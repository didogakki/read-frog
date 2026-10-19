import type { LangCodeISO6393 } from "@read-frog/definitions"
import type { FeatureUsageContext } from "@/types/analytics"
import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"
import { browser, storage } from "#imports"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext } from "@/utils/analytics"
import { normalizeDetectedCode } from "@/utils/config/languages"
import { CONFIG_STORAGE_KEY, DEFAULT_DETECTED_CODE } from "@/utils/constants/config"
import { getDetectedCodeStateKey, getTranslationStateKey } from "@/utils/constants/storage-keys"
import { shouldEnableAutoTranslation } from "@/utils/host/translate/auto-translation"
import { logger } from "@/utils/logger"
import { onMessage, sendMessage } from "@/utils/message"
import { isTranslationOnlyBlockedByProvider } from "@/utils/providers/translation-only-gate"
import { getPageTranslationOriginScope } from "@/utils/url"
import {
  injectHostContentIntoCurrentTabIframesAfterNodeTranslation,
  injectHostContentIntoTabIframes,
} from "./iframe-injection"
import {
  enqueuePageTranslationStateTask,
  getPageTranslationEnabled,
  getPageTranslationState,
  forgetClosedSessions,
  isAutoTranslationSuppressed,
  isClosedSession,
  isPageTranslationStateInUrlScope,
  isStaleSessionState,
  rememberClosedSession,
  writePageTranslationEnabled,
} from "./page-translation-state"

function notifyPageTranslationStateChanged(
  tabId: number,
  enabled: boolean,
  mode?: TranslationMode,
) {
  void sendMessage(
    "notifyTranslationStateChanged",
    mode ? { enabled, mode } : { enabled },
    tabId,
  ).catch((error) => logger.warn("Failed to notify page translation state change", error))
}

function requestManagerToTogglePageTranslation(
  tabId: number,
  enabled: boolean,
  analyticsContext?: FeatureUsageContext<"page_translation">,
) {
  void sendMessage("askManagerToTogglePageTranslation", { enabled, analyticsContext }, tabId).catch(
    (error) => logger.warn("Failed to ask page translation manager to toggle", error),
  )
}

function requestManagerToToggleOtherModePageTranslation(
  tabId: number,
  analyticsContext?: FeatureUsageContext<"page_translation">,
) {
  void sendMessage("askManagerToToggleOtherModePageTranslation", { analyticsContext }, tabId).catch(
    (error) => logger.warn("Failed to ask page translation manager to toggle other mode", error),
  )
}

function isIframe(frameId: number | undefined): boolean {
  return frameId !== undefined && frameId !== 0
}

async function getDetectedCodeForTab(tabId: number): Promise<LangCodeISO6393> {
  const storedCode = await storage.getItem<unknown>(getDetectedCodeStateKey(tabId))
  return normalizeDetectedCode(storedCode)
}

function notifyDetectedCodeChanged(detectedCode: LangCodeISO6393) {
  void sendMessage("detectedPageLanguageChanged", { detectedCode })
    // The popup is often closed, so having no receiver is expected.
    .catch(() => {})
}

async function isActiveCurrentWindowTab(tabId: number): Promise<boolean> {
  const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
  return activeTab?.id === tabId
}

async function publishCachedDetectedCodeForTab(tabId: number): Promise<void> {
  notifyDetectedCodeChanged(await getDetectedCodeForTab(tabId))
}

function requestDetectedPageLanguageRefresh(tabId: number) {
  void sendMessage("refreshDetectedPageLanguage", undefined, tabId).catch((error) =>
    logger.warn("Failed to refresh detected page language", error),
  )
}

async function publishAndRefreshActiveTab(tabId: number): Promise<void> {
  await publishCachedDetectedCodeForTab(tabId)
  requestDetectedPageLanguageRefresh(tabId)
}

export function translationMessage() {
  onMessage("getEnablePageTranslationByTabId", async (msg) => {
    const { tabId } = msg.data
    return await getTranslationState(tabId)
  })

  onMessage("getEnablePageTranslationFromContentScript", async (msg) => {
    const tabId = msg.sender?.tab?.id
    if (typeof tabId === "number") {
      return await getTranslationState(tabId)
    }
    logger.error("Invalid tabId in getEnablePageTranslationFromContentScript", msg)
    return false
  })

  onMessage("getPageTranslationSnapshotFromContentScript", async (msg) => {
    const tabId = msg.sender?.tab?.id
    if (typeof tabId === "number") {
      const state = await getPageTranslationState(tabId)
      return state?.enabled
        ? {
            enabled: true,
            mode: state.mode,
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
          }
        : { enabled: false }
    }
    logger.error("Invalid tabId in getPageTranslationSnapshotFromContentScript", msg)
    return { enabled: false }
  })

  onMessage("ensureIframeHostContentInjected", async (msg) => {
    const tabId = msg.data?.tabId ?? msg.sender?.tab?.id
    if (typeof tabId === "number") {
      await injectHostContentIntoTabIframes(tabId)
      return
    }

    logger.error("Invalid tabId in ensureIframeHostContentInjected", msg)
  })

  onMessage("injectCurrentIframesAfterTopFrameNodeTranslation", async (msg) => {
    const tabId = msg.sender?.tab?.id
    const frameId = msg.sender?.frameId

    if (typeof tabId === "number" && frameId === 0) {
      await injectHostContentIntoCurrentTabIframesAfterNodeTranslation(tabId)
      return
    }

    logger.error("Invalid sender in injectCurrentIframesAfterTopFrameNodeTranslation", msg)
  })

  onMessage("reportDetectedPageLanguage", async (msg) => {
    const tabId = msg.sender?.tab?.id
    const { url, detectedCodeOrUnd } = msg.data
    if (typeof tabId === "number") {
      const detectedCode = normalizeDetectedCode(detectedCodeOrUnd)
      await storage.setItem<LangCodeISO6393>(getDetectedCodeStateKey(tabId), detectedCode)

      if (await isActiveCurrentWindowTab(tabId)) {
        notifyDetectedCodeChanged(detectedCode)
      }

      const config = await storage.getItem<Config>(`local:${CONFIG_STORAGE_KEY}`)
      if (!config) return

      const shouldEnable = await shouldEnableAutoTranslation(url, detectedCodeOrUnd, config)
      if (shouldEnable) {
        // Honor an explicit user refusal for this origin (#2011): language is
        // re-detected on every tab activation, so without this check a manual
        // "show original" would be force-overridden on the next tab switch.
        const state = await getPageTranslationState(tabId)
        // A provider-forced close only holds until the provider recovers.
        const providerStillBlocked = state?.sessionInvalidated
          ? isTranslationOnlyBlockedByProvider(config)
          : true
        if (isAutoTranslationSuppressed(state, url, providerStillBlocked)) return

        requestManagerToTogglePageTranslation(
          tabId,
          true,
          createFeatureUsageContext(
            ANALYTICS_FEATURE.PAGE_TRANSLATION,
            ANALYTICS_SURFACE.PAGE_AUTO,
          ),
        )
      }
      return
    }

    logger.error("Invalid tabId in reportDetectedPageLanguage", msg)
  })

  onMessage("getDetectedCode", async (msg) => {
    const tabId = msg.sender?.tab?.id
    if (typeof tabId === "number") {
      return await getDetectedCodeForTab(tabId)
    }

    const [activeTab] = await browser.tabs.query({ active: true, currentWindow: true })
    if (typeof activeTab?.id === "number") {
      return await getDetectedCodeForTab(activeTab.id)
    }

    return DEFAULT_DETECTED_CODE
  })

  onMessage("tryToSetEnablePageTranslationByTabId", async (msg) => {
    const { tabId, enabled, analyticsContext } = msg.data
    if (!enabled) {
      // Record the user's refusal before asking the manager to stop, so a
      // concurrent tab-activation re-detection cannot re-enable in between.
      const tabUrl = await browser.tabs
        .get(tabId)
        .then((tab) => tab.url)
        .catch(() => undefined)
      await enqueuePageTranslationStateTask(tabId, async () => {
        await writePageTranslationEnabled(tabId, false, tabUrl, true)
        notifyPageTranslationStateChanged(tabId, false)
      })
    }
    requestManagerToTogglePageTranslation(tabId, enabled, analyticsContext)
  })

  onMessage("tryToSetEnablePageTranslationOnContentScript", async (msg) => {
    const tabId = msg.sender?.tab?.id
    const { enabled, analyticsContext } = msg.data
    if (typeof tabId === "number") {
      logger.info("sending tryToSetEnablePageTranslationOnContentScript to manager", {
        enabled,
        tabId,
      })
      if (!enabled) {
        await enqueuePageTranslationStateTask(tabId, async () => {
          await writePageTranslationEnabled(tabId, false, msg.sender?.tab?.url, true)
          notifyPageTranslationStateChanged(tabId, false)
        })
      }
      requestManagerToTogglePageTranslation(tabId, enabled, analyticsContext)
    } else {
      logger.error("tabId is not a number", msg)
    }
  })

  onMessage("toggleOtherModePageTranslationOnContentScript", async (msg) => {
    const tabId = msg.sender?.tab?.id
    if (typeof tabId === "number") {
      requestManagerToToggleOtherModePageTranslation(tabId, msg.data?.analyticsContext)
    } else {
      logger.error("tabId is not a number", msg)
    }
  })

  onMessage("setAndNotifyPageTranslationStateChangedByManager", async (msg) => {
    const tabId = msg.sender?.tab?.id
    const { enabled, url, userInitiated, mode, sessionInvalidated, sessionId } = msg.data
    if (typeof tabId === "number") {
      const senderFrameId = msg.sender?.frameId

      if (isIframe(senderFrameId)) {
        // Iframe echoes only synchronize UI; they must not write tab-level
        // state (including the userDisabled marker) because that state is
        // scoped to the top-frame origin and iframe echoes carry iframe URLs.
        // Only re-broadcast when the echo agrees with the stored state, so an
        // iframe-only stop cannot make the UI contradict a still-translating
        // top frame. An echo from a stale mode (iframe lagging a mode switch)
        // is dropped for the same reason.
        // Queued behind pending writes so the read and its broadcast see one
        // consistent state.
        await enqueuePageTranslationStateTask(tabId, async () => {
          const currentState = await getPageTranslationState(tabId)
          const currentEnabled = currentState?.enabled ?? false
          if (enabled !== currentEnabled) return
          if (enabled && mode !== currentState?.mode) return

          notifyPageTranslationStateChanged(tabId, currentEnabled, currentState?.mode)
        })
        return
      }

      await enqueuePageTranslationStateTask(tabId, async () => {
        if (sessionId) {
          if (enabled) {
            // The session was already stopped by a stop that overtook this start.
            if (isClosedSession(tabId, sessionId)) return
          } else {
            // A stop carrying an identity only closes that session: an older
            // session's late stop or invalidation must not close a newer one.
            const currentState = await getPageTranslationState(tabId)
            if (!currentState?.enabled || currentState.sessionId !== sessionId) {
              rememberClosedSession(tabId, sessionId)
              return
            }
          }
        }
        await writePageTranslationEnabled(
          tabId,
          enabled,
          url ?? msg.sender?.tab?.url,
          userInitiated,
          mode,
          sessionInvalidated,
          sessionId,
        )
        notifyPageTranslationStateChanged(tabId, enabled, enabled ? mode : undefined)
      })

      if (enabled) {
        void injectHostContentIntoTabIframes(tabId)
      }
    } else {
      logger.error("tabId is not a number", msg)
    }
  })

  onMessage("closeStalePageTranslationState", async (msg) => {
    const tabId = msg.sender?.tab?.id
    if (typeof tabId !== "number") {
      logger.error("tabId is not a number", msg)
      return
    }
    // Tab-level state belongs to the top frame; a frame's failed restore stays local.
    if (isIframe(msg.sender?.frameId)) return

    // Read, compare and write happen in one queued task: a newer start of the
    // same mode is either written before this runs (identity mismatch) or after
    // it finishes, never between the read and the write.
    await enqueuePageTranslationStateTask(tabId, async () => {
      const url = msg.data.url ?? msg.sender?.tab?.url
      const state = await getPageTranslationState(tabId)
      if (!isStaleSessionState(state, { ...msg.data, url })) return

      await writePageTranslationEnabled(tabId, false, url, false, undefined, true)
      notifyPageTranslationStateChanged(tabId, false)
    })
  })

  // === Helper Functions ===
  async function getTranslationState(tabId: number): Promise<boolean> {
    return await getPageTranslationEnabled(tabId)
  }

  // === Cleanup ===
  browser.tabs.onRemoved.addListener(async (tabId) => {
    await enqueuePageTranslationStateTask(tabId, async () => {
      forgetClosedSessions(tabId)
      await storage.removeItem(getTranslationStateKey(tabId))
    })
    await storage.removeItem(getDetectedCodeStateKey(tabId))
  })

  browser.tabs.onActivated.addListener(async (activeInfo) => {
    await publishAndRefreshActiveTab(activeInfo.tabId)
  })

  // Clear translation state only when the tab leaves the origin where it was
  // enabled (or where the user manually disabled it).
  browser.webNavigation.onCommitted.addListener(async (details) => {
    // Only handle main frame navigations, not iframes
    if (details.frameId !== 0) return

    // Read-then-remove must not interleave with a start that writes a fresh state.
    await enqueuePageTranslationStateTask(details.tabId, async () => {
      const state = await getPageTranslationState(details.tabId)
      if (!state) return

      if (state.enabled) {
        if (isPageTranslationStateInUrlScope(state, details.url)) return

        await storage.removeItem(getTranslationStateKey(details.tabId))
        return
      }

      // A user's manual-off marker (or a provider-forced close) only applies to
      // the origin it was set on; clear it once the tab commits to a different
      // origin (or an origin-less URL like chrome://) so other sites keep
      // auto-translating.
      if (state.userDisabled || state.sessionInvalidated) {
        if (state.origin && state.origin === getPageTranslationOriginScope(details.url)) return

        await storage.removeItem(getTranslationStateKey(details.tabId))
      }
    })
  })
}

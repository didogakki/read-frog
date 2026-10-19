import type { LangCodeISO6393 } from "@read-frog/definitions"
import type { ContentScriptContext } from "#imports"
import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"
import { storage } from "#imports"
import { configSchema } from "@/types/config/config"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { detectPageLanguageLightweight } from "@/utils/content/page-language"
import { ensurePresetStyles } from "@/utils/host/translate/ui/style-injector"
import { logger } from "@/utils/logger"
import { onMessage, sendMessage } from "@/utils/message"
import { clearEffectiveSiteControlUrl } from "@/utils/site-control"
import { areSamePageTranslationOrigin } from "@/utils/url"
import { bindTranslationHubShortcutKey } from "./bind-translation-hub-shortcut"
import { setupUrlChangeListener } from "./listen"
import { mountHostToast } from "./mount-host-toast"
import { bindTranslationModeShortcutKey } from "./translation-control/bind-translation-mode-shortcut"
import { bindTranslationShortcutKey } from "./translation-control/bind-translation-shortcut"
import { registerNodeTranslationTriggers } from "./translation-control/node-translation"
import { PageTranslationManager } from "./translation-control/page-translation"

export async function bootstrapHostContent(
  ctx: ContentScriptContext,
  initialConfig: Config | null,
) {
  ensurePresetStyles(document)

  const cleanupUrlListener = setupUrlChangeListener()

  const removeHostToast = window === window.top ? mountHostToast() : () => {}

  const teardownNodeTranslation = registerNodeTranslationTriggers()

  const preloadConfig =
    initialConfig?.pageTranslation.page.preload ?? DEFAULT_CONFIG.pageTranslation.page.preload
  let detectedPageLanguage: { url: string; code: LangCodeISO6393 | "und" } | undefined
  let detectionGeneration = 0
  const manager = new PageTranslationManager(
    {
      root: null,
      rootMargin: `${preloadConfig.margin}px`,
      threshold: preloadConfig.threshold,
    },
    (url) => (detectedPageLanguage?.url === url ? detectedPageLanguage.code : undefined),
  )

  const cleanupPageTranslationTriggers = manager.registerPageTranslationTriggers()

  // Config writes reach a running session without any page event: a temporary
  // translationOnly session must notice a provider change even on a static page
  // (every frame runs its own session), and the tab-title switch applies to an
  // already-translated page at once. Only the top frame owns the title, so
  // iframes skip parsing every config write.
  const cleanupConfigWatch = storage.watch<Config>(`local:${CONFIG_STORAGE_KEY}`, (config) => {
    void manager
      .revalidateSession()
      .catch((error) => logger.warn("Failed to revalidate page translation session", error))

    if (window !== window.top) return
    const parsedConfig = configSchema.safeParse(config)
    if (parsedConfig.success) {
      manager.setTitleTranslationEnabled(parsedConfig.data.pageTranslation.page.translateTitle)
    }
  })

  const cleanupTranslationShortcut = await bindTranslationShortcutKey(manager)

  const cleanupTranslationModeShortcut = await bindTranslationModeShortcutKey()

  const cleanupTranslationHubShortcut = await bindTranslationHubShortcutKey()

  const detectAndReportPageLanguage = async (url: string) => {
    const generation = ++detectionGeneration
    detectedPageLanguage = undefined
    const { detectedCodeOrUnd } = await detectPageLanguageLightweight()
    if (generation === detectionGeneration && url === window.location.href) {
      detectedPageLanguage = { url, code: detectedCodeOrUnd }
    }
    void sendMessage("reportDetectedPageLanguage", { url, detectedCodeOrUnd })
  }

  // For late-loading iframes: check if translation is already enabled for this tab
  let translationEnabled = false
  // The tab's temporary mode (floating button "other mode"); undefined when the
  // saved preference applies. Reload and late iframes restore it from here,
  // read together with the enabled flag so the two never disagree.
  let temporaryMode: TranslationMode | undefined
  let restoredSessionId: string | undefined
  try {
    const snapshot = await sendMessage("getPageTranslationSnapshotFromContentScript", undefined)
    translationEnabled = snapshot.enabled
    temporaryMode = snapshot.mode
    restoredSessionId = snapshot.sessionId
  } catch (error) {
    // Extension context may be invalidated during update, proceed without auto-start
    logger.error("Failed to check translation state:", error)
  }
  if (translationEnabled) {
    void manager.start(undefined, {
      mode: temporaryMode,
      restore: true,
      sessionId: restoredSessionId,
    })
  }

  const handleUrlChange = async (from: string, to: string) => {
    if (from !== to) {
      detectionGeneration += 1
      detectedPageLanguage = undefined
      logger.info("URL changed from", from, "to", to)
      // A start still awaiting its gates belongs to the page being left too.
      if (manager.isActive || manager.isStarting) {
        if (areSamePageTranslationOrigin(from, to)) {
          // Same-document route change: keep the session and wrappers
          // mounted — the MutationObserver walks the new route's DOM as the
          // router inserts it. Site CSS is swapped for the new path;
          // persistent DOM keeps its old walk decisions (accepted tradeoff,
          // see refreshSiteRuleCSS).
          await manager.refreshSiteRuleCSS()
        } else {
          manager.stop()
        }
      }
      // Only the top frame should detect and set language to avoid race conditions from iframes
      if (window === window.top) {
        await detectAndReportPageLanguage(to)
      }
    }
  }

  const handleExtensionUrlChange = (e: any) => {
    const { from, to } = e.detail
    void handleUrlChange(from, to)
  }
  window.addEventListener("extension:URLChange", handleExtensionUrlChange)

  // Listen for translation state changes from background
  const cleanupTranslationStateListener = onMessage("askManagerToTogglePageTranslation", (msg) => {
    const { enabled, analyticsContext } = msg.data
    if (enabled) {
      if (manager.isActive) return
      void manager.start(window === window.top ? analyticsContext : undefined)
    } else if (manager.isActive || manager.isStarting) {
      // Invariant: every sender of askManagerToTogglePageTranslation with
      // enabled=false is a user surface (popup button, floating button,
      // context menu) — the auto-translation path only ever sends
      // enabled=true — so a disable here is always user-initiated. A start
      // still awaiting its gates counts: the stop cancels it, otherwise it
      // would activate right after the user turned translation off.
      manager.stop({ userInitiated: true })
    }
  })

  // The click decision (start / switch / stop) needs the live manager state,
  // which only the top frame owns; iframes follow its broadcast below.
  const cleanupToggleOtherModeListener =
    window === window.top
      ? onMessage("askManagerToToggleOtherModePageTranslation", (msg) => {
          void manager
            .toggleOtherMode(msg.data?.analyticsContext)
            .catch((error) => logger.warn("Failed to toggle other-mode page translation", error))
        })
      : () => {}

  const cleanupFrameTranslationStateListener =
    window === window.top
      ? () => {}
      : onMessage("notifyTranslationStateChanged", (msg) => {
          const { enabled, mode } = msg.data
          if (!enabled) {
            // isStarting too: a stop that only checked isActive would let an
            // older async start activate the frame after it was told to stop.
            if (manager.isActive || manager.isStarting) manager.stop()
            return
          }
          if (manager.isActive || manager.isStarting) {
            // Already translating (or about to): only a different mode
            // matters, and the mode follows the top frame.
            if (manager.temporaryMode !== (mode ?? null)) {
              void manager.start(undefined, { mode, replaceActiveSession: true })
            }
            return
          }
          void manager.start(undefined, { mode })
        })

  const cleanupDetectedLanguageRefreshListener =
    window === window.top
      ? onMessage("refreshDetectedPageLanguage", () => {
          void detectAndReportPageLanguage(window.location.href)
        })
      : () => {}

  ctx.onInvalidated(() => {
    removeHostToast()
    cleanupUrlListener()
    teardownNodeTranslation()
    cleanupPageTranslationTriggers()
    cleanupConfigWatch()
    cleanupTranslationShortcut()
    cleanupTranslationModeShortcut()
    cleanupTranslationHubShortcut()
    cleanupTranslationStateListener()
    cleanupToggleOtherModeListener()
    cleanupFrameTranslationStateListener()
    cleanupDetectedLanguageRefreshListener()
    window.removeEventListener("extension:URLChange", handleExtensionUrlChange)
    window.__READ_FROG_HOST_INJECTED__ = false
    clearEffectiveSiteControlUrl()
  })

  // Only the top frame should detect and set language to avoid race conditions from iframes
  if (window === window.top) {
    await detectAndReportPageLanguage(window.location.href)
  }
}

// @vitest-environment jsdom

import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { GOOGLE_TRANSLATE_PROVIDER_ID } from "@/utils/constants/providers"
import {
  applyPageTranslationModeOverride,
  getPageTranslationModeOverride,
} from "@/utils/host/translate/page-translation-mode-override"
import { logger } from "@/utils/logger"
import { PageTranslationManager } from "../page-translation"

const {
  mockGetLocalConfig,
  mockRemoveAllTranslatedWrapperNodes,
  mockSendMessage,
  mockToastAdd,
  mockTranslateWalkedElement,
  mockValidateTranslationConfigAndToast,
  mockWalkAndLabelElement,
  mockWalkAndLabelElementChunked,
  observerCallbacks,
} = vi.hoisted(() => ({
  mockGetLocalConfig: vi.fn<(...args: any[]) => any>(),
  mockRemoveAllTranslatedWrapperNodes: vi.fn<(...args: any[]) => any>(),
  mockSendMessage: vi.fn<(...args: any[]) => any>(),
  mockToastAdd: vi.fn<(...args: any[]) => any>(),
  mockTranslateWalkedElement: vi.fn<(...args: any[]) => any>(),
  mockValidateTranslationConfigAndToast: vi.fn<(...args: any[]) => any>(),
  mockWalkAndLabelElement: vi.fn<(...args: any[]) => any>(),
  mockWalkAndLabelElementChunked: vi.fn<(...args: any[]) => any>(),
  observerCallbacks: [] as Array<(entries: any[], observer: any) => void>,
}))

vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: mockGetLocalConfig,
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: mockToastAdd },
}))

vi.mock("@/utils/host/dom/filter", () => ({
  hasNoWalkAncestor: vi.fn<(...args: any[]) => any>().mockReturnValue(false),
  isDontWalkIntoAndDontTranslateAsChildElement: vi
    .fn<(...args: any[]) => any>()
    .mockReturnValue(false),
  isDontWalkIntoButTranslateAsChildElement: vi.fn<(...args: any[]) => any>().mockReturnValue(false),
  isWalkBlockedElement: vi.fn<(...args: any[]) => any>().mockReturnValue(false),
  isHTMLElement: (node: unknown) => node instanceof HTMLElement,
  isTranslatedWrapperNode: (node: unknown) =>
    node instanceof HTMLElement && node.classList.contains("read-frog-translated-content-wrapper"),
}))

vi.mock("@/utils/host/dom/find", () => ({
  deepQueryTopLevelSelector: vi.fn<(...args: any[]) => any>().mockReturnValue([]),
  deepQueryAllSelector: vi.fn<(...args: any[]) => any>().mockReturnValue([]),
}))

vi.mock("@/utils/host/dom/traversal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/host/dom/traversal")>()),
  walkAndLabelElement: mockWalkAndLabelElement,
  walkAndLabelElementChunked: mockWalkAndLabelElementChunked,
}))

vi.mock("@/utils/host/translate/node-manipulation", () => ({
  removeAllTranslatedWrapperNodes: mockRemoveAllTranslatedWrapperNodes,
  translateWalkedElement: mockTranslateWalkedElement,
  translateNodes: vi.fn<(...args: any[]) => any>(),
  translateNodesBilingualMode: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/host/translate/translate-variants", () => ({
  translateTextForPageTitle: vi.fn<(...args: any[]) => any>().mockResolvedValue(""),
}))

vi.mock("@/utils/host/translate/webpage-context", () => ({
  getOrCreateWebPageContext: vi.fn<(...args: any[]) => any>().mockResolvedValue(null),
}))

vi.mock("@/utils/host/translate/translate-text", () => ({
  validateTranslationConfigAndToast: mockValidateTranslationConfigAndToast,
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    error: vi.fn<(...args: any[]) => any>(),
    info: vi.fn<(...args: any[]) => any>(),
    warn: vi.fn<(...args: any[]) => any>(),
  },
}))

vi.mock("@/utils/message", () => ({
  sendMessage: mockSendMessage,
}))

class MockIntersectionObserver {
  observe = vi.fn<(...args: any[]) => any>()
  unobserve = vi.fn<(...args: any[]) => any>()
  disconnect = vi.fn<(...args: any[]) => any>()

  constructor(callback: (entries: any[], observer: any) => void) {
    observerCallbacks.push(callback)
  }
}

function createConfig(
  mode: TranslationMode,
  providerId: string = GOOGLE_TRANSLATE_PROVIDER_ID,
): Config {
  return {
    ...DEFAULT_CONFIG,
    pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, mode, providerId },
  }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function stateMessages(enabled: boolean) {
  return mockSendMessage.mock.calls.filter(
    ([name, data]) =>
      name === "setAndNotifyPageTranslationStateChangedByManager" && data.enabled === enabled,
  )
}

function modesSeenByWalk(): Array<TranslationMode | undefined> {
  return mockWalkAndLabelElementChunked.mock.calls.map(
    ([, , config]) => config?.pageTranslation.mode,
  )
}

describe("pageTranslationManager other-mode toggle", () => {
  let managers: PageTranslationManager[]

  function createManager() {
    const manager = new PageTranslationManager()
    managers.push(manager)
    return manager
  }

  beforeEach(() => {
    vi.clearAllMocks()
    observerCallbacks.length = 0
    managers = []

    document.head.innerHTML = ""
    document.body.innerHTML = "<main><p>Article body</p></main>"
    vi.stubGlobal("IntersectionObserver", MockIntersectionObserver)

    mockGetLocalConfig.mockResolvedValue(createConfig("bilingual"))
    mockValidateTranslationConfigAndToast.mockReturnValue(true)
    mockSendMessage.mockResolvedValue(undefined)
    mockWalkAndLabelElementChunked.mockResolvedValue({ forceBlock: false, isInlineNode: false })
  })

  afterEach(() => {
    for (const manager of managers) {
      if (manager.isActive) manager.stop()
    }
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it("starts in translationOnly when off and the saved preference is bilingual", async () => {
    const manager = createManager()

    await manager.toggleOtherMode()
    await flush()

    expect(manager.isActive).toBe(true)
    expect(manager.temporaryMode).toBe("translationOnly")
    expect(getPageTranslationModeOverride()).toBe("translationOnly")
    expect(stateMessages(true)).toEqual([
      [
        "setAndNotifyPageTranslationStateChangedByManager",
        {
          enabled: true,
          url: window.location.href,
          mode: "translationOnly",
          sessionId: expect.any(String),
        },
      ],
    ])
    expect(modesSeenByWalk()).toEqual(["translationOnly"])
  })

  it("starts in bilingual when off and the saved preference is translationOnly", async () => {
    mockGetLocalConfig.mockResolvedValue(createConfig("translationOnly"))
    const manager = createManager()

    await manager.toggleOtherMode()
    await flush()

    expect(manager.isActive).toBe(true)
    expect(manager.temporaryMode).toBe("bilingual")
    expect(stateMessages(true)[0]![1]).toMatchObject({ enabled: true, mode: "bilingual" })
    expect(modesSeenByWalk()).toEqual(["bilingual"])
  })

  it("never writes the temporary mode back to the saved config", async () => {
    const saved = createConfig("bilingual")
    mockGetLocalConfig.mockResolvedValue(saved)
    const manager = createManager()

    await manager.toggleOtherMode()
    await flush()

    expect(saved.pageTranslation.mode).toBe("bilingual")
    // The override only exists as a view over the saved config.
    expect(applyPageTranslationModeOverride(saved).pageTranslation.mode).toBe("translationOnly")
    expect(saved.pageTranslation.mode).toBe("bilingual")
  })

  it("switches a live preference-mode session to the other mode without notifying a stop", async () => {
    const manager = createManager()
    await manager.start()
    await flush()
    expect(manager.temporaryMode).toBeNull()
    mockSendMessage.mockClear()
    mockWalkAndLabelElementChunked.mockClear()

    await manager.toggleOtherMode()
    await flush()

    expect(manager.isActive).toBe(true)
    expect(manager.temporaryMode).toBe("translationOnly")
    // The old session was torn down in place and a new one walked in the new mode.
    expect(mockRemoveAllTranslatedWrapperNodes).toHaveBeenCalledTimes(1)
    expect(stateMessages(false)).toHaveLength(0)
    expect(stateMessages(true)).toEqual([
      [
        "setAndNotifyPageTranslationStateChangedByManager",
        {
          enabled: true,
          url: window.location.href,
          mode: "translationOnly",
          sessionId: expect.any(String),
        },
      ],
    ])
    expect(modesSeenByWalk()).toEqual(["translationOnly"])
  })

  it("stops and restores the original content when already in the other mode", async () => {
    const manager = createManager()
    await manager.toggleOtherMode()
    await flush()
    mockSendMessage.mockClear()
    mockRemoveAllTranslatedWrapperNodes.mockClear()

    await manager.toggleOtherMode()
    await flush()

    expect(manager.isActive).toBe(false)
    expect(manager.temporaryMode).toBeNull()
    expect(getPageTranslationModeOverride()).toBeNull()
    expect(mockRemoveAllTranslatedWrapperNodes).toHaveBeenCalled()
    expect(stateMessages(false)).toEqual([
      [
        "setAndNotifyPageTranslationStateChangedByManager",
        {
          enabled: false,
          url: window.location.href,
          userInitiated: true,
          sessionId: expect.any(String),
        },
      ],
    ])
  })

  it("keeps toggling relative to the saved preference across repeated clicks", async () => {
    const manager = createManager()

    await manager.toggleOtherMode()
    await flush()
    expect(manager.temporaryMode).toBe("translationOnly")

    await manager.toggleOtherMode()
    await flush()
    expect(manager.isActive).toBe(false)

    await manager.toggleOtherMode()
    await flush()
    expect(manager.isActive).toBe(true)
    expect(manager.temporaryMode).toBe("translationOnly")
  })

  it("lets fast repeated clicks each see the previous click's effect", async () => {
    const manager = createManager()

    // Both clicks land before the first start() has resolved its config.
    const first = manager.toggleOtherMode()
    const second = manager.toggleOtherMode()
    await Promise.all([first, second])
    await flush()

    expect(manager.isActive).toBe(false)
    expect(manager.temporaryMode).toBeNull()
    expect(getPageTranslationModeOverride()).toBeNull()
    expect(stateMessages(true).length).toBeLessThanOrEqual(1)
  })

  it("cancels a still-pending start when the next click arrives", async () => {
    const manager = createManager()
    const pendingStartConfig = createDeferred<Config>()
    // 1st read: the toggle decision; 2nd read: start() itself, held back.
    mockGetLocalConfig
      .mockResolvedValueOnce(createConfig("bilingual"))
      .mockReturnValueOnce(pendingStartConfig.promise)
      .mockResolvedValue(createConfig("bilingual"))

    await manager.toggleOtherMode()
    expect(manager.isStarting).toBe(true)
    expect(manager.temporaryMode).toBe("translationOnly")

    await manager.toggleOtherMode()
    expect(manager.isStarting).toBe(false)
    expect(manager.temporaryMode).toBeNull()

    pendingStartConfig.resolve(createConfig("bilingual"))
    await flush()

    // The stale start must not resurrect itself after the cancel.
    expect(manager.isActive).toBe(false)
    expect(stateMessages(true)).toHaveLength(0)
    expect(getPageTranslationModeOverride()).toBeNull()
  })

  it("lets a later start from another surface use the saved preference", async () => {
    const manager = createManager()
    await manager.toggleOtherMode()
    await flush()
    manager.stop({ userInitiated: true })
    mockSendMessage.mockClear()
    mockWalkAndLabelElementChunked.mockClear()

    await manager.start()
    await flush()

    expect(manager.temporaryMode).toBeNull()
    expect(stateMessages(true)[0]![1]).not.toHaveProperty("mode")
    expect(modesSeenByWalk()).toEqual(["bilingual"])
  })

  it("does not let a plain (auto-translation) start overwrite an active temporary mode", async () => {
    const manager = createManager()
    await manager.toggleOtherMode()
    await flush()
    mockSendMessage.mockClear()

    await manager.start()
    await flush()

    expect(manager.temporaryMode).toBe("translationOnly")
    expect(getPageTranslationModeOverride()).toBe("translationOnly")
    expect(stateMessages(true)).toHaveLength(0)
    expect(mockRemoveAllTranslatedWrapperNodes).not.toHaveBeenCalled()
  })

  it("follows an externally requested mode (iframe path) by replacing the live session", async () => {
    const manager = createManager()
    await manager.start()
    await flush()
    mockSendMessage.mockClear()

    await manager.start(undefined, { mode: "translationOnly", replaceActiveSession: true })
    await flush()

    expect(manager.temporaryMode).toBe("translationOnly")
    expect(stateMessages(true)[0]![1]).toMatchObject({ mode: "translationOnly" })
    expect(mockRemoveAllTranslatedWrapperNodes).toHaveBeenCalledTimes(1)
  })

  describe("translationOnly provider gate", () => {
    const blockedConfig = () => createConfig("bilingual", DEFAULT_CONFIG.pageTranslation.providerId)

    it("refuses to start translationOnly, shows the reason and changes nothing", async () => {
      mockGetLocalConfig.mockResolvedValue(blockedConfig())
      const manager = createManager()

      await manager.toggleOtherMode()
      await flush()

      expect(mockToastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "info",
          title: "options.translation.preference.translationMode.providerNotSupported",
        }),
      )
      expect(manager.isActive).toBe(false)
      expect(manager.isStarting).toBe(false)
      expect(manager.temporaryMode).toBeNull()
      expect(getPageTranslationModeOverride()).toBeNull()
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(mockWalkAndLabelElementChunked).not.toHaveBeenCalled()
    })

    it("keeps a live bilingual session untouched when the switch is blocked", async () => {
      mockGetLocalConfig.mockResolvedValue(blockedConfig())
      const manager = createManager()
      await manager.start()
      await flush()
      mockSendMessage.mockClear()
      mockWalkAndLabelElementChunked.mockClear()
      mockToastAdd.mockClear()

      await manager.toggleOtherMode()
      await flush()

      expect(mockToastAdd).toHaveBeenCalledTimes(1)
      expect(manager.isActive).toBe(true)
      expect(manager.temporaryMode).toBeNull()
      expect(getPageTranslationModeOverride()).toBeNull()
      // No preemptive teardown, no state churn, no fallback walk.
      expect(mockRemoveAllTranslatedWrapperNodes).not.toHaveBeenCalled()
      expect(mockSendMessage).not.toHaveBeenCalled()
      expect(mockWalkAndLabelElementChunked).not.toHaveBeenCalled()
    })

    it("still allows the click that leaves translationOnly when the provider is blocked", async () => {
      mockGetLocalConfig.mockResolvedValue({
        ...blockedConfig(),
        pageTranslation: {
          ...blockedConfig().pageTranslation,
          mode: "translationOnly",
        },
      })
      const manager = createManager()

      await manager.toggleOtherMode()
      await flush()

      expect(manager.isActive).toBe(true)
      expect(manager.temporaryMode).toBe("bilingual")
      expect(mockToastAdd).not.toHaveBeenCalled()
    })

    it("keeps a live preference-mode session running when it is not translationOnly", async () => {
      const manager = createManager()
      await manager.start()
      await flush()
      mockSendMessage.mockClear()

      // A provider without markup support is fine for bilingual work.
      mockGetLocalConfig.mockResolvedValue(blockedConfig())
      await manager.revalidateSession()

      expect(manager.isActive).toBe(true)
      expect(stateMessages(false)).toHaveLength(0)
      expect(mockToastAdd).not.toHaveBeenCalled()
    })

    describe("provider stops supporting a running temporary translationOnly session", () => {
      async function startTemporaryTranslationOnly() {
        const manager = createManager()
        await manager.toggleOtherMode()
        await flush()
        expect(manager.temporaryMode).toBe("translationOnly")
        mockSendMessage.mockClear()
        mockToastAdd.mockClear()
        mockWalkAndLabelElement.mockClear()
        mockTranslateWalkedElement.mockClear()
        mockRemoveAllTranslatedWrapperNodes.mockClear()
        return manager
      }

      function expectClosedForGood(manager: PageTranslationManager) {
        expect(manager.isActive).toBe(false)
        expect(manager.isStarting).toBe(false)
        expect(manager.temporaryMode).toBeNull()
        expect(getPageTranslationModeOverride()).toBeNull()
        // Original DOM is put back and the background hears about it exactly once,
        // as a provider close rather than a user refusal.
        expect(mockRemoveAllTranslatedWrapperNodes).toHaveBeenCalledTimes(1)
        expect(stateMessages(false)).toEqual([
          [
            "setAndNotifyPageTranslationStateChangedByManager",
            {
              enabled: false,
              url: window.location.href,
              sessionInvalidated: true,
              sessionId: expect.any(String),
            },
          ],
        ])
        expect(mockToastAdd).toHaveBeenCalledTimes(1)
        expect(mockToastAdd).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "info",
            title: "options.translation.preference.translationMode.providerNotSupported",
          }),
        )
      }

      it("closes the session when an already-unobserved node intersects after the change", async () => {
        const manager = await startTemporaryTranslationOnly()
        const target = document.querySelector("p")!
        const unobserve = vi.fn<(...args: any[]) => any>()

        mockGetLocalConfig.mockResolvedValue(blockedConfig())
        observerCallbacks[0]!([{ isIntersecting: true, target }], { unobserve })
        await flush()

        // The observer had already let go of the node, so merely skipping the
        // work here would strand it for the rest of the session.
        expect(unobserve).toHaveBeenCalledWith(target)
        expect(mockTranslateWalkedElement).not.toHaveBeenCalled()
        expectClosedForGood(manager)
        // A missing provider reason is not a missing config.
        expect(logger.error).not.toHaveBeenCalledWith("Global config is not initialized")
      })

      it("closes the session when a mutation arrives after the change, and later mutations do nothing", async () => {
        const manager = await startTemporaryTranslationOnly()

        mockGetLocalConfig.mockResolvedValue(blockedConfig())
        const added = document.createElement("section")
        added.textContent = "Late content"
        document.body.append(added)
        await flush()

        expect(mockWalkAndLabelElement).not.toHaveBeenCalled()
        expectClosedForGood(manager)

        // Its observers are gone: nothing keeps reacting to the page.
        document.body.append(document.createElement("section"))
        await flush()
        expect(mockWalkAndLabelElement).not.toHaveBeenCalled()
        expect(stateMessages(false)).toHaveLength(1)
      })

      it("shows one reason and closes once when several callbacks notice the change together", async () => {
        const manager = await startTemporaryTranslationOnly()
        const unit = document.querySelector("p")!

        mockGetLocalConfig.mockResolvedValue(blockedConfig())
        const unobserve = vi.fn<(...args: any[]) => any>()
        observerCallbacks[0]!([{ isIntersecting: true, target: unit }], { unobserve })
        observerCallbacks[0]!([{ isIntersecting: true, target: unit }], { unobserve })
        document.body.append(document.createElement("section"))
        await flush()

        expect(manager.isActive).toBe(false)
        expectClosedForGood(manager)
      })

      it("closes a static page on the config change alone, with no page event at all", async () => {
        const manager = await startTemporaryTranslationOnly()

        mockGetLocalConfig.mockResolvedValue(blockedConfig())
        await manager.revalidateSession()

        expect(manager.isActive).toBe(false)
        expectClosedForGood(manager)
      })

      it("leaves the session alone when the config change keeps a capable provider", async () => {
        const manager = await startTemporaryTranslationOnly()

        mockGetLocalConfig.mockResolvedValue(createConfig("bilingual"))
        await manager.revalidateSession()

        expect(manager.isActive).toBe(true)
        expect(manager.temporaryMode).toBe("translationOnly")
        expect(mockRemoveAllTranslatedWrapperNodes).not.toHaveBeenCalled()
        expect(stateMessages(false)).toHaveLength(0)
        expect(mockToastAdd).not.toHaveBeenCalled()
      })

      it("can be started again by hand once the provider is capable, as a complete new session", async () => {
        const manager = await startTemporaryTranslationOnly()
        mockGetLocalConfig.mockResolvedValue(blockedConfig())
        await manager.revalidateSession()
        expect(manager.isActive).toBe(false)
        mockSendMessage.mockClear()
        mockWalkAndLabelElementChunked.mockClear()
        observerCallbacks.length = 0

        mockGetLocalConfig.mockResolvedValue(createConfig("bilingual"))
        await manager.toggleOtherMode()
        await flush()

        expect(manager.isActive).toBe(true)
        expect(manager.temporaryMode).toBe("translationOnly")
        expect(stateMessages(true)).toEqual([
          [
            "setAndNotifyPageTranslationStateChangedByManager",
            {
              enabled: true,
              url: window.location.href,
              mode: "translationOnly",
              sessionId: expect.any(String),
            },
          ],
        ])
        // The whole document is walked and observed afresh, not resumed from the
        // observers the failed session abandoned.
        expect(modesSeenByWalk()).toEqual(["translationOnly"])
        expect(observerCallbacks).toHaveLength(1)

        const unit = document.querySelector("p")!
        observerCallbacks[0]!([{ isIntersecting: true, target: unit }], {
          unobserve: vi.fn<(...args: any[]) => any>(),
        })
        await flush()
        expect(mockTranslateWalkedElement).toHaveBeenCalledTimes(1)
        expect(mockTranslateWalkedElement.mock.calls[0]![2].pageTranslation.mode).toBe(
          "translationOnly",
        )
      })

      it("does not let a late failure from a closed session stop the newer session", async () => {
        const manager = await startTemporaryTranslationOnly()
        const staleRead = createDeferred<Config>()
        mockGetLocalConfig.mockReturnValueOnce(staleRead.promise)
        const staleRevalidation = manager.revalidateSession()

        // Meanwhile the user closes the session and starts a fresh one.
        manager.stop({ userInitiated: true })
        mockGetLocalConfig.mockResolvedValue(createConfig("bilingual"))
        await manager.toggleOtherMode()
        await flush()
        expect(manager.temporaryMode).toBe("translationOnly")
        mockSendMessage.mockClear()
        mockToastAdd.mockClear()

        // The old read finally lands, reporting the unsupported provider it saw.
        staleRead.resolve(blockedConfig())
        await staleRevalidation
        await flush()

        expect(manager.isActive).toBe(true)
        expect(manager.temporaryMode).toBe("translationOnly")
        expect(getPageTranslationModeOverride()).toBe("translationOnly")
        expect(stateMessages(false)).toHaveLength(0)
        expect(mockToastAdd).not.toHaveBeenCalled()
      })

      it("closes locally in an iframe without a toast", async () => {
        const manager = await startTemporaryTranslationOnly()
        vi.spyOn(window, "top", "get").mockReturnValue({} as Window & typeof globalThis)

        mockGetLocalConfig.mockResolvedValue(blockedConfig())
        await manager.revalidateSession()

        expect(manager.isActive).toBe(false)
        expect(getPageTranslationModeOverride()).toBeNull()
        expect(mockToastAdd).not.toHaveBeenCalled()
      })
    })
  })

  it("gives every new activation its own session identity", async () => {
    const manager = createManager()

    await manager.start()
    await flush()
    manager.stop()
    await manager.start()
    await flush()

    const ids = stateMessages(true).map(([, data]) => data.sessionId)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toEqual(expect.any(String))
    expect(ids[0]).not.toBe(ids[1])
  })

  describe("restoring a temporary mode after reload", () => {
    const blockedConfig = () => createConfig("bilingual", DEFAULT_CONFIG.pageTranslation.providerId)
    const closeMessages = () =>
      mockSendMessage.mock.calls.filter(([name]) => name === "closeStalePageTranslationState")

    it("closes the stale tab state once when the restored mode is no longer allowed", async () => {
      mockGetLocalConfig.mockResolvedValue(blockedConfig())
      const manager = createManager()

      await manager.start(undefined, {
        mode: "translationOnly",
        restore: true,
        sessionId: "stored-session",
      })
      await flush()

      expect(mockToastAdd).toHaveBeenCalledTimes(1)
      // The request names the exact stored session, not just its mode.
      expect(closeMessages()).toEqual([
        [
          "closeStalePageTranslationState",
          { url: window.location.href, staleMode: "translationOnly", sessionId: "stored-session" },
        ],
      ])
      expect(stateMessages(true)).toHaveLength(0)
      expect(manager.isActive).toBe(false)
      expect(manager.isStarting).toBe(false)
      expect(manager.temporaryMode).toBeNull()
      expect(getPageTranslationModeOverride()).toBeNull()
    })

    it("restores normally when the provider still supports the mode", async () => {
      const manager = createManager()

      await manager.start(undefined, {
        mode: "translationOnly",
        restore: true,
        sessionId: "stored-session",
      })
      await flush()

      expect(manager.temporaryMode).toBe("translationOnly")
      // Restoring re-announces the same identity instead of minting a new one.
      expect(stateMessages(true)).toEqual([
        [
          "setAndNotifyPageTranslationStateChangedByManager",
          expect.objectContaining({ sessionId: "stored-session" }),
        ],
      ])
      expect(closeMessages()).toHaveLength(0)
      expect(mockToastAdd).not.toHaveBeenCalled()
    })

    it("a restored session's stop and invalidation carry the stored identity", async () => {
      const manager = createManager()

      await manager.start(undefined, {
        mode: "translationOnly",
        restore: true,
        sessionId: "stored-session",
      })
      await flush()
      manager.stop()

      expect(stateMessages(false)).toEqual([
        [
          "setAndNotifyPageTranslationStateChangedByManager",
          expect.objectContaining({ sessionId: "stored-session" }),
        ],
      ])
    })

    it("a replaced session's stop names the newer session, not the older one", async () => {
      const manager = createManager()

      await manager.toggleOtherMode()
      await flush()
      await manager.start(undefined, { mode: "bilingual", replaceActiveSession: true })
      await flush()
      manager.stop()

      const startIds = stateMessages(true).map(([, data]) => data.sessionId)
      expect(startIds).toHaveLength(2)
      expect(startIds[0]).not.toBe(startIds[1])
      expect(stateMessages(false).map(([, data]) => data.sessionId)).toEqual([startIds[1]])
    })

    it("does not clear tab state for a refused switch that is not a restore", async () => {
      mockGetLocalConfig.mockResolvedValue(blockedConfig())
      const manager = createManager()

      await manager.toggleOtherMode()
      await flush()

      expect(closeMessages()).toHaveLength(0)
      expect(mockSendMessage).not.toHaveBeenCalled()
    })

    it("keeps a frame's failed restore local: only the top frame may write tab state", async () => {
      mockGetLocalConfig.mockResolvedValue(blockedConfig())
      vi.spyOn(window, "top", "get").mockReturnValue({} as Window & typeof globalThis)
      const manager = createManager()

      await manager.start(undefined, { mode: "translationOnly", restore: true })
      await flush()

      expect(closeMessages()).toHaveLength(0)
      expect(mockToastAdd).not.toHaveBeenCalled()
      expect(manager.isActive).toBe(false)
    })

    it("does not close anything when the user cancelled the restoring start meanwhile", async () => {
      const pendingConfig = createDeferred<Config>()
      mockGetLocalConfig.mockReturnValueOnce(pendingConfig.promise)
      const manager = createManager()

      const restoring = manager.start(undefined, { mode: "translationOnly", restore: true })
      expect(manager.isStarting).toBe(true)
      manager.stop({ userInitiated: true })

      pendingConfig.resolve(blockedConfig())
      await restoring
      await flush()

      expect(closeMessages()).toHaveLength(0)
      expect(mockToastAdd).not.toHaveBeenCalled()
      expect(manager.isActive).toBe(false)
    })

    it("does not close the state a newer successful start has taken over", async () => {
      const pendingConfig = createDeferred<Config>()
      mockGetLocalConfig.mockReturnValueOnce(pendingConfig.promise)
      const manager = createManager()

      const restoring = manager.start(undefined, { mode: "translationOnly", restore: true })
      // The newer intent replaces the pending restore and succeeds.
      await manager.start(undefined, { replaceActiveSession: true })
      await flush()
      expect(manager.isActive).toBe(true)
      mockSendMessage.mockClear()

      pendingConfig.resolve(blockedConfig())
      await restoring
      await flush()

      expect(closeMessages()).toHaveLength(0)
      expect(manager.isActive).toBe(true)
      expect(manager.temporaryMode).toBeNull()
    })
  })

  describe("cancelling a start that has not activated yet", () => {
    it("stop() keeps a pending start from activating the frame afterwards", async () => {
      const pendingConfig = createDeferred<Config>()
      mockGetLocalConfig.mockReturnValueOnce(pendingConfig.promise)
      const manager = createManager()

      const starting = manager.start(undefined, { mode: "translationOnly" })
      expect(manager.isStarting).toBe(true)
      expect(manager.isActive).toBe(false)
      manager.stop()

      pendingConfig.resolve(createConfig("bilingual"))
      await starting
      await flush()

      expect(manager.isActive).toBe(false)
      expect(manager.isStarting).toBe(false)
      expect(stateMessages(true)).toHaveLength(0)
      expect(getPageTranslationModeOverride()).toBeNull()
    })
  })

  describe("dynamic content", () => {
    it("translates lazily intersected units in the temporary mode", async () => {
      const manager = createManager()
      await manager.toggleOtherMode()
      await flush()
      const unit = document.querySelector("p")!
      mockTranslateWalkedElement.mockClear()

      observerCallbacks[0]!([{ isIntersecting: true, target: unit }], {
        unobserve: vi.fn<(...args: any[]) => any>(),
      })
      await flush()

      expect(mockTranslateWalkedElement).toHaveBeenCalledTimes(1)
      const config = mockTranslateWalkedElement.mock.calls[0]![2] as Config
      expect(config.pageTranslation.mode).toBe("translationOnly")
    })

    it("walks nodes added later in the temporary mode", async () => {
      const manager = createManager()
      await manager.toggleOtherMode()
      await flush()
      mockWalkAndLabelElement.mockClear()

      const added = document.createElement("section")
      added.textContent = "Inserted after start"
      document.body.append(added)
      await flush()

      expect(mockWalkAndLabelElement).toHaveBeenCalled()
      const modes = mockWalkAndLabelElement.mock.calls.map(
        ([, , config]) => config.pageTranslation.mode,
      )
      expect(new Set(modes)).toEqual(new Set(["translationOnly"]))
    })

    it("keeps the temporary mode across a same-document route refresh", async () => {
      const manager = createManager()
      await manager.toggleOtherMode()
      await flush()

      await manager.refreshSiteRuleCSS()

      expect(manager.isActive).toBe(true)
      expect(manager.temporaryMode).toBe("translationOnly")
      expect(getPageTranslationModeOverride()).toBe("translationOnly")
    })
  })
})

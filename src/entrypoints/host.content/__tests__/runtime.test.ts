// @vitest-environment jsdom

import type { ContentScriptContext } from "#imports"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG } from "@/utils/constants/config"
import { bootstrapHostContent } from "../runtime"

const {
  messageHandlers,
  managerInstances,
  mockBindTranslationShortcutKey,
  mockClearEffectiveSiteControlUrl,
  mockDetectPageLanguageLightweight,
  mockEnsurePresetStyles,
  mockMountHostToast,
  mockOnMessage,
  mockRegisterNodeTranslationTriggers,
  mockSendMessage,
  mockSetupUrlChangeListener,
} = vi.hoisted(() => ({
  messageHandlers: new Map<string, (msg?: any) => any>(),
  managerInstances: [] as Array<{
    isActive: boolean
    isStarting: boolean
    temporaryMode: string | null
    getDetectedPageLanguage?: (url: string) => string | undefined
    start: ReturnType<typeof vi.fn>
    toggleOtherMode: ReturnType<typeof vi.fn>
    revalidateSession: ReturnType<typeof vi.fn>
    stop: ReturnType<typeof vi.fn>
    refreshSiteRuleCSS: ReturnType<typeof vi.fn>
    setTitleTranslationEnabled: ReturnType<typeof vi.fn>
    registerPageTranslationTriggers: ReturnType<typeof vi.fn>
  }>,
  mockBindTranslationShortcutKey: vi.fn<(...args: any[]) => any>(),
  mockClearEffectiveSiteControlUrl: vi.fn<(...args: any[]) => any>(),
  mockDetectPageLanguageLightweight: vi.fn<(...args: any[]) => any>(),
  mockEnsurePresetStyles: vi.fn<(...args: any[]) => any>(),
  mockMountHostToast: vi.fn<(...args: any[]) => any>(),
  mockOnMessage: vi.fn<(...args: any[]) => any>(),
  mockRegisterNodeTranslationTriggers: vi.fn<(...args: any[]) => any>(),
  mockSendMessage: vi.fn<(...args: any[]) => any>(),
  mockSetupUrlChangeListener: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/content/page-language", () => ({
  detectPageLanguageLightweight: mockDetectPageLanguageLightweight,
}))

vi.mock("@/utils/host/translate/ui/style-injector", () => ({
  ensurePresetStyles: mockEnsurePresetStyles,
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    error: vi.fn<(...args: any[]) => any>(),
    info: vi.fn<(...args: any[]) => any>(),
    warn: vi.fn<(...args: any[]) => any>(),
  },
}))

vi.mock("@/utils/message", () => ({
  onMessage: mockOnMessage,
  sendMessage: mockSendMessage,
}))

vi.mock("@/utils/site-control", () => ({
  clearEffectiveSiteControlUrl: mockClearEffectiveSiteControlUrl,
}))

vi.mock("../listen", () => ({
  setupUrlChangeListener: mockSetupUrlChangeListener,
}))

vi.mock("../mount-host-toast", () => ({
  mountHostToast: mockMountHostToast,
}))

vi.mock("../translation-control/bind-translation-shortcut", () => ({
  bindTranslationShortcutKey: mockBindTranslationShortcutKey,
}))

vi.mock("../translation-control/node-translation", () => ({
  registerNodeTranslationTriggers: mockRegisterNodeTranslationTriggers,
}))

vi.mock("../translation-control/page-translation", () => ({
  PageTranslationManager: class {
    isActive = false
    isStarting = false
    temporaryMode: string | null = null
    getDetectedPageLanguage?: (url: string) => string | undefined
    start = vi.fn<(...args: any[]) => any>(async (_context?: unknown, options?: any) => {
      this.isActive = true
      this.temporaryMode = options?.mode ?? null
    })

    toggleOtherMode = vi.fn<(...args: any[]) => any>(async () => {})

    revalidateSession = vi.fn<(...args: any[]) => any>(async () => {})

    stop = vi.fn<(...args: any[]) => any>(() => {
      this.isActive = false
      this.isStarting = false
      this.temporaryMode = null
    })

    refreshSiteRuleCSS = vi.fn<(...args: any[]) => any>(async () => {})

    setTitleTranslationEnabled = vi.fn<(...args: any[]) => any>()

    registerPageTranslationTriggers = vi.fn<(...args: any[]) => any>(() =>
      vi.fn<(...args: any[]) => any>(),
    )

    constructor(_options: unknown, getDetectedPageLanguage?: (url: string) => string | undefined) {
      this.getDetectedPageLanguage = getDetectedPageLanguage
      managerInstances.push(this)
    }
  },
}))

function createContentScriptContext() {
  const invalidationCallbacks: Array<() => void> = []

  return {
    ctx: {
      onInvalidated: (callback: () => void) => {
        invalidationCallbacks.push(callback)
      },
    } as ContentScriptContext,
    invalidate: () => {
      for (const callback of invalidationCallbacks) {
        callback()
      }
    },
  }
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
  await Promise.resolve()
}

describe("bootstrapHostContent URL changes", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageHandlers.clear()
    managerInstances.length = 0

    mockSetupUrlChangeListener.mockReturnValue(vi.fn<(...args: any[]) => any>())
    mockMountHostToast.mockReturnValue(vi.fn<(...args: any[]) => any>())
    mockRegisterNodeTranslationTriggers.mockReturnValue(vi.fn<(...args: any[]) => any>())
    mockBindTranslationShortcutKey.mockResolvedValue(vi.fn<(...args: any[]) => any>())
    mockOnMessage.mockImplementation((name: string, handler: (msg?: any) => any) => {
      messageHandlers.set(name, handler)
      return vi.fn<(...args: any[]) => any>()
    })
    mockDetectPageLanguageLightweight.mockResolvedValue({ detectedCodeOrUnd: "fra" })
    mockSendMessage.mockImplementation((name: string) => {
      if (name === "getPageTranslationSnapshotFromContentScript") {
        return Promise.resolve({ enabled: false })
      }

      return Promise.resolve(undefined)
    })
  })

  it("only refreshes site CSS on same-origin SPA navigation, keeping the session active", async () => {
    mockSendMessage.mockImplementation((name: string) => {
      if (name === "getPageTranslationSnapshotFromContentScript") {
        return Promise.resolve({ enabled: true })
      }

      return Promise.resolve(undefined)
    })

    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    const manager = managerInstances[0]

    window.dispatchEvent(
      new CustomEvent("extension:URLChange", {
        detail: {
          from: "https://example.com/articles/1",
          to: "https://example.com/articles/2?ref=nav#comments",
        },
      }),
    )
    await flushAsyncWork()

    expect(manager!.start).toHaveBeenCalledTimes(1)
    expect(manager!.refreshSiteRuleCSS).toHaveBeenCalledTimes(1)
    expect(manager!.stop).not.toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledWith("reportDetectedPageLanguage", {
      url: "https://example.com/articles/2?ref=nav#comments",
      detectedCodeOrUnd: "fra",
    })

    invalidate()
  })

  it("applies the tab title switch to the live session and stops watching on invalidation", async () => {
    const unwatch = vi.fn<() => void>()
    const watch = vi.spyOn(storage, "watch").mockReturnValue(unwatch)
    const { ctx, invalidate } = createContentScriptContext()
    try {
      await bootstrapHostContent(ctx, null)
      const manager = managerInstances[0]!
      const onConfigChange = watch.mock.calls.find(
        ([key]) => key === `local:${CONFIG_STORAGE_KEY}`,
      )?.[1]
      expect(onConfigChange).toBeDefined()

      const switchedOff = structuredClone(DEFAULT_CONFIG)
      switchedOff.pageTranslation.page.translateTitle = false
      onConfigChange!(switchedOff, DEFAULT_CONFIG)

      expect(manager.setTitleTranslationEnabled).toHaveBeenLastCalledWith(false)
      expect(manager.stop).not.toHaveBeenCalled()

      // Written before v109: the schema default keeps the title translated.
      const preMigration: any = structuredClone(DEFAULT_CONFIG)
      delete preMigration.pageTranslation.page.translateTitle
      onConfigChange!(preMigration, switchedOff)

      expect(manager.setTitleTranslationEnabled).toHaveBeenLastCalledWith(true)

      invalidate()
      expect(unwatch).toHaveBeenCalledOnce()
    } finally {
      watch.mockRestore()
    }
  })

  it("keeps inactive page translation inactive and only asks auto-translation on SPA navigation", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    const manager = managerInstances[0]

    window.dispatchEvent(
      new CustomEvent("extension:URLChange", {
        detail: {
          from: "https://example.com/articles/1",
          to: "https://example.com/articles/2",
        },
      }),
    )
    await flushAsyncWork()

    expect(manager!.start).not.toHaveBeenCalled()
    expect(manager!.refreshSiteRuleCSS).not.toHaveBeenCalled()
    expect(manager!.stop).not.toHaveBeenCalled()
    expect(mockSendMessage).toHaveBeenCalledWith("reportDetectedPageLanguage", {
      url: "https://example.com/articles/2",
      detectedCodeOrUnd: "fra",
    })

    invalidate()
  })

  it("refreshes and reports detected language when background requests active-tab refresh", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    await flushAsyncWork()

    mockSendMessage.mockClear()
    mockDetectPageLanguageLightweight.mockClear()
    mockDetectPageLanguageLightweight.mockResolvedValueOnce({ detectedCodeOrUnd: "jpn" })

    const refreshHandler = messageHandlers.get("refreshDetectedPageLanguage")
    if (!refreshHandler) {
      throw new Error("Expected refreshDetectedPageLanguage handler to be registered")
    }

    refreshHandler()
    await flushAsyncWork()

    expect(mockDetectPageLanguageLightweight).toHaveBeenCalledOnce()
    expect(mockSendMessage).toHaveBeenCalledWith("reportDetectedPageLanguage", {
      url: window.location.href,
      detectedCodeOrUnd: "jpn",
    })
    expect(managerInstances[0]?.getDetectedPageLanguage?.(window.location.href)).toBe("jpn")

    invalidate()
  })

  it("ignores an older detection that completes after the page URL changes", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    const manager = managerInstances[0]
    const oldUrl = window.location.href
    let resolveOld: ((result: { detectedCodeOrUnd: string }) => void) | undefined
    mockDetectPageLanguageLightweight.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    mockDetectPageLanguageLightweight.mockResolvedValueOnce({ detectedCodeOrUnd: "jpn" })

    messageHandlers.get("refreshDetectedPageLanguage")?.()
    window.history.pushState({}, "", "/analytics-new-page")
    const newUrl = window.location.href
    window.dispatchEvent(
      new CustomEvent("extension:URLChange", { detail: { from: oldUrl, to: newUrl } }),
    )
    await flushAsyncWork()
    resolveOld?.({ detectedCodeOrUnd: "fra" })
    await flushAsyncWork()

    expect(manager?.getDetectedPageLanguage?.(oldUrl)).toBeUndefined()
    expect(manager?.getDetectedPageLanguage?.(newUrl)).toBe("jpn")
    invalidate()
  })

  it("restores the tab's temporary mode from one snapshot when the page reloads or an iframe is injected late", async () => {
    mockSendMessage.mockImplementation((name: string) => {
      if (name === "getPageTranslationSnapshotFromContentScript") {
        return Promise.resolve({ enabled: true, mode: "translationOnly", sessionId: "session-a" })
      }

      return Promise.resolve(undefined)
    })

    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)

    // The restored session keeps the identity the background stored.
    expect(managerInstances[0]!.start).toHaveBeenCalledWith(undefined, {
      mode: "translationOnly",
      restore: true,
      sessionId: "session-a",
    })
    // enabled and mode come from the same read, never two requests that could disagree.
    const stateReads = mockSendMessage.mock.calls.filter(([name]) =>
      /PageTranslation(Snapshot|Mode)?FromContentScript$/.test(name),
    )
    expect(stateReads).toEqual([["getPageTranslationSnapshotFromContentScript", undefined]])

    invalidate()
  })

  it("only asks for the saved preference when the tab has no temporary mode", async () => {
    mockSendMessage.mockImplementation((name: string) => {
      if (name === "getPageTranslationSnapshotFromContentScript") {
        return Promise.resolve({ enabled: true })
      }

      return Promise.resolve(undefined)
    })

    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)

    expect(managerInstances[0]!.start).toHaveBeenCalledWith(undefined, {
      mode: undefined,
      restore: true,
    })

    invalidate()
  })

  it("does not start anything when translation is off", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)

    expect(managerInstances[0]!.start).not.toHaveBeenCalled()

    invalidate()
  })

  it("re-checks a running session on every config write, in addition to the title switch", async () => {
    const watch = vi.spyOn(storage, "watch").mockReturnValue(vi.fn<() => void>())
    const { ctx, invalidate } = createContentScriptContext()
    try {
      await bootstrapHostContent(ctx, null)
      const manager = managerInstances[0]!
      const onConfigChange = watch.mock.calls.find(
        ([key]) => key === `local:${CONFIG_STORAGE_KEY}`,
      )?.[1]

      onConfigChange!(DEFAULT_CONFIG, DEFAULT_CONFIG)

      // A static page produces no mutation or intersection event, so the config
      // write itself has to reach the session.
      expect(manager.revalidateSession).toHaveBeenCalledOnce()
      expect(manager.stop).not.toHaveBeenCalled()
      invalidate()
    } finally {
      watch.mockRestore()
    }
  })

  it("cancels a start still awaiting its gates when the plain toggle disables translation", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    const manager = managerInstances[0]!
    manager.isStarting = true

    messageHandlers.get("askManagerToTogglePageTranslation")?.({ data: { enabled: false } })

    expect(manager.stop).toHaveBeenCalledWith({ userInitiated: true })
    expect(manager.isStarting).toBe(false)

    invalidate()
  })

  it("does not stop an idle manager on a disable request", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    const manager = managerInstances[0]!

    messageHandlers.get("askManagerToTogglePageTranslation")?.({ data: { enabled: false } })

    expect(manager.stop).not.toHaveBeenCalled()

    invalidate()
  })

  it("cancels a pending start when the document navigates to another origin", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    const manager = managerInstances[0]!
    manager.isStarting = true

    window.dispatchEvent(
      new CustomEvent("extension:URLChange", {
        detail: { from: "https://example.com/a", to: "https://other.example.net/b" },
      }),
    )
    await flushAsyncWork()

    expect(manager.stop).toHaveBeenCalledOnce()

    invalidate()
  })

  it("hands the other-mode click to the top-frame manager together with its analytics context", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)

    const analyticsContext = { feature: "page_translation", surface: "floating_button" }
    messageHandlers.get("askManagerToToggleOtherModePageTranslation")?.({
      data: { analyticsContext },
    })

    expect(managerInstances[0]!.toggleOtherMode).toHaveBeenCalledWith(analyticsContext)
    // Never reinterpreted as a plain enable/disable request.
    expect(managerInstances[0]!.start).not.toHaveBeenCalled()
    expect(managerInstances[0]!.stop).not.toHaveBeenCalled()

    invalidate()
  })

  it("ignores an auto-translation enable while a temporary-mode session is active", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    const manager = managerInstances[0]!
    manager.isActive = true
    manager.temporaryMode = "translationOnly"

    messageHandlers.get("askManagerToTogglePageTranslation")?.({ data: { enabled: true } })

    expect(manager.start).not.toHaveBeenCalled()
    expect(manager.stop).not.toHaveBeenCalled()
    expect(manager.temporaryMode).toBe("translationOnly")

    invalidate()
  })

  it("stops with user intent when the plain toggle disables an active session", async () => {
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    const manager = managerInstances[0]!
    manager.isActive = true
    manager.temporaryMode = "translationOnly"

    messageHandlers.get("askManagerToTogglePageTranslation")?.({ data: { enabled: false } })

    expect(manager.stop).toHaveBeenCalledWith({ userInitiated: true })
    expect(manager.temporaryMode).toBeNull()

    invalidate()
  })
})

describe("bootstrapHostContent iframe state follow", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageHandlers.clear()
    managerInstances.length = 0

    mockSetupUrlChangeListener.mockReturnValue(vi.fn<(...args: any[]) => any>())
    mockMountHostToast.mockReturnValue(vi.fn<(...args: any[]) => any>())
    mockRegisterNodeTranslationTriggers.mockReturnValue(vi.fn<(...args: any[]) => any>())
    mockBindTranslationShortcutKey.mockResolvedValue(vi.fn<(...args: any[]) => any>())
    mockOnMessage.mockImplementation((name: string, handler: (msg?: any) => any) => {
      messageHandlers.set(name, handler)
      return vi.fn<(...args: any[]) => any>()
    })
    mockDetectPageLanguageLightweight.mockResolvedValue({ detectedCodeOrUnd: "fra" })
    mockSendMessage.mockResolvedValue(undefined)
  })

  async function bootstrapAsIframe() {
    // Not the top frame: only the top frame owns the click decision.
    vi.spyOn(window, "top", "get").mockReturnValue({} as Window & typeof globalThis)
    const { ctx, invalidate } = createContentScriptContext()
    await bootstrapHostContent(ctx, null)
    return { manager: managerInstances[0]!, invalidate }
  }

  it("does not own the other-mode click and follows the top frame's broadcast instead", async () => {
    const { manager, invalidate } = await bootstrapAsIframe()

    expect(messageHandlers.has("askManagerToToggleOtherModePageTranslation")).toBe(false)

    messageHandlers.get("notifyTranslationStateChanged")?.({
      data: { enabled: true, mode: "translationOnly" },
    })
    expect(manager.start).toHaveBeenCalledWith(undefined, { mode: "translationOnly" })

    invalidate()
    vi.restoreAllMocks()
  })

  it("switches a live iframe session when the broadcast carries a different mode", async () => {
    const { manager, invalidate } = await bootstrapAsIframe()
    manager.isActive = true
    manager.temporaryMode = null

    messageHandlers.get("notifyTranslationStateChanged")?.({
      data: { enabled: true, mode: "translationOnly" },
    })
    expect(manager.start).toHaveBeenCalledWith(undefined, {
      mode: "translationOnly",
      replaceActiveSession: true,
    })

    manager.start.mockClear()
    manager.temporaryMode = "translationOnly"
    // Its own echo coming back must not restart it again.
    messageHandlers.get("notifyTranslationStateChanged")?.({
      data: { enabled: true, mode: "translationOnly" },
    })
    expect(manager.start).not.toHaveBeenCalled()

    invalidate()
    vi.restoreAllMocks()
  })

  it("returns a live iframe session to the saved preference when the broadcast has no mode", async () => {
    const { manager, invalidate } = await bootstrapAsIframe()
    manager.isActive = true
    manager.temporaryMode = "translationOnly"

    messageHandlers.get("notifyTranslationStateChanged")?.({ data: { enabled: true } })
    expect(manager.start).toHaveBeenCalledWith(undefined, {
      mode: undefined,
      replaceActiveSession: true,
    })

    invalidate()
    vi.restoreAllMocks()
  })

  it("cancels an iframe start that is still pending when the broadcast disables translation", async () => {
    const { manager, invalidate } = await bootstrapAsIframe()
    // Between its guard and activation: not active yet, so an isActive-only
    // check would let the old start resurrect the stopped frame.
    manager.isStarting = true

    messageHandlers.get("notifyTranslationStateChanged")?.({ data: { enabled: false } })
    expect(manager.stop).toHaveBeenCalledOnce()
    expect(manager.isStarting).toBe(false)

    invalidate()
    vi.restoreAllMocks()
  })

  it("does not touch an idle iframe on a disable broadcast", async () => {
    const { manager, invalidate } = await bootstrapAsIframe()

    messageHandlers.get("notifyTranslationStateChanged")?.({ data: { enabled: false } })
    expect(manager.stop).not.toHaveBeenCalled()

    invalidate()
    vi.restoreAllMocks()
  })

  it("re-checks the iframe's own session on config writes without parsing the title switch", async () => {
    const watch = vi.spyOn(storage, "watch").mockReturnValue(vi.fn<() => void>())
    const { manager, invalidate } = await bootstrapAsIframe()
    const onConfigChange = watch.mock.calls.find(
      ([key]) => key === `local:${CONFIG_STORAGE_KEY}`,
    )?.[1]

    onConfigChange!(DEFAULT_CONFIG, DEFAULT_CONFIG)

    expect(manager.revalidateSession).toHaveBeenCalledOnce()
    expect(manager.setTitleTranslationEnabled).not.toHaveBeenCalled()

    invalidate()
    vi.restoreAllMocks()
  })

  it("stops the iframe session when the broadcast disables translation", async () => {
    const { manager, invalidate } = await bootstrapAsIframe()
    manager.isActive = true
    manager.temporaryMode = "translationOnly"

    messageHandlers.get("notifyTranslationStateChanged")?.({ data: { enabled: false } })
    expect(manager.stop).toHaveBeenCalledOnce()
    expect(manager.temporaryMode).toBeNull()

    invalidate()
    vi.restoreAllMocks()
  })
})

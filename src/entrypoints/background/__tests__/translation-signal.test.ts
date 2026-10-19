import { beforeEach, describe, expect, it, vi } from "vitest"
import { browser, storage } from "#imports"
import { CONFIG_STORAGE_KEY, DEFAULT_CONFIG, DEFAULT_DETECTED_CODE } from "@/utils/constants/config"
import { GOOGLE_TRANSLATE_PROVIDER_ID } from "@/utils/constants/providers"
import { getDetectedCodeStateKey, getTranslationStateKey } from "@/utils/constants/storage-keys"

const sendMessageMock = vi.fn<(...args: any[]) => any>()
const onMessageMock = vi.fn<(...args: any[]) => any>()
const storageGetItemMock = vi.fn<(...args: any[]) => any>()
const storageSetItemMock = vi.fn<(...args: any[]) => any>()
const storageRemoveItemMock = vi.fn<(...args: any[]) => any>()
const tabsOnRemovedAddListenerMock = vi.fn<(...args: any[]) => any>()
const tabsOnActivatedAddListenerMock = vi.fn<(...args: any[]) => any>()
const tabsQueryMock = vi.fn<(...args: any[]) => any>()
const tabsGetMock = vi.fn<(...args: any[]) => any>()
const webNavigationOnCommittedAddListenerMock = vi.fn<(...args: any[]) => any>()
const injectHostContentIntoTabIframesMock = vi.fn<(...args: any[]) => any>()
const injectHostContentIntoCurrentTabIframesAfterNodeTranslationMock =
  vi.fn<(...args: any[]) => any>()
const loggerErrorMock = vi.fn<(...args: any[]) => any>()
const loggerWarnMock = vi.fn<(...args: any[]) => any>()
const shouldEnableAutoTranslationMock = vi.fn<(...args: any[]) => any>()

const messageHandlers = new Map<string, (msg: any) => any>()

vi.mock("@/utils/message", () => ({
  onMessage: onMessageMock,
  sendMessage: sendMessageMock,
}))

vi.mock("@/utils/host/translate/auto-translation", () => ({
  shouldEnableAutoTranslation: shouldEnableAutoTranslationMock,
}))

vi.mock("@/utils/logger", () => ({
  logger: {
    error: loggerErrorMock,
    warn: loggerWarnMock,
    info: vi.fn<(...args: any[]) => any>(),
  },
}))

vi.mock("../iframe-injection", () => ({
  injectHostContentIntoTabIframes: injectHostContentIntoTabIframesMock,
  injectHostContentIntoCurrentTabIframesAfterNodeTranslation:
    injectHostContentIntoCurrentTabIframesAfterNodeTranslationMock,
}))

function getHandler(name: string) {
  const handler = messageHandlers.get(name)
  if (!handler) {
    throw new Error(`Expected message handler to be registered: ${name}`)
  }
  return handler
}

function getOnCommittedListener() {
  const listener = webNavigationOnCommittedAddListenerMock.mock.calls.at(-1)?.[0]
  if (!listener) {
    throw new Error("Expected webNavigation.onCommitted listener to be registered")
  }
  return listener as (details: { tabId: number; frameId: number; url: string }) => Promise<void>
}

function getOnRemovedListener() {
  const listener = tabsOnRemovedAddListenerMock.mock.calls.at(-1)?.[0]
  if (!listener) {
    throw new Error("Expected tabs.onRemoved listener to be registered")
  }
  return listener as (tabId: number) => Promise<void>
}

function getOnActivatedListener() {
  const listener = tabsOnActivatedAddListenerMock.mock.calls.at(-1)?.[0]
  if (!listener) {
    throw new Error("Expected tabs.onActivated listener to be registered")
  }
  return listener as (activeInfo: { tabId: number }) => Promise<void>
}

async function setupSubject() {
  const { translationMessage } = await import("../translation-signal")
  translationMessage()
}

describe("translationMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    messageHandlers.clear()

    browser.tabs.onRemoved.addListener = tabsOnRemovedAddListenerMock
    browser.tabs.onActivated.addListener = tabsOnActivatedAddListenerMock
    browser.tabs.query = tabsQueryMock
    browser.tabs.get = tabsGetMock
    browser.webNavigation.onCommitted.addListener = webNavigationOnCommittedAddListenerMock
    storage.getItem = storageGetItemMock
    storage.setItem = storageSetItemMock
    storage.removeItem = storageRemoveItemMock

    onMessageMock.mockImplementation((name: string, handler: (msg: any) => any) => {
      messageHandlers.set(name, handler)
      return vi.fn<(...args: any[]) => any>()
    })
    sendMessageMock.mockResolvedValue(undefined)
    tabsQueryMock.mockResolvedValue([{ id: 42 }])
    tabsGetMock.mockRejectedValue(new Error("tab not found"))
    storageGetItemMock.mockResolvedValue(undefined)
    storageSetItemMock.mockResolvedValue(undefined)
    storageRemoveItemMock.mockResolvedValue(undefined)
    shouldEnableAutoTranslationMock.mockResolvedValue(false)
  })

  it("persists manager-enabled state and injects current iframes from the top frame", async () => {
    await setupSubject()

    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: true, url: "https://example.com/articles/1" },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: true,
      origin: "https://example.com",
    })
    expect(sendMessageMock).toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      { enabled: true },
      42,
    )
    expect(injectHostContentIntoTabIframesMock).toHaveBeenCalledWith(42)
  })

  it("does not overwrite tab state or reinject every iframe when an iframe manager echoes enabled state", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue({ enabled: true, origin: "https://example.com" })

    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: true, url: "https://embed.example.net/frame" },
      sender: { tab: { id: 42 }, frameId: 7 },
    })

    expect(storageSetItemMock).not.toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      { enabled: true },
      42,
    )
    expect(injectHostContentIntoTabIframesMock).not.toHaveBeenCalled()
  })

  it("ignores enabled iframe manager echoes when tab translation is not already active", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue(undefined)

    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: true, url: "https://embed.example.net/frame" },
      sender: { tab: { id: 42 }, frameId: 7 },
    })

    expect(storageSetItemMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      { enabled: true },
      42,
    )
    expect(injectHostContentIntoTabIframesMock).not.toHaveBeenCalled()
  })

  it("persists the temporary mode with the enabled state and broadcasts it", async () => {
    await setupSubject()

    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: true, url: "https://example.com/articles/1", mode: "translationOnly" },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: true,
      origin: "https://example.com",
      mode: "translationOnly",
    })
    expect(sendMessageMock).toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      { enabled: true, mode: "translationOnly" },
      42,
    )
  })

  it("does not carry an earlier temporary mode into a start that uses the saved preference", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue({
      enabled: true,
      origin: "https://example.com",
      mode: "translationOnly",
    })

    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: true, url: "https://example.com/articles/1" },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: true,
      origin: "https://example.com",
    })
    expect(sendMessageMock).toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      { enabled: true },
      42,
    )
  })

  it("drops the temporary mode and records the refusal when the manager stops on user request", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue({
      enabled: true,
      origin: "https://example.com",
      mode: "translationOnly",
    })

    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: false, url: "https://example.com/articles/1", userInitiated: true },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: false,
      userDisabled: true,
      origin: "https://example.com",
    })
    expect(sendMessageMock).toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      { enabled: false },
      42,
    )
  })

  it("re-broadcasts an iframe echo only when it carries the tab's current mode", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue({
      enabled: true,
      origin: "https://example.com",
      mode: "translationOnly",
    })

    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: true, url: "https://embed.example.net/frame", mode: "translationOnly" },
      sender: { tab: { id: 42 }, frameId: 7 },
    })

    expect(storageSetItemMock).not.toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      { enabled: true, mode: "translationOnly" },
      42,
    )
  })

  it("drops a stale iframe echo from a different mode instead of contradicting the top frame", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue({
      enabled: true,
      origin: "https://example.com",
      mode: "translationOnly",
    })

    // The iframe is still reporting the preference mode it was started in.
    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: true, url: "https://embed.example.net/frame" },
      sender: { tab: { id: 42 }, frameId: 7 },
    })

    expect(storageSetItemMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      expect.anything(),
      42,
    )
  })

  it("drops an iframe echo for the preference mode while the tab runs a temporary mode", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue({ enabled: true, origin: "https://example.com" })

    await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
      data: { enabled: true, url: "https://embed.example.net/frame", mode: "translationOnly" },
      sender: { tab: { id: 42 }, frameId: 7 },
    })

    expect(sendMessageMock).not.toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      expect.anything(),
      42,
    )
  })

  it("hands content scripts the tab's enabled flag and temporary mode as one snapshot", async () => {
    await setupSubject()
    const getSnapshot = getHandler("getPageTranslationSnapshotFromContentScript")

    storageGetItemMock.mockResolvedValue({
      enabled: true,
      origin: "https://example.com",
      mode: "translationOnly",
    })
    await expect(getSnapshot({ sender: { tab: { id: 42 }, frameId: 3 } })).resolves.toEqual({
      enabled: true,
      mode: "translationOnly",
    })

    storageGetItemMock.mockResolvedValue({ enabled: true, origin: "https://example.com" })
    await expect(getSnapshot({ sender: { tab: { id: 42 } } })).resolves.toEqual({
      enabled: true,
      mode: undefined,
    })

    // A mode left on a disabled record is never reported as live.
    storageGetItemMock.mockResolvedValue({ enabled: false, mode: "translationOnly" })
    await expect(getSnapshot({ sender: { tab: { id: 42 } } })).resolves.toEqual({
      enabled: false,
    })

    await expect(getSnapshot({ sender: {} })).resolves.toEqual({ enabled: false })
  })

  it("forwards the other-mode click to the sender's tab without touching stored state", async () => {
    await setupSubject()
    const analyticsContext = { feature: "page_translation", surface: "floating_button" }

    await getHandler("toggleOtherModePageTranslationOnContentScript")({
      data: { analyticsContext },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(sendMessageMock).toHaveBeenCalledWith(
      "askManagerToToggleOtherModePageTranslation",
      { analyticsContext },
      42,
    )
    // The manager decides; the background must not pre-write enabled/userDisabled.
    expect(storageSetItemMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      "askManagerToTogglePageTranslation",
      expect.anything(),
      expect.anything(),
    )
  })

  it("clears state immediately when a tab-level request disables page translation", async () => {
    await setupSubject()

    await getHandler("tryToSetEnablePageTranslationByTabId")({
      data: { tabId: 42, enabled: false },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), { enabled: false })
    expect(sendMessageMock).toHaveBeenCalledWith(
      "notifyTranslationStateChanged",
      { enabled: false },
      42,
    )
    expect(sendMessageMock).toHaveBeenCalledWith(
      "askManagerToTogglePageTranslation",
      {
        enabled: false,
        analyticsContext: undefined,
      },
      42,
    )
  })

  it("injects current iframes when explicitly asked for a tab", async () => {
    await setupSubject()

    await getHandler("ensureIframeHostContentInjected")({
      data: { tabId: 42 },
    })

    expect(injectHostContentIntoTabIframesMock).toHaveBeenCalledWith(42)
  })

  it("does not inject current iframes without a valid tab id", async () => {
    await setupSubject()

    await getHandler("ensureIframeHostContentInjected")({
      data: {},
      sender: {},
    })

    expect(injectHostContentIntoTabIframesMock).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Invalid tabId in ensureIframeHostContentInjected",
      expect.objectContaining({
        data: {},
        sender: {},
      }),
    )
  })

  it("injects current iframes after successful top-frame node translation", async () => {
    await setupSubject()

    await getHandler("injectCurrentIframesAfterTopFrameNodeTranslation")({
      data: undefined,
      sender: {
        tab: { id: 42 },
        frameId: 0,
      },
    })

    expect(injectHostContentIntoCurrentTabIframesAfterNodeTranslationMock).toHaveBeenCalledWith(42)
    expect(injectHostContentIntoTabIframesMock).not.toHaveBeenCalled()
  })

  it("stores detected language by sender tab and notifies when it is the active tab", async () => {
    await setupSubject()
    tabsQueryMock.mockResolvedValue([{ id: 42 }])

    await getHandler("reportDetectedPageLanguage")({
      data: { detectedCodeOrUnd: "cmn", url: "https://zh.example.test" },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(getDetectedCodeStateKey(42), "cmn")
    expect(sendMessageMock).toHaveBeenCalledWith("detectedPageLanguageChanged", {
      detectedCode: "cmn",
    })
  })

  it("does not notify detected language from an inactive tab", async () => {
    await setupSubject()
    tabsQueryMock.mockResolvedValue([{ id: 7 }])

    await getHandler("reportDetectedPageLanguage")({
      data: { detectedCodeOrUnd: "jpn", url: "https://ja.example.test" },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(getDetectedCodeStateKey(42), "jpn")
    expect(sendMessageMock).not.toHaveBeenCalledWith("detectedPageLanguageChanged", {
      detectedCode: "jpn",
    })
  })

  it("normalizes undetected page language before caching", async () => {
    await setupSubject()

    await getHandler("reportDetectedPageLanguage")({
      data: { detectedCodeOrUnd: "und", url: "https://example.test" },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(
      getDetectedCodeStateKey(42),
      DEFAULT_DETECTED_CODE,
    )
  })

  it("normalizes unsupported page language before caching and notifying", async () => {
    await setupSubject()
    tabsQueryMock.mockResolvedValue([{ id: 42 }])

    await getHandler("reportDetectedPageLanguage")({
      data: { detectedCodeOrUnd: "vmw", url: "https://example.test" },
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(storageSetItemMock).toHaveBeenCalledWith(
      getDetectedCodeStateKey(42),
      DEFAULT_DETECTED_CODE,
    )
    expect(sendMessageMock).toHaveBeenCalledWith("detectedPageLanguageChanged", {
      detectedCode: DEFAULT_DETECTED_CODE,
    })
  })

  it("returns the sender tab detected language to content scripts", async () => {
    await setupSubject()
    storageGetItemMock.mockImplementation(async (key: string) => {
      if (key === getDetectedCodeStateKey(42)) return "jpn"
      return undefined
    })

    const detectedCode = await getHandler("getDetectedCode")({
      data: undefined,
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(detectedCode).toBe("jpn")
  })

  it("normalizes unsupported cached detected language for content scripts", async () => {
    await setupSubject()
    storageGetItemMock.mockImplementation(async (key: string) => {
      if (key === getDetectedCodeStateKey(42)) return "vmw"
      return undefined
    })

    const detectedCode = await getHandler("getDetectedCode")({
      data: undefined,
      sender: { tab: { id: 42 }, frameId: 0 },
    })

    expect(detectedCode).toBe(DEFAULT_DETECTED_CODE)
  })

  it("returns the active tab detected language to extension pages", async () => {
    await setupSubject()
    tabsQueryMock.mockResolvedValue([{ id: 8 }])
    storageGetItemMock.mockImplementation(async (key: string) => {
      if (key === getDetectedCodeStateKey(8)) return "cmn"
      return undefined
    })

    const detectedCode = await getHandler("getDetectedCode")({
      data: undefined,
      sender: {},
    })

    expect(detectedCode).toBe("cmn")
  })

  it("rejects iframe senders for top-frame node translation iframe injection", async () => {
    await setupSubject()

    await getHandler("injectCurrentIframesAfterTopFrameNodeTranslation")({
      data: undefined,
      sender: { tab: { id: 42 }, frameId: 7 },
    })

    expect(injectHostContentIntoCurrentTabIframesAfterNodeTranslationMock).not.toHaveBeenCalled()
    expect(loggerErrorMock).toHaveBeenCalledWith(
      "Invalid sender in injectCurrentIframesAfterTopFrameNodeTranslation",
      expect.objectContaining({
        sender: { tab: { id: 42 }, frameId: 7 },
      }),
    )
  })

  it("waits for the top-frame manager to validate before enabling iframe injection", async () => {
    await setupSubject()

    await getHandler("tryToSetEnablePageTranslationByTabId")({
      data: { tabId: 42, enabled: true },
    })

    expect(storageSetItemMock).not.toHaveBeenCalled()
    expect(injectHostContentIntoTabIframesMock).not.toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledWith(
      "askManagerToTogglePageTranslation",
      {
        enabled: true,
        analyticsContext: undefined,
      },
      42,
    )
  })

  it("publishes cached detected language and requests refresh when tabs are activated", async () => {
    await setupSubject()
    storageGetItemMock.mockImplementation(async (key: string) => {
      if (key === getDetectedCodeStateKey(1)) return "cmn"
      if (key === getDetectedCodeStateKey(2)) return "jpn"
      return undefined
    })

    const onActivated = getOnActivatedListener()
    await onActivated({ tabId: 1 })
    await onActivated({ tabId: 2 })

    expect(sendMessageMock).toHaveBeenCalledWith("detectedPageLanguageChanged", {
      detectedCode: "cmn",
    })
    expect(sendMessageMock).toHaveBeenCalledWith("detectedPageLanguageChanged", {
      detectedCode: "jpn",
    })
    expect(sendMessageMock).toHaveBeenCalledWith("refreshDetectedPageLanguage", undefined, 1)
    expect(sendMessageMock).toHaveBeenCalledWith("refreshDetectedPageLanguage", undefined, 2)
  })

  it("publishes default detected language when an activated tab has no cache", async () => {
    await setupSubject()

    await getOnActivatedListener()({ tabId: 42 })

    expect(sendMessageMock).toHaveBeenCalledWith("detectedPageLanguageChanged", {
      detectedCode: DEFAULT_DETECTED_CODE,
    })
    expect(sendMessageMock).toHaveBeenCalledWith("refreshDetectedPageLanguage", undefined, 42)
  })

  it("clears detected language cache when a tab is removed", async () => {
    await setupSubject()

    await getOnRemovedListener()(42)

    expect(storageRemoveItemMock).toHaveBeenCalledWith(getTranslationStateKey(42))
    expect(storageRemoveItemMock).toHaveBeenCalledWith(getDetectedCodeStateKey(42))
  })

  it("keeps enabled translation state on same-origin top-frame navigation", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue({ enabled: true, origin: "https://example.com" })

    await getOnCommittedListener()({
      tabId: 42,
      frameId: 0,
      url: "https://example.com/articles/2?from=feed#comments",
    })

    expect(storageRemoveItemMock).not.toHaveBeenCalled()
  })

  it("clears enabled translation state on cross-origin top-frame navigation", async () => {
    await setupSubject()
    storageGetItemMock.mockResolvedValue({ enabled: true, origin: "https://example.com" })

    await getOnCommittedListener()({
      tabId: 42,
      frameId: 0,
      url: "https://other.example.com/articles/2",
    })

    expect(storageRemoveItemMock).toHaveBeenCalledWith(getTranslationStateKey(42))
  })

  it("does not clear translation state for iframe navigations", async () => {
    await setupSubject()

    await getOnCommittedListener()({
      tabId: 42,
      frameId: 3,
      url: "https://other.example.com/frame",
    })

    expect(storageGetItemMock).not.toHaveBeenCalled()
    expect(storageRemoveItemMock).not.toHaveBeenCalled()
  })

  describe("user-disable suppression (#2011)", () => {
    const USER_DISABLED_STATE = {
      enabled: false,
      userDisabled: true,
      origin: "https://example.com",
    }

    function mockConfigAndState(state: unknown) {
      storageGetItemMock.mockImplementation(async (key: string) => {
        if (key === `local:${CONFIG_STORAGE_KEY}`) return {}
        if (key === getTranslationStateKey(42)) return state
        return undefined
      })
    }

    it("records a user refusal with origin when the popup disables page translation", async () => {
      await setupSubject()
      tabsGetMock.mockResolvedValue({ id: 42, url: "https://example.com/articles/1" })

      await getHandler("tryToSetEnablePageTranslationByTabId")({
        data: { tabId: 42, enabled: false },
      })

      expect(storageSetItemMock).toHaveBeenCalledWith(
        getTranslationStateKey(42),
        USER_DISABLED_STATE,
      )
    })

    it("falls back to a bare disable when the popup disables on an origin-less URL", async () => {
      await setupSubject()
      tabsGetMock.mockResolvedValue({ id: 42, url: "chrome://newtab/" })

      await getHandler("tryToSetEnablePageTranslationByTabId")({
        data: { tabId: 42, enabled: false },
      })

      expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
        enabled: false,
      })
    })

    it("records a user refusal when a content-script surface disables page translation", async () => {
      await setupSubject()

      await getHandler("tryToSetEnablePageTranslationOnContentScript")({
        data: { enabled: false },
        sender: { tab: { id: 42, url: "https://example.com/articles/1" } },
      })

      expect(storageSetItemMock).toHaveBeenCalledWith(
        getTranslationStateKey(42),
        USER_DISABLED_STATE,
      )
    })

    it("records a user refusal from a user-initiated top-frame manager stop echo", async () => {
      await setupSubject()

      await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
        data: { enabled: false, url: "https://example.com/articles/1", userInitiated: true },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(storageSetItemMock).toHaveBeenCalledWith(
        getTranslationStateKey(42),
        USER_DISABLED_STATE,
      )
    })

    it("does not invent a user refusal for programmatic manager stop echoes", async () => {
      await setupSubject()

      await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
        data: { enabled: false, url: "https://example.com/articles/1" },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
        enabled: false,
      })
    })

    it("never writes tab state from iframe disable echoes, even user-initiated ones", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue({ enabled: true, origin: "https://example.com" })

      await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
        data: { enabled: false, url: "https://embed.example.net/frame", userInitiated: true },
        sender: { tab: { id: 42 }, frameId: 7 },
      })

      expect(storageSetItemMock).not.toHaveBeenCalled()
      // The top frame is still translating; the iframe echo must not make the
      // UI claim translation is off.
      expect(sendMessageMock).not.toHaveBeenCalledWith(
        "notifyTranslationStateChanged",
        { enabled: false },
        42,
      )
    })

    it("re-broadcasts iframe disable echoes that agree with the stored state without writing", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue({ enabled: false })

      await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
        data: { enabled: false, url: "https://embed.example.net/frame" },
        sender: { tab: { id: 42 }, frameId: 7 },
      })

      expect(storageSetItemMock).not.toHaveBeenCalled()
      expect(sendMessageMock).toHaveBeenCalledWith(
        "notifyTranslationStateChanged",
        { enabled: false },
        42,
      )
    })

    it("suppresses auto-translation for the origin the user refused", async () => {
      await setupSubject()
      shouldEnableAutoTranslationMock.mockResolvedValue(true)
      mockConfigAndState(USER_DISABLED_STATE)

      await getHandler("reportDetectedPageLanguage")({
        data: { detectedCodeOrUnd: "eng", url: "https://example.com/articles/2" },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      // Detected-language caching and notification still happen.
      expect(storageSetItemMock).toHaveBeenCalledWith(getDetectedCodeStateKey(42), "eng")
      expect(sendMessageMock).not.toHaveBeenCalledWith(
        "askManagerToTogglePageTranslation",
        expect.objectContaining({ enabled: true }),
        42,
      )
    })

    it("still auto-translates other origins after a refusal elsewhere", async () => {
      await setupSubject()
      shouldEnableAutoTranslationMock.mockResolvedValue(true)
      mockConfigAndState(USER_DISABLED_STATE)

      await getHandler("reportDetectedPageLanguage")({
        data: { detectedCodeOrUnd: "eng", url: "https://other.example.net/page" },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(sendMessageMock).toHaveBeenCalledWith(
        "askManagerToTogglePageTranslation",
        expect.objectContaining({ enabled: true }),
        42,
      )
    })

    it("does not let a bare disabled state suppress auto-translation", async () => {
      // Programmatic stops (SPA navigation, mode changes) write {enabled:false}
      // without userDisabled; those must never veto auto-translation.
      await setupSubject()
      shouldEnableAutoTranslationMock.mockResolvedValue(true)
      mockConfigAndState({ enabled: false })

      await getHandler("reportDetectedPageLanguage")({
        data: { detectedCodeOrUnd: "eng", url: "https://example.com/articles/2" },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(sendMessageMock).toHaveBeenCalledWith(
        "askManagerToTogglePageTranslation",
        expect.objectContaining({ enabled: true }),
        42,
      )
    })

    it("keeps the user refusal on same-origin navigation", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue(USER_DISABLED_STATE)

      await getOnCommittedListener()({
        tabId: 42,
        frameId: 0,
        url: "https://example.com/articles/3",
      })

      expect(storageRemoveItemMock).not.toHaveBeenCalled()
    })

    it("clears the user refusal when the tab leaves the origin", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue(USER_DISABLED_STATE)

      await getOnCommittedListener()({
        tabId: 42,
        frameId: 0,
        url: "https://other.example.net/page",
      })

      expect(storageRemoveItemMock).toHaveBeenCalledWith(getTranslationStateKey(42))
    })

    it("clears the user refusal when the tab commits to an origin-less URL", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue(USER_DISABLED_STATE)

      await getOnCommittedListener()({
        tabId: 42,
        frameId: 0,
        url: "chrome://newtab/",
      })

      expect(storageRemoveItemMock).toHaveBeenCalledWith(getTranslationStateKey(42))
    })

    it("leaves bare disabled records untouched on navigation", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue({ enabled: false })

      await getOnCommittedListener()({
        tabId: 42,
        frameId: 0,
        url: "https://other.example.net/page",
      })

      expect(storageRemoveItemMock).not.toHaveBeenCalled()
    })
  })

  describe("provider-forced close of a temporary translationOnly session", () => {
    const INVALIDATED_STATE = {
      enabled: false,
      sessionInvalidated: true,
      origin: "https://example.com",
    }

    function mockConfigAndState(state: unknown, providerId: string) {
      storageGetItemMock.mockImplementation(async (key: string) => {
        if (key === `local:${CONFIG_STORAGE_KEY}`) {
          return {
            ...DEFAULT_CONFIG,
            pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, providerId },
          }
        }
        if (key === getTranslationStateKey(42)) return state
        return undefined
      })
    }

    it("records the close without faking a user refusal", async () => {
      await setupSubject()

      await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
        data: { enabled: false, url: "https://example.com/articles/1", sessionInvalidated: true },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), INVALIDATED_STATE)
      expect(sendMessageMock).toHaveBeenCalledWith(
        "notifyTranslationStateChanged",
        { enabled: false },
        42,
      )
    })

    it("holds auto-translation back on that origin while the provider is still unsupported", async () => {
      await setupSubject()
      shouldEnableAutoTranslationMock.mockResolvedValue(true)
      mockConfigAndState(INVALIDATED_STATE, DEFAULT_CONFIG.pageTranslation.providerId)

      await getHandler("reportDetectedPageLanguage")({
        data: { detectedCodeOrUnd: "eng", url: "https://example.com/articles/2" },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(sendMessageMock).not.toHaveBeenCalledWith(
        "askManagerToTogglePageTranslation",
        expect.objectContaining({ enabled: true }),
        42,
      )
    })

    it("lets auto-translation resume once the provider supports translationOnly again", async () => {
      await setupSubject()
      shouldEnableAutoTranslationMock.mockResolvedValue(true)
      mockConfigAndState(INVALIDATED_STATE, GOOGLE_TRANSLATE_PROVIDER_ID)

      await getHandler("reportDetectedPageLanguage")({
        data: { detectedCodeOrUnd: "eng", url: "https://example.com/articles/2" },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(sendMessageMock).toHaveBeenCalledWith(
        "askManagerToTogglePageTranslation",
        expect.objectContaining({ enabled: true }),
        42,
      )
    })

    it("does not hold auto-translation back on other origins", async () => {
      await setupSubject()
      shouldEnableAutoTranslationMock.mockResolvedValue(true)
      mockConfigAndState(INVALIDATED_STATE, DEFAULT_CONFIG.pageTranslation.providerId)

      await getHandler("reportDetectedPageLanguage")({
        data: { detectedCodeOrUnd: "eng", url: "https://other.example.net/page" },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(sendMessageMock).toHaveBeenCalledWith(
        "askManagerToTogglePageTranslation",
        expect.objectContaining({ enabled: true }),
        42,
      )
    })

    it("is replaced by an explicit start, which carries no marker", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue(INVALIDATED_STATE)

      await getHandler("setAndNotifyPageTranslationStateChangedByManager")({
        data: { enabled: true, url: "https://example.com/articles/1" },
        sender: { tab: { id: 42 }, frameId: 0 },
      })

      expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
        enabled: true,
        origin: "https://example.com",
      })
    })

    it("keeps the marker on same-origin navigation and clears it when the tab leaves", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue(INVALIDATED_STATE)

      await getOnCommittedListener()({
        tabId: 42,
        frameId: 0,
        url: "https://example.com/articles/3",
      })
      expect(storageRemoveItemMock).not.toHaveBeenCalled()

      await getOnCommittedListener()({
        tabId: 42,
        frameId: 0,
        url: "https://other.example.net/page",
      })
      expect(storageRemoveItemMock).toHaveBeenCalledWith(getTranslationStateKey(42))
    })
  })

  describe("closing a stale restored state", () => {
    const STALE_STATE = {
      enabled: true,
      origin: "https://example.com",
      mode: "translationOnly",
    }
    const close = (frameId: number | undefined = 0) =>
      getHandler("closeStalePageTranslationState")({
        data: { url: "https://example.com/articles/1", staleMode: "translationOnly" },
        sender: { tab: { id: 42 }, frameId },
      })

    it("clears enabled and mode in one write and broadcasts disabled", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue(STALE_STATE)

      await close()

      expect(storageSetItemMock).toHaveBeenCalledTimes(1)
      expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
        enabled: false,
        sessionInvalidated: true,
        origin: "https://example.com",
      })
      expect(sendMessageMock).toHaveBeenCalledWith(
        "notifyTranslationStateChanged",
        { enabled: false },
        42,
      )
    })

    it("does not clear a newer start that already replaced the stale mode", async () => {
      await setupSubject()

      // The user restarted in the saved preference (no mode) before the late failure arrived.
      storageGetItemMock.mockResolvedValue({ enabled: true, origin: "https://example.com" })
      await close()
      // ...or already turned translation off themselves.
      storageGetItemMock.mockResolvedValue({
        enabled: false,
        userDisabled: true,
        origin: "https://example.com",
      })
      await close()

      expect(storageSetItemMock).not.toHaveBeenCalled()
      expect(sendMessageMock).not.toHaveBeenCalled()
    })

    it("ignores a frame's failed restore: it cannot write top-level state", async () => {
      await setupSubject()
      storageGetItemMock.mockResolvedValue(STALE_STATE)

      await close(7)

      expect(storageSetItemMock).not.toHaveBeenCalled()
      expect(sendMessageMock).not.toHaveBeenCalled()
    })

    describe("session identity", () => {
      // Closed-session memory is module state that outlives a single test.
      beforeEach(async () => {
        const { forgetClosedSessions } = await import("../page-translation-state")
        forgetClosedSessions(42)
      })

      const enable = (sessionId: string, frameId = 0) =>
        getHandler("setAndNotifyPageTranslationStateChangedByManager")({
          data: {
            enabled: true,
            url: "https://example.com/articles/1",
            mode: "translationOnly",
            sessionId,
          },
          sender: { tab: { id: 42 }, frameId },
        })
      const closeSession = (sessionId?: string) =>
        getHandler("closeStalePageTranslationState")({
          data: {
            url: "https://example.com/articles/1",
            staleMode: "translationOnly",
            ...(sessionId ? { sessionId } : {}),
          },
          sender: { tab: { id: 42 }, frameId: 0 },
        })

      function createDeferred() {
        let resolve!: () => void
        const promise = new Promise<void>((r) => {
          resolve = r
        })
        return { promise, resolve }
      }

      /** In-memory tab state whose next read / the next matching write can be held open. */
      function useMemoryStore(initial?: unknown) {
        const key = getTranslationStateKey(42)
        const store = new Map<string, unknown>(initial ? [[key, initial]] : [])
        const gates: {
          read?: Promise<void>
          write?: { when: (value: any) => boolean; until: Promise<void> }
        } = {}
        const writes: unknown[] = []
        storageGetItemMock.mockImplementation(async (k: string) => {
          const gate = gates.read
          gates.read = undefined
          await gate
          return store.get(k)
        })
        storageSetItemMock.mockImplementation(async (k: string, value: unknown) => {
          const gate = gates.write
          if (gate?.when(value)) {
            gates.write = undefined
            await gate.until
          }
          store.set(k, value)
          writes.push(value)
        })
        return { read: () => store.get(key), gates, writes }
      }

      it("stores the identity with the enabled state and hands it to a restoring frame", async () => {
        await setupSubject()
        const memory = useMemoryStore()

        await enable("session-a")

        expect(memory.read()).toEqual({
          enabled: true,
          origin: "https://example.com",
          mode: "translationOnly",
          sessionId: "session-a",
        })
        await expect(
          getHandler("getPageTranslationSnapshotFromContentScript")({
            sender: { tab: { id: 42 }, frameId: 0 },
          }),
        ).resolves.toEqual({ enabled: true, mode: "translationOnly", sessionId: "session-a" })
      })

      it("ignores a late close from an old session after a same-mode restart", async () => {
        await setupSubject()
        const memory = useMemoryStore()

        await enable("session-a")
        await enable("session-b")
        sendMessageMock.mockClear()
        await closeSession("session-a")

        expect(memory.read()).toMatchObject({ enabled: true, sessionId: "session-b" })
        expect(memory.writes).toHaveLength(2)
        expect(sendMessageMock).not.toHaveBeenCalled()
      })

      it("closes the very session it was issued for", async () => {
        await setupSubject()
        const memory = useMemoryStore()

        await enable("session-a")
        await closeSession("session-a")

        expect(memory.read()).toEqual({
          enabled: false,
          sessionInvalidated: true,
          origin: "https://example.com",
        })
      })

      it("a close without identity closes a legacy state but never a newer identified session", async () => {
        await setupSubject()
        const memory = useMemoryStore({
          enabled: true,
          origin: "https://example.com",
          mode: "translationOnly",
        })

        await closeSession()
        expect(memory.read()).toMatchObject({ enabled: false, sessionInvalidated: true })

        await enable("session-a")
        sendMessageMock.mockClear()
        await closeSession()

        expect(memory.read()).toMatchObject({ enabled: true, sessionId: "session-a" })
        expect(sendMessageMock).not.toHaveBeenCalled()
      })

      it("ignores a close from another origin", async () => {
        await setupSubject()
        const memory = useMemoryStore()

        await enable("session-a")
        await getHandler("closeStalePageTranslationState")({
          data: {
            url: "https://other.example.net/page",
            staleMode: "translationOnly",
            sessionId: "session-a",
          },
          sender: { tab: { id: 42 }, frameId: 0 },
        })

        expect(memory.read()).toMatchObject({ enabled: true, sessionId: "session-a" })
      })

      it("a same-mode start landing between the close's read and write is not overwritten", async () => {
        await setupSubject()
        const memory = useMemoryStore({
          enabled: true,
          origin: "https://example.com",
          mode: "translationOnly",
          sessionId: "session-a",
        })
        const releaseRead = createDeferred()
        const releaseWrite = createDeferred()
        memory.gates.read = releaseRead.promise
        // Only the close's own write (the disable) is held open.
        memory.gates.write = {
          when: (value) => value.enabled === false,
          until: releaseWrite.promise,
        }

        // The close has been dispatched and is parked on its storage read...
        const closing = closeSession("session-a")
        await Promise.resolve()
        // ...when the newer same-mode session announces itself.
        const starting = enable("session-b")
        releaseRead.resolve()
        await new Promise((resolve) => setTimeout(resolve, 0))
        // ...and the close's own write is still in flight.
        releaseWrite.resolve()
        await Promise.all([closing, starting])

        expect(memory.read()).toEqual({
          enabled: true,
          origin: "https://example.com",
          mode: "translationOnly",
          sessionId: "session-b",
        })
        expect(memory.writes.at(-1)).toMatchObject({ enabled: true, sessionId: "session-b" })
        // The UI heard "disabled" for the old session before "enabled" for the new one.
        const notified = sendMessageMock.mock.calls
          .filter(([name]) => name === "notifyTranslationStateChanged")
          .map(([, data]) => data.enabled)
        expect(notified).toEqual([false, true])
      })

      it("a user disable cannot be overwritten by an earlier, slower enable write", async () => {
        await setupSubject()
        const memory = useMemoryStore()
        const releaseWrite = createDeferred()
        // Only the enable write is slow; the disable would otherwise land first.
        memory.gates.write = {
          when: (value) => value.enabled === true,
          until: releaseWrite.promise,
        }

        const starting = enable("session-a")
        await Promise.resolve()
        const disabling = getHandler("tryToSetEnablePageTranslationOnContentScript")({
          data: { enabled: false },
          sender: { tab: { id: 42, url: "https://example.com/articles/1" }, frameId: 0 },
        })
        releaseWrite.resolve()
        await Promise.all([starting, disabling])

        expect(memory.read()).toEqual({
          enabled: false,
          userDisabled: true,
          origin: "https://example.com",
        })
      })

      const stop = (sessionId?: string, extra: Record<string, unknown> = {}) =>
        getHandler("setAndNotifyPageTranslationStateChangedByManager")({
          data: {
            enabled: false,
            url: "https://example.com/articles/1",
            ...(sessionId ? { sessionId } : {}),
            ...extra,
          },
          sender: { tab: { id: 42 }, frameId: 0 },
        })
      const notifiedStates = () =>
        sendMessageMock.mock.calls
          .filter(([name]) => name === "notifyTranslationStateChanged")
          .map(([, data]) => data.enabled)

      it("ignores an older session's delayed stop after a newer same-mode start", async () => {
        await setupSubject()
        const memory = useMemoryStore()

        await enable("session-a")
        await enable("session-b")
        sendMessageMock.mockClear()
        await stop("session-a")
        await stop("session-a", { sessionInvalidated: true })

        expect(memory.read()).toMatchObject({ enabled: true, sessionId: "session-b" })
        expect(memory.writes).toHaveLength(2)
        expect(notifiedStates()).toEqual([])

        await stop("session-b")
        expect(memory.read()).toEqual({ enabled: false })
        expect(notifiedStates()).toEqual([false])
      })

      it("still lets a disable without identity close the current session", async () => {
        await setupSubject()
        const memory = useMemoryStore()

        await enable("session-a")
        await stop(undefined, { userInitiated: true })

        expect(memory.read()).toEqual({
          enabled: false,
          userDisabled: true,
          origin: "https://example.com",
        })
      })

      it("a stop queued behind a slow start of its own session wins", async () => {
        await setupSubject()
        const memory = useMemoryStore()
        const releaseWrite = createDeferred()
        memory.gates.write = {
          when: (value) => value.enabled === true,
          until: releaseWrite.promise,
        }

        const starting = enable("session-a")
        await Promise.resolve()
        const stopping = stop("session-a")
        releaseWrite.resolve()
        await Promise.all([starting, stopping])

        expect(memory.read()).toEqual({ enabled: false })
        expect(notifiedStates()).toEqual([true, false])
      })

      it("a cancelled start whose enable arrives after its stop cannot resurrect state", async () => {
        await setupSubject()
        const memory = useMemoryStore()

        await stop("session-a")
        await enable("session-a")
        expect(memory.read()).toBeUndefined()
        expect(notifiedStates()).toEqual([])

        // The newer intent still applies, and the cancelled one stays cancelled.
        await enable("session-b")
        await enable("session-a")
        expect(memory.read()).toMatchObject({ enabled: true, sessionId: "session-b" })
        expect(notifiedStates()).toEqual([true])
      })

      it("an iframe echo never writes state", async () => {
        await setupSubject()
        const memory = useMemoryStore()

        await enable("session-a")
        const writesBefore = memory.writes.length
        await enable("iframe-session", 7)

        expect(memory.writes).toHaveLength(writesBefore)
        expect(memory.read()).toMatchObject({ sessionId: "session-a" })
      })
    })
  })
})

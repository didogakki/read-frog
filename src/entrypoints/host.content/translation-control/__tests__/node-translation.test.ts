// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { GOOGLE_TRANSLATE_PROVIDER_ID } from "@/utils/constants/providers"
import { setPageTranslationModeOverride } from "@/utils/host/translate/page-translation-mode-override"
import { registerNodeTranslationTriggers } from "../node-translation"

const mocks = vi.hoisted(() => ({
  getLocalConfig: vi.fn<(...args: any[]) => any>(),
  toastAdd: vi.fn<(...args: any[]) => any>(),
  removeOrShowNodeTranslation: vi.fn<(...args: any[]) => any>(),
  sendMessage: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/utils/config/storage", () => ({
  getLocalConfig: mocks.getLocalConfig,
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: mocks.toastAdd },
}))

vi.mock("@/utils/host/translate/node-manipulation", () => ({
  removeOrShowNodeTranslation: mocks.removeOrShowNodeTranslation,
}))

vi.mock("@/utils/message", () => ({
  sendMessage: mocks.sendMessage,
}))

function createConfig(): Config {
  return {
    pageTranslation: {
      node: {
        enabled: true,
        hotkey: "backtick",
      },
    },
  } as Config
}

function createModeConfig(mode: TranslationMode, providerId: string): Config {
  return {
    ...DEFAULT_CONFIG,
    pageTranslation: {
      ...DEFAULT_CONFIG.pageTranslation,
      mode,
      providerId,
      node: { ...DEFAULT_CONFIG.pageTranslation.node, enabled: true, hotkey: "backtick" },
    },
  }
}

const UNSUPPORTED_PROVIDER_ID = DEFAULT_CONFIG.pageTranslation.providerId

function dispatchKeyboardEvent(type: "keydown" | "keyup", key: string) {
  document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }))
}

function dispatchMouseEvent(type: "mousemove" | "mouseover", init: MouseEventInit) {
  document.dispatchEvent(new MouseEvent(type, { bubbles: true, ...init }))
}

async function triggerBacktickNodeTranslation() {
  dispatchMouseEvent("mousemove", { clientX: 15, clientY: 25 })
  dispatchKeyboardEvent("keydown", "`")
  await Promise.resolve()
  dispatchKeyboardEvent("keyup", "`")
}

describe("registerNodeTranslationTriggers", () => {
  let teardown: (() => void) | null = null

  afterEach(() => {
    setPageTranslationModeOverride(null)
    teardown?.()
    teardown = null
    vi.clearAllMocks()
  })

  it("requests current iframe injection after a successful top-frame node translation", async () => {
    mocks.getLocalConfig.mockResolvedValue(createConfig())
    mocks.removeOrShowNodeTranslation.mockResolvedValue(true)
    mocks.sendMessage.mockResolvedValue(undefined)
    teardown = registerNodeTranslationTriggers()

    await triggerBacktickNodeTranslation()

    await vi.waitFor(() => {
      expect(mocks.removeOrShowNodeTranslation).toHaveBeenCalledWith(
        { x: 15, y: 25 },
        expect.objectContaining({
          pageTranslation: expect.objectContaining({
            node: expect.objectContaining({ enabled: true }),
          }),
        }),
      )
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        "injectCurrentIframesAfterTopFrameNodeTranslation",
        undefined,
      )
    })
  })

  it("does not request iframe injection when node translation finds no translatable node", async () => {
    mocks.getLocalConfig.mockResolvedValue(createConfig())
    mocks.removeOrShowNodeTranslation.mockResolvedValue(false)
    teardown = registerNodeTranslationTriggers()

    await triggerBacktickNodeTranslation()

    await vi.waitFor(() => {
      expect(mocks.removeOrShowNodeTranslation).toHaveBeenCalled()
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it("requests current iframe injection only once for repeated successful node translations", async () => {
    mocks.getLocalConfig.mockResolvedValue(createConfig())
    mocks.removeOrShowNodeTranslation.mockResolvedValue(true)
    mocks.sendMessage.mockResolvedValue(undefined)
    teardown = registerNodeTranslationTriggers()

    await triggerBacktickNodeTranslation()
    await vi.waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
    })

    await triggerBacktickNodeTranslation()
    await vi.waitFor(() => {
      expect(mocks.removeOrShowNodeTranslation).toHaveBeenCalledTimes(2)
    })
    expect(mocks.sendMessage).toHaveBeenCalledTimes(1)
  })

  it("translates nodes in the running session's temporary mode, not the saved one", async () => {
    mocks.getLocalConfig.mockResolvedValue(
      createModeConfig("bilingual", GOOGLE_TRANSLATE_PROVIDER_ID),
    )
    mocks.removeOrShowNodeTranslation.mockResolvedValue(false)
    setPageTranslationModeOverride("translationOnly")
    teardown = registerNodeTranslationTriggers()

    await triggerBacktickNodeTranslation()

    await vi.waitFor(() => {
      expect(mocks.removeOrShowNodeTranslation).toHaveBeenCalledWith(
        { x: 15, y: 25 },
        expect.objectContaining({
          pageTranslation: expect.objectContaining({ mode: "translationOnly" }),
        }),
      )
    })
  })

  describe("translationOnly provider gate", () => {
    async function trigger() {
      await triggerBacktickNodeTranslation()
      // Let the config read and the trigger's debounce settle.
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    it("does not start new translationOnly work from a temporary mode the provider cannot do", async () => {
      mocks.getLocalConfig.mockResolvedValue(createModeConfig("bilingual", UNSUPPORTED_PROVIDER_ID))
      setPageTranslationModeOverride("translationOnly")
      teardown = registerNodeTranslationTriggers()

      await trigger()

      expect(mocks.removeOrShowNodeTranslation).not.toHaveBeenCalled()
      expect(mocks.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "info",
          title: "options.translation.preference.translationMode.providerNotSupported",
        }),
      )
    })

    it("applies the same gate when translationOnly comes from the saved preference", async () => {
      mocks.getLocalConfig.mockResolvedValue(
        createModeConfig("translationOnly", UNSUPPORTED_PROVIDER_ID),
      )
      teardown = registerNodeTranslationTriggers()

      await trigger()

      expect(mocks.removeOrShowNodeTranslation).not.toHaveBeenCalled()
      expect(mocks.toastAdd).toHaveBeenCalledTimes(1)
    })

    it("refuses a block that mixes translated and untranslated content, so no request can be issued", async () => {
      mocks.getLocalConfig.mockResolvedValue(
        createModeConfig("translationOnly", UNSUPPORTED_PROVIDER_ID),
      )
      mocks.removeOrShowNodeTranslation.mockResolvedValue(true)
      const block = document.createElement("div")
      const translated = document.createElement("p")
      translated.setAttribute("data-read-frog-translation-only", "")
      const wrapper = document.createElement("span")
      wrapper.className = "read-frog-translated-content-wrapper"
      translated.append(wrapper)
      const untranslated = document.createElement("p")
      untranslated.textContent = "not translated yet"
      block.append(translated, untranslated)
      document.body.append(block)
      teardown = registerNodeTranslationTriggers()

      await trigger()
      block.remove()

      // removeOrShowNodeTranslation is the only path to a new provider request.
      expect(mocks.removeOrShowNodeTranslation).not.toHaveBeenCalled()
      expect(mocks.sendMessage).not.toHaveBeenCalled()
      expect(mocks.toastAdd).toHaveBeenCalledTimes(1)
      expect(translated.contains(wrapper)).toBe(true)
    })

    it("leaves bilingual node translation alone on the same provider", async () => {
      mocks.getLocalConfig.mockResolvedValue(createModeConfig("bilingual", UNSUPPORTED_PROVIDER_ID))
      mocks.removeOrShowNodeTranslation.mockResolvedValue(false)
      teardown = registerNodeTranslationTriggers()

      await trigger()

      expect(mocks.removeOrShowNodeTranslation).toHaveBeenCalledTimes(1)
      expect(mocks.toastAdd).not.toHaveBeenCalled()
    })

    it("translates in translationOnly when the provider supports it", async () => {
      mocks.getLocalConfig.mockResolvedValue(
        createModeConfig("translationOnly", GOOGLE_TRANSLATE_PROVIDER_ID),
      )
      mocks.removeOrShowNodeTranslation.mockResolvedValue(false)
      teardown = registerNodeTranslationTriggers()

      await trigger()

      expect(mocks.removeOrShowNodeTranslation).toHaveBeenCalledTimes(1)
      expect(mocks.toastAdd).not.toHaveBeenCalled()
    })
  })
})

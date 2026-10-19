// @vitest-environment jsdom
import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { GOOGLE_TRANSLATE_PROVIDER_ID } from "@/utils/constants/providers"
import { setPageTranslationModeOverride } from "@/utils/host/translate/page-translation-mode-override"
import { RetryButton } from "../retry-button"

const mocks = vi.hoisted(() => ({
  toastAdd: vi.fn<(...args: any[]) => any>(),
  translateNodesBilingualMode: vi.fn<(...args: any[]) => any>(),
  translateNodeTranslationOnlyMode: vi.fn<(...args: any[]) => any>(),
}))

vi.mock("@/components/ui/base-ui/toast", () => ({
  toastManager: { add: mocks.toastAdd },
}))

vi.mock("@/utils/host/translate/node-manipulation", () => ({
  translateNodesBilingualMode: mocks.translateNodesBilingualMode,
  translateNodeTranslationOnlyMode: mocks.translateNodeTranslationOnlyMode,
}))

const UNSUPPORTED_PROVIDER_ID = DEFAULT_CONFIG.pageTranslation.providerId

function createConfig(mode: TranslationMode, providerId: string): Config {
  return {
    ...DEFAULT_CONFIG,
    pageTranslation: { ...DEFAULT_CONFIG.pageTranslation, mode, providerId },
  }
}

async function clickRetry(config: Config) {
  const store = createStore()
  store.set(configAtom, config)
  const { container } = render(
    <Provider store={store}>
      <TooltipProvider>
        <RetryButton nodes={[]} />
      </TooltipProvider>
    </Provider>,
  )
  fireEvent.click(container.querySelector("button")!)
  await waitFor(() => {
    expect(
      mocks.toastAdd.mock.calls.length +
        mocks.translateNodesBilingualMode.mock.calls.length +
        mocks.translateNodeTranslationOnlyMode.mock.calls.length,
    ).toBeGreaterThan(0)
  })
}

describe("retryButton translationOnly provider gate", () => {
  afterEach(() => {
    cleanup()
    setPageTranslationModeOverride(null)
    vi.clearAllMocks()
  })

  it("refuses to retry in translationOnly when the saved preference's provider cannot do it", async () => {
    await clickRetry(createConfig("translationOnly", UNSUPPORTED_PROVIDER_ID))

    expect(mocks.translateNodeTranslationOnlyMode).not.toHaveBeenCalled()
    expect(mocks.translateNodesBilingualMode).not.toHaveBeenCalled()
    expect(mocks.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "options.translation.preference.translationMode.providerNotSupported",
      }),
    )
  })

  it("refuses to retry in a temporary translationOnly mode over a bilingual preference", async () => {
    setPageTranslationModeOverride("translationOnly")

    await clickRetry(createConfig("bilingual", UNSUPPORTED_PROVIDER_ID))

    expect(mocks.translateNodeTranslationOnlyMode).not.toHaveBeenCalled()
    expect(mocks.translateNodesBilingualMode).not.toHaveBeenCalled()
    expect(mocks.toastAdd).toHaveBeenCalledTimes(1)
  })

  it("retries translationOnly when the provider supports it", async () => {
    setPageTranslationModeOverride("translationOnly")

    await clickRetry(createConfig("bilingual", GOOGLE_TRANSLATE_PROVIDER_ID))

    expect(mocks.translateNodeTranslationOnlyMode).toHaveBeenCalledTimes(1)
    expect(mocks.translateNodeTranslationOnlyMode.mock.calls[0]![2].pageTranslation.mode).toBe(
      "translationOnly",
    )
    expect(mocks.toastAdd).not.toHaveBeenCalled()
  })

  it("keeps retrying in bilingual on a provider that cannot do translationOnly", async () => {
    await clickRetry(createConfig("bilingual", UNSUPPORTED_PROVIDER_ID))

    expect(mocks.translateNodesBilingualMode).toHaveBeenCalledTimes(1)
    expect(mocks.toastAdd).not.toHaveBeenCalled()
  })
})

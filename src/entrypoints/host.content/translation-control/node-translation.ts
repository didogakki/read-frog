import type { Config } from "@/types/config/config"
import { toastManager } from "@/components/ui/base-ui/toast"
import { getLocalConfig } from "@/utils/config/storage"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { removeOrShowNodeTranslation } from "@/utils/host/translate/node-manipulation"
import { applyPageTranslationModeOverride } from "@/utils/host/translate/page-translation-mode-override"
import { sendMessage } from "@/utils/message"
import { getBlockedReasonForEffectiveMode } from "@/utils/providers/translation-only-gate"
import { registerNodeTranslationTriggerListeners } from "./node-translation-trigger"

/**
 * Registers node translation triggers based on the current config.
 * Returns a teardown function to remove all listeners.
 *
 * Config is read on demand when the interaction fires so long-lived content
 * scripts don't drift if the page was frozen and missed storage events.
 */
export function registerNodeTranslationTriggers(): () => void {
  const ac = new AbortController()
  const { signal } = ac

  const getCurrentConfig = async (): Promise<Config | null> => {
    const config = await getLocalConfig()
    if (signal.aborted) return null
    // A running page session may be in a temporary mode; keep node-level
    // translations consistent with what the page is showing.
    return applyPageTranslationModeOverride(config ?? DEFAULT_CONFIG)
  }

  let hasRequestedIframeInjection = false

  const requestIframeInjectionAfterSuccessfulTopFrameNodeTranslation = () => {
    if (hasRequestedIframeInjection || window !== window.top || signal.aborted) return

    hasRequestedIframeInjection = true
    void sendMessage("injectCurrentIframesAfterTopFrameNodeTranslation", undefined).catch(
      () => undefined,
    )
  }

  const translateNode = async (
    point: Parameters<typeof removeOrShowNodeTranslation>[0],
    config: Config,
  ) => {
    // The provider may have changed since the mode was chosen (the page session
    // closes itself, but this trigger reads config on its own). The toggle can
    // translate any untranslated part of a block, so it is refused outright
    // while the provider cannot do the mode; existing translations stay as they
    // are and the page-level translation-off control still restores the original.
    const blockedReason = getBlockedReasonForEffectiveMode(config)
    if (blockedReason !== null) {
      if (window === window.top) toastManager.add({ type: "info", title: blockedReason })
      return
    }

    const didTranslate = await removeOrShowNodeTranslation(point, config)
    if (didTranslate) {
      requestIframeInjectionAfterSuccessfulTopFrameNodeTranslation()
    }
  }

  const teardownTriggerListeners = registerNodeTranslationTriggerListeners({
    getConfig: getCurrentConfig,
    onTrigger: (point, config) => {
      void translateNode(point, config)
    },
  })

  // Teardown: abort all listeners + cancel pending timers
  return () => {
    ac.abort()
    teardownTriggerListeners()
  }
}

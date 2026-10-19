import { IconReload } from "@tabler/icons-react"
import { useAtomValue } from "jotai"
import { use } from "react"
import { toastManager } from "@/components/ui/base-ui/toast"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/base-ui/tooltip"
import { configAtom } from "@/utils/atoms/config"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import {
  translateNodesBilingualMode,
  translateNodeTranslationOnlyMode,
} from "@/utils/host/translate/node-manipulation"
import { applyPageTranslationModeOverride } from "@/utils/host/translate/page-translation-mode-override"
import { getBlockedReasonForEffectiveMode } from "@/utils/providers/translation-only-gate"
import { ShadowWrapperContext } from "@/utils/react-shadow-host/create-shadow-host"

export function RetryButton({ nodes }: { nodes: ChildNode[] }) {
  const shadowWrapper = use(ShadowWrapperContext)
  const savedConfig = useAtomValue(configAtom)

  const handleRetry = async () => {
    // Read at click time: the page may be in a temporary mode that differs
    // from the saved preference.
    const config = applyPageTranslationModeOverride(savedConfig)
    const translationMode = config.pageTranslation.mode
    // A retry is new translation work; translationOnly needs a provider that
    // preserves markup, which may no longer be the configured one.
    const blockedReason = getBlockedReasonForEffectiveMode(config)
    if (blockedReason !== null) {
      toastManager.add({ type: "info", title: blockedReason })
      return
    }
    const walkId = getRandomUUID()
    if (translationMode === "bilingual") {
      await translateNodesBilingualMode(nodes, walkId, config)
    } else if (translationMode === "translationOnly") {
      await translateNodeTranslationOnlyMode(nodes, walkId, config)
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<button type="button" onClick={handleRetry} />}>
        <IconReload className="size-4 text-link hover:opacity-80" />
      </TooltipTrigger>
      <TooltipContent container={shadowWrapper} side="bottom" className="notranslate">
        Retry translation
      </TooltipContent>
    </Tooltip>
  )
}

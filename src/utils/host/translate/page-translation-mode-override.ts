import type { Config } from "@/types/config/config"
import type { TranslationMode } from "@/types/config/translate"

/**
 * Temporary translation mode of the running page-translation session in this
 * frame. It shadows `config.pageTranslation.mode` for every page-translation
 * read without ever being written to the saved config. Owned by
 * PageTranslationManager: set when a session activates, cleared when it stops.
 */
let activeModeOverride: TranslationMode | null = null

export function getPageTranslationModeOverride(): TranslationMode | null {
  return activeModeOverride
}

export function setPageTranslationModeOverride(mode: TranslationMode | null): void {
  activeModeOverride = mode
}

export function applyTranslationModeToConfig<T extends Config>(
  config: T,
  mode: TranslationMode | null,
): T {
  if (!mode || config.pageTranslation.mode === mode) return config
  return { ...config, pageTranslation: { ...config.pageTranslation, mode } }
}

/** The config as the running session sees it. */
export function applyPageTranslationModeOverride<T extends Config>(config: T): T {
  return applyTranslationModeToConfig(config, activeModeOverride)
}

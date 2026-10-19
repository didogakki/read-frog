import { z } from "zod"
import { translationModeSchema } from "@/types/config/translate"

export const translationStateSchema = z.object({
  enabled: z.boolean(),
  origin: z.string().optional(),
  // Set when the user manually turned translation off (popup, floating
  // button, shortcut, touch gesture, context menu). Scoped by `origin`;
  // auto-translation must not force the page back on while this is set.
  userDisabled: z.boolean().optional(),
  // Temporary per-tab mode that differs from `pageTranslation.mode` (floating
  // button "other mode" action). Only present while `enabled` is true; absent
  // means the saved preference applies.
  mode: translationModeSchema.optional(),
  // Identity of the enabled session: new for every activation, preserved when a
  // reloaded page restores it. Lets a late stale-close tell "the session I
  // failed to restore" from a newer session that happens to use the same mode.
  sessionId: z.string().optional(),
  // Set when a temporary translationOnly session was closed because the page
  // provider stopped supporting it (not a user refusal). Scoped by `origin`;
  // auto-translation must not restart the page in the saved mode while the
  // provider is still unsupported. Any new start rewrites the state without it.
  sessionInvalidated: z.boolean().optional(),
})

export type TranslationState = z.infer<typeof translationStateSchema>

import type { TranslationMode } from "@/types/config/translate"
import type { TranslationState } from "@/types/translation-state"
import { storage } from "#imports"
import { getTranslationStateKey } from "@/utils/constants/storage-keys"
import { getPageTranslationOriginScope } from "@/utils/url"

export async function getPageTranslationState(tabId: number): Promise<TranslationState | null> {
  return await storage.getItem<TranslationState>(getTranslationStateKey(tabId))
}

export async function getPageTranslationEnabled(tabId: number): Promise<boolean> {
  const state = await getPageTranslationState(tabId)
  return state?.enabled ?? false
}

const tabStateQueues = new Map<number, Promise<unknown>>()

/**
 * Runs `task` after every earlier state task of the same tab has settled. Every
 * write of a tab's translation state, and the stale-close read-compare-write,
 * go through here: message handlers are otherwise not serialized, so a late
 * close could write over a newer start between its read and its write.
 */
export function enqueuePageTranslationStateTask<T>(
  tabId: number,
  task: () => Promise<T>,
): Promise<T> {
  const run = (tabStateQueues.get(tabId) ?? Promise.resolve()).then(task)
  const tail = run.catch(() => {})
  tabStateQueues.set(tabId, tail)
  void tail.then(() => {
    if (tabStateQueues.get(tabId) === tail) tabStateQueues.delete(tabId)
  })
  return run
}

const MAX_REMEMBERED_CLOSED_SESSIONS = 8
const closedSessionIds = new Map<number, string[]>()

/**
 * Remembers a session whose stop arrived before its enable (the two messages
 * are not guaranteed to be handled in send order), so the late enable of that
 * cancelled session cannot resurrect the state. Call from a queued task.
 */
export function rememberClosedSession(tabId: number, sessionId: string): void {
  const ids = (closedSessionIds.get(tabId) ?? []).filter((id) => id !== sessionId)
  ids.push(sessionId)
  closedSessionIds.set(tabId, ids.slice(-MAX_REMEMBERED_CLOSED_SESSIONS))
}

export function isClosedSession(tabId: number, sessionId: string): boolean {
  return closedSessionIds.get(tabId)?.includes(sessionId) ?? false
}

export function forgetClosedSessions(tabId: number): void {
  closedSessionIds.delete(tabId)
}

/** Serialized write; use `writePageTranslationEnabled` from inside a queued task. */
export function setPageTranslationEnabled(
  tabId: number,
  enabled: boolean,
  url?: string,
  userInitiated?: boolean,
  mode?: TranslationMode,
  sessionInvalidated?: boolean,
  sessionId?: string,
): Promise<void> {
  return enqueuePageTranslationStateTask(tabId, () =>
    writePageTranslationEnabled(
      tabId,
      enabled,
      url,
      userInitiated,
      mode,
      sessionInvalidated,
      sessionId,
    ),
  )
}

/**
 * Whether the stored state is exactly the enabled session a restoring frame
 * found unusable: same mode, same origin, and — when the request carries one —
 * the same session identity. A request without an identity (older caller)
 * only matches a state without one, so it cannot close a newer identified
 * session.
 */
export function isStaleSessionState(
  state: TranslationState | null | undefined,
  request: { url?: string; staleMode: TranslationMode; sessionId?: string },
): boolean {
  if (!state?.enabled || state.mode !== request.staleMode) return false
  if (state.sessionId !== request.sessionId) return false
  if (state.origin && request.url && state.origin !== getPageTranslationOriginScope(request.url)) {
    return false
  }
  return true
}

export async function writePageTranslationEnabled(
  tabId: number,
  enabled: boolean,
  url?: string,
  userInitiated?: boolean,
  mode?: TranslationMode,
  sessionInvalidated?: boolean,
  sessionId?: string,
): Promise<void> {
  if (enabled) {
    const origin = url ? getPageTranslationOriginScope(url) : null

    // `mode` is the temporary session mode; a start without one means the
    // saved preference, so it is never carried over from an earlier session.
    await storage.setItem<TranslationState>(getTranslationStateKey(tabId), {
      enabled,
      ...(origin ? { origin } : {}),
      ...(mode ? { mode } : {}),
      ...(sessionId ? { sessionId } : {}),
    })
    return
  }

  // A user-initiated disable is remembered with the origin it was rejected
  // on, so auto-translation cannot force the page back on until the tab
  // leaves that origin. Origin-less URLs (file://, chrome://) cannot be
  // scoped and fall back to a bare disable. Always a full replace-write:
  // message handlers are not serialized, so read-modify-write here would race.
  const origin = userInitiated && url ? getPageTranslationOriginScope(url) : null
  if (origin) {
    await storage.setItem<TranslationState>(getTranslationStateKey(tabId), {
      enabled: false,
      userDisabled: true,
      origin,
    })
    return
  }

  // A provider-forced close is not a refusal, but auto-translation must not
  // silently restart the page either; it is scoped to the same origin.
  const invalidatedOrigin = sessionInvalidated && url ? getPageTranslationOriginScope(url) : null
  await storage.setItem<TranslationState>(
    getTranslationStateKey(tabId),
    invalidatedOrigin
      ? { enabled: false, sessionInvalidated: true, origin: invalidatedOrigin }
      : { enabled: false },
  )
}

export function isPageTranslationStateInUrlScope(
  state: TranslationState | null | undefined,
  url: string | undefined,
): boolean {
  if (!state?.enabled || !state.origin || !url) return false

  return state.origin === getPageTranslationOriginScope(url)
}

export function isAutoTranslationSuppressed(
  state: TranslationState | null | undefined,
  url: string | undefined,
  /**
   * Whether the page provider still cannot do translationOnly. A provider
   * close only holds back auto-translation until the provider recovers.
   */
  providerStillBlocked = true,
): boolean {
  if (!state || state.enabled || !state.origin || !url) return false
  if (state.origin !== getPageTranslationOriginScope(url)) return false

  return state.userDisabled === true || (state.sessionInvalidated === true && providerStillBlocked)
}

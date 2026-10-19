import { beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { getTranslationStateKey } from "@/utils/constants/storage-keys"
import {
  isAutoTranslationSuppressed,
  isStaleSessionState,
  isPageTranslationStateInUrlScope,
  setPageTranslationEnabled,
} from "../page-translation-state"

const storageSetItemMock = vi.fn<(...args: any[]) => any>()

describe("setPageTranslationEnabled", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.setItem = storageSetItemMock
    storageSetItemMock.mockResolvedValue(undefined)
  })

  it("stores the origin scope when enabling with a URL", async () => {
    await setPageTranslationEnabled(42, true, "https://example.com/articles/1")

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: true,
      origin: "https://example.com",
    })
  })

  it("stores the temporary mode only on enable, scoped to the same origin", async () => {
    await setPageTranslationEnabled(
      42,
      true,
      "https://example.com/articles/1",
      undefined,
      "translationOnly",
    )

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: true,
      origin: "https://example.com",
      mode: "translationOnly",
    })
  })

  it("never stores a mode on disable", async () => {
    await setPageTranslationEnabled(
      42,
      false,
      "https://example.com/articles/1",
      true,
      "translationOnly",
    )

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: false,
      userDisabled: true,
      origin: "https://example.com",
    })
  })

  it("stores the session identity only on enable", async () => {
    await setPageTranslationEnabled(
      42,
      true,
      "https://example.com/articles/1",
      undefined,
      undefined,
      undefined,
      "session-a",
    )
    await setPageTranslationEnabled(
      42,
      false,
      "https://example.com/articles/1",
      true,
      undefined,
      undefined,
      "session-a",
    )

    expect(storageSetItemMock).toHaveBeenNthCalledWith(1, getTranslationStateKey(42), {
      enabled: true,
      origin: "https://example.com",
      sessionId: "session-a",
    })
    expect(storageSetItemMock).toHaveBeenNthCalledWith(2, getTranslationStateKey(42), {
      enabled: false,
      userDisabled: true,
      origin: "https://example.com",
    })
  })

  it("stores a bare enable without a URL", async () => {
    await setPageTranslationEnabled(42, true)

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), { enabled: true })
  })

  it("records a scoped user refusal for user-initiated disables", async () => {
    await setPageTranslationEnabled(42, false, "https://example.com/articles/1", true)

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: false,
      userDisabled: true,
      origin: "https://example.com",
    })
  })

  it("stores a bare disable for programmatic disables", async () => {
    await setPageTranslationEnabled(42, false, "https://example.com/articles/1")

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), { enabled: false })
  })

  it("stores a bare disable when a user-initiated disable has no scopable origin", async () => {
    await setPageTranslationEnabled(42, false, "file:///Users/me/report.html", true)

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), { enabled: false })
  })
})

describe("isAutoTranslationSuppressed", () => {
  const userDisabledState = {
    enabled: false,
    userDisabled: true,
    origin: "https://example.com",
  }

  it("suppresses when the user refused this origin", () => {
    expect(isAutoTranslationSuppressed(userDisabledState, "https://example.com/other")).toBe(true)
  })

  it("does not suppress a different origin", () => {
    expect(isAutoTranslationSuppressed(userDisabledState, "https://other.example.net/page")).toBe(
      false,
    )
  })

  it("does not suppress on bare disabled state", () => {
    expect(isAutoTranslationSuppressed({ enabled: false }, "https://example.com/a")).toBe(false)
  })

  it("does not suppress on enabled state", () => {
    expect(
      isAutoTranslationSuppressed(
        { enabled: true, origin: "https://example.com" },
        "https://example.com/a",
      ),
    ).toBe(false)
  })

  it("does not suppress without state or URL", () => {
    expect(isAutoTranslationSuppressed(null, "https://example.com/a")).toBe(false)
    expect(isAutoTranslationSuppressed(userDisabledState, undefined)).toBe(false)
  })
})

describe("provider-forced close marker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.setItem = storageSetItemMock
    storageSetItemMock.mockResolvedValue(undefined)
  })

  const invalidatedState = {
    enabled: false,
    sessionInvalidated: true,
    origin: "https://example.com",
  }

  it("is written as its own marker, never as a user refusal", async () => {
    await setPageTranslationEnabled(
      42,
      false,
      "https://example.com/articles/1",
      undefined,
      undefined,
      true,
    )

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), invalidatedState)
  })

  it("lets a user refusal win over the marker", async () => {
    await setPageTranslationEnabled(
      42,
      false,
      "https://example.com/articles/1",
      true,
      undefined,
      true,
    )

    expect(storageSetItemMock).toHaveBeenCalledWith(getTranslationStateKey(42), {
      enabled: false,
      userDisabled: true,
      origin: "https://example.com",
    })
  })

  it("suppresses auto-translation on its origin only while the provider stays unsupported", () => {
    expect(isAutoTranslationSuppressed(invalidatedState, "https://example.com/a")).toBe(true)
    expect(isAutoTranslationSuppressed(invalidatedState, "https://example.com/a", false)).toBe(
      false,
    )
    expect(isAutoTranslationSuppressed(invalidatedState, "https://other.example.net/a")).toBe(false)
  })
})

describe("isStaleSessionState", () => {
  const state = {
    enabled: true,
    origin: "https://example.com",
    mode: "translationOnly" as const,
    sessionId: "session-a",
  }
  const request = { url: "https://example.com/a", staleMode: "translationOnly" as const }

  it("matches only the same identity, mode and origin", () => {
    expect(isStaleSessionState(state, { ...request, sessionId: "session-a" })).toBe(true)
    expect(isStaleSessionState(state, { ...request, sessionId: "session-b" })).toBe(false)
    expect(
      isStaleSessionState(state, {
        url: "https://other.example.net/",
        staleMode: "translationOnly",
      }),
    ).toBe(false)
    expect(isStaleSessionState({ ...state, mode: undefined }, request)).toBe(false)
    expect(isStaleSessionState({ ...state, enabled: false }, request)).toBe(false)
  })

  it("lets a request without identity close only a state without one", () => {
    expect(isStaleSessionState({ ...state, sessionId: undefined }, request)).toBe(true)
    expect(isStaleSessionState(state, request)).toBe(false)
  })

  it("rejects a request naming a session when the stored state has none", () => {
    expect(
      isStaleSessionState(
        { ...state, sessionId: undefined },
        { ...request, sessionId: "session-a" },
      ),
    ).toBe(false)
  })
})

describe("isPageTranslationStateInUrlScope", () => {
  it("is unaffected by the userDisabled marker", () => {
    expect(
      isPageTranslationStateInUrlScope(
        { enabled: false, userDisabled: true, origin: "https://example.com" },
        "https://example.com/a",
      ),
    ).toBe(false)
    expect(
      isPageTranslationStateInUrlScope(
        { enabled: true, origin: "https://example.com" },
        "https://example.com/a",
      ),
    ).toBe(true)
  })
})

import { Effect } from "effect";
import type { CookieLoginError, CookieSessionService } from "../session/cookie.ts";

/**
 * Opt-in recovery for a single `SessionExpiredError`: invalidate the cached
 * session, re-authenticate once, then retry `effect` exactly once. A second
 * failure — including another `SessionExpiredError` — propagates untouched.
 *
 * Deliberately policy-free: no backoff, no retry count beyond one. Auto-relogin
 * is NOT wired into the transport (AGENTS.md decision); callers opt in here so
 * the session-expiry signal stays observable by default.
 */
export const retryOnSessionExpired = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  session: CookieSessionService,
): Effect.Effect<A, E | CookieLoginError, R> =>
  Effect.catchIf(
    effect,
    (error): error is Extract<E, { readonly _tag: "SessionExpiredError" }> =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      (error as { readonly _tag: unknown })._tag === "SessionExpiredError",
    () => Effect.zipRight(Effect.zipRight(session.invalidate, session.login), effect),
  );

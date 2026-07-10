import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Redacted } from "effect";
import { retryOnSessionExpired } from "../src/combinators/retryOnSessionExpired.ts";
import { OdooAuthenticationError } from "../src/errors/auth.ts";
import { SessionExpiredError } from "../src/errors/session.ts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "../src/internal/platform.ts";
import { fromExisting } from "../src/session/cookie.ts";

// ---------------------------------------------------------------------------
// A scripted HttpClient (same shape as session-cookie.test.ts): entries are
// consumed in order; the cookie header each request carried is recorded.
// ---------------------------------------------------------------------------
interface Canned {
  readonly body: unknown;
  readonly setCookie?: string | undefined;
}

interface Recorder {
  readonly sentCookies: Array<string | null>;
  readonly urls: Array<string>;
}

const fakeHttpClient = (
  script: ReadonlyArray<Canned>,
  rec: Recorder,
): Layer.Layer<HttpClient.HttpClient> => {
  let i = 0;
  const client = HttpClient.make((request) => {
    const canned = script[Math.min(i, script.length - 1)];
    i += 1;
    rec.sentCookies.push(request.headers["cookie"] ?? null);
    rec.urls.push(request.url);
    const headers = new Headers({ "content-type": "application/json" });
    if (canned?.setCookie !== undefined) {
      headers.append("set-cookie", canned.setCookie);
    }
    const web = new Response(JSON.stringify(canned?.body ?? {}), { status: 200, headers });
    return Effect.succeed(HttpClientResponse.fromWeb(request, web));
  });
  return Layer.succeed(HttpClient.HttpClient, client);
};

const sessionInfo = (uid: number) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    uid,
    user_context: { lang: "en_US", tz: "UTC" },
    server_version_info: [16, 0, 0, "final", 0],
    username: "hodei",
  },
});

const expired = {
  jsonrpc: "2.0",
  id: 1,
  error: {
    code: 100,
    message: "Odoo Session Expired",
    data: { name: "odoo.http.SessionExpiredException", message: "Session expired" },
  },
};

const options = {
  url: new URL("https://erp.example.com/"),
  sessionId: Redacted.make("harvested-cookie-value"),
};

const failTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(
        Option.map(Cause.failureOption(exit.cause), (e) => (e as { _tag: string })._tag),
      )
    : undefined;

describe("CookieSession.fromExisting", () => {
  it.effect("seeds the harvested cookie and hydrates real session_info (single-flight)", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* fromExisting(options).pipe(
        Effect.provide(fakeHttpClient([{ body: sessionInfo(7) }], rec)),
      );

      const first = yield* session.login;
      const second = yield* session.login;

      assert.strictEqual(first.uid, 7);
      assert.deepStrictEqual(first.userContext, { lang: "en_US", tz: "UTC" });
      assert.strictEqual((first.raw as { username?: string }).username, "hodei");
      assert.strictEqual(first, second);
      // Exactly one get_session_info round trip, carrying the injected cookie.
      assert.strictEqual(rec.urls.length, 1);
      assert.strictEqual(rec.urls[0], "https://erp.example.com/web/session/get_session_info");
      assert.strictEqual(rec.sentCookies[0], "session_id=harvested-cookie-value");
    }),
  );

  it.effect("a dead cookie surfaces as SessionExpiredError (code 100 choke point)", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* fromExisting(options).pipe(
        Effect.provide(fakeHttpClient([{ body: expired }], rec)),
      );

      const exit = yield* Effect.exit(session.login);
      assert.strictEqual(failTag(exit), "SessionExpiredError");
      // Nothing cached: the next login retries the round trip (success-only).
      assert.deepStrictEqual(yield* session.peek, Option.none());
    }),
  );

  it.effect("after invalidate with no renew hook, login fails fast without a round trip", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* fromExisting(options).pipe(
        Effect.provide(fakeHttpClient([{ body: sessionInfo(7) }], rec)),
      );

      yield* session.login;
      yield* session.invalidate;

      const exit = yield* Effect.exit(session.login);
      assert.strictEqual(failTag(exit), "SessionExpiredError");
      // No network after invalidate: only the initial hydration hit the wire,
      // and the error message never leaks the cookie value.
      assert.strictEqual(rec.urls.length, 1);
      if (Exit.isFailure(exit)) {
        assert.notInclude(String(Cause.pretty(exit.cause)), "harvested-cookie-value");
      }
    }),
  );

  it.effect("retryOnSessionExpired retries once and propagates — no silent spin", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* fromExisting(options).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              { body: sessionInfo(7) }, // initial hydration succeeds…
              { body: expired }, // …then the server killed the session
            ],
            rec,
          ),
        ),
      );

      yield* session.login;
      // Simulate a call that hit code 100: the combinator invalidates and
      // re-logins. With no credentials and no renew, the relogin fails fast
      // with SessionExpiredError, which must propagate to the caller.
      const call = Effect.zipRight(
        session.login,
        session.client
          .execute(HttpClientRequest.post("https://erp.example.com/web/dataset/call_kw"))
          .pipe(
            Effect.orDie,
            Effect.zipRight(Effect.fail(new SessionExpiredError({ message: "Session expired" }))),
          ),
      );
      const exit = yield* Effect.exit(retryOnSessionExpired(call, session));
      assert.strictEqual(failTag(exit), "SessionExpiredError");
      // Wire: hydration + the one failed call attempt; the relogin never hit
      // the network and the effect was NOT retried a second time.
      assert.strictEqual(rec.urls.length, 2);
    }),
  );

  it.effect("renew hook: invalidate → login mints and replays a fresh cookie, once", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      let renews = 0;
      const session = yield* fromExisting({
        ...options,
        renew: Effect.sync(() => {
          renews += 1;
          return Redacted.make(`renewed-${renews}`);
        }),
      }).pipe(
        Effect.provide(fakeHttpClient([{ body: sessionInfo(7) }, { body: sessionInfo(7) }], rec)),
      );

      yield* session.login;
      yield* session.invalidate;
      yield* session.login;
      yield* session.login;

      // Renew ran exactly once (single-flight + cache), and the second
      // hydration carried the renewed cookie, not the harvested one.
      assert.strictEqual(renews, 1);
      assert.strictEqual(rec.urls.length, 2);
      assert.strictEqual(rec.sentCookies[0], "session_id=harvested-cookie-value");
      assert.strictEqual(rec.sentCookies[1], "session_id=renewed-1");
    }),
  );

  it.effect("an invalid cookie value fails as OdooAuthenticationError, value not leaked", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* fromExisting({
        ...options,
        sessionId: Redacted.make("bad;value"),
      }).pipe(Effect.provide(fakeHttpClient([{ body: sessionInfo(7) }], rec)));

      const exit = yield* Effect.exit(session.login);
      assert.strictEqual(failTag(exit), "OdooAuthenticationError");
      if (Exit.isFailure(exit)) {
        const err = Option.getOrThrow(Cause.failureOption(exit.cause));
        assert.instanceOf(err, OdooAuthenticationError);
        assert.notInclude(err.message, "bad;value");
      }
      assert.strictEqual(rec.urls.length, 0);
    }),
  );
});

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Redacted } from "effect";
import type { OdooConfig } from "../src/config.ts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "../src/internal/platform.ts";
import { make } from "../src/session/cookie.ts";

// ---------------------------------------------------------------------------
// A scripted HttpClient: each entry is consumed in order and its cookie header
// (what the client sent) is recorded so tests can assert cookie replay.
// ---------------------------------------------------------------------------
interface Canned {
  readonly body: unknown;
  readonly setCookie?: string | undefined;
}

interface Recorder {
  readonly sentCookies: Array<string | null>;
  readonly urls: Array<string>;
}

const fakeHttpClient = (script: ReadonlyArray<Canned>, rec: Recorder): Layer.Layer<HttpClient.HttpClient> => {
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

const config: OdooConfig = {
  url: new URL("https://erp.example.com/"),
  db: "prod",
  credentials: { _tag: "ApiKey", username: "svc", apiKey: Redacted.make("secret-key") },
};

const sessionInfo = (uid: number | null) => ({
  jsonrpc: "2.0",
  id: 1,
  result: {
    uid,
    user_context: { lang: "en_US", tz: "UTC" },
    server_version_info: [17, 0, 0, "final", 0],
    // an extra key the schema must tolerate:
    username: "svc",
  },
});

describe("CookieSession", () => {
  it.effect("invalidate racing an in-flight login cannot resurrect the session", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const gate = yield* Deferred.make<void>();
      let call = 0;
      // A gated client: the FIRST authenticate blocks until released, so
      // `invalidate` can run inside the login window.
      const gated = HttpClient.make((request) =>
        Effect.gen(function* () {
          call += 1;
          rec.urls.push(request.url);
          if (call === 1) {
            yield* Deferred.await(gate);
          }
          const headers = new Headers({ "content-type": "application/json" });
          headers.append("set-cookie", `session_id=s${call}; Path=/`);
          const web = new Response(JSON.stringify(sessionInfo(7)), { status: 200, headers });
          return HttpClientResponse.fromWeb(request, web);
        }),
      );
      const session = yield* make(config).pipe(
        Effect.provide(Layer.succeed(HttpClient.HttpClient, gated)),
      );

      const inFlight = yield* Effect.fork(session.login);
      yield* Effect.yieldNow();

      // Invalidate mid-login, then let the login finish.
      yield* session.invalidate;
      yield* Deferred.succeed(gate, undefined);
      const stale = yield* Fiber.join(inFlight);
      assert.strictEqual(stale.uid, 7); // its caller still gets a session...

      // ...but nothing was cached: peek is empty and the next login
      // re-authenticates (a second round trip).
      assert.deepStrictEqual(yield* session.peek, Option.none());
      yield* session.login;
      assert.strictEqual(rec.urls.length, 2);
    }),
  );

  it.effect("logs in once (single-flight) and decodes session_info leniently", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(fakeHttpClient([{ body: sessionInfo(7), setCookie: "session_id=abc; Path=/" }], rec)),
      );

      const first = yield* session.login;
      const second = yield* session.login;

      assert.strictEqual(first.uid, 7);
      assert.deepStrictEqual(first.userContext, { lang: "en_US", tz: "UTC" });
      assert.deepStrictEqual(first.serverVersionInfo, [17, 0, 0, "final", 0]);
      // Passthrough raw keeps the extra key.
      assert.strictEqual((first.raw as { username?: string }).username, "svc");
      assert.strictEqual(first, second);
      // Single-flight: only ONE authenticate round trip.
      assert.strictEqual(rec.urls.length, 1);
      assert.strictEqual(rec.urls[0], "https://erp.example.com/web/session/authenticate");
    }),
  );

  it.effect("uid null → mfa-pending OdooAuthenticationError", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(fakeHttpClient([{ body: sessionInfo(null) }], rec)),
      );

      const exit = yield* Effect.exit(session.login);
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "OdooAuthenticationError");
        if (exit.cause.error._tag === "OdooAuthenticationError") {
          assert.strictEqual(exit.cause.error.reason, "mfa-pending");
        }
      }
    }),
  );

  it.effect("captures the login Set-Cookie, replays it, and honors a mid-sequence rotation", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              // login → mints session_id=abc
              { body: sessionInfo(7), setCookie: "session_id=abc; Path=/" },
              // first call → rotates the cookie to session_id=def
              { body: { jsonrpc: "2.0", id: 2, result: [] }, setCookie: "session_id=def; Path=/" },
              // second call → must carry the rotated cookie
              { body: { jsonrpc: "2.0", id: 3, result: [] } },
            ],
            rec,
          ),
        ),
      );

      const ping = session.client.execute(
        HttpClientRequest.post("https://erp.example.com/web/dataset/call_kw"),
      );

      yield* session.login;
      yield* ping;
      yield* ping;

      // login carried no cookie; first call replayed abc; second call replayed the rotated def.
      assert.isNull(rec.sentCookies[0]);
      assert.strictEqual(rec.sentCookies[1], "session_id=abc");
      assert.strictEqual(rec.sentCookies[2], "session_id=def");
    }),
  );

  it.effect("invalidate drops the cached session and forces a re-login", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              { body: sessionInfo(7), setCookie: "session_id=abc; Path=/" },
              { body: sessionInfo(9), setCookie: "session_id=def; Path=/" },
            ],
            rec,
          ),
        ),
      );

      const first = yield* session.login;
      yield* session.invalidate;
      const second = yield* session.login;

      assert.strictEqual(first.uid, 7);
      assert.strictEqual(second.uid, 9);
      // Two authenticate round trips: the cache was reset.
      assert.strictEqual(rec.urls.length, 2);
      // After invalidate the dead session_id was dropped, so the relogin sent no cookie.
      assert.isNull(rec.sentCookies[1]);
    }),
  );
});

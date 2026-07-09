import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { retryOnSessionExpired } from "../src/combinators/retryOnSessionExpired.ts";
import type { OdooConfig } from "../src/config.ts";
import { HttpClient, HttpClientResponse } from "../src/internal/platform.ts";
import { CookieSession, layer as cookieLayer } from "../src/session/cookie.ts";
import { Transport } from "../src/transport.ts";
import { layer as webLayer } from "../src/transports/web.ts";

interface Canned {
  readonly body: unknown;
  readonly setCookie?: string | undefined;
}

const fakeHttpClient = (script: ReadonlyArray<Canned>): Layer.Layer<HttpClient.HttpClient> => {
  let i = 0;
  const client = HttpClient.make((request) => {
    const canned = script[Math.min(i, script.length - 1)];
    i += 1;
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

const login = { jsonrpc: "2.0", id: 1, result: { uid: 7, user_context: {}, server_version_info: [17] } };
const expired = {
  jsonrpc: "2.0",
  id: 2,
  error: { code: 100, message: "Session expired", data: { name: "odoo.http.SessionExpiredException" } },
};

const stack = (script: ReadonlyArray<Canned>) =>
  webLayer(config).pipe(Layer.provideMerge(cookieLayer(config)), Layer.provide(fakeHttpClient(script)));

const call = Effect.gen(function* () {
  const transport = yield* Transport;
  const session = yield* CookieSession;
  return yield* retryOnSessionExpired(
    transport.callKw({ model: "res.partner", method: "read", args: [[1]], kwargs: {} }),
    session,
  );
});

describe("retryOnSessionExpired", () => {
  it.effect("re-logins once and retries after a SessionExpiredError, then succeeds", () =>
    Effect.gen(function* () {
      const result = yield* call;
      assert.deepStrictEqual(result, [{ id: 1, name: "Acme" }]);
    }).pipe(
      Effect.provide(
        stack([
          { body: login, setCookie: "session_id=abc; Path=/" }, // initial login
          { body: expired }, // call_kw → expired
          { body: login, setCookie: "session_id=def; Path=/" }, // relogin
          { body: { jsonrpc: "2.0", id: 3, result: [{ id: 1, name: "Acme" }] } }, // retry succeeds
        ]),
      ),
    ),
  );

  it.effect("propagates a second SessionExpiredError (only one retry)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(call);
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "SessionExpiredError");
      }
    }).pipe(
      Effect.provide(
        stack([
          { body: login, setCookie: "session_id=abc; Path=/" }, // initial login
          { body: expired }, // call_kw → expired
          { body: login, setCookie: "session_id=def; Path=/" }, // relogin
          { body: expired }, // retry → expired again → propagates
        ]),
      ),
    ),
  );
});

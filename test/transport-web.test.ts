import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import type { OdooConfig } from "../src/config.ts";
import { HttpClient, HttpClientResponse } from "../src/internal/platform.ts";
import * as CookieSession from "../src/session/cookie.ts";
import { Transport } from "../src/transport.ts";
import * as WebTransport from "../src/transports/web.ts";

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

const config: OdooConfig = {
  url: new URL("https://erp.example.com/"),
  db: "prod",
  credentials: { _tag: "ApiKey", username: "svc", apiKey: Redacted.make("secret-key") },
};

const login = {
  jsonrpc: "2.0",
  id: 1,
  result: { uid: 7, user_context: {}, server_version_info: [17] },
};

const stack = (script: ReadonlyArray<Canned>, rec: Recorder) =>
  WebTransport.layer(config).pipe(
    Layer.provideMerge(CookieSession.layer(config)),
    Layer.provide(fakeHttpClient(script, rec)),
  );

describe("WebTransport", () => {
  it.effect("ensures login, then call_kw carries the session cookie and returns the result", () => {
    const rec: Recorder = { sentCookies: [], urls: [] };
    return Effect.gen(function* () {
      const transport = yield* Transport;
      const result = yield* transport.callKw({
        model: "res.partner",
        method: "search_read",
        args: [],
        kwargs: { limit: 1 },
      });

      assert.deepStrictEqual(result, [{ id: 1, name: "Acme" }]);
      // Round trip 0 = authenticate, round trip 1 = call_kw carrying the cookie.
      assert.strictEqual(rec.urls[0], "https://erp.example.com/web/session/authenticate");
      assert.strictEqual(rec.urls[1], "https://erp.example.com/web/dataset/call_kw");
      assert.isNull(rec.sentCookies[0]);
      assert.strictEqual(rec.sentCookies[1], "session_id=abc");
    }).pipe(
      Effect.provide(
        stack(
          [
            { body: login, setCookie: "session_id=abc; Path=/" },
            { body: { jsonrpc: "2.0", id: 2, result: [{ id: 1, name: "Acme" }] } },
          ],
          rec,
        ),
      ),
    );
  });

  it.effect("prepends a seam `ids` as the first positional call_kw argument", () => {
    const bodies: Array<{ readonly args: ReadonlyArray<unknown> }> = [];
    const recordingClient: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const body = request.body;
        if (body._tag === "Uint8Array") {
          const decoded = JSON.parse(new TextDecoder().decode(body.body)) as {
            params?: { args?: ReadonlyArray<unknown> };
          };
          if (decoded.params?.args !== undefined) {
            bodies.push({ args: decoded.params.args });
          }
        }
        const isLogin = request.url.endsWith("authenticate");
        const payload = isLogin ? login : { jsonrpc: "2.0", id: 2, result: true };
        const headers = new Headers({ "content-type": "application/json" });
        if (isLogin) {
          headers.append("set-cookie", "session_id=abc; Path=/");
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(payload), { status: 200, headers }),
          ),
        );
      }),
    );

    return Effect.gen(function* () {
      const transport = yield* Transport;
      yield* transport.callKw({
        model: "res.partner",
        method: "write",
        args: [{ name: "X" }],
        kwargs: {},
        ids: [1, 2],
      });
      // Only the call_kw envelope carries `args`; its args = [ids, ...args].
      assert.deepStrictEqual(bodies[0]?.args, [[1, 2], { name: "X" }]);
    }).pipe(
      Effect.provide(
        WebTransport.layer(config).pipe(
          Layer.provideMerge(CookieSession.layer(config)),
          Layer.provide(recordingClient),
        ),
      ),
    );
  });

  it.effect("maps JSON-RPC error code 100 to SessionExpiredError", () =>
    Effect.gen(function* () {
      const transport = yield* Transport;
      const exit = yield* Effect.exit(
        transport.callKw({ model: "res.partner", method: "read", args: [[1]], kwargs: {} }),
      );
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "SessionExpiredError");
      }
    }).pipe(
      Effect.provide(
        stack(
          [
            { body: login, setCookie: "session_id=abc; Path=/" },
            {
              body: {
                jsonrpc: "2.0",
                id: 2,
                error: {
                  code: 100,
                  message: "Odoo Session Expired",
                  data: { name: "odoo.http.SessionExpiredException", message: "Session expired" },
                },
              },
            },
          ],
          { sentCookies: [], urls: [] },
        ),
      ),
    ),
  );

  it.effect("maps a server fault (ValidationError) through mapServerFault", () =>
    Effect.gen(function* () {
      const transport = yield* Transport;
      const exit = yield* Effect.exit(
        transport.callKw({ model: "res.partner", method: "write", args: [[1], {}], kwargs: {} }),
      );
      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "OdooValidationError");
        if (exit.cause.error._tag === "OdooValidationError") {
          // Call site threaded through the choke point.
          assert.strictEqual(exit.cause.error.model, "res.partner");
          assert.strictEqual(exit.cause.error.method, "write");
        }
      }
    }).pipe(
      Effect.provide(
        stack(
          [
            { body: login, setCookie: "session_id=abc; Path=/" },
            {
              body: {
                jsonrpc: "2.0",
                id: 2,
                error: {
                  code: 200,
                  message: "Odoo Server Error",
                  data: {
                    name: "odoo.exceptions.ValidationError",
                    message: "bad value",
                    arguments: ["bad value"],
                  },
                },
              },
            },
          ],
          { sentCookies: [], urls: [] },
        ),
      ),
    ),
  );
});

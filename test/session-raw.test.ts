import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Redacted, Array as Arr } from "effect";
import type { OdooConfig } from "../src/config.ts";
import { HttpClient, HttpClientResponse } from "../src/internal/platform.ts";
import { fromExisting, make } from "../src/session/cookie.ts";

// ---------------------------------------------------------------------------
// A scripted HttpClient: entries are consumed in order. Each records the sent
// cookie/method/url so the raw-hatch specs can assert login-first + passthrough.
// ---------------------------------------------------------------------------
interface Canned {
  readonly body?: unknown;
  readonly raw?: string;
  readonly status?: number;
  readonly setCookie?: string | undefined;
  readonly contentType?: string;
}

interface Recorder {
  readonly sentCookies: Array<string | null>;
  readonly urls: Array<string>;
  readonly methods: Array<string>;
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
    rec.methods.push(request.method);
    const headers = new Headers({
      "content-type": canned?.contentType ?? "application/json",
    });
    if (canned?.setCookie !== undefined) {
      headers.append("set-cookie", canned.setCookie);
    }
    const payload = canned?.raw ?? JSON.stringify(canned?.body ?? {});
    const web = new Response(payload, { status: canned?.status ?? 200, headers });
    return Effect.succeed(HttpClientResponse.fromWeb(request, web));
  });
  return Layer.succeed(HttpClient.HttpClient, client);
};

const config: OdooConfig = {
  url: new URL("https://erp.example.com/"),
  db: "prod",
  credentials: { _tag: "ApiKey", username: "svc", apiKey: Redacted.make("secret-key") },
};

const sessionInfo = (uid: number) => ({
  jsonrpc: "2.0",
  id: 1,
  result: { uid, user_context: { lang: "en_US" }, server_version_info: [17, 0, 0, "final", 0] },
});

const failTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(
        Option.map(
          Arr.head(exit.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error] : []))),
          (e) => (e as { _tag: string })._tag,
        ),
      )
    : undefined;

describe("CookieSession raw hatches — json", () => {
  it.effect("logs in first, POSTs the envelope to an arbitrary path, returns raw result", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [], methods: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              { body: sessionInfo(7), setCookie: "session_id=abc; Path=/" },
              { body: { jsonrpc: "2.0", id: 2, result: [{ id: 1 }] } },
            ],
            rec,
          ),
        ),
      );

      const result = yield* session.json("web/dataset/call_kw", {
        model: "ir.actions.report",
        method: "search_read",
        args: [[], ["id"]],
        kwargs: {},
      });

      assert.deepStrictEqual(result, [{ id: 1 }]);
      // Login first (authenticate), then the raw POST; both under the base url.
      assert.deepStrictEqual(rec.urls, [
        "https://erp.example.com/web/session/authenticate",
        "https://erp.example.com/web/dataset/call_kw",
      ]);
      assert.strictEqual(rec.methods[1], "POST");
      // The raw call carried the login cookie.
      assert.strictEqual(rec.sentCookies[1], "session_id=abc");
    }),
  );

  it.effect("maps a JSON-RPC fault through the shared choke point (code 100)", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [], methods: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              { body: sessionInfo(7), setCookie: "session_id=abc; Path=/" },
              {
                body: {
                  jsonrpc: "2.0",
                  id: 2,
                  error: {
                    code: 100,
                    message: "Session Expired",
                    data: { name: "odoo.http.SessionExpiredException" },
                  },
                },
              },
            ],
            rec,
          ),
        ),
      );

      const exit = yield* Effect.exit(session.json("web/dataset/call_kw", {}));
      assert.strictEqual(failTag(exit), "SessionExpiredError");
    }),
  );

  it.effect("a non-envelope body fails as SchemaDriftError", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [], methods: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              { body: sessionInfo(7), setCookie: "session_id=abc; Path=/" },
              // Valid JSON, but not a JSON-RPC envelope → schema drift.
              { body: { unexpected: "shape" } },
            ],
            rec,
          ),
        ),
      );

      const exit = yield* Effect.exit(session.json("some/path", {}));
      assert.strictEqual(failTag(exit), "SchemaDriftError");
    }),
  );
});

describe("CookieSession raw hatches — http", () => {
  it.effect("logs in first, then returns the raw response untouched (2xx)", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [], methods: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              { body: sessionInfo(7), setCookie: "session_id=abc; Path=/" },
              { raw: "hello", status: 200, contentType: "text/plain" },
            ],
            rec,
          ),
        ),
      );

      const response = yield* session.http({ path: "report/pdf/foo/1" });
      const text = yield* response.text;

      assert.strictEqual(response.status, 200);
      assert.strictEqual(text, "hello");
      assert.strictEqual(rec.methods[1], "GET");
      assert.strictEqual(rec.urls[1], "https://erp.example.com/report/pdf/foo/1");
      assert.strictEqual(rec.sentCookies[1], "session_id=abc");
    }),
  );

  it.effect("returns a non-2xx response untouched — the caller owns the status", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [], methods: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              { body: sessionInfo(7), setCookie: "session_id=abc; Path=/" },
              { raw: "nope", status: 500, contentType: "text/plain" },
            ],
            rec,
          ),
        ),
      );

      const response = yield* session.http({ path: "report/pdf/bad/1" });
      // No failure: a 500 flows back as a plain response, not an error.
      assert.strictEqual(response.status, 500);
    }),
  );

  it.effect("http works for a fromExisting session too (shared internals)", () =>
    Effect.gen(function* () {
      const rec: Recorder = { sentCookies: [], urls: [], methods: [] };
      const session = yield* fromExisting({
        url: new URL("https://erp.example.com/"),
        sessionId: Redacted.make("harvested"),
      }).pipe(
        Effect.provide(
          fakeHttpClient(
            [{ body: sessionInfo(7) }, { raw: "ok", status: 200, contentType: "text/plain" }],
            rec,
          ),
        ),
      );

      const response = yield* session.http({ path: "report/pdf/foo/1" });
      assert.strictEqual(response.status, 200);
      // Hydrated via get_session_info, then the raw GET carried the injected cookie.
      assert.strictEqual(rec.urls[0], "https://erp.example.com/web/session/get_session_info");
      assert.strictEqual(rec.sentCookies[1], "session_id=harvested");
    }),
  );
});

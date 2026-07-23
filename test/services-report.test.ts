import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Redacted, Array as Arr } from "effect";
import type { OdooConfig } from "../src/config.ts";
import { HttpClient, HttpClientResponse } from "../src/internal/platform.ts";
import { make } from "../src/session/cookie.ts";
import { ReportService } from "../src/services/report.ts";

// ---------------------------------------------------------------------------
// A scripted HttpClient (bytes-aware): each entry may carry a JSON body, a raw
// string, or raw bytes, plus a status. Records the url each request hit.
// ---------------------------------------------------------------------------
interface Canned {
  readonly body?: unknown;
  readonly bytes?: Uint8Array;
  readonly status?: number;
  readonly setCookie?: string | undefined;
}

interface Recorder {
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
    rec.urls.push(request.url);
    const headers = new Headers();
    if (canned?.setCookie !== undefined) {
      headers.append("set-cookie", canned.setCookie);
    }
    const payload: BodyInit =
      canned?.bytes !== undefined
        ? (canned.bytes as unknown as ArrayBuffer)
        : JSON.stringify(canned?.body ?? {});
    if (canned?.bytes === undefined) {
      headers.set("content-type", "application/json");
    }
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
  result: { uid, user_context: {}, server_version_info: [17, 0, 0, "final", 0] },
});

const loginCanned: Canned = { body: sessionInfo(7), setCookie: "session_id=abc; Path=/" };

const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);

const failTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined =>
  Exit.isFailure(exit)
    ? Option.getOrUndefined(
        Option.map(
          Arr.head(exit.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error] : []))),
          (e) => (e as { _tag: string })._tag,
        ),
      )
    : undefined;

describe("ReportService.list", () => {
  it.effect("decodes ir.actions.report rows to camelCase via the json hatch", () =>
    Effect.gen(function* () {
      const rec: Recorder = { urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [
              loginCanned,
              {
                body: {
                  jsonrpc: "2.0",
                  id: 2,
                  result: [
                    {
                      id: 5,
                      name: "Model Overview",
                      report_name: "base.report_irmodeloverview",
                      model: "ir.model",
                      report_type: "qweb-pdf",
                    },
                  ],
                },
              },
            ],
            rec,
          ),
        ),
      );

      const rows = yield* ReportService.list(session);
      assert.deepStrictEqual(rows, [
        {
          id: 5,
          name: "Model Overview",
          reportName: "base.report_irmodeloverview",
          model: "ir.model",
          reportType: "qweb-pdf",
        },
      ]);
      assert.strictEqual(rec.urls[1], "https://erp.example.com/web/dataset/call_kw");
    }),
  );

  it.effect("a drifted row shape fails as SchemaDriftError", () =>
    Effect.gen(function* () {
      const rec: Recorder = { urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(
          fakeHttpClient(
            [loginCanned, { body: { jsonrpc: "2.0", id: 2, result: [{ id: "not-a-number" }] } }],
            rec,
          ),
        ),
      );
      const exit = yield* Effect.exit(ReportService.list(session));
      assert.strictEqual(failTag(exit), "SchemaDriftError");
    }),
  );
});

describe("ReportService.download", () => {
  it.effect("2xx PDF body → bytes; hits the report GET route with joined ids", () =>
    Effect.gen(function* () {
      const rec: Recorder = { urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(fakeHttpClient([loginCanned, { bytes: bytesOf("%PDF-1.7\n...") }], rec)),
      );

      const bytes = yield* ReportService.download(session, {
        reportName: "base.report_irmodeloverview",
        ids: [1, 2, 3],
      });

      assert.strictEqual(new TextDecoder().decode(bytes.subarray(0, 4)), "%PDF");
      assert.strictEqual(
        rec.urls[1],
        "https://erp.example.com/report/pdf/base.report_irmodeloverview/1,2,3",
      );
    }),
  );

  it.effect("2xx non-PDF body under converter pdf → SchemaDriftError", () =>
    Effect.gen(function* () {
      const rec: Recorder = { urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(fakeHttpClient([loginCanned, { bytes: bytesOf("<html>oops</html>") }], rec)),
      );
      const exit = yield* Effect.exit(
        ReportService.download(session, { reportName: "r", ids: [1] }),
      );
      assert.strictEqual(failTag(exit), "SchemaDriftError");
    }),
  );

  it.effect("404 → OdooMissingError", () =>
    Effect.gen(function* () {
      const rec: Recorder = { urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(fakeHttpClient([loginCanned, { bytes: bytesOf("nope"), status: 404 }], rec)),
      );
      const exit = yield* Effect.exit(
        ReportService.download(session, { reportName: "r", ids: [1] }),
      );
      assert.strictEqual(failTag(exit), "OdooMissingError");
    }),
  );

  it.effect("403 → OdooAccessError", () =>
    Effect.gen(function* () {
      const rec: Recorder = { urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(fakeHttpClient([loginCanned, { bytes: bytesOf("no"), status: 403 }], rec)),
      );
      const exit = yield* Effect.exit(
        ReportService.download(session, { reportName: "r", ids: [1] }),
      );
      assert.strictEqual(failTag(exit), "OdooAccessError");
    }),
  );

  it.effect("other non-2xx (unknown-report 500) → OdooTransportError", () =>
    Effect.gen(function* () {
      const rec: Recorder = { urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(fakeHttpClient([loginCanned, { bytes: bytesOf("500"), status: 500 }], rec)),
      );
      const exit = yield* Effect.exit(
        ReportService.download(session, { reportName: "does.not.exist", ids: [1] }),
      );
      assert.strictEqual(failTag(exit), "OdooTransportError");
    }),
  );

  it.effect("non-pdf converter skips the %PDF check", () =>
    Effect.gen(function* () {
      const rec: Recorder = { urls: [] };
      const session = yield* make(config).pipe(
        Effect.provide(fakeHttpClient([loginCanned, { bytes: bytesOf("<html/>") }], rec)),
      );
      const bytes = yield* ReportService.download(session, {
        reportName: "r",
        ids: [1],
        converter: "html",
      });
      assert.strictEqual(new TextDecoder().decode(bytes), "<html/>");
      assert.strictEqual(rec.urls[1], "https://erp.example.com/report/html/r/1");
    }),
  );
});

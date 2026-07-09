import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";
import type { OdooConfig } from "../src/config.ts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "../src/internal/platform.ts";
import type { CallKwParams } from "../src/transport.ts";
import { make, probeJson2Version } from "../src/transports/json2.ts";

const apiKeyConfig: OdooConfig = {
  url: new URL("https://erp.example.com"),
  db: "prod",
  credentials: {
    _tag: "ApiKey",
    username: "svc",
    apiKey: Redacted.make("s3cr3t"),
  },
};

const passwordConfig: OdooConfig = {
  url: new URL("https://erp.example.com"),
  db: "prod",
  credentials: {
    _tag: "Password",
    username: "svc",
    password: Redacted.make("hunter2"),
  },
};

/** Records the last request so header/body/url assertions can run on it. */
interface Captured {
  request?: HttpClientRequest.HttpClientRequest;
}

/** A fake `HttpClient` that answers every request with one canned web Response. */
const fakeClient = (status: number, body: unknown, captured?: Captured): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    if (captured) {
      captured.request = request;
    }
    const payload = body === undefined ? null : JSON.stringify(body);
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(payload, { status })));
  });

const provideClient = (client: HttpClient.HttpClient) =>
  Effect.provide(Layer.succeed(HttpClient.HttpClient, client));

const readJsonBody = (request: HttpClientRequest.HttpClientRequest): unknown =>
  JSON.parse(new TextDecoder().decode((request.body as { readonly body: Uint8Array }).body));

const call = (
  client: HttpClient.HttpClient,
  params: CallKwParams,
): Effect.Effect<unknown, unknown> =>
  make(apiKeyConfig).pipe(
    Effect.flatMap((transport) => transport.callKw(params)),
    provideClient(client),
  );

const params = (over: Partial<CallKwParams> = {}): CallKwParams => ({
  model: "res.partner",
  method: "read",
  args: [],
  kwargs: { ids: [1, 2], context: { lang: "en_US" } },
  ...over,
});

describe("Json2Transport", () => {
  it.effect("happy path: raw JSON out, bearer + db headers, kwargs body", () =>
    Effect.gen(function* () {
      const captured: Captured = {};
      const client = fakeClient(200, [{ id: 1, name: "Alice" }], captured);

      const result = yield* call(client, params());

      assert.deepStrictEqual(result, [{ id: 1, name: "Alice" }]);

      const request = captured.request;
      assert.isDefined(request);
      if (request === undefined) {
        return;
      }
      assert.strictEqual(request.method, "POST");
      assert.strictEqual(request.url, "https://erp.example.com/json/2/res.partner/read");
      assert.strictEqual(request.headers["authorization"], "Bearer s3cr3t");
      assert.strictEqual(request.headers["x-odoo-database"], "prod");
      assert.deepStrictEqual(readJsonBody(request), { ids: [1, 2], context: { lang: "en_US" } });
    }),
  );

  it.effect("sends the seam `ids` as the special `ids` body key, merged into kwargs", () =>
    Effect.gen(function* () {
      const captured: Captured = {};
      const client = fakeClient(200, [{ id: 5 }], captured);

      yield* call(
        client,
        params({ ids: [5, 6], kwargs: { fields: ["name"], context: { lang: "en_US" } } }),
      );

      const request = captured.request;
      assert.isDefined(request);
      if (request === undefined) {
        return;
      }
      assert.deepStrictEqual(readJsonBody(request), {
        fields: ["name"],
        context: { lang: "en_US" },
        ids: [5, 6],
      });
    }),
  );

  it.effect("still rejects positional args even when a seam `ids` is present", () =>
    Effect.gen(function* () {
      const client = fakeClient(200, null);
      const error = yield* Effect.flip(call(client, params({ ids: [1], args: [1, 2] })));
      assert.strictEqual((error as { _tag: string })._tag, "ProtocolUnsupportedError");
    }),
  );

  it.effect("rejects non-empty positional args, naming the method", () =>
    Effect.gen(function* () {
      const client = fakeClient(200, null);
      const error = yield* Effect.flip(call(client, params({ args: [1, 2] })));

      assert.strictEqual((error as { _tag: string })._tag, "ProtocolUnsupportedError");
      assert.include((error as { message: string }).message, "res.partner.read");
    }),
  );

  it.effect("Password credentials fail layer construction (bearer-only)", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        make(passwordConfig).pipe(provideClient(fakeClient(200, null))),
      );
      assert.strictEqual(error._tag, "OdooAuthenticationError");
      assert.strictEqual(error.reason, "invalid-credentials");
    }),
  );

  describe("status → error mapping (no body.name)", () => {
    const cases: ReadonlyArray<readonly [number, string]> = [
      [401, "OdooAuthenticationError"],
      [403, "OdooAccessError"],
      [404, "OdooMissingError"],
      [409, "OdooLockError"],
      [422, "OdooUserError"],
      [500, "OdooServerError"],
    ];
    for (const [status, tag] of cases) {
      it.effect(`${status} → ${tag}`, () =>
        Effect.gen(function* () {
          const client = fakeClient(status, { message: "boom" });
          const error = yield* Effect.flip(call(client, params()));
          assert.strictEqual((error as { _tag: string })._tag, tag);
          if (status === 401) {
            assert.strictEqual((error as { reason: string }).reason, "api-key-expired-or-invalid");
          } else if (tag !== "OdooAuthenticationError") {
            // Synthesized fault name preserves the status for diagnosis.
            assert.strictEqual((error as { name: string }).name, `http.${status}`);
          }
        }),
      );
    }
  });

  describe("status → error mapping (with body.name)", () => {
    const cases: ReadonlyArray<readonly [number, string, string]> = [
      [403, "odoo.exceptions.AccessError", "OdooAccessError"],
      [403, "odoo.exceptions.AccessDenied", "OdooAuthenticationError"],
      [422, "odoo.exceptions.ValidationError", "OdooValidationError"],
      [404, "odoo.exceptions.MissingError", "OdooMissingError"],
      [500, "odoo.exceptions.UserError", "OdooUserError"],
      [409, "odoo.exceptions.LockError", "OdooLockError"],
    ];
    for (const [status, name, tag] of cases) {
      it.effect(`${status} + ${name} → ${tag}`, () =>
        Effect.gen(function* () {
          const client = fakeClient(status, { name, message: "boom" });
          const error = yield* Effect.flip(call(client, params()));
          assert.strictEqual((error as { _tag: string })._tag, tag);
          // Body name always wins over the status fallback.
          if (tag !== "OdooAuthenticationError") {
            assert.strictEqual((error as { name: string }).name, name);
          }
        }),
      );
    }
  });

  it.effect("400 maps to a transport error (not a server fault)", () =>
    Effect.gen(function* () {
      const client = fakeClient(400, { message: "bad request" });
      const error = yield* Effect.flip(call(client, params()));
      assert.strictEqual((error as { _tag: string })._tag, "OdooTransportError");
    }),
  );

  describe("probeJson2Version", () => {
    it.effect("200 → Some(version)", () =>
      Effect.gen(function* () {
        const client = fakeClient(200, {
          version: "19.0",
          version_info: [19, 0, 0, "final", 0],
        });
        const result = yield* probeJson2Version(apiKeyConfig).pipe(provideClient(client));
        assert.isTrue(Option.isSome(result));
        if (Option.isSome(result)) {
          assert.strictEqual(result.value.version, "19.0");
        }
      }),
    );

    it.effect("404 means pre-19 → None", () =>
      Effect.gen(function* () {
        const client = fakeClient(404, null);
        const result = yield* probeJson2Version(apiKeyConfig).pipe(provideClient(client));
        assert.isTrue(Option.isNone(result));
      }),
    );

    it.effect("other non-2xx → transport error", () =>
      Effect.gen(function* () {
        const client = fakeClient(502, null);
        const error = yield* Effect.flip(
          probeJson2Version(apiKeyConfig).pipe(provideClient(client)),
        );
        assert.strictEqual(error._tag, "OdooTransportError");
      }),
    );
  });
});

import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import type { OdooConfig } from "../src/config.ts";
import { HttpClient, HttpClientResponse } from "../src/internal/platform.ts";
import * as JsonRpc from "../src/transports/jsonrpc.ts";

interface DecodedRequest {
  readonly service: string;
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

/** The recorded calls plus a handler that maps each decoded request to a JSON body. */
interface Stub {
  readonly calls: Array<DecodedRequest>;
  readonly client: HttpClient.HttpClient;
}

/**
 * A fake `HttpClient` that decodes the outbound `/jsonrpc` body, records it, and
 * returns whatever JSON `respond` produces — all in-memory, no network.
 */
const stubHttpClient = (respond: (req: DecodedRequest) => unknown): Stub => {
  const calls: Array<DecodedRequest> = [];
  const client = HttpClient.make((request) => {
    const body = request.body;
    const decoded =
      body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(body.body)) as { params: DecodedRequest })
        : { params: { service: "", method: "", args: [] } };
    calls.push(decoded.params);
    const payload = respond(decoded.params);
    const web = new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, web));
  });
  return { calls, client };
};

const config: OdooConfig = {
  url: new URL("https://odoo.example.com"),
  db: "testdb",
  credentials: {
    _tag: "ApiKey",
    username: "admin",
    apiKey: Redacted.make("secret-key"),
  },
};

const passwordConfig: OdooConfig = {
  ...config,
  credentials: { _tag: "Password", username: "admin", password: Redacted.make("hunter2") },
};

/** Envelope helpers matching Odoo's `{result}` / `{error}` responses. */
const ok = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });
const fault = (code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

describe("JsonRpcTransport.make", () => {
  it.effect("resolves uid then executes call_kw (happy path)", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient((req) =>
        req.method === "authenticate" ? ok(7) : ok([{ id: 42, name: "Acme" }]),
      );

      const transport = yield* JsonRpc.make(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      const result = yield* transport.callKw({
        model: "res.partner",
        method: "search_read",
        args: [],
        kwargs: { fields: ["name"] },
      });

      assert.deepStrictEqual(result, [{ id: 42, name: "Acme" }]);

      // authenticate first, then execute_kw with [db, uid, secret, model, method, args, kwargs].
      assert.strictEqual(stub.calls[0]?.method, "authenticate");
      const exec = stub.calls[1];
      assert.strictEqual(exec?.service, "object");
      assert.strictEqual(exec?.method, "execute_kw");
      assert.deepStrictEqual(exec?.args, [
        "testdb",
        7,
        "secret-key",
        "res.partner",
        "search_read",
        [],
        { fields: ["name"] },
      ]);
    }),
  );

  it.effect("prepends a seam `ids` as the first positional execute_kw argument", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient((req) => (req.method === "authenticate" ? ok(7) : ok(true)));

      const transport = yield* JsonRpc.make(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      yield* transport.callKw({
        model: "res.partner",
        method: "write",
        args: [{ name: "X" }],
        kwargs: { context: { lang: "en_US" } },
        ids: [1, 2],
      });

      const exec = stub.calls[1];
      // args = [db, uid, secret, model, method, [ids, ...args], kwargs].
      assert.deepStrictEqual(exec?.args[5], [[1, 2], { name: "X" }]);
    }),
  );

  it.effect("caches uid single-flight: two calls, one authenticate", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient((req) => (req.method === "authenticate" ? ok(7) : ok(true)));

      const transport = yield* JsonRpc.make(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      yield* transport.callKw({ model: "res.partner", method: "read", args: [[1]], kwargs: {} });
      yield* transport.callKw({ model: "res.partner", method: "read", args: [[2]], kwargs: {} });

      const authCalls = stub.calls.filter((c) => c.method === "authenticate");
      assert.strictEqual(authCalls.length, 1);
      assert.strictEqual(stub.calls.length, 3);
    }),
  );

  it.effect("authenticate → false yields OdooAuthenticationError", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(false));

      const transport = yield* JsonRpc.make(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      const exit = yield* Effect.exit(
        transport.callKw({ model: "res.partner", method: "read", args: [], kwargs: {} }),
      );
      assert.isTrue(exit._tag === "Failure");
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "OdooAuthenticationError");
      }
    }),
  );

  it.effect("Password credentials hint at the TOTP/API-key requirement", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(false));

      const transport = yield* JsonRpc.make(passwordConfig).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      const exit = yield* Effect.exit(
        transport.callKw({ model: "res.partner", method: "read", args: [], kwargs: {} }),
      );
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const err = exit.cause.error;
        assert.strictEqual(err._tag, "OdooAuthenticationError");
        if (err._tag === "OdooAuthenticationError") {
          assert.match(err.message, /API key/);
        }
      }
    }),
  );

  it.effect("maps a UserError fault from execute_kw", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient((req) =>
        req.method === "authenticate"
          ? ok(7)
          : fault(200, "Odoo Server Error", {
              name: "odoo.exceptions.UserError",
              message: "not allowed",
            }),
      );

      const transport = yield* JsonRpc.make(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      const exit = yield* Effect.exit(
        transport.callKw({ model: "res.partner", method: "write", args: [], kwargs: {} }),
      );
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        const err = exit.cause.error;
        assert.strictEqual(err._tag, "OdooUserError");
        if (err._tag === "OdooUserError") {
          assert.strictEqual(err.model, "res.partner");
          assert.strictEqual(err.method, "write");
        }
      }
    }),
  );

  it.effect("maps code 100 to SessionExpiredError", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient((req) =>
        req.method === "authenticate" ? ok(7) : fault(100, "Session expired"),
      );

      const transport = yield* JsonRpc.make(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      const exit = yield* Effect.exit(
        transport.callKw({ model: "res.partner", method: "read", args: [], kwargs: {} }),
      );
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "SessionExpiredError");
      }
    }),
  );

  it.effect("maps AccessDenied fault to OdooAuthenticationError", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient((req) =>
        req.method === "authenticate"
          ? ok(7)
          : fault(200, "Access Denied", { name: "odoo.exceptions.AccessDenied" }),
      );

      const transport = yield* JsonRpc.make(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      const exit = yield* Effect.exit(
        transport.callKw({ model: "res.partner", method: "read", args: [], kwargs: {} }),
      );
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "OdooAuthenticationError");
      }
    }),
  );

  it.effect("raises SchemaDriftError on a garbage response body", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ({ not: "a jsonrpc envelope" }));

      const transport = yield* JsonRpc.make(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      const exit = yield* Effect.exit(
        transport.callKw({ model: "res.partner", method: "read", args: [], kwargs: {} }),
      );
      if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "SchemaDriftError");
      }
    }),
  );
});

describe("JsonRpcTransport.makeVersion", () => {
  it.effect("calls common.version and decodes CommonVersionResponse", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() =>
        ok({
          server_version: "17.0",
          server_version_info: [17, 0, 0, "final", 0],
          server_serie: "17.0",
          protocol_version: 1,
        }),
      );

      const version = yield* JsonRpc.makeVersion(config).pipe(
        Effect.provideService(HttpClient.HttpClient, stub.client),
      );

      assert.strictEqual(version.server_version, "17.0");
      assert.strictEqual(stub.calls[0]?.service, "common");
      assert.strictEqual(stub.calls[0]?.method, "version");
    }),
  );
});

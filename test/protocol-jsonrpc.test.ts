import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  buildRequest,
  JsonRpcErrorResponse,
  type JsonRpcErrorPayload,
  JsonRpcResponse,
  JsonRpcSuccessResponse,
  mapJsonRpcError,
} from "../src/protocol/jsonrpc.ts";

const errorPayload = (over: Partial<JsonRpcErrorPayload>): JsonRpcErrorPayload => ({
  code: 200,
  message: "Odoo Server Error",
  ...over,
});

describe("buildRequest", () => {
  it.effect("wraps params in a JSON-RPC 2.0 envelope", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const req = buildRequest({ service: "object", method: "execute_kw", args: [1, 2] }, 7);
      assert.deepStrictEqual(req, {
        jsonrpc: "2.0",
        method: "call",
        params: { service: "object", method: "execute_kw", args: [1, 2] },
        id: 7,
      });
    }),
  );
});

describe("JsonRpcResponse schema", () => {
  const decode = Schema.decodeUnknownResult(JsonRpcResponse);

  it.effect("decodes a success envelope, keeping result opaque", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const decoded = yield* Schema.decodeUnknownEffect(JsonRpcSuccessResponse)({
        jsonrpc: "2.0",
        id: 1,
        result: [{ id: 42 }],
      });
      assert.deepStrictEqual(decoded.result, [{ id: 42 }]);
    }),
  );

  it.effect("decodes an Odoo 16/17 void success with result undefined", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const decoded = yield* Schema.decodeUnknownEffect(JsonRpcResponse)({
        jsonrpc: "2.0",
        id: 1,
      });
      assert.deepStrictEqual(decoded, { jsonrpc: "2.0", id: 1, result: undefined });
    }),
  );

  it.effect("decodes an error envelope", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const decoded = yield* Schema.decodeUnknownEffect(JsonRpcErrorResponse)({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 100, message: "Session expired" },
      });
      assert.strictEqual(decoded.error.code, 100);
    }),
  );

  it.effect("prefers the error branch over a spurious result match", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const decoded = yield* Schema.decodeUnknownEffect(JsonRpcResponse)({
        jsonrpc: "2.0",
        id: 1,
        error: { code: 200, message: "boom", data: { name: "odoo.exceptions.UserError" } },
      });
      assert.isTrue("error" in decoded);
    }),
  );

  it.effect("rejects a garbage body as drift (no jsonrpc envelope)", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.isTrue(decode({ foo: "bar" })._tag === "Failure");
      assert.isTrue(decode({ jsonrpc: "2.0" })._tag === "Failure");
      assert.isTrue(decode(42)._tag === "Failure");
    }),
  );

  it.effect("rejects an error-shaped response with an invalid error payload", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.isTrue(
        decode({
          jsonrpc: "2.0",
          id: 1,
          error: { code: "not-a-number", message: "boom" },
        })._tag === "Failure",
      );
    }),
  );
});

describe("mapJsonRpcError", () => {
  it.effect("code 100 → SessionExpiredError", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapJsonRpcError(errorPayload({ code: 100, message: "gone" }));
      assert.strictEqual(mapped._tag, "SessionExpiredError");
      assert.strictEqual(mapped.message, "gone");
    }),
  );

  it.effect("code 404 → OdooServerError, preserving data.name", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapJsonRpcError(
        errorPayload({ code: 404, data: { name: "werkzeug.exceptions.NotFound" } }),
      );
      assert.strictEqual(mapped._tag, "OdooServerError");
      if (mapped._tag === "OdooServerError") {
        assert.strictEqual(mapped.name, "werkzeug.exceptions.NotFound");
      }
    }),
  );

  it.effect("maps data.name (UserError) to its subtype, threading the call site", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapJsonRpcError(
        errorPayload({ data: { name: "odoo.exceptions.UserError", message: "nope" } }),
        { model: "res.partner", method: "write" },
      );
      assert.strictEqual(mapped._tag, "OdooUserError");
      if (mapped._tag === "OdooUserError") {
        assert.strictEqual(mapped.message, "nope");
        assert.strictEqual(mapped.model, "res.partner");
        assert.strictEqual(mapped.method, "write");
      }
    }),
  );

  it.effect("AccessDenied → OdooAuthenticationError (auth, not a server fault)", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapJsonRpcError(
        errorPayload({ data: { name: "odoo.exceptions.AccessDenied" } }),
      );
      assert.strictEqual(mapped._tag, "OdooAuthenticationError");
    }),
  );

  it.effect("missing data → OdooServerError with name 'unknown'", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapJsonRpcError(errorPayload({ message: "raw" }));
      assert.strictEqual(mapped._tag, "OdooServerError");
      if (mapped._tag === "OdooServerError") {
        assert.strictEqual(mapped.name, "unknown");
        assert.strictEqual(mapped.message, "raw");
        assert.deepStrictEqual(mapped.arguments, []);
        assert.deepStrictEqual(mapped.context, {});
      }
    }),
  );
});

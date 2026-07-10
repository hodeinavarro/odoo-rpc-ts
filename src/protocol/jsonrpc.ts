import { Schema } from "effect";
import type { FaultCallSite } from "../errors/mapFault.ts";
import { mapServerFault, type RawServerFault } from "../errors/mapFault.ts";
import { OdooServerError, type OdooServerFault } from "../errors/server.ts";
import type { OdooAuthenticationError } from "../errors/auth.ts";
import { SessionExpiredError } from "../errors/session.ts";

/**
 * The JSON-RPC envelope shared by every route that speaks it (`/jsonrpc`,
 * `/web/session/authenticate`, `/web/dataset/call_kw`). Deliberately
 * transport-agnostic: `params` is opaque here so the same builder serves the
 * `object`/`common` service calls and the web route's `{model, method, ...}`
 * params alike.
 *
 * GOTCHA: Odoo ignores the JSON-RPC `method` member entirely — it dispatches on
 * the URL and reads `params` by name. We still send the spec-mandated
 * `"call"` so the envelope is valid JSON-RPC 2.0.
 */
export interface JsonRpcRequest<P> {
  readonly jsonrpc: "2.0";
  readonly method: "call";
  readonly params: P;
  readonly id: number;
}

// GOTCHA: Odoo ignores the JSON-RPC `id` entirely — it never round-trips into
// dispatch. This process-wide monotonic counter exists only to keep concurrent
// requests distinguishable in logs/traces; module-level mutable state is
// acceptable precisely because nothing correctness-bearing reads it back.
let requestIdCounter = 0;

/** Next distinct JSON-RPC request id (log-correlation only; see gotcha above). */
export const nextRequestId = (): number => (requestIdCounter += 1);

/** Build a JSON-RPC 2.0 request envelope around arbitrary by-name `params`. */
export const buildRequest = <P>(params: P, id: number): JsonRpcRequest<P> => ({
  jsonrpc: "2.0",
  method: "call",
  params,
  id,
});

/**
 * The `error.data` payload. Odoo guarantees only `name` (the dotted Python
 * exception class); every other field can be absent depending on the fault and
 * the server's `dev_mode`. Decoded leniently, then normalized to
 * ""/[]/{} before it reaches {@link mapServerFault}.
 */
export const JsonRpcErrorData = Schema.Struct({
  name: Schema.String,
  debug: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Array(Schema.Unknown)),
  context: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type JsonRpcErrorData = typeof JsonRpcErrorData.Type;

/** The `error` member of a JSON-RPC error response. `data` may be absent. */
export const JsonRpcErrorPayload = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optional(JsonRpcErrorData),
});
export type JsonRpcErrorPayload = typeof JsonRpcErrorPayload.Type;

// `id` echoes what we sent, but a few Odoo error paths return `null` — accept
// any of the JSON-RPC-legal id shapes rather than drift on the envelope.
const JsonRpcId = Schema.Union([Schema.Number, Schema.String, Schema.Null]);

/** A JSON-RPC error response: `{jsonrpc, id?, error:{code, message, data?}}`. */
export const JsonRpcErrorResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(JsonRpcId),
  error: JsonRpcErrorPayload,
});
export type JsonRpcErrorResponse = typeof JsonRpcErrorResponse.Type;

/** A JSON-RPC success response: `{jsonrpc, id?, result}` (result is opaque). */
export const JsonRpcSuccessResponse = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optional(JsonRpcId),
  result: Schema.Unknown,
});
export type JsonRpcSuccessResponse = typeof JsonRpcSuccessResponse.Type;

/**
 * A whole JSON-RPC response. The error branch is tried first so a fault is
 * never mistaken for a `result: undefined` success. A body that is neither
 * shape (e.g. a proxy's HTML error page decoded as garbage) fails to decode →
 * the caller raises `SchemaDriftError`.
 */
export const JsonRpcResponse = Schema.Union([JsonRpcErrorResponse, JsonRpcSuccessResponse]);
export type JsonRpcResponse = typeof JsonRpcResponse.Type;

/** Normalize a lenient `error.data` (or its absence) into a {@link RawServerFault}. */
const normalizeFault = (
  data: JsonRpcErrorData | undefined,
  fallbackMessage: string,
): RawServerFault => ({
  name: data?.name ?? "unknown",
  message: data?.message ?? fallbackMessage,
  arguments: data?.arguments ?? [],
  context: data?.context ?? {},
  // exactOptionalPropertyTypes: attach `debug` only when actually present.
  ...(data?.debug !== undefined ? { debug: data.debug } : {}),
});

/**
 * The single JSON-RPC fault choke point. Both `/jsonrpc` and the web route feed
 * their decoded `error` payload through here so every fault normalizes into the
 * same tagged union.
 *
 * - code `100` → {@link SessionExpiredError} (Odoo's `SessionExpiredException`).
 * - code `404` → {@link OdooServerError} (NotFound; the `data.name` is often a
 *   werkzeug class we do not map, so it lands on the base fault by design).
 * - otherwise → {@link mapServerFault} on the normalized `data`; a missing
 *   `data` becomes name `"unknown"`, which falls back to {@link OdooServerError}.
 */
export const mapJsonRpcError = (
  error: JsonRpcErrorPayload,
  site: FaultCallSite = {},
): SessionExpiredError | OdooServerFault | OdooAuthenticationError => {
  if (error.code === 100) {
    return new SessionExpiredError({ message: error.message });
  }

  const raw = normalizeFault(error.data, error.message);

  if (error.code === 404) {
    return new OdooServerError({
      name: raw.name,
      message: raw.message,
      arguments: raw.arguments,
      context: raw.context,
      ...(raw.debug !== undefined ? { debug: raw.debug } : {}),
      ...(site.model !== undefined ? { model: site.model } : {}),
      ...(site.method !== undefined ? { method: site.method } : {}),
    });
  }

  return mapServerFault(raw, site);
};

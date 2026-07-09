import { Context, type Effect } from "effect";
import type { OdooAuthenticationError } from "./errors/auth.ts";
import type { ProtocolUnsupportedError } from "./errors/protocol.ts";
import type { SchemaDriftError } from "./errors/schema.ts";
import type { OdooServerFault } from "./errors/server.ts";
import type { SessionExpiredError } from "./errors/session.ts";
import type { OdooTransportError } from "./errors/transport.ts";

/**
 * Parameters for a single `call_kw`-shaped round trip. Deliberately mirrors
 * Odoo's `execute_kw(model, method, args, kwargs)`.
 */
export interface CallKwParams {
  readonly model: string;
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
  readonly kwargs: Record<string, unknown>;
  /**
   * The browse target — the record ids the method operates on.
   *
   * GOTCHA: this is protocol-agnostic on purpose. JSON-2 sends it as its special
   * `ids` body key; the execute_kw-family transports (web, `/jsonrpc`) prepend it
   * as the first positional argument. Callers set `ids` instead of hand-placing
   * it in `args`, so the same call works over every seam.
   */
  readonly ids?: ReadonlyArray<number>;
}

/**
 * The complete typed failure channel of a transport round trip. Every seam
 * (web, JSON-RPC, JSON-2) maps its wire faults into exactly this union at its
 * choke point, so application code sees one shape regardless of protocol.
 */
export type TransportCallError =
  | OdooTransportError
  | SessionExpiredError
  | SchemaDriftError
  | OdooAuthenticationError
  | ProtocolUnsupportedError
  | OdooServerFault;

/**
 * The one seam every protocol implements. `JsonRpcTransport`, `Json2Transport`,
 * and the cookie-session `WebTransport` all provide this tag; application code
 * depends only on it and stays protocol-agnostic.
 */
export class Transport extends Context.Tag("odoo-rpc-ts/Transport")<
  Transport,
  {
    /**
     * Execute one `call_kw`-shaped round trip and return the raw, still-undecoded
     * result (callers decode through `effect/Schema` at their boundary).
     *
     * GOTCHA: the JSON-2 API (`/json/2/<model>/<method>`) is keyword-only — it
     * cannot take positional `args`. A `Json2Transport` will reject any call
     * where `args` is non-empty; put everything in `kwargs` when targeting it.
     */
    readonly callKw: (params: CallKwParams) => Effect.Effect<unknown, TransportCallError>;
  }
>() {}

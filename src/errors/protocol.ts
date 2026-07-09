import { Data } from "effect";

/**
 * The wire protocols this client can speak. `json-2` is the Odoo 19+
 * `/json/2/<model>/<method>` bearer API; `json-rpc` is `/jsonrpc` →
 * `execute_kw`; `web` is the cookie-session `/web/dataset/call_kw` route.
 */
export type OdooProtocol = "json-rpc" | "json-2" | "web";

/**
 * The requested protocol is not available on the resolved server version —
 * e.g. asking a 16.0 server for JSON-2. Raised by the version resolver seam
 * so callers fail fast with a typed reason instead of interpreting a raw 404.
 */
export class ProtocolUnsupportedError extends Data.TaggedError("ProtocolUnsupportedError")<{
  readonly protocol: OdooProtocol;
  readonly serverVersion: string;
  readonly message: string;
}> {}

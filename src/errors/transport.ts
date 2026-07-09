import { Data } from "effect";
import type { HttpClientErrorType } from "../internal/platform.ts";

/**
 * Sanitized snapshot of the outbound request, safe to log and to attach to
 * errors. Never carries auth headers, cookies, or the request body — those
 * may hold `session_id`, API keys, or passwords.
 */
export interface RequestInfo {
  readonly method: string;
  readonly url: string;
}

/**
 * The network / HTTP layer failed: DNS, TLS, connection reset, non-decodable
 * response, timeout. Wraps the underlying platform `HttpClientError` as
 * `cause` and carries only the sanitized {@link RequestInfo}.
 *
 * A transport failure proves only that *something* failed at the wire — it
 * says nothing about Odoo's application state. Never infer success/idempotency
 * from it; probe actual state before any resume.
 */
export class OdooTransportError extends Data.TaggedError("OdooTransportError")<{
  readonly request: RequestInfo;
  readonly cause: HttpClientErrorType;
}> {}

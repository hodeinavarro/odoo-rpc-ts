import { Data } from "effect";
import type { HttpClientErrorType } from "../internal/platform.ts";

/** The stable platform failure distinction, without the unsafe platform error. */
export type TransportErrorKind = HttpClientErrorType["reason"]["_tag"];

/**
 * Sanitized snapshot of the outbound request, safe to log and to attach to
 * errors. The URL has no userinfo, query, or fragment. Never carries auth
 * headers, cookies, or the request body — those may hold `session_id`, API
 * keys, or passwords.
 */
export interface RequestInfo {
  readonly method: string;
  readonly url: string;
}

const sanitizeUrl = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "<invalid-url>";
  }
};

/**
 * The network / HTTP layer failed: DNS, TLS, connection reset, non-decodable
 * response, timeout. Carries only primitive metadata copied from the platform
 * error. It never retains the `HttpClientError`, its request, response, cause,
 * headers, or body.
 *
 * A transport failure proves only that *something* failed at the wire — it
 * says nothing about Odoo's application state. Never infer success/idempotency
 * from it; probe actual state before any resume.
 */
export class OdooTransportError extends Data.TaggedError("OdooTransportError")<{
  readonly request: RequestInfo;
  readonly kind: TransportErrorKind;
  readonly message: string;
  readonly status?: number;
}> {
  constructor(fields: {
    readonly request: RequestInfo;
    readonly kind: TransportErrorKind;
    readonly status?: number;
  }) {
    const request = {
      method: fields.request.method,
      url: sanitizeUrl(fields.request.url),
    };
    const suffix = fields.status === undefined ? "" : ` (HTTP ${fields.status})`;
    super({
      request,
      kind: fields.kind,
      message: `${fields.kind} during ${request.method} ${request.url}${suffix}`,
      ...(fields.status !== undefined ? { status: fields.status } : {}),
    });
  }

  /** Copy safe diagnostics out of an Effect HTTP error, then discard it. */
  static fromHttpClientError(request: RequestInfo, error: HttpClientErrorType): OdooTransportError {
    const status = error.response?.status;
    return new OdooTransportError({
      request,
      kind: error.reason._tag,
      ...(status !== undefined ? { status } : {}),
    });
  }
}

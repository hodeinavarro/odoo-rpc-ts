import { Data } from "effect";

/**
 * The cookie-based web session is no longer valid (JSON-RPC error code 100 /
 * `odoo.http.SessionExpiredException`). The `session_id` must be re-minted via
 * `/web/session/authenticate` before retrying. Distinct from
 * {@link OdooAuthenticationError} because the credentials themselves may still
 * be good — only the session died.
 */
export class SessionExpiredError extends Data.TaggedError("SessionExpiredError")<{
  readonly message: string;
}> {}

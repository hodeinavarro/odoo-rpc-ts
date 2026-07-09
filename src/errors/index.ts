/**
 * The complete error taxonomy for odoo-rpc-ts. Every failure the client can
 * produce is one of these tagged errors — nothing throws, and there is no
 * blanket error type. See AGENTS.md § Error taxonomy.
 */

export { OdooTransportError, type RequestInfo } from "./transport.ts";
export { OdooAuthenticationError, type OdooAuthReason } from "./auth.ts";
export { SessionExpiredError } from "./session.ts";
export { SchemaDriftError } from "./schema.ts";
export { ProtocolUnsupportedError, type OdooProtocol } from "./protocol.ts";
export {
  OdooServerError,
  OdooAccessError,
  OdooValidationError,
  OdooMissingError,
  OdooUserError,
  OdooLockError,
  serverFaultFields,
  type OdooServerFault,
} from "./server.ts";
export { mapServerFault, type RawServerFault, type FaultCallSite } from "./mapFault.ts";

import type { OdooTransportError } from "./transport.ts";
import type { OdooAuthenticationError } from "./auth.ts";
import type { SessionExpiredError } from "./session.ts";
import type { SchemaDriftError } from "./schema.ts";
import type { ProtocolUnsupportedError } from "./protocol.ts";
import type { OdooServerFault } from "./server.ts";

/** Transport / wire-layer failures. */
export type OdooTransportFailure = OdooTransportError;

/** Everything about establishing or keeping a usable session. */
export type OdooAuthFailure = OdooAuthenticationError | SessionExpiredError;

/** Boundary-decoding failures. */
export type OdooDecodeFailure = SchemaDriftError;

/**
 * The complete union of every error this client can fail with. Callers narrow
 * with `Effect.catchTag` / `catchTags`.
 */
export type OdooError =
  | OdooTransportError
  | OdooAuthenticationError
  | SessionExpiredError
  | SchemaDriftError
  | ProtocolUnsupportedError
  | OdooServerFault;

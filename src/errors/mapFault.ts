import { OdooAuthenticationError } from "./auth.ts";
import {
  OdooAccessError,
  OdooLockError,
  OdooMissingError,
  OdooServerError,
  OdooUserError,
  OdooValidationError,
  type OdooServerFault,
} from "./server.ts";

/**
 * The raw fault as surfaced by a transport choke point, before mapping. Only
 * `name` and `message` are guaranteed by Odoo; the rest may be absent and are
 * normalized to empty by the transport before reaching here.
 */
export interface RawServerFault {
  readonly name: string;
  readonly message: string;
  readonly arguments: ReadonlyArray<unknown>;
  readonly context: Record<string, unknown>;
  readonly debug?: string | undefined;
}

/** The call site, threaded through so faults carry where they came from. */
export interface FaultCallSite {
  readonly model?: string | undefined;
  readonly method?: string | undefined;
}

/**
 * Concrete constructors for the mapped subtypes, keyed by dotted Python name.
 * Any name absent from this table falls through to {@link OdooServerError},
 * which preserves the raw `name` verbatim.
 */
const byName: Record<string, new (fields: ConstructorFields) => OdooServerFault> = {
  "odoo.exceptions.AccessError": OdooAccessError,
  "odoo.exceptions.ValidationError": OdooValidationError,
  "odoo.exceptions.MissingError": OdooMissingError,
  "odoo.exceptions.UserError": OdooUserError,
  "odoo.exceptions.RedirectWarning": OdooUserError,
  "odoo.exceptions.Warning": OdooUserError,
  "odoo.exceptions.LockError": OdooLockError,
};

interface ConstructorFields {
  readonly name: string;
  readonly message: string;
  readonly arguments: ReadonlyArray<unknown>;
  readonly context: Record<string, unknown>;
  readonly debug?: string;
  readonly model?: string;
  readonly method?: string;
}

/**
 * Map a raw Odoo fault to exactly one tagged subtype. Shared by all three
 * transports' choke points so mapping lives in one place. Unknown names fall
 * back to {@link OdooServerError} with `name` preserved.
 *
 * GOTCHA: `odoo.exceptions.AccessDenied` is *authentication* (bad password or
 * API key — XML-RPC fault 3, distinct from AccessError's fault 4), so it maps
 * to {@link OdooAuthenticationError}, not to a server fault. Accounts with
 * TOTP enabled reject passwords over RPC entirely, hence the reason hint.
 */
export const mapServerFault = (
  fault: RawServerFault,
  site: FaultCallSite = {},
): OdooServerFault | OdooAuthenticationError => {
  if (fault.name === "odoo.exceptions.AccessDenied") {
    return new OdooAuthenticationError({
      reason: "invalid-credentials",
      message: fault.message,
    });
  }

  const Ctor = byName[fault.name] ?? OdooServerError;

  // Build with exactOptionalPropertyTypes: only attach optional keys when
  // actually present, never as explicit `undefined`.
  const fields: ConstructorFields = {
    name: fault.name,
    message: fault.message,
    arguments: fault.arguments,
    context: fault.context,
    ...(fault.debug !== undefined ? { debug: fault.debug } : {}),
    ...(site.model !== undefined ? { model: site.model } : {}),
    ...(site.method !== undefined ? { method: site.method } : {}),
  };

  return new Ctor(fields);
};

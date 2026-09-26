import { Schema } from "effect";

/**
 * Fields shared by every Odoo server fault. These are wire-decoded (the fault
 * payload is normalized at each transport's choke point), so the classes use
 * `Schema.TaggedError` rather than `Data.TaggedError`.
 *
 * - `name` — the raw Python exception name (e.g. `odoo.exceptions.AccessError`),
 *   preserved verbatim so nothing is lost even on the fallback path.
 * - `message` — the human-facing message Odoo produced.
 * - `arguments` — the exception's positional args, undecoded.
 * - `context` — the Odoo `context` dict in effect at the call, if surfaced.
 * - `debug` — the server traceback, when the server includes one.
 * - `model` / `method` — the call site, threaded in by the choke point.
 */
export const serverFaultFields = {
  name: Schema.String,
  message: Schema.String,
  arguments: Schema.Array(Schema.Unknown),
  context: Schema.Record(Schema.String, Schema.Unknown),
  debug: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
} as const;

/**
 * Any Odoo application-level fault whose Python name we do not map to a more
 * specific subtype. The raw `name` is preserved so callers can still branch on
 * it, and no information is discarded.
 */
export class OdooServerError extends Schema.TaggedError<OdooServerError>()(
  "OdooServerError",
  serverFaultFields,
) {}

/** `odoo.exceptions.AccessError` / `AccessDenied` — permission denied. */
export class OdooAccessError extends Schema.TaggedError<OdooAccessError>()(
  "OdooAccessError",
  serverFaultFields,
) {}

/** `odoo.exceptions.ValidationError` — a constraint/validation was violated. */
export class OdooValidationError extends Schema.TaggedError<OdooValidationError>()(
  "OdooValidationError",
  serverFaultFields,
) {}

/** `odoo.exceptions.MissingError` — a referenced record no longer exists. */
export class OdooMissingError extends Schema.TaggedError<OdooMissingError>()(
  "OdooMissingError",
  serverFaultFields,
) {}

/** `odoo.exceptions.UserError` — a deliberate, user-facing business error. */
export class OdooUserError extends Schema.TaggedError<OdooUserError>()(
  "OdooUserError",
  serverFaultFields,
) {}

/**
 * `odoo.exceptions.LockError` — concurrent-update / serialization lock failure
 * (surfaced as a distinct exception on Odoo 19+).
 */
export class OdooLockError extends Schema.TaggedError<OdooLockError>()(
  "OdooLockError",
  serverFaultFields,
) {}

/**
 * The union of every server-fault subtype. `mapServerFault` narrows a raw
 * fault to exactly one of these.
 */
export type OdooServerFault =
  | OdooServerError
  | OdooAccessError
  | OdooValidationError
  | OdooMissingError
  | OdooUserError
  | OdooLockError;

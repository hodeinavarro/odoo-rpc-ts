/**
 * Pure relation & temporal value schemas — the decode vocabulary for typed
 * records. No I/O: these are `effect/Schema` definitions a caller composes into
 * a row schema. They transform Odoo's on-the-wire shapes (classic `[id, name]`
 * many2one pairs, `false` empties, naive datetime strings) into ergonomic,
 * fully-typed domain values, failing loudly as schema drift on anything else.
 */
import { Effect, Option, Schema, SchemaIssue, SchemaParser, SchemaTransformation } from "effect";

// --- many2one references ----------------------------------------------------

/**
 * A decoded many2one reference: the related record's id and its display label,
 * as Odoo carries them together in a classic `search_read`/`read` payload. The
 * label is already present, so the common "show the name" case needs ZERO extra
 * round trips — see {@link ../typed.ts | TypedRecordSet.fetchRelated} for when
 * you need more than the label.
 */
export interface Many2OneRefValue {
  readonly id: number;
  readonly name: string;
}

/** The decoded-value schema for a {@link Many2OneRefValue}. */
export const Many2OneRefValue: Schema.Codec<Many2OneRefValue> = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
});

/** Odoo's on-the-wire many2one shape: the classic `[id, name]` pair. */
const Many2OneWirePair = Schema.Tuple([Schema.Number, Schema.String]);

/**
 * Decode a present many2one from its wire `[id, name]` pair to a
 * {@link Many2OneRefValue}. Use {@link Many2OneRefOrNull} for a field that can
 * be empty (Odoo sends `false`, not `null`, for an unset many2one).
 *
 * WIRE FACT: the `[id, name]` pair requires the classic `_classic_read` load
 * (the `search_read`/`read` default). A context that changes the load (e.g. a
 * future `load=None`) shifts the shape; strict decode then surfaces it as
 * {@link SchemaDriftError} rather than casting past it.
 */
export const Many2OneRefFromWire: Schema.Codec<Many2OneRefValue, readonly [number, string]> =
  Many2OneWirePair.pipe(
    Schema.decodeTo(
      Many2OneRefValue,
      SchemaTransformation.transform({
        decode: ([id, name]) => ({ id, name }),
        encode: ({ id, name }) => [id, name] as const,
      }),
    ),
  );

/** Ergonomic alias for {@link Many2OneRefFromWire} (the present-ref schema). */
export const Many2OneRef = Many2OneRefFromWire;

/** The wire shape of a nullable many2one: the `[id, name]` pair or `false`. */
const Many2OneWireOrFalse = Schema.Union([Many2OneWirePair, Schema.Literal(false)]);

/**
 * Decode a nullable many2one: the wire `[id, name]` pair → {@link Many2OneRefValue},
 * or Odoo's `false` empty → `null`. This is the schema a row declares for a
 * many2one that can be unset, e.g. `company_id: Many2OneRefOrNull`.
 */
export const Many2OneRefOrNull: Schema.Codec<
  Many2OneRefValue | null,
  readonly [number, string] | false
> = Many2OneWireOrFalse.pipe(
  Schema.decodeTo(
    Schema.NullOr(Many2OneRefValue),
    SchemaTransformation.transform({
      decode: (wire) => (wire === false ? null : { id: wire[0], name: wire[1] }),
      encode: (value) => (value === null ? (false as const) : ([value.id, value.name] as const)),
    }),
  ),
);

// --- dates & datetimes ------------------------------------------------------

// Odoo Date is `"YYYY-MM-DD"`; Datetime is `"YYYY-MM-DD HH:MM:SS"`, both naive.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

const pad = (n: number, width: number): string => n.toString().padStart(width, "0");

const formatUtcDate = (date: Date): string =>
  `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}`;

const formatUtcDateTime = (date: Date): string =>
  `${formatUtcDate(date)} ${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(
    date.getUTCSeconds(),
    2,
  )}`;

/** A decode/encode failure as a v4 schema issue on the offending value. */
const invalid = (value: unknown, message: string): SchemaIssue.InvalidValue =>
  new SchemaIssue.InvalidValue(Option.some(value), { message });

/**
 * Odoo `Date` field: `"YYYY-MM-DD"` → a `Date` at UTC midnight of that day.
 *
 * A `Date` is an instant, and Odoo's `Date` carries no time or zone. We anchor
 * it at UTC midnight and NEVER localize — reading back `getUTCFullYear()`/
 * `getUTCMonth()`/`getUTCDate()` reproduces the exact wire day on any host,
 * whereas the local accessors could roll a day depending on the runner's tz.
 * Decision (records design, 2026-07-10): decode as UTC, documented, never
 * silently localized.
 */
export const OdooDate: Schema.Codec<Date, string> = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Date,
    SchemaTransformation.transformOrFail({
      decode: (input) => {
        if (!DATE_RE.test(input)) {
          return Effect.fail(invalid(input, "expected YYYY-MM-DD"));
        }
        const ms = Date.parse(`${input}T00:00:00Z`);
        return Number.isNaN(ms)
          ? Effect.fail(invalid(input, "not a valid calendar date"))
          : Effect.succeed(new Date(ms));
      },
      encode: (date) =>
        Number.isNaN(date.getTime())
          ? Effect.fail(invalid(date, "invalid Date"))
          : Effect.succeed(formatUtcDate(date)),
    }),
  ),
);

/**
 * Odoo `Datetime` field: `"YYYY-MM-DD HH:MM:SS"` → a `Date` parsed as UTC.
 *
 * Odoo stores and transmits datetimes as naive strings that are UTC by
 * convention. A JS `Date` is a single instant, so parsing the wire string AS
 * UTC is the faithful, non-localizing choice: it names the same instant Odoo
 * meant, with no host-tz shift. We never apply the session tz here — that is a
 * presentation concern the caller owns. Decision (records design, 2026-07-10).
 */
export const OdooDateTime: Schema.Codec<Date, string> = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Date,
    SchemaTransformation.transformOrFail({
      decode: (input) => {
        if (!DATETIME_RE.test(input)) {
          return Effect.fail(invalid(input, "expected YYYY-MM-DD HH:MM:SS"));
        }
        const ms = Date.parse(`${input.replace(" ", "T")}Z`);
        return Number.isNaN(ms)
          ? Effect.fail(invalid(input, "not a valid calendar datetime"))
          : Effect.succeed(new Date(ms));
      },
      encode: (date) =>
        Number.isNaN(date.getTime())
          ? Effect.fail(invalid(date, "invalid Date"))
          : Effect.succeed(formatUtcDateTime(date)),
    }),
  ),
);

/**
 * Lift a `Codec<Date, string>` into one that also accepts Odoo's `false`
 * empty, decoding it to `null`. Shared by the date and datetime nullable
 * variants so the false↔null seam lives in exactly one place. Delegation to
 * the base codec runs through `SchemaParser.*Effect`, which fails with a
 * `SchemaIssue.Issue` directly — the v4 analogue of v3's
 * `ParseResult.decodeUnknown` delegation.
 */
const orFalseNull = (base: Schema.Codec<Date, string>): Schema.Codec<Date | null, string | false> =>
  Schema.Union([Schema.String, Schema.Literal(false)]).pipe(
    Schema.decodeTo(
      Schema.NullOr(Schema.Date),
      SchemaTransformation.transformOrFail({
        decode: (wire, options) =>
          wire === false
            ? Effect.succeed(null)
            : SchemaParser.decodeUnknownEffect(base)(wire, options),
        encode: (value, options) =>
          value === null
            ? Effect.succeed(false as const)
            : SchemaParser.encodeUnknownEffect(base)(value, options),
      }),
    ),
  );

/** {@link OdooDate} with Odoo's `false` empty decoding to `null`. */
export const OdooDateOrNull: Schema.Codec<Date | null, string | false> = orFalseNull(OdooDate);

/** {@link OdooDateTime} with Odoo's `false` empty decoding to `null`. */
export const OdooDateTimeOrNull: Schema.Codec<Date | null, string | false> =
  orFalseNull(OdooDateTime);

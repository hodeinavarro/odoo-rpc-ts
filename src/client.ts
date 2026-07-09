import { Context, Effect, Layer, Schema } from "effect";
import type { Domain } from "./domain.ts";
import { normalizeDomain } from "./domain.ts";
import { SchemaDriftError } from "./errors/schema.ts";
import { type OdooContext, Rpc } from "./rpc.ts";
import type { TransportCallError } from "./transport.ts";

/** A decoded Odoo record with unmodeled field values. */
export type OdooRecord = { readonly [field: string]: unknown };

/** `fields_get` metadata: field name → its attribute dict. */
export type FieldsMetadata = { readonly [field: string]: OdooRecord };

const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const RecordArray = Schema.Array(UnknownRecord);
const IdArray = Schema.Array(Schema.Number);
const FieldsGetResult = Schema.Record({ key: Schema.String, value: UnknownRecord });
const TrueLiteral = Schema.Literal(true);

/** Options shared by the record-listing ops. `context` merges via {@link Rpc}. */
export interface SearchOptions {
  readonly domain?: Domain;
  readonly limit?: number;
  readonly offset?: number;
  readonly order?: string;
  readonly context?: OdooContext;
}

export interface SearchReadOptions extends SearchOptions {
  readonly fields?: ReadonlyArray<string>;
}

/** Drop `undefined`-valued keys so we never wire an explicit `limit: null`. */
const compact = (obj: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
};

const decode =
  <A, I>(schema: Schema.Schema<A, I>, context: string) =>
  (raw: unknown): Effect.Effect<A, SchemaDriftError> =>
    Schema.decodeUnknown(schema)(raw).pipe(
      Effect.mapError((cause) => new SchemaDriftError({ context, payload: raw, cause })),
    );

/**
 * Hand-typed, boundary-decoded high-level Odoo operations over {@link Rpc}.
 * Every result is decoded through `effect/Schema`; a wire-shape mismatch fails
 * with {@link SchemaDriftError} carrying the raw payload, never a silent cast.
 */
export class OdooClient extends Context.Tag("odoo-rpc-ts/OdooClient")<
  OdooClient,
  {
    /**
     * `search_read(domain, fields, offset, limit, order)` — search and read in
     * one round trip. Rows decode through `schema` (default: unknown record).
     */
    readonly searchRead: <A = OdooRecord, I = A>(
      model: string,
      options?: SearchReadOptions,
      schema?: Schema.Schema<A, I>,
    ) => Effect.Effect<ReadonlyArray<A>, TransportCallError>;

    /** `search(domain, offset, limit, order)` — matching record ids. */
    readonly search: (
      model: string,
      options?: SearchOptions,
    ) => Effect.Effect<ReadonlyArray<number>, TransportCallError>;

    /** `read(ids, fields)` — read fields of the given records. */
    readonly read: (
      model: string,
      ids: ReadonlyArray<number>,
      fields?: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<OdooRecord>, TransportCallError>;

    /**
     * `create(vals_list)` — create one or many records, always returning the new
     * ids as an array (even for a single dict, which is normalized to a
     * one-element list). Odoo 16–19 `model_create_multi` returns a list of ids
     * for a list input, so the return contract is uniformly {@link ReadonlyArray}.
     */
    readonly create: (
      model: string,
      values: OdooRecord | ReadonlyArray<OdooRecord>,
    ) => Effect.Effect<ReadonlyArray<number>, TransportCallError>;

    /** `write(ids, values)` — update records; Odoo returns `true`. */
    readonly write: (
      model: string,
      ids: ReadonlyArray<number>,
      values: OdooRecord,
    ) => Effect.Effect<true, TransportCallError>;

    /** `unlink(ids)` — delete records; Odoo returns `true`. */
    readonly unlink: (
      model: string,
      ids: ReadonlyArray<number>,
    ) => Effect.Effect<true, TransportCallError>;

    /** `fields_get(attributes=...)` — field metadata keyed by field name. */
    readonly fieldsGet: (
      model: string,
      options?: { readonly attributes?: ReadonlyArray<string> },
    ) => Effect.Effect<FieldsMetadata, TransportCallError>;

    /** `search_count(domain)` — number of records matching the domain. */
    readonly searchCount: (
      model: string,
      domain: Domain,
    ) => Effect.Effect<number, TransportCallError>;
  }
>() {}

/** The {@link OdooClient} layer over an {@link Rpc} service. */
export const layer: Layer.Layer<OdooClient, never, Rpc> = Layer.effect(
  OdooClient,
  Effect.gen(function* () {
    const rpc = yield* Rpc;

    const withContext = (context?: OdooContext) =>
      context === undefined ? undefined : { context };

    const searchRead = <A = OdooRecord, I = A>(
      model: string,
      options?: SearchReadOptions,
      schema?: Schema.Schema<A, I>,
    ): Effect.Effect<ReadonlyArray<A>, TransportCallError> => {
      // Rows decode FROM the wire shape (I) TO the domain shape (A), so
      // transforming schemas (DateFromString, false->null, ...) are first-class.
      const rowSchema = (schema ?? UnknownRecord) as Schema.Schema<A, I>;
      const kwargs = compact({
        domain: normalizeDomain(options?.domain ?? []),
        fields: options?.fields,
        limit: options?.limit,
        offset: options?.offset,
        order: options?.order,
      });
      return rpc
        .callKw(model, "search_read", [], kwargs, withContext(options?.context))
        .pipe(Effect.flatMap(decode(Schema.Array(rowSchema), `${model}.search_read`)));
    };

    const search = (
      model: string,
      options?: SearchOptions,
    ): Effect.Effect<ReadonlyArray<number>, TransportCallError> => {
      const kwargs = compact({
        domain: normalizeDomain(options?.domain ?? []),
        limit: options?.limit,
        offset: options?.offset,
        order: options?.order,
      });
      return rpc
        .callKw(model, "search", [], kwargs, withContext(options?.context))
        .pipe(Effect.flatMap(decode(IdArray, `${model}.search`)));
    };

    // The record-targeting ops are protocol-agnostic: the browse ids ride on the
    // transport seam's `ids` (positional on execute_kw, the `ids` body key on
    // JSON-2), and every other argument is passed by its stable Python parameter
    // name (`fields`, `vals`, `vals_list`, `domain`) — `call_kw` binds kwargs by
    // name identically across Odoo 16–19 and all three transports.
    const read = (
      model: string,
      ids: ReadonlyArray<number>,
      fields?: ReadonlyArray<string>,
    ): Effect.Effect<ReadonlyArray<OdooRecord>, TransportCallError> =>
      rpc
        .callKw(model, "read", [], compact({ fields }), { ids })
        .pipe(Effect.flatMap(decode(RecordArray, `${model}.read`)));

    const create = (
      model: string,
      values: OdooRecord | ReadonlyArray<OdooRecord>,
    ): Effect.Effect<ReadonlyArray<number>, TransportCallError> => {
      const valsList = Array.isArray(values) ? values : [values];
      // Dialect split (see TransportDialect): call_kw reads create's vals from
      // args[0] unconditionally (16-19), while JSON-2 is keyword-only.
      const call =
        rpc.dialect === "json2"
          ? rpc.callKw(model, "create", [], { vals_list: valsList })
          : rpc.callKw(model, "create", [valsList]);
      return call.pipe(Effect.flatMap(decode(IdArray, `${model}.create`)));
    };

    const write = (
      model: string,
      ids: ReadonlyArray<number>,
      values: OdooRecord,
    ): Effect.Effect<true, TransportCallError> =>
      rpc
        .callKw(model, "write", [], { vals: values }, { ids })
        .pipe(Effect.flatMap(decode(TrueLiteral, `${model}.write`)));

    const unlink = (
      model: string,
      ids: ReadonlyArray<number>,
    ): Effect.Effect<true, TransportCallError> =>
      rpc
        .callKw(model, "unlink", [], {}, { ids })
        .pipe(Effect.flatMap(decode(TrueLiteral, `${model}.unlink`)));

    const fieldsGet = (
      model: string,
      options?: { readonly attributes?: ReadonlyArray<string> },
    ): Effect.Effect<FieldsMetadata, TransportCallError> =>
      rpc
        .callKw(model, "fields_get", [], compact({ attributes: options?.attributes }))
        .pipe(Effect.flatMap(decode(FieldsGetResult, `${model}.fields_get`)));

    const searchCount = (
      model: string,
      domain: Domain,
    ): Effect.Effect<number, TransportCallError> =>
      rpc
        .callKw(model, "search_count", [], { domain: normalizeDomain(domain) })
        .pipe(Effect.flatMap(decode(Schema.Number, `${model}.search_count`)));

    return {
      searchRead,
      search,
      read,
      create,
      write,
      unlink,
      fieldsGet,
      searchCount,
    };
  }),
);

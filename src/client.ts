import { Context, Effect, Layer, Schema } from "effect";
import type { Domain } from "./domain.ts";
import { normalizeDomain } from "./domain.ts";
import { SchemaDriftError } from "./errors/schema.ts";
import { OdooMissingError, type OdooServerError } from "./errors/server.ts";
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
/** A `(id, display_name)` pair, as returned by `name_search`/`name_get`. */
const NamePair = Schema.Tuple(Schema.Number, Schema.String);
const NamePairArray = Schema.Array(NamePair);
/** `check_object_reference` → `(model, res_id)`; `res_id` is `false` when the
 * xml_id resolves but is not visible to the caller. */
const ObjectReference = Schema.Tuple(
  Schema.String,
  Schema.Union(Schema.Number, Schema.Literal(false)),
);

/** Options for {@link OdooClient.call} — the undecoded model-method escape hatch. */
export interface CallOptions {
  readonly ids?: ReadonlyArray<number>;
  readonly context?: OdooContext;
  readonly kwargs?: Record<string, unknown>;
}

/** Arguments for `read_group` (all Python-stable parameter names, 16–19). */
export interface ReadGroupOptions {
  readonly domain: Domain;
  readonly fields: ReadonlyArray<string>;
  readonly groupby: ReadonlyArray<string>;
  readonly limit?: number;
  readonly offset?: number;
  readonly orderby?: string;
  readonly lazy?: boolean;
  readonly context?: OdooContext;
}

/** Arguments for `name_search`. `args` is the optional search domain. */
export interface NameSearchOptions {
  readonly name?: string;
  readonly args?: Domain;
  readonly operator?: string;
  readonly limit?: number;
  readonly context?: OdooContext;
}

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

    /**
     * Resolve an external identifier (`module.name`) to its `(model, id)` pair,
     * via `ir.model.data.check_object_reference`.
     *
     * We always use `check_object_reference` (present since Odoo 15) rather than
     * branching to the legacy `xmlid_to_res_model_res_id` — this library
     * supports 16–19 only, so the legacy branch is dead weight. A missing xml_id
     * (the server raises a `ValueError`, mapped to `OdooServerError`) or an
     * xml_id that resolves but is not visible to the caller (`[model, false]`)
     * both fail with {@link OdooMissingError} naming the xml_id.
     */
    readonly ref: (
      xmlId: string,
    ) => Effect.Effect<readonly [model: string, id: number], TransportCallError>;

    /**
     * Escape hatch: call any `model.method` and return its raw, UNDECODED result.
     * The browse `ids`, `context`, and `kwargs` ride the {@link Rpc} seam; no
     * schema is applied, so the caller owns validating the shape. Prefer the
     * typed ops above where one exists.
     */
    readonly call: (
      model: string,
      method: string,
      options?: CallOptions,
    ) => Effect.Effect<unknown, TransportCallError>;

    /**
     * `read_group(domain, fields, groupby, offset, limit, orderby, lazy)` —
     * aggregate records into groups. Rows decode as unknown records (group keys,
     * aggregates, and `__count`/`__domain` are model-dependent).
     */
    readonly readGroup: (
      model: string,
      options: ReadGroupOptions,
    ) => Effect.Effect<ReadonlyArray<OdooRecord>, TransportCallError>;

    /**
     * `name_search(name, domain, operator, limit)` → `(id, display_name)` pairs.
     *
     * WIRE FACT: the second parameter was renamed `args` → `domain` in Odoo 19.
     * Over the execute_kw family we pass all four POSITIONALLY (position is
     * stable across 16–19); over JSON-2 (19+) we pass them by MODERN name
     * (`name`, `domain`, `operator`, `limit`).
     */
    readonly nameSearch: (
      model: string,
      options?: NameSearchOptions,
    ) => Effect.Effect<ReadonlyArray<readonly [number, string]>, TransportCallError>;

    /**
     * `name_get()` → `(id, display_name)` pairs for the given ids.
     *
     * GOTCHA: `name_get` was REMOVED server-side in Odoo 17+. We call it as-is
     * with no polyfill; on 17+ it fails as a server fault. Use {@link nameSearch}
     * or read `display_name` instead on modern servers.
     */
    readonly nameGet: (
      model: string,
      ids: ReadonlyArray<number>,
    ) => Effect.Effect<ReadonlyArray<readonly [number, string]>, TransportCallError>;
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

    const missingRef = (xmlId: string, source?: OdooServerError): OdooMissingError =>
      new OdooMissingError({
        name: source?.name ?? "odoo.exceptions.MissingError",
        message: source?.message ?? `No record found for external ID '${xmlId}'.`,
        arguments: [xmlId],
        context: source?.context ?? {},
        ...(source?.debug !== undefined ? { debug: source.debug } : {}),
        model: "ir.model.data",
        method: "check_object_reference",
      });

    const ref = (
      xmlId: string,
    ): Effect.Effect<readonly [model: string, id: number], TransportCallError> => {
      const dot = xmlId.indexOf(".");
      if (dot <= 0 || dot === xmlId.length - 1) {
        return Effect.fail(missingRef(xmlId));
      }
      const module = xmlId.slice(0, dot);
      const name = xmlId.slice(dot + 1);
      // Dialect split: execute_kw sends (module, name) positionally; JSON-2 binds
      // by parameter name (`module`, `xml_id`).
      const call =
        rpc.dialect === "json2"
          ? rpc.callKw("ir.model.data", "check_object_reference", [], { module, xml_id: name })
          : rpc.callKw("ir.model.data", "check_object_reference", [module, name]);
      return call.pipe(
        // A truly-unknown xml_id makes the server raise ValueError (an unmapped
        // fault → OdooServerError); remap it to a named OdooMissingError.
        Effect.catchTag("OdooServerError", (e) => Effect.fail(missingRef(xmlId, e))),
        Effect.flatMap(decode(ObjectReference, `${xmlId} check_object_reference`)),
        Effect.flatMap(([model, resId]) =>
          resId === false
            ? Effect.fail(missingRef(xmlId))
            : Effect.succeed([model, resId] as const),
        ),
      );
    };

    const call = (
      model: string,
      method: string,
      options?: CallOptions,
    ): Effect.Effect<unknown, TransportCallError> =>
      rpc.callKw(
        model,
        method,
        [],
        options?.kwargs ?? {},
        compact({ ids: options?.ids, context: options?.context }),
      );

    const readGroup = (
      model: string,
      options: ReadGroupOptions,
    ): Effect.Effect<ReadonlyArray<OdooRecord>, TransportCallError> => {
      const kwargs = compact({
        domain: normalizeDomain(options.domain),
        fields: options.fields,
        groupby: options.groupby,
        limit: options.limit,
        offset: options.offset,
        orderby: options.orderby,
        lazy: options.lazy,
      });
      return rpc
        .callKw(model, "read_group", [], kwargs, withContext(options.context))
        .pipe(Effect.flatMap(decode(RecordArray, `${model}.read_group`)));
    };

    const nameSearch = (
      model: string,
      options?: NameSearchOptions,
    ): Effect.Effect<ReadonlyArray<readonly [number, string]>, TransportCallError> => {
      const name = options?.name ?? "";
      const operator = options?.operator ?? "ilike";
      const limit = options?.limit ?? 100;
      const domain = normalizeDomain(options?.args ?? []);
      // Dialect split (see the interface WIRE FACT): positional over execute_kw
      // (version-proof against the args→domain rename), by modern name on JSON-2.
      const call_ =
        rpc.dialect === "json2"
          ? rpc.callKw(model, "name_search", [], { name, domain, operator, limit })
          : rpc.callKw(model, "name_search", [name, domain, operator, limit]);
      return call_.pipe(
        Effect.flatMap(decode(NamePairArray, `${model}.name_search`)),
        Effect.map((pairs) => pairs.map(([id, label]) => [id, label] as const)),
      );
    };

    const nameGet = (
      model: string,
      ids: ReadonlyArray<number>,
    ): Effect.Effect<ReadonlyArray<readonly [number, string]>, TransportCallError> =>
      rpc.callKw(model, "name_get", [], {}, { ids }).pipe(
        Effect.flatMap(decode(NamePairArray, `${model}.name_get`)),
        Effect.map((pairs) => pairs.map(([id, label]) => [id, label] as const)),
      );

    return {
      searchRead,
      search,
      read,
      create,
      write,
      unlink,
      fieldsGet,
      searchCount,
      ref,
      call,
      readGroup,
      nameSearch,
      nameGet,
    };
  }),
);

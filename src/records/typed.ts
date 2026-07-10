/**
 * `TypedRecordSet` — an immutable, decoded snapshot of rows bound to its
 * `(rpc, model)` origin, with explicit, batched relation traversal — the
 * CLASSIC tier of the records design (the classic `[id, name]`-pair protocol,
 * works on 16+; the spec tier in `recordModel.ts` needs 17+). Traversal is always ONE `read` per relation per
 * recordset — never per row — so the N+1 storm is structurally impossible: there
 * is no per-record fetch API to misuse. The snapshot is never mutated; a fetch
 * produces a fresh {@link RelatedMap}, and the caller joins explicitly.
 */
import { Effect, Schema } from "effect";
import { SchemaDriftError } from "../errors/schema.ts";
import type { Rpc } from "../rpc.ts";
import type { TransportCallError } from "../transport.ts";
import { collectRefIds, makeRelatedMap, type RelatedMap } from "./related.ts";
import type { Many2OneRefValue } from "./relations.ts";

/** A decoded row must carry its `id` — every traversal and join keys on it. */
export type HasId = { readonly id: number };

/**
 * The field names of `Row` whose decoded value is a many2one reference
 * (`Many2OneRefValue | null`) — the only fields a relation can be traversed
 * through. A compile-time constraint: passing any other key to
 * {@link TypedRecordSet.fetchRelated}/`joinRelated` is a type error, not a
 * runtime surprise.
 */
export type Many2OneRefField<Row> = {
  readonly [K in keyof Row]: Row[K] extends Many2OneRefValue | null ? K : never;
}[keyof Row];

/**
 * An immutable snapshot of typed rows with explicit relation traversal. Obtain
 * one from `OdooClient.searchRecordsTyped`; it is bound to the `Rpc` seam and
 * model it was read from so `fetchRelated` can batch a co-model `read`.
 */
export interface TypedRecordSet<Row extends HasId> extends Iterable<Row> {
  /** The model these rows were read from. */
  readonly model: string;
  /** The decoded rows, in server order. Immutable. */
  readonly rows: ReadonlyArray<Row>;
  /** Each row's `id`, in row order. */
  readonly ids: ReadonlyArray<number>;
  /** The number of rows. */
  readonly length: number;

  /**
   * Fetch the related records behind a many2one `field` in ONE batched `read`
   * over the distinct, non-null ids across the whole snapshot, decoded through
   * `schema`. Returns a {@link RelatedMap} keyed by related id — a fresh
   * snapshot; the recordset is never back-filled.
   *
   * ZERO round trips when no row references a related record (all empty). The
   * batched-single-read guarantee is the entire point of this API and is
   * asserted in the tests, not merely documented.
   */
  readonly fetchRelated: <K extends Many2OneRefField<Row>, A extends HasId, I = A>(
    field: K,
    relatedModel: string,
    schema: Schema.Codec<A, I>,
    fields?: ReadonlyArray<string>,
  ) => Effect.Effect<RelatedMap<A>, TransportCallError>;

  /**
   * Like {@link fetchRelated}, but returns each row paired with its joined
   * related record (`null` when the many2one is empty or unresolved). One
   * explicit, batched call — named to keep "this is a fetch" legible at the call
   * site.
   */
  readonly joinRelated: <K extends Many2OneRefField<Row>, A extends HasId, I = A>(
    field: K,
    relatedModel: string,
    schema: Schema.Codec<A, I>,
    fields?: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<readonly [Row, A | null]>, TransportCallError>;
}

/** The subset of the {@link Rpc} service {@link TypedRecordSet} depends on. */
type RpcSeam = Pick<typeof Rpc.Service, "callKw">;

/** Boundary decode: a related-`read` payload that fails the caller schema is drift. */
const decodeRows =
  <A, I>(schema: Schema.Codec<A, I>, context: string) =>
  (raw: unknown): Effect.Effect<ReadonlyArray<A>, SchemaDriftError> =>
    Schema.decodeUnknownEffect(Schema.Array(schema))(raw).pipe(
      Effect.mapError((cause) => new SchemaDriftError({ context, payload: raw, cause })),
    );

/**
 * Read a many2one field off a row as a traversable ref value, or fail the whole
 * traversal as a defect. The type system already forbids non-ref fields; this
 * guards the dynamic-misuse escape hatch (e.g. an `any`-typed field or a schema
 * that decoded the wrong shape) — a `TypeError`-equivalent `Effect.die` with a
 * precise locator, never a silent skip.
 */
const readRefField = <Row extends HasId>(
  row: Row,
  field: PropertyKey,
  model: string,
): Effect.Effect<Many2OneRefValue | null> => {
  const value = (row as Record<PropertyKey, unknown>)[field];
  if (value === null || value === undefined) {
    return Effect.succeed(null);
  }
  if (typeof value === "object" && typeof (value as { id?: unknown }).id === "number") {
    return Effect.succeed(value as Many2OneRefValue);
  }
  return Effect.die(
    `TypedRecordSet(${model}).fetchRelated: field ${String(field)} of record ${row.id} is not a ` +
      `many2one reference ({ id, name } | null); got ${typeof value}. Declare it with ` +
      `Many2OneRefOrNull so traversal is type-safe.`,
  );
};

/**
 * Construct a {@link TypedRecordSet} over already-decoded rows. Internal: the
 * public entry point is `OdooClient.searchRecordsTyped`, which owns the initial
 * `search_read` decode and passes the resulting rows here.
 */
export const make = <Row extends HasId>(
  rpc: RpcSeam,
  model: string,
  rows: ReadonlyArray<Row>,
): TypedRecordSet<Row> => {
  const ids = rows.map((row) => row.id);

  const fetchRelated = <K extends Many2OneRefField<Row>, A extends HasId, I = A>(
    field: K,
    relatedModel: string,
    schema: Schema.Codec<A, I>,
    fields?: ReadonlyArray<string>,
  ): Effect.Effect<RelatedMap<A>, TransportCallError> =>
    // Validate every row's field up front (dynamic-misuse guard), then collect
    // the distinct ids purely and issue AT MOST one read.
    Effect.forEach(rows, (row) => readRefField(row, field, model)).pipe(
      Effect.flatMap((refs) => {
        const relatedIds = collectRefIds(refs, (ref) => ref);
        if (relatedIds.length === 0) {
          // No referenced records → no round trip. Asserted in the tests.
          return Effect.succeed(makeRelatedMap<A>([]));
        }
        return rpc
          .callKw(
            relatedModel,
            "read",
            [],
            fields === undefined ? {} : { fields },
            { ids: relatedIds },
          )
          .pipe(
            Effect.flatMap(decodeRows(schema, `${relatedModel}.read`)),
            Effect.map((relatedRows) => makeRelatedMap(relatedRows)),
          );
      }),
    );

  const joinRelated = <K extends Many2OneRefField<Row>, A extends HasId, I = A>(
    field: K,
    relatedModel: string,
    schema: Schema.Codec<A, I>,
    fields?: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<readonly [Row, A | null]>, TransportCallError> =>
    fetchRelated(field, relatedModel, schema, fields).pipe(
      Effect.map((related) =>
        rows.map(
          (row) =>
            [row, related.get((row as Record<PropertyKey, unknown>)[field] as never)] as const,
        ),
      ),
    );

  return {
    model,
    rows,
    ids,
    length: rows.length,
    [Symbol.iterator]: () => rows[Symbol.iterator](),
    fetchRelated,
    joinRelated,
  };
};

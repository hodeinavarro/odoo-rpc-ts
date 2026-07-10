/**
 * Declared record models — the SPEC tier of the records design ("declared
 * prefetch" over the 17+ `specification` protocol; the classic tier in
 * `typed.ts`/`related.ts` speaks the 16+ `[id, name]`-pair protocol instead).
 * A `RecordSpec`
 * declares a model's field graph with `effect/Schema`: scalars decode directly,
 * relations declared with {@link Many2One}/{@link One2Many} carry a nested child
 * `RecordSpec`. From one declaration we derive BOTH:
 *
 *   1. a row {@link RecordSpec.schema} that strict-decodes the NESTED wire shape
 *      the 17+ `web_search_read`/`web_read` `specification` protocol returns
 *      (a many2one as a `{ id, ...declared }` dict or `false`; an x2many as a
 *      nested list), and
 *   2. the field {@link RecordSpec.fields} metadata that {@link ./spec.ts} compiles
 *      into that `specification` payload.
 *
 * No I/O lives here — this is pure declaration. The single round trip that turns
 * a spec into rows is in `OdooClient.searchTyped`/`readTyped`/`saveTyped`.
 *
 * MANY2ONE VALUE SHAPE (decision, records design 2026-07-10). A declared
 * many2one decodes to a FLAT struct `{ id, ...declaredChildFields } | null`, not
 * a `{ id, value }` wrapper. In TS, `| null` already carries "is it set?", and a
 * flat struct exposes `.id` and every declared child field as directly-typed
 * properties (`company.name`) with no `__getattr__`-style proxy and no extra
 * `.value` hop — strictly better inference and ergonomics than a wrapper. This
 * deliberately diverges from the Python design's `.value` recommendation, which
 * existed to model presence separately from the record; TS does not need it.
 */
import { Schema } from "effect";
import type { HasId } from "./typed.ts";

/**
 * Per-field compilation metadata: how {@link ./spec.ts} renders each field. The
 * relation `child` is typed loosely (`RecordSpec<any, any>`) because `Schema` is
 * invariant in its type parameter — a precisely-typed child spec is not
 * assignable to a widened one, so the metadata graph is deliberately erased. The
 * precise types live on {@link RecordSpec.schema} for decode; this metadata is
 * only ever walked structurally by the pure compiler.
 */
export type FieldMeta =
  | { readonly kind: "scalar" }
  // oxlint-disable-next-line no-explicit-any -- Schema is invariant; see above.
  | { readonly kind: "many2one"; readonly child: RecordSpec<any, any> }
  | {
      readonly kind: "one2many";
      // oxlint-disable-next-line no-explicit-any -- Schema is invariant; see above.
      readonly child: RecordSpec<any, any>;
      readonly limit: number | undefined;
    };

/**
 * A declared record model: its Odoo model name, the row decode `schema` (the
 * whole nested graph), the per-field compilation `fields`, and whether it
 * declares any relation (the version gate keys on this). Build one with
 * {@link defineRecord}.
 */
export interface RecordSpec<A extends HasId, I = A> {
  readonly model: string;
  readonly schema: Schema.Schema<A, I>;
  readonly fields: Readonly<Record<string, FieldMeta>>;
  /** `true` iff at least one declared field is a many2one/one2many relation. */
  readonly hasRelations: boolean;
}

/** A declared many2one relation field — nests a child {@link RecordSpec}. */
export interface Many2OneDecl<A extends HasId, I> {
  readonly _decl: "many2one";
  readonly spec: RecordSpec<A, I>;
}

/** A declared one2many/many2many relation field — nests a child {@link RecordSpec}. */
export interface One2ManyDecl<A extends HasId, I> {
  readonly _decl: "one2many";
  readonly spec: RecordSpec<A, I>;
  readonly limit: number | undefined;
}

/**
 * Declare a many2one field: `company_id: Many2One(Company)`. Decodes the nested
 * `{ id, ...Company fields }` wire dict to `Company | null` (Odoo's `false`
 * empty → `null`). Note it does NOT accept the classic `[id, name]` pair — under
 * a `specification` the server returns a dict, so a leaked pair is drift, not a
 * silent decode.
 */
export const Many2One = <A extends HasId, I>(spec: RecordSpec<A, I>): Many2OneDecl<A, I> => ({
  _decl: "many2one",
  spec,
});

/**
 * Declare an x2many field: `child_ids: One2Many(Contact)` or
 * `One2Many(Contact, { limit: 20 })`. Decodes the nested list to
 * `ReadonlyArray<Contact>`; `limit`, when given, rides the compiled
 * `specification` so the server bounds the co-recordset.
 */
export const One2Many = <A extends HasId, I>(
  spec: RecordSpec<A, I>,
  options?: { readonly limit?: number },
): One2ManyDecl<A, I> => ({ _decl: "one2many", spec, limit: options?.limit });

/**
 * A field of a {@link defineRecord} declaration: a scalar schema or a relation.
 * The relation members are `any`-parameterized because `Schema` (inside the
 * nested child spec) is invariant — a precisely-typed `Many2One(Company)` is not
 * assignable to a widened `Many2OneDecl<HasId, unknown>`. Field-level types are
 * recovered structurally by {@link FieldType}/{@link FieldEncoded} via `infer`.
 */
export type FieldInput =
  | Schema.Schema.Any
  // oxlint-disable-next-line no-explicit-any -- Schema invariance; see above.
  | Many2OneDecl<any, any>
  // oxlint-disable-next-line no-explicit-any -- Schema invariance; see above.
  | One2ManyDecl<any, any>;

/** The decoded (`Type`) value a declared field yields. */
type FieldType<T> = T extends Many2OneDecl<infer A, infer _I>
  ? A | null
  : T extends One2ManyDecl<infer A, infer _I>
    ? ReadonlyArray<A>
    : T extends Schema.Schema<infer A, infer _I, infer _R>
      ? A
      : never;

/** The wire (`Encoded`) value a declared field maps from. */
type FieldEncoded<T> = T extends Many2OneDecl<infer _A, infer I>
  ? I | false
  : T extends One2ManyDecl<infer _A, infer I>
    ? ReadonlyArray<I>
    : T extends Schema.Schema<infer _A, infer I, infer _R>
      ? I
      : never;

/** The decoded row type of a declaration `F` — always carries `id: number`. */
export type RowType<F extends Record<string, FieldInput>> = {
  readonly id: number;
} & { readonly [K in keyof F]: FieldType<F[K]> };

/** The wire row type of a declaration `F`. */
export type RowEncoded<F extends Record<string, FieldInput>> = {
  readonly id: number;
} & { readonly [K in keyof F]: FieldEncoded<F[K]> };

const isRelationDecl = (
  value: FieldInput,
  // oxlint-disable-next-line no-explicit-any -- Schema invariance; see FieldInput.
): value is Many2OneDecl<any, any> | One2ManyDecl<any, any> =>
  typeof value === "object" && value !== null && "_decl" in value;

/**
 * The nullable-many2one nested schema: the child dict, or Odoo's `false` empty
 * → `null`. Strict: a classic `[id, name]` pair (or any non-dict) fails decode,
 * surfacing as {@link SchemaDriftError} at the client boundary rather than being
 * cast past.
 */
// oxlint-disable-next-line no-explicit-any -- Schema invariance; see FieldInput.
const many2oneFieldSchema = (child: RecordSpec<any, any>): Schema.Schema.Any =>
  Schema.transform(
    Schema.Union(child.schema, Schema.Literal(false)),
    Schema.NullOr(Schema.typeSchema(child.schema)),
    {
      strict: true,
      decode: (wire) => (wire === false ? null : wire),
      encode: (value) => (value === null ? (false as const) : value),
    },
  );

/**
 * Build a {@link RecordSpec} from a model name and a field declaration. `id`
 * (`Schema.Number`) is added automatically and always compiled into the
 * `specification`, so every declared record and every relation subtree carries
 * its id — the key downstream joins and re-reads rely on.
 *
 * ```ts
 * const Company = defineRecord("res.company", { name: Schema.String });
 * const Partner = defineRecord("res.partner", {
 *   name: Schema.String,
 *   company_id: Many2One(Company),
 *   child_ids: One2Many(Partner_contact, { limit: 20 }),
 * });
 * ```
 */
export const defineRecord = <F extends Record<string, FieldInput>>(
  model: string,
  fields: F,
): RecordSpec<RowType<F>, RowEncoded<F>> => {
  const structFields: Record<string, Schema.Schema.Any> = { id: Schema.Number };
  const meta: Record<string, FieldMeta> = { id: { kind: "scalar" } };

  for (const [name, decl] of Object.entries(fields)) {
    if (isRelationDecl(decl)) {
      if (decl._decl === "many2one") {
        structFields[name] = many2oneFieldSchema(decl.spec);
        meta[name] = { kind: "many2one", child: decl.spec };
      } else {
        structFields[name] = Schema.Array(decl.spec.schema);
        meta[name] = { kind: "one2many", child: decl.spec, limit: decl.limit };
      }
    } else {
      structFields[name] = decl;
      meta[name] = { kind: "scalar" };
    }
  }

  // The dynamic Struct build cannot preserve the precise mapped type; we recover
  // it via the RowType/RowEncoded projection, which is exactly what the loop
  // constructs field-for-field.
  const schema = Schema.Struct(structFields) as unknown as Schema.Schema<RowType<F>, RowEncoded<F>>;
  const hasRelations = Object.values(meta).some((m) => m.kind !== "scalar");

  return { model, schema, fields: meta, hasRelations };
};

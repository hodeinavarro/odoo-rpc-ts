/**
 * Pure compilation of a declared {@link RecordSpec} into the Odoo `web_read`/
 * `web_search_read` `specification` payload (17+). No I/O: given the field graph,
 * emit `{ field: field_spec }` where a scalar is `{}`, a many2one is
 * `{ fields: <nested> }`, and an x2many is `{ fields: <nested>, limit? }`. The
 * server resolves each relation once over the whole co-recordset, so a compiled
 * spec is exactly ONE batched round trip — no N+1.
 *
 * CYCLES. Eager child specs cannot form an object cycle in a strict language
 * (you cannot reference a `RecordSpec` inside its own `defineRecord` call), so a
 * cyclic declaration is inexpressible by construction and the normal path is
 * total. We still guard defensively by RecordSpec IDENTITY along the ancestor
 * chain — a spec forced into a cycle (via mutation / `any`) would otherwise
 * recurse forever; instead it throws {@link RecordSpecCycleError}, which the
 * client surfaces as a defect (a declaration bug, never a runtime condition). A
 * finite DAG that references the same MODEL through two distinct specs is fine —
 * only a repeated spec object is a cycle.
 */
import type { RecordSpec } from "./recordModel.ts";
import type { HasId } from "./typed.ts";

/** A declared record graph that references itself — a declaration bug, not a
 * runtime fault. Thrown by {@link compileSpecification}; the client turns it into
 * an `Effect` defect. */
export class RecordSpecCycleError extends Error {
  readonly path: ReadonlyArray<string>;
  constructor(path: ReadonlyArray<string>) {
    super(
      `RecordSpec declaration cycle: ${path.join(" -> ")} -> ${path[path.length - 1]}. ` +
        `A relation subtree references a record spec already on its ancestor chain; ` +
        `the specification would be infinite. Declared record graphs must be finite.`,
    );
    this.name = "RecordSpecCycleError";
    this.path = path;
  }
}

/** A declared record with no compilable fields — an empty `specification` would
 * ask the server for nothing. Thrown by {@link compileSpecification}. */
export class EmptyRecordSpecError extends Error {
  readonly model: string;
  constructor(model: string) {
    super(
      `RecordSpec for "${model}" compiles to an empty specification (no fields). ` +
        `A declared record must request at least its id.`,
    );
    this.name = "EmptyRecordSpecError";
    this.model = model;
  }
}

/** `true` iff the spec declares at least one relation field (gate key). */
export const hasRelations = <A extends HasId, I>(spec: RecordSpec<A, I>): boolean =>
  Object.values(spec.fields).some((m) => m.kind !== "scalar");

const compile = (
  // oxlint-disable-next-line no-explicit-any -- Schema is invariant; the compiler
  // walks the erased metadata graph structurally (see FieldMeta).
  spec: RecordSpec<any, any>,
  ancestors: ReadonlyArray<RecordSpec<any, any>>,
): Record<string, unknown> => {
  if (ancestors.includes(spec)) {
    throw new RecordSpecCycleError([...ancestors.map((a) => a.model), spec.model]);
  }
  const nextAncestors = [...ancestors, spec];
  const out: Record<string, unknown> = {};

  for (const [name, meta] of Object.entries(spec.fields)) {
    if (meta.kind === "scalar") {
      out[name] = {};
    } else if (meta.kind === "many2one") {
      out[name] = { fields: compile(meta.child, nextAncestors) };
    } else {
      out[name] = {
        fields: compile(meta.child, nextAncestors),
        ...(meta.limit !== undefined ? { limit: meta.limit } : {}),
      };
    }
  }

  if (Object.keys(out).length === 0) {
    throw new EmptyRecordSpecError(spec.model);
  }
  return out;
};

/**
 * Compile a declared {@link RecordSpec} into its nested `specification` payload.
 * Pure and total for the by-construction-acyclic normal case; throws
 * {@link RecordSpecCycleError} on a forced cycle and {@link EmptyRecordSpecError}
 * on an empty declaration. The client runs it under `Effect.sync`, so either
 * throw becomes a precise defect.
 */
export const compileSpecification = <A extends HasId, I>(
  spec: RecordSpec<A, I>,
): Record<string, unknown> => compile(spec, []);

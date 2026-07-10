/**
 * Pure join helpers for explicit relation traversal (candidate B). No I/O: given
 * already-decoded rows and a field accessor, collect the distinct related ids to
 * fetch, and key decoded related rows by id for O(1) joins. The batched `read`
 * itself lives in {@link ./typed.ts}; everything here is inert data shaping.
 */
import type { Many2OneRefValue } from "./relations.ts";

/** A many2one field's decoded value: a ref, a bare id, or empty. */
export type RefOrId = Many2OneRefValue | number | null | undefined;

/**
 * The related id a {@link RefOrId} points at, or `null` when empty. A ref value
 * carries `.id`; a bare number is itself the id. Anything else is out of
 * contract and yields `null` (the caller's runtime guard rejects true misuse
 * before this is reached — see {@link ./typed.ts}).
 */
export const refId = (ref: RefOrId): number | null => {
  if (ref === null || ref === undefined) {
    return null;
  }
  if (typeof ref === "number") {
    return ref;
  }
  return typeof ref === "object" && typeof ref.id === "number" ? ref.id : null;
};

/**
 * The distinct, non-null related ids reachable through `accessor` across all
 * `rows`, in first-seen order. This is the exact id set a single batched `read`
 * must cover — an empty result means ZERO round trips are needed.
 */
export const collectRefIds = <Row>(
  rows: ReadonlyArray<Row>,
  accessor: (row: Row) => RefOrId,
): ReadonlyArray<number> => {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const row of rows) {
    const id = refId(accessor(row));
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
};

/**
 * A snapshot of decoded related rows keyed by id. Inert: it holds data and never
 * fetches. `get` accepts a many2one ref, a bare id, or `null`/`undefined` and
 * returns the joined row or `null` — a pure lookup, never a round trip.
 */
export interface RelatedMap<A> {
  /** Join a many2one value (ref/id/empty) to its decoded related row, or `null`. */
  readonly get: (ref: RefOrId) => A | null;
  /** The number of distinct related rows held. */
  readonly size: number;
}

/**
 * Build a {@link RelatedMap} from decoded related rows, keyed by each row's
 * `id`. The rows come straight from a single batched `read`, so a duplicate id
 * cannot occur; last-write-wins is a harmless invariant, not a policy.
 */
export const makeRelatedMap = <A extends { readonly id: number }>(
  rows: ReadonlyArray<A>,
): RelatedMap<A> => {
  const byId = new Map<number, A>();
  for (const row of rows) {
    byId.set(row.id, row);
  }
  return {
    get: (ref) => {
      const id = refId(ref);
      return id === null ? null : (byId.get(id) ?? null);
    },
    size: byId.size,
  };
};

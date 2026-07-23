/**
 * Pure unit suite for the spec-tier declared-record specification compiler.
 * No I/O: `compileSpecification` turns a declared field graph into the exact
 * nested `web_read`/`web_search_read` `specification` payload — this is the
 * highest-value test in the layer, since the compiled shape IS the contract with
 * the server. Covers scalars, nested many2one, x2many with/without a limit, the
 * always-present `id`, the empty guard, and cycle detection.
 */
import { assert, describe, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  compileSpecification,
  defineRecord,
  EmptyRecordSpecError,
  hasRelations,
  Many2One,
  One2Many,
  RecordSpecCycleError,
} from "../src/records/index.ts";

const Company = defineRecord("res.company", { name: Schema.String });
const Contact = defineRecord("res.partner", { name: Schema.String });

const Partner = defineRecord("res.partner", {
  name: Schema.String,
  company_id: Many2One(Company),
  child_ids: One2Many(Contact, { limit: 5 }),
});

describe("compileSpecification", () => {
  it("compiles a scalar-only model to bare-`{}` fields incl. the implicit id", () => {
    assert.deepStrictEqual(compileSpecification(Company), { id: {}, name: {} });
  });

  it("compiles a many2one to a nested `{ fields }` subtree", () => {
    const spec = compileSpecification(
      defineRecord("res.partner", { company_id: Many2One(Company) }),
    );
    assert.deepStrictEqual(spec, {
      id: {},
      company_id: { fields: { id: {}, name: {} } },
    });
  });

  it("compiles an x2many with its limit carried into the field spec", () => {
    const spec = compileSpecification(Partner);
    assert.deepStrictEqual(spec, {
      id: {},
      name: {},
      company_id: { fields: { id: {}, name: {} } },
      child_ids: { fields: { id: {}, name: {} }, limit: 5 },
    });
  });

  it("omits the limit key entirely when an x2many declares none", () => {
    const spec = compileSpecification(
      defineRecord("res.partner", { child_ids: One2Many(Contact) }),
    );
    assert.deepStrictEqual(spec, {
      id: {},
      child_ids: { fields: { id: {}, name: {} } },
    });
  });

  it("never expands a relation subtree into all-fields — only declared fields", () => {
    // A relation whose child declares just `name` compiles to id+name, NOT a
    // wildcard. This is the trap-1 guarantee (only requested fields cross the wire).
    const spec = compileSpecification(Partner);
    assert.deepStrictEqual(Object.keys((spec["company_id"] as { fields: object }).fields), [
      "id",
      "name",
    ]);
  });
});

describe("hasRelations", () => {
  it("is false for a scalar-only model, true once a relation is declared", () => {
    assert.isFalse(hasRelations(Company));
    assert.isTrue(hasRelations(Partner));
    // The RecordSpec caches the same answer.
    assert.strictEqual(Company.hasRelations, false);
    assert.strictEqual(Partner.hasRelations, true);
  });
});

describe("guards", () => {
  it("throws EmptyRecordSpecError if a spec somehow has no fields", () => {
    // defineRecord always injects `id`, so an empty declaration is not empty.
    // Force the degenerate case by erasing the fields map (a construction bug).
    const broken = { ...defineRecord("x.empty", {}), fields: {} };
    assert.throws(() => compileSpecification(broken), EmptyRecordSpecError);
  });

  it("detects a forced declaration cycle by spec identity and throws", () => {
    // Eager child specs cannot form a cycle by construction; force one via
    // mutation to prove the ancestor-chain guard fires instead of recursing.
    const node = defineRecord("x.node", { name: Schema.String });
    (node.fields as Record<string, unknown>)["parent_id"] = { kind: "many2one", child: node };
    assert.throws(() => compileSpecification(node), RecordSpecCycleError);
  });

  it("a repeated MODEL through two distinct finite specs is NOT a cycle", () => {
    // res.partner appears at the root and as the x2many child; distinct spec
    // objects, finite depth → compiles cleanly (only a repeated spec OBJECT loops).
    assert.doesNotThrow(() => compileSpecification(Partner));
  });
});

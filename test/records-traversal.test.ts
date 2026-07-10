import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Ref, Schema } from "effect";
import { layer as clientLayer, OdooClient } from "../src/client.ts";
import { SchemaDriftError } from "../src/errors/schema.ts";
import { Many2OneRefOrNull } from "../src/records/index.ts";
import { layer as rpcLayer } from "../src/rpc.ts";
import type { CallKwParams } from "../src/transport.ts";
import * as FakeTransport from "../src/testing/fakeTransport.ts";

// v4 Cause is a flat failure list; recover the single typed error the way the
// v3 `cause._tag === "Fail" ? cause.error` narrow did.
const firstError = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  exit._tag === "Failure"
    ? exit.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error] : []))[0]
    : undefined;


const Partner = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  company_id: Many2OneRefOrNull,
});
type Partner = typeof Partner.Type;

const Company = Schema.Struct({ id: Schema.Number, name: Schema.String });

// Two partners sharing company 100, one with an empty company → distinct ids {100}.
const PARTNER_ROWS = [
  { id: 1, name: "Alice", company_id: [100, "ACME"] },
  { id: 2, name: "Bob", company_id: [100, "ACME"] },
  { id: 3, name: "Carol", company_id: false },
];

const COMPANY_NAMES: Record<number, string> = { 100: "ACME", 200: "Globex" };

const companyRead: FakeTransport.FakeHandler = (params) =>
  (params.ids ?? []).map((id) => ({ id, name: COMPANY_NAMES[id] ?? `Company ${id}` }));

const baseHandlers = (searchRows: ReadonlyArray<unknown>): FakeTransport.FakeHandlers => ({
  "res.partner": { search_read: () => searchRows },
  "res.company": { read: companyRead },
});

const runWithLog = <A, E>(
  handlers: FakeTransport.FakeHandlers,
  build: (client: typeof OdooClient.Service) => Effect.Effect<A, E>,
): Effect.Effect<{ value: A; log: ReadonlyArray<CallKwParams> }, E> =>
  Effect.gen(function* () {
    const fake = FakeTransport.make(handlers);
    const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
    const value = yield* Effect.provide(
      OdooClient.pipe(Effect.flatMap(build)),
      layer,
    );
    const log = yield* Ref.get(fake.callLog);
    return { value, log };
  });

const readCalls = (log: ReadonlyArray<CallKwParams>) =>
  log.filter((c) => c.model === "res.company" && c.method === "read");

describe("TypedRecordSet snapshot", () => {
  it.effect("searchRecordsTyped decodes rows and exposes ids/length/iteration", () =>
    Effect.gen(function* () {
      const { value: rs, log } = yield* runWithLog(baseHandlers(PARTNER_ROWS), (c) =>
        c.searchRecordsTyped("res.partner", {}, Partner),
      );
      assert.strictEqual(rs.model, "res.partner");
      assert.strictEqual(rs.length, 3);
      assert.deepStrictEqual(rs.ids, [1, 2, 3]);
      assert.deepStrictEqual(
        [...rs].map((p) => p.name),
        ["Alice", "Bob", "Carol"],
      );
      // The m2o pair decoded to a ref value; the label is present with no fetch.
      assert.deepStrictEqual(rs.rows[0]?.company_id, { id: 100, name: "ACME" });
      assert.strictEqual(rs.rows[2]?.company_id, null);
      // Only the search_read round trip so far.
      assert.strictEqual(readCalls(log).length, 0);
    }),
  );
});

describe("fetchRelated — exactly one batched read", () => {
  it.effect("issues ONE read over the DISTINCT non-null ids", () =>
    Effect.gen(function* () {
      const { value, log } = yield* runWithLog(baseHandlers(PARTNER_ROWS), (c) =>
        c.searchRecordsTyped("res.partner", {}, Partner).pipe(
          Effect.flatMap((rs) => rs.fetchRelated("company_id", "res.company", Company, ["name"])),
        ),
      );
      const reads = readCalls(log);
      assert.strictEqual(reads.length, 1);
      // Deduped: company 100 referenced twice → a single id in the read.
      assert.deepStrictEqual(reads[0]?.ids, [100]);
      assert.deepStrictEqual(reads[0]?.kwargs["fields"], ["name"]);
      // The RelatedMap joins refs, ids, and null uniformly.
      assert.strictEqual(value.size, 1);
      assert.deepStrictEqual(value.get({ id: 100, name: "ACME" }), { id: 100, name: "ACME" });
      assert.deepStrictEqual(value.get(100), { id: 100, name: "ACME" });
      assert.strictEqual(value.get(null), null);
      assert.strictEqual(value.get(999), null);
    }),
  );

  it.effect("makes ZERO reads when every reference is empty", () =>
    Effect.gen(function* () {
      const allEmpty = [
        { id: 1, name: "Alice", company_id: false },
        { id: 2, name: "Bob", company_id: false },
      ];
      const { value, log } = yield* runWithLog(baseHandlers(allEmpty), (c) =>
        c.searchRecordsTyped("res.partner", {}, Partner).pipe(
          Effect.flatMap((rs) => rs.fetchRelated("company_id", "res.company", Company)),
        ),
      );
      assert.strictEqual(readCalls(log).length, 0);
      assert.strictEqual(value.size, 0);
    }),
  );

  it.effect("omits the fields kwarg entirely when none are given", () =>
    Effect.gen(function* () {
      const { log } = yield* runWithLog(baseHandlers(PARTNER_ROWS), (c) =>
        c.searchRecordsTyped("res.partner", {}, Partner).pipe(
          Effect.flatMap((rs) => rs.fetchRelated("company_id", "res.company", Company)),
        ),
      );
      const reads = readCalls(log);
      assert.strictEqual(reads.length, 1);
      assert.strictEqual("fields" in (reads[0]?.kwargs ?? {}), false);
    }),
  );
});

describe("joinRelated — paired rows, one call", () => {
  it.effect("returns (row, related | null) pairs including the empty case", () =>
    Effect.gen(function* () {
      const { value: pairs, log } = yield* runWithLog(baseHandlers(PARTNER_ROWS), (c) =>
        c.searchRecordsTyped("res.partner", {}, Partner).pipe(
          Effect.flatMap((rs) => rs.joinRelated("company_id", "res.company", Company, ["name"])),
        ),
      );
      assert.strictEqual(readCalls(log).length, 1);
      assert.strictEqual(pairs.length, 3);
      assert.strictEqual(pairs[0]?.[0].name, "Alice");
      assert.deepStrictEqual(pairs[0]?.[1], { id: 100, name: "ACME" });
      assert.deepStrictEqual(pairs[1]?.[1], { id: 100, name: "ACME" });
      // Carol's company_id was false → no join.
      assert.strictEqual(pairs[2]?.[1], null);
    }),
  );
});

describe("drift & misuse", () => {
  it.effect("a related read that fails the schema surfaces as SchemaDriftError", () =>
    Effect.gen(function* () {
      const handlers: FakeTransport.FakeHandlers = {
        "res.partner": { search_read: () => PARTNER_ROWS },
        // name is a number → fails the Company schema.
        "res.company": { read: (p) => (p.ids ?? []).map((id) => ({ id, name: 42 })) },
      };
      const fake = FakeTransport.make(handlers);
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      const exit = yield* OdooClient.pipe(
        Effect.flatMap((c) =>
          c
            .searchRecordsTyped("res.partner", {}, Partner)
            .pipe(Effect.flatMap((rs) => rs.fetchRelated("company_id", "res.company", Company))),
        ),
        Effect.provide(layer),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
      const err = firstError(exit);
      if (err !== undefined) {
        const error = err;
        assert.isTrue(error instanceof SchemaDriftError);
        if (error instanceof SchemaDriftError) {
          assert.strictEqual(error.context, "res.company.read");
        }
      }
    }),
  );

  it.effect("dynamic misuse (a non-ref field value) dies with a precise message", () =>
    Effect.gen(function* () {
      // A row schema that (wrongly) types company_id as a string sneaks a
      // non-ref value past the compile-time guard; traversal must die loudly.
      const BadPartner = Schema.Struct({
        id: Schema.Number,
        name: Schema.String,
        company_id: Schema.Union([Schema.String, Schema.Literal(false)]),
      });
      const rows = [{ id: 1, name: "Alice", company_id: "not-a-ref" }];
      const fake = FakeTransport.make({
        "res.partner": { search_read: () => rows },
        "res.company": { read: companyRead },
      });
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      const exit = yield* OdooClient.pipe(
        Effect.flatMap((c) =>
          c.searchRecordsTyped("res.partner", {}, BadPartner).pipe(
            Effect.flatMap((rs) =>
              // @ts-expect-error company_id is not a Many2OneRefField here
              rs.fetchRelated("company_id", "res.company", Company),
            ),
          ),
        ),
        Effect.provide(layer),
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const defect = exit.cause.reasons.flatMap((r) => (r._tag === "Die" ? [r.defect] : []))[0];
        assert.include(String(defect), "is not a ");
      }
    }),
  );

  it("compile-time guard: a scalar field is not a Many2OneRefField", () => {
    const build = (rs: import("../src/records/index.ts").TypedRecordSet<Partner>) =>
      // @ts-expect-error "name" is a string field, not a many2one reference
      rs.fetchRelated("name", "res.company", Company);
    void build;
    assert.isTrue(true);
  });
});

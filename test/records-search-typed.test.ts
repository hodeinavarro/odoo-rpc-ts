/**
 * FakeTransport suite for spec-tier typed reads (declared prefetch, 17+
 * `specification` protocol). Asserts
 * the whole contract WITHOUT a network: exactly ONE `web_search_read` per
 * `searchTyped`, the exact compiled `specification` kwargs, nested decode
 * (many2one dict, `false` → null, empty x2many), drift when a classic `[id,name]`
 * pair leaks under a spec, the version gate in all three modes (resolver present
 * 16/18, resolver absent + explicit `serverMajor`), the relation-free degrade to
 * `search_read`, and the `web_read`/`web_save` call shapes.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Ref, Schema } from "effect";
import { layer as clientLayer, OdooClient } from "../src/client.ts";
import { SchemaDriftError } from "../src/errors/schema.ts";
import { defineRecord, Many2One, One2Many } from "../src/records/index.ts";
import { layer as rpcLayer } from "../src/rpc.ts";
import type { CallKwParams } from "../src/transport.ts";
import * as FakeTransport from "../src/testing/fakeTransport.ts";
import { deriveCapabilities, parseVersionInfo, VersionResolver } from "../src/version.ts";

const Company = defineRecord("res.company", { name: Schema.String });
const Contact = defineRecord("res.partner.child", { name: Schema.String });
const Partner = defineRecord("res.partner", {
  name: Schema.String,
  company_id: Many2One(Company),
  child_ids: One2Many(Contact, { limit: 5 }),
});
const FlatPartner = defineRecord("res.partner", { name: Schema.String, email: Schema.String });

const PARTNER_RECORDS = [
  { id: 1, name: "Alice", company_id: { id: 100, name: "ACME" }, child_ids: [{ id: 9, name: "Kid" }] },
  { id: 2, name: "Bob", company_id: false, child_ids: [] },
];

/** A fake VersionResolver pinned to a given major, or `undefined` for none. */
const resolverLayer = (major: number): Layer.Layer<VersionResolver> => {
  const version = parseVersionInfo([major, 0, 0, "final", 0]);
  return Layer.succeed(VersionResolver, {
    resolve: Effect.succeed({ version, capabilities: deriveCapabilities(version) }),
  });
};

const runWithLog = <A, E>(
  handlers: FakeTransport.FakeHandlers,
  build: (client: OdooClient["Type"]) => Effect.Effect<A, E>,
  resolver?: Layer.Layer<VersionResolver>,
): Effect.Effect<{ value: A; log: ReadonlyArray<CallKwParams> }, E> =>
  Effect.gen(function* () {
    const fake = FakeTransport.make(handlers);
    const clientStack = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
    const full = resolver === undefined ? clientStack : Layer.merge(clientStack, resolver);
    const value = yield* Effect.provide(OdooClient.pipe(Effect.flatMap(build)), full);
    const log = yield* Ref.get(fake.callLog);
    return { value, log };
  });

const method = (log: ReadonlyArray<CallKwParams>, m: string) => log.filter((c) => c.method === m);

describe("searchTyped — one web_search_read, exact spec, nested decode", () => {
  it.effect("issues ONE web_search_read with the compiled specification kwargs", () =>
    Effect.gen(function* () {
      const { value, log } = yield* runWithLog(
        { "res.partner": { web_search_read: () => ({ length: 2, records: PARTNER_RECORDS }) } },
        (c) => c.searchTyped(Partner, { domain: [["is_company", "=", false]], limit: 10 }),
      );
      const calls = method(log, "web_search_read");
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0]?.kwargs["specification"], {
        id: {},
        name: {},
        company_id: { fields: { id: {}, name: {} } },
        child_ids: { fields: { id: {}, name: {} }, limit: 5 },
      });
      assert.deepStrictEqual(calls[0]?.kwargs["domain"], [["is_company", "=", false]]);
      assert.strictEqual(calls[0]?.kwargs["limit"], 10);

      // Unwrapped {length, records} and decoded the nested graph.
      assert.strictEqual(value.length, 2);
      assert.deepStrictEqual(value[0]?.company_id, { id: 100, name: "ACME" });
      assert.deepStrictEqual(value[0]?.child_ids, [{ id: 9, name: "Kid" }]);
      // many2one false → null, empty x2many → [].
      assert.strictEqual(value[1]?.company_id, null);
      assert.deepStrictEqual(value[1]?.child_ids, []);
    }),
  );

  it.effect("rejects a classic [id,name] pair leaking under a spec as drift", () =>
    Effect.gen(function* () {
      const leaky = [{ id: 1, name: "Alice", company_id: [100, "ACME"], child_ids: [] }];
      const exit = yield* runWithLog(
        { "res.partner": { web_search_read: () => ({ length: 1, records: leaky }) } },
        (c) => c.searchTyped(Partner),
      ).pipe(Effect.map((r) => r.value), Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        assert.isTrue(exit.cause.error instanceof SchemaDriftError);
        if (exit.cause.error instanceof SchemaDriftError) {
          assert.strictEqual(exit.cause.error.context, "res.partner.web_search_read");
        }
      }
    }),
  );
});

describe("version gate", () => {
  it.effect("resolver present @16 + relations → ProtocolUnsupportedError BEFORE any RPC", () =>
    Effect.gen(function* () {
      const { value: exit, log } = yield* runWithLog(
        { "res.partner": { web_search_read: () => ({ length: 0, records: [] }) } },
        (c) => c.searchTyped(Partner).pipe(Effect.exit),
        resolverLayer(16),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "ProtocolUnsupportedError");
      }
      // No round trip happened — the gate fired first.
      assert.strictEqual(method(log, "web_search_read").length, 0);
    }),
  );

  it.effect("resolver present @18 → spec path (web_search_read)", () =>
    Effect.gen(function* () {
      const { value, log } = yield* runWithLog(
        { "res.partner": { web_search_read: () => ({ length: 2, records: PARTNER_RECORDS }) } },
        (c) => c.searchTyped(Partner),
        resolverLayer(18),
      );
      assert.strictEqual(method(log, "web_search_read").length, 1);
      assert.strictEqual(value.length, 2);
    }),
  );

  it.effect("no resolver → default spec path (17+ assumed)", () =>
    Effect.gen(function* () {
      const { log } = yield* runWithLog(
        { "res.partner": { web_search_read: () => ({ length: 0, records: [] }) } },
        (c) => c.searchTyped(Partner),
      );
      assert.strictEqual(method(log, "web_search_read").length, 1);
    }),
  );

  it.effect("no resolver + explicit serverMajor=16 + relations → unsupported before RPC", () =>
    Effect.gen(function* () {
      const { value: exit, log } = yield* runWithLog(
        { "res.partner": { web_search_read: () => ({ length: 0, records: [] }) } },
        (c) => c.searchTyped(Partner, { serverMajor: 16 }).pipe(Effect.exit),
      );
      assert.isTrue(Exit.isFailure(exit));
      assert.strictEqual(method(log, "web_search_read").length, 0);
    }),
  );

  it.effect("relation-free @16 degrades to search_read over the declared fields", () =>
    Effect.gen(function* () {
      const { value, log } = yield* runWithLog(
        { "res.partner": { search_read: () => [{ id: 1, name: "Alice", email: "a@x.io" }] } },
        (c) => c.searchTyped(FlatPartner, { serverMajor: 16 }),
      );
      // Degraded — no web_search_read; a plain search_read over id+name+email.
      assert.strictEqual(method(log, "web_search_read").length, 0);
      const sr = method(log, "search_read");
      assert.strictEqual(sr.length, 1);
      assert.deepStrictEqual(sr[0]?.kwargs["fields"], ["id", "name", "email"]);
      assert.deepStrictEqual(value[0], { id: 1, name: "Alice", email: "a@x.io" });
    }),
  );
});

describe("readTyped & saveTyped call shapes", () => {
  it.effect("readTyped issues web_read with the spec and ids on the seam", () =>
    Effect.gen(function* () {
      const { value, log } = yield* runWithLog(
        { "res.partner": { web_read: () => PARTNER_RECORDS } },
        (c) => c.readTyped(Partner, [1, 2]),
      );
      const calls = method(log, "web_read");
      assert.strictEqual(calls.length, 1);
      assert.deepStrictEqual(calls[0]?.ids, [1, 2]);
      assert.property(calls[0]?.kwargs ?? {}, "specification");
      assert.strictEqual(value.length, 2);
    }),
  );

  it.effect("saveTyped writes via web_save (vals positional) and returns the fresh snapshot", () =>
    Effect.gen(function* () {
      const { value, log } = yield* runWithLog(
        { "res.partner": { web_save: () => [PARTNER_RECORDS[0]] } },
        (c) => c.saveTyped(Partner, [1], { name: "Alice II" }),
      );
      const calls = method(log, "web_save");
      assert.strictEqual(calls.length, 1);
      // execute-kw dialect: vals is args[0], specification is a kwarg.
      assert.deepStrictEqual(calls[0]?.args[0], { name: "Alice II" });
      assert.property(calls[0]?.kwargs ?? {}, "specification");
      assert.deepStrictEqual(calls[0]?.ids, [1]);
      assert.strictEqual(value.length, 1);
      assert.deepStrictEqual(value[0]?.company_id, { id: 100, name: "ACME" });
    }),
  );

  it.effect("saveTyped is 17+ ONLY — a relation-free spec still fails on 16", () =>
    Effect.gen(function* () {
      const { value: exit, log } = yield* runWithLog(
        { "res.partner": { web_save: () => [] } },
        (c) => c.saveTyped(FlatPartner, [1], { name: "x" }, { serverMajor: 16 }).pipe(Effect.exit),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        assert.strictEqual(exit.cause.error._tag, "ProtocolUnsupportedError");
      }
      assert.strictEqual(method(log, "web_save").length, 0);
    }),
  );
});

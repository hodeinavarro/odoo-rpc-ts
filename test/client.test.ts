import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Ref, Schema } from "effect";
import { layer as clientLayer, OdooClient } from "../src/client.ts";
import { SchemaDriftError } from "../src/errors/schema.ts";
import { layer as rpcLayer } from "../src/rpc.ts";
import * as FakeTransport from "../src/testing/fakeTransport.ts";

const handlers: FakeTransport.FakeHandlers = {
  "res.partner": {
    search_read: () => [{ id: 1, name: "Alice" }],
    search: () => [1, 2, 3],
    read: () => [{ id: 1, name: "Alice" }],
    create: (params) =>
      // Accept both dialect encodings: positional args[0] (execute-kw) or
      // kwargs.vals_list (json2).
      ((params.args[0] ?? params.kwargs["vals_list"]) as ReadonlyArray<unknown>).map(
        (_, i) => 10 + i,
      ),
    write: () => true,
    unlink: () => true,
    fields_get: () => ({ name: { type: "char", string: "Name" } }),
    search_count: () => 5,
  },
};

const run = <A, E>(effect: Effect.Effect<A, E, OdooClient>): Effect.Effect<A, E> => {
  const fake = FakeTransport.make(handlers);
  const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
  return Effect.provide(effect, layer);
};

const withLog = <A, E>(
  build: (fake: FakeTransport.FakeTransport) => Effect.Effect<A, E, OdooClient>,
) =>
  Effect.gen(function* () {
    const fake = FakeTransport.make(handlers);
    const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
    const value = yield* Effect.provide(build(fake), layer);
    const log = yield* Ref.get(fake.callLog);
    return { value, log };
  });

describe("OdooClient ops", () => {
  it.effect("searchRead decodes rows (default unknown record)", () =>
    Effect.gen(function* () {
      const rows = yield* run(OdooClient.pipe(Effect.flatMap((c) => c.searchRead("res.partner"))));
      assert.deepStrictEqual(rows, [{ id: 1, name: "Alice" }]);
    }),
  );

  it.effect("searchRead decodes rows through a caller schema", () =>
    Effect.gen(function* () {
      const Partner = Schema.Struct({ id: Schema.Number, name: Schema.String });
      const rows = yield* run(
        OdooClient.pipe(Effect.flatMap((c) => c.searchRead("res.partner", {}, Partner))),
      );
      assert.strictEqual(rows[0]?.name, "Alice");
    }),
  );

  it.effect("searchRead normalizes the domain into search_read kwargs", () =>
    Effect.gen(function* () {
      const { log } = yield* withLog((_) =>
        OdooClient.pipe(
          Effect.flatMap((c) =>
            c.searchRead("res.partner", {
              domain: [
                ["is_company", "=", true],
                ["active", "=", true],
              ],
              fields: ["name"],
              limit: 10,
            }),
          ),
        ),
      );
      assert.strictEqual(log[0]?.method, "search_read");
      assert.deepStrictEqual(log[0]?.kwargs["domain"], [
        "&",
        ["is_company", "=", true],
        ["active", "=", true],
      ]);
      assert.deepStrictEqual(log[0]?.kwargs["fields"], ["name"]);
      assert.strictEqual(log[0]?.kwargs["limit"], 10);
    }),
  );

  it.effect("search returns ids", () =>
    Effect.gen(function* () {
      const ids = yield* run(OdooClient.pipe(Effect.flatMap((c) => c.search("res.partner"))));
      assert.deepStrictEqual(ids, [1, 2, 3]);
    }),
  );

  it.effect("read returns records", () =>
    Effect.gen(function* () {
      const recs = yield* run(
        OdooClient.pipe(Effect.flatMap((c) => c.read("res.partner", [1], ["name"]))),
      );
      assert.deepStrictEqual(recs, [{ id: 1, name: "Alice" }]);
    }),
  );

  it.effect("create normalizes a single dict to a one-element vals_list and returns [id]", () =>
    Effect.gen(function* () {
      const { value, log } = yield* withLog((_) =>
        OdooClient.pipe(Effect.flatMap((c) => c.create("res.partner", { name: "New" }))),
      );
      assert.deepStrictEqual(value, [10]);
      // execute-kw dialect: vals travel positionally (call_kw reads args[0]),
      // normalized to a list even for one dict.
      assert.deepStrictEqual(log[0]?.args, [[{ name: "New" }]]);
      assert.strictEqual(log[0]?.ids, undefined);
      assert.strictEqual(log[0]?.kwargs["vals_list"], undefined);
    }),
  );

  it.effect("create uses the vals_list kwarg on a json2-dialect transport", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make(handlers, { dialect: "json2" });
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      const value = yield* Effect.provide(
        OdooClient.pipe(Effect.flatMap((c) => c.create("res.partner", { name: "New" }))),
        layer,
      );
      const log = yield* Ref.get(fake.callLog);
      assert.deepStrictEqual(value, [10]);
      assert.deepStrictEqual(log[0]?.args, []);
      assert.deepStrictEqual(log[0]?.kwargs["vals_list"], [{ name: "New" }]);
    }),
  );

  it.effect("create returns an id array for a list of dicts", () =>
    Effect.gen(function* () {
      const { value, log } = yield* withLog((_) =>
        OdooClient.pipe(
          Effect.flatMap((c) => c.create("res.partner", [{ name: "A" }, { name: "B" }])),
        ),
      );
      assert.deepStrictEqual(value, [10, 11]);
      assert.deepStrictEqual(log[0]?.args, [[{ name: "A" }, { name: "B" }]]);
    }),
  );

  it.effect("write returns true", () =>
    Effect.gen(function* () {
      const ok = yield* run(
        OdooClient.pipe(Effect.flatMap((c) => c.write("res.partner", [1], { name: "X" }))),
      );
      assert.strictEqual(ok, true);
    }),
  );

  it.effect("unlink returns true", () =>
    Effect.gen(function* () {
      const ok = yield* run(OdooClient.pipe(Effect.flatMap((c) => c.unlink("res.partner", [1]))));
      assert.strictEqual(ok, true);
    }),
  );

  it.effect("fieldsGet returns metadata keyed by field name", () =>
    Effect.gen(function* () {
      const meta = yield* run(
        OdooClient.pipe(
          Effect.flatMap((c) => c.fieldsGet("res.partner", { attributes: ["type"] })),
        ),
      );
      assert.deepStrictEqual(meta["name"], { type: "char", string: "Name" });
    }),
  );

  it.effect("searchCount returns a number and normalizes the domain", () =>
    Effect.gen(function* () {
      const { value, log } = yield* withLog((_) =>
        OdooClient.pipe(
          Effect.flatMap((c) =>
            c.searchCount("res.partner", [
              ["is_company", "=", true],
              ["active", "=", true],
            ]),
          ),
        ),
      );
      assert.strictEqual(value, 5);
      // Protocol-agnostic: domain rides in kwargs, no positional args.
      assert.deepStrictEqual(log[0]?.args, []);
      assert.deepStrictEqual(log[0]?.kwargs["domain"], [
        "&",
        ["is_company", "=", true],
        ["active", "=", true],
      ]);
    }),
  );

  it.effect("read targets ids on the seam with fields in kwargs (no positional args)", () =>
    Effect.gen(function* () {
      const { log } = yield* withLog((_) =>
        OdooClient.pipe(Effect.flatMap((c) => c.read("res.partner", [1, 2], ["name"]))),
      );
      assert.strictEqual(log[0]?.method, "read");
      assert.deepStrictEqual(log[0]?.args, []);
      assert.deepStrictEqual(log[0]?.ids, [1, 2]);
      assert.deepStrictEqual(log[0]?.kwargs["fields"], ["name"]);
    }),
  );

  it.effect("write targets ids on the seam with vals in kwargs", () =>
    Effect.gen(function* () {
      const { log } = yield* withLog((_) =>
        OdooClient.pipe(Effect.flatMap((c) => c.write("res.partner", [1], { name: "X" }))),
      );
      assert.strictEqual(log[0]?.method, "write");
      assert.deepStrictEqual(log[0]?.args, []);
      assert.deepStrictEqual(log[0]?.ids, [1]);
      assert.deepStrictEqual(log[0]?.kwargs["vals"], { name: "X" });
    }),
  );

  it.effect("unlink targets ids on the seam with no other arguments", () =>
    Effect.gen(function* () {
      const { log } = yield* withLog((_) =>
        OdooClient.pipe(Effect.flatMap((c) => c.unlink("res.partner", [3]))),
      );
      assert.strictEqual(log[0]?.method, "unlink");
      assert.deepStrictEqual(log[0]?.args, []);
      assert.deepStrictEqual(log[0]?.ids, [3]);
    }),
  );

  it.effect("drift: a row that fails the caller schema fails with SchemaDriftError", () =>
    Effect.gen(function* () {
      const Partner = Schema.Struct({ id: Schema.Number, name: Schema.String });
      const driftHandlers: FakeTransport.FakeHandlers = {
        "res.partner": { search_read: () => [{ id: "not-a-number" }] },
      };
      const fake = FakeTransport.make(driftHandlers);
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));

      const exit = yield* OdooClient.pipe(
        Effect.flatMap((c) => c.searchRead("res.partner", {}, Partner)),
        Effect.provide(layer),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error;
        assert.isTrue(error instanceof SchemaDriftError);
        if (error instanceof SchemaDriftError) {
          assert.strictEqual(error.context, "res.partner.search_read");
          assert.deepStrictEqual(error.payload, [{ id: "not-a-number" }]);
        }
      }
    }),
  );
});

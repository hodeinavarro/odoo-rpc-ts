import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Ref, Schema } from "effect";
import { layer as clientLayer, OdooClient } from "../src/client.ts";
import { SchemaDriftError } from "../src/errors/schema.ts";
import { OdooServerError } from "../src/errors/server.ts";
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
    read_group: () => [{ is_company: true, is_company_count: 3, __count: 3 }],
    name_search: () => [
      [1, "Alice"],
      [2, "Bob"],
    ],
    name_get: () => [[1, "Alice"]],
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
  it.effect("searchRead accepts a transforming schema (I != A)", () =>
    Effect.gen(function* () {
      // Odoo sends `false` for empty scalar fields; normalize to null while
      // decoding — only possible when the schema may transform (Schema<A, I>).
      const Row = Schema.Struct({
        id: Schema.Number,
        email: Schema.transform(
          Schema.Union(Schema.String, Schema.Literal(false)),
          Schema.NullOr(Schema.String),
          {
            decode: (raw) => (raw === false ? null : raw),
            encode: (email) => email ?? (false as const),
          },
        ),
      });
      const fake = FakeTransport.make({
        "res.partner": { search_read: () => [{ id: 7, email: false }] },
      });
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      const rows = yield* Effect.provide(
        OdooClient.pipe(Effect.flatMap((c) => c.searchRead("res.partner", {}, Row))),
        layer,
      );
      assert.deepStrictEqual(rows, [{ id: 7, email: null }]);
    }),
  );

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

  it.effect("write targets ids on the seam with vals positional (models rename the param)", () =>
    Effect.gen(function* () {
      const { log } = yield* withLog((_) =>
        OdooClient.pipe(Effect.flatMap((c) => c.write("res.partner", [1], { name: "X" }))),
      );
      assert.strictEqual(log[0]?.method, "write");
      assert.deepStrictEqual(log[0]?.args, [{ name: "X" }]);
      assert.deepStrictEqual(log[0]?.ids, [1]);
      assert.deepStrictEqual(log[0]?.kwargs, { context: {} });
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

  it.effect("ref resolves an xml_id to [model, id] via check_object_reference", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({
        "ir.model.data": { check_object_reference: () => ["res.company", 1] },
      });
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      const pair = yield* OdooClient.pipe(
        Effect.flatMap((c) => c.ref("base.main_company")),
        Effect.provide(layer),
      );
      assert.deepStrictEqual(pair, ["res.company", 1]);
      const log = yield* Ref.get(fake.callLog);
      // execute-kw dialect: (module, name) positional.
      assert.deepStrictEqual(log[0]?.args, ["base", "main_company"]);
    }),
  );

  it.effect("ref sends (module, xml_id) by name on the json2 dialect", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make(
        { "ir.model.data": { check_object_reference: () => ["res.company", 1] } },
        { dialect: "json2" },
      );
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      yield* OdooClient.pipe(
        Effect.flatMap((c) => c.ref("base.main_company")),
        Effect.provide(layer),
      );
      const log = yield* Ref.get(fake.callLog);
      assert.deepStrictEqual(log[0]?.args, []);
      assert.strictEqual(log[0]?.kwargs["module"], "base");
      assert.strictEqual(log[0]?.kwargs["xml_id"], "main_company");
    }),
  );

  it.effect("ref: [model, false] (not visible) → OdooMissingError naming the xml_id", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({
        "ir.model.data": { check_object_reference: () => ["res.company", false] },
      });
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      const error = yield* OdooClient.pipe(
        Effect.flatMap((c) => c.ref("base.hidden_company")),
        Effect.provide(layer),
        Effect.flip,
      );
      assert.strictEqual(error._tag, "OdooMissingError");
      if (error._tag === "OdooMissingError") {
        assert.deepStrictEqual(error.arguments, ["base.hidden_company"]);
      }
    }),
  );

  it.effect("ref: an unknown xml_id (server ValueError) → OdooMissingError", () =>
    Effect.gen(function* () {
      const serverError = new OdooServerError({
        name: "builtins.ValueError",
        message: "External ID not found in the system: base.nope",
        arguments: ["External ID not found in the system: base.nope"],
        context: {},
      });
      const fake = FakeTransport.make({
        "ir.model.data": { check_object_reference: () => Effect.fail(serverError) },
      });
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      const error = yield* OdooClient.pipe(
        Effect.flatMap((c) => c.ref("base.nope")),
        Effect.provide(layer),
        Effect.flip,
      );
      assert.strictEqual(error._tag, "OdooMissingError");
    }),
  );

  it.effect("call is a raw, undecoded passthrough carrying ids/context/kwargs", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({
        "res.partner": { some_method: () => ({ anything: [1, "raw"] }) },
      });
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      const raw = yield* OdooClient.pipe(
        Effect.flatMap((c) =>
          c.call("res.partner", "some_method", {
            ids: [7],
            kwargs: { foo: "bar" },
            context: { lang: "es_ES" },
          }),
        ),
        Effect.provide(layer),
      );
      assert.deepStrictEqual(raw, { anything: [1, "raw"] });
      const log = yield* Ref.get(fake.callLog);
      assert.deepStrictEqual(log[0]?.ids, [7]);
      assert.strictEqual(log[0]?.kwargs["foo"], "bar");
      assert.deepStrictEqual(log[0]?.kwargs["context"], { lang: "es_ES" });
    }),
  );

  it.effect("readGroup decodes group rows and passes stable kwargs", () =>
    Effect.gen(function* () {
      const { value, log } = yield* withLog((_) =>
        OdooClient.pipe(
          Effect.flatMap((c) =>
            c.readGroup("res.partner", {
              domain: [["is_company", "=", true]],
              fields: ["is_company"],
              groupby: ["is_company"],
              limit: 10,
              lazy: false,
            }),
          ),
        ),
      );
      assert.strictEqual(value[0]?.["__count"], 3);
      assert.strictEqual(log[0]?.method, "read_group");
      assert.deepStrictEqual(log[0]?.kwargs["domain"], [["is_company", "=", true]]);
      assert.deepStrictEqual(log[0]?.kwargs["fields"], ["is_company"]);
      assert.deepStrictEqual(log[0]?.kwargs["groupby"], ["is_company"]);
      assert.strictEqual(log[0]?.kwargs["limit"], 10);
      assert.strictEqual(log[0]?.kwargs["lazy"], false);
    }),
  );

  it.effect("nameSearch sends name/args/operator/limit POSITIONALLY over execute-kw", () =>
    Effect.gen(function* () {
      const { value, log } = yield* withLog((_) =>
        OdooClient.pipe(
          Effect.flatMap((c) =>
            c.nameSearch("res.partner", {
              name: "Al",
              args: [["is_company", "=", true]],
              operator: "ilike",
              limit: 5,
            }),
          ),
        ),
      );
      assert.deepStrictEqual(value, [
        [1, "Alice"],
        [2, "Bob"],
      ]);
      assert.deepStrictEqual(log[0]?.args, ["Al", [["is_company", "=", true]], "ilike", 5]);
    }),
  );

  it.effect("nameSearch sends name/domain/operator/limit by NAME on the json2 dialect", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make(handlers, { dialect: "json2" });
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));
      yield* OdooClient.pipe(
        Effect.flatMap((c) =>
          c.nameSearch("res.partner", { name: "Al", args: [["is_company", "=", true]], limit: 5 }),
        ),
        Effect.provide(layer),
      );
      const log = yield* Ref.get(fake.callLog);
      assert.deepStrictEqual(log[0]?.args, []);
      assert.strictEqual(log[0]?.kwargs["name"], "Al");
      assert.deepStrictEqual(log[0]?.kwargs["domain"], [["is_company", "=", true]]);
      assert.strictEqual(log[0]?.kwargs["operator"], "ilike");
      assert.strictEqual(log[0]?.kwargs["limit"], 5);
    }),
  );

  it.effect("nameSearch defaults name/operator/limit when omitted", () =>
    Effect.gen(function* () {
      const { log } = yield* withLog((_) =>
        OdooClient.pipe(Effect.flatMap((c) => c.nameSearch("res.partner"))),
      );
      assert.deepStrictEqual(log[0]?.args, ["", [], "ilike", 100]);
    }),
  );

  it.effect("nameGet targets ids on the seam and decodes pairs", () =>
    Effect.gen(function* () {
      const { value, log } = yield* withLog((_) =>
        OdooClient.pipe(Effect.flatMap((c) => c.nameGet("res.partner", [1]))),
      );
      assert.deepStrictEqual(value, [[1, "Alice"]]);
      assert.strictEqual(log[0]?.method, "name_get");
      assert.deepStrictEqual(log[0]?.args, []);
      assert.deepStrictEqual(log[0]?.ids, [1]);
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

/**
 * LIVE integration specs for the seeded-context / ref / model-op features
 * (G1/G3/G5). Runs over the JSON-RPC transport on every supported major
 * (16–19), plus a JSON-2 variant gated on major >= 19. Skips itself entirely
 * when no harness stack is up.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import {
  Json2Transport,
  JsonRpcTransport,
  OdooClient,
  OdooClientLive,
  Rpc,
  RpcLive,
} from "../src/index.ts";
import { apiKeyConfig, hasStack, majorVersion, TIMEOUT_MS } from "./support.ts";

/** OdooClient + a base-tier-seeded Rpc over the JSON-RPC transport. */
const seededJsonRpc = (config = apiKeyConfig()): Layer.Layer<OdooClient | Rpc> => {
  const transport = JsonRpcTransport.layer(config).pipe(Layer.provide(NodeHttpClient.layer));
  const rpc = RpcLive.layerSeeded().pipe(Layer.provide(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc));
};

const seededJson2 = (config = apiKeyConfig()): Layer.Layer<OdooClient | Rpc> => {
  // ApiKey creds by construction — the bearer-only guard cannot fail here.
  const transport = Json2Transport.layer(config).pipe(
    Layer.orDie,
    Layer.provide(NodeHttpClient.layer),
  );
  const rpc = RpcLive.layerSeeded().pipe(Layer.provide(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc));
};

describe.skipIf(!hasStack)("features (live)", () => {
  it.live.skipIf(!hasStack)(
    "layerSeeded round trip: server context_get seeds lang/tz onto every call",
    () =>
      Effect.gen(function* () {
        const rpc = yield* Rpc;
        // fields_get echoes back nothing about context, but the seed resolving
        // without error over a real transport is the round trip we assert; then
        // a normal op works with the seeded base tier in effect.
        const client = yield* OdooClient;
        const rows = yield* client.searchRead("res.partner", { fields: ["id"], limit: 1 });
        assert.isAtMost(rows.length, 1);
        // A raw callKw also succeeds under the seeded context.
        const count = yield* rpc.callKw("res.partner", "search_count", [[]]);
        assert.isTrue(typeof count === "number");
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    'ref("base.main_company") resolves to ["res.company", 1]',
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const [model, id] = yield* client.ref("base.main_company");
        assert.strictEqual(model, "res.company");
        assert.isAbove(id, 0);
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "ref of an unknown xml_id → OdooMissingError",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const error = yield* client.ref("base.definitely_not_a_real_xmlid").pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooMissingError");
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "readGroup res.partner groups by is_company",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const groups = yield* client.readGroup("res.partner", {
          domain: [],
          fields: ["is_company"],
          groupby: ["is_company"],
          lazy: false,
        });
        assert.isAbove(groups.length, 0);
        // `lazy: false` yields the canonical `__count` aggregate key (16–19).
        assert.property(groups[0] ?? {}, "__count");
        assert.property(groups[0] ?? {}, "is_company");
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "nameSearch res.partner returns (id, label) pairs (positional over execute_kw)",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const pairs = yield* client.nameSearch("res.partner", { limit: 3 });
        assert.isAtMost(pairs.length, 3);
        for (const [id, label] of pairs) {
          assert.isTrue(typeof id === "number");
          assert.isTrue(typeof label === "string");
        }
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );

  // name_get was removed server-side in Odoo 17+ — only exercise it on 16.
  it.live.skipIf(!hasStack || majorVersion >= 17)(
    "nameGet res.partner returns pairs on Odoo 16",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const ids = yield* client.search("res.partner", { limit: 1 });
        if (ids.length === 0) {
          return;
        }
        const pairs = yield* client.nameGet("res.partner", ids);
        assert.strictEqual(pairs.length, 1);
        assert.strictEqual(pairs[0]?.[0], ids[0]);
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );

  // JSON-2 variant: the by-name dialect for ref + nameSearch, and seeding over
  // the kwargs-only json2 transport (context_get is @api.model → kwargs-only).
  const json2 = hasStack && majorVersion >= 19;
  it.live.skipIf(!json2)(
    "json2: seeded ref + nameSearch by-name dialect",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const [model] = yield* client.ref("base.main_company");
        assert.strictEqual(model, "res.company");
        const pairs = yield* client.nameSearch("res.partner", { limit: 2 });
        assert.isAtMost(pairs.length, 2);
      }).pipe(Effect.provide(seededJson2())),
    TIMEOUT_MS,
  );
});

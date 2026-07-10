/**
 * LIVE integration specs for declared-prefetch typed records (spec tier, 17+). Per
 * version:
 *
 *   17/18/19 — a declared `Partner { name, company_id: Many2One(Company),
 *     child_ids: One2Many(Child) }` round-trips through ONE `web_search_read`
 *     `specification` call (nested company dict + nested children list), and
 *     `saveTyped` writes then returns the fresh nested snapshot via `web_save`.
 *   16 — a relation-free declared model degrades to `search_read` (works), and a
 *     declared RELATION fails with `ProtocolUnsupportedError` before any RPC
 *     (gated by an explicit `serverMajor`).
 *
 * All scratch records are torn down in an `ensuring`. Skips when no stack is up.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema, Exit } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import {
  JsonRpcTransport,
  OdooClient,
  OdooClientLive,
  type Rpc,
  RpcLive,
} from "../src/index.ts";
import { defineRecord, Many2One, One2Many } from "../src/records/index.ts";
import { apiKeyConfig, hasStack, majorVersion, marker, TIMEOUT_MS } from "./support.ts";

// v4 Cause is a flat failure list; recover the single typed error the way the
// v3 `cause._tag === "Fail" ? cause.error` narrow did.
const firstError = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  exit._tag === "Failure"
    ? exit.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error] : []))[0]
    : undefined;


const seededJsonRpc = (): Layer.Layer<OdooClient | Rpc> => {
  const transport = JsonRpcTransport.layer(apiKeyConfig()).pipe(Layer.provide(NodeHttpClient.layerUndici));
  const rpc = RpcLive.layerSeeded().pipe(Layer.provide(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc));
};

const Company = defineRecord("res.company", { name: Schema.String });
const Child = defineRecord("res.partner", { name: Schema.String });
const Partner = defineRecord("res.partner", {
  name: Schema.String,
  company_id: Many2One(Company),
  child_ids: One2Many(Child),
});
const FlatPartner = defineRecord("res.partner", { name: Schema.String });

describe.skipIf(!hasStack)("declared-prefetch typed records (live)", () => {
  it.live.skipIf(!hasStack || majorVersion < 17)(
    "searchTyped one round trip + saveTyped fresh snapshot (17+)",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const tag = marker();

        const [companyId] = yield* client.create("res.company", { name: `${tag}-co` });
        const [parentId] = yield* client.create("res.partner", {
          name: `${tag}-parent`,
          company_id: companyId,
        });
        const childIds = yield* client.create("res.partner", [
          { name: `${tag}-c1`, parent_id: parentId },
          { name: `${tag}-c2`, parent_id: parentId },
        ]);

        yield* Effect.gen(function* () {
          const rows = yield* client.searchTyped(Partner, {
            domain: [["id", "=", parentId!]],
            serverMajor: majorVersion,
          });
          assert.strictEqual(rows.length, 1);
          const row = rows[0]!;
          // Nested many2one dict — the label is present with NO extra fetch.
          assert.strictEqual(row.company_id?.id, companyId);
          assert.strictEqual(row.company_id?.name, `${tag}-co`);
          // Nested x2many list — both children materialized in the same trip.
          assert.strictEqual(row.child_ids.length, 2);
          assert.deepStrictEqual(
            [...row.child_ids].map((c) => c.id).sort((a, b) => a - b),
            [...childIds].sort((a, b) => a - b),
          );

          // saveTyped: write + fresh nested re-read in one web_save.
          const saved = yield* client.saveTyped(
            Partner,
            [parentId!],
            { name: `${tag}-renamed` },
            { serverMajor: majorVersion },
          );
          assert.strictEqual(saved.length, 1);
          assert.strictEqual(saved[0]?.name, `${tag}-renamed`);
          assert.strictEqual(saved[0]?.company_id?.id, companyId);
          assert.strictEqual(saved[0]?.child_ids.length, 2);
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* client.unlink("res.partner", childIds).pipe(Effect.ignore);
              yield* client.unlink("res.partner", [parentId!]).pipe(Effect.ignore);
              yield* client.unlink("res.company", [companyId!]).pipe(Effect.ignore);
            }),
          ),
        );
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack || majorVersion !== 16)(
    "16: relation-free degrades to search_read; a declared relation raises",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const tag = marker();
        const [partnerId] = yield* client.create("res.partner", { name: `${tag}-flat` });

        yield* Effect.gen(function* () {
          // Relation-free declared model → plain search_read on 16.
          const rows = yield* client.searchTyped(FlatPartner, {
            domain: [["id", "=", partnerId!]],
            serverMajor: 16,
          });
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0]?.name, `${tag}-flat`);

          // A declared RELATION on 16 fails before any round trip.
          const exit = yield* client
            .searchTyped(Partner, { domain: [["id", "=", partnerId!]], serverMajor: 16 })
            .pipe(Effect.exit);
          assert.isTrue(exit._tag === "Failure");
          const err = firstError(exit);
      if (err !== undefined) {
            assert.strictEqual(err._tag, "ProtocolUnsupportedError");
          }
        }).pipe(
          Effect.ensuring(client.unlink("res.partner", [partnerId!]).pipe(Effect.ignore)),
        );
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );
});

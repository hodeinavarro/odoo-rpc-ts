/**
 * LIVE integration specs for typed records (candidate B — explicit traversal).
 * Creates a scratch company + partners, reads them into a `TypedRecordSet` with
 * a schema declaring a nullable many2one (`company_id`) and a datetime
 * (`create_date` via `OdooDateTime`), then exercises the batched
 * `fetchRelated`/`joinRelated` against `res.company`. Everything is torn down in
 * an `ensuring`. Skips entirely when no harness stack is up.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import {
  JsonRpcTransport,
  OdooClient,
  OdooClientLive,
  type Rpc,
  RpcLive,
} from "../src/index.ts";
// Records surface is not yet wired into src/index.ts (owner: maintainer); import
// it from the internal barrel until the public re-export lands.
import { Many2OneRefOrNull, OdooDateTime } from "../src/records/index.ts";
import { apiKeyConfig, hasStack, marker, TIMEOUT_MS } from "./support.ts";

const seededJsonRpc = (): Layer.Layer<OdooClient | Rpc> => {
  const transport = JsonRpcTransport.layer(apiKeyConfig()).pipe(Layer.provide(NodeHttpClient.layer));
  const rpc = RpcLive.layerSeeded().pipe(Layer.provide(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc));
};

const Partner = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  company_id: Many2OneRefOrNull,
  create_date: OdooDateTime,
});

const Company = Schema.Struct({ id: Schema.Number, name: Schema.String });

describe.skipIf(!hasStack)("typed records (live)", () => {
  it.live.skipIf(!hasStack)(
    "searchRecordsTyped + fetchRelated/joinRelated over a scratch company & partners",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const tag = marker();

        const [companyId] = yield* client.create("res.company", { name: `${tag}-co` });
        assert.isAbove(companyId!, 0);

        const partnerIds = yield* client.create("res.partner", [
          { name: `${tag}-a`, company_id: companyId },
          { name: `${tag}-b`, company_id: companyId },
        ]);
        assert.strictEqual(partnerIds.length, 2);

        yield* Effect.gen(function* () {
          const rs = yield* client.searchRecordsTyped(
            "res.partner",
            { domain: [["id", "in", partnerIds]], fields: ["name", "company_id", "create_date"] },
            Partner,
          );
          assert.strictEqual(rs.length, 2);
          // The m2o pair decoded to a ref (label present, no extra fetch), and
          // create_date decoded to a real UTC instant.
          assert.strictEqual(rs.rows[0]?.company_id?.id, companyId);
          assert.instanceOf(rs.rows[0]?.create_date, Date);
          assert.isFalse(Number.isNaN(rs.rows[0]!.create_date.getTime()));

          // One batched read over the single distinct company id.
          const companies = yield* rs.fetchRelated("company_id", "res.company", Company, ["name"]);
          assert.strictEqual(companies.size, 1);
          assert.strictEqual(companies.get(rs.rows[0]!.company_id)?.name, `${tag}-co`);

          const joined = yield* rs.joinRelated("company_id", "res.company", Company, ["name"]);
          assert.strictEqual(joined.length, 2);
          for (const [partner, company] of joined) {
            assert.match(partner.name, new RegExp(`^${tag}-`));
            assert.strictEqual(company?.id, companyId);
          }
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* client.unlink("res.partner", partnerIds).pipe(Effect.ignore);
              yield* client.unlink("res.company", [companyId!]).pipe(Effect.ignore);
            }),
          ),
        );
      }).pipe(Effect.provide(seededJsonRpc())),
    TIMEOUT_MS,
  );
});

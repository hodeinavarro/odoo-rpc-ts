/**
 * LIVE JSON-2 (`/json/2/<model>/<method>`, bearer auth) integration specs.
 * Entire file is gated on Odoo major >= 19 (where JSON-2 lands) AND a running
 * harness stack.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import {
  Json2Transport,
  OdooClient,
  OdooClientLive,
  Rpc,
  RpcLive,
  Transport,
} from "../src/index.ts";
import { defineRecord } from "../src/records/index.ts";
import {
  apiKeyConfig,
  badApiKeyConfig,
  BOGUS_ID,
  hasStack,
  majorVersion,
  marker,
  restrictedApiKeyConfig,
  TIMEOUT_MS,
} from "./support.ts";

const enabled = hasStack && majorVersion >= 19;

/** OdooClient + Rpc + Transport over JSON-2, on a real Node HttpClient. */
const appLayer = (config = apiKeyConfig()): Layer.Layer<OdooClient | Rpc | Transport> => {
  const transport = Json2Transport.layer(config).pipe(Layer.provide(NodeHttpClient.layerUndici));
  const rpc = RpcLive.layer.pipe(Layer.provideMerge(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc)) as Layer.Layer<
    OdooClient | Rpc | Transport
  >;
};

describe.skipIf(!enabled)("json2 (live, Odoo 19+)", () => {
  it.live.skipIf(!enabled)(
    "probeJson2Version → Some on a JSON-2 server",
    () =>
      Effect.gen(function* () {
        const probe = yield* Json2Transport.probeJson2Version(apiKeyConfig());
        assert.isTrue(Option.isSome(probe));
      }).pipe(Effect.provide(NodeHttpClient.layerUndici)),
    TIMEOUT_MS,
  );

  it.live.skipIf(!enabled)(
    "searchRead + create/unlink (ids via the seam) round trip",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;

        const rows = yield* client.searchRead("res.partner", { fields: ["id"], limit: 2 });
        assert.isAtMost(rows.length, 2);

        const name = marker();
        const ids = yield* client.create("res.partner", { name });
        yield* Effect.gen(function* () {
          const read = yield* client.read("res.partner", ids, ["name"]);
          assert.strictEqual(read[0]?.["name"], name);
        }).pipe(Effect.ensuring(client.unlink("res.partner", ids).pipe(Effect.ignore)));
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!enabled)(
    "a wrong API key → OdooAuthenticationError",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const error = yield* client.searchCount("res.partner", []).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooAuthenticationError");
      }).pipe(Effect.provide(appLayer(badApiKeyConfig()))),
    TIMEOUT_MS,
  );

  it.live.skipIf(!enabled)(
    "valid restricted bearer → OdooAccessError for sale.order.create",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const error = yield* client.create("sale.order", { partner_id: 1 }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooAccessError");
        if (error._tag === "OdooAccessError") {
          assert.strictEqual(error.name, "odoo.exceptions.AccessError");
          assert.strictEqual(error.model, "sale.order");
          assert.strictEqual(error.method, "create");
        }
      }).pipe(Effect.provide(appLayer(restrictedApiKeyConfig()))),
    TIMEOUT_MS,
  );

  it.live.skipIf(!enabled)(
    "a positional-args call via raw Transport.callKw → ProtocolUnsupportedError",
    () =>
      Effect.gen(function* () {
        const transport = yield* Transport;
        const error = yield* transport
          .callKw({ model: "res.partner", method: "search_read", args: [[]], kwargs: {} })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "ProtocolUnsupportedError");
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  // GOTCHA (verified live on 19.0): JSON-2 `read` of missing ids succeeds with
  // `[]` — the ORM silently skips them. It is `write` that raises MissingError.
  it.live.skipIf(!enabled)(
    "missing records: read yields [], write → OdooMissingError",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;

        const rows = yield* client.read("res.partner", [BOGUS_ID], ["name"]);
        assert.deepStrictEqual(rows, []);

        const error = yield* client
          .write("res.partner", [BOGUS_ID], { ref: "nope" })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooMissingError");
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!enabled)(
    "write + saveTyped bind the `vals` kwarg live (keyword-only dialect)",
    () =>
      Effect.gen(function* () {
        // Live proof of the kwarg-name-binding class of failure: JSON-2 forwards
        // kwargs by NAME into `write(self, vals)` / `web_save(self, vals,
        // specification)` — a wrong name is a 422 bad-signature fault here.
        const Partner = defineRecord("res.partner", {
          name: Schema.String,
          ref: Schema.Union([Schema.String, Schema.Literal(false)]),
        });
        const client = yield* OdooClient;
        const tag = marker();
        const ids = yield* client.create("res.partner", { name: tag });
        yield* Effect.gen(function* () {
          const wrote = yield* client.write("res.partner", ids, { ref: `${tag}-ref` });
          assert.strictEqual(wrote, true);
          const read = yield* client.read("res.partner", ids, ["ref"]);
          assert.strictEqual(read[0]?.["ref"], `${tag}-ref`);

          const saved = yield* client.saveTyped(
            Partner,
            ids,
            { name: `${tag}-renamed` },
            { serverMajor: majorVersion },
          );
          assert.strictEqual(saved.length, 1);
          assert.strictEqual(saved[0]?.name, `${tag}-renamed`);
          assert.strictEqual(saved[0]?.ref, `${tag}-ref`);
        }).pipe(Effect.ensuring(client.unlink("res.partner", ids).pipe(Effect.ignore)));
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );
});

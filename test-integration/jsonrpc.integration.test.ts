/**
 * LIVE JSON-RPC (`/jsonrpc` → `execute_kw`) integration specs, all through the
 * public surface. Skips itself entirely when no harness stack is up.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import {
  JsonRpcTransport,
  OdooClient,
  OdooClientLive,
  Rpc,
  RpcLive,
  parseVersionInfo,
} from "../src/index.ts";
import {
  apiKeyConfig,
  badApiKeyConfig,
  BOGUS_ID,
  hasStack,
  majorVersion,
  marker,
  TIMEOUT_MS,
} from "./support.ts";

/** OdooClient + Rpc over the JSON-RPC transport, on a real Node HttpClient. */
const appLayer = (config = apiKeyConfig()): Layer.Layer<OdooClient | Rpc> => {
  const transport = JsonRpcTransport.layer(config).pipe(Layer.provide(NodeHttpClient.layer));
  const rpc = RpcLive.layer.pipe(Layer.provide(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc));
};

describe.skipIf(!hasStack)("jsonrpc (live)", () => {
  it.live.skipIf(!hasStack)(
    "common.version reports the harness major",
    () =>
      Effect.gen(function* () {
        const res = yield* JsonRpcTransport.makeVersion(apiKeyConfig());
        const parsed = parseVersionInfo(res.server_version_info);
        assert.strictEqual(parsed.major, majorVersion);
      }).pipe(Effect.provide(NodeHttpClient.layer)),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "searchRead res.partner honours fields + limit",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const rows = yield* client.searchRead("res.partner", {
          fields: ["id", "name"],
          limit: 3,
        });
        assert.isAtMost(rows.length, 3);
        for (const row of rows) {
          assert.property(row, "id");
          assert.property(row, "name");
        }
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "create → write → read → searchCount → unlink round trip",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const name = marker();

        const ids = yield* client
          .create("res.partner", { name })
          .pipe(
            Effect.tap((created) => Effect.sync(() => assert.strictEqual(created.length, 1))),
          );

        yield* Effect.gen(function* () {
          // write updates a field and returns `true`.
          // GOTCHA: use a Char field — Html fields (e.g. `comment`) get sanitized
          // and wrapped in <p> by the server, which is not a round-trip.
          const wrote = yield* client.write("res.partner", ids, { ref: "it-touched" });
          assert.strictEqual(wrote, true);

          // read reflects both the create and the write.
          const read = yield* client.read("res.partner", ids, ["name", "ref"]);
          assert.strictEqual(read.length, 1);
          assert.strictEqual(read[0]?.["name"], name);
          assert.strictEqual(read[0]?.["ref"], "it-touched");

          // searchCount sees exactly the one record under our unique marker.
          const count = yield* client.searchCount("res.partner", [["name", "=", name]]);
          assert.strictEqual(count, 1);
        }).pipe(
          // Always clean up, even on assertion failure.
          Effect.ensuring(client.unlink("res.partner", ids).pipe(Effect.ignore)),
        );
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "fieldsGet returns res.partner metadata keyed by field",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const meta = yield* client.fieldsGet("res.partner", { attributes: ["type", "string"] });
        assert.property(meta, "name");
        assert.property(meta["name"] ?? {}, "type");
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "unlink on a bogus id → OdooMissingError",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const error = yield* client.unlink("res.partner", [BOGUS_ID]).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooMissingError");
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  // On 17+ the object service gates private methods with an AccessError; 16
  // does not, so the assertion is skipped there (still runs the call as a smoke).
  it.live.skipIf(!hasStack)(
    "callKw of a private method (_write) → OdooAccessError on 17+",
    () =>
      Effect.gen(function* () {
        if (majorVersion < 17) {
          return;
        }
        const rpc = yield* Rpc;
        const error = yield* rpc
          .callKw("res.partner", "_write", [], { vals: {} }, { ids: [1] })
          .pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooAccessError");
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "a bad API key → OdooAuthenticationError",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const error = yield* client.searchCount("res.partner", []).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooAuthenticationError");
      }).pipe(Effect.provide(appLayer(badApiKeyConfig()))),
    TIMEOUT_MS,
  );
});

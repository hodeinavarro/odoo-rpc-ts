/**
 * Compile-only guard for the README examples. Every snippet shown in the
 * README is mirrored here so `pnpm check` fails if the docs drift from the
 * actual API. Never executed.
 */
import { Config, Effect, Layer, Schema } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import {
  AND,
  CookieSessionLive,
  Json2Transport,
  JsonRpcTransport,
  OdooClient,
  OdooClientLive,
  OR,
  retryOnSessionExpired,
  RpcLive,
  WebTransport,
} from "../src/index.ts";
import * as FakeTransport from "../src/testing/index.ts";

// --- quick start ---------------------------------------------------------

const OdooLive = OdooClientLive.layer.pipe(
  Layer.provideMerge(RpcLive.layer),
  Layer.provide(JsonRpcTransport.layerConfig),
  Layer.provide(NodeHttpClient.layer),
);

const Partner = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.Union(Schema.String, Schema.Literal(false)),
});

const companies = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  return yield* odoo.searchRead(
    "res.partner",
    { domain: [["is_company", "=", true]], fields: ["id", "name", "email"], limit: 10 },
    Partner,
  );
});

void companies.pipe(Effect.provide(OdooLive), Effect.runPromise);

// --- find-or-create workflow ---------------------------------------------

export const findOrCreatePartner = (email: string, name: string) =>
  Effect.gen(function* () {
    const odoo = yield* OdooClient;
    const existing = yield* odoo.search("res.partner", {
      domain: [["email", "=", email]],
      limit: 1,
    });
    if (existing.length > 0) {
      return existing[0]!;
    }
    const [id] = yield* odoo.create("res.partner", { name, email });
    return id!;
  });

// --- close won leads workflow --------------------------------------------

export const archiveStaleLeads = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  const stale = yield* odoo.search("crm.lead", {
    domain: AND(
      [["active", "=", true]],
      OR([["probability", "=", 0]], [["write_date", "<", "2025-01-01"]]),
    ),
  });
  if (stale.length === 0) {
    return 0;
  }
  yield* odoo.write("crm.lead", stale, { active: false });
  return stale.length;
});

// --- pagination -----------------------------------------------------------

export const allPartnerIds = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  const out: number[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = yield* odoo.search("res.partner", { limit: 500, offset });
    out.push(...page);
    if (page.length < 500) {
      return out;
    }
  }
});

// --- error handling --------------------------------------------------------

const created = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  return yield* odoo.create("res.partner", { name: "Ada" });
}).pipe(
  Effect.catchTags({
    OdooValidationError: (e) => Effect.dieMessage(`rejected by a constraint: ${e.message}`),
    OdooAccessError: () => Effect.succeed([]),
    OdooAuthenticationError: (e) => Effect.dieMessage(e.reason),
  }),
);
void created;

// --- cookie session --------------------------------------------------------

const WebLive = OdooClientLive.layer.pipe(
  Layer.provideMerge(RpcLive.layer),
  Layer.provide(WebTransport.layerConfig),
  Layer.provideMerge(CookieSessionLive.layerConfig),
  Layer.provide(NodeHttpClient.layer),
);
void WebLive;

import { CookieSession } from "../src/index.ts";

export const resilientCount = Effect.gen(function* () {
  const session = yield* CookieSession;
  const odoo = yield* OdooClient;
  return yield* retryOnSessionExpired(odoo.searchCount("res.partner", []), session);
});

// --- json2 ------------------------------------------------------------------

const Json2Live = OdooClientLive.layer.pipe(
  Layer.provideMerge(RpcLive.layer),
  Layer.provide(Json2Transport.layerConfig),
  Layer.provide(NodeHttpClient.layer),
);
void Json2Live;

// --- config from code instead of env ----------------------------------------

import { ConfigProvider } from "effect";

const TestConfig = Layer.setConfigProvider(
  ConfigProvider.fromMap(
    new Map([
      ["ODOO_URL", "https://mycompany.odoo.com"],
      ["ODOO_DB", "mycompany"],
      ["ODOO_USERNAME", "integration@mycompany.com"],
      ["ODOO_API_KEY", "…"],
    ]),
  ),
);
void TestConfig;
void Config;

// --- testing -----------------------------------------------------------------

const fake = FakeTransport.make({
  "res.partner": {
    search_read: () => [{ id: 1, name: "Alice", email: "alice@example.com" }],
    create: (params) => (params.args[0] as unknown[]).map((_, i) => 100 + i),
  },
});

const testLayer = OdooClientLive.layer.pipe(
  Layer.provideMerge(RpcLive.layer),
  Layer.provide(fake.layer),
);
void testLayer;

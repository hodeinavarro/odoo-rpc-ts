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

// --- harvested cookie (fromExisting) ----------------------------------------

import { Redacted } from "effect";

declare const harvestedCookieValue: string;

const url = new URL("https://erp.example.com");

const HarvestedOdoo = OdooClientLive.layer.pipe(
  Layer.provideMerge(RpcLive.layer),
  Layer.provide(WebTransport.layer({ url })), // no credentials needed
  Layer.provide(
    CookieSessionLive.layerFromExisting({
      url,
      sessionId: Redacted.make(harvestedCookieValue),
      // renew: driveLoginWindow,
    }),
  ),
  Layer.provide(NodeHttpClient.layer),
);
void HarvestedOdoo;

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

// --- typed records: declared prefetch ----------------------------------------

import {
  Command,
  defineRecord,
  Many2One,
  Many2OneRefOrNull,
  OdooDateTime,
} from "../src/index.ts";

const CompanyRec = defineRecord("res.company", { name: Schema.String });
const PartnerRec = defineRecord("res.partner", {
  name: Schema.String,
  create_date: OdooDateTime,
  company_id: Many2One(CompanyRec),
});

export const declaredRows = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  const rows = yield* odoo.searchTyped(PartnerRec, {
    domain: [["is_company", "=", true]],
    limit: 10,
  });
  return rows[0]?.company_id?.name ?? null;
});

// --- typed records: explicit traversal ---------------------------------------

const PartnerRow = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  company_id: Many2OneRefOrNull,
});
const CompanyRow = Schema.Struct({ id: Schema.Number, name: Schema.String });

export const joinedPairs = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  const rows = yield* odoo.searchRecordsTyped("res.partner", {}, PartnerRow);
  return yield* rows.joinRelated("company_id", "res.company", CompanyRow);
});

// --- commands ------------------------------------------------------------------

export const writeWithCommands = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  return yield* odoo.write("res.partner", [1], {
    child_ids: [Command.create({ name: "New contact" }), Command.link(7)],
  });
});

// --- services -------------------------------------------------------------------

import { DbService, ReportService } from "../src/index.ts";

declare const master: Redacted.Redacted<string>;

export const dbAndReports = Effect.gen(function* () {
  const names = yield* DbService.listDatabases(url);
  yield* DbService.duplicate(url, master, "prod", "staging");
  const session = yield* CookieSession;
  const pdf = yield* ReportService.download(session, {
    reportName: "base.report_irmodeloverview",
    ids: [1],
  });
  return [names.length, pdf.length] as const;
});

// --- bring your own http layer ---------------------------------------------------

import { FetchHttpClient, HttpClient } from "@effect/platform";

const TunedHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) =>
    client.pipe(HttpClient.retryTransient({ times: 3 })),
  ),
).pipe(Layer.provide(FetchHttpClient.layer));
void TunedHttp;

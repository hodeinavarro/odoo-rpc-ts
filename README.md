# odoo-rpc-ts

Effect-native, strongly-typed Odoo RPC client for TypeScript. **Odoo 16–19**,
three wire protocols behind one seam — JSON-RPC, the new JSON-2 API (19+),
and the cookie-session web route — with a tagged-error taxonomy you can
`catchTag` instead of parsing messages.

```
pnpm add odoo-rpc-ts effect @effect/platform
pnpm add @effect/platform-node        # or run in the browser with FetchHttpClient
```

## Quick start

Set `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, and `ODOO_API_KEY` (or
`ODOO_PASSWORD`), then:

```ts
import { Effect, Layer, Schema } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import { JsonRpcTransport, OdooClient, OdooClientLive, RpcLive } from "odoo-rpc-ts";

// One layer graph: client → rpc → transport → your HTTP runtime.
const OdooLive = OdooClientLive.layer.pipe(
  Layer.provideMerge(RpcLive.layer),
  Layer.provide(JsonRpcTransport.layerConfig),
  Layer.provide(NodeHttpClient.layer),
);

// Rows decode through a schema — drift fails loudly, never a silent cast.
const Partner = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  email: Schema.Union(Schema.String, Schema.Literal(false)), // Odoo sends false, not null
});

const companies = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  return yield* odoo.searchRead(
    "res.partner",
    { domain: [["is_company", "=", true]], fields: ["id", "name", "email"], limit: 10 },
    Partner,
  );
});

await companies.pipe(Effect.provide(OdooLive), Effect.runPromise);
```

`OdooClient` gives you `searchRead`, `search`, `read`, `create`, `write`,
`unlink`, `fieldsGet`, `searchCount`, `readGroup`, `nameSearch`, `ref`
(resolve an XML id to `[model, id]`), and a generic `call` escape hatch —
every op works over every transport. `Rpc.callKw` sits underneath for
anything else, and `RpcLive.layerSeeded()` seeds the user's server-side
context (`lang`, `tz`) as the base tier of every call.

## Everyday workflows

**Find or create:**

```ts
const findOrCreatePartner = (email: string, name: string) =>
  Effect.gen(function* () {
    const odoo = yield* OdooClient;
    const existing = yield* odoo.search("res.partner", {
      domain: [["email", "=", email]],
      limit: 1,
    });
    if (existing.length > 0) return existing[0]!;
    const [id] = yield* odoo.create("res.partner", { name, email });
    return id!;
  });
```

**Bulk update with domain combinators** (`AND` / `OR` / `NOT`):

```ts
import { AND, OR } from "odoo-rpc-ts";

const archiveStaleLeads = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  const stale = yield* odoo.search("crm.lead", {
    domain: AND(
      [["active", "=", true]],
      OR([["probability", "=", 0]], [["write_date", "<", "2025-01-01"]]),
    ),
  });
  if (stale.length === 0) return 0;
  yield* odoo.write("crm.lead", stale, { active: false });
  return stale.length;
});
```

**Paginate a big model:**

```ts
const allPartnerIds = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  const out: number[] = [];
  for (let offset = 0; ; offset += 500) {
    const page = yield* odoo.search("res.partner", { limit: 500, offset });
    out.push(...page);
    if (page.length < 500) return out;
  }
});
```

## Typed records and relations

Two explicit ways to traverse relations — both make N+1 storms structurally
impossible, and every RPC stays visible:

**Declared prefetch** (Odoo 17+) — declare the graph, get ONE `web_search_read`:

```ts
import { defineRecord, Many2One, OdooClient, OdooDateTime } from "odoo-rpc-ts"
import { Schema } from "effect"

const Company = defineRecord("res.company", { name: Schema.String })
const Partner = defineRecord("res.partner", {
  name: Schema.String,
  create_date: OdooDateTime,            // parsed as UTC, never localized
  company_id: Many2One(Company),        // row.company_id?.name — already fetched
})

const rows = Effect.gen(function* () {
  const odoo = yield* OdooClient
  return yield* odoo.searchTyped(Partner, { domain: [["is_company", "=", true]], limit: 10 })
})
```

Provide a `VersionResolver` layer and the 17+ gate holds automatically: a
declared relation on Odoo 16 fails with `ProtocolUnsupportedError` before any
round trip, while relation-free records degrade to plain `search_read`.
`saveTyped` (17+) writes and returns the fresh nested snapshot in one call.

**Explicit traversal** (all versions) — rows keep `[id, name]` refs; batch the
hop when you need it, exactly one deduped `read`:

```ts
import { Many2OneRefOrNull, OdooClient } from "odoo-rpc-ts"

const PartnerRow = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  company_id: Many2OneRefOrNull,        // Odoo's [id, name] pair; false -> null
})
const CompanyRow = Schema.Struct({ id: Schema.Number, name: Schema.String })

const pairs = Effect.gen(function* () {
  const odoo = yield* OdooClient
  const rows = yield* odoo.searchRecordsTyped("res.partner", {}, PartnerRow)
  return yield* rows.joinRelated("company_id", "res.company", CompanyRow) // ONE read
})
```

## x2many writes without magic tuples

```ts
import { Command } from "odoo-rpc-ts"

yield* odoo.write("res.partner", [companyId], {
  child_ids: [Command.create({ name: "New contact" }), Command.link(existingId)],
})
```

## Services: databases, reports, profiles

```ts
import { DbService, ReportService } from "odoo-rpc-ts"

// database administration (master-password gated; Node-oriented)
const names = yield* DbService.listDatabases(url)
yield* DbService.duplicate(url, master, "prod", "staging")

// report downloads over the cookie session — works on ALL of 16-19
const pdf = yield* ReportService.download(session, {
  reportName: "base.report_irmodeloverview",
  ids: [modelId],
})
```

Connection profiles never serialize secrets: `ProfileData` holds the metadata,
secrets cross only as `Redacted` through a `SecretStore` you implement (OS
keyring in Node, IndexedDB in the browser); in-memory layers ship for tests.

## Bring your own HTTP layer

The library depends only on the abstract `HttpClient` tag — timeouts, proxies,
custom CAs, and retry policy are yours:

```ts
import { FetchHttpClient, HttpClient } from "@effect/platform"
import { Layer } from "effect"

const TunedHttp = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (client) => client.pipe(HttpClient.retryTransient({ times: 3 }))),
).pipe(Layer.provide(FetchHttpClient.layer))
```

## Errors are a typed API

Every failure is a tagged error carrying the raw fault, the Python exception
name, and the call site — normalized identically across all three protocols:

```ts
const created = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  return yield* odoo.create("res.partner", { name: "Ada" });
}).pipe(
  Effect.catchTags({
    OdooValidationError: (e) => Effect.dieMessage(`rejected by a constraint: ${e.message}`),
    OdooAccessError: () => Effect.succeed([]), // degrade gracefully
    OdooAuthenticationError: (e) => Effect.dieMessage(e.reason), // "invalid-credentials" | "mfa-pending" | …
  }),
);
```

The full union: `OdooTransportError` · `OdooAuthenticationError` ·
`SessionExpiredError` · `SchemaDriftError` · `ProtocolUnsupportedError` ·
`OdooServerError` (+ `OdooAccessError`, `OdooValidationError`,
`OdooMissingError`, `OdooUserError`, `OdooLockError`). Unknown server faults
are preserved on `OdooServerError` with the raw name — never swallowed.

## Pick your transport

Same application code, different layer — always your explicit choice:

```ts
// Server-to-server, stateless: /jsonrpc + execute_kw (Odoo 16–19)
Layer.provide(JsonRpcTransport.layerConfig);

// Odoo 19+: /json/2, bearer API key, real HTTP status codes
Layer.provide(Json2Transport.layerConfig);

// Browser/long-lived: cookie session over /web/dataset/call_kw
Layer.provide(WebTransport.layerConfig).pipe(Layer.provideMerge(CookieSessionLive.layerConfig));
```

Cookie sessions expire; recovery is opt-in, never magic:

```ts
import { CookieSession, retryOnSessionExpired } from "odoo-rpc-ts";

const resilientCount = Effect.gen(function* () {
  const session = yield* CookieSession;
  const odoo = yield* OdooClient;
  return yield* retryOnSessionExpired(odoo.searchCount("res.partner", []), session);
});
```

Already hold a `session_id` minted elsewhere — e.g. harvested from an
embedded browser window after the user completed the real `/web/login` page
(the only stock flow for TOTP/SSO accounts)? Adopt it directly; the client
never holds credentials:

```ts
import { Redacted } from "effect";
import { CookieSessionLive, WebTransport } from "odoo-rpc-ts";

const url = new URL("https://erp.example.com");

const HarvestedOdoo = OdooClientLive.layer.pipe(
  Layer.provideMerge(RpcLive.layer),
  Layer.provide(WebTransport.layer({ url })), // no credentials needed
  Layer.provide(
    CookieSessionLive.layerFromExisting({
      url,
      sessionId: Redacted.make(harvestedCookieValue),
      // Optional renew hook: mint a fresh cookie after an invalidate (e.g.
      // reopen the login window). Without it the session cannot recover —
      // once the server kills it, calls (and the one relogin attempted by
      // retryOnSessionExpired) fail with SessionExpiredError, and your shell
      // constructs a new session from a fresh cookie.
      // renew: driveLoginWindow,
    }),
  ),
  Layer.provide(NodeHttpClient.layer),
);
```

The injected session hydrates honestly on first use via
`POST /web/session/get_session_info`, so `login` still yields the real
`uid`/context/version — and a dead cookie surfaces immediately as
`SessionExpiredError`.

Notes: API keys work as the password on every route (and are _required_ for
accounts with 2FA). JSON-2 is bearer-only and keyword-only — the client
handles the encoding differences for you via the transport's `dialect`.

## Testing without a server

`odoo-rpc-ts/testing` ships a deterministic `FakeTransport` with a call log:

```ts
import * as FakeTransport from "odoo-rpc-ts/testing";

const fake = FakeTransport.make({
  "res.partner": {
    search_read: () => [{ id: 1, name: "Alice", email: "alice@example.com" }],
    create: (params) => (params.args[0] as unknown[]).map((_, i) => 100 + i),
  },
});

const TestLayer = OdooClientLive.layer.pipe(
  Layer.provideMerge(RpcLive.layer),
  Layer.provide(fake.layer),
);
```

Config is `effect/Config`, so tests can inject values without touching env:

```ts
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
```

Want the real thing? `pnpm harness up 16.0` (or 17/18/19) boots a disposable
seeded Odoo in Docker and `pnpm test:integration` runs the live suite against
it — see [harness/README.md](harness/README.md).

## Support matrix

|                            | 16.0 | 17.0 | 18.0 | 19.0                    |
| -------------------------- | ---- | ---- | ---- | ----------------------- |
| JSON-RPC `/jsonrpc`        | ✓    | ✓    | ✓    | ✓ (deprecated upstream) |
| Web session + `call_kw`    | ✓    | ✓    | ✓    | ✓                       |
| JSON-2 `/json/2` (bearer)  | –    | –    | –    | ✓                       |
| API key auth (as password) | ✓    | ✓    | ✓    | ✓                       |

XML-RPC is deliberately out of scope — JSON-RPC reaches the same services on
every supported version with strictly richer errors.

## Design, in one paragraph

Everything returns `Effect<A, OdooError, R>` — nothing throws. Services are
`Context.Tag`s wired with `Layer`s; the HTTP runtime is yours (`effect` and
`@effect/platform` are peer dependencies, so it runs wherever Effect does,
browser included). Responses are schema-decoded at the boundary
(`SchemaDriftError` on drift), secrets stay `Redacted`, TLS is never
disabled, and no URL/db/credential is ever assumed. The wire behavior was
mapped from the Odoo 16–19 sources and verified against live instances; the
details — and every architectural decision — live in [AGENTS.md](AGENTS.md).

Every example in this README is compile-checked in CI
([test/readme-snippets.test-d.ts](test/readme-snippets.test-d.ts)).

## Status

🚧 Pre-1.0. Core is implemented and integration-tested against live Odoo 16
and 19; the API may still move.

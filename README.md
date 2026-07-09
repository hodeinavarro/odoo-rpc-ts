# odoo-rpc-ts

A generic, strongly-typed, Effect-native Odoo RPC client for TypeScript.
One library for Odoo's JSON external APIs: **JSON-RPC**, the new **JSON-2**
API, and the **web-session route**, against **Odoo 16.0 through 19.0**, with
both **cookie-based web sessions** and **stateless (ephemeral)
authentication**. (XML-RPC is deliberately out of scope — JSON-RPC reaches
the same services on every supported version with strictly richer errors.)

Built to be reused across projects: no framework assumptions, no bundled
HTTP runtime, no silent defaults, and a rich taxonomy of tagged errors that
carries the full context of every failure.

## Why

Odoo's external API surface is fragmenting: `/xmlrpc/2` and `/jsonrpc` are
deprecated as of Odoo 19 (removal announced for Odoo 22) in favor of the
JSON-2 API (`/json/2/<model>/<method>`, bearer-token auth, real HTTP status
codes), while the cookie-session web route remains its own dialect. A client
that outlives that transition needs the protocol to be a swappable layer —
not the shape of your application code. That is exactly what this library
does: your code calls one typed API; the protocol, auth strategy, and Odoo
version quirks live behind Effect `Layer`s.

## Design principles

- **Effect-native, whole-app.** Every operation returns
  `Effect<A, OdooError, R>` — nothing throws. Schema (`effect/Schema`),
  config (`effect/Config` + `Redacted` secrets), logging, and DI
  (`Context.Tag` + `Layer`) all use Effect primitives. `effect` and
  `@effect/platform` are peer dependencies; you provide the platform
  HttpClient layer (fetch, Node, Bun), so the library runs anywhere Effect
  does — browser included.
- **Three transports, one seam.** `JsonRpcTransport`, `Json2Transport`, and
  the cookie-session `WebTransport` all implement one `Transport` tag,
  always chosen explicitly by the consumer — no auto-negotiation magic.
  Application code is protocol-agnostic.
- **Two session styles.** Ephemeral (API key or password per call /
  bearer token — server-to-server) and cookie sessions
  (`/web/session/authenticate`, httponly `session_id`, rotation-aware —
  browser and long-lived clients).
- **Version-aware, 16.0–19.0.** A version resolver (success-only cached)
  maps `server_version_info` to a capability record; asking a 16 server for
  JSON-2 fails fast with a tagged `ProtocolUnsupportedError`, not a 404 you
  have to interpret.
- **Boundary decoding.** Every response is decoded through `effect/Schema`;
  shape drift raises `SchemaDriftError` with the raw payload attached —
  never a silent cast.
- **Zero assumptions.** No implicit URL/db/protocol/credential defaults, TLS
  always verified, secrets always `Redacted` and never logged.

## Error taxonomy

All errors are tagged, `catchTag`-able, and carry structured context
(`model`, `method`, `arguments`, raw fault, `debug` traceback when the
server provides one). Server faults are normalized at one choke point per
protocol — from JSON-RPC's `error.data.name` and from JSON-2's HTTP status +
body `name` — into a single union:

```
OdooTransportError        network / HTTP layer
OdooAuthenticationError   bad credentials, bad/expired API key, MFA pending
SessionExpiredError       web session died (JSON-RPC code 100)
SchemaDriftError          response didn't match the expected schema
ProtocolUnsupportedError  protocol not available on this server version
OdooServerError           any Odoo fault, plus subtypes:
  OdooAccessError · OdooValidationError · OdooMissingError
  OdooUserError · OdooLockError (19+)
```

```ts
program.pipe(
  Effect.catchTag("SessionExpiredError", () => reauthenticateAndRetry),
  Effect.catchTag("OdooValidationError", (e) => Effect.logWarning(e.message)),
);
```

## Support matrix

|                            | 16.0 | 17.0 | 18.0 | 19.0                    |
| -------------------------- | ---- | ---- | ---- | ----------------------- |
| JSON-RPC `/jsonrpc`        | ✓    | ✓    | ✓    | ✓ (deprecated upstream) |
| Web session + `call_kw`    | ✓    | ✓    | ✓    | ✓                       |
| JSON-2 `/json/2` (bearer)  | –    | –    | –    | ✓                       |
| API key auth (as password) | ✓    | ✓    | ✓    | ✓                       |

## Intended shape

> 🚧 Early scaffolding — API not yet stable.

```ts
import { Effect } from "effect";
import { FetchHttpClient } from "@effect/platform";
import { OdooClient, JsonRpcTransport, EphemeralAuth, fromEnv } from "odoo-rpc-ts";

const companies = Effect.gen(function* () {
  const odoo = yield* OdooClient;
  return yield* odoo.searchRead("res.partner", {
    domain: [["is_company", "=", true]],
    fields: ["name", "email"],
    limit: 10,
  });
});

companies.pipe(
  Effect.provide(JsonRpcTransport.layer), // or Json2Transport / WebTransport
  Effect.provide(EphemeralAuth.layer), // or CookieSession.layer
  Effect.provide(fromEnv), // ODOO_URL / ODOO_DB / ODOO_USERNAME / ODOO_API_KEY
  Effect.provide(FetchHttpClient.layer), // you own the platform layer
  Effect.runPromise,
);
```

Testing is first-class: a deterministic `FakeTransport` ships under
`odoo-rpc-ts/testing`, so application code is testable without a server.

## Toolchain

TypeScript 7 (max-strict, no build step for dev — `tsc --noEmit` +
Node type stripping), Effect 3.x, `oxlint`/`oxfmt`, Vitest +
`@effect/vitest`, pnpm, ESM-only.

## Status

🚧 Greenfield. The wire-level behavior of all three routes has been mapped
directly from the Odoo 16.0–19.0 sources (endpoints, envelopes, fault
serialization, session and API-key mechanics) and is documented in
[AGENTS.md](AGENTS.md), which is the source of truth for contributors and
coding agents.

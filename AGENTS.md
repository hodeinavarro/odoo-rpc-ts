# AGENTS.md — odoo-rpc-ts

A generic, Effect-native, strongly-typed Odoo RPC client for TypeScript.
Reusable across projects; no assumptions about any particular host app.
This file is the single source of truth for how code is written here.
Dense on purpose. All Odoo wire facts below were verified against the
16.0–19.0 source trees (2026-07); re-verify against source before changing
protocol code, never against blog posts.

## Philosophy (non-negotiable)

- **Zero assumptions / verify-don't-assume.** A failure only proves
  _something_ failed. Probe actual state before any resume/skip/idempotent
  continue; fail loudly when state isn't verifiably what's expected. No
  implicit URL/db/protocol/credential defaults.
- **Errors are a typed API, not a dead end.** Every meaningful distinction is
  a tagged error in the typed failure channel. Upper layers never parse
  message strings.
- **Typed, composable, resource/service-shaped APIs** with explicit
  input→output types. Services as `Context.Tag`, wired with `Layer`.
- **One concern per file; split before grab-bag.** Name for growth
  (`errors/transport.ts`, not a generic `errors.ts` dumping ground).
- **No duplicated code.** Generics and shared contracts over copy-paste —
  especially across the three protocol implementations.
- **Standards first (99/1).** Schema-validate at boundaries; fail loudly on
  drift (`SchemaDriftError`), never cast.
- **Comments are for gotchas only.** Every dependency must justify itself.

## Effect-TS is the whole-app paradigm

Target **Effect 3.x** (`effect >= 3.21`). `effect` and `@effect/platform` are
**peer dependencies** — never hard deps; the consumer owns the Effect
instance and provides the platform HttpClient layer (fetch/node/bun). Nothing
throws — every operation returns `Effect<A, E, R>`.

- **HTTP:** depend only on the abstract `HttpClient` tag from
  `@effect/platform/HttpClient`. Never import `FetchHttpClient` or a node
  client outside tests/examples. Build requests with `HttpClientRequest`,
  decode with `HttpClientResponse.schemaJson`; re-tag `HttpClientError` into
  our union at the boundary.
- **Cookies:** the session-cookie mechanism is `Ref<Cookies>` +
  `HttpClient.withCookiesRef` (there is no CookieJar class);
  `Cookies.fromSetCookie` parses the login response.
- **Schema:** `effect/Schema` (core — `import { Schema } from "effect"`;
  the separate `@effect/schema` package no longer exists). No zod.
- **Errors:** wire-decoded faults are `Schema.TaggedError`; purely local
  errors are `Data.TaggedError`. Both `_tag`-discriminated so `catchTag`
  works across the whole union.
- **Services:** `class Foo extends Context.Tag("odoo-rpc-ts/Foo")<Foo, …>()`
  - hand-written `Layer`s. Do **not** use `Effect.Service` (experimental,
    highest-churn surface for the v4 migration).
- **Config:** `effect/Config` + `Config.redacted` for secrets;
  `Config.nested`/`Config.all` to build the struct. Library reads `Config`;
  the consumer chooses the `ConfigProvider`. No dotenv.
- **Secrets:** API keys and passwords held as `Redacted<string>`;
  `Redacted.value` only at the HTTP boundary. Never logged.
- **Logging:** Effect `Logger` + `Effect.annotateLogs` wide events.
- **Orchestration:** `Effect.gen` / `yield*`. Concurrency primitives from
  Effect (`Semaphore`, `Ref`, `Deferred`) — no ad-hoc promises.
- **Effect 4 decision (2026-07-09): stay on 3.21 stable, structured for the
  port.** v4 merges platform into core with big perf/bundle wins, but has no
  3↔4 interop, ~daily breaking betas, no GA date, and its HttpClient lives
  in permanently semver-exempt `effect/unstable/http`. Port-readiness rules:
  all `@effect/platform` imports funnel through a single internal module;
  no experimental APIs (`Effect.Service`) on the public surface; keep Schema
  filter usage simple (v4 rewrote filters to `.check(…)` combinators).
  Revisit at v4 GA via the official migration guide/codemod.

## Architecture — protocols, two session styles, one seam

**Decisions (2026-07-09):** public API = `Rpc.callKw` escape hatch + hand-typed
high-level ops (no model codegen for now). Protocol selection is always an
explicit consumer-provided Layer — no auto-negotiation. **XML-RPC is
deliberately not supported** (JSON-RPC reaches the same `common`/`object`/`db`
services on every supported version; XML-RPC adds only a lossy fault channel
and a marshaller to own). Single npm package with subpath exports
(`odoo-rpc-ts`, `odoo-rpc-ts/testing`).

```
OdooClient (high-level typed ops: searchRead, create, write, …)
  └─ Rpc            — protocol-agnostic callKw(model, method, args, kwargs)
       └─ Transport — one Layer per protocol
            ├─ JsonRpcTransport   POST /jsonrpc          (16–19; deprecated in 19)
            ├─ Json2Transport     POST /json/2/<model>/<method>  (19+)
            └─ WebTransport       POST /web/dataset/call_kw      (cookie session)
  Auth strategies (orthogonal to protocol where the matrix allows):
    ├─ EphemeralAuth  — uid resolved via authenticate(), credentials sent
    │                   per call (execute_kw) or as Bearer (JSON-2). Stateless.
    └─ CookieSession  — /web/session/authenticate → httponly session_id
                        cookie in a Ref<Cookies>. Stateful, rotates.
  VersionResolver   — resolves server version once (success-only cached),
                      gates protocol/feature availability per the matrix.
  FakeTransport     — exported from ./testing for deterministic tests.
```

Carry-forward patterns (from earlier private personal project work — reimplement, don't port):
context-merge choke point (session context `<` global overrides `<` caller
context, mirroring the web client), success-only single-flight caching
(`Semaphore(1)` + `Ref<Option<…>>` — retryable on failure, never
`Effect.cached`) for auth/uid/version/session, domain combinators
(`AND`/`OR`/`NOT`, `normalizeDomain`), optional per-round-trip OTel span
(no-op unless a tracer is provided).

## Protocol wire facts (verified against Odoo source)

### JSON-RPC — `POST /jsonrpc` (16–19)

- Envelope `{jsonrpc:"2.0", method:"call", params:{service, method, args}, id}`.
  The JSON-RPC `method` member is ignored by Odoo; params are by-name only.
- Services: `common` (`login`, `authenticate(db,login,password,user_agent_env)`,
  `version`), `object` (`execute_kw(db, uid, password, model, method, args,
kwargs)`), `db`.
- Success `{jsonrpc, id, result}`. Error `{jsonrpc, id, error:{code, message,
data}}` with `code` almost always `200` ("Odoo Server Error"), `404` for
  NotFound, **`100` for session expiry**. Real discrimination lives in
  `error.data` = `{name, debug, message, arguments, context}` where `name` is
  the dotted Python class (`odoo.exceptions.UserError`, …). Map on
  `data.name`, never on `message`.
- CSRF does not apply to JSON dispatchers. `Content-Type: application/json`.

### Web route — cookie session (16–19)

- Login: `POST /web/session/authenticate` (JSON-RPC envelope,
  params `{db, login, password}`) → sets httponly `session_id` cookie,
  returns `session_info()` (includes `uid`, `user_context`, `server_version_info`).
  MFA-pending returns `{uid: null}` — treat as auth failure with a distinct tag.
- Calls: `POST /web/dataset/call_kw` (JSON-RPC envelope, params
  `{model, method, args, kwargs}`; `kwargs.context` merges with session
  context). `call_button` for action buttons.
- Session expiry surfaces as `error.code === 100` → `SessionExpiredError`;
  re-auth is the caller's policy, never automatic (decision 2026-07-09). We
  ship an opt-in `retryOnSessionExpired` combinator, nothing implicit.
- Sessions rotate (19: every 3h); the `Ref<Cookies>` must always accept
  updated `Set-Cookie`. Password change / TOTP enrollment invalidates all
  sessions server-side.
- `session_info.user_companies` shape changed in 17 (adds `child_ids`,
  `parent_id`, `disallowed_ancestor_companies`) — schema per version range.

### XML-RPC — not supported (decision)

`POST /xmlrpc/2/*` exposes the same services as `/jsonrpc` but with lossy
int-only fault codes (1 generic, 2 UserError-family, 3 AccessDenied,
4 AccessError — no `data.name`) and would require owning an XML marshaller
with Odoo quirks (bytes as base64 _strings_, no `None`, naive datetimes).
An `xmlrpc` protocol in config is a **hard tagged error**, not a fallback.
If ever revisited: hand-rolled zero-dep marshaller, fixture-tested.

### JSON-2 — `POST /json/2/<model>/<method>` (19+ only)

- Auth: `Authorization: Bearer <api-key>` (key must be global/NULL scope —
  "rpc" scope matches NULL). Stateless; no session saved. DB selection via
  `X-Odoo-Database` header (forbidden to combine with a session cookie).
- Body: single JSON object = **kwargs only** (no positional args). Special
  keys: `ids: number[]` (browse target; invalid on `@api.model` methods → 422) and `context: object`. `domain`, `fields`, `limit`, … are plain
  kwargs. `Content-Type: application/json` required (else 415).
- Response: the **raw method return value** as JSON — no envelope.
- Errors: real HTTP status + `serialize_exception` body `{name, message,
arguments, context, debug}`. Status map: 401 no/bad bearer, 403
  AccessDenied/AccessError, 404 MissingError/unknown method, 409 LockError,
  422 UserError/ValidationError/bad signature, 500 anything else. Normalize
  from `body.name` first, status as fallback.
- Version probe without auth: `GET /json/version` (also `/web/version`) →
  `{version, version_info}`. On ≤18 this 404s — that itself is a version signal.
- The positional-args mismatch vs `execute_kw` is why `Rpc.callKw` keeps
  `(args, kwargs)`: the Json2Transport must reject or adapt positional args
  per method — never silently reorder.
- **`ids` is first-class on the seam (decision 2026-07-09):** `CallKwParams`
  carries an optional `ids` (the browse target). JSON-2 sends it as its
  special `ids` body key; execute_kw-family transports prepend it as the
  first positional argument. High-level ops pass everything else as *named*
  kwargs (`fields`, `vals`, `vals_list`, `domain` — stable Python parameter
  names on 16–19), so every `OdooClient` op works over every transport.

## Version support matrix (16.0 – 19.0)

| Capability                                           | 16       | 17        | 18                                                      | 19                                                |
| ---------------------------------------------------- | -------- | --------- | ------------------------------------------------------- | ------------------------------------------------- |
| `/jsonrpc`                                           | ✓        | ✓         | ✓                                                       | ✓ deprecated (log-only; removal announced for 22) |
| `/web/session` + `call_kw`                           | ✓        | ✓         | ✓                                                       | ✓                                                 |
| JSON-2 `/json/2`                                     | –        | –         | – (only gated experimental `/json/1`, unsupported here) | ✓                                                 |
| API key as `password` in `authenticate`/`execute_kw` | ✓        | ✓         | ✓                                                       | ✓                                                 |
| API key expiration dates                             | –        | –         | ✓                                                       | ✓ (+ programmatic `generate`/`revoke`, ICP-gated) |
| Private-method blocking (`get_public_method`)        | web only | ✓ all RPC | ✓                                                       | ✓                                                 |
| `LockError` (409)                                    | –        | –         | –                                                       | ✓                                                 |

Cross-version invariants we rely on: JSON-RPC envelope + `error.data.name`
shape, code 100, `common.version` →
`{server_version, server_version_info, server_serie, protocol_version: 1}`,
API-key-as-password (and TOTP-enabled users are API-key-only over RPC —
surface a dedicated error hint on AccessDenied when a password was used).

`VersionResolver` turns `server_version_info` into a capability record;
transports fail fast with a tagged error (`ProtocolUnsupportedError`) when
asked to run against a server that can't serve them. 17+ private-method
`AccessError`s exist for methods callable in 16 — that's server policy, we
just map it.

## Error taxonomy

Distinct `_tag` per subtype — best `catchTag` ergonomics; never one blanket
error discriminated by field. One error file per concern.

```
OdooTransportError        # HTTP/network layer (wraps HttpClientError)
OdooAuthenticationError   # AccessDenied at login, bad key, MFA-pending
SessionExpiredError       # jsonrpc code 100 / web session death
SchemaDriftError          # response shape ≠ schema (carries raw payload)
ProtocolUnsupportedError  # protocol × version mismatch
OdooServerError           # base for faults; carries {name, message,
  ├── OdooAccessError     #   arguments, context, debug?, model?, method?}
  ├── OdooValidationError
  ├── OdooMissingError
  ├── OdooUserError
  └── OdooLockError       # 19+ only
```

Fault mapping happens at exactly one choke point per protocol
(`mapJsonRpcFault`, `mapJson2Fault`, one for the web route) normalizing into the
same union. Unknown `data.name` → `OdooServerError` with the raw name
preserved — never dropped, never a thrown string.

## Tooling

- **TypeScript 7** (Go-native, stable 2026-07): `typescript@^7`. Defaults are
  already strict (`strict`, `target es2025`, `moduleResolution bundler`).
  We set: `module: "nodenext"`, `types: ["node"]`,
  `verbatimModuleSyntax`, `erasableSyntaxOnly` (no enums/namespaces — Node
  type-stripping compatible), `exactOptionalPropertyTypes`,
  `noUncheckedIndexedAccess`. `isolatedDeclarations` stays **off** — it
  fights inferred `Effect<A, E, R>` signatures.
  `tsc --noEmit` is the checker; no build step for dev. TS7 has no JS
  compiler API until 7.1 — don't add tools that need it (no
  `vitest --typecheck`; plain vitest is fine).
- **Lint/format:** `oxlint` + `oxfmt` — NOT ESLint/Prettier/biome. Minimal
  config; TS7-compatible.
- **Tests:** Vitest + `@effect/vitest`: `it.effect` + `Effect.gen`, `assert`
  from `@effect/vitest` (not `expect`), `layer(…)` blocks to share a
  `FakeTransport`/mock `HttpClient` layer across a describe. Wire-level
  tests decode captured fixtures per Odoo version.
- **Integration:** The checked-in Docker harness runs disposable Odoo instances for supported versions; unit tests never require Docker.
- **Package:** ESM-only, `"type": "module"`, pnpm. `exports` map with a
  `./testing` entry point. `effect` + `@effect/platform` in
  `peerDependencies` (and devDependencies for development), platform
  implementations only in devDependencies.

## Formatting & commits

- Exploded multi-line style with trailing commas (magic trailing comma) for
  clean add-later diffs. oxfmt is the arbiter — no manual style debates.
- **Atomic commits** — one logical change each.

## Invariants — do not regress

- Nothing throws; all failures are tagged errors in the `Effect` fail channel.
- Distinct `_tag` per fault subtype; upper layers never parse messages;
  unknown faults preserved, not swallowed.
- All three protocols normalize into the **same** error union at one choke
  point each.
- `effect/Schema` (core), not `@effect/schema`; `effect/Config`, not dotenv;
  abstract `HttpClient` tag, no bundled platform layer.
- TLS never disabled; secrets always `Redacted`; API keys never in URLs or logs.
- Auth/uid/version/session caches are success-only single-flight (never
  `Effect.cached`).
- No `Effect.Service`, no enums/namespaces (`erasableSyntaxOnly`), ESM only.
- Wire behavior claims in this file change only with a source-verified
  citation from the Odoo trees.

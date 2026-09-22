# Protocol implementation reference

Use for transport, authentication, session, capability or error changes.
Commands and source paths are relative to the repository root. Verify wire
claims against the matching Odoo source before changing protocol behavior.

## Architecture — protocols, two session styles, one seam

**Decisions (2026-07-09):** public API = `Rpc.callKw` escape hatch + hand-typed
high-level ops (no model codegen for now). Protocol selection is always an
explicit consumer-provided Layer — no auto-negotiation. **XML-RPC is
deliberately not supported** (JSON-RPC reaches the same `common`/`object`/`db`
services on every supported version; XML-RPC adds only a lossy fault channel
and a marshaller to own). Single npm package with subpath exports
(`@hodeinavarro/odoo-rpc-ts`, `@hodeinavarro/odoo-rpc-ts/testing`).

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

Carry-forward patterns (from earlier private personal project work —
reimplement, don't port):
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
- Success `{jsonrpc, id, result}`; when the dispatched method returns `None`,
  Odoo omits `result`, so `{jsonrpc, id}` is a successful void response. Error
  `{jsonrpc, id, error:{code, message, data}}` uses `code` almost always `200`
  ("Odoo Server Error"), `404` for
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
  first positional argument. High-level ops pass everything else as _named_
  kwargs (`fields`, `vals`, `vals_list`, `domain` — stable Python parameter
  names on 16–19), so every `OdooClient` op works over every transport.
- **Transports declare a `dialect` (`"execute-kw" | "json2"`), verified live:**
  Odoo's `call_kw` reads `create`'s vals from `args[0]` _unconditionally_
  (16–19), while JSON-2 binds kwargs by signature — so `create` cannot have
  one encoding. `OdooClient` (which owns method semantics) branches on
  `Rpc.dialect`; a transport itself never reorders args.
- **Live-verified wire quirks:** JSON-2 serializes a bad bearer key as
  `werkzeug.exceptions.Unauthorized` — the 401 status must be checked before
  the body `name` at the choke point. JSON-2 `read` of missing ids succeeds
  with `[]` (the ORM skips them); `write` is what raises `MissingError`.
  `res.partner.comment` is an Html field — the server wraps values in `<p>`,
  so integration round-trips use Char fields.
- **More live-verified facts (2026-07-10):** `name_search`'s second parameter
  was renamed `args` → `domain` in 19 — send it positionally over
  execute_kw (version-proof), by name (`domain`) on JSON-2. `name_get` was
  removed server-side in 17+ (document, don't polyfill). The report GET route
  `/report/<converter>/<reportname>/<docids>` (`auth="user"`) is byte-identical
  on 16–19 and CSRF-free (CSRF only guards http-POST) — cookie-session report
  downloads work on every version. `service="db"` still dispatches over the
  deprecated `/jsonrpc` on 19; `exp_restore` has NO neutralize param on any
  version. An unknown report name 500s (not 404). `web_search_read`/`web_read`/
  `web_save` accept a nested `specification` on **17+ only** (byte-identical
  shape across 17/18/19: m2o → `{id, name}` dict or `false`, x2many → nested
  list; 16 rejects the kwarg) and are plain model methods callable over every
  transport. `res.users.groups_id` was renamed `group_ids` in 19.

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

`VersionResolver` turns `server_version_info` into a `WireCapabilities` record
(wire capabilities only — product capabilities belong to the consumer);
transports fail fast with a tagged error (`ProtocolUnsupportedError`) when
asked to run against a server that can't serve them. 17+ private-method
`AccessError`s exist for methods callable in 16 — that's server policy, we
just map it.

## Error taxonomy

Distinct `_tag` per subtype — best `catchTag` ergonomics; never one blanket
error discriminated by field. One error file per concern.

```
OdooTransportError        # HTTP/network layer (sanitized; no raw request/cause)
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

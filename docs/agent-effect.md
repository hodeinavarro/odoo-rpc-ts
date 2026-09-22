# Effect implementation reference

Use when changing Effect services, schemas, HTTP, configuration or the beta pin.
Package paths are relative to the repository root.

## Effect-TS is the whole-app paradigm

Target the exact **Effect 4 beta** pinned in `package.json`. `effect` is an
exact peer dependency — never a hard dependency; the consumer owns the Effect
instance and provides its platform HttpClient layer (fetch/node/bun). Effect 4
betas are not semver-stable, so upgrade the peer, dev dependency, README, and
any private personal project consumer together. Nothing throws in operational
code — every operation returns
`Effect<A, E, R>`; declaration/programmer defects may use Effect's defect
channel.

- **HTTP:** depend only on the abstract `HttpClient` service from
  `effect/unstable/http`, re-exported through `src/internal/platform.ts`.
  Never import a node client in library source. Build requests with
  `HttpClientRequest`, decode with `HttpClientResponse.schemaJson`; re-tag
  `HttpClientError` into our union at the boundary.
- **Cookies:** the session-cookie mechanism is `Ref<Cookies>` +
  `HttpClient.withCookiesRef` (there is no CookieJar class);
  `Cookies.fromSetCookie` parses the login response.
- **Schema:** `effect/Schema` (core — `import { Schema } from "effect"`;
  the separate `@effect/schema` package no longer exists). No zod.
- **Errors:** wire-decoded faults are `Schema.TaggedError`; purely local
  errors are `Data.TaggedError`. Both `_tag`-discriminated so `catchTag`
  works across the whole union.
- **Services:** extend `Context.Service` with a stable package-qualified key
  and use hand-written `Layer`s. Keep construction explicit and testable.
- **Config:** `effect/Config` + `Config.redacted` for secrets;
  `Config.nested`/`Config.all` to build the struct. Library reads `Config`;
  the consumer chooses the `ConfigProvider`. No dotenv.
- **Secrets:** API keys and passwords held as `Redacted<string>`;
  `Redacted.value` only at the HTTP boundary. Never logged.
- **Logging:** Effect `Logger` + `Effect.annotateLogs` wide events.
- **Orchestration:** `Effect.gen` / `yield*`. Concurrency primitives from
  Effect (`Semaphore`, `Ref`, `Deferred`) — no ad-hoc promises.
- **Effect 4 decision (2026-07-12): the port is complete.** The package and a
  private personal project use the same exact beta. All unstable HTTP imports
  funnel through `src/internal/platform.ts`; keep that choke point and simple
  Schema checks so beta upgrades remain reviewable. Revisit the pin and APIs at
  v4 GA.

# AGENTS.md — odoo-rpc-ts

A generic, Effect-native, strongly-typed Odoo RPC client for TypeScript.
Reusable across projects; no assumptions about any particular host app.
Use [the Effect reference](docs/agent-effect.md) for services, schemas, HTTP or
release candidate upgrades, and [the protocol reference](docs/agent-protocol.md)
for transport, authentication, session, capability or error changes. Wire evidence is pinned in
[protocol verification](docs/protocol-verification.md); recheck the relevant
Odoo source when changing wire behavior.

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
- **Integration:** the checked-in Docker harness runs a disposable seeded
  Odoo for each supported version. `pnpm harness up <16.0|17.0|18.0|19.0>`,
  then `pnpm test:integration`; `pnpm harness down` tears it down. CI runs the
  four-version matrix independently; unit tests never require Docker.
- **Package:** ESM-only, `"type": "module"`, pnpm. `exports` map with a
  `./testing` entry point. Exact `effect` release candidate in
  `peerDependencies` and devDependencies; platform implementations only in
  devDependencies.

## Formatting & commits

- Exploded multi-line style with trailing commas (magic trailing comma) for
  clean add-later diffs. oxfmt is the arbiter — no manual style debates.
- **Atomic commits** — one logical change each.

## Invariants — do not regress

- Operational failures are tagged errors in the `Effect` fail channel;
  impossible declaration/programmer states may become explicit defects.
- Distinct `_tag` per fault subtype; upper layers never parse messages;
  unknown faults preserved, not swallowed.
- All three protocols normalize into the **same** error union at one choke
  point each.
- `effect/Schema` (core), not `@effect/schema`; `effect/Config`, not dotenv;
  abstract `HttpClient` tag, no bundled platform layer.
- TLS never disabled; secrets always `Redacted`; API keys never in URLs or logs.
- Auth/uid/version/session caches are success-only single-flight (never
  `Effect.cached`).
- No enums/namespaces (`erasableSyntaxOnly`); ESM only.
- Wire behavior claims in the protocol reference change only with a source-verified
  citation from the Odoo trees.

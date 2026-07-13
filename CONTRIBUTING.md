# Contributing

This is a public, pre-1.0 library published to the npm registry. Keep changes
generic: application models, workflows, UI, and persistence belong in the
consumer, while reusable Odoo wire and typed-client behavior belongs here.

Read [AGENTS.md](AGENTS.md) before changing protocol behavior. Wire claims must
be re-verified against the pinned snapshots in
[docs/protocol-verification.md](docs/protocol-verification.md), and protocol
changes need focused fixture or integration coverage.

## Local verification

Use Node 26 and pnpm 11.12.0, then run:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
pnpm pack --dry-run
```

The Docker integration harness is optional locally:

```sh
pnpm harness up 19.0
pnpm test:integration
pnpm harness down
```

CI runs that suite independently for every supported Odoo major. When a public
API changes, update and compile-check the README examples, then publish a new
package version. Update any private personal project consumer separately.
Follow [docs/publishing.md](docs/publishing.md) for the release process and
registry prerequisites.

Do not commit generated `dist/`, harness state, credentials, or package tokens.

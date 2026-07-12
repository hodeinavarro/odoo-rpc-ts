# Contributing

This is a private, pre-1.0 library published to GitHub Packages for private personal project. Keep
changes generic: host-app models, workflows, UI, and persistence belong in private personal project,
while reusable Odoo wire and typed-client behavior belongs here.

Read [AGENTS.md](AGENTS.md) before changing protocol behavior. Wire claims must
be re-verified against the supported Odoo source trees, and protocol changes
need focused fixture or integration coverage.

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
API changes, update and compile-check the README examples, publish a new package
version, then update the exact version and run the gates in private personal project.

Do not commit generated `dist/`, harness state, credentials, or package tokens.

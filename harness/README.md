# harness/ — disposable per-version Odoo integration environment

One parameterized compose stack (Postgres + Odoo) per Odoo major, built from the
official `odoo:<version>` base with **fresh upstream odoo/odoo source** overlaid.
`up` builds, starts, and creates the database with demo data for Accounting, CRM,
Project, Purchase, Sales, and Inventory. It then seeds an application-manager `rpc`
user and a plain internal-user principal with global API keys, then writes a
`.env` state file. Two versions run
**concurrently** — distinct compose projects, images, volumes and host ports.

```sh
pnpm harness up 16.0        # build + start + init + seed  → harness/.state/16.0/env
pnpm harness status         # which versions are running / seeded
pnpm harness logs 16.0      # follow logs
pnpm harness down 16.0      # stop (keep db + state)
pnpm harness reset 16.0     # WIPE volumes + state
```

The application/demo profile is checked on every `up`. A volume created by the old
base-only harness fails loudly with the reset command to run; the harness never
silently treats partially provisioned data as ready.

The seeded state file (`harness/.state/<version>/env`, gitignored) contains:
`ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME=rpc`, `ODOO_PASSWORD=rpc-integration`,
`ODOO_API_KEY`, the corresponding `ODOO_RESTRICTED_*` credentials,
`ODOO_HARNESS_VERSION`, and `ODOO_HARNESS_PROFILE`. API keys are captured only
at generation. The restricted user belongs only to `base.group_user`, allowing
integration specs to distinguish authentication failures from ACL denials.
The state root and per-version directories are owner-only (`0700`); the generated
state file is owner-readable only (`0600`). The seeding container never mounts that
directory: it emits an opaque, captured handoff that the CLI validates without
logging, then the host process creates the directory and file. This keeps the state
readable by the invoking host user on native Linux without weakening its at-rest
permissions. The Odoo HTTP port is bound to `127.0.0.1` only.
If an older native-Linux state directory is still owned by the container user, the
CLI reports the migration explicitly: remove that disposable version directory or
repair its ownership with sufficient privileges, then retry.

db credentials are templated into `odoo.conf` at container start via `envsubst`
(from the compose `environment:` block) — not hardcoded.

| version | host port |
| ------- | --------- |
| 16.0    | 8016      |
| 17.0    | 8017      |
| 18.0    | 8018      |
| 19.0    | 8019      |

> **NEVER PRODUCTION.** No admin master password, `list_db=True`, weak throwaway
> credentials, disposable volumes. Local use only — never expose or point at real data.

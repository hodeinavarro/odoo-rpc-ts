# Publishing to npm

`@hodeinavarro/odoo-rpc-ts` is a public package on the npm registry. Releases
are published from GitHub Actions with npm trusted publishing: the workflow
uses an OIDC identity instead of a long-lived registry token, and npm records
provenance for the public package and repository.

## One-time registry setup

npm trusted publishing can only be configured after the package exists. Verify
the scope and package name, then publish the bootstrap version publicly from a
maintainer account protected by 2FA:

```sh
npm publish --access public
```

That bootstrap version is already published by the command above: do not push a
matching `v<version>` tag afterward, because the tag workflow would try to
publish the same immutable version again. Configure trusted publishing, bump
`package.json` to the next version, and use the tag workflow starting with that
next release.

Then configure the package's trusted publisher on npmjs.com with these exact
values:

- Provider: GitHub Actions
- Organization or user: `hodeinavarro`
- Repository: `odoo-rpc-ts`
- Workflow filename: `publish.yml`
- Allowed action: `npm publish`

Do not configure an environment name unless the publish job is also changed to
use the same GitHub environment. After one OIDC release succeeds, set npm
publishing access to require 2FA and disallow tokens, then revoke any obsolete
automation tokens.

## Publish a release

The [publish workflow](../.github/workflows/publish.yml) runs for `v*` tags. It
validates the frozen dependency graph, typecheck, lint, and unit suite before
publishing directly to `https://registry.npmjs.org/`. Trusted publishing
requires npm 11.5.1 or newer, Node 22.14.0 or newer, and a GitHub-hosted runner;
the workflow uses Node 26 and verifies the npm minimum before publishing.

1. Choose a version that has never been published and update `package.json`.
2. Run the local gates and let the normal CI matrix pass on `main`.
3. Create and push the matching `v<version>` tag from the reviewed revision.
4. Confirm that npm shows the version as public and displays its provenance.

Protect release tags and restrict the publish workflow to reviewed revisions
in the GitHub repository settings. Never overwrite or delete-and-republish a
version: each version identifies one immutable package artifact.

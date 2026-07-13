# Security policy

Security fixes target the latest release published on npm. While the project is
pre-1.0, older releases are not guaranteed to receive backports. Report
suspected vulnerabilities privately by opening a draft repository security
advisory from GitHub's **Security** tab. Do not open a public issue containing
credentials, session cookies, API keys, exploit details, or customer data.

Include the affected revision, Odoo version and protocol, a minimal
reproduction, and the security impact. Use synthetic secrets and disposable
databases only.

The library treats passwords, API keys, database master passwords, and session
cookies as secrets. They must remain `Redacted` until the HTTP boundary and
must never appear in URLs, logs, error request snapshots, fixtures, or traces.

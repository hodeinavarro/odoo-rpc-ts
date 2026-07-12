# Security policy

This repository is private and does not currently publish supported releases.
Report suspected vulnerabilities privately by opening a draft repository
security advisory from GitHub's **Security** tab. Do not open a normal issue
containing credentials, session cookies, API keys, exploit details, or customer
data.

Include the affected revision, Odoo version and protocol, a minimal
reproduction, and the security impact. Use synthetic secrets and disposable
databases only.

The library treats passwords, API keys, database master passwords, and session
cookies as secrets. They must remain `Redacted` until the HTTP boundary and
must never appear in URLs, logs, error request snapshots, fixtures, or traces.

# Protocol verification record

The protocol contract is derived from Odoo source, not third-party summaries.
The current Odoo 16–19 claims were reviewed at these immutable public upstream
snapshots:

| Odoo | Source snapshot                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------ |
| 16.0 | [`6aca71c9522b3be5b221847e8b005f233d3ea872`](https://github.com/odoo/odoo/tree/6aca71c9522b3be5b221847e8b005f233d3ea872) |
| 17.0 | [`c7953a5283e7a07e77b809c521fc372d476c2c67`](https://github.com/odoo/odoo/tree/c7953a5283e7a07e77b809c521fc372d476c2c67) |
| 18.0 | [`e37f0420450ed2c8f465305b19cbbcfa78162666`](https://github.com/odoo/odoo/tree/e37f0420450ed2c8f465305b19cbbcfa78162666) |
| 19.0 | [`c5f1a963e6c65cf67b56b7ca2d4b77de66140e78`](https://github.com/odoo/odoo/tree/c5f1a963e6c65cf67b56b7ca2d4b77de66140e78) |

## Source map

At each snapshot, the shared protocol review covered these paths:

- `odoo/http.py`: request dispatch, sessions, JSON-RPC envelopes, and
  serialized failures; Odoo 19 also contains `Json2Dispatcher`.
- `odoo/service/model.py`: `execute_kw` and model-call dispatch.
- `odoo/service/db.py`: database-service dispatch, including `exp_restore`.
- `addons/web/controllers/session.py`: web-session authentication.
- `addons/web/controllers/dataset.py`: the web `call_kw` route.
- `addons/web/controllers/report.py`: authenticated report downloads.
- `addons/web/models/ir_http.py`: session information returned to clients.
- `odoo/addons/base/models/res_users.py`: authentication and API-key behavior.

Odoo 16–18 additionally expose `/jsonrpc` through
`odoo/addons/base/controllers/rpc.py`. The Odoo 19 protocol entry points and
JSON-2 fixtures are available at these immutable paths:

- [`addons/rpc/controllers/jsonrpc.py`](https://github.com/odoo/odoo/blob/c5f1a963e6c65cf67b56b7ca2d4b77de66140e78/addons/rpc/controllers/jsonrpc.py)
- [`addons/rpc/controllers/json2.py`](https://github.com/odoo/odoo/blob/c5f1a963e6c65cf67b56b7ca2d4b77de66140e78/addons/rpc/controllers/json2.py)
- [`odoo/http.py`](https://github.com/odoo/odoo/blob/c5f1a963e6c65cf67b56b7ca2d4b77de66140e78/odoo/http.py)
- [`odoo/addons/test_http/tests/test_webjson2.py`](https://github.com/odoo/odoo/blob/c5f1a963e6c65cf67b56b7ca2d4b77de66140e78/odoo/addons/test_http/tests/test_webjson2.py)

## Reproduce the source review

Fetch `https://github.com/odoo/odoo.git`, detach one worktree at each commit
above, and inspect the listed paths. A protocol change must update this record
to the exact new commits, identify the affected paths, and add focused fixture
or integration coverage. Live observations are useful corroboration, but source
snapshots and checked-in tests are the reproducible basis for repository claims.

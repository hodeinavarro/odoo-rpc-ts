# Harness seed — runs inside `odoo shell` AFTER the db is initialised with base,web.
# Idempotently provisions the integration test principal and emits a .env state file:
#   - user "rpc" (login rpc / password rpc-integration), in base.group_system so
#     client ops on res.partner et al. work; no 2FA, so password auth works too.
#   - a global (scope=None) API key for that user — satisfies scope='rpc' checks on
#     16/17 AND the JSON-2 bearer path on 19.
#
# The generated key is returned ONLY at creation time, so we write it immediately to
# a mounted host dir: /harness-state/<version>/env (bind of harness/.state/<version>).
#
# `odoo shell` exposes `env` (and `self`). We commit explicitly since shell scripts
# run in a transaction that is rolled back unless committed.
import inspect
import os

LOGIN = "rpc"
PASSWORD = "rpc-integration"
KEY_NAME = "odoo-rpc-ts integration"

version = os.environ["ODOO_HARNESS_VERSION"]
db = os.environ["ODOO_HARNESS_DB"]
port = os.environ["ODOO_HARNESS_PORT"]
# Master password gating db-management ops (templated into odoo.conf). Default
# "master" mirrors the compose/cli default; recorded so the db suite can use it.
master_password = os.environ.get("ODOO_HARNESS_MASTER_PASSWORD", "master")
state_dir = os.environ.get("ODOO_HARNESS_STATE_DIR", "/harness-state")

Users = env["res.users"].sudo()
group_system = env.ref("base.group_system")
group_user = env.ref("base.group_user")
# Contact Creation: group_system alone does NOT grant res.partner create/unlink,
# and the integration suite round-trips partners.
group_partner = env.ref("base.group_partner_manager")

# Odoo 19 renamed res.users.groups_id -> group_ids; pick whichever exists.
groups_field = "group_ids" if "group_ids" in Users._fields else "groups_id"

user = Users.search([("login", "=", LOGIN)], limit=1)
if not user:
    user = Users.create(
        {
            "name": "RPC Integration",
            "login": LOGIN,
            "password": PASSWORD,
            groups_field: [(6, 0, [group_system.id, group_user.id, group_partner.id])],
        }
    )
    print(f"harness-seed: created user {LOGIN} (id={user.id})")
else:
    user.write(
        {
            "password": PASSWORD,
            groups_field: [(4, group_system.id), (4, group_user.id), (4, group_partner.id)],
        }
    )
    print(f"harness-seed: user {LOGIN} already exists (id={user.id}) — ensured groups/password")

# --- API key -----------------------------------------------------------------
# res.users.apikeys._generate arity differs across majors:
#   16/17: _generate(scope, name)
#   18/19: _generate(scope, name, expiration_date)
# Introspect the signature and pass scope=None (global key) either way.
ApiKeys = env["res.users.apikeys"].with_user(user).sudo(False)
gen = ApiKeys._generate
params = inspect.signature(gen).parameters
kwargs = {}
if "expiration_date" in params:
    # 18/19 require the arg; None = never expires (disposable harness).
    kwargs["expiration_date"] = None

try:
    api_key = gen(None, KEY_NAME, **kwargs)
except TypeError:
    # Belt-and-braces: if introspection was fooled, try the 3-arg form then 2-arg.
    try:
        api_key = gen(None, KEY_NAME, None)
    except TypeError:
        api_key = gen(None, KEY_NAME)

print("harness-seed: generated API key")

env.cr.commit()

# --- state file --------------------------------------------------------------
out_dir = os.path.join(state_dir, version)
os.makedirs(out_dir, exist_ok=True)
out_path = os.path.join(out_dir, "env")
lines = [
    f"ODOO_URL=http://localhost:{port}",
    f"ODOO_DB={db}",
    "ODOO_USERNAME=rpc",
    f"ODOO_PASSWORD={PASSWORD}",
    f"ODOO_API_KEY={api_key}",
    f"ODOO_MASTER_PASSWORD={master_password}",
    f"ODOO_HARNESS_VERSION={version}",
    "",
]
with open(out_path, "w") as fh:
    fh.write("\n".join(lines))

print(f"harness-seed: wrote state file {out_path}")

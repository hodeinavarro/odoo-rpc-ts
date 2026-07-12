# Harness seed — runs inside `odoo shell` after the application-demo profile is installed.
# Idempotently provisions two integration principals and emits a .env state file:
#   - user "rpc" (login rpc / password rpc-integration), in base.group_system so
#     client ops on res.partner et al. work; no 2FA, so password auth works too.
#   - user "rpc-restricted", in base.group_user only, for real ACL-denial specs.
#   - a global (scope=None) API key for each user — satisfies scope='rpc' checks
#     on 16/17 AND the JSON-2 bearer path on 19.
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
RESTRICTED_LOGIN = "rpc-restricted"
RESTRICTED_PASSWORD = "rpc-restricted-integration"
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
application_groups = [
    env.ref("account.group_account_manager"),
    env.ref("project.group_project_manager"),
    env.ref("purchase.group_purchase_manager"),
    env.ref("sales_team.group_sale_manager"),
    env.ref("stock.group_stock_manager"),
]
group_ids = [group_system.id, group_user.id, group_partner.id] + [
    group.id for group in application_groups
]

# Odoo 19 renamed res.users.groups_id -> group_ids; pick whichever exists.
groups_field = "group_ids" if "group_ids" in Users._fields else "groups_id"

def ensure_user(login, password, name, groups, replace_groups=False):
    user = Users.search([("login", "=", login)], limit=1)
    group_command = (
        [(6, 0, groups)] if replace_groups else [(4, group_id) for group_id in groups]
    )
    if not user:
        user = Users.create(
            {
                "name": name,
                "login": login,
                "password": password,
                groups_field: [(6, 0, groups)],
            }
        )
        print(f"harness-seed: created user {login} (id={user.id})")
    else:
        user.write({"password": password, groups_field: group_command})
        print(f"harness-seed: user {login} already exists — ensured groups/password")
    return user


user = ensure_user(LOGIN, PASSWORD, "RPC Integration", group_ids)
restricted_user = ensure_user(
    RESTRICTED_LOGIN,
    RESTRICTED_PASSWORD,
    "RPC Restricted Integration",
    [group_user.id],
    replace_groups=True,
)


def generate_api_key(key_user, name):
    # res.users.apikeys._generate arity differs across majors:
    #   16/17: _generate(scope, name)
    #   18/19: _generate(scope, name, expiration_date)
    api_keys = env["res.users.apikeys"].with_user(key_user).sudo(False)
    generate = api_keys._generate
    kwargs = {}
    if "expiration_date" in inspect.signature(generate).parameters:
        kwargs["expiration_date"] = None

    try:
        return generate(None, name, **kwargs)
    except TypeError:
        try:
            return generate(None, name, None)
        except TypeError:
            return generate(None, name)


api_key = generate_api_key(user, KEY_NAME)
restricted_api_key = generate_api_key(restricted_user, f"{KEY_NAME} restricted")
print("harness-seed: generated API keys")

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
    f"ODOO_RESTRICTED_USERNAME={RESTRICTED_LOGIN}",
    f"ODOO_RESTRICTED_PASSWORD={RESTRICTED_PASSWORD}",
    f"ODOO_RESTRICTED_API_KEY={restricted_api_key}",
    f"ODOO_MASTER_PASSWORD={master_password}",
    f"ODOO_HARNESS_VERSION={version}",
    "ODOO_HARNESS_PROFILE=applications-demo-v2",
    "",
]
with open(out_path, "w") as fh:
    fh.write("\n".join(lines))

print(f"harness-seed: wrote state file {out_path}")

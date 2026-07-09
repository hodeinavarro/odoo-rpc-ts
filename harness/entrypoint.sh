#!/usr/bin/env bash
# Harness container entrypoint: render odoo.conf from env, wait for Postgres, exec.
# Explicit (not the stock image entrypoint) so the harness CLI stays in control.
set -euo pipefail

DB_HOST="${ODOO_HARNESS_DB_HOST:-db}"
DB_PORT="${ODOO_HARNESS_DB_PORT:-5432}"

# Template odoo.conf: substitute ONLY our ODOO_HARNESS_* vars so any literal `$`
# elsewhere in the file survives. envsubst comes from gettext-base (Dockerfile).
envsubst '${ODOO_HARNESS_DB_HOST} ${ODOO_HARNESS_DB_PORT} ${ODOO_HARNESS_DB_USER} ${ODOO_HARNESS_DB_PASSWORD}' \
  < /etc/odoo/odoo.conf.template > /etc/odoo/odoo.conf

echo "harness-entrypoint: waiting for postgres at ${DB_HOST}:${DB_PORT}..."
# python3 is always present in the Odoo image; avoids depending on pg_isready/nc.
until python3 - "$DB_HOST" "$DB_PORT" <<'PY' 2>/dev/null
import socket, sys
s = socket.socket(); s.settimeout(2)
s.connect((sys.argv[1], int(sys.argv[2]))); s.close()
PY
do
  sleep 1
done
echo "harness-entrypoint: postgres is up — exec: $*"

exec "$@"

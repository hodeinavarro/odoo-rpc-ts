# Harness Odoo image: the official `odoo:<major>` base (OS + python + all of Odoo's
# Python deps as system packages + wkhtmltopdf + fonts + the `odoo` launcher) with
# FRESH odoo/odoo <ref> SOURCE overlaid on top — the pinned base image lags the
# still-active stable branch, and we want to test the RPC client against REAL
# upstream source, not a months-old snapshot. We overlay only the code and inherit
# the base image's Python deps (they satisfy the stable branch's requirements).
# Vanilla Community core only — never Enterprise.
ARG ODOO_HARNESS_BASE=odoo:16.0
FROM ${ODOO_HARNESS_BASE}

USER root
# Branch / tag / commit SHA to fetch. odoo/odoo has a massive history — a DEPTH-1
# fetch pulls EXACTLY this ref's tree (one commit, no packs), not gigabytes.
ARG ODOO_HARNESS_REF=16.0
RUN set -eux; \
    . /etc/os-release; \
    if [ "${VERSION_CODENAME}" = bullseye ]; then \
        # The EOL security index advertises missing files (Debian #1147150).
        # This disposable harness uses the signed main archive for build tools.
        printf '%s\n' 'deb https://archive.debian.org/debian bullseye main' > /etc/apt/sources.list; \
        rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; \
        rm -rf /var/lib/apt/lists/*; \
    fi; \
    apt-get update && apt-get install -y --no-install-recommends git gettext-base; \
    mkdir -p /opt/odoo; cd /opt/odoo; \
    git init -q; \
    git remote add origin https://github.com/odoo/odoo; \
    git fetch -q --depth 1 origin "${ODOO_HARNESS_REF}"; \
    git checkout -q FETCH_HEAD; \
    rm -rf /opt/odoo/.git; \
    # Drop the deb-installed odoo CODE so it can't shadow the fresh source. The
    # python DEPS (python3-lxml/ldap/…) are separate apt packages — left intact.
    rm -rf /usr/lib/python3/dist-packages/odoo; \
    # gettext-base stays: entrypoint uses `envsubst` to template odoo.conf.
    apt-get purge -y git; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*

# Resolve `import odoo` (and the stock `odoo` launcher) to the fresh source only.
ENV PYTHONPATH=/opt/odoo
USER odoo

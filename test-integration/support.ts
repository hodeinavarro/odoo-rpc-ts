/**
 * Shared wiring for the LIVE integration suite. Nothing here runs unless a
 * harness stack is up: {@link hasStack} gates every spec, so a machine without
 * a running Odoo skips cleanly instead of failing.
 *
 * The harness (built concurrently under `harness/`) hands us a `.env`-format
 * state file whose keys arrive as process env vars: `ODOO_URL`, `ODOO_DB`,
 * `ODOO_USERNAME`, `ODOO_PASSWORD`, `ODOO_API_KEY`, `ODOO_HARNESS_VERSION`.
 *
 * We deliberately build {@link OdooConfig} values by hand from those vars rather
 * than through `OdooConfig` (the ambient-`ConfigProvider` reader) because a
 * single stack exposes BOTH an API key and a password, and `OdooConfig` always
 * prefers the key — the web/password specs need to force the `Password` branch.
 */
import { Redacted } from "effect";
import type { OdooConfig } from "../src/index.ts";

/** Read a required env var; only ever called behind {@link hasStack}. */
const env = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`integration: missing required env var ${name} (is a harness stack up?)`);
  }
  return value;
};

/** Whether a live stack is reachable. The whole suite skips when false. */
export const hasStack: boolean =
  process.env["ODOO_URL"] !== undefined && process.env["ODOO_URL"] !== "";

/** The running server's major version (e.g. `19` for `ODOO_HARNESS_VERSION=19.0`). */
export const majorVersion: number = hasStack
  ? Number.parseInt((process.env["ODOO_HARNESS_VERSION"] ?? "0").split(".")[0] ?? "0", 10)
  : 0;

/** Generous per-test timeout: cold auth + a live round trip can be slow. */
export const TIMEOUT_MS = 60_000;

const url = (): URL => new URL(env("ODOO_URL"));

/** API-key config — server-to-server; drives `JsonRpcTransport` and `Json2Transport`. */
export const apiKeyConfig = (): OdooConfig => ({
  url: url(),
  db: env("ODOO_DB"),
  credentials: {
    _tag: "ApiKey",
    username: env("ODOO_USERNAME"),
    apiKey: Redacted.make(env("ODOO_API_KEY")),
  },
});

/** Password config — the login-password branch; drives `WebTransport` / `CookieSession`. */
export const passwordConfig = (): OdooConfig => ({
  url: url(),
  db: env("ODOO_DB"),
  credentials: {
    _tag: "Password",
    username: env("ODOO_USERNAME"),
    password: Redacted.make(env("ODOO_PASSWORD")),
  },
});

/** Valid API-key credentials for the plain internal user with no application groups. */
export const restrictedApiKeyConfig = (): OdooConfig => ({
  url: url(),
  db: env("ODOO_DB"),
  credentials: {
    _tag: "ApiKey",
    username: env("ODOO_RESTRICTED_USERNAME"),
    apiKey: Redacted.make(env("ODOO_RESTRICTED_API_KEY")),
  },
});

/** Valid password credentials for the plain internal user with no application groups. */
export const restrictedPasswordConfig = (): OdooConfig => ({
  url: url(),
  db: env("ODOO_DB"),
  credentials: {
    _tag: "Password",
    username: env("ODOO_RESTRICTED_USERNAME"),
    password: Redacted.make(env("ODOO_RESTRICTED_PASSWORD")),
  },
});

/** An API-key config carrying a deliberately wrong key (auth-failure specs). */
export const badApiKeyConfig = (): OdooConfig => ({
  ...apiKeyConfig(),
  credentials: {
    _tag: "ApiKey",
    username: env("ODOO_USERNAME"),
    apiKey: Redacted.make("definitely-not-a-valid-api-key"),
  },
});

/** A password config carrying a deliberately wrong password (auth-failure specs). */
export const badPasswordConfig = (): OdooConfig => ({
  ...passwordConfig(),
  credentials: {
    _tag: "Password",
    username: env("ODOO_USERNAME"),
    password: Redacted.make("definitely-not-the-right-password"),
  },
});

/** A unique, greppable name prefix so created records never collide or leak. */
export const marker = (): string =>
  `odoo-rpc-ts-it-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** An id that cannot exist, for missing-record fault specs. */
export const BOGUS_ID = 999_999_999;

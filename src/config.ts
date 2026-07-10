import { Config, Effect, Option, Schema, SchemaIssue, type Redacted } from "effect";

/**
 * How the client authenticates. A tagged union so downstream auth layers
 * branch on `_tag` rather than probing which secret is present. Both secrets
 * are `Redacted` — never logged, never serialized.
 *
 * - `ApiKey` — server-to-server; the API key is sent as the password on the
 *   web/JSON-RPC routes, or as a bearer token on JSON-2.
 * - `Password` — a login password (only valid for accounts without 2FA).
 */
export type OdooCredentials =
  | {
      readonly _tag: "ApiKey";
      readonly username: string;
      readonly apiKey: Redacted.Redacted<string>;
    }
  | {
      readonly _tag: "Password";
      readonly username: string;
      readonly password: Redacted.Redacted<string>;
    };

/** Fully-resolved client configuration. No field has a default: zero assumptions. */
export interface OdooConfig {
  readonly url: URL;
  readonly db: string;
  readonly credentials: OdooCredentials;
}

/**
 * A config validation failure on the offending raw value. v4's `ConfigError`
 * wraps a `SchemaError` (data found but invalid) — the analogue of v3's
 * `ConfigError.InvalidData`.
 */
const invalidData = (value: unknown, message: string): Config.ConfigError =>
  new Config.ConfigError(
    new Schema.SchemaError(new SchemaIssue.InvalidValue(Option.some(value), { message })),
  );

/**
 * Parse and validate the `ODOO_URL` value: must be a well-formed absolute URL,
 * and must be `https` unless it targets localhost / a loopback address. TLS is
 * never silently disabled.
 */
const parseUrl = (raw: string): Effect.Effect<URL, Config.ConfigError> => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return Effect.fail(invalidData(raw, `Not a valid URL: ${raw}`));
  }

  const isLoopback =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "::1";

  if (url.protocol !== "https:" && !isLoopback) {
    return Effect.fail(
      invalidData(raw, `Refusing non-https URL to a non-localhost host: ${raw}`),
    );
  }

  return Effect.succeed(url);
};

const urlConfig: Config.Config<URL> = Config.string("URL").pipe(Config.mapOrFail(parseUrl));

const apiKeyCredentials: Config.Config<OdooCredentials> = Config.all({
  username: Config.string("USERNAME"),
  apiKey: Config.redacted("API_KEY"),
}).pipe(Config.map((c) => ({ _tag: "ApiKey" as const, ...c })));

const passwordCredentials: Config.Config<OdooCredentials> = Config.all({
  username: Config.string("USERNAME"),
  password: Config.redacted("PASSWORD"),
}).pipe(Config.map((c) => ({ _tag: "Password" as const, ...c })));

/**
 * Prefer an API key when `ODOO_API_KEY` is present; otherwise fall back to a
 * login password (`ODOO_PASSWORD`). If neither secret is set, config resolution
 * fails loudly — there is no anonymous default.
 */
const credentialsConfig: Config.Config<OdooCredentials> = apiKeyCredentials.pipe(
  Config.orElse(() => passwordCredentials),
);

/**
 * The client configuration, read from environment (or any `ConfigProvider`)
 * under the `ODOO_` prefix: `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`, and one of
 * `ODOO_API_KEY` / `ODOO_PASSWORD`.
 */
export const OdooConfig: Config.Config<OdooConfig> = Config.all({
  url: urlConfig,
  db: Config.string("DB"),
  credentials: credentialsConfig,
}).pipe(Config.nested("ODOO"));

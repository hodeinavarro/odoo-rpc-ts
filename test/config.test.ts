import { assert, describe, it } from "@effect/vitest";
import { Cause, ConfigProvider, Effect, Redacted } from "effect";
import { OdooConfig } from "../src/config.ts";

// v4: providers install per-parse (Config.parse) instead of Effect.withConfigProvider;
// fromEnv joins path segments with `_`, so keys read ODOO_URL, not ODOO.URL.
const provider = (entries: Record<string, string>) => ConfigProvider.fromEnv({ env: entries });

const load = (entries: Record<string, string>) => OdooConfig.parse(provider(entries));

describe("OdooConfig", () => {
  it.effect("parses an https URL + API-key credentials", () =>
    Effect.gen(function* () {
      const cfg = yield* load({
        "ODOO_URL": "https://erp.example.com",
        "ODOO_DB": "prod",
        "ODOO_USERNAME": "svc",
        "ODOO_API_KEY": "secret-key",
      });
      assert.strictEqual(cfg.url.href, "https://erp.example.com/");
      assert.strictEqual(cfg.db, "prod");
      assert.strictEqual(cfg.credentials._tag, "ApiKey");
      if (cfg.credentials._tag === "ApiKey") {
        assert.strictEqual(cfg.credentials.username, "svc");
        assert.strictEqual(Redacted.value(cfg.credentials.apiKey), "secret-key");
      }
    }),
  );

  it.effect("falls back to password credentials when no API key is set", () =>
    Effect.gen(function* () {
      const cfg = yield* load({
        "ODOO_URL": "https://erp.example.com",
        "ODOO_DB": "prod",
        "ODOO_USERNAME": "svc",
        "ODOO_PASSWORD": "pw",
      });
      assert.strictEqual(cfg.credentials._tag, "Password");
      if (cfg.credentials._tag === "Password") {
        assert.strictEqual(Redacted.value(cfg.credentials.password), "pw");
      }
    }),
  );

  it.effect("allows http only for loopback hosts", () =>
    Effect.gen(function* () {
      const cfg = yield* load({
        "ODOO_URL": "http://localhost:8069",
        "ODOO_DB": "dev",
        "ODOO_USERNAME": "admin",
        "ODOO_API_KEY": "k",
      });
      assert.strictEqual(cfg.url.hostname, "localhost");
    }),
  );

  it.effect("rejects http to a non-loopback host", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        load({
          "ODOO_URL": "http://erp.example.com",
          "ODOO_DB": "prod",
          "ODOO_USERNAME": "svc",
          "ODOO_API_KEY": "k",
        }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("rejects secret-bearing URL components without echoing their values", () =>
    Effect.gen(function* () {
      const secretUrl =
        "https://url-user:url-password@erp.example.com?access_token=query-secret#fragment-secret";
      const exit = yield* Effect.exit(
        load({
          "ODOO_URL": secretUrl,
          "ODOO_DB": "prod",
          "ODOO_USERNAME": "svc",
          "ODOO_API_KEY": "k",
        }),
      );

      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const rendered = `${Cause.pretty(exit.cause)} ${JSON.stringify(exit.cause)}`;
        assert.notInclude(rendered, "url-user");
        assert.notInclude(rendered, "url-password");
        assert.notInclude(rendered, "query-secret");
        assert.notInclude(rendered, "fragment-secret");
      }
    }),
  );

  it.effect("fails when no credentials are provided", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        load({
          "ODOO_URL": "https://erp.example.com",
          "ODOO_DB": "prod",
          "ODOO_USERNAME": "svc",
        }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("fails when the URL is missing (no default)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        load({
          "ODOO_DB": "prod",
          "ODOO_USERNAME": "svc",
          "ODOO_API_KEY": "k",
        }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );
});

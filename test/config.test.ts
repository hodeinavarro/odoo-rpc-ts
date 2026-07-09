import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Redacted } from "effect";
import { OdooConfig } from "../src/config.ts";

const provider = (entries: Record<string, string>) =>
  ConfigProvider.fromMap(new Map(Object.entries(entries)));

const load = (entries: Record<string, string>) =>
  OdooConfig.pipe(Effect.withConfigProvider(provider(entries)));

describe("OdooConfig", () => {
  it.effect("parses an https URL + API-key credentials", () =>
    Effect.gen(function* () {
      const cfg = yield* load({
        "ODOO.URL": "https://erp.example.com",
        "ODOO.DB": "prod",
        "ODOO.USERNAME": "svc",
        "ODOO.API_KEY": "secret-key",
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
        "ODOO.URL": "https://erp.example.com",
        "ODOO.DB": "prod",
        "ODOO.USERNAME": "svc",
        "ODOO.PASSWORD": "pw",
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
        "ODOO.URL": "http://localhost:8069",
        "ODOO.DB": "dev",
        "ODOO.USERNAME": "admin",
        "ODOO.API_KEY": "k",
      });
      assert.strictEqual(cfg.url.hostname, "localhost");
    }),
  );

  it.effect("rejects http to a non-loopback host", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        load({
          "ODOO.URL": "http://erp.example.com",
          "ODOO.DB": "prod",
          "ODOO.USERNAME": "svc",
          "ODOO.API_KEY": "k",
        }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("fails when no credentials are provided", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        load({
          "ODOO.URL": "https://erp.example.com",
          "ODOO.DB": "prod",
          "ODOO.USERNAME": "svc",
        }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );

  it.effect("fails when the URL is missing (no default)", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        load({
          "ODOO.DB": "prod",
          "ODOO.USERNAME": "svc",
          "ODOO.API_KEY": "k",
        }),
      );
      assert.strictEqual(exit._tag, "Failure");
    }),
  );
});

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Redacted } from "effect";
import type { OdooConfig } from "../src/config.ts";
import {
  InMemoryProfileStorage,
  InMemorySecretStore,
  layer as profilesLayer,
  type ProfileData,
  Profiles,
  ProfileSecretMissingError,
  ProfileStorage,
  ProfileStoreError,
  SecretStore,
} from "../src/profiles.ts";

const apiKeyConfig: OdooConfig = {
  url: new URL("https://odoo.test/"),
  db: "prod",
  credentials: {
    _tag: "ApiKey",
    username: "svc@odoo.test",
    apiKey: Redacted.make("sk-super-secret-key"),
  },
};

const passwordConfig: OdooConfig = {
  url: new URL("https://odoo.test/"),
  db: "prod",
  credentials: {
    _tag: "Password",
    username: "alice@odoo.test",
    password: Redacted.make("hunter2-do-not-leak"),
  },
};

const inMemory = Layer.provideMerge(
  profilesLayer,
  Layer.merge(InMemorySecretStore.layer, InMemoryProfileStorage.layer),
);

describe("Profiles", () => {
  it.effect("round-trips an api-key profile through save/load", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      yield* profiles.saveProfile("prod-api", apiKeyConfig, "json-rpc");

      const loaded = yield* profiles.loadProfile("prod-api");
      assert.strictEqual(loaded._tag, "credentials");
      assert.strictEqual(loaded.protocol, "json-rpc");
      if (loaded._tag === "credentials") {
        assert.strictEqual(loaded.config.url.href, "https://odoo.test/");
        assert.strictEqual(loaded.config.db, "prod");
        assert.strictEqual(loaded.config.credentials._tag, "ApiKey");
        assert.strictEqual(loaded.config.credentials.username, "svc@odoo.test");
        if (loaded.config.credentials._tag === "ApiKey") {
          assert.strictEqual(
            Redacted.value(loaded.config.credentials.apiKey),
            "sk-super-secret-key",
          );
        }
      }
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("round-trips a password profile through save/load", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      yield* profiles.saveProfile("prod-pw", passwordConfig, "web");

      const loaded = yield* profiles.loadProfile("prod-pw");
      assert.strictEqual(loaded.protocol, "web");
      assert.strictEqual(loaded._tag, "credentials");
      if (loaded._tag === "credentials") {
        assert.strictEqual(loaded.config.credentials._tag, "Password");
        if (loaded.config.credentials._tag === "Password") {
          assert.strictEqual(
            Redacted.value(loaded.config.credentials.password),
            "hunter2-do-not-leak",
          );
        }
      }
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("CRITICAL: serialized profile metadata never contains secret material", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      yield* profiles.saveProfile("prod-api", apiKeyConfig, "json-rpc");
      yield* profiles.saveProfile("prod-pw", passwordConfig, "web");

      // What ProfileStorage persists is the ONLY thing that ever gets serialized.
      const stored = yield* profiles.listProfiles();
      const serialized = JSON.stringify(stored);

      assert.notInclude(serialized, "sk-super-secret-key");
      assert.notInclude(serialized, "hunter2-do-not-leak");

      // The metadata is present and correct, just secret-free.
      const apiMeta = stored["prod-api"] as ProfileData;
      assert.strictEqual(apiMeta.credentialKind, "api-key");
      if (apiMeta.credentialKind === "api-key") {
        assert.strictEqual(apiMeta.username, "svc@odoo.test");
      }
      assert.notProperty(apiMeta, "apiKey");
      assert.notProperty(apiMeta, "password");

      // The secret is reachable ONLY through the SecretStore, under its account.
      const secrets = yield* SecretStore;
      const direct = yield* secrets.get("prod-api:api-key");
      assert.isTrue(Option.isSome(direct));
      if (Option.isSome(direct)) {
        assert.strictEqual(Redacted.value(direct.value), "sk-super-secret-key");
        // Even the Redacted wrapper refuses to serialize the payload.
        assert.notInclude(JSON.stringify(direct.value), "sk-super-secret-key");
      }
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("loadProfile fails with ProfileSecretMissingError when the secret is gone", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      const secrets = yield* SecretStore;
      yield* profiles.saveProfile("prod-api", apiKeyConfig, "json-rpc");

      // Drop the secret out of band, leaving orphaned metadata behind.
      yield* secrets.remove("prod-api:api-key");

      const error = yield* profiles.loadProfile("prod-api").pipe(Effect.flip);
      assert.instanceOf(error, ProfileSecretMissingError);
      assert.strictEqual(error.name, "prod-api");
      assert.strictEqual(error.account, "prod-api:api-key");
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("loadProfile fails with ProfileSecretMissingError for an unknown profile", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      const error = yield* profiles.loadProfile("nope").pipe(Effect.flip);
      assert.instanceOf(error, ProfileSecretMissingError);
      assert.strictEqual(error.name, "nope");
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("removeProfile deletes the secret FIRST — even when the metadata save then fails", () =>
    Effect.gen(function* () {
      const secrets = yield* SecretStore;
      // Pre-store the secret the seeded metadata points at.
      yield* secrets.set("prod-api:api-key", Redacted.make("sk-super-secret-key"));

      const profiles = yield* Profiles;
      const exit = yield* profiles.removeProfile("prod-api").pipe(Effect.exit);

      // The metadata save fails loudly...
      assert.isTrue(Exit.isFailure(exit));

      // ...but the secret was already removed — no orphaned credential left behind.
      const after = yield* secrets.get("prod-api:api-key");
      assert.isTrue(Option.isNone(after));
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          profilesLayer,
          Layer.merge(InMemorySecretStore.layer, failingStorageForRemoval()),
        ),
      ),
    ),
  );

  it.effect("removeProfile drops both metadata and secret on the happy path", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      const secrets = yield* SecretStore;
      yield* profiles.saveProfile("prod-api", apiKeyConfig, "json-rpc");

      yield* profiles.removeProfile("prod-api");

      const listed = yield* profiles.listProfiles();
      assert.notProperty(listed, "prod-api");
      const secret = yield* secrets.get("prod-api:api-key");
      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("round-trips a harvested-session profile through saveSessionProfile/load", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      const cookie = Redacted.make("f00dfaceharvestedsessioncookie");
      yield* profiles.saveSessionProfile("prod-session", new URL("https://odoo.test/"), cookie);

      const loaded = yield* profiles.loadProfile("prod-session");
      assert.strictEqual(loaded._tag, "session");
      if (loaded._tag === "session") {
        // The session arm carries url + cookie — the exact fromExisting inputs.
        assert.strictEqual(loaded.url.href, "https://odoo.test/");
        assert.strictEqual(Redacted.value(loaded.sessionId), "f00dfaceharvestedsessioncookie");
        assert.strictEqual(loaded.protocol, "web");
        // NEVER a fabricated OdooConfig with fake credentials.
        assert.notProperty(loaded, "config");
      }
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("CRITICAL: session metadata never contains the cookie value", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      yield* profiles.saveSessionProfile(
        "prod-session",
        new URL("https://odoo.test/"),
        Redacted.make("f00dfaceharvestedsessioncookie"),
      );

      const stored = yield* profiles.listProfiles();
      assert.notInclude(JSON.stringify(stored), "f00dfaceharvestedsessioncookie");
      const meta = stored["prod-session"] as ProfileData;
      assert.strictEqual(meta.credentialKind, "session");
      assert.strictEqual(meta.protocol, "web");
      assert.notProperty(meta, "username");
      assert.notProperty(meta, "db");

      // The cookie is reachable ONLY through the SecretStore, under its account.
      const secrets = yield* SecretStore;
      const direct = yield* secrets.get("prod-session:session");
      assert.isTrue(Option.isSome(direct));
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("loadProfile fails with ProfileSecretMissingError when the cookie is gone", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      const secrets = yield* SecretStore;
      yield* profiles.saveSessionProfile(
        "prod-session",
        new URL("https://odoo.test/"),
        Redacted.make("f00dfaceharvestedsessioncookie"),
      );
      yield* secrets.remove("prod-session:session");

      const error = yield* profiles.loadProfile("prod-session").pipe(Effect.flip);
      assert.instanceOf(error, ProfileSecretMissingError);
      assert.strictEqual(error.account, "prod-session:session");
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("removeProfile drops a session profile's cookie and metadata", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      const secrets = yield* SecretStore;
      yield* profiles.saveSessionProfile(
        "prod-session",
        new URL("https://odoo.test/"),
        Redacted.make("f00dfaceharvestedsessioncookie"),
      );

      yield* profiles.removeProfile("prod-session");

      const listed = yield* profiles.listProfiles();
      assert.notProperty(listed, "prod-session");
      const secret = yield* secrets.get("prod-session:session");
      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("removeProfile is a no-op for an unknown profile", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      yield* profiles.removeProfile("nope"); // must not fail
      const listed = yield* profiles.listProfiles();
      assert.deepStrictEqual(listed, {});
    }).pipe(Effect.provide(inMemory)),
  );
});

/**
 * A {@link ProfileStorage} that seeds one `prod-api` profile on load and always
 * fails on save — used to prove `removeProfile` deletes the secret before it
 * touches (and here, fails to persist) metadata.
 */
const failingStorageForRemoval = (): Layer.Layer<ProfileStorage> =>
  Layer.succeed(ProfileStorage, {
    load: () =>
      Effect.succeed<Record<string, ProfileData>>({
        "prod-api": {
          url: "https://odoo.test/",
          db: "prod",
          username: "svc@odoo.test",
          credentialKind: "api-key",
          protocol: "json-rpc",
        },
      }),
    save: () =>
      Effect.fail(new ProfileStoreError({ operation: "storage.save", cause: "disk full" })),
  });

describe("Profiles — adversarial-review regressions", () => {
  it.effect("cross-kind overwrite evicts the superseded secret (password → session)", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      const secrets = yield* SecretStore;
      yield* profiles.saveProfile("prod", passwordConfig, "web");
      // TOTP got enabled; the user switches this profile to the harvested-cookie flow.
      yield* profiles.saveSessionProfile(
        "prod",
        new URL("https://odoo.test/"),
        Redacted.make("cookie-v1"),
      );
      // The password secret must be GONE from the keyring, not orphaned.
      const orphan = yield* secrets.get("prod:password");
      assert.isTrue(Option.isNone(orphan));
      const loaded = yield* profiles.loadProfile("prod");
      assert.strictEqual(loaded._tag, "session");
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("cross-kind overwrite evicts the superseded secret (session → api-key)", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      const secrets = yield* SecretStore;
      yield* profiles.saveSessionProfile(
        "prod",
        new URL("https://odoo.test/"),
        Redacted.make("cookie-v1"),
      );
      yield* profiles.saveProfile("prod", apiKeyConfig, "json-rpc");
      const orphan = yield* secrets.get("prod:session");
      assert.isTrue(Option.isNone(orphan));
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("corrupted stored url fails typed (ProfileStoreError), never throws", () =>
    Effect.gen(function* () {
      const storage = yield* ProfileStorage;
      const secrets = yield* SecretStore;
      yield* secrets.set("bad:session", Redacted.make("cookie"));
      yield* storage.save({
        bad: { url: "::not a url::", credentialKind: "session", protocol: "web" } as ProfileData,
      });
      const profiles = yield* Profiles;
      const exit = yield* Effect.exit(profiles.loadProfile("bad"));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const failure = exit.cause;
        assert.include(JSON.stringify(failure), "profile.decode");
      }
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("credential record missing username/db fails typed, no fabricated config", () =>
    Effect.gen(function* () {
      const storage = yield* ProfileStorage;
      const secrets = yield* SecretStore;
      yield* secrets.set("mangled:password", Redacted.make("hunter2"));
      yield* storage.save({
        mangled: {
          url: "https://odoo.test/",
          credentialKind: "password",
          protocol: "web",
        } as ProfileData,
      });
      const profiles = yield* Profiles;
      const exit = yield* Effect.exit(profiles.loadProfile("mangled"));
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        assert.include(JSON.stringify(exit.cause), "profile.decode");
      }
    }).pipe(Effect.provide(inMemory)),
  );
});

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
      assert.strictEqual(loaded.protocol, "json-rpc");
      assert.strictEqual(loaded.config.url.href, "https://odoo.test/");
      assert.strictEqual(loaded.config.db, "prod");
      assert.strictEqual(loaded.config.credentials._tag, "ApiKey");
      assert.strictEqual(loaded.config.credentials.username, "svc@odoo.test");
      if (loaded.config.credentials._tag === "ApiKey") {
        assert.strictEqual(Redacted.value(loaded.config.credentials.apiKey), "sk-super-secret-key");
      }
    }).pipe(Effect.provide(inMemory)),
  );

  it.effect("round-trips a password profile through save/load", () =>
    Effect.gen(function* () {
      const profiles = yield* Profiles;
      yield* profiles.saveProfile("prod-pw", passwordConfig, "web");

      const loaded = yield* profiles.loadProfile("prod-pw");
      assert.strictEqual(loaded.protocol, "web");
      assert.strictEqual(loaded.config.credentials._tag, "Password");
      if (loaded.config.credentials._tag === "Password") {
        assert.strictEqual(
          Redacted.value(loaded.config.credentials.password),
          "hunter2-do-not-leak",
        );
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
      assert.strictEqual(apiMeta.username, "svc@odoo.test");
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

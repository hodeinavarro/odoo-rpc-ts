import { Context, Data, Effect, Layer, Option, type Redacted, Ref } from "effect";
import type { OdooConfig, OdooCredentials } from "./config.ts";

/**
 * Which transport a saved profile targets. Mirrors the three seams behind the
 * `Transport` tag (`web`, `/jsonrpc`, JSON-2); persisted as a stable string so a
 * stored profile survives refactors of the internal dialect enum.
 */
export type ProfileProtocol = "json-rpc" | "json-2" | "web";

/**
 * The serializable, **secret-free** metadata of a credential-backed preset.
 * `credentialKind` records which arm of {@link OdooCredentials} to
 * reconstruct, so the secret can be re-homed without guessing.
 */
export interface CredentialProfileData {
  readonly url: string;
  readonly db: string;
  readonly username: string;
  readonly credentialKind: "api-key" | "password";
  readonly protocol: ProfileProtocol;
}

/**
 * The serializable, **secret-free** metadata of a harvested-session preset:
 * the stored secret is the `session_id` cookie value itself, not a credential
 * (the flow exists precisely because there ARE no credentials — TOTP/SSO
 * accounts cannot password-auth). No `db`/`username`: the server binds both
 * to the cookie, and `get_session_info` reports them live. A session rides
 * the cookie-authenticated `/web` routes, so `protocol` is always `"web"`.
 */
export interface SessionProfileData {
  readonly url: string;
  readonly credentialKind: "session";
  readonly protocol: "web";
}

/**
 * The serializable, **secret-free** part of a connection preset. This is the
 * ONLY shape {@link ProfileStorage} ever sees — the secret (credential or
 * session cookie) lives in {@link SecretStore} and is never a field here.
 * Discriminated on `credentialKind`.
 */
export type ProfileData = CredentialProfileData | SessionProfileData;

/**
 * A profile's storage operation failed at the consumer-supplied backend (keyring
 * denied, IndexedDB transaction aborted, file unwritable, …). Wraps the opaque
 * platform `cause`; upper layers branch on `_tag`, never on the message. A store
 * failure proves only that *that* operation failed — infer nothing about the
 * other backend's state (see the removal ordering in {@link make}).
 */
export class ProfileStoreError extends Data.TaggedError("ProfileStoreError")<{
  /** The logical operation that failed, e.g. `"secret.set"` / `"storage.load"`. */
  readonly operation: string;
  readonly cause: unknown;
}> {}

/**
 * A profile's metadata was found but its credential secret is not reachable
 * through {@link SecretStore} (the secret was never stored, was removed out of
 * band, or the named profile does not exist at all). Distinct from
 * {@link ProfileStoreError}: the backend answered fine — the secret is simply
 * absent, so the {@link OdooConfig} cannot be reconstructed.
 */
export class ProfileSecretMissingError extends Data.TaggedError("ProfileSecretMissingError")<{
  readonly name: string;
  /** The keyring account that was probed: `${name}:${credentialKind}`. */
  readonly account: string;
}> {}

/**
 * Consumer-implemented secret vault, keyed by an opaque `account` string. The
 * platform-portable seam: an OS keyring in Node, IndexedDB + WebCrypto in a
 * browser, a `Ref`-backed map in tests. Secrets cross this boundary only as
 * `Redacted` — never a bare string — so they cannot leak into logs or JSON.
 */
export class SecretStore extends Context.Tag("odoo-rpc-ts/SecretStore")<
  SecretStore,
  {
    readonly get: (
      account: string,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, ProfileStoreError>;
    readonly set: (
      account: string,
      secret: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ProfileStoreError>;
    readonly remove: (account: string) => Effect.Effect<void, ProfileStoreError>;
  }
>() {}

/**
 * Consumer-implemented store for the secret-free {@link ProfileData} map, keyed
 * by profile name. A JSON file on disk, `localStorage`, a config table — anything
 * that round-trips a `Record<string, ProfileData>`. Never carries secrets.
 */
export class ProfileStorage extends Context.Tag("odoo-rpc-ts/ProfileStorage")<
  ProfileStorage,
  {
    readonly load: () => Effect.Effect<Record<string, ProfileData>, ProfileStoreError>;
    readonly save: (
      profiles: Record<string, ProfileData>,
    ) => Effect.Effect<void, ProfileStoreError>;
  }
>() {}

/** The keyring account for a profile's secret. One secret per (name, kind). */
const accountOf = (name: string, credentialKind: ProfileData["credentialKind"]): string =>
  `${name}:${credentialKind}`;

const credentialKindOf = (c: OdooCredentials): CredentialProfileData["credentialKind"] =>
  c._tag === "ApiKey" ? "api-key" : "password";

const secretOf = (c: OdooCredentials): Redacted.Redacted<string> =>
  c._tag === "ApiKey" ? c.apiKey : c.password;

/** Rebuild the live {@link OdooConfig} from stored metadata + a resolved secret. */
const reconstructConfig = (
  data: CredentialProfileData,
  secret: Redacted.Redacted<string>,
): OdooConfig => ({
  url: new URL(data.url),
  db: data.db,
  credentials:
    data.credentialKind === "api-key"
      ? { _tag: "ApiKey", username: data.username, apiKey: secret }
      : { _tag: "Password", username: data.username, password: secret },
});

/**
 * What {@link Profiles.loadProfile} hands back — tagged so the consumer can
 * tell a credential preset from a harvested-session preset WITHOUT this
 * service ever fabricating an {@link OdooConfig} around a fake credential:
 *
 * - `"credentials"` — a real config; feed it to `EphemeralAuth` /
 *   `CookieSessionLive.layerConfig` as usual.
 * - `"session"` — no credentials exist; feed `url` + `sessionId` to
 *   `CookieSessionLive.fromExisting` (its {@link ExistingSessionOptions}
 *   shape) over the web transport.
 */
export type LoadedProfile =
  | {
      readonly _tag: "credentials";
      readonly config: OdooConfig;
      readonly protocol: ProfileProtocol;
    }
  | {
      readonly _tag: "session";
      readonly url: URL;
      readonly sessionId: Redacted.Redacted<string>;
      readonly protocol: "web";
    };

/**
 * Named connection profiles over a {@link SecretStore} + {@link ProfileStorage}
 * seam. The metadata (URL, db, username, protocol) is serializable and travels
 * through `ProfileStorage`; the credential secret travels *only* through
 * `SecretStore` as `Redacted`. Serializing what this service persists can never
 * expose secret material.
 */
export class Profiles extends Context.Tag("odoo-rpc-ts/Profiles")<
  Profiles,
  {
    /**
     * Persist a preset: writes the secret to {@link SecretStore} first, then the
     * secret-free {@link ProfileData} to {@link ProfileStorage} (secret-before-
     * metadata so stored metadata never predates its secret). Overwrites any
     * existing profile of the same name.
     */
    readonly saveProfile: (
      name: string,
      config: OdooConfig,
      protocol: ProfileProtocol,
    ) => Effect.Effect<void, ProfileStoreError>;

    /**
     * Persist a harvested-session preset: the `session_id` cookie value is
     * the stored secret (same secret-before-metadata ordering as
     * {@link saveProfile}). No credentials are involved — this is the flow
     * for TOTP/SSO accounts whose cookie was minted by a real `/web/login`
     * (e.g. an embedded login window). Overwrites any existing profile of
     * the same name.
     */
    readonly saveSessionProfile: (
      name: string,
      url: URL,
      sessionId: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ProfileStoreError>;

    /**
     * Reconstruct a preset: reads metadata, then resolves the secret from
     * {@link SecretStore}. A credential preset rebuilds the {@link OdooConfig};
     * a session preset returns the harvested cookie — see {@link LoadedProfile}
     * for how to consume each arm. Fails with {@link ProfileSecretMissingError}
     * when the profile is unknown or its secret is absent — never returns a
     * config or session with a placeholder secret.
     */
    readonly loadProfile: (
      name: string,
    ) => Effect.Effect<LoadedProfile, ProfileStoreError | ProfileSecretMissingError>;

    /** All stored presets by name — secret-free by construction. */
    readonly listProfiles: () => Effect.Effect<Record<string, ProfileData>, ProfileStoreError>;

    /**
     * Delete a preset. Removes the secret FIRST, then the metadata (see the
     * ordering rationale in {@link make}). A no-op for an unknown name.
     */
    readonly removeProfile: (name: string) => Effect.Effect<void, ProfileStoreError>;
  }
>() {}

/** Hand-written {@link Profiles} layer over the two storage seams. */
export const layer: Layer.Layer<Profiles, never, SecretStore | ProfileStorage> = Layer.effect(
  Profiles,
  Effect.gen(function* () {
    const secrets = yield* SecretStore;
    const storage = yield* ProfileStorage;

    /**
     * Overwriting a profile with a DIFFERENT credentialKind must evict the
     * superseded secret first, or it is orphaned in the keyring forever:
     * removeProfile derives the account from the *current* metadata kind, so a
     * password secret left behind by a password→session switch would be
     * invisible and un-removable. Evict-before-write keeps the failure modes
     * benign: if the subsequent new-secret write fails, the stored metadata
     * still names the OLD kind whose secret is now gone — loadProfile then
     * reports ProfileSecretMissingError rather than returning stale material.
     */
    const evictSuperseded = (
      name: string,
      newKind: ProfileData["credentialKind"],
      existing: Record<string, ProfileData>,
    ): Effect.Effect<void, ProfileStoreError> => {
      const previous = existing[name];
      return previous !== undefined && previous.credentialKind !== newKind
        ? secrets.remove(accountOf(name, previous.credentialKind))
        : Effect.void;
    };

    const saveProfile = (
      name: string,
      config: OdooConfig,
      protocol: ProfileProtocol,
    ): Effect.Effect<void, ProfileStoreError> =>
      Effect.gen(function* () {
        const credentialKind = credentialKindOf(config.credentials);
        const data: ProfileData = {
          url: config.url.href,
          db: config.db,
          username: config.credentials.username,
          credentialKind,
          protocol,
        };
        const existing = yield* storage.load();
        yield* evictSuperseded(name, credentialKind, existing);
        // Secret before metadata: if metadata landed first and the secret write
        // then failed, we'd persist a profile that can never be loaded.
        yield* secrets.set(accountOf(name, credentialKind), secretOf(config.credentials));
        yield* storage.save({ ...existing, [name]: data });
      });

    const saveSessionProfile = (
      name: string,
      url: URL,
      sessionId: Redacted.Redacted<string>,
    ): Effect.Effect<void, ProfileStoreError> =>
      Effect.gen(function* () {
        const data: ProfileData = { url: url.href, credentialKind: "session", protocol: "web" };
        const existing = yield* storage.load();
        yield* evictSuperseded(name, "session", existing);
        // Same ordering as saveProfile: secret (the cookie) before metadata.
        yield* secrets.set(accountOf(name, "session"), sessionId);
        yield* storage.save({ ...existing, [name]: data });
      });

    const loadProfile = (
      name: string,
    ): Effect.Effect<LoadedProfile, ProfileStoreError | ProfileSecretMissingError> =>
      Effect.gen(function* () {
        const all = yield* storage.load();
        const data = all[name];
        if (data === undefined) {
          // No metadata ⇒ no reachable secret either.
          return yield* new ProfileSecretMissingError({ name, account: name });
        }
        // ProfileStorage is a consumer-supplied JSON round-trip — its output is
        // NOT trusted. A corrupted/hand-edited record must fail in the typed
        // channel (ProfileStoreError), never throw past it (new URL TypeError,
        // or a credentials arm missing username/db sailing into OdooConfig).
        const url = yield* Effect.try({
          try: () => new URL(data.url),
          catch: (cause) => new ProfileStoreError({ operation: "profile.decode", cause }),
        });
        if (
          data.credentialKind !== "session" &&
          (typeof data.username !== "string" || typeof data.db !== "string")
        ) {
          return yield* new ProfileStoreError({
            operation: "profile.decode",
            cause: `stored profile "${name}" (${data.credentialKind}) lacks username/db`,
          });
        }
        const account = accountOf(name, data.credentialKind);
        const maybeSecret = yield* secrets.get(account);
        if (Option.isNone(maybeSecret)) {
          return yield* new ProfileSecretMissingError({ name, account });
        }
        if (data.credentialKind === "session") {
          // NEVER fabricate an OdooConfig around a session cookie — there is
          // no credential; the consumer feeds this to CookieSessionLive.fromExisting.
          return {
            _tag: "session",
            url,
            sessionId: maybeSecret.value,
            protocol: data.protocol,
          } as const;
        }
        return {
          _tag: "credentials",
          config: reconstructConfig(data, maybeSecret.value),
          protocol: data.protocol,
        } as const;
      });

    const listProfiles = (): Effect.Effect<Record<string, ProfileData>, ProfileStoreError> =>
      storage.load();

    const removeProfile = (name: string): Effect.Effect<void, ProfileStoreError> =>
      Effect.gen(function* () {
        const all = yield* storage.load();
        const data = all[name];
        if (data === undefined) {
          return; // Nothing to remove — idempotent.
        }
        // Ordering: remove the SECRET first, then the metadata. The dangerous
        // half-state is an orphaned secret — a credential left in the keyring
        // with no metadata pointing at it, invisible and un-removable. Deleting
        // the secret first guarantees the credential is gone even if the
        // subsequent metadata save fails. The reverse transient (metadata
        // without a secret) is benign and self-heals: loadProfile reports
        // ProfileSecretMissingError rather than handing back a broken config.
        yield* secrets.remove(accountOf(name, data.credentialKind));
        const { [name]: _removed, ...rest } = all;
        yield* storage.save(rest);
      });

    return { saveProfile, saveSessionProfile, loadProfile, listProfiles, removeProfile };
  }),
);

/**
 * Ready-made, `Ref`-backed {@link SecretStore} for tests and single-process
 * consumers. Each `.layer` build gets its own isolated map — no shared global
 * state between tests.
 */
export const InMemorySecretStore = {
  layer: Layer.effect(
    SecretStore,
    Effect.gen(function* () {
      const store = yield* Ref.make<Record<string, Redacted.Redacted<string>>>({});
      return {
        get: (account) => Ref.get(store).pipe(Effect.map((s) => Option.fromNullable(s[account]))),
        set: (account, secret) => Ref.update(store, (s) => ({ ...s, [account]: secret })),
        remove: (account) => Ref.update(store, ({ [account]: _removed, ...rest }) => rest),
      };
    }),
  ),
} as const;

/**
 * Ready-made, `Ref`-backed {@link ProfileStorage} for tests and single-process
 * consumers. Isolated per `.layer` build, like {@link InMemorySecretStore}.
 */
export const InMemoryProfileStorage = {
  layer: Layer.effect(
    ProfileStorage,
    Effect.gen(function* () {
      const store = yield* Ref.make<Record<string, ProfileData>>({});
      return {
        load: () => Ref.get(store),
        save: (profiles) => Ref.set(store, profiles),
      };
    }),
  ),
} as const;

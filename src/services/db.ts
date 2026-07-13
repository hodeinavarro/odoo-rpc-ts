/**
 * `DbService` — the master-password-gated database-management endpoints exposed
 * by Odoo's `db` service over `POST /jsonrpc` (`exp_list`, `exp_db_exist`,
 * `exp_create_database`, `exp_drop`, `exp_duplicate_database`, `exp_dump`,
 * `exp_restore`, `exp_change_admin_password`).
 *
 * Unlike the model-level `Transport`, this service is **database-less and
 * credential-less**: it authenticates nothing and speaks to no database. The
 * only secret is the per-call master password (Odoo's `admin_passwd`), taken as
 * a `Redacted<string>` and unwrapped solely at the point the request body is
 * built. There is therefore no `Transport` tag, no uid, and no session — every
 * function takes the server `url: URL` explicitly and requires only an abstract
 * `HttpClient`.
 *
 * A wrong master password surfaces as `odoo.exceptions.AccessDenied`, which the
 * shared JSON-RPC choke point ({@link mapJsonRpcError}) maps to
 * {@link OdooAuthenticationError} — same as any other auth rejection.
 *
 * NODE ORIENTATION: {@link dump} and {@link restore} carry the whole backup in
 * memory as a `Uint8Array`. This is inherent to the wire contract — Odoo's
 * `exp_dump` returns the archive base64-encoded inside the JSON-RPC `result`,
 * and `exp_restore` takes it back the same way — so there is no streaming path
 * to preserve. Fine for the CI/ops-sized databases this is meant for; not a
 * mechanism for multi-gigabyte production dumps.
 *
 * Wire arities verified against `odoo/service/db.py` on 16.0 and 19.0 (stable
 * 16–19). `dispatch` strips the leading master password for every `exp_*`
 * method except the four unauthenticated ones (`list`, `db_exist`, `list_lang`,
 * `server_version`); `exp_restore` has NO `neutralize` parameter on any version.
 */
import { Effect, Encoding, Redacted, Schema } from "effect";
import type { FaultCallSite } from "../errors/mapFault.ts";
import { SchemaDriftError } from "../errors/schema.ts";
import type { OdooAuthenticationError } from "../errors/auth.ts";
import type { OdooServerFault } from "../errors/server.ts";
import type { SessionExpiredError } from "../errors/session.ts";
import { OdooTransportError } from "../errors/transport.ts";
import { HttpClient, HttpClientRequest } from "../internal/platform.ts";
import {
  buildRequest,
  JsonRpcResponse,
  mapJsonRpcError,
  nextRequestId,
} from "../protocol/jsonrpc.ts";

/** The failure channel a single `db` round trip can produce. */
type DbCallError =
  | OdooTransportError
  | SchemaDriftError
  | SessionExpiredError
  | OdooServerFault
  | OdooAuthenticationError;

/** Join the base URL with the `/jsonrpc` path, tolerating a trailing slash. */
const jsonRpcEndpoint = (url: URL): string => `${url.href.replace(/\/+$/, "")}/jsonrpc`;

/**
 * One `db`-service round trip: build the `{service:"db", method, args}`
 * envelope, POST it, decode the JSON-RPC response, and either return the raw
 * `result` or map the fault through the shared choke point.
 *
 * GOTCHA: never record `args` on the span — the master password rides in
 * position 0 for gated methods. Only the method name is safe.
 */
const dbCall = (
  url: URL,
  method: string,
  args: ReadonlyArray<unknown>,
): Effect.Effect<unknown, DbCallError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const endpoint = jsonRpcEndpoint(url);
    const id = nextRequestId();
    const site: FaultCallSite = { method: `db.${method}` };

    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(buildRequest({ service: "db", method, args }, id)),
    );

    const payload: unknown = yield* client.execute(request).pipe(
      Effect.flatMap((response) => response.json),
      Effect.mapError((cause) =>
        OdooTransportError.fromHttpClientError({ method: "POST", url: endpoint }, cause),
      ),
    );

    const decoded = yield* Schema.decodeUnknownEffect(JsonRpcResponse)(payload).pipe(
      Effect.mapError(
        (cause) => new SchemaDriftError({ context: "odoo.db response", payload, cause }),
      ),
    );

    if ("error" in decoded) {
      return yield* Effect.fail(mapJsonRpcError(decoded.error, site));
    }
    return decoded.result;
  }).pipe(Effect.withSpan("odoo.db", { attributes: { "odoo.db.method": method } }));

/** Decode a `db` result through `schema`, raising {@link SchemaDriftError} on drift. */
const decodeResult = <A, I>(
  schema: Schema.Codec<A, I>,
  context: string,
  result: unknown,
): Effect.Effect<A, SchemaDriftError> =>
  Schema.decodeUnknownEffect(schema)(result).pipe(
    Effect.mapError((cause) => new SchemaDriftError({ context, payload: result, cause })),
  );

/**
 * List the databases the server is willing to expose (honours `list_db` and any
 * `dbfilter`). Unauthenticated — no master password required.
 */
export const listDatabases = (
  url: URL,
): Effect.Effect<ReadonlyArray<string>, DbCallError, HttpClient.HttpClient> =>
  dbCall(url, "list", []).pipe(
    Effect.flatMap((result) =>
      decodeResult(Schema.Array(Schema.String), "odoo.db exp_list", result),
    ),
  );

/** Whether a database of the given name exists. Unauthenticated. */
export const exists = (
  url: URL,
  name: string,
): Effect.Effect<boolean, DbCallError, HttpClient.HttpClient> =>
  dbCall(url, "db_exist", [name]).pipe(
    Effect.flatMap((result) => decodeResult(Schema.Boolean, "odoo.db exp_db_exist", result)),
  );

/** Options for {@link create}. `master` and `adminPassword` are the two secrets. */
export interface CreateOptions {
  readonly master: Redacted.Redacted<string>;
  readonly name: string;
  /** Install demo data. Defaults to `false`. */
  readonly demo?: boolean;
  /** Load language / locale (e.g. `"en_US"`). Defaults to `"en_US"`. */
  readonly lang?: string;
  /** Login of the initial admin user. Defaults to `"admin"`. */
  readonly adminLogin?: string;
  /** Password of the initial admin user. */
  readonly adminPassword: Redacted.Redacted<string>;
  /** ISO country code to seed localization (e.g. `"US"`). */
  readonly countryCode?: string;
  /** Company phone to seed. */
  readonly phone?: string;
}

/**
 * Create a fresh database and its initial admin user.
 *
 * Wire (after `dispatch` strips the master): `exp_create_database(db_name,
 * demo, lang, user_password='admin', login='admin', country_code=None,
 * phone=None)`.
 */
export const create = (
  url: URL,
  options: CreateOptions,
): Effect.Effect<void, DbCallError, HttpClient.HttpClient> =>
  dbCall(url, "create_database", [
    Redacted.value(options.master),
    options.name,
    options.demo ?? false,
    options.lang ?? "en_US",
    Redacted.value(options.adminPassword),
    options.adminLogin ?? "admin",
    options.countryCode ?? null,
    options.phone ?? null,
  ]).pipe(Effect.asVoid);

/**
 * Drop a database. Resolves to `true` when a database was actually dropped,
 * `false` when none of that name existed.
 */
export const drop = (
  url: URL,
  master: Redacted.Redacted<string>,
  name: string,
): Effect.Effect<boolean, DbCallError, HttpClient.HttpClient> =>
  dbCall(url, "drop", [Redacted.value(master), name]).pipe(
    Effect.flatMap((result) => decodeResult(Schema.Boolean, "odoo.db exp_drop", result)),
  );

/** Options for {@link duplicate}. */
export interface DuplicateOptions {
  /**
   * Neutralize the copy (disable outgoing mail/crons/payment providers, …) so it
   * is safe as a staging database. Maps to `neutralize_database`. Defaults to
   * `false`.
   */
  readonly neutralize?: boolean;
}

/**
 * Duplicate `source` into a new database `target`.
 *
 * Wire (after master strip): `exp_duplicate_database(db_original_name, db_name,
 * neutralize_database=False)`.
 */
export const duplicate = (
  url: URL,
  master: Redacted.Redacted<string>,
  source: string,
  target: string,
  options: DuplicateOptions = {},
): Effect.Effect<void, DbCallError, HttpClient.HttpClient> =>
  dbCall(url, "duplicate_database", [
    Redacted.value(master),
    source,
    target,
    options.neutralize ?? false,
  ]).pipe(Effect.asVoid);

/**
 * Dump a database into an in-memory archive.
 *
 * `format` is `"zip"` (default; includes the filestore) or `"dump"` (raw
 * `pg_dump` custom format, database only). Odoo returns the archive
 * base64-encoded inside the JSON-RPC `result`; we decode it to raw bytes.
 */
export const dump = (
  url: URL,
  master: Redacted.Redacted<string>,
  name: string,
  format: "zip" | "dump" = "zip",
): Effect.Effect<Uint8Array, DbCallError, HttpClient.HttpClient> =>
  dbCall(url, "dump", [Redacted.value(master), name, format]).pipe(
    // Odoo returns the archive base64-encoded in `result`; decode to raw bytes,
    // any malformed base64 surfacing as SchemaDriftError like every other drift.
    Effect.flatMap((result) =>
      decodeResult(Schema.Uint8ArrayFromBase64, "odoo.db exp_dump", result),
    ),
  );

/** Options for {@link restore}. */
export interface RestoreOptions {
  /**
   * Restore as a *copy* — regenerate the database uuid and secret so it does not
   * collide with the original in a mail/cron sense. Maps to `copy`. Defaults to
   * `false`.
   *
   * NOTE: `exp_restore` has NO `neutralize` parameter on any supported version;
   * there is deliberately no such option here.
   */
  readonly copy?: boolean;
}

/**
 * Restore a previously {@link dump}ed archive under a new database `name`.
 *
 * The bytes are re-encoded to the base64 string `exp_restore` expects.
 * Wire (after master strip): `exp_restore(db_name, data, copy=False)`.
 */
export const restore = (
  url: URL,
  master: Redacted.Redacted<string>,
  name: string,
  archive: Uint8Array,
  options: RestoreOptions = {},
): Effect.Effect<void, DbCallError, HttpClient.HttpClient> =>
  dbCall(url, "restore", [
    Redacted.value(master),
    name,
    Encoding.encodeBase64(archive),
    options.copy ?? false,
  ]).pipe(Effect.asVoid);

/**
 * Change the server master password (`admin_passwd`). `master` is the current
 * password; `next` becomes the new one.
 *
 * Wire (after master strip): `exp_change_admin_password(new_password)`.
 */
export const changeMasterPassword = (
  url: URL,
  master: Redacted.Redacted<string>,
  next: Redacted.Redacted<string>,
): Effect.Effect<void, DbCallError, HttpClient.HttpClient> =>
  dbCall(url, "change_admin_password", [Redacted.value(master), Redacted.value(next)]).pipe(
    Effect.asVoid,
  );

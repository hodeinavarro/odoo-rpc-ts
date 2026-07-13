import { Config, Effect, Layer, Redacted, Ref, Schema } from "effect";
import { OdooConfig, type OdooCredentials } from "../config.ts";
import { OdooAuthenticationError } from "../errors/auth.ts";
import type { FaultCallSite } from "../errors/mapFault.ts";
import { SchemaDriftError } from "../errors/schema.ts";
import type { OdooServerFault } from "../errors/server.ts";
import type { SessionExpiredError } from "../errors/session.ts";
import { OdooTransportError } from "../errors/transport.ts";
import { HttpClient, HttpClientRequest } from "../internal/platform.ts";
import * as SingleFlight from "../internal/singleFlight.ts";
import { buildRequest, JsonRpcResponse, mapJsonRpcError } from "../protocol/jsonrpc.ts";
import { type CallKwParams, Transport, type TransportCallError } from "../transport.ts";
import { CommonVersionResponse } from "../version.ts";

/** The by-name params of a `/jsonrpc` call: `{service, method, args}`. */
interface JsonRpcCallParams {
  readonly service: string;
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

/** The failure channel a single round trip can produce (a subset of `TransportCallError`). */
type RoundTripError =
  | OdooTransportError
  | SchemaDriftError
  | SessionExpiredError
  | OdooServerFault
  | OdooAuthenticationError;

/** Join the configured base URL with the `/jsonrpc` path, tolerating a trailing slash. */
const jsonRpcEndpoint = (url: URL): string => `${url.href.replace(/\/+$/, "")}/jsonrpc`;

const extractCredentials = (
  credentials: OdooCredentials,
): {
  readonly username: string;
  readonly secret: Redacted.Redacted<string>;
  readonly isPassword: boolean;
} =>
  credentials._tag === "ApiKey"
    ? { username: credentials.username, secret: credentials.apiKey, isPassword: false }
    : { username: credentials.username, secret: credentials.password, isPassword: true };

/**
 * One JSON-RPC round trip: build the envelope, POST it, decode the response, and
 * either return the raw `result` or map the fault into our union.
 *
 * GOTCHA: never put `args`/`kwargs`/the secret into the span attributes — only
 * the model and method (or service/method) are safe to record.
 */
const roundTrip = (
  client: HttpClient.HttpClient,
  endpoint: string,
  id: number,
  params: JsonRpcCallParams,
  attributes: Record<string, string>,
  site: FaultCallSite,
): Effect.Effect<unknown, RoundTripError> =>
  Effect.gen(function* () {
    // v4 rename: bodyUnsafeJson → bodyJsonUnsafe.
    const request = HttpClientRequest.post(endpoint).pipe(
      HttpClientRequest.setHeader("Content-Type", "application/json"),
      HttpClientRequest.bodyJsonUnsafe(buildRequest(params, id)),
    );

    // HttpClientError covers both connection failures and a non-JSON body.
    const payload: unknown = yield* client.execute(request).pipe(
      Effect.flatMap((response) => response.json),
      Effect.mapError((cause) =>
        OdooTransportError.fromHttpClientError({ method: "POST", url: endpoint }, cause),
      ),
    );

    const decoded = yield* Schema.decodeUnknownEffect(JsonRpcResponse)(payload).pipe(
      Effect.mapError(
        (cause) => new SchemaDriftError({ context: "odoo.jsonrpc response", payload, cause }),
      ),
    );

    if ("error" in decoded) {
      return yield* Effect.fail(mapJsonRpcError(decoded.error, site));
    }
    return decoded.result;
  }).pipe(Effect.withSpan("odoo.jsonrpc", { attributes }));

/**
 * Build a `JsonRpcTransport` service value against a fully-resolved config.
 *
 * `uid` is resolved lazily on the first `callKw` via `common.authenticate`, then
 * success-only single-flight cached (a failed authenticate caches nothing, so
 * the next call retries — never `Effect.cached`).
 *
 * Requires an `HttpClient` in context; the caller provides the platform layer.
 */
export const make = (
  config: OdooConfig,
): Effect.Effect<typeof Transport.Service, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const idRef = yield* Ref.make(0);
    const endpoint = jsonRpcEndpoint(config.url);
    const { username, secret, isPassword } = extractCredentials(config.credentials);
    const db = config.db;

    const nextId = Ref.updateAndGet(idRef, (n) => n + 1);

    const authenticate: Effect.Effect<number, RoundTripError> = Effect.gen(function* () {
      const id = yield* nextId;
      const result = yield* roundTrip(
        client,
        endpoint,
        id,
        {
          service: "common",
          method: "authenticate",
          args: [db, username, Redacted.value(secret), {}],
        },
        {},
        {},
      );
      if (typeof result === "number" && result > 0) {
        return result;
      }
      // authenticate returned `false` (or a null uid): credentials rejected.
      return yield* Effect.fail(
        new OdooAuthenticationError({
          reason: "invalid-credentials",
          message: isPassword
            ? "Odoo rejected the login. If this account has TOTP/2FA enabled, its password cannot be used over RPC — supply an API key as the secret instead."
            : "Odoo rejected the provided credentials.",
        }),
      );
    });

    const uid = yield* SingleFlight.make(authenticate);

    const callKw = (params: CallKwParams): Effect.Effect<unknown, TransportCallError> =>
      Effect.gen(function* () {
        const resolvedUid = yield* uid.get;
        const id = yield* nextId;
        // execute_kw-family route: an explicit `ids` browse target rides as the
        // first positional argument (see CallKwParams.ids).
        const args = params.ids ? [params.ids, ...params.args] : params.args;
        return yield* roundTrip(
          client,
          endpoint,
          id,
          {
            service: "object",
            method: "execute_kw",
            args: [
              db,
              resolvedUid,
              Redacted.value(secret),
              params.model,
              params.method,
              args,
              params.kwargs,
            ],
          },
          { model: params.model, method: params.method },
          { model: params.model, method: params.method },
        );
      }).pipe(
        // Self-healing: an auth fault means the cached uid/credential pairing is
        // no longer valid server-side (key revoked-then-restored, credentials
        // out of sync, ...). Drop the cache so the next call re-authenticates
        // instead of staying wedged until the layer is rebuilt — symmetric with
        // CookieSession.invalidate.
        Effect.tapError((error) =>
          error._tag === "OdooAuthenticationError" ? uid.invalidate : Effect.void,
        ),
      );

    return { dialect: "execute-kw" as const, callKw };
  });

/**
 * `JsonRpcTransport` as a `Layer`, wired against an explicit config. Never
 * fails to build (`E = never`); the config is already resolved. Requires an
 * `HttpClient` from the platform layer the consumer provides.
 */
export const layer = (config: OdooConfig): Layer.Layer<Transport, never, HttpClient.HttpClient> =>
  Layer.effect(Transport, make(config));

/**
 * `JsonRpcTransport` as a `Layer` that reads {@link OdooConfig} from the ambient
 * `ConfigProvider`. Fails with `ConfigError` if required values are missing.
 */
export const layerConfig: Layer.Layer<Transport, Config.ConfigError, HttpClient.HttpClient> =
  Layer.effect(Transport, Effect.flatMap(OdooConfig, make));

/**
 * The `common.version` probe, decoded into {@link CommonVersionResponse}. Shared
 * with the `VersionResolver` implementation so version resolution and the
 * transport agree on one wire path. Requires an `HttpClient` in context.
 */
export const makeVersion = (
  config: OdooConfig,
): Effect.Effect<CommonVersionResponse, RoundTripError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const endpoint = jsonRpcEndpoint(config.url);
    const raw = yield* roundTrip(
      client,
      endpoint,
      1,
      { service: "common", method: "version", args: [] },
      {},
      {},
    );
    return yield* Schema.decodeUnknownEffect(CommonVersionResponse)(raw).pipe(
      Effect.mapError(
        (cause) =>
          new SchemaDriftError({ context: "odoo.jsonrpc common.version", payload: raw, cause }),
      ),
    );
  });

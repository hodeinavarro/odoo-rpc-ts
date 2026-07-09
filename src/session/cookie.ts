import { type ConfigError, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { OdooConfig } from "../config.ts";
import { OdooAuthenticationError } from "../errors/auth.ts";
import type { OdooServerFault } from "../errors/server.ts";
import { SchemaDriftError } from "../errors/schema.ts";
import type { SessionExpiredError } from "../errors/session.ts";
import { OdooTransportError, type RequestInfo } from "../errors/transport.ts";
import { Cookies, HttpClient, HttpClientRequest } from "../internal/platform.ts";
import * as SingleFlight from "../internal/singleFlight.ts";
import {
  buildRequest,
  JsonRpcResponse,
  mapJsonRpcError,
  nextRequestId,
} from "../protocol/jsonrpc.ts";

/**
 * Join a request path onto the configured base URL, preserving any base path
 * (e.g. a server mounted under `/odoo`). Keeping this here means both the
 * authenticate call and the `call_kw` transport derive endpoints identically.
 */
export const joinPath = (base: URL, path: string): string => {
  const href = base.href.endsWith("/") ? base.href : `${base.href}/`;
  return new URL(path, href).href;
};

/**
 * `session_info` as returned by `/web/session/authenticate`. Decoded leniently:
 * `uid` is `null` while a second factor is still pending, extra keys are
 * tolerated, and `server_version_info` passes through undecoded.
 */
const SessionInfoSchema = Schema.Struct({
  uid: Schema.NullOr(Schema.Number),
  user_context: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
  server_version_info: Schema.optional(Schema.Unknown),
});

/** A live, authenticated web session. `uid` is always a real user id here. */
export interface OdooSessionInfo {
  readonly uid: number;
  readonly userContext: Record<string, unknown>;
  readonly serverVersionInfo: unknown;
  /** The full, undecoded `session_info` result for downstream passthrough. */
  readonly raw: Record<string, unknown>;
}

/**
 * The typed failure channel of a login round trip. `SessionExpiredError` is in
 * the union only because it flows through the shared `mapJsonRpcError`; a fresh
 * authenticate should never actually produce it.
 */
export type CookieLoginError =
  | OdooTransportError
  | SchemaDriftError
  | OdooAuthenticationError
  | OdooServerFault
  | SessionExpiredError;

/**
 * The cookie-session service. Owns the `session_id` cookie jar and a
 * success-only single-flight around `/web/session/authenticate`.
 *
 * `client` is the HttpClient decorated with the shared cookie `Ref` — the web
 * transport MUST reuse it so the login `Set-Cookie` (and any mid-session
 * rotation) is carried on every subsequent `call_kw`.
 */
export interface CookieSessionService {
  /** Ensure a login has run and return the live session. Single-flight. */
  readonly login: Effect.Effect<OdooSessionInfo, CookieLoginError>;
  /**
   * Drop the cached session and the (now-dead) `session_id` cookie so the next
   * `login` re-authenticates. Does NOT auto-relogin — that is the opt-in
   * `retryOnSessionExpired` combinator's job.
   */
  readonly invalidate: Effect.Effect<void>;
  /** The shared cookie jar. Exposed for the transport's `withCookiesRef`. */
  readonly cookies: Ref.Ref<Cookies.Cookies>;
  /** HttpClient bound to the shared cookie jar; the transport reuses this. */
  readonly client: HttpClient.HttpClient;
  /** Peek at the current session without triggering a login (observability). */
  readonly peek: Effect.Effect<Option.Option<OdooSessionInfo>>;
}

export class CookieSession extends Context.Tag("odoo-rpc-ts/CookieSession")<
  CookieSession,
  CookieSessionService
>() {}

export const make = (
  config: OdooConfig,
): Effect.Effect<CookieSessionService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient;
    const cookies = yield* Ref.make(Cookies.empty);
    const client = HttpClient.withCookiesRef(baseClient, cookies);

    const authUrl = joinPath(config.url, "web/session/authenticate");
    const request: RequestInfo = { method: "POST", url: authUrl };

    const doLogin: Effect.Effect<OdooSessionInfo, CookieLoginError> = Effect.gen(function* () {
      // Redacted.value only at the wire boundary; for ApiKey creds the key is
      // sent as the password (valid on all supported Odoo versions).
      const password =
        config.credentials._tag === "ApiKey"
          ? Redacted.value(config.credentials.apiKey)
          : Redacted.value(config.credentials.password);

      const envelope = buildRequest(
        { db: config.db, login: config.credentials.username, password },
        nextRequestId(),
      );

      const response = yield* client
        .execute(HttpClientRequest.bodyUnsafeJson(HttpClientRequest.post(authUrl), envelope))
        .pipe(Effect.mapError((cause) => new OdooTransportError({ request, cause })));

      const body = yield* response.json.pipe(
        Effect.mapError((cause) => new OdooTransportError({ request, cause })),
      );

      const decoded = yield* Schema.decodeUnknown(JsonRpcResponse)(body).pipe(
        Effect.mapError(
          (cause) =>
            new SchemaDriftError({
              context: "web/session/authenticate envelope",
              payload: body,
              cause,
            }),
        ),
      );

      if ("error" in decoded) {
        return yield* Effect.fail(mapJsonRpcError(decoded.error, { method: "authenticate" }));
      }

      const info = yield* Schema.decodeUnknown(SessionInfoSchema)(decoded.result).pipe(
        Effect.mapError(
          (cause) =>
            new SchemaDriftError({
              context: "web/session/authenticate session_info",
              payload: decoded.result,
              cause,
            }),
        ),
      );

      if (info.uid === null) {
        return yield* Effect.fail(
          new OdooAuthenticationError({
            reason: "mfa-pending",
            message: "Login accepted but a second factor is required before a session exists.",
          }),
        );
      }

      const session: OdooSessionInfo = {
        uid: info.uid,
        userContext: info.user_context ?? {},
        serverVersionInfo: info.server_version_info,
        raw:
          typeof decoded.result === "object" && decoded.result !== null
            ? (decoded.result as Record<string, unknown>)
            : {},
      };
      return session;
    });

    // The flight owns both caching and invalidation. Its generation counter
    // guarantees a login already in flight when `invalidate` runs cannot
    // resurrect the cache with a stale session (its caller still gets it).
    const flight = yield* SingleFlight.make(doLogin);

    const invalidate = Effect.gen(function* () {
      yield* Ref.set(cookies, Cookies.empty);
      yield* flight.invalidate;
    });

    return {
      login: flight.get,
      invalidate,
      cookies,
      client,
      peek: flight.peek,
    };
  });

/** Provide `CookieSession` from an already-resolved config. Requires `HttpClient`. */
export const layer = (
  config: OdooConfig,
): Layer.Layer<CookieSession, never, HttpClient.HttpClient> =>
  Layer.effect(CookieSession, make(config));

/** Provide `CookieSession`, resolving `OdooConfig` from the environment. */
export const layerConfig: Layer.Layer<
  CookieSession,
  ConfigError.ConfigError,
  HttpClient.HttpClient
> = Layer.effect(CookieSession, Effect.flatMap(OdooConfig, make));

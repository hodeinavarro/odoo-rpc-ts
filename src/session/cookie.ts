import { type Config, Context, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { OdooConfig } from "../config.ts";
import { OdooAuthenticationError } from "../errors/auth.ts";
import type { OdooServerFault } from "../errors/server.ts";
import { SchemaDriftError } from "../errors/schema.ts";
import { SessionExpiredError } from "../errors/session.ts";
import { OdooTransportError, type RequestInfo } from "../errors/transport.ts";
import {
  Cookies,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "../internal/platform.ts";
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
  user_context: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
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
/**
 * Options for {@link CookieSessionService.http}: a raw HTTP round trip on the
 * cookie-bound client. `path` is joined onto the session's base url (a base
 * mount like `/odoo` is preserved). `method` defaults to `GET`.
 */
export interface RawHttpOptions {
  readonly path: string;
  readonly method?: string;
  readonly body?: Uint8Array;
  readonly headers?: Record<string, string>;
}

export interface CookieSessionService {
  /** Ensure a login has run and return the live session. Single-flight. */
  readonly login: Effect.Effect<OdooSessionInfo, CookieLoginError>;
  /**
   * Raw JSON-RPC escape hatch: ensure login, then POST the shared JSON-RPC
   * envelope (`{jsonrpc, method:"call", params, id}`) to an arbitrary `path`
   * under the session's base url and return the raw `result` member. Server
   * faults flow through the shared `mapJsonRpcError` choke point (code 100 →
   * `SessionExpiredError`, etc.); a non-envelope body fails as `SchemaDriftError`.
   * For calling models this is `web/dataset/call_kw` with the `{model, method,
   * args, kwargs}` params shape.
   */
  readonly json: (
    path: string,
    params?: Record<string, unknown>,
  ) => Effect.Effect<unknown, CookieLoginError>;
  /**
   * Raw HTTP escape hatch: ensure login, then issue a raw request on the
   * cookie-bound client and return the response UNTOUCHED. The caller owns the
   * response fully, including any non-2xx status — this hatch never inspects it
   * and only fails (`OdooTransportError`) on a wire-level error or a failed
   * login. Used for binary endpoints like `GET /report/<converter>/...`.
   */
  readonly http: (
    options: RawHttpOptions,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, CookieLoginError>;
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

export class CookieSession extends Context.Service<
  CookieSession,
  CookieSessionService
>()("odoo-rpc-ts/CookieSession") {}

/**
 * One session-info round trip: POST a JSON-RPC envelope, decode the response,
 * map faults through the shared choke point (code 100 → `SessionExpiredError`),
 * and validate the returned `session_info`. Shared by the credential login and
 * the injected-cookie path so both decode — and fail — identically.
 */
const sessionInfoRoundTrip = (
  client: HttpClient.HttpClient,
  url: string,
  params: unknown,
  endpoint: string,
  method: string,
): Effect.Effect<OdooSessionInfo, CookieLoginError> =>
  Effect.gen(function* () {
    const request: RequestInfo = { method: "POST", url };
    const envelope = buildRequest(params, nextRequestId());

    const response = yield* client
      .execute(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), envelope))
      .pipe(Effect.mapError((cause) => new OdooTransportError({ request, cause })));

    const body = yield* response.json.pipe(
      Effect.mapError((cause) => new OdooTransportError({ request, cause })),
    );

    const decoded = yield* Schema.decodeUnknownEffect(JsonRpcResponse)(body).pipe(
      Effect.mapError(
        (cause) =>
          new SchemaDriftError({
            context: `${endpoint} envelope`,
            payload: body,
            cause,
          }),
      ),
    );

    if ("error" in decoded) {
      return yield* Effect.fail(mapJsonRpcError(decoded.error, { method }));
    }

    const info = yield* Schema.decodeUnknownEffect(SessionInfoSchema)(decoded.result).pipe(
      Effect.mapError(
        (cause) =>
          new SchemaDriftError({
            context: `${endpoint} session_info`,
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

/**
 * Build the two raw escape hatches (`json`, `http`) shared by {@link make} and
 * {@link fromExisting}. Both close over the SAME cookie-bound `client`, base
 * `url`, and single-flight `login` the rest of the service uses, so a hatch
 * request rides the live `session_id` cookie exactly like a `call_kw` does.
 */
const makeRawHatches = (
  client: HttpClient.HttpClient,
  baseUrl: URL,
  login: Effect.Effect<OdooSessionInfo, CookieLoginError>,
): Pick<CookieSessionService, "json" | "http"> => {
  const json = (
    path: string,
    params: Record<string, unknown> = {},
  ): Effect.Effect<unknown, CookieLoginError> =>
    Effect.gen(function* () {
      yield* login;

      const url = joinPath(baseUrl, path);
      const request: RequestInfo = { method: "POST", url };
      const envelope = buildRequest(params, nextRequestId());

      const response = yield* client
        .execute(HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), envelope))
        .pipe(Effect.mapError((cause) => new OdooTransportError({ request, cause })));

      const body = yield* response.json.pipe(
        Effect.mapError((cause) => new OdooTransportError({ request, cause })),
      );

      const decoded = yield* Schema.decodeUnknownEffect(JsonRpcResponse)(body).pipe(
        Effect.mapError(
          (cause) => new SchemaDriftError({ context: `${path} envelope`, payload: body, cause }),
        ),
      );

      if ("error" in decoded) {
        return yield* Effect.fail(mapJsonRpcError(decoded.error, { method: path }));
      }

      return decoded.result;
    });

  const http = (
    options: RawHttpOptions,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, CookieLoginError> =>
    Effect.gen(function* () {
      yield* login;

      const url = joinPath(baseUrl, options.path);
      const method = options.method ?? "GET";
      const request: RequestInfo = { method, url };

      let req = HttpClientRequest.make(method as Parameters<typeof HttpClientRequest.make>[0])(url);
      if (options.headers !== undefined) {
        req = HttpClientRequest.setHeaders(req, options.headers);
      }
      if (options.body !== undefined) {
        req = HttpClientRequest.bodyUint8Array(req, options.body);
      }

      // Response returned untouched — the caller owns any non-2xx status.
      return yield* client
        .execute(req)
        .pipe(Effect.mapError((cause) => new OdooTransportError({ request, cause })));
    });

  return { json, http };
};

export const make = (
  config: OdooConfig,
): Effect.Effect<CookieSessionService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient;
    const cookies = yield* Ref.make(Cookies.empty);
    const client = HttpClient.withCookiesRef(baseClient, cookies);

    const authUrl = joinPath(config.url, "web/session/authenticate");

    const doLogin: Effect.Effect<OdooSessionInfo, CookieLoginError> = Effect.suspend(() => {
      // Redacted.value only at the wire boundary; for ApiKey creds the key is
      // sent as the password (valid on all supported Odoo versions).
      const password =
        config.credentials._tag === "ApiKey"
          ? Redacted.value(config.credentials.apiKey)
          : Redacted.value(config.credentials.password);

      return sessionInfoRoundTrip(
        client,
        authUrl,
        { db: config.db, login: config.credentials.username, password },
        "web/session/authenticate",
        "authenticate",
      );
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
      ...makeRawHatches(client, config.url, flight.get),
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
  Config.ConfigError,
  HttpClient.HttpClient
> = Layer.effect(CookieSession, Effect.flatMap(OdooConfig, make));

/**
 * Options for {@link fromExisting}: adopt a `session_id` cookie that was
 * minted elsewhere (e.g. harvested from an embedded browser window after the
 * user completed the real `/web/login` page — the only stock flow that works
 * for TOTP/SSO accounts).
 */
export interface ExistingSessionOptions {
  /** Base server URL (same shape as `OdooConfig.url`; TLS rules apply). */
  readonly url: URL;
  /** The harvested `session_id` cookie value. Redacted until the wire. */
  readonly sessionId: Redacted.Redacted<string>;
  /**
   * Optional renewal hook: an Effect that yields a FRESH `session_id` (e.g.
   * by driving a login window again). Runs inside the login single-flight
   * after an `invalidate`, so concurrent callers trigger it at most once.
   * Must be fully provided (`R = never`) and fail within `CookieLoginError` —
   * map UI-level failures (window closed, …) into `OdooAuthenticationError`.
   */
  readonly renew?: Effect.Effect<Redacted.Redacted<string>, CookieLoginError>;
}

/**
 * Build a `CookieSessionService` from an already-minted `session_id` cookie —
 * no credentials are ever held. `login` seeds the cookie jar and validates the
 * session via `POST /web/session/get_session_info` (verified 16–19: JSON-RPC
 * envelope, `auth="user"`), so `OdooSessionInfo` (`uid`, context, version) is
 * always real, never fabricated. Success-only single-flight, like {@link make}.
 *
 * Expired-session contract: this session cannot re-login by itself. When the
 * server kills the session, calls fail with `SessionExpiredError`; after
 * `invalidate`, a subsequent `login` fails FAST with `SessionExpiredError`
 * (no network) unless a `renew` hook was provided. `retryOnSessionExpired`
 * therefore performs exactly one relogin attempt and propagates the second
 * `SessionExpiredError` — it can never spin. The consumer's shell is expected
 * to catch it, re-run its login UI, and construct a fresh session (or supply
 * `renew` to do the same in place).
 */
// RFC 6265 `cookie-octet`: the exact charset a cookie value may put on the
// wire (excludes controls, whitespace, DQUOTE, comma, semicolon, backslash).
const cookieOctets = /^[\u0021\u0023-\u002b\u002d-\u003a\u003c-\u005b\u005d-\u007e]+$/;

export const fromExisting = (
  options: ExistingSessionOptions,
): Effect.Effect<CookieSessionService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient;
    const cookies = yield* Ref.make(Cookies.empty);
    const client = HttpClient.withCookiesRef(baseClient, cookies);

    const infoUrl = joinPath(options.url, "web/session/get_session_info");

    // The cookie to seed on the next login. Starts as the harvested value;
    // consumed once, and cleared by `invalidate` so a dead cookie is never
    // re-seeded. After that only `renew` can produce another one.
    const nextCookie = yield* Ref.make(Option.some(options.sessionId));

    // Redacted.value only at the wire boundary (the cookie jar IS the wire
    // buffer). Seeded via `fromSetCookie` so the raw value rides the wire
    // untouched, exactly like a server-set cookie — `Cookies.makeCookie`
    // would percent-encode it (corrupting `+`/`=`/`/`), and an unvalidated
    // `fromSetCookie` would silently truncate at the first `;`.
    const seed = (value: Redacted.Redacted<string>): Effect.Effect<void, CookieLoginError> => {
      const raw = Redacted.value(value);
      if (raw === "" || !cookieOctets.test(raw)) {
        return Effect.fail(
          new OdooAuthenticationError({
            reason: "invalid-credentials",
            message: "The provided session_id is not a valid cookie value (RFC 6265).",
          }),
        );
      }
      return Ref.update(cookies, (jar) =>
        Cookies.merge(jar, Cookies.fromSetCookie(`session_id=${raw}; Path=/`)),
      );
    };

    const doLogin: Effect.Effect<OdooSessionInfo, CookieLoginError> = Effect.gen(function* () {
      const jar = yield* Ref.get(cookies);
      if (Option.isNone(Cookies.getValue(jar, "session_id"))) {
        const pending = yield* Ref.getAndSet(nextCookie, Option.none());
        if (Option.isSome(pending)) {
          yield* seed(pending.value);
        } else if (options.renew !== undefined) {
          yield* seed(yield* options.renew);
        } else {
          // Fail FAST, without a round trip: this session holds no credentials
          // and no renew hook, so re-login is structurally impossible.
          return yield* Effect.fail(
            new SessionExpiredError({
              message:
                "The injected web session was invalidated and no renew hook was provided; " +
                "obtain a fresh session_id and construct a new session.",
            }),
          );
        }
      }

      // Validate + hydrate: a dead cookie surfaces here as code 100 →
      // SessionExpiredError via the shared choke point.
      return yield* sessionInfoRoundTrip(
        client,
        infoUrl,
        {},
        "web/session/get_session_info",
        "get_session_info",
      );
    });

    const flight = yield* SingleFlight.make(doLogin);

    const invalidate = Effect.gen(function* () {
      yield* Ref.set(cookies, Cookies.empty);
      yield* Ref.set(nextCookie, Option.none());
      yield* flight.invalidate;
    });

    return {
      login: flight.get,
      invalidate,
      cookies,
      client,
      peek: flight.peek,
      ...makeRawHatches(client, options.url, flight.get),
    };
  });

/** Provide `CookieSession` from a harvested cookie. See {@link fromExisting}. */
export const layerFromExisting = (
  options: ExistingSessionOptions,
): Layer.Layer<CookieSession, never, HttpClient.HttpClient> =>
  Layer.effect(CookieSession, fromExisting(options));

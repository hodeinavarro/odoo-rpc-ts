import { type Config, Effect, Layer, Option, Redacted, Schema } from "effect";
import { OdooConfig } from "../config.ts";
import type { OdooConfig as OdooConfigType } from "../config.ts";
import { OdooAuthenticationError } from "../errors/auth.ts";
import { type FaultCallSite, mapServerFault, type RawServerFault } from "../errors/mapFault.ts";
import { ProtocolUnsupportedError } from "../errors/protocol.ts";
import { SchemaDriftError } from "../errors/schema.ts";
import {
  OdooAccessError,
  OdooLockError,
  OdooMissingError,
  OdooServerError,
  type OdooServerFault,
  OdooUserError,
} from "../errors/server.ts";
import { OdooTransportError, type RequestInfo } from "../errors/transport.ts";
import {
  HttpClient,
  type HttpClientErrorType,
  HttpClientRequest,
  HttpClientResponse,
} from "../internal/platform.ts";
import { type CallKwParams, Transport } from "../transport.ts";
import { ServerVersionInfo } from "../version.ts";

/**
 * Odoo's `/json/2/<model>/<method>` API (Odoo 19+): a keyword-only, bearer-auth
 * JSON route that returns the raw method result with no JSON-RPC envelope. This
 * module is one of the three seams behind the {@link Transport} tag.
 */

/** Strip any trailing slashes so path segments join cleanly onto a base URL. */
const baseUrl = (url: URL): string => url.href.replace(/\/+$/u, "");

/** Sanitized request snapshot — never carries the bearer header or body. */
const requestInfo = (url: string, method: string): RequestInfo => ({ method, url });

const toTransportError =
  (request: RequestInfo) =>
  (cause: HttpClientErrorType): OdooTransportError =>
    new OdooTransportError({ request, cause });

/**
 * The `serialize_exception` payload Odoo returns in an error body. Everything is
 * optional: a bare HTTP failure (proxy 502, gateway timeout) may have no JSON
 * body at all, in which case we synthesize a fault from the status alone.
 */
const SerializeException = Schema.Struct({
  name: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  arguments: Schema.optional(Schema.Array(Schema.Unknown)),
  context: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  debug: Schema.optional(Schema.String),
});
type SerializeException = typeof SerializeException.Type;

const emptyException: SerializeException = {};

/**
 * Build a {@link RawServerFault} from a decoded exception body and the call
 * site, honouring `exactOptionalPropertyTypes` (optional keys are attached only
 * when present, never as explicit `undefined`).
 */
const rawFault = (
  exc: SerializeException,
  status: number,
  site: FaultCallSite,
): RawServerFault & FaultCallSite => ({
  name: exc.name ?? `http.${status}`,
  message: exc.message ?? "",
  arguments: exc.arguments ?? [],
  context: exc.context ?? {},
  ...(exc.debug !== undefined ? { debug: exc.debug } : {}),
  ...(site.model !== undefined ? { model: site.model } : {}),
  ...(site.method !== undefined ? { method: site.method } : {}),
});

/** Status → concrete server-fault constructor, for the no-`name` fallback path. */
const byStatus: Record<number, new (fields: RawServerFault & FaultCallSite) => OdooServerFault> = {
  403: OdooAccessError,
  404: OdooMissingError,
  409: OdooLockError,
  422: OdooUserError,
};

/**
 * The single error-mapping choke point for JSON-2. A non-2xx response becomes
 * exactly one tagged error:
 *
 * - `400` / `415` are transport-shaped (malformed request / wrong media type),
 *   so they map to {@link OdooTransportError} carrying the platform
 *   `ResponseError` as `cause`.
 * - Any body with a Python `name` goes through {@link mapServerFault} (shared
 *   with the other transports), so `AccessDenied` correctly becomes an auth
 *   error and known exception names get their subtype.
 * - Otherwise we fall back on the HTTP status, synthesizing a fault named
 *   `http.<status>` so nothing is silently dropped.
 */
const mapJson2Fault = (
  response: HttpClientResponse.HttpClientResponse,
  request: RequestInfo,
  site: FaultCallSite,
): Effect.Effect<never, OdooTransportError | OdooAuthenticationError | OdooServerFault> =>
  Effect.gen(function* () {
    const status = response.status;

    if (status === 400 || status === 415) {
      // A genuine platform ResponseError is required as `cause`; `filterStatusOk`
      // manufactures one from the non-ok status without reading the body.
      const cause = yield* Effect.flip(HttpClientResponse.filterStatusOk(response)).pipe(
        Effect.orDie,
      );
      return yield* Effect.fail(new OdooTransportError({ request, cause }));
    }

    // A non-JSON or shape-drifted error body falls back to an empty exception,
    // which routes to status-based mapping below.
    const exc = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SerializeException)),
      Effect.orElseSucceed(() => emptyException),
    );
    const raw = rawFault(exc, status, site);

    // GOTCHA: 401 is checked BEFORE the body name. Odoo 19 serializes a bad
    // bearer key as werkzeug.exceptions.Unauthorized — an unmapped name that
    // would otherwise fall through to OdooServerError instead of auth.
    if (status === 401) {
      return yield* Effect.fail(
        new OdooAuthenticationError({
          reason: "api-key-expired-or-invalid",
          message: raw.message || "JSON-2 rejected the API key (HTTP 401).",
        }),
      );
    }

    if (exc.name !== undefined) {
      return yield* Effect.fail(mapServerFault(raw, site));
    }

    const Ctor = byStatus[status] ?? OdooServerError;
    return yield* Effect.fail(new Ctor(raw));
  });

/**
 * Build a {@link Transport} bound to the JSON-2 route for a given config.
 *
 * GOTCHA: JSON-2 is bearer-only. If the config carries `Password` credentials
 * there is no API key to send, so construction FAILS in the typed channel with
 * {@link OdooAuthenticationError} rather than silently degrading — this is a
 * `Layer` build failure, surfaced eagerly so a misconfigured client never issues
 * an unauthenticated request.
 */
export const make = (
  config: OdooConfigType,
): Effect.Effect<typeof Transport.Service, OdooAuthenticationError, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    if (config.credentials._tag !== "ApiKey") {
      return yield* Effect.fail(
        new OdooAuthenticationError({
          reason: "invalid-credentials",
          message:
            "JSON-2 transport is bearer-only and requires ApiKey credentials; " +
            "got Password. Provide ODOO_API_KEY.",
        }),
      );
    }

    const apiKey = config.credentials.apiKey;
    const client = yield* HttpClient.HttpClient;
    const base = baseUrl(config.url);

    const callKw = (params: CallKwParams): Effect.Effect<unknown, TransportCallErrorLocal> => {
      const site: FaultCallSite = { model: params.model, method: params.method };

      const run = Effect.gen(function* () {
        // JSON-2 cannot carry positional args; reordering silently would corrupt
        // the call, so reject loudly and name the offending method.
        if (params.args.length > 0) {
          return yield* Effect.fail(
            new ProtocolUnsupportedError({
              protocol: "json-2",
              serverVersion: "19+",
              message:
                `JSON-2 is keyword-only: "${params.model}.${params.method}" was called with ` +
                `${params.args.length} positional argument(s); move them into kwargs.`,
            }),
          );
        }

        const url = `${base}/json/2/${params.model}/${params.method}`;
        const info = requestInfo(url, "POST");

        // Keyword-only route: the browse target rides as the dedicated `ids` body
        // key (see CallKwParams.ids), never as positional args.
        const body = params.ids ? { ...params.kwargs, ids: params.ids } : params.kwargs;

        // Redacted is unwrapped ONLY here, at the wire boundary.
        const request = HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders({
            Authorization: `Bearer ${Redacted.value(apiKey)}`,
            "X-Odoo-Database": config.db,
            "Content-Type": "application/json",
          }),
          HttpClientRequest.bodyJsonUnsafe(body),
        );

        const response = yield* client
          .execute(request)
          .pipe(Effect.mapError(toTransportError(info)));

        if (response.status >= 200 && response.status < 300) {
          // Raw method result, no envelope; callers decode at their own boundary.
          return yield* response.json.pipe(Effect.mapError(toTransportError(info)));
        }

        return yield* mapJson2Fault(response, info, site);
      });

      // Span carries only the coordinates — never args, kwargs, or the API key.
      return run.pipe(
        Effect.withSpan("odoo.json2", {
          attributes: { model: params.model, method: params.method },
        }),
      );
    };

    return { dialect: "json2" as const, callKw };
  });

/** The concrete subset of the transport failure channel JSON-2 produces. */
type TransportCallErrorLocal =
  | OdooTransportError
  | OdooAuthenticationError
  | ProtocolUnsupportedError
  | OdooServerFault;

/** Wire a JSON-2 {@link Transport} from an explicit config. */
export const layer = (
  config: OdooConfigType,
): Layer.Layer<Transport, OdooAuthenticationError, HttpClient.HttpClient> =>
  Layer.effect(Transport, make(config));

/** Wire a JSON-2 {@link Transport}, reading {@link OdooConfig} from the environment. */
export const layerConfig: Layer.Layer<
  Transport,
  OdooAuthenticationError | Config.ConfigError,
  HttpClient.HttpClient
> = Layer.effect(Transport, Effect.flatMap(OdooConfig, make));

/**
 * The `/json/version` probe result: the server's version string and its raw
 * `version_info` tuple. Decoded at the boundary; drift raises
 * {@link SchemaDriftError}.
 */
export const Json2Version = Schema.Struct({
  version: Schema.String,
  version_info: ServerVersionInfo,
});
export type Json2Version = typeof Json2Version.Type;

/**
 * Probe `GET {url}/json/version` to detect JSON-2 support.
 *
 * Returns `Option.some(version)` on a 200, and `Option.none()` on a 404 — a 404
 * is the documented "this server predates Odoo 19 (no JSON-2)" signal, not an
 * error. Any other non-2xx is a real {@link OdooTransportError}; a 200 body that
 * fails to decode is a {@link SchemaDriftError}.
 */
export const probeJson2Version = (
  config: OdooConfigType,
): Effect.Effect<
  Option.Option<Json2Version>,
  OdooTransportError | SchemaDriftError,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const url = `${baseUrl(config.url)}/json/version`;
    const info = requestInfo(url, "GET");

    const response = yield* client
      .execute(HttpClientRequest.get(url))
      .pipe(Effect.mapError(toTransportError(info)));

    const status = response.status;
    if (status === 404) {
      return Option.none();
    }
    if (status < 200 || status >= 300) {
      const cause = yield* Effect.flip(HttpClientResponse.filterStatusOk(response)).pipe(
        Effect.orDie,
      );
      return yield* Effect.fail(new OdooTransportError({ request: info, cause }));
    }

    const payload = yield* response.json.pipe(Effect.mapError(toTransportError(info)));
    const decoded = yield* Schema.decodeUnknownEffect(Json2Version)(payload).pipe(
      Effect.mapError(
        (cause) => new SchemaDriftError({ context: "odoo.json2.version", payload, cause }),
      ),
    );
    return Option.some(decoded);
  });

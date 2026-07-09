import { type ConfigError, Effect, Layer, Schema } from "effect";
import { OdooConfig } from "../config.ts";
import { SchemaDriftError } from "../errors/schema.ts";
import { OdooTransportError, type RequestInfo } from "../errors/transport.ts";
import { HttpClientRequest } from "../internal/platform.ts";
import { CookieSession } from "../session/cookie.ts";
import { joinPath } from "../session/cookie.ts";
import {
  buildRequest,
  JsonRpcResponse,
  mapJsonRpcError,
  nextRequestId,
} from "../protocol/jsonrpc.ts";
import { type CallKwParams, Transport, type TransportCallError } from "../transport.ts";

/**
 * Build the `WebTransport` implementation. Every `call_kw` first ensures a
 * cookie session exists (via {@link CookieSession}) and then rides the shared,
 * cookie-bound HttpClient so `session_id` — and any rotation — is always sent.
 */
export const make = (config: OdooConfig): Effect.Effect<Transport["Type"], never, CookieSession> =>
  Effect.gen(function* () {
    const session = yield* CookieSession;
    const callUrl = joinPath(config.url, "web/dataset/call_kw");
    const request: RequestInfo = { method: "POST", url: callUrl };

    const callKw = (params: CallKwParams): Effect.Effect<unknown, TransportCallError> =>
      Effect.gen(function* () {
        // Choke point: ensure the session before the call. A SessionExpiredError
        // from here does NOT auto-relogin (see retryOnSessionExpired).
        yield* session.login;

        // execute_kw-family route: an explicit `ids` browse target rides as the
        // first positional argument (see CallKwParams.ids).
        const args = params.ids ? [params.ids, ...params.args] : params.args;
        const envelope = buildRequest(
          {
            model: params.model,
            method: params.method,
            args,
            kwargs: params.kwargs,
          },
          nextRequestId(),
        );

        const response = yield* session.client
          .execute(HttpClientRequest.bodyUnsafeJson(HttpClientRequest.post(callUrl), envelope))
          .pipe(Effect.mapError((cause) => new OdooTransportError({ request, cause })));

        const body = yield* response.json.pipe(
          Effect.mapError((cause) => new OdooTransportError({ request, cause })),
        );

        const decoded = yield* Schema.decodeUnknown(JsonRpcResponse)(body).pipe(
          Effect.mapError(
            (cause) =>
              new SchemaDriftError({
                context: "web/dataset/call_kw envelope",
                payload: body,
                cause,
              }),
          ),
        );

        if ("error" in decoded) {
          // Single mapping choke point: code 100 → SessionExpiredError, else
          // mapServerFault, with the call site threaded through.
          return yield* Effect.fail(
            mapJsonRpcError(decoded.error, { model: params.model, method: params.method }),
          );
        }

        return decoded.result;
      }).pipe(
        // No args/secrets in span attributes — model + method only.
        Effect.withSpan("odoo.web.call_kw", {
          attributes: { model: params.model, method: params.method },
        }),
      );

    return { dialect: "execute-kw" as const, callKw };
  });

/** Provide the web `Transport` from an already-resolved config. Requires `CookieSession`. */
export const layer = (config: OdooConfig): Layer.Layer<Transport, never, CookieSession> =>
  Layer.effect(Transport, make(config));

/** Provide the web `Transport`, resolving `OdooConfig` from the environment. */
export const layerConfig: Layer.Layer<Transport, ConfigError.ConfigError, CookieSession> =
  Layer.effect(Transport, Effect.flatMap(OdooConfig, make));

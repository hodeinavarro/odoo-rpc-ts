/**
 * The single funnel for everything we consume from the platform HTTP layer.
 *
 * Every other module in this package imports platform values and types
 * from HERE — never directly from `effect/unstable/http`. This kept the
 * blast radius of the platform v4 move (v3 `@effect/platform` →
 * `effect/unstable/http`) to exactly this file, and documents the exact
 * platform surface the client depends on.
 */

export {
  Cookies,
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

// Type-only alias for the transport error channel of `HttpClient`, kept
// here so error modules can name it without reaching into the namespace.
export type { HttpClientError as HttpClientErrorType } from "effect/unstable/http/HttpClientError";

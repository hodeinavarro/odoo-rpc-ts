/**
 * The single funnel for everything we consume from `@effect/platform`.
 *
 * Every other module in this package imports platform values and types
 * from HERE — never directly from `@effect/platform`. This keeps the
 * blast radius of a platform major bump (v4 port-readiness) to one file,
 * and documents the exact platform surface the client depends on.
 */

export {
  Cookies,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "@effect/platform";

// Type-only alias for the transport error channel of `HttpClient`, kept
// here so error modules can name it without reaching into the namespace.
export type { HttpClientError as HttpClientErrorType } from "@effect/platform/HttpClientError";

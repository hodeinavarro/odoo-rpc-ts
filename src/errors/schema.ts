import { Data } from "effect";
import type { ParseResult } from "effect";

/**
 * A response reached us intact at the transport layer but did not match the
 * schema we decode it through — the server's wire shape drifted (a version
 * quirk, an unexpected null, a renamed field). We fail loudly with the raw
 * payload attached rather than casting past the mismatch.
 *
 * `payload` is the undecoded value exactly as received, for diagnosis.
 * `cause` is the `effect/Schema` `ParseError` describing the mismatch.
 */
export class SchemaDriftError extends Data.TaggedError("SchemaDriftError")<{
  readonly context: string;
  readonly payload: unknown;
  readonly cause: ParseResult.ParseError;
}> {}

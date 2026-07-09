import { Effect, Option, Ref } from "effect";

/** A memoized `get` whose underlying `acquire` runs at most once on success. */
export interface SingleFlight<A, E, R> {
  /**
   * Return the cached value, or acquire it. Concurrent callers race a single
   * permit so `acquire` runs once; a failure caches nothing, so the next call
   * retries. This is the success-only single-flight AGENTS.md mandates in place
   * of `Effect.cached` (which would also memoize failures).
   */
  readonly get: Effect.Effect<A, E, R>;
}

/**
 * Build a success-only single-flight cache around `acquire`.
 *
 * Invariant (AGENTS.md): only successful results are cached. A failed `acquire`
 * leaves the cache empty so callers can retry — never `Effect.cached`.
 */
export const make = <A, E, R>(
  acquire: Effect.Effect<A, E, R>,
): Effect.Effect<SingleFlight<A, E, R>, never, never> =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(Option.none<A>());
    const semaphore = yield* Effect.makeSemaphore(1);

    const get: Effect.Effect<A, E, R> = Effect.gen(function* () {
      // Fast path: already cached, no lock needed.
      const cached = yield* Ref.get(ref);
      if (Option.isSome(cached)) {
        return cached.value;
      }

      // Slow path: serialize acquisition behind the single permit.
      return yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          // Double-check: a racing caller may have filled the cache while we
          // waited for the permit.
          const again = yield* Ref.get(ref);
          if (Option.isSome(again)) {
            return again.value;
          }

          const value = yield* acquire;
          yield* Ref.set(ref, Option.some(value));
          return value;
        }),
      );
    });

    return { get };
  });

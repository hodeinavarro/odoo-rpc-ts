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
  /**
   * Drop the cached value so the next `get` re-acquires.
   *
   * GOTCHA: an acquire already in flight when `invalidate` runs will complete
   * and be returned to ITS caller, but is NOT cached — a generation counter
   * guards the write, so a stale result can never resurrect the cache.
   */
  readonly invalidate: Effect.Effect<void>;
  /** The current cached value, without triggering an acquire. */
  readonly peek: Effect.Effect<Option.Option<A>>;
}

interface State<A> {
  readonly generation: number;
  readonly value: Option.Option<A>;
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
    const ref = yield* Ref.make<State<A>>({ generation: 0, value: Option.none() });
    const semaphore = yield* Effect.makeSemaphore(1);

    const get: Effect.Effect<A, E, R> = Effect.gen(function* () {
      // Fast path: already cached, no lock needed.
      const cached = yield* Ref.get(ref);
      if (Option.isSome(cached.value)) {
        return cached.value.value;
      }

      // Slow path: serialize acquisition behind the single permit.
      return yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          // Double-check: a racing caller may have filled the cache while we
          // waited for the permit.
          const state = yield* Ref.get(ref);
          if (Option.isSome(state.value)) {
            return state.value.value;
          }

          const startGeneration = state.generation;
          const value = yield* acquire;
          // Cache only if no invalidate happened while we were acquiring.
          yield* Ref.update(ref, (current) =>
            current.generation === startGeneration
              ? { generation: current.generation, value: Option.some(value) }
              : current,
          );
          return value;
        }),
      );
    });

    const invalidate = Ref.update(ref, (current) => ({
      generation: current.generation + 1,
      value: Option.none<A>(),
    }));

    const peek = Ref.get(ref).pipe(Effect.map((state) => state.value));

    return { get, invalidate, peek };
  });

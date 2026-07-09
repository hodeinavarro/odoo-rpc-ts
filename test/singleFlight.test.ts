import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref } from "effect";
import * as SingleFlight from "../src/internal/singleFlight.ts";

describe("singleFlight.make", () => {
  it.effect("caches a successful acquire (runs once across calls)", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const cache = yield* SingleFlight.make(Ref.updateAndGet(calls, (n) => n + 1));

      const first = yield* cache.get;
      const second = yield* cache.get;

      assert.strictEqual(first, 1);
      assert.strictEqual(second, 1);
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("collapses concurrent callers into a single acquire", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const cache = yield* SingleFlight.make(
        Effect.gen(function* () {
          // A yield point so the fibers actually interleave under the permit.
          yield* Effect.yieldNow();
          return yield* Ref.updateAndGet(calls, (n) => n + 1);
        }),
      );

      const results = yield* Effect.all([cache.get, cache.get, cache.get, cache.get], {
        concurrency: "unbounded",
      });

      assert.deepStrictEqual(results, [1, 1, 1, 1]);
      assert.strictEqual(yield* Ref.get(calls), 1);
    }),
  );

  it.effect("does not cache failures — a later call can still succeed", () =>
    Effect.gen(function* () {
      const attempts = yield* Ref.make(0);
      const cache = yield* SingleFlight.make(
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(attempts, (x) => x + 1);
          if (n === 1) {
            return yield* Effect.fail("first attempt fails" as const);
          }
          return n;
        }),
      );

      const firstExit = yield* Effect.exit(cache.get);
      assert.isTrue(firstExit._tag === "Failure");

      // Failure cached nothing, so the retry re-runs acquire and succeeds.
      const second = yield* cache.get;
      assert.strictEqual(second, 2);

      // And the success is now cached: no further acquire.
      const third = yield* cache.get;
      assert.strictEqual(third, 2);
      assert.strictEqual(yield* Ref.get(attempts), 2);
    }),
  );

  it.effect("invalidate drops the cache so the next get re-acquires", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const cache = yield* SingleFlight.make(Ref.updateAndGet(calls, (n) => n + 1));

      assert.strictEqual(yield* cache.get, 1);
      assert.deepStrictEqual(yield* cache.peek, Option.some(1));

      yield* cache.invalidate;
      assert.deepStrictEqual(yield* cache.peek, Option.none());

      assert.strictEqual(yield* cache.get, 2);
      assert.strictEqual(yield* Ref.get(calls), 2);
    }),
  );

  it.effect("an acquire in flight during invalidate cannot resurrect the cache", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0);
      const gate = yield* Deferred.make<void>();
      const cache = yield* SingleFlight.make(
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(calls, (x) => x + 1);
          if (n === 1) {
            // Hold the FIRST acquire open so invalidate can race it.
            yield* Deferred.await(gate);
          }
          return n;
        }),
      );

      const inFlight = yield* Effect.fork(cache.get);
      yield* Effect.yieldNow(); // let the fiber reach the gate

      // Invalidate while the acquire is mid-flight...
      yield* cache.invalidate;
      yield* Deferred.succeed(gate, undefined);

      // ...its caller still receives the value it acquired,
      assert.strictEqual(yield* Fiber.join(inFlight), 1);
      // but the stale result must NOT have been cached,
      assert.deepStrictEqual(yield* cache.peek, Option.none());
      // and the next get re-acquires fresh.
      assert.strictEqual(yield* cache.get, 2);
      assert.strictEqual(yield* Ref.get(calls), 2);
    }),
  );
});

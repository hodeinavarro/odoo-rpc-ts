import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Ref, Array as Arr } from "effect";
import { GlobalContext, layer as rpcLayer, layerSeeded, layerWith, Rpc } from "../src/rpc.ts";
import * as FakeTransport from "../src/testing/fakeTransport.ts";

// v4 Cause is a flat failure list; recover the single typed error the way the
// v3 `cause._tag === "Fail" ? cause.error` narrow did.
const firstError = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  exit._tag === "Failure"
    ? exit.cause.reasons.flatMap((r) => (r._tag === "Fail" ? [r.error] : []))[0]
    : undefined;

const lastContext = (log: ReadonlyArray<{ readonly kwargs: Record<string, unknown> }>) =>
  log[log.length - 1]?.kwargs["context"];

const countMethod = (
  log: ReadonlyArray<{ readonly model: string; readonly method: string }>,
  model: string,
  method: string,
) => log.filter((c) => c.model === model && c.method === method).length;

describe("Rpc.callKw — context merge", () => {
  it.effect("merges session < layer overrides < caller (later wins)", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({ m: { ping: () => true } });
      const layer = layerWith({ globalContext: { b: "layer", c: "layer" } }).pipe(
        Layer.provide(fake.layer),
        Layer.provide(Layer.succeed(GlobalContext, { a: "base", b: "base", c: "base" })),
      );

      yield* Rpc.pipe(
        Effect.flatMap((rpc) => rpc.callKw("m", "ping", [], {}, { context: { c: "caller" } })),
        Effect.provide(layer),
      );

      const log = yield* Ref.get(fake.callLog);
      assert.deepStrictEqual(lastContext(log), { a: "base", b: "layer", c: "caller" });
    }),
  );

  it.effect("default layer is seeded: base tier comes from res.users.context_get", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({
        m: { ping: () => true },
        "res.users": { context_get: () => ({ lang: "es_ES", tz: "Europe/Madrid" }) },
      });
      const layer = rpcLayer.pipe(Layer.provide(fake.layer));

      yield* Rpc.pipe(
        Effect.flatMap((rpc) => rpc.callKw("m", "ping", [])),
        Effect.provide(layer),
      );

      const log = yield* Ref.get(fake.callLog);
      assert.deepStrictEqual(lastContext(log), { lang: "es_ES", tz: "Europe/Madrid" });
    }),
  );

  it.effect("layerWith (no provider) defaults the base context to {}", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({ m: { ping: () => true } });
      const layer = layerWith().pipe(Layer.provide(fake.layer));

      yield* Rpc.pipe(
        Effect.flatMap((rpc) => rpc.callKw("m", "ping", [])),
        Effect.provide(layer),
      );

      const log = yield* Ref.get(fake.callLog);
      assert.deepStrictEqual(lastContext(log), {});
    }),
  );

  it.effect(
    "treats kwargs.context as a caller tier: base < layer < kwargs.context < options.context",
    () =>
      Effect.gen(function* () {
        const fake = FakeTransport.make({ m: { ping: () => true } });
        const layer = layerWith({ globalContext: { b: "layer", c: "layer", d: "layer" } }).pipe(
          Layer.provide(fake.layer),
          Layer.provide(
            Layer.succeed(GlobalContext, { a: "base", b: "base", c: "base", d: "base" }),
          ),
        );

        yield* Rpc.pipe(
          Effect.flatMap((rpc) =>
            rpc.callKw(
              "m",
              "ping",
              [],
              { x: 1, context: { c: "kwargs", d: "kwargs" } },
              {
                context: { d: "options" },
              },
            ),
          ),
          Effect.provide(layer),
        );

        const log = yield* Ref.get(fake.callLog);
        // kwargs.context beats layer for `c`; options.context beats kwargs.context for `d`.
        assert.deepStrictEqual(lastContext(log), {
          a: "base",
          b: "layer",
          c: "kwargs",
          d: "options",
        });
        // context is stripped from kwargs, never wired twice.
        assert.deepStrictEqual(log[0]?.kwargs, {
          x: 1,
          context: { a: "base", b: "layer", c: "kwargs", d: "options" },
        });
      }),
  );

  it.effect("dies when kwargs.context is present but not a plain object", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({ m: { ping: () => true } });
      const layer = layerWith().pipe(Layer.provide(fake.layer));

      const exit = yield* Rpc.pipe(
        Effect.flatMap((rpc) =>
          rpc.callKw("m", "ping", [], { context: [1, 2] as unknown as Record<string, unknown> }),
        ),
        Effect.provide(layer),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const die = Arr.head(
          exit.cause.reasons.flatMap((r) => (r._tag === "Die" ? [r.defect] : [])),
        );
        assert.isTrue(Option.isSome(die));
        if (Option.isSome(die)) {
          assert.include(String(die.value), "kwargs.context");
        }
      }
    }),
  );

  it.effect("layerSeeded seeds the base tier from res.users.context_get", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({
        "res.users": { context_get: () => ({ lang: "es_ES", tz: "Europe/Madrid" }) },
        m: { ping: () => true },
      });
      const layer = layerSeeded().pipe(Layer.provide(fake.layer));

      yield* Rpc.pipe(
        Effect.flatMap((rpc) => rpc.callKw("m", "ping", [], {}, { context: { c: "caller" } })),
        Effect.provide(layer),
      );

      const log = yield* Ref.get(fake.callLog);
      // The seeded lang/tz sit at the base tier, below the caller context.
      assert.deepStrictEqual(lastContext(log), {
        lang: "es_ES",
        tz: "Europe/Madrid",
        c: "caller",
      });
    }),
  );

  it.effect("layerSeeded resolves the provider once across many calls (single-flight)", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({
        "res.users": { context_get: () => ({ lang: "en_US" }) },
        m: { ping: () => true },
      });
      const layer = layerSeeded().pipe(Layer.provide(fake.layer));

      yield* Rpc.pipe(
        Effect.flatMap((rpc) =>
          Effect.gen(function* () {
            yield* rpc.callKw("m", "ping", []);
            yield* rpc.callKw("m", "ping", []);
            yield* rpc.callKw("m", "ping", []);
          }),
        ),
        Effect.provide(layer),
      );

      const log = yield* Ref.get(fake.callLog);
      assert.strictEqual(countMethod(log, "res.users", "context_get"), 1);
      assert.strictEqual(countMethod(log, "m", "ping"), 3);
    }),
  );

  it.effect("layerSeeded: a failed seed surfaces as the call error and is retryable", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const fake = FakeTransport.make({
        "res.users": {
          // First seed attempt drifts (a non-object payload → SchemaDriftError);
          // the second succeeds. Success-only single-flight must retry.
          context_get: () => (attempts++ === 0 ? "not-an-object" : { lang: "en_US" }),
        },
        m: { ping: () => true },
      });
      const layer = layerSeeded().pipe(Layer.provide(fake.layer));

      yield* Rpc.pipe(
        Effect.flatMap((rpc) =>
          Effect.gen(function* () {
            const first = yield* rpc.callKw("m", "ping", []).pipe(Effect.exit);
            assert.isTrue(Exit.isFailure(first));
            const firstErr = firstError(first);
            if (firstErr !== undefined) {
              assert.strictEqual(firstErr._tag, "SchemaDriftError");
            }
            // The seed retries on the next call and now succeeds.
            yield* rpc.callKw("m", "ping", []);
          }),
        ),
        Effect.provide(layer),
      );

      const log = yield* Ref.get(fake.callLog);
      assert.strictEqual(countMethod(log, "res.users", "context_get"), 2);
      assert.deepStrictEqual(lastContext(log), { lang: "en_US" });
    }),
  );

  it.effect("layerWith without a provider keeps today's behavior (no seeding call)", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({ m: { ping: () => true } });
      const layer = layerWith({ globalContext: { a: "layer" } }).pipe(Layer.provide(fake.layer));

      yield* Rpc.pipe(
        Effect.flatMap((rpc) => rpc.callKw("m", "ping", [])),
        Effect.provide(layer),
      );

      const log = yield* Ref.get(fake.callLog);
      assert.strictEqual(countMethod(log, "res.users", "context_get"), 0);
      assert.deepStrictEqual(lastContext(log), { a: "layer" });
    }),
  );

  it.effect("never mutates caller kwargs or context inputs", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({ m: { ping: () => true } });
      const layer = rpcLayer.pipe(Layer.provide(fake.layer));

      const callerKwargs = { x: 1 };
      const callerContext = { c: "caller" };

      yield* Rpc.pipe(
        Effect.flatMap((rpc) =>
          rpc.callKw("m", "ping", [], callerKwargs, { context: callerContext }),
        ),
        Effect.provide(layer),
      );

      // Originals untouched: no `context` leaked into kwargs, no keys added.
      assert.deepStrictEqual(callerKwargs, { x: 1 });
      assert.deepStrictEqual(callerContext, { c: "caller" });

      const log = yield* Ref.get(fake.callLog);
      const received = log[0]?.kwargs;
      assert.notStrictEqual(received, callerKwargs);
      assert.deepStrictEqual(received, { x: 1, context: { c: "caller" } });
      // The merged context is a fresh object, not the caller's.
      assert.notStrictEqual(received?.["context"], callerContext);
    }),
  );
});

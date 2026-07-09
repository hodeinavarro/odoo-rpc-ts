import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option, Ref } from "effect";
import { GlobalContext, layer as rpcLayer, layerWith, Rpc } from "../src/rpc.ts";
import * as FakeTransport from "../src/testing/fakeTransport.ts";

const lastContext = (log: ReadonlyArray<{ readonly kwargs: Record<string, unknown> }>) =>
  log[log.length - 1]?.kwargs["context"];

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

  it.effect("defaults session/base context to {} when GlobalContext is absent", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({ m: { ping: () => true } });
      const layer = rpcLayer.pipe(Layer.provide(fake.layer));

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
      const layer = rpcLayer.pipe(Layer.provide(fake.layer));

      const exit = yield* Rpc.pipe(
        Effect.flatMap((rpc) =>
          rpc.callKw("m", "ping", [], { context: [1, 2] as unknown as Record<string, unknown> }),
        ),
        Effect.provide(layer),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        const die = Cause.dieOption(exit.cause);
        assert.isTrue(Option.isSome(die));
        if (Option.isSome(die)) {
          assert.include(String(die.value), "kwargs.context");
        }
      }
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

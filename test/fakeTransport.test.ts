import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option, Ref, Array as Arr } from "effect";
import { OdooTransportError } from "../src/errors/transport.ts";
import { Transport } from "../src/transport.ts";
import * as FakeTransport from "../src/testing/fakeTransport.ts";

describe("FakeTransport", () => {
  it.effect("dispatches to the scripted handler and records the call", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({
        "res.partner": {
          search_count: (params) => (params.args.length === 1 ? 7 : 0),
        },
      });

      const result = yield* Transport.pipe(
        Effect.flatMap((t) =>
          t.callKw({
            model: "res.partner",
            method: "search_count",
            args: [[]],
            kwargs: { context: { lang: "en_US" } },
          }),
        ),
        Effect.provide(fake.layer),
      );

      assert.strictEqual(result, 7);

      const log = yield* Ref.get(fake.callLog);
      assert.strictEqual(log.length, 1);
      assert.strictEqual(log[0]?.model, "res.partner");
      assert.strictEqual(log[0]?.method, "search_count");
      assert.deepStrictEqual(log[0]?.kwargs, { context: { lang: "en_US" } });
    }),
  );

  it.effect("lets a handler script a typed transport failure", () =>
    Effect.gen(function* () {
      const boom = new OdooTransportError({
        request: { method: "POST", url: "https://odoo.test/jsonrpc" },
        kind: "TransportError",
      });
      const fake = FakeTransport.make({
        "res.users": {
          read: () => Effect.fail(boom),
        },
      });

      const exit = yield* Transport.pipe(
        Effect.flatMap((t) =>
          t.callKw({ model: "res.users", method: "read", args: [[1]], kwargs: {} }),
        ),
        Effect.provide(fake.layer),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("dies (defect, not typed error) on an unhandled model/method", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make({ "res.partner": { search: () => [] } });

      const exit = yield* Transport.pipe(
        Effect.flatMap((t) =>
          t.callKw({ model: "res.partner", method: "unlink", args: [[1]], kwargs: {} }),
        ),
        Effect.provide(fake.layer),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit)) {
        // A defect (die), never a value in the typed failure channel.
        const die = Arr.head(
          exit.cause.reasons.flatMap((r) => (r._tag === "Die" ? [r.defect] : [])),
        );
        assert.isTrue(Option.isSome(die));
        assert.strictEqual(
          Option.getOrThrow(die),
          "FakeTransport: no handler for res.partner.unlink",
        );
      }
    }),
  );
});

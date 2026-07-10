import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";
import { layer as clientLayer, OdooClient } from "../src/client.ts";
import {
  Command,
  type ClearCommand,
  type CommandTuple,
  type CreateCommand,
  type SetCommand,
  type X2ManyCommands,
} from "../src/commands.ts";
import { layer as rpcLayer } from "../src/rpc.ts";
import * as FakeTransport from "../src/testing/fakeTransport.ts";

describe("Command constructors (exact wire triples)", () => {
  it("encodes every command per Odoo's Command namespace", () => {
    assert.deepStrictEqual(Command.create({ name: "line" }), [0, 0, { name: "line" }]);
    assert.deepStrictEqual(Command.update(7, { qty: 2 }), [1, 7, { qty: 2 }]);
    assert.deepStrictEqual(Command.delete(7), [2, 7, 0]);
    assert.deepStrictEqual(Command.unlink(7), [3, 7, 0]);
    assert.deepStrictEqual(Command.link(7), [4, 7, 0]);
    assert.deepStrictEqual(Command.clear(), [5, 0, 0]);
    assert.deepStrictEqual(Command.set([1, 2, 3]), [6, 0, [1, 2, 3]]);
  });
});

// Type-level assertions: the first tuple element must stay a literal code, and
// each constructor must produce its exact command type. `satisfies` fails the
// typecheck (pnpm check) if any encoding drifts, at zero runtime cost.
{
  const _create = Command.create({ name: "x" }) satisfies readonly [0, 0, unknown];
  const _createExact: CreateCommand = Command.create({ name: "x" });
  const _update = Command.update(1, {}) satisfies readonly [1, number, unknown];
  const _delete = Command.delete(1) satisfies readonly [2, number, 0];
  const _unlink = Command.unlink(1) satisfies readonly [3, number, 0];
  const _link = Command.link(1) satisfies readonly [4, number, 0];
  const _clear = Command.clear() satisfies ClearCommand;
  const _set = Command.set([1]) satisfies SetCommand;
  const _tuple: CommandTuple = Command.link(1);
  const _list: X2ManyCommands = [Command.create({ a: 1 }), Command.link(2), Command.clear()];
  void [_create, _createExact, _update, _delete, _unlink, _link, _clear, _set, _tuple, _list];
}

const handlers: FakeTransport.FakeHandlers = {
  "sale.order": {
    write: () => true,
  },
};

describe("Command passthrough via OdooClient.write", () => {
  it.effect("commands ride the write payload unchanged to the transport", () =>
    Effect.gen(function* () {
      const fake = FakeTransport.make(handlers);
      const layer = clientLayer.pipe(Layer.provide(rpcLayer), Layer.provide(fake.layer));

      const lines: X2ManyCommands = [
        Command.create({ product_id: 42, product_uom_qty: 1 }),
        Command.update(99, { price_unit: 10 }),
        Command.unlink(7),
      ];

      const ok = yield* Effect.provide(
        OdooClient.pipe(Effect.flatMap((c) => c.write("sale.order", [1], { order_line: lines }))),
        layer,
      );
      assert.strictEqual(ok, true);

      const log = yield* Ref.get(fake.callLog);
      assert.strictEqual(log.length, 1);
      const call = log[0]!;
      assert.strictEqual(call.model, "sale.order");
      assert.strictEqual(call.method, "write");
      // The x2many triples must reach the transport byte-for-byte.
      assert.deepStrictEqual(call.kwargs["vals"], {
        order_line: [
          [0, 0, { product_id: 42, product_uom_qty: 1 }],
          [1, 99, { price_unit: 10 }],
          [3, 7, 0],
        ],
      });
    }),
  );
});

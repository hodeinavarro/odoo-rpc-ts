import { NodeHttpClient } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

describe("Node platform runtime", () => {
  it.effect("loads the Node HTTP client with the pinned Effect modules", () =>
    Effect.sync(() => {
      assert.isDefined(NodeHttpClient.layerUndici);
    }),
  );
});

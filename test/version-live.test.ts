import { assert, describe, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import type { CommonVersionResponse } from "../src/version.ts";
import * as VersionLive from "../src/version-live.ts";

const commonResponse = (info: ReadonlyArray<number | string>): CommonVersionResponse => ({
  server_version: `${info[0]}.0`,
  server_version_info: info,
  server_serie: `${info[0]}.0`,
  protocol_version: 1,
});

describe("version-live.make", () => {
  it.effect("single-flights the probe: resolve twice, probe runs once", () =>
    Effect.gen(function* () {
      const probes = yield* Ref.make(0);
      const probe = Effect.zipRight(
        Ref.update(probes, (n) => n + 1),
        Effect.succeed(commonResponse([19, 0, 0, "final", 0])),
      );

      const resolver = yield* VersionLive.make(probe);
      const first = yield* resolver.resolve;
      const second = yield* resolver.resolve;

      assert.strictEqual(yield* Ref.get(probes), 1);
      assert.strictEqual(first.version.major, 19);
      assert.strictEqual(second.version.major, 19);
    }),
  );

  it.effect("derives capabilities for 19 (JSON-2, legacy deprecated)", () =>
    Effect.gen(function* () {
      const resolver = yield* VersionLive.make(
        Effect.succeed(commonResponse([19, 0, 0, "final", 0])),
      );
      const resolved = yield* resolver.resolve;

      assert.strictEqual(resolved.version.major, 19);
      assert.deepStrictEqual(resolved.capabilities, {
        supportsJson2: true,
        jsonRpcDeprecated: true,
        supportsWebReadSpec: true,
      });
    }),
  );

  it.effect("derives capabilities for 16 (no JSON-2, legacy live)", () =>
    Effect.gen(function* () {
      const resolver = yield* VersionLive.make(
        Effect.succeed(commonResponse([16, 0, 0, "final", 0])),
      );
      const resolved = yield* resolver.resolve;

      assert.strictEqual(resolved.version.major, 16);
      assert.deepStrictEqual(resolved.capabilities, {
        supportsJson2: false,
        jsonRpcDeprecated: false,
        supportsWebReadSpec: false,
      });
    }),
  );

  it.effect("accepts the web `{ version, version_info }` probe shape", () =>
    Effect.gen(function* () {
      const resolver = yield* VersionLive.make(
        Effect.succeed({ version: "17.0", version_info: [17, 0, 0, "final", 0] }),
      );
      const resolved = yield* resolver.resolve;

      assert.strictEqual(resolved.version.major, 17);
      assert.isFalse(resolved.capabilities.supportsJson2);
    }),
  );
});

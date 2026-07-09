/**
 * LIVE version-resolution specs: wire `VersionResolverLive` over the real
 * `common.version` JSON-RPC probe and assert the derived capabilities match the
 * running major. Skips itself when no harness stack is up.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import {
  JsonRpcTransport,
  VersionResolver,
  VersionResolverLive,
} from "../src/index.ts";
import { apiKeyConfig, hasStack, majorVersion, TIMEOUT_MS } from "./support.ts";

/**
 * The `common.version` probe, run on a real HttpClient and narrowed to the
 * `VersionResolver`'s probe-error channel: `common.version` is unauthenticated
 * and cannot legitimately raise an auth/server fault, so those branches are
 * defects if they ever fire.
 */
const versionProbe = () =>
  JsonRpcTransport.makeVersion(apiKeyConfig()).pipe(
    Effect.provide(NodeHttpClient.layer),
    Effect.catchTags({
      OdooAuthenticationError: (e) => Effect.die(e),
      SessionExpiredError: (e) => Effect.die(e),
      OdooServerError: (e) => Effect.die(e),
      OdooAccessError: (e) => Effect.die(e),
      OdooValidationError: (e) => Effect.die(e),
      OdooMissingError: (e) => Effect.die(e),
      OdooUserError: (e) => Effect.die(e),
      OdooLockError: (e) => Effect.die(e),
    }),
  );

describe.skipIf(!hasStack)("version resolver (live)", () => {
  it.live.skipIf(!hasStack)(
    "resolves the running major and derives supportsJson2 correctly",
    () =>
      Effect.gen(function* () {
        const resolver = yield* VersionResolver;
        const resolved = yield* resolver.resolve;

        assert.strictEqual(resolved.version.major, majorVersion);
        assert.strictEqual(resolved.capabilities.supportsJson2, majorVersion >= 19);
        assert.strictEqual(resolved.capabilities.jsonRpcDeprecated, majorVersion >= 19);
      }).pipe(Effect.provide(VersionResolverLive.layer(versionProbe()))),
    TIMEOUT_MS,
  );
});

/**
 * LIVE web-route (`/web/dataset/call_kw`, cookie session) integration specs.
 * All through the public surface; skips itself when no harness stack is up.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted, Ref } from "effect";
import { Cookies } from "effect/unstable/http";
import { NodeHttpClient } from "@effect/platform-node";
import {
  CookieSession,
  CookieSessionLive,
  OdooClient,
  OdooClientLive,
  RpcLive,
  WebTransport,
  retryOnSessionExpired,
} from "../src/index.ts";
import {
  badPasswordConfig,
  hasStack,
  marker,
  passwordConfig,
  restrictedPasswordConfig,
  TIMEOUT_MS,
} from "./support.ts";

/** Just the cookie session (login-only specs). */
const sessionLayer = (config = passwordConfig()): Layer.Layer<CookieSession> =>
  CookieSessionLive.layer(config).pipe(Layer.provide(NodeHttpClient.layerUndici));

/** OdooClient + CookieSession over the web transport, on a real Node HttpClient. */
const appLayer = (config = passwordConfig()): Layer.Layer<OdooClient | CookieSession> => {
  const transport = WebTransport.layer(config).pipe(Layer.provideMerge(sessionLayer(config)));
  const rpc = RpcLive.layer.pipe(Layer.provideMerge(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc)) as Layer.Layer<
    OdooClient | CookieSession
  >;
};

/** OdooClient over an INJECTED (harvested) cookie session — no credentials. */
const existingAppLayer = (sessionId: string): Layer.Layer<OdooClient | CookieSession> => {
  const url = passwordConfig().url;
  const session = CookieSessionLive.layerFromExisting({
    url,
    sessionId: Redacted.make(sessionId),
  }).pipe(Layer.provide(NodeHttpClient.layerUndici));
  const transport = WebTransport.layer({ url }).pipe(Layer.provideMerge(session));
  const rpc = RpcLive.layer.pipe(Layer.provideMerge(transport));
  return OdooClientLive.layer.pipe(Layer.provideMerge(rpc)) as Layer.Layer<
    OdooClient | CookieSession
  >;
};

describe.skipIf(!hasStack)("web (live)", () => {
  it.live.skipIf(!hasStack)(
    "CookieSession.login with password creds yields a real uid + session_info",
    () =>
      Effect.gen(function* () {
        const session = yield* CookieSession;
        const info = yield* session.login;
        assert.isAbove(info.uid, 0);
        // session_info decoded: user_context is a dict, raw carries the payload.
        assert.isObject(info.userContext);
        assert.property(info.raw, "uid");
      }).pipe(Effect.provide(sessionLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "OdooClient round trip over WebTransport; the session survives two sequential ops",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        // Two sequential calls on the same cookie jar; both succeeding proves the
        // session_id cookie is carried across round trips (no re-login needed).
        const count = yield* client.searchCount("res.partner", []);
        assert.isAtLeast(count, 0);
        const rows = yield* client.searchRead("res.partner", { fields: ["id"], limit: 1 });
        assert.isAtMost(rows.length, 1);
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "create/unlink round trip over WebTransport",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const name = marker();
        const ids = yield* client.create("res.partner", { name });
        yield* Effect.gen(function* () {
          const read = yield* client.read("res.partner", ids, ["name"]);
          assert.strictEqual(read[0]?.["name"], name);
        }).pipe(Effect.ensuring(client.unlink("res.partner", ids).pipe(Effect.ignore)));
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "write round trip over WebTransport, including the write([], vals) no-op",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const name = marker();
        const ids = yield* client.create("res.partner", { name });
        yield* Effect.gen(function* () {
          // End-to-end proof of the call_kw envelope: args=[ids, vals], vals
          // positional (a `vals=` kwarg breaks on renamed write overrides).
          const wrote = yield* client.write("res.partner", ids, { ref: `${name}-ref` });
          assert.strictEqual(wrote, true);
          const read = yield* client.read("res.partner", ids, ["ref"]);
          assert.strictEqual(read[0]?.["ref"], `${name}-ref`);
          // Empty-ids no-op: the server accepts args=[[], vals] and returns true.
          const noop = yield* client.write("res.partner", [], { ref: `${name}-noop` });
          assert.strictEqual(noop, true);
          const untouched = yield* client.read("res.partner", ids, ["ref"]);
          assert.strictEqual(untouched[0]?.["ref"], `${name}-ref`);
        }).pipe(Effect.ensuring(client.unlink("res.partner", ids).pipe(Effect.ignore)));
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "valid restricted session → OdooAccessError for sale.order.create",
    () =>
      Effect.gen(function* () {
        const session = yield* CookieSession;
        yield* session.login;
        const client = yield* OdooClient;
        const error = yield* client.create("sale.order", { partner_id: 1 }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooAccessError");
        if (error._tag === "OdooAccessError") {
          assert.strictEqual(error.name, "odoo.exceptions.AccessError");
          assert.strictEqual(error.model, "sale.order");
          assert.strictEqual(error.method, "create");
        }
      }).pipe(Effect.provide(appLayer(restrictedPasswordConfig()))),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "an invalid password → OdooAuthenticationError",
    () =>
      Effect.gen(function* () {
        const session = yield* CookieSession;
        const error = yield* session.login.pipe(Effect.flip);
        assert.strictEqual(error._tag, "OdooAuthenticationError");
      }).pipe(Effect.provide(sessionLayer(badPasswordConfig()))),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "fromExisting adopts a harvested session_id: real session_info + call_kw, no credentials",
    () =>
      Effect.gen(function* () {
        // Mint a session with credentials, then HARVEST the cookie — exactly
        // what an embedded login window's cookie jar hands a desktop shell.
        const minted = yield* CookieSession;
        const mintedInfo = yield* minted.login;
        const jar = yield* Ref.get(minted.cookies);
        const harvested = Option.getOrThrow(Cookies.getValue(jar, "session_id"));

        yield* Effect.gen(function* () {
          const injected = yield* CookieSession;
          const info = yield* injected.login;
          // Honest hydration via get_session_info: same real uid.
          assert.strictEqual(info.uid, mintedInfo.uid);
          assert.property(info.raw, "uid");
          const client = yield* OdooClient;
          const count = yield* client.searchCount("res.partner", []);
          assert.isAtLeast(count, 0);

          // The cannot-recover contract, live: invalidate (no renew hook) →
          // login fails fast with SessionExpiredError.
          yield* injected.invalidate;
          const error = yield* injected.login.pipe(Effect.flip);
          assert.strictEqual(error._tag, "SessionExpiredError");
        }).pipe(Effect.provide(existingAppLayer(harvested)));
      }).pipe(Effect.provide(sessionLayer())),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "fromExisting with a dead cookie → SessionExpiredError on login",
    () =>
      Effect.gen(function* () {
        const injected = yield* CookieSession;
        const error = yield* injected.login.pipe(Effect.flip);
        assert.strictEqual(error._tag, "SessionExpiredError");
      }).pipe(Effect.provide(existingAppLayer("deadbeef-invalid-session"))),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "retryOnSessionExpired recovers a poisoned session",
    () =>
      Effect.gen(function* () {
        const client = yield* OdooClient;
        const session = yield* CookieSession;

        // Establish and cache a live session (fills the single-flight).
        yield* session.login;

        // Poison ONLY the cookie jar with a bogus session_id, leaving the cached
        // flight intact — so `login` will NOT re-auth on its own and the next
        // call_kw hits Odoo with a dead cookie → SessionExpiredError (code 100).
        yield* Ref.set(
          session.cookies,
          Cookies.fromSetCookie("session_id=deadbeef-invalid-session; Path=/"),
        );

        // Through the combinator: the first attempt fails with SessionExpiredError,
        // which invalidates + re-logins once and retries → recovery.
        const count = yield* retryOnSessionExpired(client.searchCount("res.partner", []), session);
        assert.isAtLeast(count, 0);
      }).pipe(Effect.provide(appLayer())),
    TIMEOUT_MS,
  );
});

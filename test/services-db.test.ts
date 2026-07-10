import { assert, describe, it } from "@effect/vitest";
import { Effect, Encoding, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "../src/internal/platform.ts";
import * as Db from "../src/services/db.ts";

interface DecodedRequest {
  readonly service: string;
  readonly method: string;
  readonly args: ReadonlyArray<unknown>;
}

interface Stub {
  readonly calls: Array<DecodedRequest>;
  readonly client: HttpClient.HttpClient;
}

/**
 * A fake `HttpClient` that decodes the outbound `/jsonrpc` body, records the
 * `{service, method, args}`, and returns whatever JSON `respond` produces.
 */
const stubHttpClient = (respond: (req: DecodedRequest) => unknown): Stub => {
  const calls: Array<DecodedRequest> = [];
  const client = HttpClient.make((request) => {
    const body = request.body;
    const decoded =
      body._tag === "Uint8Array"
        ? (JSON.parse(new TextDecoder().decode(body.body)) as { params: DecodedRequest })
        : { params: { service: "", method: "", args: [] } };
    calls.push(decoded.params);
    const web = new Response(JSON.stringify(respond(decoded.params)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    return Effect.succeed(HttpClientResponse.fromWeb(request, web));
  });
  return { calls, client };
};

const URL_ = new URL("https://odoo.example.com");
const MASTER = Redacted.make("master");

const ok = (result: unknown) => ({ jsonrpc: "2.0", id: 1, result });
const fault = (code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  error: { code, message, ...(data !== undefined ? { data } : {}) },
});

const provide = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  stub: Stub,
): Effect.Effect<A, E> => effect.pipe(Effect.provideService(HttpClient.HttpClient, stub.client));

describe("DbService arg encodings", () => {
  it.effect("listDatabases → service=db method=list, no args", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(["odoo_a", "odoo_b"]));
      const dbs = yield* provide(Db.listDatabases(URL_), stub);
      assert.deepStrictEqual(dbs, ["odoo_a", "odoo_b"]);
      assert.strictEqual(stub.calls[0]?.service, "db");
      assert.strictEqual(stub.calls[0]?.method, "list");
      assert.deepStrictEqual(stub.calls[0]?.args, []);
    }),
  );

  it.effect("exists → method=db_exist, args=[name]", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(true));
      const present = yield* provide(Db.exists(URL_, "odoo_a"), stub);
      assert.strictEqual(present, true);
      assert.strictEqual(stub.calls[0]?.method, "db_exist");
      assert.deepStrictEqual(stub.calls[0]?.args, ["odoo_a"]);
    }),
  );

  it.effect("create → full positional arg vector with defaults", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(true));
      yield* provide(
        Db.create(URL_, {
          master: MASTER,
          name: "fresh",
          adminPassword: Redacted.make("adminpw"),
        }),
        stub,
      );
      assert.strictEqual(stub.calls[0]?.method, "create_database");
      // [master, name, demo, lang, admin_password, login, country_code, phone]
      assert.deepStrictEqual(stub.calls[0]?.args, [
        "master",
        "fresh",
        false,
        "en_US",
        "adminpw",
        "admin",
        null,
        null,
      ]);
    }),
  );

  it.effect("create → explicit options land in the right positions", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(true));
      yield* provide(
        Db.create(URL_, {
          master: MASTER,
          name: "fresh",
          demo: true,
          lang: "fr_FR",
          adminLogin: "root",
          adminPassword: Redacted.make("adminpw"),
          countryCode: "FR",
          phone: "+33",
        }),
        stub,
      );
      assert.deepStrictEqual(stub.calls[0]?.args, [
        "master",
        "fresh",
        true,
        "fr_FR",
        "adminpw",
        "root",
        "FR",
        "+33",
      ]);
    }),
  );

  it.effect("drop → method=drop, args=[master, name], returns boolean", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(true));
      const dropped = yield* provide(Db.drop(URL_, MASTER, "scratch"), stub);
      assert.strictEqual(dropped, true);
      assert.strictEqual(stub.calls[0]?.method, "drop");
      assert.deepStrictEqual(stub.calls[0]?.args, ["master", "scratch"]);
    }),
  );

  it.effect("duplicate → args=[master, source, target, neutralize]", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(true));
      yield* provide(Db.duplicate(URL_, MASTER, "src", "dst", { neutralize: true }), stub);
      assert.strictEqual(stub.calls[0]?.method, "duplicate_database");
      assert.deepStrictEqual(stub.calls[0]?.args, ["master", "src", "dst", true]);
    }),
  );

  it.effect("duplicate → neutralize defaults to false", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(true));
      yield* provide(Db.duplicate(URL_, MASTER, "src", "dst"), stub);
      assert.deepStrictEqual(stub.calls[0]?.args, ["master", "src", "dst", false]);
    }),
  );

  it.effect("changeMasterPassword → args=[master, next]", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(true));
      yield* provide(Db.changeMasterPassword(URL_, MASTER, Redacted.make("newpw")), stub);
      assert.strictEqual(stub.calls[0]?.method, "change_admin_password");
      assert.deepStrictEqual(stub.calls[0]?.args, ["master", "newpw"]);
    }),
  );
});

describe("DbService base64 dump/restore", () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]); // "PK\x03\x04\x00\xff"
  const base64 = Encoding.encodeBase64(bytes);

  it.effect("dump → decodes the base64 result to the exact bytes", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(base64));
      const out = yield* provide(Db.dump(URL_, MASTER, "odoo_a"), stub);
      assert.deepStrictEqual(Array.from(out), Array.from(bytes));
      assert.strictEqual(stub.calls[0]?.method, "dump");
      assert.deepStrictEqual(stub.calls[0]?.args, ["master", "odoo_a", "zip"]);
    }),
  );

  it.effect("dump → honours an explicit format", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(base64));
      yield* provide(Db.dump(URL_, MASTER, "odoo_a", "dump"), stub);
      assert.deepStrictEqual(stub.calls[0]?.args, ["master", "odoo_a", "dump"]);
    }),
  );

  it.effect("restore → re-encodes the bytes to base64 in the request", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok(true));
      yield* provide(Db.restore(URL_, MASTER, "restored", bytes, { copy: true }), stub);
      assert.strictEqual(stub.calls[0]?.method, "restore");
      assert.deepStrictEqual(stub.calls[0]?.args, ["master", "restored", base64, true]);
    }),
  );

  it.effect("dump → malformed base64 surfaces as SchemaDriftError", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ok("not valid base64 !!!"));
      const error = yield* provide(Db.dump(URL_, MASTER, "odoo_a"), stub).pipe(Effect.flip);
      assert.strictEqual(error._tag, "SchemaDriftError");
    }),
  );
});

describe("DbService fault mapping", () => {
  it.effect("wrong master (AccessDenied) → OdooAuthenticationError", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() =>
        fault(200, "Odoo Server Error", { name: "odoo.exceptions.AccessDenied" }),
      );
      const error = yield* provide(Db.drop(URL_, Redacted.make("wrong"), "x"), stub).pipe(
        Effect.flip,
      );
      assert.strictEqual(error._tag, "OdooAuthenticationError");
    }),
  );

  it.effect("a garbage response body → SchemaDriftError", () =>
    Effect.gen(function* () {
      const stub = stubHttpClient(() => ({ not: "a jsonrpc envelope" }));
      const error = yield* provide(Db.listDatabases(URL_), stub).pipe(Effect.flip);
      assert.strictEqual(error._tag, "SchemaDriftError");
    }),
  );
});

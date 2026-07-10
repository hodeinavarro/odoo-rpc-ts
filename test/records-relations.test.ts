import { assert, describe, it } from "@effect/vitest";
import { Either, Schema } from "effect";
import {
  Many2OneRef,
  Many2OneRefOrNull,
  OdooDate,
  OdooDateOrNull,
  OdooDateTime,
  OdooDateTimeOrNull,
} from "../src/records/index.ts";

const decode = <A, I>(schema: Schema.Schema<A, I>) => Schema.decodeUnknownEither(schema);

describe("Many2OneRef schemas", () => {
  it("decodes a present [id, name] pair to a ref value", () => {
    const result = decode(Many2OneRef)([3, "ACME"]);
    assert.deepStrictEqual(result, Either.right({ id: 3, name: "ACME" }));
  });

  it("Many2OneRefOrNull decodes a pair to a ref value", () => {
    const result = decode(Many2OneRefOrNull)([7, "Globex"]);
    assert.deepStrictEqual(result, Either.right({ id: 7, name: "Globex" }));
  });

  it("Many2OneRefOrNull decodes Odoo's `false` empty to null", () => {
    const result = decode(Many2OneRefOrNull)(false);
    assert.deepStrictEqual(result, Either.right(null));
  });

  it("a malformed pair (name not a string) fails to decode (drift)", () => {
    const result = decode(Many2OneRef)([3, 42]);
    assert.isTrue(Either.isLeft(result));
  });

  it("null (not `false`) fails to decode — Odoo empties are `false`", () => {
    const result = decode(Many2OneRefOrNull)(null);
    assert.isTrue(Either.isLeft(result));
  });

  it("round-trips a ref value back to its wire pair", () => {
    const encoded = Schema.encodeUnknownSync(Many2OneRefOrNull)({ id: 5, name: "Initech" });
    assert.deepStrictEqual(encoded, [5, "Initech"]);
    assert.strictEqual(Schema.encodeUnknownSync(Many2OneRefOrNull)(null), false);
  });
});

describe("OdooDate / OdooDateTime schemas", () => {
  it("OdooDate decodes YYYY-MM-DD as UTC midnight", () => {
    const date = Schema.decodeUnknownSync(OdooDate)("2024-01-15");
    assert.strictEqual(date.getUTCFullYear(), 2024);
    assert.strictEqual(date.getUTCMonth(), 0);
    assert.strictEqual(date.getUTCDate(), 15);
    assert.strictEqual(date.getUTCHours(), 0);
    assert.strictEqual(date.toISOString(), "2024-01-15T00:00:00.000Z");
  });

  it("OdooDateTime decodes YYYY-MM-DD HH:MM:SS as a UTC instant", () => {
    const dt = Schema.decodeUnknownSync(OdooDateTime)("2024-01-15 13:45:30");
    assert.strictEqual(dt.toISOString(), "2024-01-15T13:45:30.000Z");
  });

  it("OdooDate/OdooDateTime round-trip back to the wire string (UTC)", () => {
    const roundDate = Schema.encodeUnknownSync(OdooDate)(
      Schema.decodeUnknownSync(OdooDate)("2024-01-15"),
    );
    assert.strictEqual(roundDate, "2024-01-15");
    const roundDt = Schema.encodeUnknownSync(OdooDateTime)(
      Schema.decodeUnknownSync(OdooDateTime)("2024-01-15 13:45:30"),
    );
    assert.strictEqual(roundDt, "2024-01-15 13:45:30");
  });

  it("false→null variants: OdooDateOrNull / OdooDateTimeOrNull decode `false` to null", () => {
    assert.strictEqual(Schema.decodeUnknownSync(OdooDateOrNull)(false), null);
    assert.strictEqual(Schema.decodeUnknownSync(OdooDateTimeOrNull)(false), null);
    const dt = Schema.decodeUnknownSync(OdooDateTimeOrNull)("2024-01-15 13:45:30");
    assert.strictEqual(dt?.toISOString(), "2024-01-15T13:45:30.000Z");
  });

  it("a malformed date string fails to decode (drift)", () => {
    assert.isTrue(Either.isLeft(decode(OdooDate)("15/01/2024")));
    assert.isTrue(Either.isLeft(decode(OdooDateTime)("2024-01-15")));
    assert.isTrue(Either.isLeft(decode(OdooDate)("2024-13-40")));
  });
});

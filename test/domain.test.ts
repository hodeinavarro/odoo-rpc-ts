import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { AND, NOT, OR, normalizeDomain, type Domain } from "../src/domain.ts";

const a: Domain = [["is_company", "=", true]];
const b: Domain = [["customer_rank", ">", 0]];
const c: Domain = [["active", "=", true]];

describe("normalizeDomain", () => {
  it.effect("leaves an empty domain empty", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.deepStrictEqual(normalizeDomain([]), []);
    }),
  );

  it.effect("makes an implicit AND of two leaves explicit", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.deepStrictEqual(normalizeDomain([...a, ...b]), [
        "&",
        ["is_company", "=", true],
        ["customer_rank", ">", 0],
      ]);
    }),
  );

  it.effect("leaves an already-explicit expression unchanged", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const explicit: Domain = ["|", ["a", "=", 1], ["b", "=", 2]];
      assert.deepStrictEqual(normalizeDomain(explicit), explicit);
    }),
  );
});

describe("AND / OR / NOT", () => {
  it.effect("AND folds n domains with n-1 leading &", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.deepStrictEqual(AND(a, b, c), [
        "&",
        "&",
        ["is_company", "=", true],
        ["customer_rank", ">", 0],
        ["active", "=", true],
      ]);
    }),
  );

  it.effect("OR folds n domains with n-1 leading |", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.deepStrictEqual(OR(a, b), ["|", ["is_company", "=", true], ["customer_rank", ">", 0]]);
    }),
  );

  it.effect("empty sub-domains are dropped", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.deepStrictEqual(AND(a, [], b), [
        "&",
        ["is_company", "=", true],
        ["customer_rank", ">", 0],
      ]);
    }),
  );

  it.effect("a single surviving sub-domain is returned as-is (normalized)", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.deepStrictEqual(AND([], a, []), [["is_company", "=", true]]);
      assert.deepStrictEqual(OR(), []);
    }),
  );

  it.effect("NOT prefixes a normalized expression with !", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      assert.deepStrictEqual(NOT(a), ["!", ["is_company", "=", true]]);
      assert.deepStrictEqual(NOT([]), []);
    }),
  );

  it.effect("nested combinators normalize inner implicit ANDs", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      // OR( (a AND b), c ) — the first operand is a two-leaf implicit AND.
      assert.deepStrictEqual(OR([...a, ...b], c), [
        "|",
        "&",
        ["is_company", "=", true],
        ["customer_rank", ">", 0],
        ["active", "=", true],
      ]);
    }),
  );
});

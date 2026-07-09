import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { mapServerFault, type RawServerFault } from "../src/errors/mapFault.ts";

const raw = (name: string, over: Partial<RawServerFault> = {}): RawServerFault => ({
  name,
  message: "boom",
  arguments: [],
  context: {},
  ...over,
});

describe("mapServerFault", () => {
  it.effect("maps each known Python name to its subtype", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["odoo.exceptions.AccessError", "OdooAccessError"],
        ["odoo.exceptions.ValidationError", "OdooValidationError"],
        ["odoo.exceptions.MissingError", "OdooMissingError"],
        ["odoo.exceptions.UserError", "OdooUserError"],
        ["odoo.exceptions.RedirectWarning", "OdooUserError"],
        ["odoo.exceptions.Warning", "OdooUserError"],
        ["odoo.exceptions.LockError", "OdooLockError"],
      ];
      for (const [name, tag] of cases) {
        const mapped = mapServerFault(raw(name));
        assert.strictEqual(mapped._tag, tag);
        // The raw Python name is always preserved.
        assert.strictEqual(mapped.name, name);
      }
    }),
  );

  it.effect("maps AccessDenied to OdooAuthenticationError (auth, not a server fault)", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapServerFault(raw("odoo.exceptions.AccessDenied"));
      assert.strictEqual(mapped._tag, "OdooAuthenticationError");
      if (mapped._tag === "OdooAuthenticationError") {
        assert.strictEqual(mapped.reason, "invalid-credentials");
        assert.strictEqual(mapped.message, "boom");
      }
    }),
  );

  it.effect("falls back to OdooServerError for unknown names, preserving name", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapServerFault(raw("odoo.exceptions.NotAThing"));
      assert.strictEqual(mapped._tag, "OdooServerError");
      assert.strictEqual(mapped.name, "odoo.exceptions.NotAThing");
    }),
  );

  it.effect("threads the call site and debug through when present", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapServerFault(raw("odoo.exceptions.UserError", { debug: "traceback..." }), {
        model: "res.partner",
        method: "write",
      });
      assert.strictEqual(mapped._tag, "OdooUserError");
      if (mapped._tag === "OdooUserError") {
        assert.strictEqual(mapped.model, "res.partner");
        assert.strictEqual(mapped.method, "write");
        assert.strictEqual(mapped.debug, "traceback...");
      }
    }),
  );

  it.effect("omits optional fields entirely when absent (exactOptional)", () =>
    Effect.gen(function* () {
      yield* Effect.void;
      const mapped = mapServerFault(raw("odoo.exceptions.UserError"));
      assert.strictEqual(mapped._tag, "OdooUserError");
      if (mapped._tag === "OdooUserError") {
        assert.isUndefined(mapped.model);
        assert.isUndefined(mapped.method);
        assert.isUndefined(mapped.debug);
      }
    }),
  );
});

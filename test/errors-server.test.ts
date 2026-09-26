import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { OdooValidationError } from "../src/errors/server.ts";

describe("server fault schema", () => {
  it.effect("round-trips a tagged fault and remains catchTag-discriminated", () =>
    Effect.gen(function* () {
      const fault = new OdooValidationError({
        name: "odoo.exceptions.ValidationError",
        message: "Invalid value",
        arguments: ["Invalid value"],
        context: { lang: "es_ES" },
        model: "res.partner",
        method: "write",
      });
      const encoded = Schema.encodeUnknownSync(OdooValidationError)(fault);
      assert.deepEqual(encoded, {
        _tag: "OdooValidationError",
        name: "odoo.exceptions.ValidationError",
        message: "Invalid value",
        arguments: ["Invalid value"],
        context: { lang: "es_ES" },
        model: "res.partner",
        method: "write",
      });

      const decoded = Schema.decodeUnknownSync(OdooValidationError)(encoded);
      assert.instanceOf(decoded, OdooValidationError);
      yield* Effect.fail(decoded).pipe(
        Effect.catchTag("OdooValidationError", (caught) =>
          Effect.sync(() => {
            assert.strictEqual(caught.name, "odoo.exceptions.ValidationError");
            assert.strictEqual(caught.model, "res.partner");
          }),
        ),
      );
    }),
  );
});

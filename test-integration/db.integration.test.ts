/**
 * LIVE database-management (`service="db"` → `/jsonrpc`) integration specs.
 * Skips itself entirely when no harness stack is up.
 *
 * The `db` service is master-password-gated: the harness records the password in
 * its state file as `ODOO_MASTER_PASSWORD` (default "master"; see the harness
 * upgrade). These specs NEVER mutate the seeded database — every mutating op
 * (create / duplicate / drop) targets a unique, scratch name that is always
 * cleaned up, and `dump` is read-only.
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Redacted } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import type { HttpClient } from "../src/internal/platform.ts";
import * as Db from "../src/services/db.ts";
import { hasStack, marker, TIMEOUT_MS } from "./support.ts";

const url = (): URL => new URL(process.env["ODOO_URL"] ?? "");
const master = (): Redacted.Redacted<string> =>
  Redacted.make(process.env["ODOO_MASTER_PASSWORD"] ?? "master");
const seededDb = (): string => process.env["ODOO_DB"] ?? "";

/** Generous timeout for create/duplicate: initializing/copying a db is slow. */
const HEAVY_TIMEOUT_MS = 300_000;

const withHttp = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
  effect.pipe(Effect.provide(NodeHttpClient.layer));

describe.skipIf(!hasStack)("db (live)", () => {
  it.live.skipIf(!hasStack)(
    "listDatabases contains the harness db",
    () =>
      withHttp(
        Effect.gen(function* () {
          const dbs = yield* Db.listDatabases(url());
          assert.include(dbs, seededDb());
        }),
      ),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "exists is true for the seeded db, false for a bogus name",
    () =>
      withHttp(
        Effect.gen(function* () {
          assert.isTrue(yield* Db.exists(url(), seededDb()));
          assert.isFalse(yield* Db.exists(url(), `${marker()}-nope`));
        }),
      ),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "dump of the seeded db returns a zip archive (PK magic)",
    () =>
      withHttp(
        Effect.gen(function* () {
          const bytes = yield* Db.dump(url(), master(), seededDb(), "zip");
          assert.isAtLeast(bytes.length, 2);
          // ZIP local-file-header magic: 0x50 0x4b = "PK".
          assert.strictEqual(bytes[0], 0x50);
          assert.strictEqual(bytes[1], 0x4b);
        }),
      ),
    HEAVY_TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "wrong master password → OdooAuthenticationError",
    () =>
      withHttp(
        Effect.gen(function* () {
          const error = yield* Db.drop(url(), Redacted.make("definitely-wrong"), seededDb()).pipe(
            Effect.flip,
          );
          assert.strictEqual(error._tag, "OdooAuthenticationError");
          // And the seeded db is untouched.
          assert.isTrue(yield* Db.exists(url(), seededDb()));
        }),
      ),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "create → exists → duplicate → drop lifecycle on scratch dbs",
    () =>
      withHttp(
        Effect.gen(function* () {
          // Scratch names must be valid Postgres identifiers: no hyphens.
          const base = marker().replace(/-/g, "_");
          const created = `${base}_a`;
          const dup = `${base}_b`;

          yield* Effect.gen(function* () {
            yield* Db.create(url(), {
              master: master(),
              name: created,
              adminPassword: Redacted.make("admin-scratch"),
            });
            assert.isTrue(yield* Db.exists(url(), created));

            yield* Db.duplicate(url(), master(), created, dup, { neutralize: true });
            assert.isTrue(yield* Db.exists(url(), dup));

            assert.isTrue(yield* Db.drop(url(), master(), dup));
            assert.isFalse(yield* Db.exists(url(), dup));

            assert.isTrue(yield* Db.drop(url(), master(), created));
            assert.isFalse(yield* Db.exists(url(), created));

            // The seeded db was never a target of any of these ops.
            assert.isTrue(yield* Db.exists(url(), seededDb()));
          }).pipe(
            // Belt-and-braces cleanup even if an assertion above fails midway.
            Effect.ensuring(
              Effect.all(
                [
                  Db.drop(url(), master(), dup).pipe(Effect.ignore),
                  Db.drop(url(), master(), created).pipe(Effect.ignore),
                ],
                { discard: true },
              ),
            ),
          );
        }),
      ),
    HEAVY_TIMEOUT_MS,
  );
});

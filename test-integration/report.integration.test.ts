/**
 * LIVE report-service integration specs: `ir.actions.report` listing via the
 * cookie session's `json` hatch, and the `GET /report/<converter>/...` binary
 * download via the `http` hatch. All through the public surface; skips itself
 * when no harness stack is up. Verified against 16.0 (:8016) and 19.0 (:8019).
 */
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { NodeHttpClient } from "@effect/platform-node";
import { CookieSession, CookieSessionLive } from "../src/index.ts";
import { ReportService } from "../src/services/report.ts";
import { hasStack, passwordConfig, TIMEOUT_MS } from "./support.ts";

const sessionLayer: Layer.Layer<CookieSession> = CookieSessionLive.layer(passwordConfig()).pipe(
  Layer.provide(NodeHttpClient.layerUndici),
);

describe.skipIf(!hasStack)("report service (live)", () => {
  it.live.skipIf(!hasStack)(
    "lists ir.actions.report definitions (bare base+web ships several)",
    () =>
      Effect.gen(function* () {
        const session = yield* CookieSession;
        const reports = yield* ReportService.list(session);
        // A bare base+web install already ships a handful of report actions.
        assert.isAtLeast(reports.length, 5);
        // Every row is decoded to the camelCase shape.
        for (const r of reports) {
          assert.isNumber(r.id);
          assert.isString(r.reportName);
          assert.isString(r.model);
        }
      }).pipe(Effect.provide(sessionLayer)),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "downloads base.report_irmodeloverview as a real PDF (%PDF magic)",
    () =>
      Effect.gen(function* () {
        const session = yield* CookieSession;
        // The Model Overview report renders over ir.model records; grab one id.
        const rows = yield* session.json("web/dataset/call_kw", {
          model: "ir.model",
          method: "search",
          args: [[]],
          kwargs: { limit: 1 },
        });
        const ids = rows as ReadonlyArray<number>;
        assert.isAtLeast(ids.length, 1);

        const pdf = yield* ReportService.download(session, {
          reportName: "base.report_irmodeloverview",
          ids: [ids[0] as number],
        });
        assert.strictEqual(new TextDecoder().decode(pdf.subarray(0, 4)), "%PDF");
        assert.isAbove(pdf.length, 4);
      }).pipe(Effect.provide(sessionLayer)),
    TIMEOUT_MS,
  );

  it.live.skipIf(!hasStack)(
    "an unknown report name → typed error (500 → OdooTransportError)",
    () =>
      Effect.gen(function* () {
        const session = yield* CookieSession;
        const error = yield* ReportService.download(session, {
          reportName: "base.report_does_not_exist_xyz",
          ids: [1],
        }).pipe(Effect.flip);
        // Odoo answers the unknown-report route with a 500 (accepted path);
        // 404/403 would map to Missing/Access. Any is a typed, non-throwing fail.
        assert.include(
          ["OdooTransportError", "OdooMissingError", "OdooAccessError"],
          error._tag,
        );
      }).pipe(Effect.provide(sessionLayer)),
    TIMEOUT_MS,
  );
});

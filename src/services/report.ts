import { Effect, Result, Schema } from "effect";
import { OdooAccessError, OdooMissingError } from "../errors/server.ts";
import { SchemaDriftError } from "../errors/schema.ts";
import { OdooTransportError, type RequestInfo } from "../errors/transport.ts";
import type { CookieLoginError, CookieSessionService } from "../session/cookie.ts";

/**
 * A decoded `ir.actions.report` row. Field names are normalized to camelCase at
 * the schema boundary so callers never touch Odoo's snake_case wire shape.
 */
export interface ReportAction {
  readonly id: number;
  readonly name: string;
  readonly reportName: string;
  readonly model: string;
  readonly reportType: string;
}

/**
 * Lenient decoder for an `ir.actions.report` row. Only the columns we request
 * are decoded; extra keys are tolerated. `report_name` is the identifier that
 * feeds the `GET /report/<converter>/<report_name>/<ids>` download route.
 */
const ReportActionSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  report_name: Schema.String,
  model: Schema.String,
  report_type: Schema.String,
});

const toReportAction = (row: typeof ReportActionSchema.Type): ReportAction => ({
  id: row.id,
  name: row.name,
  reportName: row.report_name,
  model: row.model,
  reportType: row.report_type,
});

/**
 * List `ir.actions.report` definitions over a cookie session, optionally scoped
 * to a single `model`. Self-contained: goes through the session's `json` hatch
 * (`web/dataset/call_kw` → `search_read`) so it needs no `Transport`/`Rpc`
 * wiring. Fails with the session's `CookieLoginError` union (login faults,
 * server faults, or `SchemaDriftError` on a drifted row shape).
 */
export const list = (
  session: CookieSessionService,
  model?: string,
): Effect.Effect<ReadonlyArray<ReportAction>, CookieLoginError> =>
  Effect.gen(function* () {
    const domain = model === undefined ? [] : [["model", "=", model]];
    const result = yield* session.json("web/dataset/call_kw", {
      model: "ir.actions.report",
      method: "search_read",
      args: [domain, ["id", "name", "report_name", "model", "report_type"]],
      kwargs: {},
    });

    const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ReportActionSchema))(result).pipe(
      Effect.mapError(
        (cause) =>
          new SchemaDriftError({ context: "ir.actions.report rows", payload: result, cause }),
      ),
    );

    return rows.map(toReportAction);
  });

/**
 * Options for {@link download}. `converter` is the report renderer segment of
 * the download URL (`pdf` by default; `html`, `text`, … are also valid).
 */
export interface DownloadOptions {
  readonly reportName: string;
  readonly ids: ReadonlyArray<number>;
  readonly converter?: string;
}

/** The `%PDF` signature every well-formed PDF opens with. */
const PDF_MAGIC = Uint8Array.of(0x25, 0x50, 0x44, 0x46);

const hasPdfMagic = (bytes: Uint8Array): boolean =>
  bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((byte, i) => bytes[i] === byte);

/**
 * Download a rendered report as raw bytes via `GET
 * /report/<converter>/<reportName>/<ids.join(",")>` on the cookie-bound client
 * (the route is identical and CSRF-free across Odoo 16–19).
 *
 * Status mapping: `404 → OdooMissingError`, `403 → OdooAccessError`, any other
 * non-2xx (including the `500` Odoo raises for an unknown report name) →
 * `OdooTransportError`. For `converter === "pdf"` the 2xx body is checked for
 * the `%PDF` magic and fails as `SchemaDriftError` if the server handed back
 * something else (e.g. an HTML error page with a 200).
 */
export const download = (
  session: CookieSessionService,
  options: DownloadOptions,
): Effect.Effect<Uint8Array, CookieLoginError> =>
  Effect.gen(function* () {
    const converter = options.converter ?? "pdf";
    const path = `report/${converter}/${options.reportName}/${options.ids.join(",")}`;

    const response = yield* session.http({ path, method: "GET" });
    const request: RequestInfo = { method: "GET", url: response.request.url };

    if (response.status === 404) {
      return yield* Effect.fail(
        new OdooMissingError({
          name: "werkzeug.exceptions.NotFound",
          message: `Report ${options.reportName} not found (404) for ids ${options.ids.join(",")}.`,
          arguments: [],
          context: {},
        }),
      );
    }

    if (response.status === 403) {
      return yield* Effect.fail(
        new OdooAccessError({
          name: "werkzeug.exceptions.Forbidden",
          message: `Access denied (403) downloading report ${options.reportName}.`,
          arguments: [],
          context: {},
        }),
      );
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* Effect.fail(
        new OdooTransportError({
          request,
          kind: "StatusCodeError",
          status: response.status,
        }),
      );
    }

    const buffer = yield* response.arrayBuffer.pipe(
      Effect.mapError((cause) => OdooTransportError.fromHttpClientError(request, cause)),
    );
    const bytes = new Uint8Array(buffer);

    if (converter === "pdf" && !hasPdfMagic(bytes)) {
      // Manufacture a real ParseError so SchemaDriftError.cause is honest: a 2xx
      // body that is not a PDF (e.g. an HTML error page served with status 200).
      const header = new TextDecoder().decode(bytes.subarray(0, PDF_MAGIC.length));
      const parsed = Schema.decodeUnknownResult(Schema.Literal("%PDF"))(header);
      if (Result.isFailure(parsed)) {
        return yield* Effect.fail(
          new SchemaDriftError({
            context: `report/pdf/${options.reportName}`,
            payload: `non-PDF body (${bytes.length} bytes, status ${response.status})`,
            cause: parsed.failure,
          }),
        );
      }
    }

    return bytes;
  });

/** The report service, grouped for `ReportService.list` / `ReportService.download`. */
export const ReportService = { list, download } as const;

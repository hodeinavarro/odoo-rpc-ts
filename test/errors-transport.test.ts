import { assert, describe, it } from "@effect/vitest";
import { OdooTransportError } from "../src/errors/transport.ts";
import {
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "../src/internal/platform.ts";

const authorization = "Bearer secret-api-key";
const password = "secret-password";
const unsafeUrl =
  "https://url-user:url-password@odoo.test/jsonrpc?access_token=query-secret#fragment-secret";

const unsafeRequest = HttpClientRequest.post(unsafeUrl).pipe(
  HttpClientRequest.setHeader("Authorization", authorization),
  HttpClientRequest.bodyJsonUnsafe({ password }),
);

describe("OdooTransportError", () => {
  it("does not retain the platform error, request headers, or request body", () => {
    const platformError = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request: unsafeRequest,
        cause: new Error("socket closed"),
      }),
    });

    const error = OdooTransportError.fromHttpClientError(
      { method: unsafeRequest.method, url: unsafeRequest.url },
      platformError,
    );
    const exposed = error as unknown as Record<string, unknown>;
    const request = error.request as unknown as Record<string, unknown>;
    const serialized = JSON.stringify(error);

    assert.strictEqual(error.kind, "TransportError");
    assert.strictEqual(error.message, "TransportError during POST https://odoo.test/jsonrpc");
    assert.strictEqual(exposed.cause, undefined);
    assert.strictEqual(exposed.reason, undefined);
    assert.deepStrictEqual(Object.keys(request).sort(), ["method", "url"]);
    assert.strictEqual(request.headers, undefined);
    assert.strictEqual(request.body, undefined);
    assert.notInclude(serialized, authorization);
    assert.notInclude(serialized, password);
    assert.notInclude(serialized, "socket closed");
    assert.notInclude(serialized, "url-user");
    assert.notInclude(serialized, "url-password");
    assert.notInclude(serialized, "query-secret");
    assert.notInclude(serialized, "fragment-secret");
  });

  it("retains status and kind while copying only sanitized request fields", () => {
    const response = HttpClientResponse.fromWeb(unsafeRequest, new Response(null, { status: 502 }));
    const platformError = new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({ request: unsafeRequest, response }),
    });

    const error = OdooTransportError.fromHttpClientError(unsafeRequest, platformError);

    assert.strictEqual(error.kind, "StatusCodeError");
    assert.strictEqual(error.status, 502);
    assert.include(error.message, "HTTP 502");
    assert.notStrictEqual(error.request, unsafeRequest);
    assert.deepStrictEqual(error.request, {
      method: "POST",
      url: "https://odoo.test/jsonrpc",
    });
  });

  it("sanitizes direct-constructor URLs and does not accept caller-provided messages", () => {
    const fields = {
      request: { method: "POST", url: unsafeUrl },
      kind: "EncodeError" as const,
      message: "caller-message-secret",
    };
    const error = new OdooTransportError(fields);
    const serialized = JSON.stringify(error);

    assert.strictEqual(error.request.url, "https://odoo.test/jsonrpc");
    assert.strictEqual(error.message, "EncodeError during POST https://odoo.test/jsonrpc");
    assert.notInclude(serialized, "url-user");
    assert.notInclude(serialized, "url-password");
    assert.notInclude(serialized, "query-secret");
    assert.notInclude(serialized, "fragment-secret");
    assert.notInclude(serialized, "caller-message-secret");
  });

  it("does not echo an invalid request URL", () => {
    const error = new OdooTransportError({
      request: { method: "GET", url: "not-a-url-with-secret-token" },
      kind: "InvalidUrlError",
    });

    assert.strictEqual(error.request.url, "<invalid-url>");
    assert.strictEqual(error.message, "InvalidUrlError during GET <invalid-url>");
    assert.notInclude(JSON.stringify(error), "secret-token");
  });
});

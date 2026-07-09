import { Context, type Effect, Schema } from "effect";
import type { ProtocolUnsupportedError } from "./errors/protocol.ts";
import type { SchemaDriftError } from "./errors/schema.ts";
import type { OdooTransportError } from "./errors/transport.ts";

/**
 * Odoo's `server_version_info`: `[major, minor, micro, releaselevel, serial]`,
 * a heterogeneous tuple (numbers plus a string release level). Modeled
 * leniently as a mixed array so a shape change on a future version surfaces as
 * a decode drift rather than a silent truncation.
 */
export const ServerVersionInfo = Schema.Array(Schema.Union(Schema.Number, Schema.String));
export type ServerVersionInfo = typeof ServerVersionInfo.Type;

/**
 * The response of the `common.version` call (`/jsonrpc` service `common`,
 * method `version`). Decoded at the boundary; drift raises `SchemaDriftError`.
 */
export const CommonVersionResponse = Schema.Struct({
  server_version: Schema.String,
  server_version_info: ServerVersionInfo,
  server_serie: Schema.String,
  protocol_version: Schema.Number,
});
export type CommonVersionResponse = typeof CommonVersionResponse.Type;

/** A parsed, structured server version. */
export interface OdooVersion {
  readonly major: number;
  readonly minor: number;
  readonly micro: number;
  readonly releaseLevel: string;
  readonly serial: number;
  readonly raw: ServerVersionInfo;
}

/** What a given server version can and cannot do, on the wire. */
export interface OdooCapabilities {
  /** The JSON-2 `/json/2` bearer API exists (Odoo 19+). */
  readonly supportsJson2: boolean;
  /** `/jsonrpc` and `/xmlrpc` are deprecated upstream (Odoo 19+). */
  readonly jsonRpcDeprecated: boolean;
}

/** A resolved version together with its derived capabilities. */
export interface ResolvedVersion {
  readonly version: OdooVersion;
  readonly capabilities: OdooCapabilities;
}

const asNumber = (value: number | string | undefined): number =>
  typeof value === "number" ? value : 0;

/**
 * Turn a raw `server_version_info` tuple into a structured {@link OdooVersion}.
 * Missing trailing elements default to `0` / empty; the raw tuple is retained.
 */
export const parseVersionInfo = (raw: ServerVersionInfo): OdooVersion => ({
  major: asNumber(raw[0]),
  minor: asNumber(raw[1]),
  micro: asNumber(raw[2]),
  releaseLevel: typeof raw[3] === "string" ? raw[3] : "",
  serial: asNumber(raw[4]),
  raw,
});

/** Derive wire capabilities from a version. JSON-2 lands, and the legacy RPC
 * routes are deprecated, at major 19. */
export const deriveCapabilities = (version: OdooVersion): OdooCapabilities => ({
  supportsJson2: version.major >= 19,
  jsonRpcDeprecated: version.major >= 19,
});

/**
 * Resolves (and success-only caches) the server version behind whichever
 * transport is provided. Implementation ships later; this is the seam so the
 * client can gate protocol choices on capabilities.
 */
export class VersionResolver extends Context.Tag("odoo-rpc-ts/VersionResolver")<
  VersionResolver,
  {
    readonly resolve: Effect.Effect<
      ResolvedVersion,
      OdooTransportError | SchemaDriftError | ProtocolUnsupportedError
    >;
  }
>() {}

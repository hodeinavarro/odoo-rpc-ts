import { Effect, Layer } from "effect";
import type { SchemaDriftError } from "./errors/schema.ts";
import type { ProtocolUnsupportedError } from "./errors/protocol.ts";
import type { OdooTransportError } from "./errors/transport.ts";
import * as SingleFlight from "./internal/singleFlight.ts";
import {
  type CommonVersionResponse,
  deriveWireCapabilities,
  parseVersionInfo,
  type ResolvedVersion,
  type ServerVersionInfo,
  VersionResolver,
} from "./version.ts";

/**
 * The two version-probe shapes we accept, already boundary-decoded by whichever
 * transport family issued the probe:
 *
 * - {@link CommonVersionResponse} — the `/jsonrpc` `common.version` response.
 * - `{ version, version_info }` — the web `/web/webclient/version_info` shape.
 *
 * Both carry the `server_version_info` tuple under different keys; that tuple is
 * all this resolver needs.
 */
export type VersionProbeResponse =
  | CommonVersionResponse
  | { readonly version: string; readonly version_info: ServerVersionInfo };

/**
 * The typed failures a transport-provided VERSION probe may surface. The
 * `VersionProbe` prefix is deliberate: the bare word "probe" belongs to the
 * application layer's product-capability probing (`fields_get` reachability);
 * this package only ever probes the server version.
 */
export type VersionProbeError = OdooTransportError | SchemaDriftError | ProtocolUnsupportedError;

const extractInfo = (response: VersionProbeResponse): ServerVersionInfo =>
  "server_version_info" in response ? response.server_version_info : response.version_info;

const resolveVersion = (response: VersionProbeResponse): ResolvedVersion => {
  const version = parseVersionInfo(extractInfo(response));
  return { version, capabilities: deriveWireCapabilities(version) };
};

/**
 * Build a {@link VersionResolver} service from a transport-agnostic `probe`.
 *
 * The `Transport` seam only exposes `call_kw`, so version discovery lives with
 * each transport family (which owns the right endpoint and decode). This
 * resolver stays generic: hand it the decoded probe effect and it success-only
 * single-flight caches the mapped {@link ResolvedVersion}.
 */
export const make = (
  probe: Effect.Effect<VersionProbeResponse, VersionProbeError>,
): Effect.Effect<VersionResolver["Type"], never> =>
  Effect.gen(function* () {
    const cache = yield* SingleFlight.make(Effect.map(probe, resolveVersion));
    return { resolve: cache.get };
  });

/**
 * The {@link VersionResolver} layer over a transport-provided `probe`. Transport
 * packages construct the probe (endpoint + decode) and pass it here.
 */
export const layer = (
  probe: Effect.Effect<VersionProbeResponse, VersionProbeError>,
): Layer.Layer<VersionResolver> => Layer.effect(VersionResolver, make(probe));

/**
 * odoo-rpc-ts — public surface.
 *
 * A modern, Effect-native, strongly-typed Odoo RPC client: the shared
 * contracts (errors, the `Transport` seam, config, domains, version
 * resolution), the three transports, the session/auth services, and the
 * high-level `OdooClient`. The `FakeTransport` testing double ships from the
 * separate `odoo-rpc-ts/testing` entry point.
 */

// Error taxonomy + the fault mapper.
export * from "./errors/index.ts";

// The one transport seam and its call shape.
export { Transport, type CallKwParams, type TransportCallError } from "./transport.ts";

// Configuration.
export { OdooConfig, type OdooCredentials } from "./config.ts";

// Search-domain types and combinators.
export {
  AND,
  OR,
  NOT,
  normalizeDomain,
  type Domain,
  type DomainItem,
  type DomainLeaf,
  type DomainOperator,
} from "./domain.ts";

// Version resolution and capability derivation.
export {
  VersionResolver,
  CommonVersionResponse,
  ServerVersionInfo,
  parseVersionInfo,
  deriveCapabilities,
  type OdooVersion,
  type OdooCapabilities,
  type ResolvedVersion,
} from "./version.ts";
export * as VersionResolverLive from "./version-live.ts";

// The call_kw choke point (context merge) and the high-level client.
export { Rpc, GlobalContext, type OdooContext } from "./rpc.ts";
export * as RpcLive from "./rpc.ts";
export {
  OdooClient,
  type OdooRecord,
  type FieldsMetadata,
  type SearchOptions,
  type SearchReadOptions,
} from "./client.ts";
export * as OdooClientLive from "./client.ts";

// Transports — one Layer per protocol, all implementing the Transport tag.
export * as JsonRpcTransport from "./transports/jsonrpc.ts";
export * as Json2Transport from "./transports/json2.ts";
export * as WebTransport from "./transports/web.ts";

// Cookie session + opt-in session-expiry recovery.
export {
  CookieSession,
  type CookieSessionService,
  type CookieLoginError,
  type ExistingSessionOptions,
  type OdooSessionInfo,
} from "./session/cookie.ts";
export * as CookieSessionLive from "./session/cookie.ts";
export { retryOnSessionExpired } from "./combinators/retryOnSessionExpired.ts";

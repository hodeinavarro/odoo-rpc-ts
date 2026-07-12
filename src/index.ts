/**
 * @hodeinavarro/odoo-rpc-ts — public surface.
 *
 * A modern, Effect-native, strongly-typed Odoo RPC client: the shared
 * contracts (errors, the `Transport` seam, config, domains, version
 * resolution), the three transports, the session/auth services, and the
 * high-level `OdooClient`. The `FakeTransport` testing double ships from the
 * separate `@hodeinavarro/odoo-rpc-ts/testing` entry point.
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

// Version resolution and WIRE-capability derivation (the app layer owns
// product capabilities — see WireCapabilities).
export {
  VersionResolver,
  CommonVersionResponse,
  ServerVersionInfo,
  parseVersionInfo,
  deriveWireCapabilities,
  type OdooVersion,
  type WireCapabilities,
  type ResolvedVersion,
} from "./version.ts";
export * as VersionResolverLive from "./version-live.ts";

// The call_kw choke point (context merge) and the high-level client.
export { Rpc, GlobalContext, type OdooContext, type GlobalContextProvider } from "./rpc.ts";
export * as RpcLive from "./rpc.ts";
export {
  OdooClient,
  type OdooRecord,
  type FieldsMetadata,
  type SearchOptions,
  type SearchReadOptions,
  type CallOptions,
  type ReadGroupOptions,
  type NameSearchOptions,
  type TypedOptions,
  type TypedReadOptions,
} from "./client.ts";
export * as OdooClientLive from "./client.ts";

// Typed records — two per-protocol tiers, not competitors. The CLASSIC tier
// (explicit traversal: Many2OneRef*, TypedRecordSet) speaks the classic
// `[id, name]`-pair protocol and works on 16+; the SPEC tier (declared
// prefetch: defineRecord/Many2One/One2Many + the pure specification compiler)
// speaks the 17+ `specification` protocol. Relation/temporal decode
// vocabulary is shared.
export {
  // Relation & temporal decode schemas (classic-tier row declarations).
  Many2OneRef,
  Many2OneRefFromWire,
  Many2OneRefOrNull,
  Many2OneRefValue,
  OdooDate,
  OdooDateOrNull,
  OdooDateTime,
  OdooDateTimeOrNull,
  // Pure join helpers + the classic-tier explicit-traversal snapshot.
  collectRefIds,
  makeRelatedMap,
  makeTypedRecordSet,
  refId,
  type HasId,
  type Many2OneRefField,
  type RefOrId,
  type RelatedMap,
  type TypedRecordSet,
  // Spec-tier model declaration + compilation (17+ `specification` protocol).
  defineRecord,
  Many2One,
  One2Many,
  compileSpecification,
  hasRelations,
  EmptyRecordSpecError,
  RecordSpecCycleError,
  type FieldInput,
  type FieldMeta,
  type Many2OneDecl,
  type One2ManyDecl,
  type RecordSpec,
  type RowEncoded,
  type RowType,
} from "./records/index.ts";

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
  type RawHttpOptions,
} from "./session/cookie.ts";
export * as CookieSessionLive from "./session/cookie.ts";
export { retryOnSessionExpired } from "./combinators/retryOnSessionExpired.ts";

// Typed x2many write commands.
export {
  Command,
  type CommandTuple,
  type X2ManyCommands,
} from "./commands.ts";

// Database administration (master-password gated; Node-oriented buffers).
export * as DbService from "./services/db.ts";
export type { CreateOptions, DuplicateOptions, RestoreOptions } from "./services/db.ts";

// Report downloads over a cookie session.
export { ReportService, type ReportAction, type DownloadOptions } from "./services/report.ts";

// Named connection profiles — secrets never serialize; storage is yours.
export {
  Profiles,
  SecretStore,
  ProfileStorage,
  InMemorySecretStore,
  InMemoryProfileStorage,
  ProfileStoreError,
  ProfileSecretMissingError,
  type ProfileData,
  type CredentialProfileData,
  type SessionProfileData,
  type LoadedProfile,
  type ProfileProtocol,
} from "./profiles.ts";
export * as ProfilesLive from "./profiles.ts";

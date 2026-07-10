/**
 * Typed records — internal barrel for both per-protocol tiers of the records
 * design: the CLASSIC tier (explicit traversal over the classic `[id, name]`
 * pair protocol, 16+: relation/temporal decode schemas, pure join helpers,
 * the `TypedRecordSet` snapshot) and the SPEC tier (declared prefetch over the
 * 17+ `specification` protocol: `defineRecord` + the specification compiler).
 * Re-exported to the public surface via `src/index.ts`.
 */
export {
  Many2OneRef,
  Many2OneRefFromWire,
  Many2OneRefOrNull,
  Many2OneRefValue,
  OdooDate,
  OdooDateOrNull,
  OdooDateTime,
  OdooDateTimeOrNull,
} from "./relations.ts";
export {
  collectRefIds,
  makeRelatedMap,
  refId,
  type RefOrId,
  type RelatedMap,
} from "./related.ts";
export {
  make as makeTypedRecordSet,
  type HasId,
  type Many2OneRefField,
  type TypedRecordSet,
} from "./typed.ts";
export {
  defineRecord,
  Many2One,
  One2Many,
  type FieldInput,
  type FieldMeta,
  type Many2OneDecl,
  type One2ManyDecl,
  type RecordSpec,
  type RowEncoded,
  type RowType,
} from "./recordModel.ts";
export {
  compileSpecification,
  EmptyRecordSpecError,
  hasRelations,
  RecordSpecCycleError,
} from "./spec.ts";

/**
 * Typed records — internal barrel. Candidate B ("explicit traversal") of the
 * records design: relation/temporal decode schemas, pure join helpers, and the
 * `TypedRecordSet` snapshot. Re-exported to the public surface via `src/index.ts`.
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

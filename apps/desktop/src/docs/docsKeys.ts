import type { DocTable } from "./types";

/**
 * The key that identifies a table across the viewer — `schema.name`, or the
 * bare name on schema-less engines like SQLite and MySQL.
 *
 * This rule was copied into four places before it lived here. It is the key
 * that annotations are stored under, so two call sites disagreeing would
 * attach a note to the wrong table.
 *
 * Typed as `Pick<DocTable, "schema" | "name">` rather than the full `DocTable`
 * so callers that only have a schema/name pair on hand — a relationship's
 * `FieldRef`, remapped — can use it too without an unsafe cast.
 */
export function qualifiedTableKey(table: Pick<DocTable, "schema" | "name">): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

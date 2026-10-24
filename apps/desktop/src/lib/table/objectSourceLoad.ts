import type { DatabaseType, MetadataReadOptions, ObjectSource, ObjectSourceKind } from "@/types/database";
import * as api from "@/lib/backend/api";
import { exactOracleTriggerMetadata } from "@/lib/database/oracleTriggerIdentity";
import { oracleTriggerSourceBinding, oracleTriggerSourceScopeMatches, type OracleTriggerDatabaseType, type PreparedOracleTriggerSql } from "@/lib/database/oracleTriggerSql";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";

export type GetObjectSourceFn = (connectionId: string, database: string, schema: string, name: string, objectType: ObjectSourceKind, signature?: string, relationName?: string, options?: MetadataReadOptions) => Promise<ObjectSource>;

export type BuildEditableObjectSourceFn = (input: { databaseType: DatabaseType; objectType: ObjectSourceKind; schema?: string; name: string; source: string }) => Promise<string>;

export type OracleTriggerSourceInspection = { complete: boolean; prepared?: PreparedOracleTriggerSql; error?: string };

/** Keep raw/partial source available for manual correction; never promote it to
 * a replacement baseline merely because the generic formatter adds CREATE. */
export async function inspectExactOracleTriggerSource(raw: ObjectSource, owner: string, name: string): Promise<{ editableSource: string; triggerSource: OracleTriggerSourceInspection }> {
  const metadata = exactOracleTriggerMetadata(raw.trigger);
  if (!metadata || metadata.owner !== owner || metadata.name !== name || raw.name !== name || raw.schema !== owner || raw.object_type !== "TRIGGER") {
    return { editableSource: raw.source, triggerSource: { complete: false, error: "Exact trigger identity was not verified; reload with the current provider" } };
  }
  if (metadata.definition?.format === "body") return { editableSource: raw.source, triggerSource: { complete: false, error: "Only the trigger body is available; reload the complete declaration before replacing it" } };
  try {
    const databaseType: OracleTriggerDatabaseType = metadata.engine === "dm" ? "dameng" : metadata.engine;
    const prepared = await api.prepareOracleTriggerSql({ databaseType, owner, name, source: raw.source, purpose: "inspect", binding: oracleTriggerSourceBinding(metadata), allowExportAppendix: metadata.definition?.origin === "DBMS_METADATA" && metadata.definition.format === "ddl" });
    if (!oracleTriggerSourceScopeMatches(metadata, prepared.header)) throw new Error("The source ON scope does not match the trigger dictionary; keep the draft and reload");
    const complete = metadata.definition?.complete === true && metadata.reads.identity?.state === "available" && metadata.reads.definition?.state === "available" && typeof metadata.objectId === "string" && metadata.objectId.length > 0;
    return { editableSource: prepared.definition, triggerSource: { complete, prepared, ...(!complete ? { error: "The complete trigger snapshot could not be verified; keep the draft and reload" } : {}) } };
  } catch (error) {
    return { editableSource: raw.source, triggerSource: { complete: false, error: error instanceof Error ? error.message : String(error) } };
  }
}

export function oracleTriggerErrorEditorOffset(raw: Readonly<ObjectSource>, editorSource: string, error: { line?: number | null; position?: number | null }): number | undefined {
  const metadata = exactOracleTriggerMetadata(raw.trigger);
  // ALL_ERRORS coordinates describe the stored unit. GET_DDL may reconstruct
  // its header/spacing, so that export alone does not establish a position map.
  if (!metadata || raw.object_type !== "TRIGGER" || raw.name !== metadata.name || raw.schema !== metadata.owner || metadata.definition?.origin !== "ALL_SOURCE" || metadata.definition.format !== "declaration" || !metadata.definition.complete || metadata.reads.definition?.state !== "available")
    return;
  const line = error.line,
    column = error.position;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || typeof column !== "number" || !Number.isSafeInteger(column) || column < 1) return;
  const source = raw.source.replace(/\r\n?/g, "\n");
  const lines = source.split("\n");
  const sourceLine = lines[line - 1];
  if (sourceLine === undefined) return;
  const characters = Array.from(sourceLine);
  if (column > characters.length + 1) return;
  const sourceOffset = lines.slice(0, line - 1).reduce((length, value) => length + value.length + 1, 0) + characters.slice(0, column - 1).join("").length;
  const storedUnit = source.trim();
  if (!storedUnit) return;
  const unitStart = source.indexOf(storedUnit);
  if (sourceOffset < unitStart || sourceOffset > unitStart + storedUnit.length) return;
  const editor = editorSource.replace(/\r\n?/g, "\n");
  const start = editor.indexOf(storedUnit);
  if (start < 0 || editor.indexOf(storedUnit, start + 1) >= 0) return;
  const head = tokenizeSqlSemantic(editor, "oracle").find((token) => token.span.start <= start && start < token.span.end);
  if (head?.kind !== "word" || head.span.start !== start) return;
  return start + sourceOffset - unitStart;
}

/**
 * Load object source, retrying common routine type mismatches.
 * Optimistic Ctrl/Cmd+click often assumes PROCEDURE; Oracle functions and package bodies need a second try.
 */
export async function loadObjectSourceWithRoutineFallback(
  getObjectSource: GetObjectSourceFn,
  connectionId: string,
  database: string,
  schema: string,
  name: string,
  objectType: ObjectSourceKind,
  signature?: string,
  relationName?: string,
  options?: MetadataReadOptions,
): Promise<{ source: ObjectSource; objectType: ObjectSourceKind }> {
  const primary = options ? await getObjectSource(connectionId, database, schema, name, objectType, signature, relationName, options) : await getObjectSource(connectionId, database, schema, name, objectType, signature, relationName);
  if (primary.source?.trim() || primary.routine_parameters !== undefined) {
    return { source: primary, objectType };
  }

  const fallbacks: ObjectSourceKind[] = objectType === "PROCEDURE" ? ["FUNCTION"] : objectType === "FUNCTION" ? ["PROCEDURE"] : objectType === "PACKAGE" ? ["PACKAGE_BODY"] : objectType === "PACKAGE_BODY" ? ["PACKAGE"] : [];

  for (const fallbackType of fallbacks) {
    try {
      const alternate = options ? await getObjectSource(connectionId, database, schema, name, fallbackType, signature, relationName, options) : await getObjectSource(connectionId, database, schema, name, fallbackType, signature, relationName);
      if (alternate.source?.trim() || alternate.routine_parameters !== undefined) {
        return { source: alternate, objectType: fallbackType };
      }
    } catch {
      // Keep trying remaining fallbacks; surface the primary empty/error state if none succeed.
    }
  }

  return { source: primary, objectType };
}

/**
 * Load raw object source then convert it to the editable editor form.
 *
 * For Oracle, bare `ALL_SOURCE` text like `procedure name is ...` becomes
 * `CREATE OR REPLACE procedure name is ...` so the query tab shows deployable DDL
 * (same wrapping ObjectSourceDialog already applies).
 */
export async function loadEditableObjectSourceForEditor(
  getObjectSource: GetObjectSourceFn,
  buildEditableObjectSource: BuildEditableObjectSourceFn,
  options: {
    connectionId: string;
    database: string;
    schema: string;
    name: string;
    objectType: ObjectSourceKind;
    databaseType: DatabaseType;
    signature?: string;
    relationName?: string;
    metadataReadOptions?: MetadataReadOptions;
  },
): Promise<{ raw: ObjectSource; editableSource: string; objectType: ObjectSourceKind; triggerSource?: OracleTriggerSourceInspection }> {
  const { source: raw, objectType: resolvedType } = await loadObjectSourceWithRoutineFallback(getObjectSource, options.connectionId, options.database, options.schema, options.name, options.objectType, options.signature, options.relationName, options.metadataReadOptions);

  if (resolvedType === "TRIGGER" && options.metadataReadOptions?.identityMode === "exact") {
    return { raw, objectType: resolvedType, ...(await inspectExactOracleTriggerSource(raw, options.schema, options.name)) };
  }

  const editableSource = await buildEditableObjectSource({
    databaseType: options.databaseType,
    objectType: resolvedType,
    schema: options.schema,
    name: options.name,
    source: raw.source,
  });

  return {
    raw,
    editableSource: editableSource.trim() ? editableSource : raw.source,
    objectType: resolvedType,
  };
}

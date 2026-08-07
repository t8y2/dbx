import type { DatabaseType, ObjectSource, ObjectSourceKind } from "@/types/database";

export type GetObjectSourceFn = (connectionId: string, database: string, schema: string, name: string, objectType: ObjectSourceKind, signature?: string, relationName?: string) => Promise<ObjectSource>;

export type BuildEditableObjectSourceFn = (input: { databaseType: DatabaseType; objectType: ObjectSourceKind; schema?: string; name: string; source: string }) => Promise<string>;

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
): Promise<{ source: ObjectSource; objectType: ObjectSourceKind }> {
  const primary = await getObjectSource(connectionId, database, schema, name, objectType, signature, relationName);
  if (primary.source?.trim()) {
    return { source: primary, objectType };
  }

  const fallbacks: ObjectSourceKind[] = objectType === "PROCEDURE" ? ["FUNCTION"] : objectType === "FUNCTION" ? ["PROCEDURE"] : objectType === "PACKAGE" ? ["PACKAGE_BODY"] : objectType === "PACKAGE_BODY" ? ["PACKAGE"] : [];

  for (const fallbackType of fallbacks) {
    try {
      const alternate = await getObjectSource(connectionId, database, schema, name, fallbackType, signature, relationName);
      if (alternate.source?.trim()) {
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
  },
): Promise<{ raw: ObjectSource; editableSource: string; objectType: ObjectSourceKind }> {
  const { source: raw, objectType: resolvedType } = await loadObjectSourceWithRoutineFallback(getObjectSource, options.connectionId, options.database, options.schema, options.name, options.objectType, options.signature, options.relationName);

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

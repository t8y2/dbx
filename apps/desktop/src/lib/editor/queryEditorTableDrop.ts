import type { DatabaseType } from "@/types/database";
import { qualifiedTableName, quoteTableIdentifier } from "@/lib/table/tableSelectSql";

export const DBX_TABLE_REFERENCE_MIME = "application/x-dbx-table-reference";
export const DBX_TABLE_REFERENCE_DROP_EVENT = "dbx-table-reference-drop";

export interface QueryEditorTableReferencePayload {
  kind: "dbx-table-reference";
  connectionId: string;
  database: string;
  schema?: string;
  tableName?: string;
  columnName?: string;
  referenceType?: "database" | "table" | "column";
  databaseType?: DatabaseType;
}

export interface QueryEditorTableReferenceDropDetail {
  payload: QueryEditorTableReferencePayload;
  clientX: number;
  clientY: number;
}

let activeTableReferencePayload: QueryEditorTableReferencePayload | null = null;

export function createTableReferencePayload(options: { connectionId?: string; database?: string; schema?: string; tableName?: string; columnName?: string; referenceType?: "database" | "table" | "column"; databaseType?: DatabaseType }): QueryEditorTableReferencePayload | null {
  if (!options.connectionId || options.database == null) return null;
  const referenceType = options.referenceType ?? (options.columnName ? "column" : "table");
  if (referenceType !== "database" && !options.tableName) return null;
  const payload: QueryEditorTableReferencePayload = {
    kind: "dbx-table-reference",
    connectionId: options.connectionId,
    database: options.database,
  };
  if (referenceType === "database") {
    payload.referenceType = "database";
  } else {
    payload.tableName = options.tableName;
  }
  if (referenceType === "column" && options.columnName) {
    payload.columnName = options.columnName;
    payload.referenceType = "column";
  }
  if (options.schema) payload.schema = options.schema;
  if (options.databaseType) payload.databaseType = options.databaseType;
  return payload;
}

export function serializeTableReferencePayload(payload: QueryEditorTableReferencePayload): string {
  return JSON.stringify(payload);
}

export function parseTableReferencePayload(value: string | undefined | null): QueryEditorTableReferencePayload | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<QueryEditorTableReferencePayload>;
    if (parsed.kind !== "dbx-table-reference" || typeof parsed.connectionId !== "string" || typeof parsed.database !== "string" || !parsed.connectionId) {
      return null;
    }
    if (parsed.referenceType === "database") {
      const payload: QueryEditorTableReferencePayload = {
        kind: "dbx-table-reference",
        connectionId: parsed.connectionId,
        database: parsed.database,
        referenceType: "database",
      };
      if (parsed.databaseType) payload.databaseType = parsed.databaseType;
      return payload;
    }
    if (typeof parsed.tableName !== "string" || !parsed.tableName) return null;
    const columnName = typeof parsed.columnName === "string" && parsed.columnName ? parsed.columnName : undefined;
    const referenceType = parsed.referenceType === "column" || columnName ? "column" : "table";
    if (referenceType === "column" && !columnName) return null;
    const payload: QueryEditorTableReferencePayload = {
      kind: "dbx-table-reference",
      connectionId: parsed.connectionId,
      database: parsed.database,
      tableName: parsed.tableName,
    };
    if (referenceType === "column" && columnName) {
      payload.columnName = columnName;
      payload.referenceType = "column";
    }
    if (typeof parsed.schema === "string" && parsed.schema) payload.schema = parsed.schema;
    if (parsed.databaseType) payload.databaseType = parsed.databaseType;
    return payload;
  } catch {
    return null;
  }
}

export function hasTableReferencePayloadType(types: Iterable<string> | undefined | null): boolean {
  if (!types) return false;
  for (const type of types) {
    if (type === DBX_TABLE_REFERENCE_MIME) return true;
  }
  return false;
}

export function setActiveTableReferencePayload(payload: QueryEditorTableReferencePayload | null) {
  activeTableReferencePayload = payload;
}

export function activeTableReferencePayloadValue(): QueryEditorTableReferencePayload | null {
  return activeTableReferencePayload;
}

export function clearActiveTableReferencePayload(payload?: QueryEditorTableReferencePayload | null) {
  if (!payload || activeTableReferencePayload === payload) {
    activeTableReferencePayload = null;
  }
}

export function createTableReferenceDropEvent(detail: QueryEditorTableReferenceDropDetail) {
  return new CustomEvent<QueryEditorTableReferenceDropDetail>(DBX_TABLE_REFERENCE_DROP_EVENT, { detail });
}

export function tableReferenceInsertText(payload: QueryEditorTableReferencePayload, fallbackDatabaseType?: DatabaseType): string {
  const databaseType = payload.databaseType ?? fallbackDatabaseType;
  if (payload.referenceType === "database") {
    return quoteTableIdentifier(databaseType, payload.database);
  }
  if (payload.referenceType === "column" && payload.columnName) {
    return quoteTableIdentifier(databaseType, payload.columnName);
  }
  const tableName = payload.tableName || payload.database;
  return qualifiedTableName({
    databaseType,
    schema: payload.schema,
    tableName,
  });
}

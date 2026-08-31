import type { DatabaseType } from "@/types/database";
import { qualifiedTableName, quoteTableIdentifier } from "@/lib/table/tableSelectSql";
import { requiresMysqlIdentifierQuote, requiresPostgresIdentifierQuote } from "@/lib/sql/sqlIdentifier.ts";

/** 智能引号使用反引号的方言族。 */
const SMART_QUOTE_BACKTICK_TYPES = new Set<DatabaseType>(["mysql", "clickhouse", "hive", "kyuubi", "impala", "spark", "databricks", "databend", "tdengine", "access", "doris", "starrocks", "goldendb"]);
/** 智能引号使用双引号的方言族（SQL Server 方括号除外）。 */
const SMART_QUOTE_DOUBLE_TYPES = new Set<DatabaseType>(["postgres", "gaussdb", "opengauss"]);
/** SQL Server 族智能引号使用方括号。 */
const SMART_QUOTE_BRACKET_TYPES = new Set<DatabaseType>(["sqlserver"]);

/**
 * 列引用插入的按需引号：普通名称（合法标识符字符、非保留字）裸输出，
 * 保留字或含特殊字符时按方言加引号。表名/库名仍走全量引号。
 *
 * MySQL/PG/SQL Server 族用各自的保留字判定；其余方言无专属保留字表，
 * 用「严格标识符正则 + PG/MySQL 保留字并集」做通用保守判定。
 */
function quoteColumnReferenceName(databaseType: DatabaseType | undefined, name: string): string {
  if (databaseType && SMART_QUOTE_BACKTICK_TYPES.has(databaseType)) {
    return requiresMysqlIdentifierQuote(name) ? `\`${name.replace(/`/g, "``")}\`` : name;
  }
  if (databaseType && SMART_QUOTE_DOUBLE_TYPES.has(databaseType)) {
    // PG 族裸标识符会折叠为小写，混合大小写必须加引号保留原样。
    return requiresPostgresIdentifierQuote(name) ? `"${name.replace(/"/g, '""')}"` : name;
  }
  if (databaseType && SMART_QUOTE_BRACKET_TYPES.has(databaseType)) {
    return requiresPostgresIdentifierQuote(name) ? `[${name.replace(/\]/g, "]]")}]` : name;
  }
  // 其余方言：引号格式仍由 quoteTableIdentifier 按方言决定，是否加引号
  // 用通用保守判定（严格标识符正则 + PG/MySQL 保留字并集）。
  return requiresMysqlIdentifierQuote(name) ? quoteTableIdentifier(databaseType, name) : name;
}

export const DBX_TABLE_REFERENCE_MIME = "application/x-dbx-table-reference";
export const DBX_TABLE_REFERENCE_DROP_EVENT = "dbx-table-reference-drop";
export const DBX_TABLE_REFERENCE_HOVER_EVENT = "dbx-table-reference-hover";
export const DBX_TABLE_REFERENCE_DRAG_END_EVENT = "dbx-table-reference-drag-end";

export interface QueryEditorTableReferencePayload {
  kind: "dbx-table-reference";
  connectionId: string;
  database: string;
  schema?: string;
  tableName?: string;
  columnName?: string;
  /** 多个结果列一起拖入时按选择顺序排列；单列沿用 columnName。 */
  columnNames?: string[];
  referenceType?: "database" | "table" | "column";
  databaseType?: DatabaseType;
  driverProfile?: string;
}

export interface QueryEditorTableReferenceDropDetail {
  payload: QueryEditorTableReferencePayload;
  clientX: number;
  clientY: number;
}

export interface QueryEditorTableReferenceHoverDetail {
  clientX: number;
  clientY: number;
}

function normalizeColumnNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((name) => (typeof name === "string" ? name.trim() : "")).filter((name) => name.length > 0);
}

/** schema/databaseType/driverProfile 为可选元数据，payload 各构造路径共用同一拷贝规则。 */
function applyOptionalReferenceMeta(payload: QueryEditorTableReferencePayload, source: Partial<QueryEditorTableReferencePayload>) {
  if (typeof source.schema === "string" && source.schema) payload.schema = source.schema;
  if (source.databaseType) payload.databaseType = source.databaseType;
  if (typeof source.driverProfile === "string" && source.driverProfile) payload.driverProfile = source.driverProfile;
}

let activeTableReferencePayload: QueryEditorTableReferencePayload | null = null;

export function createTableReferencePayload(options: {
  connectionId?: string;
  database?: string;
  schema?: string;
  tableName?: string;
  columnName?: string;
  referenceType?: "database" | "table" | "column";
  databaseType?: DatabaseType;
  driverProfile?: string;
}): QueryEditorTableReferencePayload | null {
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
  applyOptionalReferenceMeta(payload, options);
  return payload;
}

export function createColumnReferencePayload(options: { connectionId?: string; database?: string; schema?: string; columnNames?: readonly (string | undefined | null)[]; databaseType?: DatabaseType }): QueryEditorTableReferencePayload | null {
  const columnNames = normalizeColumnNames(options.columnNames);
  if (!options.connectionId || options.database == null || columnNames.length === 0) return null;
  const payload: QueryEditorTableReferencePayload = {
    kind: "dbx-table-reference",
    connectionId: options.connectionId,
    database: options.database,
    referenceType: "column",
    columnNames,
  };
  applyOptionalReferenceMeta(payload, options as Partial<QueryEditorTableReferencePayload>);
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
      if (typeof parsed.driverProfile === "string" && parsed.driverProfile) payload.driverProfile = parsed.driverProfile;
      return payload;
    }
    if (typeof parsed.tableName !== "string" || !parsed.tableName) {
      // 无来源表的纯列引用（如从查询结果列头拖入），tableName 非必需。
      const columnNames = normalizeColumnNames(parsed.columnNames);
      if (columnNames.length === 0) return null;
      const payload: QueryEditorTableReferencePayload = {
        kind: "dbx-table-reference",
        connectionId: parsed.connectionId,
        database: parsed.database,
        referenceType: "column",
        columnNames,
      };
      applyOptionalReferenceMeta(payload, parsed);
      return payload;
    }
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
    applyOptionalReferenceMeta(payload, parsed);
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

export function createTableReferenceHoverEvent(detail: QueryEditorTableReferenceHoverDetail) {
  return new CustomEvent<QueryEditorTableReferenceHoverDetail>(DBX_TABLE_REFERENCE_HOVER_EVENT, { detail });
}

export function createTableReferenceDragEndEvent(): Event {
  return new Event(DBX_TABLE_REFERENCE_DRAG_END_EVENT);
}

export function tableReferenceInsertText(payload: QueryEditorTableReferencePayload, fallbackDatabaseType?: DatabaseType): string {
  const databaseType = payload.databaseType ?? fallbackDatabaseType;
  if (payload.referenceType === "database") {
    return quoteTableIdentifier(databaseType, payload.database);
  }
  const columnNames = payload.columnNames?.length ? payload.columnNames : payload.columnName ? [payload.columnName] : [];
  if (payload.referenceType === "column" && columnNames.length > 0) {
    return columnNames.map((name) => quoteColumnReferenceName(databaseType, name)).join(",\n");
  }
  const tableName = payload.tableName || payload.database;
  return qualifiedTableName({
    databaseType,
    driverProfile: payload.driverProfile,
    schema: payload.schema,
    tableName,
  });
}

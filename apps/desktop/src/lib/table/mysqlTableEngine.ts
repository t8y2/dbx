import type { ConnectionConfig, QueryResult } from "@/types/database";

export interface MysqlTableEngineMetadata {
  currentEngine?: string;
  defaultEngine?: string;
  engines: string[];
}

export interface MysqlTableEngineDraft {
  value: string;
  originalValue: string;
}

export const MYSQL_STORAGE_ENGINES_SQL = "SHOW ENGINES";

function mysqlUtf8Literal(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `CONVERT(X'${hex}' USING utf8mb4)`;
}

export function mysqlTableEngineSql(database: string, table: string): string {
  return ["SELECT ENGINE AS engine", "FROM information_schema.TABLES", `WHERE TABLE_SCHEMA = ${mysqlUtf8Literal(database)}`, `  AND TABLE_NAME = ${mysqlUtf8Literal(table)}`, "LIMIT 1"].join("\n");
}

function columnIndex(result: QueryResult, name: string): number {
  return result.columns.findIndex((column) => column.trim().toLowerCase() === name.toLowerCase());
}

function cellText(result: QueryResult, rowIndex: number, index: number): string {
  if (index < 0) return "";
  const value = result.rows[rowIndex]?.[index];
  return value === null || value === undefined ? "" : String(value).trim();
}

export function parseMysqlTableEngineMetadata(enginesResult: QueryResult, tableResult?: QueryResult): MysqlTableEngineMetadata {
  const engineIndex = columnIndex(enginesResult, "Engine");
  const supportIndex = columnIndex(enginesResult, "Support");
  const engines: string[] = [];
  let defaultEngine: string | undefined;
  const seen = new Set<string>();

  for (let rowIndex = 0; rowIndex < enginesResult.rows.length; rowIndex += 1) {
    const engine = cellText(enginesResult, rowIndex, engineIndex);
    const support = cellText(enginesResult, rowIndex, supportIndex).toUpperCase();
    if (!engine || (support !== "YES" && support !== "DEFAULT")) continue;
    const key = engine.toLowerCase();
    if (!seen.has(key)) {
      engines.push(engine);
      seen.add(key);
    }
    if (support === "DEFAULT") defaultEngine = engine;
  }

  let currentEngine: string | undefined;
  if (tableResult) {
    currentEngine = cellText(tableResult, 0, columnIndex(tableResult, "engine")) || undefined;
    if (currentEngine && !seen.has(currentEngine.toLowerCase())) engines.unshift(currentEngine);
  }

  return { currentEngine, defaultEngine, engines };
}

export function mysqlTableEngineDraft(metadata: MysqlTableEngineMetadata, isCreateMode: boolean): MysqlTableEngineDraft {
  const current = (isCreateMode ? metadata.defaultEngine || metadata.engines[0] : metadata.currentEngine) || "";
  return { value: current, originalValue: current };
}

export function refreshMysqlTableEngineDraft(metadata: MysqlTableEngineMetadata, current: MysqlTableEngineDraft, isCreateMode: boolean, preserveDraft: boolean): MysqlTableEngineDraft {
  const server = mysqlTableEngineDraft(metadata, isCreateMode);
  if (!preserveDraft || current.value === current.originalValue) return server;
  return { value: current.value, originalValue: server.originalValue };
}

export function mysqlTableEngineSqlOption(draft: MysqlTableEngineDraft, isCreateMode: boolean, supported: boolean): string | undefined {
  const value = draft.value.trim();
  if (!supported || !value) return undefined;
  if (!isCreateMode && value.toLowerCase() === draft.originalValue.trim().toLowerCase()) return undefined;
  return value;
}

export function supportsMysqlTableEngine(connection: Pick<ConnectionConfig, "db_type" | "driver_profile"> | undefined): boolean {
  if (connection?.db_type !== "mysql") return false;
  const profile = connection.driver_profile?.trim().toLowerCase();
  return !profile || profile === "mysql";
}

import type { BackendErrorTranslate } from "@/i18n/backend-errors";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { supportsNativeMysqlAutoIncrement, type MysqlAutoIncrementSqlOptions } from "@/lib/database/dbAdminSql";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";

export interface MysqlAutoIncrementCounterDraft {
  value: string | undefined;
  originalValue: string | undefined;
}

export function mysqlAutoIncrementCounterDraft(value: string | null): MysqlAutoIncrementCounterDraft {
  const current = value ?? undefined;
  return { value: current, originalValue: current };
}

export function refreshMysqlAutoIncrementCounterDraft(serverValue: string | null, current: MysqlAutoIncrementCounterDraft, preserveDraft: boolean): MysqlAutoIncrementCounterDraft {
  const server = mysqlAutoIncrementCounterDraft(serverValue);
  if (!preserveDraft || current.value === current.originalValue) return server;
  return { value: current.value, originalValue: server.originalValue };
}

export function canEditMysqlAutoIncrementCounter(connection: Pick<ConnectionConfig, "db_type" | "driver_profile"> | undefined, _isCreateMode: boolean, columns: readonly EditableStructureColumn[]): boolean {
  if (!supportsNativeMysqlAutoIncrement(connection)) return false;
  return columns.some((column) => !column.markedForDrop && column.extra.autoIncrement === true);
}

export interface BuildMysqlAutoIncrementCounterStatementOptions extends Omit<MysqlAutoIncrementSqlOptions, "databaseType" | "value"> {
  enabled: boolean;
  databaseType: DatabaseType | undefined;
  value: string | undefined;
  originalValue: string | undefined;
  buildSql: (options: MysqlAutoIncrementSqlOptions) => Promise<string>;
}

export async function buildMysqlAutoIncrementCounterStatement({ enabled, originalValue, buildSql, ...options }: BuildMysqlAutoIncrementCounterStatementOptions): Promise<string | undefined> {
  const { databaseType, value } = options;
  if (!enabled || databaseType === undefined || originalValue === undefined || value === undefined || value === originalValue) {
    return undefined;
  }
  return buildSql({ ...options, databaseType, value });
}

/** Translate only recognized structure warnings; preserve other backend diagnostics. */
export function translateMysqlAutoIncrementWarning(t: BackendErrorTranslate, warning: string): string {
  if (warning === "MySQL allows only one AUTO_INCREMENT column per table.") {
    return t("structureEditor.mysqlAutoIncrementSingleColumn");
  }
  if (warning === "AUTO_INCREMENT requires a native MySQL auto-increment column.") {
    return t("structureEditor.mysqlAutoIncrementRequiresNativeColumn");
  }
  const missingIndex = /^AUTO_INCREMENT column "([\s\S]*)" requires a supporting index \(first key column for InnoDB\)\.$/.exec(warning);
  if (missingIndex) return t("structureEditor.mysqlAutoIncrementRequiresIndex", { column: missingIndex[1] });
  return warning;
}

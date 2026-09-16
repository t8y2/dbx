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

export function canEditMysqlAutoIncrementCounter(connection: Pick<ConnectionConfig, "db_type" | "driver_profile"> | undefined, isCreateMode: boolean, columns: readonly EditableStructureColumn[]): boolean {
  if (isCreateMode || !supportsNativeMysqlAutoIncrement(connection)) return false;
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

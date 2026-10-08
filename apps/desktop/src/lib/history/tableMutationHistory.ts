import { getActivePinia } from "pinia";
import type { HistoryEntry } from "@/lib/backend/api";
import { classifySqlActivityKind, primarySqlOperation } from "@/lib/history/historyActivityKind";
import { useHistoryStore } from "@/stores/historyStore";

export interface RecordTableMutationHistoryOptions {
  connectionId: string;
  connectionName?: string;
  database: string;
  sql: string;
  elapsedMs?: number;
  success?: boolean;
  error?: string;
  target?: string;
  affectedRows?: number;
}

export type TableMutationHistoryStore = {
  add: (entry: Omit<HistoryEntry, "id" | "executed_at">) => Promise<void>;
};

export function getTableMutationHistoryStoreOrNull(): TableMutationHistoryStore | null {
  try {
    if (!getActivePinia()) return null;
    return useHistoryStore();
  } catch {
    return null;
  }
}

export async function recordTableMutationHistory(historyStore: TableMutationHistoryStore | undefined | null, options: RecordTableMutationHistoryOptions): Promise<void> {
  if (!historyStore) return;
  const sql = options.sql.trim();
  if (!sql || !options.connectionId) return;

  const success = options.success ?? true;
  await historyStore.add({
    connection_id: options.connectionId,
    connection_name: options.connectionName || "",
    database: options.database,
    sql,
    execution_time_ms: Math.max(0, options.elapsedMs ?? 0),
    success,
    error: options.error,
    activity_kind: classifySqlActivityKind(sql),
    operation: primarySqlOperation(sql),
    target: options.target,
    affected_rows: success ? options.affectedRows : undefined,
  });
}

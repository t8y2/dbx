import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export type BinlogFilter = { database?: string; table?: string; gtid?: string; from_time?: number; to_time?: number; from_position?: number; to_position?: number };
export type BinlogTransaction = { start_position: string; end_position: string; timestamp: number; gtid: string | null; rows: number; tables: [string, string][] };
export type BinlogList = { sha256: string; total: number; offset: number; transactions: BinlogTransaction[] };
export type BinlogCell = { ordinal: number; column: string; kind: string; value: string | null };
export type BinlogRow = { position: string; database: string; table: string; full_image: boolean; has_column_names: boolean; has_signedness: boolean; before: BinlogCell[] | null; after: BinlogCell[] | null };
export type BinlogDetails = { sha256: string; start_position: string; total: number; offset: number; rows: BinlogRow[] };
export type BinlogRequest = { action: "list"; path: string; filter?: BinlogFilter; offset?: number } | { action: "details"; path: string; sha256: string; start_position: string; offset?: number } | { action: "generate"; path: string; sha256: string; schema_path: string; start_positions: string[] };

export async function requestBinlog<T>(request: BinlogRequest, requestId: string): Promise<T> {
  if (!isTauriRuntime()) throw new Error("Binlog recovery is available in Desktop only.");
  const response = await invoke<string>("binlog_recovery_request", { requestId, request: JSON.stringify(request) });
  return JSON.parse(response) as T;
}
export async function cancelBinlog(requestId: string): Promise<void> {
  await invoke("binlog_recovery_cancel", { requestId });
}
export function positionFilter(value: string): number | undefined {
  if (!value.trim()) return undefined;
  if (!/^\d+$/.test(value)) throw new Error("Position must be a non-negative decimal integer.");
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error("Position exceeds the supported exact integer range.");
  return number;
}
export async function exportBinlogSql(path: string, sql: string): Promise<void> {
  await invoke("binlog_recovery_export", { path, sql });
}

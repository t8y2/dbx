import type { ConnectionConfig } from "@/types/database";

export const DEFAULT_QUERY_TIMEOUT_SECS = 30;

export function queryTimeoutSecsForConnection(connection?: Pick<ConnectionConfig, "query_timeout_secs"> | null): number {
  const value = Number(connection?.query_timeout_secs);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_QUERY_TIMEOUT_SECS;
}

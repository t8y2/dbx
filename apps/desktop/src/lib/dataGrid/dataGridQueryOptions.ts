import { queryTimeoutSecsForConnection } from "@/lib/sql/queryTimeout";
import type { ConnectionConfig } from "@/types/database";

export function dataGridCountQueryOptions(connection?: Pick<ConnectionConfig, "query_timeout_secs"> | null): {
  maxRows: number;
  timeoutSecs: number;
} {
  // COUNT queries can be slower than the paged query they summarize. Always
  // inherit the connection setting instead of falling back to the backend's shorter legacy default.
  return {
    maxRows: 1,
    timeoutSecs: queryTimeoutSecsForConnection(connection),
  };
}

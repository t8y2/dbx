import type { HistoryConnectionFilter, HistoryDatabaseFilter } from "@/lib/backend/api";

export function historyConnectionHasSelectedDatabase(connection: HistoryConnectionFilter, databases: HistoryDatabaseFilter[]): boolean {
  return databases.some((database) => {
    if (!database.database) return false;
    if (connection.connection_id || database.connection_id) {
      return Boolean(connection.connection_id) && connection.connection_id === database.connection_id;
    }
    return Boolean(connection.connection_name) && connection.connection_name === database.connection_name;
  });
}

import { addConnection as desktopAddConnection, findConnection as desktopFindConnection, loadConnections as desktopLoadConnections, removeConnection as desktopRemoveConnection } from "./connections.js";
import { closeDatabaseResources as desktopCloseDatabaseResources, describeTable as desktopDescribeTable, executeQuery as desktopExecuteQuery, listTables as desktopListTables } from "./database.js";
import type { ConnectionConfig } from "./connections.js";
import type { ColumnInfo, QueryOptions, QueryResult, TableInfo } from "./database.js";

export interface Backend {
  loadConnections(): Promise<ConnectionConfig[]>;
  findConnection(name: string): Promise<ConnectionConfig | undefined>;
  addConnection(config: Omit<ConnectionConfig, "id">): Promise<ConnectionConfig>;
  removeConnection(name: string): Promise<boolean>;
  listTables(config: ConnectionConfig, schema?: string): Promise<TableInfo[]>;
  describeTable(config: ConnectionConfig, table: string, schema?: string): Promise<ColumnInfo[]>;
  executeQuery(config: ConnectionConfig, sql: string, options?: QueryOptions): Promise<QueryResult>;
  close?(): Promise<void>;
}

export async function createBackend(env: NodeJS.ProcessEnv = process.env): Promise<Backend> {
  if (env.DBX_WEB_URL) {
    return await import("./web-backend.js");
  }

  return {
    loadConnections: desktopLoadConnections,
    findConnection: desktopFindConnection,
    addConnection: desktopAddConnection,
    removeConnection: desktopRemoveConnection,
    listTables: desktopListTables,
    describeTable: desktopDescribeTable,
    executeQuery: desktopExecuteQuery,
    close: desktopCloseDatabaseResources,
  };
}

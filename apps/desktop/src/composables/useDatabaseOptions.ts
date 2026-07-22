import { ref } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { filterDatabaseNamesForConnection, filterSchemaNamesForConnection } from "@/lib/database/visibleDatabases";
import { usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";

type NamespaceOptionsConnection = Pick<ConnectionConfig, "database" | "db_type" | "driver_profile" | "visible_databases" | "visible_schemas">;

export function databaseOptionsForConnection(databaseNames: string[], connection: Pick<ConnectionConfig, "db_type" | "visible_databases"> | undefined): string[] {
  const names = filterDatabaseNamesForConnection(databaseNames, connection);
  if (names.length === 0 && usesTreeSchemaMode(connection?.db_type)) return [""];
  return names;
}

export function namespaceOptionsAreSchemas(connection: Pick<ConnectionConfig, "db_type"> | undefined): boolean {
  return connection?.db_type === "dameng";
}

export async function fetchNamespaceOptionsForConnection(connectionId: string, connection: NamespaceOptionsConnection): Promise<string[]> {
  if (connection.db_type === "dameng") {
    const database = connection.database || "";
    // Dameng users and schemas are not interchangeable: independent schemas
    // appear in listSchemas but not in the user-backed listDatabases result.
    const schemas = await api.listSchemas(connectionId, database, true);
    return filterSchemaNamesForConnection(schemas, connection, database);
  }

  const databases = await api.listDatabases(connectionId);
  return databaseOptionsForConnection(
    databases.map((database) => database.name),
    connection,
  );
}

export async function fetchSqlFileTargetOptions(connectionId: string, connection: NamespaceOptionsConnection): Promise<string[]> {
  return fetchNamespaceOptionsForConnection(connectionId, connection);
}

export function useDatabaseOptions() {
  const connectionStore = useConnectionStore();

  const databaseOptions = ref<Record<string, string[]>>({});
  const loadingDatabaseOptions = ref<Record<string, boolean>>({});

  async function loadDatabaseOptions(connectionId: string) {
    const connection = connectionStore.getConfig(connectionId);
    if (!connection || loadingDatabaseOptions.value[connectionId]) return;

    loadingDatabaseOptions.value[connectionId] = true;
    try {
      await connectionStore.ensureConnected(connectionId);
      if (connection.db_type === "redis") {
        const dbs = await api.redisListDatabases(connectionId);
        databaseOptions.value[connectionId] = databaseOptionsForConnection(
          dbs.map((db) => String(db.db)),
          connection,
        );
      } else if (connection.db_type === "mongodb") {
        databaseOptions.value[connectionId] = filterDatabaseNamesForConnection(await api.mongoListDatabases(connectionId), connection);
      } else {
        const dbs = await api.listDatabases(connectionId);
        databaseOptions.value[connectionId] = databaseOptionsForConnection(
          dbs.map((db) => db.name),
          connection,
        );
      }
    } finally {
      loadingDatabaseOptions.value[connectionId] = false;
    }
  }

  async function getDatabaseOptions(connectionId: string): Promise<string[]> {
    if (!databaseOptions.value[connectionId]) {
      await loadDatabaseOptions(connectionId);
    }
    return databaseOptions.value[connectionId] ?? [];
  }

  return { databaseOptions, loadingDatabaseOptions, loadDatabaseOptions, getDatabaseOptions };
}

import { ref } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { filterDatabaseNamesForConnection, filterSchemaNamesForConnection } from "@/lib/database/visibleDatabases";
import { usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { isInternalDorisCatalog } from "@/lib/database/databaseFeatureSupport";
import type { CatalogInfo, ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";

type NamespaceOptionsConnection = Pick<ConnectionConfig, "database" | "db_type" | "driver_profile" | "visible_databases" | "visible_schemas">;
export function catalogDatabaseOptionsKey(connectionId: string, catalog: string): string {
  return `${connectionId}:${catalog}`;
}

export function queryCatalogSelectorVisible(catalogs: CatalogInfo[]): boolean {
  return catalogs.some((catalog) => !isInternalDorisCatalog(catalog.catalog_type, catalog.name));
}

export function selectedQueryCatalogName(catalogs: CatalogInfo[], tabCatalog?: string): string {
  if (tabCatalog) return tabCatalog;
  return catalogs.find((catalog) => isInternalDorisCatalog(catalog.catalog_type, catalog.name))?.name ?? "";
}

export function normalizedQueryTabCatalog(catalogs: CatalogInfo[], selectedCatalog: string): string | undefined {
  if (!selectedCatalog) return undefined;
  const catalog = catalogs.find((candidate) => candidate.name === selectedCatalog);
  return catalog && isInternalDorisCatalog(catalog.catalog_type, catalog.name) ? undefined : selectedCatalog;
}

export function databaseAfterCatalogChange(currentDatabase: string, databaseOptions: string[]): string {
  return databaseOptions.includes(currentDatabase) ? currentDatabase : "";
}

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
  const catalogOptions = ref<Record<string, CatalogInfo[]>>({});
  const loadingCatalogOptions = ref<Record<string, boolean>>({});
  const catalogDatabaseOptions = ref<Record<string, string[]>>({});
  const loadingCatalogDatabaseOptions = ref<Record<string, boolean>>({});
  const catalogRequests = new Map<string, Promise<CatalogInfo[]>>();
  const catalogDatabaseRequests = new Map<string, Promise<string[]>>();

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

  async function loadCatalogOptions(connectionId: string): Promise<CatalogInfo[]> {
    const cached = catalogOptions.value[connectionId];
    if (cached) return cached;
    const pending = catalogRequests.get(connectionId);
    if (pending) return pending;

    const request = (async () => {
      loadingCatalogOptions.value[connectionId] = true;
      try {
        await connectionStore.ensureConnected(connectionId);
        const catalogs = await api.listDorisCatalogs(connectionId);
        catalogOptions.value[connectionId] = catalogs;
        return catalogs;
      } finally {
        loadingCatalogOptions.value[connectionId] = false;
        catalogRequests.delete(connectionId);
      }
    })();
    catalogRequests.set(connectionId, request);
    return request;
  }

  async function loadCatalogDatabaseOptions(connectionId: string, catalog: string): Promise<string[]> {
    const key = catalogDatabaseOptionsKey(connectionId, catalog);
    const cached = catalogDatabaseOptions.value[key];
    if (cached) return cached;
    const pending = catalogDatabaseRequests.get(key);
    if (pending) return pending;

    const request = (async () => {
      loadingCatalogDatabaseOptions.value[key] = true;
      try {
        await connectionStore.ensureConnected(connectionId);
        const connection = connectionStore.getConfig(connectionId);
        const databases = await api.listDorisCatalogDatabases(connectionId, catalog);
        const names = databaseOptionsForConnection(
          databases.map((database) => database.name),
          connection,
        );
        catalogDatabaseOptions.value[key] = names;
        return names;
      } finally {
        loadingCatalogDatabaseOptions.value[key] = false;
        catalogDatabaseRequests.delete(key);
      }
    })();
    catalogDatabaseRequests.set(key, request);
    return request;
  }

  async function getDatabaseOptions(connectionId: string): Promise<string[]> {
    if (!databaseOptions.value[connectionId]) {
      await loadDatabaseOptions(connectionId);
    }
    return databaseOptions.value[connectionId] ?? [];
  }

  return {
    databaseOptions,
    loadingDatabaseOptions,
    loadDatabaseOptions,
    getDatabaseOptions,
    catalogOptions,
    loadingCatalogOptions,
    loadCatalogOptions,
    catalogDatabaseOptions,
    loadingCatalogDatabaseOptions,
    loadCatalogDatabaseOptions,
  };
}

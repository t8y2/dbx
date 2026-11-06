import { ref } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { isSchemaAware as isSchemaAwareType, isSingleDatabase, usesTreeSchemaMode } from "@/lib/database/databaseCapabilities";
import { sortSidebarNames } from "@/lib/database/databaseTree";
import { filterSchemaNamesForConnection, schemaVisibilityDatabaseKey } from "@/lib/database/visibleDatabases";
import type { ConnectionConfig } from "@/types/database";

export function hasSchemaOptionsCacheEntry(options: Record<string, string[]>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, key);
}

export function schemaOptionsCacheKey(connectionId: string, database: string, showSystemSchemas: boolean): string {
  return `${connectionId}:${database}:${showSystemSchemas ? "show-system" : "hide-system"}`;
}

export function schemaOptionsForConnection(schemaNames: string[], connection: Partial<ConnectionConfig> | undefined, database = "", oracleMaintainedSchemas?: ReadonlySet<string>): string[] {
  // Keep numeric schema suffixes in human order (SCHEMA2 before SCHEMA10), matching the database tree.
  return sortSidebarNames(filterSchemaNamesForConnection(schemaNames, connection, database, { oracleMaintainedSchemas }));
}

export function useSchemaOptions() {
  const connectionStore = useConnectionStore();

  const schemaOptions = ref<Record<string, string[]>>({});
  const loadingSchemaOptions = ref<Record<string, boolean>>({});
  const schemaRequests = new Map<string, Promise<void>>();
  const loadedSelections = new Map<string, string | undefined>();
  const maintainedSchemas = new Map<string, ReadonlySet<string> | undefined>();
  const loadedRevisions = new Map<string, number>();

  function cacheKey(connectionId: string, database: string) {
    return schemaOptionsCacheKey(connectionId, database, true);
  }

  function isSchemaAware(connectionId: string): boolean {
    return isSchemaAwareType(connectionStore.getConfig(connectionId)?.db_type);
  }

  async function loadSchemaOptions(connectionId: string, database: string) {
    if (!isSchemaAware(connectionId)) return;
    const connection = connectionStore.getConfig(connectionId);
    const dbType = connection?.db_type;
    if (!database && !isSingleDatabase(dbType) && !usesTreeSchemaMode(dbType)) return;
    const key = cacheKey(connectionId, database);
    const databaseKey = schemaVisibilityDatabaseKey(connection, database);
    const overrides = connection?.schema_visibility?.databases[databaseKey];
    const selected = overrides ? Object.keys(overrides).filter((name) => overrides[name]) : connection?.visible_schemas?.[databaseKey];
    const signature = JSON.stringify(selected);
    const cached = schemaOptions.value[key];
    const revision = connectionStore.completionCacheRevision(connectionId, database);
    const refresh = hasSchemaOptionsCacheEntry(schemaOptions.value, key) && loadedSelections.get(key) !== signature && selected?.some((name) => !cached!.includes(name)) === true;
    if (hasSchemaOptionsCacheEntry(schemaOptions.value, key) && !refresh && loadedRevisions.get(key) === revision) return;
    const pending = schemaRequests.get(key);
    if (pending) return pending;

    const request = (async () => {
      loadingSchemaOptions.value[key] = true;
      try {
        await connectionStore.ensureConnected(connectionId);
        const selectionRequest = connectionStore.readVisibleSchemaSelection(connectionId, database, refresh);
        const requestRevision = connectionStore.completionCacheRevision(connectionId, database);
        const selection = await selectionRequest;
        schemaOptions.value[key] = selection.names;
        maintainedSchemas.set(key, selection.oracleMaintainedSchemas);
        loadedRevisions.set(key, requestRevision);
        loadedSelections.set(key, signature);
      } catch (e) {
        loadedSelections.set(key, signature);
        delete schemaOptions.value[key];
        throw e;
      } finally {
        loadingSchemaOptions.value[key] = false;
        schemaRequests.delete(key);
      }
    })();
    schemaRequests.set(key, request);
    return request;
  }

  function getSchemaOptionsForDb(connectionId: string, database: string): string[] {
    const key = cacheKey(connectionId, database);
    return schemaOptionsForConnection(schemaOptions.value[key] ?? [], connectionStore.getConfig(connectionId), database, maintainedSchemas.get(key));
  }

  function isLoadingSchemas(connectionId: string, database: string): boolean {
    return !!loadingSchemaOptions.value[cacheKey(connectionId, database)];
  }

  return {
    schemaOptions,
    loadingSchemaOptions,
    loadSchemaOptions,
    getSchemaOptionsForDb,
    isLoadingSchemas,
    isSchemaAware,
  };
}

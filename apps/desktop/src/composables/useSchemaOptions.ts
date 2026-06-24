import { ref } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { isSchemaAware as isSchemaAwareType, isSingleDatabase, usesTreeSchemaMode } from "@/lib/databaseCapabilities";
import { filterDatabaseNamesForConnection } from "@/lib/visibleDatabases";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/api";

export function hasSchemaOptionsCacheEntry(options: Record<string, string[]>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(options, key);
}

export function schemaOptionsForConnection(schemaNames: string[], connection: Pick<ConnectionConfig, "db_type" | "driver_profile" | "visible_databases"> | undefined): string[] {
  return filterDatabaseNamesForConnection(schemaNames, connection);
}

export function useSchemaOptions() {
  const connectionStore = useConnectionStore();

  const schemaOptions = ref<Record<string, string[]>>({});
  const loadingSchemaOptions = ref<Record<string, boolean>>({});

  function cacheKey(connectionId: string, database: string) {
    return `${connectionId}:${database}`;
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
    if (hasSchemaOptionsCacheEntry(schemaOptions.value, key)) return;
    if (loadingSchemaOptions.value[key]) return;

    loadingSchemaOptions.value[key] = true;
    try {
      await connectionStore.ensureConnected(connectionId);
      schemaOptions.value[key] = schemaOptionsForConnection(await api.listSchemas(connectionId, database), connection);
    } catch (e) {
      schemaOptions.value[key] = [];
      throw e;
    } finally {
      loadingSchemaOptions.value[key] = false;
    }
  }

  function getSchemaOptionsForDb(connectionId: string, database: string): string[] {
    return schemaOptions.value[cacheKey(connectionId, database)] ?? [];
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

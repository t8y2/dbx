import { ref } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/api";

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
        databaseOptions.value[connectionId] = dbs.map(String);
      } else if (connection.db_type === "mongodb") {
        databaseOptions.value[connectionId] = await api.mongoListDatabases(connectionId);
      } else {
        const dbs = await api.listDatabases(connectionId);
        databaseOptions.value[connectionId] = dbs.map((db) => db.name);
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

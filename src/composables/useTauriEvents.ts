import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { NavigationTarget } from "@/composables/useNavigationTargets";

export function useTauriEvents(deps: { openTableTarget: (target: NavigationTarget) => Promise<void> }) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();

  function setupTauriListeners() {
    import("@tauri-apps/api/event")
      .then(({ listen }) => {
        listen<{ connection_id: string; database: string; schema?: string; table: string }>(
          "mcp-open-table",
          async (event) => {
            const { connection_id, database, schema, table } = event.payload;
            if (!connectionStore.connections.length) await connectionStore.initFromDisk();
            const config = connectionStore.getConfig(connection_id);
            if (!config) return;
            connectionStore.activeConnectionId = connection_id;
            await connectionStore.ensureConnected(connection_id);
            if (config.db_type === "redis") {
              queryStore.createTab(connection_id, database || "0", `db${database || "0"}`, "redis");
            } else if (config.db_type === "mongodb") {
              queryStore.createTab(connection_id, database, table, "mongo");
            } else {
              deps.openTableTarget({
                connectionId: connection_id,
                database,
                schema,
                tableName: table,
              });
            }
            import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
              getCurrentWindow()
                .setFocus()
                .catch(() => {}),
            );
          },
        );
        listen("mcp-reload-connections", async () => {
          await connectionStore.initFromDisk();
        });
        listen<{ connection_id: string; database: string; sql: string }>("mcp-execute-query", async (event) => {
          const { connection_id, database, sql } = event.payload;
          if (!connectionStore.connections.length) await connectionStore.initFromDisk();
          const config = connectionStore.getConfig(connection_id);
          if (!config) return;
          connectionStore.activeConnectionId = connection_id;
          await connectionStore.ensureConnected(connection_id);
          const tabId = queryStore.createTab(connection_id, database, undefined, "query");
          queryStore.updateSql(tabId, sql);
          await queryStore.executeTabSql(tabId, sql);
          import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
            getCurrentWindow()
              .setFocus()
              .catch(() => {}),
          );
        });
      })
      .catch(() => {});
  }

  return { setupTauriListeners };
}

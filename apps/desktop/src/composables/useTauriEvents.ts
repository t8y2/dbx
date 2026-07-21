import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { NavigationTarget } from "@/composables/useNavigationTargets";
import type { QueryResult } from "@/types/database";

export function useTauriEvents(deps: { openTableTarget: (target: NavigationTarget) => Promise<void>; openSqlFilePath: (path: string) => Promise<void>; openDbFilePath: (path: string) => Promise<void>; openConnectionDeepLink: (url: string) => Promise<void> }) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const unlistenHandles: Array<() => void> = [];

  function focusCurrentWindow() {
    void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
      getCurrentWindow()
        .setFocus()
        .catch(() => {}),
    );
  }

  function setupTauriListeners() {
    import("@tauri-apps/api/event")
      .then(({ listen }) => {
        listen<{ connection_id: string; database: string; schema?: string; table: string }>("mcp-open-table", async (event) => {
          try {
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
              deps.openTableTarget({ connectionId: connection_id, database, schema, tableName: table });
            }
            focusCurrentWindow();
          } catch (e) {
            console.error("[DBX] mcp-open-table error:", e);
          }
        }).then((unlisten) => unlistenHandles.push(unlisten));

        listen("mcp-reload-connections", async () => {
          try {
            await connectionStore.initFromDisk();
          } catch (e) {
            console.error("[DBX] mcp-reload-connections error:", e);
          }
        }).then((unlisten) => unlistenHandles.push(unlisten));

        listen<{
          connection_id: string;
          database: string;
          sql: string;
          results: QueryResult[];
        }>("mcp-execute-query", async (event) => {
          try {
            const { connection_id, database, sql, results } = event.payload;
            if (!connectionStore.connections.length) await connectionStore.initFromDisk();
            const config = connectionStore.getConfig(connection_id);
            if (!config) return;
            connectionStore.activeConnectionId = connection_id;
            queryStore.showExecutedQueryResults(connection_id, database, sql, results);
            focusCurrentWindow();
          } catch (e) {
            console.error("[DBX] mcp-execute-query error:", e);
          }
        }).then((unlisten) => unlistenHandles.push(unlisten));

        listen<string[]>("dbx-open-sql-files", async (event) => {
          try {
            for (const path of event.payload) {
              await deps.openSqlFilePath(path);
            }
            focusCurrentWindow();
          } catch (e) {
            console.error("[DBX] dbx-open-sql-files error:", e);
          }
        }).then((unlisten) => unlistenHandles.push(unlisten));

        listen<string[]>("dbx-open-db-files", async (event) => {
          try {
            for (const path of event.payload) {
              await deps.openDbFilePath(path);
            }
            focusCurrentWindow();
          } catch (e) {
            console.error("[DBX] dbx-open-db-files error:", e);
          }
        }).then((unlisten) => unlistenHandles.push(unlisten));

        listen<string[]>("dbx-open-connection-links", async (event) => {
          try {
            for (const url of event.payload) {
              await deps.openConnectionDeepLink(url);
            }
            focusCurrentWindow();
          } catch (e) {
            console.error("[DBX] dbx-open-connection-links error:", e);
          }
        }).then((unlisten) => unlistenHandles.push(unlisten));
      })
      .catch(() => {});
  }

  function cleanupTauriListeners() {
    unlistenHandles.forEach((unlisten) => unlisten());
    unlistenHandles.length = 0;
  }

  return { setupTauriListeners, cleanupTauriListeners };
}

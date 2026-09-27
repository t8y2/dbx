import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { NavigationTarget } from "@/composables/useNavigationTargets";
import type { QueryResult } from "@/types/database";

export function useTauriEvents(deps: {
  openTableTarget: (target: NavigationTarget) => Promise<void>;
  openSqlFilePath: (path: string) => Promise<void>;
  openDbFilePath: (path: string) => Promise<void>;
  openConnectionDeepLink: (url: string) => Promise<void>;
  openAiConfigDeepLink: (url: string) => Promise<void>;
  openPluginInstallDeepLink: (url: string) => Promise<void>;
  closeActiveSurface: () => void;
  refreshPluginWorkbenches: (pluginId: string) => void;
}) {
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

  function setupTauriListeners(): Promise<void> {
    return import("@tauri-apps/api/event")
      .then(({ listen }) => {
        const registrations: Promise<void>[] = [];
        const track = (registration: Promise<() => void>) => {
          registrations.push(
            registration.then((unlisten) => {
              unlistenHandles.push(unlisten);
            }),
          );
        };

        track(
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
          }),
        );

        track(
          listen<{ connection_id: string }>("mcp-open-connection-workbench", async (event) => {
            try {
              const { connection_id } = event.payload;
              if (!connectionStore.connections.length) await connectionStore.initFromDisk();
              const config = connectionStore.getConfig(connection_id);
              if (!config) return;
              connectionStore.activeConnectionId = connection_id;
              // Dedup + tab switch happen inside the store; also ensures the
              // plugin workbench session (and its PTY) exists before returning.
              // Deliberately no window focus here: agent-terminal calls open
              // the tab so the command lands in a real terminal, but stealing
              // the OS focus interrupted whatever the user was doing.
              await queryStore.openPluginConnection(connection_id);
            } catch (e) {
              console.error("[DBX] mcp-open-connection-workbench error:", e);
            }
          }),
        );

        // Plugins report live transport state through plugin events; when an
        // SSH session dies, flip the sidebar entry offline so the tree stops
        // showing a connection that no longer exists.
        track(
          listen<{ method: string; params: { state?: string; connectionId?: string } }>("dbx-plugin-event", async (event) => {
            try {
              const payload = event.payload ?? ({} as typeof event.payload);
              if (payload.method !== "ssh/session/state" || payload.params?.state !== "disconnected") return;
              const connectionId = payload.params?.connectionId;
              if (!connectionId) return;
              if (!connectionStore.connections.length) await connectionStore.initFromDisk();
              if (!connectionStore.getConfig(connectionId)) return;
              connectionStore.markConnectionOffline(connectionId);
            } catch (e) {
              console.error("[DBX] dbx-plugin-event (ssh/session/state) error:", e);
            }
          }),
        );

        track(
          listen("mcp-reload-connections", async () => {
            try {
              await connectionStore.initFromDisk();
            } catch (e) {
              console.error("[DBX] mcp-reload-connections error:", e);
            }
          }),
        );

        track(
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
          }),
        );

        track(
          listen<string[]>("dbx-open-sql-files", async (event) => {
            try {
              for (const path of event.payload) {
                await deps.openSqlFilePath(path);
              }
              focusCurrentWindow();
            } catch (e) {
              console.error("[DBX] dbx-open-sql-files error:", e);
            }
          }),
        );

        track(
          listen<string[]>("dbx-open-db-files", async (event) => {
            try {
              for (const path of event.payload) {
                await deps.openDbFilePath(path);
              }
              focusCurrentWindow();
            } catch (e) {
              console.error("[DBX] dbx-open-db-files error:", e);
            }
          }),
        );

        track(
          listen<string[]>("dbx-open-connection-links", async (event) => {
            try {
              for (const url of event.payload) {
                await deps.openConnectionDeepLink(url);
              }
              focusCurrentWindow();
            } catch (e) {
              console.error("[DBX] dbx-open-connection-links error:", e);
            }
          }),
        );

        track(
          listen<string[]>("dbx-open-ai-config-links", async (event) => {
            try {
              for (const url of event.payload) {
                await deps.openAiConfigDeepLink(url);
              }
              focusCurrentWindow();
            } catch (e) {
              console.error("[DBX] dbx-open-ai-config-links error:", e);
            }
          }),
        );

        track(
          listen<string[]>("dbx-open-plugin-install-links", async (event) => {
            try {
              for (const url of event.payload) {
                await deps.openPluginInstallDeepLink(url);
              }
              focusCurrentWindow();
            } catch (e) {
              console.error("[DBX] dbx-open-plugin-install-links error:", e);
            }
          }),
        );

        track(
          listen("dbx-close-active-tab", () => {
            deps.closeActiveSurface();
          }),
        );

        // A plugin was installed/rolled back from its already-replaced runtime:
        // open workbench tabs still render the previous UI bundle until they
        // reload, so hand them the new identity to pick up.
        track(
          listen<{ pluginId: string; version: string }>("plugin-runtime-replaced", (event) => {
            if (event.payload?.pluginId) deps.refreshPluginWorkbenches(event.payload.pluginId);
          }),
        );

        return Promise.allSettled(registrations).then(() => {});
      })
      .catch(() => {});
  }

  function cleanupTauriListeners() {
    unlistenHandles.forEach((unlisten) => unlisten());
    unlistenHandles.length = 0;
  }

  return { setupTauriListeners, cleanupTauriListeners };
}

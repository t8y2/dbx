import { useI18n } from "vue-i18n";
import { uuid } from "@/lib/common/utils";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useProjectStore } from "@/stores/projectStore";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import type { ConnectionConfig, ExternalSqlFileVersion } from "@/types/database";
import type { SqlFileEncoding, SqlFileLineEnding } from "@/lib/backend/tauri";
import { detectDatabaseFileType } from "@/lib/database/databaseFileDetection";
import { externalSqlFileOpenErrorMessage, readBrowserSqlFile } from "@/lib/sql/sqlFileOpen";
import { resolveExternalSqlFileTarget, unassociatedExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";

function isSqlFilePath(path: string): boolean {
  return /\.sql$/i.test(path);
}

function getDataFileQuery(path: string): Promise<string | undefined> {
  return api.buildDroppedFilePreviewSql({ path });
}

export function useFileDrop() {
  const { t } = useI18n();
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const projectStore = useProjectStore();
  const { toast } = useToast();

  async function openDroppedSqlFile(name: string, content: string, path?: string, version?: ExternalSqlFileVersion, meta?: { projectId?: string; fileEncoding?: SqlFileEncoding; fileLineEnding?: SqlFileLineEnding }) {
    if (path) {
      const target = resolveExternalSqlFileTarget(path, (savedConnectionId) => !!connectionStore.getConfig(savedConnectionId), unassociatedExternalSqlFileTarget());
      queryStore.openExternalSqlFile(target.connectionId, target.database, path, content, version, { catalog: target.catalog, ...meta });
    } else {
      const connectionId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
      const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
      const database = connection?.database || "";
      const tabId = queryStore.createTab(connectionId, database, name, "query");
      queryStore.updateSql(tabId, content);
    }
    toast(t("welcome.fileOpened", { name }));
  }

  async function setupFileDrop() {
    if (isTauriRuntime()) {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const webview = getCurrentWebview();
      await webview.onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        const { stat } = await import("@tauri-apps/plugin-fs");
        const directoryPaths: string[] = [];
        for (const path of event.payload.paths) {
          const name = path.split("/").pop()?.split("\\").pop() || path;

          // 目录 → 作为 SQL 项目打开（多目录时第一个为激活项目）
          try {
            const info = await stat(path);
            if (info.isDirectory) {
              directoryPaths.push(path);
              continue;
            }
          } catch {
            // stat 失败时走原有文件处理流程
          }

          const dataQuery = await getDataFileQuery(path);
          if (dataQuery) {
            const config: ConnectionConfig = {
              id: uuid(),
              name: `[Preview] ${name}`,
              db_type: "duckdb",
              driver_profile: "duckdb",
              driver_label: "DuckDB",
              url_params: "",
              host: ":memory:",
              port: 0,
              username: "",
              password: "",
            };
            const connectionId = await api.connectDb(config);
            connectionStore.addEphemeralConnection({ ...config, id: connectionId });
            const tabId = queryStore.createTab(connectionId, "", name, "query");
            queryStore.updateSql(tabId, dataQuery);
            queryStore.executeCurrentTab();
            toast(t("welcome.fileOpened", { name }));
            continue;
          }

          if (isSqlFilePath(path)) {
            try {
              const snapshot = await api.readExternalSqlFileSnapshot(path);
              const projectId = projectStore.projectForFilePath(path)?.id ?? undefined;
              await openDroppedSqlFile(name, snapshot.content, path, snapshot.version, {
                projectId,
                fileEncoding: snapshot.encoding,
                fileLineEnding: snapshot.lineEnding,
              });
            } catch (e: any) {
              toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
            }
            continue;
          }

          const dbType = await detectDatabaseFileType(path);
          if (!dbType) continue;
          const config: ConnectionConfig = {
            id: uuid(),
            name,
            db_type: dbType,
            driver_profile: dbType,
            driver_label: dbType === "duckdb" ? "DuckDB" : "SQLite",
            url_params: "",
            host: path,
            port: 0,
            username: "",
            password: "",
          };
          try {
            await connectionStore.addConnection(config);
            void connectionStore.connect(config);
            toast(t("welcome.fileOpened", { name }));
          } catch (e: any) {
            toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
          }
        }

        if (directoryPaths.length > 0) {
          try {
            const opened = await projectStore.openProjects(directoryPaths);
            if (opened.length > 0) {
              window.dispatchEvent(new CustomEvent("dbx-show-sql-file-panel"));
              if (opened.length === 1) {
                toast(t("toolbar.sqlProjectOpened", { name: opened[0].name }));
              } else {
                toast(t("toolbar.sqlProjectsOpened", { name: opened[0].name, count: opened.length - 1 }));
              }
            }
          } catch (e: any) {
            toast(t("toolbar.sqlOpenFailed", { message: e?.message || String(e) }), 5000);
          }
        }
      });
    } else {
      document.addEventListener("drop", (event: DragEvent) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        event.preventDefault();
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!isSqlFilePath(file.name)) continue;
          void readBrowserSqlFile(file)
            .then((content) => openDroppedSqlFile(file.name, content))
            .catch((e: any) => {
              toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
            });
        }
      });
      document.addEventListener("dragover", (event: DragEvent) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return;
        for (let i = 0; i < files.length; i++) {
          if (isSqlFilePath(files[i].name)) {
            event.preventDefault();
            return;
          }
        }
      });
    }
  }

  return { setupFileDrop };
}

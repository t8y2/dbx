import { useI18n } from "vue-i18n";
import { useQueryStore } from "@/stores/queryStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { useLargeSqlFileStreamingFallback } from "@/composables/useLargeSqlFileFallback";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { activeTabExternalSqlFileTarget, resolveExternalSqlFileTarget } from "@/lib/sql/externalSqlFileTarget";
import { externalSqlFileOpenErrorMessage, externalSqlEditorMaxBytes, queryEditorOpenFileAccept, queryEditorOpenFileFilters, readBrowserSqlFile } from "@/lib/sql/sqlFileOpen";

export function useSqlFilePicker() {
  const { t } = useI18n();
  const queryStore = useQueryStore();
  const connectionStore = useConnectionStore();
  const settingsStore = useSettingsStore();
  const { toast } = useToast();
  const { openInStreamingExecutorOnTooLarge } = useLargeSqlFileStreamingFallback();

  async function openSqlFile() {
    // Capture the initiating query's context before the asynchronous picker:
    // another tab may become active while the user chooses or reads a file.
    const fallbackTarget = activeTabExternalSqlFileTarget(queryStore.tabs, queryStore.activeTabId, (connectionId) => connectionStore.getConfig(connectionId), { allowMongoScripts: true });
    const connection = connectionStore.getConfig(fallbackTarget.connectionId);
    const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection?.db_type;
    let openedSqlPath: string | undefined;
    try {
      if (isTauriRuntime()) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const path = await open({
          filters: queryEditorOpenFileFilters(databaseType),
          multiple: false,
        });
        if (typeof path === "string") {
          openedSqlPath = path;
          const snapshot = await api.readExternalSqlFileSnapshot(path, externalSqlEditorMaxBytes(settingsStore.editorSettings.externalSqlEditorMaxMb), "auto");
          const target = resolveExternalSqlFileTarget(path, (connectionId) => !!connectionStore.getConfig(connectionId), fallbackTarget);
          queryStore.openExternalSqlFile(target.connectionId, target.database, path, snapshot.content, snapshot.version, target.catalog, target.schema, undefined, snapshot.encoding);
        }
      } else {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = queryEditorOpenFileAccept(databaseType);
        input.onchange = async () => {
          const file = input.files?.[0];
          if (!file) return;
          try {
            const content = await readBrowserSqlFile(file, externalSqlEditorMaxBytes(settingsStore.editorSettings.externalSqlEditorMaxMb));
            // Browsers expose only a basename, which cannot identify a file.
            // Even two files named query.sql must get independent tabs.
            queryStore.createTab(fallbackTarget.connectionId, fallbackTarget.database, file.name, "query", fallbackTarget.schema, content, fallbackTarget.catalog, { forceNew: true });
          } catch (e: any) {
            toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
          }
        };
        input.click();
      }
    } catch (e: any) {
      if (!openInStreamingExecutorOnTooLarge(openedSqlPath, e)) {
        toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(e, (key, params) => t(key, params)) }), 5000);
      }
    }
  }

  return { openSqlFile };
}

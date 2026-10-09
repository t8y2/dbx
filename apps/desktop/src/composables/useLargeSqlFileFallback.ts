import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { resolveExternalSqlFileTargetForActiveTab } from "@/lib/sql/externalSqlFileTarget";
import { formatSqlFileSize, isExternalSqlFileTooLargeError, isSqlFilePath } from "@/lib/sql/sqlFileOpen";

/**
 * Editor-oversized external SQL files are not a dead end: route them to the
 * streaming Execute SQL File dialog, mirroring SqlFilePanel's fallback for
 * files the editor cannot load.
 */
export function useLargeSqlFileStreamingFallback() {
  const { t } = useI18n();
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();
  const { toast } = useToast();

  function openInStreamingExecutor(path: string, sizeBytes: number) {
    const target = resolveExternalSqlFileTargetForActiveTab(path, queryStore.tabs, queryStore.activeTabId, (connectionId) => connectionStore.getConfig(connectionId));
    connectionStore.sqlFileSource = {
      connectionId: target.connectionId,
      database: target.database,
      ...(target.schema ? { schema: target.schema } : {}),
      filePath: path,
    };
    toast(t("sqlFile.largeFileExecutionOpened", { size: formatSqlFileSize(sizeBytes) }), 6000);
  }

  function openInStreamingExecutorOnTooLarge(path: string | undefined, error: unknown): boolean {
    if (!path || !isExternalSqlFileTooLargeError(error) || !isSqlFilePath(path)) return false;
    openInStreamingExecutor(path, error.sizeBytes);
    return true;
  }

  return { openInStreamingExecutor, openInStreamingExecutorOnTooLarge };
}

import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { sqlFileFailureCopyText } from "@/components/export/failureDetailCopyText";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { SqlFileFailure } from "@/composables/useExportTracker";
import { useToast } from "@/composables/useToast";
import { promptExportSavePath } from "@/lib/export/exportPath";
import { FAILURE_LOG_TEXT_TOO_LARGE, failureLogListCoverage, failureLogRowKey, selectedFailureLogKeys, takeFailureLogSensitiveNotice } from "@/lib/export/failureLogExport";
import { sanitizeExportBaseName } from "@/lib/export/saveTextFile";
import { translateBackendError } from "@/i18n/backend-errors";

export type FailureLogExportFormat = "txt" | "csv";
export type FailureLogExportScope = "all" | "selected";

export interface UseSqlFileFailureLogOptions {
  executionId: () => string | undefined;
  /** Failures the UI keeps in memory (at most a few hundred). */
  failures: () => SqlFileFailure[];
  /** Failures the backend logged but the UI dropped; they are still exported. */
  omittedFailures: () => number;
  /** Used for the default export file name, e.g. the script or task name. */
  fileNameHint: () => string;
}

/**
 * Failure-log actions shared by the execution dialog and the background-task
 * popover (dbx#11619): selection over the visible failures, copy/export through
 * the backend log (which holds the complete statements), and honest degradation
 * when that log is missing or damaged.
 *
 * The surfaces render their own lists, so only the behaviour lives here.
 */
export function useSqlFileFailureLog(options: UseSqlFileFailureLogOptions) {
  const { t } = useI18n();
  const { toast } = useToast();

  const selectedKeys = ref<Set<string>>(new Set());
  const info = ref<api.SqlFileFailureLogInfo | null>(null);
  const busy = ref(false);

  const logUnavailable = computed(() => info.value?.status === "unavailable");
  const logDegraded = computed(() => info.value?.status === "degraded");
  const logWarning = computed(() => {
    if (info.value?.status === "unavailable") {
      return t("exportProgress.failureLog.unavailable", { reason: info.value.reason ?? "" });
    }
    if (info.value?.status === "degraded") {
      return t("exportProgress.failureLog.degraded", { reason: info.value.reason ?? "" });
    }
    return "";
  });

  const selectedCount = computed(() => options.failures().filter((failure) => selectedKeys.value.has(failureLogRowKey(failure))).length);
  const allSelected = computed(() => {
    const list = options.failures();
    return list.length > 0 && selectedCount.value >= list.length;
  });
  /** The list is capped while the log keeps everything, so the UI must say so. */
  const coverage = computed(() => failureLogListCoverage(options.failures().length + options.omittedFailures(), options.failures().length));

  function isSelected(failure: SqlFileFailure): boolean {
    return selectedKeys.value.has(failureLogRowKey(failure));
  }

  function toggleSelection(failure: SqlFileFailure): void {
    const next = new Set(selectedKeys.value);
    const key = failureLogRowKey(failure);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    selectedKeys.value = next;
  }

  function toggleAll(): void {
    selectedKeys.value = allSelected.value ? new Set() : new Set(options.failures().map(failureLogRowKey));
  }

  function clearSelection(): void {
    selectedKeys.value = new Set();
  }

  async function refreshInfo(): Promise<void> {
    const executionId = options.executionId();
    if (!executionId) {
      info.value = null;
      return;
    }
    try {
      info.value = await api.sqlFileFailureLogInfo(executionId);
    } catch {
      // An unreachable status must not block the UI: fall back to the in-memory
      // failure list, which the copy path already degrades to.
      info.value = null;
    }
  }

  // Refreshes are coalesced: a running execution reports failures per statement,
  // and one lookup in flight is enough for the UI to notice a log that degraded
  // mid-run (disk full) and disable the export controls.
  let refreshInFlight = false;

  function scheduleRefreshInfo(): void {
    if (refreshInFlight) return;
    refreshInFlight = true;
    void refreshInfo().finally(() => {
      refreshInFlight = false;
    });
  }

  watch(
    () => options.executionId(),
    () => {
      clearSelection();
      void refreshInfo();
    },
    { immediate: true },
  );

  // New failures mean the log is being written to, so its health may have changed.
  watch(
    () => options.failures().length,
    () => scheduleRefreshInfo(),
  );

  function selectedFailures(): SqlFileFailure[] {
    return options.failures().filter((failure) => selectedKeys.value.has(failureLogRowKey(failure)));
  }

  function formatLimit(limitBytes: number): string {
    return `${Math.max(1, Math.round(limitBytes / (1024 * 1024)))}MB`;
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  // Warn once per app run before the first copy/export: the derived text holds
  // complete SQL and raw database errors, which can carry sensitive values.
  function warnSensitiveLogOnce(): void {
    if (!takeFailureLogSensitiveNotice()) return;
    toast(t("exportProgress.failureLog.sensitiveWarning"), 8000);
  }

  async function copySelected(): Promise<void> {
    const executionId = options.executionId();
    const failures = selectedFailures();
    if (!executionId || failures.length === 0) return;
    await refreshInfo();
    warnSensitiveLogOnce();
    busy.value = true;
    try {
      if (logUnavailable.value) {
        // Degrade honestly: only summaries exist in memory, and the toast says so
        // instead of passing them off as the full log.
        const text = failures.map((failure) => sqlFileFailureCopyText(failure, translateBackendError(t, failure.error))).join("\n\n");
        await copyToClipboard(text);
        toast(t("exportProgress.failureLog.copySummaryFallback"), 5000);
        return;
      }
      const payload = await api.readSqlFileFailureLogText(executionId, "txt", selectedFailureLogKeys(options.failures(), selectedKeys.value));
      if (payload.tooLarge || payload.text === undefined) {
        toast(t("exportProgress.failureLog.copyTooLarge", { limit: formatLimit(payload.limitBytes) }), 5000);
        return;
      }
      await copyToClipboard(payload.text);
      toast(t("exportProgress.failureLog.copySelectedDone", { count: failures.length }), 2500);
    } catch (error) {
      toast(t("exportProgress.failureLog.actionFailed", { message: translateBackendError(t, errorMessage(error)) }), 5000);
    } finally {
      busy.value = false;
    }
  }

  async function exportLog(format: FailureLogExportFormat, scope: FailureLogExportScope): Promise<void> {
    const executionId = options.executionId();
    if (!executionId) return;
    const keys = scope === "selected" ? selectedFailureLogKeys(options.failures(), selectedKeys.value) : [];
    if (scope === "selected" && keys.length === 0) return;
    await refreshInfo();
    warnSensitiveLogOnce();
    busy.value = true;
    try {
      const baseName = sanitizeExportBaseName(options.fileNameHint()) || "sql-file";
      const defaultFileName = `${baseName}-failures.${format}`;
      if (isTauriRuntime()) {
        const targetPath = await promptExportSavePath({
          defaultFileName,
          filters: [{ name: format.toUpperCase(), extensions: [format] }],
        });
        if (!targetPath) return;
        const result = await api.exportSqlFileFailureLog(executionId, format, targetPath, keys.length > 0 ? keys : undefined);
        toast(t("exportProgress.failureLog.exportedRecords", { count: result.records }), 3000);
        return;
      }
      // Web: the whole log streams from the server as an attachment; a selected
      // subset comes back as capped text and is saved by the transport.
      const result = await api.exportSqlFileFailureLog(executionId, format, "", keys.length > 0 ? keys : undefined);
      toast(scope === "selected" ? t("exportProgress.failureLog.exportedRecords", { count: result.records }) : t("exportProgress.failureLog.exportStarted"), 3000);
    } catch (error) {
      const message = errorMessage(error);
      if (message === FAILURE_LOG_TEXT_TOO_LARGE) {
        toast(t("exportProgress.failureLog.exportSelectionTooLarge"), 5000);
        return;
      }
      toast(t("exportProgress.failureLog.actionFailed", { message: translateBackendError(t, message) }), 5000);
    } finally {
      busy.value = false;
    }
  }

  async function openLogFolder(): Promise<void> {
    await refreshInfo();
    const path = info.value?.path;
    if (!path) return;
    try {
      await api.revealPathInFileManager(path);
    } catch (error) {
      toast(t("exportProgress.failureLog.actionFailed", { message: errorMessage(error) }), 3000);
    }
  }

  return {
    selectedCount,
    allSelected,
    coverage,
    logUnavailable,
    logDegraded,
    logWarning,
    busy,
    info,
    isSelected,
    toggleSelection,
    toggleAll,
    clearSelection,
    refreshInfo,
    copySelected,
    exportLog,
    openLogFolder,
  };
}

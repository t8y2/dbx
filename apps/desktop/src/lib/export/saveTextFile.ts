import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { appendDebugLog, getBrowserMemorySnapshot, isDebugLoggingEnabled } from "@/lib/backend/debugLog";
import { autoRevealExportedPathIfConfigured, promptExportSavePath } from "./exportPath";

export async function saveTextFile(content: string, defaultFileName: string, filterName: string, filterExt: string, diagnostics: { exportId?: string; operation?: string; autoOpenFolder?: boolean } = {}): Promise<string | boolean> {
  const logSaveStage = (stage: string, details: Record<string, unknown> = {}) => {
    if (!isDebugLoggingEnabled()) return;
    appendDebugLog("info", `[DBX][export:save:${stage}]`, {
      ...diagnostics,
      filterName,
      filterExt,
      contentChars: content.length,
      ...details,
      browserMemory: getBrowserMemorySnapshot(),
    });
  };

  logSaveStage("start");
  if (isTauriRuntime()) {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await promptExportSavePath({
      defaultFileName,
      filters: [{ name: filterName, extensions: [filterExt] }],
    });
    logSaveStage("dialog-result", { selected: !!path });
    if (path) await writeTextFile(path, content);
    if (path) logSaveStage("write-done");
    if (path && diagnostics.autoOpenFolder) {
      void autoRevealExportedPathIfConfigured(path);
    }
    return path || false;
  }

  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = defaultFileName;
  a.click();
  URL.revokeObjectURL(url);
  logSaveStage("browser-download-triggered");
  return true;
}

export type QueryResultExportFileNameSource = "result-label" | "tab-title";
export const DEFAULT_QUERY_RESULT_EXPORT_FILE_NAME_SOURCE: QueryResultExportFileNameSource = "result-label";

export function normalizeQueryResultExportFileNameSource(value: unknown, fallback: QueryResultExportFileNameSource = DEFAULT_QUERY_RESULT_EXPORT_FILE_NAME_SOURCE): QueryResultExportFileNameSource {
  return value === "tab-title" || value === "result-label" ? value : fallback;
}

/**
 * Export file base name for a query result (#9894, #12092).
 *
 * When sourceMode is "result-label" (default):
 * The result tab is already named after the SQL's nearby comment (`-- name: x`
 * or a plain leading comment) or after the `schema.table` that produced it, so
 * an export of that result should reuse the same name instead of the generic
 * query tab title ("query 3", "查询 3"). Table data tabs keep passing their
 * table name, which is why the caller decides the fallback.
 *
 * When sourceMode is "tab-title":
 * The export file name prefers the query tab's title (e.g. the saved SQL file
 * name like `sales_report.sql`), falling back to the result label if the tab
 * title is not available.
 */
export function queryResultExportBaseName(resultLabel: string | undefined, tabTitle: string | undefined, sourceMode: QueryResultExportFileNameSource = DEFAULT_QUERY_RESULT_EXPORT_FILE_NAME_SOURCE): string | undefined {
  if (sourceMode === "tab-title") {
    return tabTitle?.trim() || resultLabel?.trim() || undefined;
  }
  return resultLabel?.trim() || tabTitle?.trim() || undefined;
}

export function sanitizeExportBaseName(value: string): string {
  return replaceControlCharacters(
    value
      .trim()
      .replace(/\.[sS][qQ][lL]$/, "")
      .replace(/[<>:"/\\|?*]/g, "_"),
    "_",
  )
    .replace(/\s+/g, " ")
    .replace(/[._\s-]+$/g, "")
    .slice(0, 120);
}

function replaceControlCharacters(value: string, replacement: string): string {
  return Array.from(value)
    .map((char) => (char.charCodeAt(0) < 32 ? replacement : char))
    .join("");
}

export function compactLocalTimestamp(date = new Date()): string {
  const yy = String(date.getFullYear() % 100).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return `${yy}${month}${day}${hour}${minute}${second}`;
}

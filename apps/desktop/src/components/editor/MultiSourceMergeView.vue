<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Download, RefreshCw, Undo2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useToast } from "@/composables/useToast";
import { translateBackendError } from "@/i18n/backend-errors";
import { formatSelectionAggregate } from "@/lib/dataGrid/gridSelection";
import { formatLocalTimestamp } from "@/lib/backend/debugLog";
import { buildXlsxSqlWorksheet } from "@/lib/export/xlsxSqlSheet";
import { MULTI_SOURCE_MAX_ROWS_PER_SOURCE, MULTI_SOURCE_MERGE_MAX_ROWS, mergeMultiSourceResults } from "@/lib/query/multiSourceResult";
import type { QueryResult } from "@/types/database";

/**
 * Quick inspection view for one multi-database execution. When the statement
 * returns result sets, every target's result is unioned by column name into one
 * table (first column names the row's source, all-numeric columns get a SUM
 * footer, rows can be exported as Excel). When it returns no result set — an
 * UPDATE/DELETE/DDL batch — the view lists one row per target with its affected
 * row count, status and error, and a failed target can be re-run on its own.
 */
const props = withDefaults(
  defineProps<{
    items: Array<{
      key: string;
      label: string;
      result?: QueryResult;
      status?: "pending" | "running" | "pending_commit" | "rolled_back" | "success" | "failed" | "skipped" | "cancelled" | "not_executed";
      durationMs?: number;
      errorMessage?: string;
      /** Present while this target still owns an unsettled transaction session. */
      transaction?: { canCommit: boolean; settling?: boolean };
    }>;
    /** Hidden when the host dialog renders its own export button group. */
    showExportActions?: boolean;
    /** Set while the owning batch is still running, so re-running is blocked. */
    rerunDisabled?: boolean;
    /** True when the batch ran inside per-target transactions. */
    transactional?: boolean;
    /** Statement the batch executed, shown in the header and written into the export. */
    sql?: string;
    /** How long the batch took, shown in the header and written into the export. */
    durationMs?: number;
    /** When the batch started (epoch ms), shown in the header and exported. */
    executedAt?: number;
  }>(),
  { showExportActions: true },
);

const emit = defineEmits<{
  rerunTarget: [key: string];
  commitTarget: [key: string];
  rollbackTarget: [key: string];
  commitAll: [];
  rollbackAll: [];
}>();

const { t } = useI18n();
const { toast } = useToast();

/** Rendering cap; the merged statistics always cover every merged row. */
const RENDERED_ROW_LIMIT = 1000;

const merged = computed(() =>
  mergeMultiSourceResults(
    props.items.map((item) => ({ key: item.key, label: item.label, result: item.result })),
    { sourceColumnLabel: t("multiDbExecute.mergedSourceColumn") },
  ),
);
/** False for write statements: no target returned columns to union. */
const hasTabularResults = computed(() => merged.value.sources.length > 0);
const summaryByColumnIndex = computed(() => new Map(merged.value.summaries.map((summary) => [summary.columnIndex, summary])));
const renderedRows = computed(() => merged.value.rows.slice(0, RENDERED_ROW_LIMIT));
const hiddenRowCount = computed(() => Math.max(0, merged.value.rows.length - renderedRows.value.length));

/** Sources whose row count reached the per-source fetch cap, so more may exist. */
const cappedSourceCount = computed(() => merged.value.sources.filter((source) => source.rowCount >= MULTI_SOURCE_MAX_ROWS_PER_SOURCE).length);
const perSourceCap = MULTI_SOURCE_MAX_ROWS_PER_SOURCE;
const mergeCap = MULTI_SOURCE_MERGE_MAX_ROWS;

function statusLabel(status: (typeof props.items)[number]["status"]): string {
  switch (status) {
    case "running":
      return t("multiDbExecute.running");
    case "success":
      return t("multiDbExecute.success");
    case "pending_commit":
      return t("multiDbExecute.pendingCommit");
    case "rolled_back":
      return t("toolbar.rollback");
    case "failed":
      return t("multiDbExecute.failed");
    case "skipped":
      return t("multiDbExecute.skipped");
    case "cancelled":
      return t("multiDbExecute.cancelled");
    case "not_executed":
      return t("multiDbExecute.notExecuted");
    default:
      return t("multiDbExecute.pending");
  }
}

function statusClass(status: (typeof props.items)[number]["status"]): string {
  if (status === "success") return "text-emerald-600 dark:text-emerald-300";
  if (status === "pending_commit") return "text-amber-600 dark:text-amber-300";
  if (status === "failed") return "text-destructive";
  if (status === "running") return "text-primary";
  if (status === "skipped" || status === "cancelled" || status === "not_executed" || status === "rolled_back") return "text-amber-600 dark:text-amber-300";
  return "text-muted-foreground";
}

/** A statement that ran, whether or not its transaction is still open. */
function hasWrittenRows(item: (typeof props.items)[number]): boolean {
  return item.status === "success" || item.status === "pending_commit";
}

/** Affected rows are only meaningful for a statement that actually ran. The
 *  column already names them, so the cell carries the bare count. */
function affectedRowsText(item: (typeof props.items)[number]): string {
  if (!hasWrittenRows(item)) return "—";
  return String(item.result?.affected_rows ?? 0);
}

/** Rows the batch wrote in total, summarized in the header for write statements. */
const totalAffectedRows = computed(() => props.items.reduce((sum, item) => sum + (hasWrittenRows(item) ? (item.result?.affected_rows ?? 0) : 0), 0));

function canRerun(item: (typeof props.items)[number]): boolean {
  // A target that still owns a session has to be settled before it is re-run.
  if (item.transaction) return false;
  return item.status !== undefined && !hasWrittenRows(item) && item.status !== "running" && item.status !== "pending";
}

/** Targets whose changes are still pending in their own transaction. */
const openTransactionCount = computed(() => props.items.filter((item) => item.transaction !== undefined).length);
/** Committing skips the targets that errored: they have nothing to write. */
const committableCount = computed(() => props.items.filter((item) => item.transaction?.canCommit === true).length);

function isTransactionOpen(item: (typeof props.items)[number]): boolean {
  return props.transactional === true && item.transaction !== undefined;
}

function txnStateLabel(item: (typeof props.items)[number]): string {
  if (item.transaction) return t("multiDbExecute.txnOpen");
  if (item.status === "rolled_back") return t("multiDbExecute.txnRolledBack");
  if (hasWrittenRows(item)) return t("multiDbExecute.txnCommitted");
  return "—";
}

function durationText(durationMs: number | undefined): string {
  if (durationMs === undefined) return "";
  return durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)} s` : `${Math.round(durationMs)} ms`;
}

/** Local execution timestamp, sharing the app's timezone-explicit format. */
function timestampText(executedAt: number | undefined): string {
  if (executedAt === undefined) return "";
  return formatLocalTimestamp(new Date(executedAt)).replace("T", " ").replace(/\.\d+/, "");
}

/** Rows of the write-statement export: one line per target, no result set. */
function writeStatementExport(): { columns: string[]; rows: (string | number)[][] } {
  const columns = [t("multiDbExecute.mergedSourceColumn"), t("multiDbExecute.statusColumn")];
  if (props.transactional) columns.push(t("multiDbExecute.txnColumn"));
  columns.push(t("multiDbExecute.affectedRowsColumn"), t("multiDbExecute.durationColumn"), t("multiDbExecute.errorColumn"));
  const rows = props.items.map((item) => {
    const row: (string | number)[] = [item.label, statusLabel(item.status)];
    if (props.transactional) row.push(txnStateLabel(item));
    row.push(hasWrittenRows(item) ? (item.result?.affected_rows ?? 0) : "", durationText(item.durationMs), item.errorMessage ?? "");
    return row;
  });
  return { columns, rows };
}

function cellText(value: string | number | boolean | null): string {
  return value === null ? "" : String(value);
}

function summaryCellText(columnIndex: number): string {
  const summary = summaryByColumnIndex.value.get(columnIndex);
  return summary ? formatSelectionAggregate(summary.sum) : "";
}

function summaryCellTitle(columnIndex: number): string | undefined {
  const summary = summaryByColumnIndex.value.get(columnIndex);
  return summary ? t("multiDbExecute.mergedSummaryCellHint", { count: summary.count }) : undefined;
}

function exportFileName(scope: "page" | "all"): string {
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return ["dbx-merged-result", scope === "page" ? "page" : "all", timestamp].join("_") + ".xlsx";
}

/** SQL + timing worksheet: mirrors the grid export's "include SQL sheet" pattern. */
function buildSqlWorksheet() {
  const entries: Array<{ resultName: string; sql: string }> = [];
  const executedAt = timestampText(props.executedAt);
  if (executedAt) entries.push({ resultName: t("multiDbExecute.executedAtColumn"), sql: executedAt });
  const duration = durationText(props.durationMs);
  if (duration) entries.push({ resultName: t("multiDbExecute.durationColumn"), sql: duration });
  if (props.sql?.trim()) entries.push({ resultName: "SQL", sql: props.sql });
  return buildXlsxSqlWorksheet(entries);
}

/**
 * Writes one Excel workbook for the merged view.
 *
 * A statement with a result set exports the merged table (`page` = the rows on
 * screen, `all` = every merged row). A write statement without a result set
 * exports the per-target list instead —?status, transaction state, affected
 * rows, elapsed time and error. Both get a second "SQL" sheet carrying the
 * executed statement and the batch duration.
 *
 * The web build assembles the workbook in the browser and downloads it, the
 * desktop build asks for a path and writes it through the backend.
 */
async function exportMergedRows(scope: "page" | "all"): Promise<void> {
  const tabular = hasTabularResults.value;
  const rows = scope === "page" ? renderedRows.value : merged.value.rows;
  if (tabular && rows.length === 0) {
    toast(t("multiDbExecute.mergedEmpty"), 3000);
    return;
  }
  if (!tabular && props.items.length === 0) {
    toast(t("multiDbExecute.mergedEmpty"), 3000);
    return;
  }
  try {
    let outputPath = exportFileName(scope);
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({ defaultPath: outputPath, filters: [{ name: "Excel", extensions: ["xlsx"] }] });
      if (!path) return;
      outputPath = String(path);
    }
    const writeExport = tabular ? undefined : writeStatementExport();
    const dataSheet = {
      sheetName: t("multiDbExecute.mergedSheetName"),
      columns: tabular ? [...merged.value.columns] : (writeExport?.columns ?? []),
      columnTypes: (tabular ? merged.value.columns : (writeExport?.columns ?? [])).map(() => ""),
      rows: tabular ? rows : (writeExport?.rows ?? []),
      numericColumnRightAlign: true,
      autoFilter: true,
    };
    const sqlWorksheet = buildSqlWorksheet();
    if (sqlWorksheet) {
      await api.exportQueryResultsXlsx(outputPath, [dataSheet, sqlWorksheet], true);
    } else {
      await api.exportQueryResultXlsx(outputPath, dataSheet.sheetName, dataSheet.columns, dataSheet.columnTypes, undefined, dataSheet.rows, true, true);
    }
    const exportedRows = tabular ? rows.length : props.items.length;
    toast(cappedSourceCount.value > 0 && tabular ? t("multiDbExecute.exportedRowsCapped", { rows: exportedRows, count: cappedSourceCount.value, limit: perSourceCap }) : t("multiDbExecute.exportedRows", { rows: exportedRows }), 4000);
  } catch (error) {
    toast(t("grid.exportFailed", { message: translateBackendError(t, error) }), 5000);
  }
}

defineExpose({ exportMergedRows });
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col" data-multi-source-merge-view>
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-5 py-2 text-xs text-muted-foreground">
      <!-- A write batch has no rows to merge: report what it touched instead of
           the merged-source statistics, which would all read zero. -->
      <span v-if="hasTabularResults">{{ t("multiDbExecute.mergedSources", { count: merged.sources.length, rows: merged.rowCount }) }}</span>
      <span v-if="hasTabularResults">{{ t("multiDbExecute.mergedSourceRowCap", { count: perSourceCap }) }}</span>
      <span v-else data-merge-write-summary>{{ t("multiDbExecute.mergedWriteSummary", { targets: items.length, rows: totalAffectedRows }) }}</span>
      <span v-if="hasTabularResults && cappedSourceCount > 0" class="font-medium text-amber-600 dark:text-amber-300" data-merge-source-cap-reached>
        {{ t("multiDbExecute.mergedSourceCapReached", { count: cappedSourceCount, limit: perSourceCap }) }}
      </span>
      <span v-if="hasTabularResults && merged.truncated" class="font-medium text-amber-600 dark:text-amber-300" data-merge-truncated>
        {{ t("multiDbExecute.mergedTruncated", { count: mergeCap }) }}
      </span>
      <span v-if="hasTabularResults && hiddenRowCount > 0">{{ t("multiDbExecute.mergedRowLimit", { count: renderedRows.length, rows: merged.rowCount }) }}</span>
      <span v-if="executedAt !== undefined" class="tabular-nums" data-merge-executed-at>{{ t("multiDbExecute.executedAtChip", { time: timestampText(executedAt) }) }}</span>
      <span v-if="durationMs !== undefined" class="tabular-nums" data-merge-duration>{{ t("multiDbExecute.elapsedColumn", { duration: durationText(durationMs) }) }}</span>
      <span v-if="sql" class="min-w-0 max-w-[420px] truncate font-mono" :title="sql" data-merge-sql>{{ sql }}</span>
      <span v-if="transactional && openTransactionCount > 0" class="font-medium text-amber-600 dark:text-amber-300" data-merge-txn-open>
        {{ t("multiDbExecute.txnOpenHint", { count: openTransactionCount }) }}
      </span>
      <span v-if="showExportActions || transactional" class="ml-auto flex shrink-0 items-center gap-1">
        <template v-if="transactional">
          <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" data-merge-commit-all :disabled="committableCount === 0 || rerunDisabled" @click="emit('commitAll')">
            <Check class="h-3.5 w-3.5" />
            {{ t("multiDbExecute.commitAllTargets", { count: committableCount }) }}
          </Button>
          <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" data-merge-rollback-all :disabled="openTransactionCount === 0 || rerunDisabled" @click="emit('rollbackAll')">
            <Undo2 class="h-3.5 w-3.5" />
            {{ t("multiDbExecute.rollbackAllTargets", { count: openTransactionCount }) }}
          </Button>
        </template>
        <template v-if="showExportActions">
          <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" data-merge-export-page @click="exportMergedRows('page')">
            <Download class="h-3.5 w-3.5" />
            {{ t("multiDbExecute.exportCurrentPage") }}
          </Button>
          <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" data-merge-export-all @click="exportMergedRows('all')">
            <Download class="h-3.5 w-3.5" />
            {{ t("multiDbExecute.exportAllRows") }}
          </Button>
        </template>
      </span>
    </div>

    <div class="min-h-0 flex-1 overflow-auto">
      <!-- Write statements (UPDATE / DELETE / DDL) return no result set: report
           one row per target instead of an empty merged table. -->
      <table v-if="!hasTabularResults" class="w-full border-collapse text-xs" data-merge-target-results>
        <thead class="sticky top-0 z-10 bg-muted text-left">
          <tr>
            <th class="border-r border-b px-2 py-1 font-medium whitespace-nowrap">{{ t("multiDbExecute.mergedSourceColumn") }}</th>
            <th class="border-r border-b px-2 py-1 font-medium whitespace-nowrap">{{ t("multiDbExecute.statusColumn") }}</th>
            <th v-if="transactional" class="border-r border-b px-2 py-1 font-medium whitespace-nowrap">{{ t("multiDbExecute.txnColumn") }}</th>
            <th class="border-r border-b px-2 py-1 font-medium whitespace-nowrap">{{ t("multiDbExecute.affectedRowsColumn") }}</th>
            <th class="border-r border-b px-2 py-1 font-medium whitespace-nowrap">{{ t("multiDbExecute.durationColumn") }}</th>
            <th class="border-r border-b px-2 py-1 font-medium whitespace-nowrap">{{ t("multiDbExecute.errorColumn") }}</th>
            <th class="border-b px-2 py-1" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.key" class="border-b align-top hover:bg-muted/40">
            <td class="max-w-[280px] truncate border-r px-2 py-1 whitespace-nowrap" :title="item.label">{{ item.label }}</td>
            <td class="border-r px-2 py-1 whitespace-nowrap" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</td>
            <td v-if="transactional" class="border-r px-2 py-1 whitespace-nowrap" :class="{ 'text-amber-600 dark:text-amber-300': item.transaction !== undefined }" data-merge-txn-state>
              {{ txnStateLabel(item) }}
            </td>
            <td class="border-r px-2 py-1 text-right tabular-nums whitespace-nowrap">{{ affectedRowsText(item) }}</td>
            <td class="border-r px-2 py-1 text-right tabular-nums whitespace-nowrap">{{ durationText(item.durationMs) }}</td>
            <td class="max-w-[360px] border-r px-2 py-1 text-destructive">
              <span class="line-clamp-3 break-words whitespace-pre-wrap">{{ item.errorMessage ?? "" }}</span>
            </td>
            <td class="px-2 py-1 text-right whitespace-nowrap">
              <template v-if="isTransactionOpen(item) && item.transaction">
                <Button variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" data-merge-commit :disabled="rerunDisabled || item.transaction.settling === true || !item.transaction.canCommit" @click="emit('commitTarget', item.key)">
                  <Check class="h-3.5 w-3.5" />
                  {{ t("toolbar.commit") }}
                </Button>
                <Button variant="outline" size="sm" class="ml-1 h-6 gap-1 px-2 text-xs" data-merge-rollback :disabled="rerunDisabled || item.transaction.settling === true" @click="emit('rollbackTarget', item.key)">
                  <Undo2 class="h-3.5 w-3.5" />
                  {{ t("toolbar.rollback") }}
                </Button>
              </template>
              <Button v-else-if="canRerun(item)" variant="outline" size="sm" class="h-6 gap-1 px-2 text-xs" data-merge-rerun :disabled="rerunDisabled" @click="emit('rerunTarget', item.key)">
                <RefreshCw class="h-3.5 w-3.5" />
                {{ t("multiDbExecute.rerunTarget") }}
              </Button>
            </td>
          </tr>
          <tr v-if="items.length === 0">
            <td :colspan="transactional ? 7 : 6" class="px-2 py-6 text-center text-muted-foreground">{{ t("multiDbExecute.mergedEmpty") }}</td>
          </tr>
        </tbody>
      </table>

      <table v-else class="w-full border-collapse text-xs">
        <thead class="sticky top-0 z-10 bg-muted text-left">
          <tr>
            <th v-for="(column, columnIndex) in merged.columns" :key="`head-${columnIndex}`" class="border-r border-b px-2 py-1 font-medium whitespace-nowrap">{{ column }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in renderedRows" :key="`row-${rowIndex}`" class="border-b hover:bg-muted/40">
            <td v-for="(cell, columnIndex) in row" :key="`cell-${rowIndex}-${columnIndex}`" class="max-w-[320px] truncate border-r px-2 py-1 whitespace-nowrap" :class="{ 'text-muted-foreground': cell === null }" :title="cellText(cell)">
              {{ cellText(cell) }}
            </td>
          </tr>
          <tr v-if="renderedRows.length === 0">
            <td :colspan="merged.columns.length" class="px-2 py-6 text-center text-muted-foreground">{{ t("multiDbExecute.mergedEmpty") }}</td>
          </tr>
        </tbody>
        <tfoot v-if="merged.summaries.length > 0" class="sticky bottom-0 z-10 bg-muted">
          <tr>
            <td class="border-r border-t px-2 py-1 text-center font-medium text-muted-foreground">{{ t("multiDbExecute.mergedSummaryLabel") }}</td>
            <td v-for="columnIndex in merged.columns.length - 1" :key="`sum-${columnIndex}`" class="border-r border-t px-2 py-1 text-right tabular-nums" :title="summaryCellTitle(columnIndex)">
              {{ summaryCellText(columnIndex) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>
</template>

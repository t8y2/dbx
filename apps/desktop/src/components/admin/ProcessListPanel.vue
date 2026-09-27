<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, Ban, Copy, Loader2, PlugZap, RefreshCcw, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { clampInterval, createProcessListLoadCoordinator, DEFAULT_REFRESH_SECONDS, processListExecutionError, processListSessionCount } from "@/lib/database/mysqlProcessList";
import { resolveProcessListDriverForConnection, type ProcessRow } from "@/lib/database/processListDrivers";
import { processListSelectionAfterClick } from "@/lib/database/processListSelection";
import { useTabUiState } from "@/lib/tabs/tabUiState";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { toast } = useToast();
const { initialState: restoredUiState, track: trackUiState } = useTabUiState<{
  search?: string;
  sortKey?: string;
  sortDir?: "asc" | "desc";
  autoRefresh?: boolean;
  intervalSeconds?: number;
}>({}, "ProcessListPanel");

// The panel is only opened for supported engines; guard the driver defensively so
// a missing one degrades to an empty table rather than crashing the render.
const driver = computed(() => resolveProcessListDriverForConnection(props.connection));
const columns = computed(() => driver.value?.columns ?? []);
const numericKeys = computed(() => new Set(columns.value.filter((column) => column.numeric).map((column) => column.key)));

const rows = ref<ProcessRow[]>([]);
const truncated = ref(false);
const ownSessionId = ref<number | null>(null);
const loading = ref(false);
const loadCoordinator = createProcessListLoadCoordinator();
const loadError = ref("");
const search = ref(restoredUiState.search ?? "");
const restoredSortKey = columns.value.some((column) => column.key === restoredUiState.sortKey) ? restoredUiState.sortKey : undefined;
const sortKey = ref<string>(restoredSortKey ?? driver.value?.defaultSortKey ?? "time");
const sortDir = ref<"asc" | "desc">(restoredUiState.sortDir === "asc" ? "asc" : "desc");

const autoRefresh = ref(restoredUiState.autoRefresh ?? false);
const intervalSeconds = ref(clampInterval(restoredUiState.intervalSeconds ?? DEFAULT_REFRESH_SECONDS));
let timer: ReturnType<typeof setInterval> | undefined;

const cancelTarget = ref<ProcessRow | null>(null);
const canceling = ref(false);
const terminateTarget = ref<ProcessRow | null>(null);
const terminating = ref(false);
const batchSupported = computed(() => driver.value?.supportsBatchCancel === true);
// Engines without a terminate statement only expose query cancellation.
const terminateSupported = computed(() => typeof driver.value?.buildTerminateSessionSql === "function");
// Multi-selection serves batch cancel and/or batch terminate; either enables the checkboxes.
const selectionSupported = computed(() => batchSupported.value || terminateSupported.value);
const selectedIds = ref(new Set<number>());
// Anchor row for Shift+click range selection, in the current display order.
const selectionAnchorId = ref<number | null>(null);
const batchTargets = ref<ProcessRow[] | null>(null);
const batchTerminateTargets = ref<ProcessRow[] | null>(null);
const batchResult = ref<{ kind: "cancel" | "terminate"; succeeded: number; failures: { id: number; message: string }[] } | null>(null);
const refreshing = ref(false);
const actionsLocked = computed(() => canceling.value || cancelTarget.value !== null || terminating.value || terminateTarget.value !== null || batchTargets.value !== null || batchTerminateTargets.value !== null);
let connectionGeneration = 0;
let disposed = false;
const fallbackListSql = ref<string | null>(null);

// Full-text preview for long cells (SQL statement / info), opened by clicking them.
const previewText = ref<string | null>(null);

trackUiState(() => ({ search: search.value, sortKey: sortKey.value, sortDir: sortDir.value, autoRefresh: autoRefresh.value, intervalSeconds: intervalSeconds.value }));

function openPreview(value: string | number | null) {
  if (value === null || value === undefined || String(value).length === 0) return;
  previewText.value = String(value);
}

async function copyPreview() {
  if (previewText.value === null) return;
  try {
    await navigator.clipboard.writeText(previewText.value);
    toast(t("processList.copied"), 1500);
  } catch (error: any) {
    toast(error?.message || String(error), 3000);
  }
}

const filteredRows = computed(() => {
  const query = search.value.trim().toLowerCase();
  const base = query ? rows.value.filter((row) => Object.values(row).some((value) => value !== null && value !== undefined && String(value).toLowerCase().includes(query))) : rows.value.slice();
  const key = sortKey.value;
  const dir = sortDir.value === "asc" ? 1 : -1;
  return base.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
});

const selectableRows = computed(() => (ownSessionId.value === null ? [] : filteredRows.value.filter((row) => !isOwnSession(row) && Number.isInteger(row.id) && row.id > 0)));
const allSelected = computed(() => selectableRows.value.length > 0 && selectableRows.value.every((row) => selectedIds.value.has(row.id)));
const partiallySelected = computed(() => selectedIds.value.size > 0 && !allSelected.value);

watch(
  selectableRows,
  (visible) => {
    const available = new Set(visible.map((row) => row.id));
    selectedIds.value = new Set([...selectedIds.value].filter((id) => available.has(id)));
    if (selectionAnchorId.value !== null && !available.has(selectionAnchorId.value)) selectionAnchorId.value = null;
  },
  { flush: "sync" },
);

function clearSelection() {
  selectedIds.value = new Set();
  selectionAnchorId.value = null;
}

/** Row checkbox click: a plain click toggles one row, Shift+click extends from the anchor. */
function toggleSelection(id: number, event: MouseEvent) {
  if (actionsLocked.value || refreshing.value) return;
  // The browser toggles the clicked checkbox before this handler runs, so the
  // next state comes from the selection; both agree because the click is never
  // cancelled (cancelling it would leave the DOM checkbox out of sync).
  const next = processListSelectionAfterClick(selectableRows.value, { selected: selectedIds.value, anchorId: selectionAnchorId.value }, id, event);
  selectedIds.value = next.selected;
  selectionAnchorId.value = next.anchorId;
}

function toggleAll(checked: boolean) {
  if (actionsLocked.value || refreshing.value) return;
  selectedIds.value = new Set(checked ? selectableRows.value.map((row) => row.id) : []);
  selectionAnchorId.value = null;
}

function requestBatchCancel() {
  if (!batchSupported.value || actionsLocked.value || refreshing.value || ownSessionId.value === null) return;
  const targets = selectableRows.value.filter((row) => selectedIds.value.has(row.id));
  if (targets.length) batchTargets.value = targets.map((row) => ({ ...row }));
}

async function confirmBatchCancel() {
  const targets = batchTargets.value;
  const activeDriver = driver.value;
  if (!targets?.length || !activeDriver?.supportsBatchCancel || ownSessionId.value === null || canceling.value) return;
  const connection = { ...props.connection };
  const generation = connectionGeneration;
  const isCurrent = () => !disposed && generation === connectionGeneration;
  canceling.value = true;
  let executed = false;
  try {
    const statements = targets.map((row) => ({ id: row.id, sql: activeDriver.buildCancelQuerySql(row.id) }));
    const result = await executeWithProductionSqlGuard({
      connection,
      database: "",
      sql: statements.map((statement) => statement.sql).join(";\n"),
      source: t("production.sourceAdmin"),
      execute: async () => {
        const summary = { kind: "cancel" as const, succeeded: 0, failures: [] as { id: number; message: string }[] };
        for (const statement of statements) {
          // A closed tab or changed connection must not dispatch remaining work.
          if (!isCurrent()) break;
          executed = true;
          try {
            const results = await api.executeMulti(connection.id, "", statement.sql, undefined, undefined, { maxRows: 1 });
            const error = processListExecutionError(results) || activeDriver.cancelQueryResultError?.(results);
            if (error) throw new Error(error);
            summary.succeeded++;
          } catch (error: unknown) {
            summary.failures.push({ id: statement.id, message: error instanceof Error ? error.message : String(error) });
          }
        }
        return summary;
      },
    });
    if (result === undefined || !isCurrent()) return;
    batchResult.value = result;
    batchTargets.value = null;
    clearSelection();
  } catch (error: unknown) {
    if (isCurrent()) toast(t("processList.killFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  } finally {
    canceling.value = false;
    if (!disposed && (executed || !isCurrent())) void load({ silent: true });
  }
}

function requestBatchTerminate() {
  if (!terminateSupported.value || actionsLocked.value || refreshing.value || ownSessionId.value === null) return;
  const targets = selectableRows.value.filter((row) => selectedIds.value.has(row.id));
  if (targets.length) batchTerminateTargets.value = targets.map((row) => ({ ...row }));
}

/**
 * Close the selected sessions one by one. Each statement runs on its own so a
 * failure on one session (permissions, an id that already exited) is reported in
 * the summary instead of aborting the remaining terminations, mirroring batch
 * cancel. The `terminating` mutex is shared with the single-row terminate action.
 */
async function confirmBatchTerminate() {
  const targets = batchTerminateTargets.value;
  const activeDriver = driver.value;
  const buildTerminateSql = activeDriver?.buildTerminateSessionSql;
  if (!targets?.length || !activeDriver || !buildTerminateSql || terminating.value) return;
  const connection = { ...props.connection };
  const generation = connectionGeneration;
  const isCurrent = () => !disposed && generation === connectionGeneration;
  terminating.value = true;
  let executed = false;
  try {
    const statements = targets.map((row) => ({ id: row.id, sql: buildTerminateSql.call(activeDriver, row.id) }));
    const executeTerminateSql = async (sql: string) => {
      const results = await api.executeMulti(connection.id, "", sql, undefined, undefined, { maxRows: 1 });
      const executionError = processListExecutionError(results);
      if (executionError) throw new Error(executionError);
      return results;
    };
    const result = await executeWithProductionSqlGuard({
      connection,
      database: "",
      sql: statements.map((statement) => statement.sql).join(";\n"),
      source: t("production.sourceAdmin"),
      execute: async () => {
        const summary = { kind: "terminate" as const, succeeded: 0, failures: [] as { id: number; message: string }[] };
        for (const statement of statements) {
          // A closed tab or changed connection must not dispatch remaining work.
          if (!isCurrent()) break;
          executed = true;
          try {
            let usedFallbackTerminateSql = false;
            let results;
            try {
              results = await executeTerminateSql(statement.sql);
            } catch (error) {
              if (!activeDriver.buildFallbackTerminateSessionSql || !activeDriver.shouldUseFallbackTerminateSessionSql?.(error)) throw error;
              usedFallbackTerminateSql = true;
              results = await executeTerminateSql(activeDriver.buildFallbackTerminateSessionSql(statement.id));
            }
            const terminateResultError = usedFallbackTerminateSql ? activeDriver.fallbackTerminateSessionResultError?.(results) : activeDriver.terminateSessionResultError?.(results);
            if (terminateResultError) throw new Error(terminateResultError);
            summary.succeeded++;
          } catch (error: unknown) {
            summary.failures.push({ id: statement.id, message: error instanceof Error ? error.message : String(error) });
          }
        }
        return summary;
      },
    });
    if (result === undefined || !isCurrent()) return;
    batchResult.value = result;
    batchTerminateTargets.value = null;
    clearSelection();
  } catch (error: unknown) {
    if (isCurrent()) toast(t("processList.terminateFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  } finally {
    terminating.value = false;
    if (!disposed && (executed || !isCurrent())) void load({ silent: true });
  }
}

function toggleSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDir.value = numericKeys.value.has(key) ? "desc" : "asc";
  }
}

async function load(options: { silent?: boolean } = {}) {
  const activeDriver = driver.value;
  if (!activeDriver || disposed || actionsLocked.value) return;
  if (!loadCoordinator.tryStart()) return;
  const connectionId = props.connection.id;
  const generation = connectionGeneration;
  const isCurrent = () => !disposed && generation === connectionGeneration;
  refreshing.value = true;
  if (!options.silent) loading.value = true;
  loadError.value = "";
  try {
    await connectionStore.ensureConnected(connectionId);
    if (!isCurrent()) return;
    if (ownSessionId.value === null) {
      try {
        let idResult;
        try {
          idResult = await api.executeQuery(connectionId, "", activeDriver.ownSessionSql, undefined, undefined, { maxRows: 1 });
        } catch (error) {
          if (!activeDriver.fallbackOwnSessionSql || !activeDriver.shouldUseFallbackOwnSessionSql?.(error)) throw error;
          idResult = await api.executeQuery(connectionId, "", activeDriver.fallbackOwnSessionSql, undefined, undefined, { maxRows: 1 });
        }
        const raw = idResult?.rows?.[0]?.[0];
        const parsed = Number(raw);
        if (isCurrent() && Number.isInteger(parsed) && parsed > 0) ownSessionId.value = parsed;
      } catch {
        // Non-fatal: without our own id we simply cannot dim the self row.
      }
    }
    if (!isCurrent()) return;
    const listSql = fallbackListSql.value ?? activeDriver.listSql;
    let result;
    try {
      result = await api.executeQuery(connectionId, "", listSql, undefined, undefined, { maxRows: activeDriver.maxRows });
    } catch (error) {
      if (fallbackListSql.value || !activeDriver.fallbackListSql || !activeDriver.shouldUseFallbackListSql?.(error)) throw error;
      result = await api.executeQuery(connectionId, "", activeDriver.fallbackListSql, undefined, undefined, { maxRows: activeDriver.maxRows });
      // Cache the compatible query so old servers do not fail once per refresh.
      if (isCurrent()) fallbackListSql.value = activeDriver.fallbackListSql;
    }
    if (!isCurrent()) return;
    rows.value = activeDriver.mapRows(result);
    truncated.value = result.truncated === true;
  } catch (error: any) {
    if (isCurrent()) loadError.value = error?.message || String(error);
  } finally {
    loading.value = false;
    refreshing.value = false;
    loadCoordinator.finish();
    if (!disposed && !isCurrent()) void load();
  }
}

function isOwnSession(row: ProcessRow): boolean {
  return ownSessionId.value !== null && row.id === ownSessionId.value;
}

function requestCancel(row: ProcessRow) {
  if (isOwnSession(row) || actionsLocked.value || refreshing.value) return;
  cancelTarget.value = row;
}

async function confirmCancel() {
  const target = cancelTarget.value;
  const activeDriver = driver.value;
  if (!target || !activeDriver || canceling.value) return;
  const connection = { ...props.connection };
  const generation = connectionGeneration;
  const isCurrent = () => !disposed && generation === connectionGeneration;
  canceling.value = true;
  try {
    const cancelSql = activeDriver.buildCancelQuerySql(target.id);
    let usedFallbackCancelSql = false;
    const executeCancelSql = async (sql: string) => {
      if (!isCurrent()) return undefined;
      const results = await api.executeMulti(connection.id, "", sql, undefined, undefined, { maxRows: 1 });
      const executionError = processListExecutionError(results);
      if (executionError) throw new Error(executionError);
      return results;
    };
    const result = await executeWithProductionSqlGuard({
      connection,
      database: "",
      sql: cancelSql,
      source: t("production.sourceAdmin"),
      execute: async () => {
        try {
          return await executeCancelSql(cancelSql);
        } catch (error) {
          if (!activeDriver.buildFallbackCancelQuerySql || !activeDriver.shouldUseFallbackCancelQuerySql?.(error)) throw error;
          usedFallbackCancelSql = true;
          return executeCancelSql(activeDriver.buildFallbackCancelQuerySql(target.id));
        }
      },
    });
    if (result === undefined || !isCurrent()) return;
    const cancelResultError = usedFallbackCancelSql ? activeDriver.fallbackCancelQueryResultError?.(result) : activeDriver.cancelQueryResultError?.(result);
    if (cancelResultError) throw new Error(cancelResultError);
    toast(t("processList.killSuccess", { id: target.id }), 2500);
    cancelTarget.value = null;
  } catch (error: any) {
    if (isCurrent()) toast(t("processList.killFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    canceling.value = false;
    if (cancelTarget.value === null) void load({ silent: true });
  }
}

function requestTerminate(row: ProcessRow) {
  if (isOwnSession(row) || actionsLocked.value || refreshing.value || !terminateSupported.value) return;
  terminateTarget.value = row;
}

/**
 * Close the session itself. `KILL QUERY` / `pg_cancel_backend` leave an idle session
 * connected, so an idle row could never be removed from the list before this action.
 */
async function confirmTerminate() {
  const target = terminateTarget.value;
  const activeDriver = driver.value;
  const buildTerminateSql = activeDriver?.buildTerminateSessionSql;
  if (!target || !activeDriver || !buildTerminateSql || terminating.value) return;
  const connection = { ...props.connection };
  const generation = connectionGeneration;
  const isCurrent = () => !disposed && generation === connectionGeneration;
  terminating.value = true;
  try {
    const terminateSql = buildTerminateSql.call(activeDriver, target.id);
    let usedFallbackTerminateSql = false;
    const executeTerminateSql = async (sql: string) => {
      if (!isCurrent()) return undefined;
      const results = await api.executeMulti(connection.id, "", sql, undefined, undefined, { maxRows: 1 });
      const executionError = processListExecutionError(results);
      if (executionError) throw new Error(executionError);
      return results;
    };
    const result = await executeWithProductionSqlGuard({
      connection,
      database: "",
      sql: terminateSql,
      source: t("production.sourceAdmin"),
      execute: async () => {
        try {
          return await executeTerminateSql(terminateSql);
        } catch (error) {
          if (!activeDriver.buildFallbackTerminateSessionSql || !activeDriver.shouldUseFallbackTerminateSessionSql?.(error)) throw error;
          usedFallbackTerminateSql = true;
          return executeTerminateSql(activeDriver.buildFallbackTerminateSessionSql(target.id));
        }
      },
    });
    if (result === undefined || !isCurrent()) return;
    const terminateResultError = usedFallbackTerminateSql ? activeDriver.fallbackTerminateSessionResultError?.(result) : activeDriver.terminateSessionResultError?.(result);
    if (terminateResultError) throw new Error(terminateResultError);
    toast(t("processList.terminateSuccess", { id: target.id }), 2500);
    terminateTarget.value = null;
  } catch (error: any) {
    if (isCurrent()) toast(t("processList.terminateFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    terminating.value = false;
    if (terminateTarget.value === null) void load({ silent: true });
  }
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function restartTimer() {
  stopTimer();
  if (!autoRefresh.value) return;
  const seconds = clampInterval(intervalSeconds.value);
  timer = setInterval(() => {
    // Skip polling while the window is hidden to avoid needless server load.
    if (document.hidden) return;
    void load({ silent: true });
  }, seconds * 1000);
}

function onIntervalInput() {
  intervalSeconds.value = clampInterval(Number(intervalSeconds.value));
  if (autoRefresh.value) restartTimer();
}

watch(autoRefresh, restartTimer);

watch(intervalSeconds, () => {
  if (autoRefresh.value) restartTimer();
});

watch(
  () => props.connection.id,
  () => {
    connectionGeneration++;
    clearSelection();
    batchTargets.value = null;
    batchTerminateTargets.value = null;
    batchResult.value = null;
    cancelTarget.value = null;
    fallbackListSql.value = null;
    rows.value = [];
    truncated.value = false;
    ownSessionId.value = null;
    search.value = "";
    sortKey.value = driver.value?.defaultSortKey ?? "time";
    sortDir.value = "desc";
    void load();
  },
);

onMounted(() => void load());
onBeforeUnmount(() => {
  disposed = true;
  connectionGeneration++;
  stopTimer();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-1">
      <div class="flex min-w-0 items-center gap-2">
        <Activity class="h-4 w-4 text-primary" />
        <div class="truncate text-sm font-semibold">{{ t("processList.title") }}</div>
        <Badge variant="outline" class="h-5 rounded-md px-1.5 text-[11px]">{{ connection.name }}</Badge>
        <Badge variant="secondary" class="h-5 rounded-md px-1.5 text-[11px]">{{ t("processList.sessionCount", { count: processListSessionCount(truncated ? rows.length : filteredRows.length, truncated) }) }}</Badge>
      </div>
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <Button
          v-if="batchSupported"
          variant="destructive"
          size="sm"
          class="h-7 gap-1.5 px-2 text-xs"
          :disabled="actionsLocked || refreshing || selectedIds.size === 0 || ownSessionId === null"
          :title="ownSessionId === null ? t('processList.batchNeedsSession') : undefined"
          @click="requestBatchCancel"
        >
          <Loader2 v-if="canceling && batchTargets" class="h-3.5 w-3.5 animate-spin" />
          <Ban v-else class="h-3.5 w-3.5" />
          {{ t("processList.batchCancel", { count: selectedIds.size }) }}
        </Button>
        <Button
          v-if="terminateSupported"
          variant="destructive"
          size="sm"
          class="h-7 gap-1.5 px-2 text-xs"
          :disabled="actionsLocked || refreshing || selectedIds.size === 0 || ownSessionId === null"
          :title="ownSessionId === null ? t('processList.batchNeedsSession') : undefined"
          @click="requestBatchTerminate"
        >
          <Loader2 v-if="terminating && batchTerminateTargets" class="h-3.5 w-3.5 animate-spin" />
          <PlugZap v-else class="h-3.5 w-3.5" />
          {{ t("processList.batchTerminate", { count: selectedIds.size }) }}
        </Button>
        <div class="flex h-7 items-center gap-1.5 rounded-md border bg-background px-2">
          <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input v-model="search" :disabled="actionsLocked" class="h-full w-40 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('processList.filter')" />
        </div>
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input v-model="autoRefresh" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
          {{ t("processList.autoRefresh") }}
        </label>
        <div class="flex h-7 items-center gap-1 rounded-md border bg-background px-1.5">
          <Input v-model.number="intervalSeconds" type="number" min="1" max="3600" class="h-6 w-14 border-0 px-1 text-xs shadow-none focus-visible:ring-0" @change="onIntervalInput" />
          <span class="pr-1 text-[11px] text-muted-foreground">{{ t("processList.seconds") }}</span>
        </div>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="refreshing || actionsLocked" @click="load()">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          {{ t("grid.refresh") }}
        </Button>
      </div>
    </div>

    <div v-if="selectionSupported && ownSessionId === null && !refreshing" class="border-b px-3 py-2 text-xs text-muted-foreground">{{ t("processList.batchNeedsSession") }}</div>

    <div v-if="loadError" class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ loadError }}</div>

    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full border-collapse text-xs">
        <thead class="sticky top-0 z-10 bg-muted/40 backdrop-blur">
          <tr>
            <th v-if="selectionSupported" class="w-8 border-b px-3 py-2">
              <input
                type="checkbox"
                class="h-3.5 w-3.5 accent-primary"
                :checked="allSelected"
                :indeterminate="partiallySelected"
                :disabled="actionsLocked || refreshing || selectableRows.length === 0"
                :aria-label="t('processList.selectAll')"
                :title="t('processList.selectAll')"
                @change="toggleAll(($event.target as HTMLInputElement).checked)"
              />
            </th>
            <th v-for="column in columns" :key="column.key" class="cursor-pointer select-none whitespace-nowrap border-b px-3 py-2 text-left font-medium hover:bg-accent" @click="toggleSort(column.key)">
              <span class="inline-flex items-center gap-1">
                {{ t(column.labelKey) }}
                <ArrowUp v-if="sortKey === column.key && sortDir === 'asc'" class="h-3 w-3" />
                <ArrowDown v-else-if="sortKey === column.key && sortDir === 'desc'" class="h-3 w-3" />
              </span>
            </th>
            <th class="w-40 whitespace-nowrap border-b px-3 py-2 text-right font-medium">{{ t("processList.colActions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredRows" :key="row.id" class="border-b hover:bg-accent/40" :class="{ 'bg-primary/5': isOwnSession(row) }">
            <td v-if="selectionSupported" class="px-3 py-1.5">
              <input
                type="checkbox"
                class="h-3.5 w-3.5 accent-primary"
                :checked="selectedIds.has(row.id)"
                :disabled="actionsLocked || refreshing || ownSessionId === null || isOwnSession(row) || !Number.isInteger(row.id) || row.id <= 0"
                :aria-label="t('processList.selectSession', { id: row.id })"
                @click="toggleSelection(row.id, $event as MouseEvent)"
              />
            </td>
            <td
              v-for="column in columns"
              :key="column.key"
              class="px-3 py-1.5"
              :class="[column.mono ? 'font-mono' : '', column.wide ? 'max-w-md cursor-pointer truncate hover:text-foreground hover:underline' : 'whitespace-nowrap', column.wide || column.key === 'db' || column.key === 'state' || column.key === 'wait' ? 'text-muted-foreground' : '']"
              :title="column.wide ? (row[column.key] === null || row[column.key] === undefined ? '' : t('processList.previewTitle')) : undefined"
              @click="column.wide ? openPreview(row[column.key]) : undefined"
            >
              <template v-if="column.key === 'id'">
                {{ row.id }}
                <Badge v-if="isOwnSession(row)" variant="outline" class="ml-1 h-4 rounded px-1 text-[10px]">{{ t("processList.self") }}</Badge>
              </template>
              <template v-else>{{ row[column.key] === null || row[column.key] === undefined ? "—" : row[column.key] }}</template>
            </td>
            <td class="px-3 py-1.5 text-right">
              <span class="inline-flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-6 gap-1 px-1.5 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  :disabled="isOwnSession(row) || actionsLocked || refreshing"
                  :title="isOwnSession(row) ? t('processList.cannotKillSelf') : t('processList.kill')"
                  @click="requestCancel(row)"
                >
                  <Ban class="h-3.5 w-3.5" />
                  {{ t("processList.kill") }}
                </Button>
                <Button
                  v-if="terminateSupported"
                  variant="ghost"
                  size="sm"
                  class="h-6 gap-1 px-1.5 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                  :disabled="isOwnSession(row) || actionsLocked || refreshing"
                  :title="isOwnSession(row) ? t('processList.cannotTerminateSelf') : t('processList.terminate')"
                  @click="requestTerminate(row)"
                >
                  <PlugZap class="h-3.5 w-3.5" />
                  {{ t("processList.terminate") }}
                </Button>
              </span>
            </td>
          </tr>
          <tr v-if="!loading && filteredRows.length === 0">
            <td :colspan="columns.length + 1 + (selectionSupported ? 1 : 0)" class="px-3 py-10 text-center text-muted-foreground">
              {{ search ? t("grid.noSearchResults") : t("processList.empty") }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Dialog
      :open="cancelTarget !== null"
      @update:open="
        (open) => {
          if (!open && !canceling) cancelTarget = null;
        }
      "
    >
      <DialogContent class="max-w-sm" :show-close-button="!canceling">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle class="h-4 w-4 text-destructive" />
            {{ t("processList.killTitle") }}
          </DialogTitle>
        </DialogHeader>
        <p v-if="cancelTarget" class="text-sm text-muted-foreground">
          {{ t("processList.killConfirm", { id: cancelTarget.id, user: cancelTarget.user }) }}
        </p>
        <DialogFooter>
          <Button variant="outline" :disabled="canceling" @click="cancelTarget = null">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" :disabled="canceling" @click="confirmCancel">
            <Loader2 v-if="canceling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("processList.kill") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="terminateTarget !== null"
      @update:open="
        (open) => {
          if (!open && !terminating) terminateTarget = null;
        }
      "
    >
      <DialogContent class="max-w-sm" :show-close-button="!terminating">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle class="h-4 w-4 text-destructive" />
            {{ t("processList.terminateTitle") }}
          </DialogTitle>
        </DialogHeader>
        <p v-if="terminateTarget" class="text-sm text-muted-foreground">
          {{ t("processList.terminateConfirm", { id: terminateTarget.id, user: terminateTarget.user }) }}
        </p>
        <DialogFooter>
          <Button variant="outline" :disabled="terminating" @click="terminateTarget = null">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" :disabled="terminating" @click="confirmTerminate">
            <Loader2 v-if="terminating" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("processList.terminate") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="batchTargets !== null"
      @update:open="
        (open) => {
          if (!open && !canceling) batchTargets = null;
        }
      "
    >
      <DialogContent
        class="max-w-md"
        :show-close-button="!canceling"
        @interact-outside="
          (event) => {
            if (canceling) event.preventDefault();
          }
        "
        @escape-key-down="
          (event) => {
            if (canceling) event.preventDefault();
          }
        "
      >
        <DialogHeader>
          <DialogTitle>{{ t("processList.batchTitle") }}</DialogTitle>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">{{ t("processList.batchConfirm", { count: batchTargets?.length ?? 0 }) }}</p>
        <p class="max-h-40 overflow-auto break-words font-mono text-xs">{{ batchTargets?.map((row) => row.id).join(", ") }}</p>
        <DialogFooter>
          <Button variant="outline" :disabled="canceling" @click="batchTargets = null">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" :disabled="canceling" @click="confirmBatchCancel">
            <Loader2 v-if="canceling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t(canceling ? "processList.batchRunning" : "processList.kill") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="batchTerminateTargets !== null"
      @update:open="
        (open) => {
          if (!open && !terminating) batchTerminateTargets = null;
        }
      "
    >
      <DialogContent
        class="max-w-md"
        :show-close-button="!terminating"
        @interact-outside="
          (event) => {
            if (terminating) event.preventDefault();
          }
        "
        @escape-key-down="
          (event) => {
            if (terminating) event.preventDefault();
          }
        "
      >
        <DialogHeader>
          <DialogTitle>{{ t("processList.batchTerminateTitle") }}</DialogTitle>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">{{ t("processList.batchTerminateConfirm", { count: batchTerminateTargets?.length ?? 0 }) }}</p>
        <p class="max-h-40 overflow-auto break-words font-mono text-xs">{{ batchTerminateTargets?.map((row) => row.id).join(", ") }}</p>
        <DialogFooter>
          <Button variant="outline" :disabled="terminating" @click="batchTerminateTargets = null">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" :disabled="terminating" @click="confirmBatchTerminate">
            <Loader2 v-if="terminating" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t(terminating ? "processList.batchTerminateRunning" : "processList.terminate") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="batchResult !== null"
      @update:open="
        (open) => {
          if (!open) batchResult = null;
        }
      "
    >
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ t(batchResult?.kind === "terminate" ? "processList.batchTerminateTitle" : "processList.batchTitle") }}</DialogTitle>
        </DialogHeader>
        <p v-if="batchResult" class="text-sm">{{ t(batchResult.kind === "terminate" ? "processList.batchTerminateSummary" : "processList.batchSummary", { succeeded: batchResult.succeeded, failed: batchResult.failures.length }) }}</p>
        <ul v-if="batchResult?.failures.length" class="max-h-60 space-y-2 overflow-auto text-xs text-destructive">
          <li v-for="failure in batchResult.failures" :key="failure.id" class="break-words">{{ failure.id }}: {{ failure.message }}</li>
        </ul>
        <DialogFooter>
          <Button variant="secondary" @click="batchResult = null">{{ t("common.close") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="previewText !== null"
      @update:open="
        (open) => {
          if (!open) previewText = null;
        }
      "
    >
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ t("processList.previewTitle") }}</DialogTitle>
        </DialogHeader>
        <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs">{{ previewText }}</pre>
        <DialogFooter>
          <Button variant="outline" class="gap-1.5" @click="copyPreview">
            <Copy class="h-3.5 w-3.5" />
            {{ t("processList.copy") }}
          </Button>
          <Button variant="secondary" @click="previewText = null">{{ t("dangerDialog.cancel") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

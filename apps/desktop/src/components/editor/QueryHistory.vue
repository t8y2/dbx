<script setup lang="ts">
import { ref, computed, nextTick, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { CalendarClock, Copy, Database, RotateCcw, Search, Sparkles, Trash2, X } from "@lucide/vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { useHistoryStore } from "@/stores/historyStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { resolveHistoryActivityKind } from "@/lib/history/historyActivityKind";
import { canRollbackHistoryEntry } from "@/lib/history/historyAiAnalysis";
import { hasHistoryDateRange, historyDateRangeIsValid, historyEntryMatchesDateRange, type HistoryDateRange } from "@/lib/history/historyTimeRange";
import { HISTORY_ROW_HEIGHT, HISTORY_SCROLL_BUFFER, shouldVirtualizeHistory } from "@/lib/history/historyVirtualList";
import type { HistoryEntry } from "@/lib/backend/api";
import { copyToClipboard } from "@/lib/common/clipboard";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import * as api from "@/lib/backend/api";

const { t } = useI18n();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const store = useHistoryStore();
const connectionStore = useConnectionStore();

const emit = defineEmits<{
  restore: [sql: string, entry: HistoryEntry];
  analyzeAi: [entry: HistoryEntry];
  close: [];
}>();

type HistoryFilter = "all" | "query" | "data_change" | "schema_change" | "failed";

const searchText = ref("");
const activeFilter = ref<HistoryFilter>("all");
const dateRange = ref<HistoryDateRange>({ startDate: "", endDate: "" });
const dateRangeDraft = ref<HistoryDateRange>({ startDate: "", endDate: "" });
const dateRangeOpen = ref(false);
const startDateInputRef = ref<HTMLInputElement | null>(null);
const endDateInputRef = ref<HTMLInputElement | null>(null);
const selectedEntry = ref<HistoryEntry | null>(null);
const isRollingBack = ref(false);
const showDeleteConfirm = ref(false);
const showClearConfirm = ref(false);
const deleteTargetId = ref<string | null>(null);
const filterScrollRef = ref<HTMLElement | null>(null);
const filtersScrollable = ref(false);
let filterScrollResizeObserver: ResizeObserver | null = null;

const filters: HistoryFilter[] = ["all", "query", "data_change", "schema_change", "failed"];
const hasDateFilter = computed(() => hasHistoryDateRange(dateRange.value));
const dateRangeDraftValid = computed(() => historyDateRangeIsValid(dateRangeDraft.value));
const dateRangeSummary = computed(() => {
  if (!hasDateFilter.value) return "";
  const start = dateRange.value.startDate || t("history.dateRange.unboundedStart");
  const end = dateRange.value.endDate || t("history.dateRange.unboundedEnd");
  return `${start} -> ${end}`;
});

const filtered = computed(() => {
  const q = searchText.value.toLowerCase();
  return store.entries.filter((entry) => {
    if (activeFilter.value === "failed" && entry.success) return false;
    if (activeFilter.value !== "all" && activeFilter.value !== "failed" && activityKind(entry) !== activeFilter.value) {
      return false;
    }
    if (!historyEntryMatchesDateRange(entry.executed_at, dateRange.value)) return false;
    if (!q) return true;
    return [entry.sql, entry.connection_name, entry.database, entry.operation, entry.target].filter(Boolean).some((value) => String(value).toLowerCase().includes(q));
  });
});
const emptyMessage = computed(() => (store.entries.length > 0 ? t("history.emptyFilteredRecent") : t("history.empty")));

function activityKind(entry: HistoryEntry) {
  return resolveHistoryActivityKind(entry);
}

function restore(entry: HistoryEntry) {
  emit("restore", entry.sql, entry);
  selectedEntry.value = null;
}

async function copyText(text: string) {
  try {
    await copyToClipboard(text);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function confirmDeleteEntry(id: string) {
  deleteTargetId.value = id;
  showDeleteConfirm.value = true;
}

function executeDelete() {
  if (deleteTargetId.value) {
    store.remove(deleteTargetId.value);
    deleteTargetId.value = null;
  }
  showDeleteConfirm.value = false;
}

function confirmClearHistory() {
  if (store.entries.length > 0) {
    showClearConfirm.value = true;
  }
}

function executeClear() {
  store.clear();
  showClearConfirm.value = false;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatFullTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function truncateSql(sql: string): string {
  const line = sql.replace(/\s+/g, " ").trim();
  return line.length > 120 ? line.slice(0, 120) + "..." : line;
}

function entryTitle(entry: HistoryEntry) {
  return entry.target || entry.operation || truncateSql(entry.sql);
}

function entrySubtitle(entry: HistoryEntry) {
  if (activityKind(entry) === "query") return truncateSql(entry.sql);
  return truncateSql(entry.sql || entry.target || entry.operation || "");
}

function filterLabel(filter: HistoryFilter) {
  return t(`history.filters.${filter}`);
}

function updateFilterScrollability() {
  const el = filterScrollRef.value;
  if (!el) return;
  const scrollable = el.scrollWidth > el.clientWidth + 3;
  filtersScrollable.value = scrollable;
  if (!scrollable && el.scrollLeft !== 0) {
    el.scrollLeft = 0;
  }
}

function openDateRangeFilter() {
  dateRangeDraft.value = { ...dateRange.value };
}

function setDateRangeOpen(value: boolean) {
  if (value) openDateRangeFilter();
  dateRangeOpen.value = value;
}

function applyDateRangeFilter() {
  if (!dateRangeDraftValid.value) return;
  dateRange.value = { ...dateRangeDraft.value };
  dateRangeOpen.value = false;
}

function clearDateRangeFilter() {
  dateRange.value = { startDate: "", endDate: "" };
  dateRangeDraft.value = { startDate: "", endDate: "" };
}

function cancelDateRangeFilter() {
  dateRangeDraft.value = { ...dateRange.value };
  dateRangeOpen.value = false;
}

function dateFieldLabel(value: string) {
  return value ? value.replaceAll("-", "/") : "yyyy/mm/dd";
}

function openDatePicker(input: HTMLInputElement | null) {
  if (!input) return;
  input.focus();
  const pickerInput = input as HTMLInputElement & { showPicker?: () => void };
  if (pickerInput.showPicker) {
    pickerInput.showPicker();
  } else {
    input.click();
  }
}

function kindLabel(entry: HistoryEntry) {
  return t(`history.kinds.${activityKind(entry)}`);
}

function kindShortLabel(entry: HistoryEntry) {
  return t(`history.kindShort.${activityKind(entry)}`);
}

function detailsRows(entry: HistoryEntry) {
  const rows = [
    [t("history.detail.kind"), kindLabel(entry)],
    [t("history.detail.operation"), entry.operation || "-"],
    [t("history.detail.connection"), entry.connection_name || "-"],
    [t("history.detail.database"), entry.database || "-"],
    [t("history.detail.target"), entry.target || "-"],
    [t("history.detail.time"), formatFullTime(entry.executed_at)],
    [t("history.detail.duration"), `${entry.execution_time_ms}ms`],
    [t("history.detail.affectedRows"), entry.affected_rows ?? "-"],
    [t("history.detail.rollback"), canRollbackHistoryEntry(entry) ? t("history.rollbackAvailable") : t("history.rollbackUnavailable")],
    [t("history.detail.status"), entry.success ? t("history.success") : t("history.failed")],
  ];
  if (entry.error) rows.push([t("history.detail.error"), entry.error]);
  return rows;
}

async function rollback(entry: HistoryEntry) {
  if (!canRollbackHistoryEntry(entry) || isRollingBack.value) return;
  if (!window.confirm(t("history.rollbackConfirm"))) return;

  const connectionId = entry.connection_id!;
  const rollbackSql = entry.rollback_sql!;
  isRollingBack.value = true;
  const start = Date.now();
  try {
    const result = await executeWithProductionSqlGuard({
      connection: connectionStore.getConfig(connectionId),
      database: entry.database,
      sql: rollbackSql,
      source: t("production.sourceQueryHistory"),
      execute: () => api.executeScript(connectionId, entry.database, rollbackSql),
    });
    if (!result) return;
    await store.add({
      connection_id: connectionId,
      connection_name: entry.connection_name,
      database: entry.database,
      sql: rollbackSql,
      execution_time_ms: Date.now() - start,
      success: true,
      activity_kind: "data_change",
      operation: "ROLLBACK",
      target: entry.target,
      affected_rows: result.affected_rows,
      details_json: JSON.stringify({ rollback_of: entry.id }),
    });
    toast(t("history.rollbackSuccess"));
    selectedEntry.value = null;
  } catch (e: any) {
    toast(t("history.rollbackFailed", { message: e?.message || String(e) }), 5000);
  } finally {
    isRollingBack.value = false;
  }
}

function getHistoryMenuItems(entry: HistoryEntry): ContextMenuItem[] {
  return [
    {
      label: t("history.viewDetails"),
      action: () => {
        selectedEntry.value = entry;
      },
    },
    { label: t("history.restore"), action: () => restore(entry) },
    { label: t("history.analyzeWithAi"), action: () => emit("analyzeAi", entry), icon: Sparkles },
    { label: t("history.copy"), action: () => copyText(entry.sql) },
    ...(canRollbackHistoryEntry(entry) ? [{ label: t("history.rollback"), action: () => rollback(entry) }] : []),
    { label: t("history.delete"), action: () => confirmDeleteEntry(entry.id), variant: "destructive" as const },
  ];
}

watch(
  () => filters.map((filter) => filterLabel(filter)).join("\0"),
  () => {
    void nextTick(updateFilterScrollability);
  },
);

onMounted(() => {
  store.load();
  void nextTick(updateFilterScrollability);

  if (filterScrollRef.value) {
    filterScrollResizeObserver = new ResizeObserver(updateFilterScrollability);
    filterScrollResizeObserver.observe(filterScrollRef.value);
  }
});

onBeforeUnmount(() => {
  filterScrollResizeObserver?.disconnect();
  filterScrollResizeObserver = null;
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden border-l">
    <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0 bg-muted/20">
      <span class="text-xs font-medium">{{ t("history.title") }}</span>
      <span class="flex-1" />
      <Button v-if="store.entries.length > 0" variant="ghost" size="icon" class="h-5 w-5" @click="confirmClearHistory">
        <Trash2 class="h-3 w-3" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('close')">
        <X class="h-3 w-3" />
      </Button>
    </div>

    <div class="border-b shrink-0">
      <div ref="filterScrollRef" class="history-filter-scroll flex gap-1 px-2 pt-2" :class="{ 'history-filter-scroll--scrollable': filtersScrollable }">
        <button v-for="filter in filters" :key="filter" type="button" class="h-6 shrink-0 rounded border px-2 text-xs" :class="activeFilter === filter ? 'border-primary bg-primary text-primary-foreground' : 'bg-background'" @click="activeFilter = filter">
          {{ filterLabel(filter) }}
        </button>
      </div>
      <div class="relative flex items-center px-2 py-1">
        <Search class="absolute left-3 w-3 h-3 text-muted-foreground pointer-events-none" />
        <input v-model="searchText" autocapitalize="off" autocorrect="off" spellcheck="false" class="flex-1 h-5 text-xs bg-transparent border rounded pl-5 pr-1 outline-none placeholder:text-muted-foreground" :placeholder="t('history.search')" />
        <Popover :open="dateRangeOpen" @update:open="setDateRangeOpen">
          <PopoverTrigger as-child>
            <button
              type="button"
              class="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors"
              :class="hasDateFilter ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/15' : 'border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground'"
              :title="t('history.dateRange.title')"
            >
              <CalendarClock class="h-3 w-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" class="w-auto max-w-[calc(100vw-24px)] gap-3 p-3" @click.stop @keydown.stop>
            <div class="flex items-center justify-between gap-3">
              <div class="text-xs font-medium text-foreground">{{ t("history.dateRange.title") }}</div>
            </div>
            <div class="flex flex-wrap items-end gap-2">
              <label class="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
                <span>{{ t("history.dateRange.start") }}</span>
                <input ref="startDateInputRef" v-model="dateRangeDraft.startDate" type="date" class="sr-only" tabindex="-1" aria-hidden="true" />
                <button type="button" class="flex h-8 w-28 min-w-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-xs text-foreground outline-none hover:bg-muted/50 focus:border-ring focus:ring-2 focus:ring-ring/30" @click="openDatePicker(startDateInputRef)">
                  <span class="min-w-0 flex-1 truncate tabular-nums" :class="{ 'text-muted-foreground': !dateRangeDraft.startDate }">
                    {{ dateFieldLabel(dateRangeDraft.startDate) }}
                  </span>
                  <CalendarClock class="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              </label>
              <span class="pb-2 text-xs text-muted-foreground">-></span>
              <label class="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
                <span>{{ t("history.dateRange.end") }}</span>
                <input ref="endDateInputRef" v-model="dateRangeDraft.endDate" type="date" class="sr-only" tabindex="-1" aria-hidden="true" />
                <button type="button" class="flex h-8 w-28 min-w-0 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-left text-xs text-foreground outline-none hover:bg-muted/50 focus:border-ring focus:ring-2 focus:ring-ring/30" @click="openDatePicker(endDateInputRef)">
                  <span class="min-w-0 flex-1 truncate tabular-nums" :class="{ 'text-muted-foreground': !dateRangeDraft.endDate }">
                    {{ dateFieldLabel(dateRangeDraft.endDate) }}
                  </span>
                  <CalendarClock class="h-3 w-3 shrink-0 text-muted-foreground" />
                </button>
              </label>
            </div>
            <div v-if="!dateRangeDraftValid" class="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
              {{ t("history.dateRange.invalid") }}
            </div>
            <div class="flex items-center justify-between gap-2 pt-1">
              <Button variant="ghost" size="sm" class="h-8 px-2 text-xs" @click="clearDateRangeFilter">
                {{ t("history.dateRange.clear") }}
              </Button>
              <div class="flex items-center gap-2">
                <Button variant="outline" size="sm" class="h-8 px-2 text-xs" @click="cancelDateRangeFilter">
                  {{ t("dangerDialog.cancel") }}
                </Button>
                <Button size="sm" class="h-8 px-3 text-xs" :disabled="!dateRangeDraftValid" @click="applyDateRangeFilter">
                  {{ t("history.dateRange.apply") }}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div v-if="hasDateFilter" class="flex items-center gap-1 px-2 pb-2">
        <button type="button" class="flex min-w-0 items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/15" :title="t('history.dateRange.title')" @click="setDateRangeOpen(true)">
          <CalendarClock class="h-3 w-3 shrink-0" />
          <span class="shrink-0">{{ t("history.dateRange.label") }}</span>
          <span class="min-w-0 truncate tabular-nums">{{ dateRangeSummary }}</span>
        </button>
        <button type="button" class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground" :title="t('history.dateRange.clear')" @click="clearDateRangeFilter">
          <X class="h-3 w-3" />
        </button>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <RecycleScroller v-if="shouldVirtualizeHistory(filtered.length)" class="h-full" :items="filtered" :item-size="HISTORY_ROW_HEIGHT" :buffer="HISTORY_SCROLL_BUFFER" :skip-hover="true" key-field="id">
        <template #default="{ item: entry }">
          <CustomContextMenu :items="getHistoryMenuItems(entry)" v-slot="{ onContextMenu }">
            <div class="h-[72px] cursor-pointer border-b border-border/50 px-3 py-2 text-xs hover:bg-accent/50" @click="selectedEntry = entry" @contextmenu="onContextMenu">
              <div class="mb-0.5 flex items-center gap-1">
                <span class="inline-flex h-5 w-9 shrink-0 items-center justify-center rounded border px-1 text-[10px] leading-none text-muted-foreground">
                  {{ kindShortLabel(entry) }}
                </span>
                <span class="truncate font-medium">{{ entryTitle(entry) }}</span>
                <span class="ml-auto shrink-0 text-muted-foreground">{{ formatTime(entry.executed_at) }}</span>
              </div>
              <div class="truncate font-mono text-muted-foreground">{{ entrySubtitle(entry) }}</div>
              <div class="mt-0.5 flex items-center gap-2">
                <span class="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
                  <Database class="h-3 w-3 shrink-0" />
                  <span class="truncate">
                    {{ entry.connection_name }}<template v-if="entry.database"> / {{ entry.database }}</template>
                  </span>
                </span>
                <span class="ml-auto shrink-0" :class="entry.success ? 'text-green-500' : 'text-red-500'">
                  {{ entry.success ? `${entry.execution_time_ms}ms` : t("history.failed") }}
                </span>
              </div>
            </div>
          </CustomContextMenu>
        </template>
      </RecycleScroller>

      <div v-if="filtered.length === 0" class="px-3 py-8 text-center text-muted-foreground text-xs">
        {{ emptyMessage }}
      </div>
    </div>

    <Dialog :open="!!selectedEntry" @update:open="(value) => !value && (selectedEntry = null)">
      <DialogContent class="sm:max-w-2xl duration-75" @interact-outside="selectedEntry = null">
        <DialogHeader>
          <DialogTitle>{{ selectedEntry ? entryTitle(selectedEntry) : t("history.viewDetails") }}</DialogTitle>
        </DialogHeader>
        <div v-if="selectedEntry" class="space-y-4 overflow-y-auto max-h-[60vh]">
          <div class="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-sm">
            <template v-for="[label, value] in detailsRows(selectedEntry)" :key="label">
              <div class="text-muted-foreground">{{ label }}</div>
              <div class="min-w-0 break-words">{{ value }}</div>
            </template>
          </div>
          <div>
            <div class="mb-1 flex items-center justify-between">
              <div class="text-sm font-medium">SQL</div>
              <Button variant="ghost" size="sm" class="h-7" @click="copyText(selectedEntry.sql)">
                <Copy class="h-3.5 w-3.5" />
                {{ t("history.copy") }}
              </Button>
            </div>
            <pre class="max-h-48 overflow-auto rounded border bg-muted/30 p-3 text-xs" v-html="highlight(selectedEntry.sql)"></pre>
          </div>
          <div v-if="selectedEntry.rollback_sql">
            <div class="mb-1 flex items-center justify-between">
              <div class="text-sm font-medium">{{ t("history.rollbackSql") }}</div>
              <Button variant="ghost" size="sm" class="h-7" @click="copyText(selectedEntry.rollback_sql || '')">
                <Copy class="h-3.5 w-3.5" />
                {{ t("history.copy") }}
              </Button>
            </div>
            <pre class="max-h-40 overflow-auto rounded border bg-muted/30 p-3 text-xs" v-html="highlight(selectedEntry.rollback_sql || '')"></pre>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="selectedEntry && emit('analyzeAi', selectedEntry)">
            <Sparkles class="h-4 w-4" />
            {{ t("history.analyzeWithAi") }}
          </Button>
          <Button variant="outline" @click="selectedEntry && restore(selectedEntry)">{{ t("history.restore") }}</Button>
          <Button v-if="selectedEntry && canRollbackHistoryEntry(selectedEntry)" :disabled="isRollingBack" @click="rollback(selectedEntry)">
            <RotateCcw class="h-4 w-4" />
            {{ isRollingBack ? t("common.loading") : t("history.rollback") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showDeleteConfirm">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ t("history.delete") }}</DialogTitle>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">{{ t("history.confirmDelete") }}</p>
        <DialogFooter>
          <Button variant="outline" @click="showDeleteConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" @click="executeDelete">{{ t("dangerDialog.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showClearConfirm">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ t("history.clear") }}</DialogTitle>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">{{ t("history.confirmClear") }}</p>
        <DialogFooter>
          <Button variant="outline" @click="showClearConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" @click="executeClear">{{ t("dangerDialog.confirm") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.history-filter-scroll {
  overflow-x: hidden;
  overscroll-behavior-x: none;
}

.history-filter-scroll--scrollable {
  overflow-x: auto;
  padding-bottom: 2px;
  scrollbar-color: color-mix(in oklab, var(--muted-foreground) 45%, transparent) transparent;
  scrollbar-width: thin;
}

.history-filter-scroll--scrollable::-webkit-scrollbar {
  height: 4px;
}

.history-filter-scroll--scrollable::-webkit-scrollbar-track {
  background: transparent;
}

.history-filter-scroll--scrollable::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in oklab, var(--muted-foreground) 45%, transparent);
}
</style>

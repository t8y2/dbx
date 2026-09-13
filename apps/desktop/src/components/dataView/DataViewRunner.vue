<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Play, Loader2, AlertCircle, Pencil, CheckCircle2, LayoutGrid, Check, GripVertical } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DataGrid from "@/components/grid/DataGrid.vue";
import QueryChart from "@/components/chart/QueryChart.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import { useDataViewStore } from "@/stores/dataViewStore";
import { resolveDynamicDefault } from "@/lib/dataView/dynamicDefaults";
import { resolveDisplayResult } from "@/lib/dataView/dataViewResultDisplay";
import { formatRedisCommandResult } from "@/lib/redis/redisValuePresentation";
import { formatElapsedSeconds } from "@/lib/common/elapsedTime";
import { clampGridPos, columnWidthPx, compactLayout, gridContainerHeightPx, gridRectToPixels, pixelDeltaToGridUnits, resolveGridLayout } from "@/lib/dataView/dataViewGridLayout";
import type { DataView, DataViewDisplayMode, DataViewGridPos, DataViewParamValue, DataViewQuery, DataViewQueryResult } from "@/types/dataView";

const props = defineProps<{
  view: DataView;
  /** Minimal share-page mode: no card chrome, fills the viewport. */
  embedded?: boolean;
}>();

const { t } = useI18n();
const store = useDataViewStore();

const values = reactive<Record<string, string>>({});
const running = ref(false);
const runError = ref<string | null>(null);
const results = ref<DataViewQueryResult[]>([]);
const runElapsedMs = ref(0);
const runElapsedSeconds = computed(() => formatElapsedSeconds(runElapsedMs.value));
let runElapsedTimer: ReturnType<typeof setInterval> | undefined;
let runStartedAt = 0;

function startRunTimer() {
  stopRunTimer();
  runStartedAt = Date.now();
  runElapsedMs.value = 0;
  runElapsedTimer = setInterval(() => {
    runElapsedMs.value = Date.now() - runStartedAt;
  }, 100);
}

function stopRunTimer() {
  if (runElapsedTimer) clearInterval(runElapsedTimer);
  runElapsedTimer = undefined;
}
const displayModes = reactive<Record<string, DataViewDisplayMode>>({});
// Per-mutation execution state keyed by query id.
const mutationBusy = reactive<Record<string, boolean>>({});
const mutationResult = reactive<Record<string, DataViewQueryResult>>({});

const readQueries = computed(() => props.view.queries.filter((q) => (q.kind ?? "query") !== "mutation"));
const mutationQueries = computed(() => props.view.queries.filter((q) => q.kind === "mutation"));

function resetDefaults() {
  for (const key of Object.keys(values)) delete values[key];
  for (const variable of props.view.variables) {
    values[variable.name] = resolveDynamicDefault(variable.defaultValue);
  }
}

const missingRequired = computed(() => props.view.variables.filter((v) => v.required && !String(values[v.name] ?? "").trim()).map((v) => v.name));

// Dashboard-grid layout (drag/resize) for the results panels, edit-mode only.
const layoutEditing = ref(false);
const layoutDraft = reactive<Record<string, DataViewGridPos>>({});
const gridContainerRef = ref<HTMLElement | null>(null);
const containerWidthPx = ref(0);
const colWidthPx = computed(() => (containerWidthPx.value > 0 ? columnWidthPx(containerWidthPx.value) : 0));
const gridHeightPx = computed(() => gridContainerHeightPx(Object.values(layoutDraft)));
let containerResizeObserver: ResizeObserver | null = null;

watch(gridContainerRef, (el, prevEl) => {
  if (prevEl) containerResizeObserver?.unobserve(prevEl);
  if (el) {
    containerWidthPx.value = el.getBoundingClientRect().width;
    containerResizeObserver ??= new ResizeObserver(([entry]) => {
      if (entry) containerWidthPx.value = entry.contentRect.width;
    });
    containerResizeObserver.observe(el);
  }
});

function seedLayoutDraft() {
  const resolved = resolveGridLayout(readQueries.value);
  for (const key of Object.keys(layoutDraft)) delete layoutDraft[key];
  for (const [id, gridPos] of resolved) layoutDraft[id] = gridPos;
}

function panelStyle(queryId: string) {
  const gridPos = layoutDraft[queryId];
  if (!gridPos) return undefined;
  const rect = gridRectToPixels(gridPos, colWidthPx.value);
  const active = panelDragState.value?.queryId === queryId || panelResizeState.value?.queryId === queryId;
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    transition: active ? "none" : "left 160ms ease-out, top 160ms ease-out, width 160ms ease-out, height 160ms ease-out",
    zIndex: active ? 20 : 1,
  };
}

interface PanelGesture {
  queryId: string;
  startX: number;
  startY: number;
  startGridPos: DataViewGridPos;
  /** Snapshot of every other panel's layout at gesture start (compaction obstacles never mutate). */
  otherEntries: { id: string; gridPos: DataViewGridPos }[];
  liveGridPos: DataViewGridPos;
}

/** Live-recompacts every other panel around `tentative` (obstacle), and previews the gesture's own panel at `tentative`. */
function applyGestureFrame(state: PanelGesture, tentative: DataViewGridPos) {
  state.liveGridPos = tentative;
  const recompacted = compactLayout(state.otherEntries, [tentative]);
  for (const [id, gridPos] of recompacted) layoutDraft[id] = gridPos;
  layoutDraft[state.queryId] = tentative;
}

function revertGesture(state: PanelGesture) {
  layoutDraft[state.queryId] = state.startGridPos;
  for (const entry of state.otherEntries) layoutDraft[entry.id] = entry.gridPos;
}

/** Final full compaction (including the dragged/resized panel) for a gap-free layout, then persists. */
function commitGesture(state: PanelGesture) {
  const compacted = compactLayout([{ id: state.queryId, gridPos: state.liveGridPos }, ...state.otherEntries]);
  for (const [id, gridPos] of compacted) layoutDraft[id] = gridPos;
  void persistLayout();
}

function snapshotOtherPanels(queryId: string): { id: string; gridPos: DataViewGridPos }[] {
  return Object.entries(layoutDraft)
    .filter(([id]) => id !== queryId)
    .map(([id, gridPos]) => ({ id, gridPos }));
}

const panelDragState = ref<PanelGesture | null>(null);
let dragFrame = 0;
let pendingDragClientX = 0;
let pendingDragClientY = 0;

function startPanelDrag(queryId: string, event: PointerEvent) {
  if (!layoutEditing.value || event.button !== 0) return;
  const gridPos = layoutDraft[queryId];
  if (!gridPos) return;
  event.preventDefault();
  document.body.style.userSelect = "none";
  panelDragState.value = { queryId, startX: event.clientX, startY: event.clientY, startGridPos: gridPos, otherEntries: snapshotOtherPanels(queryId), liveGridPos: gridPos };
  window.addEventListener("pointermove", onPanelDragMove, true);
  window.addEventListener("pointerup", onPanelDragEnd, true);
  window.addEventListener("pointercancel", onPanelDragCancel, true);
}

function applyPanelDragFrame() {
  dragFrame = 0;
  const state = panelDragState.value;
  if (!state || colWidthPx.value <= 0) return;
  const { dx, dy } = pixelDeltaToGridUnits(pendingDragClientX - state.startX, pendingDragClientY - state.startY, colWidthPx.value);
  applyGestureFrame(state, clampGridPos({ x: state.startGridPos.x + dx, y: state.startGridPos.y + dy, w: state.startGridPos.w, h: state.startGridPos.h }));
}

function onPanelDragMove(event: PointerEvent) {
  if (!panelDragState.value) return;
  event.preventDefault();
  pendingDragClientX = event.clientX;
  pendingDragClientY = event.clientY;
  if (!dragFrame) dragFrame = requestAnimationFrame(applyPanelDragFrame);
}

function finishPanelDrag(commit: boolean) {
  const state = panelDragState.value;
  window.removeEventListener("pointermove", onPanelDragMove, true);
  window.removeEventListener("pointerup", onPanelDragEnd, true);
  window.removeEventListener("pointercancel", onPanelDragCancel, true);
  document.body.style.userSelect = "";
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    dragFrame = 0;
  }
  panelDragState.value = null;
  if (!state) return;
  if (commit) commitGesture(state);
  else revertGesture(state);
}

function onPanelDragEnd() {
  finishPanelDrag(true);
}

function onPanelDragCancel() {
  finishPanelDrag(false);
}

const panelResizeState = ref<PanelGesture | null>(null);
let resizeFrame = 0;
let pendingResizeClientX = 0;
let pendingResizeClientY = 0;

function startPanelResize(queryId: string, event: PointerEvent) {
  if (!layoutEditing.value || event.button !== 0) return;
  const gridPos = layoutDraft[queryId];
  if (!gridPos) return;
  event.preventDefault();
  event.stopPropagation();
  document.body.style.userSelect = "none";
  panelResizeState.value = { queryId, startX: event.clientX, startY: event.clientY, startGridPos: gridPos, otherEntries: snapshotOtherPanels(queryId), liveGridPos: gridPos };
  window.addEventListener("pointermove", onPanelResizeMove, true);
  window.addEventListener("pointerup", onPanelResizeEnd, true);
  window.addEventListener("pointercancel", onPanelResizeCancel, true);
}

function applyPanelResizeFrame() {
  resizeFrame = 0;
  const state = panelResizeState.value;
  if (!state || colWidthPx.value <= 0) return;
  const { dx, dy } = pixelDeltaToGridUnits(pendingResizeClientX - state.startX, pendingResizeClientY - state.startY, colWidthPx.value);
  applyGestureFrame(state, clampGridPos({ x: state.startGridPos.x, y: state.startGridPos.y, w: state.startGridPos.w + dx, h: state.startGridPos.h + dy }));
}

function onPanelResizeMove(event: PointerEvent) {
  if (!panelResizeState.value) return;
  event.preventDefault();
  pendingResizeClientX = event.clientX;
  pendingResizeClientY = event.clientY;
  if (!resizeFrame) resizeFrame = requestAnimationFrame(applyPanelResizeFrame);
}

function finishPanelResize(commit: boolean) {
  const state = panelResizeState.value;
  window.removeEventListener("pointermove", onPanelResizeMove, true);
  window.removeEventListener("pointerup", onPanelResizeEnd, true);
  window.removeEventListener("pointercancel", onPanelResizeCancel, true);
  document.body.style.userSelect = "";
  if (resizeFrame) {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
  }
  panelResizeState.value = null;
  if (!state) return;
  if (commit) commitGesture(state);
  else revertGesture(state);
}

function onPanelResizeEnd() {
  finishPanelResize(true);
}

function onPanelResizeCancel() {
  finishPanelResize(false);
}

/** Persists the current panel layout onto the view's queries; failures just mean it isn't saved yet (layout still applies locally). */
async function persistLayout() {
  const updated: DataView = { ...props.view, queries: props.view.queries.map((query) => ({ ...query, gridPos: layoutDraft[query.id] ?? query.gridPos ?? null })) };
  try {
    await store.save(updated);
  } catch {
    // Ignored: the in-memory layout already reflects the user's change.
  }
}

onBeforeUnmount(() => {
  finishPanelDrag(false);
  finishPanelResize(false);
  containerResizeObserver?.disconnect();
  stopRunTimer();
});

watch(
  () => props.view.id,
  () => {
    resetDefaults();
    seedLayoutDraft();
    // Skip straight to results when every variable already has a usable value.
    if (readQueries.value.length > 0 && missingRequired.value.length === 0) run();
  },
  { immediate: true },
);

watch(readQueries, seedLayoutDraft);

function buildPayload(): Record<string, DataViewParamValue> {
  const payload: Record<string, DataViewParamValue> = {};
  for (const variable of props.view.variables) {
    payload[variable.name] = { kind: variable.kind ?? "string", value: String(values[variable.name] ?? "") };
  }
  return payload;
}

function displayModeFor(result: DataViewQueryResult): DataViewDisplayMode {
  return displayModes[result.queryId] ?? result.displayMode ?? props.view.defaultDisplayMode;
}

function setDisplayMode(queryId: string, mode: DataViewDisplayMode) {
  displayModes[queryId] = mode;
}

function chartConfigFor(queryId: string) {
  return props.view.queries.find((q) => q.id === queryId)?.chartConfig;
}

function queryFor(queryId: string) {
  return props.view.queries.find((q) => q.id === queryId);
}

function displayResultFor(result: DataViewQueryResult) {
  return resolveDisplayResult(result, queryFor(result.queryId));
}

async function run() {
  if (running.value || readQueries.value.length === 0) return;
  runError.value = null;
  running.value = true;
  startRunTimer();
  try {
    const response = await store.execute(props.view.id, buildPayload(), {
      queryIds: readQueries.value.map((q) => q.id),
      allowMutations: false,
    });
    results.value = response.results;
  } catch (error) {
    runError.value = error instanceof Error ? error.message : String(error);
  } finally {
    running.value = false;
    stopRunTimer();
  }
}

const pendingMutation = ref<DataViewQuery | null>(null);
const mutationDialogOpen = ref(false);

function requestMutation(query: DataViewQuery) {
  if (mutationBusy[query.id] || missingRequired.value.length > 0) return;
  pendingMutation.value = query;
  mutationDialogOpen.value = true;
}

async function executeMutation() {
  const query = pendingMutation.value;
  if (!query || mutationBusy[query.id]) return;
  mutationDialogOpen.value = false;
  pendingMutation.value = null;
  mutationBusy[query.id] = true;
  try {
    const response = await store.execute(props.view.id, buildPayload(), { queryIds: [query.id], allowMutations: true });
    const result = response.results.find((r) => r.queryId === query.id);
    if (result) mutationResult[query.id] = result;
  } catch (error) {
    mutationResult[query.id] = {
      queryId: query.id,
      title: query.title ?? "",
      displayMode: "table",
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    mutationBusy[query.id] = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col gap-3 overflow-auto" :class="embedded ? 'p-4' : ''">
    <!-- Shared variable inputs -->
    <div class="flex flex-wrap items-end gap-3 rounded-md border bg-card p-3">
      <div v-for="variable in view.variables" :key="variable.name" class="flex flex-col gap-1">
        <Label class="text-xs font-medium text-muted-foreground">
          {{ variable.label || variable.name }}
          <span v-if="variable.required" class="text-destructive">*</span>
        </Label>

        <template v-if="variable.inputType === 'select'">
          <Select v-model="values[variable.name]">
            <SelectTrigger class="h-8 w-48">
              <SelectValue :placeholder="variable.name" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in variable.options ?? []" :key="option" :value="option">{{ option }}</SelectItem>
            </SelectContent>
          </Select>
        </template>

        <template v-else-if="variable.kind === 'boolean'">
          <input type="checkbox" class="h-4 w-4" :checked="values[variable.name] === 'true'" @change="values[variable.name] = ($event.target as HTMLInputElement).checked ? 'true' : 'false'" />
        </template>

        <template v-else>
          <Input v-model="values[variable.name]" :type="variable.kind === 'date' ? 'date' : variable.kind === 'number' ? 'number' : 'text'" class="h-8 w-48" :placeholder="variable.name" @keydown.enter="run" />
        </template>
      </div>

      <Button v-if="readQueries.length > 0" :disabled="running || missingRequired.length > 0" class="h-8" @click="run">
        <Loader2 v-if="running" class="mr-1 h-4 w-4 animate-spin" />
        <Play v-else class="mr-1 h-4 w-4" />
        {{ t("dataView.run") }}
      </Button>

      <Button v-if="!embedded && readQueries.length > 0" size="sm" :variant="layoutEditing ? 'secondary' : 'outline'" class="h-8" @click="layoutEditing = !layoutEditing">
        <Check v-if="layoutEditing" class="mr-1 h-4 w-4" />
        <LayoutGrid v-else class="mr-1 h-4 w-4" />
        {{ layoutEditing ? t("dataView.doneEditing") : t("dataView.editLayout") }}
      </Button>
    </div>

    <div v-if="runError" class="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
      <AlertCircle class="h-4 w-4 shrink-0" />
      <span>{{ runError }}</span>
    </div>

    <!-- Re-run indicator: keeps stale results visible while a fresh run is in flight. -->
    <div v-if="running && results.length > 0" class="flex items-center gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
      <Loader2 class="h-3.5 w-3.5 animate-spin" />
      <span>{{ t("dataView.running") }}</span>
      <span class="tabular-nums">· {{ runElapsedSeconds }}s</span>
    </div>

    <!-- Update (mutation) actions -->
    <div v-if="mutationQueries.length > 0" class="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <span class="text-xs font-medium text-amber-700 dark:text-amber-300">{{ t("dataView.updates") }}</span>
      <div v-for="query in mutationQueries" :key="query.id" class="flex items-center gap-2">
        <span class="text-sm">{{ query.title || t("dataView.untitledQuery") }}</span>
        <Button size="sm" variant="destructive" class="h-7" :disabled="mutationBusy[query.id] || missingRequired.length > 0" @click="requestMutation(query)">
          <Loader2 v-if="mutationBusy[query.id]" class="mr-1 h-4 w-4 animate-spin" />
          <Pencil v-else class="mr-1 h-4 w-4" />
          {{ t("dataView.executeUpdate") }}
        </Button>
        <span v-if="mutationResult[query.id]?.error" class="flex items-center gap-1 text-xs text-destructive"> <AlertCircle class="h-3.5 w-3.5" />{{ mutationResult[query.id].error }} </span>
        <span v-else-if="mutationResult[query.id]?.result" class="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"> <CheckCircle2 class="h-3.5 w-3.5" />{{ t("dataView.affectedRows", { count: mutationResult[query.id].result?.affected_rows ?? 0 }) }} </span>
        <span v-else-if="mutationResult[query.id]?.redisValue !== undefined" class="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"> <CheckCircle2 class="h-3.5 w-3.5" />{{ formatRedisCommandResult(mutationResult[query.id].redisValue) }} </span>
      </div>
    </div>

    <!-- Results, laid out on a 12-column dashboard grid; drag/resize handles only render in edit mode. -->
    <div v-if="results.length > 0" ref="gridContainerRef" class="relative" :style="{ height: `${gridHeightPx}px` }">
      <div v-for="result in results" :key="result.queryId" class="absolute flex flex-col overflow-hidden rounded-md border bg-card" :class="layoutEditing ? 'ring-1 ring-primary/20' : ''" :style="panelStyle(result.queryId)">
        <div class="flex shrink-0 items-center gap-1 border-b px-3 py-2">
          <GripVertical v-if="layoutEditing" class="h-4 w-4 shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing" @pointerdown="startPanelDrag(result.queryId, $event)" />
          <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ result.title || t("dataView.untitledQuery") }}</span>
          <div v-if="displayResultFor(result)" class="flex shrink-0 items-center gap-1">
            <Button size="sm" :variant="displayModeFor(result) === 'table' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs" @click="setDisplayMode(result.queryId, 'table')">
              {{ t("dataView.table") }}
            </Button>
            <Button size="sm" :variant="displayModeFor(result) === 'chart' ? 'secondary' : 'ghost'" class="h-6 px-2 text-xs" @click="setDisplayMode(result.queryId, 'chart')">
              {{ t("dataView.chart") }}
            </Button>
          </div>
        </div>

        <div v-if="result.error" class="flex items-center gap-2 p-3 text-sm text-destructive">
          <AlertCircle class="h-4 w-4 shrink-0" />
          <span>{{ result.error }}</span>
        </div>
        <div v-else-if="displayResultFor(result)" class="min-h-0 flex-1">
          <QueryChart v-if="displayModeFor(result) === 'chart'" :result="displayResultFor(result)!" :default-chart-type="chartConfigFor(result.queryId)?.type" :default-x-column="chartConfigFor(result.queryId)?.xColumn" :default-y-columns="chartConfigFor(result.queryId)?.yColumns" />
          <DataGrid v-else :result="displayResultFor(result)!" :editable="false" />
        </div>

        <div v-if="layoutEditing" class="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none text-muted-foreground" @pointerdown="startPanelResize(result.queryId, $event)">
          <svg viewBox="0 0 16 16" class="h-full w-full" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M13 3 L3 13 M13 8 L8 13 M13 13 L13 13" />
          </svg>
        </div>
      </div>
    </div>

    <QueryLoadingState v-if="running && results.length === 0" label-key="dataView.running" :elapsed-seconds="runElapsedSeconds" class="rounded-md border border-dashed p-6" />
    <div v-else-if="results.length === 0 && !running && readQueries.length > 0" class="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
      {{ t("dataView.emptyRunHint") }}
    </div>

    <DangerConfirmDialog
      v-model:open="mutationDialogOpen"
      :sql="pendingMutation?.sqlTemplate ?? ''"
      :title="t('dataView.executeUpdate')"
      :message="t('dataView.confirmUpdate', { name: pendingMutation?.title || t('dataView.untitledQuery') })"
      :confirm-label="t('dataView.executeUpdate')"
      :cancelable="true"
      @confirm="executeMutation"
    />
  </div>
</template>

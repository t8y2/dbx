<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, toRaw, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, Trash2, Wand2, ChevronLeft, ChevronDown, ChevronRight, Eye, Loader2, AlertCircle, GripVertical, Pencil } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DataGrid from "@/components/grid/DataGrid.vue";
import QueryChart from "@/components/chart/QueryChart.vue";
import ConnectionTreeSelect from "@/components/connection/ConnectionTreeSelect.vue";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { useDataViewStore } from "@/stores/dataViewStore";
import { useConnectionStore } from "@/stores/connectionStore";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { codeMirrorSqlDialect, codeMirrorSqlDialectForConnection, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { isSchemaAware } from "@/lib/database/databaseFeatureSupport";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { extractSqlParameters } from "@/lib/sql/sqlParameters";
import { resolveDynamicDefault } from "@/lib/dataView/dynamicDefaults";
import { resolveDisplayResult } from "@/lib/dataView/dataViewResultDisplay";
import { useToast } from "@/composables/useToast";
import type { DataView, DataViewChartConfig, DataViewChartType, DataViewDisplayMode, DataViewParamValue, DataViewQuery, DataViewQueryResult, DataViewVariableKind } from "@/types/dataView";

const props = defineProps<{ view: DataView }>();
const emit = defineEmits<{ saved: [view: DataView]; back: [] }>();

const { t } = useI18n();
const store = useDataViewStore();
const connectionStore = useConnectionStore();
const { databaseOptions, loadDatabaseOptions } = useDatabaseOptions();
const { toast } = useToast();

const draft = reactive<DataView>(structuredClone(toRaw(props.view)));
const saving = ref(false);

/** Preload database name options for every query's connection so the picker isn't empty on open. */
function preloadDatabaseOptions() {
  const connectionIds = new Set(draft.queries.map((q) => q.connectionId).filter(Boolean));
  for (const connectionId of connectionIds) loadDatabaseOptions(connectionId);
}
preloadDatabaseOptions();

watch(
  () => props.view.id,
  () => {
    Object.assign(draft, structuredClone(toRaw(props.view)));
    preloadDatabaseOptions();
  },
);

const displayModes: DataViewDisplayMode[] = ["table", "chart"];
const chartTypes: DataViewChartType[] = ["bar", "line", "pie"];
const variableKinds: DataViewVariableKind[] = ["string", "number", "boolean", "date"];
const INHERIT = "__inherit__";

const canSave = computed(() => draft.name.trim().length > 0 && !saving.value);

// Preview state, keyed by query id so single-query and whole-view preview share rendering.
const previewBusy = reactive<Record<string, boolean>>({});
const previewResults = reactive<Record<string, DataViewQueryResult>>({});
const viewPreviewBusy = ref(false);
const previewError = ref<string | null>(null);

// Collapsed state per query row, keyed by query id (default expanded).
const collapsedQueries = reactive<Record<string, boolean>>({});
function toggleQueryCollapsed(id: string) {
  collapsedQueries[id] = !collapsedQueries[id];
}

// Drag-to-reorder state for the queries list. Uses raw pointer events (not native HTML5
// drag & drop) so the whole card can follow the cursor as a floating clone, Grafana-style.
const QUERY_ROW_GAP_PX = 8; // matches the `gap-2` class on the queries list container
const queriesListRef = ref<HTMLElement | null>(null);
interface QueryDragState {
  sourceIndex: number;
  targetIndex: number;
  startY: number;
  currentY: number;
  rowTops: number[];
  rowHeights: number[];
  previewElement: HTMLElement | null;
  dragging: boolean;
}
const queryDragState = ref<QueryDragState | null>(null);

function queryRowElements(): HTMLElement[] {
  return Array.from(queriesListRef.value?.querySelectorAll<HTMLElement>(":scope > [data-query-row]") ?? []);
}

function blockQueryDragNativeInteraction(event: Event) {
  event.preventDefault();
}

function createQueryDragPreview(state: QueryDragState) {
  const source = queryRowElements()[state.sourceIndex];
  if (!source || state.previewElement) return;
  const rect = source.getBoundingClientRect();
  const preview = source.cloneNode(true) as HTMLElement;
  preview.setAttribute("aria-hidden", "true");
  preview.inert = true;
  Object.assign(preview.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    transform: "translateY(0)",
    transition: "none",
    zIndex: "100",
    pointerEvents: "none",
  });
  preview.classList.add("shadow-xl", "ring-2", "ring-primary/50", "bg-background");
  document.body.append(preview);
  state.previewElement = preview;
}

function removeQueryDragPreview(state: QueryDragState) {
  state.previewElement?.remove();
  state.previewElement = null;
}

/** Nearest slot (by original card center) to where the dragged card currently sits. */
function computeQueryTargetIndex(state: QueryDragState): number {
  const deltaY = state.currentY - state.startY;
  const draggedCenter = state.rowTops[state.sourceIndex] + state.rowHeights[state.sourceIndex] / 2 + deltaY;
  let best = state.sourceIndex;
  let bestDist = Infinity;
  for (let i = 0; i < state.rowTops.length; i++) {
    const center = state.rowTops[i] + state.rowHeights[i] / 2;
    const dist = Math.abs(center - draggedCenter);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Live offset applied to every non-dragged row so it slides into the gap immediately. */
function queryRowDragOffset(index: number): number {
  const state = queryDragState.value;
  if (!state?.dragging || index === state.sourceIndex) return 0;
  const shiftSize = state.rowHeights[state.sourceIndex] + QUERY_ROW_GAP_PX;
  if (state.targetIndex > state.sourceIndex && index > state.sourceIndex && index <= state.targetIndex) return -shiftSize;
  if (state.targetIndex < state.sourceIndex && index >= state.targetIndex && index < state.sourceIndex) return shiftSize;
  return 0;
}

function queryRowStyle(index: number) {
  const offset = queryRowDragOffset(index);
  if (!offset) return undefined;
  return { transform: `translateY(${offset}px)`, transition: "transform 160ms cubic-bezier(0.2, 0, 0, 1)" };
}

function onQueryDragPointerMove(event: PointerEvent) {
  const state = queryDragState.value;
  if (!state) return;
  if (!state.dragging && Math.abs(event.clientY - state.startY) > 4) {
    state.dragging = true;
    document.body.style.userSelect = "none";
    createQueryDragPreview(state);
  }
  if (!state.dragging) return;
  event.preventDefault();
  state.currentY = event.clientY;
  if (state.previewElement) state.previewElement.style.transform = `translateY(${state.currentY - state.startY}px)`;
  state.targetIndex = computeQueryTargetIndex(state);
}

function finishQueryDrag(commit: boolean) {
  const state = queryDragState.value;
  if (!state) return;
  window.removeEventListener("pointermove", onQueryDragPointerMove, true);
  window.removeEventListener("pointerup", onQueryDragPointerUp, true);
  window.removeEventListener("pointercancel", onQueryDragPointerCancel, true);
  document.removeEventListener("selectstart", blockQueryDragNativeInteraction, true);
  document.removeEventListener("dragstart", blockQueryDragNativeInteraction, true);
  document.body.style.userSelect = "";

  if (!state.dragging || !commit || state.targetIndex === state.sourceIndex) {
    removeQueryDragPreview(state);
    queryDragState.value = null;
    return;
  }

  // Spring the floating preview into its resting slot, then commit the reorder once it settles.
  const preview = state.previewElement;
  const commitReorder = () => {
    const [moved] = draft.queries.splice(state.sourceIndex, 1);
    draft.queries.splice(state.targetIndex, 0, moved);
    draft.queries.forEach((query, i) => (query.orderIndex = i));
    removeQueryDragPreview(state);
    queryDragState.value = null;
  };
  if (preview) {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      commitReorder();
    };
    preview.addEventListener("transitionend", settle, { once: true });
    preview.style.transition = "transform 160ms cubic-bezier(0.2, 0, 0, 1)";
    void preview.offsetHeight; // force reflow so the transform change below animates
    preview.style.transform = `translateY(${state.rowTops[state.targetIndex] - state.rowTops[state.sourceIndex]}px)`;
    window.setTimeout(settle, 220);
  } else {
    commitReorder();
  }
}

function onQueryDragPointerUp(event: PointerEvent) {
  const state = queryDragState.value;
  if (state?.dragging) {
    state.currentY = event.clientY;
    state.targetIndex = computeQueryTargetIndex(state);
  }
  finishQueryDrag(true);
}

function onQueryDragPointerCancel() {
  finishQueryDrag(false);
}

function startQueryDrag(index: number, event: PointerEvent) {
  if (event.button !== 0) return;
  const rows = queryRowElements();
  if (rows.length === 0) return;
  event.preventDefault();
  document.addEventListener("selectstart", blockQueryDragNativeInteraction, true);
  document.addEventListener("dragstart", blockQueryDragNativeInteraction, true);
  queryDragState.value = {
    sourceIndex: index,
    targetIndex: index,
    startY: event.clientY,
    currentY: event.clientY,
    rowTops: rows.map((el) => el.getBoundingClientRect().top),
    rowHeights: rows.map((el) => el.getBoundingClientRect().height),
    previewElement: null,
    dragging: false,
  };
  window.addEventListener("pointermove", onQueryDragPointerMove, true);
  window.addEventListener("pointerup", onQueryDragPointerUp, true);
  window.addEventListener("pointercancel", onQueryDragPointerCancel, true);
}

onBeforeUnmount(() => finishQueryDrag(false));

function connectionForQuery(query: DataViewQuery) {
  return connectionStore.getConfig(query.connectionId);
}

function databaseTypeForQuery(query: DataViewQuery) {
  return effectiveDatabaseTypeForConnection(connectionForQuery(query));
}

function dialectForQuery(query: DataViewQuery) {
  return codeMirrorSqlDialect(databaseTypeForQuery(query));
}

function syntaxDialectForQuery(query: DataViewQuery) {
  return codeMirrorSqlDialectForConnection(connectionForQuery(query));
}

function formatDialectForQuery(query: DataViewQuery) {
  return sqlFormatDialectForDbType(databaseTypeForQuery(query));
}

function databaseOptionsForQuery(query: DataViewQuery): string[] {
  return query.connectionId ? (databaseOptions.value[query.connectionId] ?? []) : [];
}

function onQueryConnectionChange(query: DataViewQuery, connectionId: string) {
  query.connectionId = connectionId;
  query.database = "";
  if (connectionId) loadDatabaseOptions(connectionId);
}

function addQuery() {
  const defaultConnectionId = draft.queries[draft.queries.length - 1]?.connectionId ?? connectionStore.connections[0]?.id ?? "";
  const query = store.makeQuery(
    {
      title: `${t("dataView.query")} ${draft.queries.length + 1}`,
      connectionId: defaultConnectionId,
      database: "",
      sqlTemplate: "",
    },
    draft.queries.length,
  );
  draft.queries.push(query);
  collapsedQueries[query.id] = false;
  if (defaultConnectionId) loadDatabaseOptions(defaultConnectionId);
}

function addVariable() {
  draft.variables.push({ name: "", label: "", kind: "string", inputType: "text", required: false });
}

function removeVariable(index: number) {
  draft.variables.splice(index, 1);
}

function removeQuery(index: number) {
  draft.queries.splice(index, 1);
}

function effectiveDisplayMode(query: DataViewQuery): DataViewDisplayMode {
  return query.displayMode ?? draft.defaultDisplayMode;
}

function setDisplayMode(query: DataViewQuery, value: string) {
  query.displayMode = value === INHERIT ? null : (value as DataViewDisplayMode);
}

function setChartType(query: DataViewQuery, chartType: DataViewChartType) {
  query.chartConfig = { ...(query.chartConfig ?? {}), type: chartType };
}

function setChartAxis(query: DataViewQuery, patch: Partial<DataViewChartConfig>) {
  query.chartConfig = { ...(query.chartConfig ?? {}), ...patch };
}

/** Merge `${name}` placeholders from every sub-query into the variable list. */
function extractVariables() {
  const existing = new Set(draft.variables.map((v) => v.name));
  for (const query of draft.queries) {
    for (const name of extractSqlParameters(query.sqlTemplate, { enabledSyntaxes: ["shell"] })) {
      if (!existing.has(name)) {
        draft.variables.push({ name, label: name, kind: "string", inputType: "text", required: true });
        existing.add(name);
      }
    }
  }
}

function buildSavePayload(): DataView {
  return { ...draft, variables: draft.variables.filter((v) => v.name.trim().length > 0) };
}

/** Default variable values (dynamic tokens resolved) used to run a preview. */
function buildPreviewPayload(): Record<string, DataViewParamValue> {
  const payload: Record<string, DataViewParamValue> = {};
  for (const variable of draft.variables) {
    payload[variable.name] = { kind: variable.kind ?? "string", value: resolveDynamicDefault(variable.defaultValue) };
  }
  return payload;
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  try {
    const saved = await store.save(buildSavePayload());
    toast(t("dataView.save"));
    emit("saved", saved);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}

/** Preview always runs against persisted state, so silently save the draft first. */
async function persistDraftForPreview(): Promise<DataView | null> {
  try {
    const saved = await store.save(buildSavePayload());
    Object.assign(draft, saved);
    return saved;
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
    return null;
  }
}

async function doPreviewQuery(query: DataViewQuery, allowMutations: boolean) {
  if (previewBusy[query.id]) return;
  previewBusy[query.id] = true;
  previewError.value = null;
  try {
    const saved = await persistDraftForPreview();
    if (!saved) return;
    const response = await store.execute(saved.id, buildPreviewPayload(), { queryIds: [query.id], allowMutations });
    const result = response.results.find((r) => r.queryId === query.id);
    if (result) previewResults[query.id] = result;
  } catch (error) {
    previewResults[query.id] = {
      queryId: query.id,
      title: query.title ?? "",
      displayMode: effectiveDisplayMode(query),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    previewBusy[query.id] = false;
  }
}

async function previewQuery(query: DataViewQuery) {
  if ((query.kind ?? "query") === "mutation") {
    requestPreviewMutation(query);
    return;
  }
  await doPreviewQuery(query, false);
}

const pendingPreviewMutation = ref<DataViewQuery | null>(null);
const previewMutationDialogOpen = ref(false);

function requestPreviewMutation(query: DataViewQuery) {
  if (previewBusy[query.id]) return;
  pendingPreviewMutation.value = query;
  previewMutationDialogOpen.value = true;
}

async function executePreviewMutation() {
  const query = pendingPreviewMutation.value;
  if (!query || previewBusy[query.id]) return;
  previewMutationDialogOpen.value = false;
  pendingPreviewMutation.value = null;
  await doPreviewQuery(query, true);
}

async function previewView() {
  if (viewPreviewBusy.value) return;
  const readQueryIds = draft.queries.filter((q) => (q.kind ?? "query") !== "mutation").map((q) => q.id);
  if (readQueryIds.length === 0) return;
  viewPreviewBusy.value = true;
  previewError.value = null;
  try {
    const saved = await persistDraftForPreview();
    if (!saved) return;
    const response = await store.execute(saved.id, buildPreviewPayload(), { queryIds: readQueryIds, allowMutations: false });
    for (const result of response.results) previewResults[result.queryId] = result;
  } catch (error) {
    previewError.value = error instanceof Error ? error.message : String(error);
  } finally {
    viewPreviewBusy.value = false;
  }
}
</script>

<template>
  <div class="flex h-full flex-col">
    <div class="flex h-9 shrink-0 items-center gap-1 border-b bg-muted/20 px-2">
      <LightTooltip :text="t('dataView.back')" side="bottom">
        <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('back')">
          <ChevronLeft class="h-3.5 w-3.5" />
        </Button>
      </LightTooltip>
      <span class="min-w-0 truncate text-[13px] font-medium" :title="draft.name">{{ draft.name || t("dataView.newView") }}</span>
      <span class="flex-1" />
      <Button variant="outline" size="sm" class="h-6" :disabled="viewPreviewBusy" @click="previewView">
        <Loader2 v-if="viewPreviewBusy" class="mr-1 h-3 w-3 animate-spin" />
        <Eye v-else class="mr-1 h-3 w-3" />
        {{ t("dataView.previewView") }}
      </Button>
      <Button size="sm" class="h-6" :disabled="!canSave" @click="save">{{ t("dataView.save") }}</Button>
    </div>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
      <div v-if="previewError" class="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
        <AlertCircle class="h-4 w-4 shrink-0" />
        <span>{{ previewError }}</span>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="flex flex-col gap-1">
          <Label class="text-xs font-medium text-muted-foreground">{{ t("dataView.name") }}</Label>
          <Input v-model="draft.name" :placeholder="t('dataView.name')" />
        </div>
        <div class="flex flex-col gap-1">
          <Label class="text-xs font-medium text-muted-foreground">{{ t("dataView.defaultDisplayMode") }}</Label>
          <Select v-model="draft.defaultDisplayMode">
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="mode in displayModes" :key="mode" :value="mode">{{ t(`dataView.${mode}`) }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="col-span-2 flex flex-col gap-1">
          <Label class="text-xs font-medium text-muted-foreground">{{ t("dataView.description") }}</Label>
          <Input :model-value="draft.description ?? ''" :placeholder="t('dataView.description')" @update:model-value="(v) => (draft.description = String(v))" />
        </div>
      </div>

      <!-- Variables -->
      <div class="flex flex-col gap-2 rounded-md border p-3">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">{{ t("dataView.variables") }}</span>
          <Button size="sm" variant="ghost" class="ml-auto" @click="extractVariables"><Wand2 class="mr-1 h-4 w-4" />SQL</Button>
          <Button size="sm" variant="ghost" @click="addVariable"><Plus class="h-4 w-4" /></Button>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("dataView.dynamicDefaultHint") }}</p>
        <div v-for="(variable, index) in draft.variables" :key="index" class="flex items-center gap-2">
          <Input v-model="variable.name" class="h-8 w-40" :placeholder="t('dataView.variableName')" />
          <Input v-model="variable.label" class="h-8 w-40" :placeholder="t('dataView.variableLabel')" />
          <Select v-model="variable.kind">
            <SelectTrigger class="h-8 w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="kind in variableKinds" :key="kind" :value="kind">{{ kind }}</SelectItem>
            </SelectContent>
          </Select>
          <Input :model-value="variable.defaultValue ?? ''" class="h-8 w-32" :placeholder="t('dataView.variableDefault')" @update:model-value="(v) => (variable.defaultValue = String(v))" />
          <Label class="flex cursor-default items-center gap-1 text-xs text-muted-foreground"> <input type="checkbox" v-model="variable.required" class="h-4 w-4" />{{ t("dataView.required") }} </Label>
          <Button size="sm" variant="ghost" @click="removeVariable(index)"><Trash2 class="h-4 w-4 text-destructive" /></Button>
        </div>
      </div>

      <!-- Queries -->
      <div class="flex flex-col gap-2 rounded-md border p-3">
        <div class="flex items-center gap-2">
          <span class="text-sm font-medium">{{ t("dataView.queries") }}</span>
          <Button size="sm" variant="ghost" class="ml-auto" @click="addQuery"><Plus class="mr-1 h-4 w-4" />{{ t("dataView.addQuery") }}</Button>
        </div>

        <div v-if="draft.queries.length === 0" class="flex flex-col items-center gap-2 rounded-md border border-dashed px-4 py-8 text-center">
          <p class="text-xs text-muted-foreground">{{ t("dataView.emptyQueriesHint") }}</p>
          <Button size="sm" @click="addQuery"><Plus class="mr-1 h-3.5 w-3.5" />{{ t("dataView.addQuery") }}</Button>
        </div>

        <div ref="queriesListRef" class="flex flex-col gap-2">
          <div v-for="(query, index) in draft.queries" :key="query.id" data-query-row class="flex flex-col gap-2 rounded-md border p-2" :class="queryDragState?.dragging && queryDragState.sourceIndex === index ? 'opacity-0 pointer-events-none' : ''" :style="queryRowStyle(index)">
            <div class="flex items-center gap-2">
              <button type="button" class="flex h-8 w-5 shrink-0 cursor-grab items-center justify-center touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing" @pointerdown="startQueryDrag(index, $event)">
                <GripVertical class="h-4 w-4" />
              </button>
              <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted text-[11px] font-medium text-muted-foreground">{{ String.fromCharCode(65 + (index % 26)) }}</span>
              <Input v-model="query.title" class="h-8 flex-1" :placeholder="t('dataView.queryTitle')" />
              <Select v-model="query.kind">
                <SelectTrigger class="h-8 w-28"><SelectValue :placeholder="t('dataView.query')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="query">{{ t("dataView.query") }}</SelectItem>
                  <SelectItem value="mutation">{{ t("dataView.mutation") }}</SelectItem>
                </SelectContent>
              </Select>
              <Select :model-value="query.displayMode ?? INHERIT" @update:model-value="(v) => setDisplayMode(query, String(v))">
                <SelectTrigger class="h-8 w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem :value="INHERIT">{{ t("dataView.inheritDisplayMode") }}</SelectItem>
                  <SelectItem v-for="mode in displayModes" :key="mode" :value="mode">{{ t(`dataView.${mode}`) }}</SelectItem>
                </SelectContent>
              </Select>
              <Select v-if="effectiveDisplayMode(query) === 'chart'" :model-value="query.chartConfig?.type ?? 'bar'" @update:model-value="(v) => setChartType(query, v as DataViewChartType)">
                <SelectTrigger class="h-8 w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="ct in chartTypes" :key="ct" :value="ct">{{ t(`chart.${ct}`) }}</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" :variant="query.kind === 'mutation' ? 'destructive' : 'ghost'" class="ml-auto shrink-0" :disabled="previewBusy[query.id] || !query.connectionId" @click="previewQuery(query)">
                <Loader2 v-if="previewBusy[query.id]" class="mr-1 h-4 w-4 animate-spin" />
                <Pencil v-else-if="query.kind === 'mutation'" class="mr-1 h-4 w-4" />
                <Eye v-else class="mr-1 h-4 w-4" />
                {{ query.kind === "mutation" ? t("dataView.executeUpdate") : t("dataView.preview") }}
              </Button>
              <LightTooltip :text="collapsedQueries[query.id] ? t('dataView.expandQuery') : t('dataView.collapseQuery')" side="bottom">
                <Button size="sm" variant="ghost" class="shrink-0 px-1" @click="toggleQueryCollapsed(query.id)">
                  <ChevronRight v-if="collapsedQueries[query.id]" class="h-4 w-4" />
                  <ChevronDown v-else class="h-4 w-4" />
                </Button>
              </LightTooltip>
              <Button size="sm" variant="ghost" class="shrink-0" @click="removeQuery(index)"><Trash2 class="h-4 w-4 text-destructive" /></Button>
            </div>

            <template v-if="!collapsedQueries[query.id]">
              <div class="flex flex-wrap items-center gap-2">
                <ConnectionTreeSelect
                  :model-value="query.connectionId"
                  :connections="connectionStore.connections"
                  :layout="connectionStore.sidebarLayout"
                  trigger-class="h-8 w-56"
                  :placeholder="t('editor.selectConnection')"
                  :search-placeholder="t('editor.searchConnection')"
                  :empty-text="t('grid.noSearchResults')"
                  @update:model-value="(connectionId) => onQueryConnectionChange(query, connectionId)"
                />
                <Select :model-value="query.database || ''" @update:model-value="(v) => (query.database = String(v))">
                  <SelectTrigger class="h-8 w-44"><SelectValue :placeholder="t('editor.selectDatabase')" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="db in databaseOptionsForQuery(query)" :key="db || '__default__'" :value="db">{{ db || t("editor.defaultDatabase") }}</SelectItem>
                  </SelectContent>
                </Select>
                <Input v-if="isSchemaAware(databaseTypeForQuery(query))" :model-value="query.schema ?? ''" class="h-8 w-32" :placeholder="t('editor.selectSchema')" @update:model-value="(v) => (query.schema = String(v) || null)" />
              </div>

              <div class="h-56 overflow-hidden rounded-md border">
                <QueryEditor
                  :model-value="query.sqlTemplate"
                  :connection-id="query.connectionId"
                  :database="query.database"
                  :schema="query.schema ?? undefined"
                  :database-type="databaseTypeForQuery(query)"
                  :dialect="dialectForQuery(query)"
                  :syntax-dialect="syntaxDialectForQuery(query)"
                  :format-dialect="formatDialectForQuery(query)"
                  hide-execution-controls
                  force-word-wrap
                  @update:model-value="(v) => (query.sqlTemplate = v)"
                />
              </div>

              <div v-if="previewResults[query.id]" class="flex min-h-40 flex-col rounded-md border">
                <div v-if="previewResults[query.id].error" class="flex items-center gap-2 p-2 text-xs text-destructive">
                  <AlertCircle class="h-3.5 w-3.5 shrink-0" />
                  <span>{{ previewResults[query.id].error }}</span>
                </div>
                <div v-else-if="resolveDisplayResult(previewResults[query.id], query)" class="h-56">
                  <QueryChart
                    v-if="effectiveDisplayMode(query) === 'chart'"
                    :result="resolveDisplayResult(previewResults[query.id], query)!"
                    :default-chart-type="query.chartConfig?.type"
                    :default-x-column="query.chartConfig?.xColumn"
                    :default-y-columns="query.chartConfig?.yColumns"
                    @update:chart-type="(type) => setChartType(query, type)"
                    @update:x-column="(column) => setChartAxis(query, { xColumn: column })"
                    @update:y-columns="(columns) => setChartAxis(query, { yColumns: columns })"
                  />
                  <DataGrid v-else :result="resolveDisplayResult(previewResults[query.id], query)!" :editable="false" />
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>

    <DangerConfirmDialog
      v-model:open="previewMutationDialogOpen"
      :sql="pendingPreviewMutation?.sqlTemplate ?? ''"
      :title="t('dataView.executeUpdate')"
      :message="t('dataView.confirmUpdate', { name: pendingPreviewMutation?.title || t('dataView.untitledQuery') })"
      :confirm-label="t('dataView.executeUpdate')"
      :cancelable="true"
      @confirm="executePreviewMutation"
    />
  </div>
</template>

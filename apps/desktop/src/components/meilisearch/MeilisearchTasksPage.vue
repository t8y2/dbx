<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Ban, ChevronLeft, ChevronRight, Eye, Loader2, RefreshCcw, Search, Settings2, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { useToast } from "@/composables/useToast";
import {
  formatMeilisearchTaskDateTime,
  formatMeilisearchTaskDetails,
  formatMeilisearchTaskDuration,
  MEILISEARCH_TASK_STATUS_OPTIONS,
  meilisearchTaskStatusLabel,
  normalizeTaskMutationSelector,
  normalizeTaskSelector,
  withFixedTaskIndex,
  type EnqueuedTaskSummary,
  type MeilisearchTask,
  type TaskSelector,
} from "@/types/meilisearchManagement";
import { loadMeilisearchTaskColumns, saveMeilisearchTaskColumns, type MeilisearchTaskColumnKey } from "@/lib/meilisearch/meilisearchTaskColumns";

const props = defineProps<{ connectionId: string; fixedIndexUid?: string }>();
const { locale, t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const readOnly = computed(() => connectionIsEffectivelyReadOnly(connectionStore.getConfig(props.connectionId)));

const rows = ref<MeilisearchTask[]>([]);
const total = ref(0);
const next = ref<number | null>(null);
const cursorStack = ref<Array<number | null>>([null]);
const loading = ref(false);
const error = ref("");
const allFilterValue = "__all__";
const filters = ref({ uids: "", indexUid: allFilterValue, status: allFilterValue });
const indexOptions = ref<string[]>([]);
const indexesLoading = ref(false);
const indexLoadError = ref("");
const visibleColumns = ref<MeilisearchTaskColumnKey[]>(loadMeilisearchTaskColumns());
const detailOpen = ref(false);
const detail = ref<MeilisearchTask | null>(null);
const confirmOpen = ref(false);
const pendingAction = ref<"cancel" | "delete" | null>(null);
const pendingSelector = ref<TaskSelector | null>(null);
const pendingMatchCount = ref(0);
const preparingAction = ref(false);
const mutating = ref(false);
const pollingTaskUid = ref<number | null>(null);
const timedOutTaskUid = ref<number | null>(null);
const appliedUserSelector = ref<TaskSelector>({});
let disposed = false;

const currentCursor = computed(() => cursorStack.value[cursorStack.value.length - 1] ?? null);
const hasPrevious = computed(() => cursorStack.value.length > 1);
const hasNext = computed(() => next.value != null);
const taskOperationBusy = computed(() => preparingAction.value || mutating.value || pollingTaskUid.value != null || timedOutTaskUid.value != null);
const activeStatuses = new Set(["enqueued", "processing"]);
const finishedStatuses = new Set(["succeeded", "failed", "canceled"]);
const columnOptions = computed<Array<{ key: MeilisearchTaskColumnKey; label: string }>>(() => [
  { key: "uid", label: "UID" },
  { key: "index", label: t("meilisearch.index") },
  { key: "type", label: t("meilisearch.type") },
  { key: "status", label: t("meilisearch.status") },
  { key: "details", label: t("meilisearch.details") },
  { key: "enqueuedAt", label: t("meilisearch.enqueuedAt") },
  { key: "startedAt", label: t("meilisearch.startedAt") },
  { key: "finishedAt", label: t("meilisearch.finishedAt") },
  { key: "duration", label: t("meilisearch.duration") },
]);
const columnFractions: Record<MeilisearchTaskColumnKey, number> = {
  uid: 0.65,
  index: 0.8,
  type: 1.5,
  status: 1.1,
  details: 2.2,
  enqueuedAt: 1.35,
  startedAt: 1.35,
  finishedAt: 1.35,
  duration: 0.75,
};
const gridTemplateColumns = computed(() => [...visibleColumns.value.map((key) => `minmax(0, ${columnFractions[key]}fr)`), "80px"].join(" "));
const renderedRows = computed(() =>
  rows.value.map((task) => ({
    task,
    statusLabel: meilisearchTaskStatusLabel(task.status),
    details: formatMeilisearchTaskDetails(task.details, {
      receivedDocuments: t("meilisearch.receivedDocuments"),
      indexedDocuments: t("meilisearch.indexedDocuments"),
    }),
    enqueuedAt: formatMeilisearchTaskDateTime(task.enqueuedAt, locale.value),
    startedAt: formatMeilisearchTaskDateTime(task.startedAt, locale.value),
    finishedAt: formatMeilisearchTaskDateTime(task.finishedAt, locale.value),
    duration: formatMeilisearchTaskDuration(task.duration, locale.value),
  })),
);

function isColumnVisible(key: MeilisearchTaskColumnKey): boolean {
  return visibleColumns.value.includes(key);
}

function toggleColumn(key: MeilisearchTaskColumnKey) {
  const isVisible = isColumnVisible(key);
  if (isVisible && visibleColumns.value.length === 1) return;
  visibleColumns.value = isVisible ? visibleColumns.value.filter((column) => column !== key) : columnOptions.value.map((option) => option.key).filter((column) => column === key || visibleColumns.value.includes(column));
  saveMeilisearchTaskColumns(visibleColumns.value);
}

function detailsJson(task: MeilisearchTask): string | undefined {
  return task.details ? JSON.stringify(task.details, null, 2) : undefined;
}

function numbers(value: string): number[] | undefined {
  const result = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  return result.length ? result : undefined;
}

function userSelector(): TaskSelector {
  return {
    uids: numbers(filters.value.uids),
    indexUids: !props.fixedIndexUid && filters.value.indexUid !== allFilterValue ? [filters.value.indexUid] : undefined,
    statuses: filters.value.status !== allFilterValue ? [filters.value.status] : undefined,
  };
}

function requestSelector(): TaskSelector {
  return withFixedTaskIndex(appliedUserSelector.value, props.fixedIndexUid);
}

function normalizedSelector(selector = requestSelector()): TaskSelector {
  return normalizeTaskSelector(selector);
}

const selectorPreview = computed(() => JSON.stringify(pendingSelector.value ?? {}, null, 2));

async function load(reset = false) {
  if (reset) cursorStack.value = [null];
  loading.value = true;
  error.value = "";
  try {
    const page = await api.meilisearchGetTasks(props.connectionId, { selector: normalizedSelector(), from: currentCursor.value, limit: 20 });
    rows.value = page.results;
    total.value = page.total;
    next.value = page.next ?? null;
  } catch (cause: any) {
    error.value = cause?.message || String(cause);
  } finally {
    loading.value = false;
  }
}

async function loadIndexes() {
  if (props.fixedIndexUid) return;
  indexesLoading.value = true;
  indexLoadError.value = "";
  try {
    const indexes = await api.meilisearchListIndexes(props.connectionId);
    indexOptions.value = [...new Set(indexes.filter(Boolean))].sort((left, right) => left.localeCompare(right));
  } catch (cause: any) {
    indexLoadError.value = cause?.message || String(cause);
  } finally {
    indexesLoading.value = false;
  }
}

function refresh() {
  timedOutTaskUid.value = null;
  void load();
  void loadIndexes();
}

function resetFilters() {
  filters.value = { uids: "", indexUid: allFilterValue, status: allFilterValue };
  appliedUserSelector.value = {};
  void load(true);
}

function applyFilters() {
  appliedUserSelector.value = normalizeTaskSelector(userSelector());
  void load(true);
}

function updateIndexFilter(value: unknown) {
  filters.value.indexUid = String(value ?? allFilterValue);
  applyFilters();
}

function updateStatusFilter(value: unknown) {
  filters.value.status = String(value ?? allFilterValue);
  applyFilters();
}

function goNext() {
  if (next.value == null) return;
  cursorStack.value.push(next.value);
  void load();
}

function goPrevious() {
  if (!hasPrevious.value) return;
  cursorStack.value.pop();
  void load();
}

async function openDetails(task: MeilisearchTask) {
  detailOpen.value = true;
  detail.value = null;
  try {
    const result = await api.meilisearchGetTask(props.connectionId, task.uid, props.fixedIndexUid);
    detail.value = result;
  } catch (cause: any) {
    detailOpen.value = false;
    toast(cause?.message || String(cause), 5000);
  }
}

async function requestAction(action: "cancel" | "delete", task: MeilisearchTask) {
  if (readOnly.value || taskOperationBusy.value) return;
  const baseSelector = withFixedTaskIndex({ uids: [task.uid] }, props.fixedIndexUid);
  const frozenSelector = normalizeTaskMutationSelector(baseSelector, action);
  if (!frozenSelector) {
    toast(t("meilisearch.noAllowedTaskStatuses"), 5000);
    return;
  }
  preparingAction.value = true;
  try {
    const page = await api.meilisearchGetTasks(props.connectionId, { selector: frozenSelector, from: null, limit: 1 });
    pendingAction.value = action;
    pendingSelector.value = frozenSelector;
    pendingMatchCount.value = page.total;
    confirmOpen.value = true;
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    preparingAction.value = false;
  }
}

async function waitForTask(summary: EnqueuedTaskSummary) {
  timedOutTaskUid.value = null;
  pollingTaskUid.value = summary.taskUid;
  for (let attempt = 0; attempt < 60 && !disposed; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000));
    if (disposed) return;
    try {
      const task = await api.meilisearchGetTask(props.connectionId, summary.taskUid);
      if (finishedStatuses.has(task.status)) {
        pollingTaskUid.value = null;
        timedOutTaskUid.value = null;
        toast(task.status === "succeeded" ? t("meilisearch.taskOperationCompleted") : t("meilisearch.taskOperationFinished", { status: task.status }), 5000);
        await load(true);
        return;
      }
    } catch {
      // The management task can be briefly unavailable immediately after enqueue.
    }
  }
  if (!disposed && pollingTaskUid.value != null) {
    timedOutTaskUid.value = pollingTaskUid.value;
    pollingTaskUid.value = null;
    toast(t("meilisearch.taskPollingTimeout", { uid: timedOutTaskUid.value }), 7000);
  }
}

async function confirmAction() {
  if (!pendingAction.value || !pendingSelector.value || readOnly.value || pollingTaskUid.value != null || timedOutTaskUid.value != null) return;
  const action = pendingAction.value;
  const selector = pendingSelector.value;
  mutating.value = true;
  try {
    const summary = action === "cancel" ? await api.meilisearchCancelTasks(props.connectionId, selector) : await api.meilisearchDeleteTasks(props.connectionId, selector);
    confirmOpen.value = false;
    pendingAction.value = null;
    pendingSelector.value = null;
    pendingMatchCount.value = 0;
    void waitForTask(summary);
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    mutating.value = false;
  }
}

onMounted(() => {
  void load(true);
  void loadIndexes();
});
onBeforeUnmount(() => {
  disposed = true;
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden p-4">
    <div class="mb-3 flex items-center justify-between gap-3">
      <div>
        <h2 class="text-base font-semibold">{{ fixedIndexUid ? t("meilisearch.indexTasks", { index: fixedIndexUid }) : t("meilisearch.tasks") }}</h2>
        <p class="text-xs text-muted-foreground">{{ t("meilisearch.tasksDescription") }}</p>
      </div>
      <Button size="sm" variant="outline" :disabled="loading" @click="refresh"><RefreshCcw class="mr-1 h-3.5 w-3.5" />{{ t("meilisearch.refresh") }}</Button>
    </div>

    <div class="mb-3 flex items-center gap-2 overflow-x-auto rounded-lg border bg-muted/20 p-2 text-xs">
      <div class="relative min-w-[260px] flex-1">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="filters.uids" class="pl-9" :aria-label="t('meilisearch.uidFilter')" :placeholder="t('meilisearch.searchUid')" @keyup.enter="applyFilters" />
      </div>
      <div v-if="!fixedIndexUid" class="w-[200px] shrink-0">
        <Select :model-value="filters.indexUid" :disabled="indexesLoading" @update:model-value="updateIndexFilter">
          <SelectTrigger :aria-label="t('meilisearch.index')"><SelectValue :placeholder="indexesLoading ? t('common.loading') : t('meilisearch.allIndexes')" /></SelectTrigger>
          <SelectContent>
            <SelectItem :value="allFilterValue">{{ t("meilisearch.allIndexes") }}</SelectItem>
            <SelectItem v-for="index in indexOptions" :key="index" :value="index">{{ index }}</SelectItem>
          </SelectContent>
        </Select>
        <span v-if="indexLoadError" class="text-[11px] text-destructive" :title="indexLoadError">{{ t("meilisearch.indexListUnavailable") }}</span>
      </div>
      <div class="w-[200px] shrink-0">
        <Select :model-value="filters.status" @update:model-value="updateStatusFilter">
          <SelectTrigger :aria-label="t('meilisearch.status')"><SelectValue :placeholder="t('meilisearch.allStatuses')" /></SelectTrigger>
          <SelectContent>
            <SelectItem :value="allFilterValue">{{ t("meilisearch.allStatuses") }}</SelectItem>
            <SelectItem v-for="option in MEILISEARCH_TASK_STATUS_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <Button class="ml-auto shrink-0" size="sm" variant="ghost" @click="resetFilters">{{ t("meilisearch.resetFilters") }}</Button>
    </div>

    <div v-if="preparingAction || pollingTaskUid != null || timedOutTaskUid != null || readOnly" class="mb-3 flex flex-wrap items-center gap-2">
      <span v-if="preparingAction" class="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" />{{ t("meilisearch.countingMatchingTasks") }}</span>
      <span v-if="pollingTaskUid != null" class="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 class="h-3.5 w-3.5 animate-spin" />{{ t("meilisearch.waitingForTask", { uid: pollingTaskUid }) }}</span>
      <span v-if="timedOutTaskUid != null" class="text-xs text-muted-foreground">{{ t("meilisearch.taskPollingTimeout", { uid: timedOutTaskUid }) }}</span>
      <span v-if="readOnly" class="text-xs text-muted-foreground">{{ t("meilisearch.readOnlyDisabled") }}</span>
    </div>

    <ErrorBanner v-if="error" class="mb-3" :message="error" />
    <div data-testid="tasks-grid" role="table" class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border">
      <QueryLoadingState v-if="loading && !rows.length" class="py-12" />
      <template v-else>
        <div data-testid="tasks-header" role="rowgroup" class="shrink-0 bg-muted text-xs font-semibold">
          <div role="row" class="grid items-center" :style="{ gridTemplateColumns }">
            <div v-if="isColumnVisible('uid')" role="columnheader" data-column="uid" class="min-w-0 px-3 py-2">UID</div>
            <div v-if="isColumnVisible('index')" role="columnheader" data-column="index" class="min-w-0 px-3 py-2">{{ t("meilisearch.index") }}</div>
            <div v-if="isColumnVisible('type')" role="columnheader" data-column="type" class="min-w-0 px-3 py-2">{{ t("meilisearch.type") }}</div>
            <div v-if="isColumnVisible('status')" role="columnheader" data-column="status" class="min-w-0 px-3 py-2">{{ t("meilisearch.status") }}</div>
            <div v-if="isColumnVisible('details')" role="columnheader" data-column="details" class="min-w-0 px-3 py-2">{{ t("meilisearch.details") }}</div>
            <div v-if="isColumnVisible('enqueuedAt')" role="columnheader" data-column="enqueuedAt" class="min-w-0 px-3 py-2">{{ t("meilisearch.enqueuedAt") }}</div>
            <div v-if="isColumnVisible('startedAt')" role="columnheader" data-column="startedAt" class="min-w-0 px-3 py-2">{{ t("meilisearch.startedAt") }}</div>
            <div v-if="isColumnVisible('finishedAt')" role="columnheader" data-column="finishedAt" class="min-w-0 px-3 py-2">{{ t("meilisearch.finishedAt") }}</div>
            <div v-if="isColumnVisible('duration')" role="columnheader" data-column="duration" class="min-w-0 px-3 py-2">{{ t("meilisearch.duration") }}</div>
            <div role="columnheader" data-column="actions" class="min-w-0 px-2 py-1.5">
              <div class="flex items-center justify-end gap-1 whitespace-nowrap">
                <span>{{ t("meilisearch.rowActions") }}</span>
                <Popover>
                  <PopoverTrigger as-child>
                    <Button size="icon-xs" variant="ghost" :title="t('meilisearch.columnSettings')" :aria-label="t('meilisearch.columnSettings')"><Settings2 class="h-3.5 w-3.5" /></Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" class="w-56 p-2">
                    <div class="px-2 pb-2 text-xs font-semibold">{{ t("meilisearch.columnSettings") }}</div>
                    <label v-for="option in columnOptions" :key="option.key" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-muted">
                      <input type="checkbox" :checked="isColumnVisible(option.key)" :disabled="isColumnVisible(option.key) && visibleColumns.length === 1" @change="toggleColumn(option.key)" />
                      <span>{{ option.label }}</span>
                    </label>
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>
        </div>
        <div data-testid="tasks-body" role="rowgroup" class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [contain:layout_paint] [will-change:scroll-position]">
          <div v-for="row in renderedRows" :key="row.task.uid" role="row" class="grid items-center border-t text-xs" :style="{ gridTemplateColumns }">
            <div v-if="isColumnVisible('uid')" role="cell" data-column="uid" class="min-w-0 truncate px-3 py-2 font-mono">{{ row.task.uid }}</div>
            <div v-if="isColumnVisible('index')" role="cell" data-column="index" class="min-w-0 truncate px-3 py-2 font-mono">{{ row.task.indexUid || "-" }}</div>
            <div v-if="isColumnVisible('type')" role="cell" data-column="type" class="min-w-0 truncate px-3 py-2" :title="row.task.type">{{ row.task.type }}</div>
            <div v-if="isColumnVisible('status')" role="cell" data-column="status" class="min-w-0 truncate px-3 py-2">
              <span class="font-medium">{{ row.statusLabel }}</span>
            </div>
            <div v-if="isColumnVisible('details')" role="cell" data-column="details" class="min-w-0 px-3 py-2" :title="detailsJson(row.task)">
              <div class="truncate font-mono">{{ row.details }}</div>
            </div>
            <div v-if="isColumnVisible('enqueuedAt')" role="cell" data-column="enqueuedAt" class="min-w-0 truncate px-3 py-2" :title="row.task.enqueuedAt || undefined">{{ row.enqueuedAt }}</div>
            <div v-if="isColumnVisible('startedAt')" role="cell" data-column="startedAt" class="min-w-0 truncate px-3 py-2" :title="row.task.startedAt || undefined">{{ row.startedAt }}</div>
            <div v-if="isColumnVisible('finishedAt')" role="cell" data-column="finishedAt" class="min-w-0 truncate px-3 py-2" :title="row.task.finishedAt || undefined">{{ row.finishedAt }}</div>
            <div v-if="isColumnVisible('duration')" role="cell" data-column="duration" class="min-w-0 truncate px-3 py-2" :title="row.task.duration || undefined">{{ row.duration }}</div>
            <div role="cell" data-column="actions" class="min-w-0 px-2 py-2">
              <div class="flex justify-end gap-1">
                <Button size="icon-xs" variant="ghost" :title="t('common.view')" @click="openDetails(row.task)"><Eye class="h-3.5 w-3.5" /></Button
                ><Button v-if="activeStatuses.has(row.task.status)" size="icon-xs" variant="ghost" :disabled="readOnly || taskOperationBusy" :title="t('meilisearch.cancelTask')" @click="requestAction('cancel', row.task)"><Ban class="h-3.5 w-3.5" /></Button
                ><Button v-if="finishedStatuses.has(row.task.status)" size="icon-xs" variant="ghost" class="text-destructive" :disabled="readOnly || taskOperationBusy" :title="t('meilisearch.deleteTaskHistory')" @click="requestAction('delete', row.task)"><Trash2 class="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          </div>
          <div v-if="!rows.length" class="p-10 text-center text-xs text-muted-foreground">{{ t("meilisearch.noTasks") }}</div>
        </div>
      </template>
    </div>
    <div class="mt-3 flex items-center justify-between text-xs text-muted-foreground">
      <span>{{ t("meilisearch.taskCount", { count: total }) }}</span>
      <div class="flex gap-2">
        <Button size="sm" variant="outline" :disabled="!hasPrevious || loading" @click="goPrevious"><ChevronLeft class="mr-1 h-3.5 w-3.5" />{{ t("meilisearch.previous") }}</Button
        ><Button size="sm" variant="outline" :disabled="!hasNext || loading" @click="goNext">{{ t("meilisearch.next") }}<ChevronRight class="ml-1 h-3.5 w-3.5" /></Button>
      </div>
    </div>

    <Dialog v-model:open="detailOpen"
      ><DialogContent class="max-w-3xl"
        ><DialogHeader
          ><DialogTitle>{{ t("meilisearch.taskDetails") }} #{{ detail?.uid }}</DialogTitle></DialogHeader
        >
        <pre v-if="detail" class="max-h-[65vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">{{ JSON.stringify(detail, null, 2) }}</pre>
        <DialogFooter
          ><Button variant="outline" @click="detailOpen = false">{{ t("common.close") }}</Button></DialogFooter
        ></DialogContent
      ></Dialog
    >

    <DangerConfirmDialog
      v-model:open="confirmOpen"
      :title="pendingAction === 'cancel' ? t('meilisearch.cancelTasks') : t('meilisearch.deleteTaskHistory')"
      :message="pendingAction === 'cancel' ? t('meilisearch.cancelTasksConfirm', { count: pendingMatchCount }) : t('meilisearch.deleteTasksConfirm', { count: pendingMatchCount })"
      :details="selectorPreview"
      :confirm-label="pendingAction === 'cancel' ? t('meilisearch.cancelTasks') : t('meilisearch.deleteTaskHistory')"
      :loading="mutating"
      :close-on-confirm="false"
      @confirm="confirmAction"
    />
  </div>
</template>

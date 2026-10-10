<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import type { TaskRunDetail, TaskRunItem, TaskRunItemsPage } from "@/lib/backend/tauri";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatQueryDuration } from "@/lib/format/duration";
import { formatTaskEndpoint, formatTaskTimestamp, taskRunElapsedMs, isUnfinishedTaskItem } from "@/lib/taskHistory";

const props = defineProps<{ open: boolean; runId: string | null }>();
const emit = defineEmits<{ "update:open": [open: boolean] }>();

const { t, locale } = useI18n();
const { toast } = useToast();
/** Upper bound for one copied summary; a transfer can legitimately own tens of thousands of objects. */
const MAX_SUMMARY_ITEMS = 20_000;
const detail = ref<TaskRunDetail | null>(null);
const detailLoading = ref(false);
const detailFailed = ref(false);
const items = ref<TaskRunItem[]>([]);
const itemsLoading = ref(false);
const itemsLoadingMore = ref(false);
const itemsFailed = ref(false);
const itemFilter = ref<"all" | "failed" | "non_succeeded">("all");
const nextAfterItemIndex = ref<number | null>(null);
const copying = ref(false);
let detailGeneration = 0;
let itemGeneration = 0;
let copyGeneration = 0;

const statusColor = computed(() => {
  switch (detail.value?.run.status) {
    case "succeeded":
      return "bg-green-500/10 text-green-700 dark:text-green-400";
    case "partial_failed":
      return "bg-amber-500/10 text-amber-700 dark:text-amber-400";
    case "failed":
      return "bg-destructive/10 text-destructive";
    case "cancelled":
      return "bg-yellow-500/10 text-yellow-700 dark:text-yellow-400";
    default:
      return "bg-primary/10 text-primary";
  }
});
const elapsedMs = computed(() => (detail.value ? taskRunElapsedMs(detail.value.run.startedAt, detail.value.run.finishedAt) : null));
const hasMoreItems = computed(() => itemFilter.value === "all" && nextAfterItemIndex.value !== null);

function isCurrentItemRequest(generation: number, runId: string): boolean {
  return generation === itemGeneration && props.open && props.runId === runId;
}

function mergeItems(existing: TaskRunItem[], incoming: TaskRunItem[]): TaskRunItem[] {
  const indexes = new Set(existing.map((item) => item.itemIndex));
  return [...existing, ...incoming.filter((item) => !indexes.has(item.itemIndex))];
}

async function loadFirstItems(runId: string): Promise<void> {
  const generation = ++itemGeneration;
  itemFilter.value = "all";
  items.value = [];
  nextAfterItemIndex.value = null;
  itemsFailed.value = false;
  itemsLoading.value = true;
  try {
    const page = await api.loadTaskRunItems(runId, { limit: 100 });
    if (!isCurrentItemRequest(generation, runId)) return;
    items.value = page.items;
    nextAfterItemIndex.value = page.nextAfterItemIndex ?? null;
  } catch {
    if (isCurrentItemRequest(generation, runId)) itemsFailed.value = true;
  } finally {
    if (isCurrentItemRequest(generation, runId)) itemsLoading.value = false;
  }
}

async function loadMoreItems(): Promise<void> {
  const runId = props.runId;
  const cursor = nextAfterItemIndex.value;
  if (!runId || cursor === null || itemsLoading.value || itemsLoadingMore.value) return;
  const generation = itemGeneration;
  itemsLoadingMore.value = true;
  itemsFailed.value = false;
  try {
    const page = await api.loadTaskRunItems(runId, { limit: 100, afterItemIndex: cursor });
    if (!isCurrentItemRequest(generation, runId)) return;
    items.value = mergeItems(items.value, page.items);
    nextAfterItemIndex.value = page.nextAfterItemIndex ?? null;
  } catch {
    if (isCurrentItemRequest(generation, runId)) itemsFailed.value = true;
  } finally {
    if (isCurrentItemRequest(generation, runId)) itemsLoadingMore.value = false;
  }
}

async function loadAllMatchingItems(filter: "failed" | "non_succeeded"): Promise<void> {
  const runId = props.runId;
  if (!runId || !props.open || itemsLoading.value || itemsLoadingMore.value) return;
  const generation = ++itemGeneration;
  itemFilter.value = filter;
  items.value = [];
  nextAfterItemIndex.value = null;
  itemsFailed.value = false;
  itemsLoading.value = true;
  const matches: TaskRunItem[] = [];
  const seenIndexes = new Set<number>();
  let cursor: number | undefined;
  try {
    while (true) {
      const page: TaskRunItemsPage = await api.loadTaskRunItems(runId, { limit: 200, afterItemIndex: cursor });
      if (!isCurrentItemRequest(generation, runId)) return;
      for (const item of page.items) {
        const selected = filter === "failed" ? item.status === "failed" : isUnfinishedTaskItem(item.status);
        if (selected && !seenIndexes.has(item.itemIndex)) {
          seenIndexes.add(item.itemIndex);
          matches.push(item);
        }
      }
      const next = page.nextAfterItemIndex ?? null;
      if (next === null || next === cursor) break;
      cursor = next;
    }
    items.value = matches;
  } catch {
    if (isCurrentItemRequest(generation, runId)) {
      items.value = matches;
      itemsFailed.value = true;
    }
  } finally {
    if (isCurrentItemRequest(generation, runId)) itemsLoading.value = false;
  }
}

async function applyItemFilter(filter: "all" | "failed" | "non_succeeded"): Promise<void> {
  if (filter === "all") {
    if (itemFilter.value !== "all") await loadFirstItems(props.runId ?? "");
    return;
  }
  if (itemFilter.value !== filter) await loadAllMatchingItems(filter);
}

async function retryItems(): Promise<void> {
  if (itemFilter.value === "all") await loadFirstItems(props.runId ?? "");
  else await loadAllMatchingItems(itemFilter.value);
}

async function loadDetail(): Promise<void> {
  const runId = props.runId;
  const generation = ++detailGeneration;
  ++copyGeneration;
  if (!runId || !props.open) return;
  detail.value = null;
  detailFailed.value = false;
  items.value = [];
  itemsFailed.value = false;
  detailLoading.value = true;
  try {
    const result = await api.loadTaskRun(runId);
    if (generation !== detailGeneration || !props.open || props.runId !== runId) return;
    if (!result) {
      detailFailed.value = true;
      return;
    }
    detail.value = result;
    await loadFirstItems(runId);
  } catch {
    if (generation === detailGeneration) detailFailed.value = true;
  } finally {
    if (generation === detailGeneration) detailLoading.value = false;
  }
}

function clearDetail(): void {
  detailGeneration += 1;
  itemGeneration += 1;
  copyGeneration += 1;
  detail.value = null;
  items.value = [];
  nextAfterItemIndex.value = null;
  detailLoading.value = false;
  itemsLoading.value = false;
  itemsLoadingMore.value = false;
  detailFailed.value = false;
  itemsFailed.value = false;
  copying.value = false;
  itemFilter.value = "all";
}

watch(
  () => [props.open, props.runId] as const,
  ([open]) => {
    if (open) void loadDetail();
    else clearDetail();
  },
  { immediate: true },
);

onBeforeUnmount(clearDetail);

function formatCount(value: number | null | undefined, rowCountState: string): string {
  if (value !== null && value !== undefined) return value.toLocaleString();
  return t(`taskHistory.rowCount.${rowCountState}`);
}

function statusKey(status: string): string {
  return `taskHistory.itemStatus.${status}`;
}

function transferValue(key: string | undefined): string {
  return key ? t(`taskHistory.transfer.${key}`) : t("taskHistory.notAvailable");
}

async function loadEveryItem(runId: string): Promise<{ items: TaskRunItem[]; truncated: boolean }> {
  const result: TaskRunItem[] = [];
  const seen = new Set<number>();
  let cursor: number | undefined;
  while (true) {
    const page = await api.loadTaskRunItems(runId, { limit: 200, afterItemIndex: cursor });
    for (const item of page.items) {
      if (!seen.has(item.itemIndex)) {
        seen.add(item.itemIndex);
        result.push(item);
      }
    }
    const next = page.nextAfterItemIndex ?? null;
    // A bounded summary keeps one runaway report from building an unbounded payload.
    const truncated = result.length >= MAX_SUMMARY_ITEMS;
    if (next === null || next === cursor || truncated) {
      return { items: result.slice(0, MAX_SUMMARY_ITEMS), truncated };
    }
    cursor = next;
  }
}

function copySummaryText(value: TaskRunDetail, objectItems: TaskRunItem[], truncated = false): string {
  const run = value.run;
  const lines = [
    `${t("taskHistory.copy.runId")}: ${run.runId}`,
    `${t("taskHistory.copy.taskType")}: ${t("taskHistory.taskType.transfer")}`,
    `${t("taskHistory.copy.status")}: ${t(`taskHistory.status.${run.status}`)}`,
    `${t("taskHistory.copy.startedAt")}: ${formatTaskTimestamp(run.startedAt, locale.value)}`,
  ];
  if (run.finishedAt) lines.push(`${t("taskHistory.copy.finishedAt")}: ${formatTaskTimestamp(run.finishedAt, locale.value)}`);
  if (elapsedMs.value !== null) lines.push(`${t("taskHistory.copy.duration")}: ${formatQueryDuration(elapsedMs.value)}`);
  lines.push(`${t("taskHistory.copy.source")}: ${formatTaskEndpoint(run.source)}`, `${t("taskHistory.copy.target")}: ${formatTaskEndpoint(run.target)}`, `${t("taskHistory.copy.historyComplete")}: ${run.historyComplete ? t("taskHistory.yes") : t("taskHistory.no")}`);
  if (value.transfer) {
    lines.push(
      `${t("taskHistory.copy.content")}: ${transferValue(value.transfer.content)}`,
      `${t("taskHistory.copy.mode")}: ${transferValue(value.transfer.mode)}`,
      `${t("taskHistory.copy.batchSize")}: ${value.transfer.batchSize.toLocaleString()}`,
      `${t("taskHistory.copy.objectCount")}: ${value.transfer.tableTotal.toLocaleString()}`,
    );
  }
  if (run.safeErrorSummary) lines.push(`${t("taskHistory.copy.safeError")}: ${run.safeErrorSummary}`);
  lines.push("", t("taskHistory.copy.objects"));
  for (const item of objectItems) {
    lines.push(
      `- ${item.sourceObject} → ${item.targetObject} (${t(`taskHistory.itemKind.${item.itemKind}`)})`,
      `  ${t("taskHistory.copy.status")}: ${t(statusKey(item.status))}; ${t("taskHistory.copy.sourceRows")}: ${formatCount(item.sourceRowCount, item.rowCountState)}; ${t("taskHistory.copy.movedRows")}: ${formatCount(item.movedRowCount, item.rowCountState)}; ${t("taskHistory.copy.targetRows")}: ${formatCount(item.targetRowCount, item.rowCountState)}; ${t("taskHistory.copy.filterApplied")}: ${item.hasTableFilter ? t("taskHistory.yes") : t("taskHistory.no")}`,
    );
    if (item.safeErrorSummary) lines.push(`  ${t("taskHistory.copy.safeError")}: ${item.safeErrorSummary}`);
  }
  if (truncated) {
    lines.push("", t("taskHistory.copy.objectsTruncated", { limit: MAX_SUMMARY_ITEMS.toLocaleString() }));
  }
  return lines.join("\n");
}

async function copySummary(): Promise<void> {
  if (!detail.value || copying.value) return;
  const value = detail.value;
  const runId = value.run.runId;
  const generation = ++copyGeneration;
  copying.value = true;
  try {
    const { items: allItems, truncated } = await loadEveryItem(runId);
    if (!props.open || props.runId !== runId || generation !== copyGeneration) return;
    await copyToClipboard(copySummaryText(value, allItems, truncated));
    if (props.open && generation === copyGeneration) toast(t("taskHistory.copy.copied"));
  } catch {
    if (props.open && generation === copyGeneration) toast(t("taskHistory.copy.failed"), 5000);
  } finally {
    if (generation === copyGeneration) copying.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="h-[min(90vh,62rem)] max-w-[min(1200px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] gap-4 p-5">
      <DialogHeader>
        <div class="flex min-w-0 items-start justify-between gap-8">
          <div class="min-w-0">
            <DialogTitle>{{ t("taskHistory.detailTitle") }}</DialogTitle>
            <DialogDescription>{{ detail?.run.runId ?? t("taskHistory.detailDescription") }}</DialogDescription>
          </div>
          <Button v-if="detail" size="sm" variant="outline" class="mr-8 shrink-0" :disabled="copying" @click="copySummary">
            {{ copying ? t("taskHistory.copy.copying") : t("taskHistory.copy.action") }}
          </Button>
        </div>
      </DialogHeader>

      <div class="min-h-0 overflow-y-auto pr-1">
        <div v-if="detailLoading" class="p-8 text-center text-sm text-muted-foreground">{{ t("taskHistory.loading") }}</div>
        <div v-else-if="detailFailed" class="flex flex-col items-center gap-3 p-8 text-center">
          <p class="text-sm text-destructive">{{ t("taskHistory.detailLoadFailed") }}</p>
          <Button size="sm" variant="outline" @click="loadDetail">{{ t("taskHistory.retry") }}</Button>
        </div>
        <template v-else-if="detail">
          <div class="space-y-4">
            <section class="rounded-md border p-3">
              <div class="mb-3 flex flex-wrap items-center gap-2">
                <span class="text-sm font-semibold">{{ t("taskHistory.taskType.transfer") }}</span>
                <span class="rounded px-2 py-0.5 text-xs font-medium" :class="statusColor">{{ t(`taskHistory.status.${detail.run.status}`) }}</span>
                <span v-if="detail.run.historyComplete === false" class="rounded bg-amber-500/10 px-2 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400">{{ t("taskHistory.incompleteHistory") }}</span>
              </div>
              <dl class="grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-2 xl:grid-cols-3">
                <div>
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.runId") }}</dt>
                  <dd class="mt-0.5 break-all font-mono">{{ detail.run.runId }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.startedAt") }}</dt>
                  <dd class="mt-0.5">{{ formatTaskTimestamp(detail.run.startedAt, locale) }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.finishedAt") }}</dt>
                  <dd class="mt-0.5">{{ detail.run.finishedAt ? formatTaskTimestamp(detail.run.finishedAt, locale) : t("taskHistory.notAvailable") }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.duration") }}</dt>
                  <dd class="mt-0.5">{{ elapsedMs === null ? t("taskHistory.durationUnavailable") : formatQueryDuration(elapsedMs) }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.source") }}</dt>
                  <dd class="mt-0.5 break-words">
                    {{ formatTaskEndpoint(detail.run.source) }}<span class="mt-0.5 block break-all font-mono text-[10px] text-muted-foreground">{{ t("taskHistory.fields.connectionId") }}: {{ detail.run.source.connectionId }}</span>
                  </dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.target") }}</dt>
                  <dd class="mt-0.5 break-words">
                    {{ formatTaskEndpoint(detail.run.target) }}<span class="mt-0.5 block break-all font-mono text-[10px] text-muted-foreground">{{ t("taskHistory.fields.connectionId") }}: {{ detail.run.target.connectionId }}</span>
                  </dd>
                </div>
                <div v-if="detail.transfer">
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.transferMode") }}</dt>
                  <dd class="mt-0.5">{{ transferValue(detail.transfer.mode) }}</dd>
                </div>
                <div v-if="detail.transfer">
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.content") }}</dt>
                  <dd class="mt-0.5">{{ transferValue(detail.transfer.content) }}</dd>
                </div>
                <div v-if="detail.transfer">
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.batchSize") }}</dt>
                  <dd class="mt-0.5 tabular-nums">{{ detail.transfer.batchSize.toLocaleString() }}</dd>
                </div>
                <div v-if="detail.transfer">
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.objectCount") }}</dt>
                  <dd class="mt-0.5 tabular-nums">{{ detail.transfer.tableTotal.toLocaleString() }}</dd>
                </div>
                <div v-if="detail.transfer">
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.filteredObjects") }}</dt>
                  <dd class="mt-0.5 tabular-nums">{{ detail.transfer.filteredTableCount.toLocaleString() }}</dd>
                </div>
                <div>
                  <dt class="text-muted-foreground">{{ t("taskHistory.fields.historyIntegrity") }}</dt>
                  <dd class="mt-0.5">{{ detail.run.historyComplete ? t("taskHistory.completeHistory") : t("taskHistory.incompleteHistory") }}</dd>
                </div>
              </dl>
              <p v-if="detail.run.safeErrorSummary" class="mt-3 whitespace-pre-wrap break-words rounded bg-destructive/5 p-2 text-xs text-destructive">{{ detail.run.safeErrorSummary }}</p>
              <p v-if="detail.run.historyComplete === false || detail.run.status === 'running'" class="mt-3 rounded bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">{{ t("taskHistory.incompleteHistoryHint") }}</p>
            </section>

            <section class="rounded-md border">
              <div class="flex flex-wrap items-center justify-between gap-3 border-b p-3">
                <div>
                  <h3 class="text-sm font-semibold">{{ t("taskHistory.objectsTitle") }}</h3>
                  <p class="mt-0.5 text-xs text-muted-foreground">{{ t("taskHistory.objectsCount", { loaded: items.length, total: detail.transfer?.tableTotal ?? items.length }) }}</p>
                </div>
                <div class="flex gap-1" role="group" :aria-label="t('taskHistory.objectFilters.label')">
                  <Button size="sm" :variant="itemFilter === 'all' ? 'secondary' : 'ghost'" :disabled="itemsLoading" @click="applyItemFilter('all')">{{ t("taskHistory.objectFilters.all") }}</Button>
                  <Button size="sm" :variant="itemFilter === 'failed' ? 'secondary' : 'ghost'" :disabled="itemsLoading" @click="applyItemFilter('failed')">{{ t("taskHistory.objectFilters.failed") }}</Button>
                  <Button size="sm" :variant="itemFilter === 'non_succeeded' ? 'secondary' : 'ghost'" :disabled="itemsLoading" @click="applyItemFilter('non_succeeded')">{{ t("taskHistory.objectFilters.nonSucceeded") }}</Button>
                </div>
              </div>
              <div v-if="itemsLoading" class="p-6 text-center text-xs text-muted-foreground">{{ itemFilter === "all" ? t("taskHistory.loading") : t("taskHistory.objectFilters.scanning") }}</div>
              <div v-else-if="itemsFailed && items.length === 0" class="flex items-center justify-between gap-3 p-3 text-xs">
                <span class="text-destructive">{{ t("taskHistory.itemsLoadFailed") }}</span>
                <Button size="sm" variant="outline" @click="retryItems">{{ t("taskHistory.retry") }}</Button>
              </div>
              <div v-else-if="items.length === 0" class="p-6 text-center text-xs text-muted-foreground">{{ itemFilter === "all" ? t("taskHistory.noObjects") : t("taskHistory.objectFilters.noMatches") }}</div>
              <div v-else class="overflow-x-auto">
                <table class="w-full min-w-[850px] border-collapse text-left text-xs">
                  <thead class="sticky top-0 bg-muted/80 text-muted-foreground">
                    <tr>
                      <th class="px-2 py-2 font-medium">{{ t("taskHistory.columns.sourceObject") }}</th>
                      <th class="px-2 py-2 font-medium">{{ t("taskHistory.columns.targetObject") }}</th>
                      <th class="px-2 py-2 font-medium">{{ t("taskHistory.columns.kind") }}</th>
                      <th class="px-2 py-2 font-medium">{{ t("taskHistory.columns.status") }}</th>
                      <th class="px-2 py-2 text-right font-medium">{{ t("taskHistory.columns.sourceRows") }}</th>
                      <th class="px-2 py-2 text-right font-medium">{{ t("taskHistory.columns.movedRows") }}</th>
                      <th class="px-2 py-2 text-right font-medium">{{ t("taskHistory.columns.targetRows") }}</th>
                      <th class="px-2 py-2 font-medium">{{ t("taskHistory.columns.filter") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="item in items" :key="item.itemIndex" class="border-t align-top">
                      <td class="max-w-64 whitespace-pre-wrap break-all px-2 py-2 font-mono">{{ item.sourceObject }}</td>
                      <td class="max-w-64 whitespace-pre-wrap break-all px-2 py-2 font-mono">{{ item.targetObject }}</td>
                      <td class="px-2 py-2">{{ t(`taskHistory.itemKind.${item.itemKind}`) }}</td>
                      <td class="px-2 py-2">
                        <span>{{ t(statusKey(item.status)) }}</span>
                        <p v-if="item.safeErrorSummary" class="mt-1 max-w-72 whitespace-pre-wrap break-words text-destructive">{{ item.safeErrorSummary }}</p>
                      </td>
                      <td class="px-2 py-2 text-right tabular-nums">{{ formatCount(item.sourceRowCount, item.rowCountState) }}</td>
                      <td class="px-2 py-2 text-right tabular-nums">{{ formatCount(item.movedRowCount, item.rowCountState) }}</td>
                      <td class="px-2 py-2 text-right tabular-nums">{{ formatCount(item.targetRowCount, item.rowCountState) }}</td>
                      <td class="px-2 py-2">{{ item.hasTableFilter ? t("taskHistory.yes") : t("taskHistory.no") }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-if="items.length > 0 || hasMoreItems" class="flex items-center justify-between gap-3 border-t p-3">
                <span class="text-xs text-muted-foreground">{{ itemFilter === "all" ? t("taskHistory.loadedCount", { count: items.length }) : t("taskHistory.objectFilters.matchCount", { count: items.length }) }}</span>
                <Button v-if="hasMoreItems" size="sm" variant="outline" :disabled="itemsLoadingMore" @click="loadMoreItems">{{ itemsLoadingMore ? t("taskHistory.loading") : t("taskHistory.loadMore") }}</Button>
              </div>
              <div v-if="itemsFailed && items.length > 0" class="flex items-center justify-between gap-3 border-t p-3 text-xs">
                <span class="text-destructive">{{ t("taskHistory.itemsLoadFailed") }}</span>
                <Button size="sm" variant="outline" @click="retryItems">{{ t("taskHistory.retry") }}</Button>
              </div>
            </section>
          </div>
        </template>
      </div>
    </DialogContent>
  </Dialog>
</template>

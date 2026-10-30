<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import Input from "@/components/ui/input/Input.vue";
import TaskRunSummary from "@/components/export/TaskRunSummary.vue";
import { useTaskRunHistory } from "@/composables/useTaskRunHistory";
import { taskRunQueryFromFilters, type TaskRunFilterDraft } from "@/lib/taskHistory";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  "update:open": [open: boolean];
  "open-run": [runId: string];
}>();

const { t } = useI18n();
// Destructured so the template reads plain refs instead of `history.resource.value`.
const { runs: historyRuns, loading: historyLoading, loadingMore: historyLoadingMore, failed: historyFailed, hasMore: historyHasMore, loadFirstPage: loadHistoryPage, loadMore: loadMoreHistory, retry: retryHistory, invalidate: invalidateHistory } = useTaskRunHistory(30);
const draft = reactive<TaskRunFilterDraft>({ fromDate: "", throughDate: "", sourceQuery: "", targetQuery: "", status: "" });
const validationError = ref("");
const activeQuery = ref(taskRunQueryFromFilters(draft));
const anyFilter = computed(() => Boolean(activeQuery.value.status || activeQuery.value.startedAtFrom || activeQuery.value.startedAtBefore || activeQuery.value.sourceQuery || activeQuery.value.targetQuery));

watch(
  () => props.open,
  (open) => {
    if (open) void loadHistoryPage(activeQuery.value);
    else invalidateHistory();
  },
  { immediate: true },
);

function applyFilters(): void {
  validationError.value = "";
  if (draft.fromDate && draft.throughDate && draft.fromDate > draft.throughDate) {
    validationError.value = t("taskHistory.filters.invalidDateRange");
    return;
  }
  activeQuery.value = taskRunQueryFromFilters(draft);
  void loadHistoryPage(activeQuery.value);
}

function clearFilters(): void {
  draft.fromDate = "";
  draft.throughDate = "";
  draft.sourceQuery = "";
  draft.targetQuery = "";
  draft.status = "";
  applyFilters();
}

function openRun(runId: string): void {
  emit("open-run", runId);
  emit("update:open", false);
}

onBeforeUnmount(() => invalidateHistory());
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="h-[min(88vh,56rem)] max-w-[min(1100px,calc(100vw-32px))] grid-rows-[auto_auto_minmax(0,1fr)] gap-3 p-5">
      <DialogHeader>
        <DialogTitle>{{ t("taskHistory.title") }}</DialogTitle>
        <DialogDescription>{{ t("taskHistory.description") }}</DialogDescription>
      </DialogHeader>

      <form class="grid grid-cols-1 gap-2 rounded-md border bg-muted/20 p-3 md:grid-cols-2 xl:grid-cols-5" @submit.prevent="applyFilters">
        <label class="space-y-1 text-xs">
          <span class="font-medium">{{ t("taskHistory.filters.from") }}</span>
          <Input v-model="draft.fromDate" type="date" :aria-label="t('taskHistory.filters.from')" />
        </label>
        <label class="space-y-1 text-xs">
          <span class="font-medium">{{ t("taskHistory.filters.through") }}</span>
          <Input v-model="draft.throughDate" type="date" :aria-label="t('taskHistory.filters.through')" />
        </label>
        <label class="space-y-1 text-xs">
          <span class="font-medium">{{ t("taskHistory.filters.source") }}</span>
          <Input v-model="draft.sourceQuery" maxlength="256" :placeholder="t('taskHistory.filters.endpointPlaceholder')" :aria-label="t('taskHistory.filters.source')" />
        </label>
        <label class="space-y-1 text-xs">
          <span class="font-medium">{{ t("taskHistory.filters.target") }}</span>
          <Input v-model="draft.targetQuery" maxlength="256" :placeholder="t('taskHistory.filters.endpointPlaceholder')" :aria-label="t('taskHistory.filters.target')" />
        </label>
        <label class="space-y-1 text-xs">
          <span class="font-medium">{{ t("taskHistory.filters.status") }}</span>
          <select v-model="draft.status" class="h-8 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" :aria-label="t('taskHistory.filters.status')">
            <option value="">{{ t("taskHistory.filters.allStatuses") }}</option>
            <option value="running">{{ t("taskHistory.status.running") }}</option>
            <option value="succeeded">{{ t("taskHistory.status.succeeded") }}</option>
            <option value="partial_failed">{{ t("taskHistory.status.partial_failed") }}</option>
            <option value="failed">{{ t("taskHistory.status.failed") }}</option>
            <option value="cancelled">{{ t("taskHistory.status.cancelled") }}</option>
          </select>
        </label>
        <div class="flex items-end gap-2 md:col-span-2 xl:col-span-5">
          <Button type="submit" size="sm" :disabled="historyLoading">{{ t("taskHistory.filters.apply") }}</Button>
          <Button type="button" variant="outline" size="sm" :disabled="historyLoading && !anyFilter" @click="clearFilters">{{ t("taskHistory.filters.clear") }}</Button>
          <span v-if="validationError" role="alert" class="text-xs text-destructive">{{ validationError }}</span>
          <span v-else class="ml-auto text-xs text-muted-foreground">{{ t("taskHistory.filters.endpointHint") }}</span>
        </div>
      </form>

      <div class="min-h-0 overflow-y-auto rounded-md border" aria-live="polite">
        <div v-if="historyLoading" class="p-8 text-center text-sm text-muted-foreground">{{ t("taskHistory.loading") }}</div>
        <div v-else-if="historyFailed && historyRuns.length === 0" class="flex flex-col items-center gap-3 p-8 text-center">
          <p class="text-sm text-destructive">{{ t("taskHistory.loadFailed") }}</p>
          <Button size="sm" variant="outline" @click="retryHistory">{{ t("taskHistory.retry") }}</Button>
        </div>
        <div v-else-if="historyRuns.length === 0" class="p-8 text-center">
          <p class="text-sm font-medium">{{ anyFilter ? t("taskHistory.noMatchingHistory") : t("taskHistory.empty") }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ t("taskHistory.demoHint") }}</p>
        </div>
        <div v-else>
          <TaskRunSummary v-for="run in historyRuns" :key="run.runId" :run="run" @open="openRun" />
          <div class="flex items-center justify-between gap-3 border-t p-3">
            <span class="text-xs text-muted-foreground">{{ t("taskHistory.loadedCount", { count: historyRuns.length }) }}</span>
            <Button v-if="historyHasMore" size="sm" variant="outline" :disabled="historyLoadingMore" @click="loadMoreHistory">
              {{ historyLoadingMore ? t("taskHistory.loading") : t("taskHistory.loadMore") }}
            </Button>
          </div>
          <div v-if="historyFailed" class="flex items-center justify-between gap-3 border-t p-3 text-xs">
            <span class="text-destructive">{{ t("taskHistory.loadFailed") }}</span>
            <Button size="sm" variant="outline" @click="retryHistory">{{ t("taskHistory.retry") }}</Button>
          </div>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

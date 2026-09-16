<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { AlertTriangle, ArrowLeft, CheckCircle2, Eye, History, Loader2, RefreshCw, RotateCcw, Square, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import NacosConfigDiffDialog from "@/components/nacos/NacosConfigDiffDialog.vue";
import * as api from "@/lib/backend/api";
import { buildNacosContentReplacePlan, type NacosContentReplacePlan, type NacosContentReplacePlanItem, type NacosContentReplaceReport, type NacosContentRollbackReport } from "@/lib/nacos/nacosContentReplace";
import { applyWithNacosHistory, rollbackFromNacosHistory, nacosHistoryTarget, nacosHistoryRollbackCandidates, withNacosHistoryLock, type NacosReplaceHistoryEntry } from "@/lib/nacos/nacosReplaceHistory";
import { deleteNacosReplaceHistory, listNacosReplaceHistory } from "@/lib/nacos/nacosReplaceHistoryStorage";
import type { NacosConfigItem, NacosContentMatch, NacosNamespaceScope, NacosSearchProgress } from "@/types/nacos";

const props = defineProps<{
  open: boolean;
  connectionId: string;
  currentNamespace?: string;
  readOnly?: boolean;
}>();

const emit = defineEmits<{ "update:open": [value: boolean]; changed: [] }>();
const { t } = useI18n();
const search = ref("");
const replacement = ref("");
const scope = ref<NacosNamespaceScope>("currentNamespace");
const group = ref("");
const dataId = ref("");
const plan = ref<NacosContentReplacePlan | null>(null);
const report = ref<NacosContentReplaceReport | null>(null);
const rollbackReport = ref<NacosContentRollbackReport | null>(null);
const previewing = ref(false);
const applying = ref(false);
const rollingBack = ref(false);
const error = ref("");
const progress = ref<NacosSearchProgress | null>(null);
const activeOperationId = ref("");
const diffItem = ref<NacosContentReplacePlanItem | null>(null);
const diffOpen = ref(false);
const tab = ref("replace");
const entries = ref<NacosReplaceHistoryEntry[]>([]);
const activeEntry = ref<NacosReplaceHistoryEntry | null>(null);
const selectedHistoryId = ref("");
const historyLoading = ref(false);
const confirmOpen = ref(false);
const confirmAction = ref<"rollback" | "delete">("rollback");
const confirmEntryId = ref("");
const deleting = ref(false);
let previewTarget = "";
let historySequence = 0;
let previewSequence = 0;

const busy = computed(() => previewing.value || applying.value || rollingBack.value || deleting.value);
const canPreview = computed(() => !!search.value && search.value !== replacement.value && !busy.value && !props.readOnly);
const canApply = computed(() => !!plan.value?.items.length && !report.value && !busy.value && !props.readOnly);
const resultItemsByKey = computed(() => new Map(report.value?.items.map((item) => [item.key, item]) ?? []));
const rollbackItemsByKey = computed(() => new Map(rollbackReport.value?.items.map((item) => [item.key, item]) ?? []));
const canRollback = computed(() => !!activeEntry.value && nacosHistoryRollbackCandidates(activeEntry.value).length > 0 && !busy.value && !props.readOnly);

watch(
  () => [props.open, props.connectionId] as const,
  ([open]) => {
    if (!open || busy.value) return;
    reset();
    void loadHistory();
  },
  { immediate: true },
);

watch(tab, (value) => {
  if (value === "history") {
    selectedHistoryId.value = "";
    void loadHistory();
  } else {
    clearResults();
    selectedHistoryId.value = "";
  }
});
onBeforeUnmount(() => {
  historySequence += 1;
  void cancelPreview();
});

watch([search, replacement, scope, group, dataId, () => props.currentNamespace], () => {
  if (previewing.value || applying.value || report.value) return;
  plan.value = null;
  error.value = "";
});

function reset() {
  previewSequence += 1;
  search.value = "";
  replacement.value = "";
  scope.value = "currentNamespace";
  group.value = "";
  dataId.value = "";
  clearResults();
  tab.value = "replace";
  selectedHistoryId.value = "";
  confirmOpen.value = false;
  entries.value = [];
  previewing.value = false;
  applying.value = false;
  rollingBack.value = false;
  error.value = "";
  progress.value = null;
  activeOperationId.value = "";
}

function clearResults() {
  plan.value = null;
  report.value = null;
  rollbackReport.value = null;
  activeEntry.value = null;
}

function showError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  const keys: Record<string, string> = {
    "nacos-history-storage-unavailable": "storageUnavailable",
    "nacos-history-storage-failed": "storageFailed",
    "nacos-history-target-mismatch": "targetMismatch",
    "nacos-history-busy": "busy",
  };
  error.value = keys[message] ? t(`nacos.replaceHistory.${keys[message]}`) : message;
}

async function currentTarget(connectionId: string) {
  const connection = (await api.loadConnections()).find((item) => item.id === connectionId);
  if (!connection) throw new Error("nacos-history-target-mismatch");
  return nacosHistoryTarget(connection);
}

async function loadHistory() {
  const sequence = ++historySequence;
  const connectionId = props.connectionId;
  historyLoading.value = true;
  try {
    const loaded = await listNacosReplaceHistory(connectionId);
    if (sequence === historySequence && connectionId === props.connectionId) entries.value = loaded;
  } catch (cause) {
    if (sequence === historySequence) showError(cause);
  } finally {
    if (sequence === historySequence) historyLoading.value = false;
  }
}

function viewHistory(entry: NacosReplaceHistoryEntry) {
  selectedHistoryId.value = entry.id;
  activeEntry.value = entry;
  plan.value = entry.plan;
  report.value = entry.report;
  rollbackReport.value = entry.rollback ?? null;
  error.value = "";
}

function confirmOperation(action: "rollback" | "delete", id: string) {
  if (busy.value || (action === "rollback" && !canRollback.value)) return;
  confirmAction.value = action;
  confirmEntryId.value = id;
  confirmOpen.value = true;
}

async function confirmedOperation() {
  if (busy.value) return;
  if (confirmAction.value === "rollback") await rollback();
  else {
    deleting.value = true;
    try {
      const connectionId = props.connectionId;
      await withNacosHistoryLock(connectionId, () => deleteNacosReplaceHistory(confirmEntryId.value, connectionId));
      await loadHistory();
      if (activeEntry.value?.id === confirmEntryId.value) {
        clearResults();
        selectedHistoryId.value = "";
      }
    } catch (cause) {
      showError(cause);
    } finally {
      deleting.value = false;
    }
  }
  confirmOpen.value = false;
}

function closeDialog(value: boolean) {
  if (!value && busy.value) return;
  emit("update:open", value);
}

function historyItemStatus(item: NacosContentReplacePlanItem) {
  if (activeEntry.value?.inFlight?.key === item.key || activeEntry.value?.uncertainItems?.some((uncertain) => uncertain.key === item.key)) return t("nacos.replaceHistory.uncertain");
  const rollback = rollbackItemsByKey.value.get(item.key);
  if (rollback) return t(`nacos.replaceHistory.rollbackStatus.${rollback.status}`);
  const applied = resultItemsByKey.value.get(item.key);
  return applied ? t(`nacos.contentReplaceStatus.${applied.status}`) : t("nacos.replaceHistory.notExecuted");
}

function operationId() {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `nacos-replace-${suffix}`;
}

function matchIdentity(match: NacosContentMatch) {
  return `${match.namespace}\u0000${match.group}\u0000${match.dataId}`;
}

async function mapConcurrent<T, R>(items: readonly T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = Array.from({ length: items.length }) as R[];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

async function preview() {
  if (!canPreview.value) return;
  const sequence = ++previewSequence;
  const id = operationId();
  activeOperationId.value = id;
  previewing.value = true;
  error.value = "";
  plan.value = null;
  report.value = null;
  rollbackReport.value = null;
  progress.value = null;
  try {
    const connectionId = props.connectionId;
    previewTarget = await currentTarget(connectionId);
    const result = await api.nacosSearchConfigContent(
      connectionId,
      {
        operationId: id,
        namespace: props.currentNamespace || undefined,
        scope: scope.value,
        query: search.value,
        group: group.value.trim() || undefined,
        dataId: dataId.value.trim() || undefined,
        maxResults: 10_000,
      },
      (value) => {
        if (sequence === previewSequence) progress.value = value;
      },
    );
    if (sequence !== previewSequence) return;
    if (result.incomplete || result.truncated || result.cancelled || result.failures.length) {
      error.value = t("nacos.contentReplaceIncomplete");
      return;
    }
    const matches = [...new Map(result.matches.map((match) => [matchIdentity(match), match])).values()];
    const configs = await mapConcurrent(matches, 8, async (match): Promise<NacosConfigItem> => {
      const config = await api.nacosGetConfig(connectionId, { namespace: match.namespace, group: match.group, dataId: match.dataId });
      return { ...config, namespace: config.namespace || match.namespace, group: config.group || match.group, dataId: config.dataId || match.dataId };
    });
    if (sequence !== previewSequence) return;
    plan.value = buildNacosContentReplacePlan(configs, search.value, replacement.value);
  } catch (cause) {
    if (sequence === previewSequence) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (sequence === previewSequence) {
      previewing.value = false;
      activeOperationId.value = "";
    }
  }
}

async function cancelPreview() {
  previewSequence += 1;
  const id = activeOperationId.value;
  activeOperationId.value = "";
  previewing.value = false;
  if (id) await api.nacosCancelConfigContentSearch(id).catch(() => undefined);
}

async function apply() {
  if (!canApply.value || !plan.value) return;
  applying.value = true;
  error.value = "";
  try {
    const connectionId = props.connectionId;
    const currentPlan = plan.value;
    activeEntry.value = await withNacosHistoryLock(connectionId, async () => {
      const target = await currentTarget(connectionId);
      if (target !== previewTarget) throw new Error("nacos-history-target-mismatch");
      return applyWithNacosHistory(connectionId, target, { scope: scope.value, namespace: props.currentNamespace || "public", group: group.value, dataId: dataId.value }, currentPlan, {
        getConfig: (key) => api.nacosGetConfig(connectionId, key),
        publishConfig: (request) => api.nacosPublishConfig(connectionId, request),
      });
    });
    report.value = activeEntry.value.report;
    if (report.value.replaced) emit("changed");
  } catch (cause) {
    showError(cause);
    // The interrupted batch is already durable; do not allow a second apply
    // using the same stale plan after a journal failure.
    plan.value = null;
    emit("changed");
  } finally {
    applying.value = false;
    await loadHistory();
  }
}

async function rollback() {
  if (!canRollback.value || !activeEntry.value || activeEntry.value.id !== confirmEntryId.value) return;
  rollingBack.value = true;
  error.value = "";
  try {
    const connectionId = props.connectionId;
    activeEntry.value = await withNacosHistoryLock(connectionId, async () => {
      const target = await currentTarget(connectionId);
      return rollbackFromNacosHistory(confirmEntryId.value, connectionId, target, {
        getConfig: (key) => api.nacosGetConfig(connectionId, key),
        publishConfig: (request) => api.nacosPublishConfig(connectionId, request),
      });
    });
    rollbackReport.value = activeEntry.value.rollback ?? null;
    if (rollbackReport.value?.restored) emit("changed");
  } catch (cause) {
    showError(cause);
    emit("changed");
  } finally {
    rollingBack.value = false;
    await loadHistory();
    const refreshed = entries.value.find((entry) => entry.id === activeEntry.value?.id);
    if (refreshed) {
      activeEntry.value = refreshed;
      rollbackReport.value = refreshed.rollback ?? null;
    }
  }
}

function showDiff(item: NacosContentReplacePlanItem) {
  diffItem.value = item;
  diffOpen.value = true;
}
</script>

<template>
  <Dialog :open="open" @update:open="closeDialog">
    <DialogContent class="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-5xl" :show-close-button="!busy" @escape-key-down="busy && $event.preventDefault()" @pointer-down-outside="busy && $event.preventDefault()">
      <DialogHeader>
        <DialogTitle>{{ t("nacos.contentReplaceTitle") }}</DialogTitle>
        <DialogDescription>{{ t("nacos.contentReplaceDescription") }}</DialogDescription>
      </DialogHeader>

      <Tabs v-model="tab">
        <TabsList>
          <TabsTrigger value="replace" :disabled="busy">{{ t("nacos.replaceHistory.replaceTab") }}</TabsTrigger>
          <TabsTrigger value="history" data-testid="nacos-replace-history-tab" :disabled="busy"><History class="mr-1.5 h-4 w-4" />{{ t("nacos.replaceHistory.historyTab") }}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <template v-if="tab === 'history' && !selectedHistoryId">
          <div class="flex items-center justify-between gap-2">
            <span class="text-sm text-muted-foreground">{{ t("nacos.replaceHistory.batchCount", { count: entries.length }) }}</span>
            <Button size="icon" variant="ghost" :disabled="historyLoading || busy" :title="t('nacos.replaceHistory.refresh')" :aria-label="t('nacos.replaceHistory.refresh')" @click="loadHistory"><RefreshCw class="h-4 w-4" :class="{ 'animate-spin': historyLoading }" /></Button>
          </div>
          <div v-if="!entries.length && !historyLoading" class="py-8 text-center text-sm text-muted-foreground">{{ t("nacos.replaceHistory.empty") }}</div>
          <div class="divide-y">
            <div v-for="entry in entries" :key="entry.id" class="flex min-w-0 items-start gap-2 py-3">
              <div class="min-w-0 flex-1 space-y-1">
                <div class="flex flex-wrap items-center gap-2 text-sm">
                  <time>{{ new Date(entry.createdAt).toLocaleString() }}</time
                  ><Badge variant="outline">{{ t(`nacos.replaceHistory.state.${entry.state}`) }}</Badge>
                </div>
                <div class="break-all font-mono text-xs">{{ entry.plan.search }} → {{ entry.plan.replacement }}</div>
                <div class="break-all text-xs text-muted-foreground">{{ entry.scope.scope === "allNamespaces" ? t("nacos.allNamespaces") : entry.scope.namespace }} / {{ entry.scope.group || t("nacos.contentReplaceAllGroups") }} / {{ entry.scope.dataId || t("nacos.contentReplaceAllDataIds") }}</div>
                <div class="text-xs">{{ t("nacos.contentReplaceReport", entry.report) }}</div>
                <div v-if="entry.rollback" class="text-xs text-muted-foreground">{{ t("nacos.contentReplaceRollbackReport", entry.rollback) }}</div>
              </div>
              <Button size="icon" variant="ghost" data-testid="nacos-replace-history-details" :disabled="busy" :title="t('nacos.replaceHistory.details')" :aria-label="t('nacos.replaceHistory.details')" @click="viewHistory(entry)"><Eye class="h-4 w-4" /></Button>
              <Button size="icon" variant="ghost" :disabled="busy" :title="t('nacos.replaceHistory.delete')" :aria-label="t('nacos.replaceHistory.delete')" @click="confirmOperation('delete', entry.id)"><Trash2 class="h-4 w-4" /></Button>
            </div>
          </div>
        </template>
        <div v-if="tab === 'history' && selectedHistoryId" class="space-y-2">
          <Button variant="ghost" size="sm" :disabled="busy" @click="selectedHistoryId = ''"><ArrowLeft class="h-4 w-4" />{{ t("nacos.replaceHistory.historyTab") }}</Button>
          <div class="break-all text-sm">{{ new Date(activeEntry!.createdAt).toLocaleString() }} · {{ t(`nacos.replaceHistory.state.${activeEntry!.state}`) }}</div>
          <div class="break-all font-mono text-sm">{{ plan?.search }} → {{ plan?.replacement }}</div>
          <div v-if="activeEntry?.inFlight || activeEntry?.uncertainItems?.length" class="text-sm text-amber-700 dark:text-amber-300">{{ t("nacos.replaceHistory.interrupted") }}</div>
        </div>
        <template v-if="tab === 'replace'">
          <div class="grid gap-3 md:grid-cols-2">
            <label class="space-y-1.5 text-sm">
              <span class="font-medium">{{ t("nacos.contentReplaceSearch") }}</span>
              <Input v-model="search" data-testid="nacos-replace-search" autocomplete="off" :disabled="busy || !!report" />
            </label>
            <label class="space-y-1.5 text-sm">
              <span class="font-medium">{{ t("nacos.contentReplaceValue") }}</span>
              <Input v-model="replacement" data-testid="nacos-replace-value" autocomplete="off" :disabled="busy || !!report" />
            </label>
          </div>

          <div class="grid gap-3 md:grid-cols-3">
            <label class="space-y-1.5 text-sm">
              <span class="font-medium">{{ t("nacos.contentReplaceScope") }}</span>
              <select v-model="scope" data-testid="nacos-replace-scope" class="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" :disabled="busy || !!report">
                <option value="currentNamespace">{{ t("nacos.currentNamespace") }}</option>
                <option value="allNamespaces">{{ t("nacos.allNamespaces") }}</option>
              </select>
            </label>
            <label class="space-y-1.5 text-sm">
              <span class="font-medium">Group</span>
              <Input v-model="group" :placeholder="t('nacos.contentReplaceAllGroups')" :disabled="busy || !!report" />
            </label>
            <label class="space-y-1.5 text-sm">
              <span class="font-medium">Data ID</span>
              <Input v-model="dataId" :placeholder="t('nacos.contentReplaceAllDataIds')" :disabled="busy || !!report" />
            </label>
          </div>

          <div v-if="scope === 'allNamespaces'" class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
            <span>{{ t("nacos.contentReplaceAllNamespacesWarning") }}</span>
          </div>

          <div v-if="previewing && progress" class="text-sm text-muted-foreground">{{ t("nacos.contentReplaceScanning", { scanned: progress.scanned, matched: progress.matched }) }}</div>
        </template>
        <div v-if="error" class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
          <span class="min-w-0 break-words">{{ error }}</span>
        </div>

        <section v-if="plan && (tab === 'replace' || selectedHistoryId)" class="space-y-3">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{{ t("nacos.contentReplaceConfigCount", { count: plan.items.length }) }}</Badge>
            <Badge variant="outline">{{ t("nacos.contentReplaceOccurrenceCount", { count: plan.totalReplacements }) }}</Badge>
          </div>
          <div v-if="!plan.items.length" class="py-8 text-center text-sm text-muted-foreground">{{ t("nacos.contentReplaceNoMatches") }}</div>
          <div v-else class="divide-y rounded-md border">
            <div v-for="item in plan.items" :key="item.key" class="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <div class="min-w-0 flex-1">
                <div class="break-all font-mono text-sm font-medium">{{ item.dataId }}</div>
                <div class="break-all text-xs text-muted-foreground">{{ item.namespace || "public" }} / {{ item.group }} · {{ t("nacos.contentReplaceOccurrenceCount", { count: item.replacements }) }}</div>
                <div v-if="resultItemsByKey.get(item.key)?.message || rollbackItemsByKey.get(item.key)?.message" class="break-words text-xs text-destructive">{{ rollbackItemsByKey.get(item.key)?.message || resultItemsByKey.get(item.key)?.message }}</div>
              </div>
              <Badge v-if="report" class="max-w-28 shrink-0 whitespace-normal text-center" :variant="resultItemsByKey.get(item.key)?.status === 'replaced' ? 'secondary' : 'destructive'">
                {{ historyItemStatus(item) }}
              </Badge>
              <Button type="button" size="icon" variant="ghost" :title="t('nacos.contentReplaceViewDiff')" :aria-label="t('nacos.contentReplaceViewDiff')" @click="showDiff(item)"><Eye class="h-4 w-4" /></Button>
            </div>
          </div>
        </section>

        <div v-if="report && (tab === 'replace' || selectedHistoryId)" class="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ t("nacos.contentReplaceReport", { replaced: report.replaced, conflicts: report.conflicts, failed: report.failed }) }}</span>
        </div>
        <div v-if="rollbackReport && (tab === 'replace' || selectedHistoryId)" class="text-sm text-muted-foreground">{{ t("nacos.contentReplaceRollbackReport", rollbackReport) }}</div>
      </div>

      <DialogFooter class="gap-2 border-t pt-4">
        <Button v-if="tab === 'replace' && !report" type="button" variant="outline" data-testid="nacos-replace-preview" :disabled="!canPreview" @click="preview">
          <Loader2 v-if="previewing" class="h-4 w-4 animate-spin" />
          <Eye v-else class="h-4 w-4" />
          {{ t("nacos.contentReplacePreview") }}
        </Button>
        <Button v-if="previewing" type="button" variant="outline" @click="cancelPreview"><Square class="h-3.5 w-3.5" />{{ t("nacos.cancel") }}</Button>
        <Button v-if="tab === 'replace' && plan?.items.length && !report" type="button" data-testid="nacos-replace-apply" :disabled="!canApply" @click="apply">
          <Loader2 v-if="applying" class="h-4 w-4 animate-spin" />
          {{ t("nacos.contentReplaceApply", { count: plan?.items.length ?? 0 }) }}
        </Button>
        <Button v-if="activeEntry && (tab === 'replace' || selectedHistoryId)" type="button" variant="outline" data-testid="nacos-replace-history-rollback" :disabled="!canRollback" @click="confirmOperation('rollback', activeEntry.id)">
          <Loader2 v-if="rollingBack" class="h-4 w-4 animate-spin" />
          <RotateCcw v-else class="h-4 w-4" />
          {{ t("nacos.contentReplaceRollback") }}
        </Button>
        <Button type="button" variant="outline" :disabled="busy" @click="closeDialog(false)">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <NacosConfigDiffDialog v-model:open="diffOpen" :before="diffItem?.beforeContent ?? ''" :after="diffItem?.afterContent ?? ''" :format="diffItem?.configType" :show-confirm="false" />
  <DangerConfirmDialog
    v-model:open="confirmOpen"
    :title="t(`nacos.replaceHistory.${confirmAction}Title`)"
    :message="t(`nacos.replaceHistory.${confirmAction}Confirm`)"
    :confirm-label="t(confirmAction === 'rollback' ? 'nacos.contentReplaceRollback' : 'nacos.replaceHistory.delete')"
    :close-on-confirm="false"
    :loading="rollingBack || deleting"
    @confirm="confirmedOperation"
  />
</template>

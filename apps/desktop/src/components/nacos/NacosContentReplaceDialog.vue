<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, CheckCircle2, Eye, Loader2, RotateCcw, Square } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import NacosConfigDiffDialog from "@/components/nacos/NacosConfigDiffDialog.vue";
import * as api from "@/lib/backend/api";
import { applyNacosContentReplacePlan, buildNacosContentReplacePlan, rollbackNacosContentReplace, type NacosContentReplacePlan, type NacosContentReplacePlanItem, type NacosContentReplaceReport, type NacosContentRollbackReport } from "@/lib/nacos/nacosContentReplace";
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
let previewSequence = 0;

const busy = computed(() => previewing.value || applying.value || rollingBack.value);
const canPreview = computed(() => !!search.value && search.value !== replacement.value && !busy.value && !props.readOnly);
const canApply = computed(() => !!plan.value?.items.length && !report.value && !busy.value && !props.readOnly);
const resultItemsByKey = computed(() => new Map(report.value?.items.map((item) => [item.key, item]) ?? []));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    reset();
  },
);

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
  plan.value = null;
  report.value = null;
  rollbackReport.value = null;
  previewing.value = false;
  applying.value = false;
  rollingBack.value = false;
  error.value = "";
  progress.value = null;
  activeOperationId.value = "";
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
    const result = await api.nacosSearchConfigContent(
      props.connectionId,
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
      const config = await api.nacosGetConfig(props.connectionId, { namespace: match.namespace, group: match.group, dataId: match.dataId });
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
    report.value = await applyNacosContentReplacePlan(plan.value, {
      getConfig: (key) => api.nacosGetConfig(props.connectionId, key),
      publishConfig: (request) => api.nacosPublishConfig(props.connectionId, request),
    });
    if (report.value.replaced) emit("changed");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    applying.value = false;
  }
}

async function rollback() {
  if (!report.value || rollingBack.value) return;
  rollingBack.value = true;
  error.value = "";
  try {
    rollbackReport.value = await rollbackNacosContentReplace(report.value, {
      getConfig: (key) => api.nacosGetConfig(props.connectionId, key),
      publishConfig: (request) => api.nacosPublishConfig(props.connectionId, request),
    });
    if (rollbackReport.value.restored) emit("changed");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    rollingBack.value = false;
  }
}

function showDiff(item: NacosContentReplacePlanItem) {
  diffItem.value = item;
  diffOpen.value = true;
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-5xl">
      <DialogHeader>
        <DialogTitle>{{ t("nacos.contentReplaceTitle") }}</DialogTitle>
        <DialogDescription>{{ t("nacos.contentReplaceDescription") }}</DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
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
        <div v-if="error" class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ error }}</span>
        </div>

        <section v-if="plan" class="space-y-3">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">{{ t("nacos.contentReplaceConfigCount", { count: plan.items.length }) }}</Badge>
            <Badge variant="outline">{{ t("nacos.contentReplaceOccurrenceCount", { count: plan.totalReplacements }) }}</Badge>
          </div>
          <div v-if="!plan.items.length" class="py-8 text-center text-sm text-muted-foreground">{{ t("nacos.contentReplaceNoMatches") }}</div>
          <div v-else class="divide-y rounded-md border">
            <div v-for="item in plan.items" :key="item.key" class="flex min-w-0 items-center gap-3 px-3 py-2.5">
              <div class="min-w-0 flex-1">
                <div class="truncate font-mono text-sm font-medium">{{ item.dataId }}</div>
                <div class="truncate text-xs text-muted-foreground">{{ item.namespace || "public" }} / {{ item.group }} · {{ t("nacos.contentReplaceOccurrenceCount", { count: item.replacements }) }}</div>
              </div>
              <Badge v-if="resultItemsByKey.get(item.key)" :variant="resultItemsByKey.get(item.key)?.status === 'replaced' ? 'secondary' : 'destructive'">
                {{ t(`nacos.contentReplaceStatus.${resultItemsByKey.get(item.key)?.status}`) }}
              </Badge>
              <Button type="button" size="icon" variant="ghost" :title="t('nacos.contentReplaceViewDiff')" :aria-label="t('nacos.contentReplaceViewDiff')" @click="showDiff(item)"><Eye class="h-4 w-4" /></Button>
            </div>
          </div>
        </section>

        <div v-if="report" class="flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">
          <CheckCircle2 class="mt-0.5 h-4 w-4 shrink-0" />
          <span>{{ t("nacos.contentReplaceReport", { replaced: report.replaced, conflicts: report.conflicts, failed: report.failed }) }}</span>
        </div>
        <div v-if="rollbackReport" class="text-sm text-muted-foreground">{{ t("nacos.contentReplaceRollbackReport", rollbackReport) }}</div>
      </div>

      <DialogFooter class="gap-2 border-t pt-4">
        <Button v-if="!report" type="button" variant="outline" data-testid="nacos-replace-preview" :disabled="!canPreview" @click="preview">
          <Loader2 v-if="previewing" class="h-4 w-4 animate-spin" />
          <Eye v-else class="h-4 w-4" />
          {{ t("nacos.contentReplacePreview") }}
        </Button>
        <Button v-if="previewing" type="button" variant="outline" @click="cancelPreview"><Square class="h-3.5 w-3.5" />{{ t("nacos.cancel") }}</Button>
        <Button v-if="plan?.items.length && !report" type="button" data-testid="nacos-replace-apply" :disabled="!canApply" @click="apply">
          <Loader2 v-if="applying" class="h-4 w-4 animate-spin" />
          {{ t("nacos.contentReplaceApply", { count: plan?.items.length ?? 0 }) }}
        </Button>
        <Button v-if="report?.replaced && !rollbackReport" type="button" variant="outline" :disabled="rollingBack" @click="rollback">
          <Loader2 v-if="rollingBack" class="h-4 w-4 animate-spin" />
          <RotateCcw v-else class="h-4 w-4" />
          {{ t("nacos.contentReplaceRollback") }}
        </Button>
        <Button type="button" variant="outline" :disabled="busy" @click="emit('update:open', false)">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <NacosConfigDiffDialog v-model:open="diffOpen" :before="diffItem?.beforeContent ?? ''" :after="diffItem?.afterContent ?? ''" :format="diffItem?.configType" :show-confirm="false" />
</template>

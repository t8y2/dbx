<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertTriangle, Archive, CheckCircle2, FileUp, Loader2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { NacosBatchPreview, NacosBatchReport, NacosConfigSelectionScope, NacosConflictPolicy, NacosNamespaceInfo } from "@/types/nacos";
import { nacosNamespaceIdentity } from "@/lib/nacos/nacosNamespaceVisibility";

export type NacosBatchDialogMode = "export" | "import" | "copy";

export interface NacosConfigTransferTarget {
  id: string;
  label: string;
}

const props = defineProps<{
  open: boolean;
  mode: NacosBatchDialogMode;
  loading: boolean;
  selectedCount: number;
  filteredCount: number;
  targetConnections: NacosConfigTransferTarget[];
  targetConnectionId: string;
  sourceConnectionId: string;
  namespaces: NacosNamespaceInfo[];
  currentNamespace: string;
  preview: NacosBatchPreview | null;
  report: NacosBatchReport | null;
  sourceName?: string;
  error?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  chooseFile: [];
  reset: [];
  targetConnectionChange: [connectionId: string];
  preview: [payload: { scope: NacosConfigSelectionScope; targetConnectionId: string; targetNamespace: string; policy: NacosConflictPolicy }];
  apply: [payload: { scope: NacosConfigSelectionScope; targetConnectionId: string; targetNamespace: string; policy: NacosConflictPolicy }];
  export: [scope: NacosConfigSelectionScope];
}>();

const { t } = useI18n();
const scope = ref<NacosConfigSelectionScope>("selected");
const policy = ref<NacosConflictPolicy>("ABORT");
const targetNamespace = ref("");

const titleKey = computed(() => `nacos.batch${props.mode[0].toUpperCase()}${props.mode.slice(1)}Title`);
const descriptionKey = computed(() => `nacos.batch${props.mode[0].toUpperCase()}${props.mode.slice(1)}Description`);
const targetNamespaces = computed(() => props.namespaces.filter((item) => props.targetConnectionId !== props.sourceConnectionId || nacosNamespaceIdentity(item.namespace) !== nacosNamespaceIdentity(props.currentNamespace)));
const selectedTargetNamespace = computed(() => {
  try {
    const namespace = JSON.parse(targetNamespace.value);
    return typeof namespace === "string" ? namespace : "";
  } catch {
    return "";
  }
});
const canContinue = computed(() => {
  if (props.mode === "import") return !!props.sourceName;
  if (props.mode === "copy") return !!props.targetConnectionId && targetNamespace.value !== "" && (scope.value !== "selected" || props.selectedCount > 0);
  return scope.value !== "selected" || props.selectedCount > 0;
});
const hasPreviewBlockingErrors = computed(() => !!props.preview && (props.preview.invalid > 0 || (policy.value === "ABORT" && props.preview.conflicts > 0)));
const reportWritten = computed(() => (props.report?.created ?? 0) + (props.report?.overwritten ?? 0));
const reportProcessed = computed(() => reportWritten.value + (props.report?.skipped ?? 0) + (props.report?.failed ?? 0));
const reportNeedsAttention = computed(() => !!props.report && (props.report.aborted || props.report.partial || props.report.cancelled || props.report.failed > 0));
const reportSummaryClass = computed(() => {
  if (props.report?.failed) return "text-destructive";
  return reportNeedsAttention.value ? "text-amber-600" : "text-emerald-600";
});
const reportSummary = computed(() => {
  const report = props.report;
  if (!report) return "";
  if (report.aborted) return t("nacos.batchAborted");
  if (report.cancelled) return t("nacos.batchCancelledSummary", { processed: reportProcessed.value, total: report.total });
  if (report.failed) return t("nacos.batchFailedSummary", { written: reportWritten.value, failed: report.failed });
  if (report.partial) return t("nacos.batchPartialSummary", { processed: reportProcessed.value, total: report.total });
  if (report.skipped) return t("nacos.batchFinishedWithSkipped", { written: reportWritten.value, skipped: report.skipped });
  return t("nacos.batchFinished", { written: reportWritten.value });
});

const batchStatusKeys: Record<string, string> = {
  create: "nacos.batchStatusCreate",
  conflict: "nacos.batchStatusConflict",
  invalid: "nacos.batchStatusInvalid",
  created: "nacos.batchStatusCreated",
  overwritten: "nacos.batchStatusOverwritten",
  skipped: "nacos.batchStatusSkipped",
  failed: "nacos.batchStatusFailed",
  aborted: "nacos.batchStatusAborted",
  exported: "nacos.batchStatusExported",
};

function batchStatusLabel(status: string) {
  return t(batchStatusKeys[status] ?? "nacos.batchStatusUnknown", { status });
}

function batchStatusClass(status: string) {
  if (["create", "created", "overwritten", "exported"].includes(status)) return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (["conflict", "skipped", "aborted"].includes(status)) return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  if (["invalid", "failed"].includes(status)) return "border-destructive/30 bg-destructive/10 text-destructive";
  return "text-muted-foreground";
}

function resetTargetNamespace() {
  if (targetNamespaces.value.some((item) => JSON.stringify(item.namespace) === targetNamespace.value)) return;
  targetNamespace.value = targetNamespaces.value[0] ? JSON.stringify(targetNamespaces.value[0].namespace) : "";
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    scope.value = props.selectedCount ? "selected" : "filtered";
    policy.value = "ABORT";
    resetTargetNamespace();
  },
  { immediate: true },
);

watch(
  () => props.targetConnectionId,
  () => {
    targetNamespace.value = "";
  },
);

watch(targetNamespaces, () => {
  if (props.open) resetTargetNamespace();
});
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="flex max-h-[82vh] flex-col overflow-hidden sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{{ t(titleKey) }}</DialogTitle>
        <DialogDescription>{{ t(descriptionKey) }}</DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1 space-y-4 overflow-auto">
        <div v-if="mode !== 'import'" class="space-y-2">
          <div class="text-sm font-medium">{{ t("nacos.exportScope") }}</div>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="scope" type="radio" name="nacos-batch-scope" value="selected" @change="emit('reset')" />
            <span>{{ t("nacos.selectedConfigs", { count: selectedCount }) }}</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="scope" type="radio" name="nacos-batch-scope" value="filtered" @change="emit('reset')" />
            <span>{{ t("nacos.filteredConfigs", { count: filteredCount }) }}</span>
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="scope" type="radio" name="nacos-batch-scope" value="namespace" @change="emit('reset')" />
            <span>{{ t("nacos.namespaceAllConfigs") }}</span>
          </label>
        </div>

        <div v-if="mode === 'import'" class="rounded-md border p-3">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium">{{ t("nacos.importArchive") }}</div>
              <div class="truncate text-xs text-muted-foreground">{{ sourceName || t("nacos.noArchiveSelected") }}</div>
            </div>
            <Button variant="outline" size="sm" :disabled="loading" @click="emit('chooseFile')">
              <FileUp class="mr-2 h-4 w-4" />
              {{ t("nacos.chooseZip") }}
            </Button>
          </div>
          <div class="mt-3 flex items-start gap-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
            <span>{{ t("nacos.importSensitiveWarning") }}</span>
          </div>
        </div>

        <div v-if="mode === 'copy'" class="space-y-2">
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <div class="text-sm font-medium">{{ t("nacos.targetConnection") }}</div>
              <select
                :value="targetConnectionId"
                class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                :disabled="loading || !targetConnections.length"
                @change="
                  emit('targetConnectionChange', ($event.target as HTMLSelectElement).value);
                  emit('reset');
                "
              >
                <option disabled value="">{{ t("nacos.chooseTargetConnection") }}</option>
                <option v-for="connection in targetConnections" :key="connection.id" :value="connection.id">{{ connection.label }}</option>
              </select>
              <p v-if="!targetConnections.length" class="text-xs text-muted-foreground">{{ t("nacos.noTargetConnections") }}</p>
            </div>

            <div class="space-y-2">
              <div class="text-sm font-medium">{{ t("nacos.targetNamespace") }}</div>
              <select v-model="targetNamespace" class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" :disabled="loading || !targetConnectionId" @change="emit('reset')">
                <option disabled value="">{{ t("nacos.chooseTargetNamespace") }}</option>
                <option v-for="item in targetNamespaces" :key="item.namespace" :value="JSON.stringify(item.namespace)">{{ item.namespaceShowName || item.namespace || "public" }}</option>
              </select>
            </div>
          </div>
          <p class="text-xs text-muted-foreground">{{ t("nacos.copyKeepsSource") }}</p>
        </div>

        <div v-if="mode !== 'export'" class="space-y-2">
          <div class="text-sm font-medium">{{ t("nacos.conflictPolicy") }}</div>
          <div class="grid gap-2 sm:grid-cols-3">
            <label v-for="value in ['ABORT', 'SKIP', 'OVERWRITE'] as NacosConflictPolicy[]" :key="value" class="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm" :class="{ 'border-primary bg-primary/5': policy === value }">
              <input v-model="policy" type="radio" name="nacos-batch-policy" :value="value" />
              <span>
                <span class="block font-medium">{{ t(`nacos.policy${value}`) }}</span>
                <span class="block text-xs text-muted-foreground">{{ t(`nacos.policy${value}Hint`) }}</span>
              </span>
            </label>
          </div>
          <div v-if="policy === 'OVERWRITE'" class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
            <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
            <span>{{ t("nacos.overwriteWarning") }}</span>
          </div>
        </div>

        <div v-if="preview" class="space-y-2">
          <div class="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{{ t("nacos.previewTotal", { count: preview.total }) }}</Badge>
            <Badge variant="outline" class="text-emerald-600">{{ t("nacos.previewCreated", { count: preview.created }) }}</Badge>
            <Badge variant="outline" class="text-amber-600">{{ t("nacos.previewConflicts", { count: preview.conflicts }) }}</Badge>
            <Badge v-if="preview.invalid" variant="outline" class="text-destructive">{{ t("nacos.previewInvalid", { count: preview.invalid }) }}</Badge>
          </div>
          <div class="max-h-52 overflow-auto rounded-md border text-xs">
            <div v-for="item in preview.items" :key="`${item.namespace}\u0000${item.group}\u0000${item.dataId}`" class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b px-3 py-2 last:border-b-0">
              <div class="min-w-0">
                <div class="truncate font-medium">{{ item.dataId }}</div>
                <div class="truncate text-muted-foreground">{{ item.group }} · {{ item.namespace || "public" }}</div>
                <div v-if="item.message" class="break-all text-destructive">{{ item.message }}</div>
              </div>
              <Badge variant="outline" :class="batchStatusClass(item.status)">{{ batchStatusLabel(item.status) }}</Badge>
            </div>
          </div>
        </div>

        <div v-if="report" class="space-y-2">
          <div class="flex items-center gap-2 text-sm font-medium" :class="reportSummaryClass">
            <component :is="reportNeedsAttention ? AlertTriangle : CheckCircle2" class="h-4 w-4" />
            {{ reportSummary }}
          </div>
          <div class="flex flex-wrap gap-2">
            <Badge variant="outline">{{ t("nacos.reportWritten", { count: reportWritten }) }}</Badge>
            <Badge v-if="report.created" variant="outline" class="text-emerald-600">{{ t("nacos.reportCreated", { count: report.created }) }}</Badge>
            <Badge v-if="report.overwritten" variant="outline" class="text-emerald-600">{{ t("nacos.reportOverwritten", { count: report.overwritten }) }}</Badge>
            <Badge v-if="report.skipped" variant="outline" class="text-amber-600">{{ t("nacos.reportSkipped", { count: report.skipped }) }}</Badge>
            <Badge v-if="report.failed" variant="outline" class="text-destructive">{{ t("nacos.reportFailed", { count: report.failed }) }}</Badge>
            <Badge v-if="report.cancelled" variant="outline" class="text-amber-600">{{ t("nacos.batchCancelled") }}</Badge>
          </div>
          <div v-if="report.items.length" class="max-h-52 overflow-auto rounded-md border text-xs">
            <div class="border-b bg-muted/30 px-3 py-2 font-medium text-foreground">{{ t("nacos.reportItems", { count: report.items.length }) }}</div>
            <div v-for="item in report.items" :key="`${item.namespace}\u0000${item.group}\u0000${item.dataId}`" class="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b px-3 py-2 last:border-b-0">
              <div class="min-w-0">
                <div class="truncate font-medium">{{ item.dataId }}</div>
                <div class="truncate text-muted-foreground">{{ item.group }} · {{ item.namespace || "public" }}</div>
                <div v-if="item.message" class="break-all text-destructive">{{ item.message }}</div>
              </div>
              <Badge variant="outline" :class="batchStatusClass(item.status)">{{ batchStatusLabel(item.status) }}</Badge>
            </div>
          </div>
        </div>

        <p v-if="error && !report" class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{{ error }}</p>
      </div>

      <DialogFooter>
        <Button :variant="report ? 'default' : 'outline'" :disabled="loading" @click="emit('update:open', false)">{{ t("common.close") }}</Button>
        <template v-if="!report">
          <Button v-if="mode === 'export'" :disabled="loading || !canContinue" @click="emit('export', scope)">
            <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
            <Archive v-else class="mr-2 h-4 w-4" />
            {{ t("nacos.exportZip") }}
          </Button>
          <template v-else>
            <Button v-if="!preview" :disabled="loading || !canContinue" @click="emit('preview', { scope, targetConnectionId, targetNamespace: selectedTargetNamespace, policy })">
              <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
              {{ t("nacos.preview") }}
            </Button>
            <Button v-else :variant="policy === 'OVERWRITE' ? 'destructive' : 'default'" :disabled="loading || hasPreviewBlockingErrors" @click="emit('apply', { scope, targetConnectionId, targetNamespace: selectedTargetNamespace, policy })">
              <Loader2 v-if="loading" class="mr-2 h-4 w-4 animate-spin" />
              {{ t("nacos.apply") }}
            </Button>
          </template>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

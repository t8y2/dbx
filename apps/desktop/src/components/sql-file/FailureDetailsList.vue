<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Check, ChevronRight, Copy } from "@lucide/vue";

import { Button } from "@/components/ui/button";
import { sqlFileFailureCopyText } from "@/components/export/failureDetailCopyText";
import { useSqlFileFailureLog } from "@/composables/useSqlFileFailureLog";
import type { SqlFileFailure } from "@/composables/useExportTracker";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { failureLogRowKey } from "@/lib/export/failureLogExport";
import { translateBackendError } from "@/i18n/backend-errors";

const props = withDefaults(
  defineProps<{
    executionId?: string;
    failures: SqlFileFailure[];
    /** Failures the backend logged but this in-memory list dropped. */
    omitted: number;
    fileNameHint: string;
    /** Only affects paddings/sizes so each surface keeps its own density. */
    variant?: "dialog" | "popover";
  }>(),
  { executionId: undefined, variant: "dialog" },
);

/** Owned locally unless a parent binds it (the execution dialog auto-expands on failure). */
const expanded = defineModel<boolean>("expanded", { default: false });

const { t } = useI18n();
const { toast } = useToast();

const failureLog = useSqlFileFailureLog({
  executionId: () => props.executionId,
  failures: () => props.failures,
  omittedFailures: () => props.omitted,
  fileNameHint: () => props.fileNameHint,
});
const { selectedCount, allSelected, coverage, logWarning, logUnavailable, busy, info } = failureLog;

const totalFailures = computed(() => props.failures.length + props.omitted);
const listClass = computed(() => (props.variant === "popover" ? "max-h-44 overflow-y-auto rounded border border-destructive/20 bg-destructive/5 text-xs" : "max-h-[min(30vh,280px)] min-w-0 overflow-y-auto rounded-md border border-destructive/20 bg-destructive/5 text-xs"));
const rowClass = computed(() => (props.variant === "popover" ? "border-b border-destructive/15 px-2.5 py-2 last:border-b-0" : "border-b border-destructive/15 p-2.5 last:border-b-0"));

// Per-row copy keeps the existing single-failure behaviour; the bulk actions
// above copy/export the full statements from the backend log instead.
const copiedRowKey = ref("");
let copiedRowTimer: ReturnType<typeof setTimeout> | undefined;

onBeforeUnmount(() => {
  if (copiedRowTimer) clearTimeout(copiedRowTimer);
});

async function copyRow(failure: SqlFileFailure): Promise<void> {
  const key = failureLogRowKey(failure);
  try {
    await copyToClipboard(sqlFileFailureCopyText(failure, translateBackendError(t, failure.error)));
    copiedRowKey.value = key;
    if (copiedRowTimer) clearTimeout(copiedRowTimer);
    copiedRowTimer = setTimeout(() => {
      if (copiedRowKey.value === key) copiedRowKey.value = "";
      copiedRowTimer = undefined;
    }, 2000);
    toast(t("exportProgress.failureDetailCopied"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast(t("exportProgress.failureDetailCopyFailed", { message: translateBackendError(t, message) }), 5000);
  }
}
</script>

<template>
  <div class="min-w-0 space-y-1.5">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <button type="button" class="flex items-center gap-1 text-xs font-medium text-foreground hover:text-primary" :aria-expanded="expanded" @click="expanded = !expanded">
        <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform" :class="{ 'rotate-90': expanded }" />
        {{ expanded ? t("exportProgress.hideFailureDetails") : t("exportProgress.showFailureDetails", { count: totalFailures }) }}
      </button>
      <div class="ml-auto flex flex-wrap items-center gap-x-2 gap-y-1">
        <label class="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
          <input type="checkbox" class="h-3.5 w-3.5 accent-primary" :checked="allSelected" @change="failureLog.toggleAll()" />
          {{ t("exportProgress.failureLog.selectAll") }}
        </label>
        <span v-if="selectedCount > 0" class="text-xs text-muted-foreground">{{ t("exportProgress.failureLog.selectedCount", { count: selectedCount }) }}</span>
        <Button variant="outline" size="sm" class="h-6 px-2 text-xs" :disabled="selectedCount === 0 || busy" @click="failureLog.copySelected()">{{ t("exportProgress.failureLog.copySelected") }}</Button>
        <Button variant="outline" size="sm" class="h-6 px-2 text-xs" :disabled="busy || logUnavailable" @click="failureLog.exportLog('txt', 'all')">{{ t("exportProgress.failureLog.exportTxt") }}</Button>
        <Button variant="outline" size="sm" class="h-6 px-2 text-xs" :disabled="busy || logUnavailable" @click="failureLog.exportLog('csv', 'all')">{{ t("exportProgress.failureLog.exportCsv") }}</Button>
        <Button v-if="selectedCount > 0" variant="outline" size="sm" class="h-6 px-2 text-xs" :disabled="busy || logUnavailable" @click="failureLog.exportLog('txt', 'selected')">{{ t("exportProgress.failureLog.exportSelected") }}</Button>
        <Button v-if="info?.path" variant="outline" size="sm" class="h-6 px-2 text-xs" @click="failureLog.openLogFolder()">{{ t("exportProgress.failureLog.openFolder") }}</Button>
      </div>
    </div>
    <!-- The list is capped while the log keeps every failure: say so instead of
         letting the export/UI counts silently disagree. -->
    <p v-if="coverage.truncated" class="text-xs text-muted-foreground">
      {{ t("exportProgress.failureLog.listTruncated", { visible: failures.length, total: totalFailures }) }}
    </p>
    <p v-if="logWarning" class="text-xs text-destructive">{{ logWarning }}</p>
    <div v-if="expanded" :class="listClass">
      <div v-for="failure in failures" :key="failureLogRowKey(failure)" :class="rowClass">
        <div class="flex min-w-0 items-start justify-between gap-2">
          <label class="flex min-w-0 items-start gap-2">
            <input type="checkbox" class="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary" :checked="failureLog.isSelected(failure)" :aria-label="`#${failure.statementIndex}`" @change="failureLog.toggleSelection(failure)" />
            <span class="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
              <span class="shrink-0">#{{ failure.statementIndex }}</span>
              <span v-if="failure.fileName" class="truncate text-muted-foreground" :title="failure.fileName">{{ failure.fileName }}</span>
            </span>
          </label>
          <button
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
            :title="copiedRowKey === failureLogRowKey(failure) ? t('exportProgress.failureDetailCopied') : t('exportProgress.copyFailureDetail')"
            :aria-label="copiedRowKey === failureLogRowKey(failure) ? t('exportProgress.failureDetailCopied') : t('exportProgress.copyFailureDetail')"
            @click.stop="copyRow(failure)"
          >
            <Check v-if="copiedRowKey === failureLogRowKey(failure)" class="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
            <Copy v-else class="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" aria-hidden="true" />
          </button>
        </div>
        <div v-if="failure.statementSummary" class="mt-1 max-w-full overflow-auto font-mono whitespace-pre-wrap break-words text-foreground">{{ failure.statementSummary }}</div>
        <div class="mt-1 select-text whitespace-pre-wrap break-words text-destructive">{{ translateBackendError(t, failure.error) }}</div>
        <div v-if="failure.truncated" class="mt-1 text-muted-foreground">{{ t("exportProgress.failureDetailTruncated") }}</div>
      </div>
      <div v-if="omitted" class="p-2.5 text-muted-foreground">{{ t("exportProgress.failureDetailsOmitted", { count: omitted }) }}</div>
    </div>
  </div>
</template>

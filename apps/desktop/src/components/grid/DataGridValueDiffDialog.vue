<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { AlertCircle, FileDiff } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import SideBySideTextDiff, { type TextDiffSide } from "@/components/common/SideBySideTextDiff.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatJsonValueDiffText, type JsonValueDiffFormatError, type JsonValueDiffMode, type JsonValueDiffSnapshot } from "@/lib/dataGrid/jsonValueDiff";

const props = defineProps<{
  snapshot: Readonly<JsonValueDiffSnapshot> | null;
}>();

const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const { toast } = useToast();
const formatMode = ref<JsonValueDiffMode>("json");
const originalFormatted = computed(() => formatJsonValueDiffText(props.snapshot?.originalValue ?? "", formatMode.value));
const currentFormatted = computed(() => formatJsonValueDiffText(props.snapshot?.currentValue ?? "", formatMode.value));

function formatError(error: JsonValueDiffFormatError): string {
  if (error.kind === "too-large") return t("grid.valueDiffTooLarge", { limit: error.limit.toLocaleString() });
  return t("grid.valueDiffInvalidJson", { message: error.message });
}

async function copyValue(side: TextDiffSide) {
  const snapshot = props.snapshot;
  if (!snapshot) return;
  try {
    await copyToClipboard(side === "before" ? snapshot.originalValue : snapshot.currentValue);
    toast(t("grid.cellValueCopied"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

watch(open, (isOpen) => {
  if (isOpen) formatMode.value = "json";
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="snapshot" class="flex h-[min(82vh,760px)] min-w-0 max-w-[min(1180px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1180px,calc(100vw-32px))]">
      <DialogHeader class="shrink-0 border-b px-4 py-3 pr-11">
        <DialogTitle class="flex min-w-0 items-center gap-2 text-sm">
          <FileDiff class="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <span class="min-w-0 truncate">{{ t("grid.valueDiffTitle", { column: snapshot.columnName }) }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="flex h-9 shrink-0 items-center gap-3 border-b px-3">
        <div class="inline-flex h-7 items-center rounded border bg-muted/20 p-0.5" role="group" :aria-label="t('grid.valueDiffFormat')">
          <Button type="button" size="sm" :variant="formatMode === 'json' ? 'secondary' : 'ghost'" class="h-6 rounded-sm px-2 text-[11px] shadow-none" @click="formatMode = 'json'">JSON</Button>
          <Button type="button" size="sm" :variant="formatMode === 'raw' ? 'secondary' : 'ghost'" class="h-6 rounded-sm px-2 text-[11px] shadow-none" @click="formatMode = 'raw'">{{ t("grid.valueDiffRaw") }}</Button>
        </div>
      </div>

      <div v-if="originalFormatted.error || currentFormatted.error" class="grid shrink-0 grid-cols-2 border-b bg-amber-500/10 text-[11px] text-amber-700 dark:text-amber-300">
        <div class="flex min-w-0 items-start gap-1.5 border-r px-2 py-1">
          <template v-if="originalFormatted.error"
            ><AlertCircle class="mt-0.5 h-3 w-3 shrink-0" /><span class="min-w-0 break-words">{{ formatError(originalFormatted.error) }}</span></template
          >
        </div>
        <div class="flex min-w-0 items-start gap-1.5 px-2 py-1">
          <template v-if="currentFormatted.error"
            ><AlertCircle class="mt-0.5 h-3 w-3 shrink-0" /><span class="min-w-0 break-words">{{ formatError(currentFormatted.error) }}</span></template
          >
        </div>
      </div>

      <SideBySideTextDiff
        :before-text="originalFormatted.text"
        :after-text="currentFormatted.text"
        :before-label="t('grid.valueDiffOriginal')"
        :after-label="t('grid.valueDiffCurrent')"
        :copy-before-title="t('grid.copyOriginalValue')"
        :copy-after-title="t('grid.copyCurrentValue')"
        @copy="copyValue"
      />
    </DialogContent>
  </Dialog>
</template>

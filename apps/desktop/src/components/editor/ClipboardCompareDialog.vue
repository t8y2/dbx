<script setup lang="ts">
import { FileDiff } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import SideBySideTextDiff, { type TextDiffSide } from "@/components/common/SideBySideTextDiff.vue";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";

export interface ClipboardCompareSnapshot {
  editorText: string;
  clipboardText: string;
  /** True when only the selected text of the editor is compared, not the whole document. */
  selectionOnly: boolean;
}

const props = defineProps<{
  snapshot: Readonly<ClipboardCompareSnapshot> | null;
}>();

const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const { toast } = useToast();

async function copySide(side: TextDiffSide) {
  const snapshot = props.snapshot;
  if (!snapshot) return;
  try {
    await copyToClipboard(side === "before" ? snapshot.editorText : snapshot.clipboardText);
    toast(t("editor.clipboardCompare.copied"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent v-if="snapshot" class="flex h-[min(82vh,760px)] min-w-0 max-w-[min(1180px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1180px,calc(100vw-32px))]">
      <DialogHeader class="shrink-0 border-b px-4 py-3 pr-11">
        <DialogTitle class="flex min-w-0 items-center gap-2 text-sm">
          <FileDiff class="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
          <span class="min-w-0 truncate">{{ t("editor.clipboardCompare.title") }}</span>
        </DialogTitle>
      </DialogHeader>

      <SideBySideTextDiff
        :before-text="snapshot.editorText"
        :after-text="snapshot.clipboardText"
        :before-label="snapshot.selectionOnly ? t('editor.clipboardCompare.selection') : t('editor.clipboardCompare.editor')"
        :after-label="t('editor.clipboardCompare.clipboard')"
        :copy-before-title="snapshot.selectionOnly ? t('editor.clipboardCompare.copySelection') : t('editor.clipboardCompare.copyEditor')"
        :copy-after-title="t('editor.clipboardCompare.copyClipboard')"
        @copy="copySide"
      />
    </DialogContent>
  </Dialog>
</template>

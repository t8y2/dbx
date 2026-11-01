<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Copy } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import type { DataGridSqlPreview } from "./dataGridSqlPreview";

const props = defineProps<{ preview: DataGridSqlPreview; canOpenQuery: boolean }>();
const emit = defineEmits<{ close: []; openQuery: [sql: string] }>();
const { t } = useI18n();
const { toast } = useToast();
// The host mounts a fresh dialog for each snapshot; background refreshes never replace the draft.
const draft = ref(props.preview.sql);

async function copySql(sql: string) {
  try {
    await copyToClipboard(sql);
    toast(t("grid.copied"));
  } catch (error: unknown) {
    toast(t("grid.copyFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  }
}
</script>

<template>
  <Dialog :open="true" @update:open="!$event && emit('close')">
    <DialogContent class="flex max-h-[calc(var(--dbx-viewport-height)-2rem)] flex-col sm:max-w-3xl">
      <DialogHeader>
        <DialogTitle>{{ t("grid.viewQuerySql") }}</DialogTitle>
        <DialogDescription>{{ t("grid.sqlPreviewDraftHint") }}</DialogDescription>
      </DialogHeader>
      <div class="min-h-0 flex-1 overflow-auto space-y-3">
        <div class="text-xs font-medium">{{ preview.isCurrentPage ? t("grid.currentPageSql") : "SQL" }} · {{ t("grid.sqlPreviewDraft") }}</div>
        <textarea
          v-model="draft"
          data-native-clipboard
          :aria-label="t('grid.sqlPreviewDraft')"
          spellcheck="false"
          class="block h-[40vh] min-h-32 w-full resize-none overflow-auto rounded-md border border-input bg-background p-3 font-mono text-xs leading-relaxed select-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <p v-if="preview.probeLimit !== undefined" class="text-xs text-muted-foreground">{{ t("grid.pageProbeDescription", { count: preview.probeLimit }) }}</p>
        <details v-if="preview.actualSql && preview.actualSql.trim() !== preview.sql.trim()" class="rounded-md border p-3">
          <summary class="cursor-pointer text-xs font-medium">{{ t("grid.actualExecutionSql") }}</summary>
          <textarea :value="preview.actualSql" readonly data-native-clipboard :aria-label="t('grid.actualExecutionSql')" class="mt-2 block h-32 w-full resize-none overflow-auto bg-background p-2 font-mono text-xs leading-relaxed select-text" />
          <Button variant="outline" size="sm" class="mt-2" @click="copySql(preview.actualSql)"><Copy class="mr-1 h-3 w-3" />{{ t("grid.copyActualExecutionSql") }}</Button>
        </details>
      </div>
      <DialogFooter class="shrink-0">
        <Button variant="outline" @click="emit('close')">{{ t("common.close") }}</Button>
        <Button variant="outline" :disabled="!draft.trim()" @click="copySql(draft)"><Copy class="mr-1 h-3 w-3" />{{ t("grid.copyQuerySql") }}</Button>
        <Button :disabled="!canOpenQuery || !draft.trim()" @click="emit('openQuery', draft)">{{ t("grid.openSqlInNewQuery") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

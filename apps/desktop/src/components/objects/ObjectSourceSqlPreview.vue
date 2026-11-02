<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Eye, Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import SqlPreviewPanel from "@/components/editor/SqlPreviewPanel.vue";
import { buildExecutableObjectSourceStatements, type BuildEditableObjectSourceSqlInput } from "@/lib/table/objectSourceEditor";

const props = defineProps<{ input: BuildEditableObjectSourceSqlInput; contextKey: string; disabled?: boolean }>();
const { t } = useI18n();
const open = ref(false);
const loading = ref(false);
const sql = ref("");
const error = ref("");
let serial = 0;

function invalidate() {
  serial++;
  open.value = false;
  loading.value = false;
  sql.value = "";
  error.value = "";
}
watch(() => JSON.stringify([props.input, props.contextKey, props.disabled]), invalidate);
onBeforeUnmount(invalidate);
watch(open, (value) => {
  if (!value) serial++;
});

async function preview() {
  if (props.disabled || !props.input.source.trim()) return;
  const request = ++serial;
  const input = { ...props.input };
  open.value = true;
  loading.value = true;
  sql.value = "";
  error.value = "";
  try {
    // The same pure builder used by Save; never prepare or execute a write here.
    const statements = await buildExecutableObjectSourceStatements(input);
    if (request === serial && open.value) sql.value = statements.filter((statement) => statement.trim()).join("\n\n");
  } catch (cause) {
    if (request === serial && open.value) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (request === serial) loading.value = false;
  }
}
</script>

<template>
  <Button variant="outline" size="icon" class="h-7 w-7 shrink-0" :title="t('contextMenu.sqlPreview')" :aria-label="t('contextMenu.sqlPreview')" :disabled="disabled || !input.source.trim()" @click="preview"><Eye class="h-4 w-4" /></Button>
  <Dialog v-model:open="open">
    <DialogContent class="flex h-[min(75vh,640px)] w-[calc(100vw-2rem)] max-w-4xl flex-col overflow-hidden">
      <DialogHeader
        ><DialogTitle class="break-words">{{ t("contextMenu.sqlPreview") }} - {{ input.name }}</DialogTitle></DialogHeader
      >
      <div v-if="loading" class="flex min-h-0 flex-1 items-center justify-center" role="status"><Loader2 class="h-5 w-5 animate-spin" :aria-label="t('common.loading')" /></div>
      <div v-else-if="error" class="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words text-sm text-destructive" role="alert">{{ error }}</div>
      <SqlPreviewPanel v-else :sql="sql" class="min-h-0 flex-1" @close="open = false" />
      <DialogFooter
        ><Button variant="outline" @click="open = false">{{ t("common.close") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>

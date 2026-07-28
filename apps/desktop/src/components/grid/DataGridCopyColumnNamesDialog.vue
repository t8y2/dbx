<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { COLUMN_NAME_COPY_SEPARATOR_LABELS, COLUMN_NAME_COPY_SEPARATOR_OPTIONS, formatColumnNamesForCopy, isColumnNameCopySeparator, loadColumnNameCopySeparator, saveColumnNameCopySeparator, supportsColumnNameQuoting, type ColumnNameCopySeparator } from "@/lib/dataGrid/dataGridColumnNameCopy";
import type { DatabaseType } from "@/types/database";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ columnNames: string[]; databaseType?: DatabaseType }>();
const emit = defineEmits<{ copy: [text: string] }>();

const separator = ref<ColumnNameCopySeparator>(loadColumnNameCopySeparator());
const quote = ref(false);

// 每次打开时重新读取上次分隔符选择；转义选项每次默认关闭
watch(open, (value) => {
  if (!value) return;
  separator.value = loadColumnNameCopySeparator();
  quote.value = false;
});

const showQuoteOption = computed(() => supportsColumnNameQuoting(props.databaseType));

const previewText = computed(() => formatColumnNamesForCopy(props.columnNames, { separator: separator.value, quote: quote.value, databaseType: props.databaseType }));

function onSeparatorChange(value: unknown) {
  if (isColumnNameCopySeparator(value)) separator.value = value;
}

function confirmCopy() {
  saveColumnNameCopySeparator(separator.value);
  emit("copy", previewText.value);
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[440px]">
      <DialogHeader
        ><DialogTitle>{{ t("grid.copyColumnNamesTitle", { count: columnNames.length }) }}</DialogTitle></DialogHeader
      >
      <div class="space-y-3">
        <div class="flex items-center justify-between gap-3">
          <Label class="shrink-0 text-sm">{{ t("grid.copyColumnNamesSeparator") }}</Label>
          <Select :model-value="separator" @update:model-value="onSeparatorChange">
            <SelectTrigger class="h-8 w-44 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              <SelectItem v-for="option in COLUMN_NAME_COPY_SEPARATOR_OPTIONS" :key="option" :value="option" class="dbx-data-grid-value-font text-xs">{{ COLUMN_NAME_COPY_SEPARATOR_LABELS[option] }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="showQuoteOption" class="flex items-center justify-between gap-3">
          <Label class="shrink-0 text-sm" for="copy-column-names-quote">{{ t("grid.copyColumnNamesQuote") }}</Label>
          <Switch id="copy-column-names-quote" v-model="quote" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-sm">{{ t("grid.copyColumnNamesPreview") }}</Label>
          <pre class="dbx-data-grid-value-font max-h-40 min-h-16 w-full overflow-auto whitespace-pre-wrap break-all rounded-[6px] border border-input bg-muted/30 px-2.5 py-1.5 text-xs" data-copy-column-names-preview>{{ previewText }}</pre>
        </div>
      </div>
      <DialogFooter
        ><Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button
        ><Button @click="confirmCopy">{{ t("grid.copy") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>

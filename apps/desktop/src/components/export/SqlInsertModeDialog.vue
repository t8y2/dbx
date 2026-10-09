<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { SqlExportColumnSelection, SqlExportOptions, SqlInsertMode } from "@/lib/export/sqlInsertMode";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ allowSplit?: boolean; columns?: SqlExportColumnSelection[] }>();
const selected = ref<SqlInsertMode>("batch");
const selectedColumnIndexes = ref(props.columns?.map((column) => column.sourceIndex) ?? []);
const splitSqlOutput = ref(false);
const splitSqlPartMaxMb = ref(100);
const MIN_SPLIT_SQL_PART_MB = 1;
const MAX_SPLIT_SQL_PART_MB = 4096;
let outcomeEmitted = false;
const columnSelectionEnabled = computed(() => props.columns !== undefined);
const selectedColumnSet = computed(() => new Set(selectedColumnIndexes.value));
const selectedColumns = computed(() => props.columns?.filter((column) => selectedColumnSet.value.has(column.sourceIndex)) ?? []);
const canConfirm = computed(() => !columnSelectionEnabled.value || selectedColumns.value.length > 0);
const duplicateColumnNames = computed(() => {
  const counts = new Map<string, number>();
  for (const column of props.columns ?? []) counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
  return new Set([...counts].flatMap(([name, count]) => (count > 1 ? [name] : [])));
});

const emit = defineEmits<{
  confirm: [options: SqlExportOptions];
  cancel: [];
}>();

function normalizedSplitSqlPartMaxMb(): number {
  const value = Number(splitSqlPartMaxMb.value);
  if (!Number.isFinite(value)) return 100;
  return Math.min(MAX_SPLIT_SQL_PART_MB, Math.max(MIN_SPLIT_SQL_PART_MB, Math.round(value)));
}

function onConfirm() {
  if (!canConfirm.value) return;
  outcomeEmitted = true;
  open.value = false;
  emit("confirm", {
    insertMode: selected.value,
    splitMaxMb: props.allowSplit && splitSqlOutput.value ? normalizedSplitSqlPartMaxMb() : undefined,
    ...(columnSelectionEnabled.value ? { selectedColumns: selectedColumns.value } : {}),
  });
}

function selectAllColumns() {
  selectedColumnIndexes.value = props.columns?.map((column) => column.sourceIndex) ?? [];
}

function clearColumns() {
  selectedColumnIndexes.value = [];
}

function onCancel() {
  if (outcomeEmitted) return;
  outcomeEmitted = true;
  open.value = false;
  emit("cancel");
}

function onOpenChange(value: boolean) {
  if (!value) onCancel();
}
</script>

<template>
  <Dialog v-model:open="open" @update:open="onOpenChange">
    <DialogContent class="sm:max-w-md" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("grid.sqlInsertModeTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-3 py-2">
        <p class="text-sm text-muted-foreground">{{ t("grid.sqlInsertModePrompt") }}</p>
        <label class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50">
          <input v-model="selected" type="radio" value="batch" class="mt-0.5 h-4 w-4 shrink-0" data-sql-insert-mode="batch" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t("grid.sqlInsertModeBatch") }}</span>
            <span class="mt-1 block text-xs text-muted-foreground">{{ t("grid.sqlInsertModeBatchDescription") }}</span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent/50">
          <input v-model="selected" type="radio" value="single" class="mt-0.5 h-4 w-4 shrink-0" data-sql-insert-mode="single" />
          <span class="min-w-0">
            <span class="block text-sm font-medium">{{ t("grid.sqlInsertModeSingle") }}</span>
            <span class="mt-1 block text-xs text-muted-foreground">{{ t("grid.sqlInsertModeSingleDescription") }}</span>
          </span>
        </label>
        <div v-if="columnSelectionEnabled" class="space-y-2 rounded-md border p-3" data-sql-export-columns>
          <div class="flex items-center justify-between gap-3">
            <div>
              <p class="text-sm font-medium">{{ t("databaseExport.sqlColumnSelection") }}</p>
              <p class="text-xs text-muted-foreground">{{ t("databaseExport.selectedColumns", { selected: selectedColumns.length, total: props.columns?.length ?? 0 }) }}</p>
            </div>
            <div class="flex gap-2">
              <Button type="button" variant="ghost" size="sm" data-sql-export-select-all @click="selectAllColumns">{{ t("databaseExport.selectAllColumns") }}</Button>
              <Button type="button" variant="ghost" size="sm" data-sql-export-clear @click="clearColumns">{{ t("databaseExport.clearColumns") }}</Button>
            </div>
          </div>
          <div class="max-h-48 space-y-1 overflow-y-auto rounded border p-2">
            <label v-for="column in props.columns" :key="column.sourceIndex" class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-accent/50">
              <input v-model="selectedColumnIndexes" type="checkbox" :value="column.sourceIndex" class="h-4 w-4" :data-sql-export-column="column.sourceIndex" />
              <span class="truncate"
                >{{ column.name }}<span v-if="duplicateColumnNames.has(column.name)" class="text-muted-foreground"> #{{ column.nameOccurrence + 1 }}</span></span
              >
            </label>
          </div>
          <p v-if="!canConfirm" role="alert" class="text-xs text-destructive" data-sql-export-column-error>{{ t("databaseExport.selectAtLeastOneColumn") }}</p>
        </div>
        <div v-if="props.allowSplit" class="space-y-2 rounded-md border p-3">
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input v-model="splitSqlOutput" type="checkbox" class="h-4 w-4" data-sql-split-output />
            {{ t("databaseExport.splitSqlOutput") }}
          </label>
          <div v-if="splitSqlOutput" class="flex items-center justify-between gap-3 pl-6">
            <span class="text-xs text-muted-foreground">{{ t("databaseExport.splitSqlPartMaxMb") }}</span>
            <input v-model.number="splitSqlPartMaxMb" type="number" :min="MIN_SPLIT_SQL_PART_MB" :max="MAX_SPLIT_SQL_PART_MB" class="h-8 w-24 rounded-md border bg-background px-2 text-sm" data-sql-split-max-mb />
          </div>
          <p v-if="splitSqlOutput" class="pl-6 text-xs text-muted-foreground">
            {{ t("databaseExport.splitSqlOutputDescription", { min: MIN_SPLIT_SQL_PART_MB, max: MAX_SPLIT_SQL_PART_MB }) }}
          </p>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="onCancel">{{ t("common.cancel") }}</Button>
        <Button :disabled="!canConfirm" data-sql-insert-mode-confirm @click="onConfirm">{{ t("common.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

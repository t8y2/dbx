<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { SqlExportOptions, SqlInsertMode } from "@/lib/export/sqlInsertMode";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ allowSplit?: boolean }>();
const selected = ref<SqlInsertMode>("batch");
const splitSqlOutput = ref(false);
const splitSqlPartMaxMb = ref(100);
const MIN_SPLIT_SQL_PART_MB = 1;
const MAX_SPLIT_SQL_PART_MB = 4096;
let outcomeEmitted = false;

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
  outcomeEmitted = true;
  open.value = false;
  emit("confirm", {
    insertMode: selected.value,
    splitMaxMb: props.allowSplit && splitSqlOutput.value ? normalizedSplitSqlPartMaxMb() : undefined,
  });
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
        <Button data-sql-insert-mode-confirm @click="onConfirm">{{ t("common.confirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

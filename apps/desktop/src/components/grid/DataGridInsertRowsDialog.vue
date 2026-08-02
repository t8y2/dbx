<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DATA_GRID_MAX_BATCH_INSERT_ROWS } from "@/composables/useDataGridEditor";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const MAX_INSERT_ROWS = DATA_GRID_MAX_BATCH_INSERT_ROWS;

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ insert: [count: number] }>();

const rowCount = ref("1");

watch(open, (isOpen) => {
  if (isOpen) rowCount.value = "1";
});

function parseIntegerOrNull(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

const parsedCount = computed<number | null>(() => {
  const parsed = parseIntegerOrNull(rowCount.value);
  if (parsed === null) return null;
  return Math.min(parsed, MAX_INSERT_ROWS);
});

const inputInvalid = computed(() => {
  const raw = rowCount.value.trim();
  if (raw === "") return false;
  return parseIntegerOrNull(raw) === null;
});

function confirmInsert() {
  const count = parsedCount.value;
  if (count === null) return;
  emit("insert", count);
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("grid.insertRowsTitle") }}</DialogTitle>
        <DialogDescription>{{ t("grid.insertRowsDescription") }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-2">
        <label for="insert-rows-count" class="text-sm font-medium">{{ t("grid.insertRowCountLabel") }}</label>
        <Input id="insert-rows-count" v-model="rowCount" type="number" min="1" :max="MAX_INSERT_ROWS" :aria-invalid="inputInvalid" class="w-40" @keydown.enter.prevent="confirmInsert" />
        <p v-if="inputInvalid" class="text-sm text-destructive">{{ t("grid.insertRowCountInvalid") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("grid.insertRowsMaxHint", { max: MAX_INSERT_ROWS }) }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="parsedCount === null" @click="confirmInsert">{{ t("grid.insertRowsConfirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

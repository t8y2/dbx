<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { INSERT_TEMPLATE_MAX_ROW_COUNT } from "@/lib/table/tableSqlTemplates";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MAX_ROWS = INSERT_TEMPLATE_MAX_ROW_COUNT;

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ confirm: [count: number] }>();

const rowCount = ref<string | number>("1");

watch(
  open,
  (isOpen) => {
    if (isOpen) rowCount.value = "1";
  },
  { immediate: true },
);

function parseIntegerOrNull(raw: string | number): number | null {
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

const parsedCount = computed<number | null>(() => {
  const parsed = parseIntegerOrNull(rowCount.value);
  if (parsed === null) return null;
  return Math.min(parsed, MAX_ROWS);
});

const inputInvalid = computed(() => {
  const raw = String(rowCount.value).trim();
  if (raw === "") return false;
  return parseIntegerOrNull(raw) === null;
});

function confirmRows() {
  const count = parsedCount.value;
  if (count === null) return;
  emit("confirm", count);
  open.value = false;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ t("contextMenu.insertRowsDialogTitle") }}</DialogTitle>
        <DialogDescription>{{ t("contextMenu.insertRowsDialogDescription") }}</DialogDescription>
      </DialogHeader>
      <div class="space-y-2">
        <Label for="insert-template-rows-count">{{ t("contextMenu.insertRowsDialogCountLabel") }}</Label>
        <Input id="insert-template-rows-count" v-model="rowCount" type="number" min="1" :max="MAX_ROWS" :aria-invalid="inputInvalid" class="w-40" @keydown.enter.prevent="confirmRows" />
        <p v-if="inputInvalid" class="text-sm text-destructive">{{ t("contextMenu.insertRowsDialogCountInvalid", { max: MAX_ROWS }) }}</p>
        <p class="text-xs text-muted-foreground">{{ t("contextMenu.insertRowsDialogMaxHint", { max: MAX_ROWS }) }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="parsedCount === null" @click="confirmRows">{{ t("contextMenu.insertRowsDialogConfirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

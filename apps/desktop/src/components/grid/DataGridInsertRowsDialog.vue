<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { type GridInsertRowPosition } from "@/lib/dataGrid/gridNewRowPlacement";
import { dataGridPendingRowLimit } from "@/lib/dataGrid/dataGridRowPreparation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = withDefaults(defineProps<{ canPlaceAtSelection?: boolean; initialPosition?: GridInsertRowPosition; maxRows?: number }>(), { maxRows: dataGridPendingRowLimit(1) });
const emit = defineEmits<{ insert: [count: number, position: GridInsertRowPosition] }>();

const canUsePosition = computed(() => props.canPlaceAtSelection !== false);

const rowCount = ref<string | number>("1");
const position = ref<GridInsertRowPosition>("below");

watch(
  open,
  (isOpen) => {
    if (isOpen) {
      rowCount.value = "1";
      position.value = canUsePosition.value ? (props.initialPosition ?? "below") : "end";
    }
  },
  { immediate: true },
);

// Without a unique selected row the above/below placements are not meaningful;
// fall back to the end instead of silently degrading on submit.
watch(canUsePosition, (canUse) => {
  if (!canUse) position.value = "end";
});

function parseIntegerOrNull(raw: string | number): number | null {
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

const requestedCount = computed(() => parseIntegerOrNull(rowCount.value));
const capacityExceeded = computed(() => requestedCount.value !== null && requestedCount.value > props.maxRows);
const parsedCount = computed(() => (capacityExceeded.value ? null : requestedCount.value));

const inputInvalid = computed(() => {
  const raw = String(rowCount.value).trim();
  if (raw === "") return false;
  return parsedCount.value === null;
});

function confirmInsert() {
  const count = parsedCount.value;
  if (count === null) return;
  emit("insert", count, position.value);
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
      <div class="space-y-3">
        <div class="space-y-2">
          <label for="insert-rows-count" class="text-sm font-medium">{{ t("grid.insertRowCountLabel") }}</label>
          <Input id="insert-rows-count" v-model="rowCount" type="number" min="1" step="1" :max="maxRows" :aria-invalid="inputInvalid" class="w-40" @keydown.enter.prevent="confirmInsert" />
          <p v-if="capacityExceeded" class="text-sm text-destructive">{{ t("grid.insertRowsCapacityExceeded", { max: maxRows }) }}</p>
          <p v-else-if="inputInvalid" class="text-sm text-destructive">{{ t("grid.insertRowCountInvalid") }}</p>
          <p class="text-xs text-muted-foreground">{{ t("grid.insertRowsMaxHint", { max: maxRows }) }}</p>
        </div>
        <div class="space-y-1.5">
          <span class="text-sm font-medium">{{ t("grid.insertRowPositionLabel") }}</span>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="position" type="radio" value="above" :disabled="!canUsePosition" class="h-3.5 w-3.5 accent-primary disabled:cursor-not-allowed" />
            {{ t("grid.insertPositionAbove") }}
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="position" type="radio" value="below" :disabled="!canUsePosition" class="h-3.5 w-3.5 accent-primary disabled:cursor-not-allowed" />
            {{ t("grid.insertPositionBelow") }}
          </label>
          <label class="flex items-center gap-2 text-sm">
            <input v-model="position" type="radio" value="end" class="h-3.5 w-3.5 accent-primary" />
            {{ t("grid.insertPositionEnd") }}
          </label>
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" @click="open = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="parsedCount === null" @click="confirmInsert">{{ t("grid.insertRowsConfirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

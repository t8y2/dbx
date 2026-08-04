<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DATA_GRID_MAX_BATCH_INSERT_ROWS } from "@/composables/useDataGridEditor";
import { type GridInsertRowPosition } from "@/lib/dataGrid/gridNewRowPlacement";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

const MAX_INSERT_ROWS = DATA_GRID_MAX_BATCH_INSERT_ROWS;

const { t } = useI18n();
const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{ canPlaceAtSelection?: boolean; initialPosition?: GridInsertRowPosition }>();
const emit = defineEmits<{ insert: [count: number, position: GridInsertRowPosition] }>();

const canUsePosition = computed(() => props.canPlaceAtSelection !== false);

const rowCount = ref("1");
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
          <Input id="insert-rows-count" v-model="rowCount" type="number" min="1" :max="MAX_INSERT_ROWS" :aria-invalid="inputInvalid" class="w-40" @keydown.enter.prevent="confirmInsert" />
          <p v-if="inputInvalid" class="text-sm text-destructive">{{ t("grid.insertRowCountInvalid") }}</p>
          <p class="text-xs text-muted-foreground">{{ t("grid.insertRowsMaxHint", { max: MAX_INSERT_ROWS }) }}</p>
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

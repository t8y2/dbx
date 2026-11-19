<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ArrowDown, ArrowUp, RotateCcw } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { orderDataGridFilterModeOptions, resetDataGridFilterModeOrder, saveDataGridFilterModeOrder, type DataGridFilterModeOption } from "@/lib/dataGrid/dataGridFilterModeOrder";

const props = defineProps<{
  open: boolean;
  databaseType?: string;
  options: readonly DataGridFilterModeOption[];
}>();
const emit = defineEmits<{ "update:open": [value: boolean]; saved: [] }>();
const { t } = useI18n();
const draft = ref<DataGridFilterModeOption[]>([]);

const databaseLabel = computed(() => {
  const labels: Record<string, string> = { mysql: "MySQL", postgres: "PostgreSQL", oracle: "Oracle", sqlserver: "SQL Server", sqlite: "SQLite", mongodb: "MongoDB", redis: "Redis", clickhouse: "ClickHouse" };
  return labels[props.databaseType || ""] || props.databaseType || t("grid.filterModeOrderUnknownDatabase");
});

watch(
  () => [props.open, props.databaseType, props.options] as const,
  () => {
    if (props.open) draft.value = orderDataGridFilterModeOptions(props.databaseType, props.options);
  },
  { immediate: true },
);

function move(index: number, offset: -1 | 1) {
  const target = index + offset;
  if (target < 0 || target >= draft.value.length) return;
  const next = [...draft.value];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item!);
  draft.value = next;
}

function reset() {
  resetDataGridFilterModeOrder(props.databaseType);
  draft.value = [...props.options];
}

function save() {
  saveDataGridFilterModeOrder(
    props.databaseType,
    draft.value.map((item) => item.value),
  );
  emit("saved");
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>{{ t("grid.filterModeOrderTitle") }}</DialogTitle>
        <DialogDescription>{{ t("grid.filterModeOrderDescription", { database: databaseLabel }) }}</DialogDescription>
      </DialogHeader>
      <div class="rounded border bg-muted/20 px-2 py-1.5 text-xs text-muted-foreground">{{ t("grid.filterModeOrderDatabase", { database: databaseLabel }) }}</div>
      <div class="max-h-[min(55vh,420px)] space-y-1 overflow-auto py-1">
        <div v-for="(option, index) in draft" :key="option.value" class="flex items-center gap-2 rounded border bg-background px-2 py-1.5 text-sm">
          <span class="min-w-0 flex-1 truncate">{{ t(option.labelKey) }}</span>
          <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="index === 0" :aria-label="t('grid.filterModeOrderMoveUp')" @click="move(index, -1)"><ArrowUp class="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="index === draft.length - 1" :aria-label="t('grid.filterModeOrderMoveDown')" @click="move(index, 1)"><ArrowDown class="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      <DialogFooter>
        <Button variant="ghost" size="sm" @click="reset"><RotateCcw class="mr-1 h-3.5 w-3.5" />{{ t("grid.filterModeOrderReset") }}</Button>
        <Button size="sm" @click="save">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

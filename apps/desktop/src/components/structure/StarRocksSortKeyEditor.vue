<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import StructureColumnMultiSelect from "./StructureColumnMultiSelect.vue";
import { getStarRocksCapabilities } from "@/lib/table/starrocksCapabilities";
import { isStarRocksSortColumn } from "@/lib/table/starrocksPhysicalOptions";
import type { StarRocksAlterOptions } from "@/lib/table/starrocksAlterOptions";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
const props = defineProps<{ modelValue: string[]; context?: StarRocksAlterOptions; columns: EditableStructureColumn[]; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [names: string[]] }>();
const { t } = useI18n();
const available = computed(() =>
  props.columns
    .filter(
      (column) =>
        column.original &&
        !column.markedForDrop &&
        isStarRocksSortColumn(column, props.context?.model === "primary") &&
        !/^(json|array|map|struct|bitmap|hll|percentile|binary|varbinary)/i.test(column.dataType) &&
        (!["aggregate", "unique"].includes(props.context?.model ?? "") || props.context?.keyColumns.includes(column.original.name)),
    )
    .map((column) => ({ ...column, id: column.original!.name })),
);
const supported = computed(() => {
  if (!props.context?.model) return false;
  const capabilities = getStarRocksCapabilities(props.context.serverVersion);
  return props.context.model === "primary" ? capabilities.primaryKeySorting : capabilities.duplicateKeySorting;
});
function move(index: number, offset: number) {
  const names = [...props.modelValue];
  const target = index + offset;
  if (target < 0 || target >= names.length) return;
  [names[index], names[target]] = [names[target]!, names[index]!];
  emit("update:modelValue", names);
}
</script>
<template>
  <details class="shrink-0 rounded-md border bg-muted/10 px-3 py-2" data-starrocks-edit-sort>
    <summary class="cursor-pointer font-medium">{{ t("starrocksLayout.sortColumns") }}</summary>
    <div class="mt-2 max-h-48 space-y-2 overflow-y-auto">
      <StructureColumnMultiSelect :model-value="modelValue" :columns="available" :label="t('starrocksLayout.sortColumns')" :disabled="disabled || !supported" @update:model-value="emit('update:modelValue', $event)" />
      <ol class="space-y-1">
        <li v-for="(name, index) in modelValue" :key="name" class="flex items-center gap-2 text-xs">
          <span class="min-w-0 flex-1 truncate">{{ index + 1 }}. {{ available.find((column) => column.id === name)?.name ?? name }}</span>
          <Button variant="ghost" size="sm" :disabled="disabled || !supported || index === 0" :aria-label="t('starrocksLayout.moveSortUp')" @click="move(index, -1)">↑</Button>
          <Button variant="ghost" size="sm" :disabled="disabled || !supported || index === modelValue.length - 1" :aria-label="t('starrocksLayout.moveSortDown')" @click="move(index, 1)">↓</Button>
          <Button
            variant="ghost"
            size="sm"
            :disabled="disabled || !supported"
            :aria-label="t('starrocksLayout.removeSortColumn')"
            @click="
              emit(
                'update:modelValue',
                modelValue.filter((value) => value !== name),
              )
            "
            >×</Button
          >
        </li>
      </ol>
      <p class="text-xs text-muted-foreground">{{ t("starrocksLayout.editSortHint") }}</p>
      <p v-if="!supported" class="text-xs text-amber-600">{{ t("starrocksLayout.editSortVersionHint") }}</p>
    </div>
  </details>
</template>

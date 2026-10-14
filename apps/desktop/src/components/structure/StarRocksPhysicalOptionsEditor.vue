<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import StructureColumnMultiSelect from "./StructureColumnMultiSelect.vue";
import StarRocksPartitionOptionsEditor from "./StarRocksPartitionOptionsEditor.vue";
import { getStarRocksCapabilities } from "@/lib/table/starrocksCapabilities";
import { isStarRocksHashColumn, isStarRocksSortColumn, type StarRocksPhysicalOptionsDraft } from "@/lib/table/starrocksPhysicalOptions";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
const props = defineProps<{ modelValue: StarRocksPhysicalOptionsDraft; columns: EditableStructureColumn[]; serverVersion?: string; disabled?: boolean; hidePartition?: boolean; hideSorting?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: StarRocksPhysicalOptionsDraft] }>();
const { t } = useI18n();
const capabilities = computed(() => getStarRocksCapabilities(props.serverVersion));
const activeColumns = computed(() => props.columns.filter((column) => !column.markedForDrop && !!column.name.trim()));
const hasPrimaryKey = computed(() => activeColumns.value.some((column) => column.isPrimaryKey));
const hashColumns = computed(() => activeColumns.value.filter(isStarRocksHashColumn));
const sortColumns = computed(() => activeColumns.value.filter((column) => isStarRocksSortColumn(column, hasPrimaryKey.value)));
const supportsSorting = computed(() => (hasPrimaryKey.value ? capabilities.value.primaryKeySorting : capabilities.value.duplicateKeySorting));
function moveSortColumn(index: number, offset: number) {
  const ids = [...props.modelValue.sortColumnIds];
  const target = index + offset;
  if (target < 0 || target >= ids.length) return;
  [ids[index], ids[target]] = [ids[target]!, ids[index]!];
  update("sortColumnIds", ids);
}
const primaryKeyConflict = computed(() => {
  if (!hasPrimaryKey.value) return false;
  const draft = props.modelValue;
  const partitionIds = draft.partitionKind === "none" ? [] : [...draft.partitionColumnIds, ...(draft.partitionKind === "time" ? [draft.partitionColumnId] : [])];
  const ids = [...partitionIds, ...(draft.distribution === "hash" ? draft.distributionColumnIds : [])];
  return draft.distribution === "random" || activeColumns.value.some((column) => ids.includes(column.id) && !column.isPrimaryKey);
});
function update<K extends keyof StarRocksPhysicalOptionsDraft>(key: K, value: StarRocksPhysicalOptionsDraft[K]) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}
</script>
<template>
  <details open class="shrink-0 rounded-md border bg-muted/10 px-3 py-2" data-starrocks-physical-options>
    <summary class="cursor-pointer font-medium">{{ t(hideSorting ? "starrocksLayout.partitionAndBucketTitle" : "starrocksLayout.title") }}</summary>
    <div class="mt-2 max-h-72 space-y-3 overflow-y-auto pr-1">
      <StarRocksPartitionOptionsEditor v-if="!hidePartition" :model-value="modelValue" :columns="activeColumns" :server-version="serverVersion" :disabled="disabled" @update:model-value="emit('update:modelValue', $event)" />
      <section class="space-y-2 border-t pt-2" data-starrocks-buckets>
        <div class="flex flex-wrap items-end gap-3">
          <div class="space-y-1">
            <span class="block text-muted-foreground">{{ t("starrocksLayout.distribution") }}</span>
            <Select :model-value="modelValue.distribution" :disabled="disabled" @update:model-value="update('distribution', $event as StarRocksPhysicalOptionsDraft['distribution'])">
              <SelectTrigger class="h-8 w-36" :aria-label="t('starrocksLayout.distribution')"><SelectValue /></SelectTrigger>
              <SelectContent
                ><SelectItem value="auto">{{ t("starrocksLayout.auto") }}</SelectItem
                ><SelectItem value="hash">{{ t("starrocksLayout.hash") }}</SelectItem
                ><SelectItem value="random" :disabled="hasPrimaryKey || !capabilities.randomDistribution">{{ t("starrocksLayout.random") }}</SelectItem></SelectContent
              >
            </Select>
          </div>
          <StructureColumnMultiSelect v-if="modelValue.distribution === 'hash'" :model-value="modelValue.distributionColumnIds" :columns="hashColumns" :label="t('starrocksLayout.hashColumns')" :disabled="disabled" @update:model-value="update('distributionColumnIds', $event)" />
          <label class="space-y-1"
            ><span class="block text-muted-foreground">{{ t("starrocksLayout.bucketCount") }}</span
            ><Input :model-value="modelValue.bucketCount" type="number" min="1" max="2147483647" step="1" class="h-8 w-28" :placeholder="t('starrocksLayout.auto')" :disabled="disabled" @update:model-value="update('bucketCount', String($event ?? ''))"
          /></label>
        </div>
        <p class="text-xs text-muted-foreground">{{ t("starrocksLayout.bucketCountHint") }}</p>
        <p class="text-xs text-muted-foreground">{{ modelValue.distribution === "auto" ? t(hasPrimaryKey ? "starrocksLayout.autoPrimaryHint" : "starrocksLayout.autoDuplicateHint") : t("starrocksLayout.bucketHint") }}</p>
      </section>
      <section v-if="!hideSorting" class="space-y-2 border-t pt-2" data-starrocks-sort>
        <StructureColumnMultiSelect :model-value="modelValue.sortColumnIds" :columns="sortColumns" :label="t('starrocksLayout.sortColumns')" :disabled="disabled || !supportsSorting" @update:model-value="update('sortColumnIds', $event)" />
        <ol v-if="modelValue.sortColumnIds.length" class="space-y-1">
          <li v-for="(id, index) in modelValue.sortColumnIds" :key="id" class="flex items-center gap-2">
            <span class="min-w-0 truncate">{{ index + 1 }}. {{ activeColumns.find((column) => column.id === id)?.name ?? t("starrocksLayout.missingSortColumn") }}</span>
            <Button type="button" variant="ghost" size="sm" :disabled="disabled || index === 0" :aria-label="t('starrocksLayout.moveSortUp')" @click="moveSortColumn(index, -1)">↑</Button>
            <Button type="button" variant="ghost" size="sm" :disabled="disabled || index === modelValue.sortColumnIds.length - 1" :aria-label="t('starrocksLayout.moveSortDown')" @click="moveSortColumn(index, 1)">↓</Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              :disabled="disabled"
              :aria-label="t('starrocksLayout.removeSortColumn')"
              @click="
                update(
                  'sortColumnIds',
                  modelValue.sortColumnIds.filter((value) => value !== id),
                )
              "
              >×</Button
            >
          </li>
        </ol>
        <p class="text-xs text-muted-foreground">{{ t("starrocksLayout.sortHint") }}</p>
        <p v-if="!supportsSorting" class="text-xs text-amber-600">{{ t("starrocksLayout.sortVersionHint") }}</p>
      </section>
      <p v-if="hasPrimaryKey" class="text-xs" :class="primaryKeyConflict ? 'text-destructive' : 'text-muted-foreground'">{{ t("starrocksLayout.primaryKeyHint") }}</p>
      <p v-if="!capabilities.timePartitioning" class="text-xs text-amber-600">{{ t("starrocksLayout.versionHint") }}</p>
    </div>
  </details>
</template>

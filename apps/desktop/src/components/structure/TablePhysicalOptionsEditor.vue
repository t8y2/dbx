<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { TablePhysicalOptionsConfig, TablePhysicalOptionsDraft } from "@/lib/table/tablePhysicalOptions";

const props = defineProps<{
  modelValue: TablePhysicalOptionsDraft;
  config: TablePhysicalOptionsConfig;
  columns: Array<{ id: string; name: string }>;
  disabled?: boolean;
}>();
const emit = defineEmits<{ "update:modelValue": [value: TablePhysicalOptionsDraft] }>();
const { t } = useI18n();
const search = ref({ partition: "", distribution: "" });
type ColumnGroup = "partition" | "distribution";
const columnGroups = computed(() => [
  { key: "partition" as const, label: props.config.partitionColumnsLabel },
  { key: "distribution" as const, label: props.config.distributionColumnsLabel },
]);

function selectedIds(group: ColumnGroup): string[] {
  return group === "partition" ? props.modelValue.partitionColumnIds : props.modelValue.distributionColumnIds;
}

function selectedNames(group: ColumnGroup): string {
  const selected = new Set(selectedIds(group));
  return props.columns
    .filter((column) => selected.has(column.id))
    .map((column) => column.name)
    .join(", ");
}

function availableColumns(group: ColumnGroup) {
  const filter = search.value[group].trim().toLowerCase();
  return props.columns.filter((column) => !filter || column.name.toLowerCase().includes(filter));
}

function toggleColumn(group: ColumnGroup, id: string) {
  const current = selectedIds(group);
  const next = current.includes(id) ? current.filter((selected) => selected !== id) : [...current, id];
  emit("update:modelValue", {
    ...props.modelValue,
    [group === "partition" ? "partitionColumnIds" : "distributionColumnIds"]: next,
  });
}

function updateValue<K extends keyof TablePhysicalOptionsDraft>(field: K, value: TablePhysicalOptionsDraft[K]) {
  emit("update:modelValue", { ...props.modelValue, [field]: value });
}
</script>

<template>
  <div class="flex shrink-0 flex-wrap items-end gap-3 border-b pb-2">
    <label v-for="group in columnGroups" :key="group.key" class="flex min-w-0 max-w-full flex-col gap-1 text-muted-foreground">
      <span>{{ t(group.label) }}</span>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm" class="h-8 w-48 max-w-full justify-between gap-1 px-2 font-normal" :disabled="disabled" :aria-label="t(group.label)">
            <span class="min-w-0 truncate font-mono">{{ selectedNames(group.key) || t("structureEditor.indexColumnsPlaceholder") }}</span>
            <ChevronDown class="size-3.5 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent class="max-h-64 min-w-48 overflow-y-auto" side="bottom" :side-offset="2">
          <div class="px-2 pb-1 pt-0.5">
            <Input v-model="search[group.key]" class="h-7 text-xs" :placeholder="t('grid.search')" @click.stop />
          </div>
          <DropdownMenuCheckboxItem v-for="column in availableColumns(group.key)" :key="column.id" :checked="selectedIds(group.key).includes(column.id)" @select.prevent @click="toggleColumn(group.key, column.id)">
            {{ column.name }}
          </DropdownMenuCheckboxItem>
          <div v-if="availableColumns(group.key).length === 0" class="px-2 py-1 text-xs text-muted-foreground">{{ t("structureEditor.indexColumnsPlaceholder") }}</div>
        </DropdownMenuContent>
      </DropdownMenu>
    </label>
    <label class="flex min-w-0 max-w-full flex-col gap-1 text-muted-foreground">
      <span>{{ t(config.bucketCountLabel) }}</span>
      <Input :model-value="modelValue.bucketCount" type="number" min="1" :max="config.maxBuckets" step="1" class="h-8 w-24 max-w-full" :disabled="disabled" @update:model-value="updateValue('bucketCount', String($event ?? ''))" />
    </label>
    <label v-if="config.storageFormats.length" class="flex min-w-0 max-w-full flex-col gap-1 text-muted-foreground">
      <span>{{ t(config.storageFormatLabel) }}</span>
      <Select :model-value="modelValue.storageFormat || '__default'" :disabled="disabled" @update:model-value="updateValue('storageFormat', $event === '__default' ? '' : String($event))">
        <SelectTrigger class="w-32 max-w-full"><SelectValue :placeholder="t('structureEditor.defaultAction')" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__default">{{ t("structureEditor.defaultAction") }}</SelectItem>
          <SelectItem v-for="format in config.storageFormats" :key="format" :value="format">{{ format }}</SelectItem>
        </SelectContent>
      </Select>
    </label>
    <label v-if="config.transactionalLabel" class="flex h-9 items-center gap-2 text-muted-foreground">
      <input :checked="modelValue.transactional" type="checkbox" class="h-4 w-4 accent-primary" :disabled="disabled" @change="updateValue('transactional', ($event.target as HTMLInputElement).checked)" />
      {{ t(config.transactionalLabel) }}
    </label>
  </div>
</template>

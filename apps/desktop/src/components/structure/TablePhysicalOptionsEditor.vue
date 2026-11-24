<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronDown, Plus, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { paimonWriteExpression } from "@/lib/table/tablePhysicalOptions";
import type { TablePhysicalOptionsConfig, TablePhysicalOptionsDraft } from "@/lib/table/tablePhysicalOptions";

const props = defineProps<{
  modelValue: TablePhysicalOptionsDraft;
  config: TablePhysicalOptionsConfig;
  columns: Array<{ id: string; name: string; dataType?: string }>;
  disabled?: boolean;
  generatedColumnsUnavailable?: boolean;
  section?: "properties" | "layout";
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
  return props.columns.filter((column) => {
    if (!column.name.toLowerCase().includes(filter)) return false;
    if (group !== "partition" || strategy.value !== "time" || !props.config.paimonPartitioning) return true;
    return selectedIds(group).includes(column.id) || /^(DATE|TIMESTAMP(?:_NTZ|_LTZ)?)$/i.test(column.dataType?.trim() ?? "");
  });
}

const mode = computed(() => props.modelValue.partitionMode ?? (props.modelValue.partitionColumnIds.length ? "value" : "none"));
const timeUnits = ["day", "month", "year"] as const;
const strategy = computed(() => (["day", "month", "year"].includes(mode.value) ? "time" : mode.value));
const strategies = { none: "none", time: "time", value: "values", range: "range", group: "list" } as const;
function changeStrategy(value: keyof typeof strategies) {
  const ids = props.modelValue.partitionColumnIds;
  emit("update:modelValue", { ...props.modelValue, partitionMode: value === "time" ? "month" : value, partitionColumnIds: value === "none" ? [] : value === "value" ? ids : ids.slice(0, 1) });
}
const timeSourceType = computed(() =>
  props.columns
    .find((column) => column.id === selectedIds("partition")[0])
    ?.dataType?.trim()
    .toUpperCase(),
);
const supportsGeneratedTime = computed(() => ["DATE", "TIMESTAMP_NTZ"].includes(timeSourceType.value ?? ""));
const target = computed(() => props.modelValue.partitionTarget?.trim() || "p_" + mode.value);
const expression = computed(() => {
  const source = props.columns.find((column) => column.id === selectedIds("partition")[0]);
  if (!source) return "";
  try {
    return paimonWriteExpression(props.modelValue, "`" + source.name.replaceAll("`", "``") + "`");
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
});
const partitionSql = computed(() => {
  if (mode.value === "none") return "";
  if (mode.value !== "value") return "PARTITIONED BY (`" + target.value.replaceAll("`", "``") + "`)";
  const names = selectedIds("partition")
    .map((id) => props.columns.find((column) => column.id === id)?.name)
    .filter(Boolean);
  return names.length ? "PARTITIONED BY (" + names.map((name) => "`" + name!.replaceAll("`", "``") + "`").join(", ") + ")" : "";
});

function conflictLabel(group: ColumnGroup, id: string) {
  if (mode.value !== "value" || !props.config.paimonPartitioning || selectedIds(group).includes(id)) return "";
  const other = group === "partition" ? "distribution" : "partition";
  return selectedIds(other).includes(id) ? t(other === "partition" ? props.config.partitionColumnsLabel : props.config.distributionColumnsLabel) : "";
}

function toggleColumn(group: ColumnGroup, id: string) {
  if (conflictLabel(group, id)) return;
  const current = selectedIds(group);
  const next = current.includes(id) ? current.filter((selected) => selected !== id) : group === "partition" && mode.value !== "value" ? [id] : [...current, id];
  emit("update:modelValue", {
    ...props.modelValue,
    ...(props.config.paimonPartitioning && group === "partition" && strategy.value === "time" ? { generatePartition: false } : {}),
    [group === "partition" ? "partitionColumnIds" : "distributionColumnIds"]: next,
  });
}

function updateValue<K extends keyof TablePhysicalOptionsDraft>(field: K, value: TablePhysicalOptionsDraft[K]) {
  emit("update:modelValue", { ...props.modelValue, [field]: value });
}
const enumRows = computed(() =>
  (props.modelValue.partitionGroups || "")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 0 ? { name: line, values: "" } : { name: line.slice(0, separator), values: line.slice(separator + 1) };
    }),
);
function saveEnumRows(rows: { name: string; values: string }[]) {
  updateValue("partitionGroups", rows.map((row) => row.name + "=" + row.values).join("\n"));
}
const propertyRows = computed(() => props.modelValue.propertyRows ?? []);

function editProperty(index: number, field: 0 | 1, value: string) {
  const rows = propertyRows.value.slice();
  const row: [string, string] = [...rows[index]];
  row[field] = value;
  rows[index] = row;
  updateValue("propertyRows", rows);
}
</script>

<template>
  <component v-if="section !== 'properties'" :is="config.paimonPartitioning ? 'details' : 'div'" open class="min-w-0">
    <summary v-if="config.paimonPartitioning" class="cursor-pointer py-2 font-medium">{{ t("starrocksLayout.partitionAndBucketTitle") }}</summary>
    <div class="flex shrink-0 flex-wrap items-end gap-3 border-b pb-2">
      <template v-for="group in columnGroups" :key="group.key">
        <label v-if="config.paimonPartitioning && group.key === 'partition'" class="flex flex-col gap-1">
          {{ t("structureEditor.partitionMethod") }}
          <Select :model-value="strategy" :disabled="disabled" @update:model-value="changeStrategy($event as keyof typeof strategies)">
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent
              ><SelectItem v-for="(label, item) in strategies" :key="item" :value="item">{{ t("starrocksLayout." + label) }}</SelectItem></SelectContent
            >
          </Select>
        </label>
        <label v-if="!config.paimonPartitioning || group.key !== 'partition' || mode !== 'none'" class="flex min-w-0 max-w-full flex-col gap-1 text-muted-foreground">
          <span>{{ t(group.key === "partition" && mode !== "value" ? "structureEditor.partitionSource" : group.label) }}</span>
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
              <DropdownMenuCheckboxItem v-for="column in availableColumns(group.key)" :key="column.id" :disabled="!!conflictLabel(group.key, column.id)" :checked="selectedIds(group.key).includes(column.id)" @select.prevent @click="toggleColumn(group.key, column.id)">
                {{ column.name }} <small v-if="conflictLabel(group.key, column.id)">({{ conflictLabel(group.key, column.id) }})</small>
              </DropdownMenuCheckboxItem>
              <div v-if="availableColumns(group.key).length === 0" class="px-2 py-1 text-xs text-muted-foreground">{{ t("structureEditor.indexColumnsPlaceholder") }}</div>
            </DropdownMenuContent>
          </DropdownMenu>
        </label>
        <label v-if="group.key === 'partition' && strategy === 'time'" class="flex flex-col gap-1"
          >{{ t("starrocksLayout.granularity") }}
          <Select :model-value="mode" :disabled="disabled" @update:model-value="updateValue('partitionMode', $event as (typeof timeUnits)[number])">
            <SelectTrigger><SelectValue /></SelectTrigger
            ><SelectContent
              ><SelectItem v-for="unit in timeUnits" :key="unit" :value="unit">{{ t("starrocksLayout." + unit) }}</SelectItem></SelectContent
            >
          </Select>
        </label>
        <div v-if="config.paimonPartitioning && group.key === 'partition'" class="w-full border-b pb-2 text-muted-foreground">
          <div v-if="mode !== 'value' && mode !== 'none'" class="grid max-w-xl gap-2 py-1">
            <label>{{ t("structureEditor.partitionTarget") }}<Input :model-value="modelValue.partitionTarget" :placeholder="target" :disabled="disabled" @update:model-value="updateValue('partitionTarget', String($event))" /></label>
            <div v-if="mode === 'group'" class="space-y-2">
              <div v-for="(row, index) in enumRows" :key="index" class="flex items-end gap-2">
                <label
                  >{{ t("starrocksLayout.partitionName") }}
                  <Input :model-value="row.name" placeholder="LN" :disabled="disabled" @update:model-value="saveEnumRows(enumRows.map((r, i) => (i === index ? { ...r, name: String($event) } : r)))" />
                </label>
                <label
                  >{{ selectedNames("partition") }}
                  <Input :model-value="row.values" placeholder="2101,2102" :disabled="disabled" @update:model-value="saveEnumRows(enumRows.map((r, i) => (i === index ? { ...r, values: String($event) } : r)))" />
                </label>
                <Button :disabled="disabled" @click="saveEnumRows(enumRows.filter((_, i) => i !== index))">{{ t("starrocksLayout.removePartition") }}</Button>
              </div>
              <Button :disabled="disabled" @click="saveEnumRows([...enumRows, { name: '', values: '' }])">{{ t("starrocksLayout.addPartition") }}</Button>
            </div>
            <div v-else-if="mode === 'range'" class="space-y-2">
              <div v-for="(row, index) in modelValue.partitionRanges" :key="index" class="flex gap-2">
                <label v-for="(label, key) in { name: 'partitionName', lower: 'lower', upper: 'upper' }" :key="key"
                  >{{ t("starrocksLayout." + label) }}
                  <Input
                    :model-value="row[key]"
                    :disabled="disabled"
                    @update:model-value="
                      updateValue(
                        'partitionRanges',
                        modelValue.partitionRanges?.map((r, i) => (i === index ? { ...r, [key]: String($event) } : r)),
                      )
                    "
                  />
                </label>
                <Button
                  :disabled="disabled"
                  @click="
                    updateValue(
                      'partitionRanges',
                      modelValue.partitionRanges?.filter((_, i) => i !== index),
                    )
                  "
                  >{{ t("starrocksLayout.removePartition") }}</Button
                >
              </div>
              <Button :disabled="disabled" @click="updateValue('partitionRanges', [...(modelValue.partitionRanges ?? []), { name: '', lower: '', upper: '' }])">{{ t("starrocksLayout.addPartition") }}</Button>
            </div>
            <label v-else
              ><input type="checkbox" :checked="modelValue.generatePartition" :disabled="disabled || generatedColumnsUnavailable || (!supportsGeneratedTime && !modelValue.generatePartition)" @change="updateValue('generatePartition', ($event.target as HTMLInputElement).checked)" />
              {{ t("structureEditor.partitionGenerate") }}</label
            >
            <p v-if="strategy === 'time' && timeSourceType && !supportsGeneratedTime" class="text-xs text-muted-foreground">
              {{ t("structureEditor.partitionGenerateTypeHint", { type: timeSourceType }) }}
            </p>
            <code v-if="expression">{{ strategy !== "time" || !modelValue.generatePartition ? t("structureEditor.partitionWrite") : "GENERATED ALWAYS AS" }} ({{ expression }})</code>
          </div>
          <template v-if="partitionSql"
            ><span v-if="mode === 'value'">{{ t("structureEditor.partitionByValue") }} </span><code>{{ partitionSql }}</code></template
          >
          <template v-else>{{ t("structureEditor.noPartitionSelected") }}</template>
        </div>
      </template>
      <label class="flex min-w-0 max-w-full flex-col gap-1 text-muted-foreground">
        <span>{{ t(config.bucketCountLabel) }}</span>
        <Input :model-value="modelValue.bucketCount" type="number" :min="config.minBuckets ?? 1" :max="config.maxBuckets" step="1" class="h-8 w-24 max-w-full" :disabled="disabled" @update:model-value="updateValue('bucketCount', String($event ?? ''))" />
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
  </component>
  <fieldset v-if="config.tableProperties && section !== 'layout'" class="min-w-0 shrink-0 border-b pb-2" :disabled="disabled">
    <legend class="px-0 font-medium">TBLPROPERTIES</legend>
    <div class="mt-1 max-h-44 max-w-3xl overflow-auto">
      <div v-if="propertyRows.length" class="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1.5">
        <span class="text-muted-foreground">Key</span>
        <span class="text-muted-foreground">Value</span>
        <span />
        <template v-for="(row, index) in propertyRows" :key="index">
          <Input :model-value="row[0]" :aria-label="`Key ${index + 1}`" placeholder="file.format" class="font-mono" @update:model-value="editProperty(index, 0, String($event))" />
          <Input :model-value="row[1]" :aria-label="`Value ${index + 1}`" placeholder="parquet" class="font-mono" @update:model-value="editProperty(index, 1, String($event))" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            :aria-label="t('structureEditor.removeProperty')"
            :title="t('structureEditor.removeProperty')"
            @click="
              updateValue(
                'propertyRows',
                propertyRows.filter((_, i) => i !== index),
              )
            "
          >
            <Trash2 class="size-3.5" />
          </Button>
        </template>
      </div>
    </div>
    <Button type="button" size="sm" variant="outline" class="mt-1.5" @click="updateValue('propertyRows', [...propertyRows, ['', '']])"> <Plus class="size-3.5" />{{ t("structureEditor.addProperty") }} </Button>
  </fieldset>
</template>

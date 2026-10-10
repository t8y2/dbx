<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import StructureColumnMultiSelect from "./StructureColumnMultiSelect.vue";
import { getStarRocksCapabilities } from "@/lib/table/starrocksCapabilities";
import { isStarRocksTimeColumn, isStarRocksPartitionColumn, type StarRocksPhysicalOptionsDraft, type StarRocksPartitionKind } from "@/lib/table/starrocksPhysicalOptions";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
const props = defineProps<{ modelValue: StarRocksPhysicalOptionsDraft; columns: EditableStructureColumn[]; serverVersion?: string; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: StarRocksPhysicalOptionsDraft] }>();
const { t } = useI18n();
const caps = computed(() => getStarRocksCapabilities(props.serverVersion));
const timeColumns = computed(() => props.columns.filter(isStarRocksTimeColumn));
const eligible = computed(() => props.columns.filter((column) => isStarRocksPartitionColumn(column, props.modelValue.partitionKind === "range") && (props.modelValue.partitionKind !== "time" || column.id !== props.modelValue.partitionColumnId)));
const selected = computed(() => props.modelValue.partitionColumnIds.map((id) => ({ id, name: props.columns.find((column) => column.id === id)?.name ?? t("starrocksLayout.unavailableColumn") })));
const missingTime = computed(() => !!props.modelValue.partitionColumnId && !timeColumns.value.some((column) => column.id === props.modelValue.partitionColumnId));
function update<K extends keyof StarRocksPhysicalOptionsDraft>(key: K, value: StarRocksPhysicalOptionsDraft[K]) {
  emit("update:modelValue", { ...props.modelValue, [key]: value });
}
function setKind(kind: StarRocksPartitionKind) {
  emit("update:modelValue", { ...props.modelValue, partitionKind: kind, timePartitionEnabled: kind === "time" });
}
function addRange() {
  update("rangePartitions", [...props.modelValue.rangePartitions, { id: crypto.randomUUID(), name: `p${props.modelValue.rangePartitions.length + 1}`, lower: {}, upper: {} }]);
}
function rangeField(index: number, side: "lower" | "upper", id: string, value: string) {
  update(
    "rangePartitions",
    props.modelValue.rangePartitions.map((row, i) => (i === index ? { ...row, [side]: { ...row[side], [id]: value } } : row)),
  );
}
function addList() {
  update("listPartitions", [...props.modelValue.listPartitions, { id: crypto.randomUUID(), name: `p${props.modelValue.listPartitions.length + 1}`, values: [{ id: crypto.randomUUID(), fields: {} }] }]);
}
function listField(index: number, tupleIndex: number, id: string, value: string) {
  update(
    "listPartitions",
    props.modelValue.listPartitions.map((row, i) => (i === index ? { ...row, values: row.values.map((tuple, j) => (j === tupleIndex ? { ...tuple, fields: { ...tuple.fields, [id]: value } } : tuple)) } : row)),
  );
}
function addTuple(index: number) {
  update(
    "listPartitions",
    props.modelValue.listPartitions.map((row, i) => (i === index ? { ...row, values: [...row.values, { id: crypto.randomUUID(), fields: {} }] } : row)),
  );
}
function removeTuple(index: number, tupleIndex: number) {
  update(
    "listPartitions",
    props.modelValue.listPartitions.map((row, i) => (i === index ? { ...row, values: row.values.filter((_, j) => j !== tupleIndex) } : row)),
  );
}
</script>
<template>
  <section class="space-y-2" data-starrocks-partitions>
    <div class="flex flex-wrap items-end gap-3">
      <div class="space-y-1">
        <span class="block text-muted-foreground">{{ t("starrocksLayout.partitionStrategy") }}</span>
        <Select :model-value="modelValue.partitionKind" :disabled="disabled" @update:model-value="setKind($event as StarRocksPartitionKind)">
          <SelectTrigger class="h-8 w-52" :aria-label="t('starrocksLayout.partitionStrategy')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{{ t("starrocksLayout.none") }}</SelectItem>
            <SelectItem value="time" :disabled="!caps.timePartitioning">{{ t("starrocksLayout.time") }}</SelectItem>
            <SelectItem value="values" :disabled="!caps.valuePartitioning">{{ t("starrocksLayout.values") }}</SelectItem>
            <SelectItem value="range">{{ t("starrocksLayout.range") }}</SelectItem>
            <SelectItem value="list" :disabled="!caps.valuePartitioning">{{ t("starrocksLayout.list") }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <template v-if="modelValue.partitionKind === 'time'">
        <div class="space-y-1">
          <span class="block text-muted-foreground">{{ t("starrocksLayout.partitionColumn") }}</span>
          <Select :model-value="modelValue.partitionColumnId" :disabled="disabled" @update:model-value="update('partitionColumnId', String($event))">
            <SelectTrigger class="h-8 w-40" :aria-label="t('starrocksLayout.partitionColumn')"><SelectValue :placeholder="t('starrocksLayout.selectColumn')" /></SelectTrigger>
            <SelectContent
              ><SelectItem v-if="missingTime" :value="modelValue.partitionColumnId" disabled>{{ t("starrocksLayout.unavailableColumn") }}</SelectItem
              ><SelectItem v-for="column in timeColumns" :key="column.id" :value="column.id">{{ column.name }}</SelectItem></SelectContent
            >
          </Select>
        </div>
        <div class="space-y-1">
          <span class="block text-muted-foreground">{{ t("starrocksLayout.granularity") }}</span>
          <Select :model-value="modelValue.granularity" :disabled="disabled" @update:model-value="update('granularity', $event as StarRocksPhysicalOptionsDraft['granularity'])">
            <SelectTrigger class="h-8 w-24" :aria-label="t('starrocksLayout.granularity')"><SelectValue /></SelectTrigger>
            <SelectContent
              ><SelectItem v-for="unit in ['year', 'month', 'day', 'hour'] as const" :key="unit" :value="unit">{{ t(`starrocksLayout.${unit}`) }}</SelectItem></SelectContent
            >
          </Select>
        </div>
        <label class="space-y-1"
          ><span class="block text-muted-foreground">{{ t("starrocksLayout.timeInterval") }}</span
          ><Input :model-value="modelValue.timeInterval" type="number" min="1" step="1" class="h-8 w-32" :placeholder="t('starrocksLayout.calendarUnit')" :disabled="disabled" @update:model-value="update('timeInterval', String($event ?? ''))"
        /></label>
      </template>
      <StructureColumnMultiSelect
        v-if="modelValue.partitionKind !== 'none' && (modelValue.partitionKind !== 'time' || caps.mixedPartitioning || modelValue.partitionColumnIds.length)"
        :model-value="modelValue.partitionColumnIds"
        :columns="eligible"
        :label="t(modelValue.partitionKind === 'time' ? 'starrocksLayout.additionalColumns' : 'starrocksLayout.partitionColumns')"
        :disabled="disabled"
        @update:model-value="update('partitionColumnIds', $event)"
      />
    </div>
    <p class="text-xs text-muted-foreground">{{ t(`starrocksLayout.${modelValue.partitionKind}Hint`) }}</p>
    <p v-if="modelValue.partitionKind === 'time'" class="text-xs text-muted-foreground">{{ t("starrocksLayout.timeIntervalHint") }}</p>
    <p v-if="modelValue.partitionKind === 'time' && timeColumns.length === 0" class="text-xs text-destructive">{{ t("starrocksLayout.noTimeColumn") }}</p>
    <p v-if="(modelValue.partitionKind === 'time' && missingTime) || (modelValue.partitionKind !== 'none' && selected.some((column) => !eligible.some((item) => item.id === column.id)))" class="text-xs text-destructive">{{ t("starrocksLayout.invalidSelection") }}</p>
    <template v-if="modelValue.partitionKind === 'range'">
      <div v-for="(row, i) in modelValue.rangePartitions" :key="row.id" class="space-y-2 rounded border p-2">
        <div class="flex items-center gap-2">
          <Input
            :model-value="row.name"
            class="h-8 w-40"
            :aria-label="t('starrocksLayout.partitionName')"
            :placeholder="t('starrocksLayout.partitionName')"
            :disabled="disabled"
            @update:model-value="
              update(
                'rangePartitions',
                modelValue.rangePartitions.map((item, j) => (j === i ? { ...item, name: String($event) } : item)),
              )
            "
          /><Button
            variant="ghost"
            size="sm"
            :disabled="disabled"
            @click="
              update(
                'rangePartitions',
                modelValue.rangePartitions.filter((_, j) => j !== i),
              )
            "
            >{{ t("starrocksLayout.removePartition") }}</Button
          >
        </div>
        <div v-for="side in ['lower', 'upper'] as const" :key="side" class="flex flex-wrap items-end gap-2">
          <span class="w-28 shrink-0 pb-1 text-muted-foreground">{{ t(`starrocksLayout.${side}`) }}</span>
          <label v-for="column in selected" :key="column.id" class="space-y-1"
            ><span class="block text-xs">{{ column.name }}</span
            ><Input :model-value="row[side][column.id] ?? ''" class="h-8 w-44" :disabled="disabled" :placeholder="t('starrocksLayout.valuePlaceholder')" @update:model-value="rangeField(i, side, column.id, String($event))"
          /></label>
        </div>
      </div>
      <Button variant="outline" size="sm" :disabled="disabled || selected.length === 0" @click="addRange">{{ t("starrocksLayout.addPartition") }}</Button>
    </template>
    <template v-if="modelValue.partitionKind === 'list'">
      <div v-for="(row, i) in modelValue.listPartitions" :key="row.id" class="space-y-2 rounded border p-2">
        <div class="flex items-center gap-2">
          <Input
            :model-value="row.name"
            class="h-8 w-40"
            :aria-label="t('starrocksLayout.partitionName')"
            :placeholder="t('starrocksLayout.partitionName')"
            :disabled="disabled"
            @update:model-value="
              update(
                'listPartitions',
                modelValue.listPartitions.map((item, j) => (j === i ? { ...item, name: String($event) } : item)),
              )
            "
          /><Button
            variant="ghost"
            size="sm"
            :disabled="disabled"
            @click="
              update(
                'listPartitions',
                modelValue.listPartitions.filter((_, j) => j !== i),
              )
            "
            >{{ t("starrocksLayout.removePartition") }}</Button
          >
        </div>
        <div v-for="(tuple, j) in row.values" :key="tuple.id" class="flex flex-wrap items-end gap-2">
          <label v-for="column in selected" :key="column.id" class="space-y-1"
            ><span class="block text-xs">{{ column.name }}</span
            ><Input :model-value="tuple.fields[column.id] ?? ''" class="h-8 w-44" :disabled="disabled" :placeholder="t('starrocksLayout.valuePlaceholder')" @update:model-value="listField(i, j, column.id, String($event))"
          /></label>
          <Button variant="ghost" size="sm" :disabled="disabled" @click="removeTuple(i, j)">{{ t("starrocksLayout.removeValues") }}</Button>
        </div>
        <Button variant="outline" size="sm" :disabled="disabled || selected.length === 0" @click="addTuple(i)">{{ t("starrocksLayout.addValues") }}</Button>
      </div>
      <Button variant="outline" size="sm" :disabled="disabled || selected.length === 0" @click="addList">{{ t("starrocksLayout.addPartition") }}</Button>
    </template>
  </section>
</template>

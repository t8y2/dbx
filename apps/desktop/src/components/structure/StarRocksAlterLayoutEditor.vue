<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import StructureColumnMultiSelect from "./StructureColumnMultiSelect.vue";
import { getStarRocksCapabilities } from "@/lib/table/starrocksCapabilities";
import { isStarRocksHashColumn } from "@/lib/table/starrocksPhysicalOptions";
import type { StarRocksAlterOptions, StarRocksLayoutDraft, StarRocksPartitionChange } from "@/lib/table/starrocksAlterOptions";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
const props = defineProps<{ modelValue: StarRocksLayoutDraft; context: StarRocksAlterOptions; columns: EditableStructureColumn[]; disabled?: boolean }>();
const emit = defineEmits<{ "update:modelValue": [value: StarRocksLayoutDraft] }>();
const { t } = useI18n();
const caps = computed(() => getStarRocksCapabilities(props.context.serverVersion));
const locked = computed(() => props.disabled || !caps.value.alterDistribution || props.context.colocated);
const distributionLocked = computed(() => locked.value || props.context.automaticBucketScaling);
const hashColumns = computed(() =>
  props.columns.filter((column) => column.original && !column.markedForDrop && isStarRocksHashColumn(column) && (props.context.model === "duplicate" || props.context.keyColumns.includes(column.original.name))).map((column) => ({ ...column, id: column.original!.name })),
);
const canDefault = computed(() => caps.value.defaultBuckets && props.modelValue.method === "hash" && props.context.distribution?.method === "hash" && JSON.stringify(props.modelValue.columns) === JSON.stringify(props.context.distribution.columns));
const action = ref("replicas");
const name = ref("");
const lower = ref<Record<string, string>>({});
const upper = ref<Record<string, string>>({});
const listRows = ref<Array<Record<string, string>>>([{}]);
const replicas = ref("1");
function update<K extends keyof StarRocksLayoutDraft>(key: K, value: StarRocksLayoutDraft[K]) {
  emit("update:modelValue", { ...props.modelValue, [key]: value, ...(key === "method" || key === "columns" ? { defaultOnly: false } : {}) });
}
function queue() {
  if (!name.value.trim()) return;
  const values = (row: Record<string, string>) => props.context.partitionColumns.map((column) => row[column] ?? "");
  let operation: StarRocksPartitionChange;
  if (action.value === "addRange") operation = { kind: "addRange", name: name.value.trim(), lower: values(lower.value), upper: values(upper.value) };
  else if (action.value === "addList") operation = { kind: "addList", name: name.value.trim(), values: listRows.value.map(values) };
  else if (action.value === "drop") operation = { kind: "drop", name: name.value.trim() };
  else operation = { kind: "replicas", name: name.value.trim(), replicas: Number.isInteger(Number(replicas.value)) && Number(replicas.value) > 0 && Number(replicas.value) <= 32767 ? Number(replicas.value) : 0 };
  update("partitions", [...props.modelValue.partitions, operation]);
  name.value = "";
}
</script>
<template>
  <details open class="shrink-0 rounded-md border bg-muted/10 px-3 py-2" data-starrocks-alter-layout>
    <summary class="cursor-pointer font-medium">{{ t("starrocksLayout.alterLayoutTitle") }}</summary>
    <div class="mt-2 max-h-72 space-y-3 overflow-y-auto pr-1">
      <p class="text-xs text-muted-foreground">{{ t("starrocksLayout.alterLayoutHint") }}</p>
      <p v-if="context.colocated || !caps.alterDistribution" class="text-xs text-amber-600">{{ t("starrocksLayout.alterLayoutUnavailable") }}</p>
      <p v-if="context.automaticBucketScaling" class="text-xs text-muted-foreground">{{ t("starrocksLayout.automaticBucketsReadonly") }}</p>
      <div class="flex flex-wrap items-end gap-3">
        <div class="space-y-1">
          <span class="block text-muted-foreground">{{ t("starrocksLayout.distribution") }}</span>
          <Select :model-value="modelValue.method" :disabled="distributionLocked" @update:model-value="update('method', $event as 'hash' | 'random')">
            <SelectTrigger class="h-8 w-36"><SelectValue /></SelectTrigger>
            <SelectContent
              ><SelectItem value="hash">{{ t("starrocksLayout.hash") }}</SelectItem
              ><SelectItem value="random" :disabled="context.model !== 'duplicate'">{{ t("starrocksLayout.random") }}</SelectItem></SelectContent
            >
          </Select>
        </div>
        <StructureColumnMultiSelect v-if="modelValue.method === 'hash'" :model-value="modelValue.columns" :columns="hashColumns" :label="t('starrocksLayout.hashColumns')" :disabled="distributionLocked" @update:model-value="update('columns', $event)" />
        <label class="space-y-1"
          ><span class="block text-muted-foreground">{{ t("starrocksLayout.bucketCount") }}</span
          ><Input :model-value="modelValue.bucketCount" type="number" min="1" max="2147483647" step="1" class="h-8 w-28" :placeholder="t('starrocksLayout.auto')" :disabled="distributionLocked" @update:model-value="update('bucketCount', String($event ?? ''))"
        /></label>
      </div>
      <label v-if="canDefault" class="flex items-center gap-2 text-xs"><input type="checkbox" :checked="modelValue.defaultOnly" :disabled="distributionLocked" @change="update('defaultOnly', ($event.target as HTMLInputElement).checked)" />{{ t("starrocksLayout.defaultBucketsOnly") }}</label>
      <p class="text-xs text-muted-foreground">{{ t("starrocksLayout.alterBucketsHint") }}</p>
      <section class="space-y-2 border-t pt-2">
        <p class="text-xs text-muted-foreground">{{ t("starrocksLayout.partitionReadonly") }}</p>
        <pre v-if="context.partitionClause" class="overflow-auto whitespace-pre-wrap text-xs">{{ context.partitionClause }}</pre>
        <div class="flex flex-wrap items-end gap-2">
          <Select v-model="action" :disabled="locked"
            ><SelectTrigger class="h-8 w-44"><SelectValue /></SelectTrigger
            ><SelectContent>
              <SelectItem value="replicas">{{ t("starrocksLayout.partitionReplicas") }}</SelectItem>
              <SelectItem v-if="context.partitionKind" value="drop">{{ t("starrocksLayout.dropPartition") }}</SelectItem>
              <SelectItem v-if="context.partitionKind === 'range'" value="addRange">{{ t("starrocksLayout.addRangePartition") }}</SelectItem>
              <SelectItem v-if="context.partitionKind === 'list'" value="addList">{{ t("starrocksLayout.addListPartition") }}</SelectItem>
            </SelectContent></Select
          >
          <Input v-model="name" class="h-8 w-48" :placeholder="t(action === 'replicas' ? 'starrocksLayout.partitionNameAll' : 'starrocksLayout.partitionNameInput')" :disabled="locked" />
          <Input v-if="action === 'replicas'" v-model="replicas" type="number" min="1" max="32767" step="1" class="h-8 w-24" :disabled="locked" />
        </div>
        <div v-if="action === 'addRange'" class="flex flex-wrap gap-2">
          <div v-for="column in context.partitionColumns" :key="column" class="space-y-1">
            <span class="text-xs">{{ column }}</span
            ><Input v-model="lower[column]" :placeholder="t('starrocksLayout.rangeLower')" :disabled="locked" /><Input v-model="upper[column]" :placeholder="t('starrocksLayout.rangeUpper')" :disabled="locked" />
          </div>
        </div>
        <div v-if="action === 'addList'" class="space-y-2">
          <div v-for="(row, index) in listRows" :key="index" class="flex flex-wrap gap-2">
            <Input v-for="column in context.partitionColumns" :key="column" v-model="row[column]" :placeholder="column" class="h-8 w-40" :disabled="locked" /><Button variant="ghost" size="sm" :disabled="locked || listRows.length === 1" @click="listRows.splice(index, 1)">{{
              t("starrocksLayout.removePartitionOperation")
            }}</Button>
          </div>
          <Button variant="outline" size="sm" :disabled="locked" @click="listRows.push({})">{{ t("starrocksLayout.addValueTuple") }}</Button>
        </div>
        <p v-if="action === 'drop'" class="text-xs text-amber-600">{{ t("starrocksLayout.dropPartitionHint") }}</p>
        <p class="text-xs text-muted-foreground">{{ t("starrocksLayout.partitionValuesHint") }}</p>
        <Button variant="outline" size="sm" :disabled="locked || !name.trim()" @click="queue">{{ t("starrocksLayout.queuePartitionOperation") }}</Button>
        <div v-for="(operation, index) in modelValue.partitions" :key="index" class="flex items-center justify-between gap-2 rounded border px-2 py-1 text-xs">
          <span>{{ t(`starrocksLayout.operation_${operation.kind}`) }} · {{ operation.name }}</span
          ><Button
            variant="ghost"
            size="sm"
            :disabled="disabled"
            @click="
              update(
                'partitions',
                modelValue.partitions.filter((_, i) => i !== index),
              )
            "
            >{{ t("starrocksLayout.removePartitionOperation") }}</Button
          >
        </div>
      </section>
    </div>
  </details>
</template>

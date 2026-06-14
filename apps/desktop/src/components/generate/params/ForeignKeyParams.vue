<script setup lang="ts">
import { ref, onMounted } from "vue";
import { Label } from "@/components/ui/label";
import type { GeneratorParams } from "@/lib/dataGenerate";
import * as api from "@/lib/api";

const props = defineProps<{ params: GeneratorParams; config: any; connectionId?: string; database?: string }>();

const schemas = ref<string[]>([]);
const tables = ref<{ name: string }[]>([]);
const columns = ref<{ name: string }[]>([]);
const loadingSchemas = ref(false);
const loadingTables = ref(false);
const loadingColumns = ref(false);

const fkModes = [
  { value: "random", label: "随机" },
  { value: "unique", label: "不重复" },
  { value: "repeat", label: "重复每个值" },
];

onMounted(async () => {
  await loadSchemas();
});

async function loadSchemas() {
  if (!props.connectionId || !props.database) return;
  loadingSchemas.value = true;
  try {
    schemas.value = await api.listSchemas(props.connectionId, props.database);
    if (schemas.value.length === 0) schemas.value = ["main"];
    if (props.params.fkSchema) await loadTables();
  } catch {
    schemas.value = ["main"];
  } finally {
    loadingSchemas.value = false;
  }
}

async function loadTables() {
  if (!props.connectionId || !props.database || !props.params.fkSchema) return;
  loadingTables.value = true;
  try {
    tables.value = await api.listTables(props.connectionId, props.database, props.params.fkSchema);
    if (props.params.fkTable) await loadColumns();
  } catch {
    tables.value = [];
  } finally {
    loadingTables.value = false;
  }
}

async function loadColumns() {
  if (!props.connectionId || !props.database || !props.params.fkSchema || !props.params.fkTable) return;
  loadingColumns.value = true;
  try {
    const cols = await api.getColumns(props.connectionId, props.database, props.params.fkSchema, props.params.fkTable);
    columns.value = cols.map((c: any) => ({ name: c.name }));
  } catch {
    columns.value = [];
  } finally {
    loadingColumns.value = false;
  }
}

function onSchemaChange(val: string) {
  props.params.fkSchema = val;
  props.params.fkTable = undefined;
  props.params.fkField = undefined;
  tables.value = [];
  columns.value = [];
  void loadTables();
}

function onTableChange(val: string) {
  props.params.fkTable = val;
  props.params.fkField = undefined;
  columns.value = [];
  void loadColumns();
}
</script>

<template>
  <div class="space-y-3">
    <div class="rounded-md border bg-muted/10 p-3 space-y-2">
      <div class="grid grid-cols-[60px_1fr] items-center gap-2 text-xs">
        <Label class="text-muted-foreground">模式</Label>
        <select v-model="props.params.fkSchema" class="h-7 rounded border bg-background px-2 text-xs" @change="onSchemaChange(($event.target as HTMLSelectElement).value)">
          <option v-if="loadingSchemas" disabled>加载中...</option>
          <option v-for="s in schemas" :key="s" :value="s">{{ s }}</option>
        </select>
      </div>
      <div class="grid grid-cols-[60px_1fr] items-center gap-2 text-xs">
        <Label class="text-muted-foreground">表</Label>
        <select v-model="props.params.fkTable" class="h-7 rounded border bg-background px-2 text-xs" @change="onTableChange(($event.target as HTMLSelectElement).value)">
          <option v-if="loadingTables" disabled>加载中...</option>
          <option v-for="t in tables" :key="t.name" :value="t.name">{{ t.name }}</option>
        </select>
      </div>
      <div class="grid grid-cols-[60px_1fr] items-center gap-2 text-xs">
        <Label class="text-muted-foreground">字段</Label>
        <select v-model="props.params.fkField" class="h-7 rounded border bg-background px-2 text-xs">
          <option v-if="loadingColumns" disabled>加载中...</option>
          <option v-for="c in columns" :key="c.name" :value="c.name">{{ c.name }}</option>
        </select>
      </div>
    </div>

    <div class="rounded-md border bg-muted/10 p-3">
      <div class="text-xs text-muted-foreground mb-2">生成模式</div>
      <div class="flex items-center gap-2 text-xs flex-wrap">
        <button v-for="m in fkModes" :key="m.value" type="button" class="px-2 py-1 rounded border text-xs" :class="(params.fkMode || 'random') === m.value ? 'bg-primary text-primary-foreground border-primary' : 'bg-background'" @click="params.fkMode = m.value as 'random' | 'unique' | 'repeat'">
          {{ m.label }}
        </button>
      </div>
    </div>
  </div>
</template>

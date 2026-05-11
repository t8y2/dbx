<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RecycleScroller } from "vue-virtual-scroller";
import {
  Braces,
  Code2,
  Copy,
  Eye,
  Loader2,
  PencilLine,
  RefreshCw,
  Search,
  ScrollText,
  Table2,
  WrapText,
  X,
} from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as api from "@/lib/api";
import type { ConnectionConfig, ObjectInfo, ObjectSourceKind } from "@/types/database";
import { isSchemaAware } from "@/lib/databaseCapabilities";
import { useToast } from "@/composables/useToast";
import { buildEditableObjectSourceSql, objectSourceEditTabTitle } from "@/lib/objectSourceEditor";

type ObjectRow = {
  id: string;
  name: string;
  schema?: string;
  type: "TABLE" | "VIEW" | "PROCEDURE" | "FUNCTION";
  comment?: string | null;
};

type ObjectFilter = "all" | "tables" | "views" | "procedures" | "functions";

const props = defineProps<{
  connection: ConnectionConfig;
  database: string;
  schema?: string;
}>();

const emit = defineEmits<{
  openTable: [target: { tableName: string; schema?: string }];
  schemaChange: [schema: string | undefined];
  editSource: [target: { title: string; sql: string; schema?: string }];
}>();

const { t } = useI18n();
const { toast } = useToast();

const schemas = ref<string[]>([]);
const selectedSchema = ref<string | undefined>(props.schema);
const rows = ref<ObjectRow[]>([]);
const search = ref("");
const objectFilter = ref<ObjectFilter>("all");
const loadingSchemas = ref(false);
const loadingObjects = ref(false);
const sourceLoading = ref(false);
const sourceContent = ref("");
const sourceError = ref("");
const sourceRow = ref<ObjectRow | null>(null);
const sourceWrap = ref(false);
const error = ref("");
let loadId = 0;

const needsSchema = computed(() => isSchemaAware(props.connection.db_type));
const tableCount = computed(() => rows.value.filter((row) => row.type === "TABLE").length);
const viewCount = computed(() => rows.value.filter((row) => row.type === "VIEW").length);
const procedureCount = computed(() => rows.value.filter((row) => row.type === "PROCEDURE").length);
const functionCount = computed(() => rows.value.filter((row) => row.type === "FUNCTION").length);
const objectFilters = computed<ObjectFilter[]>(() =>
  (
    [
      ["all", rows.value.length],
      ["tables", tableCount.value],
      ["views", viewCount.value],
      ["procedures", procedureCount.value],
      ["functions", functionCount.value],
    ] as Array<[ObjectFilter, number]>
  )
    .filter(([filter, count]) => filter === "all" || count > 0)
    .map(([filter]) => filter),
);
const showObjectFilter = computed(() => objectFilters.value.length > 2);
const hasComments = computed(() => rows.value.some((row) => row.comment?.trim()));
const gridTemplateColumns = computed(() =>
  hasComments.value ? "minmax(0,1fr) 120px 160px minmax(160px,0.7fr)" : "minmax(0,1fr) 120px 160px",
);
const searchedRows = computed(() => {
  const q = search.value.trim().toLowerCase();
  if (!q) return rows.value;
  return rows.value.filter((row) =>
    [row.name, row.schema, row.type, row.comment]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(q)),
  );
});
const filteredRows = computed(() => {
  if (objectFilter.value === "tables") return searchedRows.value.filter((row) => row.type === "TABLE");
  if (objectFilter.value === "views") return searchedRows.value.filter((row) => row.type === "VIEW");
  if (objectFilter.value === "procedures") return searchedRows.value.filter((row) => row.type === "PROCEDURE");
  if (objectFilter.value === "functions") return searchedRows.value.filter((row) => row.type === "FUNCTION");
  return searchedRows.value;
});

function normalizeType(type: string): ObjectRow["type"] {
  const value = type.toUpperCase();
  if (value.includes("VIEW")) return "VIEW";
  if (value.includes("PROC")) return "PROCEDURE";
  if (value.includes("FUNC")) return "FUNCTION";
  return "TABLE";
}

function iconFor(row: ObjectRow) {
  if (row.type === "VIEW") return Eye;
  if (row.type === "PROCEDURE") return ScrollText;
  if (row.type === "FUNCTION") return Braces;
  return Table2;
}

function typeLabel(type: ObjectRow["type"]) {
  if (type === "VIEW") return t("objects.view");
  if (type === "PROCEDURE") return t("objects.procedure");
  if (type === "FUNCTION") return t("objects.function");
  return t("objects.table");
}

function iconClass(type: ObjectRow["type"]) {
  if (type === "VIEW") return "text-purple-500";
  if (type === "PROCEDURE") return "text-blue-500";
  if (type === "FUNCTION") return "text-amber-500";
  return "text-green-500";
}

function canOpenSource(row: ObjectRow) {
  return row.type === "VIEW" || row.type === "PROCEDURE" || row.type === "FUNCTION";
}

function sourceTitle(row: ObjectRow | null) {
  if (!row) return t("objects.source");
  return `${row.name} ${t("objects.source")}`;
}

function openRow(row: ObjectRow) {
  if (row.type === "TABLE") {
    emit("openTable", { tableName: row.name, schema: row.schema });
    return;
  }
  if (canOpenSource(row)) {
    void openSource(row);
  }
}

async function openSource(row: ObjectRow) {
  sourceRow.value = row;
  sourceContent.value = "";
  sourceError.value = "";
  sourceLoading.value = true;
  try {
    const result = await api.getObjectSource(
      props.connection.id,
      props.database,
      row.schema || selectedSchema.value || props.database,
      row.name,
      row.type as ObjectSourceKind,
    );
    sourceContent.value = result.source;
  } catch (e: any) {
    sourceError.value = e?.message || String(e);
  } finally {
    sourceLoading.value = false;
  }
}

function closeSource() {
  sourceRow.value = null;
  sourceContent.value = "";
  sourceError.value = "";
}

function copySource() {
  if (!sourceContent.value) return;
  navigator.clipboard.writeText(sourceContent.value);
  toast(t("grid.copied"));
}

function editSource() {
  if (!sourceRow.value || !sourceContent.value) return;
  const row = sourceRow.value;
  const schema = row.schema || selectedSchema.value;
  emit("editSource", {
    title: objectSourceEditTabTitle(schema, row.name),
    schema,
    sql: buildEditableObjectSourceSql({
      databaseType: props.connection.db_type,
      objectType: row.type as ObjectSourceKind,
      schema,
      name: row.name,
      source: sourceContent.value,
    }),
  });
}

async function loadSchemas() {
  if (!needsSchema.value) {
    schemas.value = [];
    selectedSchema.value = undefined;
    return;
  }
  loadingSchemas.value = true;
  try {
    const names = await api.listSchemas(props.connection.id, props.database);
    schemas.value = names;
    if (!selectedSchema.value || !names.includes(selectedSchema.value)) {
      selectedSchema.value = names.includes("public") ? "public" : names[0];
    }
  } finally {
    loadingSchemas.value = false;
  }
}

async function loadObjects() {
  const id = ++loadId;
  loadingObjects.value = true;
  error.value = "";
  rows.value = [];
  try {
    const schema = needsSchema.value ? selectedSchema.value || "" : props.database;
    const objects: ObjectInfo[] = await api.listObjects(props.connection.id, props.database, schema);
    if (id !== loadId) return;
    rows.value = objects.map((object) => ({
      id: `${object.schema || schema || props.database}:${object.name}:${object.object_type}`,
      name: object.name,
      schema: object.schema || (needsSchema.value ? schema : undefined),
      type: normalizeType(object.object_type),
      comment: object.comment,
    }));
  } catch (e: any) {
    if (id !== loadId) return;
    error.value = e?.message || String(e);
  } finally {
    if (id === loadId) loadingObjects.value = false;
  }
}

async function reload() {
  await loadSchemas();
  await loadObjects();
}

function onSchemaChange(value: any) {
  selectedSchema.value = typeof value === "string" && value ? value : undefined;
  emit("schemaChange", selectedSchema.value);
  void loadObjects();
}

function filterCount(filter: ObjectFilter) {
  if (filter === "tables") return tableCount.value;
  if (filter === "views") return viewCount.value;
  if (filter === "procedures") return procedureCount.value;
  if (filter === "functions") return functionCount.value;
  return rows.value.length;
}

function filterLabel(filter: ObjectFilter) {
  const key =
    filter === "tables"
      ? "objects.tables"
      : filter === "views"
        ? "objects.views"
        : filter === "procedures"
          ? "objects.procedures"
          : filter === "functions"
            ? "objects.functions"
            : "objects.all";
  return `${t(key)} ${filterCount(filter)}`;
}

watch(
  () => [props.connection.id, props.database, props.schema] as const,
  () => {
    selectedSchema.value = props.schema;
    void reload();
  },
  { immediate: true },
);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <Table2 class="h-4 w-4 text-muted-foreground" />
        <div class="min-w-0 truncate text-sm font-medium">
          {{ props.database }}<template v-if="selectedSchema"> / {{ selectedSchema }}</template>
        </div>
        <div class="shrink-0 rounded border bg-muted/40 px-1.5 py-0.5 text-xs text-muted-foreground">
          {{ filteredRows.length }} / {{ rows.length }}
        </div>
      </div>
      <div class="flex min-w-[240px] flex-1 items-center gap-2">
        <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <Input v-model="search" class="h-7 text-xs" :placeholder="t('objects.search')" />
        <div v-if="showObjectFilter" class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
          <button
            v-for="filter in objectFilters"
            :key="filter"
            type="button"
            class="h-6 rounded-sm px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
            :class="{ 'bg-background text-foreground shadow-sm': objectFilter === filter }"
            @click="objectFilter = filter"
          >
            {{ filterLabel(filter) }}
          </button>
        </div>
      </div>
      <Select
        v-if="needsSchema"
        :model-value="selectedSchema"
        :disabled="loadingSchemas"
        @update:model-value="onSchemaChange"
      >
        <SelectTrigger class="h-7 w-36 text-xs">
          <SelectValue :placeholder="loadingSchemas ? t('objects.loadingSchemas') : t('objects.schema')" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="schema in schemas" :key="schema" :value="schema">{{ schema }}</SelectItem>
        </SelectContent>
      </Select>
      <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="loadingObjects" @click="reload">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loadingObjects }" />
      </Button>
    </div>

    <div v-if="loadingObjects" class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      {{ t("objects.loading") }}
    </div>
    <div v-else-if="error" class="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">
      {{ error }}
    </div>
    <div
      v-else-if="filteredRows.length === 0"
      class="flex flex-1 items-center justify-center text-sm text-muted-foreground"
    >
      {{ t("objects.empty") }}
    </div>
    <div v-else class="flex min-h-0 flex-1 flex-col">
      <div
        class="grid h-8 shrink-0 items-center gap-3 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground"
        :style="{ gridTemplateColumns }"
      >
        <div class="truncate">{{ t("objects.name") }}</div>
        <div class="truncate">{{ t("objects.type") }}</div>
        <div class="truncate">{{ t("objects.schemaColumn") }}</div>
        <div v-if="hasComments" class="truncate">{{ t("objects.comment") }}</div>
      </div>
      <RecycleScroller class="min-h-0 flex-1" :items="filteredRows" :item-size="38" key-field="id">
        <template #default="{ item }">
          <div
            class="grid h-[38px] cursor-pointer items-center gap-3 border-b px-3 hover:bg-accent/50"
            :class="{ 'bg-accent/40': sourceRow?.id === item.id }"
            :style="{ gridTemplateColumns }"
            @click="openRow(item)"
          >
            <div class="flex min-w-0 items-center gap-2">
              <component :is="iconFor(item)" class="h-3.5 w-3.5 shrink-0" :class="iconClass(item.type)" />
              <span class="truncate text-[13px] font-medium text-foreground">{{ item.name }}</span>
            </div>
            <div class="truncate text-xs text-muted-foreground">{{ typeLabel(item.type) }}</div>
            <div class="truncate text-xs text-muted-foreground">{{ item.schema || props.database }}</div>
            <div v-if="hasComments" class="truncate text-xs text-muted-foreground" :title="item.comment || ''">
              {{ item.comment || "" }}
            </div>
          </div>
        </template>
      </RecycleScroller>
      <div v-if="sourceRow" class="flex h-[42%] min-h-44 shrink-0 flex-col border-t bg-background">
        <div class="flex h-8 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
          <Code2 class="h-3.5 w-3.5 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ sourceTitle(sourceRow) }}</span>
          <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!sourceContent" @click="copySource">
            <Copy class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!sourceContent" @click="editSource">
            <PencilLine class="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            class="h-5 w-5"
            :class="{ 'bg-accent': sourceWrap }"
            @click="sourceWrap = !sourceWrap"
          >
            <WrapText class="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" class="h-5 w-5" @click="closeSource">
            <X class="h-3 w-3" />
          </Button>
        </div>
        <div v-if="sourceLoading" class="flex flex-1 items-center justify-center">
          <Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
        <div v-else-if="sourceError" class="flex flex-1 items-center justify-center px-4 text-sm text-destructive">
          {{ sourceError }}
        </div>
        <pre
          v-else
          class="min-w-0 flex-1 overflow-auto p-3 font-mono text-xs leading-5"
          :class="sourceWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
          >{{ sourceContent }}</pre
        >
      </div>
    </div>
  </div>
</template>

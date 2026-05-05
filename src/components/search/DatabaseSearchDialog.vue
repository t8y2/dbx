<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertCircle, Loader2, Search, Square, Table2 } from "lucide-vue-next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/api";
import {
  buildDatabaseSearchSql,
  buildSearchResultWhere,
  findMatchedSearchColumns,
} from "@/lib/databaseSearch";
import type { DatabaseType, TableInfo } from "@/types/database";

const props = defineProps<{
  open: boolean;
  prefillConnectionId: string;
  prefillDatabase: string;
  prefillSchema?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "open-target": [value: {
    connectionId: string;
    database: string;
    schema?: string;
    tableName: string;
    whereInput?: string;
  }];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const dialogOpen = computed({
  get: () => props.open,
  set: (value) => emit("update:open", value),
});

type SearchResultItem = {
  id: string;
  schema?: string;
  tableName: string;
  matchedColumns: string[];
  preview: string;
  whereInput: string;
};

type SearchTableTask = {
  schema?: string;
  table: TableInfo;
};

const SCHEMA_AWARE_TYPES = new Set<DatabaseType>(["postgres", "sqlserver", "oracle", "redshift"]);
const SYSTEM_SCHEMAS = new Set(["information_schema", "pg_catalog", "sys", "system", "mysql", "performance_schema", "xdb", "outln", "dbsnmp"]);
const MAX_TABLES = 200;

const keyword = ref("");
const perTableLimit = ref(20);
const running = ref(false);
const cancelled = ref(false);
const loadingTables = ref(false);
const progressDone = ref(0);
const progressTotal = ref(0);
const results = ref<SearchResultItem[]>([]);
const tableErrors = ref<Array<{ tableName: string; message: string }>>([]);
const generalError = ref("");
const limitedTables = ref(false);
const currentExecutionId = ref("");
let runId = 0;

const connection = computed(() => props.prefillConnectionId ? connectionStore.getConfig(props.prefillConnectionId) : undefined);
const scopeLabel = computed(() =>
  [connection.value?.name, props.prefillDatabase, props.prefillSchema].filter(Boolean).join(" / "),
);
const canSearch = computed(() =>
  Boolean(props.prefillConnectionId && props.prefillDatabase && keyword.value.trim() && !running.value),
);
const progressLabel = computed(() =>
  t("databaseSearch.progress", { done: progressDone.value, total: progressTotal.value }),
);

watch(dialogOpen, (open) => {
  if (open) {
    resetSearchState();
  } else {
    stopSearch();
  }
});

function resetSearchState() {
  running.value = false;
  cancelled.value = false;
  loadingTables.value = false;
  progressDone.value = 0;
  progressTotal.value = 0;
  results.value = [];
  tableErrors.value = [];
  generalError.value = "";
  limitedTables.value = false;
  currentExecutionId.value = "";
}

function isSchemaAware(databaseType?: DatabaseType): boolean {
  return !!databaseType && SCHEMA_AWARE_TYPES.has(databaseType);
}

function isSearchableTable(table: TableInfo): boolean {
  const type = table.table_type.toUpperCase();
  return type.includes("TABLE") && !type.includes("VIEW");
}

function filterSearchSchemas(schemas: string[]): string[] {
  return schemas.filter((schema) => !SYSTEM_SCHEMAS.has(schema.toLowerCase()));
}

function makeExecutionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `database-search-${crypto.randomUUID()}`;
  return `database-search-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function valuePreview(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  const text = String(value).replace(/\s+/g, " ").trim();
  return text.length > 90 ? `${text.slice(0, 90)}...` : text;
}

function rowPreview(columns: string[], row: unknown[], matchedColumns: string[]): string {
  const matched = matchedColumns
    .slice(0, 3)
    .map((column) => {
      const index = columns.findIndex((name) => name.toLowerCase() === column.toLowerCase());
      return index >= 0 ? `${column}: ${valuePreview(row[index])}` : "";
    })
    .filter(Boolean);

  if (matched.length) return matched.join(" · ");

  return columns
    .slice(0, 3)
    .map((column, index) => `${column}: ${valuePreview(row[index])}`)
    .join(" · ");
}

async function listSearchTables(): Promise<SearchTableTask[]> {
  if (!connection.value || !props.prefillConnectionId || !props.prefillDatabase) return [];
  const databaseType = connection.value.db_type;
  const schemaNames = props.prefillSchema
    ? [props.prefillSchema]
    : isSchemaAware(databaseType)
      ? filterSearchSchemas(await api.listSchemas(props.prefillConnectionId, props.prefillDatabase))
      : [props.prefillDatabase];

  const tasks: SearchTableTask[] = [];
  for (const schema of schemaNames) {
    const tables = await api.listTables(props.prefillConnectionId, props.prefillDatabase, schema);
    for (const table of tables.filter(isSearchableTable)) {
      tasks.push({ schema, table });
    }
  }

  if (tasks.length > MAX_TABLES) {
    limitedTables.value = true;
    return tasks.slice(0, MAX_TABLES);
  }
  return tasks;
}

async function startSearch() {
  if (!canSearch.value || !connection.value) return;
  const currentRun = ++runId;
  resetSearchState();
  running.value = true;
  loadingTables.value = true;

  try {
    await connectionStore.ensureConnected(props.prefillConnectionId);
    const tasks = await listSearchTables();
    if (currentRun !== runId || cancelled.value) return;
    progressTotal.value = tasks.length;
    loadingTables.value = false;

    for (const task of tasks) {
      if (currentRun !== runId || cancelled.value) break;
      await searchTable(task, connection.value.db_type, currentRun);
      progressDone.value += 1;
    }
  } catch (error: any) {
    if (!cancelled.value) generalError.value = error?.message || String(error);
  } finally {
    if (currentRun === runId) {
      running.value = false;
      loadingTables.value = false;
      currentExecutionId.value = "";
    }
  }
}

async function searchTable(task: SearchTableTask, databaseType: DatabaseType, currentRun: number) {
  const tableLabel = task.schema ? `${task.schema}.${task.table.name}` : task.table.name;
  try {
    const schema = task.schema || props.prefillDatabase;
    const columns = await api.getColumns(props.prefillConnectionId, props.prefillDatabase, schema, task.table.name);
    const query = buildDatabaseSearchSql({
      databaseType,
      schema: task.schema,
      tableName: task.table.name,
      columns,
      term: keyword.value,
      limit: perTableLimit.value,
    });
    if (!query || currentRun !== runId || cancelled.value) return;

    const executionId = makeExecutionId();
    currentExecutionId.value = executionId;
    const result = await api.executeQuery(props.prefillConnectionId, props.prefillDatabase, query.sql, executionId);
    if (currentExecutionId.value === executionId) currentExecutionId.value = "";
    if (currentRun !== runId || cancelled.value) return;

    result.rows.forEach((row, rowIndex) => {
      const matchedColumns = findMatchedSearchColumns(result.columns, row, columns, keyword.value);
      const whereInput = buildSearchResultWhere({
        databaseType,
        columns,
        resultColumns: result.columns,
        row,
        matchedColumns,
      });
      results.value.push({
        id: `${tableLabel}:${rowIndex}:${results.value.length}`,
        schema: task.schema,
        tableName: task.table.name,
        matchedColumns,
        preview: rowPreview(result.columns, row, matchedColumns),
        whereInput,
      });
    });
  } catch (error: any) {
    if (!cancelled.value) {
      tableErrors.value.push({ tableName: tableLabel, message: error?.message || String(error) });
    }
  }
}

async function stopSearch() {
  cancelled.value = true;
  runId++;
  running.value = false;
  loadingTables.value = false;
  const executionId = currentExecutionId.value;
  currentExecutionId.value = "";
  if (executionId) {
    try {
      await api.cancelQuery(executionId);
    } catch {
      // Best effort; some drivers may finish before cancellation arrives.
    }
  }
}

function openResult(item: SearchResultItem) {
  emit("open-target", {
    connectionId: props.prefillConnectionId,
    database: props.prefillDatabase,
    schema: item.schema,
    tableName: item.tableName,
    whereInput: item.whereInput,
  });
}
</script>

<template>
  <Dialog v-model:open="dialogOpen">
    <DialogScrollContent class="max-w-4xl gap-0 p-0">
      <DialogHeader class="border-b px-5 py-4">
        <DialogTitle class="flex items-center gap-2">
          <Search class="h-5 w-5" />
          {{ t('databaseSearch.title') }}
        </DialogTitle>
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{{ scopeLabel }}</span>
          <Badge v-if="props.prefillSchema" variant="secondary">{{ props.prefillSchema }}</Badge>
        </div>
      </DialogHeader>

      <div class="space-y-4 px-5 py-4">
        <div class="grid gap-3 md:grid-cols-[1fr_9rem_auto]">
          <div class="space-y-1.5">
            <Label class="text-xs">{{ t('databaseSearch.keyword') }}</Label>
            <Input
              v-model="keyword"
              class="h-9"
              :placeholder="t('databaseSearch.keywordPlaceholder')"
              :disabled="running"
              @keydown.enter.prevent="startSearch"
            />
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">{{ t('databaseSearch.limitPerTable') }}</Label>
            <Input v-model.number="perTableLimit" class="h-9" type="number" min="1" max="100" :disabled="running" />
          </div>
          <div class="flex items-end gap-2">
            <Button class="h-9" :disabled="!canSearch" @click="startSearch">
              <Loader2 v-if="running" class="h-4 w-4 animate-spin" />
              <Search v-else class="h-4 w-4" />
              {{ running ? t('databaseSearch.searching') : t('databaseSearch.search') }}
            </Button>
            <Button v-if="running" variant="destructive" class="h-9" @click="stopSearch">
              <Square class="h-4 w-4 fill-current" />
              {{ t('databaseSearch.stop') }}
            </Button>
          </div>
        </div>

        <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
          {{ t('databaseSearch.hint') }}
        </div>

        <div v-if="running || progressTotal" class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{{ loadingTables ? t('databaseSearch.loadingTables') : progressLabel }}</span>
          <span>{{ t('databaseSearch.resultCount', { count: results.length }) }}</span>
          <span v-if="limitedTables" class="text-amber-600">{{ t('databaseSearch.limitedTables', { count: 200 }) }}</span>
        </div>

        <div v-if="generalError" class="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          <AlertCircle class="mt-0.5 h-4 w-4" />
          <span>{{ generalError }}</span>
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <div class="text-sm font-medium">{{ t('databaseSearch.results') }}</div>
            <Badge variant="outline">{{ results.length }}</Badge>
          </div>
          <div v-if="results.length" class="max-h-[360px] space-y-2 overflow-auto pr-1">
            <button
              v-for="item in results"
              :key="item.id"
              class="flex w-full items-start gap-3 rounded-md border bg-background px-3 py-2 text-left transition-colors hover:bg-muted/40"
              @click="openResult(item)"
            >
              <Table2 class="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                  <span class="truncate font-medium">{{ item.schema ? `${item.schema}.${item.tableName}` : item.tableName }}</span>
                  <Badge v-for="column in item.matchedColumns" :key="column" variant="secondary">{{ column }}</Badge>
                </div>
                <div class="mt-1 truncate text-xs text-muted-foreground">{{ item.preview }}</div>
              </div>
              <span class="shrink-0 text-xs text-primary">{{ t('databaseSearch.openResult') }}</span>
            </button>
          </div>
          <div v-else class="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground">
            {{ running ? t('databaseSearch.waiting') : t('databaseSearch.noResults') }}
          </div>
        </div>

        <div v-if="tableErrors.length" class="space-y-2">
          <div class="text-sm font-medium text-muted-foreground">{{ t('databaseSearch.errors') }}</div>
          <div class="max-h-24 space-y-1 overflow-auto rounded-md border bg-muted/20 p-2 text-xs text-muted-foreground">
            <div v-for="error in tableErrors" :key="`${error.tableName}:${error.message}`">
              <span class="font-medium text-foreground">{{ error.tableName }}</span>: {{ error.message }}
            </div>
          </div>
        </div>
      </div>

      <DialogFooter class="border-t px-5 py-3">
        <Button variant="outline" @click="dialogOpen = false">{{ t('common.close') }}</Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>

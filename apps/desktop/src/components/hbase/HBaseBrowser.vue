<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Braces, DatabaseZap, ListFilter, Loader2, Plus, RefreshCw, ScanSearch, TableProperties, Trash2 } from "@lucide/vue";
import { useI18n } from "vue-i18n";

import DataGrid from "@/components/grid/DataGrid.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CustomSaveHandler } from "@/composables/useDataGridEditor";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";
import type { CellValue } from "@/lib/dataGrid/cellValue";
import { encodeHBaseTextInput, hbaseCellInput } from "@/lib/hbase/hbaseValues";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import type { QueryResult } from "@/types/database";
import type { HBaseCellInput, HBasePutRowInput, HBaseRow, HBaseTableSchema, HBaseValueEncoding } from "@/types/hbase";

const props = defineProps<{
  tabId: string;
  connectionId: string;
  namespace: string;
  table: string;
  createTableOnOpen?: boolean;
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();

type LookupMode = "prefix" | "exact";

const rows = ref<HBaseRow[]>([]);
const loading = ref(false);
const error = ref("");
const lookupMode = ref<LookupMode>("prefix");
const rowKeyInput = ref("");
const rowLimit = ref("100");
const truncated = ref(false);
const elapsedMs = ref(0);
const schema = ref<HBaseTableSchema>();
const schemaLoading = ref(false);
const schemaDialogOpen = ref(false);
const writeDialogOpen = ref(false);
const writeJson = ref("");
const writeLoading = ref(false);
const writeError = ref("");
const createTableDialogOpen = ref(false);
const createTableName = ref("");
const createColumnFamilies = ref("");
const createTableLoading = ref(false);
const createTableError = ref("");
const deleteTableDialogOpen = ref(false);
const deleteTableLoading = ref(false);
const deleteTableError = ref("");

const hasTable = computed(() => props.table.trim().length > 0);
const readOnly = computed(() => connectionStore.getConfig(props.connectionId)?.read_only === true);
const qualifiedTableLabel = computed(() => {
  if (!hasTable.value) return props.namespace;
  return props.namespace && props.namespace !== "default" ? `${props.namespace}:${props.table}` : props.table;
});

const gridColumns = computed(() => {
  const columns = new Set<string>();
  for (const row of rows.value) {
    for (const cell of row.cells) columns.add(cell.column);
  }
  return ["_row_key", ...Array.from(columns).sort((left, right) => left.localeCompare(right))];
});

const gridResult = computed<QueryResult>(() => {
  const columns = gridColumns.value;
  const data = rows.value.map((row) => {
    const cells = new Map(row.cells.map((cell) => [cell.column, cell.value]));
    return columns.map((column) => (column === "_row_key" ? row.rowKey : (cells.get(column) ?? null)));
  });
  return {
    columns,
    column_types: columns.map((column) => (column === "_row_key" ? "ROW_KEY" : "HBASE_CELL")),
    column_sortables: columns.map(() => false),
    rows: data,
    affected_rows: data.length,
    execution_time_ms: elapsedMs.value,
    total_is_exact: !truncated.value,
  };
});

const customSaveHandler = computed<CustomSaveHandler>(() => ({
  save: saveGridChanges,
  preview: previewGridChanges,
  supportsInsert: false,
  canInsert: false,
  canDelete: !readOnly.value,
  readonlyColumns: ["_row_key"],
  targetLabel: qualifiedTableLabel.value,
}));

watch(
  () => [props.connectionId, props.namespace, props.table] as const,
  () => {
    rows.value = [];
    schema.value = undefined;
    rowKeyInput.value = "";
    if (hasTable.value) void refreshRows();
  },
  { immediate: true },
);

watch(
  () => props.createTableOnOpen,
  (requested) => {
    if (!requested) return;
    openCreateTableDialog();
    const tab = queryStore.tabs.find((candidate) => candidate.id === props.tabId);
    if (tab) tab.hbaseCreateTableOnOpen = undefined;
  },
  { immediate: true },
);

async function refreshRows() {
  if (loading.value || !hasTable.value) return;
  loading.value = true;
  error.value = "";
  const startedAt = performance.now();
  try {
    if (lookupMode.value === "exact" && rowKeyInput.value) {
      const rowKey = encodeHBaseTextInput(rowKeyInput.value);
      const row = await api.hbaseGetRow(props.connectionId, props.namespace, props.table, rowKey.value, rowKey.encoding);
      rows.value = row ? [row] : [];
      truncated.value = false;
    } else {
      const result = await api.hbaseScanRows(props.connectionId, props.namespace, props.table, rowKeyInput.value || undefined, Number(rowLimit.value));
      rows.value = result.rows;
      truncated.value = result.truncated;
    }
  } catch (caught) {
    error.value = errorMessage(caught);
  } finally {
    elapsedMs.value = Math.round(performance.now() - startedAt);
    loading.value = false;
  }
}

async function openSchemaDialog() {
  schemaDialogOpen.value = true;
  if (schema.value) return;
  schemaLoading.value = true;
  try {
    schema.value = await api.hbaseGetTableSchema(props.connectionId, props.namespace, props.table);
  } catch (caught) {
    error.value = errorMessage(caught);
    schemaDialogOpen.value = false;
  } finally {
    schemaLoading.value = false;
  }
}

async function openWriteDialog() {
  if (schemaLoading.value) return;
  error.value = "";
  schemaLoading.value = true;
  try {
    schema.value ??= await api.hbaseGetTableSchema(props.connectionId, props.namespace, props.table);
  } catch (caught) {
    error.value = errorMessage(caught);
    return;
  } finally {
    schemaLoading.value = false;
  }
  const family = schema.value.columnFamilies[0]?.name;
  if (!family) {
    error.value = t("hbase.noColumnFamilies");
    return;
  }
  writeJson.value = JSON.stringify(
    {
      rowKey: "",
      cells: {
        [`${family}:qualifier`]: "value",
      },
    },
    null,
    2,
  );
  writeError.value = "";
  writeDialogOpen.value = true;
}

function openCreateTableDialog() {
  createTableError.value = "";
  createTableName.value = "";
  createColumnFamilies.value = "";
  createTableDialogOpen.value = true;
}

async function writeRow() {
  if (writeLoading.value) return;
  writeLoading.value = true;
  writeError.value = "";
  try {
    const input = parseWriteInput(writeJson.value);
    await api.hbasePutRow(props.connectionId, props.namespace, props.table, input);
    writeDialogOpen.value = false;
    toast(t("hbase.rowSaved"));
    await refreshRows();
  } catch (caught) {
    writeError.value = errorMessage(caught);
  } finally {
    writeLoading.value = false;
  }
}

async function createTable() {
  if (createTableLoading.value) return;
  const families = createColumnFamilies.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  createTableLoading.value = true;
  createTableError.value = "";
  try {
    const createdTable = createTableName.value.trim();
    await api.hbaseCreateTable(props.connectionId, props.namespace, createdTable, families);
    createTableDialogOpen.value = false;
    toast(t("hbase.tableCreated", { table: createdTable }));
    await connectionStore.loadTables(props.connectionId, props.namespace);
    if (!hasTable.value) {
      const tab = queryStore.tabs.find((candidate) => candidate.id === props.tabId);
      if (tab) tab.title = createdTable;
      queryStore.updateSql(props.tabId, createdTable);
    }
  } catch (caught) {
    createTableError.value = errorMessage(caught);
  } finally {
    createTableLoading.value = false;
  }
}

async function deleteTable() {
  if (deleteTableLoading.value) return;
  deleteTableLoading.value = true;
  deleteTableError.value = "";
  try {
    await api.hbaseDeleteTable(props.connectionId, props.namespace, props.table);
    deleteTableDialogOpen.value = false;
    await connectionStore.loadTables(props.connectionId, props.namespace);
    queryStore.closeTab(props.tabId);
    toast(t("hbase.tableDeleted", { table: qualifiedTableLabel.value }));
  } catch (caught) {
    deleteTableError.value = errorMessage(caught);
  } finally {
    deleteTableLoading.value = false;
  }
}

async function saveGridChanges(changes: { dirtyRows: Map<number, Map<number, CellValue>>; deletedRows: Set<number>; columns: string[] }) {
  for (const [rowIndex, dirtyColumns] of changes.dirtyRows) {
    const row = rows.value[rowIndex];
    if (!row) continue;
    const cells: HBaseCellInput[] = [];
    for (const [columnIndex, value] of dirtyColumns) {
      const column = changes.columns[columnIndex];
      if (!column || column === "_row_key") continue;
      cells.push(hbaseCellInput(column, value));
    }
    if (cells.length > 0) {
      await api.hbasePutRow(props.connectionId, props.namespace, props.table, {
        rowKey: row.rowKeyBase64,
        rowKeyEncoding: "base64",
        cells,
      });
    }
  }
  for (const rowIndex of changes.deletedRows) {
    const row = rows.value[rowIndex];
    if (!row) continue;
    await api.hbaseDeleteRow(props.connectionId, props.namespace, props.table, row.rowKeyBase64, "base64");
  }
}

async function previewGridChanges(changes: { dirtyRows: Map<number, Map<number, CellValue>>; deletedRows: Set<number>; columns: string[] }) {
  const statements: string[] = [];
  for (const [rowIndex, dirtyColumns] of changes.dirtyRows) {
    const row = rows.value[rowIndex];
    if (!row) continue;
    const columns = Array.from(dirtyColumns.keys())
      .map((index) => changes.columns[index])
      .filter((column) => column && column !== "_row_key");
    if (columns.length > 0) statements.push(`PUT ${qualifiedTableLabel.value}/${row.rowKey} (${columns.join(", ")})`);
  }
  for (const rowIndex of changes.deletedRows) {
    const row = rows.value[rowIndex];
    if (row) statements.push(`DELETE ${qualifiedTableLabel.value}/${row.rowKey}`);
  }
  return statements;
}

function parseWriteInput(source: string): HBasePutRowInput {
  const value = JSON.parse(source) as { rowKey?: unknown; cells?: unknown };
  const rowKey = encodedJsonValue(value.rowKey, "rowKey");
  if (!value.cells || typeof value.cells !== "object" || Array.isArray(value.cells)) {
    throw new Error(t("hbase.cellsObjectRequired"));
  }
  const cells = Object.entries(value.cells as Record<string, unknown>).map(([column, cellValue]) => {
    const encoded = encodedJsonValue(cellValue, column);
    return { column, value: encoded.value, valueEncoding: encoded.encoding };
  });
  if (cells.length === 0) throw new Error(t("hbase.cellRequired"));
  return { rowKey: rowKey.value, rowKeyEncoding: rowKey.encoding, cells };
}

function encodedJsonValue(value: unknown, label: string): { value: string; encoding: HBaseValueEncoding } {
  if (typeof value === "string") {
    return value.startsWith("base64:") ? { value: value.slice(7), encoding: "base64" } : { value, encoding: "utf8" };
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as { base64?: unknown }).base64 === "string") {
    return { value: (value as { base64: string }).base64, encoding: "base64" };
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return { value: value === null ? "" : String(value), encoding: "utf8" };
  }
  throw new Error(t("hbase.invalidJsonValue", { label }));
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex min-h-10 shrink-0 flex-wrap items-center gap-2 border-b px-2 py-1.5">
      <div class="flex min-w-0 items-center gap-1.5 pr-1">
        <DatabaseZap class="h-4 w-4 shrink-0 text-primary" />
        <span class="truncate text-xs font-medium">{{ qualifiedTableLabel }}</span>
      </div>

      <div v-if="hasTable" class="flex h-7 shrink-0 items-center rounded border bg-muted/40 p-0.5">
        <button type="button" class="flex h-6 items-center gap-1 rounded-sm px-2 text-xs transition-colors" :class="lookupMode === 'prefix' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="lookupMode = 'prefix'">
          <ListFilter class="h-3.5 w-3.5" />
          {{ t("hbase.prefix") }}
        </button>
        <button type="button" class="flex h-6 items-center gap-1 rounded-sm px-2 text-xs transition-colors" :class="lookupMode === 'exact' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="lookupMode = 'exact'">
          <ScanSearch class="h-3.5 w-3.5" />
          {{ t("hbase.exact") }}
        </button>
      </div>

      <Input v-if="hasTable" v-model="rowKeyInput" class="h-7 min-w-40 flex-1 text-xs sm:max-w-80" :placeholder="lookupMode === 'prefix' ? t('hbase.rowKeyPrefix') : t('hbase.rowKey')" @keydown.enter="refreshRows" />

      <Select v-if="hasTable && lookupMode === 'prefix'" v-model="rowLimit">
        <SelectTrigger class="h-7 w-24 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="50">50 {{ t("hbase.rows") }}</SelectItem>
          <SelectItem value="100">100 {{ t("hbase.rows") }}</SelectItem>
          <SelectItem value="200">200 {{ t("hbase.rows") }}</SelectItem>
          <SelectItem value="500">500 {{ t("hbase.rows") }}</SelectItem>
        </SelectContent>
      </Select>

      <Button v-if="hasTable" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="loading" @click="refreshRows">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
      <Button v-if="hasTable" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="openSchemaDialog">
        <Braces class="h-3.5 w-3.5" />
        {{ t("hbase.schema") }}
      </Button>
      <Button v-if="hasTable && !readOnly" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="schemaLoading" @click="openWriteDialog">
        <Loader2 v-if="schemaLoading" class="h-3.5 w-3.5 animate-spin" />
        <Plus v-else class="h-3.5 w-3.5" />
        {{ t("hbase.writeRow") }}
      </Button>
      <Button v-if="hasTable && !readOnly" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" @click="openCreateTableDialog">
        <TableProperties class="h-3.5 w-3.5" />
        {{ t("hbase.createTable") }}
      </Button>
      <Button
        v-if="hasTable && !readOnly"
        variant="ghost"
        size="icon-sm"
        class="h-7 w-7 text-destructive"
        :aria-label="t('hbase.deleteTable')"
        @click="
          deleteTableError = '';
          deleteTableDialogOpen = true;
        "
      >
        <Trash2 class="h-3.5 w-3.5" />
      </Button>
    </div>

    <div v-if="hasTable" class="flex h-7 shrink-0 items-center gap-2 border-b px-3 text-[11px] text-muted-foreground">
      <span>{{ t("hbase.loadedRows", { count: rows.length }) }}</span>
      <span>{{ elapsedMs }} ms</span>
      <span v-if="truncated" class="text-amber-600 dark:text-amber-400">{{ t("hbase.resultTruncated") }}</span>
    </div>

    <ErrorBanner v-if="error" :message="error" dismissible @dismiss="error = ''" />
    <DataGrid
      v-if="hasTable"
      class="min-h-0 flex-1"
      :result="gridResult"
      context="results"
      database-type="hbase"
      :editable="!readOnly"
      :custom-save-handler="customSaveHandler"
      :allow-insert-rows="false"
      :allow-delete-rows="!readOnly"
      :loading="loading"
      :page-limit="Number(rowLimit)"
      :total-row-count="rows.length"
      :total-row-count-is-exact="!truncated"
      @reload="refreshRows"
    />
    <div v-else class="flex min-h-0 flex-1 items-center justify-center">
      <Button v-if="!readOnly" variant="outline" class="gap-2" @click="openCreateTableDialog">
        <TableProperties class="h-4 w-4" />
        {{ t("hbase.createTable") }}
      </Button>
    </div>

    <Dialog v-model:open="schemaDialogOpen">
      <DialogContent class="max-h-[80vh] max-w-2xl overflow-hidden p-0">
        <DialogHeader class="border-b px-4 py-3">
          <DialogTitle class="text-sm">{{ t("hbase.tableSchema", { table: qualifiedTableLabel }) }}</DialogTitle>
        </DialogHeader>
        <div class="min-h-0 overflow-auto px-4 py-3">
          <div v-if="schemaLoading" class="flex min-h-32 items-center justify-center">
            <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
          <div v-else-if="schema" class="space-y-4 text-xs">
            <section v-for="family in schema.columnFamilies" :key="family.name" class="border-b pb-3 last:border-b-0">
              <div class="mb-2 font-medium">{{ family.name }}</div>
              <dl class="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1 font-mono text-[11px]">
                <template v-for="(value, key) in family.properties" :key="key">
                  <dt class="text-muted-foreground">{{ key }}</dt>
                  <dd class="break-all">{{ value }}</dd>
                </template>
              </dl>
            </section>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="writeDialogOpen">
      <DialogContent class="max-w-xl">
        <DialogHeader>
          <DialogTitle class="text-sm">{{ t("hbase.writeRow") }}</DialogTitle>
        </DialogHeader>
        <ErrorBanner v-if="writeError" :message="writeError" dismissible @dismiss="writeError = ''" />
        <textarea v-model="writeJson" class="min-h-64 w-full resize-y rounded border bg-muted/20 p-3 font-mono text-xs outline-none focus:ring-1 focus:ring-ring" spellcheck="false" />
        <DialogFooter>
          <Button variant="outline" :disabled="writeLoading" @click="writeDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="writeLoading" @click="writeRow">
            <Loader2 v-if="writeLoading" class="mr-1.5 h-4 w-4 animate-spin" />
            {{ t("common.save") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="createTableDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="text-sm">{{ t("hbase.createTableIn", { namespace }) }}</DialogTitle>
        </DialogHeader>
        <ErrorBanner v-if="createTableError" :message="createTableError" dismissible @dismiss="createTableError = ''" />
        <div class="space-y-3">
          <Input v-model="createTableName" :placeholder="t('hbase.tableName')" />
          <Input v-model="createColumnFamilies" :placeholder="t('hbase.columnFamiliesPlaceholder')" @keydown.enter="createTable" />
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="createTableLoading" @click="createTableDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="createTableLoading || !createTableName.trim() || !createColumnFamilies.trim()" @click="createTable">
            <Loader2 v-if="createTableLoading" class="mr-1.5 h-4 w-4 animate-spin" />
            {{ t("hbase.create") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <DangerConfirmDialog
      v-model:open="deleteTableDialogOpen"
      :title="t('hbase.deleteTable')"
      :message="t('hbase.deleteTableConfirm', { table: qualifiedTableLabel })"
      :details="qualifiedTableLabel"
      :confirm-label="t('common.delete')"
      :loading="deleteTableLoading"
      :close-on-confirm="false"
      @confirm="deleteTable"
    >
      <template #options>
        <ErrorBanner v-if="deleteTableError" :message="deleteTableError" dismissible class="mb-3" @dismiss="deleteTableError = ''" />
      </template>
    </DangerConfirmDialog>
  </div>
</template>

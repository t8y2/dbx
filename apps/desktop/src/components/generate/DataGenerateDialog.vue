<script setup lang="ts">
import { reactive, ref, computed, onMounted, watch, type ComponentPublicInstance } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/api";
import type { TableGenerateConfig } from "@/lib/dataGenerate";
import { findGeneratorKey, generateTableData } from "@/lib/dataGenerate";
import { quoteTableIdentifier } from "@/lib/tableSelectSql";
import { effectiveDatabaseTypeForConnection } from "@/lib/jdbcDialect";
import GeneratorParamsPanel from "./params/GeneratorParamsPanel.vue";
import type { ColumnInfo, TableInfo } from "@/types/database";

import { Dialog, DialogHeader, DialogTitle, DialogScrollContent, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Database, Table, Columns, Loader2, Save, Upload, Settings, ChevronRight, X, AlertCircle, ArrowUp, ArrowDown } from "@lucide/vue";
import { ScrollArea } from "@/components/ui/scroll-area";

const { t } = useI18n();
const store = useConnectionStore();
const dbType = computed(() => effectiveDatabaseTypeForConnection(store.getConfig(props.prefillConnectionId ?? "")));
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
}>();

// Left tree state
const schemas = ref<string[]>([]);
const expandedSchemas = reactive<Record<string, boolean>>({});
const schemaTables = reactive<Record<string, TableInfo[]>>({});
const schemaLoading = reactive<Record<string, boolean>>({});
const schemaError = reactive<Record<string, string>>({});
const loading = ref(false);

// Table expansion and columns cache
const expandedTables = reactive<Record<string, boolean>>({});
const tableColumnsExt = reactive<Record<string, ColumnInfo[]>>({});
const tableColumnsLoading = reactive<Record<string, boolean>>({});

// Config cache
const configs = reactive<Record<string, TableGenerateConfig>>({});
const checkedTables = reactive<Record<string, boolean>>({});
const checkedColumns = reactive<Record<string, boolean>>({});

// Right panel state — explicitly set by activation functions
const panelTableKey = ref<string | null>(null);
const panelMode = ref<"table" | "column" | null>(null);
const panelColumnName = ref<string | null>(null);

// Step state: config -> preview
const currentStep = ref<"config" | "preview" | "result">("config");
const generatedResults = ref<{ tableName: string; columns: string[]; rows: unknown[][]; sql: string }[]>([]);

const connectionName = computed(() => (props.prefillConnectionId ? store.getConfig(props.prefillConnectionId)?.name : ""));

function tableKey(schema: string, table: string) {
  return `${schema}.${table}`;
}
function colKey(schema: string, table: string, column: string) {
  return `${schema}.${table}.${column}`;
}

// Derived state for template
const activeCfg = computed(() => {
  const k = panelTableKey.value;
  return k ? (configs[k] ?? null) : null;
});
const activeCol = computed(() => {
  if (panelMode.value !== "column" || !panelColumnName.value || !activeCfg.value) return null;
  return activeCfg.value.columns.find((c) => c.columnName === panelColumnName.value) ?? null;
});

async function loadSchemas() {
  const cid = props.prefillConnectionId;
  const db = props.prefillDatabase;
  if (!cid || !db) return;
  loading.value = true;
  try {
    await store.ensureConnected(cid);

    let schemaList: string[];
    try {
      schemaList = await api.listSchemas(cid, db);
    } catch {
      schemaList = [];
    }
    if (schemaList.length === 0) {
      schemaList = [props.prefillSchema || db || "main"];
    }
    schemas.value = schemaList;

    const schemaCandidates = props.prefillSchema && schemaList.includes(props.prefillSchema) ? [props.prefillSchema] : [schemaList[0]];

    if (props.prefillTable && schemaCandidates[0]) {
      for (const targetSchema of schemaCandidates) {
        if (!targetSchema) continue;
        expandedSchemas[targetSchema] = true;
        try {
          const tables = await api.listTables(cid, db, targetSchema);
          schemaTables[targetSchema] = tables;
          if (tables.some((t: { name: string }) => t.name === props.prefillTable)) {
            const cols = await api.getColumns(cid, db, targetSchema, props.prefillTable);
            const key = tableKey(targetSchema, props.prefillTable);
            configs[key] = {
              tableName: props.prefillTable,
              schema: targetSchema,
              database: db,
              rowCount: 1000,
              columns: cols.map((c: ColumnInfo) => ({
                columnName: c.name,
                dataType: c.data_type,
                rowCount: 1000,
                generatorKey: findGeneratorKey(c.name, c.data_type),
                generatorParams: {},
                isAutoIncrement: c.extra === "auto_increment" || (c.column_default?.includes("nextval") ?? false),
              })),
            };
            checkedTables[key] = true;
            for (const c of cols) {
              checkedColumns[colKey(targetSchema, props.prefillTable, c.name)] = true;
            }
            break;
          }
        } catch {
          // try next schema
        }
      }
    }
  } catch {
    // silently fail
  } finally {
    loading.value = false;
  }
}

async function toggleSchema(schema: string) {
  if (expandedSchemas[schema]) {
    expandedSchemas[schema] = false;
    return;
  }
  expandedSchemas[schema] = true;
  if (!schemaTables[schema] && props.prefillConnectionId && props.prefillDatabase) {
    schemaLoading[schema] = true;
    schemaError[schema] = "";
    try {
      const tables = await api.listTables(props.prefillConnectionId, props.prefillDatabase, schema);
      schemaTables[schema] = tables;
    } catch (e: any) {
      schemaError[schema] = String(e?.message ?? e);
    } finally {
      schemaLoading[schema] = false;
    }
  }
}

async function toggleTable(schema: string, table: string) {
  const key = tableKey(schema, table);
  if (expandedTables[key]) {
    expandedTables[key] = false;
    return;
  }
  expandedTables[key] = true;
  if (!tableColumnsExt[key] && props.prefillConnectionId && props.prefillDatabase) {
    tableColumnsLoading[key] = true;
    try {
      const cols = await api.getColumns(props.prefillConnectionId, props.prefillDatabase, schema, table);
      tableColumnsExt[key] = cols;
    } catch {
      // ignore
    } finally {
      tableColumnsLoading[key] = false;
    }
  }
}

async function loadColumns(schema: string, table: string) {
  const key = tableKey(schema, table);
  if (configs[key]) return configs[key];
  if (!props.prefillConnectionId || !props.prefillDatabase) return null;
  const cols = await api.getColumns(props.prefillConnectionId, props.prefillDatabase, schema, table);
  const cfg: TableGenerateConfig = {
    tableName: table,
    schema,
    database: props.prefillDatabase,
    rowCount: 1000,
    columns: cols.map((c: ColumnInfo) => ({
      columnName: c.name,
      dataType: c.data_type,
      rowCount: 1000,
      generatorKey: findGeneratorKey(c.name, c.data_type),
      generatorParams: {},
      isAutoIncrement: c.extra === "auto_increment" || (c.column_default?.includes("nextval") ?? false),
    })),
  };
  configs[key] = cfg;
  for (const c of cols) {
    const ck = colKey(schema, table, c.name);
    if (checkedColumns[ck] === undefined) checkedColumns[ck] = true;
  }
  return cfg;
}

async function selectTable(schema: string, table: string, checked: boolean) {
  const key = tableKey(schema, table);
  if (checked) {
    checkedTables[key] = true;
    if (!configs[key]) {
      await loadColumns(schema, table);
    }
    const cols = tableColumnsExt[key] ?? configs[key]?.columns;
    if (cols) {
      for (const c of cols) {
        checkedColumns[colKey(schema, table, c.name ?? (c as any).columnName)] = true;
      }
    }
  } else {
    delete checkedTables[key];
    const cols = tableColumnsExt[key] ?? configs[key]?.columns;
    if (cols) {
      for (const c of cols) {
        checkedColumns[colKey(schema, table, c.name ?? (c as any).columnName)] = false;
      }
    }
  }
}

function toggleColumn(schema: string, table: string, column: string) {
  const ck = colKey(schema, table, column);
  const key = tableKey(schema, table);
  checkedColumns[ck] = !checkedColumns[ck];
  if (checkedColumns[ck]) {
    checkedTables[key] = true;
  } else {
    const cols = tableColumnsExt[key] ?? configs[key]?.columns;
    if (cols) {
      const hasAny = cols.some((c) => checkedColumns[colKey(schema, table, c.name ?? (c as any).columnName)]);
      if (!hasAny) delete checkedTables[key];
    }
  }
}

async function showColumn(schema: string, table: string, column: string) {
  const key = tableKey(schema, table);
  if (!configs[key]) {
    try {
      await loadColumns(schema, table);
    } catch {
      return;
    }
  }
  panelTableKey.value = key;
  panelMode.value = "column";
  panelColumnName.value = column;
}

async function showTable(schema: string, table: string) {
  const key = tableKey(schema, table);
  if (!configs[key]) {
    try {
      await loadColumns(schema, table);
    } catch {
      return;
    }
  }
  panelTableKey.value = key;
  panelMode.value = "table";
  panelColumnName.value = null;
}

const previewTableIndex = ref(0);
const previewColWidths = reactive<Record<number, number>>({});

function onPreviewColResizeStart(ci: number, event: MouseEvent) {
  event.preventDefault();
  const startX = event.clientX;
  const startW = previewColWidths[ci] ?? 120;
  const onMove = (e: MouseEvent) => {
    previewColWidths[ci] = Math.max(60, startW + e.clientX - startX);
  };
  const onUp = () => {
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.body.classList.remove("select-none", "cursor-col-resize");
  };
  document.addEventListener("pointermove", onMove);
  document.addEventListener("pointerup", onUp);
  document.body.classList.add("select-none", "cursor-col-resize");
}
const currentPreview = computed(() => generatedResults.value[previewTableIndex.value] ?? { tableName: "", columns: [], rows: [], sql: "" });

async function fetchMaxValues(cfg: TableGenerateConfig): Promise<Record<string, number>> {
  const starts: Record<string, number> = {};
  const aiCols = cfg.columns.filter((c) => {
    const ck = colKey(cfg.schema, cfg.tableName, c.columnName);
    return c.isAutoIncrement && checkedColumns[ck] !== false;
  });
  if (aiCols.length === 0) return starts;
  const cid = props.prefillConnectionId!;
  const db = props.prefillDatabase!;
  for (const col of aiCols) {
    try {
      const schemaPart = cfg.schema ? `${quoteTableIdentifier(dbType.value, cfg.schema)}.` : "";
      const sql = `SELECT COALESCE(MAX(${quoteTableIdentifier(dbType.value, col.columnName)}), 0) FROM ${schemaPart}${quoteTableIdentifier(dbType.value, cfg.tableName)}`;
      const result = await api.executeQuery(cid, db, sql, cfg.schema, undefined, { maxRows: 1 });
      const val = result.rows.length > 0 ? Number(result.rows[0][0]) : 0;
      starts[col.columnName] = (Number.isNaN(val) ? 0 : val) + 1;
    } catch {
      starts[col.columnName] = 1;
    }
  }
  return starts;
}

async function doGenerate() {
  const results: { tableName: string; columns: string[]; rows: unknown[][]; sql: string }[] = [];
  const order = tableOrder.value.length > 0 ? tableOrder.value : Object.keys(configs);
  for (const key of order) {
    if (!checkedTables[key]) continue;
    const cfg = configs[key];
    let columns = cfg.columns.filter((col) => checkedColumns[colKey(cfg.schema, cfg.tableName, col.columnName)] !== false);
    if (columns.length === 0) continue;
    const aiStarts = await fetchMaxValues(cfg);
    if (Object.keys(aiStarts).length > 0) {
      columns = columns.map((col) => {
        const start = aiStarts[col.columnName];
        if (start !== undefined) {
          return { ...col, generatorKey: "sequence", generatorParams: { startValue: start, increment: 1 } };
        }
        return col;
      });
    }
    const result = generateTableData({ ...cfg, columns }, dbType.value);
    results.push({ tableName: cfg.tableName, columns: result.columns, rows: result.rows, sql: result.sql });
  }
  generatedResults.value = results;
  previewTableIndex.value = 0;
  currentStep.value = "preview";
}

async function regenerate() {
  if (generatedResults.value.length === 0) return;
  const key = Object.keys(configs).find((k) => configs[k].tableName === generatedResults.value[previewTableIndex.value]?.tableName);
  if (!key) return;
  const cfg = configs[key];
  let columns = cfg.columns.filter((col) => checkedColumns[colKey(cfg.schema, cfg.tableName, col.columnName)] !== false);
  const aiStarts = await fetchMaxValues(cfg);
  if (Object.keys(aiStarts).length > 0) {
    columns = columns.map((col) => {
      const start = aiStarts[col.columnName];
      if (start !== undefined) {
        return { ...col, generatorKey: "sequence", generatorParams: { startValue: start, increment: 1 } };
      }
      return col;
    });
  }
  const result = generateTableData({ ...cfg, columns }, dbType.value);
  generatedResults.value[previewTableIndex.value] = { tableName: cfg.tableName, columns: result.columns, rows: result.rows, sql: result.sql };
}

function copyAllSql() {
  const allSql = allSqlStatements().join("\n\n");
  void navigator.clipboard.writeText(allSql);
}

const executing = ref(false);

interface TableResult {
  table: string;
  total: number;
  ok: number;
  err: number;
  error?: string;
}
const executeResults = ref<TableResult[]>([]);

const generateOptions = reactive({
  continueOnError: false,
  truncate: false,
  useTransaction: true,
  extendedInsert: true,
});

const optionsDialogOpen = ref(false);

function sqlStatementsForTable(r: { tableName: string; columns: string[]; rows: unknown[][]; sql: string }): string[] {
  const stmts: string[] = [];
  if (generateOptions.truncate) {
    stmts.push(`TRUNCATE TABLE ${quoteTableIdentifier(dbType.value, r.tableName)};`);
  }
  if (generateOptions.extendedInsert) {
    stmts.push(r.sql);
  } else {
    const colList = r.columns.map((c) => quoteTableIdentifier(dbType.value, c)).join(", ");
    for (const row of r.rows) {
      const vals = row
        .map((v) => {
          if (v === null || v === undefined) return "NULL";
          if (typeof v === "number") return String(v);
          return `'${String(v).replace(/'/g, "''")}'`;
        })
        .join(", ");
      stmts.push(`INSERT INTO ${quoteTableIdentifier(dbType.value, r.tableName)} (${colList}) VALUES (${vals});`);
    }
  }
  return stmts;
}

function allSqlStatements(): string[] {
  return generatedResults.value.flatMap((r) => sqlStatementsForTable(r));
}

async function startInsert() {
  if (executing.value) return;
  const cid = props.prefillConnectionId;
  const db = props.prefillDatabase;
  if (!cid || !db) return;
  executing.value = true;
  const perTable: TableResult[] = [];
  for (const r of generatedResults.value) {
    const stmts = sqlStatementsForTable(r);
    const rowCount = r.rows.length;
    let ok = 0;
    let lastError = "";
    for (let si = 0; si < stmts.length; si++) {
      try {
        if (generateOptions.useTransaction) {
          await api.executeInTransaction(cid, db, [stmts[si]], props.prefillSchema);
        } else {
          await api.executeQuery(cid, db, stmts[si], props.prefillSchema);
        }
        if (generateOptions.extendedInsert) {
          ok = rowCount;
        } else if (!(generateOptions.truncate && si === 0)) {
          ok++;
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[startInsert] SQL error:", msg);
        if (!lastError) lastError = msg;
        if (generateOptions.extendedInsert) {
          ok = 0;
        }
        if (!generateOptions.continueOnError) break;
      }
    }
    perTable.push({ table: r.tableName, total: rowCount, ok, err: rowCount - ok, error: lastError || undefined });
  }
  executeResults.value = perTable;
  currentStep.value = "result";
  executing.value = false;
}

const orderDialogOpen = ref(false);
const tableOrder = ref<string[]>([]);

const orderableTables = computed(() => {
  return Object.keys(checkedTables).filter((k) => checkedTables[k]);
});

function openOrderDialog() {
  tableOrder.value = [...orderableTables.value];
  orderDialogOpen.value = true;
}

function moveOrderItem(index: number, dir: -1 | 1) {
  const target = index + dir;
  if (target < 0 || target >= tableOrder.value.length) return;
  const arr = tableOrder.value;
  [arr[index], arr[target]] = [arr[target], arr[index]];
}

function isPartialTable(schema: string, table: string): boolean {
  const key = tableKey(schema, table);
  const cols = tableColumnsExt[key] ?? configs[key]?.columns;
  if (!cols || cols.length === 0) return false;
  let n = 0;
  for (const c of cols) {
    if (checkedColumns[colKey(schema, table, c.name ?? (c as any).columnName)]) n++;
  }
  return n > 0 && n < cols.length;
}

const tableCheckboxRefs = reactive<Record<string, HTMLInputElement | null>>({});
function setTableRef(el: Element | ComponentPublicInstance | null, key: string) {
  const input = el instanceof Element ? (el as HTMLInputElement) : null;
  tableCheckboxRefs[key] = input;
  if (input) {
    const parts = key.split(".");
    if (parts.length >= 2) {
      const schema = parts.slice(0, -1).join(".");
      const table = parts[parts.length - 1];
      input.indeterminate = isPartialTable(schema, table);
    }
  }
}
watch(
  () => [checkedColumns, tableColumnsExt, configs] as const,
  () => {
    for (const key of Object.keys(tableCheckboxRefs)) {
      const el = tableCheckboxRefs[key];
      if (!el) continue;
      const parts = key.split(".");
      if (parts.length < 2) continue;
      const schema = parts.slice(0, -1).join(".");
      const table = parts[parts.length - 1];
      el.indeterminate = isPartialTable(schema, table);
    }
  },
  { deep: true, flush: "post" },
);

onMounted(() => {
  void loadSchemas();
});

watch(open, (val) => {
  if (val) {
    void loadSchemas();
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogScrollContent class="max-w-[1100px] pt-12">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2 text-base">
          <Database class="h-4 w-4" />
          {{ t("dataGenerate.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="rounded-md border bg-muted/20 px-3 py-2 text-sm">
        <span class="text-muted-foreground">{{ t("dataGenerate.target") }}:</span>
        <span class="ml-1 font-medium">{{ connectionName || props.prefillDatabase }}</span>
      </div>

      <template v-if="currentStep === 'config'">
        <div class="flex gap-4 min-h-[400px]">
          <!-- left: schema tree -->
          <div class="w-64 shrink-0 rounded-md border">
            <div class="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
              {{ t("dataGenerate.databaseObjects") }}
            </div>
            <ScrollArea class="h-[380px] p-1">
              <div v-if="loading" class="flex items-center justify-center py-8">
                <Loader2 class="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
              <div v-else-if="schemas.length === 0" class="py-8 text-center text-xs text-muted-foreground">(empty)</div>

              <div v-for="sc in schemas" :key="sc">
                <div class="group flex items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-accent" @click="toggleSchema(sc)">
                  <button type="button" class="-m-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground">
                    <Loader2 v-if="schemaLoading[sc]" class="h-3.5 w-3.5 animate-spin" />
                    <ChevronRight v-else class="h-3.5 w-3.5 transition-transform" :class="{ 'rotate-90': expandedSchemas[sc] }" />
                  </button>
                  <span class="text-sm truncate">{{ sc }}</span>
                  <AlertCircle v-if="schemaError[sc]" class="ml-auto h-3.5 w-3.5 text-destructive shrink-0" />
                </div>

                <div v-if="expandedSchemas[sc] && schemaTables[sc]" class="ml-[18px]">
                  <div v-for="tbl in schemaTables[sc]" :key="tbl.name">
                    <!-- table row -->
                    <div class="group flex items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-accent">
                      <button type="button" class="-m-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" @click="toggleTable(sc, tbl.name)">
                        <Loader2 v-if="tableColumnsLoading[tableKey(sc, tbl.name)]" class="h-3.5 w-3.5 animate-spin" />
                        <ChevronRight v-else class="h-3.5 w-3.5 transition-transform" :class="{ 'rotate-90': expandedTables[tableKey(sc, tbl.name)] }" />
                      </button>
                      <input type="checkbox" class="h-3.5 w-3.5 accent-primary shrink-0" :checked="!!checkedTables[tableKey(sc, tbl.name)]" :ref="(el) => setTableRef(el, tableKey(sc, tbl.name))" @change="selectTable(sc, tbl.name, ($event.target as HTMLInputElement).checked)" />
                      <Table class="h-3.5 w-3.5 shrink-0 text-green-500" />
                      <span class="text-sm truncate" :class="{ 'text-foreground font-medium': panelTableKey === tableKey(sc, tbl.name), 'text-muted-foreground': panelTableKey !== tableKey(sc, tbl.name) }" @click="showTable(sc, tbl.name)">
                        {{ tbl.name }}
                      </span>
                    </div>
                    <!-- column children -->
                    <div v-if="expandedTables[tableKey(sc, tbl.name)] && tableColumnsExt[tableKey(sc, tbl.name)]" class="ml-[36px]">
                      <div
                        v-for="col in tableColumnsExt[tableKey(sc, tbl.name)]"
                        :key="col.name"
                        class="group flex items-center gap-1.5 py-0.5 px-2 cursor-pointer hover:bg-accent"
                        :class="{ 'bg-accent': panelColumnName === col.name && panelTableKey === tableKey(sc, tbl.name) }"
                        @click="showColumn(sc, tbl.name, col.name)"
                      >
                        <input type="checkbox" class="h-3 w-3 accent-primary shrink-0" :checked="!!checkedColumns[colKey(sc, tbl.name, col.name)]" @click.stop @change="toggleColumn(sc, tbl.name, col.name)" />
                        <Columns class="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span class="text-xs truncate font-mono">{{ col.name }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-else-if="expandedSchemas[sc] && schemaLoading[sc]" class="ml-[18px] px-2 py-1 text-xs text-muted-foreground">Loading...</div>
                <div v-else-if="expandedSchemas[sc] && schemaError[sc]" class="ml-[18px] px-2 py-1 text-xs text-destructive">
                  {{ schemaError[sc] }}
                </div>
              </div>
            </ScrollArea>
          </div>

          <!-- right: active table config -->
          <div class="flex-1 rounded-md border">
            <div class="h-[380px] p-1 pt-10 overflow-y-auto">
              <div v-if="!activeCfg" class="flex h-full items-center justify-center text-xs text-muted-foreground">
                {{ t("dataGenerate.selectTable") }}
              </div>

              <template v-else-if="activeCol">
                <div class="p-3 space-y-3">
                  <div class="flex items-center gap-2 text-sm font-medium">
                    <Columns class="h-4 w-4 text-muted-foreground" />
                    <span>{{ activeCol.columnName }}</span>
                    <span class="text-xs text-muted-foreground font-mono">{{ activeCol.dataType }}</span>
                  </div>
                  <GeneratorParamsPanel :config="activeCol" :connection-id="props.prefillConnectionId" :database="props.prefillDatabase" />
                  <div class="rounded border border-dashed border-amber-300 bg-amber-50 dark:bg-amber-950/20 px-2 py-1 text-[10px] font-mono text-amber-700 dark:text-amber-400 leading-relaxed break-all">
                    <div>generatorKey: {{ activeCol.generatorKey ?? "(none)" }}</div>
                    <div>generatorParams: {{ JSON.stringify(activeCol.generatorParams) }}</div>
                  </div>
                </div>
              </template>
              <template v-else-if="activeCfg">
                <div class="p-3 space-y-3">
                  <div class="flex items-center gap-2 text-sm font-medium">
                    <Table class="h-4 w-4 text-green-500" />
                    <span>{{ activeCfg.tableName }}</span>
                  </div>
                  <div class="flex items-center gap-3 rounded-md bg-muted/20 px-3 py-2">
                    <Label class="text-xs shrink-0">{{ t("dataGenerate.rowCount") }}:</Label>
                    <Input v-model.number="activeCfg.rowCount" class="h-7 w-24 text-xs" />
                  </div>
                </div>
              </template>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="currentStep === 'preview'">
        <!-- status bar -->
        <div class="flex items-center justify-between -mx-4 -mt-4 mb-0 px-4 py-2 border-b bg-muted/10">
          <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Database class="h-3.5 w-3.5" />
            <span class="font-medium text-foreground">{{ connectionName || props.prefillDatabase }}</span>
            <span class="text-muted-foreground">/</span>
            <span>{{ Object.keys(checkedTables).length > 0 ? Object.keys(checkedTables)[0].split(".")[0] : props.prefillSchema || "main" }}</span>
          </div>
          <span class="text-sm font-medium absolute left-1/2 -translate-x-1/2">{{ t("dataGenerate.title") }}</span>
          <div />
        </div>

        <div class="rounded-md border">
          <div v-if="generatedResults.length === 0" class="flex h-[420px] items-center justify-center text-xs text-muted-foreground">{{ t("dataGenerate.noData") }}</div>
          <template v-else>
            <div class="flex items-center justify-between px-3 py-2 border-b bg-muted/10">
              <div class="flex items-center gap-2">
                <span class="text-xs text-muted-foreground">{{ t("dataGenerate.target") }}：</span>
                <select v-if="generatedResults.length > 1" v-model="previewTableIndex" class="h-7 rounded border bg-background px-2 text-xs">
                  <option v-for="(r, i) in generatedResults" :key="i" :value="i">{{ r.tableName }}</option>
                </select>
                <span v-else class="text-sm font-medium">{{ generatedResults[0].tableName }}</span>
                <span class="text-xs text-muted-foreground">{{ currentPreview.rows.length }} 行</span>
              </div>
              <Button variant="outline" size="sm" class="h-7 text-xs" @click="regenerate">{{ t("dataGenerate.regenerate") }}</Button>
            </div>
            <div class="flex flex-col h-[380px]">
              <div class="flex-1 overflow-auto overscroll-none bg-background">
                <table class="w-full text-xs border-collapse" style="table-layout: auto">
                  <thead>
                    <tr class="sticky top-0 z-10 bg-[rgb(239_239_239)] dark:bg-muted/60 border-y border-border">
                      <th class="px-2 py-1.5 border-r border-border text-center text-muted-foreground select-none w-10 shrink-0">#</th>
                      <th v-for="(col, ci) in currentPreview.columns" :key="col" class="relative px-2 py-1.5 border-r border-border whitespace-nowrap text-left font-medium select-none" :style="{ minWidth: '60px', width: previewColWidths[ci] + 'px' }">
                        {{ col }}
                        <div class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30" @mousedown.stop="onPreviewColResizeStart(ci, $event)" @dblclick.stop="delete previewColWidths[ci]" />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="(row, ri) in currentPreview.rows.slice(0, 50)" :key="ri" class="border-b border-border" :class="{ 'bg-muted/30': ri % 2 === 1 }">
                      <td class="data-grid-row-number px-2 py-1 border-r border-border text-center text-muted-foreground select-none text-xs">{{ ri + 1 }}</td>
                      <td
                        v-for="(cell, ci) in row"
                        :key="ci"
                        class="px-3 py-1 border-r border-border whitespace-nowrap overflow-hidden text-ellipsis select-none font-mono"
                        :style="{ maxWidth: (previewColWidths[ci] ?? 120) + 'px' }"
                        :class="{ 'text-muted-foreground italic': cell === null || cell === undefined }"
                      >
                        {{ cell === null || cell === undefined ? "NULL" : String(cell) }}
                      </td>
                    </tr>
                  </tbody>
                </table>
                <div v-if="currentPreview.rows.length > 50" class="sticky left-0 text-xs text-muted-foreground px-3 py-1.5 border-t border-border bg-background">{{ t("dataGenerate.first50Rows", { count: currentPreview.rows.length }) }}</div>
              </div>
            </div>
          </template>
        </div>
      </template>

      <template v-else-if="currentStep === 'result'">
        <div class="rounded-md border">
          <div class="border-b bg-muted/10 px-4 py-2 text-sm font-medium">{{ t("dataGenerate.resultTitle") }}</div>
          <div class="divide-y max-h-[400px] overflow-y-auto">
            <div v-for="r in executeResults" :key="r.table" class="px-4 py-3 text-xs">
              <div class="flex items-center justify-between">
                <span class="font-medium truncate">{{ r.table }}</span>
                <span class="flex items-center gap-3 shrink-0">
                  <span class="text-green-600 dark:text-green-400">{{ t("dataGenerate.successLabel", { count: r.ok }) }}</span>
                  <span v-if="r.err > 0" class="text-destructive">{{ t("dataGenerate.failLabel", { count: r.err }) }}</span>
                  <span class="text-muted-foreground">{{ t("dataGenerate.totalLabel", { count: r.total }) }}</span>
                </span>
              </div>
              <div v-if="r.error" class="mt-1 text-destructive/80 break-all leading-relaxed">{{ r.error }}</div>
            </div>
          </div>
          <div v-if="executeResults.length === 0" class="flex h-24 items-center justify-center text-xs text-muted-foreground">{{ t("dataGenerate.noResult") }}</div>
        </div>
      </template>

      <DialogFooter class="flex items-center justify-between border-t pt-3 sm:justify-between">
        <div class="flex items-center gap-2">
          <template v-if="currentStep === 'config'">
            <Button variant="outline" size="sm" class="h-7 text-xs">
              <Save class="mr-1 h-3 w-3" />
              {{ t("dataGenerate.saveProfile") }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 text-xs">
              <Upload class="mr-1 h-3 w-3" />
              {{ t("dataGenerate.loadProfile") }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="optionsDialogOpen = true">
              <Settings class="mr-1 h-3 w-3" />
              {{ t("dataGenerate.options") }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="openOrderDialog">
              <Settings class="mr-1 h-3 w-3" />
              {{ t("dataGenerate.generateOrder") }}
            </Button>
          </template>
          <template v-else-if="currentStep === 'preview' && generatedResults.length > 0">
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="copyAllSql">{{ t("dataGenerate.copyAllSql") }}</Button>
          </template>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="outline" size="sm" class="h-7 text-xs" @click="open = false">
            <X class="mr-1 h-3 w-3" />
            {{ t("dangerDialog.cancel") }}
          </Button>
          <template v-if="currentStep === 'config'">
            <Button variant="default" size="sm" class="h-7 text-xs" @click="doGenerate">
              {{ t("dataGenerate.nextStep") }}
            </Button>
          </template>
          <template v-else-if="currentStep === 'preview'">
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="currentStep = 'config'">{{ t("dataGenerate.prevStep") }}</Button>
            <Button variant="default" size="sm" class="h-7 text-xs" :disabled="executing" @click="startInsert">
              <Loader2 v-if="executing" class="mr-1 h-3 w-3 animate-spin" />
              {{ t("dataGenerate.startInsert") }}
            </Button>
          </template>
          <template v-else-if="currentStep === 'result'">
            <Button variant="outline" size="sm" class="h-7 text-xs" @click="currentStep = 'preview'">{{ t("dataGenerate.back") }}</Button>
            <Button variant="default" size="sm" class="h-7 text-xs" @click="open = false">{{ t("dataGenerate.confirm") }}</Button>
          </template>
        </div>
      </DialogFooter>
    </DialogScrollContent>

    <Dialog v-model:open="optionsDialogOpen">
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle class="text-sm">生成选项</DialogTitle>
        </DialogHeader>
        <div class="space-y-3 py-2">
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" v-model="generateOptions.continueOnError" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t("dataGenerate.errorContinue") }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" v-model="generateOptions.truncate" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t("dataGenerate.truncateBefore") }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" v-model="generateOptions.useTransaction" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t("dataGenerate.useTransaction") }}</span>
          </label>
          <label class="flex items-center gap-3 cursor-pointer">
            <input type="checkbox" v-model="generateOptions.extendedInsert" class="h-4 w-4 accent-primary" />
            <span class="text-xs">{{ t("dataGenerate.extendedInsert") }}</span>
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" class="h-7 text-xs" @click="optionsDialogOpen = false">{{ t("dataGenerate.ok") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="orderDialogOpen">
      <DialogContent class="max-w-md">
        <DialogHeader>
          <DialogTitle class="text-sm">{{ t("dataGenerate.generateOrder") }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-1 max-h-80 overflow-y-auto">
          <div v-for="(key, i) in tableOrder" :key="key" class="flex items-center gap-2 rounded border bg-background px-3 py-2 text-xs">
            <span class="flex h-5 w-5 items-center justify-center rounded bg-muted text-muted-foreground text-[10px] font-medium">{{ i + 1 }}</span>
            <span class="flex-1 truncate font-medium">{{ configs[key]?.tableName ?? key }}</span>
            <span class="text-muted-foreground truncate max-w-[120px]">{{ configs[key]?.schema }}</span>
            <button type="button" class="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-20" :disabled="i === 0" @click="moveOrderItem(i, -1)">
              <ArrowUp class="h-3.5 w-3.5" />
            </button>
            <button type="button" class="flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-20" :disabled="i === tableOrder.length - 1" @click="moveOrderItem(i, 1)">
              <ArrowDown class="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        <div v-if="tableOrder.length === 0" class="py-8 text-center text-xs text-muted-foreground">{{ t("dataGenerate.noTablesSelected") }}</div>
        <DialogFooter>
          <Button size="sm" class="h-7 text-xs" @click="orderDialogOpen = false">{{ t("dataGenerate.ok") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Dialog>
</template>

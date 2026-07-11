<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import { isSchemaAware } from "@/lib/database/databaseCapabilities";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { DataCompareCellValue, DataCompareModifiedRow, DataCompareResult, DataCompareRow, DataCompareSyncPlan, DataCompareSyncPlanTableOptions } from "@/lib/dataGrid/dataCompare";
import type { ColumnInfo, DatabaseType } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { ArrowLeftRight, CheckSquare, ChevronDown, ChevronRight, Copy, GitCompareArrows, Loader2, Play, Square } from "@lucide/vue";

type CompareColumn = ColumnInfo;

interface DataCompareTableTask {
  sourceTable: string;
  targetTable: string;
}

type DataCompareTableStatus = "different" | "same" | "error";
type DiffKind = "added" | "removed" | "modified";

interface SelectableDataCompareRow extends DataCompareRow {
  selected: boolean;
}

interface SelectableDataCompareModifiedRow extends DataCompareModifiedRow {
  selected: boolean;
}

interface SelectableDataCompareResult {
  added: SelectableDataCompareRow[];
  removed: SelectableDataCompareRow[];
  modified: SelectableDataCompareModifiedRow[];
}

interface DataCompareTableResult {
  sourceTable: string;
  targetTable: string;
  keyColumns: string[];
  columns: string[];
  columnInfo: CompareColumn[];
  status: DataCompareTableStatus;
  added: number;
  removed: number;
  modified: number;
  sourceRowCount: number;
  targetRowCount: number;
  sourceTruncated: boolean;
  targetTruncated: boolean;
  databaseType?: DatabaseType;
  preSyncStatements?: string[];
  diff: SelectableDataCompareResult;
  expanded: boolean;
  showAll: Record<DiffKind, boolean>;
  error?: string;
}

const PREVIEW_LIMIT_OPTIONS = [50, 100, 200, 500];
const SYNC_EXECUTE_BATCH_SIZE = 500;

const { t } = useI18n();
const { toast } = useToast();
const store = useConnectionStore();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
}>();

const sourceConnectionId = ref("");
const sourceDatabase = ref("");
const sourceSchema = ref("");
const sourceTable = ref("");
const sourceDatabases = ref<string[]>([]);
const sourceSchemas = ref<string[]>([]);
const sourceTables = ref<string[]>([]);
const sourceTableSearch = ref("");
const selectedSourceTables = ref<Set<string>>(new Set());

const targetConnectionId = ref("");
const targetDatabase = ref("");
const targetSchema = ref("");
const targetTable = ref("");
const targetDatabases = ref<string[]>([]);
const targetSchemas = ref<string[]>([]);
const targetTables = ref<string[]>([]);

const keyColumnsText = ref("");
const detailPreviewLimit = ref(String(PREVIEW_LIMIT_OPTIONS[1]));
const batchResults = ref<DataCompareTableResult[]>([]);
const syncPlan = ref<DataCompareSyncPlan>(emptySyncPlan());
const comparing = ref(false);
const planningSync = ref(false);
const compareProgressCurrent = ref(0);
const compareProgressTotal = ref(0);
const compareProgressTable = ref("");
const executing = ref(false);
const executedCount = ref(0);
const executeTotal = ref(0);
const syncErrors = ref<{ sql: string; error: string }[]>([]);
const showAdded = ref(true);
const showRemoved = ref(true);
const showModified = ref(true);

let syncPlanRequestId = 0;

const sqlConnections = computed(() => store.connections.filter((connection) => !["redis", "mongodb", "elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "mq", "nacos"].includes(connection.db_type)));
const selectedSourceTableNames = computed(() => sourceTables.value.filter((table) => selectedSourceTables.value.has(table)));
const isBatchCompare = computed(() => selectedSourceTableNames.value.length > 1);
const filteredSourceTables = computed(() => {
  const query = sourceTableSearch.value.trim().toLowerCase();
  if (!query) return sourceTables.value;
  return sourceTables.value.filter((table) => table.toLowerCase().includes(query));
});
const allFilteredTablesSelected = computed(() => filteredSourceTables.value.length > 0 && filteredSourceTables.value.every((table) => selectedSourceTables.value.has(table)));
const compareTasksPreview = computed(() =>
  selectedSourceTableNames.value.map((table) => {
    const target = isBatchCompare.value ? table : targetTable.value || table;
    const matched = !!target && targetTables.value.includes(target);
    return {
      sourceTable: table,
      targetTable: target,
      matched,
    };
  }),
);
const matchedTaskCount = computed(() => compareTasksPreview.value.filter((task) => task.matched).length);
const missingTargetTables = computed(() => compareTasksPreview.value.filter((task) => !task.matched).map((task) => task.targetTable || task.sourceTable));
const canCompare = computed(() => sourceConnectionId.value && sourceDatabase.value && sourceSchema.value && selectedSourceTableNames.value.length > 0 && targetConnectionId.value && targetDatabase.value && targetSchema.value);
const keyColumns = computed(() =>
  keyColumnsText.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const detailPreviewLimitNumber = computed(() => Number(detailPreviewLimit.value) || PREVIEW_LIMIT_OPTIONS[1]);

const sameTableCount = computed(() => batchResults.value.filter((item) => item.status === "same").length);
const differentTableCount = computed(() => batchResults.value.filter((item) => item.status === "different").length);
const failedTableCount = computed(() => batchResults.value.filter((item) => item.status === "error").length);
const totalAdded = computed(() => batchResults.value.reduce((sum, item) => sum + item.added, 0));
const totalRemoved = computed(() => batchResults.value.reduce((sum, item) => sum + item.removed, 0));
const totalModified = computed(() => batchResults.value.reduce((sum, item) => sum + item.modified, 0));
const hasResults = computed(() => batchResults.value.length > 0);
const visibleKinds = computed(() => [...(showAdded.value ? (["added"] as DiffKind[]) : []), ...(showRemoved.value ? (["removed"] as DiffKind[]) : []), ...(showModified.value ? (["modified"] as DiffKind[]) : [])]);
const selectedAddedCount = computed(() => selectedDiffCount("added"));
const selectedRemovedCount = computed(() => selectedDiffCount("removed"));
const selectedModifiedCount = computed(() => selectedDiffCount("modified"));
const summary = computed(() => {
  if (!hasResults.value) return "";
  if (batchResults.value.length === 1 && batchResults.value[0]?.status !== "error") {
    const item = batchResults.value[0];
    return t("dataCompare.summary", {
      added: item.added,
      removed: item.removed,
      modified: item.modified,
    });
  }
  return t("dataCompare.batchSummary", {
    tables: batchResults.value.length,
    different: differentTableCount.value,
    same: sameTableCount.value,
    failed: failedTableCount.value,
    added: totalAdded.value,
    removed: totalRemoved.value,
    modified: totalModified.value,
  });
});
const selectedSummary = computed(() =>
  t("dataCompare.selectedSummary", {
    added: selectedAddedCount.value,
    removed: selectedRemovedCount.value,
    modified: selectedModifiedCount.value,
  }),
);
const compareProgressLabel = computed(() => {
  if (!comparing.value || compareProgressTotal.value === 0) return "";
  return t("dataCompare.comparingTable", {
    current: compareProgressCurrent.value,
    total: compareProgressTotal.value,
    table: compareProgressTable.value,
  });
});

function emptySyncPlan(): DataCompareSyncPlan {
  return {
    insertCount: 0,
    updateCount: 0,
    deleteCount: 0,
    statementCount: 0,
    syncStatements: [],
    syncSql: "",
  };
}

function connectionIconType(connectionId: string) {
  const config = store.getConfig(connectionId);
  return config?.driver_profile || config?.db_type || "mysql";
}

function targetDatabaseType(): DatabaseType | undefined {
  return store.getConfig(targetConnectionId.value)?.db_type;
}

function resetSelectedSourceTables(nextTables: Iterable<string>) {
  selectedSourceTables.value = new Set(nextTables);
}

function toggleSourceTable(table: string) {
  const next = new Set(selectedSourceTables.value);
  if (next.has(table)) next.delete(table);
  else next.add(table);
  resetSelectedSourceTables(next);
}

function toggleSelectAllSourceTables() {
  const next = new Set(selectedSourceTables.value);
  if (allFilteredTablesSelected.value) {
    filteredSourceTables.value.forEach((table) => next.delete(table));
  } else {
    filteredSourceTables.value.forEach((table) => next.add(table));
  }
  resetSelectedSourceTables(next);
}

function buildCompareTasks(): DataCompareTableTask[] {
  if (!selectedSourceTableNames.value.length) return [];
  if (!isBatchCompare.value) {
    const table = selectedSourceTableNames.value[0];
    return table ? [{ sourceTable: table, targetTable: targetTable.value || table }] : [];
  }
  return selectedSourceTableNames.value.map((table) => ({
    sourceTable: table,
    targetTable: table,
  }));
}

function clearResult() {
  batchResults.value = [];
  syncPlan.value = emptySyncPlan();
  syncErrors.value = [];
  compareProgressCurrent.value = 0;
  compareProgressTotal.value = 0;
  compareProgressTable.value = "";
  executedCount.value = 0;
  executeTotal.value = 0;
  syncPlanRequestId++;
}

function swapSourceTarget() {
  const previousSelectedTables = [...selectedSourceTableNames.value];
  const nextSingleTarget = previousSelectedTables.length === 1 ? (previousSelectedTables[0] ?? "") : "";
  const nextSourceSelection = previousSelectedTables.length <= 1 ? [targetTable.value].filter(Boolean) : previousSelectedTables;

  const tmpConnId = sourceConnectionId.value;
  const tmpDb = sourceDatabase.value;
  const tmpDbs = sourceDatabases.value;
  const tmpSchema = sourceSchema.value;
  const tmpSchemas = sourceSchemas.value;
  const tmpTables = sourceTables.value;

  sourceConnectionId.value = targetConnectionId.value;
  sourceDatabase.value = targetDatabase.value;
  sourceDatabases.value = targetDatabases.value;
  sourceSchema.value = targetSchema.value;
  sourceSchemas.value = targetSchemas.value;
  sourceTables.value = targetTables.value;
  resetSelectedSourceTables(nextSourceSelection.filter((table) => targetTables.value.includes(table)));

  targetConnectionId.value = tmpConnId;
  targetDatabase.value = tmpDb;
  targetDatabases.value = tmpDbs;
  targetSchema.value = tmpSchema;
  targetSchemas.value = tmpSchemas;
  targetTables.value = tmpTables;
  targetTable.value = nextSingleTarget;

  sourceTable.value = selectedSourceTableNames.value.length === 1 ? selectedSourceTableNames.value[0] : "";
  clearResult();
}

async function resolveSchema(connectionId: string, database: string, preferredSchema = ""): Promise<string> {
  const config = store.getConfig(connectionId);
  if (isSchemaAware(config?.db_type)) {
    const schemas = await api.listSchemas(connectionId, database);
    if (preferredSchema && schemas.includes(preferredSchema)) return preferredSchema;
    return schemas.includes("public") ? "public" : (schemas[0] ?? "");
  }
  return database;
}

async function loadSchemas(side: "source" | "target", preferredSchema = "") {
  const connectionId = side === "source" ? sourceConnectionId.value : targetConnectionId.value;
  const database = side === "source" ? sourceDatabase.value : targetDatabase.value;
  if (!connectionId || !database) return;
  const config = store.getConfig(connectionId);
  if (!isSchemaAware(config?.db_type)) {
    if (side === "source") {
      sourceSchemas.value = [];
      sourceSchema.value = database;
    } else {
      targetSchemas.value = [];
      targetSchema.value = database;
    }
    await loadTables(side);
    return;
  }

  const schemas = await api.listSchemas(connectionId, database);
  const schema = preferredSchema && schemas.includes(preferredSchema) ? preferredSchema : schemas.includes("public") ? "public" : (schemas[0] ?? "");
  if (side === "source") {
    sourceSchemas.value = schemas;
    sourceSchema.value = schema;
  } else {
    targetSchemas.value = schemas;
    targetSchema.value = schema;
  }
}

async function loadDatabases(connectionId: string, side: "source" | "target") {
  if (!connectionId) return;
  await store.ensureConnected(connectionId);
  const names = databaseOptionsForConnection(
    (await api.listDatabases(connectionId)).map((database) => database.name),
    store.getConfig(connectionId),
  );
  if (side === "source") {
    sourceDatabases.value = names;
    sourceDatabase.value = names.length === 1 ? names[0] : "";
    sourceSchemas.value = [];
    sourceSchema.value = "";
    sourceTables.value = [];
    sourceTable.value = "";
    resetSelectedSourceTables([]);
  } else {
    targetDatabases.value = names;
    targetDatabase.value = names.length === 1 ? names[0] : "";
    targetSchemas.value = [];
    targetSchema.value = "";
    targetTables.value = [];
    targetTable.value = "";
  }
}

async function loadTables(side: "source" | "target") {
  const connectionId = side === "source" ? sourceConnectionId.value : targetConnectionId.value;
  const database = side === "source" ? sourceDatabase.value : targetDatabase.value;
  if (!connectionId || !database) return;
  const schema = side === "source" ? sourceSchema.value || (await resolveSchema(connectionId, database, props.prefillSchema)) : targetSchema.value || (await resolveSchema(connectionId, database));
  const tables = (await api.listTables(connectionId, database, schema)).filter((table) => table.table_type !== "VIEW" && table.table_type !== "MATERIALIZED_VIEW").map((table) => table.name);

  if (side === "source") {
    const preferredSelection = props.prefillTable && tables.includes(props.prefillTable) ? [props.prefillTable] : [...selectedSourceTables.value].filter((table) => tables.includes(table));
    sourceSchema.value = schema;
    sourceTables.value = tables;
    resetSelectedSourceTables(preferredSelection);
    sourceTable.value = preferredSelection.length === 1 ? preferredSelection[0] : "";
  } else {
    targetSchema.value = schema;
    targetTables.value = tables;
    const singleSourceTable = selectedSourceTableNames.value.length === 1 ? selectedSourceTableNames.value[0] : "";
    const preferred = targetTable.value && tables.includes(targetTable.value) ? targetTable.value : singleSourceTable && tables.includes(singleSourceTable) ? singleSourceTable : "";
    targetTable.value = preferred;
  }
}

async function loadColumnsWithCache(cache: Map<string, CompareColumn[]>, connectionId: string, database: string, schema: string, table: string): Promise<CompareColumn[]> {
  const key = `${connectionId}:${database}:${schema}:${table}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const columns = (await api.getColumns(connectionId, database, schema, table)) as CompareColumn[];
  cache.set(key, columns);
  return columns;
}

async function inferKeyColumnsForTable(table: string, sourceColumnCache?: Map<string, CompareColumn[]>): Promise<string[]> {
  if (!sourceConnectionId.value || !sourceDatabase.value || !sourceSchema.value || !table) return [];
  const columns = sourceColumnCache ? await loadColumnsWithCache(sourceColumnCache, sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, table) : (((await api.getColumns(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, table)) as CompareColumn[]) ?? []);
  const primaryKeys = columns.filter((column) => column.is_primary_key).map((column) => column.name);
  if (primaryKeys.length > 0) return primaryKeys;
  return columns.slice(0, 1).map((column) => column.name);
}

async function inferKeyColumns() {
  const table = selectedSourceTableNames.value.length === 1 ? selectedSourceTableNames.value[0] : "";
  if (!table) return;
  const inferred = await inferKeyColumnsForTable(table);
  keyColumnsText.value = inferred.join(", ");
}

function resultStatusLabel(status: DataCompareTableStatus): string {
  if (status === "different") return t("dataCompare.statusDifferent");
  if (status === "same") return t("dataCompare.statusSame");
  return t("dataCompare.statusError");
}

function resultStatusClass(status: DataCompareTableStatus): string {
  if (status === "different") return "bg-amber-500/15 text-amber-700";
  if (status === "same") return "bg-emerald-500/15 text-emerald-700";
  return "bg-destructive/15 text-destructive";
}

function toSelectableDiff(diff: DataCompareResult): SelectableDataCompareResult {
  return {
    added: diff.added.map((row) => ({ ...row, selected: true })),
    removed: diff.removed.map((row) => ({ ...row, selected: true })),
    modified: diff.modified.map((row) => ({ ...row, selected: true })),
  };
}

function buildSelectedDiff(table: DataCompareTableResult): DataCompareResult {
  return {
    added: table.diff.added.filter((row) => row.selected).map(stripSelectedRow),
    removed: table.diff.removed.filter((row) => row.selected).map(stripSelectedRow),
    modified: table.diff.modified.filter((row) => row.selected).map(stripSelectedModifiedRow),
  };
}

function stripSelectedRow(row: SelectableDataCompareRow): DataCompareRow {
  const { selected: _selected, ...rest } = row;
  return rest;
}

function stripSelectedModifiedRow(row: SelectableDataCompareModifiedRow): DataCompareModifiedRow {
  const { selected: _selected, ...rest } = row;
  return rest;
}

function hasDiffRows(table: DataCompareTableResult, kind: DiffKind): boolean {
  return table.diff[kind].length > 0;
}

function selectedRows(table: DataCompareTableResult, kind: DiffKind): number {
  return table.diff[kind].filter((row) => row.selected).length;
}

function rowsForDisplay(table: DataCompareTableResult, kind: DiffKind) {
  const rows = table.diff[kind];
  return table.showAll[kind] ? rows : rows.slice(0, detailPreviewLimitNumber.value);
}

function remainingRows(table: DataCompareTableResult, kind: DiffKind) {
  return Math.max(0, table.diff[kind].length - rowsForDisplay(table, kind).length);
}

function toggleTableExpanded(table: DataCompareTableResult) {
  table.expanded = !table.expanded;
}

function toggleShowAll(table: DataCompareTableResult, kind: DiffKind) {
  table.showAll[kind] = !table.showAll[kind];
}

function setDiffSelection(kind: DiffKind, selected: boolean) {
  batchResults.value.forEach((table) => {
    table.diff[kind].forEach((row) => {
      row.selected = selected;
    });
  });
  rebuildSyncPlan().catch((e) => toast(String(e), 5000));
}

function setTableDiffSelection(table: DataCompareTableResult, kind: DiffKind, selected: boolean) {
  table.diff[kind].forEach((row) => {
    row.selected = selected;
  });
  rebuildSyncPlan().catch((e) => toast(String(e), 5000));
}

function clearAllSelections() {
  (["added", "removed", "modified"] as DiffKind[]).forEach((kind) => {
    batchResults.value.forEach((table) => {
      table.diff[kind].forEach((row) => {
        row.selected = false;
      });
    });
  });
  rebuildSyncPlan().catch((e) => toast(String(e), 5000));
}

function toggleRowSelection(row: SelectableDataCompareRow | SelectableDataCompareModifiedRow) {
  row.selected = !row.selected;
  rebuildSyncPlan().catch((e) => toast(String(e), 5000));
}

function selectedDiffCount(kind: DiffKind) {
  return batchResults.value.reduce((sum, table) => sum + selectedRows(table, kind), 0);
}

function buildSyncPlanTables(): DataCompareSyncPlanTableOptions[] {
  return batchResults.value
    .filter((table) => table.status === "different")
    .map((table) => ({
      tableName: table.targetTable,
      schema: targetSchema.value,
      columns: table.columns,
      keyColumns: table.keyColumns,
      columnInfo: table.columnInfo,
      diff: buildSelectedDiff(table),
      databaseType: table.databaseType,
      preSyncStatements: table.preSyncStatements ?? [],
    }))
    .filter((table) => table.preSyncStatements.length > 0 || table.diff.added.length > 0 || table.diff.removed.length > 0 || table.diff.modified.length > 0);
}

async function rebuildSyncPlan() {
  const requestId = ++syncPlanRequestId;
  const tables = buildSyncPlanTables();
  if (tables.length === 0) {
    syncPlan.value = emptySyncPlan();
    planningSync.value = false;
    return;
  }
  planningSync.value = true;
  try {
    const plan = await api.buildDataCompareSyncPlan({ tables });
    if (requestId !== syncPlanRequestId) return;
    syncPlan.value = plan;
  } catch (e: any) {
    if (requestId !== syncPlanRequestId) return;
    syncPlan.value = emptySyncPlan();
    toast(e?.message || String(e), 5000);
  } finally {
    if (requestId === syncPlanRequestId) planningSync.value = false;
  }
}

async function startCompare() {
  if (!canCompare.value || comparing.value) return;
  const tasks = buildCompareTasks();
  if (tasks.length === 0) {
    toast(t("dataCompare.noComparableTables"), 5000);
    return;
  }

  comparing.value = true;
  clearResult();
  compareProgressTotal.value = tasks.length;

  const sourceColumnCache = new Map<string, CompareColumn[]>();
  const targetColumnCache = new Map<string, CompareColumn[]>();
  const results: DataCompareTableResult[] = [];
  const currentTargetDatabaseType = targetDatabaseType();

  try {
    await Promise.all([store.ensureConnected(sourceConnectionId.value), store.ensureConnected(targetConnectionId.value)]);

    for (const [index, task] of tasks.entries()) {
      compareProgressCurrent.value = index + 1;
      compareProgressTable.value = task.sourceTable;

      try {
        if (!targetTables.value.includes(task.targetTable)) {
          const sourceColumns = await loadColumnsWithCache(sourceColumnCache, sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, task.sourceTable);
          const resolvedKeys = keyColumns.value.length > 0 ? keyColumns.value : [];
          const preparation = await api.prepareDataCompareMissingTarget({
            sourceConnectionId: sourceConnectionId.value,
            sourceDatabase: sourceDatabase.value,
            sourceSchema: sourceSchema.value,
            sourceTable: task.sourceTable,
            targetConnectionId: targetConnectionId.value,
            targetDatabase: targetDatabase.value,
            targetSchema: targetSchema.value,
            targetTable: task.targetTable,
            keyColumns: resolvedKeys,
          });
          results.push({
            sourceTable: task.sourceTable,
            targetTable: task.targetTable,
            keyColumns: resolvedKeys,
            columns: sourceColumns.map((column) => column.name),
            columnInfo: sourceColumns,
            status: "different",
            added: preparation.result.added.length,
            removed: 0,
            modified: 0,
            sourceRowCount: preparation.sourceRowCount,
            targetRowCount: 0,
            sourceTruncated: preparation.sourceTruncated,
            targetTruncated: false,
            databaseType: currentTargetDatabaseType,
            preSyncStatements: preparation.preSyncStatements,
            diff: toSelectableDiff(preparation.result),
            expanded: preparation.result.added.length > 0,
            showAll: {
              added: false,
              removed: false,
              modified: false,
            },
          });
          continue;
        }

        const resolvedKeys = keyColumns.value.length > 0 ? keyColumns.value : await inferKeyColumnsForTable(task.sourceTable, sourceColumnCache);
        if (resolvedKeys.length === 0) {
          throw new Error(t("dataCompare.noKeyColumns"));
        }

        const sourceColumns = await loadColumnsWithCache(sourceColumnCache, sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, task.sourceTable);
        const targetColumns = await loadColumnsWithCache(targetColumnCache, targetConnectionId.value, targetDatabase.value, targetSchema.value, task.targetTable);
        const columns = sourceColumns.map((column) => column.name).filter((column) => targetColumns.some((target) => target.name === column));
        const columnInfo = columns.map((column) => targetColumns.find((target) => target.name === column)).filter((column): column is CompareColumn => !!column);
        const missingKeys = resolvedKeys.filter((column) => !columns.includes(column));
        if (missingKeys.length > 0) {
          throw new Error(t("dataCompare.missingKeyColumns", { columns: missingKeys.join(", ") }));
        }
        if (columns.length === 0) {
          throw new Error(t("dataCompare.noCommonColumns"));
        }

        const preparation = await api.prepareDataCompareFromTables({
          sourceConnectionId: sourceConnectionId.value,
          sourceDatabase: sourceDatabase.value,
          sourceSchema: sourceSchema.value,
          sourceTable: task.sourceTable,
          targetConnectionId: targetConnectionId.value,
          targetDatabase: targetDatabase.value,
          targetSchema: targetSchema.value,
          targetTable: task.targetTable,
          columns,
          keyColumns: resolvedKeys,
        });

        const added = preparation.result.added.length;
        const removed = preparation.result.removed.length;
        const modified = preparation.result.modified.length;
        const status: DataCompareTableStatus = added || removed || modified ? "different" : "same";

        results.push({
          sourceTable: task.sourceTable,
          targetTable: task.targetTable,
          keyColumns: resolvedKeys,
          columns,
          columnInfo,
          status,
          added,
          removed,
          modified,
          sourceRowCount: preparation.sourceRowCount,
          targetRowCount: preparation.targetRowCount,
          sourceTruncated: preparation.sourceTruncated,
          targetTruncated: preparation.targetTruncated,
          databaseType: currentTargetDatabaseType,
          diff: toSelectableDiff(preparation.result),
          expanded: status === "different",
          showAll: {
            added: false,
            removed: false,
            modified: false,
          },
        });
      } catch (e: any) {
        results.push({
          sourceTable: task.sourceTable,
          targetTable: task.targetTable,
          keyColumns: keyColumns.value,
          columns: [],
          columnInfo: [],
          status: "error",
          added: 0,
          removed: 0,
          modified: 0,
          sourceRowCount: 0,
          targetRowCount: 0,
          sourceTruncated: false,
          targetTruncated: false,
          databaseType: currentTargetDatabaseType,
          preSyncStatements: [],
          diff: { added: [], removed: [], modified: [] },
          expanded: false,
          showAll: {
            added: false,
            removed: false,
            modified: false,
          },
          error: e?.message || String(e),
        });
      }
    }

    batchResults.value = results;
    await rebuildSyncPlan();
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    comparing.value = false;
    compareProgressCurrent.value = 0;
    compareProgressTotal.value = 0;
    compareProgressTable.value = "";
  }
}

async function copySql() {
  try {
    await copyToClipboard(syncPlan.value.syncSql);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function executeSql() {
  if (!syncPlan.value.syncSql.trim() || syncPlan.value.syncStatements.length === 0 || executing.value) return;
  const targetConnection = store.getConfig(targetConnectionId.value);
  try {
    const failed = await executeWithProductionSqlGuard({
      connection: targetConnection,
      database: targetDatabase.value,
      sql: syncPlan.value.syncSql,
      source: t("production.sourceDataCompare"),
      execute: async () => {
        executing.value = true;
        syncErrors.value = [];
        executeTotal.value = syncPlan.value.syncStatements.length;
        executedCount.value = 0;
        await store.ensureConnected(targetConnectionId.value);
        const statements = syncPlan.value.syncStatements;
        for (let index = 0; index < statements.length; index += SYNC_EXECUTE_BATCH_SIZE) {
          const batch = statements.slice(index, index + SYNC_EXECUTE_BATCH_SIZE);
          try {
            await api.executeBatch(targetConnectionId.value, targetDatabase.value, batch, targetSchema.value);
            executedCount.value += batch.length;
          } catch (e: any) {
            for (const stmt of batch) {
              try {
                await api.executeBatch(targetConnectionId.value, targetDatabase.value, [stmt], targetSchema.value);
              } catch (singleError: any) {
                syncErrors.value.push({ sql: stmt, error: singleError?.message || String(singleError) });
              }
              executedCount.value++;
            }
          }
        }
        return syncErrors.value.length;
      },
    });
    if (failed === undefined) return;
    if (failed === 0) {
      toast(t("dataCompare.syncSuccess"), 2000);
    } else {
      toast(t("diff.syncSummary", { success: syncPlan.value.syncStatements.length - failed, failed }), 5000);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    executing.value = false;
  }
}

function formatValue(value: DataCompareCellValue): string {
  if (value == null) return "NULL";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateText(text: string, limit = 160): string {
  return text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
}

function formatKeyValues(values: Record<string, DataCompareCellValue>): string {
  return Object.entries(values)
    .map(([column, value]) => `${column}=${formatValue(value)}`)
    .join(", ");
}

function formatRowValues(values: Record<string, DataCompareCellValue>): string {
  return truncateText(
    Object.entries(values)
      .map(([column, value]) => `${column}=${formatValue(value)}`)
      .join(", "),
  );
}

function formatModifiedSummary(row: SelectableDataCompareModifiedRow): string {
  return truncateText(row.changes.map((change) => `${change.column}: ${formatValue(change.target)} -> ${formatValue(change.source)}`).join(", "), 220);
}

watch(sourceConnectionId, (id) => {
  clearResult();
  sourceDatabase.value = "";
  sourceSchema.value = "";
  sourceSchemas.value = [];
  sourceTables.value = [];
  sourceTable.value = "";
  sourceTableSearch.value = "";
  resetSelectedSourceTables([]);
  loadDatabases(id, "source").catch((e) => toast(String(e), 5000));
});
watch(targetConnectionId, (id) => {
  clearResult();
  targetDatabase.value = "";
  targetSchema.value = "";
  targetSchemas.value = [];
  targetTables.value = [];
  targetTable.value = "";
  loadDatabases(id, "target").catch((e) => toast(String(e), 5000));
});
watch(sourceDatabase, () => {
  clearResult();
  sourceSchema.value = "";
  sourceSchemas.value = [];
  sourceTables.value = [];
  sourceTable.value = "";
  sourceTableSearch.value = "";
  resetSelectedSourceTables([]);
  loadSchemas("source", props.prefillSchema).catch((e) => toast(String(e), 5000));
});
watch(targetDatabase, () => {
  clearResult();
  targetSchema.value = "";
  targetSchemas.value = [];
  targetTables.value = [];
  targetTable.value = "";
  loadSchemas("target").catch((e) => toast(String(e), 5000));
});
watch(sourceSchema, () => {
  clearResult();
  sourceTables.value = [];
  sourceTable.value = "";
  sourceTableSearch.value = "";
  resetSelectedSourceTables([]);
  if (sourceSchema.value) loadTables("source").catch((e) => toast(String(e), 5000));
});
watch(targetSchema, () => {
  clearResult();
  targetTables.value = [];
  targetTable.value = "";
  if (targetSchema.value) loadTables("target").catch((e) => toast(String(e), 5000));
});
watch(selectedSourceTableNames, (tables, previous) => {
  clearResult();
  sourceTable.value = tables.length === 1 ? tables[0] : "";
  if (tables.length !== 1) {
    keyColumnsText.value = "";
    return;
  }
  const table = tables[0];
  if (targetTables.value.includes(table)) {
    targetTable.value = table;
  } else if (previous?.length === 1 && targetTable.value === previous[0]) {
    targetTable.value = "";
  }
  if (table !== previous?.[0]) {
    keyColumnsText.value = "";
  }
  inferKeyColumns().catch(() => {});
});
watch(targetTable, () => clearResult());
watch(
  open,
  async (value) => {
    if (!value) return;
    clearResult();
    if (props.prefillConnectionId) {
      sourceConnectionId.value = props.prefillConnectionId;
      await loadDatabases(props.prefillConnectionId, "source");
      if (props.prefillDatabase) sourceDatabase.value = props.prefillDatabase;
      if (props.prefillDatabase) await loadSchemas("source", props.prefillSchema);
      if (props.prefillTable) {
        await loadTables("source");
        if (sourceTables.value.includes(props.prefillTable)) {
          resetSelectedSourceTables([props.prefillTable]);
          sourceTable.value = props.prefillTable;
        }
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-5xl max-h-[85vh] flex flex-col overflow-hidden" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <GitCompareArrows class="w-4 h-4" />
          {{ t("dataCompare.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-auto space-y-4 py-2">
        <div class="grid grid-cols-[1fr_auto_1fr] gap-4 items-start">
          <div class="space-y-2">
            <Label class="text-xs font-medium">{{ t("diff.source") }}</Label>
            <SearchableSelect
              v-model="sourceConnectionId"
              :options="sqlConnections.map((c) => c.id)"
              :placeholder="t('diff.selectConnection')"
              :search-placeholder="t('diff.searchConnection')"
              :empty-text="t('common.noResults')"
              :display-name="(id) => sqlConnections.find((c) => c.id === id)?.name ?? id"
              trigger-variant="outline"
              trigger-class="h-8 w-full justify-between text-xs"
              content-class="w-[var(--reka-popover-trigger-width)]"
            >
              <template #option-label="{ option, label }">
                <div class="flex items-center gap-2">
                  <DatabaseIcon :db-type="connectionIconType(option)" class="w-3.5 h-3.5" />
                  {{ label }}
                </div>
              </template>
            </SearchableSelect>
            <SearchableSelect
              v-model="sourceDatabase"
              :options="sourceDatabases"
              :placeholder="t('diff.selectDatabase')"
              :search-placeholder="t('diff.searchDatabase')"
              :empty-text="t('common.noResults')"
              :disabled="!sourceDatabases.length"
              trigger-variant="outline"
              trigger-class="h-8 w-full justify-between text-xs"
              content-class="w-[var(--reka-popover-trigger-width)]"
            />
            <SearchableSelect
              v-if="sourceSchemas.length"
              v-model="sourceSchema"
              :options="sourceSchemas"
              :placeholder="t('diff.selectSchema')"
              :search-placeholder="t('diff.searchSchema')"
              :empty-text="t('common.noResults')"
              trigger-variant="outline"
              trigger-class="h-8 w-full justify-between text-xs"
              content-class="w-[var(--reka-popover-trigger-width)]"
            />

            <div class="space-y-2 rounded-lg border p-2">
              <div class="flex items-center justify-between gap-2">
                <Label class="text-xs font-medium">{{ t("dataCompare.sourceTables") }}</Label>
                <div v-if="sourceTables.length" class="text-[11px] text-muted-foreground">
                  {{
                    t("dataCompare.selectedTables", {
                      selected: selectedSourceTableNames.length,
                      total: sourceTables.length,
                    })
                  }}
                </div>
              </div>

              <Input v-if="sourceTables.length > 5" v-model="sourceTableSearch" class="h-7 text-xs" :placeholder="t('dataCompare.searchTables')" />

              <div class="flex items-center gap-2">
                <Button v-if="sourceTables.length" variant="outline" size="sm" class="h-7 px-2 text-xs" @click="toggleSelectAllSourceTables">
                  {{ allFilteredTablesSelected ? t("dataCompare.deselectAllTables") : t("dataCompare.selectAllTables") }}
                </Button>
              </div>

              <div v-if="!sourceConnectionId || !sourceDatabase" class="text-xs text-muted-foreground py-3 text-center">
                {{ t("dataCompare.selectSourceTables") }}
              </div>
              <div v-else-if="sourceTables.length === 0" class="text-xs text-muted-foreground py-3 text-center">
                {{ t("dataCompare.noTables") }}
              </div>
              <div v-else class="max-h-40 overflow-auto rounded border">
                <button v-for="table in filteredSourceTables" :key="table" type="button" class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-muted/50" @click="toggleSourceTable(table)">
                  <CheckSquare v-if="selectedSourceTables.has(table)" class="w-3.5 h-3.5 text-primary shrink-0" />
                  <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                  <span class="truncate">{{ table }}</span>
                </button>
              </div>
            </div>
          </div>

          <div class="flex items-center pt-6">
            <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('diff.swap')" @click="swapSourceTarget">
              <ArrowLeftRight class="w-3.5 h-3.5" />
            </Button>
          </div>

          <div class="space-y-2">
            <Label class="text-xs font-medium">{{ t("diff.target") }}</Label>
            <SearchableSelect
              v-model="targetConnectionId"
              :options="sqlConnections.map((c) => c.id)"
              :placeholder="t('diff.selectConnection')"
              :search-placeholder="t('diff.searchConnection')"
              :empty-text="t('common.noResults')"
              :display-name="(id) => sqlConnections.find((c) => c.id === id)?.name ?? id"
              trigger-variant="outline"
              trigger-class="h-8 w-full justify-between text-xs"
              content-class="w-[var(--reka-popover-trigger-width)]"
            >
              <template #option-label="{ option, label }">
                <div class="flex items-center gap-2">
                  <DatabaseIcon :db-type="connectionIconType(option)" class="w-3.5 h-3.5" />
                  {{ label }}
                </div>
              </template>
            </SearchableSelect>
            <SearchableSelect
              v-model="targetDatabase"
              :options="targetDatabases"
              :placeholder="t('diff.selectDatabase')"
              :search-placeholder="t('diff.searchDatabase')"
              :empty-text="t('common.noResults')"
              :disabled="!targetDatabases.length"
              trigger-variant="outline"
              trigger-class="h-8 w-full justify-between text-xs"
              content-class="w-[var(--reka-popover-trigger-width)]"
            />
            <SearchableSelect
              v-if="targetSchemas.length"
              v-model="targetSchema"
              :options="targetSchemas"
              :placeholder="t('diff.selectSchema')"
              :search-placeholder="t('diff.searchSchema')"
              :empty-text="t('common.noResults')"
              trigger-variant="outline"
              trigger-class="h-8 w-full justify-between text-xs"
              content-class="w-[var(--reka-popover-trigger-width)]"
            />

            <div v-if="!isBatchCompare" class="space-y-1">
              <Label class="text-xs font-medium">{{ t("dataCompare.targetTable") }}</Label>
              <SearchableSelect
                v-model="targetTable"
                :options="targetTables"
                :placeholder="t('dataCompare.selectTable')"
                :search-placeholder="t('dataCompare.searchTable')"
                :empty-text="t('common.noResults')"
                trigger-variant="outline"
                trigger-class="h-8 w-full justify-between text-xs"
                content-class="w-[var(--reka-popover-trigger-width)]"
              />
            </div>
            <div v-else class="space-y-2 rounded-lg border p-3 text-xs">
              <div class="font-medium">{{ t("dataCompare.autoMatchHint") }}</div>
              <div class="text-muted-foreground">
                {{ t("dataCompare.matchedTables", { matched: matchedTaskCount, total: selectedSourceTableNames.length }) }}
              </div>
              <div v-if="missingTargetTables.length" class="text-destructive">
                {{ t("dataCompare.missingTargetTables", { tables: missingTargetTables.join(", ") }) }}
              </div>
              <div v-if="compareTasksPreview.length" class="max-h-36 overflow-auto rounded border bg-muted/20">
                <div v-for="task in compareTasksPreview" :key="`${task.sourceTable}:${task.targetTable}`" class="flex items-center justify-between gap-2 border-b px-2 py-1 last:border-b-0">
                  <span class="truncate font-mono">{{ task.sourceTable }}</span>
                  <span class="text-muted-foreground">→</span>
                  <span class="truncate font-mono" :class="task.matched ? '' : 'text-destructive'">
                    {{ task.targetTable || t("dataCompare.targetTableMissing", { table: task.sourceTable }) }}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-1">
          <Label class="text-xs font-medium">{{ t("dataCompare.keyColumns") }}</Label>
          <Input v-model="keyColumnsText" class="h-8 text-xs" :placeholder="t('dataCompare.keyColumnsPlaceholder')" />
          <div class="text-[11px] text-muted-foreground">
            {{ t("dataCompare.keyColumnsAutoHint") }}
          </div>
        </div>

        <div v-if="hasResults" class="space-y-3">
          <div class="rounded-lg border p-3 text-sm space-y-2">
            <div>{{ summary }}</div>
            <div class="text-xs text-muted-foreground">{{ selectedSummary }}</div>
          </div>

          <div class="rounded-lg border p-3 space-y-3">
            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" class="h-7 text-xs" :class="showAdded ? 'border-primary' : ''" @click="showAdded = !showAdded"> {{ t("diff.added") }} · {{ totalAdded }} </Button>
              <Button size="sm" variant="outline" class="h-7 text-xs" :class="showRemoved ? 'border-primary' : ''" @click="showRemoved = !showRemoved"> {{ t("diff.removed") }} · {{ totalRemoved }} </Button>
              <Button size="sm" variant="outline" class="h-7 text-xs" :class="showModified ? 'border-primary' : ''" @click="showModified = !showModified"> {{ t("diff.modified") }} · {{ totalModified }} </Button>
              <span class="flex-1" />
              <Select v-model="detailPreviewLimit">
                <SelectTrigger class="h-7 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="limit in PREVIEW_LIMIT_OPTIONS" :key="limit" :value="String(limit)">
                    {{ t("dataCompare.previewLimitOption", { count: limit }) }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" class="h-7 text-xs" @click="setDiffSelection('added', true)">
                {{ t("dataCompare.selectAllKind", { kind: t("diff.added") }) }}
              </Button>
              <Button size="sm" variant="outline" class="h-7 text-xs" @click="setDiffSelection('removed', true)">
                {{ t("dataCompare.selectAllKind", { kind: t("diff.removed") }) }}
              </Button>
              <Button size="sm" variant="outline" class="h-7 text-xs" @click="setDiffSelection('modified', true)">
                {{ t("dataCompare.selectAllKind", { kind: t("diff.modified") }) }}
              </Button>
              <Button size="sm" variant="outline" class="h-7 text-xs" @click="clearAllSelections">
                {{ t("dataCompare.clearSelection") }}
              </Button>
            </div>
          </div>

          <div class="rounded-lg border overflow-hidden">
            <div class="max-h-64 overflow-auto">
              <table class="w-full text-xs">
                <thead class="bg-muted sticky top-0 z-10">
                  <tr>
                    <th class="px-3 py-2 text-left font-medium">{{ t("diff.table") }}</th>
                    <th class="px-3 py-2 text-left font-medium">{{ t("dataCompare.targetTable") }}</th>
                    <th class="px-3 py-2 text-left font-medium">{{ t("diff.status") }}</th>
                    <th class="px-3 py-2 text-left font-medium">{{ t("diff.details") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in batchResults" :key="`${item.sourceTable}:${item.targetTable}`" class="border-t">
                    <td class="px-3 py-2 align-top font-mono">{{ item.sourceTable }}</td>
                    <td class="px-3 py-2 align-top font-mono text-muted-foreground">{{ item.targetTable }}</td>
                    <td class="px-3 py-2 align-top">
                      <span class="inline-flex rounded px-2 py-0.5 text-[11px]" :class="resultStatusClass(item.status)">
                        {{ resultStatusLabel(item.status) }}
                      </span>
                    </td>
                    <td class="px-3 py-2 align-top text-muted-foreground">
                      <div v-if="item.status === 'error'" class="text-destructive">{{ item.error }}</div>
                      <template v-else>
                        <div>
                          {{
                            t("dataCompare.summary", {
                              added: item.added,
                              removed: item.removed,
                              modified: item.modified,
                            })
                          }}
                        </div>
                        <div class="mt-1">
                          {{
                            t("dataCompare.rowCounts", {
                              source: item.sourceRowCount,
                              target: item.targetRowCount,
                            })
                          }}
                        </div>
                        <div class="mt-1">
                          {{ t("dataCompare.keyColumnsInline", { columns: item.keyColumns.join(", ") }) }}
                        </div>
                        <div v-if="item.status === 'different'" class="mt-1">
                          {{
                            t("dataCompare.selectedInline", {
                              selected: selectedRows(item, "added") + selectedRows(item, "removed") + selectedRows(item, "modified"),
                              total: item.added + item.removed + item.modified,
                            })
                          }}
                        </div>
                      </template>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div class="space-y-3">
            <div v-for="item in batchResults.filter((entry) => entry.status === 'different')" :key="`details-${item.sourceTable}:${item.targetTable}`" class="rounded-lg border overflow-hidden">
              <button type="button" class="flex w-full items-center gap-2 border-b bg-muted/30 px-3 py-2 text-left text-sm font-medium" @click="toggleTableExpanded(item)">
                <ChevronDown v-if="item.expanded" class="h-4 w-4 shrink-0" />
                <ChevronRight v-else class="h-4 w-4 shrink-0" />
                <span class="font-mono">{{ item.sourceTable }}</span>
                <span class="text-muted-foreground">→</span>
                <span class="font-mono text-muted-foreground">{{ item.targetTable }}</span>
              </button>

              <div v-if="item.expanded" class="space-y-3 p-3">
                <div v-for="kind in visibleKinds" :key="`${item.sourceTable}:${kind}`" class="rounded-lg border" v-show="hasDiffRows(item, kind)">
                  <div class="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-2 text-xs">
                    <span class="font-medium">{{ t(`diff.${kind}`) }}</span>
                    <span class="text-muted-foreground">{{ selectedRows(item, kind) }}/{{ item.diff[kind].length }}</span>
                    <span class="flex-1" />
                    <Button size="sm" variant="ghost" class="h-6 px-2 text-xs" @click="setTableDiffSelection(item, kind, true)">
                      {{ t("dataCompare.selectAllKind", { kind: t(`diff.${kind}`) }) }}
                    </Button>
                    <Button size="sm" variant="ghost" class="h-6 px-2 text-xs" @click="setTableDiffSelection(item, kind, false)">
                      {{ t("dataCompare.clearKind", { kind: t(`diff.${kind}`) }) }}
                    </Button>
                    <Button v-if="item.diff[kind].length > detailPreviewLimitNumber" size="sm" variant="ghost" class="h-6 px-2 text-xs" @click="toggleShowAll(item, kind)">
                      {{ item.showAll[kind] ? t("dataCompare.showLessRows") : t("dataCompare.showAllRows", { count: item.diff[kind].length }) }}
                    </Button>
                  </div>

                  <div class="max-h-72 overflow-auto divide-y">
                    <button v-for="row in rowsForDisplay(item, kind)" :key="`${item.sourceTable}:${kind}:${row.key}`" type="button" class="flex w-full items-start gap-3 px-3 py-2 text-left text-xs hover:bg-muted/40" @click="toggleRowSelection(row)">
                      <CheckSquare v-if="row.selected" class="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <Square v-else class="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
                      <div class="min-w-0 flex-1">
                        <div class="font-mono">{{ formatKeyValues(row.keyValues) }}</div>
                        <div class="mt-1 text-muted-foreground break-words">
                          {{ kind === "modified" ? formatModifiedSummary(row as SelectableDataCompareModifiedRow) : formatRowValues((row as SelectableDataCompareRow).values) }}
                        </div>
                      </div>
                    </button>
                  </div>

                  <div v-if="remainingRows(item, kind) > 0 && !item.showAll[kind]" class="border-t px-3 py-2 text-xs text-muted-foreground">
                    {{ t("dataCompare.remainingRows", { count: remainingRows(item, kind) }) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div v-if="planningSync" class="text-sm text-muted-foreground">
            {{ t("dataCompare.planningSync") }}
          </div>
          <div v-else-if="syncPlan.syncSql.trim()" class="space-y-1">
            <Label class="text-xs font-medium">{{ t("diff.generatedSql") }}</Label>
            <textarea :value="syncPlan.syncSql" readonly class="w-full h-48 rounded-[6px] border bg-muted/20 p-3 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring" />
          </div>
          <div v-else-if="differentTableCount === 0 && failedTableCount === 0" class="text-sm text-muted-foreground">
            {{ t("dataCompare.noDifferences") }}
          </div>
          <div v-else class="text-sm text-muted-foreground">
            {{ t("dataCompare.noSelectedDifferences") }}
          </div>
        </div>

        <div v-if="syncErrors.length > 0" class="space-y-1">
          <Label class="text-xs font-medium text-destructive">
            {{ t("diff.syncSummary", { success: executeTotal - syncErrors.length, failed: syncErrors.length }) }}
          </Label>
          <div class="max-h-32 overflow-auto border rounded-lg bg-destructive/5 p-2 space-y-1">
            <div v-for="(err, i) in syncErrors" :key="i" class="text-xs font-mono">
              <span class="text-destructive">{{ err.error }}</span>
              <span class="text-muted-foreground ml-1">— {{ err.sql.slice(0, 80) }}{{ err.sql.length > 80 ? "..." : "" }}</span>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter v-if="!hasResults">
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
        <span v-if="compareProgressLabel" class="text-xs text-muted-foreground self-center">{{ compareProgressLabel }}</span>
        <Button size="sm" :disabled="!canCompare || comparing" @click="startCompare">
          <Loader2 v-if="comparing" class="w-3.5 h-3.5 animate-spin mr-1" />
          <GitCompareArrows v-else class="w-3.5 h-3.5 mr-1" />
          {{ t("dataCompare.compare") }}
        </Button>
      </DialogFooter>

      <DialogFooter v-else class="flex items-center gap-2">
        <Button variant="outline" @click="open = false">{{ t("common.close") }}</Button>
        <span v-if="executing" class="text-xs text-muted-foreground mr-auto">
          {{ t("diff.syncProgress", { current: executedCount, total: executeTotal }) }}
        </span>
        <span v-else-if="planningSync" class="text-xs text-muted-foreground mr-auto">
          {{ t("dataCompare.planningSync") }}
        </span>
        <span v-else class="text-xs text-muted-foreground mr-auto">
          {{
            t("dataCompare.planSummary", {
              inserts: syncPlan.insertCount,
              updates: syncPlan.updateCount,
              deletes: syncPlan.deleteCount,
              statements: syncPlan.statementCount,
            })
          }}
        </span>
        <Button variant="outline" size="sm" :disabled="!syncPlan.syncSql.trim()" @click="copySql"> <Copy class="w-3 h-3 mr-1" /> {{ t("diff.copySql") }} </Button>
        <Button size="sm" :disabled="planningSync || executing || syncPlan.statementCount === 0" @click="executeSql">
          <Loader2 v-if="executing" class="w-3 h-3 animate-spin mr-1" />
          <Play v-else class="w-3 h-3 mr-1" />
          {{ t("diff.executeSync") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

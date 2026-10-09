<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useEventListener, useResizeObserver } from "@vueuse/core";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import { useI18n } from "vue-i18n";
import { ArrowRightLeft, Loader2 } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ConnectionTreeSelect from "@/components/connection/ConnectionTreeSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { isSchemaAware } from "@/lib/database/databaseFeatureSupport";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { normalizeSqliteNamespace } from "@/lib/database/sqliteNamespace";
import { ensureReadOnlyWriteAccess } from "@/lib/database/readOnlyWriteAccess";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";
import { quoteTableIdentifier } from "@/lib/table/tableSelectSql";
import type { ColumnInfo, ConnectionConfig, DatabaseType, QueryResult } from "@/types/database";
import {
  alwaysIdentityColumnNamesFromDdl,
  identityColumnNamesFromDdl,
  nonInsertableColumnNamesFromDdl,
  queryResultTransferCreateCleanupSql,
  queryResultTransferDatabaseType,
  queryResultTransferIncomplete,
  queryResultTransferNeedsCreateCleanup,
  rewriteCreateTableName,
  supportsQueryResultTransfer,
  transactionalMysqlTableDdl,
} from "./queryResultTransfer";
import { postgresTransferSequenceSyncSql, queryResultTransferInsertSql, withSqlServerIdentityInsert } from "./queryResultTransferStatements";
import { adaptMysqlDdlCollations, mysqlDdlCollations, temporalColumnTypesFromDdl } from "./queryResultTransferDdl";
import { analyzeEditableQuery } from "@/lib/sql/sqlAnalysis";
import { queryResultTransferSqlLiteral, queryResultTransferTargetType } from "./queryResultTransferValues";

const open = defineModel<boolean>("open", { default: false });
const props = defineProps<{
  sourceConnectionId: string;
  sourceDatabase: string;
  sourceSchema?: string;
  sourceTable?: string;
  sourceSql?: string;
  sourceDatabaseType?: DatabaseType;
  result: QueryResult;
  loadResult: () => Promise<QueryResult | undefined>;
  loadSourceDdl?: () => Promise<string | undefined>;
}>();

const { t } = useI18n();
const { toast } = useToast();
const connections = useConnectionStore();
const settingsStore = useSettingsStore();
const productionSafetyStore = useProductionSafetyStore();
const targetConnectionId = ref("");
const targetDatabase = ref("");
const targetDatabases = ref<string[]>([]);
const databasesLoading = ref(false);
let dragBounds = { left: 0, right: 0, top: 0, bottom: 0 };
let dragX = 0;
let dragY = 0;
const dragHandle = ref<HTMLElement>();
const dialogElement = computed(() => dragHandle.value?.closest<HTMLElement>('[data-slot="dialog-content"]'));
let stopActiveDrag: (() => void) | undefined;
let dragFrame: number | undefined;
// Keep pointer movement out of Vue's render cycle: the connection tree and
// export form must not be patched on every mouse event.
function paintPosition() {
  if (dragFrame !== undefined) cancelAnimationFrame(dragFrame);
  dragFrame = undefined;
  const element = dialogElement.value;
  if (element) element.style.transform = `translate3d(${dragX}px, ${dragY}px, 0)`;
}
function schedulePosition() {
  if (dragFrame === undefined) dragFrame = requestAnimationFrame(paintPosition);
}
function updateDragBounds(rect: DOMRect) {
  const left = dragX - rect.left + 8;
  const top = dragY - rect.top + 8;
  // If the viewport is smaller than the content, keep its header accessible.
  dragBounds = { left, right: Math.max(left, dragX + window.innerWidth - rect.right - 8), top, bottom: Math.max(top, dragY + window.innerHeight - rect.bottom - 8) };
}
let positionUpdatePending = false;
function constrainDialogPosition() {
  // Resizing changes the drag coordinate origin. End the old gesture rather
  // than letting its next pointer event restore coordinates from the old size.
  stopActiveDrag?.();
  if (positionUpdatePending) return;
  positionUpdatePending = true;
  void nextTick(() => {
    positionUpdatePending = false;
    if (!open.value) return;
    const rect = dialogElement.value?.getBoundingClientRect();
    if (!rect) return;
    updateDragBounds(rect);
    dragX = Math.max(dragBounds.left, Math.min(dragBounds.right, dragX));
    dragY = Math.max(dragBounds.top, Math.min(dragBounds.bottom, dragY));
    paintPosition();
  });
}
useEventListener(window, "resize", constrainDialogPosition);
useResizeObserver(dialogElement, constrainDialogPosition);
onBeforeUnmount(() => {
  stopActiveDrag?.();
  if (dragFrame !== undefined) cancelAnimationFrame(dragFrame);
});
function startDrag(event: PointerEvent) {
  if (event.button !== 0) return;
  stopActiveDrag?.();
  const handle = event.currentTarget as HTMLElement;
  const rect = handle.closest('[data-slot="dialog-content"]')?.getBoundingClientRect();
  if (!rect) return;
  const start = { x: event.clientX, y: event.clientY, offsetX: dragX, offsetY: dragY };
  updateDragBounds(rect);
  handle.setPointerCapture(event.pointerId);
  const move = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    dragX = Math.max(dragBounds.left, Math.min(dragBounds.right, start.offsetX + next.clientX - start.x));
    dragY = Math.max(dragBounds.top, Math.min(dragBounds.bottom, start.offsetY + next.clientY - start.y));
    schedulePosition();
  };
  const stop = () => {
    paintPosition();
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", stop);
    handle.removeEventListener("lostpointercapture", stop);
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    if (stopActiveDrag === stop) stopActiveDrag = undefined;
  };
  const finish = (next: PointerEvent) => {
    if (next.pointerId !== event.pointerId) return;
    move(next);
    stop();
  };
  const cancel = (next: PointerEvent) => {
    if (next.pointerId === event.pointerId) stop();
  };
  stopActiveDrag = stop;
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", cancel);
  window.addEventListener("blur", stop);
  handle.addEventListener("lostpointercapture", stop, { once: true });
  event.preventDefault();
}
const targetSchema = ref("");
const targetTable = ref("");
const mode = ref<"append" | "overwrite">("append");
const createTable = ref(true);
const submitting = ref(false);
const progress = ref("");
const cancelRequested = ref(false);
const canCancel = ref(false);
let sourceRevision = 0;
watch(
  () => [props.result, props.sourceSql, props.sourceDatabaseType, props.sourceConnectionId, props.sourceDatabase, props.sourceSchema, props.sourceTable],
  () => {
    sourceRevision += 1;
  },
  { flush: "sync" },
);
onBeforeUnmount(() => {
  sourceRevision += 1;
});

const sqlConnections = computed(() => connections.connections.filter((item) => supportsQueryResultTransfer(item)));
const targetConfig = computed<ConnectionConfig | undefined>(() => (targetConnectionId.value ? connections.getConfig(targetConnectionId.value) : undefined));
const targetDatabaseType = computed(() => queryResultTransferDatabaseType(targetConfig.value));
const reviewMode = ref<"preview" | "confirm" | null>(null);
const reviewOpen = computed({
  get: () => reviewMode.value !== null,
  set: (value: boolean) => {
    if (!value) reviewMode.value = null;
  },
});
const canTransfer = computed(() => open.value && !!targetConfig.value && !!targetDatabaseType.value && !!targetDatabase.value.trim() && !!targetTable.value.trim() && (!isSchemaAware(targetDatabaseType.value) || !!targetSchema.value.trim()) && !submitting.value && !databasesLoading.value);
const sourceLocation = computed(() => [connections.getConfig(props.sourceConnectionId)?.name || props.sourceConnectionId, props.sourceDatabase, props.sourceSchema, props.sourceTable || props.result.sourceLabel].filter(Boolean).join(" / "));
const targetLocation = computed(() => [targetConfig.value?.name, targetDatabase.value.trim(), isSchemaAware(targetDatabaseType.value) ? targetSchema.value.trim() : undefined, targetTable.value.trim()].filter(Boolean).join(" / "));
const operationSummary = computed(() => t(createTable.value ? "grid.exportDatabasePlanCreate" : mode.value === "overwrite" ? "grid.exportDatabasePlanOverwrite" : "grid.exportDatabasePlanAppend"));
// Any edited source/target invalidates the pending approval. Never execute a
// different destination or result than the one shown in the confirmation.
watch(
  () => [open.value, props.result, props.sourceSql, props.sourceDatabaseType, props.sourceConnectionId, props.sourceDatabase, props.sourceSchema, props.sourceTable, targetConfig.value, targetDatabase.value, targetSchema.value, targetTable.value, mode.value, createTable.value],
  () => {
    reviewMode.value = null;
  },
  { flush: "sync" },
);
function showReview(mode: "preview" | "confirm") {
  if (canTransfer.value) reviewMode.value = mode;
}
function confirmTransfer() {
  if (reviewMode.value !== "confirm" || !canTransfer.value) return;
  reviewMode.value = null;
  void transfer();
}

watch(open, (value) => {
  if (!value) {
    stopActiveDrag?.();
    if (submitting.value && canCancel.value) cancelRequested.value = true;
    return;
  }
  if (submitting.value) return;
  dragX = 0;
  dragY = 0;
  void nextTick(paintPosition);
  targetConnectionId.value = "";
  targetDatabase.value = "";
  targetSchema.value = "";
  targetTable.value = props.result.sourceLabel?.replace(/[^A-Za-z0-9_]+/g, "_") || "query_result";
  mode.value = "append";
  createTable.value = true;
  progress.value = "";
  cancelRequested.value = false;
  canCancel.value = false;
});

watch([open, targetConnectionId], async ([isOpen, id], _previous, onCleanup) => {
  let stale = false;
  onCleanup(() => {
    stale = true;
  });
  targetDatabases.value = [];
  databasesLoading.value = false;
  targetDatabase.value = "";
  targetSchema.value = "";
  if (!isOpen || !id) return;
  const config = connections.getConfig(id);
  if (!config) return;
  targetDatabase.value = config.database || "";
  targetSchema.value = config.default_schema || "";
  databasesLoading.value = true;
  try {
    await connections.ensureConnected(id);
    if (stale) return;
    const databases = await api.listDatabases(id);
    if (stale) return;
    targetDatabases.value = databaseOptionsForConnection(
      databases.map((item) => item.name),
      config,
    );
    if (!targetDatabase.value && targetDatabases.value.length === 1) targetDatabase.value = targetDatabases.value[0]!;
  } catch (error) {
    if (!stale) toast(formatError(error));
  } finally {
    if (!stale) databasesLoading.value = false;
  }
});

function uniqueColumnNames(columns: string[]): string[] {
  const used = new Set<string>();
  return columns.map((column, index) => {
    const base = column.trim() || `column_${index + 1}`;
    let name = base;
    let suffix = 2;
    while (used.has(name.toLowerCase())) name = `${base}_${suffix++}`;
    used.add(name.toLowerCase());
    return name;
  });
}

function requestCancel() {
  if (submitting.value && canCancel.value) {
    cancelRequested.value = true;
    progress.value = t("grid.exportDatabaseCancelling");
  } else if (!submitting.value) {
    open.value = false;
  }
}

async function transfer() {
  const config = targetConfig.value;
  const databaseType = targetDatabaseType.value;
  const database = targetDatabase.value.trim();
  // In MySQL the database is the namespace. Do not allow a hidden second
  // database qualifier to bypass the selected database's production guard.
  // SQLite transactions execute on the main connection, so every target must
  // explicitly name the selected main/attached database in its SQL.
  const schema = databaseType === "sqlite" ? normalizeSqliteNamespace(database, config) : isSchemaAware(databaseType) ? targetSchema.value.trim() : "";
  const tableName = targetTable.value.trim();
  if (!config || !databaseType || !database || !tableName || (isSchemaAware(databaseType) && !schema) || submitting.value) return;
  const target = { config: { ...config }, databaseType, database, schema, tableName, mode: mode.value, createTable: createTable.value };
  const source = { ...props };
  const revision = sourceRevision;
  const identifierQuote = connections.connectionIdentifierQuote(config.id);
  const quote = (name: string) => (!identifierQuote ? quoteTableIdentifier(databaseType, name) : identifierQuote === "[" ? `[${name.replaceAll("]", "]]")}]` : `${identifierQuote}${name.replaceAll(identifierQuote, identifierQuote + identifierQuote)}${identifierQuote}`);
  const table = [schema, tableName].filter(Boolean).map(quote).join(".");
  let createdTargetTable = false;
  submitting.value = true;
  canCancel.value = true;
  cancelRequested.value = false;
  const checkCancelled = () => {
    if (cancelRequested.value || revision !== sourceRevision || !open.value) throw new Error(t("grid.exportDatabaseCancelled"));
  };
  const execute = async (sql: string) => {
    // DDL was already split above. Keep cleanup blocks intact even when a
    // generic JDBC connection uses a different backend statement splitter.
    const result = await api.executeQuery(target.config.id, target.database, sql, target.schema || undefined, undefined, { executionMode: "simple" });
    if (result.execution_error) throw new Error(result.error ? formatError(result.error) : t("grid.exportDatabaseExecutionFailed"));
    return result;
  };
  try {
    const allowed = await ensureReadOnlyWriteAccess({ connection: target.config, source: "Query result transfer", treatAsMutation: true });
    checkCancelled();
    if (!allowed) return;
    if (productionContextForDatabase(target.config, target.database).active) {
      const confirmed = await productionSafetyStore.requestConfirmation({
        sql: `${target.mode === "overwrite" ? "DELETE FROM" : "INSERT INTO"} ${table}`,
        connectionName: target.config.name,
        database: target.database,
        productionDatabases: target.config.production_databases,
        source: t("grid.exportDatabase"),
      });
      checkCancelled();
      if (!confirmed) return;
    }
    const fullResult = await source.loadResult();
    checkCancelled();
    if (!fullResult || !fullResult.columns.length || fullResult.execution_error) throw new Error(t("grid.exportDatabaseEmpty"));
    const rowLimit = settingsStore.editorSettings.exportRowLimitEnabled ? settingsStore.editorSettings.exportRowLimit : undefined;
    if (rowLimit && fullResult.rows.length > rowLimit) throw new Error(t("grid.exportDatabaseRowLimit", { limit: rowLimit }));
    if (queryResultTransferIncomplete(fullResult, rowLimit)) throw new Error(t("grid.exportDatabaseIncomplete"));

    const analysis = analyzeEditableQuery(source.sourceSql || "");
    const canReuseSourceDdl = target.createTable && source.sourceDatabaseType === target.databaseType && !!source.sourceTable && !!analysis?.selectStar && !analysis.sources?.length;
    let tableDdl: string | undefined;
    let existingColumns: ColumnInfo[] | undefined;
    if (canReuseSourceDdl) {
      tableDdl = await source.loadSourceDdl?.();
      checkCancelled();
      if (!tableDdl) throw new Error(t("grid.exportDatabaseDdlUnavailable"));
    } else if (!target.createTable) {
      // Existing targets have their own generated/identity columns and types.
      tableDdl = await api.getTableDisplayDdl(target.config.id, target.database, target.schema || target.database, target.tableName);
      checkCancelled();
      if (!tableDdl) throw new Error(t("grid.exportDatabaseDdlUnavailable"));
      if (["mysql", "goldendb"].includes(target.databaseType) && !transactionalMysqlTableDdl(tableDdl)) throw new Error(t("grid.exportDatabaseNonTransactionalTarget"));
      existingColumns = await api.getColumns(target.config.id, target.database, target.schema || target.database, target.tableName);
      checkCancelled();
      if (!existingColumns.length) throw new Error(t("grid.exportDatabaseDdlUnavailable"));
    }
    const nonInsertable = tableDdl ? nonInsertableColumnNamesFromDdl(tableDdl, target.databaseType) : new Set<string>();
    const declaredTemporalTypes = tableDdl ? temporalColumnTypesFromDdl(tableDdl, target.databaseType) : new Map<string, string | null>();
    const identity = tableDdl ? identityColumnNamesFromDdl(tableDdl, target.databaseType) : new Set<string>();
    const alwaysIdentity = tableDdl ? alwaysIdentityColumnNamesFromDdl(tableDdl, target.databaseType) : new Set<string>();
    const hidden = new Set(fullResult.hidden_column_indexes ?? []);
    const visibleIndexes = fullResult.columns.map((_, index) => index).filter((index) => !hidden.has(index));
    const visibleNames = visibleIndexes.map((index) => fullResult.columns[index]!);
    const existingColumn = (name: string) => existingColumns?.find((item) => item.name === name) ?? (["mysql", "goldendb", "sqlserver"].includes(target.databaseType) ? existingColumns?.find((item) => item.name.toLowerCase() === name.toLowerCase()) : undefined);
    const columnNames = tableDdl ? visibleNames.map((name) => existingColumn(name)?.name ?? name) : uniqueColumnNames(visibleNames);
    const writableIndexes = columnNames.map((column, index) => ({ column, index: visibleIndexes[index]! })).filter(({ column }) => !nonInsertable.has(column));
    if (!writableIndexes.length) throw new Error(t("grid.exportDatabaseNoWritableColumns"));
    const identityColumns = writableIndexes.filter(({ column }) => identity.has(column));
    const pgIdentity = ["postgres", "kingbase", "highgo", "vastbase"].includes(target.databaseType);
    if (identityColumns.length && !pgIdentity && target.databaseType !== "sqlserver") throw new Error(t("grid.exportDatabaseIdentityUnsupported"));
    if (identityColumns.length && target.config.driver_profile === "sqlserver-legacy") throw new Error(t("grid.exportDatabaseIdentityUnsupported"));
    const overrideIdentity = writableIndexes.some(({ column }) => alwaysIdentity.has(column));
    const columns = writableIndexes.map(({ column }) => quote(column));
    const targetColumnTypes = writableIndexes.map(({ column, index }) => {
      const declaredTemporalType = declaredTemporalTypes.get(column);
      if (declaredTemporalType === null) throw new Error(t("grid.exportDatabaseValueUnsupported", { column }));
      if (existingColumns) {
        const metadata = existingColumn(column);
        if (!metadata) throw new Error(t("grid.exportDatabaseTargetColumnMissing", { column }));
        return declaredTemporalType ?? metadata.data_type;
      }
      if (declaredTemporalType) return declaredTemporalType;
      if (canReuseSourceDdl && fullResult.column_types?.[index]) return fullResult.column_types[index]!;
      return queryResultTransferTargetType(fullResult.column_types?.[index], target.databaseType, source.sourceDatabaseType);
    });
    const createStatements: string[] = [];
    const statements: string[] = [];
    if (target.createTable) {
      progress.value = t("grid.exportDatabasePreparing");
      const targetTables = await api.listTables(target.config.id, target.database, target.schema);
      checkCancelled();
      if (targetTables.some((item) => item.name.toLowerCase() === target.tableName.toLowerCase())) throw new Error(t("grid.exportDatabaseTargetExists", { table: target.tableName }));
      let rewrittenDdl = tableDdl ? rewriteCreateTableName(tableDdl, table, target.databaseType, ["mysql", "goldendb"].includes(target.databaseType) ? source.sourceSchema || source.sourceDatabase : undefined) : undefined;
      if (canReuseSourceDdl && !rewrittenDdl) throw new Error(t("grid.exportDatabaseDdlUnavailable"));
      if (rewrittenDdl && ["mysql", "goldendb"].includes(target.databaseType) && mysqlDdlCollations(rewrittenDdl).length) {
        const metadata = await execute("SHOW COLLATION");
        checkCancelled();
        const column = metadata.columns.findIndex((name) => name.toLowerCase() === "collation");
        const supported = column < 0 ? [] : metadata.rows.map((row) => String(row[column] ?? ""));
        const adapted = adaptMysqlDdlCollations(rewrittenDdl, supported);
        if (adapted.unsupported.length) throw new Error(t("grid.exportDatabaseUnsupportedCollation", { collations: adapted.unsupported.join(", ") }));
        rewrittenDdl = adapted.ddl;
        if (adapted.changes.length) toast(t("grid.exportDatabaseCollationAdapted", { changes: adapted.changes.join(", ") }), 10000);
      }
      if (rewrittenDdl)
        createStatements.push(
          ...splitSqlStatementRanges(rewrittenDdl, target.databaseType)
            .map((range) => range.sql)
            .filter((sql) => sql.trim()),
        );
      else createStatements.push(`CREATE TABLE ${table} (${writableIndexes.map(({ column }, index) => `${quote(column)} ${targetColumnTypes[index]}`).join(", ")})`);
    } else if (target.mode === "overwrite") statements.push(`DELETE FROM ${table}`);

    const inserts: string[] = [];
    const buildInserts = (values: string[]) => (target.config.driver_profile === "sqlserver-legacy" ? values.flatMap((value) => queryResultTransferInsertSql(table, columns, [value], target.databaseType)) : queryResultTransferInsertSql(table, columns, values, target.databaseType, overrideIdentity));
    for (let offset = 0; offset < fullResult.rows.length; offset += 200) {
      checkCancelled();
      const rows = fullResult.rows.slice(offset, offset + 200);
      const values = rows.map((row) => {
        if (row.length !== fullResult.columns.length) throw new Error(t("grid.exportDatabaseIncomplete"));
        const literals = writableIndexes.map(({ column, index }, columnIndex) => {
          const literal = queryResultTransferSqlLiteral(row[index], target.databaseType, fullResult.column_types?.[index], targetColumnTypes[columnIndex], source.sourceDatabaseType);
          if (literal === undefined) throw new Error(t("grid.exportDatabaseValueUnsupported", { column }));
          return literal;
        });
        return `(${literals.join(", ")})`;
      });
      // Split large batches down to a single row before rejecting oversized values.
      let batch: string[] = [];
      let bytes = 0;
      for (const value of values) {
        const length = new TextEncoder().encode(value).length;
        if (length > 512 * 1024) throw new Error(t("grid.exportDatabaseBatchTooLarge"));
        if (bytes + length > 512 * 1024) {
          inserts.push(...buildInserts(batch));
          batch = [];
          bytes = 0;
        }
        batch.push(value);
        bytes += length;
      }
      inserts.push(...buildInserts(batch));
      progress.value = `${Math.min(offset + rows.length, fullResult.rows.length)} / ${fullResult.rows.length}`;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (target.databaseType === "sqlserver" && identityColumns.length && inserts.length) statements.push(withSqlServerIdentityInsert(table, inserts));
    else statements.push(...inserts);
    if (pgIdentity && identityColumns.length && fullResult.rows.length) {
      for (const { column } of identityColumns) {
        statements.push(postgresTransferSequenceSyncSql(table, column));
      }
    }
    checkCancelled();
    progress.value = t("grid.exportDatabaseWriting");
    canCancel.value = false;
    if (target.createTable && queryResultTransferNeedsCreateCleanup(target.databaseType)) {
      // CREATE can commit implicitly. Only take ownership after it succeeds;
      // a concurrent creator's table must never be deleted by our cleanup.
      await execute(createStatements[0]!);
      createdTargetTable = true;
      for (const ddl of createStatements.slice(1)) await execute(ddl);
      if (statements.length) await api.executeInTransaction(target.config.id, target.database, statements, target.schema || undefined);
    } else {
      const batch = [...createStatements, ...statements];
      if (batch.length) await api.executeInTransaction(target.config.id, target.database, batch, target.schema || undefined);
    }
    toast(t("grid.exportDatabaseDone"));
    open.value = false;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (createdTargetTable) {
      try {
        await execute(queryResultTransferCreateCleanupSql(table, target.databaseType));
      } catch (cleanupError) {
        toast(t("grid.exportDatabaseCleanupFailed", { table, message, error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError) }), 8000);
        return;
      }
    }
    toast(message, 6000);
  } finally {
    submitting.value = false;
    canCancel.value = false;
    progress.value = "";
  }
}
</script>

<template>
  <Dialog v-model:open="open" :modal="false">
    <DialogContent class="sm:max-w-[640px] !animate-none !transition-none will-change-transform" :show-close-button="!submitting" @escape-key-down="submitting && $event.preventDefault()" @interact-outside.prevent>
      <DialogHeader>
        <div ref="dragHandle" class="cursor-move touch-none select-none pr-8" @pointerdown="startDrag">
          <DialogTitle class="flex items-center gap-2"><ArrowRightLeft class="h-4 w-4" />{{ t("grid.exportDatabase") }}</DialogTitle>
          <DialogDescription>{{ t("grid.exportDatabaseDescription", { database: sourceDatabase, columns: result.columns.length, rows: result.rows.length }) }}</DialogDescription>
        </div>
      </DialogHeader>
      <div class="grid gap-3 py-2">
        <div class="space-y-1.5">
          <Label>{{ t("transfer.targetConnection") }}</Label>
          <ConnectionTreeSelect
            v-model="targetConnectionId"
            :connections="sqlConnections"
            :layout="connections.sidebarLayout"
            :placeholder="t('transfer.selectConnection')"
            :search-placeholder="t('transfer.searchConnection')"
            :empty-text="t('common.noResults')"
            :disabled="submitting"
            trigger-class="h-8 w-full justify-between text-xs"
            list-class="w-[var(--reka-popover-trigger-width)]"
          />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <Label>{{ t("transfer.targetDatabase") }}</Label
            ><SearchableSelect
              v-model="targetDatabase"
              :options="targetDatabases"
              :loading="databasesLoading"
              :disabled="submitting || !targetConnectionId"
              allow-custom
              :placeholder="t('transfer.selectDatabase')"
              :search-placeholder="t('transfer.searchDatabase')"
              :empty-text="t('common.noResults')"
              :loading-text="t('common.loading')"
              trigger-class="h-8 w-full justify-between text-xs"
              content-class="w-[var(--reka-popover-trigger-width)]"
            />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t("transfer.targetSchema") }}{{ isSchemaAware(targetDatabaseType) ? " *" : "" }}</Label
            ><Input v-model="targetSchema" :disabled="submitting || !isSchemaAware(targetDatabaseType)" class="h-8 text-xs" />
          </div>
        </div>
        <div class="space-y-1.5">
          <Label>{{ t("grid.exportDatabaseTable") }}</Label
          ><Input v-model="targetTable" :disabled="submitting" class="h-8 text-xs" />
        </div>
        <div class="flex flex-wrap items-center gap-4 text-xs">
          <label class="flex items-center gap-2"><input v-model="createTable" :disabled="submitting" type="checkbox" />{{ t("grid.exportDatabaseCreateTable") }}</label>
          <label class="flex items-center gap-2"><input v-model="mode" :disabled="submitting" type="radio" value="append" />{{ t("transfer.modeAppend") }}</label>
          <label class="flex items-center gap-2"><input v-model="mode" :disabled="submitting" type="radio" value="overwrite" />{{ t("grid.exportDatabaseModeOverwrite") }}</label>
        </div>
        <p v-if="progress" class="text-xs text-muted-foreground">{{ progress }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" :disabled="submitting && !canCancel" @click="requestCancel">{{ t("transfer.cancel") }}</Button>
        <Button variant="outline" size="sm" :disabled="!canTransfer" data-testid="transfer-preview" @click="showReview('preview')">{{ t("grid.exportDatabasePreview") }}</Button>
        <Button size="sm" :disabled="!canTransfer" @click="showReview('confirm')"><Loader2 v-if="submitting" class="mr-1.5 h-3.5 w-3.5 animate-spin" /><ArrowRightLeft v-else class="mr-1.5 h-3.5 w-3.5" />{{ t("transfer.start") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
  <Dialog v-if="reviewOpen" v-model:open="reviewOpen">
    <DialogContent class="sm:max-w-[640px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t(reviewMode === "confirm" ? "grid.exportDatabaseConfirmTitle" : "grid.exportDatabasePreview") }}</DialogTitle>
        <DialogDescription>{{ t(reviewMode === "confirm" ? "grid.exportDatabaseConfirmDescription" : "grid.exportDatabasePreviewDescription") }}</DialogDescription>
      </DialogHeader>
      <div class="min-h-0 overflow-y-auto space-y-4" data-testid="transfer-overview">
        <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm">
          <dt class="text-muted-foreground">{{ t("grid.exportDatabaseSource") }}</dt>
          <dd class="break-words">{{ sourceLocation }}</dd>
          <dt class="text-muted-foreground">{{ t("grid.exportDatabaseTarget") }}</dt>
          <dd class="break-words font-medium">{{ targetLocation }}</dd>
          <dt class="text-muted-foreground">{{ t("grid.exportDatabaseScope") }}</dt>
          <dd>{{ t("grid.exportDatabaseLoadedScope", { rows: result.rows.length, columns: result.columns.length }) }}</dd>
          <dt class="text-muted-foreground">{{ t("grid.exportDatabaseOperations") }}</dt>
          <dd>{{ operationSummary }}</dd>
          <dt class="text-muted-foreground">{{ t("grid.exportDatabaseColumns") }}</dt>
          <dd class="max-h-28 overflow-y-auto break-words">{{ result.columns.join(", ") }}</dd>
        </dl>
        <p class="text-xs text-muted-foreground">{{ t("grid.exportDatabasePreviewScopeNote") }}</p>
        <p v-if="!createTable && mode === 'overwrite'" class="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{{ t("grid.exportDatabaseOverwriteWarning") }}</p>
      </div>
      <DialogFooter>
        <Button variant="outline" size="sm" data-testid="transfer-review-back" @click="reviewMode = null">{{ t("grid.exportDatabaseBack") }}</Button>
        <Button v-if="reviewMode === 'preview'" size="sm" :disabled="!canTransfer" data-testid="transfer-preview-start" @click="showReview('confirm')">{{ t("transfer.start") }}</Button>
        <Button v-else size="sm" :variant="!createTable && mode === 'overwrite' ? 'destructive' : 'default'" :disabled="!canTransfer" data-testid="transfer-confirm" @click="confirmTransfer">{{ t("grid.exportDatabaseConfirm") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

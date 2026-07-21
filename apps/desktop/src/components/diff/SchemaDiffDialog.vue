<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { GitCompareArrows, ArrowLeft, Play, Loader2, Maximize2, Minimize2, AlertTriangle, CircleCheck } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { useSchemaDiffConfig } from "@/composables/useSchemaDiffConfig";
import SchemaDiffConfigStep from "@/components/diff/SchemaDiffConfigStep.vue";
import SchemaDiffObjectTree from "@/components/diff/SchemaDiffObjectTree.vue";
import SchemaDiffDdlPanel from "@/components/diff/SchemaDiffDdlPanel.vue";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";
import SchemaDiffOptionsPanel from "@/components/diff/SchemaDiffOptionsPanel.vue";

import { getSchemaDiffOptionsForDbType } from "@/lib/schema/schemaDiffOptions";
import { createConcurrencyLimiter, mapWithConcurrency, schemaDiffMetadataConcurrency } from "@/lib/schema/schemaDiffMetadataLoad";
import { normalizeSchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { SchemaDiffCompareOptions, SchemaDiffConfig } from "@/types/schemaDiff";
import type { ObjectSourceKind, TableInfo } from "@/types/database";
import { buildDeploySqlForObjects, convertToSchemaDiffObjects, groupDiffObjects, schemaDiffDeployTargetSchema, type OperationGroup, type SchemaDiffObject, type DiffOperationType, type DiffObjectKind, type SchemaDiffPreparation, type TableSchemaDetail } from "@/lib/schema/schemaDiff";
import { compileSchemaDiffTableFilter, filterSchemaDiffTables } from "@/lib/schema/schemaDiffTableFilter";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const store = useConnectionStore();

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
}>();

// Wizard state
const step = ref<"config" | "compare" | "result" | "deploy-review">("config");

// Deploy confirm dialog
const showConfirmDialog = ref(false);

// Source/Target selections
const sourceConnectionId = ref("");
const sourceDatabase = ref("");
const sourceSchema = ref("");
const targetConnectionId = ref("");
const targetDatabase = ref("");
const targetSchema = ref("");
const ignoreComments = ref(false);

// Options panel
const showOptionsPanel = ref(false);
const optionTree = computed(() => {
  const targetConfig = store.getConfig(targetConnectionId.value);
  const dbType = targetConfig?.db_type || "postgres";
  return getSchemaDiffOptionsForDbType(dbType);
});

// Compare state
const loading = ref(false);
const diffObjects = ref<SchemaDiffObject[]>([]);
const diffGroups = ref<OperationGroup[]>([]);
const selectedObjectId = ref<string | null>(null);
const deploySql = ref("");
const deploySqlAll = ref("");
const executing = ref(false);
const lastDiffResult = ref<SchemaDiffPreparation | null>(null);
const targetDbVersion = ref<string | null>(null);
const showResultDialog = ref(false);
const deployResult = ref<{ success: boolean; message: string; affectedRows?: number } | null>(null);

// Dialog size memory (width + height + splitpanes ratio)
const DIALOG_SIZE_KEY = "dbx-schema-diff-size";
const SPLITPANES_SIZE_KEY = "dbx-schema-diff-splitpanes-v2";
const savedSize = JSON.parse(localStorage.getItem(DIALOG_SIZE_KEY) || "null");

const savedSplitpanes = (() => {
  try {
    const raw = localStorage.getItem(SPLITPANES_SIZE_KEY);
    if (!raw) return null;
    const val = JSON.parse(raw);
    return typeof val === "number" && val >= 10 && val <= 90 ? val : null;
  } catch {
    return null;
  }
})();

// Splitpanes size memory (percentage for first pane)
const splitpanesSize = ref(savedSplitpanes ?? 60);

function handleSplitpanesResized(payload: { panes: { size: number }[] }) {
  if (payload.panes && payload.panes.length > 0) {
    const size = payload.panes[0].size;
    splitpanesSize.value = size;
    localStorage.setItem(SPLITPANES_SIZE_KEY, JSON.stringify(size));
  }
}

const isMaximized = ref(false);

// Config step: always use default size 1100x820
// Result step: use saved size if exists
const dialogStyle = computed(() => {
  if (isMaximized.value) {
    return {
      width: "100vw",
      height: "100vh",
      maxWidth: "100vw",
      maxHeight: "100vh",
      borderRadius: "0",
    };
  }
  if (step.value === "result") {
    return {
      width: savedSize?.width || "1100px",
      height: savedSize?.height || "820px",
      maxWidth: "calc(100vw - 2rem)",
      maxHeight: "calc(100vh - 2rem)",
    };
  }
  return {
    width: "1100px",
    height: "820px",
    maxWidth: "calc(100vw - 2rem)",
    maxHeight: "calc(100vh - 2rem)",
  };
});

function toggleMaximize() {
  isMaximized.value = !isMaximized.value;
}

let resizeObserver: ResizeObserver | null = null;
let saveTimeout: number | null = null;

function setupResizeObserver() {
  const el = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
  if (!el) return;

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (saveTimeout) clearTimeout(saveTimeout);
      saveTimeout = window.setTimeout(() => {
        localStorage.setItem(
          DIALOG_SIZE_KEY,
          JSON.stringify({
            width: `${width}px`,
            height: `${height}px`,
          }),
        );
      }, 500);
    }
  });

  resizeObserver.observe(el);
}

function teardownResizeObserver() {
  if (saveTimeout) clearTimeout(saveTimeout);
  resizeObserver?.disconnect();
  resizeObserver = null;
}

// Only enable resize observer in result step
watch(
  () => step.value,
  (newStep) => {
    if (newStep === "result") {
      setTimeout(setupResizeObserver, 100);
    } else {
      teardownResizeObserver();
    }
  },
);

onBeforeUnmount(() => {
  teardownResizeObserver();
});

// Config management
const { configs, activeConfigId, activeConfig, recentConfigs, ensureDefaultConfig, updateActiveConfigConnection, updateActiveConfigOptions, saveToHistory, deleteFromHistory } = useSchemaDiffConfig();
const schemaDiffPanelOptions = computed(() => normalizeSchemaDiffCompareOptions(activeConfig.value?.options, getDbType()));

const selectedObject = computed(() => {
  if (!selectedObjectId.value) return null;
  for (const group of diffGroups.value) {
    for (const typeGroup of group.typeGroups) {
      const obj = typeGroup.objects.find((o) => o.id === selectedObjectId.value);
      if (obj) return obj;
    }
  }
  return null;
});

const canDeploy = computed(() => {
  return diffObjects.value.some((o) => o.selected && o.operationType !== "none");
});

// Watch for prefilled values
watch(
  () => open.value,
  (isOpen) => {
    if (isOpen) {
      ensureDefaultConfig();
      if (props.prefillConnectionId) {
        sourceConnectionId.value = props.prefillConnectionId;
        if (props.prefillDatabase) {
          sourceDatabase.value = props.prefillDatabase;
        }
        if (props.prefillSchema) {
          sourceSchema.value = props.prefillSchema;
        }
      }
    }
  },
  { immediate: true },
);

// Config sync
watch([sourceConnectionId, sourceDatabase, sourceSchema, targetConnectionId, targetDatabase, targetSchema], ([srcConn, srcDb, srcSchema, tgtConn, tgtDb, tgtSchema]) => {
  updateActiveConfigConnection({
    sourceConnectionId: srcConn,
    sourceDatabase: srcDb,
    sourceSchema: srcSchema,
    targetConnectionId: tgtConn,
    targetDatabase: tgtDb,
    targetSchema: tgtSchema,
  });
});

// Auto-fetch target database version when connection/database changes
watch(
  () => [targetConnectionId.value, targetDatabase.value],
  async ([connId, db]) => {
    if (connId && db) {
      await fetchDbVersion(connId, db, targetSchema.value);
    } else {
      targetDbVersion.value = null;
    }
  },
);

function getDbType(): string {
  const targetConfig = store.getConfig(targetConnectionId.value);
  return targetConfig?.db_type || "postgres";
}

function handleSwap() {
  const tempConn = sourceConnectionId.value;
  const tempDb = sourceDatabase.value;
  const tempSchema = sourceSchema.value;
  sourceConnectionId.value = targetConnectionId.value;
  sourceDatabase.value = targetDatabase.value;
  sourceSchema.value = targetSchema.value;
  targetConnectionId.value = tempConn;
  targetDatabase.value = tempDb;
  targetSchema.value = tempSchema;
}

function handleOptionsUpdate(options: SchemaDiffCompareOptions) {
  if (activeConfig.value) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions(options, getDbType()));
  }
}

/** Map a JDBC table_type to an ObjectSourceKind for getTableDdl routing.
 *  Views and materialized views need the object_type parameter so the
 *  backend can call DBMS_METADATA.GET_DDL with the correct type. */
function isViewOrMaterializedView(tableType: string): ObjectSourceKind | undefined {
  switch (tableType.toUpperCase().replace(/\s+/g, "_")) {
    case "VIEW":
      return "VIEW";
    case "MATERIALIZED_VIEW":
      return "MATERIALIZED_VIEW";
    default:
      return undefined;
  }
}

interface SchemaDetailLoadContext {
  connectionId: string;
  database: string;
  schema: string;
  dbType: string;
  options: SchemaDiffCompareOptions;
}

function shouldLoadIndexes(options: SchemaDiffCompareOptions): boolean {
  return options.indexes || options.primaryKeys || options.uniqueKeys;
}

async function loadSchemaDetails(tables: TableInfo[], context: SchemaDetailLoadContext): Promise<TableSchemaDetail[]> {
  const concurrency = schemaDiffMetadataConcurrency(context.dbType, tables.length);
  const runMetadataQuery = createConcurrencyLimiter(concurrency);

  return mapWithConcurrency(tables, concurrency, async (table) => {
    const objectType = isViewOrMaterializedView(table.table_type);
    const [columns, indexes, foreignKeys, triggers, ddl] = await Promise.all([
      runMetadataQuery(() => api.getColumns(context.connectionId, context.database, context.schema, table.name)),
      shouldLoadIndexes(context.options) ? runMetadataQuery(() => api.listIndexes(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
      context.options.foreignKeys ? runMetadataQuery(() => api.listForeignKeys(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
      context.options.triggers ? runMetadataQuery(() => api.listTriggers(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
      runMetadataQuery(() => api.getTableDdl(context.connectionId, context.database, context.schema, table.name, objectType)),
    ]);

    return { name: table.name, columns, indexes, foreignKeys, triggers, ddl };
  });
}

async function handleCompare() {
  loading.value = true;
  step.value = "compare";

  try {
    const sourceConfig = store.getConfig(sourceConnectionId.value);
    const targetConfig = store.getConfig(targetConnectionId.value);
    const dbType = targetConfig?.db_type || "mysql";
    const sourceDbType = sourceConfig?.db_type || dbType;
    const opts = normalizeSchemaDiffCompareOptions(activeConfig.value?.options, dbType);
    const tableFilter = compileSchemaDiffTableFilter(opts);

    await store.ensureConnected(sourceConnectionId.value);
    await store.ensureConnected(targetConnectionId.value);

    const [srcTables, tgtTables] = await Promise.all([api.listTables(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value), api.listTables(targetConnectionId.value, targetDatabase.value, targetSchema.value)]);
    const { sourceTables, targetTables } = filterSchemaDiffTables(srcTables, tgtTables, tableFilter);

    const sourceDetails = await loadSchemaDetails(sourceTables, {
      connectionId: sourceConnectionId.value,
      database: sourceDatabase.value,
      schema: sourceSchema.value,
      dbType: sourceDbType,
      options: opts,
    });

    const targetDetails = await loadSchemaDetails(targetTables, {
      connectionId: targetConnectionId.value,
      database: targetDatabase.value,
      schema: targetSchema.value,
      dbType,
      options: opts,
    });

    const isPostgresLike = dbType === "postgres" || dbType === "opengauss";

    // Fetch new object types for PostgreSQL-like databases
    const promises: Promise<any>[] = [];
    if (isPostgresLike && opts?.functions) {
      promises.push(api.listFunctions(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value));
      promises.push(api.listFunctions(targetConnectionId.value, targetDatabase.value, targetSchema.value));
    }
    if (isPostgresLike && opts?.sequences) {
      promises.push(api.listSequences(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, !!opts?.sequenceLastValues));
      promises.push(api.listSequences(targetConnectionId.value, targetDatabase.value, targetSchema.value, !!opts?.sequenceLastValues));
    }
    if (isPostgresLike && opts?.rules) {
      promises.push(api.listRules(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value));
      promises.push(api.listRules(targetConnectionId.value, targetDatabase.value, targetSchema.value));
    }
    if (isPostgresLike && opts?.owners) {
      promises.push(api.listOwners(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value));
      promises.push(api.listOwners(targetConnectionId.value, targetDatabase.value, targetSchema.value));
    }

    const results = await Promise.all(promises);
    let idx = 0;
    const srcFunctions = opts?.functions && isPostgresLike ? results[idx++] : [];
    const tgtFunctions = opts?.functions && isPostgresLike ? results[idx++] : [];
    const srcSequences = opts?.sequences && isPostgresLike ? results[idx++] : [];
    const tgtSequences = opts?.sequences && isPostgresLike ? results[idx++] : [];
    const srcRules = opts?.rules && isPostgresLike ? results[idx++] : [];
    const tgtRules = opts?.rules && isPostgresLike ? results[idx++] : [];
    const srcOwners = opts?.owners && isPostgresLike ? results[idx++] : [];
    const tgtOwners = opts?.owners && isPostgresLike ? results[idx++] : [];

    const result = await api.prepareSchemaDiff({
      sourceTables,
      targetTables,
      sourceDetails,
      targetDetails,
      sourceFunctions: srcFunctions,
      targetFunctions: tgtFunctions,
      sourceSequences: srcSequences,
      targetSequences: tgtSequences,
      sourceRules: srcRules,
      targetRules: tgtRules,
      sourceOwners: srcOwners,
      targetOwners: tgtOwners,
      databaseType: dbType,
      targetSchema: schemaDiffDeployTargetSchema(dbType, targetDatabase.value, targetSchema.value),
      ignoreComments: ignoreComments.value,
      cascadeDelete: opts?.cascadeDelete ?? false,
      compareColumnOrder: opts.compareColumnOrder,
    });

    // Convert to unified objects
    diffObjects.value = convertToSchemaDiffObjects(result.diffs, result.functionDiffs, result.sequenceDiffs, result.ruleDiffs, result.ownerDiffs);

    // Group by operation type and object kind
    diffGroups.value = groupDiffObjects(diffObjects.value);

    // Save full result and generate deploy SQL
    lastDiffResult.value = result;
    deploySqlAll.value = result.syncSql;
    regenerateDeploySql();

    step.value = "result";
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
    step.value = "config";
  } finally {
    loading.value = false;
  }
}

function handleToggleGroup(operationType: DiffOperationType) {
  diffGroups.value = diffGroups.value.map((g) => (g.operationType === operationType ? { ...g, expanded: !g.expanded } : g));
}

function handleToggleTypeGroup(operationType: DiffOperationType, kind: DiffObjectKind) {
  diffGroups.value = diffGroups.value.map((g) => {
    if (g.operationType !== operationType) return g;
    return {
      ...g,
      typeGroups: g.typeGroups.map((tg) => (tg.kind === kind ? { ...tg, expanded: !tg.expanded } : tg)),
    };
  });
}

function handleToggleGroupSelection(operationType: DiffOperationType, selected: boolean) {
  diffGroups.value = diffGroups.value.map((g) => {
    if (g.operationType !== operationType) return g;
    return {
      ...g,
      selectedCount: selected ? g.count : 0,
      typeGroups: g.typeGroups.map((tg) => {
        for (const obj of tg.objects) {
          obj.selected = selected;
        }
        return { ...tg, selectedCount: selected ? tg.objects.length : 0 };
      }),
    };
  });
  regenerateDeploySql();
}

function handleToggleTypeSelection(operationType: DiffOperationType, kind: DiffObjectKind, selected: boolean) {
  diffGroups.value = diffGroups.value.map((g) => {
    if (g.operationType !== operationType) return g;
    const newTypeGroups = g.typeGroups.map((tg) => {
      if (tg.kind !== kind) return tg;
      for (const obj of tg.objects) {
        obj.selected = selected;
      }
      return { ...tg, selectedCount: selected ? tg.objects.length : 0 };
    });
    const newSelectedCount = newTypeGroups.reduce((sum, tg) => sum + tg.selectedCount, 0);
    return { ...g, selectedCount: newSelectedCount, typeGroups: newTypeGroups };
  });
  regenerateDeploySql();
}

function handleToggleObjectSelection(objectId: string, selected: boolean) {
  const obj = diffObjects.value.find((o) => o.id === objectId);
  if (!obj) return;

  obj.selected = selected;

  // Update diffGroups with new references to trigger reactivity
  diffGroups.value = diffGroups.value.map((g) => {
    if (g.operationType !== obj.operationType) return g;
    const newTypeGroups = g.typeGroups.map((tg) => {
      if (tg.kind !== obj.objectKind) return tg;
      const newSelectedCount = tg.objects.filter((o) => o.selected).length;
      return { ...tg, selectedCount: newSelectedCount };
    });
    const newSelectedCount = newTypeGroups.reduce((sum, tg) => sum + tg.selectedCount, 0);
    return { ...g, selectedCount: newSelectedCount, typeGroups: newTypeGroups };
  });

  regenerateDeploySql();
}

function regenerateDeploySql() {
  deploySql.value = buildDeploySqlForObjects(diffObjects.value);
}

async function handleExecuteScript() {
  if (!deploySql.value || deploySql.value.startsWith("-- ")) {
    toast(t("diff.noObjectsSelected"), 3000);
    return;
  }

  executing.value = true;
  try {
    const result = await executeWithProductionSqlGuard({
      connection: store.getConfig(targetConnectionId.value),
      database: targetDatabase.value,
      sql: deploySql.value,
      source: t("production.sourceSchemaDiff"),
      execute: () => api.executeScript(targetConnectionId.value, targetDatabase.value, deploySql.value, targetSchema.value),
    });
    if (!result) return;
    toast(t("diff.executeSuccess"), 3000);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    executing.value = false;
  }
}
async function handleSelectObject(obj: SchemaDiffObject) {
  selectedObjectId.value = obj.id;

  // Dynamically fetch DDL for objects that don't have pre-generated DDL
  // (views need runtime retrieval; functions should already have definition)
  const objectTypeMap: Record<string, ObjectSourceKind> = {
    function: "FUNCTION",
    view: "VIEW",
  };
  const objectType = objectTypeMap[obj.objectKind];
  if (!objectType) return;

  try {
    // For "create" objects: source has it, target doesn't → fetch source DDL
    if (obj.operationType === "create" && !obj.sourceDdl) {
      const result = await api.getObjectSource(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, obj.name, objectType, obj.arguments);
      if (result?.source) obj.sourceDdl = result.source;
    }

    // For "delete" objects: target has it, source doesn't → fetch target DDL
    if (obj.operationType === "delete" && !obj.targetDdl) {
      const result = await api.getObjectSource(targetConnectionId.value, targetDatabase.value, targetSchema.value, obj.name, objectType, obj.arguments);
      if (result?.source) obj.targetDdl = result.source;
    }

    // For "modify" objects: fetch whichever side is missing
    if (obj.operationType === "modify") {
      if (!obj.sourceDdl) {
        const result = await api.getObjectSource(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, obj.name, objectType, obj.arguments);
        if (result?.source) obj.sourceDdl = result.source;
      }
      if (!obj.targetDdl) {
        const result = await api.getObjectSource(targetConnectionId.value, targetDatabase.value, targetSchema.value, obj.name, objectType, obj.arguments);
        if (result?.source) obj.targetDdl = result.source;
      }
    }
  } catch {
    // Silently ignore errors
  }
}
function handleLoadHistoryConfig(config: SchemaDiffConfig) {
  sourceConnectionId.value = config.sourceConnectionId;
  sourceDatabase.value = config.sourceDatabase;
  sourceSchema.value = config.sourceSchema;
  targetConnectionId.value = config.targetConnectionId;
  targetDatabase.value = config.targetDatabase;
  targetSchema.value = config.targetSchema;
  if (config.options) {
    updateActiveConfigOptions(config.options);
  }
}

function handleSaveConfig() {
  if (activeConfig.value) {
    const name = window.prompt(t("diff.saveConfigPrompt") || "Please enter config name:", activeConfig.value.name || "Default");
    if (name === null) return; // User cancelled
    const configToSave = { ...activeConfig.value, name: name.trim() || "Default" };
    saveToHistory(configToSave);
    toast(t("diff.configSaved"), 2000);
  }
}

function handleDeleteHistoryConfig(configId: string) {
  deleteFromHistory(configId);
  toast(t("diff.configDeleted"), 2000);
}

async function fetchDbVersion(connectionId: string, database: string, schema: string) {
  try {
    await store.ensureConnected(connectionId);
    const config = store.getConfig(connectionId);
    const dbType = config?.db_type;
    let sql = "";
    switch (dbType) {
      case "postgres":
      case "opengauss":
        sql = "SELECT version()";
        break;
      case "mysql":
        sql = "SELECT VERSION()";
        break;
      case "sqlite":
        sql = "SELECT sqlite_version()";
        break;
      default:
        return;
    }
    const result = await api.executeQuery(connectionId, database, sql, schema || undefined);
    if (result.rows && result.rows.length > 0) {
      targetDbVersion.value = String(result.rows[0][0]);
    } else {
      console.warn("[fetchDbVersion] No rows returned");
    }
  } catch (e) {
    console.error("[fetchDbVersion] Failed to fetch version:", e);
    targetDbVersion.value = null;
  }
}

function handleDeployReview() {
  const selectedObjects = diffObjects.value.filter((o) => o.selected && o.operationType !== "none");
  if (selectedObjects.length === 0) {
    toast(t("diff.noObjectsSelected"), 3000);
    return;
  }
  step.value = "deploy-review";
  fetchDbVersion(targetConnectionId.value, targetDatabase.value, targetSchema.value);
}

async function handleDeploy() {
  showConfirmDialog.value = true;
}

async function onConfirmDeploy() {
  showConfirmDialog.value = false;
  executing.value = true;
  try {
    const result = await executeWithProductionSqlGuard({
      connection: store.getConfig(targetConnectionId.value),
      database: targetDatabase.value,
      sql: deploySql.value,
      source: t("production.sourceSchemaDiff"),
      execute: () => api.executeScript(targetConnectionId.value, targetDatabase.value, deploySql.value, targetSchema.value),
    });
    if (!result) return;
    deployResult.value = {
      success: true,
      message: t("diff.deploySuccess"),
      affectedRows: result.affected_rows,
    };
    showResultDialog.value = true;
  } catch (e: any) {
    deployResult.value = {
      success: false,
      message: e?.message || String(e),
    };
    showResultDialog.value = true;
  } finally {
    executing.value = false;
  }
}

const deployStats = computed(() => {
  const selected = diffObjects.value.filter((o) => o.selected && o.operationType !== "none");
  const isTopLevel = (o: SchemaDiffObject) => !o.id.startsWith("col-") && !o.id.startsWith("idx-") && !o.id.startsWith("fk-") && !o.id.startsWith("trg-");
  const topLevel = selected.filter(isTopLevel);
  return {
    create: topLevel.filter((o) => o.operationType === "create").length,
    modify: topLevel.filter((o) => o.operationType === "modify").length,
    delete: topLevel.filter((o) => o.operationType === "delete").length,
    total: topLevel.length,
  };
});

const targetConnectionInfo = computed(() => {
  const config = store.getConfig(targetConnectionId.value);
  if (!config) return null;
  return {
    host: config.host || "-",
    port: config.port || "-",
    dbType: config.db_type || "-",
  };
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :class="['min-w-[800px] flex flex-col overflow-hidden', isMaximized ? '' : 'resize']" :style="dialogStyle" @interact-outside.prevent>
      <Button variant="ghost" size="icon-sm" class="absolute top-2 right-10 z-10" @click="toggleMaximize">
        <Maximize2 v-if="!isMaximized" class="w-4 h-4" />
        <Minimize2 v-else class="w-4 h-4" />
        <span class="sr-only">{{ isMaximized ? t("diff.restore") : t("diff.maximize") }}</span>
      </Button>

      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <GitCompareArrows class="w-4 h-4" />
          {{ t("diff.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-hidden flex flex-col">
        <!-- Config Step -->
        <SchemaDiffConfigStep
          v-if="step === 'config'"
          v-model:source-connection-id="sourceConnectionId"
          v-model:source-database="sourceDatabase"
          v-model:source-schema="sourceSchema"
          v-model:target-connection-id="targetConnectionId"
          v-model:target-database="targetDatabase"
          v-model:target-schema="targetSchema"
          v-model:ignore-comments="ignoreComments"
          :configs="configs"
          :active-config-id="activeConfigId"
          :options="activeConfig?.options"
          :loading="loading"
          :recent-configs="recentConfigs"
          @compare="handleCompare"
          @swap="handleSwap"
          @show-options="showOptionsPanel = true"
          @save-config="handleSaveConfig"
          @load-history-config="handleLoadHistoryConfig"
          @delete-history-config="handleDeleteHistoryConfig"
        />

        <!-- Compare Loading -->
        <div v-else-if="step === 'compare'" class="flex items-center justify-center py-20">
          <Loader2 class="w-6 h-6 animate-spin mr-2" />
          <span class="text-sm text-muted-foreground">{{ t("diff.comparing") }}</span>
        </div>

        <!-- Result Step -->
        <template v-else-if="step === 'result'">
          <Splitpanes horizontal class="flex-1 min-h-0" @resized="handleSplitpanesResized">
            <Pane :size="splitpanesSize" min-size="20">
              <div class="h-full overflow-auto">
                <SchemaDiffObjectTree
                  :groups="diffGroups"
                  :selected-object-id="selectedObject?.id ?? null"
                  @toggle-group="handleToggleGroup"
                  @toggle-type-group="handleToggleTypeGroup"
                  @toggle-group-selection="handleToggleGroupSelection"
                  @toggle-type-selection="handleToggleTypeSelection"
                  @toggle-object-selection="handleToggleObjectSelection"
                  @select-object="handleSelectObject"
                />
              </div>
            </Pane>
            <Pane :size="100 - splitpanesSize" min-size="20">
              <SchemaDiffDdlPanel :selected-object="selectedObject" :deploy-sql="deploySql" :deploy-sql-all="deploySqlAll" @execute-script="handleExecuteScript" />
            </Pane>
          </Splitpanes>
        </template>

        <!-- Deploy Review Step -->
        <template v-else-if="step === 'deploy-review'">
          <SchemaDiffDeployStep v-model:deploy-sql="deploySql" :selected-objects="diffObjects" :target-connection-id="targetConnectionId" :target-database="targetDatabase" :target-schema="targetSchema" :executing="executing" @back="step = 'result'" @deploy="handleDeploy" />
        </template>
      </div>

      <!-- Footer -->
      <DialogFooter class="flex items-center justify-between">
        <div v-if="step === 'result'" class="flex items-center gap-2">
          <Button variant="outline" size="sm" @click="step = 'config'">
            <ArrowLeft class="w-3.5 h-3.5 mr-1" />
            {{ t("diff.prevStep") }}
          </Button>
          <Button variant="outline" size="sm" :disabled="loading" @click="handleCompare">
            <GitCompareArrows class="w-3.5 h-3.5 mr-1" />
            {{ t("diff.recompare") }}
          </Button>
        </div>
        <div v-else></div>

        <div v-if="step === 'result'" class="flex items-center gap-2">
          <Button size="sm" :disabled="!canDeploy || executing" @click="handleDeployReview">
            <Loader2 v-if="executing" class="w-3.5 h-3.5 mr-1 animate-spin" />
            <Play v-else class="w-3.5 h-3.5 mr-1" />
            {{ t("diff.nextStepDeploy") }}
          </Button>
        </div>
      </DialogFooter>

      <!-- Deploy Confirm Dialog -->
      <Dialog v-model:open="showConfirmDialog">
        <DialogContent class="sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2 text-destructive">
              <AlertTriangle class="h-5 w-5" />
              {{ t("diff.deployConfirmTitle") }}
            </DialogTitle>
          </DialogHeader>

          <div class="py-2 space-y-3">
            <p class="text-sm text-muted-foreground">{{ t("diff.deployConfirmMessage") }}</p>

            <div class="bg-muted p-3 rounded text-xs font-mono space-y-1">
              <div v-if="targetConnectionInfo">
                {{ t("diff.targetServer") }}: {{ targetConnectionInfo.host }}:{{ targetConnectionInfo.port }}
                <span class="text-muted-foreground">({{ targetConnectionInfo.dbType }})</span>
              </div>
              <div v-if="targetDbVersion">{{ t("diff.dbVersion") }}: {{ targetDbVersion }}</div>
              <div>
                {{ t("diff.targetDatabase") }}:
                <span class="text-primary font-bold">{{ targetDatabase }}</span>
              </div>
              <div>
                {{ t("diff.targetSchema") }}:
                <span class="text-primary font-bold">{{ targetSchema || "-" }}</span>
              </div>
            </div>

            <div class="flex gap-4 text-sm">
              <span class="text-green-600">{{ t("diff.create") }}: {{ deployStats.create }}</span>
              <span class="text-blue-600">{{ t("diff.modify") }}: {{ deployStats.modify }}</span>
              <span class="text-red-600">{{ t("diff.delete") }}: {{ deployStats.delete }}</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" @click="showConfirmDialog = false">{{ t("diff.cancel") }}</Button>
            <Button variant="destructive" :disabled="executing" @click="onConfirmDeploy">
              <Loader2 v-if="executing" class="w-3.5 h-3.5 mr-1 animate-spin" />
              {{ t("diff.confirmDeploy") }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <!-- Deploy Result Dialog -->
      <Dialog v-model:open="showResultDialog">
        <DialogContent class="sm:max-w-[480px]">
          <DialogHeader>
            <DialogTitle class="flex items-center gap-2" :class="deployResult?.success ? 'text-green-500' : 'text-destructive'">
              <AlertTriangle v-if="!deployResult?.success" class="h-5 w-5" />
              <CircleCheck v-else class="h-5 w-5" />
              {{ deployResult?.success ? t("diff.deploySuccess") : t("diff.deployFailed") }}
            </DialogTitle>
          </DialogHeader>

          <div class="py-2">
            <div v-if="deployResult?.success" class="space-y-2">
              <p class="text-sm text-muted-foreground">{{ t("diff.deploySuccessMessage") }}</p>
              <div class="bg-muted p-3 rounded text-xs font-mono">
                <div>{{ t("diff.affectedRows") }}: {{ deployResult.affectedRows ?? 0 }}</div>
                <div>{{ t("diff.executedStatements") }}: {{ deployStats.total }}</div>
              </div>
            </div>
            <div v-else class="space-y-2">
              <p class="text-sm text-muted-foreground">{{ t("diff.deployFailedMessage") }}</p>
              <pre class="text-xs bg-destructive/10 text-destructive p-3 rounded overflow-auto max-h-40 font-mono whitespace-pre-wrap">{{ deployResult?.message }}</pre>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" @click="showResultDialog = false">{{ t("diff.close") }}</Button>
            <Button
              v-if="deployResult?.success"
              @click="
                showResultDialog = false;
                step = 'result';
              "
            >
              {{ t("diff.backToResult") }}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <!-- Options Panel Overlay -->
      <div v-if="showOptionsPanel" class="absolute inset-0 bg-background/80 backdrop-blur-sm z-50 flex items-center justify-center" @click.self="showOptionsPanel = false">
        <div class="bg-card border rounded-lg shadow-lg w-[760px] max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-auto p-4">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-medium">{{ t("schemaDiff.optionsTitle") }}</h3>
            <Button variant="ghost" size="sm" @click="showOptionsPanel = false">✕</Button>
          </div>
          <SchemaDiffOptionsPanel :options="schemaDiffPanelOptions" :option-tree="optionTree" @update:options="handleOptionsUpdate" @close="showOptionsPanel = false" />
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:deep(.splitpanes--horizontal > .splitpanes__splitter) {
  height: 8px;
  background: hsl(var(--border));
  cursor: row-resize;
}
:deep(.splitpanes--horizontal > .splitpanes__splitter:hover) {
  background: hsl(var(--primary));
}
</style>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { GitCompareArrows, ArrowLeft, Play, Loader2, Maximize2, Minimize2, AlertTriangle, CircleCheck, ChevronDown, ChevronRight } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { useSchemaDiffConfig } from "@/composables/useSchemaDiffConfig";
import SchemaDiffConfigStep from "@/components/diff/SchemaDiffConfigStep.vue";
import FieldMappingDialog from "@/components/diff/FieldMappingDialog.vue";
import SchemaDiffObjectTree from "@/components/diff/SchemaDiffObjectTree.vue";
import SchemaDiffDdlPanel from "@/components/diff/SchemaDiffDdlPanel.vue";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";
import SchemaDiffOptionsPanel from "@/components/diff/SchemaDiffOptionsPanel.vue";

import { getSchemaDiffOptionsForDbType } from "@/lib/schema/schemaDiffOptions";
import { buildDeployTxResult } from "@/lib/schema/deployTxResult";
import { createConcurrencyLimiter, mapWithConcurrency, schemaDiffMetadataConcurrency, schemaDiffMetadataLoadPlan } from "@/lib/schema/schemaDiffMetadataLoad";
import { normalizeSchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { SchemaDiffCompareOptions, SchemaDiffConfig, FieldMappingEntry } from "@/types/schemaDiff";
import type { ObjectSourceKind, TableInfo } from "@/types/database";
import {
  buildDeploySqlForObjects,
  convertToSchemaDiffObjects,
  detectDestructiveSchemaDiffStatements,
  groupDiffObjects,
  injectColumnRenameSql,
  schemaDiffDeployTargetSchema,
  schemaDiffSelectionOwnerId,
  selectedSchemaDiffObjects,
  setSchemaDiffObjectSelected,
  summarizeSchemaDiffOperations,
  databaseTypeToDialectKind,
  normalizeDialectKind,
  type OperationGroup,
  type SchemaDiffObject,
  type DiffOperationType,
  type DiffObjectKind,
  type SchemaDiffPreparation,
  type MissingRollbackObject,
  type RollbackCompleteness,
  type TableSchemaDetail,
  type RenameCandidate,
  type CompatibilityWarning,
  type PermissionDiff,
  type DependencyGraph,
} from "@/lib/schema/schemaDiff";
import { compileSchemaDiffTableFilter, filterSchemaDiffTables, isSchemaDiffView } from "@/lib/schema/schemaDiffTableFilter";
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
const showFieldMappingDialog = ref(false);
const sourceDbType = computed(() => store.getConfig(sourceConnectionId.value)?.db_type ?? "");
const targetDbType = computed(() => store.getConfig(targetConnectionId.value)?.db_type ?? "");

// Clear stale field mappings when source and target are the same type
watch([sourceDbType, targetDbType], ([src, tgt]) => {
  if (src && src === tgt && activeConfig.value?.options.fieldMappings?.length) {
    handleFieldMappingsUpdate([]);
  }
});
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
const deployResult = ref<{ success: boolean; status?: string; message: string; affectedRows?: number; error?: string } | null>(null);

// Phase 4 result fields
const rollbackSql = ref("");
const rollbackCompleteness = ref<RollbackCompleteness>("complete");
const missingRollbackObjects = ref<MissingRollbackObject[]>([]);
const renameCandidates = ref<RenameCandidate[]>([]);
const compatibilityWarnings = ref<CompatibilityWarning[]>([]);
const permissionDiffs = ref<PermissionDiff[]>([]);
const dependencyGraph = ref<DependencyGraph | null>(null);

// Rename candidates panel
const showRenamePanel = ref(true);

// Rollback / forward SQL mode in deploy step
const deploySqlMode = ref<"forward" | "rollback">("forward");

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
      width: "100%",
      height: "100%",
      maxWidth: "100%",
      maxHeight: "100%",
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

function handleDialogEscape(event: KeyboardEvent) {
  if (!showOptionsPanel.value) return;

  event.preventDefault();
  showOptionsPanel.value = false;
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

function handleFieldMappingsUpdate(mappings: FieldMappingEntry[]) {
  if (activeConfig.value) {
    const updated = { ...activeConfig.value.options, fieldMappings: mappings };
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions(updated, getDbType()));
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

async function loadSchemaDetails(tables: TableInfo[], context: SchemaDetailLoadContext): Promise<TableSchemaDetail[]> {
  const concurrency = schemaDiffMetadataConcurrency(context.dbType, tables.length);
  const runMetadataQuery = createConcurrencyLimiter(concurrency);

  return mapWithConcurrency(tables, concurrency, async (table) => {
    const objectType = isViewOrMaterializedView(table.table_type);
    const loadPlan = schemaDiffMetadataLoadPlan(isSchemaDiffView(table), context.options);
    const ddlPromise = loadPlan.ddl ? runMetadataQuery(() => api.getTableDdl(context.connectionId, context.database, context.schema, table.name, objectType)) : Promise.resolve("");
    const [columns, indexes, foreignKeys, triggers, ddl] = await Promise.all([
      loadPlan.columns ? runMetadataQuery(() => api.getColumns(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
      loadPlan.indexes ? runMetadataQuery(() => api.listIndexes(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
      loadPlan.foreignKeys ? runMetadataQuery(() => api.listForeignKeys(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
      loadPlan.triggers ? runMetadataQuery(() => api.listTriggers(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
      ddlPromise,
    ]);

    return { name: table.name, columns, indexes, foreignKeys, triggers, ddl };
  });
}

async function handleCompare() {
  loading.value = true;
  step.value = "compare";

  // Reset Phase 4 state to prevent stale data from previous compares
  rollbackSql.value = "";
  rollbackCompleteness.value = "complete";
  missingRollbackObjects.value = [];
  renameCandidates.value = [];
  compatibilityWarnings.value = [];
  permissionDiffs.value = [];
  dependencyGraph.value = null;

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
    const { sourceTables, targetTables } = filterSchemaDiffTables(srcTables, tgtTables, tableFilter, opts);

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
      detectRenames: opts?.detectRenames ?? false,
      detectTableRenames: opts?.detectTableRenames ?? false,
      renameThreshold: opts?.renameThreshold ?? 0.5,
      enableRollback: opts?.enableRollback ?? false,
      batchPatterns: opts?.batchPatterns
        ? opts.batchPatterns
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean)
        : undefined,
      sourceDialect: opts?.sourceDialect ? normalizeDialectKind(opts.sourceDialect) : sourceConfig?.db_type ? databaseTypeToDialectKind(sourceConfig.db_type) : undefined,
      targetDialect: opts?.targetDialect ? normalizeDialectKind(opts.targetDialect) : targetConfig?.db_type ? databaseTypeToDialectKind(targetConfig.db_type) : undefined,
      compatibilityThreshold: opts?.compatibilityThreshold ?? 0.5,
      fieldMappings:
        opts?.fieldMappings?.map((m: FieldMappingEntry) => ({
          sourceType: m.sourceType,
          targetType: m.targetType,
          paramStrategy: m.paramStrategy ?? "preserve",
          customParams: m.customParams,
        })) || [],
    });

    // Extract new result fields
    rollbackSql.value = result.rollbackSyncSql ?? "";
    rollbackCompleteness.value = result.rollbackCompleteness ?? "complete";
    missingRollbackObjects.value = result.missingRollbackObjects ?? [];
    renameCandidates.value = result.renameCandidates ?? [];
    compatibilityWarnings.value = result.compatibilityWarnings ?? [];
    permissionDiffs.value = result.permissionDiffs ?? [];
    dependencyGraph.value = result.dependencyGraph ?? null;

    // Convert to unified objects
    diffObjects.value = convertToSchemaDiffObjects(result.diffs, result.functionDiffs, result.sequenceDiffs, result.ruleDiffs, result.ownerDiffs, result.renameCandidates);

    // Group by operation type and object kind
    diffGroups.value = groupDiffObjects(diffObjects.value);

    // Save full result and apply column rename detection to SQL
    lastDiffResult.value = result;
    deploySqlAll.value = result.syncSql;
    if (opts?.detectRenames && opts.renameThreshold) {
      deploySqlAll.value = injectColumnRenameSql(deploySqlAll.value, result.diffs, opts.renameThreshold);
      if (rollbackSql.value) {
        rollbackSql.value = injectColumnRenameSql(rollbackSql.value, result.diffs, opts.renameThreshold, true);
      }
    }
    deploySqlMode.value = "forward";
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
  const group = diffGroups.value.find((candidate) => candidate.operationType === operationType);
  for (const object of group?.typeGroups.flatMap((typeGroup) => typeGroup.objects) ?? []) {
    setSchemaDiffObjectSelected(diffObjects.value, schemaDiffSelectionOwnerId(object), selected);
  }
  rebuildDiffGroups();
  regenerateDeploySql();
}

function handleToggleTypeSelection(operationType: DiffOperationType, kind: DiffObjectKind, selected: boolean) {
  const typeGroup = diffGroups.value.find((group) => group.operationType === operationType)?.typeGroups.find((candidate) => candidate.kind === kind);
  for (const object of typeGroup?.objects ?? []) {
    setSchemaDiffObjectSelected(diffObjects.value, schemaDiffSelectionOwnerId(object), selected);
  }
  rebuildDiffGroups();
  regenerateDeploySql();
}

function handleToggleObjectSelection(objectId: string, selected: boolean) {
  const reviewObject = diffGroups.value.flatMap((group) => group.typeGroups.flatMap((typeGroup) => typeGroup.objects)).find((object) => object.id === objectId);
  if (!setSchemaDiffObjectSelected(diffObjects.value, reviewObject ? schemaDiffSelectionOwnerId(reviewObject) : objectId, selected)) return;
  rebuildDiffGroups();
  regenerateDeploySql();
}

function rebuildDiffGroups() {
  const expanded = new Map(diffGroups.value.map((group) => [group.operationType, group.expanded]));
  const typeExpanded = new Map(diffGroups.value.flatMap((group) => group.typeGroups.map((typeGroup) => [`${group.operationType}:${typeGroup.kind}`, typeGroup.expanded] as const)));
  diffGroups.value = groupDiffObjects(diffObjects.value).map((group) => ({
    ...group,
    expanded: expanded.get(group.operationType) ?? group.expanded,
    typeGroups: group.typeGroups.map((typeGroup) => ({
      ...typeGroup,
      expanded: typeExpanded.get(`${group.operationType}:${typeGroup.kind}`) ?? typeGroup.expanded,
    })),
  }));
}

function regenerateDeploySql() {
  deploySql.value = buildDeploySqlForObjects(diffObjects.value);
}

function switchDeploySqlMode(mode: "forward" | "rollback") {
  if (mode === "rollback" && rollbackCompleteness.value === "incomplete") {
    toast(t("diff.rollbackIncompleteBlocked"), 4000);
    return;
  }
  deploySqlMode.value = mode;
  if (mode === "rollback" && rollbackSql.value) {
    deploySql.value = rollbackSql.value;
  } else {
    regenerateDeploySql();
  }
}

const canExecuteDeploy = computed(() => {
  if (deploySqlMode.value === "rollback" && rollbackCompleteness.value === "incomplete") {
    return false;
  }
  return true;
});

const destructiveStatements = computed(() => {
  const databaseType = store.getConfig(targetConnectionId.value)?.db_type;
  return detectDestructiveSchemaDiffStatements(deploySql.value, databaseType);
});

function applyRename(rc: RenameCandidate) {
  let found = false;
  for (const obj of diffObjects.value) {
    // Backend-detected renamed diff (diff_type = "renamed")
    if (obj.renameMetadata?.sourceName === rc.sourceName && obj.renameMetadata?.targetName === rc.targetName) {
      obj.renameMetadata.confirmed = true;
      obj.selected = true;
      found = true;
    }
    // Legacy delete+create pair
    if (obj.operationType === "delete" && obj.name === rc.sourceName) {
      obj.deploySql = `-- Renamed to ${rc.targetName}\n${obj.deploySql ?? ""}`;
      obj.renameMetadata = { confirmed: true, targetName: rc.targetName, score: rc.score };
      found = true;
    }
    if (obj.operationType === "create" && obj.name === rc.targetName) {
      obj.deploySql = `-- Renamed from ${rc.sourceName}\n${obj.deploySql ?? ""}`;
      obj.sourceName = rc.sourceName;
      obj.renameMetadata = { confirmed: true, sourceName: rc.sourceName, score: rc.score };
      found = true;
    }
  }
  if (found) {
    regenerateDeploySql();
    toast(t("diff.renameApplied"), 2000);
  }
}

function ignoreRename(index: number) {
  const rc = renameCandidates.value[index];
  if (rc) {
    for (const obj of diffObjects.value) {
      if (obj.renameMetadata?.sourceName === rc.sourceName && obj.renameMetadata?.targetName === rc.targetName) {
        obj.renameMetadata.confirmed = false;
        obj.selected = false;
      }
    }
  }
  renameCandidates.value.splice(index, 1);
  regenerateDeploySql();
}

async function handleExecuteScript() {
  if (!deploySql.value || deploySql.value.startsWith("-- ")) {
    toast(t("diff.noObjectsSelected"), 3000);
    return;
  }
  if (deploySqlMode.value === "rollback" && rollbackCompleteness.value === "incomplete") {
    toast(t("diff.rollbackIncompleteBlocked"), 5000);
    return;
  }

  await handleDeploy();
}

async function executeDeploySql() {
  executing.value = true;
  try {
    const targetConnection = store.getConfig(targetConnectionId.value);
    const failed = await executeWithProductionSqlGuard({
      connection: targetConnection,
      database: targetDatabase.value,
      sql: deploySql.value,
      source: t("production.sourceSchemaDiff"),
      execute: async () => {
        const txLog = await api.executeScriptWith2pc(targetConnectionId.value, targetDatabase.value, [deploySql.value], targetSchema.value, destructiveStatements.value.length > 0);
        return txLog;
      },
    });
    if (failed === undefined) return;
    showDeployTxResult(failed);
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

function showDeployTxResult(txLog: any) {
  deployResult.value = buildDeployTxResult(txLog, t);
  showResultDialog.value = true;
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
    const name = window.prompt(t("diff.saveConfigPrompt"), activeConfig.value.name || t("diff.defaultConfigName"));
    if (name === null) return; // User cancelled
    const configToSave = { ...activeConfig.value, name: name.trim() || t("diff.defaultConfigName") };
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
  if (deploySqlMode.value === "rollback" && rollbackCompleteness.value === "incomplete") {
    toast(t("diff.rollbackIncompleteBlocked"), 5000);
    return;
  }
  showConfirmDialog.value = true;
}

async function onConfirmDeploy() {
  showConfirmDialog.value = false;
  if (deploySqlMode.value === "rollback" && rollbackCompleteness.value === "incomplete") {
    toast(t("diff.rollbackIncompleteBlocked"), 5000);
    return;
  }

  await executeDeploySql();
}

const deployStats = computed(() => {
  const counts = summarizeSchemaDiffOperations(diffObjects.value);
  return {
    create: counts.create,
    modify: counts.modify,
    delete: counts.delete,
    total: selectedSchemaDiffObjects(diffObjects.value).length,
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
    <DialogContent :class="['flex flex-col overflow-hidden', isMaximized ? 'min-w-0' : 'min-w-[800px] resize']" :portal-class="isMaximized ? 'p-0' : undefined" :style="dialogStyle" @interact-outside.prevent @escape-key-down="handleDialogEscape">
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
          @update:field-mappings="handleFieldMappingsUpdate"
          @open-field-mapping="showFieldMappingDialog = true"
        />

        <!-- Compare Loading -->
        <div v-else-if="step === 'compare'" class="flex items-center justify-center py-20">
          <Loader2 class="w-6 h-6 animate-spin mr-2" />
          <span class="text-sm text-muted-foreground">{{ t("diff.comparing") }}</span>
        </div>

        <!-- Result Step -->
        <template v-else-if="step === 'result'">
          <!-- Rename Candidates Panel -->
          <div v-if="renameCandidates.length > 0" class="border-b bg-amber-50 dark:bg-amber-950/20 shrink-0 overflow-hidden">
            <button class="flex items-center gap-2 px-3 py-1.5 w-full text-left text-xs font-medium hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition-colors" @click="showRenamePanel = !showRenamePanel">
              <ChevronDown v-if="showRenamePanel" class="w-3 h-3" />
              <ChevronRight v-else class="w-3 h-3" />
              {{ t("diff.renameCandidates") }}
              <span class="ml-auto text-muted-foreground font-normal">{{ renameCandidates.length }} candidate(s)</span>
            </button>
            <div v-if="showRenamePanel" class="px-3 pb-2 text-xs">
              <table class="w-full">
                <thead>
                  <tr class="text-muted-foreground border-b">
                    <th class="text-left py-1 pr-4">{{ t("diff.sourceTable") }}</th>
                    <th class="text-left py-1 pr-4">{{ t("diff.targetTable") }}</th>
                    <th class="text-left py-1 pr-4">{{ t("diff.similarity") }}</th>
                    <th class="text-left py-1">{{ t("common.action") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(rc, i) in renameCandidates" :key="i" class="border-b border-amber-200/50 dark:border-amber-800/30">
                    <td class="py-1 pr-4 font-mono">{{ rc.sourceName }}</td>
                    <td class="py-1 pr-4 font-mono">{{ rc.targetName }}</td>
                    <td class="py-1 pr-4">
                      <span
                        class="px-1.5 py-0.5 rounded text-[10px] font-medium"
                        :class="rc.score >= 0.8 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : rc.score >= 0.5 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'"
                        >{{ (rc.score * 100).toFixed(0) }}%</span
                      >
                    </td>
                    <td class="py-1">
                      <button class="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary hover:bg-primary/20 transition-colors mr-1" @click="applyRename(rc)">
                        {{ t("diff.confirmRename") }}
                      </button>
                      <button class="text-xs px-2 py-0.5 rounded bg-muted hover:bg-muted/80 transition-colors" @click="ignoreRename(i)">
                        {{ t("diff.ignore") }}
                      </button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

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
              <SchemaDiffDdlPanel
                :selected-object="selectedObject"
                :deploy-sql="deploySql"
                :deploy-sql-all="deploySqlAll"
                :compatibility-warnings="compatibilityWarnings"
                :rollback-sql="rollbackSql"
                :deploy-sql-mode="deploySqlMode"
                :dependency-graph="dependencyGraph"
                :permission-diffs="permissionDiffs"
                :rollback-completeness="rollbackCompleteness"
                :missing-rollback-objects="missingRollbackObjects"
                :can-execute="canExecuteDeploy"
                @update:deploy-sql-mode="switchDeploySqlMode"
                @execute-script="handleExecuteScript"
              />
            </Pane>
          </Splitpanes>
        </template>

        <!-- Deploy Review Step -->
        <template v-else-if="step === 'deploy-review'">
          <SchemaDiffDeployStep
            v-model:deploy-sql="deploySql"
            :selected-objects="diffObjects"
            :target-connection-id="targetConnectionId"
            :target-database="targetDatabase"
            :target-schema="targetSchema"
            :executing="executing"
            :rollback-sql="rollbackSql"
            :deploy-sql-mode="deploySqlMode"
            :compatibility-warnings="compatibilityWarnings"
            :rename-candidates="renameCandidates"
            :rollback-completeness="rollbackCompleteness"
            :missing-rollback-objects="missingRollbackObjects"
            :can-execute="canExecuteDeploy"
            :destructive-statement-count="destructiveStatements.length"
            @update:deploy-sql-mode="switchDeploySqlMode"
            @back="step = 'result'"
            @deploy="handleDeploy"
          />
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

          <div class="py-2 space-y-3 min-w-0">
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

            <div v-if="destructiveStatements.length > 0" class="rounded border border-red-300 bg-red-50 p-3 text-xs text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">
              <div class="font-semibold">{{ t("diff.destructiveSqlDetected", { count: destructiveStatements.length }) }}</div>
              <ul class="mt-2 max-h-32 space-y-1 overflow-auto font-mono">
                <li v-for="(item, index) in destructiveStatements" :key="`${item.objectType}-${index}`" class="truncate" :title="item.statement">{{ item.action.toUpperCase() }} {{ item.objectType }}: {{ item.statement }}</li>
              </ul>
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
              <template v-if="deployResult?.status === 'mixed'">{{ t("diff.deployMixedTitle") }}</template>
              <template v-else-if="deployResult?.status === 'rolled_back'">{{ t("diff.deployRolledBackTitle") }}</template>
              <template v-else>{{ deployResult?.success ? t("diff.deploySuccess") : t("diff.deployFailed") }}</template>
            </DialogTitle>
          </DialogHeader>

          <div class="py-2">
            <div v-if="deployResult?.status === 'mixed'" class="space-y-2">
              <p class="text-sm text-destructive-foreground">{{ deployResult.message }}</p>
              <div class="bg-yellow-50 border border-yellow-300 p-3 rounded text-xs text-yellow-800">
                {{ t("diff.deployMixedWarning") }}
              </div>
            </div>
            <div v-else-if="deployResult?.status === 'rolled_back'" class="space-y-2">
              <p class="text-sm text-destructive-foreground">{{ deployResult.message }}</p>
            </div>
            <div v-else-if="deployResult?.success" class="space-y-2">
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
            <Button variant="ghost" size="sm" @click="showOptionsPanel = false" :aria-label="t('common.close')">✕</Button>
          </div>
          <SchemaDiffOptionsPanel :options="schemaDiffPanelOptions" :option-tree="optionTree" @update:options="handleOptionsUpdate" @close="showOptionsPanel = false" />
        </div>
      </div>

      <!-- Field Mapping Dialog Overlay -->
      <FieldMappingDialog
        :open="showFieldMappingDialog"
        :mappings="activeConfig?.options.fieldMappings ?? []"
        :source-db-type="sourceDbType"
        :target-db-type="targetDbType"
        :source-connection-id="sourceConnectionId"
        :source-database="sourceDatabase"
        :target-connection-id="targetConnectionId"
        :target-database="targetDatabase"
        @update:open="showFieldMappingDialog = $event"
        @save="handleFieldMappingsUpdate"
      />
    </DialogContent>
  </Dialog>
</template>

<style scoped>
:deep(.splitpanes--horizontal > .splitpanes__splitter) {
  height: 8px;
  background: var(--border);
  cursor: row-resize;
}
:deep(.splitpanes--horizontal > .splitpanes__splitter:hover) {
  background: var(--primary);
}
</style>

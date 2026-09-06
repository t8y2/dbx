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
import { loadSchemaDetails } from "@/lib/schema/schemaDiffMetadataLoad";
import { getSchemaDiffNextProgressStep, isSchemaDiffPostgresLike, shouldLoadSchemaDiffExtraObjects, type SchemaDiffProgressPhase } from "@/lib/schema/schemaDiffProgress";
import { createSchemaDiffTableListLoader, type SchemaDiffTableIdentity } from "@/lib/schema/schemaDiffTableList";
import { normalizeSchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { SchemaDiffCompareOptions, SchemaDiffConfig, FieldMappingEntry, SchemaDiffTableMapping } from "@/types/schemaDiff";
import type { DatabaseType, ObjectSourceKind } from "@/types/database";
import {
  convertToSchemaDiffObjects,
  detectDestructiveSchemaDiffStatements,
  groupDiffObjects,
  injectColumnRenameSql,
  schemaDiffDeployTargetSchema,
  findSchemaDiffObject,
  flattenSchemaDiffObjects,
  schemaDiffSelectionTargets,
  selectSchemaDiffInput,
  selectSchemaDiffInputForObject,
  selectedSchemaDiffObjects,
  setSchemaDiffObjectSelected,
  setSchemaDiffObjectSelectedWithDependencies,
  summarizeSchemaDiffOperations,
  databaseTypeToDialectKind,
  normalizeDialectKind,
  type OperationGroup,
  type SchemaDiffObject,
  type DiffOperationType,
  type SchemaDiffPreparation,
  type MissingRollbackObject,
  type RollbackCompleteness,
  type RenameCandidate,
  type CompatibilityWarning,
  type PermissionDiff,
  type DependencyGraph,
  normalizeSchemaDiffDependencyGraph,
} from "@/lib/schema/schemaDiff";
import { compileSchemaDiffTableFilter, filterSchemaDiffTables } from "@/lib/schema/schemaDiffTableFilter";
import { swapSchemaDiffTableMappings } from "@/lib/schema/schemaDiffTableMapping";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const store = useConnectionStore();
const schemaDiffTableListLoader = createSchemaDiffTableListLoader({
  ensureConnected: (connectionId) => store.ensureConnected(connectionId),
  listTables: (connectionId, database, schema) => api.listTables(connectionId, database, schema),
});

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
interface SchemaDiffProgress {
  phase: SchemaDiffProgressPhase;
  current?: number;
  total?: number;
  objectName?: string;
}

const loading = ref(false);
const schemaDiffProgress = ref<SchemaDiffProgress | null>(null);
const schemaDiffHasExtraObjectPhase = ref(false);
let comparisonRequestId = 0;
const diffObjects = ref<SchemaDiffObject[]>([]);
const diffGroups = ref<OperationGroup[]>([]);
const selectedObjectId = ref<string | null>(null);
const focusedDeploySql = ref("");
const focusedForwardDeploySql = ref("");
const focusedRollbackSql = ref("");
const selectedDeploySql = ref("");
const selectedForwardDeploySql = ref("");
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
let selectedDeploySqlGeneration = 0;
let focusedDeploySqlGeneration = 0;

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
  const object = selectedTreeObject.value;
  if (!object) return null;
  return object.parentId ? (findSchemaDiffObject(diffObjects.value, object.parentId) ?? object) : object;
});

const selectedTreeObject = computed(() => {
  if (!selectedObjectId.value) return null;
  for (const group of diffGroups.value) {
    for (const typeGroup of group.typeGroups) {
      const object = flattenSchemaDiffObjects(typeGroup.objects).find((candidate) => candidate.id === selectedObjectId.value);
      if (object) return object;
    }
  }
  return null;
});

const canDeploy = computed(() => {
  return selectedSchemaDiffObjects(diffObjects.value).length > 0;
});

const schemaDiffProgressCount = computed(() => {
  const progress = schemaDiffProgress.value;
  return progress && progress.total !== undefined && progress.total > 0 && progress.current !== undefined ? { current: progress.current, total: progress.total } : null;
});

const schemaDiffProgressPercent = computed(() => {
  const count = schemaDiffProgressCount.value;
  return count ? Math.min(100, Math.round((count.current / count.total) * 100)) : null;
});

const schemaDiffProgressLabel = computed(() => {
  switch (schemaDiffProgress.value?.phase) {
    case "loading-table-lists":
      return t("diff.progress.loadingObjects");
    case "loading-source-details":
      return t("diff.progress.loadingSourceDetails");
    case "loading-target-details":
      return t("diff.progress.loadingTargetDetails");
    case "loading-extra-objects":
      return t("diff.progress.loadingExtraObjects");
    case "comparing":
      return t("diff.progress.comparing");
    case "generating":
      return t("diff.progress.generating");
    default:
      return "";
  }
});

const schemaDiffNextProgressLabel = computed(() => {
  const nextStep = getSchemaDiffNextProgressStep(schemaDiffProgress.value?.phase, schemaDiffHasExtraObjectPhase.value);
  return nextStep ? t("diff.progress.next", { step: t(`diff.progress.${nextStep}`) }) : "";
});

function resetComparisonResultState() {
  comparisonRequestId++;
  selectedDeploySqlGeneration++;
  focusedDeploySqlGeneration++;
  loading.value = false;
  schemaDiffProgress.value = null;
  schemaDiffHasExtraObjectPhase.value = false;
  step.value = "config";
  diffObjects.value = [];
  diffGroups.value = [];
  selectedObjectId.value = null;
  focusedDeploySql.value = "";
  focusedForwardDeploySql.value = "";
  focusedRollbackSql.value = "";
  selectedDeploySql.value = "";
  selectedForwardDeploySql.value = "";
  lastDiffResult.value = null;
  rollbackSql.value = "";
  rollbackCompleteness.value = "complete";
  missingRollbackObjects.value = [];
  renameCandidates.value = [];
  compatibilityWarnings.value = [];
  permissionDiffs.value = [];
  dependencyGraph.value = null;
  deploySqlMode.value = "forward";
  showConfirmDialog.value = false;
  showResultDialog.value = false;
  deployResult.value = null;
}

// Watch for prefilled values
watch(
  () => open.value,
  (isOpen) => {
    if (isOpen) {
      resetComparisonResultState();
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
    } else {
      comparisonRequestId++;
      loading.value = false;
      schemaDiffProgress.value = null;
      schemaDiffHasExtraObjectPhase.value = false;
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

function getDbType(): DatabaseType {
  const targetConfig = store.getConfig(targetConnectionId.value);
  return targetConfig?.db_type || "postgres";
}

function handleSwap() {
  const currentOptions = normalizeSchemaDiffCompareOptions(activeConfig.value?.options, getDbType());
  const swappedMappings = swapSchemaDiffTableMappings(currentOptions.tableMappings ?? []);
  const swappedSelectedTables = Array.isArray(currentOptions.selectedTables) ? swappedMappings.map((mapping) => mapping.sourceTable) : undefined;
  if (activeConfig.value) {
    updateActiveConfigOptions(
      normalizeSchemaDiffCompareOptions(
        {
          ...currentOptions,
          selectedTables: swappedSelectedTables,
          tableMappings: swappedMappings,
        },
        getDbType(),
      ),
    );
  }

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

function handleSelectedTablesUpdate(value?: string[]) {
  if (activeConfig.value) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions({ ...activeConfig.value.options, selectedTables: value }, getDbType()));
  }
}

function handleTableMappingsUpdate(value: SchemaDiffTableMapping[]) {
  if (activeConfig.value) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions({ ...activeConfig.value.options, tableMappings: value }, getDbType()));
  }
}

function handleFieldMappingsUpdate(mappings: FieldMappingEntry[]) {
  if (activeConfig.value) {
    const updated = { ...activeConfig.value.options, fieldMappings: mappings };
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions(updated, getDbType()));
  }
}

async function handleCompare() {
  const requestId = ++comparisonRequestId;
  const isCurrentRequest = () => requestId === comparisonRequestId;

  loading.value = true;
  step.value = "compare";
  schemaDiffProgress.value = { phase: "loading-table-lists" };
  schemaDiffHasExtraObjectPhase.value = false;

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
    const isPostgresLike = isSchemaDiffPostgresLike(dbType);
    const hasExtraObjectPhase = shouldLoadSchemaDiffExtraObjects(dbType, opts);
    schemaDiffHasExtraObjectPhase.value = hasExtraObjectPhase;
    const tableFilter = compileSchemaDiffTableFilter(opts);

    const sourceTableIdentity: SchemaDiffTableIdentity = { connectionId: sourceConnectionId.value, database: sourceDatabase.value, schema: sourceSchema.value };
    const targetTableIdentity: SchemaDiffTableIdentity = { connectionId: targetConnectionId.value, database: targetDatabase.value, schema: targetSchema.value };
    // The dialog can remain open while either database changes, so Compare must not reuse
    // the table list cached while configuring the comparison.
    const [srcTables, tgtTables] = await Promise.all([schemaDiffTableListLoader.load(sourceTableIdentity, { refresh: true }), schemaDiffTableListLoader.load(targetTableIdentity, { refresh: true })]);
    if (!isCurrentRequest()) return;
    // Explicit (visual) table selection is applied here, BEFORE any per-table
    // metadata details are loaded, so metadata requests only happen for the
    // final table set. `undefined`/empty means no restriction (legacy path).
    const { sourceTables, targetTables } = filterSchemaDiffTables(srcTables, tgtTables, tableFilter, opts, opts.selectedTables);

    schemaDiffProgress.value = { phase: "loading-source-details", current: 0, total: sourceTables.length };
    const sourceDetails = await loadSchemaDetails(
      sourceTables,
      {
        connectionId: sourceConnectionId.value,
        database: sourceDatabase.value,
        schema: sourceSchema.value,
        dbType: sourceDbType,
        options: opts,
        onProgress: (progress) => {
          if (isCurrentRequest()) schemaDiffProgress.value = { phase: "loading-source-details", ...progress };
        },
      },
      api,
    );
    if (!isCurrentRequest()) return;

    schemaDiffProgress.value = { phase: "loading-target-details", current: 0, total: targetTables.length };
    const targetDetails = await loadSchemaDetails(
      targetTables,
      {
        connectionId: targetConnectionId.value,
        database: targetDatabase.value,
        schema: targetSchema.value,
        dbType,
        options: opts,
        onProgress: (progress) => {
          if (isCurrentRequest()) schemaDiffProgress.value = { phase: "loading-target-details", ...progress };
        },
      },
      api,
    );
    if (!isCurrentRequest()) return;

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

    if (hasExtraObjectPhase) schemaDiffProgress.value = { phase: "loading-extra-objects" };
    const results = await Promise.all(promises);
    if (!isCurrentRequest()) return;
    let idx = 0;
    const srcFunctions = opts?.functions && isPostgresLike ? results[idx++] : [];
    const tgtFunctions = opts?.functions && isPostgresLike ? results[idx++] : [];
    const srcSequences = opts?.sequences && isPostgresLike ? results[idx++] : [];
    const tgtSequences = opts?.sequences && isPostgresLike ? results[idx++] : [];
    const srcRules = opts?.rules && isPostgresLike ? results[idx++] : [];
    const tgtRules = opts?.rules && isPostgresLike ? results[idx++] : [];
    const srcOwners = opts?.owners && isPostgresLike ? results[idx++] : [];
    const tgtOwners = opts?.owners && isPostgresLike ? results[idx++] : [];

    schemaDiffProgress.value = { phase: "comparing" };
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
      // Mappings only apply to an explicit table selection; the all-tables path
      // (selectedTables === undefined) must stay mapping-free so the Rust side
      // cannot reclassify added/removed tables from stale persisted mappings.
      tableMappings: opts.selectedTables === undefined ? undefined : opts.tableMappings,
      databaseType: dbType,
      targetSchema: schemaDiffDeployTargetSchema(dbType, targetDatabase.value, targetSchema.value),
      ignoreComments: ignoreComments.value,
      cascadeDelete: opts?.cascadeDelete ?? false,
      compareColumnOrder: opts.compareColumnOrder,
      ignoreTableNameCase: opts.ignoreTableNameCase,
      ignoreColumnNameCase: opts.ignoreColumnNameCase,
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
    if (!isCurrentRequest()) return;

    // Extract new result fields
    rollbackSql.value = result.rollbackSyncSql ?? "";
    rollbackCompleteness.value = result.rollbackCompleteness ?? "complete";
    missingRollbackObjects.value = result.missingRollbackObjects ?? [];
    renameCandidates.value = result.renameCandidates ?? [];
    compatibilityWarnings.value = result.compatibilityWarnings ?? [];
    permissionDiffs.value = result.permissionDiffs ?? [];
    dependencyGraph.value = normalizeSchemaDiffDependencyGraph(result.dependencyGraph);

    // Convert to unified objects
    diffObjects.value = convertToSchemaDiffObjects(result.diffs, result.functionDiffs, result.sequenceDiffs, result.ruleDiffs, result.ownerDiffs, result.renameCandidates);

    // Group by operation type and object kind
    diffGroups.value = groupDiffObjects(diffObjects.value);

    // Save the structured result; both script previews are generated from the
    // current selection projection below rather than from the initial full SQL.
    lastDiffResult.value = result;
    deploySqlMode.value = "forward";
    schemaDiffProgress.value = { phase: "generating" };
    await regenerateSelectedDeploySql();
    await regenerateFocusedDeploySql();
    if (!isCurrentRequest()) return;

    schemaDiffProgress.value = null;
    step.value = "result";
  } catch (e: any) {
    if (!isCurrentRequest()) return;
    schemaDiffProgress.value = null;
    schemaDiffHasExtraObjectPhase.value = false;
    toast(e?.message || String(e), 5000);
    step.value = "config";
  } finally {
    if (isCurrentRequest()) loading.value = false;
  }
}

function handleToggleGroup(operationType: DiffOperationType) {
  diffGroups.value = diffGroups.value.map((g) => (g.operationType === operationType ? { ...g, expanded: !g.expanded } : g));
}

function handleToggleGroupSelection(operationType: DiffOperationType, selected: boolean) {
  const group = diffGroups.value.find((candidate) => candidate.operationType === operationType);
  for (const object of group?.typeGroups.flatMap((typeGroup) => typeGroup.objects) ?? []) {
    for (const target of schemaDiffSelectionTargets(object)) {
      updateObjectSelection(target.id, selected);
    }
  }
  rebuildDiffGroups();
  void regenerateSelectedDeploySql();
}

function handleToggleObjectSelection(object: SchemaDiffObject, selected: boolean) {
  let changed = false;
  for (const target of schemaDiffSelectionTargets(object)) {
    changed = updateObjectSelection(target.id, selected) || changed;
  }
  if (!changed) return;
  rebuildDiffGroups();
  void regenerateSelectedDeploySql();
}

function updateObjectSelection(objectId: string, selected: boolean): boolean {
  return lastDiffResult.value ? setSchemaDiffObjectSelectedWithDependencies(diffObjects.value, lastDiffResult.value, objectId, selected) : setSchemaDiffObjectSelected(diffObjects.value, objectId, selected);
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

function buildSchemaSyncPlanOptions(options: SchemaDiffCompareOptions) {
  return {
    databaseType: getDbType(),
    targetSchema: schemaDiffDeployTargetSchema(getDbType(), targetDatabase.value, targetSchema.value),
    cascadeDelete: options.cascadeDelete,
    sourceDialect: options.sourceDialect ? normalizeDialectKind(options.sourceDialect) : sourceDbType.value ? databaseTypeToDialectKind(sourceDbType.value) : undefined,
    fieldMappings: options.fieldMappings,
    enableRollback: options.enableRollback,
  };
}

function formatSchemaSyncPlan(plan: Awaited<ReturnType<typeof api.generateSchemaSyncPlan>>, input: ReturnType<typeof selectSchemaDiffInput>, options: SchemaDiffCompareOptions) {
  let forwardSql = plan.syncSql || "-- No objects selected";
  let nextRollbackSql = plan.rollbackSyncSql ?? "";
  if (options.detectRenames && options.renameThreshold) {
    forwardSql = injectColumnRenameSql(forwardSql, input.diffs, options.renameThreshold);
    if (nextRollbackSql) nextRollbackSql = injectColumnRenameSql(nextRollbackSql, input.diffs, options.renameThreshold, true);
  }
  return { forwardSql, rollbackSql: nextRollbackSql };
}

function clearSelectedDeploySql() {
  selectedForwardDeploySql.value = "";
  selectedDeploySql.value = "";
  rollbackSql.value = "";
  rollbackCompleteness.value = "complete";
  missingRollbackObjects.value = [];
}

async function regenerateSelectedDeploySql() {
  const result = lastDiffResult.value;
  const generation = ++selectedDeploySqlGeneration;
  clearSelectedDeploySql();
  if (!result) {
    return;
  }

  const options = normalizeSchemaDiffCompareOptions(activeConfig.value?.options, getDbType());
  const input = selectSchemaDiffInput(result, diffObjects.value);
  let plan;
  try {
    plan = await api.generateSchemaSyncPlan(input, buildSchemaSyncPlanOptions(options));
  } catch (error: any) {
    if (generation === selectedDeploySqlGeneration) toast(error?.message || String(error), 5000);
    return;
  }
  if (generation !== selectedDeploySqlGeneration) return;

  const formatted = formatSchemaSyncPlan(plan, input, options);
  rollbackCompleteness.value = plan.rollbackCompleteness ?? "complete";
  missingRollbackObjects.value = plan.missingRollbackObjects ?? [];
  selectedForwardDeploySql.value = formatted.forwardSql;
  rollbackSql.value = formatted.rollbackSql;
  selectedDeploySql.value = deploySqlMode.value === "rollback" && formatted.rollbackSql ? formatted.rollbackSql : formatted.forwardSql;
}

async function regenerateFocusedDeploySql(objectId: string | null = selectedObjectId.value) {
  const result = lastDiffResult.value;
  const generation = ++focusedDeploySqlGeneration;
  focusedForwardDeploySql.value = "";
  focusedRollbackSql.value = "";
  focusedDeploySql.value = "";
  if (!result || !objectId || !findSchemaDiffObject(diffObjects.value, objectId)) {
    return;
  }

  const options = normalizeSchemaDiffCompareOptions(activeConfig.value?.options, getDbType());
  const input = selectSchemaDiffInputForObject(result, diffObjects.value, objectId);
  let plan;
  try {
    plan = await api.generateSchemaSyncPlan(input, buildSchemaSyncPlanOptions(options));
  } catch (error: any) {
    if (generation === focusedDeploySqlGeneration && selectedObjectId.value === objectId) toast(error?.message || String(error), 5000);
    return;
  }
  if (generation !== focusedDeploySqlGeneration || selectedObjectId.value !== objectId) return;

  const formatted = formatSchemaSyncPlan(plan, input, options);
  focusedForwardDeploySql.value = formatted.forwardSql;
  focusedRollbackSql.value = formatted.rollbackSql;
  focusedDeploySql.value = deploySqlMode.value === "rollback" && formatted.rollbackSql ? formatted.rollbackSql : formatted.forwardSql;
}

function switchDeploySqlMode(mode: "forward" | "rollback") {
  if (mode === "rollback" && rollbackCompleteness.value === "incomplete") {
    toast(t("diff.rollbackIncompleteBlocked"), 4000);
    return;
  }
  deploySqlMode.value = mode;
  selectedDeploySql.value = mode === "rollback" && rollbackSql.value ? rollbackSql.value : selectedForwardDeploySql.value;
  focusedDeploySql.value = mode === "rollback" && focusedRollbackSql.value ? focusedRollbackSql.value : focusedForwardDeploySql.value;
  if (mode === "rollback" && !rollbackSql.value) {
    void regenerateSelectedDeploySql();
  }
}

const canExecuteDeploy = computed(() => {
  if (deploySqlMode.value === "rollback" && rollbackCompleteness.value === "incomplete") {
    return false;
  }
  const sql = selectedDeploySql.value.trim();
  return sql.length > 0 && sql !== "-- No objects selected";
});

const destructiveStatements = computed(() => {
  const databaseType = store.getConfig(targetConnectionId.value)?.db_type;
  return detectDestructiveSchemaDiffStatements(selectedDeploySql.value, databaseType);
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
    rebuildDiffGroups();
    void regenerateSelectedDeploySql();
    void regenerateFocusedDeploySql();
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
  rebuildDiffGroups();
  void regenerateSelectedDeploySql();
  void regenerateFocusedDeploySql();
}

async function handleExecuteScript() {
  if (!selectedDeploySql.value.trim() || selectedDeploySql.value.trim() === "-- No objects selected") {
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
      sql: selectedDeploySql.value,
      source: t("production.sourceSchemaDiff"),
      execute: async () => {
        const txLog = await api.executeScriptWith2pc(targetConnectionId.value, targetDatabase.value, [selectedDeploySql.value], targetSchema.value, destructiveStatements.value.length > 0);
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
async function handleSelectObject(reviewObject: SchemaDiffObject) {
  selectedObjectId.value = reviewObject.id;
  void regenerateFocusedDeploySql(reviewObject.id);
  const obj = reviewObject.parentId ? (findSchemaDiffObject(diffObjects.value, reviewObject.parentId) ?? reviewObject) : reviewObject;

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
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions(config.options, getDbType()));
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
  const selectedObjects = selectedSchemaDiffObjects(diffObjects.value);
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

const selectedCompatibilityWarnings = computed(() => {
  if (!lastDiffResult.value) return [];
  const input = selectSchemaDiffInput(lastDiffResult.value, diffObjects.value);
  const selectedColumns = new Set(input.diffs.flatMap((diff) => (diff.columns ?? []).map((column) => `${diff.name}\u0000${column.name}`)));
  return compatibilityWarnings.value.filter((warning) => selectedColumns.has(`${warning.table}\u0000${warning.column}`));
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

      <!-- Result step relies on splitpanes to manage its own scroll/heights, so it keeps
           `overflow-hidden`; the config step's tall content (e.g. the table multi-select
           added in the "compare specific tables" feature) can overflow a fixed-height
           dialog, so it must be allowed to scroll vertically instead of being clipped --
           otherwise the Compare button at the bottom becomes unreachable. -->
      <div :class="[step === 'result' ? 'overflow-hidden' : 'overflow-y-auto', 'flex-1 min-h-0 flex flex-col']">
        <!-- Config Step -->
        <SchemaDiffConfigStep
          v-if="step === 'config'"
          class="shrink-0"
          v-model:source-connection-id="sourceConnectionId"
          v-model:source-database="sourceDatabase"
          v-model:source-schema="sourceSchema"
          v-model:target-connection-id="targetConnectionId"
          v-model:target-database="targetDatabase"
          v-model:target-schema="targetSchema"
          v-model:ignore-comments="ignoreComments"
          :configs="configs"
          :active-config-id="activeConfigId"
          :options="schemaDiffPanelOptions"
          :selected-tables="schemaDiffPanelOptions.selectedTables"
          :table-list-loader="schemaDiffTableListLoader"
          :loading="loading"
          :recent-configs="recentConfigs"
          @compare="handleCompare"
          @swap="handleSwap"
          @show-options="showOptionsPanel = true"
          @save-config="handleSaveConfig"
          @load-history-config="handleLoadHistoryConfig"
          @delete-history-config="handleDeleteHistoryConfig"
          @update:field-mappings="handleFieldMappingsUpdate"
          @update:table-mappings="handleTableMappingsUpdate"
          @update:selected-tables="handleSelectedTablesUpdate"
          @open-field-mapping="showFieldMappingDialog = true"
        />

        <!-- Compare Loading -->
        <div v-else-if="step === 'compare'" class="flex items-center justify-center py-20">
          <div class="w-full max-w-md px-6 space-y-3">
            <div class="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 class="w-5 h-5 animate-spin text-primary" />
              <span>{{ schemaDiffProgressLabel }}</span>
            </div>
            <div v-if="schemaDiffProgressCount" class="flex items-center justify-between text-xs tabular-nums text-muted-foreground">
              <span>{{ t("diff.progress.count", schemaDiffProgressCount) }}</span>
              <span>{{ schemaDiffProgressPercent }}%</span>
            </div>
            <div class="h-2 overflow-hidden rounded-full bg-muted" role="progressbar" :aria-label="schemaDiffProgressLabel || t('diff.progress.comparing')">
              <div
                v-if="schemaDiffProgressPercent !== null"
                class="h-full rounded-full bg-primary transition-[width] duration-200"
                :aria-valuemin="0"
                :aria-valuemax="schemaDiffProgressCount?.total"
                :aria-valuenow="schemaDiffProgressCount?.current"
                :style="{ width: `${schemaDiffProgressPercent}%` }"
              />
              <div v-else class="h-full w-full overflow-hidden rounded-full">
                <div class="schema-diff-progress-indeterminate h-full rounded-full bg-primary" />
              </div>
            </div>
            <div v-if="schemaDiffProgress?.objectName" class="truncate text-center text-xs text-muted-foreground" :title="schemaDiffProgress.objectName">{{ schemaDiffProgress.objectName }}</div>
            <div v-if="schemaDiffNextProgressLabel" class="text-center text-xs text-muted-foreground">{{ schemaDiffNextProgressLabel }}</div>
          </div>
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
                <SchemaDiffObjectTree :groups="diffGroups" :selected-object-id="selectedObjectId" @toggle-group="handleToggleGroup" @toggle-group-selection="handleToggleGroupSelection" @toggle-object-selection="handleToggleObjectSelection" @select-object="handleSelectObject" />
              </div>
            </Pane>
            <Pane :size="100 - splitpanesSize" min-size="20">
              <SchemaDiffDdlPanel
                :selected-object="selectedObject"
                :focused-object="selectedTreeObject"
                :deploy-sql="focusedDeploySql"
                :deploy-sql-all="selectedDeploySql"
                :rollback-forward-sql="selectedForwardDeploySql"
                :compatibility-warnings="selectedCompatibilityWarnings"
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
            v-model:deploy-sql="selectedDeploySql"
            :selected-objects="diffObjects"
            :target-connection-id="targetConnectionId"
            :target-database="targetDatabase"
            :target-schema="targetSchema"
            :executing="executing"
            :rollback-sql="rollbackSql"
            :deploy-sql-mode="deploySqlMode"
            :compatibility-warnings="selectedCompatibilityWarnings"
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
.schema-diff-progress-indeterminate {
  width: 42%;
  animation: schema-diff-progress-slide 1.15s ease-in-out infinite;
}

@keyframes schema-diff-progress-slide {
  0% {
    transform: translateX(-110%);
  }
  50% {
    transform: translateX(190%);
  }
  100% {
    transform: translateX(290%);
  }
}

:deep(.splitpanes--horizontal > .splitpanes__splitter) {
  height: 8px;
  background: var(--border);
  cursor: row-resize;
}
:deep(.splitpanes--horizontal > .splitpanes__splitter:hover) {
  background: var(--primary);
}
</style>

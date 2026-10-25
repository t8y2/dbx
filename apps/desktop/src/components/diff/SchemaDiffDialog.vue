<script setup lang="ts">
import { computed, reactive, ref, watch, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { applyDdlTextPreferences } from "@/lib/sql/ddlPreferences";
import DdlStorageToggle from "@/components/objects/DdlStorageToggle.vue";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { useToast } from "@/composables/useToast";
import { GitCompareArrows, ArrowLeft, Play, Loader2, Maximize2, Minimize2, AlertTriangle, CircleCheck, ChevronDown, ChevronRight } from "@lucide/vue";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import { isSchemaAware } from "@/lib/database/databaseCapabilities";
import { supportsDatabaseCompare } from "@/lib/database/databaseCompareCapabilities";
import { useSchemaDiffConfig } from "@/composables/useSchemaDiffConfig";
import SchemaDiffConfigStep from "@/components/diff/SchemaDiffConfigStep.vue";
import SchemaDiffConfigSelector from "@/components/diff/SchemaDiffConfigSelector.vue";
import FieldMappingDialog from "@/components/diff/FieldMappingDialog.vue";
import SchemaDiffObjectTree from "@/components/diff/SchemaDiffObjectTree.vue";
import SchemaDiffRoutineList from "@/components/diff/SchemaDiffRoutineList.vue";
import SchemaDiffDdlPanel from "@/components/diff/SchemaDiffDdlPanel.vue";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";
import SchemaDiffOptionsPanel from "@/components/diff/SchemaDiffOptionsPanel.vue";
import SideBySideTextDiff, { type TextDiffSide } from "@/components/common/SideBySideTextDiff.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { getSchemaDiffOptionsForDbType } from "@/lib/schema/schemaDiffOptions";
import { buildContinueOnErrorDeployLog, buildDeployTxResult, type DeployTxResult } from "@/lib/schema/deployTxResult";
import { getSchemaDiffNextProgressStep, isSchemaDiffPostgresLike, shouldLoadSchemaDiffExtraObjectPhase, type SchemaDiffProgressPhase } from "@/lib/schema/schemaDiffProgress";
import { createSchemaDiffTableListLoader } from "@/lib/schema/schemaDiffTableList";
import { countSchemaDiffActionableObjects, partitionSchemaDiffObjectsByResultTab, swapSchemaDiffRoutineMappings } from "@/lib/schema/schemaDiffRoutine";
import { schemaDiffRoutineObjectTypesIntersection, schemaDiffRoutineProductType } from "@/lib/database/databaseObjectCapabilities";
import { loadObjectSourceWithRoutineFallback } from "@/lib/table/objectSourceLoad";
import { copyToClipboard } from "@/lib/common/clipboard";
import { normalizeSchemaDiffCompareOptions } from "@/types/schemaDiff";
import {
  createOracleRoutineDeployment,
  editOracleRoutineDraft,
  editOraclePackageOptions,
  includeOraclePackageCompanion,
  reviewOraclePackageTargetDraft,
  executeOracleRoutineDeployment,
  observeOracleRoutineDeployment,
  oracleRoutineActiveStep,
  oracleRoutinePlanSql,
  prepareOracleRoutineRecovery,
  refreshOracleRoutineDeployment,
  selectOracleRoutineDraft,
  synchronizeOracleRoutineSelection,
  validateOracleRoutineDeployment,
  canRegenerateOracleRoutineDeployment,
} from "@/lib/schema/oracleRoutineDeploy";
import type { SchemaDiffCompareOptions, SchemaDiffConfig, FieldMappingEntry, SchemaDiffTableMapping, SchemaDiffRoutineMapping, OracleRoutineKind, OracleRoutineIdentity } from "@/types/schemaDiff";
import { getSchemaDiffSession, schemaDiffSessionObjects, startSchemaDiffSession, type SchemaDiffSession } from "@/composables/useSchemaDiffSession";
import type { DatabaseType, ObjectSourceKind } from "@/types/database";
import {
  detectDestructiveSchemaDiffStatements,
  groupDiffObjects,
  injectColumnRenameSql,
  schemaDiffDeployTargetSchema,
  normalizeDialectKind,
  databaseTypeToDialectKind,
  schemaDiffEngineDatabaseType,
  findSchemaDiffObject,
  flattenSchemaDiffObjects,
  schemaDiffSelectionTargets,
  selectSchemaDiffInput,
  selectSchemaDiffInputForObject,
  selectedSchemaDiffObjects,
  setSchemaDiffObjectSelected,
  setSchemaDiffObjectSelectedWithDependencies,
  summarizeSchemaDiffOperations,
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

import { swapSchemaDiffTableMappings } from "@/lib/schema/schemaDiffTableMapping";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

type SchemaDiffResultTab = "tables" | "routines";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const store = useConnectionStore();
const settingsStore = useSettingsStore();
const schemaDiffTableListLoader = createSchemaDiffTableListLoader({
  ensureConnected: (connectionId) => store.ensureConnected(connectionId),
  listTables: (connectionId, database, schema) => api.listTables(connectionId, database, schema),
});

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillSelectedRoutines?: string[];
  prefillResultTab?: "tables" | "routines";
  sessionId?: string | null;
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
const showConfigSelector = ref(false);
const sourceDbType = computed(() => store.getConfig(sourceConnectionId.value)?.db_type ?? "");
const targetDbType = computed(() => store.getConfig(targetConnectionId.value)?.db_type ?? "");
// A JDBC connection stores `jdbc` in db_type while its product lives in the driver
// profile; the diff engine needs the product for clause shapes and view comparison.
const sourceEngineDbType = computed(() => schemaDiffEngineDatabaseType(store.getConfig(sourceConnectionId.value)));
const targetEngineDbType = computed(() => schemaDiffEngineDatabaseType(store.getConfig(targetConnectionId.value)));

// Clear stale field mappings when source and target are the same type
watch([sourceDbType, targetDbType], ([src, tgt]) => {
  if (src && src === tgt && activeConfig.value?.options.fieldMappings?.length) {
    handleFieldMappingsUpdate([]);
  }
});
const optionTree = computed(() => {
  const targetConfig = store.getConfig(targetConnectionId.value);
  const dbType = schemaDiffEngineDatabaseType(targetConfig) || targetConfig?.db_type || "postgres";
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
const activeSessionId = ref<string | null>(props.sessionId ?? null);
let appliedSessionResult: SchemaDiffPreparation | null = null;
let shownSessionError = "";
let componentUnmounted = false;
let suppressTargetIdentityReset = false;
const diffObjects = ref<SchemaDiffObject[]>([]);
const tableDiffGroups = ref<OperationGroup[]>([]);
const routineDiffGroups = ref<OperationGroup[]>([]);
const resultTab = ref<SchemaDiffResultTab>("tables");
const preferredResultTab = ref<SchemaDiffResultTab | null>(null);
const selectedTableObjectId = ref<string | null>(null);
const selectedRoutineObjectId = ref<string | null>(null);
const selectedObjectId = computed({
  get: () => (resultTab.value === "routines" ? selectedRoutineObjectId.value : selectedTableObjectId.value),
  set: (value: string | null) => {
    if (resultTab.value === "routines") selectedRoutineObjectId.value = value;
    else selectedTableObjectId.value = value;
  },
});
const focusedDeploySql = ref("");
const focusedForwardDeploySql = ref("");
const focusedRollbackSql = ref("");
const selectedDeploySql = ref("");
const selectedForwardDeploySql = ref("");
const executing = ref(false);
const lastDiffResult = ref<SchemaDiffPreparation | null>(null);
const targetDbVersion = ref<string | null>(null);
const showResultDialog = ref(false);
const deployResult = ref<DeployTxResult | null>(null);

const partitionedDiffObjects = computed(() => partitionSchemaDiffObjectsByResultTab(diffObjects.value));
const tableDiffObjects = computed(() => partitionedDiffObjects.value.tableObjects);
const routineDiffObjects = computed(() => partitionedDiffObjects.value.routineObjects);
const currentTabDiffObjects = computed(() => (resultTab.value === "routines" ? routineDiffObjects.value : tableDiffObjects.value));
const activeDiffGroups = computed(() => (resultTab.value === "routines" ? routineDiffGroups.value : tableDiffGroups.value));
const tableActionableCount = computed(() => countSchemaDiffActionableObjects(tableDiffObjects.value));
const routineActionableCount = computed(() => countSchemaDiffActionableObjects(routineDiffObjects.value));
const tablesCompareEnabled = computed(() => !!schemaDiffPanelOptions.value.tables);
const routinesCompareEnabled = computed(() => !!schemaDiffPanelOptions.value.functions);
const canEnableRoutinesCompare = computed(
  () => schemaDiffRoutineObjectTypesIntersection(schemaDiffRoutineProductType(sourceDbType.value, sourceEngineDbType.value), schemaDiffRoutineProductType(targetDbType.value, targetEngineDbType.value), schemaDiffPanelOptions.value.routineObjectKinds).length > 0,
);
const effectiveRoutinesEnabled = computed(() => routinesCompareEnabled.value && canEnableRoutinesCompare.value);
const showTableResultTab = computed(() => tablesCompareEnabled.value);
const showRoutineResultTab = computed(() => effectiveRoutinesEnabled.value);
const showResultTabList = computed(() => showTableResultTab.value && showRoutineResultTab.value);
const showNoDifferences = computed(() => showTableResultTab.value && tableDiffObjects.value.length === 0);
const routineInventoriesComplete = computed(() => !!comparisonSession.value?.routineSnapshots?.source?.enumerationComplete && !!comparisonSession.value?.routineSnapshots?.target?.enumerationComplete);
const showRoutineNoDifferences = computed(() => showRoutineResultTab.value && routineDiffObjects.value.length === 0 && (!isOracleRoutineComparison.value || routineInventoriesComplete.value));
const comparisonSession = computed(() => getSchemaDiffSession(activeSessionId.value));
const isOracleRoutineComparison = computed(() => {
  const snapshots = comparisonSession.value?.routineSnapshots;
  return !!snapshots?.source && !!snapshots.target && [snapshots.source.endpoint.databaseType, snapshots.target.endpoint.databaseType].every((type) => type === "oracle" || type === "oceanbase-oracle");
});
const isOracleRoutineDeploy = computed(() => resultTab.value === "routines" && isOracleRoutineComparison.value);
const routineDeployment = computed(() => comparisonSession.value?.routineDeployment);
const routineTargetIsCurrent = computed(() => {
  const snapshots = comparisonSession.value?.routineSnapshots;
  return (
    !!snapshots?.source &&
    !!snapshots.target &&
    snapshots.source.endpoint.connectionId === sourceConnectionId.value &&
    snapshots.source.endpoint.database === sourceDatabase.value &&
    snapshots.source.endpoint.schema === sourceSchema.value &&
    snapshots.target.endpoint.connectionId === targetConnectionId.value &&
    snapshots.target.endpoint.database === targetDatabase.value &&
    snapshots.target.endpoint.schema === targetSchema.value &&
    sourceEngineDbType.value === snapshots.source.endpoint.databaseType &&
    targetEngineDbType.value === snapshots.target.endpoint.databaseType
  );
});
const deployIsBusy = computed(() => executing.value || !!routineDeployment.value?.executing || !!routineDeployment.value?.validating);
const routineReadIssues = computed(() => {
  if (!isOracleRoutineComparison.value) return [];
  return (["source", "target"] as const).flatMap((side) => {
    const snapshot = comparisonSession.value?.routineSnapshots?.[side];
    const selected = selectedObject.value;
    const name = side === "source" ? (selected?.sourceName ?? selected?.name) : (selected?.targetName ?? selected?.name);
    const object = snapshot?.objects.find((object) => object.version.identity.name === name && object.version.identity.kind === selected?.routineType);
    return [...(snapshot?.issues ?? []), ...(object?.issues ?? [])].map((issue) => ({ side, message: issue.message }));
  });
});
const deployEditorSql = computed({
  get: () => {
    if (!isOracleRoutineDeploy.value || !routineDeployment.value) return selectedDeploySql.value;
    const state = routineDeployment.value;
    return state.recoveryPlan ? (oracleRoutineActiveStep(state)?.sql ?? "") : (state.drafts.find((draft) => draft.objectId === state.selectedObjectId)?.sql ?? "");
  },
  set: (sql: string) => {
    if (!isOracleRoutineDeploy.value || !routineDeployment.value) {
      selectedDeploySql.value = sql;
      if (deploySqlMode.value === "rollback") rollbackSql.value = sql;
      else selectedForwardDeploySql.value = sql;
      return;
    }
    if (!routineDeployment.value.recoveryPlan && routineDeployment.value.selectedObjectId) editOracleRoutineDraft(routineDeployment.value, routineDeployment.value.selectedObjectId, sql);
  },
});
let routineConfirmRevision: number | null = null;
let confirmedDeploy: {
  sql: string;
  connectionId: string;
  connection: ReturnType<typeof store.getConfig>;
  connectionFingerprint: string;
  database: string;
  schema: string;
  mode: "forward" | "rollback";
  continueOnError: boolean;
  destructive: boolean;
  completeness: RollbackCompleteness;
} | null = null;

function ensureRoutineDeployment() {
  const session = comparisonSession.value;
  if (!isOracleRoutineComparison.value || !session?.routineSnapshots?.source || !session.routineSnapshots.target) return;
  session.routineDeployment ??= reactive(createOracleRoutineDeployment(session.routineSnapshots.source, session.routineSnapshots.target));
  session.routineDeployment.ddlPreferences ??= { ...tableDdlPreferences.value };
  synchronizeOracleRoutineSelection(session.routineDeployment, routineDiffObjects.value);
  return session.routineDeployment;
}

function leaveDeployReview() {
  const state = routineDeployment.value;
  if (state) {
    state.stopRequested = true;
    state.reviewOpen = false;
  }
  step.value = "result";
}

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
const selectedRawPlan = ref<ReturnType<typeof formatSchemaSyncPlan> | null>(null);
const focusedRawPlan = ref<ReturnType<typeof formatSchemaSyncPlan> | null>(null);
const focusedPlanObjectId = ref<string | null>(null);
const focusedPlanError = ref("");
const generatedForwardSql = ref("");
const generatedRollbackSql = ref("");
const selectedPlanCurrent = ref(false);
const selectedGenerationIssues = computed(() => selectedRawPlan.value?.generationIssues.filter((issue) => issue.direction === deploySqlMode.value) ?? []);
const focusedGenerationIssues = computed(() => focusedRawPlan.value?.generationIssues.filter((issue) => issue.direction === deploySqlMode.value) ?? []);
const tableDdlPreferences = ref({
  includeDdlStorage: settingsStore.editorSettings.includeDdlStorage,
  compactDdlSql: settingsStore.editorSettings.compactDdlSql,
  separateDdlIndexes: settingsStore.editorSettings.separateDdlIndexes,
});
const ddlPreferences = computed({
  get: () => (isOracleRoutineDeploy.value ? routineDeployment.value?.ddlPreferences : undefined) ?? tableDdlPreferences.value,
  set: (preferences) => {
    if (isOracleRoutineDeploy.value && routineDeployment.value) routineDeployment.value.ddlPreferences = preferences;
    else tableDdlPreferences.value = preferences;
  },
});
const routineDdlOptionsLocked = computed(() => {
  const state = routineDeployment.value;
  return isOracleRoutineDeploy.value && !!state && (!!state.plan || !!state.recoveryPlan || state.drafts.some((draft) => draft.included && draft.sql !== undefined)) && !canRegenerateOracleRoutineDeployment(state);
});
const deploySqlDirty = computed(() => !!selectedRawPlan.value && (selectedForwardDeploySql.value !== generatedForwardSql.value || rollbackSql.value !== generatedRollbackSql.value));

function confirmDiscardDeployEdits(): boolean {
  return !deploySqlDirty.value || window.confirm(t("objects.refreshDiscardConfirm"));
}

function renderSelectedPlan() {
  if (!selectedRawPlan.value) return;
  const type = targetEngineDbType.value ?? getDbType();
  generatedForwardSql.value = applyDdlTextPreferences(selectedRawPlan.value.forwardSql, type, ddlPreferences.value);
  generatedRollbackSql.value = applyDdlTextPreferences(selectedRawPlan.value.rollbackSql, type, ddlPreferences.value);
  selectedForwardDeploySql.value = generatedForwardSql.value;
  rollbackSql.value = generatedRollbackSql.value;
  selectedDeploySql.value = deploySqlMode.value === "rollback" ? rollbackSql.value : selectedForwardDeploySql.value;
}

function renderFocusedPlan() {
  if (!focusedRawPlan.value) return;
  const type = targetEngineDbType.value ?? getDbType();
  focusedForwardDeploySql.value = applyDdlTextPreferences(focusedRawPlan.value.forwardSql, type, ddlPreferences.value);
  focusedRollbackSql.value = applyDdlTextPreferences(focusedRawPlan.value.rollbackSql, type, ddlPreferences.value);
  focusedDeploySql.value = deploySqlMode.value === "rollback" ? focusedRollbackSql.value : focusedForwardDeploySql.value;
}

const independentPreview = ref<{ objectId: string; source?: string; target?: string; issues: string[]; loading: boolean } | null>(null);
let independentPreviewGeneration = 0;
const displayedSelectedObject = computed(() => {
  const object = selectedObject.value;
  if (!object) return null;
  return {
    ...object,
    sourceDdl: applyDdlTextPreferences((independentPreview.value?.objectId === object.id ? independentPreview.value.source : undefined) ?? object.sourceDdl ?? "", sourceEngineDbType.value ?? getDbType(), ddlPreferences.value),
    targetDdl: applyDdlTextPreferences((independentPreview.value?.objectId === object.id ? independentPreview.value.target : undefined) ?? object.targetDdl ?? "", targetEngineDbType.value ?? getDbType(), ddlPreferences.value),
  };
});

watch([() => settingsStore.editorSettings.includeDdlStorage, () => settingsStore.editorSettings.compactDdlSql, () => settingsStore.editorSettings.separateDdlIndexes, deploySqlDirty, showConfirmDialog, deployIsBusy, isOracleRoutineDeploy], ([include, compact, separate, dirty, confirming, busy]) => {
  if ((dirty && !isOracleRoutineDeploy.value) || confirming || busy || routineDdlOptionsLocked.value) return;
  const indexesChanged = ddlPreferences.value.separateDdlIndexes !== separate;
  const compactChanged = ddlPreferences.value.compactDdlSql !== compact;
  ddlPreferences.value = { includeDdlStorage: include, compactDdlSql: compact, separateDdlIndexes: separate };
  if (isOracleRoutineDeploy.value) {
    const state = routineDeployment.value;
    if (compactChanged && state && canRegenerateOracleRoutineDeployment(state)) void validateOracleRoutineDeployment(state, undefined, { compactSql: compact, regenerateGenerated: true });
    return;
  }
  if (indexesChanged) {
    void regenerateSelectedDeploySql();
    void regenerateFocusedDeploySql();
    return;
  }
  renderSelectedPlan();
  renderFocusedPlan();
});

// Deploy review: bracket the deploy script with MySQL's FOREIGN_KEY_CHECKS toggle.
// Only MySQL honours the session variable, so the option is offered — and sent to
// the backend — for MySQL targets alone; the backend re-checks the target type and
// returns every other engine's script unchanged.
const ignoreForeignKeyChecks = ref(false);
const continueOnError = ref(false);
const isMysqlDeployTarget = computed(() => targetEngineDbType.value === "mysql");
const effectiveIgnoreForeignKeyChecks = computed(() => ignoreForeignKeyChecks.value && isMysqlDeployTarget.value);

// Ticking the box rewrites the script through the plan generator, so the header
// and trailer come from the same backend implementation the copy, export and
// deploy paths all read from, and unticking restores the plain script.
watch(ignoreForeignKeyChecks, () => {
  if (step.value !== "deploy-review" || !lastDiffResult.value) return;
  void regenerateSelectedDeploySql();
});

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
      width: parseFloat(savedSize?.width) > 0 ? savedSize.width : "1100px",
      height: parseFloat(savedSize?.height) > 0 ? savedSize.height : "820px",
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
  if (showConfigSelector.value) {
    event.preventDefault();
    showConfigSelector.value = false;
    return;
  }
  if (!showOptionsPanel.value) return;

  event.preventDefault();
  showOptionsPanel.value = false;
}

let resizeObserver: ResizeObserver | null = null;
let saveTimeout: number | null = null;

function setupResizeObserver() {
  if (componentUnmounted) return;
  const el = document.querySelector('[data-slot="dialog-content"]') as HTMLElement;
  if (!el) return;

  resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) continue;
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
      setTimeout(() => {
        if (!componentUnmounted) setupResizeObserver();
      }, 100);
    } else {
      teardownResizeObserver();
    }
  },
);

onBeforeUnmount(() => {
  componentUnmounted = true;
  if (routineDeployment.value) routineDeployment.value.stopRequested = true;
  teardownResizeObserver();
});

// Config management
const { configs, activeConfigId, activeConfig, recentConfigs, ensureDefaultConfig, createConfig, updateConfig, renameConfig, deleteConfig, duplicateConfig, importConfigs, updateActiveConfigConnection, updateActiveConfigOptions, saveToHistory, deleteFromHistory } = useSchemaDiffConfig();
const schemaDiffPanelOptions = computed(() => normalizeSchemaDiffCompareOptions(activeConfig.value?.options, getDbType()));

const selectedObject = computed(() => {
  const object = selectedTreeObject.value;
  if (!object) return null;
  return object.parentId ? (findSchemaDiffObject(diffObjects.value, object.parentId) ?? object) : object;
});

const selectedTreeObject = computed(() => {
  if (!selectedObjectId.value) return null;
  for (const group of activeDiffGroups.value) {
    for (const typeGroup of group.typeGroups) {
      const object = flattenSchemaDiffObjects(typeGroup.objects).find((candidate) => candidate.id === selectedObjectId.value);
      if (object) return object;
    }
  }
  return findSchemaDiffObject(diffObjects.value, selectedObjectId.value);
});

const canDeployRoutines = computed(() => {
  if (!isOracleRoutineComparison.value) return isSchemaDiffPostgresLike(targetDbType.value);
  if (!routineTargetIsCurrent.value) return false;
  const snapshots = comparisonSession.value!.routineSnapshots!;
  if (snapshots.source!.endpoint.databaseType === snapshots.target!.endpoint.databaseType) return true;
  const kinds = comparisonSession.value!.config.options.routineObjectKinds;
  return !!kinds?.length && kinds.every((kind) => kind === "PACKAGE" || kind === "PACKAGE_BODY") && routineDiffObjects.value.every((object) => object.routineType === "PACKAGE" || object.routineType === "PACKAGE_BODY");
});
watch([selectedObject, () => ddlPreferences.value.separateDdlIndexes, sourceConnectionId, sourceDatabase, sourceSchema, targetConnectionId, targetDatabase, targetSchema, sourceEngineDbType, targetEngineDbType, () => open.value], async () => {
  const generation = ++independentPreviewGeneration;
  independentPreview.value = null;
  const object = selectedObject.value;
  if (!open.value || !ddlPreferences.value.separateDdlIndexes || object?.objectKind !== "table") return;
  const diff = lastDiffResult.value?.diffs.find((diff) => diff.name === object.name);
  if (!diff) return;
  const sides = [
    { side: "source" as const, exists: diff.type !== "removed", type: sourceEngineDbType.value, connectionId: sourceConnectionId.value, database: sourceDatabase.value, schema: sourceSchema.value, tableName: diff.name },
    { side: "target" as const, exists: diff.type !== "added", type: targetEngineDbType.value, connectionId: targetConnectionId.value, database: targetDatabase.value, schema: targetSchema.value, tableName: diff.targetName ?? diff.name },
  ].filter((side) => side.exists && (side.type === "oracle" || side.type === "oceanbase-oracle"));
  if (!sides.length) return;
  independentPreview.value = { objectId: object.id, issues: [], loading: true };
  const results = await Promise.all(
    sides.map(async (side) => {
      try {
        const { ddl } = await loadObjectDdl({ connectionId: side.connectionId, queryTimeoutSecs: store.getConfig(side.connectionId)?.query_timeout_secs, database: side.database, schema: side.schema, tableName: side.tableName, separateIndexes: true });
        return { side: side.side, ddl, issue: undefined };
      } catch (error: any) {
        return { side: side.side, ddl: undefined, issue: `${t(side.side === "source" ? "diff.sourceDdl" : "diff.targetDdl")} ${side.schema}.${side.tableName}: ${error?.message || String(error)}` };
      }
    }),
  );
  if (componentUnmounted || generation !== independentPreviewGeneration || !open.value) return;
  independentPreview.value = { objectId: object.id, source: results.find((result) => result.side === "source")?.ddl, target: results.find((result) => result.side === "target")?.ddl, issues: results.flatMap((result) => (result.issue ? [result.issue] : [])), loading: false };
});

const canDeploy = computed(() => {
  // MySQL/SQL Server routine sync is deferred (copy DDL only). Postgres-family
  // already has function DDL templates, so keep deploy on the routines tab.
  if (resultTab.value === "routines" && !canDeployRoutines.value) return false;
  return selectedSchemaDiffObjects(currentTabDiffObjects.value).length > 0;
});

const showRoutineDeployDeferredHint = computed(() => step.value === "result" && resultTab.value === "routines" && !canDeployRoutines.value);

const deployButtonLabel = computed(() => (resultTab.value === "routines" ? t("diff.nextStepDeployRoutines") : t("diff.nextStepDeploy")));

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
  selectedRawPlan.value = null;
  focusedRawPlan.value = null;
  focusedPlanObjectId.value = null;
  focusedPlanError.value = "";
  selectedDeploySqlGeneration++;
  focusedDeploySqlGeneration++;
  loading.value = false;
  schemaDiffProgress.value = null;
  schemaDiffHasExtraObjectPhase.value = false;
  step.value = "config";
  diffObjects.value = [];
  tableDiffGroups.value = [];
  routineDiffGroups.value = [];
  resultTab.value = "tables";
  selectedTableObjectId.value = null;
  selectedRoutineObjectId.value = null;
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
  ignoreForeignKeyChecks.value = false;
  continueOnError.value = false;
  showConfirmDialog.value = false;
  showResultDialog.value = false;
  deployResult.value = null;
}

function comparisonEndpointLabel(connectionId: string, database: string, schema: string): string {
  const connection = store.getConfig(connectionId);
  return [connection?.name || connectionId, database, schema].filter(Boolean).join(" / ");
}

function restoreSchemaDiffSession(session: SchemaDiffSession): void {
  const config = session.config;
  runWithoutTargetIdentityReset(() => {
    sourceConnectionId.value = config.sourceConnectionId;
    sourceDatabase.value = config.sourceDatabase;
    sourceSchema.value = config.sourceSchema;
    targetConnectionId.value = config.targetConnectionId;
    targetDatabase.value = config.targetDatabase;
    targetSchema.value = config.targetSchema;
  });
  ignoreComments.value = config.ignoreComments;
  ensureDefaultConfig(config.targetDbType);
  updateActiveConfigConnection({
    sourceConnectionId: config.sourceConnectionId,
    sourceDatabase: config.sourceDatabase,
    sourceSchema: config.sourceSchema,
    targetConnectionId: config.targetConnectionId,
    targetDatabase: config.targetDatabase,
    targetSchema: config.targetSchema,
  });
  updateActiveConfigOptions(config.options);
  schemaDiffHasExtraObjectPhase.value = shouldLoadSchemaDiffExtraObjectPhase(schemaDiffRoutineProductType(config.sourceDbType, config.sourceEngineDbType), schemaDiffRoutineProductType(config.targetDbType, config.targetEngineDbType), config.options);
}

function applySchemaDiffSession(session: SchemaDiffSession | undefined): void {
  if (!session) return;
  schemaDiffHasExtraObjectPhase.value = shouldLoadSchemaDiffExtraObjectPhase(schemaDiffRoutineProductType(session.config.sourceDbType, session.config.sourceEngineDbType), schemaDiffRoutineProductType(session.config.targetDbType, session.config.targetEngineDbType), session.config.options);
  if (session.status === "running") {
    loading.value = true;
    step.value = "compare";
    schemaDiffProgress.value = session.progress ?? { phase: "loading-table-lists" };
    return;
  }

  loading.value = false;
  schemaDiffProgress.value = null;
  if (session.status === "failed") {
    step.value = "config";
    if (session.error && shownSessionError !== session.error) {
      shownSessionError = session.error;
      toast(session.error, 5000);
    }
    return;
  }
  if (!session.result) return;

  step.value = "result";
  if (appliedSessionResult === session.result) return;
  appliedSessionResult = session.result;
  rollbackSql.value = session.result.rollbackSyncSql ?? "";
  rollbackCompleteness.value = session.result.rollbackCompleteness ?? "complete";
  missingRollbackObjects.value = session.result.missingRollbackObjects ?? [];
  renameCandidates.value = session.result.renameCandidates ?? [];
  compatibilityWarnings.value = session.result.compatibilityWarnings ?? [];
  permissionDiffs.value = session.result.permissionDiffs ?? [];
  dependencyGraph.value = normalizeSchemaDiffDependencyGraph(session.result.dependencyGraph);
  diffObjects.value = schemaDiffSessionObjects(session.result, session.routineDeployment);
  if (session.routineDeployment) {
    for (const object of diffObjects.value) {
      const saved = session.routineDeployment.drafts.find((draft) => draft.objectId === object.id);
      if (saved) object.selected = saved.included;
    }
  }
  rebuildDiffGroups();
  const hasTableActions = showTableResultTab.value && countSchemaDiffActionableObjects(tableDiffObjects.value) > 0;
  const hasRoutineActions = showRoutineResultTab.value && countSchemaDiffActionableObjects(routineDiffObjects.value) > 0;
  if (!showTableResultTab.value && showRoutineResultTab.value) {
    resultTab.value = "routines";
    preferredResultTab.value = null;
  } else if (showTableResultTab.value && !showRoutineResultTab.value) {
    resultTab.value = "tables";
    preferredResultTab.value = null;
  } else if (preferredResultTab.value === "routines" && showRoutineResultTab.value) {
    resultTab.value = "routines";
    preferredResultTab.value = null;
  } else if (preferredResultTab.value) {
    resultTab.value = "tables";
    preferredResultTab.value = null;
  } else {
    resultTab.value = !hasTableActions && hasRoutineActions ? "routines" : "tables";
  }
  selectedTableObjectId.value = null;
  selectedRoutineObjectId.value = null;
  lastDiffResult.value = session.result;
  deploySqlMode.value = "forward";
  void regenerateSelectedDeploySql();
  void regenerateFocusedDeploySql();
  if (session.routineDeployment?.reviewOpen) step.value = "deploy-review";
}

// A Compare session deliberately outlives this v-if-mounted dialog. Closing the
// dialog only removes the view; the session runner keeps updating its task.
watch(
  [() => open.value, () => props.sessionId],
  ([isOpen]) => {
    if (!isOpen) {
      if (routineDeployment.value) routineDeployment.value.stopRequested = true;
      return;
    }
    const session = getSchemaDiffSession(props.sessionId);
    activeSessionId.value = session?.id ?? null;
    appliedSessionResult = null;
    shownSessionError = "";
    resetComparisonResultState();
    if (session) {
      restoreSchemaDiffSession(session);
      applySchemaDiffSession(session);
      return;
    }

    ensureDefaultConfig();
    if (props.prefillConnectionId) {
      sourceConnectionId.value = props.prefillConnectionId;
      if (props.prefillDatabase) sourceDatabase.value = props.prefillDatabase;
      if (props.prefillSchema) sourceSchema.value = props.prefillSchema;
    }
    if (props.prefillSelectedRoutines?.length) {
      handleCompareScopeUpdate({ functions: true });
      handleSelectedRoutinesUpdate([...props.prefillSelectedRoutines]);
    }
    preferredResultTab.value = props.prefillResultTab ?? null;
    if (props.prefillResultTab) {
      resultTab.value = props.prefillResultTab;
    }
  },
  { immediate: true },
);

watch(
  () => {
    const session = getSchemaDiffSession(activeSessionId.value);
    return [session?.status, session?.progress, session?.result, session?.error] as const;
  },
  () => applySchemaDiffSession(getSchemaDiffSession(activeSessionId.value)),
);

let restoringResultTab = false;
watch(resultTab, (_tab, previous) => {
  if (restoringResultTab) {
    restoringResultTab = false;
    return;
  }
  if (step.value !== "result") return;
  if (!confirmDiscardDeployEdits()) {
    restoringResultTab = true;
    resultTab.value = previous;
    return;
  }
  void regenerateSelectedDeploySql();
  void regenerateFocusedDeploySql();
});

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

function runWithoutTargetIdentityReset(action: () => void): void {
  suppressTargetIdentityReset = true;
  try {
    action();
  } finally {
    void nextTick(() => {
      suppressTargetIdentityReset = false;
    });
  }
}

watch([sourceConnectionId, sourceDatabase, sourceSchema, targetConnectionId, targetDatabase, targetSchema], () => {
  if (!suppressTargetIdentityReset && routineDeployment.value) routineDeployment.value.stopRequested = true;
});

function handleSourceConnectionChange(connectionId: string): void {
  if (connectionId === sourceConnectionId.value) return;
  sourceConnectionId.value = connectionId;
  sourceDatabase.value = "";
  sourceSchema.value = "";
  clearCompareObjectSelection();
}

function clearCompareObjectSelection(): void {
  if (!activeConfig.value) return;
  updateActiveConfigOptions(
    normalizeSchemaDiffCompareOptions(
      {
        ...activeConfig.value.options,
        selectedTables: undefined,
        selectedRoutines: undefined,
        tableMappings: [],
        routineMappings: [],
      },
      getDbType(),
    ),
  );
}

// Switching target must drop stale schema (Oracle→MySQL) and object selection/mappings.
watch(targetConnectionId, (connId, previousConnId) => {
  if (suppressTargetIdentityReset) return;
  if (connId === previousConnId) return;
  targetDatabase.value = "";
  targetSchema.value = "";
  clearCompareObjectSelection();
});

watch(targetDatabase, (database, previousDatabase) => {
  if (suppressTargetIdentityReset) return;
  if (database === previousDatabase) return;
  targetSchema.value = "";
  clearCompareObjectSelection();
});

watch(targetDbType, (dbType, previousDbType) => {
  if (suppressTargetIdentityReset) return;
  if (!isSchemaAware(dbType as DatabaseType) && targetSchema.value) {
    targetSchema.value = "";
  }
  if (previousDbType && dbType && previousDbType !== dbType) {
    clearCompareObjectSelection();
  }
});

// Auto-fetch target database version when connection/database changes
watch(
  () => [targetConnectionId.value, targetDatabase.value, targetSchema.value, targetDbType.value] as const,
  async ([connId, db, schema, dbType]) => {
    if (connId && db) {
      const effectiveSchema = isSchemaAware(dbType as DatabaseType) ? schema : "";
      await fetchDbVersion(connId, db, effectiveSchema);
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
  const swappedRoutineMappings = swapSchemaDiffRoutineMappings(currentOptions.routineMappings ?? []);
  const swappedSelectedRoutines = Array.isArray(currentOptions.selectedRoutines) ? swappedRoutineMappings.map((mapping) => mapping.sourceRoutine) : undefined;
  if (activeConfig.value) {
    updateActiveConfigOptions(
      normalizeSchemaDiffCompareOptions(
        {
          ...currentOptions,
          selectedTables: swappedSelectedTables,
          tableMappings: swappedMappings,
          selectedRoutines: swappedSelectedRoutines,
          routineMappings: swappedRoutineMappings,
        },
        getDbType(),
      ),
    );
  }

  runWithoutTargetIdentityReset(() => {
    const tempConn = sourceConnectionId.value;
    const tempDb = sourceDatabase.value;
    const tempSchema = sourceSchema.value;
    sourceConnectionId.value = targetConnectionId.value;
    sourceDatabase.value = targetDatabase.value;
    sourceSchema.value = targetSchema.value;
    targetConnectionId.value = tempConn;
    targetDatabase.value = tempDb;
    targetSchema.value = tempSchema;
  });
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

function handleSelectedRoutinesUpdate(value?: string[]) {
  if (activeConfig.value) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions({ ...activeConfig.value.options, selectedRoutines: value }, getDbType()));
  }
}

function handleRoutineSelectionUpdate(value: { objectKinds: OracleRoutineKind[]; selectedObjects?: Pick<OracleRoutineIdentity, "name" | "kind">[] }) {
  if (activeConfig.value) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions({ ...activeConfig.value.options, routineObjectKinds: value.objectKinds, selectedRoutineObjects: value.selectedObjects, selectedRoutines: undefined, routineMappings: [] }, getDbType()));
  }
}

function handleCompareScopeUpdate(value: { tables?: boolean; views?: boolean; functions?: boolean }) {
  if (activeConfig.value) {
    const next = { ...activeConfig.value.options, ...value };
    if (value.tables === false) next.views = false;
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions(next, getDbType()));
  }
}

function handleTableMappingsUpdate(value: SchemaDiffTableMapping[]) {
  if (activeConfig.value) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions({ ...activeConfig.value.options, tableMappings: value }, getDbType()));
  }
}

function handleRoutineMappingsUpdate(value: SchemaDiffRoutineMapping[]) {
  if (activeConfig.value) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions({ ...activeConfig.value.options, routineMappings: value }, getDbType()));
  }
}

function handleFieldMappingsUpdate(mappings: FieldMappingEntry[]) {
  if (activeConfig.value) {
    const updated = { ...activeConfig.value.options, fieldMappings: mappings };
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions(updated, getDbType()));
  }
}

function handleCompare(): void {
  if (!confirmDiscardDeployEdits()) return;
  const sourceConfig = store.getConfig(sourceConnectionId.value);
  const targetConfig = store.getConfig(targetConnectionId.value);
  if (!supportsDatabaseCompare(sourceConfig, "schema") || !supportsDatabaseCompare(targetConfig, "schema")) return;
  const targetDbType = (targetConfig?.db_type || "mysql") as DatabaseType;
  const sourceDbType = sourceConfig?.db_type || targetDbType;
  const options = normalizeSchemaDiffCompareOptions(activeConfig.value?.options, targetDbType);

  appliedSessionResult = null;
  shownSessionError = "";
  resetComparisonResultState();
  schemaDiffHasExtraObjectPhase.value = shouldLoadSchemaDiffExtraObjectPhase(schemaDiffRoutineProductType(sourceDbType, sourceEngineDbType.value), schemaDiffRoutineProductType(targetDbType, targetEngineDbType.value), options);
  const session = startSchemaDiffSession(
    {
      sourceConnectionId: sourceConnectionId.value,
      sourceDatabase: sourceDatabase.value,
      sourceSchema: sourceSchema.value,
      targetConnectionId: targetConnectionId.value,
      targetDatabase: targetDatabase.value,
      targetSchema: targetSchema.value,
      sourceDbType,
      targetDbType,
      sourceEngineDbType: sourceEngineDbType.value,
      targetEngineDbType: targetEngineDbType.value,
      options,
      ignoreComments: ignoreComments.value,
      label: `${comparisonEndpointLabel(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value)} → ${comparisonEndpointLabel(targetConnectionId.value, targetDatabase.value, targetSchema.value)}`,
    },
    { tableListLoader: schemaDiffTableListLoader },
  );
  activeSessionId.value = session.id;
  applySchemaDiffSession(session);
}

function handleToggleGroup(operationType: DiffOperationType) {
  const groups = resultTab.value === "routines" ? routineDiffGroups : tableDiffGroups;
  groups.value = groups.value.map((g) => (g.operationType === operationType ? { ...g, expanded: !g.expanded } : g));
}

function handleToggleGroupSelection(operationType: DiffOperationType, selected: boolean) {
  if (!confirmDiscardDeployEdits()) return;
  const group = activeDiffGroups.value.find((candidate) => candidate.operationType === operationType);
  for (const object of group?.typeGroups.flatMap((typeGroup) => typeGroup.objects) ?? []) {
    for (const target of schemaDiffSelectionTargets(object)) {
      updateObjectSelection(target.id, selected);
    }
  }
  rebuildDiffGroups();
  void regenerateSelectedDeploySql();
}

function handleToggleObjectSelection(object: SchemaDiffObject, selected: boolean) {
  if (!confirmDiscardDeployEdits()) return;
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
  const preserveExpanded = (groups: OperationGroup[], objects: SchemaDiffObject[]) => {
    const expanded = new Map(groups.map((group) => [group.operationType, group.expanded]));
    const typeExpanded = new Map(groups.flatMap((group) => group.typeGroups.map((typeGroup) => [`${group.operationType}:${typeGroup.kind}`, typeGroup.expanded] as const)));
    return groupDiffObjects(objects).map((group) => ({
      ...group,
      expanded: expanded.get(group.operationType) ?? group.expanded,
      typeGroups: group.typeGroups.map((typeGroup) => ({
        ...typeGroup,
        expanded: typeExpanded.get(`${group.operationType}:${typeGroup.kind}`) ?? typeGroup.expanded,
      })),
    }));
  };

  const { tableObjects, routineObjects } = partitionSchemaDiffObjectsByResultTab(diffObjects.value);
  tableDiffGroups.value = preserveExpanded(tableDiffGroups.value, tableObjects);
  routineDiffGroups.value = preserveExpanded(routineDiffGroups.value, routineObjects);
}

function buildSchemaSyncPlanOptions(options: SchemaDiffCompareOptions) {
  const engineDbType = targetEngineDbType.value ?? getDbType();
  return {
    databaseType: engineDbType,
    targetSchema: schemaDiffDeployTargetSchema(getDbType(), targetDatabase.value, targetSchema.value),
    cascadeDelete: options.cascadeDelete,
    sourceDialect: options.sourceDialect ? normalizeDialectKind(options.sourceDialect) : sourceEngineDbType.value ? databaseTypeToDialectKind(sourceEngineDbType.value) : undefined,
    fieldMappings: options.fieldMappings,
    enableRollback: options.enableRollback,
    ignoreForeignKeyChecks: effectiveIgnoreForeignKeyChecks.value,
    ...(ddlPreferences.value.separateDdlIndexes && (engineDbType === "oracle" || engineDbType === "oceanbase-oracle")
      ? {
          oracleDdl: {
            separateIndexes: true,
            source: { connectionId: sourceConnectionId.value, database: sourceDatabase.value, schema: sourceSchema.value },
            target: { connectionId: targetConnectionId.value, database: targetDatabase.value, schema: targetSchema.value },
            tableMappings: comparisonSession.value?.config.options.tableMappings?.map((mapping) => ({ ...mapping })),
          },
        }
      : {}),
  };
}

function formatSchemaSyncPlan(plan: Awaited<ReturnType<typeof api.generateSchemaSyncPlan>>, input: ReturnType<typeof selectSchemaDiffInput>, options: SchemaDiffCompareOptions) {
  let forwardSql = plan.syncSql || "-- No objects selected";
  let nextRollbackSql = plan.rollbackSyncSql ?? "";
  if (options.detectRenames && options.renameThreshold) {
    forwardSql = injectColumnRenameSql(forwardSql, input.diffs, options.renameThreshold);
    if (nextRollbackSql) nextRollbackSql = injectColumnRenameSql(nextRollbackSql, input.diffs, options.renameThreshold, true);
  }
  return { forwardSql, rollbackSql: nextRollbackSql, forwardCompleteness: plan.forwardCompleteness ?? "complete", rollbackCompleteness: plan.rollbackCompleteness ?? "complete", generationIssues: plan.generationIssues ?? [] };
}

function clearSelectedDeploySql() {
  selectedPlanCurrent.value = false;
  selectedRawPlan.value = null;
  selectedForwardDeploySql.value = "";
  selectedDeploySql.value = "";
  rollbackSql.value = "";
  rollbackCompleteness.value = "complete";
  missingRollbackObjects.value = [];
}

async function regenerateSelectedDeploySql() {
  const result = lastDiffResult.value;
  const generation = ++selectedDeploySqlGeneration;
  selectedPlanCurrent.value = false;
  if (!result) {
    clearSelectedDeploySql();
    return;
  }
  if (isOracleRoutineDeploy.value) {
    ensureRoutineDeployment();
    return;
  }

  const options = normalizeSchemaDiffCompareOptions(activeConfig.value?.options, getDbType());
  const input = selectSchemaDiffInput(result, currentTabDiffObjects.value);
  let plan;
  try {
    plan = await api.generateSchemaSyncPlan(input, buildSchemaSyncPlanOptions(options));
  } catch (error: any) {
    if (!componentUnmounted && generation === selectedDeploySqlGeneration) toast(error?.message || String(error), 5000);
    return;
  }
  if (componentUnmounted || generation !== selectedDeploySqlGeneration) return;

  const formatted = formatSchemaSyncPlan(plan, input, options);
  rollbackCompleteness.value = plan.rollbackCompleteness ?? "complete";
  missingRollbackObjects.value = plan.missingRollbackObjects ?? [];
  selectedRawPlan.value = formatted;
  renderSelectedPlan();
  selectedPlanCurrent.value = true;
}

async function regenerateFocusedDeploySql(objectId: string | null = selectedObjectId.value) {
  const result = lastDiffResult.value;
  const generation = ++focusedDeploySqlGeneration;
  focusedPlanError.value = "";
  if (focusedPlanObjectId.value !== objectId || !result || !objectId) {
    focusedRawPlan.value = null;
    focusedPlanObjectId.value = null;
    focusedForwardDeploySql.value = "";
    focusedRollbackSql.value = "";
    focusedDeploySql.value = "";
  }
  if (isOracleRoutineDeploy.value) return;
  if (!result || !objectId || !findSchemaDiffObject(diffObjects.value, objectId)) {
    return;
  }

  const options = normalizeSchemaDiffCompareOptions(activeConfig.value?.options, getDbType());
  const input = selectSchemaDiffInputForObject(result, diffObjects.value, objectId);
  let plan;
  try {
    plan = await api.generateSchemaSyncPlan(input, buildSchemaSyncPlanOptions(options));
  } catch (error: any) {
    if (!componentUnmounted && generation === focusedDeploySqlGeneration && selectedObjectId.value === objectId) {
      focusedPlanError.value = error?.message || String(error);
      toast(focusedPlanError.value, 5000);
    }
    return;
  }
  if (componentUnmounted || generation !== focusedDeploySqlGeneration || selectedObjectId.value !== objectId) return;

  const formatted = formatSchemaSyncPlan(plan, input, options);
  focusedRawPlan.value = formatted;
  focusedPlanObjectId.value = objectId;
  renderFocusedPlan();
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
  if (isOracleRoutineDeploy.value) {
    const state = routineDeployment.value;
    return routineTargetIsCurrent.value && !!(state?.recoveryPlan ?? state?.plan)?.ready && !deployIsBusy.value;
  }
  if (deploySqlMode.value === "rollback" && rollbackCompleteness.value === "incomplete") {
    return false;
  }
  if (!selectedPlanCurrent.value) return false;
  if (deploySqlMode.value === "forward" && selectedRawPlan.value?.forwardCompleteness === "incomplete") return false;
  const sql = selectedDeploySql.value.trim();
  return sql.length > 0 && sql !== "-- No objects selected";
});

const destructiveStatements = computed(() => {
  const databaseType = store.getConfig(targetConnectionId.value)?.db_type;
  return detectDestructiveSchemaDiffStatements(isOracleRoutineDeploy.value && routineDeployment.value ? oracleRoutinePlanSql(routineDeployment.value) : selectedDeploySql.value, databaseType);
});

function applyRename(rc: RenameCandidate) {
  if (!confirmDiscardDeployEdits()) return;
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
  if (!confirmDiscardDeployEdits()) return;
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
  if (isOracleRoutineDeploy.value) {
    await handleDeployReview();
    return;
  }
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
  if (isOracleRoutineDeploy.value && routineDeployment.value) {
    const state = routineDeployment.value;
    if (!routineTargetIsCurrent.value) return;
    await executeOracleRoutineDeployment(state, (sql, execute) =>
      executeWithProductionSqlGuard({
        connection: store.getConfig(state.target.endpoint.connectionId),
        database: state.target.endpoint.database,
        sql,
        source: t("production.sourceSchemaDiff"),
        execute,
      }),
    );
    return;
  }
  const confirmed = confirmedDeploy;
  if (!confirmed || confirmed.completeness === "incomplete") return;
  const targetIsCurrent = () => {
    const connection = store.getConfig(confirmed.connectionId);
    return !!connection && confirmed.connectionId === targetConnectionId.value && confirmed.database === targetDatabase.value && confirmed.schema === targetSchema.value && confirmed.mode === deploySqlMode.value && connectionConfigFingerprint(connection) === confirmed.connectionFingerprint;
  };
  confirmedDeploy = null;
  executing.value = true;
  try {
    if (!targetIsCurrent()) throw new Error(t("processList.oracleConnectionChanged"));
    const failed = await executeWithProductionSqlGuard({
      connection: confirmed.connection,
      database: confirmed.database,
      sql: confirmed.sql,
      source: t("production.sourceSchemaDiff"),
      execute: async () => {
        if (!targetIsCurrent()) throw new Error(t("processList.oracleConnectionChanged"));
        if (confirmed.continueOnError) {
          const results = await api.executeMulti(confirmed.connectionId, confirmed.database, confirmed.sql, confirmed.schema || undefined, undefined, {
            continueOnError: true,
            maxRows: 1,
          });
          return buildContinueOnErrorDeployLog(results);
        }
        const txLog = await api.executeScriptWith2pc(confirmed.connectionId, confirmed.database, [confirmed.sql], confirmed.schema, confirmed.destructive);
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
  // (views need runtime retrieval; routines may have empty definitions from list_functions_via_objects)
  if (obj.objectKind === "view") {
    try {
      if (obj.operationType === "create" && !obj.sourceDdl) {
        const result = await api.getObjectSource(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, obj.name, "VIEW", obj.arguments);
        if (result?.source) obj.sourceDdl = result.source;
      }
      if (obj.operationType === "delete" && !obj.targetDdl) {
        const result = await api.getObjectSource(targetConnectionId.value, targetDatabase.value, targetSchema.value, obj.name, "VIEW", obj.arguments);
        if (result?.source) obj.targetDdl = result.source;
      }
      if (obj.operationType === "modify") {
        if (!obj.sourceDdl) {
          const result = await api.getObjectSource(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, obj.name, "VIEW", obj.arguments);
          if (result?.source) obj.sourceDdl = result.source;
        }
        if (!obj.targetDdl) {
          const result = await api.getObjectSource(targetConnectionId.value, targetDatabase.value, targetSchema.value, obj.name, "VIEW", obj.arguments);
          if (result?.source) obj.targetDdl = result.source;
        }
      }
    } catch {
      // Silently ignore errors
    }
    return;
  }

  if (obj.objectKind !== "function") return;
  // Strict snapshots retain incomplete reads and their issues; an ordinary
  // fallback must not silently replace that evidence with an unverified source.
  if (isOracleRoutineComparison.value) return;

  const preferredKind: ObjectSourceKind = obj.routineType ?? "FUNCTION";

  async function fetchRoutineDdl(connectionId: string, database: string, schema: string, name: string): Promise<string | undefined> {
    try {
      const { source } = await loadObjectSourceWithRoutineFallback(api.getObjectSource, connectionId, database, schema, name, preferredKind, obj.arguments);
      return source?.source?.trim() ? source.source : undefined;
    } catch {
      return undefined;
    }
  }

  if (obj.operationType === "create" && !obj.sourceDdl) {
    const ddl = await fetchRoutineDdl(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, obj.name);
    if (ddl) obj.sourceDdl = ddl;
  }
  if (obj.operationType === "delete" && !obj.targetDdl) {
    const ddl = await fetchRoutineDdl(targetConnectionId.value, targetDatabase.value, targetSchema.value, obj.name);
    if (ddl) obj.targetDdl = ddl;
  }
  if (obj.operationType === "modify") {
    if (!obj.sourceDdl) {
      const ddl = await fetchRoutineDdl(sourceConnectionId.value, sourceDatabase.value, sourceSchema.value, obj.name);
      if (ddl) obj.sourceDdl = ddl;
    }
    if (!obj.targetDdl) {
      const ddl = await fetchRoutineDdl(targetConnectionId.value, targetDatabase.value, targetSchema.value, obj.name);
      if (ddl) obj.targetDdl = ddl;
    }
  }
}

async function handleViewRoutineDiff(object: SchemaDiffObject) {
  await handleSelectObject(object);
}

async function copyRoutineDiffSide(side: TextDiffSide) {
  const object = selectedObject.value;
  if (!object) return;
  const text = side === "before" ? (object.sourceDdl ?? "") : (object.targetDdl ?? "");
  try {
    await copyToClipboard(text);
    toast(t("diff.routineDdlCopied"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}
function handleLoadHistoryConfig(config: SchemaDiffConfig) {
  applyConfigToForm(config);
  if (config.options) {
    updateActiveConfigOptions(normalizeSchemaDiffCompareOptions(config.options, getDbType()));
  }
}

function applyConfigToForm(config: SchemaDiffConfig) {
  runWithoutTargetIdentityReset(() => {
    sourceConnectionId.value = config.sourceConnectionId;
    sourceDatabase.value = config.sourceDatabase;
    sourceSchema.value = config.sourceSchema;
    targetConnectionId.value = config.targetConnectionId;
    targetDatabase.value = config.targetDatabase;
    targetSchema.value = config.targetSchema;
  });
}

function snapshotCurrentConfig(name: string): SchemaDiffConfig {
  ensureDefaultConfig(getDbType());
  const base = activeConfig.value;
  return {
    id: base?.id ?? "",
    name,
    createdAt: base?.createdAt ?? Date.now(),
    updatedAt: Date.now(),
    sourceConnectionId: sourceConnectionId.value,
    sourceDatabase: sourceDatabase.value,
    sourceSchema: sourceSchema.value,
    targetConnectionId: targetConnectionId.value,
    targetDatabase: targetDatabase.value,
    targetSchema: targetSchema.value,
    options: { ...schemaDiffPanelOptions.value },
  };
}

function handleLoadConfig() {
  ensureDefaultConfig(getDbType());
  showConfigSelector.value = true;
}

function handleSelectActiveConfig(id: string) {
  if (!id || id === activeConfigId.value) return;
  activeConfigId.value = id;
  const config = configs.value.find((entry) => entry.id === id);
  if (config) applyConfigToForm(config);
}

function handleSaveConfig() {
  ensureDefaultConfig(getDbType());
  if (!activeConfig.value) return;
  const name = window.prompt(t("diff.saveConfigPrompt"), activeConfig.value.name || t("diff.defaultConfigName"));
  if (name === null) return;
  const trimmed = name.trim() || t("diff.defaultConfigName");
  const snapshot = snapshotCurrentConfig(trimmed);
  updateConfig(activeConfig.value.id, {
    name: trimmed,
    sourceConnectionId: snapshot.sourceConnectionId,
    sourceDatabase: snapshot.sourceDatabase,
    sourceSchema: snapshot.sourceSchema,
    targetConnectionId: snapshot.targetConnectionId,
    targetDatabase: snapshot.targetDatabase,
    targetSchema: snapshot.targetSchema,
    options: snapshot.options,
  });
  saveToHistory({ ...snapshot, id: activeConfig.value.id });
  toast(t("diff.configSaved"), 2000);
}

function handleCreateNamedConfig(name: string) {
  const snapshot = snapshotCurrentConfig(name);
  createConfig(name, snapshot, getDbType());
}

function handleRenameNamedConfig(id: string, name: string) {
  renameConfig(id, name);
}

function handleDeleteNamedConfig(id: string) {
  deleteConfig(id);
  if (activeConfig.value) applyConfigToForm(activeConfig.value);
}

function handleDuplicateNamedConfig(id: string) {
  duplicateConfig(id);
  if (activeConfig.value) applyConfigToForm(activeConfig.value);
}

function handleImportNamedConfigs(jsonText: string) {
  try {
    importConfigs(jsonText, "merge");
    if (activeConfig.value) applyConfigToForm(activeConfig.value);
    toast(t("diff.configSaved"), 2000);
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

function handleDeleteHistoryConfig(configId: string) {
  deleteFromHistory(configId);
  toast(t("diff.configDeleted"), 2000);
}

async function fetchDbVersion(connectionId: string, database: string, schema: string) {
  if (!supportsDatabaseCompare(store.getConfig(connectionId), "schema")) return;
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

async function handleDeployReview() {
  if (resultTab.value === "routines" && !canDeployRoutines.value) return;
  const selectedObjects = selectedSchemaDiffObjects(currentTabDiffObjects.value);
  if (selectedObjects.length === 0) {
    toast(t("diff.noObjectsSelected"), 3000);
    return;
  }
  step.value = "deploy-review";
  if (isOracleRoutineDeploy.value) {
    const state = ensureRoutineDeployment();
    if (state) {
      state.reviewOpen = true;
      if (!state.plan && !state.recoveryPlan && !state.executing) await validateOracleRoutineDeployment(state, undefined, { compactSql: ddlPreferences.value.compactDdlSql });
    }
  }
  fetchDbVersion(targetConnectionId.value, targetDatabase.value, targetSchema.value);
}

async function handleDeploy() {
  confirmedDeploy = null;
  if (isOracleRoutineDeploy.value) {
    if (!canExecuteDeploy.value) return;
    routineConfirmRevision = routineDeployment.value?.revision ?? null;
  }
  if (deploySqlMode.value === "rollback" && rollbackCompleteness.value === "incomplete") {
    toast(t("diff.rollbackIncompleteBlocked"), 5000);
    return;
  }
  if (!isOracleRoutineDeploy.value) {
    if (!canExecuteDeploy.value) return;
    const connection = store.getConfig(targetConnectionId.value);
    if (!connection) return;
    confirmedDeploy = {
      sql: selectedDeploySql.value,
      connectionId: targetConnectionId.value,
      connection: connection ? { ...connection } : undefined,
      connectionFingerprint: connectionConfigFingerprint(connection),
      database: targetDatabase.value,
      schema: targetSchema.value,
      mode: deploySqlMode.value,
      continueOnError: continueOnError.value,
      destructive: destructiveStatements.value.length > 0,
      completeness: deploySqlMode.value === "rollback" ? rollbackCompleteness.value : (selectedRawPlan.value?.forwardCompleteness ?? "complete"),
    };
  }
  showConfirmDialog.value = true;
}

async function onConfirmDeploy() {
  showConfirmDialog.value = false;
  if (!isOracleRoutineDeploy.value && confirmedDeploy) confirmedDeploy.continueOnError = continueOnError.value;
  if (isOracleRoutineDeploy.value && (routineConfirmRevision !== routineDeployment.value?.revision || !canExecuteDeploy.value)) return;
  if (deploySqlMode.value === "rollback" && rollbackCompleteness.value === "incomplete") {
    toast(t("diff.rollbackIncompleteBlocked"), 5000);
    return;
  }

  await executeDeploySql();
}

const deployStats = computed(() => {
  if (isOracleRoutineDeploy.value && routineDeployment.value) {
    const steps = (routineDeployment.value.recoveryPlan ?? routineDeployment.value.plan)?.steps ?? [];
    return { create: steps.filter((step) => step.action === "create").length, modify: steps.filter((step) => step.action === "replace").length, delete: steps.filter((step) => step.action === "delete").length, total: steps.length };
  }
  const counts = summarizeSchemaDiffOperations(currentTabDiffObjects.value);
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
    <DialogContent :class="['flex flex-col overflow-hidden dbx-schema-diff-dialog', isMaximized ? 'dbx-dialog-maximized min-w-0' : 'min-w-[800px] resize']" :portal-class="isMaximized ? 'p-0' : undefined" :style="dialogStyle" @interact-outside.prevent @escape-key-down="handleDialogEscape">
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
          :source-connection-id="sourceConnectionId"
          @update:source-connection-id="handleSourceConnectionChange"
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
          :selected-routines="schemaDiffPanelOptions.selectedRoutines"
          :table-list-loader="schemaDiffTableListLoader"
          :loading="loading"
          :recent-configs="recentConfigs"
          @compare="handleCompare"
          @swap="handleSwap"
          @show-options="showOptionsPanel = true"
          @save-config="handleSaveConfig"
          @load-config="handleLoadConfig"
          @load-history-config="handleLoadHistoryConfig"
          @delete-history-config="handleDeleteHistoryConfig"
          @update:field-mappings="handleFieldMappingsUpdate"
          @update:table-mappings="handleTableMappingsUpdate"
          @update:routine-mappings="handleRoutineMappingsUpdate"
          @update:selected-tables="handleSelectedTablesUpdate"
          @update:selected-routines="handleSelectedRoutinesUpdate"
          @update:routine-selection="handleRoutineSelectionUpdate"
          @update:compare-scope="handleCompareScopeUpdate"
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
          <p v-if="independentPreview?.loading" role="status" class="flex shrink-0 items-center gap-2 px-3 py-2 text-sm text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("common.loading") }}</p>
          <ul v-if="independentPreview?.issues.length" role="alert" class="max-h-32 shrink-0 overflow-auto px-3 py-2 text-sm text-destructive">
            <li v-for="issue in independentPreview.issues" :key="issue">{{ issue }}</li>
          </ul>
          <ul v-if="!isOracleRoutineDeploy && focusedGenerationIssues.length" role="alert" class="max-h-32 shrink-0 overflow-auto px-3 py-2 text-sm text-destructive">
            <li v-for="(issue, index) in focusedGenerationIssues" :key="index">{{ issue.table ? `${issue.table} / ` : "" }}{{ issue.name }}: {{ issue.reason }}</li>
          </ul>
          <p v-if="!isOracleRoutineDeploy && focusedPlanError" role="alert" class="shrink-0 px-3 py-2 text-sm text-destructive">{{ focusedPlanError }}</p>
          <Tabs v-model="resultTab" class="flex min-h-0 flex-1 flex-col gap-0 data-horizontal:flex-col">
            <TabsList v-if="showResultTabList" class="mx-3 mt-2 h-8 w-fit shrink-0">
              <TabsTrigger value="tables" class="text-xs">
                {{ t("diff.resultTabTables", { count: tableActionableCount }) }}
              </TabsTrigger>
              <TabsTrigger value="routines" class="text-xs">
                {{ t("diff.resultTabRoutines", { count: routineActionableCount }) }}
              </TabsTrigger>
            </TabsList>

            <TabsContent v-if="showTableResultTab" value="tables" class="mt-0 flex min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden">
              <div v-if="showNoDifferences" class="mx-3 mt-2 shrink-0 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-center text-xs text-muted-foreground">
                {{ t("diff.noDifferences") }}
              </div>
              <div v-if="renameCandidates.length > 0" class="shrink-0 overflow-hidden border-b bg-amber-50 dark:bg-amber-950/20">
                <button class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium transition-colors hover:bg-amber-100/50 dark:hover:bg-amber-900/30" @click="showRenamePanel = !showRenamePanel">
                  <ChevronDown v-if="showRenamePanel" class="h-3 w-3" />
                  <ChevronRight v-else class="h-3 w-3" />
                  {{ t("diff.renameCandidates") }}
                  <span class="ml-auto font-normal text-muted-foreground">{{ renameCandidates.length }} candidate(s)</span>
                </button>
                <div v-if="showRenamePanel" class="px-3 pb-2 text-xs">
                  <table class="w-full">
                    <thead>
                      <tr class="border-b text-muted-foreground">
                        <th class="py-1 pr-4 text-left">{{ t("diff.sourceTable") }}</th>
                        <th class="py-1 pr-4 text-left">{{ t("diff.targetTable") }}</th>
                        <th class="py-1 pr-4 text-left">{{ t("diff.similarity") }}</th>
                        <th class="py-1 text-left">{{ t("common.actions") }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(rc, i) in renameCandidates" :key="i" class="border-b border-amber-200/50 dark:border-amber-800/30">
                        <td class="py-1 pr-4 font-mono">{{ rc.sourceName }}</td>
                        <td class="py-1 pr-4 font-mono">{{ rc.targetName }}</td>
                        <td class="py-1 pr-4">
                          <span
                            class="rounded px-1.5 py-0.5 text-[10px] font-medium"
                            :class="rc.score >= 0.8 ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : rc.score >= 0.5 ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'"
                            >{{ (rc.score * 100).toFixed(0) }}%</span
                          >
                        </td>
                        <td class="py-1">
                          <button class="mr-1 rounded bg-primary/10 px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/20" @click="applyRename(rc)">
                            {{ t("diff.confirmRename") }}
                          </button>
                          <button class="rounded bg-muted px-2 py-0.5 text-xs transition-colors hover:bg-muted/80" @click="ignoreRename(i)">
                            {{ t("diff.ignore") }}
                          </button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <Splitpanes horizontal class="min-h-0 flex-1" @resized="handleSplitpanesResized">
                <Pane :size="splitpanesSize" min-size="20">
                  <div class="h-full overflow-auto">
                    <SchemaDiffObjectTree :groups="tableDiffGroups" :selected-object-id="selectedTableObjectId" @toggle-group="handleToggleGroup" @toggle-group-selection="handleToggleGroupSelection" @toggle-object-selection="handleToggleObjectSelection" @select-object="handleSelectObject" />
                  </div>
                </Pane>
                <Pane :size="100 - splitpanesSize" min-size="20">
                  <SchemaDiffDdlPanel
                    :selected-object="displayedSelectedObject"
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
            </TabsContent>

            <TabsContent v-if="showRoutineResultTab" value="routines" class="mt-0 flex min-h-0 flex-1 flex-col outline-none data-[state=inactive]:hidden">
              <div v-if="routineReadIssues.length || (selectedObject?.operationType === 'none' && selectedObject.changes?.length)" role="status" class="mx-3 mt-2 max-h-32 shrink-0 space-y-1 overflow-auto text-xs text-amber-700 dark:text-amber-300">
                <p v-for="(issue, index) in routineReadIssues" :key="index">{{ t(issue.side === "source" ? "diff.sourceObject" : "diff.targetObject") }} — {{ issue.message }}</p>
                <p v-for="(change, index) in selectedObject?.operationType === 'none' ? (selectedObject.changes ?? []) : []" :key="`change-${index}`">{{ change }}</p>
              </div>
              <div v-if="showRoutineNoDifferences" class="mx-3 mt-2 shrink-0 rounded-md border border-dashed bg-muted/20 px-3 py-2 text-center text-xs text-muted-foreground">
                {{ t("diff.noDifferences") }}
              </div>
              <Splitpanes horizontal class="min-h-0 flex-1" @resized="handleSplitpanesResized">
                <Pane :size="splitpanesSize" min-size="20">
                  <div class="h-full overflow-auto">
                    <SchemaDiffRoutineList
                      :objects="routineDiffObjects"
                      :viewing-object-id="selectedRoutineObjectId"
                      :selectable="canDeployRoutines"
                      :empty-text="t(isOracleRoutineComparison && !routineInventoriesComplete ? 'diff.routineUnreadable' : 'diff.noDifferences')"
                      @toggle-selection="handleToggleObjectSelection"
                      @view-diff="handleViewRoutineDiff"
                    />
                  </div>
                </Pane>
                <Pane :size="100 - splitpanesSize" min-size="20">
                  <div class="flex h-full min-h-0 flex-col">
                    <div v-if="!selectedObject || selectedObject.objectKind !== 'function'" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                      {{ t("diff.selectRoutineToCompare") }}
                    </div>
                    <div v-else-if="!selectedObject.sourceDdl && !selectedObject.targetDdl" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                      {{ t("diff.noDdlAvailable") }}
                    </div>
                    <SideBySideTextDiff
                      v-else
                      class="min-h-0 flex-1"
                      :before-text="selectedObject.sourceDdl || ''"
                      :after-text="selectedObject.targetDdl || ''"
                      :before-label="t('diff.sourceDdl')"
                      :after-label="t('diff.targetDdl')"
                      :copy-before-title="t('diff.copySourceDdl')"
                      :copy-after-title="t('diff.copyTargetDdl')"
                      :before-available="!!selectedObject.sourceDdl"
                      :after-available="!!selectedObject.targetDdl"
                      @copy="copyRoutineDiffSide"
                    />
                  </div>
                </Pane>
              </Splitpanes>
            </TabsContent>
          </Tabs>
        </template>

        <!-- Deploy Review Step -->
        <template v-else-if="step === 'deploy-review'">
          <DdlStorageToggle :database-type="targetEngineDbType" :preferences="ddlPreferences" :disabled="(!isOracleRoutineDeploy && deploySqlDirty) || deployIsBusy || showConfirmDialog || routineDdlOptionsLocked" class="px-3 py-2" />
          <ul v-if="!isOracleRoutineDeploy && selectedGenerationIssues.length" role="alert" class="max-h-32 shrink-0 overflow-auto px-3 py-2 text-sm text-destructive">
            <li v-for="(issue, index) in selectedGenerationIssues" :key="index">{{ issue.table ? `${issue.table} / ` : "" }}{{ issue.name }}: {{ issue.reason }}</li>
          </ul>
          <SchemaDiffDeployStep
            v-model:deploy-sql="deployEditorSql"
            v-model:ignore-foreign-key-checks="ignoreForeignKeyChecks"
            v-model:continue-on-error="continueOnError"
            :show-ignore-foreign-key-checks="isMysqlDeployTarget"
            :selected-objects="currentTabDiffObjects"
            :target-connection-id="targetConnectionId"
            :target-database="targetDatabase"
            :target-schema="targetSchema"
            :executing="deployIsBusy || showConfirmDialog"
            :database-type="targetEngineDbType"
            :routine-deployment="isOracleRoutineDeploy ? routineDeployment : null"
            :rollback-sql="isOracleRoutineDeploy ? undefined : rollbackSql"
            :deploy-sql-mode="deploySqlMode"
            :compatibility-warnings="selectedCompatibilityWarnings"
            :rename-candidates="renameCandidates"
            :rollback-completeness="rollbackCompleteness"
            :missing-rollback-objects="missingRollbackObjects"
            :can-execute="canExecuteDeploy"
            :destructive-statement-count="destructiveStatements.length"
            @update:deploy-sql-mode="switchDeploySqlMode"
            @back="leaveDeployReview"
            @deploy="handleDeploy"
            @select-routine="
              (id) => {
                if (routineDeployment) selectOracleRoutineDraft(routineDeployment, id);
              }
            "
            @validate-routines="routineDeployment && validateOracleRoutineDeployment(routineDeployment, undefined, { compactSql: ddlPreferences.compactDdlSql })"
            @include-package-companion="(id, source) => routineDeployment && includeOraclePackageCompanion(routineDeployment, id, source)"
            @update-package-options="(id, options) => routineDeployment && editOraclePackageOptions(routineDeployment, id, options)"
            @review-package-target="(id) => routineDeployment && reviewOraclePackageTargetDraft(routineDeployment, id)"
            @refresh-routines="routineDeployment && refreshOracleRoutineDeployment(routineDeployment)"
            @observe-routine="(id) => routineDeployment && observeOracleRoutineDeployment(routineDeployment, id)"
            @recover-routine="(id) => routineDeployment && prepareOracleRoutineRecovery(routineDeployment, id)"
          />
        </template>
      </div>

      <!-- Footer -->
      <DialogFooter class="flex items-center justify-between">
        <div v-if="step === 'result'" class="flex items-center gap-2">
          <DdlStorageToggle :database-type="targetEngineDbType" :preferences="ddlPreferences" :disabled="(!isOracleRoutineDeploy && deploySqlDirty) || deployIsBusy || showConfirmDialog || routineDdlOptionsLocked" />
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
          <p v-if="showRoutineDeployDeferredHint" class="max-w-md text-right text-[11px] text-muted-foreground">
            {{ t("diff.routineSyncDeferredHint") }}
          </p>
          <Button v-else size="sm" :disabled="!canDeploy || deployIsBusy" @click="handleDeployReview">
            <Loader2 v-if="deployIsBusy" class="w-3.5 h-3.5 mr-1 animate-spin" />
            <Play v-else class="w-3.5 h-3.5 mr-1" />
            {{ deployButtonLabel }}
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

            <label v-if="!isOracleRoutineDeploy" class="flex items-start gap-2 rounded border border-yellow-300 bg-yellow-50 p-3 text-xs text-yellow-800 dark:border-yellow-700 dark:bg-yellow-950/30 dark:text-yellow-200" :class="executing ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'">
              <input v-model="continueOnError" type="checkbox" class="mt-0.5 accent-primary" :disabled="executing" />
              <span>
                <span class="font-medium">{{ t("diff.continueOnError") }}</span>
                <span class="mt-1 block">{{ t("diff.continueOnErrorHint") }}</span>
              </span>
            </label>
          </div>

          <DialogFooter>
            <Button variant="outline" @click="showConfirmDialog = false">{{ t("diff.cancel") }}</Button>
            <Button variant="destructive" :disabled="deployIsBusy || (isOracleRoutineDeploy && !canExecuteDeploy)" @click="onConfirmDeploy">
              <Loader2 v-if="deployIsBusy" class="w-3.5 h-3.5 mr-1 animate-spin" />
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
              <template v-if="deployResult?.status === 'completed_with_errors'">{{ t("diff.deployCompletedWithErrorsTitle") }}</template>
              <template v-else-if="deployResult?.status === 'mixed'">{{ t("diff.deployMixedTitle") }}</template>
              <template v-else-if="deployResult?.status === 'rolled_back'">{{ t("diff.deployRolledBackTitle") }}</template>
              <template v-else>{{ deployResult?.success ? t("diff.deploySuccess") : t("diff.deployFailed") }}</template>
            </DialogTitle>
          </DialogHeader>

          <div class="py-2">
            <div v-if="deployResult?.status === 'completed_with_errors'" class="space-y-2">
              <p class="text-sm text-destructive-foreground">{{ deployResult.message }}</p>
              <div v-if="deployResult.failures?.length" class="max-h-56 space-y-2 overflow-auto rounded border border-destructive/30 bg-destructive/5 p-2 text-xs">
                <div v-for="failure in deployResult.failures" :key="failure.index" class="space-y-1">
                  <div class="font-medium text-destructive">{{ t("diff.statementNumber", { index: failure.index + 1 }) }}</div>
                  <pre class="whitespace-pre-wrap font-mono">{{ failure.error }}</pre>
                </div>
              </div>
            </div>
            <div v-else-if="deployResult?.status === 'mixed'" class="space-y-2">
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
        <div class="flex h-[calc(100%-2rem)] max-h-[680px] w-[900px] max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg border bg-card shadow-lg">
          <div class="flex shrink-0 items-center justify-between border-b px-4 py-3">
            <h3 class="text-sm font-medium">{{ t("schemaDiff.optionsTitle") }}</h3>
            <Button variant="ghost" size="sm" @click="showOptionsPanel = false" :aria-label="t('common.close')">✕</Button>
          </div>
          <div class="min-h-0 flex-1 p-4">
            <SchemaDiffOptionsPanel :options="schemaDiffPanelOptions" :option-tree="optionTree" @update:options="handleOptionsUpdate" @close="showOptionsPanel = false" />
          </div>
        </div>
      </div>

      <!-- Config selector overlay (save/load named configs) -->
      <div v-if="showConfigSelector" class="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm" @click.self="showConfigSelector = false">
        <div class="max-h-[80vh] w-[720px] max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border bg-card p-4 shadow-lg">
          <div class="mb-4 flex items-center justify-between gap-2">
            <h3 class="text-sm font-medium">{{ t("diff.loadConfig") }}</h3>
            <Button variant="ghost" size="sm" :aria-label="t('common.close')" @click="showConfigSelector = false">✕</Button>
          </div>
          <SchemaDiffConfigSelector
            :configs="configs"
            :active-config-id="activeConfigId"
            @update:active-config-id="handleSelectActiveConfig"
            @create="handleCreateNamedConfig"
            @rename="handleRenameNamedConfig"
            @delete="handleDeleteNamedConfig"
            @duplicate="handleDuplicateNamedConfig"
            @import="handleImportNamedConfigs"
          />
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

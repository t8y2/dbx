<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { mysqlDataCharsetEnabled } from "@/lib/connection/mysqlDataCharset";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { buildTransferObjectSelectionField, countTransferObjects } from "./transferSelections";
import { createTaskLoadTracker } from "./taskLoadTracker";
import { describeTransferStructureOperation, summarizeTransferStructureOperations } from "./structurePlanSummary";
import {
  confirmTransferWithProductionSafety,
  createTransferSubmission,
  hasTransferSqlPreview,
  rebuildUnavailableReason,
  resolveTransferStrategy,
  supportsTransferUpsert,
  transferPlanReviewText,
  transferPreviewSql,
  transferStrategyOptions,
  TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE,
  type TransferStrategy,
  type TransferPackageConfirmation,
} from "./transferStrategy";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import ConnectionTreeSelect from "@/components/connection/ConnectionTreeSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { ensureReadOnlyWriteAccess } from "@/lib/database/readOnlyWriteAccess";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import * as api from "@/lib/backend/api";
import type { TransferColumnNameCase, TransferContent, TransferObjectKind, TransferTableNameCase } from "@/lib/backend/api";
import { crossFamilyTransferableKinds, isSameTransferFamily, isTransferPairSupported, transferObjectFamily, transferObjectKindsForDatabase, transferSchemasForDatabase } from "@/lib/database/transferObjectKinds";
import ObjectSelectionTree from "@/components/transfer/ObjectSelectionTree.vue";
import TransferTaskTree from "@/components/transfer/TransferTaskTree.vue";
import DataTransferProgressDialog from "@/components/transfer/DataTransferProgressDialog.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import SqlPreviewPanel from "@/components/editor/SqlPreviewPanel.vue";
import SchemaDiffDeployStep from "@/components/diff/SchemaDiffDeployStep.vue";
import {
  createOracleRoutineDeployment,
  oraclePackageTransferPendingReady,
  disposeOracleRoutineDeployment,
  editOracleRoutineDraft,
  editOraclePackageOptions,
  includeOraclePackageCompanion,
  refreshOracleRoutineDeployment,
  reviewOraclePackageTargetDraft,
  selectOracleRoutineDraft,
  validateOracleRoutineDeployment,
  type OracleRoutineDeployment,
} from "@/lib/schema/oracleRoutineDeploy";
import { normalizeSchemaDiffCompareOptions, type OracleRoutinePlanInput } from "@/types/schemaDiff";
import type { DatabaseType } from "@/types/database";
import type { TransferPackageDraft, TransferTask, TransferTaskConfig } from "@/types/database";
import { isSchemaAware, supportsTransfer } from "@/lib/database/databaseCapabilities";
import { transferDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { isDorisFamilyCatalogCapable } from "@/lib/database/databaseFeatureSupport";
import { decodeTransferDatabaseOption, encodeTransferDatabaseOptions, formatTransferEndpointLabel, isSameTransferDatabase, isTransferDatabaseSelected, normalizeTransferCatalog } from "@/lib/database/dataTransferSelection";
import { formatDatabaseLabel } from "@/lib/database/defaultDatabase";
import { DEFAULT_QUERY_TIMEOUT_SECS, MAX_QUERY_TIMEOUT_SECS } from "@/lib/connection/timeoutLimits";
import { databaseOptionsForConnection, fetchCatalogNamespaceOptions, fetchNamespaceOptionsForConnection, namespaceOptionsAreSchemas } from "@/composables/useDatabaseOptions";
import { useExportTracker } from "@/composables/useExportTracker";
import { openDataTransferTask, openSchemaDiffSession } from "@/composables/useDialogSources";
import { startSchemaDiffSession } from "@/composables/useSchemaDiffSession";
import { createSchemaDiffTableListLoader } from "@/lib/schema/schemaDiffTableList";
import { useTransferTaskStore, TransferTaskNameConflictError, nextTransferTaskCopyName } from "@/stores/transferTaskStore";
import { useToast } from "@/composables/useToast";
import type { CatalogInfo } from "@/types/database";
import { ArrowRightLeft, ArrowLeftRight, Loader2, X } from "@lucide/vue";

const { t } = useI18n();
const { tasks, startDataTransferTask } = useExportTracker();
const { toast } = useToast();
const taskStore = useTransferTaskStore();
const productionSafetyStore = useProductionSafetyStore();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillCatalog?: string;
  prefillSchema?: string;
  prefillTables?: string[];
  prefillTargetConnectionId?: string;
  prefillTargetDatabase?: string;
  prefillTargetSchema?: string;
  taskId?: string | null;
}>();

const trackedTransferTask = computed(() => {
  if (!props.taskId) return undefined;
  return tasks.value.find((task) => task.exportId === props.taskId && task.kind === "data-transfer");
});

const transferDialogStyle = {
  width: "min(1120px, calc(100vw - 2rem))",
  height: "min(80vh, calc(var(--dbx-viewport-height) - 2rem))",
  minWidth: "min(780px, calc(100vw - 2rem))",
  minHeight: "min(480px, calc(var(--dbx-viewport-height) - 2rem))",
  maxWidth: "calc(100vw - 2rem)",
  maxHeight: "calc(var(--dbx-viewport-height) - 2rem)",
} as const;

const store = useConnectionStore();
const DEFAULT_TRANSFER_OPERATION_TIMEOUT_SECS = 600;

const sqlConnections = computed(() => store.connections.filter((c) => !mysqlDataCharsetEnabled(c) && supportsTransfer(transferDatabaseTypeForConnection(c))));
const sourceConnections = computed(() => {
  const targetType = transferDatabaseTypeForConnection(store.getConfig(targetConnectionId.value));
  return sqlConnections.value.filter((connection) => isTransferPairSupported(transferDatabaseTypeForConnection(connection), targetType));
});
const targetConnections = computed(() => {
  const sourceType = transferDatabaseTypeForConnection(store.getConfig(sourceConnectionId.value));
  return sqlConnections.value.filter((connection) => isTransferPairSupported(sourceType, transferDatabaseTypeForConnection(connection)));
});

// Source state
const sourceConnectionId = ref("");
const sourceCatalog = ref("");
const sourceCatalogs = ref<CatalogInfo[]>([]);
const sourceDatabase = ref("");
const sourceDatabases = ref<string[]>([]);
const sourceSchemas = ref<string[]>([]);
const sourceSchema = ref("");
const objectGroups = ref<Partial<Record<TransferObjectKind, string[]>>>({});
const selectedObjects = ref<Partial<Record<TransferObjectKind, Set<string>>>>({});
const objectSearch = ref("");
const loadingObjects = ref(false);
const transferContent = ref<TransferContent>("structureAndData");

const selectedTables = computed(() => new Set(selectedObjects.value.TABLE ?? []));
const selectedTableList = computed(() => [...selectedTables.value]);

const OBJECT_KIND_LABEL_KEY: Record<TransferObjectKind, string> = {
  TABLE: "transfer.objectTypeTable",
  VIEW: "transfer.objectTypeView",
  MATERIALIZED_VIEW: "transfer.objectTypeMaterializedView",
  PROCEDURE: "transfer.objectTypeProcedure",
  FUNCTION: "transfer.objectTypeFunction",
  TRIGGER: "transfer.objectTypeTrigger",
  SEQUENCE: "transfer.objectTypeSequence",
  EVENT: "transfer.objectTypeEvent",
  PACKAGE: "tree.packages",
  PACKAGE_BODY: "objects.packageBody",
  SYNONYM: "tree.synonyms",
};

const treeSelection = computed<Record<string, string[]>>({
  get: () => Object.fromEntries(Object.entries(selectedObjects.value).map(([k, v]) => [k, [...(v ?? [])]])),
  set: (value) => {
    const next: Partial<Record<TransferObjectKind, Set<string>>> = {};
    for (const [k, names] of Object.entries(value)) {
      if (names.length > 0) next[k as TransferObjectKind] = new Set(names);
    }
    selectedObjects.value = next;
  },
});

const treeGroups = computed(() =>
  (Object.keys(objectGroups.value) as TransferObjectKind[])
    .filter((kind) => !(sourceTransferType.value === "mysql" && targetTransferType.value === "xugu") || kind === "TABLE")
    .map((kind) => ({
      kind,
      label: t(OBJECT_KIND_LABEL_KEY[kind]),
      items: objectGroups.value[kind] ?? [],
    })),
);

const treeDisabledGroups = computed<TransferObjectKind[]>(() => {
  const presentKinds = Object.keys(objectGroups.value) as TransferObjectKind[];
  if (transferContent.value === "dataOnly") {
    return presentKinds.filter((k) => k !== "TABLE");
  }
  const sourceConfig = store.getConfig(sourceConnectionId.value);
  const targetConfig = store.getConfig(targetConnectionId.value);
  const allowed = crossFamilyTransferableKinds(transferDatabaseTypeForConnection(sourceConfig), transferDatabaseTypeForConnection(targetConfig));
  return presentKinds.filter((k) => k !== "TABLE" && !allowed.includes(k));
});

const objectSelectionSummary = computed(() => {
  if (transferDatabaseTypeForConnection(store.getConfig(sourceConnectionId.value)) !== "xugu") {
    return { selected: selectedTables.value.size, total: objectGroups.value.TABLE?.length ?? 0 };
  }
  const enabled = treeGroups.value.filter((group) => !treeDisabledGroups.value.includes(group.kind));
  return {
    selected: enabled.reduce((count, group) => count + group.items.filter((name) => selectedObjects.value[group.kind]?.has(name)).length, 0),
    total: enabled.reduce((count, group) => count + group.items.length, 0),
  };
});

const treeDisabledHints = computed<Record<string, string>>(() => {
  const hints: Record<string, string> = {};
  const dataOnly = transferContent.value === "dataOnly";
  for (const kind of treeDisabledGroups.value) {
    hints[kind] = dataOnly ? t("transfer.objectDataOnlyDisabled") : t("transfer.objectCrossFamilyDisabled");
  }
  return hints;
});

const showCrossFamilyViewHint = computed(() => {
  const sourceConfig = store.getConfig(sourceConnectionId.value);
  const targetConfig = store.getConfig(targetConnectionId.value);
  if (transferContent.value === "dataOnly") return false;
  if (!sourceConfig || !targetConfig) return false;
  const allowed = crossFamilyTransferableKinds(transferDatabaseTypeForConnection(sourceConfig), transferDatabaseTypeForConnection(targetConfig));
  if (!allowed.includes("VIEW")) return false;
  return !isSameTransferFamily(transferDatabaseTypeForConnection(sourceConfig), transferDatabaseTypeForConnection(targetConfig)) && (selectedObjects.value.VIEW?.size ?? 0) > 0;
});
// 「批量录入」允许的 schema.table / db.table 前缀：取当前源已选的 catalog / 库 / schema，
// 便于用户从其他工具粘贴带前缀的对象名；全为空时前端退化为只按对象名匹配。
const objectQualifiers = computed(() => [sourceCatalog.value, sourceDatabase.value, sourceSchema.value].filter((value) => value.trim().length > 0));

const pendingSourceSchemaPrefill = ref("");
const pendingSelectedTablesPrefill = ref<string[] | null>(null);
// Pending object selection for saved-task loading (covers all object kinds,
// unlike the table-only dialog prefill used by sidebar entry points).
const pendingSelectedObjectsPrefill = ref<Partial<Record<TransferObjectKind, string[]>> | null>(null);
// Saved-task per-table filters, applied together with the object selection once the tree loads.
const pendingTableFiltersPrefill = ref<Record<string, string> | null>(null);

// Target state
const targetConnectionId = ref("");
const targetCatalog = ref("");
const targetCatalogs = ref<CatalogInfo[]>([]);
const targetDatabase = ref("");
const targetDatabases = ref<string[]>([]);
const targetSchemas = ref<string[]>([]);
const targetSchema = ref("");
const pendingTargetSchemaPrefill = ref("");

// Options
const selectedStrategy = ref<TransferStrategy>("append");
const targetTableStrategy = computed<TransferStrategy>({
  // Structure-only transfers have no table-data operation, but overwrite is
  // still meaningful for selected schema objects (for example MySQL routines).
  // Keep upsert unavailable in this mode while preserving an explicit overwrite.
  get: () => (transferContent.value === "structureOnly" && (selectedStrategy.value === "upsert" || (selectedStrategy.value === "overwrite" && !structureOverwriteSupported())) ? "append" : selectedStrategy.value),
  set: (value) => {
    selectedStrategy.value = value;
  },
});
const targetTableNameCase = ref<TransferTableNameCase>("preserve");
const targetColumnNameCase = ref<TransferColumnNameCase>("preserve");
const quoteTargetColumnNames = ref(true);
const batchSize = ref(1000);
const operationTimeoutMode = ref<"inherit" | "custom">("inherit");
const operationTimeoutSecs = ref(DEFAULT_TRANSFER_OPERATION_TIMEOUT_SECS);
const showSqlPreviewConfirm = ref(false);
// Per-source-table filter: table name -> bare WHERE predicate or full SELECT.
const tableFilters = ref<Record<string, string>>({});
const filterDialogOpen = ref(false);
const filterEditingTable = ref("");
const filterDraft = ref("");
const isSubmitting = ref(false);
const pendingTransferId = ref<string | null>(null);
const showStartConfirm = ref(false);
const confirmationRequest = shallowRef<api.TransferRequest | null>(null);
const confirmationPreview = shallowRef<api.TransferOwnershipPreview | null>(null);
const packageDeployment = shallowRef<OracleRoutineDeployment | null>(null);
const packagePreparedInput = shallowRef<OracleRoutinePlanInput | null>(null);
const packageComparisonLoading = ref(false);
const packagePreviewTab = ref("routines");
const packageTableName = ref("");
const packageTablePreview = computed(() => confirmationPreview.value?.structure?.tables.find((table) => table.sourceTable === packageTableName.value) ?? confirmationPreview.value?.structure?.tables[0]);
const savedPackageDrafts = shallowRef<{ context: string; drafts: TransferPackageDraft[] } | null>(null);
const packageDraftSql = computed(() => packageDeployment.value?.drafts.find((draft) => draft.objectId === packageDeployment.value?.selectedObjectId)?.sql ?? "");
const packageReady = computed(() => {
  const state = packageDeployment.value;
  const preview = confirmationPreview.value?.oraclePackages;
  return !packageComparisonLoading.value && (!state || (!state.disposed && !state.validating && !state.error && (!!state.plan?.ready || (!!preview && oraclePackageTransferPendingReady(state, preview)))));
});
let resolveTransferConfirmation: ((confirmed: boolean) => void) | undefined;
const ownershipDialogOpen = ref(false);
const ownershipMissingOwners = ref<string[]>([]);
const ownershipTargetOwner = ref("");
let resolveOwnershipConfirmation: ((policy: api.TransferOwnershipPolicy | null) => void) | undefined;
const transferSubmission = createTransferSubmission({
  ensureWritable: (request) => ensureReadOnlyWriteAccess({ connection: store.getConfig(request.targetConnectionId), source: t("readOnlyUnlock.sourceTransfer"), treatAsMutation: true }),
  preview: api.previewTransferOwnership,
  confirmOwnership: requestOwnershipConfirmation,
  confirm: requestTransferConfirmation,
  execute: (request) => runTransfer(request, request.content !== "dataOnly"),
});

// Saved-task state: the form mirrors the active task; a canonical JSON
// snapshot taken at load/save time drives the unsaved-changes check.
const taskTreeRef = ref<InstanceType<typeof TransferTaskTree> | null>(null);
const activeTaskId = ref<string | null>(null);
const savedConfigSnapshot = ref("");
const showUnsavedConfirm = ref(false);
let pendingDiscardAction: (() => void) | null = null;
const taskLoadTracker = createTaskLoadTracker();

function connectionType(id: string): DatabaseType | undefined {
  return store.connections.find((c) => c.id === id)?.db_type;
}

// Keep in sync with `transfer_table_filter_supported` in dbx-core.
const tableFilterSupported = computed(() => {
  const type = connectionType(sourceConnectionId.value);
  return type === "mysql" || type === "gbase" || type === "postgres" || type === "kingbase" || type === "gaussdb" || type === "opengauss" || type === "kwdb";
});

const activeTableFilterCount = computed(() => selectedTableList.value.filter((table) => (tableFilters.value[table] ?? "").trim().length > 0).length);

function openTableFilter(table: string) {
  filterEditingTable.value = table;
  filterDraft.value = tableFilters.value[table] ?? "";
  filterDialogOpen.value = true;
}

function clearTableFilter(table: string) {
  if (!(table in tableFilters.value)) return;
  const next = { ...tableFilters.value };
  delete next[table];
  tableFilters.value = next;
}

function saveTableFilter() {
  const table = filterEditingTable.value;
  if (!table) return;
  const value = filterDraft.value.trim();
  if (value) tableFilters.value = { ...tableFilters.value, [table]: value };
  else clearTableFilter(table);
  filterDialogOpen.value = false;
}

/** Filters for currently selected tables only; undefined when there are none. */
function requestedTableFilters(): Record<string, string> | undefined {
  const entries = Object.entries(tableFilters.value).filter(([table, value]) => selectedTables.value.has(table) && value.trim().length > 0);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

const sourceTransferType = computed(() => transferDatabaseTypeForConnection(store.getConfig(sourceConnectionId.value)));
const targetTransferType = computed(() => transferDatabaseTypeForConnection(store.getConfig(targetConnectionId.value)));
const isXuguTransferPair = computed(() => targetTransferType.value === "xugu" && (sourceTransferType.value === "xugu" || sourceTransferType.value === "mysql"));

function structureOverwriteSupported(): boolean {
  if (transferContent.value !== "structureOnly") return true;
  const hasNonTableObject = Object.entries(selectedObjects.value).some(([kind, names]) => kind !== "TABLE" && (names?.size ?? 0) > 0);
  return transferObjectFamily(sourceTransferType.value) === "mysql" && transferObjectFamily(targetTransferType.value) === "mysql" && hasNonTableObject;
}
// The table-name-case selector is hidden for Xugu pairs; reset any earlier choice so the
// blocking xuguPreserveTableNames hint cannot strand the user without a visible control.
watch(isXuguTransferPair, (isXuguPair) => {
  if (isXuguPair) {
    targetTableNameCase.value = "preserve";
    targetColumnNameCase.value = "preserve";
  }
});
const targetStrategyType = computed(() => (targetTransferType.value === "xugu" ? "xugu" : connectionType(targetConnectionId.value)));
const xuguTransferHint = computed(() => {
  if (sourceTransferType.value === "xugu" || targetTransferType.value === "xugu") {
    if (!isTransferPairSupported(sourceTransferType.value, targetTransferType.value)) return t("transfer.xuguPairOnly");
    if (targetTableStrategy.value === "upsert" || targetTableStrategy.value === "rebuild") return t("transfer.xuguAppendOverwriteOnly");
    if (transferContent.value !== "dataOnly" && targetTableNameCase.value !== "preserve") return t("transfer.xuguPreserveTableNames");
  }
  return "";
});

function isMongoConnection(id: string): boolean {
  return connectionType(id) === "mongodb";
}

const showTargetColumnQuoteOption = computed(() => ["gaussdb", "opengauss"].includes(connectionType(targetConnectionId.value) ?? ""));

const rebuildDisabledReason = computed(() => rebuildUnavailableReason(transferContent.value, targetStrategyType.value));
const upsertSupported = computed(() => supportsTransferUpsert(targetStrategyType.value));
const rebuildDisabledHint = computed(() => {
  if (rebuildDisabledReason.value === "dataOnly") return t("transfer.rebuildDataOnlyDisabled");
  if (rebuildDisabledReason.value === "unsupported") return t("transfer.rebuildUnsupportedDisabled");
  return "";
});

function isCatalogCapable(id: string): boolean {
  const config = store.getConfig(id);
  return isDorisFamilyCatalogCapable(config?.db_type, config?.driver_profile);
}

function decodedDatabase(connectionId: string, option: string): string {
  return decodeTransferDatabaseOption(connectionType(connectionId), option);
}

function encodedDatabase(connectionId: string, database: string): string {
  return encodeTransferDatabaseOptions(connectionType(connectionId), [database])[0] ?? "";
}

function databaseOptionLabel(connectionId: string, option: string): string {
  return formatDatabaseLabel(store.getConfig(connectionId), decodedDatabase(connectionId, option), {
    defaultDatabase: t("editor.defaultDatabase"),
    noDatabase: t("editor.noDatabase"),
  });
}

const sourceDatabaseName = computed(() => decodedDatabase(sourceConnectionId.value, sourceDatabase.value));
const targetDatabaseName = computed(() => decodedDatabase(targetConnectionId.value, targetDatabase.value));
const operationTimeoutValid = computed(() => operationTimeoutMode.value === "inherit" || (Number.isInteger(operationTimeoutSecs.value) && operationTimeoutSecs.value >= 0 && operationTimeoutSecs.value <= MAX_QUERY_TIMEOUT_SECS));

function connectionQueryTimeoutSecs(connectionId: string): number {
  const value = store.getConfig(connectionId)?.query_timeout_secs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : DEFAULT_QUERY_TIMEOUT_SECS;
}

function formatOperationTimeout(timeoutSecs: number): string {
  return timeoutSecs === 0 ? t("transfer.operationTimeoutUnlimited") : t("transfer.operationTimeoutSeconds", { seconds: timeoutSecs });
}

const operationTimeoutHint = computed(() => {
  if (operationTimeoutMode.value === "custom") {
    return operationTimeoutSecs.value === 0 ? t("transfer.operationTimeoutCustomUnlimitedHint") : t("transfer.operationTimeoutCustomHint", { seconds: operationTimeoutSecs.value });
  }
  return t("transfer.operationTimeoutInheritedHint", {
    source: formatOperationTimeout(connectionQueryTimeoutSecs(sourceConnectionId.value)),
    target: formatOperationTimeout(connectionQueryTimeoutSecs(targetConnectionId.value)),
  });
});

const canStart = computed(() => {
  if (mysqlDataCharsetEnabled(store.getConfig(sourceConnectionId.value)) || mysqlDataCharsetEnabled(store.getConfig(targetConnectionId.value))) return false;
  const effectiveSourceSchema = sourceSchema.value || sourceDatabaseName.value;
  const effectiveTargetSchema = targetSchema.value || targetDatabaseName.value;
  const sameCatalogAndDatabase = isSameTransferDatabase(
    { connectionId: sourceConnectionId.value, catalog: sourceCatalog.value, catalogs: sourceCatalogs.value, database: sourceDatabaseName.value },
    { connectionId: targetConnectionId.value, catalog: targetCatalog.value, catalogs: targetCatalogs.value, database: targetDatabaseName.value },
  );
  const sameSourceAndTarget = sameCatalogAndDatabase && effectiveSourceSchema === effectiveTargetSchema;
  return (
    !!sourceConnectionId.value &&
    isTransferPairSupported(sourceTransferType.value, targetTransferType.value) &&
    !xuguTransferHint.value &&
    isTransferDatabaseSelected(sourceDatabase.value) &&
    !!targetConnectionId.value &&
    isTransferDatabaseSelected(targetDatabase.value) &&
    (sourceCatalogs.value.length <= 1 || !!sourceCatalog.value) &&
    (targetCatalogs.value.length <= 1 || !!targetCatalog.value) &&
    (selectedTables.value.size > 0 || Object.values(selectedObjects.value).some((names) => names.size > 0)) &&
    (targetTableStrategy.value !== "rebuild" || !rebuildDisabledReason.value) &&
    (transferContent.value === "structureOnly" || targetTableStrategy.value !== "upsert" || upsertSupported.value) &&
    operationTimeoutValid.value &&
    !sameSourceAndTarget
  );
});

async function loadCatalogs(connectionId: string, side: "source" | "target", isCancelled: () => boolean = () => false) {
  if (!connectionId || !isCatalogCapable(connectionId)) {
    if (side === "source") {
      sourceCatalogs.value = [];
      sourceCatalog.value = "";
    } else {
      targetCatalogs.value = [];
      targetCatalog.value = "";
    }
    return;
  }
  // 竞态防护：请求发出后若用户切换了连接，旧连接的回调必须丢弃，
  // 不允许过期结果覆盖新选择（一切以最新选择的连接为准）。
  const isStale = () => isCancelled() || (side === "source" ? sourceConnectionId.value !== connectionId : targetConnectionId.value !== connectionId);
  try {
    const catalogs = await api.listDorisCatalogs(connectionId);
    if (isStale()) return;
    if (side === "source") {
      sourceCatalogs.value = catalogs;
      sourceCatalog.value = catalogs.length === 1 ? catalogs[0].name : "";
    } else {
      targetCatalogs.value = catalogs;
      targetCatalog.value = catalogs.length === 1 ? catalogs[0].name : "";
    }
  } catch {
    if (isStale()) return;
    if (side === "source") {
      sourceCatalogs.value = [];
      sourceCatalog.value = "";
    } else {
      targetCatalogs.value = [];
      targetCatalog.value = "";
    }
  }
}

async function loadDatabases(connectionId: string, target: "source" | "target", isCancelled: () => boolean = () => false) {
  if (!connectionId) return;
  // 竞态防护：连接切换后，旧连接的数据库列表回调直接丢弃。
  const isStale = () => isCancelled() || (target === "source" ? sourceConnectionId.value !== connectionId : targetConnectionId.value !== connectionId);
  try {
    await store.ensureConnected(connectionId);
    const config = store.getConfig(connectionId);
    if (!config) return;
    const names = isMongoConnection(connectionId) ? databaseOptionsForConnection(await api.mongoListDatabases(connectionId), config) : await fetchNamespaceOptionsForConnection(connectionId, config);
    const options = encodeTransferDatabaseOptions(config.db_type, names);
    if (isStale()) return;
    if (target === "source") {
      sourceDatabases.value = options;
      sourceDatabase.value = options.length === 1 ? options[0] : "";
    } else {
      targetDatabases.value = options;
      targetDatabase.value = options.length === 1 ? options[0] : "";
    }
  } catch {
    if (isStale()) return;
    if (target === "source") sourceDatabases.value = [];
    else targetDatabases.value = [];
  }
}

async function loadDatabasesForCatalog(connectionId: string, catalog: string, target: "source" | "target", isCancelled: () => boolean = () => false) {
  if (!connectionId || !catalog) return;
  // 竞态防护：连接或 catalog 切换后，旧请求的数据库列表回调直接丢弃。
  const isStale = () => {
    const currentConnection = target === "source" ? sourceConnectionId.value : targetConnectionId.value;
    const currentCatalog = target === "source" ? sourceCatalog.value : targetCatalog.value;
    return isCancelled() || currentConnection !== connectionId || currentCatalog !== catalog;
  };
  try {
    await store.ensureConnected(connectionId);
    const config = store.getConfig(connectionId);
    if (!config) return;
    const names = await fetchCatalogNamespaceOptions(connectionId, catalog, config);
    const options = encodeTransferDatabaseOptions(config.db_type, names);
    if (isStale()) return;
    if (target === "source") {
      sourceDatabases.value = options;
      sourceDatabase.value = options.length === 1 ? options[0] : "";
    } else {
      targetDatabases.value = options;
      targetDatabase.value = options.length === 1 ? options[0] : "";
    }
  } catch {
    if (isStale()) return;
    if (target === "source") sourceDatabases.value = [];
    else targetDatabases.value = [];
  }
}

async function loadSchemas(connectionId: string, database: string, side: "source" | "target", preferredSchema = "", isCancelled: () => boolean = () => false) {
  if (!connectionId) return;
  // 竞态防护：连接或数据库切换后，旧请求的 schema 列表回调直接丢弃。
  const isStale = () => {
    const currentConnection = side === "source" ? sourceConnectionId.value : targetConnectionId.value;
    const currentDatabase = side === "source" ? sourceDatabaseName.value : targetDatabaseName.value;
    return isCancelled() || currentConnection !== connectionId || currentDatabase !== database;
  };
  if (isMongoConnection(connectionId)) {
    if (isStale()) return;
    if (side === "source") {
      sourceSchemas.value = [];
      sourceSchema.value = database;
    } else {
      targetSchemas.value = [];
      targetSchema.value = database;
    }
    return;
  }
  try {
    const schemas = transferSchemasForDatabase(transferDatabaseTypeForConnection(store.getConfig(connectionId)), await api.listSchemas(connectionId, database));
    if (isStale()) return;
    const selected = preferredSchema && schemas.includes(preferredSchema) ? preferredSchema : schemas.includes("public") ? "public" : (schemas[0] ?? "");
    if (side === "source") {
      sourceSchemas.value = schemas;
      sourceSchema.value = selected;
    } else {
      targetSchemas.value = schemas;
      targetSchema.value = selected;
    }
  } catch {
    if (isStale()) return;
    if (side === "source") {
      sourceSchemas.value = [];
      sourceSchema.value = "";
    } else {
      targetSchemas.value = [];
      targetSchema.value = "";
    }
  }
}

function applyPendingTableSelection() {
  const pending = pendingSelectedTablesPrefill.value;
  const tables = objectGroups.value.TABLE ?? [];
  if (pending) {
    const chosen = new Set(tables.filter((table) => pending.includes(table)));
    if (chosen.size > 0) {
      selectedObjects.value = { ...selectedObjects.value, TABLE: chosen };
    }
  }
  pendingSelectedTablesPrefill.value = null;
}

/** Applies a saved task's object selection and per-table filters, dropping missing objects. */
function applyPendingObjectSelection() {
  const pending = pendingSelectedObjectsPrefill.value;
  if (pending) {
    const next: Partial<Record<TransferObjectKind, Set<string>>> = { ...selectedObjects.value };
    for (const [kind, names] of Object.entries(pending)) {
      const available = objectGroups.value[kind as TransferObjectKind] ?? [];
      const chosen = new Set(available.filter((name) => names.includes(name)));
      if (chosen.size > 0) next[kind as TransferObjectKind] = chosen;
    }
    selectedObjects.value = next;
    pendingSelectedObjectsPrefill.value = null;
  }

  const restoredFilters = pendingTableFiltersPrefill.value;
  if (restoredFilters) {
    const available = new Set(objectGroups.value.TABLE ?? []);
    const nextFilters: Record<string, string> = {};
    for (const [table, value] of Object.entries(restoredFilters)) {
      if (available.has(table) && value.trim().length > 0) nextFilters[table] = value;
    }
    tableFilters.value = nextFilters;
    pendingTableFiltersPrefill.value = null;
  }
}

async function loadObjects(isCancelled: () => boolean = () => false) {
  const connectionId = sourceConnectionId.value;
  const databaseOption = sourceDatabase.value;
  const database = sourceDatabaseName.value;
  if (!connectionId || !isTransferDatabaseSelected(databaseOption)) {
    objectGroups.value = {};
    return;
  }
  // 竞态防护：捕获发起时的上下文快照，加载期间用户切换连接/数据库/Schema 后，
  // 旧请求的对象列表回调直接丢弃，不覆盖新选择对应的状态。
  const catalog = sourceCatalog.value || undefined;
  const schemaValue = sourceSchema.value;
  const isStale = () => isCancelled() || sourceConnectionId.value !== connectionId || sourceDatabase.value !== databaseOption || (sourceCatalog.value || undefined) !== catalog || sourceSchema.value !== schemaValue;
  loadingObjects.value = true;
  try {
    if (isMongoConnection(connectionId)) {
      const collections = await api.mongoListCollections(connectionId, database);
      if (isStale()) return;
      objectGroups.value = { TABLE: collections.map((c) => c.name) };
      applyPendingTableSelection();
      applyPendingObjectSelection();
      return;
    }
    const config = store.getConfig(connectionId);
    const needsSchema = isSchemaAware(config?.db_type);
    const schema = needsSchema && schemaValue ? schemaValue : database;
    const kinds = transferObjectKindsForDatabase(transferDatabaseTypeForConnection(config));
    const groups: Partial<Record<TransferObjectKind, string[]>> = {};
    const xuguLoadFailures: string[] = [];
    for (const kind of kinds) {
      try {
        if (kind === "TABLE") {
          const tables = await api.listTables(connectionId, database, schema, undefined, undefined, undefined, undefined, catalog);
          groups.TABLE = tables.filter((t) => t.table_type === "TABLE" || t.table_type === "BASE TABLE").map((t) => t.name);
        } else {
          const objects = await api.listObjects(connectionId, database, schema, [kind], undefined, undefined, undefined, catalog);
          groups[kind] = objects.map((o) => o.name);
        }
      } catch (error) {
        groups[kind] = [];
        if (transferDatabaseTypeForConnection(config) === "xugu") xuguLoadFailures.push(`${kind}: ${String(error)}`);
      }
    }
    if (isStale()) return;
    if (xuguLoadFailures.length) toast(xuguLoadFailures.join("\n"), 8000);
    objectGroups.value = groups;
    applyPendingTableSelection();
    applyPendingObjectSelection();
  } catch {
    if (!isStale()) objectGroups.value = {};
  } finally {
    if (!isStale()) loadingObjects.value = false;
  }
}

const skipSourceWatch = ref(false);
const skipTargetWatch = ref(false);
// One-shot watcher suppression used when applying a saved task: every flag is
// consumed by its watcher so task loading can drive the form deterministically
// with explicit awaits instead of racing the async watcher chain.
const skipSourceCatalogWatch = ref(false);
const skipSourceDatabaseWatch = ref(false);
const skipSourceSchemaWatch = ref(false);
const skipTargetCatalogWatch = ref(false);
const skipTargetDatabaseWatch = ref(false);

watch(sourceConnectionId, async (id) => {
  if (skipSourceWatch.value) {
    skipSourceWatch.value = false;
    return;
  }
  sourceCatalog.value = "";
  sourceCatalogs.value = [];
  sourceDatabase.value = "";
  objectGroups.value = {};
  selectedObjects.value = {};
  tableFilters.value = {};
  pendingSourceSchemaPrefill.value = "";
  pendingSelectedTablesPrefill.value = null;
  if (isCatalogCapable(id)) {
    await loadCatalogs(id, "source");
    // await 期间连接可能已被切换，旧链直接放弃，后续加载由新连接的 watcher 负责
    if (sourceConnectionId.value !== id) return;
    if (sourceCatalog.value) {
      await loadDatabasesForCatalog(id, sourceCatalog.value, "source");
    }
  } else {
    await loadDatabases(id, "source");
  }
});

watch(sourceCatalog, async (catalog) => {
  if (skipSourceCatalogWatch.value) {
    skipSourceCatalogWatch.value = false;
    return;
  }
  if (!sourceConnectionId.value) return;
  sourceDatabase.value = "";
  objectGroups.value = {};
  selectedObjects.value = {};
  tableFilters.value = {};
  if (catalog) {
    await loadDatabasesForCatalog(sourceConnectionId.value, catalog, "source");
  }
});

watch(sourceDatabase, async (db) => {
  if (skipSourceDatabaseWatch.value) {
    skipSourceDatabaseWatch.value = false;
    return;
  }
  tableFilters.value = {};
  if (isTransferDatabaseSelected(db)) {
    const config = store.getConfig(sourceConnectionId.value);
    const database = sourceDatabaseName.value;
    if (namespaceOptionsAreSchemas(config)) {
      // Dameng has no selectable catalog, so the top-level namespace option is
      // also the schema used for metadata lookup and qualified transfer SQL.
      sourceSchemas.value = [];
      sourceSchema.value = database;
    } else if (isSchemaAware(config?.db_type)) {
      await loadSchemas(sourceConnectionId.value, database, "source", pendingSourceSchemaPrefill.value);
      pendingSourceSchemaPrefill.value = "";
    } else {
      sourceSchema.value = database;
    }
  }
});

watch(sourceSchema, () => {
  if (skipSourceSchemaWatch.value) {
    skipSourceSchemaWatch.value = false;
    return;
  }
  tableFilters.value = {};
  loadObjects();
});

watch(targetConnectionId, async (id) => {
  if (skipTargetWatch.value) {
    skipTargetWatch.value = false;
    return;
  }
  targetCatalog.value = "";
  targetCatalogs.value = [];
  targetDatabase.value = "";
  targetSchemas.value = [];
  targetSchema.value = "";
  pendingTargetSchemaPrefill.value = "";
  if (isCatalogCapable(id)) {
    await loadCatalogs(id, "target");
    // await 期间连接可能已被切换，旧链直接放弃，后续加载由新连接的 watcher 负责
    if (targetConnectionId.value !== id) return;
    if (targetCatalog.value) {
      await loadDatabasesForCatalog(id, targetCatalog.value, "target");
    }
  } else {
    await loadDatabases(id, "target");
  }
});

watch(targetCatalog, async (catalog) => {
  if (skipTargetCatalogWatch.value) {
    skipTargetCatalogWatch.value = false;
    return;
  }
  if (!targetConnectionId.value) return;
  targetDatabase.value = "";
  targetSchemas.value = [];
  targetSchema.value = "";
  if (catalog) {
    await loadDatabasesForCatalog(targetConnectionId.value, catalog, "target");
  }
});

watch(targetDatabase, async (db) => {
  if (skipTargetDatabaseWatch.value) {
    skipTargetDatabaseWatch.value = false;
    return;
  }
  if (isTransferDatabaseSelected(db)) {
    const config = store.getConfig(targetConnectionId.value);
    const database = targetDatabaseName.value;
    if (namespaceOptionsAreSchemas(config)) {
      targetSchemas.value = [];
      targetSchema.value = database;
    } else if (isSchemaAware(config?.db_type)) {
      await loadSchemas(targetConnectionId.value, database, "target", pendingTargetSchemaPrefill.value);
      pendingTargetSchemaPrefill.value = "";
    } else {
      targetSchema.value = database;
    }
  }
});

async function applyTransferPrefill() {
  resetState();
  pendingSourceSchemaPrefill.value = props.prefillSchema ?? "";
  pendingSelectedTablesPrefill.value = props.prefillTables?.length ? [...props.prefillTables] : null;
  pendingTargetSchemaPrefill.value = props.prefillTargetSchema ?? "";
  if (props.prefillConnectionId) {
    skipSourceWatch.value = true;
    sourceConnectionId.value = props.prefillConnectionId;
    if (isCatalogCapable(props.prefillConnectionId)) {
      await loadCatalogs(props.prefillConnectionId, "source");
      if (props.prefillCatalog) {
        sourceCatalog.value = props.prefillCatalog;
      }
      if (sourceCatalog.value) {
        await loadDatabasesForCatalog(props.prefillConnectionId, sourceCatalog.value, "source");
      }
    } else {
      await loadDatabases(props.prefillConnectionId, "source");
    }
    if (props.prefillDatabase !== undefined) sourceDatabase.value = encodedDatabase(props.prefillConnectionId, props.prefillDatabase);
  }
  if (props.prefillTargetConnectionId) {
    skipTargetWatch.value = true;
    targetConnectionId.value = props.prefillTargetConnectionId;
    if (isCatalogCapable(props.prefillTargetConnectionId)) {
      await loadCatalogs(props.prefillTargetConnectionId, "target");
      if (targetCatalog.value) {
        await loadDatabasesForCatalog(props.prefillTargetConnectionId, targetCatalog.value, "target");
      }
    } else {
      await loadDatabases(props.prefillTargetConnectionId, "target");
    }
    if (props.prefillTargetDatabase !== undefined) targetDatabase.value = encodedDatabase(props.prefillTargetConnectionId, props.prefillTargetDatabase);
  }
}

watch(
  [open, () => props.taskId],
  async ([val, taskId]) => {
    if (!val || taskId) return;
    void taskStore.initFromStorage();
    if (currentConfig().oraclePackageDrafts?.length) {
      const sameContext = [
        [props.prefillConnectionId, sourceConnectionId.value],
        [props.prefillDatabase, sourceDatabaseName.value],
        [props.prefillCatalog, sourceCatalog.value],
        [props.prefillSchema, sourceSchema.value || sourceDatabaseName.value],
        [props.prefillTargetConnectionId, targetConnectionId.value],
        [props.prefillTargetDatabase, targetDatabaseName.value],
        [props.prefillTargetSchema, targetSchema.value || targetDatabaseName.value],
      ].every(([requested, current]) => !requested || requested === current);
      if (sameContext && !props.prefillTables?.length) return;
      requestDiscardableAction(() => {
        void applyTransferPrefill();
      });
      return;
    }
    await applyTransferPrefill();
  },
  { immediate: true },
);

function resetState(cancelTaskLoad = true) {
  if (cancelTaskLoad) taskLoadTracker.cancel();
  cancelPendingTransfer();
  packageDeployment.value = null;
  savedPackageDrafts.value = null;
  sourceConnectionId.value = "";
  sourceCatalog.value = "";
  sourceCatalogs.value = [];
  sourceDatabase.value = "";
  sourceDatabases.value = [];
  sourceSchemas.value = [];
  sourceSchema.value = "";
  objectGroups.value = {};
  selectedObjects.value = {};
  loadingObjects.value = false;
  pendingSourceSchemaPrefill.value = "";
  pendingSelectedTablesPrefill.value = null;
  objectSearch.value = "";
  targetConnectionId.value = "";
  targetCatalog.value = "";
  targetCatalogs.value = [];
  targetDatabase.value = "";
  targetDatabases.value = [];
  targetSchemas.value = [];
  targetSchema.value = "";
  pendingTargetSchemaPrefill.value = "";
  transferContent.value = "structureAndData";
  selectedStrategy.value = "append";
  targetTableNameCase.value = "preserve";
  targetColumnNameCase.value = "preserve";
  quoteTargetColumnNames.value = true;
  batchSize.value = 1000;
  operationTimeoutMode.value = "inherit";
  operationTimeoutSecs.value = DEFAULT_TRANSFER_OPERATION_TIMEOUT_SECS;
  tableFilters.value = {};
  filterDialogOpen.value = false;
  filterEditingTable.value = "";
  filterDraft.value = "";
  pendingSelectedObjectsPrefill.value = null;
  pendingTableFiltersPrefill.value = null;
  activeTaskId.value = null;
  savedConfigSnapshot.value = "";
}

/**
 * 交换源和目标两侧：连接、Catalog、数据库、Schema 的选择随各自一侧整体互换，
 * 一次点击即可反转传输方向。对象树只属于源端，旧选择作废，按新源端重新加载。
 */
function swapSourceAndTarget() {
  const sourceState = {
    connectionId: sourceConnectionId.value,
    catalog: sourceCatalog.value,
    catalogs: sourceCatalogs.value,
    database: sourceDatabase.value,
    databases: sourceDatabases.value,
    schema: sourceSchema.value,
    schemas: sourceSchemas.value,
  };
  const targetState = {
    connectionId: targetConnectionId.value,
    catalog: targetCatalog.value,
    catalogs: targetCatalogs.value,
    database: targetDatabase.value,
    databases: targetDatabases.value,
    schema: targetSchema.value,
    schemas: targetSchemas.value,
  };

  if (sourceState.connectionId === targetState.connectionId && sourceState.catalog === targetState.catalog && sourceState.database === targetState.database && sourceState.schema === targetState.schema) {
    // 两侧选择完全相同（含都未选择）时交换没有意义
    return;
  }

  // 若正在加载已保存任务，先取消，避免任务加载链覆盖交换后的状态
  taskLoadTracker.cancel();
  pendingSourceSchemaPrefill.value = "";
  pendingTargetSchemaPrefill.value = "";
  pendingSelectedTablesPrefill.value = null;
  pendingSelectedObjectsPrefill.value = null;

  // 只在值确实变化时设置一次性跳过标记：标记由对应 watcher 消费，
  // 若值未变则 watcher 不会触发，残留标记会误吞后续一次真实变更。
  if (sourceConnectionId.value !== targetState.connectionId) {
    skipSourceWatch.value = true;
    sourceConnectionId.value = targetState.connectionId;
  }
  if (sourceCatalog.value !== targetState.catalog) {
    skipSourceCatalogWatch.value = true;
    sourceCatalog.value = targetState.catalog;
  }
  sourceCatalogs.value = targetState.catalogs;
  if (sourceDatabase.value !== targetState.database) {
    skipSourceDatabaseWatch.value = true;
    sourceDatabase.value = targetState.database;
  }
  sourceDatabases.value = targetState.databases;
  if (sourceSchema.value !== targetState.schema) {
    skipSourceSchemaWatch.value = true;
    sourceSchema.value = targetState.schema;
  }
  sourceSchemas.value = targetState.schemas;

  if (targetConnectionId.value !== sourceState.connectionId) {
    skipTargetWatch.value = true;
    targetConnectionId.value = sourceState.connectionId;
  }
  if (targetCatalog.value !== sourceState.catalog) {
    skipTargetCatalogWatch.value = true;
    targetCatalog.value = sourceState.catalog;
  }
  targetCatalogs.value = sourceState.catalogs;
  if (targetDatabase.value !== sourceState.database) {
    skipTargetDatabaseWatch.value = true;
    targetDatabase.value = sourceState.database;
  }
  targetDatabases.value = sourceState.databases;
  targetSchema.value = sourceState.schema;
  targetSchemas.value = sourceState.schemas;

  // 对象树始终跟随源端：新源端是旧目标端，旧选择已无意义，清空后重新加载
  objectGroups.value = {};
  selectedObjects.value = {};
  tableFilters.value = {};
  objectSearch.value = "";
  void loadObjects();
}

async function requestStartTransfer() {
  if (!canStart.value || isSubmitting.value) return;
  isSubmitting.value = true;

  const effectiveSourceSchema = sourceSchema.value || sourceDatabaseName.value;
  const effectiveTargetSchema = targetSchema.value || targetDatabaseName.value;
  const sourceDatabase = sourceDatabaseName.value;
  const targetConnection = targetConnectionId.value;
  const targetDatabase = targetDatabaseName.value;
  const request: api.TransferRequest = {
    transferId: uuid(),
    sourceConnectionId: sourceConnectionId.value,
    sourceDatabase,
    sourceSchema: effectiveSourceSchema,
    sourceCatalog: normalizeTransferCatalog(sourceCatalog.value, sourceCatalogs.value) || undefined,
    targetConnectionId: targetConnection,
    targetDatabase,
    targetSchema: effectiveTargetSchema,
    targetCatalog: normalizeTransferCatalog(targetCatalog.value, targetCatalogs.value) || undefined,
    tables: [...selectedTables.value],
    createTable: transferContent.value !== "dataOnly",
    content: transferContent.value,
    ...buildTransferObjectSelectionField(selectedObjects.value, treeDisabledGroups.value),
    ...transferStrategyOptions(targetTableStrategy.value),
    targetTableNameCase: targetTableNameCase.value,
    targetColumnNameCase: targetColumnNameCase.value,
    quoteTargetColumnNames: quoteTargetColumnNames.value,
    ownershipPolicy: "preserve",
    batchSize: batchSize.value,
    operationTimeoutSecs: operationTimeoutMode.value === "custom" ? operationTimeoutSecs.value : undefined,
    tableFilters: requestedTableFilters(),
    dropTargetConfirmed: false,
  };
  if (request.content !== "dataOnly") {
    for (const kind of ["PACKAGE", "PACKAGE_BODY"] as const) {
      const names = currentConfig().objects[kind];
      if (!names?.length) continue;
      const selection = request.objects.find((selection) => selection.objectType === kind);
      if (selection) selection.names = [...names];
      else request.objects.push({ objectType: kind, names: [...names] });
    }
  }
  pendingTransferId.value = request.transferId;
  try {
    await transferSubmission.start(request);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast(transferPreviewFailureMessage(message), 5000);
  } finally {
    if (pendingTransferId.value === request.transferId) {
      pendingTransferId.value = null;
      isSubmitting.value = false;
    }
  }
}

function runTransfer(request: api.TransferRequest, shouldRefreshTargetTree: boolean) {
  isSubmitting.value = true;
  rememberTransferPackageDrafts();
  const deployment = packageDeployment.value;
  startDataTransferTask(request, `${request.sourceDatabase} → ${request.targetDatabase}`, {
    oracleRoutineDeployment: deployment ?? undefined,
    onRemove: deployment
      ? () => {
          void disposeOracleRoutineDeployment(deployment);
        }
      : undefined,
    formatOverlapError: (tables) => t("transfer.targetTableBusy", { tables: tables.join(", ") }),
    onStarted: () => toast(t("transfer.backgroundStarted")),
    onOpen: () => openDataTransferTask(request.transferId),
    onDone: async () => {
      if (shouldRefreshTargetTree) {
        await store.refreshObjectListTreeNode(request.targetConnectionId, request.targetDatabase, request.targetSchema, request.targetCatalog);
      }
    },
  });
  // The background task now owns the same retained approvals and editable
  // results; closing this form must not release them before the server claims.
  packageDeployment.value = null;
  open.value = false;
  resetState();
}

function requestOwnershipConfirmation(preview: api.TransferOwnershipPreview): Promise<api.TransferOwnershipPolicy | null> {
  ownershipMissingOwners.value = preview.missingOwners;
  ownershipTargetOwner.value = preview.targetOwner;
  ownershipDialogOpen.value = true;
  return new Promise((resolve) => {
    resolveOwnershipConfirmation = resolve;
  });
}

function resolveOwnershipDecision(policy: api.TransferOwnershipPolicy | null) {
  const resolve = resolveOwnershipConfirmation;
  resolveOwnershipConfirmation = undefined;
  ownershipDialogOpen.value = false;
  ownershipMissingOwners.value = [];
  ownershipTargetOwner.value = "";
  resolve?.(policy);
}

function getConnectionName(id: string) {
  return store.connections.find((c) => c.id === id)?.name ?? id;
}

// ---------------------------------------------------------------------------
// Saved transfer tasks (left tree panel)
// ---------------------------------------------------------------------------

const activeTaskName = computed(() => (activeTaskId.value ? (taskStore.getTask(activeTaskId.value)?.name ?? "") : ""));

/** Builds a serializable config from the current form state. */
function currentConfig(includePackageDrafts = true): TransferTaskConfig {
  const objects: TransferTaskConfig["objects"] = {};
  for (const [kind, names] of Object.entries(selectedObjects.value)) {
    if (names && names.size > 0) objects[kind as TransferObjectKind] = [...names];
  }
  const config: TransferTaskConfig = {
    sourceConnectionId: sourceConnectionId.value,
    sourceCatalog: normalizeTransferCatalog(sourceCatalog.value, sourceCatalogs.value) || undefined,
    sourceDatabase: sourceDatabaseName.value,
    sourceSchema: sourceSchema.value || undefined,
    targetConnectionId: targetConnectionId.value,
    targetCatalog: normalizeTransferCatalog(targetCatalog.value, targetCatalogs.value) || undefined,
    targetDatabase: targetDatabaseName.value,
    targetSchema: targetSchema.value || undefined,
    objects,
    content: transferContent.value,
    ...transferStrategyOptions(targetTableStrategy.value),
    targetTableNameCase: targetTableNameCase.value,
    targetColumnNameCase: targetColumnNameCase.value,
    quoteTargetColumnNames: quoteTargetColumnNames.value,
    batchSize: batchSize.value,
    operationTimeoutSecs: operationTimeoutMode.value === "custom" && operationTimeoutValid.value ? operationTimeoutSecs.value : undefined,
    tableFilters: requestedTableFilters(),
    dropTargetConfirmed: false,
  };
  if (includePackageDrafts) {
    const state = packageDeployment.value;
    const context = packageDraftContext(config);
    const drafts = state && !state.disposed && confirmationRequest.value && packageDraftContext(confirmationRequest.value) === context ? transferPackageDrafts(state) : savedPackageDrafts.value?.context === context ? savedPackageDrafts.value.drafts : undefined;
    const selectedDrafts = drafts?.filter((draft) => (draft.identity.kind === "PACKAGE" || draft.identity.kind === "PACKAGE_BODY") && config.objects[draft.identity.kind]?.includes(draft.sourceName ?? draft.identity.name));
    if (selectedDrafts?.length) {
      config.oraclePackageDrafts = selectedDrafts;
    }
  }
  return config;
}

/** Canonical serialization (sorted kinds/names) for stable dirty comparison. */
function configSnapshot(config: TransferTaskConfig) {
  const orderedObjects: Record<string, string[]> = {};
  for (const kind of Object.keys(config.objects).sort()) {
    orderedObjects[kind] = [...(config.objects[kind as TransferObjectKind] ?? [])].sort();
  }
  const orderedFilters = Object.fromEntries(Object.entries(config.tableFilters ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ ...config, objects: orderedObjects, tableFilters: orderedFilters });
}

const formHasContent = computed(() => !!sourceConnectionId.value || !!targetConnectionId.value);
const isConfigDirty = computed(() => !!activeTaskId.value && configSnapshot(currentConfig()) !== savedConfigSnapshot.value);
const needsDiscardConfirm = computed(() => isConfigDirty.value || (!activeTaskId.value && formHasContent.value));
const canSaveConfig = computed(() => !!sourceConnectionId.value && isTransferDatabaseSelected(sourceDatabase.value) && !!targetConnectionId.value && isTransferDatabaseSelected(targetDatabase.value) && operationTimeoutValid.value);

// Invalidate before asynchronous callbacks can publish a preview for an old form,
// including a task switch whose new values happen to equal the previous task.
let addingPackageCompanion = false;
watch(
  () => configSnapshot(currentConfig(false)),
  () => {
    if (!addingPackageCompanion) cancelPendingTransfer();
  },
  { flush: "sync" },
);
watch(activeTaskId, cancelPendingTransfer, { flush: "sync" });
watch(
  open,
  (isOpen) => {
    if (!isOpen) cancelPendingTransfer();
  },
  { flush: "sync" },
);
watch(
  () => {
    const connection = store.getConfig(targetConnectionId.value);
    return JSON.stringify([connection?.read_only, connection?.is_production, connection?.production_databases, mysqlDataCharsetEnabled(connection), mysqlDataCharsetEnabled(store.getConfig(sourceConnectionId.value))]);
  },
  cancelPendingTransfer,
  { flush: "sync" },
);
onBeforeUnmount(cancelPendingTransfer);

/** Applies a saved task to the form, loading catalogs/databases/schemas/objects with explicit awaits. */
async function loadTaskIntoForm(task: TransferTask) {
  const taskLoadToken = taskLoadTracker.begin(task.id);
  const isTaskLoadStale = () => !taskLoadTracker.isCurrent(taskLoadToken, activeTaskId.value);
  const config = task.config;
  resetState(false);
  activeTaskId.value = task.id;
  transferContent.value = config.content;
  selectedStrategy.value = resolveTransferStrategy(config);
  targetTableNameCase.value = config.targetTableNameCase;
  targetColumnNameCase.value = config.targetColumnNameCase ?? "preserve";
  quoteTargetColumnNames.value = config.quoteTargetColumnNames;
  batchSize.value = config.batchSize;
  operationTimeoutMode.value = config.operationTimeoutSecs === undefined ? "inherit" : "custom";
  operationTimeoutSecs.value = config.operationTimeoutSecs ?? DEFAULT_TRANSFER_OPERATION_TIMEOUT_SECS;
  pendingSelectedObjectsPrefill.value = Object.keys(config.objects).length > 0 ? JSON.parse(JSON.stringify(config.objects)) : null;
  pendingTableFiltersPrefill.value = config.tableFilters && Object.keys(config.tableFilters).length > 0 ? { ...config.tableFilters } : null;

  skipSourceWatch.value = true;
  sourceConnectionId.value = config.sourceConnectionId;
  if (isCatalogCapable(config.sourceConnectionId)) {
    await loadCatalogs(config.sourceConnectionId, "source", isTaskLoadStale);
    if (isTaskLoadStale()) return;
    if (config.sourceCatalog && sourceCatalog.value !== config.sourceCatalog) {
      skipSourceCatalogWatch.value = true;
      sourceCatalog.value = config.sourceCatalog;
    }
    if (sourceCatalog.value) {
      await loadDatabasesForCatalog(config.sourceConnectionId, sourceCatalog.value, "source", isTaskLoadStale);
      if (isTaskLoadStale()) return;
    }
  } else {
    await loadDatabases(config.sourceConnectionId, "source", isTaskLoadStale);
    if (isTaskLoadStale()) return;
  }
  const sourceConfig = store.getConfig(config.sourceConnectionId);
  const sourceDatabaseOption = encodedDatabase(config.sourceConnectionId, config.sourceDatabase);
  if (sourceDatabase.value !== sourceDatabaseOption) {
    skipSourceDatabaseWatch.value = true;
    sourceDatabase.value = sourceDatabaseOption;
  }
  if (namespaceOptionsAreSchemas(sourceConfig)) {
    sourceSchemas.value = [];
    sourceSchema.value = config.sourceDatabase;
  } else if (isSchemaAware(sourceConfig?.db_type)) {
    await loadSchemas(config.sourceConnectionId, config.sourceDatabase, "source", config.sourceSchema ?? "", isTaskLoadStale);
    if (isTaskLoadStale()) return;
  } else {
    sourceSchema.value = config.sourceDatabase;
  }
  // The schema watcher may trigger a concurrent loadObjects; both converge on
  // the same groups and the pending selection is consumed by the first one.
  await loadObjects(isTaskLoadStale);
  if (isTaskLoadStale()) return;

  skipTargetWatch.value = true;
  targetConnectionId.value = config.targetConnectionId;
  if (isCatalogCapable(config.targetConnectionId)) {
    await loadCatalogs(config.targetConnectionId, "target", isTaskLoadStale);
    if (isTaskLoadStale()) return;
    if (config.targetCatalog && targetCatalog.value !== config.targetCatalog) {
      skipTargetCatalogWatch.value = true;
      targetCatalog.value = config.targetCatalog;
    }
    if (targetCatalog.value) {
      await loadDatabasesForCatalog(config.targetConnectionId, targetCatalog.value, "target", isTaskLoadStale);
      if (isTaskLoadStale()) return;
    }
  } else {
    await loadDatabases(config.targetConnectionId, "target", isTaskLoadStale);
    if (isTaskLoadStale()) return;
  }
  const targetConfig = store.getConfig(config.targetConnectionId);
  const targetDatabaseOption = encodedDatabase(config.targetConnectionId, config.targetDatabase);
  if (targetDatabase.value !== targetDatabaseOption) {
    skipTargetDatabaseWatch.value = true;
    targetDatabase.value = targetDatabaseOption;
  }
  if (namespaceOptionsAreSchemas(targetConfig)) {
    targetSchemas.value = [];
    targetSchema.value = config.targetDatabase;
  } else if (isSchemaAware(targetConfig?.db_type)) {
    await loadSchemas(config.targetConnectionId, config.targetDatabase, "target", config.targetSchema ?? "", isTaskLoadStale);
    if (isTaskLoadStale()) return;
  } else {
    targetSchema.value = config.targetDatabase;
  }

  if (isTaskLoadStale()) return;
  savedPackageDrafts.value = config.oraclePackageDrafts?.length ? { context: packageDraftContext(config), drafts: JSON.parse(JSON.stringify(config.oraclePackageDrafts)) } : null;
  savedConfigSnapshot.value = configSnapshot(currentConfig());
}

/** Runs the action immediately, or asks for confirmation when the form has unsaved changes. */
function requestDiscardableAction(action: () => void) {
  if (needsDiscardConfirm.value) {
    pendingDiscardAction = action;
    showUnsavedConfirm.value = true;
    return;
  }
  action();
}

function confirmDiscardChanges() {
  showUnsavedConfirm.value = false;
  const action = pendingDiscardAction;
  pendingDiscardAction = null;
  action?.();
}

function onSelectTask(task: TransferTask) {
  if (task.id === activeTaskId.value && !isConfigDirty.value) return;
  requestDiscardableAction(() => {
    void loadTaskIntoForm(task);
  });
}

function onNewBlank() {
  requestDiscardableAction(() => resetState());
}

/** Tree cleared the selection because the active task was deleted: reset the form so no stale config lingers as "unsaved changes". */
function onSelectedTaskIdUpdate(id: string | null) {
  if (id === null && activeTaskId.value) {
    resetState();
    return;
  }
  activeTaskId.value = id;
}

// ---- confirmation for the immutable, previewed transfer request ----

function transferStrategyLabel(request: api.TransferRequest): string {
  if (request.content === "structureOnly") {
    if (request.dropTargetBeforeCreate) return t("transfer.modeRebuildStructure");
    return t(request.mode === "overwrite" ? "transfer.modeReplaceExisting" : "transfer.modeKeepExisting");
  }
  const strategy = resolveTransferStrategy(request);
  const keys = { append: "modeAppend", overwrite: "modeOverwrite", upsert: "modeUpsert", rebuild: "modeRebuild" };
  return t(`transfer.${keys[strategy]}`);
}

const confirmationSummary = computed(() => {
  const request = confirmationRequest.value;
  if (!request) return "";
  const source = formatTransferEndpointLabel(getConnectionName(request.sourceConnectionId), request.sourceDatabase, request.sourceSchema, request.sourceCatalog);
  const target = formatTransferEndpointLabel(getConnectionName(request.targetConnectionId), request.targetDatabase, request.targetSchema, request.targetCatalog);
  const count = countTransferObjects(request);
  return t("transfer.startConfirmMessage", { source, target, count });
});

const confirmationStrategy = computed(() => (confirmationRequest.value ? transferStrategyLabel(confirmationRequest.value) : ""));
const confirmationTitle = computed(() => {
  if (!confirmationRequest.value) return "";
  // A rebuild keeps its strategy title (it covers rename + create); a plain structure transfer
  // is titled by what the user is actually reviewing.
  return confirmationRequest.value.dropTargetBeforeCreate ? confirmationStrategy.value : t("transfer.structurePlanTitle");
});
/** The read-only SQL both confirmations review, composed so no operation is shown twice. */
const confirmationSql = computed(() => (confirmationPreview.value ? transferPreviewSql(confirmationPreview.value) : ""));
const confirmationDangerMessage = computed(() => (confirmationRequest.value?.dropTargetBeforeCreate ? t("transfer.rebuildDanger") : t("transfer.structurePreviewDanger")));
const confirmationDetails = computed(() => {
  const preview = confirmationPreview.value;
  const request = confirmationRequest.value;
  if (!preview || !request) return "";
  const lines = [confirmationSummary.value];
  if (preview.rebuild) {
    const missingTargets = preview.rebuild.tables.some((table) => !table.backupTable);
    if (!preview.structure) lines.push(t("transfer.rebuildSummary", { count: preview.rebuild.tables.length }));
    if (missingTargets) lines.push(t("transfer.rebuildMissingTargets"));
  }
  if (preview.structure) {
    const operations = preview.structure.operations ?? [];
    const operationSummary = summarizeTransferStructureOperations(operations);
    lines.push(t("transfer.structurePlanTitle"));

    const createdCounts = [
      [operationSummary.createdSchemas, "structurePlanSchemas"],
      [operationSummary.createdTables, "structurePlanTables"],
      [operationSummary.indexes, "structurePlanIndexes"],
      [operationSummary.foreignKeys, "structurePlanForeignKeys"],
      [operationSummary.sequences, "structurePlanSequences"],
      [operationSummary.comments, "structurePlanComments"],
    ] as const;
    const createdItems = createdCounts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${t(`transfer.${label}`, count)}`);
    if (createdItems.length > 0) lines.push(`${t("transfer.structurePlanCreated")}: ${createdItems.join(" · ")}`);
    if (operationSummary.skippedTables > 0) {
      lines.push(`${t("transfer.structurePlanSkipped")}: ${operationSummary.skippedTables} ${t("transfer.structurePlanTables", operationSummary.skippedTables)}`);
    }
    if (operationSummary.rebuiltTables > 0) {
      lines.push(`${t("transfer.structurePlanRebuilt")}: ${operationSummary.rebuiltTables} ${t("transfer.structurePlanTables", operationSummary.rebuiltTables)}`);
    }
    if (operations.length > 0) {
      lines.push(t("transfer.plannedOperations"));
      lines.push(
        ...operations.map((operation) => {
          const description = describeTransferStructureOperation(operation);
          const label = t(description.key, description.values);
          const suffix = description.suffixKey ? ` — ${t(description.suffixKey)}` : "";
          return `• ${label}${suffix}`;
        }),
      );
    }
    lines.push(t("transfer.structurePlanSqlPreview"));

    const unexpandedObjects = request.objects.filter((selection) => selection.objectType !== "TABLE" && selection.names.length > 0);
    if (unexpandedObjects.length > 0 && !preview.structure.schemaObjectsExpanded) {
      lines.push(t("transfer.structurePreviewUnexpandedObjects", { objects: unexpandedObjects.map((selection) => selection.names.join(", ")).join("; ") }));
    }
    lines.push(t("transfer.structurePreviewRevalidation"));
  }
  return lines.filter(Boolean).join("\n");
});

function transferPreviewFailureMessage(message: string): string {
  if (message === "TRANSFER_REBUILD_PREVIEW_UNAVAILABLE") return t("transfer.rebuildPreviewUnavailable");
  if (message === TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE) return t("transfer.structurePreviewUnavailable");
  return t("transfer.previewFailed", { message });
}

function packageDraftContext(config: Pick<TransferTaskConfig, "sourceConnectionId" | "sourceDatabase" | "sourceSchema" | "sourceCatalog" | "targetConnectionId" | "targetDatabase" | "targetSchema" | "targetCatalog">): string {
  return JSON.stringify([config.sourceConnectionId, config.sourceCatalog ?? "", config.sourceDatabase, config.sourceSchema || config.sourceDatabase, config.targetConnectionId, config.targetCatalog ?? "", config.targetDatabase, config.targetSchema || config.targetDatabase]);
}

function transferPackageDrafts(state: OracleRoutineDeployment): TransferPackageDraft[] {
  return state.drafts
    .filter((draft) => draft.included)
    .map((draft) => ({
      identity: { ...draft.identity },
      sourceName: draft.sourceName,
      sql: draft.sql,
      packageBodySource: draft.packageBodySource,
      packageContract: draft.packageContract,
      confirmPackagePair: draft.confirmPackagePair,
      reviewedTargetDraft: draft.reviewedTargetDraft,
    }));
}

function includeTransferPackageCompanion(objectId: string, source: "source" | "target") {
  const state = packageDeployment.value;
  if (!state) return;
  const draft = includeOraclePackageCompanion(state, objectId, source);
  if (!draft || (draft.identity.kind !== "PACKAGE" && draft.identity.kind !== "PACKAGE_BODY")) return;
  addingPackageCompanion = true;
  try {
    const names = new Set(selectedObjects.value[draft.identity.kind] ?? []);
    names.add(draft.sourceName ?? draft.identity.name);
    selectedObjects.value = { ...selectedObjects.value, [draft.identity.kind]: names };
  } finally {
    addingPackageCompanion = false;
  }
}

function rememberTransferPackageDrafts() {
  const state = packageDeployment.value;
  const request = confirmationRequest.value;
  if (state && request && !state.disposed) savedPackageDrafts.value = { context: packageDraftContext(request), drafts: transferPackageDrafts(state) };
}

function packageTransferObjects(request: api.TransferRequest): api.TransferRequest["objects"] {
  const objects = request.objects.map((selection) => ({ ...selection, names: [...selection.names] }));
  for (const draft of packageDeployment.value?.drafts.filter((draft) => draft.included) ?? []) {
    const kind = draft.identity.kind;
    if (kind !== "PACKAGE" && kind !== "PACKAGE_BODY") continue;
    let selection = objects.find((selection) => selection.objectType === kind);
    if (!selection) objects.push((selection = { objectType: kind, names: [] }));
    const name = draft.sourceName ?? draft.identity.name;
    if (!selection.names.includes(name)) selection.names.push(name);
  }
  return objects;
}

async function compareTransferPackages() {
  const request = confirmationRequest.value;
  const packages = confirmationPreview.value?.oraclePackages;
  const state = packageDeployment.value;
  if (!request || !packages || packageComparisonLoading.value || state?.validating || state?.executing) return;
  const source = store.getConfig(request.sourceConnectionId);
  const target = store.getConfig(request.targetConnectionId);
  if (!source || !target) return;
  packageComparisonLoading.value = true;
  try {
    const selected = packageTransferObjects(request).flatMap((selection) => (selection.objectType === "PACKAGE" || selection.objectType === "PACKAGE_BODY" ? selection.names.map((name) => ({ name, kind: selection.objectType as "PACKAGE" | "PACKAGE_BODY" })) : []));
    const session = startSchemaDiffSession(
      {
        sourceConnectionId: request.sourceConnectionId,
        sourceDatabase: request.sourceDatabase,
        sourceSchema: request.sourceSchema,
        targetConnectionId: request.targetConnectionId,
        targetDatabase: request.targetDatabase,
        targetSchema: request.targetSchema,
        sourceDbType: source.db_type,
        targetDbType: target.db_type,
        sourceEngineDbType: packages.input.source.endpoint.databaseType,
        targetEngineDbType: packages.input.target.endpoint.databaseType,
        options: normalizeSchemaDiffCompareOptions({ tables: false, views: false, functions: true, sequences: false, rules: false, owners: false, routineObjectKinds: [...new Set(selected.map((object) => object.kind))], selectedRoutineObjects: selected }, packages.input.target.endpoint.databaseType),
        ignoreComments: false,
        label: `${getConnectionName(request.sourceConnectionId)} → ${getConnectionName(request.targetConnectionId)}`,
      },
      { tableListLoader: createSchemaDiffTableListLoader({ ensureConnected: (id) => store.ensureConnected(id), listTables: (id, database, schema) => api.listTables(id, database, schema) }) },
      {
        source: packages.input.source.endpoint,
        target: packages.input.target.endpoint,
        drafts: state ? transferPackageDrafts(state) : savedPackageDrafts.value?.context === packageDraftContext(request) ? savedPackageDrafts.value.drafts : [],
      },
    );
    if (session.status === "running")
      await new Promise<void>((resolve) => {
        const stop = watch(
          () => session.status,
          (status) => {
            if (status !== "running") {
              stop();
              resolve();
            }
          },
        );
      });
    if (confirmationRequest.value !== request) return;
    if (session.status === "failed") {
      toast(session.error ?? t("transfer.previewFailed", { message: "" }), 5000);
      return;
    }
    resolveStartDecision(false);
    openSchemaDiffSession(session.id);
    open.value = false;
  } finally {
    packageComparisonLoading.value = false;
  }
}

async function validateTransferPackages() {
  const state = packageDeployment.value;
  const request = confirmationRequest.value;
  if (!state || !request) return;
  const revision = state.revision;
  await validateOracleRoutineDeployment(state, async (input) => {
    const preview = await api.previewTransferOwnership({ ...request, objects: packageTransferObjects(request), oraclePackages: { input, operationIds: [] } });
    if (!preview.oraclePackages) throw new Error(TRANSFER_STRUCTURE_PREVIEW_UNAVAILABLE);
    if (packageDeployment.value === state && confirmationRequest.value === request && state.revision === revision && !state.disposed) {
      if (preview.oraclePackages.pendingTables) {
        if (state.drafts.some((draft) => draft.operation && (draft.operation.lifecycle !== "prepared" || draft.operation.dispatched || state.attemptedOperationIds.includes(draft.operation.operationId))))
          throw new Error("Establish the original package request's termination before changing this transfer preview");
        for (const draft of state.drafts) {
          draft.operation = undefined;
          draft.supersedesOperationId = undefined;
        }
        if (!confirmationPreview.value?.oraclePackages?.pendingTables) packagePreviewTab.value = "tables";
      }
      confirmationPreview.value = preview;
      packagePreparedInput.value = preview.oraclePackages.input;
    }
    return preview.oraclePackages.plan;
  });
}

async function refreshTransferPackages() {
  const state = packageDeployment.value;
  if (!state) return;
  await refreshOracleRoutineDeployment(state);
  if (!state.error && packageDeployment.value === state) await validateTransferPackages();
}

async function requestTransferConfirmation(request: api.TransferRequest, preview: api.TransferOwnershipPreview): Promise<boolean | TransferPackageConfirmation> {
  rememberTransferPackageDrafts();
  if (packageDeployment.value) await disposeOracleRoutineDeployment(packageDeployment.value);
  packageDeployment.value = null;
  packagePreparedInput.value = null;
  confirmationRequest.value = request;
  confirmationPreview.value = preview;
  packagePreviewTab.value = preview.structure?.tables.length ? "tables" : "routines";
  packageTableName.value = "";
  const packages = preview.oraclePackages;
  if (packages?.input.drafts.length) {
    const state = reactive(createOracleRoutineDeployment(packages.input.source, packages.input.target));
    const saved = savedPackageDrafts.value?.context === packageDraftContext(request) ? savedPackageDrafts.value.drafts : [];
    state.drafts = packages.input.drafts.map((draft, index) => ({ ...draft, ...saved.find((item) => item.identity.owner === draft.identity.owner && item.identity.name === draft.identity.name && item.identity.kind === draft.identity.kind), objectId: `transfer-package:${index}`, included: true }));
    state.selectedObjectId = state.drafts[0]?.objectId ?? null;
    packageDeployment.value = state;
    packagePreparedInput.value = packages.input;
    if (saved.length) await validateTransferPackages();
    else await validateOracleRoutineDeployment(state, async () => packages.plan);
    if (confirmationRequest.value !== request || state.disposed) return false;
    const accepted = await new Promise<boolean>((resolve) => {
      resolveTransferConfirmation = resolve;
      showSqlPreviewConfirm.value = true;
    });
    if (!accepted || !packageReady.value || packageDeployment.value !== state || !packagePreparedInput.value) return false;
    const revision = state.revision;
    const finalPreview = confirmationPreview.value!;
    const decision: TransferPackageConfirmation = JSON.parse(
      JSON.stringify({
        objects: packageTransferObjects(request),
        oraclePackages: { input: packagePreparedInput.value, operationIds: state.plan!.steps.flatMap((step) => (step.operation ? [step.operation.operationId] : [])), pendingTables: finalPreview.oraclePackages?.pendingTables },
      }),
    );
    const authorized = await confirmTransferWithProductionSafety({
      request,
      connection: store.getConfig(request.targetConnectionId),
      reviewText: transferPlanReviewText(confirmationStrategy.value, confirmationDetails.value, finalPreview),
      source: t("transfer.title"),
      confirm: async () => true,
    });
    return authorized && state.revision === revision && packageReady.value ? decision : false;
  }
  const reviewText = hasTransferSqlPreview(preview)
    ? transferPlanReviewText(confirmationStrategy.value, confirmationDetails.value, preview)
    : [confirmationSummary.value, `${t("transfer.targetTableHandling")}: ${confirmationStrategy.value}`, ...request.objects.map((selection) => selection.names.join(", "))].join("\n");
  const accepted = await confirmTransferWithProductionSafety({
    request,
    connection: store.getConfig(request.targetConnectionId),
    reviewText,
    source: t("transfer.title"),
    confirm: () =>
      new Promise((resolve) => {
        resolveTransferConfirmation = resolve;
        if (hasTransferSqlPreview(preview)) showSqlPreviewConfirm.value = true;
        else showStartConfirm.value = true;
      }),
  });
  return accepted && packages ? { objects: request.objects, oraclePackages: { input: packages.input, operationIds: [] } } : accepted;
}

function resolveStartDecision(confirmed: boolean) {
  if (confirmed && !packageReady.value) return;
  rememberTransferPackageDrafts();
  const resolve = resolveTransferConfirmation;
  resolveTransferConfirmation = undefined;
  showStartConfirm.value = false;
  showSqlPreviewConfirm.value = false;
  resolve?.(confirmed);
}

function cancelPendingTransfer() {
  transferSubmission.cancel();
  rememberTransferPackageDrafts();
  if (packageDeployment.value) void disposeOracleRoutineDeployment(packageDeployment.value);
  const scopeId = pendingTransferId.value;
  pendingTransferId.value = null;
  if (scopeId) productionSafetyStore.cancelScope(scopeId);
  resolveStartDecision(false);
  resolveOwnershipDecision(null);
  confirmationRequest.value = null;
  confirmationPreview.value = null;
  isSubmitting.value = false;
}

watch(
  showStartConfirm,
  (isOpen) => {
    if (!isOpen) resolveStartDecision(false);
  },
  { flush: "sync" },
);
watch(
  showSqlPreviewConfirm,
  (isOpen) => {
    if (!isOpen) resolveStartDecision(false);
  },
  { flush: "sync" },
);
watch(
  ownershipDialogOpen,
  (isOpen) => {
    if (!isOpen) resolveOwnershipDecision(null);
  },
  { flush: "sync" },
);

/** Saves the form into the active task, or creates a new one and starts its rename. */
async function saveConfigTask() {
  if (!canSaveConfig.value) return;
  const config = currentConfig();
  try {
    const existing = activeTaskId.value ? taskStore.getTask(activeTaskId.value) : undefined;
    if (existing) {
      await taskStore.saveTask({ id: existing.id, name: existing.name, config });
    } else {
      const rootTasks = taskStore.listTasks(undefined);
      const defaultName = t("transfer.tasks.newTaskDefault");
      const takenNames = new Set(rootTasks.map((task) => task.name));
      const takenKeys = new Set(rootTasks.map((task) => task.name.toLocaleLowerCase()));
      const name = takenKeys.has(defaultName.toLocaleLowerCase()) ? nextTransferTaskCopyName(defaultName, takenNames) : defaultName;
      const task = await taskStore.saveTask({ name, config });
      activeTaskId.value = task.id;
      taskTreeRef.value?.startRenameTask(task);
    }
    savedConfigSnapshot.value = configSnapshot(currentConfig());
    toast(t("transfer.taskSaved"), 2000);
  } catch (error) {
    const message = error instanceof TransferTaskNameConflictError ? t("transfer.tasks.nameConflict", { name: error.entryName }) : ((error as Error)?.message ?? String(error));
    toast(t("transfer.tasks.saveFailed", { message }), 5000);
  }
}
</script>

<template>
  <DataTransferProgressDialog v-if="trackedTransferTask" v-model:open="open" :task="trackedTransferTask" />
  <Dialog v-else v-model:open="open">
    <DialogContent class="dbx-transfer-dialog sm:max-w-[1120px] max-h-[80vh] flex flex-col overflow-hidden resize" :style="transferDialogStyle" @interact-outside.prevent>
      <DialogHeader class="shrink-0">
        <DialogTitle class="flex items-center gap-2">
          <ArrowRightLeft class="w-4 h-4" />
          {{ t("transfer.title") }}
          <span v-if="activeTaskName" class="text-xs font-normal text-muted-foreground truncate">— {{ activeTaskName }}</span>
        </DialogTitle>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 -ml-4">
        <div class="relative w-60 shrink-0 self-stretch border-r border-border">
          <TransferTaskTree ref="taskTreeRef" :selected-task-id="activeTaskId" class="absolute inset-0" @update:selected-task-id="onSelectedTaskIdUpdate" @select="onSelectTask" @new-blank="onNewBlank" />
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto pl-4 pr-1 scrollbar-thin">
          <div class="flex flex-col gap-5 py-3">
            <!-- Source / Target Side by Side -->
            <div class="grid grid-cols-[1fr_auto_1fr] gap-4 items-start">
              <!-- Source Section -->
              <div class="space-y-3">
                <div class="text-sm font-medium text-blue-500">
                  {{ t("transfer.source") }}
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.sourceConnection") }}</Label>
                  <ConnectionTreeSelect
                    v-model="sourceConnectionId"
                    :connections="sourceConnections"
                    :layout="store.sidebarLayout"
                    :placeholder="t('transfer.selectConnection')"
                    :search-placeholder="t('transfer.searchConnection')"
                    :empty-text="t('common.noResults')"
                    trigger-class="h-8 w-full max-w-none justify-between gap-1.5 border border-input rounded-md bg-transparent px-2.5 text-xs shadow-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
                    list-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <!-- Source Catalog (Doris/StarRocks multi-catalog) -->
                <div v-if="sourceCatalogs.length > 1" class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.sourceCatalog") }}</Label>
                  <SearchableSelect
                    v-model="sourceCatalog"
                    :options="sourceCatalogs.map((c) => c.name)"
                    :placeholder="t('transfer.selectCatalog')"
                    :search-placeholder="t('transfer.searchCatalog')"
                    :empty-text="t('common.noResults')"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.sourceDatabase") }}</Label>
                  <SearchableSelect
                    v-model="sourceDatabase"
                    :options="sourceDatabases"
                    :display-name="(option) => databaseOptionLabel(sourceConnectionId, option)"
                    :placeholder="t('transfer.selectDatabase')"
                    :search-placeholder="t('transfer.searchDatabase')"
                    :empty-text="t('common.noResults')"
                    :disabled="!sourceDatabases.length"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <div v-if="sourceSchemas.length" class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.sourceSchema") }}</Label>
                  <SearchableSelect
                    v-model="sourceSchema"
                    :options="sourceSchemas"
                    :placeholder="t('transfer.selectSchema')"
                    :search-placeholder="t('transfer.searchSchema')"
                    :empty-text="t('common.noResults')"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>
              </div>

              <!-- Swap source / target -->
              <div class="flex items-center pt-8">
                <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('transfer.swap')" :aria-label="t('transfer.swap')" @click="swapSourceAndTarget">
                  <ArrowLeftRight class="w-3.5 h-3.5" />
                </Button>
              </div>

              <!-- Target Section -->
              <div class="space-y-3">
                <div class="text-sm font-medium text-green-500">
                  {{ t("transfer.target") }}
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.targetConnection") }}</Label>
                  <ConnectionTreeSelect
                    v-model="targetConnectionId"
                    :connections="targetConnections"
                    :layout="store.sidebarLayout"
                    :placeholder="t('transfer.selectConnection')"
                    :search-placeholder="t('transfer.searchConnection')"
                    :empty-text="t('common.noResults')"
                    trigger-class="h-8 w-full max-w-none justify-between gap-1.5 border border-input rounded-md bg-transparent px-2.5 text-xs shadow-none hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50"
                    list-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <!-- Target Catalog (Doris/StarRocks multi-catalog) -->
                <div v-if="targetCatalogs.length > 1" class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.targetCatalog") }}</Label>
                  <SearchableSelect
                    v-model="targetCatalog"
                    :options="targetCatalogs.map((c) => c.name)"
                    :placeholder="t('transfer.selectCatalog')"
                    :search-placeholder="t('transfer.searchCatalog')"
                    :empty-text="t('common.noResults')"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <div class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.targetDatabase") }}</Label>
                  <SearchableSelect
                    v-model="targetDatabase"
                    :options="targetDatabases"
                    :display-name="(option) => databaseOptionLabel(targetConnectionId, option)"
                    :placeholder="t('transfer.selectDatabase')"
                    :search-placeholder="t('transfer.searchDatabase')"
                    :empty-text="t('common.noResults')"
                    :disabled="!targetDatabases.length"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>

                <div v-if="targetSchemas.length" class="space-y-1.5">
                  <Label class="text-xs">{{ t("transfer.targetSchema") }}</Label>
                  <SearchableSelect
                    v-model="targetSchema"
                    :options="targetSchemas"
                    :placeholder="t('transfer.selectSchema')"
                    :search-placeholder="t('transfer.searchSchema')"
                    :empty-text="t('common.noResults')"
                    trigger-variant="outline"
                    trigger-class="h-8 w-full justify-between text-xs"
                    content-class="w-[var(--reka-popover-trigger-width)]"
                  />
                </div>
              </div>
            </div>

            <!-- Objects Section -->
            <div class="flex min-h-0 flex-col gap-2">
              <div class="flex items-center justify-between">
                <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {{ t("transfer.objects") }}
                  <span v-if="objectSelectionSummary.total" class="text-muted-foreground/60">({{ objectSelectionSummary.selected }}/{{ objectSelectionSummary.total }})</span>
                </div>
              </div>

              <div v-if="(!loadingObjects && !sourceConnectionId) || !sourceDatabase" class="text-xs text-muted-foreground py-4 text-center">
                {{ t("transfer.selectSourceFirst") }}
              </div>
              <ObjectSelectionTree v-model="treeSelection" :groups="treeGroups" :disabled-groups="treeDisabledGroups" :disabled-hints="treeDisabledHints" :qualifiers="objectQualifiers" v-model:search="objectSearch" :loading="loadingObjects" class="min-h-0 flex-1" />
              <!-- Per-table SQL filters (MySQL / PostgreSQL sources) -->
              <div v-if="tableFilterSupported && transferContent !== 'structureOnly' && selectedTableList.length" class="shrink-0 rounded-lg border border-border/60 bg-card/60 p-1.5">
                <div class="flex items-center justify-between gap-2 px-1 pb-1">
                  <span class="text-xs font-medium text-muted-foreground">
                    {{ t("transfer.tableFilterSection") }}
                    <span v-if="activeTableFilterCount" class="text-primary">({{ activeTableFilterCount }})</span>
                  </span>
                  <span class="text-[11px] text-muted-foreground/70">{{ t("transfer.tableFilterSectionHint") }}</span>
                </div>
                <div class="max-h-24 space-y-0.5 overflow-auto">
                  <div v-for="name in selectedTableList" :key="name" class="flex items-center gap-1.5 rounded px-1.5 py-1 text-xs hover:bg-muted/60">
                    <span class="min-w-0 flex-1 truncate" :title="name">{{ name }}</span>
                    <span v-if="tableFilters[name]" class="max-w-[45%] truncate rounded bg-primary/10 px-1 text-[11px] text-primary" :title="tableFilters[name]">
                      {{ tableFilters[name] }}
                    </span>
                    <Button variant="ghost" size="sm" class="h-6 shrink-0 px-1.5 text-[11px]" @click="openTableFilter(name)">
                      {{ tableFilters[name] ? t("transfer.tableFilterEdit") : t("transfer.tableFilterSet") }}
                    </Button>
                    <Button v-if="tableFilters[name]" variant="ghost" size="icon" class="h-6 w-6 shrink-0" :title="t('transfer.tableFilterClear')" :aria-label="t('transfer.tableFilterClear')" @click="clearTableFilter(name)">
                      <X class="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
              <div v-if="showCrossFamilyViewHint" class="mt-1.5 rounded-md border border-amber-300/40 bg-amber-50 px-2 py-1.5 text-xs text-amber-700">
                {{ t("transfer.crossFamilyViewHint") }}
              </div>
            </div>

            <!-- Options -->
            <div class="space-y-2.5">
              <div class="space-y-1">
                <Label class="text-xs">{{ t("transfer.content") }}</Label>
                <div class="flex flex-col gap-1">
                  <label class="flex cursor-pointer items-center gap-2 text-xs">
                    <input type="radio" value="structureAndData" v-model="transferContent" class="h-3.5 w-3.5" />
                    {{ t("transfer.contentStructureAndData") }}
                  </label>
                  <label class="flex cursor-pointer items-center gap-2 text-xs">
                    <input type="radio" value="structureOnly" v-model="transferContent" class="h-3.5 w-3.5" />
                    {{ t("transfer.contentStructureOnly") }}
                    <span class="text-muted-foreground/70">{{ t("transfer.contentStructureOnlyHint") }}</span>
                  </label>
                  <label class="flex cursor-pointer items-center gap-2 text-xs">
                    <input type="radio" value="dataOnly" v-model="transferContent" class="h-3.5 w-3.5" />
                    {{ t("transfer.contentDataOnly") }}
                    <span class="text-muted-foreground/70">{{ t("transfer.contentDataOnlyHint") }}</span>
                  </label>
                </div>
              </div>
              <div class="flex items-center gap-3">
                <Label class="text-xs shrink-0">{{ t("transfer.targetTableHandling") }}</Label>
                <Select v-model="targetTableStrategy">
                  <SelectTrigger class="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="append">{{ t(transferContent === "structureOnly" ? "transfer.modeKeepExisting" : "transfer.modeAppend") }}</SelectItem>
                    <SelectItem v-if="transferContent !== 'structureOnly' || structureOverwriteSupported()" value="overwrite">{{ t(transferContent === "structureOnly" ? "transfer.modeReplaceExisting" : "transfer.modeOverwrite") }}</SelectItem>
                    <SelectItem v-if="transferContent !== 'structureOnly'" value="upsert" :disabled="!upsertSupported">{{ t("transfer.modeUpsert") }}</SelectItem>
                    <SelectItem value="rebuild" :disabled="!!rebuildDisabledReason">{{ t(transferContent === "structureOnly" ? "transfer.modeRebuildStructure" : "transfer.modeRebuild") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <p v-if="rebuildDisabledHint" class="text-xs text-muted-foreground">{{ rebuildDisabledHint }}</p>
              <p v-if="xuguTransferHint" class="text-xs text-amber-600">{{ xuguTransferHint }}</p>
              <div v-if="!isXuguTransferPair" class="flex items-center gap-3">
                <Label class="text-xs shrink-0">{{ t("transfer.targetTableNameCase") }}</Label>
                <Select v-model="targetTableNameCase">
                  <SelectTrigger class="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preserve">{{ t("transfer.tableNameCasePreserve") }}</SelectItem>
                    <SelectItem value="lower">{{ t("transfer.tableNameCaseLower") }}</SelectItem>
                    <SelectItem value="upper">{{ t("transfer.tableNameCaseUpper") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-if="!isXuguTransferPair" class="flex items-center gap-3">
                <Label class="text-xs shrink-0">{{ t("transfer.targetColumnNameCase") }}</Label>
                <Select v-model="targetColumnNameCase">
                  <SelectTrigger class="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="preserve">{{ t("transfer.tableNameCasePreserve") }}</SelectItem>
                    <SelectItem value="lower">{{ t("transfer.tableNameCaseLower") }}</SelectItem>
                    <SelectItem value="upper">{{ t("transfer.tableNameCaseUpper") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div v-if="showTargetColumnQuoteOption" class="flex items-center gap-3">
                <Label for="transfer-quote-target-column-names" class="text-xs shrink-0">{{ t("transfer.quoteTargetColumnNames") }}</Label>
                <Switch id="transfer-quote-target-column-names" v-model="quoteTargetColumnNames" size="sm" />
              </div>
              <div class="flex items-center gap-3">
                <Label class="text-xs shrink-0">{{ t("transfer.batchSize") }}</Label>
                <Input v-model.number="batchSize" type="number" min="100" max="10000" step="100" class="h-7 text-xs w-24" />
              </div>
              <div class="space-y-1">
                <div class="flex items-center gap-3">
                  <Label class="text-xs shrink-0">{{ t("transfer.operationTimeout") }}</Label>
                  <Select v-model="operationTimeoutMode">
                    <SelectTrigger class="h-7 w-32 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="inherit">{{ t("transfer.operationTimeoutInherit") }}</SelectItem>
                      <SelectItem value="custom">{{ t("transfer.operationTimeoutCustom") }}</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input v-if="operationTimeoutMode === 'custom'" v-model.number="operationTimeoutSecs" type="number" min="0" :max="MAX_QUERY_TIMEOUT_SECS" step="1" class="h-7 w-24 text-xs" />
                </div>
                <p class="text-xs leading-5 text-muted-foreground">{{ operationTimeoutHint }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter class="shrink-0">
        <p v-if="mysqlDataCharsetEnabled(store.getConfig(sourceConnectionId)) || mysqlDataCharsetEnabled(store.getConfig(targetConnectionId))" class="text-xs text-muted-foreground">{{ t("connection.mysqlDataCharsetExportHint") }}</p>
        <Button variant="outline" size="sm" @click="open = false">
          {{ t("transfer.cancel") }}
        </Button>
        <Button variant="outline" size="sm" :disabled="!canSaveConfig || isSubmitting" @click="saveConfigTask">
          {{ activeTaskId ? t("transfer.saveConfig") : t("transfer.saveAsNewTask") }}
        </Button>
        <Button size="sm" :disabled="!canStart || isSubmitting" @click="requestStartTransfer">
          <Loader2 v-if="isSubmitting" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
          <ArrowRightLeft v-else class="w-3.5 h-3.5 mr-1.5" />
          {{ t("transfer.start") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showUnsavedConfirm">
    <DialogContent class="sm:max-w-[400px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("transfer.unsavedTitle") }}</DialogTitle>
        <DialogDescription>
          {{ t("transfer.unsavedMessage") }}
        </DialogDescription>
      </DialogHeader>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="showUnsavedConfirm = false">
          {{ t("transfer.cancel") }}
        </Button>
        <Button variant="destructive" size="sm" @click="confirmDiscardChanges">
          {{ t("transfer.unsavedDiscard") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="showStartConfirm">
    <DialogContent class="sm:max-w-[420px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("transfer.startConfirmTitle") }}</DialogTitle>
        <DialogDescription>
          {{ confirmationSummary }}
        </DialogDescription>
      </DialogHeader>
      <p class="text-xs text-muted-foreground">{{ t("transfer.targetTableHandling") }}: {{ confirmationStrategy }}</p>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="resolveStartDecision(false)">
          {{ t("transfer.cancel") }}
        </Button>
        <Button size="sm" @click="resolveStartDecision(true)">
          {{ t("transfer.start") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <DangerConfirmDialog
    v-model:open="showSqlPreviewConfirm"
    :sql="confirmationSql"
    :title="confirmationTitle"
    :message="confirmationDangerMessage"
    :details-text="confirmationDetails"
    :confirm-label="t('transfer.start')"
    :confirm-disabled="!packageReady"
    :initial-focus="packageDeployment ? 'default' : 'confirm'"
    :close-on-confirm="false"
    @confirm="resolveStartDecision(true)"
  >
    <template v-if="confirmationPreview?.oraclePackages" #options>
      <div class="mb-3 space-y-2">
        <p v-if="confirmationPreview.oraclePackages.skipped.length" class="max-h-24 overflow-auto text-sm text-muted-foreground">
          {{ t("transfer.structurePlanSkipped") }}: {{ confirmationPreview.oraclePackages.skipped.map((identity) => `${identity.kind.replaceAll("_", " ")} ${identity.owner}.${identity.name}`).join("; ") }}
        </p>
        <Button variant="outline" size="sm" :disabled="packageComparisonLoading || packageDeployment?.validating" @click="compareTransferPackages"><Loader2 v-if="packageComparisonLoading" class="mr-1 h-3.5 w-3.5 animate-spin" />{{ t("diff.title") }}</Button>
      </div>
    </template>
    <template v-if="packageDeployment" #preview>
      <Tabs v-model="packagePreviewTab" class="flex min-h-0 flex-1 flex-col">
        <TabsList v-if="confirmationPreview?.structure?.tables.length" class="shrink-0 self-start">
          <TabsTrigger value="tables">{{ t("diff.tableSelection") }}</TabsTrigger>
          <TabsTrigger value="routines">{{ t("diff.routineSelection") }}</TabsTrigger>
        </TabsList>
        <TabsContent v-if="packageTablePreview" value="tables" class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <Select :model-value="packageTablePreview.sourceTable" @update:model-value="packageTableName = String($event)">
            <SelectTrigger class="mb-2 w-full sm:max-w-sm" :aria-label="t('diff.tableSelection')"><SelectValue /></SelectTrigger>
            <SelectContent
              ><SelectItem v-for="table in confirmationPreview?.structure?.tables" :key="table.sourceTable" :value="table.sourceTable">{{ table.sourceTable }} → {{ table.targetTable }}</SelectItem></SelectContent
            >
          </Select>
          <div class="min-h-0 flex-1 overflow-hidden rounded border" data-testid="transfer-table-sql"><SqlPreviewPanel :sql="packageTablePreview.sql" sql-format-dialect="oracle" @close="packagePreviewTab = 'routines'" /></div>
        </TabsContent>
        <TabsContent value="routines" class="min-h-0 flex-1 overflow-hidden rounded border">
          <SchemaDiffDeployStep
            :deploy-sql="packageDraftSql"
            :selected-objects="[]"
            :target-connection-id="packageDeployment.target.endpoint.connectionId"
            :target-database="packageDeployment.target.endpoint.database"
            :target-schema="packageDeployment.target.endpoint.schema"
            :database-type="packageDeployment.target.endpoint.databaseType"
            :executing="packageComparisonLoading"
            :routine-deployment="packageDeployment"
            package-transfer
            @update:deploy-sql="editOracleRoutineDraft(packageDeployment, packageDeployment.selectedObjectId!, $event)"
            @select-routine="selectOracleRoutineDraft(packageDeployment, $event)"
            @validate-routines="validateTransferPackages"
            @refresh-routines="refreshTransferPackages"
            @include-package-companion="includeTransferPackageCompanion"
            @update-package-options="(id, options) => editOraclePackageOptions(packageDeployment!, id, options)"
            @review-package-target="reviewOraclePackageTargetDraft(packageDeployment, $event)"
          />
        </TabsContent>
      </Tabs>
    </template>
  </DangerConfirmDialog>

  <Dialog v-model:open="ownershipDialogOpen">
    <DialogContent class="sm:max-w-[520px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("transfer.ownershipTitle") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-3 text-sm">
        <p class="text-muted-foreground">
          {{ t("transfer.ownershipMessage", { owners: ownershipMissingOwners.join(", ") }) }}
        </p>
        <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {{ t("transfer.ownershipSkipDetails") }}
        </div>
        <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {{ t("transfer.ownershipTargetOwner", { owner: ownershipTargetOwner }) }}
        </div>
      </div>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="resolveOwnershipDecision(null)">
          {{ t("transfer.cancel") }}
        </Button>
        <Button variant="secondary" size="sm" @click="resolveOwnershipDecision('skip')">
          {{ t("transfer.ownershipSkip") }}
        </Button>
        <Button size="sm" @click="resolveOwnershipDecision('reassignMissing')">
          {{ t("transfer.ownershipConfirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="filterDialogOpen">
    <DialogContent class="sm:max-w-[560px]" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle>{{ t("transfer.tableFilterTitle", { table: filterEditingTable }) }}</DialogTitle>
        <DialogDescription>{{ t("transfer.tableFilterHint") }}</DialogDescription>
      </DialogHeader>
      <textarea
        v-model="filterDraft"
        rows="5"
        spellcheck="false"
        class="w-full rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-xs shadow-none outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        :placeholder="t('transfer.tableFilterPlaceholder')"
      ></textarea>
      <p class="text-xs text-muted-foreground">{{ t("transfer.tableFilterExamples") }}</p>
      <DialogFooter class="gap-2">
        <Button variant="outline" size="sm" @click="filterDialogOpen = false">
          {{ t("transfer.cancel") }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="!tableFilters[filterEditingTable]"
          @click="
            clearTableFilter(filterEditingTable);
            filterDialogOpen = false;
          "
        >
          {{ t("transfer.tableFilterClear") }}
        </Button>
        <Button size="sm" @click="saveTableFilter">{{ t("transfer.tableFilterSave") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style>
html.dbx-legacy-webview [data-slot="dialog-content"].dbx-transfer-dialog[class~="max-w-sm"] {
  /* Override the legacy default cap without pinning width, so native resize remains effective. */
  max-width: calc(100vw - 2rem) !important;
}
</style>

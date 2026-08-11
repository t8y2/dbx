<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Check, CheckSquare, ChevronDown, ChevronRight, FolderOpen, Layers, Loader2, MinusSquare, Pencil, Play, RefreshCw, Search, Settings2, Square, Trash2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useToast } from "@/composables/useToast";
import { useMultiDbExecution, type MultiDbExecutionAdapter, type MultiDbExecutionMode } from "@/composables/useMultiDbExecution";
import { formatDataTransferDuration, useExportTracker } from "@/composables/useExportTracker";
import { useMultiDbTargetSelection, type MultiDbTargetCatalogOption, type SqlExecutionTargetValidationReason } from "@/composables/useMultiDbTargetSelection";
import { useSqlExecutionTargetGroupStore } from "@/stores/sqlExecutionTargetGroupStore";
import { dedupeMultiDbExecutionTargets, multiDbExecutionTargetKey, type MultiDbExecutionTarget, type MultiDbExecutionItemStatus, type SqlExecutionTargetGroup, type SqlExecutionTargetValidation } from "@/types/sqlExecution";
import type { ConnectionConfig, DatabaseType } from "@/types/database";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { targetAllowsEmptyDatabase, targetIsSingleDatabase, targetSupportsCatalog, targetSupportsSchema, targetUsesConnectionOnlyScope } from "@/lib/database/sqlExecutionTargetCapabilities";

const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  sql: string;
  sourceTabId: string;
  databaseType?: DatabaseType;
  initialTargets: MultiDbExecutionTarget[];
  launchId: number;
  executeTarget: MultiDbExecutionAdapter["executeTarget"];
  cancelTarget?: MultiDbExecutionAdapter["cancelTarget"];
  cancelPending?: MultiDbExecutionAdapter["cancelPending"];
  sourceOffset?: number;
}>();

const { t } = useI18n();
const { toast } = useToast();
const { addMultiDbExecutionTask, updateMultiDbExecutionTask, registerTaskCancelHandler, unregisterTaskCancelHandler } = useExportTracker();
const targetGroupStore = useSqlExecutionTargetGroupStore();
const targetSelection = useMultiDbTargetSelection(computed(() => props.databaseType));
const compatibleConnections = targetSelection.compatibleConnections;

const selectedTargets = ref<MultiDbExecutionTarget[]>([]);
const validationResults = ref<SqlExecutionTargetValidation[]>([]);
const searchText = ref("");
const selectedGroupId = ref<string>();
const manageGroups = ref(false);
const expandedConnections = ref<Set<string>>(new Set());
const expandedCatalogs = ref<Set<string>>(new Set());
const expandedDatabases = ref<Set<string>>(new Set());
const ignoreSelectionChange = ref(false);
const manualSelectionTouched = ref(false);
const validating = ref(false);
const groupNameDialogOpen = ref(false);
const groupName = ref("");
const groupNameMode = ref<"create" | "update" | "clone" | "rename">("create");
const editingGroupId = ref<string>();
const pendingAfterSave = ref<(() => void) | undefined>();
const deleteGroupId = ref<string>();
const pendingGroupId = ref<string | null>();
const pendingClose = ref(false);
const unsavedPromptOpen = ref(false);
const executionStarted = ref(false);
const executionMode = ref<MultiDbExecutionMode>("serial");
const currentTime = ref(Date.now());
let elapsedTimer: ReturnType<typeof setInterval> | undefined;
let validationRun = 0;
let trackedBatchId: string | undefined;
let initializedLaunchId = -1;

const execution = useMultiDbExecution(
  {
    validateTarget: async (target) => {
      const result = await targetSelection.validateTarget(target);
      return {
        valid: result.state === "valid",
        ...(result.state !== "valid" ? { errorMessage: validationReasonLabel(result.reason) } : {}),
      };
    },
    executeTarget: props.executeTarget,
    cancelTarget: props.cancelTarget,
    cancelPending: props.cancelPending,
  },
  { sourceTabId: computed(() => props.sourceTabId) },
);

const currentGroup = computed(() => (selectedGroupId.value ? targetGroupStore.getGroup(selectedGroupId.value) : undefined));
const compatibleGroups = computed(() => (props.databaseType ? targetGroupStore.getGroupsByDatabaseType(props.databaseType) : []));
const allGroups = computed(() => targetGroupStore.getGroupsByDatabaseType());
const isExecuting = computed(() => execution.isRunning.value);
const batch = computed(() => execution.batch.value);
const selectedTargetKeys = computed(() => new Set(selectedTargets.value.map(multiDbExecutionTargetKey)));
const validationByKey = computed(() => new Map(validationResults.value.map((entry) => [multiDbExecutionTargetKey(entry.target), entry])));
const invalidTargetCount = computed(() => validationResults.value.filter((entry) => entry.state === "invalid").length);
const needsRecheckCount = computed(() => validationResults.value.filter((entry) => entry.state === "needsRecheck").length);
const allTargetsValid = computed(() => selectedTargets.value.length > 0 && selectedTargets.value.every((target) => validationByKey.value.get(multiDbExecutionTargetKey(target))?.state === "valid"));
const hasUnsavedChanges = computed(() => {
  if (selectedGroupId.value && currentGroup.value) {
    return !sameTargetList(selectedTargets.value, currentGroup.value.targets);
  }
  return manualSelectionTouched.value;
});
const canExecute = computed(() => !isExecuting.value && !!props.sql.trim() && allTargetsValid.value && invalidTargetCount.value === 0 && needsRecheckCount.value === 0);
const canSaveGroup = computed(() => !isExecuting.value && !!props.databaseType && selectedTargets.value.length > 0 && allTargetsValid.value);
const progressCompleted = computed(() => (batch.value?.items ?? []).filter((item) => !["pending", "running"].includes(item.status)).length);
const progressCounts = computed(() => {
  const items = batch.value?.items ?? [];
  return {
    success: items.filter((item) => item.status === "success").length,
    failed: items.filter((item) => item.status === "failed").length,
    skipped: items.filter((item) => item.status === "skipped").length,
    notExecuted: items.filter((item) => item.status === "not_executed" || item.status === "cancelled").length,
  };
});
const elapsedMs = computed(() => {
  const current = batch.value;
  if (!current) return 0;
  return current.durationMs ?? Math.max(0, (current.completedAt ?? currentTime.value) - current.startedAt);
});

function syncBackgroundTask(current: NonNullable<typeof batch.value>): void {
  const items = current.items;
  const completed = items.filter((item) => !["pending", "running"].includes(item.status)).length;
  const failureCount = items.filter((item) => item.status === "failed").length;
  const status = current.status === "cancelled" ? "cancelled" : current.status === "completed" ? "completed" : "running";
  updateMultiDbExecutionTask(current.id, {
    sourceTabId: current.sourceTabId,
    total: items.length,
    completed,
    successCount: items.filter((item) => item.status === "success").length,
    failureCount,
    skippedCount: items.filter((item) => item.status === "skipped").length,
    notExecutedCount: items.filter((item) => item.status === "not_executed" || item.status === "cancelled").length,
    status,
    startedAt: current.startedAt,
    finishedAt: current.completedAt,
    elapsedMs: current.durationMs,
    currentTarget: current.items.find((item) => item.status === "running")?.target,
    errorMessage: failureCount > 0 ? current.items.find((item) => item.status === "failed")?.errorMessage : undefined,
  });
}

function executionModeLabel(): string {
  return executionMode.value === "serial" ? t("multiDbExecute.serial") : t("multiDbExecute.parallel");
}

function toggleExecutionMode(): void {
  if (isExecuting.value) return;
  executionMode.value = executionMode.value === "serial" ? "parallel" : "serial";
}

watch(
  batch,
  (current) => {
    if (!current) return;
    if (trackedBatchId !== current.id) {
      trackedBatchId = current.id;
      addMultiDbExecutionTask(current.id, t("multiDbExecute.title"), current.sourceTabId, () => {
        open.value = true;
      });
      registerTaskCancelHandler(current.id, () => execution.cancel());
    }
    syncBackgroundTask(current);
    if (current.status === "completed" || current.status === "cancelled") unregisterTaskCancelHandler(current.id);
  },
  { deep: true, flush: "sync" },
);

onMounted(() => {
  elapsedTimer = setInterval(() => {
    currentTime.value = Date.now();
  }, 1000);
});

onBeforeUnmount(() => {
  if (elapsedTimer) clearInterval(elapsedTimer);
  if (trackedBatchId) unregisterTaskCancelHandler(trackedBatchId);
});

const searchQuery = computed(() => searchText.value.trim().toLocaleLowerCase());

function sameTargetList(left: readonly MultiDbExecutionTarget[], right: readonly MultiDbExecutionTarget[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((target, index) => multiDbExecutionTargetKey(target) === multiDbExecutionTargetKey(right[index]));
}

function targetKey(target: MultiDbExecutionTarget): string {
  return multiDbExecutionTargetKey(target);
}

function targetLabel(target: MultiDbExecutionTarget): string {
  const connection = targetSelection.connection(target.connectionId);
  const connectionName = connection?.name || target.connectionId;
  return [connectionName, target.catalog, target.database, target.schema].filter((value) => value !== undefined && value !== "").join(" / ");
}

function connectionLabel(connection: ConnectionConfig): string {
  return connection.name || connection.id;
}

function catalogLabel(catalog: MultiDbTargetCatalogOption): string {
  return catalog.isInternal ? `${catalog.name} (${t("multiDbExecute.internalCatalog")})` : catalog.name;
}

function databaseLabel(connection: ConnectionConfig, database: string): string {
  if (targetUsesConnectionOnlyScope(connection)) return t("multiDbExecute.connectionOnlyTarget");
  if (database) return database;
  if (targetIsSingleDatabase(connection)) return t("multiDbExecute.defaultDatabase");
  return t("multiDbExecute.noDatabase");
}

function statusLabel(status: MultiDbExecutionItemStatus): string {
  const labels: Record<MultiDbExecutionItemStatus, string> = {
    pending: t("multiDbExecute.pending"),
    running: t("multiDbExecute.running"),
    success: t("multiDbExecute.success"),
    failed: t("multiDbExecute.failed"),
    skipped: t("multiDbExecute.skipped"),
    cancelled: t("multiDbExecute.cancelled"),
    not_executed: t("multiDbExecute.notExecuted"),
  };
  return labels[status];
}

function validationReasonLabel(reason?: string): string {
  if (!reason) return t("multiDbExecute.targetValidationFailed");
  const key = reason as SqlExecutionTargetValidationReason;
  return t(`multiDbExecute.${key}`);
}

function isSelected(target: MultiDbExecutionTarget): boolean {
  return selectedTargetKeys.value.has(targetKey(target));
}

function validationFor(target: MultiDbExecutionTarget): SqlExecutionTargetValidation | undefined {
  return validationByKey.value.get(targetKey(target));
}

function resolveTargetDatabaseType(target: MultiDbExecutionTarget): DatabaseType | undefined {
  return effectiveDatabaseTypeForConnection(targetSelection.connection(target.connectionId));
}

function selectionState(targets: MultiDbExecutionTarget[]): "none" | "partial" | "all" {
  if (targets.length === 0) return "none";
  const selected = targets.filter(isSelected).length;
  if (selected === 0) return "none";
  if (selected === targets.length) return "all";
  return "partial";
}

function toggleTargets(targets: MultiDbExecutionTarget[]): void {
  if (isExecuting.value || targets.length === 0) return;
  const state = selectionState(targets);
  const keys = new Set(targets.map(targetKey));
  ignoreSelectionChange.value = true;
  if (state === "all") {
    selectedTargets.value = selectedTargets.value.filter((target) => !keys.has(targetKey(target)));
  } else {
    const existing = new Set(selectedTargets.value.map(targetKey));
    selectedTargets.value = [...selectedTargets.value, ...targets.filter((target) => !existing.has(targetKey(target)))];
  }
  ignoreSelectionChange.value = false;
  manualSelectionTouched.value = true;
  markTargetsNeedsRecheck();
  void validateSelectedTargets();
}

function toggleTarget(target: MultiDbExecutionTarget): void {
  toggleTargets([target]);
}

function markTargetsNeedsRecheck(): void {
  const existing = validationByKey.value;
  validationResults.value = selectedTargets.value.map((target) => existing.get(targetKey(target)) ?? { target, state: "needsRecheck" });
}

async function validateSelectedTargets(): Promise<boolean> {
  const run = ++validationRun;
  if (!selectedTargets.value.length) {
    validationResults.value = [];
    return false;
  }
  validating.value = true;
  try {
    const results = await targetSelection.validateTargets(selectedTargets.value);
    if (run !== validationRun) return false;
    validationResults.value = results;
    return validationResults.value.every((entry) => entry.state === "valid");
  } finally {
    if (run === validationRun) validating.value = false;
  }
}

function connectionExpanded(connectionId: string): boolean {
  return expandedConnections.value.has(connectionId);
}

function catalogKey(connectionId: string, catalog?: string): string {
  return `${connectionId}:catalog:${catalog || "__internal__"}`;
}

function databaseKey(connectionId: string, catalog: string | undefined, database: string): string {
  return `${connectionId}:database:${catalog || "__internal__"}:${database || "__default__"}`;
}

function databaseTarget(connectionId: string, catalog: string | undefined, database: string, schema?: string): MultiDbExecutionTarget {
  return {
    connectionId,
    ...(catalog ? { catalog } : {}),
    database,
    ...(schema ? { schema } : {}),
  };
}

function databaseTargets(connectionId: string, catalog: string | undefined, database: string): MultiDbExecutionTarget[] {
  const connection = targetSelection.connection(connectionId);
  if (!connection) return [];
  const base = databaseTarget(connectionId, catalog, database);
  if (!targetSupportsSchema(connection)) return [base];
  const schemas = targetSelection.schemaNamesForTarget(base);
  return schemas.length > 0 ? schemas.map((schema) => databaseTarget(connectionId, catalog, database, schema)) : [base];
}

function catalogTargets(connectionId: string, catalog: MultiDbTargetCatalogOption): MultiDbExecutionTarget[] {
  const databases = targetSelection.databaseNamesForConnection(connectionId, catalog.targetCatalog);
  return databases.flatMap((database) => databaseTargets(connectionId, catalog.targetCatalog, database));
}

function connectionTargets(connection: ConnectionConfig): MultiDbExecutionTarget[] {
  if (targetUsesConnectionOnlyScope(connection)) return [{ connectionId: connection.id, database: "" }];
  if (targetSupportsCatalog(connection)) {
    return targetSelection.catalogsForConnection(connection.id).flatMap((catalog) => catalogTargets(connection.id, catalog));
  }
  const databases = targetSelection.databaseNamesForConnection(connection.id);
  if (databases.length === 0 && targetAllowsEmptyDatabase(connection)) return [{ connectionId: connection.id, database: "" }];
  return databases.flatMap((database) => databaseTargets(connection.id, undefined, database));
}

function queryMatches(...values: Array<string | undefined>): boolean {
  if (!searchQuery.value) return true;
  return values.some((value) => value?.toLocaleLowerCase().includes(searchQuery.value));
}

function schemaVisible(connection: ConnectionConfig, catalog: string | undefined, database: string, schema: string): boolean {
  return queryMatches(connectionLabel(connection), catalog, database, schema);
}

function databaseVisible(connection: ConnectionConfig, catalog: string | undefined, database: string): boolean {
  if (queryMatches(connectionLabel(connection), catalog, database)) return true;
  if (!targetSupportsSchema(connection)) return false;
  const base = databaseTarget(connection.id, catalog, database);
  return targetSelection.schemaNamesForTarget(base).some((schema) => schemaVisible(connection, catalog, database, schema));
}

function catalogVisible(connection: ConnectionConfig, catalog: MultiDbTargetCatalogOption): boolean {
  if (queryMatches(connectionLabel(connection), catalog.name)) return true;
  return targetSelection.databaseNamesForConnection(connection.id, catalog.targetCatalog).some((database) => databaseVisible(connection, catalog.targetCatalog, database));
}

function connectionVisible(connection: ConnectionConfig): boolean {
  // Connections are the lazy-loading root of the selector. Do not hide an
  // unexpanded compatible connection merely because its database metadata has
  // not been requested yet; users must be able to expand it first.
  if (!searchQuery.value) return true;
  if (!expandedConnections.value.has(connection.id)) return queryMatches(connectionLabel(connection), connection.id);
  if (queryMatches(connectionLabel(connection), connection.id)) return true;
  if (targetUsesConnectionOnlyScope(connection)) return false;
  if (targetSupportsCatalog(connection)) return targetSelection.catalogsForConnection(connection.id).some((catalog) => catalogVisible(connection, catalog));
  return targetSelection.databaseNamesForConnection(connection.id).some((database) => databaseVisible(connection, undefined, database));
}

async function toggleConnection(connection: ConnectionConfig): Promise<void> {
  const next = new Set(expandedConnections.value);
  if (next.has(connection.id)) {
    next.delete(connection.id);
  } else {
    next.add(connection.id);
    await targetSelection.loadConnection(connection.id).catch(() => {});
  }
  expandedConnections.value = next;
}

async function toggleConnectionSelection(connection: ConnectionConfig): Promise<void> {
  if (isExecuting.value) return;
  await targetSelection.loadConnection(connection.id).catch(() => {});
  if (targetUsesConnectionOnlyScope(connection)) {
    toggleTargets(connectionTargets(connection));
    return;
  }
  if (targetSupportsCatalog(connection)) {
    await targetSelection.loadCatalogs(connection.id).catch(() => {});
    for (const catalog of targetSelection.catalogsForConnection(connection.id)) {
      await targetSelection.loadDatabase(connection.id, catalog.targetCatalog).catch(() => {});
      if (targetSupportsSchema(connection)) {
        for (const database of targetSelection.databaseNamesForConnection(connection.id, catalog.targetCatalog)) {
          await targetSelection.loadSchemas(databaseTarget(connection.id, catalog.targetCatalog, database)).catch(() => {});
        }
      }
    }
  } else {
    const databases = targetSelection.databaseNamesForConnection(connection.id);
    if (targetSupportsSchema(connection)) {
      for (const database of databases) {
        await targetSelection.loadSchemas(databaseTarget(connection.id, undefined, database)).catch(() => {});
      }
    }
  }
  toggleTargets(connectionTargets(connection));
}

async function toggleCatalog(connectionId: string, catalog: MultiDbTargetCatalogOption): Promise<void> {
  const key = catalogKey(connectionId, catalog.targetCatalog);
  const next = new Set(expandedCatalogs.value);
  if (next.has(key)) next.delete(key);
  else {
    next.add(key);
    await targetSelection.loadDatabase(connectionId, catalog.targetCatalog).catch(() => {});
  }
  expandedCatalogs.value = next;
}

async function toggleCatalogSelection(connectionId: string, catalog: MultiDbTargetCatalogOption): Promise<void> {
  if (isExecuting.value) return;
  await targetSelection.loadDatabase(connectionId, catalog.targetCatalog).catch(() => {});
  const connection = targetSelection.connection(connectionId);
  if (connection && targetSupportsSchema(connection)) {
    for (const database of targetSelection.databaseNamesForConnection(connectionId, catalog.targetCatalog)) {
      await targetSelection.loadSchemas(databaseTarget(connectionId, catalog.targetCatalog, database)).catch(() => {});
    }
  }
  toggleTargets(catalogTargets(connectionId, catalog));
}

async function toggleDatabase(connectionId: string, catalog: string | undefined, database: string): Promise<void> {
  const key = databaseKey(connectionId, catalog, database);
  const next = new Set(expandedDatabases.value);
  const connection = targetSelection.connection(connectionId);
  if (next.has(key)) next.delete(key);
  else {
    next.add(key);
    if (connection && targetSupportsSchema(connection)) await targetSelection.loadSchemas(databaseTarget(connectionId, catalog, database)).catch(() => {});
  }
  expandedDatabases.value = next;
}

async function toggleDatabaseSelection(connectionId: string, catalog: string | undefined, database: string): Promise<void> {
  if (isExecuting.value) return;
  const connection = targetSelection.connection(connectionId);
  if (connection && targetSupportsSchema(connection)) {
    await targetSelection.loadSchemas(databaseTarget(connectionId, catalog, database)).catch(() => {});
  }
  toggleTargets(databaseTargets(connectionId, catalog, database));
}

async function retryConnection(connectionId: string): Promise<void> {
  await targetSelection.loadConnection(connectionId).catch(() => {});
}

async function retryDatabase(connectionId: string, catalog?: string): Promise<void> {
  await targetSelection.loadDatabase(connectionId, catalog).catch(() => {});
}

async function retryDatabaseSchemas(connectionId: string, catalog: string | undefined, database: string): Promise<void> {
  await targetSelection.loadSchemas(databaseTarget(connectionId, catalog, database)).catch(() => {});
}

function setTargets(targets: MultiDbExecutionTarget[], options: { manual?: boolean } = {}): void {
  ignoreSelectionChange.value = true;
  selectedTargets.value = dedupeMultiDbExecutionTargets(targets);
  ignoreSelectionChange.value = false;
  manualSelectionTouched.value = options.manual === true;
  validationResults.value = selectedTargets.value.map((target) => ({ target, state: "needsRecheck" }));
}

function applyGroup(group: SqlExecutionTargetGroup): void {
  selectedGroupId.value = group.id;
  setTargets(group.targets);
  manageGroups.value = false;
  void validateSelectedTargets();
}

function requestGroupSelection(id: string): void {
  if (!id) {
    if (hasUnsavedChanges.value) {
      pendingGroupId.value = null;
      pendingClose.value = false;
      unsavedPromptOpen.value = true;
      return;
    }
    selectedGroupId.value = undefined;
    setTargets([], { manual: true });
    return;
  }
  if (hasUnsavedChanges.value) {
    pendingGroupId.value = id;
    pendingClose.value = false;
    unsavedPromptOpen.value = true;
    return;
  }
  const group = compatibleGroups.value.find((candidate) => candidate.id === id);
  if (group) applyGroup(group);
}

function discardAndContinue(): void {
  const nextGroupId = pendingGroupId.value;
  const shouldClose = pendingClose.value;
  pendingGroupId.value = undefined;
  pendingClose.value = false;
  unsavedPromptOpen.value = false;
  if (shouldClose) {
    open.value = false;
    return;
  }
  if (nextGroupId === null) {
    selectedGroupId.value = undefined;
    setTargets([], { manual: false });
    return;
  }
  if (nextGroupId) {
    const group = compatibleGroups.value.find((candidate) => candidate.id === nextGroupId);
    if (group) applyGroup(group);
  }
}

function savePendingChanges(): void {
  const continuation = () => {
    const nextGroupId = pendingGroupId.value;
    const shouldClose = pendingClose.value;
    pendingGroupId.value = undefined;
    pendingClose.value = false;
    if (shouldClose) {
      open.value = false;
      return;
    }
    if (nextGroupId === null) {
      selectedGroupId.value = undefined;
      setTargets([], { manual: false });
      return;
    }
    if (nextGroupId) {
      const group = compatibleGroups.value.find((candidate) => candidate.id === nextGroupId);
      if (group) applyGroup(group);
    }
  };
  unsavedPromptOpen.value = false;
  pendingAfterSave.value = continuation;
  openGroupNameDialog(selectedGroupId.value ? "update" : "create");
}

function cancelUnsavedPrompt(): void {
  pendingGroupId.value = undefined;
  pendingClose.value = false;
  unsavedPromptOpen.value = false;
}

function requestClose(): void {
  if (isExecuting.value) {
    open.value = false;
    return;
  }
  if (hasUnsavedChanges.value) {
    pendingClose.value = true;
    pendingGroupId.value = undefined;
    unsavedPromptOpen.value = true;
    return;
  }
  open.value = false;
}

function openGroupNameDialog(mode: "create" | "update" | "clone" | "rename", group?: SqlExecutionTargetGroup): void {
  if ((mode === "create" || mode === "update" || mode === "clone") && !canSaveGroup.value) return;
  groupNameMode.value = mode;
  editingGroupId.value = group?.id;
  groupName.value = mode === "rename" ? (group?.name ?? "") : mode === "update" ? (currentGroup.value?.name ?? "") : "";
  groupNameDialogOpen.value = true;
}

function groupNameError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("不能为空")) return t("multiDbExecute.groupNameRequired");
  if (message.includes("已存在")) return t("multiDbExecute.groupNameExists");
  return t("multiDbExecute.groupSaveFailed", { message });
}

function confirmGroupName(): void {
  const name = groupName.value.trim();
  if (!name) return;
  try {
    if (groupNameMode.value === "rename") {
      const group = editingGroupId.value ? targetGroupStore.getGroup(editingGroupId.value) : undefined;
      if (!group) return;
      targetGroupStore.updateGroup(group.id, { name, resolveDatabaseType: resolveTargetDatabaseType });
      toast(t("multiDbExecute.groupSaved"));
    } else if (groupNameMode.value === "update") {
      const group = currentGroup.value;
      if (!group) return;
      targetGroupStore.updateGroup(group.id, { targets: selectedTargets.value, resolveDatabaseType: resolveTargetDatabaseType });
      manualSelectionTouched.value = false;
      void validateSelectedTargets();
      toast(t("multiDbExecute.groupSaved"));
    } else {
      const created = targetGroupStore.createGroup({ name, databaseType: props.databaseType!, targets: selectedTargets.value, resolveDatabaseType: resolveTargetDatabaseType });
      selectedGroupId.value = created.id;
      manualSelectionTouched.value = false;
      toast(t("multiDbExecute.groupSaved"));
    }
    groupNameDialogOpen.value = false;
    const afterSave = pendingAfterSave.value;
    pendingAfterSave.value = undefined;
    afterSave?.();
  } catch (error) {
    toast(groupNameError(error), 5000);
  }
}

function cancelGroupNameDialog(): void {
  groupNameDialogOpen.value = false;
  pendingAfterSave.value = undefined;
}

function confirmDeleteGroup(): void {
  const id = deleteGroupId.value;
  if (!id) return;
  targetGroupStore.deleteGroup(id);
  if (selectedGroupId.value === id) {
    selectedGroupId.value = undefined;
    setTargets([], { manual: false });
  }
  deleteGroupId.value = undefined;
}

function groupNameForId(id: string): string {
  return targetGroupStore.getGroup(id)?.name ?? id;
}

function openForNewBatch(): void {
  execution.reset();
  executionStarted.value = false;
  executionMode.value = "serial";
  trackedBatchId = undefined;
  manageGroups.value = false;
  selectedGroupId.value = undefined;
  searchText.value = "";
  expandedCatalogs.value = new Set();
  expandedDatabases.value = new Set();
  const initial = dedupeMultiDbExecutionTargets(props.initialTargets);
  setTargets(initial);
  expandedConnections.value = new Set(initial.map((target) => target.connectionId));
  for (const connectionId of expandedConnections.value) void targetSelection.loadConnection(connectionId).catch(() => {});
  void validateSelectedTargets();
}

async function startExecution(): Promise<void> {
  // Metadata can change while the dialog is open (connection removal,
  // permission changes, or a database/schema refresh). Always perform the
  // execution-time validation required by the target-group contract instead
  // of relying solely on the last background validation result.
  const valid = await validateSelectedTargets();
  if (!valid || !canExecute.value) return;
  if (selectedGroupId.value) targetGroupStore.markGroupUsed(selectedGroupId.value);
  executionStarted.value = true;
  void execution.start(props.sql, selectedTargets.value, { sourceOffset: props.sourceOffset }, executionMode.value);
}

function removeSelected(target: MultiDbExecutionTarget): void {
  if (isExecuting.value) return;
  selectedTargets.value = selectedTargets.value.filter((candidate) => targetKey(candidate) !== targetKey(target));
  manualSelectionTouched.value = true;
  markTargetsNeedsRecheck();
  void validateSelectedTargets();
}

function resetSelection(): void {
  if (isExecuting.value) return;
  selectedGroupId.value = undefined;
  setTargets([], { manual: true });
}

function statusClass(status: MultiDbExecutionItemStatus): string {
  if (status === "success") return "text-emerald-600 dark:text-emerald-300";
  if (status === "failed") return "text-destructive";
  if (status === "running") return "text-primary";
  if (status === "skipped" || status === "cancelled") return "text-amber-600 dark:text-amber-300";
  return "text-muted-foreground";
}

watch(
  selectedTargets,
  () => {
    if (ignoreSelectionChange.value) return;
    markTargetsNeedsRecheck();
  },
  { deep: true },
);

watch(
  () => [open.value, props.launchId] as const,
  ([value, launchId]) => {
    if (value && launchId !== initializedLaunchId) {
      initializedLaunchId = launchId;
      openForNewBatch();
    }
  },
  { immediate: true },
);

watch(
  () => props.databaseType,
  (value) => {
    if (!value || !open.value) return;
    void validateSelectedTargets();
  },
);
</script>

<template>
  <Dialog :open="open" @update:open="(value) => (value ? (open = true) : requestClose())">
    <DialogContent class="flex h-[min(88vh,860px)] max-w-[min(1080px,calc(100vw-32px))] flex-col gap-0 overflow-hidden p-0">
      <DialogHeader class="shrink-0 border-b px-5 py-3">
        <DialogTitle class="flex items-center gap-2">
          <Layers class="h-5 w-5 text-primary" />
          {{ executionStarted ? t("multiDbExecute.progress") : t("multiDbExecute.title") }}
        </DialogTitle>
      </DialogHeader>

      <div v-if="executionStarted && batch" class="flex min-h-0 flex-1 flex-col">
        <div class="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-5 py-3 text-xs text-muted-foreground">
          <span>{{ t("multiDbExecute.progress", { completed: progressCompleted, total: batch.items.length }) }}</span>
          <Badge variant="secondary">{{ executionModeLabel() }}</Badge>
          <span class="tabular-nums">{{ t("multiDbExecute.elapsed", { duration: formatDataTransferDuration(elapsedMs) }) }}</span>
          <Badge variant="outline">{{ t("multiDbExecute.success") }} {{ progressCounts.success }}</Badge>
          <Badge variant="outline">{{ t("multiDbExecute.failed") }} {{ progressCounts.failed }}</Badge>
          <Badge variant="outline">{{ t("multiDbExecute.skipped") }} {{ progressCounts.skipped }}</Badge>
          <Badge variant="outline">{{ t("multiDbExecute.notExecuted") }} {{ progressCounts.notExecuted }}</Badge>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div class="space-y-2">
            <div v-for="item in batch.items" :key="item.id" class="flex min-w-0 items-start gap-3 rounded-md border px-3 py-2">
              <Loader2 v-if="item.status === 'running'" class="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />
              <Check v-else-if="item.status === 'success'" class="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
              <AlertTriangle v-else-if="item.status === 'failed'" class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <X v-else-if="item.status === 'skipped' || item.status === 'cancelled'" class="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div v-else class="mt-0.5 h-4 w-4 shrink-0 rounded-full border border-muted-foreground/40" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm" :class="statusClass(item.status)">{{ targetLabel(item.target) }}</div>
                <div class="text-xs text-muted-foreground">{{ statusLabel(item.status) }}</div>
                <div v-if="item.durationMs !== undefined" class="text-xs tabular-nums text-muted-foreground">{{ t("multiDbExecute.elapsed", { duration: formatDataTransferDuration(item.durationMs) }) }}</div>
                <div v-if="item.errorMessage" class="mt-1 whitespace-pre-wrap break-words text-xs text-destructive">{{ item.errorMessage }}</div>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter class="mx-0 mb-0 shrink-0 border-t px-5 py-3">
          <Button v-if="isExecuting" variant="destructive" class="gap-1.5" @click="execution.cancel()">
            <X class="h-4 w-4" />
            {{ t("multiDbExecute.cancelBatch") }}
          </Button>
          <Button v-if="isExecuting" variant="outline" @click="requestClose">{{ t("exportProgress.minimize") }}</Button>
          <Button v-else @click="requestClose">{{ t("common.close") }}</Button>
        </DialogFooter>
      </div>

      <div v-else-if="manageGroups" class="flex min-h-0 flex-1 flex-col">
        <div class="flex items-center justify-between border-b px-5 py-3">
          <div>
            <div class="text-sm font-medium">{{ t("multiDbExecute.manageGroups") }}</div>
            <div class="text-xs text-muted-foreground">{{ t("multiDbExecute.manageGroupsDescription") }}</div>
          </div>
          <Button variant="ghost" size="icon-sm" :aria-label="t('common.close')" @click="manageGroups = false">
            <X class="h-4 w-4" />
          </Button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div v-if="allGroups.length === 0" class="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">{{ t("multiDbExecute.noGroups") }}</div>
          <div v-else class="space-y-2">
            <div v-for="group in allGroups" :key="group.id" class="flex items-center gap-3 rounded-md border px-3 py-2">
              <FolderOpen class="h-4 w-4 shrink-0 text-muted-foreground" />
              <div class="min-w-0 flex-1">
                <div class="truncate text-sm font-medium">{{ group.name }}</div>
                <div class="text-xs text-muted-foreground">{{ group.databaseType }} · {{ group.targets.length }} {{ t("multiDbExecute.targets") }}</div>
              </div>
              <Badge v-if="group.databaseType === props.databaseType" variant="secondary">{{ t("multiDbExecute.available") }}</Badge>
              <Badge v-else variant="outline">{{ t("multiDbExecute.typeMismatch") }}</Badge>
              <Button variant="ghost" size="icon-sm" :disabled="group.databaseType !== props.databaseType" :title="t('multiDbExecute.loadGroup')" @click="requestGroupSelection(group.id)">
                <FolderOpen class="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" :title="t('multiDbExecute.renameGroup')" @click="openGroupNameDialog('rename', group)">
                <Pencil class="h-4 w-4" />
              </Button>
              <Button variant="ghost" size="icon-sm" class="text-destructive" :title="t('multiDbExecute.deleteGroup')" @click="deleteGroupId = group.id">
                <Trash2 class="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter class="mx-0 mb-0 shrink-0 border-t px-5 py-3">
          <Button variant="outline" @click="manageGroups = false">{{ t("common.close") }}</Button>
        </DialogFooter>
      </div>

      <div v-else class="flex min-h-0 flex-1 flex-col">
        <div class="grid shrink-0 gap-3 border-b px-5 py-3 md:grid-cols-[minmax(0,1fr)_minmax(240px,320px)]">
          <div class="min-w-0">
            <div class="mb-1 text-xs font-medium text-muted-foreground">{{ t("multiDbExecute.sqlPreview") }}</div>
            <pre class="max-h-24 overflow-auto rounded-md bg-muted/50 px-3 py-2 text-xs leading-5 font-mono whitespace-pre-wrap">{{ sql }}</pre>
          </div>
          <div class="space-y-2">
            <div class="flex items-center justify-between text-xs font-medium text-muted-foreground">
              <span>{{ t("multiDbExecute.selectGroup") }}</span>
              <Button variant="ghost" size="sm" class="h-6 px-1.5 text-xs" @click="manageGroups = true"><Settings2 class="mr-1 h-3.5 w-3.5" />{{ t("multiDbExecute.manageGroups") }}</Button>
            </div>
            <select class="h-8 w-full rounded-md border border-input bg-background px-2 text-sm" :value="selectedGroupId || ''" :disabled="isExecuting" @change="requestGroupSelection(($event.target as HTMLSelectElement).value)">
              <option value="">{{ t("multiDbExecute.noGroupSelected") }}</option>
              <option v-for="group in compatibleGroups" :key="group.id" :value="group.id">{{ group.name }} · {{ group.targets.length }}</option>
            </select>
            <div class="flex items-center justify-between text-xs text-muted-foreground">
              <span
                >{{ t("multiDbExecute.databaseType") }}: <strong class="text-foreground">{{ databaseType || "-" }}</strong></span
              >
              <span>{{ t("multiDbExecute.selectedCount", { count: selectedTargets.length }) }}</span>
            </div>
          </div>
        </div>

        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden px-5 py-3">
          <div class="flex shrink-0 items-center gap-2">
            <div class="relative min-w-0 flex-1">
              <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="searchText" class="h-8 pl-8 text-xs" :placeholder="t('multiDbExecute.searchTargets')" />
            </div>
            <Button variant="outline" size="sm" :disabled="!selectedTargets.length || isExecuting" @click="resetSelection">{{ t("multiDbExecute.clearTargets") }}</Button>
          </div>

          <div class="grid min-h-0 flex-1 gap-3 lg:grid-cols-[minmax(0,1.15fr)_minmax(300px,0.85fr)]">
            <div class="min-h-0 overflow-y-auto rounded-md border bg-muted/10 p-2">
              <div v-if="compatibleConnections.length === 0" class="flex h-full min-h-40 items-center justify-center text-center text-sm text-muted-foreground">{{ t("multiDbExecute.noTargets") }}</div>
              <div v-else class="space-y-1">
                <template v-for="connection in compatibleConnections" :key="connection.id">
                  <div v-if="connectionVisible(connection)" class="rounded-md border bg-background/70">
                    <div class="flex items-center gap-1 px-2 py-1.5">
                      <button type="button" class="rounded p-0.5 hover:bg-muted" :aria-label="connectionExpanded(connection.id) ? t('common.collapse') : t('common.expand')" @click="toggleConnection(connection)">
                        <ChevronDown v-if="connectionExpanded(connection.id)" class="h-3.5 w-3.5" />
                        <ChevronRight v-else class="h-3.5 w-3.5" />
                      </button>
                      <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :disabled="isExecuting" @click="toggleConnectionSelection(connection)">
                        <CheckSquare v-if="selectionState(connectionTargets(connection)) === 'all'" class="h-4 w-4 shrink-0 text-primary" />
                        <MinusSquare v-else-if="selectionState(connectionTargets(connection)) === 'partial'" class="h-4 w-4 shrink-0 text-primary" />
                        <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
                        <DatabaseIcon :db-type="connection.db_type" class="h-4 w-4 shrink-0" />
                        <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ connectionLabel(connection) }}</span>
                      </button>
                      <Loader2 v-if="targetSelection.resourceState(`catalogs:${connection.id}`).loading || targetSelection.databaseState(connection.id).loading" class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      <Button v-if="targetSelection.resourceState(`catalogs:${connection.id}`).error || targetSelection.databaseState(connection.id).error" variant="ghost" size="icon-sm" :title="t('multiDbExecute.retryValidation')" @click="retryConnection(connection.id)"
                        ><RefreshCw class="h-3.5 w-3.5"
                      /></Button>
                    </div>

                    <div v-if="connectionExpanded(connection.id)" class="border-t px-2 py-1">
                      <template v-if="targetUsesConnectionOnlyScope(connection)">
                        <div class="flex items-center gap-2 rounded px-1 py-2 text-xs text-muted-foreground">
                          <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :disabled="isExecuting" @click="toggleConnectionSelection(connection)">
                            <CheckSquare v-if="selectionState(connectionTargets(connection)) === 'all'" class="h-4 w-4 shrink-0 text-primary" />
                            <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
                            <span class="truncate">{{ t("multiDbExecute.connectionOnlyTarget") }}</span>
                          </button>
                        </div>
                      </template>
                      <template v-else-if="targetSupportsCatalog(connection)">
                        <div v-if="targetSelection.catalogsForConnection(connection.id).length === 0 && !targetSelection.catalogState(connection.id).loading" class="px-7 py-2 text-xs text-muted-foreground">{{ t("multiDbExecute.noTargets") }}</div>
                        <div v-for="catalog in targetSelection.catalogsForConnection(connection.id)" :key="catalogKey(connection.id, catalog.targetCatalog)" class="rounded">
                          <div v-if="catalogVisible(connection, catalog)" class="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                            <button type="button" class="rounded p-0.5 hover:bg-muted" @click="toggleCatalog(connection.id, catalog)">
                              <ChevronDown v-if="expandedCatalogs.has(catalogKey(connection.id, catalog.targetCatalog))" class="h-3.5 w-3.5" />
                              <ChevronRight v-else class="h-3.5 w-3.5" />
                            </button>
                            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :disabled="isExecuting" @click="toggleCatalogSelection(connection.id, catalog)">
                              <CheckSquare v-if="selectionState(catalogTargets(connection.id, catalog)) === 'all'" class="h-4 w-4 shrink-0 text-primary" />
                              <MinusSquare v-else-if="selectionState(catalogTargets(connection.id, catalog)) === 'partial'" class="h-4 w-4 shrink-0 text-primary" />
                              <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
                              <Layers class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span class="truncate text-xs">{{ catalogLabel(catalog) }}</span>
                            </button>
                            <Loader2 v-if="targetSelection.databaseState(connection.id, catalog.targetCatalog).loading" class="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                            <Button v-if="targetSelection.databaseState(connection.id, catalog.targetCatalog).error" variant="ghost" size="icon-sm" :title="t('multiDbExecute.retryValidation')" @click="retryDatabase(connection.id, catalog.targetCatalog)"><RefreshCw class="h-3.5 w-3.5" /></Button>
                          </div>
                          <div v-if="expandedCatalogs.has(catalogKey(connection.id, catalog.targetCatalog))" class="ml-6 border-l pl-2">
                            <template v-for="database in targetSelection.databaseNamesForConnection(connection.id, catalog.targetCatalog)" :key="databaseKey(connection.id, catalog.targetCatalog, database)">
                              <div v-if="databaseVisible(connection, catalog.targetCatalog, database)" class="rounded">
                                <div class="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                                  <button type="button" class="rounded p-0.5 hover:bg-muted" @click="toggleDatabase(connection.id, catalog.targetCatalog, database)">
                                    <ChevronDown v-if="expandedDatabases.has(databaseKey(connection.id, catalog.targetCatalog, database))" class="h-3.5 w-3.5" />
                                    <ChevronRight v-else class="h-3.5 w-3.5" />
                                  </button>
                                  <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :disabled="isExecuting" @click="toggleDatabaseSelection(connection.id, catalog.targetCatalog, database)">
                                    <CheckSquare v-if="selectionState(databaseTargets(connection.id, catalog.targetCatalog, database)) === 'all'" class="h-4 w-4 shrink-0 text-primary" />
                                    <MinusSquare v-else-if="selectionState(databaseTargets(connection.id, catalog.targetCatalog, database)) === 'partial'" class="h-4 w-4 shrink-0 text-primary" />
                                    <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
                                    <span class="truncate text-xs">{{ databaseLabel(connection, database) }}</span>
                                  </button>
                                </div>
                                <div v-if="expandedDatabases.has(databaseKey(connection.id, catalog.targetCatalog, database)) && targetSupportsSchema(connection)" class="ml-6 border-l pl-2">
                                  <div v-if="targetSelection.schemaState(databaseTarget(connection.id, catalog.targetCatalog, database)).error" class="flex items-center gap-2 px-1 py-1 text-xs text-destructive">
                                    <span class="min-w-0 flex-1 truncate">{{ targetSelection.schemaState(databaseTarget(connection.id, catalog.targetCatalog, database)).error }}</span>
                                    <Button variant="ghost" size="icon-sm" @click="retryDatabaseSchemas(connection.id, catalog.targetCatalog, database)"><RefreshCw class="h-3.5 w-3.5" /></Button>
                                  </div>
                                  <template v-for="schema in targetSelection.schemaNamesForTarget(databaseTarget(connection.id, catalog.targetCatalog, database))" :key="schema">
                                    <div v-if="schemaVisible(connection, catalog.targetCatalog, database, schema)" class="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                                      <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :disabled="isExecuting" @click="toggleTarget(databaseTarget(connection.id, catalog.targetCatalog, database, schema))">
                                        <Check v-if="isSelected(databaseTarget(connection.id, catalog.targetCatalog, database, schema))" class="h-4 w-4 shrink-0 text-primary" />
                                        <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
                                        <span class="truncate text-xs text-muted-foreground">{{ schema }}</span>
                                      </button>
                                    </div>
                                  </template>
                                </div>
                              </div>
                            </template>
                          </div>
                        </div>
                      </template>
                      <template v-else>
                        <template v-for="database in targetSelection.databaseNamesForConnection(connection.id)" :key="databaseKey(connection.id, undefined, database)">
                          <div v-if="databaseVisible(connection, undefined, database)" class="rounded">
                            <div class="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                              <button type="button" class="rounded p-0.5 hover:bg-muted" @click="toggleDatabase(connection.id, undefined, database)">
                                <ChevronDown v-if="expandedDatabases.has(databaseKey(connection.id, undefined, database))" class="h-3.5 w-3.5" />
                                <ChevronRight v-else class="h-3.5 w-3.5" />
                              </button>
                              <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :disabled="isExecuting" @click="toggleDatabaseSelection(connection.id, undefined, database)">
                                <CheckSquare v-if="selectionState(databaseTargets(connection.id, undefined, database)) === 'all'" class="h-4 w-4 shrink-0 text-primary" />
                                <MinusSquare v-else-if="selectionState(databaseTargets(connection.id, undefined, database)) === 'partial'" class="h-4 w-4 shrink-0 text-primary" />
                                <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
                                <span class="truncate text-xs">{{ databaseLabel(connection, database) }}</span>
                              </button>
                            </div>
                            <div v-if="expandedDatabases.has(databaseKey(connection.id, undefined, database)) && targetSupportsSchema(connection)" class="ml-6 border-l pl-2">
                              <div v-if="targetSelection.schemaState(databaseTarget(connection.id, undefined, database)).error" class="flex items-center gap-2 px-1 py-1 text-xs text-destructive">
                                <span class="min-w-0 flex-1 truncate">{{ targetSelection.schemaState(databaseTarget(connection.id, undefined, database)).error }}</span>
                                <Button variant="ghost" size="icon-sm" @click="retryDatabaseSchemas(connection.id, undefined, database)"><RefreshCw class="h-3.5 w-3.5" /></Button>
                              </div>
                              <template v-for="schema in targetSelection.schemaNamesForTarget(databaseTarget(connection.id, undefined, database))" :key="schema">
                                <div v-if="schemaVisible(connection, undefined, database, schema)" class="flex items-center gap-1 rounded px-1 py-1 hover:bg-muted/60">
                                  <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left" :disabled="isExecuting" @click="toggleTarget(databaseTarget(connection.id, undefined, database, schema))">
                                    <Check v-if="isSelected(databaseTarget(connection.id, undefined, database, schema))" class="h-4 w-4 shrink-0 text-primary" />
                                    <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
                                    <span class="truncate text-xs text-muted-foreground">{{ schema }}</span>
                                  </button>
                                </div>
                              </template>
                            </div>
                          </div>
                        </template>
                      </template>
                    </div>
                  </div>
                </template>
              </div>
            </div>

            <div class="min-h-0 overflow-hidden rounded-md border bg-background">
              <div class="flex items-center justify-between border-b px-3 py-2">
                <div class="text-xs font-medium">{{ t("multiDbExecute.selectedTargets") }}</div>
                <Badge variant="secondary">{{ selectedTargets.length }}</Badge>
              </div>
              <ScrollArea class="h-full max-h-[calc(88vh-300px)]">
                <div v-if="selectedTargets.length === 0" class="p-5 text-center text-sm text-muted-foreground">{{ t("multiDbExecute.noTargets") }}</div>
                <div v-else class="space-y-1 p-2">
                  <div v-for="target in selectedTargets" :key="targetKey(target)" class="flex min-w-0 items-start gap-2 rounded-md border px-2 py-1.5">
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-xs font-medium">{{ targetLabel(target) }}</div>
                      <div v-if="validationFor(target)?.state === 'invalid'" class="mt-0.5 flex items-start gap-1 text-[11px] text-destructive">
                        <AlertTriangle class="mt-0.5 h-3 w-3 shrink-0" /><span>{{ validationReasonLabel(validationFor(target)?.reason) }}</span>
                      </div>
                      <div v-else-if="validationFor(target)?.state === 'needsRecheck'" class="mt-0.5 text-[11px] text-muted-foreground">{{ t("multiDbExecute.needsRecheck") }}</div>
                      <div v-else class="mt-0.5 text-[11px] text-emerald-600 dark:text-emerald-300">{{ t("multiDbExecute.validTarget") }}</div>
                    </div>
                    <Button variant="ghost" size="icon-sm" :disabled="isExecuting" :title="t('multiDbExecute.removeTarget')" @click="removeSelected(target)"><X class="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              </ScrollArea>
            </div>
          </div>
        </div>

        <div class="flex shrink-0 flex-wrap items-center gap-2 border-t bg-muted/15 px-5 py-2 text-xs text-muted-foreground">
          <span>{{ executionMode === "serial" ? t("multiDbExecute.serialContinueOnError") : t("multiDbExecute.parallelContinueOnError") }}</span>
          <span v-if="validating" class="inline-flex items-center gap-1"><Loader2 class="h-3 w-3 animate-spin" />{{ t("common.loading") }}</span>
          <span v-else-if="invalidTargetCount" class="text-destructive">{{ t("multiDbExecute.invalidTargetCount", { count: invalidTargetCount }) }}</span>
          <span v-else-if="needsRecheckCount" class="text-amber-600 dark:text-amber-300">{{ t("multiDbExecute.needsRecheckCount", { count: needsRecheckCount }) }}</span>
          <span v-if="hasUnsavedChanges" class="text-amber-600 dark:text-amber-300">{{ t("multiDbExecute.groupModified") }}</span>
        </div>

        <DialogFooter class="mx-0 mb-0 shrink-0 flex-wrap border-t px-5 py-3">
          <Button variant="outline" :disabled="isExecuting" @click="openGroupNameDialog('create')">{{ t("multiDbExecute.saveAsGroup") }}</Button>
          <Button v-if="selectedGroupId" variant="outline" :disabled="!canSaveGroup || !hasUnsavedChanges" @click="openGroupNameDialog('update')">{{ t("multiDbExecute.saveChanges") }}</Button>
          <Button v-if="selectedGroupId" variant="outline" :disabled="!canSaveGroup" @click="openGroupNameDialog('clone')">{{ t("multiDbExecute.saveAsNewGroup") }}</Button>
          <span class="flex-1" />
          <Button variant="outline" :disabled="isExecuting" @click="requestClose">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="outline" :disabled="isExecuting" @click="toggleExecutionMode">{{ executionMode === "serial" ? t("multiDbExecute.switchToParallel") : t("multiDbExecute.switchToSerial") }}</Button>
          <Button class="gap-1.5" :disabled="!canExecute" @click="startExecution">
            <Loader2 v-if="validating" class="h-4 w-4 animate-spin" />
            <Play v-else class="h-4 w-4" />
            {{ t("multiDbExecute.execute") }}
          </Button>
        </DialogFooter>
      </div>
    </DialogContent>
  </Dialog>

  <Dialog :open="groupNameDialogOpen" @update:open="(value) => (value ? (groupNameDialogOpen = true) : cancelGroupNameDialog())">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle>{{ groupNameMode === "rename" ? t("multiDbExecute.renameGroup") : groupNameMode === "update" ? t("multiDbExecute.saveChanges") : groupNameMode === "clone" ? t("multiDbExecute.saveAsNewGroup") : t("multiDbExecute.saveAsGroup") }}</DialogTitle>
      </DialogHeader>
      <div class="space-y-2">
        <label class="text-xs font-medium text-muted-foreground">{{ t("multiDbExecute.groupName") }}</label>
        <Input v-model="groupName" autofocus @keydown.enter.prevent="confirmGroupName" />
      </div>
      <DialogFooter>
        <Button variant="outline" @click="cancelGroupNameDialog">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="!groupName.trim()" @click="confirmGroupName">{{ t("common.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="deleteGroupId !== undefined" @update:open="(value) => !value && (deleteGroupId = undefined)">
    <DialogContent class="sm:max-w-[420px]">
      <DialogHeader>
        <DialogTitle class="text-destructive">{{ t("multiDbExecute.deleteGroup") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t("multiDbExecute.deleteGroupConfirm", { name: deleteGroupId ? groupNameForId(deleteGroupId) : "" }) }}</p>
      <DialogFooter>
        <Button variant="outline" @click="deleteGroupId = undefined">{{ t("dangerDialog.cancel") }}</Button>
        <Button variant="destructive" @click="confirmDeleteGroup">{{ t("multiDbExecute.deleteGroup") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog :open="unsavedPromptOpen" @update:open="(value) => !value && cancelUnsavedPrompt()">
    <DialogContent class="sm:max-w-[480px]">
      <DialogHeader>
        <DialogTitle>{{ t("multiDbExecute.groupModified") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t("multiDbExecute.unsavedChangesConfirm") }}</p>
      <DialogFooter class="flex-wrap">
        <Button variant="outline" @click="cancelUnsavedPrompt">{{ t("multiDbExecute.cancelOperation") }}</Button>
        <Button variant="secondary" @click="discardAndContinue">{{ t("multiDbExecute.discardChanges") }}</Button>
        <Button :disabled="!canSaveGroup" @click="savePendingChanges">{{ t("multiDbExecute.saveChanges") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

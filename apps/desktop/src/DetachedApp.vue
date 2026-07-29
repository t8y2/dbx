<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { TooltipProvider } from "@/components/ui/tooltip";
import DetachedTabWindow from "@/components/layout/DetachedTabWindow.vue";
import DetachedWindowShell from "@/components/layout/DetachedWindowShell.vue";
import AppDialogs from "@/components/layout/AppDialogs.vue";
import type { ConfigTab } from "@/components/connection/ConnectionDialog.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { useDialogSources } from "@/composables/useDialogSources";
import { useNavigationTargets } from "@/composables/useNavigationTargets";
import { useSqlExecution } from "@/composables/useSqlExecution";
import { useDataGridActions } from "@/composables/useDataGridActions";
import { clearDataGridPendingSnapshotsForTab, restoreDataGridPendingSnapshotsForTab } from "@/composables/useDataGridEditor";
import * as api from "@/lib/backend/api";
import { translateBackendError } from "@/i18n/backend-errors";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { isSchemaAware, isSingleDatabase } from "@/lib/database/databaseFeatureSupport";
import { schemaAfterConnectionSwitch } from "@/lib/schema/connectionSchemaInitialization";
import { resolveExecutableSql, resolveExecutableSqlWithBackend, type SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import { sqlObjectNavigationSourceKind, sqlObjectNavigationTableType, type SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import { ensureJdbcxRuntimeDrivers } from "@/lib/database/jdbcxBuiltinDriver";
import { externalSqlFileOpenErrorMessage, readBrowserSqlFile, sqlFileTitleFromPath } from "@/lib/sql/sqlFileOpen";
import {
  isBrowserReloadShortcut,
  isCloseTabShortcut,
  isExecuteSqlInNewResultTabShortcut,
  isExecuteSqlShortcut,
  isFocusSearchShortcut,
  isModRShortcut,
  isNewQueryShortcut,
  isObjectSourceSaveShortcutTarget,
  isOpenSettingsShortcut,
  isRefreshDataShortcut,
  isSaveShortcut,
} from "@/lib/editor/keyboardShortcuts";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { buildExecutableObjectSourceStatements, executeObjectSourceSave } from "@/lib/table/objectSourceEditor";
import { codeMirrorSqlDialect, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { destroyDetachedWindowAfterCleanup, listenForDetachedAppCloseChecks, receiveDetachedTab, requestDetachedTabMainWindowAction, type DetachedTabMainWindowAction } from "@/lib/tabs/tabWindow";
import type { DataGridReloadIntent } from "@/lib/dataGrid/dataGridToolbar";
import type { ObjectBrowserViewport, ObjectSourceKind, QueryTab } from "@/types/database";

const QueryEditorDdlViewDialog = defineAsyncComponent(() => import("@/components/objects/DdlViewDialog.vue"));
const QueryEditorObjectSourceDialog = defineAsyncComponent(() => import("@/components/objects/ObjectSourceDialog.vue"));

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const { message: toastMessage, visible: toastVisible, toast } = useToast();
const { applyTheme } = useTheme();
const { getDatabaseOptions } = useDatabaseOptions();
const dialogs = useDialogSources();
const { openTableTarget, onStructureEditorSaved } = useNavigationTargets(dialogs);

connectionStore.setBeforeConnectHandler((config) => ensureJdbcxRuntimeDrivers(config, api).then(() => undefined));

const shellRef = ref<InstanceType<typeof DetachedWindowShell> | null>(null);
const contentAreaRef = ref<InstanceType<typeof DetachedTabWindow> | null>(null);
const selectedSql = ref("");
const cursorPos = ref(0);
const formatSqlRequest = ref<{ id: number; tabId: string } | null>(null);
const compressSqlRequest = ref<{ id: number; tabId: string } | null>(null);
const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
const blockDangerousRedisCommands = ref(true);
const showConnectionDialog = ref(false);
const connectionDialogInitialTab = ref<ConfigTab | undefined>();
const showQueryEditorDdlDialog = ref(false);
const showQueryEditorObjectSourceDialog = ref(false);
const queryEditorDdlTarget = ref<{ connectionId: string; database: string; catalog?: string; schema?: string; tableName: string; objectType?: ObjectSourceKind } | null>(null);
const queryEditorObjectSourceTarget = ref<{ connectionId: string; database: string; schema?: string; name: string; objectType: ObjectSourceKind; initialEditing: boolean } | null>(null);

let unlistenDetachedTabTransfer: UnlistenFn | undefined;
let unlistenDetachedWindowClose: UnlistenFn | undefined;
let unlistenDetachedAppCloseCheck: UnlistenFn | undefined;
let detachedWindowClosing = false;

const activeTab = computed(() => queryStore.tabs.find((tab) => tab.id === queryStore.activeTabId));
const activeConnection = computed(() => {
  const tab = activeTab.value;
  return tab ? connectionStore.getConfig(tab.connectionId) : undefined;
});
const queryEditorDdlDatabaseType = computed(() => {
  if (!queryEditorDdlTarget.value?.connectionId) return undefined;
  return effectiveDatabaseTypeForConnection(connectionStore.getConfig(queryEditorDdlTarget.value.connectionId));
});
const queryEditorDdlDialect = computed(() => codeMirrorSqlDialect(queryEditorDdlDatabaseType.value));
const queryEditorObjectSourceDatabaseType = computed(() => {
  if (!queryEditorObjectSourceTarget.value?.connectionId) return undefined;
  return effectiveDatabaseTypeForConnection(connectionStore.getConfig(queryEditorObjectSourceTarget.value.connectionId));
});
const queryEditorObjectSourceDialect = computed(() => codeMirrorSqlDialect(queryEditorObjectSourceDatabaseType.value));
const queryEditorObjectSourceFormatDialect = computed(() => sqlFormatDialectForDbType(queryEditorObjectSourceDatabaseType.value));
const executableSql = computed(() => {
  const tab = activeTab.value;
  return tab
    ? resolveExecutableSql(tab.sql, selectedSql.value, {
        mode: settingsStore.editorSettings.executeMode,
        cursorPos: cursorPos.value,
      })
    : "";
});

async function resolveActiveExecutableSql(snapshot?: SqlExecutionSnapshot) {
  const tab = activeTab.value;
  return tab
    ? await resolveExecutableSqlWithBackend(snapshot?.fullSql ?? tab.sql, snapshot?.selectedSql ?? selectedSql.value, {
        mode: settingsStore.editorSettings.executeMode,
        cursorPos: snapshot?.cursorPos ?? cursorPos.value,
        databaseType: activeConnection.value?.db_type,
      })
    : "";
}

function promptActiveDatabaseSelection() {
  toast(t("editor.selectDatabaseRequired"), 2500);
}

const {
  dangerSql,
  showDangerDialog,
  suppressDangerConfirm,
  tryExecute,
  tryExecuteInNewResultTab,
  cancelActiveExecution,
  tryExplain,
  onDangerConfirm,
  showSqlParameterDialog,
  sqlParameterSourceSql,
  sqlParameterNames,
  sqlParameterDatabaseType,
  sqlParameterEnabledSyntaxes,
  onSqlParametersConfirm,
  explainMode,
} = useSqlExecution({
  activeTab,
  activeConnection,
  executableSql,
  resolveExecutableSql: resolveActiveExecutableSql,
  activeOutputView,
  blockDangerousRedisCommands,
  onMissingDatabase: promptActiveDatabaseSelection,
});
const { onExecuteSql, onReloadData, onPaginate, onSort } = useDataGridActions(activeTab);

function rejectMainWindowFeature() {
  toast(t("tabs.detachedWindowSingleTab"), 3000);
}

function forwardToMainWindow(action: DetachedTabMainWindowAction) {
  void requestDetachedTabMainWindowAction(action).catch((error) => {
    toast(t("tabs.openTabWindowFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  });
}

function tableTargetFromActiveTab(table: string | SqlObjectNavigationTarget) {
  const tab = activeTab.value;
  if (!tab) return undefined;
  const connectionId = tab.connectionId;
  const catalog = tab.tableMeta?.catalog || tab.catalog;
  if (typeof table !== "string") {
    // Structured targets preserve quoted names and qualifiers without reparsing.
    return {
      connectionId,
      database: table.database || tab.database,
      catalog,
      schema: table.schema || tab.schema,
      tableName: table.name,
      tableType: table.type ? sqlObjectNavigationTableType(table) : undefined,
    };
  }

  let database = tab.database;
  let schema = tab.schema;
  const parts = table.split(".").filter(Boolean);
  const tableName = parts[parts.length - 1] || table;
  if (parts.length >= 3) {
    database = parts[parts.length - 3] || database;
    schema = parts[parts.length - 2];
  } else if (parts.length === 2) {
    const databaseType = connectionStore.getConfig(connectionId)?.db_type;
    if (databaseType && !isSchemaAware(databaseType) && !isSingleDatabase(databaseType)) {
      database = parts[0] || database;
      schema = undefined;
    } else {
      schema = parts[0];
    }
  }
  return { connectionId, database, catalog, schema, tableName };
}

async function openTableInDetachedWindow(table: string | SqlObjectNavigationTarget, tableInfoTab?: "ddl") {
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  await openTableTarget(target, { tableInfoTab, replaceActiveInDetached: true });
  activeOutputView.value = "result";
}

function openTableDdlInDetachedWindow(table: string | SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  queryEditorDdlTarget.value = {
    ...target,
    objectType: typeof table === "string" ? undefined : sqlObjectNavigationSourceKind(table),
  };
  showQueryEditorDdlDialog.value = true;
}

function openClickedTableInDetachedWindow(table: string | SqlObjectNavigationTarget) {
  if (typeof table !== "string" && sqlObjectNavigationSourceKind(table)) {
    openTableDdlInDetachedWindow(table);
    return;
  }
  void openTableInDetachedWindow(table, "ddl");
}

async function editTableStructureInDetachedWindow(table: string | SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  await connectionStore.ensureConnected(target.connectionId);
  await queryStore.replaceActiveTabForDetachedNavigation();
  queryStore.openTableStructure(target.connectionId, target.database, target.schema, target.tableName, undefined, undefined, target.catalog);
}

async function openObjectSourceInDetachedWindow(table: string | SqlObjectNavigationTarget, initialEditing: boolean) {
  if (typeof table === "string") return;
  const target = tableTargetFromActiveTab(table);
  const objectType = sqlObjectNavigationSourceKind(table);
  if (!target || !objectType) return;
  try {
    await connectionStore.ensureConnected(target.connectionId);
    connectionStore.activeConnectionId = target.connectionId;
    queryEditorObjectSourceTarget.value = {
      connectionId: target.connectionId,
      database: target.database,
      schema: target.schema,
      name: target.tableName,
      objectType,
      initialEditing,
    };
    showQueryEditorObjectSourceDialog.value = true;
  } catch (error: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, error?.message || String(error)) }), 5000);
  }
}

function onQueryEditorObjectSourceSaved() {
  const target = queryEditorObjectSourceTarget.value;
  if (!target) return;
  connectionStore.invalidateCompletionCache(target.connectionId, target.database);
  contentAreaRef.value?.refreshQueryEditorCompletionCache();
}

async function openObjectTableInDetachedWindow(target: { schema?: string; catalog?: string; tableName: string; tableType?: string }) {
  const tab = activeTab.value;
  if (!tab) return;
  await openTableTarget(
    {
      connectionId: tab.connectionId,
      database: tab.database,
      schema: target.schema,
      catalog: target.catalog,
      tableName: target.tableName,
      tableType: target.tableType,
    },
    { replaceActiveInDetached: true },
  );
  activeOutputView.value = "result";
}

function formatActiveSql() {
  const tab = activeTab.value;
  if (!tab || tab.mode !== "query" || !tab.sql.trim()) return;
  formatSqlRequest.value = {
    id: (formatSqlRequest.value?.id ?? 0) + 1,
    tabId: tab.id,
  };
}

function compressActiveSql() {
  const tab = activeTab.value;
  if (!tab || tab.mode !== "query" || !tab.sql.trim()) return;
  compressSqlRequest.value = {
    id: (compressSqlRequest.value?.id ?? 0) + 1,
    tabId: tab.id,
  };
}

function toggleSqlKeywordCase() {
  const sqlFormatter = settingsStore.editorSettings.sqlFormatter;
  settingsStore.updateEditorSettings({
    sqlFormatter: {
      ...sqlFormatter,
      keywordCase: sqlFormatter.keywordCase === "lower" ? "upper" : "lower",
    },
  });
}

function defaultSqlFileName(tab: QueryTab): string {
  const normalized = (tab.title.trim() || "query").replace(/\s+/g, "_");
  return normalized.endsWith(".sql") ? normalized : `${normalized}.sql`;
}

async function saveActiveObjectSource(tab: QueryTab): Promise<boolean> {
  const connection = connectionStore.getConfig(tab.connectionId);
  const source = tab.objectSource;
  if (!connection || !source) return false;
  try {
    const databaseType = effectiveDatabaseTypeForConnection(connection) ?? connection.db_type;
    const statements = await buildExecutableObjectSourceStatements({
      databaseType,
      objectType: source.objectType,
      schema: source.schema || tab.schema || tab.database,
      name: source.name,
      source: tab.sql,
    });
    const sql = statements.filter((statement) => statement.trim()).join(";\n");
    if (sql.trim()) {
      const saved = await executeWithProductionSqlGuard({
        connection,
        database: tab.database,
        sql,
        source: t("production.sourceObjectSource"),
        execute: async () => {
          await executeObjectSourceSave(tab.connectionId, tab.database, databaseType, statements, source.schema || tab.schema);
          return true;
        },
      });
      if (!saved) return false;
    } else {
      await executeObjectSourceSave(tab.connectionId, tab.database, databaseType, statements, source.schema || tab.schema);
    }
    queryStore.markTabClean(tab);
    toast(t("objects.sourceSaved"), 2000);
    return true;
  } catch (error: any) {
    toast(t("objects.sourceSaveFailed", { message: error?.message || String(error) }), 5000);
    return false;
  }
}

async function saveActiveSql() {
  const tab = activeTab.value;
  if (!tab || tab.mode !== "query" || (!tab.externalSqlPath && !tab.sql.trim())) return;
  if (tab.objectSource) {
    await saveActiveObjectSource(tab);
    return;
  }
  try {
    const path = tab.externalSqlPath || (await api.saveExternalSqlFile(defaultSqlFileName(tab), tab.sql));
    if (!path) return;
    if (tab.externalSqlPath) await api.writeExternalSqlFile(path, tab.sql);
    queryStore.linkExternalSqlPath(tab.id, path, sqlFileTitleFromPath(path));
    queryStore.markTabClean(tab);
    toast(t("savedSql.saved"), 2000);
  } catch (error: any) {
    toast(t("toolbar.sqlSaveFailed", { message: error?.message || String(error) }), 5000);
  }
}

async function openSqlFile() {
  const tab = activeTab.value;
  if (!tab) return;
  try {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ filters: [{ name: "SQL", extensions: ["sql"] }], multiple: false });
      if (!path) return;
      const sqlPath = path as string;
      queryStore.updateSql(tab.id, await api.readExternalSqlFile(sqlPath));
      queryStore.linkExternalSqlPath(tab.id, sqlPath, sqlFileTitleFromPath(sqlPath));
      return;
    }
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sql";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (file) queryStore.updateSql(tab.id, await readBrowserSqlFile(file));
    };
    input.click();
  } catch (error: any) {
    toast(t("toolbar.sqlOpenFailed", { message: externalSqlFileOpenErrorMessage(error, (key, params) => t(key, params)) }), 5000);
  }
}

async function changeActiveConnection(connectionId: string) {
  const tab = activeTab.value;
  const connection = connectionStore.getConfig(connectionId);
  if (!tab || !connection) return;
  queryStore.updateConnection(tab.id, connectionId, resolveDefaultDatabase(connection, []));
  connectionStore.activeConnectionId = connectionId;
  try {
    await connectionStore.ensureConnected(connectionId);
    const database = resolveDefaultDatabase(connection, await getDatabaseOptions(connectionId));
    queryStore.updateDatabase(tab.id, database);
    if (connection.db_type === "oracle") {
      try {
        const schema = schemaAfterConnectionSwitch(connection.db_type, await api.listSchemas(connectionId, database));
        if (schema && activeTab.value?.id === tab.id && activeTab.value.connectionId === connectionId) queryStore.updateSchema(tab.id, schema);
      } catch {
        // Metadata failure must not turn a successful connection switch into an error.
      }
    }
  } catch (error: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, error?.message || String(error)) }), 5000);
  }
}

function changeActiveDatabase(database: string) {
  if (activeTab.value) queryStore.updateDatabase(activeTab.value.id, database);
}

function changeActiveSchema(schema: string | undefined) {
  if (activeTab.value) queryStore.updateSchema(activeTab.value.id, schema);
}

async function setActiveDatabaseAsDefault() {
  const tab = activeTab.value;
  if (tab?.connectionId && tab.database) await connectionStore.setDefaultDatabase(tab.connectionId, tab.database);
}

async function clearActiveDefaultDatabase() {
  const tab = activeTab.value;
  if (tab?.connectionId) await connectionStore.clearDefaultDatabase(tab.connectionId);
}

function openConnectionSettings(connectionId: string, initialTab: ConfigTab = "connection") {
  if (!connectionStore.getConfig(connectionId)) return;
  connectionDialogInitialTab.value = initialTab;
  connectionStore.startEditing(connectionId);
  showConnectionDialog.value = true;
}

function setConnectionDialogOpen(open: boolean) {
  showConnectionDialog.value = open;
  if (!open) connectionDialogInitialTab.value = undefined;
}

function restoreActiveConnectionContext() {
  const connectionId = activeTab.value?.connectionId;
  if (connectionId && connectionStore.getConfig(connectionId)) connectionStore.activeConnectionId = connectionId;
}

watch(
  () => queryStore.activeTabId,
  (tabId, previousTabId) => {
    if (!previousTabId || tabId === previousTabId) return;
    selectedSql.value = "";
    cursorPos.value = 0;
    activeOutputView.value = "result";
  },
);

async function closeDetachedTab() {
  if (detachedWindowClosing) return;
  detachedWindowClosing = true;
  const detachedWindow = getCurrentWebviewWindow();
  await detachedWindow.hide().catch(() => {});
  const tabId = queryStore.activeTabId;
  try {
    const outcome = await destroyDetachedWindowAfterCleanup(detachedWindow, async () => {
      if (tabId) await queryStore.closeTabAndWait(tabId, { force: true });
    });
    if (outcome.status === "failed") console.warn("[DBX][detached-tab:cleanup:error]", { tabId, error: outcome.error });
    if (outcome.status === "timed-out") console.warn("[DBX][detached-tab:cleanup:timeout]", { tabId, timeoutMs: outcome.timeoutMs });
  } catch (error) {
    detachedWindowClosing = false;
    await detachedWindow.show().catch(() => {});
    toast(t("tabs.closeTabWindowFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  }
}

function handleContextMenu(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable || target.closest("[contenteditable], [data-reka-collection-item], [data-radix-vue-collection-item], [data-context-menu]")) return;
  event.preventDefault();
}

function handleKeydown(event: KeyboardEvent) {
  if (event.defaultPrevented) return;
  const shortcuts = settingsStore.editorSettings.shortcuts;
  if (isCloseTabShortcut(event, shortcuts)) {
    event.preventDefault();
    event.stopPropagation();
    void closeDetachedTab();
    return;
  }
  if (isRefreshDataShortcut(event, shortcuts)) {
    event.preventDefault();
    event.stopPropagation();
    contentAreaRef.value?.refreshData();
    return;
  }
  if (isFocusSearchShortcut(event, shortcuts) && contentAreaRef.value?.focusSearch()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (activeTab.value?.mode === "query" && isSaveShortcut(event, shortcuts) && event.target instanceof Element && !isObjectSourceSaveShortcutTarget(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    void saveActiveSql();
    return;
  }
  if (activeTab.value?.mode === "query" && isExecuteSqlInNewResultTabShortcut(event, shortcuts) && event.target instanceof Element && event.target.closest("[data-query-editor-root]")) {
    event.preventDefault();
    event.stopPropagation();
    if (!contentAreaRef.value?.requestQueryEditorExecuteInNewResultTab()) void tryExecuteInNewResultTab();
    return;
  }
  if (activeTab.value?.mode === "query" && isExecuteSqlShortcut(event, shortcuts) && event.target instanceof Element && event.target.closest("[data-query-editor-root]")) {
    event.preventDefault();
    event.stopPropagation();
    if (!contentAreaRef.value?.requestQueryEditorExecute()) void tryExecute();
    return;
  }
  if (isModRShortcut(event) && event.target instanceof Element && contentAreaRef.value?.handleModRTarget(event.target)) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (isNewQueryShortcut(event, shortcuts)) {
    event.preventDefault();
    event.stopPropagation();
    forwardToMainWindow({ type: "new-query" });
    return;
  }
  if (isOpenSettingsShortcut(event, shortcuts)) {
    event.preventDefault();
    event.stopPropagation();
    forwardToMainWindow({ type: "open-settings" });
    return;
  }
  if (isBrowserReloadShortcut(event)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

async function applyUiScale() {
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(settingsStore.editorSettings.uiScale);
  } catch {
    // A zoom failure must not block detached-tab ownership transfer.
  }
}

onMounted(async () => {
  applyTheme();
  window.addEventListener("keydown", handleKeydown);
  document.addEventListener("contextmenu", handleContextMenu);
  const detachedWindow = getCurrentWebviewWindow();
  unlistenDetachedWindowClose = await detachedWindow.onCloseRequested(async (event) => {
    if (detachedWindowClosing) return;
    event.preventDefault();
    await closeDetachedTab();
  });

  try {
    // Only tab-critical settings and connection metadata block transfer readiness.
    await Promise.all([settingsStore.initEditorSettings(), connectionStore.initFromDisk()]);
    void applyUiScale();
    unlistenDetachedAppCloseCheck = await listenForDetachedAppCloseChecks(() => queryStore.hasDirtyTabs);
    unlistenDetachedTabTransfer = await receiveDetachedTab((payload) => {
      restoreDataGridPendingSnapshotsForTab(payload.tab.id, payload.dataGridSnapshots);
      queryStore.adoptTransferredTab(payload.tab);
      activeOutputView.value = payload.activeOutputView;
      selectedSql.value = payload.selectedSql;
      cursorPos.value = payload.cursorPos;
      explainMode.value = payload.explainMode;
      blockDangerousRedisCommands.value = payload.blockDangerousRedisCommands;
      restoreActiveConnectionContext();
      return () => {
        queryStore.takeTabForTransfer(payload.tab.id);
        clearDataGridPendingSnapshotsForTab(payload.tab.id);
      };
    });
  } catch (error) {
    await nextTick();
    shellRef.value?.showError(error);
  }
});

onUnmounted(() => {
  unlistenDetachedTabTransfer?.();
  unlistenDetachedWindowClose?.();
  unlistenDetachedAppCloseCheck?.();
  window.removeEventListener("keydown", handleKeydown);
  document.removeEventListener("contextmenu", handleContextMenu);
});
</script>

<template>
  <!-- Keep the loading shell mounted until ownership transfer completes. -->
  <DetachedWindowShell v-if="!activeTab" ref="shellRef" />
  <template v-else>
    <TooltipProvider :delay-duration="300">
      <DetachedTabWindow
        ref="contentAreaRef"
        :active-tab="activeTab"
        :active-connection="activeConnection"
        :executable-sql="executableSql"
        :active-output-view="activeOutputView"
        :format-sql-request="formatSqlRequest"
        :compress-sql-request="compressSqlRequest"
        :selected-sql="selectedSql"
        :cursor-pos="cursorPos"
        :block-dangerous-redis-commands="blockDangerousRedisCommands"
        :explain-mode="explainMode"
        :sql-keyword-case="settingsStore.editorSettings.sqlFormatter.keywordCase"
        :auto-commit="activeTab.autoCommit ?? true"
        :txn-session-id="activeTab.txnSessionId"
        :txn-auto-rolled-back="activeTab.txnAutoRolledBack"
        @update:active-output-view="activeOutputView = $event"
        @fix-with-ai="(errorMessage: string) => forwardToMainWindow({ type: 'fix-with-ai', errorMessage })"
        @send-selection-to-ai="(sql: string) => forwardToMainWindow({ type: 'send-selection-to-ai', sql })"
        @execute="tryExecute($event)"
        @execute-in-new-result-tab="tryExecuteInNewResultTab($event)"
        @cancel="cancelActiveExecution()"
        @explain="tryExplain()"
        @editor-update="(tabId: string, value: string) => queryStore.updateSql(tabId, value)"
        @editor-selection-change="(value: string) => (selectedSql = value)"
        @editor-cursor-change="(position: number) => (cursorPos = position)"
        @editor-viewport-change="(tabId: string, viewport: { scrollTop: number; scrollLeft: number }) => queryStore.updateEditorViewport(tabId, viewport)"
        @editor-selection-state-change="(tabId: string, selection: { anchor: number; head: number }) => queryStore.updateEditorSelection(tabId, selection)"
        @format-error="toast(t('toolbar.formatSqlFailed'))"
        @save-sql="void saveActiveSql()"
        @reload="(sql?: string, searchText?: string, whereInput?: string, orderBy?: string, limit?: number, offset?: number, intent?: DataGridReloadIntent) => onReloadData(sql, searchText, whereInput, orderBy, limit, offset, intent)"
        @paginate="onPaginate"
        @sort="onSort"
        @execute-sql="onExecuteSql"
        @click-table="openClickedTableInDetachedWindow"
        @view-table-data="(table: string | SqlObjectNavigationTarget) => openTableInDetachedWindow(table)"
        @edit-table-structure="editTableStructureInDetachedWindow"
        @view-table-ddl="openTableDdlInDetachedWindow"
        @open-object-source="openObjectSourceInDetachedWindow"
        @open-object-table="openObjectTableInDetachedWindow"
        @object-schema-change="(schema: string | undefined) => activeTab && queryStore.updateSchema(activeTab.id, schema)"
        @object-browser-viewport-change="(tabId: string, viewport: ObjectBrowserViewport) => queryStore.updateObjectBrowserViewport(tabId, viewport)"
        @structure-editor-saved="
          (commentChanged: boolean) =>
            activeTab &&
            onStructureEditorSaved(
              onReloadData,
              toast,
              {
                connectionId: activeTab.connectionId,
                database: activeTab.database,
                schema: activeTab.schema,
                tableName: activeTab.structureTableName || '',
              },
              commentChanged,
            )
        "
        @structure-editor-close="closeDetachedTab"
        @open-settings="(initialTab?: string, initialSection?: string) => forwardToMainWindow({ type: 'open-settings', initialTab, initialSection })"
        @open-connection-settings="openConnectionSettings"
        @close="closeDetachedTab"
        @close-tab="closeDetachedTab"
        @format-sql="formatActiveSql"
        @compress-sql="compressActiveSql"
        @toggle-sql-keyword-case="toggleSqlKeywordCase"
        @open-sql="openSqlFile"
        @import-result-archive="rejectMainWindowFeature"
        @paste-sql-in-condition="contentAreaRef?.pasteClipboardAsSqlInCondition()"
        @change-connection="changeActiveConnection"
        @change-database="changeActiveDatabase"
        @change-schema="changeActiveSchema"
        @set-default-database="setActiveDatabaseAsDefault"
        @clear-default-database="clearActiveDefaultDatabase"
        @update:explain-mode="(mode: 'explain' | 'autotrace') => (explainMode = mode)"
        @update:block-dangerous-redis-commands="(value: boolean) => (blockDangerousRedisCommands = value)"
        @update:auto-commit="(value: boolean) => activeTab && queryStore.setAutoCommit(activeTab.id, value)"
        @commit="activeTab && queryStore.commitTransaction(activeTab.id)"
        @rollback="activeTab && queryStore.rollbackTransaction(activeTab.id)"
        @dismiss-txn-rolled-back="activeTab && (activeTab.txnAutoRolledBack = false)"
      />
    </TooltipProvider>
    <AppDialogs
      :show-connection-dialog="showConnectionDialog"
      :connection-initial-tab="connectionDialogInitialTab"
      :show-danger-dialog="showDangerDialog"
      :danger-sql="dangerSql"
      :suppress-danger-confirm="suppressDangerConfirm"
      :active-database-type="activeConnection?.db_type"
      :show-sql-parameter-dialog="showSqlParameterDialog"
      :sql-parameter-source-sql="sqlParameterSourceSql"
      :sql-parameter-names="sqlParameterNames"
      :sql-parameter-database-type="sqlParameterDatabaseType"
      :sql-parameter-enabled-syntaxes="sqlParameterEnabledSyntaxes"
      @update:show-connection-dialog="setConnectionDialogOpen"
      @update:show-danger-dialog="showDangerDialog = $event"
      @update:suppress-danger-confirm="suppressDangerConfirm = $event"
      @update:show-sql-parameter-dialog="showSqlParameterDialog = $event"
      @danger-confirm="onDangerConfirm"
      @sql-parameters-confirm="onSqlParametersConfirm"
      @connect-started="(name: string) => toast(t('connection.connecting', { name }), 30000)"
      @connect-succeeded="(name: string) => toast(t('connection.connectSuccess', { name }), 2000)"
      @connect-failed="(message: string) => toast(t('connection.connectFailed', { message: translateBackendError(t, message) }), 5000)"
      @open-driver-store="setConnectionDialogOpen(false)"
      @open-tunnel-profile-settings="setConnectionDialogOpen(false)"
      @open-lineage-target="rejectMainWindowFeature"
      @open-database-search-target="rejectMainWindowFeature"
      @open-diagram-target="rejectMainWindowFeature"
    />
    <QueryEditorDdlViewDialog
      v-if="queryEditorDdlTarget"
      v-model:open="showQueryEditorDdlDialog"
      :connection-id="queryEditorDdlTarget.connectionId"
      :database="queryEditorDdlTarget.database"
      :catalog="queryEditorDdlTarget.catalog"
      :schema="queryEditorDdlTarget.schema"
      :table-name="queryEditorDdlTarget.tableName"
      :object-type="queryEditorDdlTarget.objectType"
      :database-type="queryEditorDdlDatabaseType"
      :dialect="queryEditorDdlDialect"
    />
    <QueryEditorObjectSourceDialog
      v-if="queryEditorObjectSourceTarget"
      v-model:open="showQueryEditorObjectSourceDialog"
      :connection-id="queryEditorObjectSourceTarget.connectionId"
      :database="queryEditorObjectSourceTarget.database"
      :schema="queryEditorObjectSourceTarget.schema"
      :name="queryEditorObjectSourceTarget.name"
      :object-type="queryEditorObjectSourceTarget.objectType"
      :initial-editing="queryEditorObjectSourceTarget.initialEditing"
      :database-type="queryEditorObjectSourceDatabaseType"
      :dialect="queryEditorObjectSourceDialect"
      :format-dialect="queryEditorObjectSourceFormatDialect"
      @saved="onQueryEditorObjectSourceSaved"
    />
    <Teleport to="body">
      <Transition name="toast">
        <div v-if="toastVisible" class="fixed bottom-6 inset-x-0 w-max max-w-[90vw] sm:max-w-3xl mx-auto z-99999 px-4 py-2 rounded-lg bg-foreground text-background text-sm shadow-lg select-text whitespace-pre-wrap break-words">
          {{ toastMessage }}
        </div>
      </Transition>
    </Teleport>
  </template>
</template>

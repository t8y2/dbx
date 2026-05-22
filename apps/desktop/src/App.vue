<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppToolbar from "@/components/layout/AppToolbar.vue";
import AppTabBar from "@/components/layout/AppTabBar.vue";
import AppSidebar from "@/components/layout/AppSidebar.vue";
import EditorToolbar from "@/components/layout/EditorToolbar.vue";
import ContentArea from "@/components/layout/ContentArea.vue";
import AppDialogs from "@/components/layout/AppDialogs.vue";
import WelcomeScreen from "@/components/layout/WelcomeScreen.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useAppUpdater } from "@/composables/useAppUpdater";
import { useFileDrop } from "@/composables/useFileDrop";
import { usePanelResize } from "@/composables/usePanelResize";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { useSqlExecution } from "@/composables/useSqlExecution";
import { useDialogSources } from "@/composables/useDialogSources";
import { useNavigationTargets } from "@/composables/useNavigationTargets";
import { useDataGridActions } from "@/composables/useDataGridActions";
import { useTauriEvents } from "@/composables/useTauriEvents";
import "@/i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import * as api from "@/lib/api";
import { resolveDefaultDatabase } from "@/lib/defaultDatabase";
import { findTreeNodeById, resolveNewQueryTarget } from "@/lib/newQueryContext";
import { buildExecutableObjectSourceStatements, objectSourceSaveExecutionMode } from "@/lib/objectSourceEditor";
import { resolveExecutableSql } from "@/lib/sqlExecutionTarget";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { sqlFileTitleFromPath } from "@/lib/sqlFileOpen";
import { parseConnectionDeepLink, type ConnectionDeepLinkDraft } from "@/lib/connectionDeepLink";
import {
  isCloseTabShortcut,
  isExecuteSqlShortcut,
  isFocusSearchShortcut,
  isNewQueryShortcut,
  isObjectSourceSaveShortcutTarget,
  isRefreshDataShortcut,
  isSaveShortcut,
} from "@/lib/keyboardShortcuts";
import { isPreviewTab } from "@/lib/tabPresentation";
import { supportsSqlFileExecution } from "@/lib/databaseCapabilities";
import { classifyAiSqlExecution } from "@/lib/aiSqlExecutionPolicy";
import { buildHistoryAiAnalysisPrompt } from "@/lib/historyAiAnalysis";
import { countAvailableAgentDriverUpdates, type AgentDriverUpdateBadgeState } from "@/lib/agentDriverUpdateBadge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { HistoryEntry } from "@/lib/tauri";
import type { AiAction } from "@/lib/ai";

const AiAssistant = defineAsyncComponent(() => import("@/components/editor/AiAssistant.vue"));
const QueryHistory = defineAsyncComponent(() => import("@/components/editor/QueryHistory.vue"));
const DriverStorePage = defineAsyncComponent(() => import("@/components/config/DriverStoreDialog.vue"));
const UpdateDialog = defineAsyncComponent(() => import("@/components/layout/UpdateDialog.vue"));
const LoginPage = defineAsyncComponent(() => import("@/components/auth/LoginPage.vue"));

type AiAssistantHandle = {
  triggerAction: (action: AiAction, instruction?: string) => void;
};

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const savedSqlStore = useSavedSqlStore();
const { message: toastMessage, visible: toastVisible, toast } = useToast();
const { isDark, themeMode, applyTheme, setThemeMode } = useTheme();
const {
  checkingUpdates,
  updateInfo,
  updateCheckMessage,
  showUpdateDialog,
  isDownloadingUpdate,
  downloadProgress,
  updateReady,
  hasUpdateAvailable,
  openUrl,
  checkUpdates,
  openLatestRelease,
  downloadAndInstallUpdate,
  restartApp,
} = useAppUpdater();
const { setupFileDrop } = useFileDrop();

const isDesktop = isTauriRuntime();
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let updateCheckTimer: ReturnType<typeof setInterval> | undefined;
const needsAuth = ref(!isDesktop);
const authenticated = ref(isDesktop);
const setupRequired = ref(false);

const showConnectionDialog = ref(false);
const connectionDialogPrefill = ref<ConnectionDeepLinkDraft | null>(null);
const showSettingsDialog = ref(false);
const showDriverStore = ref(false);
const agentDriverUpdateCount = ref(0);
const showHistory = ref(false);
const showAiPanel = ref(localStorage.getItem("dbx-ai-panel-open") === "true");
const aiPanelReady = ref(false);
const { sidebarWidth, aiPanelWidth, historyWidth, startSidebarResize, startAiPanelResize, startHistoryResize } =
  usePanelResize();
const aiAssistantRef = ref<AiAssistantHandle | null>(null);
const appSidebarRef = ref<InstanceType<typeof AppSidebar> | null>(null);
const contentAreaRef = ref<InstanceType<typeof ContentArea> | null>(null);

const selectedSql = ref("");
const cursorPos = ref(0);
const formatSqlRequestId = ref(0);
const activeOutputView = ref<"result" | "explain" | "chart">("result");
const newQueryContextSource = ref<"tab" | "sidebar">("tab");
const showSaveSqlDialog = ref(false);
const saveSqlName = ref("");
const saveSqlFolderId = ref("");
const ROOT_SAVED_SQL_FOLDER = "__root__";

const activeTab = computed(() => queryStore.tabs.find((t) => t.id === queryStore.activeTabId));

const activeConnection = computed(() => {
  const tab = activeTab.value;
  return tab ? connectionStore.getConfig(tab.connectionId) : undefined;
});

function updateAgentDriverUpdateCount(count: number) {
  agentDriverUpdateCount.value = count;
}

async function refreshAgentDriverUpdateCount() {
  if (!isDesktop) return;
  try {
    const drivers = await invoke<AgentDriverUpdateBadgeState[]>("list_installed_agents");
    updateAgentDriverUpdateCount(countAvailableAgentDriverUpdates(drivers));
  } catch {
    // Driver update availability is only a badge hint; keep the existing count if the registry cannot be reached.
  }
}

function restoreHistorySql(sql: string, entry: HistoryEntry) {
  const tab = activeTab.value;
  if (tab?.mode === "query") {
    queryStore.updateSql(tab.id, sql);
    return;
  }

  const connectionId = entry.connection_id || tab?.connectionId || connectionStore.connections[0]?.id;
  if (!connectionId) return;
  const config = connectionStore.getConfig(connectionId);
  const database = entry.database || tab?.database || (config ? resolveDefaultDatabase(config, []) : "");
  const tabId = queryStore.createTab(connectionId, database || "", t("tabs.sql"));
  queryStore.updateSql(tabId, sql);
}

const executableSql = computed(() => {
  const tab = activeTab.value;
  return tab
    ? resolveExecutableSql(tab.sql, selectedSql.value, {
        mode: settingsStore.editorSettings.executeMode,
        cursorPos: cursorPos.value,
      })
    : "";
});

const {
  dangerSql,
  pendingDangerSql,
  showDangerDialog,
  tryExecute,
  doExecute,
  cancelActiveExecution,
  tryExplain,
  onDangerConfirm,
} = useSqlExecution({ activeTab, activeConnection, executableSql, activeOutputView });

const dialogs = useDialogSources();
const { getDatabaseOptions } = useDatabaseOptions();
const { openLineageTarget, openDatabaseSearchTarget, onStructureEditorSaved, openTableTarget } =
  useNavigationTargets(dialogs);
const { onExecuteSql, onReloadData, onPaginate, onSort } = useDataGridActions(activeTab);
const { setupTauriListeners, cleanupTauriListeners } = useTauriEvents({
  openTableTarget,
  openSqlFilePath,
  openConnectionDeepLink,
});

const appVersion = ref("");
const isClassicLayout = computed(() => settingsStore.editorSettings.appLayout === "classic");
const hasSqlFileConnections = computed(() =>
  connectionStore.connections.some((c) => supportsSqlFileExecution(c.db_type)),
);
const connectionStats = computed(() => ({
  total: connectionStore.connections.length,
  connected: connectionStore.connectedIds.size,
  types: new Set(connectionStore.connections.map((c) => c.driver_profile || c.db_type)).size,
}));
const recentConnections = computed(() => connectionStore.connections.slice(0, 5));
const saveSqlFolders = computed(() => {
  const tab = activeTab.value;
  return tab ? savedSqlStore.listFolders(tab.connectionId) : [];
});

watch(
  () => queryStore.activeTabId,
  (id) => {
    if (id) newQueryContextSource.value = "tab";
    selectedSql.value = "";
    activeOutputView.value = "result";
    showDriverStore.value = false;
    if (id) queryStore.reloadEvictedTab(id);
  },
);

watch(
  () => connectionStore.selectedTreeNodeId,
  (id) => {
    if (id) newQueryContextSource.value = "sidebar";
  },
);

function toggleAiPanel() {
  showAiPanel.value = !showAiPanel.value;
  localStorage.setItem("dbx-ai-panel-open", String(showAiPanel.value));
}

function fixWithAi(errorMessage: string) {
  if (!showAiPanel.value) {
    showAiPanel.value = true;
    localStorage.setItem("dbx-ai-panel-open", "true");
  }
  nextTick(() => aiAssistantRef.value?.triggerAction("fix", errorMessage));
}

function openAiPanel() {
  if (!showAiPanel.value) {
    showAiPanel.value = true;
    localStorage.setItem("dbx-ai-panel-open", "true");
  }
}

function analyzeHistoryWithAi(entry: HistoryEntry) {
  const connectionId = entry.connection_id || activeTab.value?.connectionId;
  if (!connectionId) {
    toast(t("history.aiAnalyzeNoConnection"), 5000);
    return;
  }

  const config = connectionStore.getConfig(connectionId);
  if (!config) {
    toast(t("history.aiAnalyzeNoConnection"), 5000);
    return;
  }

  openAiPanel();
  const database = entry.database || activeTab.value?.database || resolveDefaultDatabase(config, []);
  const title = t("history.aiAnalysisTab");
  const tabId = queryStore.createTab(connectionId, database || "", title, "query");
  queryStore.updateSql(tabId, entry.sql);
  nextTick(() => aiAssistantRef.value?.triggerAction("explain", buildHistoryAiAnalysisPrompt(entry)));
}

function formatActiveSql() {
  const tab = activeTab.value;
  if (!tab || tab.mode !== "query" || !tab.sql.trim()) return;
  formatSqlRequestId.value++;
}

function defaultSavedSqlName(title: string) {
  const trimmed = title.trim() || "Query";
  return trimmed.endsWith(".sql") ? trimmed : `${trimmed}.sql`;
}

async function openSaveSqlDialog() {
  const tab = activeTab.value;
  if (!tab || !tab.sql.trim()) return;
  if (tab.objectSource) {
    await saveActiveObjectSource(tab);
    return;
  }
  const existing = tab.savedSqlId ? savedSqlStore.getFile(tab.savedSqlId) : undefined;
  if (existing) {
    const updated = await savedSqlStore.saveFile({
      id: existing.id,
      connectionId: tab.connectionId,
      folderId: existing.folderId,
      name: existing.name,
      database: tab.database,
      schema: tab.schema,
      sql: tab.sql,
    });
    queryStore.linkSavedSql(tab.id, updated.id, updated.name);
    connectionStore.refreshSavedSqlTree(tab.connectionId);
    toast(t("savedSql.saved"), 2000);
    return;
  }

  saveSqlName.value = defaultSavedSqlName(tab.title);
  saveSqlFolderId.value = ROOT_SAVED_SQL_FOLDER;
  showSaveSqlDialog.value = true;
}

async function saveActiveObjectSource(tab: NonNullable<typeof activeTab.value>) {
  const connection = connectionStore.getConfig(tab.connectionId);
  const source = tab.objectSource;
  if (!connection || !source) return;

  try {
    const statements = buildExecutableObjectSourceStatements({
      databaseType: connection.db_type,
      objectType: source.objectType,
      schema: source.schema || tab.schema || tab.database,
      name: source.name,
      source: tab.sql,
    });
    for (const sql of statements) {
      if (objectSourceSaveExecutionMode(connection.db_type) === "single") {
        await api.executeQuery(tab.connectionId, tab.database, sql, source.schema || tab.schema);
      } else {
        await api.executeScript(tab.connectionId, tab.database, sql, source.schema || tab.schema);
      }
    }
    toast(t("objects.sourceSaved"), 2000);
  } catch (e: any) {
    toast(t("objects.sourceSaveFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function confirmSaveSqlToLibrary() {
  const tab = activeTab.value;
  const name = saveSqlName.value.trim();
  if (!tab || !tab.sql.trim() || !name) return;
  try {
    const saved = await savedSqlStore.saveFile({
      id: tab.savedSqlId,
      connectionId: tab.connectionId,
      folderId: saveSqlFolderId.value === ROOT_SAVED_SQL_FOLDER ? undefined : saveSqlFolderId.value,
      name: defaultSavedSqlName(name),
      database: tab.database,
      schema: tab.schema,
      sql: tab.sql,
    });
    queryStore.linkSavedSql(tab.id, saved.id, saved.name);
    connectionStore.refreshSavedSqlTree(tab.connectionId);
    showSaveSqlDialog.value = false;
    toast(t("savedSql.saved"), 2000);
  } catch (e: any) {
    toast(t("savedSql.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function openSqlFile() {
  const tab = activeTab.value;
  if (!tab) return;
  try {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await open({ filters: [{ name: "SQL", extensions: ["sql"] }], multiple: false });
      if (path) {
        const content = await readTextFile(path as string);
        queryStore.updateSql(tab.id, content);
      }
    } else {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".sql";
      input.onchange = () => {
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          if (typeof reader.result === "string") {
            queryStore.updateSql(tab.id, reader.result);
          }
        };
        reader.readAsText(file);
      };
      input.click();
    }
  } catch (e: any) {
    toast(t("toolbar.sqlOpenFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function openSqlFilePath(path: string) {
  if (!isTauriRuntime()) return;
  try {
    const content = await api.readExternalSqlFile(path);
    const connectionId =
      connectionStore.activeConnectionId || activeTab.value?.connectionId || connectionStore.connections[0]?.id || "";
    const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const database = activeTab.value?.database || (connection ? resolveDefaultDatabase(connection, []) : "");
    const tabId = queryStore.createTab(connectionId, database, sqlFileTitleFromPath(path), "query");
    queryStore.updateSql(tabId, content);
  } catch (e: any) {
    toast(t("toolbar.sqlOpenFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function openPendingSqlFiles() {
  if (!isTauriRuntime()) return;
  try {
    const paths = await api.pendingOpenSqlFiles();
    for (const path of paths) {
      await openSqlFilePath(path);
    }
  } catch {
    /* ignore startup file-open probing errors */
  }
}

async function openConnectionDeepLink(url: string) {
  try {
    const draft = parseConnectionDeepLink(url);
    if (!draft) return;
    connectionStore.stopEditing();
    connectionStore.stopCreatingConnectionInGroup();
    connectionDialogPrefill.value = draft;
    showConnectionDialog.value = true;
  } catch (e: any) {
    toast(t("connection.parseConnectionUrlFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function openPendingConnectionLinks() {
  if (!isTauriRuntime()) return;
  try {
    const links = await api.pendingOpenConnectionLinks();
    for (const link of links) {
      await openConnectionDeepLink(link);
    }
  } catch {
    /* ignore startup deep-link probing errors */
  }
}

function setConnectionDialogOpen(value: boolean) {
  showConnectionDialog.value = value;
  if (!value) connectionDialogPrefill.value = null;
}

async function newQuery() {
  const target = resolveNewQueryTarget({
    activeTab: activeTab.value,
    selectedTreeNode: findTreeNodeById(connectionStore.treeNodes, connectionStore.selectedTreeNodeId),
    activeConnectionId: connectionStore.activeConnectionId,
    connections: connectionStore.connections,
    preferredSource: newQueryContextSource.value,
  });
  if (!target) return;
  const conn = connectionStore.getConfig(target.connectionId);
  if (!conn) return;
  connectionStore.activeConnectionId = target.connectionId;
  const tabId = queryStore.createTab(conn.id, target.database);
  try {
    await connectionStore.ensureConnected(target.connectionId);
    if (target.shouldRefreshDefaultDatabase) {
      const options = await getDatabaseOptions(target.connectionId);
      queryStore.updateDatabase(tabId, resolveDefaultDatabase(conn, options));
    }
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function openConnectionQuery(connectionId: string) {
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  connectionStore.activeConnectionId = connectionId;
  const tabId = queryStore.createTab(connectionId, resolveDefaultDatabase(connection, []));
  try {
    await connectionStore.ensureConnected(connectionId);
    const options = await getDatabaseOptions(connectionId);
    queryStore.updateDatabase(tabId, resolveDefaultDatabase(connection, options));
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function onClickTable(tableName: string) {
  const tab = activeTab.value;
  if (!tab) return;
  const connectionId = tab.connectionId;
  const database = tab.database;

  // Parse schema.table if needed
  const [schema, rawTableName] = tableName.includes(".") ? tableName.split(".") : [database, tableName];

  try {
    await connectionStore.ensureConnected(connectionId);
    const ddl = await api.getTableDdl(connectionId, database, schema || database, rawTableName);

    // Create a new tab with the DDL
    const tabId = queryStore.createTab(connectionId, database, `DDL - ${rawTableName}`);
    queryStore.updateSql(tabId, ddl);
  } catch (e: any) {
    toast(`Failed to get table DDL: ${e?.message || String(e)}`, 5000);
  }
}

async function changeActiveConnection(connectionId: string) {
  const tab = activeTab.value;
  if (!tab) return;
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  queryStore.updateConnection(tab.id, connectionId, resolveDefaultDatabase(connection, []));
  connectionStore.activeConnectionId = connectionId;
  try {
    await connectionStore.ensureConnected(connectionId);
    const options = await getDatabaseOptions(connectionId);
    queryStore.updateDatabase(tab.id, resolveDefaultDatabase(connection, options));
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function changeActiveDatabase(database: string) {
  const tab = activeTab.value;
  if (tab) queryStore.updateDatabase(tab.id, database);
}

async function setActiveDatabaseAsDefault() {
  const tab = activeTab.value;
  if (!tab || !tab.connectionId || !tab.database) return;
  await connectionStore.setDefaultDatabase(tab.connectionId, tab.database);
}

async function clearActiveDefaultDatabase() {
  const tab = activeTab.value;
  if (!tab || !tab.connectionId) return;
  await connectionStore.clearDefaultDatabase(tab.connectionId);
}

function changeActiveSchema(schema: string | undefined) {
  const tab = activeTab.value;
  if (tab) queryStore.updateSchema(tab.id, schema);
}
function openGitHub() {
  openUrl("https://github.com/t8y2/dbx");
}
function openMcpGuide() {
  openUrl("https://github.com/t8y2/dbx/blob/main/docs/mcp-guide.md");
}

function ensureQueryTab(): string {
  const tab = activeTab.value;
  if (tab && tab.mode === "query") return tab.id;
  const connId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
  const db = tab?.database || "";
  return queryStore.createTab(connId, db, undefined, "query");
}

function onAiReplaceSql(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, sql);
}

function onAiExecuteSql(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, sql);
  selectedSql.value = "";
  nextTick(() => tryExecute(sql));
}

function onAiRequestAutoExecuteSql(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, sql);
  selectedSql.value = "";

  const decision = classifyAiSqlExecution(sql, activeConnection.value);
  if (decision.action === "block") {
    toast(t("ai.autoSqlBlocked"), 5000);
    return;
  }

  nextTick(() => {
    if (decision.action === "auto_execute") {
      void doExecute(sql);
      return;
    }
    dangerSql.value = sql;
    pendingDangerSql.value = sql;
    showDangerDialog.value = true;
  });
}

function handleKeydown(e: KeyboardEvent) {
  const shortcuts = settingsStore.editorSettings.shortcuts;

  if (isFocusSearchShortcut(e, shortcuts)) {
    const focused = contentAreaRef.value?.focusSearch() || appSidebarRef.value?.focusSearch();
    if (focused) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (isRefreshDataShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    contentAreaRef.value?.refreshData();
    return;
  }
  if (isNewQueryShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    void newQuery();
    return;
  }
  if (isCloseTabShortcut(e, shortcuts)) {
    e.preventDefault();
    if (showDriverStore.value) {
      showDriverStore.value = false;
    } else if (queryStore.activeTabId) {
      queryStore.closeTab(queryStore.activeTabId);
    }
    return;
  }
  if (isSaveShortcut(e, shortcuts) && e.target instanceof Element && isObjectSourceSaveShortcutTarget(e.target)) {
    return;
  }
  if (activeTab.value?.mode === "query" && !showSaveSqlDialog.value && isSaveShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    void openSaveSqlDialog();
    return;
  }
  if (
    activeTab.value?.mode === "query" &&
    isExecuteSqlShortcut(e, shortcuts) &&
    e.target instanceof Element &&
    e.target.closest("[data-query-editor-root]")
  ) {
    e.preventDefault();
    e.stopPropagation();
    tryExecute();
  }
}

function onLoginSuccess() {
  authenticated.value = true;
  setupRequired.value = false;
  needsAuth.value = true;
  window.history.replaceState(null, "", "/");
  initApp();
}

function initApp() {
  const t0 = performance.now();
  console.log("[STARTUP] initApp begin");
  savedSqlStore
    .initFromStorage()
    .then(() => {
      console.log(`[STARTUP]   savedSqlStore.initFromStorage: ${(performance.now() - t0).toFixed(0)}ms`);
      return connectionStore.initFromDisk();
    })
    .then(() => {
      console.log(`[STARTUP]   connectionStore.initFromDisk: ${(performance.now() - t0).toFixed(0)}ms`);
      reconnectRestoredTabs();
    })
    .catch((e: any) => {
      toast(t("connection.loadFailed", { message: e?.message || String(e) }), 5000);
    });
  settingsStore.initAiConfig();
}

async function reconnectRestoredTabs() {
  if (isDesktop) return;
  const connectionIds = new Set(queryStore.tabs.map((t) => t.connectionId).filter(Boolean));
  for (const id of connectionIds) {
    try {
      await connectionStore.ensureConnected(id);
    } catch {}
  }
  for (const tab of queryStore.tabs) {
    if (tab.mode === "data" && tab.tableMeta && tab.sql) {
      queryStore.executeTabSql(tab.id, tab.sql).catch(() => {});
    }
  }
}

function handleContextMenu(e: MouseEvent) {
  const target = e.target as HTMLElement;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
  if (target.closest("[data-reka-collection-item], [data-radix-vue-collection-item], [data-context-menu]")) return;
  e.preventDefault();
}

function openDriverStoreFromEvent() {
  showDriverStore.value = true;
}

onMounted(async () => {
  console.log("[STARTUP] onMounted begin");
  const mountStart = performance.now();
  requestAnimationFrame(() => {
    aiPanelReady.value = true;
  });
  applyTheme();
  window.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("dbx-open-driver-store", openDriverStoreFromEvent);
  if (isDesktop) {
    document.addEventListener("contextmenu", handleContextMenu);
  }
  if (!isDesktop) {
    try {
      const res = await fetch("/api/auth/check");
      const data = await res.json();
      needsAuth.value = data.required;
      authenticated.value = data.authenticated;
      setupRequired.value = data.setup_required;
    } catch {
      /* server unreachable */
    }
    if (needsAuth.value && !authenticated.value) {
      history.replaceState(null, "", "/login");
    }
    if (!setupRequired.value && (!needsAuth.value || authenticated.value)) initApp();
    api
      .getAppVersion()
      .then((v) => {
        appVersion.value = v;
      })
      .catch(() => {});
    return;
  }
  initApp();
  setupFileDrop().catch(() => {});
  void refreshAgentDriverUpdateCount();
  setTimeout(() => {
    checkUpdates({ silent: true });
    void refreshAgentDriverUpdateCount();
    updateCheckTimer = setInterval(() => {
      checkUpdates({ silent: true });
      void refreshAgentDriverUpdateCount();
    }, UPDATE_CHECK_INTERVAL_MS);
  }, 10_000);
  api
    .getAppVersion()
    .then((v) => {
      appVersion.value = v;
    })
    .catch(() => {});
  setupTauriListeners();
  void openPendingSqlFiles();
  void openPendingConnectionLinks();
  console.log(`[STARTUP] onMounted sync done: ${(performance.now() - mountStart).toFixed(0)}ms`);
});

onUnmounted(() => {
  cleanupTauriListeners();
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
  }
  window.removeEventListener("keydown", handleKeydown, true);
  window.removeEventListener("dbx-open-driver-store", openDriverStoreFromEvent);
  document.removeEventListener("contextmenu", handleContextMenu);
});
</script>

<template>
  <LoginPage
    v-if="setupRequired || (needsAuth && !authenticated)"
    :setup-mode="setupRequired"
    @authenticated="onLoginSuccess"
  />
  <div v-show="!setupRequired && (!needsAuth || authenticated)">
    <TooltipProvider :delay-duration="300">
      <div class="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
        <AppToolbar
          :is-dark="isDark"
          :theme-mode="themeMode"
          :show-ai-panel="showAiPanel"
          :show-history="showHistory"
          :show-driver-store="showDriverStore"
          :checking-updates="checkingUpdates"
          :has-update-available="hasUpdateAvailable"
          :agent-driver-update-count="agentDriverUpdateCount"
          :has-connections="connectionStore.connections.length > 0"
          :has-sql-file-connections="hasSqlFileConnections"
          @new-connection="showConnectionDialog = true"
          @new-query="newQuery"
          @set-theme-mode="setThemeMode"
          @toggle-ai="toggleAiPanel"
          @toggle-history="showHistory = !showHistory"
          @open-github="openGitHub"
          @open-settings="showSettingsDialog = true"
          @open-driver-store="showDriverStore = !showDriverStore"
          @check-updates="checkUpdates()"
          @open-transfer="dialogs.showTransferDialog.value = true"
          @open-sql-file="dialogs.showSqlFileDialog.value = true"
          @open-schema-diff="dialogs.showSchemaDiffDialog.value = true"
          @open-data-compare="dialogs.showDataCompareDialog.value = true"
        />

        <div
          :class="
            isClassicLayout
              ? 'app-layout-classic flex-1 flex min-h-0'
              : 'app-panel-gutter flex-1 flex min-h-0 gap-1 p-1'
          "
        >
          <AppSidebar
            ref="appSidebarRef"
            :sidebar-width="sidebarWidth"
            :classic-layout="isClassicLayout"
            @import="dialogs.onImportClick"
            @export="dialogs.onExportClick"
            @start-resize="startSidebarResize"
          />

          <div
            :class="
              isClassicLayout
                ? 'flex-1 min-w-0'
                : 'flex-1 min-w-0 overflow-hidden rounded-md border border-border/80 bg-background'
            "
          >
            <div class="h-full flex flex-col min-w-0">
              <AppTabBar
                :show-driver-store="showDriverStore"
                :agent-driver-update-count="agentDriverUpdateCount"
                @toggle-driver-store="showDriverStore = true"
                @close-driver-store="showDriverStore = false"
              />
              <DriverStorePage
                v-if="showDriverStore"
                class="flex-1 min-h-0"
                @update-count-change="updateAgentDriverUpdateCount"
              />
              <div v-else-if="activeTab" class="flex flex-col flex-1 min-h-0">
                <EditorToolbar
                  v-if="activeTab.mode === 'query' && !isPreviewTab(activeTab)"
                  :active-tab="activeTab"
                  :active-connection="activeConnection"
                  :executable-sql="executableSql"
                  @execute="tryExecute()"
                  @cancel="cancelActiveExecution()"
                  @explain="tryExplain()"
                  @format-sql="formatActiveSql"
                  @save-sql="void openSaveSqlDialog()"
                  @open-sql="openSqlFile"
                  @change-connection="changeActiveConnection"
                  @change-database="changeActiveDatabase"
                  @change-schema="changeActiveSchema"
                  @set-default-database="setActiveDatabaseAsDefault"
                  @clear-default-database="clearActiveDefaultDatabase"
                />
                <KeepAlive :max="20">
                  <ContentArea
                    ref="contentAreaRef"
                    :key="activeTab.id"
                    :active-tab="activeTab"
                    :active-connection="activeConnection"
                    :executable-sql="executableSql"
                    :active-output-view="activeOutputView"
                    :format-sql-request-id="formatSqlRequestId"
                    :selected-sql="selectedSql"
                    :cursor-pos="cursorPos"
                    @update:active-output-view="activeOutputView = $event"
                    @fix-with-ai="fixWithAi"
                    @execute="tryExecute()"
                    @cancel="cancelActiveExecution()"
                    @explain="tryExplain()"
                    @editor-update="
                      (v: string) => {
                        if (queryStore.activeTabId) queryStore.updateSql(queryStore.activeTabId, v);
                      }
                    "
                    @editor-selection-change="(v: string) => (selectedSql = v)"
                    @editor-cursor-change="(p: number) => (cursorPos = p)"
                    @format-error="toast(t('toolbar.formatSqlFailed'))"
                    @save-sql="void openSaveSqlDialog()"
                    @reload="
                      (
                        sql?: string,
                        searchText?: string,
                        whereInput?: string,
                        orderBy?: string,
                        limit?: number,
                        offset?: number,
                      ) => onReloadData(sql, searchText, whereInput, orderBy, limit, offset)
                    "
                    @paginate="onPaginate"
                    @sort="onSort"
                    @execute-sql="onExecuteSql"
                    @click-table="onClickTable"
                    @open-object-table="
                      (target) =>
                        activeTab &&
                        openTableTarget({
                          connectionId: activeTab.connectionId,
                          database: activeTab.database,
                          schema: target.schema,
                          tableName: target.tableName,
                        })
                    "
                    @object-schema-change="(schema) => activeTab && queryStore.updateSchema(activeTab.id, schema)"
                  />
                </KeepAlive>
              </div>
              <WelcomeScreen
                v-else
                :connection-stats="connectionStats"
                :recent-connections="recentConnections"
                :app-version="appVersion"
                :has-connections="connectionStore.connections.length > 0"
                @open-connection-query="openConnectionQuery"
                @new-connection="showConnectionDialog = true"
                @new-query="newQuery"
                @show-history="showHistory = true"
                @import-config="dialogs.onImportClick"
                @open-github="openGitHub"
                @open-mcp-guide="openMcpGuide"
              />
            </div>
          </div>

          <div
            v-if="showAiPanel"
            :class="
              isClassicLayout
                ? 'h-full shrink-0 relative bg-background'
                : 'h-full shrink-0 relative rounded-md border border-border/80 bg-background'
            "
            :style="{ width: aiPanelWidth + 'px' }"
          >
            <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startAiPanelResize" />
            <div class="h-full min-h-0 overflow-hidden">
              <AiAssistant
                v-if="aiPanelReady"
                ref="aiAssistantRef"
                :tab="activeTab"
                :connection="activeConnection"
                @replace-sql="onAiReplaceSql"
                @execute-sql="onAiExecuteSql"
                @request-auto-execute-sql="onAiRequestAutoExecuteSql"
                @close="toggleAiPanel"
              />
            </div>
          </div>

          <div
            v-if="showHistory"
            :class="
              isClassicLayout
                ? 'h-full shrink-0 relative bg-background'
                : 'h-full shrink-0 relative rounded-md border border-border/80 bg-background'
            "
            :style="{ width: historyWidth + 'px' }"
          >
            <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startHistoryResize" />
            <QueryHistory
              @restore="restoreHistorySql"
              @analyze-ai="analyzeHistoryWithAi"
              @close="showHistory = false"
            />
          </div>
        </div>

        <AppDialogs
          :show-connection-dialog="showConnectionDialog"
          :connection-prefill="connectionDialogPrefill"
          :show-settings-dialog="showSettingsDialog"
          :app-version="appVersion"
          :show-danger-dialog="showDangerDialog"
          :danger-sql="dangerSql"
          @update:show-connection-dialog="setConnectionDialogOpen"
          @update:show-settings-dialog="showSettingsDialog = $event"
          @update:show-danger-dialog="showDangerDialog = $event"
          @danger-confirm="onDangerConfirm"
          @connect-started="(name: string) => toast(t('connection.connecting', { name }), 30000)"
          @connect-succeeded="(name: string) => toast(t('connection.connectSuccess', { name }), 2000)"
          @connect-failed="
            (msg: string) => toast(t('connection.connectFailed', { message: translateBackendError(t, msg) }), 5000)
          "
          @open-driver-store="
            setConnectionDialogOpen(false);
            showDriverStore = true;
          "
          @structure-editor-saved="onStructureEditorSaved(onReloadData, toast)"
          @open-lineage-target="openLineageTarget"
          @open-database-search-target="openDatabaseSearchTarget"
        />
        <UpdateDialog
          v-if="showUpdateDialog"
          v-model:open="showUpdateDialog"
          :update-info="updateInfo"
          :update-check-message="updateCheckMessage"
          :is-downloading-update="isDownloadingUpdate"
          :download-progress="downloadProgress"
          :update-ready="updateReady"
          @open-latest-release="openLatestRelease"
          @download-and-install="downloadAndInstallUpdate"
          @restart="restartApp"
        />
        <Transition name="toast">
          <div
            v-if="toastVisible"
            class="fixed bottom-6 left-1/2 -translate-x-1/2 z-100 px-4 py-2 rounded-lg bg-foreground text-background text-sm shadow-lg"
          >
            {{ toastMessage }}
          </div>
        </Transition>
      </div>

      <Dialog v-model:open="showSaveSqlDialog">
        <DialogContent class="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>{{ t("savedSql.saveToLibrary") }}</DialogTitle>
          </DialogHeader>
          <div class="space-y-3">
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("savedSql.fileName") }}</label>
              <Input v-model="saveSqlName" @keydown.enter.prevent="confirmSaveSqlToLibrary" />
            </div>
            <div class="space-y-1.5">
              <label class="text-xs font-medium text-muted-foreground">{{ t("savedSql.folder") }}</label>
              <Select v-model="saveSqlFolderId">
                <SelectTrigger class="h-8 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem :value="ROOT_SAVED_SQL_FOLDER">{{ t("savedSql.rootFolder") }}</SelectItem>
                  <SelectItem v-for="folder in saveSqlFolders" :key="folder.id" :value="folder.id">
                    {{ folder.name }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" @click="showSaveSqlDialog = false">{{ t("dangerDialog.cancel") }}</Button>
            <Button :disabled="!saveSqlName.trim()" @click="confirmSaveSqlToLibrary">{{ t("savedSql.save") }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>

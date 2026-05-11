<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { TooltipProvider } from "@/components/ui/tooltip";
import AiAssistant from "@/components/editor/AiAssistant.vue";
import QueryHistory from "@/components/editor/QueryHistory.vue";
import AppToolbar from "@/components/layout/AppToolbar.vue";
import AppTabBar from "@/components/layout/AppTabBar.vue";
import AppSidebar from "@/components/layout/AppSidebar.vue";
import EditorToolbar from "@/components/layout/EditorToolbar.vue";
import ContentArea from "@/components/layout/ContentArea.vue";
import AppDialogs from "@/components/layout/AppDialogs.vue";
import WelcomeScreen from "@/components/layout/WelcomeScreen.vue";
import UpdateDialog from "@/components/layout/UpdateDialog.vue";
import LoginPage from "@/components/auth/LoginPage.vue";
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
import { setLocale, currentLocale, nextLocale } from "@/i18n";
import * as api from "@/lib/api";
import { resolveDefaultDatabase } from "@/lib/defaultDatabase";
import { resolveExecutableSql } from "@/lib/sqlExecutionTarget";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { isCloseTabShortcut, isExecuteSqlShortcut } from "@/lib/keyboardShortcuts";
import { isPreviewTab } from "@/lib/tabPresentation";
import { SQL_FILE_UNSUPPORTED_TYPES } from "@/lib/databaseCapabilities";
import { classifyAiSqlExecution } from "@/lib/aiSqlExecutionPolicy";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { HistoryEntry } from "@/lib/tauri";

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const savedSqlStore = useSavedSqlStore();
const { message: toastMessage, visible: toastVisible, toast } = useToast();
const { isDark, applyTheme, toggleTheme } = useTheme();
const {
  checkingUpdates,
  updateInfo,
  updateCheckMessage,
  showUpdateDialog,
  isDownloadingUpdate,
  downloadProgress,
  updateReady,
  openUrl,
  checkUpdates,
  openLatestRelease,
  downloadAndInstallUpdate,
  restartApp,
} = useAppUpdater();
const { setupFileDrop } = useFileDrop();

const isDesktop = isTauriRuntime();
const needsAuth = ref(!isDesktop);
const authenticated = ref(isDesktop);
const setupRequired = ref(false);

const showConnectionDialog = ref(false);
const showSettingsDialog = ref(false);
const showHistory = ref(false);
const showAiPanel = ref(localStorage.getItem("dbx-ai-panel-open") !== "false");
const { sidebarWidth, aiPanelWidth, historyWidth, startSidebarResize, startAiPanelResize, startHistoryResize } =
  usePanelResize();
const aiAssistantRef = ref<InstanceType<typeof AiAssistant> | null>(null);

const selectedSql = ref("");
const cursorPos = ref(0);
const formatSqlRequestId = ref(0);
const activeOutputView = ref<"result" | "explain" | "chart">("result");
const showSaveSqlDialog = ref(false);
const saveSqlName = ref("");
const saveSqlFolderId = ref("");
const ROOT_SAVED_SQL_FOLDER = "__root__";

const activeTab = computed(() => queryStore.tabs.find((t) => t.id === queryStore.activeTabId));

const activeConnection = computed(() => {
  const tab = activeTab.value;
  return tab ? connectionStore.getConfig(tab.connectionId) : undefined;
});

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
const { setupTauriListeners, cleanupTauriListeners } = useTauriEvents({ openTableTarget });

const appVersion = ref("");
const isClassicLayout = computed(() => settingsStore.editorSettings.appLayout === "classic");
const hasSqlFileConnections = computed(() =>
  connectionStore.connections.some((c) => !SQL_FILE_UNSUPPORTED_TYPES.has(c.db_type)),
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
  () => {
    selectedSql.value = "";
    activeOutputView.value = "result";
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

async function newQuery() {
  const connId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id;
  if (!connId) return;
  const conn = connectionStore.getConfig(connId);
  if (!conn) return;
  connectionStore.activeConnectionId = connId;
  const tabId = queryStore.createTab(conn.id, resolveDefaultDatabase(conn, []));
  try {
    await connectionStore.ensureConnected(connId);
    const options = await getDatabaseOptions(connId);
    queryStore.updateDatabase(tabId, resolveDefaultDatabase(conn, options));
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: e?.message || String(e) }), 5000);
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
    toast(t("connection.connectFailed", { message: e?.message || String(e) }), 5000);
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
    toast(t("connection.connectFailed", { message: e?.message || String(e) }), 5000);
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

function toggleLocale() {
  setLocale(nextLocale(currentLocale()));
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
  if (isCloseTabShortcut(e)) {
    e.preventDefault();
    if (queryStore.activeTabId) queryStore.closeTab(queryStore.activeTabId);
    return;
  }
  if (
    activeTab.value?.mode === "query" &&
    !showSaveSqlDialog.value &&
    !e.isComposing &&
    !e.altKey &&
    (e.metaKey || e.ctrlKey) &&
    e.key.toLowerCase() === "s"
  ) {
    e.preventDefault();
    e.stopPropagation();
    void openSaveSqlDialog();
    return;
  }
  if (
    activeTab.value?.mode === "query" &&
    isExecuteSqlShortcut(e) &&
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
  savedSqlStore
    .initFromStorage()
    .then(() => connectionStore.initFromDisk())
    .then(() => {
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
  if (target.closest("[data-radix-vue-collection-item], [data-context-menu]")) return;
  e.preventDefault();
}

onMounted(async () => {
  applyTheme();
  window.addEventListener("keydown", handleKeydown, true);
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
  checkUpdates({ silent: true });
  api
    .getAppVersion()
    .then((v) => {
      appVersion.value = v;
    })
    .catch(() => {});
  setupTauriListeners();
});

onUnmounted(() => {
  cleanupTauriListeners();
  window.removeEventListener("keydown", handleKeydown, true);
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
          :show-ai-panel="showAiPanel"
          :show-history="showHistory"
          :checking-updates="checkingUpdates"
          :has-connections="connectionStore.connections.length > 0"
          :has-sql-file-connections="hasSqlFileConnections"
          @new-connection="showConnectionDialog = true"
          @new-query="newQuery"
          @toggle-theme="toggleTheme"
          @toggle-locale="toggleLocale"
          @toggle-ai="toggleAiPanel"
          @toggle-history="showHistory = !showHistory"
          @open-github="openGitHub"
          @open-settings="showSettingsDialog = true"
          @check-updates="checkUpdates()"
          @open-transfer="dialogs.showTransferDialog.value = true"
          @open-sql-file="dialogs.showSqlFileDialog.value = true"
        />

        <div
          :class="
            isClassicLayout
              ? 'app-layout-classic flex-1 flex min-h-0'
              : 'app-panel-gutter flex-1 flex min-h-0 gap-1 p-1'
          "
        >
          <AppSidebar
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
              <AppTabBar />
              <div v-if="activeTab" class="flex flex-col flex-1 min-h-0">
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
                <ContentArea
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
                  @reload="
                    (sql?: string, searchText?: string, whereInput?: string, orderBy?: string) =>
                      onReloadData(sql, searchText, whereInput, orderBy)
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
            <QueryHistory @restore="restoreHistorySql" @close="showHistory = false" />
          </div>
        </div>

        <AppDialogs
          :show-connection-dialog="showConnectionDialog"
          :show-settings-dialog="showSettingsDialog"
          :show-danger-dialog="showDangerDialog"
          :danger-sql="dangerSql"
          @update:show-connection-dialog="showConnectionDialog = $event"
          @update:show-settings-dialog="showSettingsDialog = $event"
          @update:show-danger-dialog="showDangerDialog = $event"
          @danger-confirm="onDangerConfirm"
          @connect-started="(name: string) => toast(t('connection.connecting', { name }), 30000)"
          @connect-succeeded="(name: string) => toast(t('connection.connectSuccess', { name }), 2000)"
          @connect-failed="(msg: string) => toast(t('connection.connectFailed', { message: msg }), 5000)"
          @structure-editor-saved="onStructureEditorSaved(onReloadData, toast)"
          @open-lineage-target="openLineageTarget"
          @open-database-search-target="openDatabaseSearchTarget"
        />
        <UpdateDialog
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

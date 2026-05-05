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
import { useHistoryStore } from "@/stores/historyStore";
import { useSettingsStore, EDITOR_THEMES } from "@/stores/settingsStore";
import { useSettingsStore } from "@/stores/settingsStore";
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
import { setLocale, currentLocale } from "@/i18n";
import * as api from "@/lib/api";
import { resolveExecutableSql } from "@/lib/sqlExecutionTarget";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { isCloseTabShortcut, isExecuteSqlShortcut } from "@/lib/keyboardShortcuts";
import { isPreviewTab } from "@/lib/tabPresentation";

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const { message: toastMessage, visible: toastVisible, toast } = useToast();
const { isDark, applyTheme, toggleTheme } = useTheme();
const {
  checkingUpdates, updateInfo, updateCheckMessage, showUpdateDialog,
  isDownloadingUpdate, downloadProgress, updateReady,
  openUrl, checkUpdates, openLatestRelease,
  downloadAndInstallUpdate, restartApp,
} = useAppUpdater();
const { setupFileDrop } = useFileDrop();

const isDesktop = isTauriRuntime();
const needsAuth = ref(!isDesktop);
const authenticated = ref(isDesktop);

const showConnectionDialog = ref(false);
const showSettingsDialog = ref(false);
const showHistory = ref(false);
const showAiPanel = ref(localStorage.getItem("dbx-ai-panel-open") !== "false");
const {
  sidebarWidth, aiPanelWidth, historyWidth,
  startSidebarResize, startAiPanelResize, startHistoryResize,
} = usePanelResize();
const aiAssistantRef = ref<InstanceType<typeof AiAssistant> | null>(null);

const selectedSql = ref("");
const cursorPos = ref(0);
const formatSqlRequestId = ref(0);
const activeOutputView = ref<"result" | "explain">("result");

const activeTab = computed(() =>
  queryStore.tabs.find((t) => t.id === queryStore.activeTabId)
);

const activeConnection = computed(() => {
  const tab = activeTab.value;
  return tab ? connectionStore.getConfig(tab.connectionId) : undefined;
});

const executableSql = computed(() => {
  const tab = activeTab.value;
  return tab ? resolveExecutableSql(tab.sql, selectedSql.value, {
    mode: settingsStore.editorSettings.executeMode,
    cursorPos: cursorPos.value,
  }) : "";
});

const {
  dangerSql, showDangerDialog,
  tryExecute, cancelActiveExecution, tryExplain, onDangerConfirm,
} = useSqlExecution({ activeTab, activeConnection, executableSql, activeOutputView });

const dialogs = useDialogSources();
const { getDatabaseOptions } = useDatabaseOptions();
const { openLineageTarget, openDatabaseSearchTarget, onStructureEditorSaved, openTableTarget } =
  useNavigationTargets(dialogs);
const { onExecuteSql, onReloadData, onPaginate, onSort } = useDataGridActions(activeTab);
const { setupTauriListeners } = useTauriEvents({ openTableTarget });

const appVersion = ref("");
const sqlFileUnsupportedTypes = new Set(["redis", "mongodb", "elasticsearch"]);
const hasSqlFileConnections = computed(() =>
  connectionStore.connections.some((c) => !sqlFileUnsupportedTypes.has(c.db_type))
);
const connectionStats = computed(() => ({
  total: connectionStore.connections.length,
  connected: connectionStore.connectedIds.size,
  types: new Set(connectionStore.connections.map((c) => c.driver_profile || c.db_type)).size,
}));
const recentConnections = computed(() => connectionStore.connections.slice(0, 5));

watch(() => queryStore.activeTabId, () => {
  selectedSql.value = "";
  activeOutputView.value = "result";
});

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

function newQuery() {
  const connId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id;
  if (!connId) return;
  const conn = connectionStore.getConfig(connId);
  if (!conn) return;
  connectionStore.activeConnectionId = connId;
  queryStore.createTab(conn.id, conn.database || "");
}

async function openConnectionQuery(connectionId: string) {
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  const options = await getDatabaseOptions(connectionId);
  connectionStore.activeConnectionId = connectionId;
  queryStore.createTab(connectionId, connection.database || options[0] || "");
}

async function changeActiveConnection(connectionId: string) {
  const tab = activeTab.value;
  if (!tab) return;
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  const options = await getDatabaseOptions(connectionId);
  queryStore.updateConnection(tab.id, connectionId, connection.database || options[0] || "");
  connectionStore.activeConnectionId = connectionId;
}

function changeActiveDatabase(database: string) {
  const tab = activeTab.value;
  if (tab) queryStore.updateDatabase(tab.id, database);
}

function toggleLocale() { setLocale(currentLocale() === "zh-CN" ? "en" : "zh-CN"); }
function openGitHub() { openUrl("https://github.com/t8y2/dbx"); }
function openMcpGuide() { openUrl("https://github.com/t8y2/dbx/blob/main/docs/mcp-guide.md"); }

function ensureQueryTab(): string {
  const tab = activeTab.value;
  if (tab && tab.mode === "query") return tab.id;
  const connId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
  const db = tab?.database || "";
  return queryStore.createTab(connId, db, undefined, "query");
}

async function onSort(column: string, direction: "asc" | "desc" | null, whereInput?: string) {
  const tab = activeTab.value;
  if (!tab?.tableMeta) return;
  const orderBy = direction ? `${quoteIdent(tab, column)} ${direction.toUpperCase()}` : undefined;
  const sql = buildTableSql(tab, { orderBy, whereInput });
  queryStore.updateSql(tab.id, sql);
  await queryStore.executeCurrentTab();
}

function toggleLocale() {
  const next: Locale = currentLocale() === "zh-CN" ? "en" : "zh-CN";
  setLocale(next);
}

const systemPrefersDark = ref(
  (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) ?? false
);
const themeMode = computed(() => settingsStore.appSettings.themeMode);
const isDark = computed(() => themeMode.value === "dark" || (themeMode.value === "system" && systemPrefersDark.value));
const isCompact = computed(() => settingsStore.appSettings.density === "compact");
const activeStatusConnection = computed(() => activeConnection.value || (connectionStore.activeConnectionId ? connectionStore.getConfig(connectionStore.activeConnectionId) : undefined));
const activeStatusDatabase = computed(() => activeTab.value?.database || "");

function applyTheme() {
  document.documentElement.classList.toggle("dark", isDark.value);
  if (!isTauriRuntime()) return;
  getCurrentWindow()
    .setTheme(isDark.value ? "dark" as Theme : "light" as Theme)
    .catch(() => {});
}

function toggleTheme() {
  const current = themeMode.value;
  let next: "system" | "light" | "dark";
  if (current === "system") next = "light";
  else if (current === "light") next = "dark";
  else next = "system";
  settingsStore.updateAppSettings({ themeMode: next });
}

function toggleDensity() {
  settingsStore.updateAppSettings({ density: isCompact.value ? "comfortable" : "compact" });
}

function syncEditorThemeWithApp() {
  if (!settingsStore.appSettings.syncEditorTheme) return;
  const currentTheme = settingsStore.editorSettings.theme;
  const lightThemes = new Set(EDITOR_THEMES.filter(t => !t.dark).map(t => t.value));
  const darkThemes = new Set(EDITOR_THEMES.filter(t => t.dark).map(t => t.value));
  const defaultDarkTheme = EDITOR_THEMES.find(t => t.dark)?.value ?? "one-dark";
  const defaultLightTheme = EDITOR_THEMES.find(t => !t.dark)?.value ?? "vscode-light";
  const targetTheme = isDark.value ? defaultDarkTheme : defaultLightTheme;
  if ((isDark.value && lightThemes.has(currentTheme)) || (!isDark.value && darkThemes.has(currentTheme))) {
    settingsStore.updateEditorSettings({ theme: targetTheme });
  }
}

let systemThemeMedia: MediaQueryList | null = null;
let systemThemeListener: ((event: MediaQueryListEvent) => void) | null = null;

import { open } from "@tauri-apps/plugin-shell";

function openGitHub() {
  open("https://github.com/t8y2/dbx");
}

function openMcpGuide() {
  open("https://github.com/t8y2/dbx/blob/main/docs/mcp-guide.md");
}

async function checkUpdates(options: { silent?: boolean } = {}) {
  if (checkingUpdates.value) return;
  checkingUpdates.value = true;
  updateCheckMessage.value = "";
  try {
    const info = await api.checkForUpdates();
    updateInfo.value = info;
    if (info.update_available) {
      showUpdateDialog.value = true;
    } else if (!options.silent) {
      updateCheckMessage.value = t("updates.upToDate", { version: info.current_version });
      showUpdateDialog.value = true;
    }
  } catch (e: any) {
    if (!options.silent) {
      updateCheckMessage.value = formatUpdateError(String(e));
      showUpdateDialog.value = true;
    }
  } finally {
    checkingUpdates.value = false;
  }
}

function onAiReplaceSql(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, sql);
}

function onAiExecuteSql(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, sql);
  nextTick(() => tryExecute());
}

function handleKeydown(e: KeyboardEvent) {
  if (isCloseTabShortcut(e)) {
    e.preventDefault();
    if (queryStore.activeTabId) queryStore.closeTab(queryStore.activeTabId);
    return;
  }
  if (activeTab.value?.mode === "query" && isExecuteSqlShortcut(e)
    && e.target instanceof Element && e.target.closest("[data-query-editor-root]")) {
    e.preventDefault();
    e.stopPropagation();
    tryExecute();
  }
}

onMounted(() => {
  applyTheme();
  syncEditorThemeWithApp();
  systemThemeMedia = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  systemThemeListener = (event: MediaQueryListEvent) => {
    systemPrefersDark.value = event.matches;
    applyTheme();
  };
  systemThemeMedia?.addEventListener?.("change", systemThemeListener);
  connectionStore.initFromDisk().catch((e: any) => {
    toast(t("connection.loadFailed", { message: e?.message || String(e) }), 5000);
  });
  settingsStore.initAiConfig();
  window.addEventListener("keydown", handleKeydown, true);
  window.addEventListener("resize", updateScrollButtons);
  if (isTauriRuntime()) {
    setupFileDrop().catch(() => {});
    checkUpdates({ silent: true });
    getVersion().then((v) => { appVersion.value = v; }).catch(() => {});
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ connection_id: string; database: string; schema?: string; table: string }>("mcp-open-table", async (event) => {
        const { connection_id, database, schema, table } = event.payload;

        if (!connectionStore.connections.length) {
          await connectionStore.initFromDisk();
        }
        const config = connectionStore.getConfig(connection_id);
        if (!config) return;
        connectionStore.activeConnectionId = connection_id;
        await connectionStore.ensureConnected(connection_id);

        if (config.db_type === "redis") {
          queryStore.createTab(connection_id, database || "0", `db${database || "0"}`, "redis");
        } else if (config.db_type === "mongodb") {
          queryStore.createTab(connection_id, database, table, "mongo");
        } else {
          openLineageTarget({ connectionId: connection_id, database, schema, tableName: table });
        }

        getCurrentWindow().setFocus().catch(() => {});
      });
      listen<{ connection_id: string; database: string; sql: string }>("mcp-execute-query", async (event) => {
        const { connection_id, database, sql } = event.payload;
        if (!connectionStore.connections.length) {
          await connectionStore.initFromDisk();
        }
        const config = connectionStore.getConfig(connection_id);
        if (!config) return;
        connectionStore.activeConnectionId = connection_id;
        await connectionStore.ensureConnected(connection_id);
        const tabId = queryStore.createTab(connection_id, database, undefined, "query");
        queryStore.updateSql(tabId, sql);
        await queryStore.executeTabSql(tabId, sql);
        getCurrentWindow().setFocus().catch(() => {});
      });
    }).catch(() => {});
  }
});

onUnmounted(() => {
  window.removeEventListener("keydown", handleKeydown, true);
  window.removeEventListener("resize", updateScrollButtons);
});

watch(() => settingsStore.appSettings, () => {
  applyTheme();
  syncEditorThemeWithApp();
}, { deep: true });
watch(isDark, syncEditorThemeWithApp);

const DB_EXTENSIONS = [".db", ".sqlite", ".sqlite3", ".duckdb"];

function getDbType(path: string): "sqlite" | "duckdb" | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".duckdb")) return "duckdb";
  if (DB_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "sqlite";
  return null;
}

function initApp() {
  connectionStore.initFromDisk().then(() => {
    reconnectRestoredTabs();
  }).catch((e: any) => {
    toast(t("connection.loadFailed", { message: e?.message || String(e) }), 5000);
  });
  settingsStore.initAiConfig();
}

async function reconnectRestoredTabs() {
  if (isDesktop) return;
  const connectionIds = new Set(queryStore.tabs.map(t => t.connectionId).filter(Boolean));
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

onMounted(async () => {
  applyTheme();
  window.addEventListener("keydown", handleKeydown, true);
  if (!isDesktop) {
    try {
      const res = await fetch("/api/auth/check");
      const data = await res.json();
      needsAuth.value = data.required;
      authenticated.value = data.authenticated;
    } catch { /* server unreachable */ }
    if (!needsAuth.value || authenticated.value) initApp();
    api.checkForUpdates().then((info) => { appVersion.value = info.current_version; }).catch(() => {});
    return;
  }
  initApp();
  setupFileDrop().catch(() => {});
  checkUpdates({ silent: true });
  import("@tauri-apps/api/app").then(({ getVersion }) => {
    getVersion().then((v) => { appVersion.value = v; }).catch(() => {});
  }).catch(() => {});
  setupTauriListeners();
});

onUnmounted(() => { window.removeEventListener("keydown", handleKeydown, true); });
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden" :class="{ 'dbx-compact': isCompact }">
      <!-- Toolbar -->
      <div class="dbx-toolbar h-10 flex items-center gap-1 px-2 border-b bg-muted/30 shrink-0">
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs gap-1" @click="showConnectionDialog = true">
          <DatabaseZap class="h-3.5 w-3.5" />
          {{ t('toolbar.newConnection') }}
        </Button>

        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs gap-1" @click="newQuery" :disabled="!connectionStore.connections.length">
          <FilePlus2 class="h-3.5 w-3.5" />
          {{ t('toolbar.newQuery') }}
        </Button>

        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs gap-1" @click="showTransferDialog = true" :disabled="!connectionStore.connections.length">
          <ArrowLeftRight class="h-3.5 w-3.5" />
          {{ t('transfer.dataTransfer') }}
        </Button>

        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs gap-1" @click="showSqlFileDialog = true" :disabled="!hasSqlFileConnections">
          <FileCode class="h-3.5 w-3.5" />
          {{ t('sqlFile.title') }}
        </Button>

        <div class="flex-1" />

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="checkingUpdates" @click="checkUpdates()">
              <Loader2 v-if="checkingUpdates" class="h-4 w-4 animate-spin" />
              <CloudDownload v-else class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('updates.check') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" :class="{ 'bg-accent': showHistory }" @click="showHistory = !showHistory">
              <History class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('history.title') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" :class="{ 'bg-accent': showAiPanel }" @click="toggleAiPanel">
              <Bot class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>AI</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="toggleTheme">
              <Monitor v-if="themeMode === 'system'" class="h-4 w-4" />
              <Moon v-else-if="!isDark" class="h-4 w-4" />
              <Sun v-else class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            <span v-if="themeMode === 'system'">{{ t('settings.themeLight') }}</span>
            <span v-else-if="themeMode === 'light'">{{ t('settings.themeDark') }}</span>
            <span v-else>{{ t('settings.themeSystem') }}</span>
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" :class="{ 'bg-accent': isCompact }" @click="toggleDensity">
              <Rows3 class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ isCompact ? t('settings.comfortableDensity') : t('settings.compactDensity') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="toggleLocale">
              <Globe class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('common.language') }}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="openGitHub">
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12 24 5.37 18.627 0 12 0z"/></svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent>GitHub</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon" class="h-7 w-7" @click="showSettingsDialog = true">
              <Settings class="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ t('settings.title') }}</TooltipContent>
        </Tooltip>
      </div>
  <LoginPage v-if="needsAuth && !authenticated" @authenticated="authenticated = true; initApp()" />
  <TooltipProvider v-show="!needsAuth || authenticated" :delay-duration="300">
    <div class="h-screen w-screen flex flex-col bg-background text-foreground overflow-hidden">
      <AppToolbar
        :is-dark="isDark" :show-ai-panel="showAiPanel" :show-history="showHistory"
        :checking-updates="checkingUpdates"
        :has-connections="connectionStore.connections.length > 0"
        :has-sql-file-connections="hasSqlFileConnections"
        @new-connection="showConnectionDialog = true" @new-query="newQuery"
        @toggle-theme="toggleTheme" @toggle-locale="toggleLocale"
        @toggle-ai="toggleAiPanel" @toggle-history="showHistory = !showHistory"
        @open-github="openGitHub" @open-settings="showSettingsDialog = true"
        @check-updates="checkUpdates()"
        @open-transfer="dialogs.showTransferDialog.value = true"
        @open-sql-file="dialogs.showSqlFileDialog.value = true"
      />

      <div class="flex-1 flex min-h-0">
        <AppSidebar
          :sidebar-width="sidebarWidth"
          @import="dialogs.onImportClick" @export="dialogs.onExportClick"
          @start-resize="startSidebarResize"
        />

        <div class="flex-1 min-w-0">
          <div class="h-full flex flex-col min-w-0">
          <!-- Tabs Bar -->
          <div v-if="queryStore.tabs.length > 0" class="relative h-9 flex items-center border-b bg-muted/20 shrink-0">
            <button
              v-if="canScrollLeft"
              class="absolute left-0 z-10 h-full px-1 bg-linear-to-r from-background via-background/80 to-transparent text-muted-foreground hover:text-foreground"
              :aria-label="t('tabs.scrollLeft')"
              @click="scrollTabs('left')"
            >
              <ChevronRight class="h-4 w-4 rotate-180" />
            </button>
            <div
              ref="tabsContainerRef"
              class="flex-1 flex items-center overflow-x-auto min-w-0"
              style="-ms-overflow-style:none;scrollbar-width:none;-webkit-overflow-scrolling:touch"
              @scroll="updateScrollButtons"
            >
            <ContextMenu
              v-for="tab in queryStore.tabs"
              :key="tab.id"
            >
              <ContextMenuTrigger as-child>
                <Tooltip>
                <TooltipTrigger as-child>
                <div
                  class="group flex min-w-38 items-center gap-1 px-1 h-full text-xs cursor-pointer border-r border-b-2 hover:bg-accent transition-colors whitespace-nowrap"
                  :class="tab.id === queryStore.activeTabId ? 'bg-background font-medium border-b-primary' : 'font-normal text-muted-foreground border-b-transparent'"
                  :data-active-tab="tab.id === queryStore.activeTabId"
                  @click="queryStore.activeTabId = tab.id"
                >
                  <span class="h-4 w-1 rounded-full shrink-0" :style="{ backgroundColor: connectionColor(tab.connectionId) || '#9ca3af' }" />
                  <span class="min-w-0 truncate flex-1">{{ tabDisplayTitle(tab) }}</span>
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <button
                          class="inline-flex rounded p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground focus:opacity-100"
                          :class="tab.pinned ? 'visible text-primary' : 'invisible group-hover:visible'"
                          @click.stop="queryStore.togglePinnedTab(tab.id)"
                      >
                        <Pin class="h-3 w-3" :class="{ 'fill-current': tab.pinned }" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{{ tab.pinned ? t('contextMenu.unpin') : t('contextMenu.pin') }}</TooltipContent>
                  </Tooltip>
                  <span
                    class="shrink-0 rounded border px-1 text-[10px] leading-4"
                    :class="tab.mode === 'data' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300' : 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950 dark:text-blue-300'"
                  >
                    {{ tabModeLabel(tab) }}
                  </span>
                  <button
                    class="rounded hover:bg-muted-foreground/20 p-0.5 shrink-0"
                    @click.stop="queryStore.closeTab(tab.id)"
                  >
                    <X class="h-3 w-3" />
                  </button>
                </div>
                </TooltipTrigger>
                <TooltipContent side="bottom" class="text-xs grid grid-cols-[auto_1fr] gap-x-2">
                  <template v-for="line in tabTooltipLines(tab)" :key="line.label">
                    <span class="text-muted-foreground">{{ line.label }}</span>
                    <span>{{ line.value }}</span>
                  </template>
                </TooltipContent>
                </Tooltip>
              </ContextMenuTrigger>

              <ContextMenuContent class="w-44">
                <ContextMenuItem @click="queryStore.togglePinnedTab(tab.id)">
                  <Pin class="w-3.5 h-3.5 mr-2" :class="{ 'fill-current': tab.pinned }" />
                  {{ tab.pinned ? t('contextMenu.unpin') : t('contextMenu.pin') }}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem @click="queryStore.closeTab(tab.id)">
                  <X class="w-3.5 h-3.5 mr-2" />
                  {{ t('contextMenu.closeTab') }}
                </ContextMenuItem>
                <ContextMenuItem
                  :disabled="queryStore.tabs.length <= 1"
                  @click="queryStore.closeOtherTabs(tab.id)"
                >
                  <X class="w-3.5 h-3.5 mr-2" />
                  {{ t('contextMenu.closeOtherTabs') }}
                </ContextMenuItem>
                <ContextMenuItem variant="destructive" @click="queryStore.closeAllTabs">
                  <X class="w-3.5 h-3.5 mr-2" />
                  {{ t('contextMenu.closeAllTabs') }}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            <AppTabBar />
            <div v-if="activeTab" class="flex flex-col flex-1 min-h-0">
              <EditorToolbar
                v-if="activeTab.mode === 'query' && !isPreviewTab(activeTab)"
                :active-tab="activeTab" :active-connection="activeConnection" :executable-sql="executableSql"
                @execute="tryExecute()" @cancel="cancelActiveExecution()" @explain="tryExplain()"
                @format-sql="formatActiveSql"
                @change-connection="changeActiveConnection" @change-database="changeActiveDatabase"
              />
              <ContentArea
                :active-tab="activeTab" :active-connection="activeConnection" :executable-sql="executableSql"
                :active-output-view="activeOutputView" :format-sql-request-id="formatSqlRequestId"
                :selected-sql="selectedSql" :cursor-pos="cursorPos"
                @update:active-output-view="activeOutputView = $event"
                @fix-with-ai="fixWithAi" @execute="tryExecute()" @cancel="cancelActiveExecution()"
                @explain="tryExplain()"
                @editor-update="(v: string) => { if (queryStore.activeTabId) queryStore.updateSql(queryStore.activeTabId, v) }"
                @editor-selection-change="(v: string) => selectedSql = v"
                @editor-cursor-change="(p: number) => cursorPos = p"
                @format-error="toast(t('toolbar.formatSqlFailed'))"
                @reload="onReloadData" @paginate="onPaginate" @sort="onSort" @execute-sql="onExecuteSql"
              />
            </div>
            <WelcomeScreen
              v-else
              :connection-stats="connectionStats" :recent-connections="recentConnections"
              :app-version="appVersion" :has-connections="connectionStore.connections.length > 0"
              @open-connection-query="openConnectionQuery" @new-connection="showConnectionDialog = true"
              @new-query="newQuery" @show-history="showHistory = true"
              @import-config="dialogs.onImportClick" @open-github="openGitHub" @open-mcp-guide="openMcpGuide"
            />
          </div>
        </div>

          <!-- Editor Panel -->
          <div v-if="activeTab" class="flex flex-col flex-1 min-h-0">
            <div v-if="activeTab.mode === 'query' && !isPreviewTab(activeTab)" class="dbx-query-header h-9 shrink-0 border-b bg-background/80 px-3 flex items-center gap-1 text-xs text-muted-foreground">
              <div class="flex items-center gap-0.5">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      :variant="activeTab.isExecuting ? 'destructive' : 'ghost'"
                      size="icon"
                      class="h-6 w-6"
                      :disabled="activeTab.isCancelling || activeTab.isExplaining || (!activeTab.isExecuting && !executableSql.trim())"
                      @click="activeTab.isExecuting ? cancelActiveExecution() : tryExecute()"
                    >
                      <Loader2 v-if="activeTab.isCancelling" class="h-3.5 w-3.5 animate-spin" />
                      <Square v-else-if="activeTab.isExecuting" class="h-3.5 w-3.5 fill-current" />
                      <Play v-else class="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ activeTab.isExecuting ? t('toolbar.stopQuery') : t('toolbar.executeShortcut') }}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button
                      :variant="activeTab.isExplaining ? 'destructive' : 'ghost'"
                      size="icon"
                      class="h-6 w-6"
                      :disabled="activeTab.isExecuting || (!activeTab.isExplaining && !executableSql.trim())"
                      @click="activeTab.isExplaining ? cancelActiveExecution() : tryExplain()"
                    >
                      <Square v-if="activeTab.isExplaining" class="h-3.5 w-3.5 fill-current" />
                      <GitBranch v-else class="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ activeTab.isExplaining ? t('toolbar.stopExplain') : t('toolbar.explainPlan') }}</TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger as-child>
                    <Button variant="ghost" size="icon" class="h-6 w-6" :disabled="activeTab.isExecuting || activeTab.isExplaining || !activeTab.sql.trim()" @click="formatActiveSql">
                      <AlignLeft class="h-3.5 w-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{{ t('toolbar.formatSql') }}</TooltipContent>
                </Tooltip>
              </div>
              <span class="flex-1" />
              <div class="flex items-center gap-2">
                <div class="flex items-center gap-1">
                  <span v-if="activeConnection?.color" class="h-4 w-1 rounded-full shrink-0" :style="{ backgroundColor: activeConnection.color }" />
                  <Select
                    :model-value="activeConnectionValue"
                    @update:model-value="changeActiveConnection"
                  >
                    <SelectTrigger class="h-6 w-auto max-w-56 border-0 bg-transparent px-1 text-xs font-medium text-foreground shadow-none focus:ring-0">
                      <div v-if="activeConnection" class="flex min-w-0 items-center gap-1.5">
                        <DatabaseIcon :db-type="connectionIconType(activeConnection)" class="h-3.5 w-3.5 shrink-0" />
                        <span class="truncate">{{ connectionDisplayName(activeConnectionValue) }}</span>
                      </div>
                      <SelectValue v-else :placeholder="t('editor.selectConnection')" />
                    </SelectTrigger>
                    <SelectContent class="min-w-64">
                      <SelectItem
                        v-for="connection in connectionStore.connections"
                        :key="connection.id"
                        :value="connection.id"
                      >
                        <div class="flex min-w-0 items-center gap-2">
                          <span v-if="connection.color" class="h-3.5 w-1 rounded-full shrink-0" :style="{ backgroundColor: connection.color }" />
                          <span v-else class="h-3.5 w-1 shrink-0" />
                          <DatabaseIcon :db-type="connectionIconType(connection)" class="h-3.5 w-3.5 shrink-0" />
                          <div class="min-w-0 flex-1">
                            <div class="truncate">{{ connection.name }}</div>
                            <div class="truncate text-[11px] font-normal text-muted-foreground">{{ connectionOptionSubtitle(connection) }}</div>
                          </div>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="flex items-center gap-1">
                  <Database class="h-3.5 w-3.5 shrink-0" />
                  <Select
                    :model-value="activeDatabaseValue"
                    @update:model-value="changeActiveDatabase"
                    @update:open="(open: boolean) => { if (open && activeConnection) loadDatabaseOptions(activeConnection.id).catch(() => {}) }"
                  >
                    <SelectTrigger class="h-6 w-auto max-w-56 border-0 bg-transparent px-1 text-xs shadow-none focus:ring-0">
                      <SelectValue :placeholder="loadingDatabaseOptions[activeConnection?.id || ''] ? t('common.loading') : t('editor.selectDatabase')">
                        {{ databaseDisplayName(activeDatabaseValue) }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem
                        v-for="database in activeDatabaseOptions"
                        :key="database"
                        :value="database"
                      >
                        {{ databaseDisplayName(database) }}
                      </SelectItem>
                      <SelectItem v-if="!activeDatabaseOptions.length && activeDatabaseValue" :value="activeDatabaseValue">
                        {{ databaseDisplayName(activeDatabaseValue) }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div class="flex items-center gap-2 ml-4">
                <span class="inline-flex max-w-[180px] items-center gap-1 truncate rounded border bg-background/60 px-2 py-0.5 text-xs">
                  <span class="h-1.5 w-1.5 rounded-full" :class="activeStatusConnection && connectionStore.connectedIds.has(activeStatusConnection.id) ? 'bg-green-500' : 'bg-muted-foreground/40'" />
                  <span class="truncate">{{ activeStatusConnection?.name || t('editor.selectConnection') }}</span>
                </span>
                <span class="inline-flex max-w-[140px] items-center gap-1 truncate rounded border bg-background/60 px-2 py-0.5 text-xs">
                  <Database class="h-3 w-3" />
                  <span class="truncate">{{ activeStatusDatabase || t('editor.noDatabase') }}</span>
                </span>
              </div>
              <div v-if="activeTab.tableMeta" class="flex min-w-0 items-center gap-1 ml-2">
                <Table2 class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ activeTab.tableMeta.columns.length }} {{ t('tree.columns') }}</span>
              </div>
            </div>
            <!-- Query mode: editor + results -->
            <template v-if="activeTab.mode === 'query'">
              <Splitpanes horizontal class="flex-1">
                <Pane :size="40" :min-size="15">
                  <div class="h-full flex flex-col">
                    <QueryEditor
                      class="flex-1"
                      :model-value="activeTab.sql"
                      :connection-id="activeTab.connectionId"
                      :database="activeTab.database"
                      :dialect="editorDialect"
                      :format-dialect="activeSqlFormatDialect"
                      :format-request-id="formatSqlRequestId"
                      @update:model-value="onEditorUpdate"
                      @selection-change="onEditorSelectionChange"
                      @format-error="onFormatSqlError"
                      @execute="tryExecute"
                    />
                  </div>
                </Pane>
                <Pane :size="60" :min-size="20">
                  <div class="h-full flex flex-col">
                    <div
                      v-if="activeTab.result || activeTab.explainPlan || activeTab.explainError || activeTab.isExecuting || activeTab.isExplaining"
                      class="h-8 shrink-0 border-b bg-muted/20 px-2 flex items-center gap-1"
                    >
                      <Button
                        size="sm"
                        :variant="activeOutputView === 'result' ? 'secondary' : 'ghost'"
                        class="h-6 px-2 text-xs"
                        :disabled="!activeTab.result && !activeTab.isExecuting"
                        @click="activeOutputView = 'result'"
                      >
                        {{ t('tabs.tableData') }}
                      </Button>
                      <template v-if="activeOutputView === 'result' && activeTab.results && activeTab.results.length > 1">
                        <span class="mx-1 h-4 w-px bg-border" />
                        <Button
                          v-for="(_, rIdx) in activeTab.results"
                          :key="rIdx"
                          size="sm"
                          :variant="activeTab.activeResultIndex === rIdx ? 'default' : 'ghost'"
                          class="h-6 px-2 text-xs"
                          @click="queryStore.setActiveResultIndex(activeTab.id, rIdx)"
                        >
                          {{ t('tabs.resultN', { n: rIdx + 1 }) }}
                        </Button>
                      </template>
                      <Button
                        size="sm"
                        :variant="activeOutputView === 'explain' ? 'secondary' : 'ghost'"
                        class="h-6 px-2 text-xs gap-1"
                        :disabled="!activeTab.explainPlan && !activeTab.explainError && !activeTab.isExplaining"
                        @click="activeOutputView = 'explain'"
                      >
                        <GitBranch class="h-3.5 w-3.5" />
                        {{ t('explain.title') }}
                      </Button>
                    </div>

                    <ExplainPlanViewer
                      v-if="activeOutputView === 'explain'"
                      class="flex-1 min-h-0"
                      :plan="activeTab.explainPlan"
                      :error="activeTab.explainError"
                      :loading="activeTab.isExplaining"
                      :source-sql="activeTab.lastExplainedSql"
                      :explain-sql="activeTab.explainSql"
                    />

                    <template v-else>
                      <DataGrid v-if="activeTab.result" :key="`${activeTab.id}-${activeTab.activeResultIndex ?? 0}`" class="flex-1 min-h-0" :result="activeTab.result" :sql="activeTab.lastExecutedSql || activeTab.sql" :loading="activeTab.isExecuting" />
                      <div v-if="activeTab.result?.columns.includes('Error')" class="flex items-center gap-2 px-3 py-1.5 border-t bg-destructive/5">
                        <Bot class="h-3.5 w-3.5 text-destructive" />
                        <button class="text-xs text-destructive hover:underline" @click="fixWithAi(String(activeTab.result?.rows?.[0]?.[0] ?? ''))">
                          {{ t('ai.fixWithAi') }}
                        </button>
                      </div>
                      <div v-else-if="!activeTab.result && activeTab.isExecuting" class="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
                        <div class="flex items-center">
                          <Loader2 class="h-5 w-5 animate-spin mr-2" />
                          {{ t(queryExecutionLabelKey(activeTab)) }}
                        </div>
                      </div>
                      <div v-else-if="!activeTab.result" class="flex-1 min-h-0 flex items-center justify-center text-muted-foreground text-sm">
                        {{ t('editor.pressToExecute') }}
                      </div>
                    </template>
                  </div>
                </Pane>
              </Splitpanes>
            </template>

            <!-- Data mode: full-height grid -->
            <template v-else-if="activeTab.mode === 'data'">
              <div class="flex-1 min-h-0 flex flex-col">
                <div class="h-9 shrink-0 border-b bg-background/80 px-3 flex items-center gap-2 text-xs">
                  <span class="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300">
                    <Table2 class="h-3.5 w-3.5" />
                    {{ t('tabs.tableData') }}
                  </span>
                  <span class="font-medium truncate">{{ activeTab.tableMeta?.tableName || activeTab.title }}</span>
                  <span class="text-muted-foreground truncate">
                    {{ databaseDisplayNameForTab(activeTab.connectionId, activeTab.database) }}
                    <template v-if="activeTab.tableMeta?.schema"> · {{ activeTab.tableMeta.schema }}</template>
                  </span>
                  <span v-if="activeTab.tableMeta" class="ml-auto text-muted-foreground">
                    {{ activeTab.tableMeta.columns.length }} {{ t('tree.columns') }}
                  </span>
                </div>
                <DataGrid
                  v-if="activeTab.result"
                  class="flex-1 min-h-0"
                  :key="activeTab.id"
                  :result="activeTab.result"
                  :sql="activeTab.sql"
                  :loading="activeTab.isExecuting"
                  :editable="!!activeTab.tableMeta?.primaryKeys?.length"
                  :database-type="activeConnection?.db_type"
                  :connection-id="activeTab.connectionId"
                  :database="activeTab.database"
                  :table-meta="activeTab.tableMeta"
                  :on-execute-sql="onExecuteSql"
                  @reload="onReloadData"
                  @paginate="onPaginate"
                  @sort="onSort"
                />
                <div v-else-if="activeTab.isExecuting" class="h-full flex flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
                  <div class="flex items-center">
                    <Loader2 class="h-5 w-5 animate-spin mr-2" />
                    {{ t(queryExecutionLabelKey(activeTab)) }}
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    class="h-7 gap-1.5"
                    :disabled="!canCancelQueryExecution(activeTab)"
                    @click="cancelActiveExecution"
                  >
                    <Loader2 v-if="activeTab.isCancelling" class="h-3.5 w-3.5 animate-spin" />
                    <Square v-else class="h-3.5 w-3.5 fill-current" />
                    {{ t('toolbar.stopQuery') }}
                  </Button>
                </div>
              </div>
            </template>

            <!-- Redis mode: key browser -->
            <template v-else-if="activeTab.mode === 'redis'">
              <div class="flex-1 min-h-0">
                <RedisKeyBrowser
                  :key="activeTab.id"
                  :connection-id="activeTab.connectionId"
                  :db="Number(activeTab.database)"
                />
              </div>
            </template>

            <!-- MongoDB mode: document browser -->
            <template v-else-if="activeTab.mode === 'mongo'">
              <div class="flex-1 min-h-0">
                <MongoDocBrowser
                  :key="activeTab.id"
                  :connection-id="activeTab.connectionId"
                  :database="activeTab.database"
                  :collection="activeTab.sql"
                />
              </div>
            </template>
          </div>

          <!-- Empty State -->
          <div v-else class="flex-1 overflow-auto bg-background">
            <div class="mx-auto flex min-h-full w-full max-w-5xl flex-col justify-center gap-6 px-8 py-10">
              <div class="grid grid-cols-3 gap-3">
                <div class="rounded-lg border bg-muted/20 px-4 py-3">
                  <div class="flex items-center gap-2 text-xs text-muted-foreground">
                    <Database class="h-3.5 w-3.5" /> {{ t('welcome.connections') }}
                  </div>
                  <div class="mt-2 text-2xl font-semibold">{{ connectionStats.total }}</div>
                </div>
                <div class="rounded-lg border bg-muted/20 px-4 py-3">
                  <div class="flex items-center gap-2 text-xs text-muted-foreground">
                    <ShieldCheck class="h-3.5 w-3.5" /> {{ t('welcome.connected') }}
                  </div>
                  <div class="mt-2 text-2xl font-semibold">{{ connectionStats.connected }}</div>
                </div>
                <div class="rounded-lg border bg-muted/20 px-4 py-3">
                  <div class="flex items-center gap-2 text-xs text-muted-foreground">
                    <Sparkles class="h-3.5 w-3.5" /> {{ t('welcome.databaseTypes') }}
                  </div>
                  <div class="mt-2 text-2xl font-semibold">{{ connectionStats.types }}</div>
                </div>
              </div>

              <div class="grid grid-cols-[1.2fr_0.8fr] gap-4">
                <div class="rounded-lg border">
                  <div class="flex items-center justify-between border-b px-4 py-3">
                    <div class="text-sm font-medium">{{ t('welcome.quickConnections') }}</div>
                  </div>
                  <div class="divide-y">
                    <button
                      v-for="connection in recentConnections"
                      :key="connection.id"
                      class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
                      @click="openConnectionQuery(connection.id)"
                    >
                      <DatabaseIcon :db-type="connectionIconType(connection)" class="h-4 w-4" />
                      <span class="h-5 w-1 rounded-full shrink-0" :style="{ backgroundColor: connection.color || '#9ca3af' }" />
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm font-medium">{{ connection.name }}</div>
                        <div class="truncate text-xs text-muted-foreground">
                          {{ connectionOptionSubtitle(connection) || connectionDriverLabel(connection) }}
                        </div>
                      </div>
                      <FilePlus2 class="h-4 w-4 text-muted-foreground" />
                    </button>
                    <div v-if="recentConnections.length === 0" class="px-4 py-8 text-sm text-muted-foreground">
                      {{ t('sidebar.noConnections') }}
                    </div>
                  </div>
                </div>

                <div class="rounded-lg border">
                  <div class="border-b px-4 py-3">
                    <div class="text-sm font-medium">{{ t('welcome.shortcuts') }}</div>
                  </div>
                  <div class="grid gap-1 p-2">
                    <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="showConnectionDialog = true">
                      <Plus class="h-4 w-4" /> {{ t('toolbar.newConnection') }}
                    </button>
                    <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" :disabled="!connectionStore.connections.length" @click="newQuery">
                      <FilePlus2 class="h-4 w-4" /> {{ t('toolbar.newQuery') }}
                    </button>
                    <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="showHistory = true">
                      <History class="h-4 w-4" /> {{ t('history.title') }}
                    </button>
                    <button class="flex items-center gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-muted/50" @click="onImportClick">
                      <Upload class="h-4 w-4" /> {{ t('sidebar.import') }}
                    </button>
                    <div class="mt-2 rounded-md bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">
                      <Search class="mr-1 inline h-3.5 w-3.5" />
                      {{ t('welcome.tip') }}
                    </div>
                  </div>
                </div>
              </div>

              <!-- MCP Integration Hint -->
              <div class="rounded-lg border bg-muted/10 px-5 py-4">
                <div class="flex items-start gap-3">
                  <Sparkles class="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div class="min-w-0">
                    <div class="text-sm font-medium">{{ t('welcome.mcpTitle') }}</div>
                    <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t('welcome.mcpDescription') }}</p>
                    <div class="mt-2 flex items-center gap-2">
                      <code class="rounded bg-muted px-2 py-0.5 text-[11px] select-all">npx @dbx-app/mcp-server</code>
                      <a href="#" class="text-xs text-primary hover:underline" @click.prevent="openMcpGuide">{{ t('welcome.mcpLearnMore') }}</a>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Project Info -->
              <div class="mt-2 flex items-center justify-center gap-3 text-[11px] text-muted-foreground/60">
                <span>DBX {{ appVersion ? 'v' + appVersion : '' }}</span>
                <span>·</span>
                <a href="#" class="hover:text-foreground transition-colors" @click.prevent="openGitHub">GitHub</a>
              </div>
            </div>
          </div>
        <div v-if="showAiPanel" class="h-full shrink-0 relative bg-background" :style="{ width: aiPanelWidth + 'px' }">
          <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startAiPanelResize" />
          <div class="h-full min-h-0 overflow-hidden">
            <AiAssistant ref="aiAssistantRef" :tab="activeTab" :connection="activeConnection"
              @replace-sql="onAiReplaceSql"
              @execute-sql="onAiExecuteSql" @close="toggleAiPanel"
            />
          </div>
        </div>

        <div v-if="showHistory" class="h-full shrink-0 relative bg-background" :style="{ width: historyWidth + 'px' }">
          <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startHistoryResize" />
          <QueryHistory @restore="(sql: string) => { if (queryStore.activeTabId) queryStore.updateSql(queryStore.activeTabId, sql) }" @close="showHistory = false" />
        </div>
      </div>

      <AppDialogs
        :show-connection-dialog="showConnectionDialog" :show-settings-dialog="showSettingsDialog"
        :show-danger-dialog="showDangerDialog" :danger-sql="dangerSql"
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
        v-model:open="showUpdateDialog" :update-info="updateInfo" :update-check-message="updateCheckMessage"
        :is-downloading-update="isDownloadingUpdate" :download-progress="downloadProgress" :update-ready="updateReady"
        @open-latest-release="openLatestRelease" @download-and-install="downloadAndInstallUpdate" @restart="restartApp"
      />

      <Transition name="toast">
        <div v-if="toastVisible" class="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-foreground text-background text-sm shadow-lg">
          {{ toastMessage }}
        </div>
      </Transition>
    </div>
  </TooltipProvider>
</template>

<style scoped>
.toast-enter-active, .toast-leave-active { transition: all 0.25s ease; }
.toast-enter-from, .toast-leave-to { opacity: 0; transform: translate(-50%, 8px); }
</style>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted, nextTick, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import { ChevronsRight } from "@lucide/vue";
import { TooltipProvider } from "@/components/ui/tooltip";
import AppToolbar from "@/components/layout/AppToolbar.vue";
import AppTabBar from "@/components/layout/AppTabBar.vue";
import AppSidebar from "@/components/layout/AppSidebar.vue";
import EditorToolbar from "@/components/layout/EditorToolbar.vue";
import ContentArea from "@/components/layout/ContentArea.vue";
import AppDialogs from "@/components/layout/AppDialogs.vue";
import WelcomeScreen from "@/components/layout/WelcomeScreen.vue";
import type { ConfigTab } from "@/components/connection/ConnectionDialog.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { enforceRightSidebarPanelExclusivity, RIGHT_SIDEBAR_PANEL_IDS, transitionRightSidebarPanels, useSettingsStore, type RightSidebarPanelId, type RightSidebarPanelState } from "@/stores/settingsStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { usePromptTemplateStore } from "@/stores/promptTemplateStore";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useAppUpdater } from "@/composables/useAppUpdater";
import { useExportTracker } from "@/composables/useExportTracker";
import { useFileDrop } from "@/composables/useFileDrop";
import { usePanelResize } from "@/composables/usePanelResize";
import { useDatabaseOptions } from "@/composables/useDatabaseOptions";
import { useSqlExecution } from "@/composables/useSqlExecution";
import { useDialogSources } from "@/composables/useDialogSources";
import { useNavigationTargets } from "@/composables/useNavigationTargets";
import { useDataGridActions } from "@/composables/useDataGridActions";
import { useTauriEvents } from "@/composables/useTauriEvents";
import { useCloseActionPrompt, type AppCloseAction, type AppCloseRequestOptions } from "@/composables/useCloseActionPrompt";
import { useVisibilityChange } from "@/composables/useVisibilityChange";
import { useWebDavAutoUpload } from "@/composables/useWebDavAutoUpload";
import { useScheduledDatabaseBackups } from "@/composables/useScheduledDatabaseBackups";
import { shouldDrawDesktopWindowFrame } from "@/composables/useWindowControls";
import { useSaveSqlFolderSelection } from "@/composables/useSaveSqlFolderSelection";
import "@/i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import * as api from "@/lib/backend/api";
import { connectionRedactedNameLabel } from "@/lib/connection/connectionPresentation";
import { quickConnectionOpenTarget } from "@/lib/connection/connectionOpenTarget";
import { resolveDefaultDatabase } from "@/lib/database/defaultDatabase";
import { findTreeNodeById, resolveNewQueryTarget, resolveNewQueryInitialSql } from "@/lib/sql/newQueryContext";
import { sqlObjectNavigationSourceKind, sqlObjectNavigationTableType, type SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import { buildExecutableObjectSourceStatements, executeObjectSourceSave } from "@/lib/table/objectSourceEditor";
import { resolveExecutableSql, resolveExecutableSqlWithBackend, type SqlExecutionSnapshot } from "@/lib/sql/sqlExecutionTarget";
import { uuid } from "@/lib/common/utils";
import { isMacOS, isWindows } from "@/lib/backend/platform";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { openQueryResultArchiveFile } from "@/lib/query/queryResultArchiveFile";
import { sqlFileTitleFromPath } from "@/lib/sql/sqlFileOpen";
import type { ConnectionConfig, ObjectSourceKind, QueryTab } from "@/types/database";
import { parseConnectionDeepLink, type ConnectionDeepLinkDraft } from "@/lib/connection/connectionDeepLink";
import {
  isBrowserReloadShortcut,
  isCloseOtherTabsShortcut,
  isCloseTabShortcut,
  isExecuteSqlShortcut,
  isFocusSearchShortcut,
  isModRShortcut,
  isNewQueryShortcut,
  isObjectSourceSaveShortcutTarget,
  isOpenSettingsShortcut,
  isQuickOpenShortcut,
  isResetZoomShortcut,
  isRefreshDataShortcut,
  isSaveShortcut,
  isSendSelectionToAiShortcut,
  isSwitchToNextTabShortcut,
  isSwitchToPreviousTabShortcut,
  isToggleSidebarShortcut,
  isZoomInShortcut,
  isZoomOutShortcut,
  switchToTabIndexFromShortcut,
} from "@/lib/editor/keyboardShortcuts";
import { isPreviewTab } from "@/lib/tabs/tabPresentation";
import { supportsSqlFileExecution } from "@/lib/database/databaseCapabilities";
import { classifyAiSqlExecution } from "@/lib/ai/aiSqlExecutionPolicy";
import { buildAppendedEditorSql } from "@/lib/ai/aiSqlAppend";
import { assessProductionSql } from "@/lib/database/productionSafety";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { buildHistoryAiAnalysisPrompt } from "@/lib/history/historyAiAnalysis";
import { countAvailableAgentDriverUpdates, type AgentDriverUpdateBadgeState } from "@/lib/connection/agentDriverUpdateBadge";
import type { DriverStoreFocus } from "@/lib/connection/agentDriverInstallHint";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { apiUrl, webPath } from "@/lib/common/webPath";
import { APP_FONT_SANS_CSS_VAR, DATA_GRID_FONT_FAMILY_CSS_VAR, DEFAULT_DATA_GRID_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY } from "@/lib/app/appFonts";
import { rankSavedSqlHistory } from "@/lib/savedSql/savedSqlHistory";
import { countActiveUpdateBlockingTasks } from "@/lib/app/appUpdateTaskGuard";
import { initSavedSqlEditorPositions } from "@/lib/app/savedSqlEditorPosition";
import { isSchemaAware, isSingleDatabase, usesTreeSchemaMode } from "@/lib/database/databaseFeatureSupport";
import { codeMirrorSqlDialect, connectionUsesDatabaseObjectTreeMode, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { sqlFormatDialectForDbType } from "@/lib/sql/sqlFormatter";
import { detectDatabaseFileType } from "@/lib/database/databaseFileDetection";
import { ensureJdbcxRuntimeDrivers } from "@/lib/database/jdbcxBuiltinDriver";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { HistoryEntry } from "@/lib/backend/tauri";
import type { AiAction } from "@/lib/ai/ai";

const AiAssistant = defineAsyncComponent(() => import("@/components/editor/AiAssistant.vue"));
const QueryHistory = defineAsyncComponent(() => import("@/components/editor/QueryHistory.vue"));
const SqlLibraryPanel = defineAsyncComponent(() => import("@/components/layout/SqlLibraryPanel.vue"));
const SqlFilePanel = defineAsyncComponent(() => import("@/components/layout/SqlFilePanel.vue"));
const DriverStorePage = defineAsyncComponent(() => import("@/components/config/DriverStoreDialog.vue"));
const EditorSettingsPage = defineAsyncComponent(() => import("@/components/editor/EditorSettingsDialog.vue"));
const UpdateDialog = defineAsyncComponent(() => import("@/components/layout/UpdateDialog.vue"));
const CloseActionPromptDialog = defineAsyncComponent(() => import("@/components/layout/CloseActionPromptDialog.vue"));
const LoginPage = defineAsyncComponent(() => import("@/components/auth/LoginPage.vue"));
const QuickOpenDialog = defineAsyncComponent(() => import("@/components/quick-open/QuickOpenDialog.vue"));
const QueryEditorDdlViewDialog = defineAsyncComponent(() => import("@/components/objects/DdlViewDialog.vue"));
const QueryEditorObjectSourceDialog = defineAsyncComponent(() => import("@/components/objects/ObjectSourceDialog.vue"));

type AiAssistantHandle = {
  triggerAction: (action: AiAction, instruction?: string) => void;
  setPrompt: (text: string) => void;
};

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const savedSqlStore = useSavedSqlStore();
const promptTemplateStore = usePromptTemplateStore();
connectionStore.setBeforeConnectHandler((config) => ensureJdbcxRuntimeDrivers(config, api).then(() => undefined));
const { message: toastMessage, visible: toastVisible, toast } = useToast();
const { isDark, themeMode, applyTheme, setThemeMode } = useTheme();
const { activeCount: activeBackgroundTaskCount } = useExportTracker();
const trackedUpdateTaskCount = computed(() => countActiveUpdateBlockingTasks(activeBackgroundTaskCount.value, queryStore.tabs));
const {
  checkingUpdates,
  updateInfo,
  updateCheckMessage,
  showUpdateDialog,
  isDownloadingUpdate,
  downloadProgress,
  updateDownloaded,
  isInstallingUpdate,
  updateReady,
  activeTaskCount: activeUpdateTaskCount,
  hasUpdateAvailable,
  openUrl,
  checkUpdates,
  openLatestRelease,
  downloadAndInstallUpdate,
  installDownloadedUpdate,
  restartApp,
} = useAppUpdater({
  getActiveTaskCount: () => trackedUpdateTaskCount.value,
});
const { setupFileDrop } = useFileDrop();

const isDesktop = isTauriRuntime();
const drawDesktopWindowFrame = shouldDrawDesktopWindowFrame(isMacOS(), isDesktop, isWindows());
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let updateCheckTimer: ReturnType<typeof setInterval> | undefined;
const needsAuth = ref(!isDesktop);
const authenticated = ref(isDesktop);
const setupRequired = ref(false);

const showConnectionDialog = ref(false);
const connectionDialogPrefill = ref<ConnectionDeepLinkDraft | null>(null);
const connectionDialogInitialTab = ref<ConfigTab | undefined>(undefined);
const settingsPageTabOpen = ref(false);
const settingsInitialTab = ref("appearance");
const settingsInitialSection = ref<string | undefined>(undefined);
const showQueryEditorDdlDialog = ref(false);
const showQueryEditorObjectSourceDialog = ref(false);
const driverStoreTabOpen = ref(false);
const driverStoreActive = ref(false);
const driverStoreActiveTab = ref<"agent" | "jdbc" | "storage" | "runtime">("agent");
const settingsReturnSurface = ref<"query" | "driverStore" | "welcome">("welcome");
const showDriverStore = computed(() => driverStoreTabOpen.value && driverStoreActive.value);
const showSettingsPage = computed(() => settingsPageTabOpen.value && settingsStore.settingsPageActive);
const showQuickOpen = ref(false);
const agentDriverUpdateCount = ref(0);
const showHistory = ref(false);
const showAiPanel = ref(safeLocalStorageGet("dbx-ai-panel-open") === "true");
const showSqlLibraryPanel = ref(safeLocalStorageGet("dbx-sql-library-open") === "true");
const showSqlFilePanel = ref(safeLocalStorageGet("dbx-sql-file-panel-open") === "true");
const rightSidebarPanelRefs: Record<RightSidebarPanelId, typeof showAiPanel> = {
  ai: showAiPanel,
  history: showHistory,
  sqlLibrary: showSqlLibraryPanel,
  sqlFile: showSqlFilePanel,
};
const rightSidebarPanelStorageKeys: Partial<Record<RightSidebarPanelId, string>> = {
  ai: "dbx-ai-panel-open",
  sqlLibrary: "dbx-sql-library-open",
  sqlFile: "dbx-sql-file-panel-open",
};
let lastOpenedRightSidebarPanel = RIGHT_SIDEBAR_PANEL_IDS.find((panelId) => rightSidebarPanelRefs[panelId].value);
const sidebarOpen = ref(safeLocalStorageGet("dbx-sidebar-open") !== "false");
const aiPanelReady = ref(false);
const { sidebarWidth, aiPanelWidth, historyWidth, sqlLibraryWidth, sqlFilePanelWidth, startSidebarResize, startAiPanelResize, startHistoryResize, startSqlLibraryResize, startSqlFilePanelResize } = usePanelResize();
const aiAssistantRef = ref<AiAssistantHandle | null>(null);
const appSidebarRef = ref<InstanceType<typeof AppSidebar> | null>(null);
const appTabBarRef = ref<InstanceType<typeof AppTabBar> | null>(null);
const contentAreaRef = ref<InstanceType<typeof ContentArea> | null>(null);

const selectedSql = ref("");
const cursorPos = ref(0);
const formatSqlRequest = ref<{ id: number; tabId: string } | null>(null);
const compressSqlRequest = ref<{ id: number; tabId: string } | null>(null);
const activeOutputView = ref<"result" | "summary" | "explain" | "chart">("result");
const newQueryContextSource = ref<"tab" | "sidebar">("tab");
const queryEditorDdlTarget = ref<{ connectionId: string; database: string; catalog?: string; schema?: string; tableName: string; objectType?: ObjectSourceKind } | null>(null);
const queryEditorObjectSourceTarget = ref<{ connectionId: string; database: string; schema?: string; name: string; objectType: ObjectSourceKind; initialEditing: boolean } | null>(null);
const showSaveSqlDialog = ref(false);
const saveSqlName = ref("");
const ROOT_SAVED_SQL_FOLDER = "__root__";
const { selection: saveSqlFolderId, pending: saveSqlFolderCreationPending, reset: resetSaveSqlFolderSelection, invalidate: invalidateSaveSqlFolderSelection, select: selectSaveSqlFolder } = useSaveSqlFolderSelection(ROOT_SAVED_SQL_FOLDER);
const pendingSaveAndCloseTabId = ref<string | null>(null);
const pendingPrevActiveTabId = ref<string | null>(null);
const pendingSaveShouldCloseTab = ref(true);
const pendingAppCloseAction = ref<AppCloseAction | null>(null);
const pendingCloseActionChoice = ref(false);

const activeTab = computed(() => queryStore.tabs.find((t) => t.id === queryStore.activeTabId));

const activeConnection = computed(() => {
  const tab = activeTab.value;
  return tab ? connectionStore.getConfig(tab.connectionId) : undefined;
});

function updateAgentDriverUpdateCount(count: number) {
  if (!settingsStore.editorSettings.updateNotificationsEnabled) {
    agentDriverUpdateCount.value = 0;
    return;
  }
  agentDriverUpdateCount.value = count;
}

async function refreshAgentDriverUpdateCount() {
  if (!isDesktop || !settingsStore.editorSettings.updateNotificationsEnabled) return;
  try {
    const drivers = await invoke<AgentDriverUpdateBadgeState[]>("list_installed_agents");
    if (!settingsStore.editorSettings.updateNotificationsEnabled) return;
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

const blockDangerousRedisCommands = ref(true);
const databaseRequiredSignal = ref(0);
const databaseRequiredTabId = ref<string | null>(null);

function promptActiveDatabaseSelection() {
  const tab = activeTab.value;
  if (!tab) return;
  databaseRequiredTabId.value = tab.id;
  databaseRequiredSignal.value += 1;
  toast(t("editor.selectDatabaseRequired"), 2500);
}

const {
  dangerSql,
  pendingDangerSql,
  showDangerDialog,
  suppressDangerConfirm,
  tryExecute,
  doExecute,
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

function requestActiveEditorExecute() {
  if (contentAreaRef.value?.requestQueryEditorExecute?.()) return;
  void tryExecute();
}

const dialogs = useDialogSources();
const { getDatabaseOptions } = useDatabaseOptions();
const { openLineageTarget, openDatabaseSearchTarget, openDiagramTarget, onStructureEditorSaved, openTableTarget } = useNavigationTargets(dialogs);
const { onExecuteSql, onReloadData, onPaginate, onSort } = useDataGridActions(activeTab);
const { setupTauriListeners, cleanupTauriListeners } = useTauriEvents({
  openTableTarget,
  openSqlFilePath,
  openDbFilePath,
  openConnectionDeepLink,
});
const { showCloseActionPrompt, chooseQuit, chooseMinimize, cancelCloseActionPrompt, performCloseAction, setupCloseActionPromptListener, cleanupCloseActionPromptListener } = useCloseActionPrompt({ requestClose: requestAppClose });
useVisibilityChange();
useWebDavAutoUpload();
useScheduledDatabaseBackups({ scheduler: true });

const appVersion = ref("");
const isClassicLayout = computed(() => settingsStore.editorSettings.appLayout === "classic");
const updateNotificationsEnabled = computed(() => settingsStore.editorSettings.updateNotificationsEnabled);

function openSettings(initialTab = "appearance", initialSection?: string) {
  settingsInitialTab.value = initialTab;
  settingsInitialSection.value = initialSection;
  if (!settingsStore.settingsPageActive) {
    settingsReturnSurface.value = showDriverStore.value ? "driverStore" : activeTab.value ? "query" : "welcome";
  }
  activateSettingsPage();
}

watch(
  () => settingsStore.settingsNavigationRequest,
  (request) => {
    if (!request) return;
    openSettings(request.tab, request.section);
    settingsStore.clearSettingsNavigationRequest(request.id);
  },
);

function activateSettingsPage() {
  settingsPageTabOpen.value = true;
  settingsStore.settingsPageActive = true;
  driverStoreActive.value = false;
}

function closeSettingsPage() {
  settingsPageTabOpen.value = false;
  settingsStore.settingsPageActive = false;
  if (settingsReturnSurface.value === "driverStore" && driverStoreTabOpen.value) {
    driverStoreActive.value = true;
    return;
  }
  driverStoreActive.value = false;
}

const driverStoreFocus = ref<DriverStoreFocus | null>(null);

function openDriverStorePage(target?: "agent" | "jdbc" | "storage" | "runtime" | DriverStoreFocus | null) {
  if (typeof target === "string") {
    driverStoreActiveTab.value = target;
    driverStoreFocus.value = null;
  } else if (target && target.target === "tab") {
    driverStoreActiveTab.value = target.tab;
    driverStoreFocus.value = null;
  } else {
    driverStoreFocus.value = target ?? null;
  }
  driverStoreTabOpen.value = true;
  driverStoreActive.value = true;
  settingsStore.settingsPageActive = false;
}

function closeDriverStorePage() {
  driverStoreTabOpen.value = false;
  driverStoreActive.value = false;
  driverStoreActiveTab.value = "agent";
  driverStoreFocus.value = null;
}
const toolbarAgentDriverUpdateCount = computed(() => (updateNotificationsEnabled.value ? agentDriverUpdateCount.value : 0));
const toolbarHasUpdateAvailable = computed(() => updateNotificationsEnabled.value && hasUpdateAvailable.value);
const hasSqlFileConnections = computed(() => connectionStore.connections.some((c) => supportsSqlFileExecution(c.db_type)));
const queryEditorDdlDatabaseType = computed(() => {
  if (!queryEditorDdlTarget.value?.connectionId) return undefined;
  return effectiveDatabaseTypeForConnection(connectionStore.getConfig(queryEditorDdlTarget.value.connectionId));
});
const queryEditorDdlDialect = computed(() => {
  return codeMirrorSqlDialect(queryEditorDdlDatabaseType.value);
});
const queryEditorObjectSourceDatabaseType = computed(() => {
  if (!queryEditorObjectSourceTarget.value?.connectionId) return undefined;
  return effectiveDatabaseTypeForConnection(connectionStore.getConfig(queryEditorObjectSourceTarget.value.connectionId));
});
const queryEditorObjectSourceDialect = computed(() => codeMirrorSqlDialect(queryEditorObjectSourceDatabaseType.value));
const queryEditorObjectSourceFormatDialect = computed(() => sqlFormatDialectForDbType(queryEditorObjectSourceDatabaseType.value));
const connectionStats = computed(() => ({
  total: connectionStore.connections.length,
  connected: connectionStore.connectedIds.size,
  types: new Set(connectionStore.connections.map((c) => c.driver_profile || c.db_type)).size,
}));
const recentConnections = computed(() => connectionStore.connections.slice(0, 5));
const savedSqlHistoryItems = computed(() => {
  const folderById = new Map(savedSqlStore.allFolders.map((folder) => [folder.id, folder]));
  const folderPath = (folderId?: string): string | undefined => {
    if (!folderId) return undefined;
    const parts: string[] = [];
    const seen = new Set<string>();
    let folder = folderById.get(folderId);
    while (folder && !seen.has(folder.id)) {
      seen.add(folder.id);
      parts.unshift(folder.name);
      folder = folder.parentFolderId ? folderById.get(folder.parentFolderId) : undefined;
    }
    return parts.join("/");
  };
  return rankSavedSqlHistory(savedSqlStore.allFiles, { limit: 6 }).map((file) => {
    const connection = connectionStore.getConfig(file.connectionId);
    return {
      id: file.id,
      name: file.name,
      connectionName: connection ? connectionRedactedNameLabel(connection) : t("welcome.unknownConnection"),
      database: file.database,
      folderName: folderPath(file.folderId),
      openCount: file.openCount ?? 0,
    };
  });
});
const saveSqlFolders = computed(() => {
  const folderById = new Map(savedSqlStore.allFolders.map((folder) => [folder.id, folder]));
  const pathForFolder = (folderId: string) => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let folder = folderById.get(folderId);
    while (folder && !seen.has(folder.id)) {
      seen.add(folder.id);
      parts.unshift(folder.name);
      folder = folder.parentFolderId ? folderById.get(folder.parentFolderId) : undefined;
    }
    return parts.join(" / ");
  };
  return savedSqlStore.allFoldersTreeOrder.map((folder) => ({
    ...folder,
    displayName: pathForFolder(folder.id) || folder.name,
  }));
});

async function applyUiScale(scale: number) {
  if (!isDesktop) return;
  try {
    const { getCurrentWebview } = await import("@tauri-apps/api/webview");
    await getCurrentWebview().setZoom(scale);
    window.dispatchEvent(new CustomEvent("dbx:ui-scale-applied", { detail: { scale } }));
  } catch (error) {
    console.warn("[DBX] Failed to apply UI scale", { scale, error });
  }
}

function setGlobalUiScale(scale: number) {
  settingsStore.updateEditorSettings({ uiScale: scale });
}

function zoomInUi() {
  setGlobalUiScale(settingsStore.editorSettings.uiScale + 0.1);
}

function zoomOutUi() {
  setGlobalUiScale(settingsStore.editorSettings.uiScale - 0.1);
}

function resetUiZoom() {
  setGlobalUiScale(1);
}

function applyUiFontFamily(fontFamily: string) {
  if (typeof document === "undefined") return;
  const next = fontFamily || DEFAULT_UI_FONT_FAMILY;
  // Override Tailwind's shared sans variable so app chrome and existing UI classes stay in sync.
  document.documentElement.style.setProperty(APP_FONT_SANS_CSS_VAR, next);
  document.body.style.fontFamily = `var(${APP_FONT_SANS_CSS_VAR}, ${DEFAULT_UI_FONT_FAMILY})`;
}

function applyDataGridFontFamily(fontFamily: string) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(DATA_GRID_FONT_FAMILY_CSS_VAR, fontFamily || DEFAULT_DATA_GRID_FONT_FAMILY);
}

const appUiFontFamilyStyle = computed<Record<string, string>>(() => {
  const fontFamily = settingsStore.editorSettings.uiFontFamily || DEFAULT_UI_FONT_FAMILY;
  return {
    [APP_FONT_SANS_CSS_VAR]: fontFamily,
    fontFamily: `var(${APP_FONT_SANS_CSS_VAR}, ${DEFAULT_UI_FONT_FAMILY})`,
  };
});

function isGlobalUiZoomTarget(target: EventTarget | null): target is Element {
  if (!(target instanceof Element)) return false;
  if (target.closest("[data-query-editor-root], [data-cell-detail-editor-root], [data-object-source-editor]")) {
    return true;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) {
    return false;
  }
  return !target.closest("[contenteditable='true']");
}

watch(
  () => queryStore.activeTabId,
  (id, previousId) => {
    if (previousId && previousId !== id && typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("dbx:before-tab-switch", {
          detail: { tabId: id, fromTabId: previousId },
        }),
      );
    }
    if (id) newQueryContextSource.value = "tab";
    if (id && driverStoreActive.value) driverStoreActive.value = false;
    if (id && settingsStore.settingsPageActive) settingsStore.settingsPageActive = false;
    selectedSql.value = "";
    activeOutputView.value = "result";
    if (id) queryStore.reloadEvictedTab(id);
  },
);

watch(
  () => connectionStore.selectedTreeNodeId,
  (id) => {
    if (id) newQueryContextSource.value = "sidebar";
  },
);

watch(
  () => settingsStore.editorSettings.uiScale,
  (scale) => {
    void applyUiScale(scale);
  },
  { immediate: true },
);

watch(
  () => settingsStore.editorSettings.uiFontFamily,
  (fontFamily) => {
    applyUiFontFamily(fontFamily);
  },
  { immediate: true },
);

watch(
  () => settingsStore.editorSettings.tableFontFamily,
  (fontFamily) => {
    applyDataGridFontFamily(fontFamily);
  },
  { immediate: true },
);

watch(
  [() => settingsStore.isEditorSettingsLoaded, () => settingsStore.editorSettings.toolbarItems.exclusiveRightSidebarPanels],
  ([loaded, exclusive]) => {
    if (!loaded || !exclusive) return;
    // Compatibility: old persisted panel flags may contain multiple open panels.
    applyRightSidebarPanelState(enforceRightSidebarPanelExclusivity(currentRightSidebarPanelState(), lastOpenedRightSidebarPanel));
  },
  { immediate: true },
);

function currentRightSidebarPanelState(): RightSidebarPanelState {
  return Object.fromEntries(RIGHT_SIDEBAR_PANEL_IDS.map((panelId) => [panelId, rightSidebarPanelRefs[panelId].value])) as RightSidebarPanelState;
}

function applyRightSidebarPanelState(next: RightSidebarPanelState) {
  for (const panelId of RIGHT_SIDEBAR_PANEL_IDS) {
    const panelRef = rightSidebarPanelRefs[panelId];
    if (panelRef.value === next[panelId]) continue;
    panelRef.value = next[panelId];
    const storageKey = rightSidebarPanelStorageKeys[panelId];
    if (storageKey) safeLocalStorageSet(storageKey, String(next[panelId]));
  }
}

function setRightSidebarPanelOpen(panelId: RightSidebarPanelId, open: boolean) {
  const exclusive = settingsStore.isEditorSettingsLoaded && settingsStore.editorSettings.toolbarItems.exclusiveRightSidebarPanels;
  applyRightSidebarPanelState(transitionRightSidebarPanels(currentRightSidebarPanelState(), panelId, open, exclusive));
  if (open) {
    lastOpenedRightSidebarPanel = panelId;
  } else if (lastOpenedRightSidebarPanel === panelId) {
    lastOpenedRightSidebarPanel = RIGHT_SIDEBAR_PANEL_IDS.find((candidate) => rightSidebarPanelRefs[candidate].value);
  }
}

function toggleRightSidebarPanel(panelId: RightSidebarPanelId) {
  setRightSidebarPanelOpen(panelId, !rightSidebarPanelRefs[panelId].value);
}

function openRightSidebarPanel(panelId: RightSidebarPanelId) {
  setRightSidebarPanelOpen(panelId, true);
}

function closeRightSidebarPanel(panelId: RightSidebarPanelId) {
  setRightSidebarPanelOpen(panelId, false);
}

function invokeWhenAiReady(invoke: (handle: AiAssistantHandle) => void) {
  if (aiAssistantRef.value) {
    invoke(aiAssistantRef.value);
    return;
  }
  // AiAssistant 是异步组件，首次打开面板时单个 nextTick 不足以等待挂载完成，
  // 因此监听 ref，待其从 null 变为组件实例后再调用。
  const stop = watch(aiAssistantRef, (handle) => {
    if (handle) {
      stop();
      invoke(handle);
    }
  });
}

function fixWithAi(errorMessage: string) {
  openRightSidebarPanel("ai");
  invokeWhenAiReady((handle) => handle.triggerAction("fix", errorMessage));
}

function sendSelectionToAi(sql: string) {
  openRightSidebarPanel("ai");
  invokeWhenAiReady((handle) => handle.setPrompt(sql));
}

function openAiPanel() {
  openRightSidebarPanel("ai");
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
  invokeWhenAiReady((handle) => handle.triggerAction("explain", buildHistoryAiAnalysisPrompt(entry)));
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

function defaultSavedSqlName(title: string) {
  const trimmed = title.trim() || "query";
  const normalized = trimmed.replace(/\s+/g, "_");
  return normalized.endsWith(".sql") ? normalized : `${normalized}.sql`;
}

function canSaveSqlTab(tab: QueryTab): boolean {
  return !!tab.externalSqlPath || !!tab.sql.trim();
}

function closePendingSavedTab() {
  if (!pendingSaveAndCloseTabId.value) return;
  const closeId = pendingSaveAndCloseTabId.value;
  pendingSaveAndCloseTabId.value = null;
  if (pendingPrevActiveTabId.value) queryStore.activeTabId = pendingPrevActiveTabId.value;
  pendingPrevActiveTabId.value = null;
  const shouldCloseTab = pendingSaveShouldCloseTab.value;
  pendingSaveShouldCloseTab.value = true;
  if (shouldCloseTab) queryStore.closeTab(closeId, { force: true });
}

function cancelPendingSaveAndClose() {
  invalidateSaveSqlFolderSelection();
  showSaveSqlDialog.value = false;
  pendingSaveAndCloseTabId.value = null;
  pendingPrevActiveTabId.value = null;
  pendingSaveShouldCloseTab.value = true;
  cancelPendingAppClose();
}

function cancelPendingAppClose() {
  pendingAppCloseAction.value = null;
  pendingCloseActionChoice.value = false;
  pendingSaveShouldCloseTab.value = true;
}

function finishPendingAppClose(action: AppCloseAction) {
  if (pendingCloseActionChoice.value) {
    pendingCloseActionChoice.value = false;
    showCloseActionPrompt.value = true;
    return;
  }
  pendingAppCloseAction.value = null;
  pendingSaveShouldCloseTab.value = true;
  void queryStore
    .flushPendingPersist()
    .catch(() => {})
    .finally(() => performCloseAction(action));
}

function continuePendingAppCloseAfterSave() {
  const action = pendingAppCloseAction.value;
  if (!action) return;
  if (queryStore.hasDirtyTabs) {
    pendingSaveShouldCloseTab.value = false;
    if (queryStore.requestAppCloseConfirmation()) return;
  }
  finishPendingAppClose(action);
}

function requestAppClose(action: AppCloseAction, options: AppCloseRequestOptions = {}) {
  pendingCloseActionChoice.value = !!options.requireCloseActionChoice;
  if (queryStore.hasDirtyTabs) {
    pendingAppCloseAction.value = action;
    pendingSaveShouldCloseTab.value = false;
    if (queryStore.requestAppCloseConfirmation()) return;
  }
  finishPendingAppClose(action);
}

function completePendingTabSave(tabId: string) {
  if (pendingAppCloseAction.value) {
    continuePendingAppCloseAfterSave();
    return;
  }
  queryStore.closeTab(tabId, { force: true });
}

function handleDiscardPendingTabClose() {
  if (!pendingAppCloseAction.value) return;
  continuePendingAppCloseAfterSave();
}

function handleDiscardAllPendingTabClose() {
  if (!pendingAppCloseAction.value) return;
  continuePendingAppCloseAfterSave();
}

function handleCloseActionPromptOpenChange(open: boolean) {
  showCloseActionPrompt.value = open;
  if (!open) {
    cancelCloseActionPrompt();
    cancelPendingAppClose();
  }
}

async function saveExternalSqlPath(tab: QueryTab, options: { closeAfterSave?: boolean } = {}): Promise<boolean> {
  if (!tab.externalSqlPath || !isTauriRuntime()) return false;
  try {
    await api.writeExternalSqlFile(tab.externalSqlPath, tab.sql);
    queryStore.markTabClean(tab);
    toast(t("savedSql.saved"), 2000);
    if (options.closeAfterSave) queryStore.closeTab(tab.id, { force: true });
    return true;
  } catch (e: any) {
    toast(t("toolbar.sqlSaveFailed", { message: e?.message || String(e) }), 5000);
    return true;
  }
}

async function saveTabForCloseAll(tabId: string): Promise<boolean> {
  const tab = queryStore.tabs.find((t) => t.id === tabId);
  if (!tab) return true;
  queryStore.activeTabId = tabId;

  if (tab.mode === "structure") {
    await nextTick();
    return (await contentAreaRef.value?.applyTableStructureChanges?.()) === true;
  }
  if (!canSaveSqlTab(tab)) return true;

  if (tab.objectSource) return saveActiveObjectSource(tab);

  if (await saveExternalSqlPath(tab)) return !queryStore.isTabDirty(tab);

  const existing = tab.savedSqlId ? savedSqlStore.getFile(tab.savedSqlId) : undefined;
  try {
    const saved = await savedSqlStore.saveFile({
      id: existing?.id,
      connectionId: tab.connectionId,
      folderId: existing?.folderId,
      name: existing?.name || defaultSavedSqlName(tab.title),
      database: tab.database,
      schema: tab.schema,
      sql: tab.sql,
    });
    queryStore.linkSavedSql(tab.id, saved.id, saved.name);
    queryStore.markTabClean(tab);
    return true;
  } catch (e: any) {
    toast(t("savedSql.saveFailed", { message: e?.message || String(e) }), 5000);
    return false;
  }
}

async function handleSaveAllPendingTabClose() {
  const ids = [...queryStore.closeConfirmDirtyTabIds];
  if (!ids.length) return;
  queryStore.suspendCloseConfirm();

  for (const id of ids) {
    const saved = await saveTabForCloseAll(id);
    if (!saved) break;
  }

  if (queryStore.closeConfirmDirtyTabIds.length > 0) {
    queryStore.resumeCloseConfirm();
    return;
  }

  const result = queryStore.completePendingCloseAfterSaveAll();
  if (result === "app") continuePendingAppCloseAfterSave();
}

async function handleSaveTab(tabId: string) {
  const tab = queryStore.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  if (tab.mode === "structure") {
    queryStore.activeTabId = tabId;
    await nextTick();
    if (await contentAreaRef.value?.applyTableStructureChanges?.()) {
      completePendingTabSave(tabId);
    } else {
      queryStore.resumeCloseConfirm();
    }
    return;
  }
  if (!canSaveSqlTab(tab)) return;
  const closeAfterSave = pendingAppCloseAction.value === null;
  pendingSaveShouldCloseTab.value = closeAfterSave;
  if (tab.objectSource) {
    const saved = await saveActiveObjectSource(tab);
    if (saved) completePendingTabSave(tabId);
    else if (pendingAppCloseAction.value) cancelPendingAppClose();
    return;
  }
  if (await saveExternalSqlPath(tab, { closeAfterSave })) {
    if (!closeAfterSave) continuePendingAppCloseAfterSave();
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
    queryStore.markTabClean(tab);
    toast(t("savedSql.saved"), 2000);
    completePendingTabSave(tabId);
    return;
  }
  // No existing saved SQL — open save dialog, then close after save
  const prevActive = queryStore.activeTabId;
  queryStore.activeTabId = tabId;
  saveSqlName.value = defaultSavedSqlName(tab.title);
  resetSaveSqlFolderSelection(ROOT_SAVED_SQL_FOLDER);
  pendingSaveAndCloseTabId.value = tabId;
  pendingPrevActiveTabId.value = prevActive;
  showSaveSqlDialog.value = true;
}

async function openSaveSqlDialog() {
  const tab = activeTab.value;
  if (!tab || !canSaveSqlTab(tab)) return;
  if (tab.objectSource) {
    await saveActiveObjectSource(tab);
    return;
  }
  if (await saveExternalSqlPath(tab)) return;
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
    queryStore.markTabClean(tab);
    toast(t("savedSql.saved"), 2000);
    return;
  }

  saveSqlName.value = defaultSavedSqlName(tab.title);
  resetSaveSqlFolderSelection(ROOT_SAVED_SQL_FOLDER);
  showSaveSqlDialog.value = true;
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
    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");
    if (executableSql.trim()) {
      const saved = await executeWithProductionSqlGuard({
        connection,
        database: tab.database,
        sql: executableSql,
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
  } catch (e: any) {
    toast(t("objects.sourceSaveFailed", { message: e?.message || String(e) }), 5000);
    return false;
  }
}

function saveSqlFolderDisplayName(id: string) {
  if (id === ROOT_SAVED_SQL_FOLDER) return t("savedSql.rootFolder");
  const folder = saveSqlFolders.value.find((f) => f.id === id);
  return folder?.displayName ?? id;
}

function saveSqlFolderNormalizeCustom(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  const folder = saveSqlFolders.value.find((f) => f.displayName === trimmed);
  return folder ? folder.id : trimmed;
}

async function handleSaveSqlFolderSelect(value: string) {
  const isExisting = value === ROOT_SAVED_SQL_FOLDER || saveSqlFolders.value.some((f) => f.id === value);
  if (isExisting) {
    await selectSaveSqlFolder(value);
    return;
  }
  const tab = activeTab.value;
  if (!tab) return;
  await selectSaveSqlFolder(
    value,
    async () => (await savedSqlStore.createFolder(tab.connectionId, value)).id,
    (error: any) => toast(t("savedSql.createFolderFailed", { message: error?.message || String(error) }), 5000),
  );
}

async function confirmSaveSqlToLibrary() {
  if (saveSqlFolderCreationPending.value) return;
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
    queryStore.markTabClean(tab);
    showSaveSqlDialog.value = false;
    closePendingSavedTab();
    toast(t("savedSql.saved"), 2000);
  } catch (e: any) {
    toast(t("savedSql.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function saveActiveSqlAsLocalFile() {
  const tab = activeTab.value;
  if (!tab || !canSaveSqlTab(tab) || !isTauriRuntime()) return;
  try {
    const path = await api.saveExternalSqlFile(defaultSavedSqlName(tab.title), tab.sql);
    if (!path) return;
    queryStore.linkExternalSqlPath(tab.id, path, sqlFileTitleFromPath(path));
    invalidateSaveSqlFolderSelection();
    showSaveSqlDialog.value = false;
    closePendingSavedTab();
    toast(t("savedSql.saved"), 2000);
  } catch (e: any) {
    toast(t("toolbar.sqlSaveFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function openSqlFile() {
  const tab = activeTab.value;
  if (!tab) return;
  try {
    if (isTauriRuntime()) {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        filters: [{ name: "SQL", extensions: ["sql"] }],
        multiple: false,
      });
      if (path) {
        const sqlPath = path as string;
        const content = await api.readExternalSqlFile(sqlPath);
        queryStore.updateSql(tab.id, content);
        queryStore.linkExternalSqlPath(tab.id, sqlPath, sqlFileTitleFromPath(sqlPath));
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

async function importResultArchive() {
  try {
    const bytes = await openQueryResultArchiveFile();
    if (!bytes) return;
    const tabId = await queryStore.importResultArchive(bytes);
    if (!tabId) {
      toast(t("tabs.resultArchiveImportInvalid"), 5000);
      return;
    }
    activeOutputView.value = "result";
    toast(t("tabs.resultArchiveImported"), 2500);
  } catch (e: any) {
    toast(t("tabs.resultArchiveImportFailed", { message: e?.message || String(e) }), 5000);
  }
}

function pasteClipboardAsSqlInCondition() {
  void contentAreaRef.value?.pasteClipboardAsSqlInCondition?.();
}

async function openSqlFilePath(path: string) {
  if (!isTauriRuntime()) return;
  try {
    const content = await api.readExternalSqlFile(path);
    const connectionId = connectionStore.activeConnectionId || activeTab.value?.connectionId || connectionStore.connections[0]?.id || "";
    const connection = connectionId ? connectionStore.getConfig(connectionId) : undefined;
    const database = activeTab.value?.database || (connection ? resolveDefaultDatabase(connection, []) : "");
    queryStore.openExternalSqlFile(connectionId, database, path, content);
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

async function openDbFilePath(path: string) {
  if (!isTauriRuntime()) return;
  await connectionStore.initFromDisk();
  try {
    const name = path.split("/").pop()?.split("\\").pop() || path;
    const dbType = await detectDatabaseFileType(path);
    if (!dbType) return;

    // Check for existing connection with the same file path
    const existing = connectionStore.connections.find((c) => c.host === path);
    if (existing) {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      const switchTo = await ask(`A connection to "${path}" already exists. Switch to it?`, {
        title: "Database Already Open",
        kind: "info",
      });
      if (switchTo) {
        connectionStore.activeConnectionId = existing.id;
        connectionStore.ensureConnected(existing.id).catch(() => {});
        const node = connectionStore.treeNodes.find((n) => n.id === existing.id);
        if (node && !node.isExpanded) {
          connectionStore.loadDatabases(existing.id);
        }
      }
      return;
    }

    const config: ConnectionConfig = {
      id: uuid(),
      name,
      db_type: dbType,
      driver_profile: dbType,
      driver_label: dbType === "duckdb" ? "DuckDB" : "SQLite",
      url_params: "",
      host: path,
      port: 0,
      username: "",
      password: "",
    };
    await connectionStore.addConnection(config);
    void connectionStore.connect(config);
    toast(t("welcome.fileOpened", { name }));
  } catch (e: any) {
    toast(t("toolbar.sqlOpenFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function openPendingDbFiles() {
  if (!isTauriRuntime()) return;
  try {
    const paths = await api.pendingOpenDbFiles();
    for (const path of paths) {
      await openDbFilePath(path);
    }
  } catch {
    /* ignore startup file-open probing errors */
  }
}

async function openConnectionDeepLink(url: string) {
  await connectionStore.initFromDisk();
  try {
    const draft = parseConnectionDeepLink(url);
    if (!draft) return;
    connectionStore.stopEditing();
    connectionStore.stopCreatingConnectionInGroup();
    connectionDialogPrefill.value = draft;
    showConnectionDialog.value = true;
  } catch (e: any) {
    toast(
      t("connection.parseConnectionUrlFailed", {
        message: e?.message || String(e),
      }),
      5000,
    );
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
  if (!value) {
    connectionDialogPrefill.value = null;
    connectionDialogInitialTab.value = undefined;
  }
}

function openConnectionSettings(connectionId: string, initialTab: ConfigTab = "connection") {
  if (!connectionStore.getConfig(connectionId)) return;
  connectionDialogInitialTab.value = initialTab;
  connectionStore.startEditing(connectionId);
  showConnectionDialog.value = true;
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
  const connectionTarget = quickConnectionOpenTarget(conn);
  if (connectionTarget.kind !== "query") {
    try {
      await connectionStore.ensureConnected(target.connectionId);
      if (connectionTarget.kind === "mq-admin") {
        queryStore.openMqAdmin(target.connectionId);
      } else if (connectionTarget.kind === "nacos-admin") {
        await connectionStore.loadNacosNamespaces(target.connectionId);
        queryStore.openNacosAdmin(target.connectionId);
      } else {
        queryStore.createTab(target.connectionId, "", `${conn.name}:keys`, connectionTarget.kind);
      }
    } catch (e: any) {
      toast(
        t("connection.connectFailed", {
          message: translateBackendError(t, e?.message || String(e)),
        }),
        5000,
      );
    }
    return;
  }
  // Prefill the editor with `SELECT * FROM <focused table>` when enabled and a
  // table context (active data/structure tab or selected table node) is available.
  // Built before createTab so the tab opens with the content directly (no flash).
  const initialSql = resolveNewQueryInitialSql({
    activeTab: activeTab.value,
    selectedTreeNode: findTreeNodeById(connectionStore.treeNodes, connectionStore.selectedTreeNodeId),
    preferredSource: newQueryContextSource.value,
    prefillEnabled: settingsStore.editorSettings.prefillNewQueryWithSelect,
    targetConnectionId: target.connectionId,
    targetDatabase: target.database,
    databaseType: effectiveDatabaseTypeForConnection(conn),
  });
  const tabId = queryStore.createTab(conn.id, target.database, undefined, "query", target.schema, initialSql, target.catalog);
  try {
    await connectionStore.ensureConnected(target.connectionId);
    if (target.shouldRefreshDefaultDatabase) {
      const options = await getDatabaseOptions(target.connectionId);
      queryStore.updateDatabase(tabId, resolveDefaultDatabase(conn, options));
    }
  } catch (e: any) {
    toast(
      t("connection.connectFailed", {
        message: translateBackendError(t, e?.message || String(e)),
      }),
      5000,
    );
  }
}

async function openConnectionQuery(connectionId: string) {
  const connection = connectionStore.getConfig(connectionId);
  if (!connection) return;
  connectionStore.activeConnectionId = connectionId;
  const initialTarget = quickConnectionOpenTarget(connection);
  if (initialTarget.kind === "mq-admin") {
    queryStore.openMqAdmin(connectionId);
    return;
  }
  if (initialTarget.kind === "nacos-admin") {
    try {
      await connectionStore.ensureConnected(connectionId);
      await connectionStore.loadNacosNamespaces(connectionId);
    } catch (e: any) {
      toast(
        t("connection.connectFailed", {
          message: translateBackendError(t, e?.message || String(e)),
        }),
        5000,
      );
    }
    return;
  }
  if (initialTarget.kind === "etcd" || initialTarget.kind === "zookeeper") {
    try {
      await connectionStore.ensureConnected(connectionId);
      queryStore.createTab(connectionId, "", `${connection.name}:keys`, initialTarget.kind);
    } catch (e: any) {
      toast(
        t("connection.connectFailed", {
          message: translateBackendError(t, e?.message || String(e)),
        }),
        5000,
      );
    }
    return;
  }
  const tabId = queryStore.createTab(connectionId, initialTarget.database);
  try {
    await connectionStore.ensureConnected(connectionId);
    const options = await getDatabaseOptions(connectionId);
    const target = quickConnectionOpenTarget(connection, options);
    if (target.kind === "query") {
      queryStore.updateDatabase(tabId, target.database);
    }
  } catch (e: any) {
    toast(
      t("connection.connectFailed", {
        message: translateBackendError(t, e?.message || String(e)),
      }),
      5000,
    );
  }
}

async function openSavedSqlFromWelcome(fileId: string) {
  const file = await savedSqlStore.ensureFileContent(fileId);
  if (!file) return;
  queryStore.openSavedSql(file);
  connectionStore.activeConnectionId = file.connectionId;
  void savedSqlStore.recordFileUsage(file.id);
  toast(t("welcome.fileOpened", { name: file.name }), 2000);
}

function tableTargetFromActiveTab(table: string | SqlObjectNavigationTarget) {
  const tab = activeTab.value;
  if (!tab) return null;
  const connectionId = tab.connectionId;
  const catalog = tab.tableMeta?.catalog || tab.catalog;
  if (typeof table !== "string") {
    // Structured targets already separate qualifiers; reparsing would corrupt quoted object names that contain dots.
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
  const tableName = table;

  const parts = tableName.split(".").filter(Boolean);
  const rawTableName = parts[parts.length - 1] || tableName;
  if (parts.length >= 3) {
    database = parts[parts.length - 3] || database;
    schema = parts[parts.length - 2];
  } else if (parts.length === 2) {
    const dbType = connectionStore.getConfig(connectionId)?.db_type;
    if (dbType && !isSchemaAware(dbType) && !isSingleDatabase(dbType)) {
      database = parts[0] || database;
      schema = undefined;
    } else {
      schema = parts[0];
    }
  }

  return { connectionId, database, catalog, schema, tableName: rawTableName, tableType: undefined };
}

async function onClickTable(table: SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  const objectType = sqlObjectNavigationSourceKind(table);
  if (objectType) {
    // Definition navigation for views must not run the view query, which may be expensive or have side effects upstream.
    queryEditorDdlTarget.value = { ...target, objectType };
    showQueryEditorDdlDialog.value = true;
    return;
  }
  try {
    await openTableTarget(target, { tableInfoTab: "ddl" });
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

async function onViewTableData(table: SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  try {
    await openTableTarget(target);
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function onViewTableDdl(table: SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  if (!target) return;
  queryEditorDdlTarget.value = { ...target, objectType: sqlObjectNavigationSourceKind(table) };
  showQueryEditorDdlDialog.value = true;
}

function onEditTableStructure(table: SqlObjectNavigationTarget) {
  const target = tableTargetFromActiveTab(table);
  // Keep view-like objects out of the table editor even if a stale menu dispatches this event.
  if (!target || sqlObjectNavigationSourceKind(table)) return;
  queryStore.openTableStructure(target.connectionId, target.database, target.schema, target.tableName, undefined, undefined, target.catalog);
}

async function onOpenObjectSource(table: SqlObjectNavigationTarget, initialEditing: boolean) {
  const target = tableTargetFromActiveTab(table);
  const objectType = sqlObjectNavigationSourceKind(table);
  if (!target || !objectType) return;
  try {
    await connectionStore.ensureConnected(target.connectionId);
    connectionStore.activeConnectionId = target.connectionId;
    queryEditorObjectSourceTarget.value = { connectionId: target.connectionId, database: target.database, schema: target.schema, name: target.tableName, objectType, initialEditing };
    showQueryEditorObjectSourceDialog.value = true;
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function onQueryEditorObjectSourceSaved() {
  const target = queryEditorObjectSourceTarget.value;
  if (!target) return;
  connectionStore.invalidateCompletionCache(target.connectionId, target.database);
  contentAreaRef.value?.refreshQueryEditorCompletionCache();
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
    toast(
      t("connection.connectFailed", {
        message: translateBackendError(t, e?.message || String(e)),
      }),
      5000,
    );
  }
}

function changeActiveDatabase(database: string) {
  const tab = activeTab.value;
  if (tab) {
    queryStore.updateDatabase(tab.id, database);
    if (databaseRequiredTabId.value === tab.id && database) {
      databaseRequiredTabId.value = null;
    }
  }
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
  openUrl("https://dbxio.com/cn/docs/mcp");
}

function setSidebarOpen(open: boolean) {
  sidebarOpen.value = open;
  safeLocalStorageSet("dbx-sidebar-open", open ? "true" : "false");
}

function ensureQueryTab(): string {
  const tab = activeTab.value;
  if (tab && tab.mode === "query") return tab.id;
  const connId = connectionStore.activeConnectionId || connectionStore.connections[0]?.id || "";
  const db = tab?.connectionId === connId ? tab.database : connectionStore.getConfig(connId)?.database || "";
  return queryStore.createTab(connId, db, undefined, "query");
}

function routeAiRedisCommand(command: string, execute: boolean): boolean {
  if (activeConnection.value?.db_type !== "redis") return false;

  // Redis has a dedicated console. Falling through to ensureQueryTab() would
  // recreate the original bug by opening a SQL tab for a Redis command.
  const routed = execute ? contentAreaRef.value?.executeRedisCommand(command) : contentAreaRef.value?.insertRedisCommand(command);
  if (!routed) {
    console.warn("[DBX] Redis AI command could not reach the active Redis console");
    return true;
  }
  void routed.then((handled) => {
    if (!handled) console.warn("[DBX] Redis AI command could not reach the active Redis console");
  });
  return true;
}

function onAiReplaceSql(sql: string) {
  if (routeAiRedisCommand(sql, false)) return;
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, sql);
}

function runAiGeneratedSql(sql: string) {
  selectedSql.value = "";
  nextTick(() => tryExecute(sql));
}

function onAiExecuteSql(sql: string) {
  if (routeAiRedisCommand(sql, true)) return;
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, buildAppendedEditorSql(activeTab.value?.sql || "", sql));
  runAiGeneratedSql(sql);
}

function onAiTempRunSql(sql: string) {
  if (routeAiRedisCommand(sql, true)) return;
  ensureQueryTab();
  runAiGeneratedSql(sql);
}

function onAiRequestAutoExecuteSql(sql: string) {
  if (routeAiRedisCommand(sql, true)) return;
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, buildAppendedEditorSql(activeTab.value?.sql || "", sql));
  selectedSql.value = "";

  const productionAssessment = assessProductionSql(sql, activeConnection.value, activeTab.value?.database);
  if (productionAssessment.active && productionAssessment.isMutation) {
    toast(t("production.aiReviewRequired"), 5000);
    return;
  }

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

function onAiOpenExplainPlan(sql: string) {
  const tabId = ensureQueryTab();
  queryStore.updateSql(tabId, buildAppendedEditorSql(activeTab.value?.sql || "", sql));
  selectedSql.value = "";
  nextTick(() => {
    void tryExplain(sql);
  });
}

async function handleQuickOpenSelect(item: any) {
  const connectionStore = useConnectionStore();
  const queryStore = useQueryStore();

  // For all types, set the active connection
  connectionStore.activeConnectionId = item.connectionId;

  // Ensure connection is connected
  try {
    await connectionStore.ensureConnected(item.connectionId);
  } catch (error) {
    console.error("Failed to connect:", error);
    return;
  }

  // Navigate based on type
  if (item.type === "connection") {
    // Expand connection node in sidebar
    // Tree node ID for connection is just the connectionId
    const connNode = findTreeNodeById(connectionStore.treeNodes, item.connectionId);
    if (connNode && !connNode.isExpanded) {
      const config = connectionStore.getConfig(item.connectionId);
      if (config?.db_type === "redis") {
        await connectionStore.loadRedisDatabases(item.connectionId);
      } else if (config?.db_type === "etcd") {
        await connectionStore.loadEtcdRoot(item.connectionId);
      } else if (config?.db_type === "zookeeper") {
        await connectionStore.loadZooKeeperRoot(item.connectionId);
      } else if (config?.db_type === "mongodb") {
        await connectionStore.loadMongoDatabases(item.connectionId);
      } else if (config?.db_type === "elasticsearch") {
        await connectionStore.loadElasticsearchIndices(item.connectionId);
      } else if (config?.db_type === "qdrant" || config?.db_type === "milvus" || config?.db_type === "weaviate" || config?.db_type === "chromadb") {
        await connectionStore.loadVectorCollections(item.connectionId);
      } else if (config?.db_type === "mq") {
        await connectionStore.loadMqTenants(item.connectionId);
      } else {
        await connectionStore.loadDatabases(item.connectionId);
      }
    }
    return;
  } else if (item.type === "database") {
    // Expand connection node first
    // Tree node ID for connection is just the connectionId
    const connNode = findTreeNodeById(connectionStore.treeNodes, item.connectionId);
    if (connNode && !connNode.isExpanded) {
      const config = connectionStore.getConfig(item.connectionId);
      if (config?.db_type === "redis") {
        await connectionStore.loadRedisDatabases(item.connectionId);
      } else if (config?.db_type === "etcd") {
        await connectionStore.loadEtcdRoot(item.connectionId);
      } else if (config?.db_type === "zookeeper") {
        await connectionStore.loadZooKeeperRoot(item.connectionId);
      } else if (config?.db_type === "mongodb") {
        await connectionStore.loadMongoDatabases(item.connectionId);
      } else if (config?.db_type === "elasticsearch") {
        await connectionStore.loadElasticsearchIndices(item.connectionId);
      } else if (config?.db_type === "qdrant" || config?.db_type === "milvus" || config?.db_type === "weaviate" || config?.db_type === "chromadb") {
        await connectionStore.loadVectorCollections(item.connectionId);
      } else if (config?.db_type === "mq") {
        await connectionStore.loadMqTenants(item.connectionId);
      } else {
        await connectionStore.loadDatabases(item.connectionId);
      }
    }

    // Expand database node
    // Tree node ID for database is `${connectionId}:${database_name}`
    const dbNodeId = `${item.connectionId}:${item.database}`;
    const dbNode = findTreeNodeById(connectionStore.treeNodes, dbNodeId);
    if (dbNode && !dbNode.isExpanded) {
      const config = connectionStore.getConfig(item.connectionId);
      const effectiveDbType = effectiveDatabaseTypeForConnection(config);
      if (config?.db_type === "sqlserver") {
        await connectionStore.loadSqlServerDatabaseObjects(item.connectionId, item.database);
      } else if (usesTreeSchemaMode(effectiveDbType) && !connectionUsesDatabaseObjectTreeMode(config)) {
        await connectionStore.loadSchemas(item.connectionId, item.database);
      } else {
        await connectionStore.loadTables(item.connectionId, item.database);
      }
    }
    return;
  } else if (item.type === "schema") {
    const dbNode = findTreeNodeById(connectionStore.treeNodes, `${item.connectionId}:${item.database}`);
    if (dbNode && !dbNode.isExpanded) await connectionStore.loadSchemas(item.connectionId, item.database);
    const schemaNode = findTreeNodeById(connectionStore.treeNodes, `${item.connectionId}:${item.database}:${item.schema}`);
    if (schemaNode && !schemaNode.isExpanded) await connectionStore.loadTables(item.connectionId, item.database, item.schema);
    return;
  } else if (item.type === "table" || item.type === "view" || item.type === "materialized_view") {
    // Open the table/view in a data tab
    await openTableTarget({
      connectionId: item.connectionId,
      database: item.database,
      schema: item.schema,
      tableName: item.objectName || item.tableName,
      tableType: item.type === "view" ? "VIEW" : item.type === "materialized_view" ? "MATERIALIZED_VIEW" : "TABLE",
    });
  } else if (item.type === "procedure" || item.type === "function" || item.type === "trigger" || item.type === "sequence" || item.type === "package" || item.type === "package-body" || item.type === "type" || item.type === "type-body") {
    // Open the object source in a source tab
    const objectTypeMap: Record<string, ObjectSourceKind> = {
      procedure: "PROCEDURE",
      function: "FUNCTION",
      trigger: "TRIGGER",
      sequence: "SEQUENCE",
      package: "PACKAGE",
      "package-body": "PACKAGE_BODY",
      type: "TYPE",
      "type-body": "TYPE_BODY",
    };

    const objectType = objectTypeMap[item.type];
    if (!objectType) return;

    const schema = item.schema || item.database;
    try {
      const result = await api.getObjectSource(item.connectionId, item.database, schema, item.objectName || item.tableName, objectType, item.signature);
      const tabId = queryStore.createTab(item.connectionId, item.database, `Source - ${item.objectName || item.tableName}`);
      queryStore.updateSql(tabId, result.source);
      if (item.type !== "sequence" && item.type !== "trigger" && item.type !== "type" && item.type !== "type-body") {
        queryStore.setObjectSource(tabId, {
          schema,
          name: item.objectName || item.tableName,
          objectType,
          signature: item.signature,
        });
      }
      queryStore.markTabClean(queryStore.tabs.find((tab) => tab.id === tabId));
    } catch (error) {
      toast((error as any)?.message || String(error), 5000);
    }
  }
}

function dispatchBeforeTabSwitch(tabId: string) {
  if (tabId === queryStore.activeTabId) return;
  window.dispatchEvent(new CustomEvent("dbx:before-tab-switch", { detail: { tabId, fromTabId: queryStore.activeTabId } }));
}

function activateQueryTab(tabId: string): boolean {
  if (!queryStore.tabs.some((tab) => tab.id === tabId)) return false;
  dispatchBeforeTabSwitch(tabId);
  queryStore.activeTabId = tabId;
  driverStoreActive.value = false;
  settingsStore.settingsPageActive = false;
  return true;
}

function activateTabByIndex(index: number): boolean {
  const tab = queryStore.tabs[index];
  return tab ? activateQueryTab(tab.id) : false;
}

function activateAdjacentTab(direction: -1 | 1): boolean {
  const count = queryStore.tabs.length;
  if (count < 2) return false;
  const currentIndex = queryStore.tabs.findIndex((tab) => tab.id === queryStore.activeTabId);
  const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : count - 1) : (currentIndex + direction + count) % count;
  return activateTabByIndex(nextIndex);
}

function handleKeydown(e: KeyboardEvent) {
  if (e.defaultPrevented) return;

  const shortcuts = settingsStore.editorSettings.shortcuts;
  const switchTabIndex = switchToTabIndexFromShortcut(e, shortcuts);

  if (isOpenSettingsShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    openSettings();
    return;
  }
  if (isQuickOpenShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    showQuickOpen.value = true;
    return;
  }
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
  if (isToggleSidebarShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    setSidebarOpen(!sidebarOpen.value);
    return;
  }
  if (switchTabIndex != null) {
    if (activateTabByIndex(switchTabIndex)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (isSwitchToPreviousTabShortcut(e, shortcuts)) {
    if (activateAdjacentTab(-1)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (isSwitchToNextTabShortcut(e, shortcuts)) {
    if (activateAdjacentTab(1)) {
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (isCloseOtherTabsShortcut(e, shortcuts)) {
    e.preventDefault();
    e.stopPropagation();
    appTabBarRef.value?.closeOtherActiveTabs();
    return;
  }
  if (isCloseTabShortcut(e, shortcuts)) {
    e.preventDefault();
    if (showSettingsPage.value) {
      closeSettingsPage();
    } else if (showDriverStore.value) {
      closeDriverStorePage();
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
  if (activeTab.value?.mode === "query" && isExecuteSqlShortcut(e, shortcuts) && e.target instanceof Element && e.target.closest("[data-query-editor-root]")) {
    e.preventDefault();
    e.stopPropagation();
    requestActiveEditorExecute();
    return;
  }
  if (activeTab.value?.mode === "query" && isSendSelectionToAiShortcut(e, shortcuts) && e.target instanceof Element && e.target.closest("[data-query-editor-root]")) {
    e.preventDefault();
    e.stopPropagation();
    if (selectedSql.value.trim()) sendSelectionToAi(selectedSql.value);
    return;
  }
  if (isModRShortcut(e) && e.target instanceof Element && contentAreaRef.value?.handleModRTarget(e.target)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (isDesktop && isGlobalUiZoomTarget(e.target)) {
    if (isZoomInShortcut(e, shortcuts)) {
      e.preventDefault();
      e.stopPropagation();
      zoomInUi();
      return;
    }
    if (isZoomOutShortcut(e, shortcuts)) {
      e.preventDefault();
      e.stopPropagation();
      zoomOutUi();
      return;
    }
    if (isResetZoomShortcut(e, shortcuts)) {
      e.preventDefault();
      e.stopPropagation();
      resetUiZoom();
      return;
    }
  }
  if (isDesktop && isBrowserReloadShortcut(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}

function onLoginSuccess() {
  authenticated.value = true;
  setupRequired.value = false;
  needsAuth.value = true;
  window.history.replaceState(null, "", webPath("/"));
  void initApp();
}

async function initApp() {
  const t0 = performance.now();
  console.log("[STARTUP] initApp begin");
  await settingsStore.initAiConfigs();
  try {
    await settingsStore.initEditorSettings();
    console.log(`[STARTUP]   settingsStore.initEditorSettings: ${(performance.now() - t0).toFixed(0)}ms`);
    await queryStore.initOpenTabs();
    console.log(`[STARTUP]   queryStore.initOpenTabs: ${(performance.now() - t0).toFixed(0)}ms`);
    await settingsStore.initDesktopSettings().catch(() => {});

    void promptTemplateStore.init();

    void Promise.all([initSavedSqlEditorPositions(), savedSqlStore.initFromStorage()])
      .then(() => {
        console.log(`[STARTUP]   savedSqlStore.initFromStorage: ${(performance.now() - t0).toFixed(0)}ms`);
        void queryStore.hydrateSavedSqlTabs();
      })
      .catch((e: any) => {
        toast(t("connection.loadFailed", { message: e?.message || String(e) }), 5000);
      });

    await connectionStore.initFromDisk();
    console.log(`[STARTUP]   connectionStore.initFromDisk: ${(performance.now() - t0).toFixed(0)}ms`);
    restoreActiveConnectionContext();
  } catch (e: any) {
    toast(t("connection.loadFailed", { message: e?.message || String(e) }), 5000);
  }
}

function restoreActiveConnectionContext() {
  const activeConnectionId = activeTab.value?.connectionId || connectionStore.activeConnectionId;
  if (activeConnectionId && connectionStore.getConfig(activeConnectionId)) {
    connectionStore.activeConnectionId = activeConnectionId;
  }
}

function handleContextMenu(e: MouseEvent) {
  const target = e.target as HTMLElement;

  // Check if target is a standard editable input element
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    if (import.meta.env.DEV) {
      console.debug("[contextmenu] Allowing for input/textarea:", target);
    }
    return;
  }

  // Check if target or any parent has contenteditable attribute
  if (target.isContentEditable || target.closest("[contenteditable]")) {
    if (import.meta.env.DEV) {
      console.debug("[contextmenu] Allowing for contenteditable:", target);
    }
    return;
  }

  // Check if target is within a custom context menu container or collection item
  if (target.closest("[data-reka-collection-item], [data-radix-vue-collection-item], [data-context-menu]")) {
    if (import.meta.env.DEV) {
      console.debug("[contextmenu] Allowing for custom context menu container:", target);
    }
    return;
  }

  // Prevent default context menu for all other elements
  if (import.meta.env.DEV) {
    console.debug("[contextmenu] Preventing default for:", target);
  }
  e.preventDefault();
}

function openDriverStoreFromEvent(event: Event) {
  openDriverStorePage(((event as CustomEvent).detail as DriverStoreFocus | undefined) ?? null);
}

function runUpdateNotificationChecks() {
  if (!updateNotificationsEnabled.value) return;
  checkUpdates({ silent: true });
  void refreshAgentDriverUpdateCount();
}

watch(updateNotificationsEnabled, (enabled) => {
  if (!enabled) {
    agentDriverUpdateCount.value = 0;
    if (updateCheckTimer) {
      clearInterval(updateCheckTimer);
      updateCheckTimer = undefined;
    }
    return;
  }
  runUpdateNotificationChecks();
  if (!updateCheckTimer) {
    updateCheckTimer = setInterval(runUpdateNotificationChecks, UPDATE_CHECK_INTERVAL_MS);
  }
});

onMounted(async () => {
  console.log("[STARTUP] onMounted begin");
  const mountStart = performance.now();
  requestAnimationFrame(() => {
    aiPanelReady.value = true;
  });
  applyTheme();
  void applyUiScale(settingsStore.editorSettings.uiScale);
  window.addEventListener("keydown", handleKeydown);
  window.addEventListener("dbx-open-driver-store", openDriverStoreFromEvent);
  if (isDesktop) {
    document.addEventListener("contextmenu", handleContextMenu);
  }
  // macOS: Ctrl+click fires both click and contextmenu.
  // Intercept click in capture phase to prevent unwanted navigation.
  // Windows/Linux use Ctrl+click for multi-select; do not block there.
  document.addEventListener(
    "click",
    (e) => {
      if (e.ctrlKey && isMacOS()) e.stopPropagation();
    },
    true,
  );
  if (!isDesktop) {
    try {
      const res = await fetch(apiUrl("/api/auth/check"));
      const data = await res.json();
      needsAuth.value = data.required;
      authenticated.value = data.authenticated;
      setupRequired.value = data.setup_required;
    } catch {
      /* server unreachable */
    }
    if (needsAuth.value && !authenticated.value) {
      history.replaceState(null, "", webPath("/login"));
    }
    if (!setupRequired.value && (!needsAuth.value || authenticated.value)) void initApp();
    api
      .getAppVersion()
      .then((v) => {
        appVersion.value = v;
      })
      .catch(() => {});
    return;
  }
  void initApp();
  setupFileDrop().catch(() => {});
  setTimeout(() => {
    runUpdateNotificationChecks();
    if (updateNotificationsEnabled.value && !updateCheckTimer) {
      updateCheckTimer = setInterval(runUpdateNotificationChecks, UPDATE_CHECK_INTERVAL_MS);
    }
  }, 10_000);
  api
    .getAppVersion()
    .then((v) => {
      appVersion.value = v;
    })
    .catch(() => {});
  setupTauriListeners();
  setupCloseActionPromptListener();
  void openPendingSqlFiles();
  void openPendingDbFiles();
  void openPendingConnectionLinks();
  console.log(`[STARTUP] onMounted sync done: ${(performance.now() - mountStart).toFixed(0)}ms`);
});

onUnmounted(() => {
  cleanupTauriListeners();
  cleanupCloseActionPromptListener();
  if (updateCheckTimer) {
    clearInterval(updateCheckTimer);
  }
  window.removeEventListener("keydown", handleKeydown);
  window.removeEventListener("dbx-open-driver-store", openDriverStoreFromEvent);
  document.removeEventListener("contextmenu", handleContextMenu);
});
</script>

<template>
  <LoginPage v-if="setupRequired || (needsAuth && !authenticated)" :setup-mode="setupRequired" @authenticated="onLoginSuccess" />
  <div v-show="!setupRequired && (!needsAuth || authenticated)" class="fixed inset-0 h-screen w-screen overflow-hidden">
    <TooltipProvider :delay-duration="300">
      <div class="h-screen w-screen max-w-full min-w-[760px] min-h-[600px] flex flex-col bg-background text-foreground overflow-hidden" :class="{ 'dbx-desktop-window-frame': drawDesktopWindowFrame }" :style="appUiFontFamilyStyle">
        <AppToolbar
          :is-dark="isDark"
          :theme-mode="themeMode"
          :show-ai-panel="showAiPanel"
          :show-history="showHistory"
          :show-sql-library="showSqlLibraryPanel"
          :show-sql-file-panel="showSqlFilePanel"
          :show-driver-store="showDriverStore"
          :show-settings-page="showSettingsPage"
          :checking-updates="checkingUpdates"
          :has-update-available="toolbarHasUpdateAvailable"
          :agent-driver-update-count="toolbarAgentDriverUpdateCount"
          :has-connections="connectionStore.connections.length > 0"
          :has-sql-file-connections="hasSqlFileConnections"
          @new-connection="showConnectionDialog = true"
          @new-query="newQuery"
          @set-theme-mode="setThemeMode"
          @toggle-ai="toggleRightSidebarPanel('ai')"
          @toggle-history="toggleRightSidebarPanel('history')"
          @toggle-sql-library="toggleRightSidebarPanel('sqlLibrary')"
          @toggle-sql-file-panel="toggleRightSidebarPanel('sqlFile')"
          @open-github="openGitHub"
          @open-settings="openSettings()"
          @open-driver-store="openDriverStorePage"
          @check-updates="checkUpdates()"
          @open-transfer="dialogs.showTransferDialog.value = true"
          @open-sql-file="dialogs.showSqlFileDialog.value = true"
          @open-schema-diff="dialogs.showSchemaDiffDialog.value = true"
          @open-data-compare="dialogs.showDataCompareDialog.value = true"
        />

        <div :class="isClassicLayout ? 'app-layout-classic flex-1 flex min-h-0' : 'app-panel-gutter flex-1 flex min-h-0 gap-1 p-1'">
          <AppSidebar v-show="sidebarOpen" ref="appSidebarRef" :sidebar-width="sidebarWidth" :classic-layout="isClassicLayout" @import="dialogs.onImportClick" @export="dialogs.onExportClick" @start-resize="startSidebarResize" @collapse="setSidebarOpen(false)" />
          <div v-show="!sidebarOpen" class="flex h-full w-8 shrink-0 items-start justify-center border-r bg-background/80 pt-2" :class="isClassicLayout ? '' : 'rounded-md border border-border/80'">
            <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('sidebar.expand')" :aria-label="t('sidebar.expand')" @click="setSidebarOpen(true)">
              <ChevronsRight class="h-4 w-4" />
            </Button>
          </div>

          <div :class="isClassicLayout ? 'flex-1 min-w-0 overflow-hidden' : 'flex-1 min-w-0 overflow-hidden rounded-md border border-border/80 bg-background'">
            <div class="h-full flex flex-col min-w-0">
              <AppTabBar
                ref="appTabBarRef"
                :driver-store-open="driverStoreTabOpen"
                :driver-store-active="driverStoreActive"
                :settings-page-open="settingsPageTabOpen"
                :settings-page-active="settingsStore.settingsPageActive"
                :agent-driver-update-count="toolbarAgentDriverUpdateCount"
                @activate-driver-store="openDriverStorePage"
                @activate-settings-page="activateSettingsPage"
                @activate-tab="
                  driverStoreActive = false;
                  settingsStore.settingsPageActive = false;
                "
                @close-driver-store="closeDriverStorePage"
                @close-settings-page="closeSettingsPage"
                @save-tab="handleSaveTab"
                @discard-tab-close="handleDiscardPendingTabClose"
                @save-all-tab-close="handleSaveAllPendingTabClose"
                @discard-all-tab-close="handleDiscardAllPendingTabClose"
                @cancel-tab-close="cancelPendingAppClose"
              />
              <DriverStorePage v-if="driverStoreTabOpen" v-show="driverStoreActive" v-model:active-tab="driverStoreActiveTab" class="flex-1 min-h-0" :update-notifications-enabled="updateNotificationsEnabled" :focus-target="driverStoreFocus" @update-count-change="updateAgentDriverUpdateCount" />
              <EditorSettingsPage
                v-if="settingsPageTabOpen"
                v-show="settingsStore.settingsPageActive"
                variant="page"
                :open="settingsPageTabOpen"
                :initial-tab="settingsInitialTab"
                :initial-section="settingsInitialSection"
                :app-version="appVersion"
                class="flex-1 min-h-0"
                @update:open="(open: boolean) => (open ? activateSettingsPage() : closeSettingsPage())"
              />
              <div v-if="activeTab" v-show="!driverStoreActive && !settingsStore.settingsPageActive" class="flex flex-col flex-1 min-h-0">
                <EditorToolbar
                  v-if="activeTab.mode === 'query' && !isPreviewTab(activeTab)"
                  :active-tab="activeTab"
                  :active-connection="activeConnection"
                  :executable-sql="executableSql"
                  :explain-mode="explainMode"
                  :block-dangerous-redis-commands="blockDangerousRedisCommands"
                  :sql-keyword-case="settingsStore.editorSettings.sqlFormatter.keywordCase"
                  :database-required-signal="databaseRequiredTabId === activeTab.id ? databaseRequiredSignal : 0"
                  :auto-commit="activeTab.autoCommit ?? true"
                  :txn-session-id="activeTab?.txnSessionId"
                  :txn-auto-rolled-back="activeTab?.txnAutoRolledBack"
                  @update:explain-mode="(m: 'explain' | 'autotrace') => (explainMode = m)"
                  @update:block-dangerous-redis-commands="(v: boolean) => (blockDangerousRedisCommands = v)"
                  @update:auto-commit="
                    (v: boolean) => {
                      if (activeTab) queryStore.setAutoCommit(activeTab.id, v);
                    }
                  "
                  @commit="activeTab && queryStore.commitTransaction(activeTab.id)"
                  @rollback="activeTab && queryStore.rollbackTransaction(activeTab.id)"
                  @dismiss-txn-rolled-back="activeTab && (activeTab.txnAutoRolledBack = false)"
                  @execute="requestActiveEditorExecute()"
                  @cancel="cancelActiveExecution()"
                  @explain="tryExplain()"
                  @format-sql="formatActiveSql"
                  @compress-sql="compressActiveSql"
                  @toggle-sql-keyword-case="toggleSqlKeywordCase"
                  @save-sql="void openSaveSqlDialog()"
                  @open-sql="openSqlFile"
                  @import-result-archive="importResultArchive"
                  @paste-sql-in-condition="pasteClipboardAsSqlInCondition"
                  @change-connection="changeActiveConnection"
                  @change-database="changeActiveDatabase"
                  @change-schema="changeActiveSchema"
                  @set-default-database="setActiveDatabaseAsDefault"
                  @clear-default-database="clearActiveDefaultDatabase"
                />
                <KeepAlive :max="4">
                  <ContentArea
                    ref="contentAreaRef"
                    :key="activeTab.id"
                    :active-tab="activeTab"
                    :active-connection="activeConnection"
                    :executable-sql="executableSql"
                    :active-output-view="activeOutputView"
                    :format-sql-request="formatSqlRequest"
                    :compress-sql-request="compressSqlRequest"
                    :selected-sql="selectedSql"
                    :cursor-pos="cursorPos"
                    :block-dangerous-redis-commands="blockDangerousRedisCommands"
                    @update:active-output-view="activeOutputView = $event"
                    @fix-with-ai="fixWithAi"
                    @send-selection-to-ai="sendSelectionToAi"
                    @execute="tryExecute($event)"
                    @cancel="cancelActiveExecution()"
                    @explain="tryExplain()"
                    @editor-update="(tabId: string, v: string) => queryStore.updateSql(tabId, v)"
                    @editor-selection-change="(v: string) => (selectedSql = v)"
                    @editor-cursor-change="(p: number) => (cursorPos = p)"
                    @editor-viewport-change="(tabId: string, viewport: { scrollTop: number; scrollLeft: number }) => queryStore.updateEditorViewport(tabId, viewport)"
                    @editor-selection-state-change="(tabId: string, selection: { anchor: number; head: number }) => queryStore.updateEditorSelection(tabId, selection)"
                    @format-error="toast(t('toolbar.formatSqlFailed'))"
                    @save-sql="void openSaveSqlDialog()"
                    @reload="(sql, searchText, whereInput, orderBy, limit, offset, intent) => onReloadData(sql, searchText, whereInput, orderBy, limit, offset, intent)"
                    @paginate="onPaginate"
                    @sort="onSort"
                    @execute-sql="onExecuteSql"
                    @click-table="onClickTable"
                    @view-table-data="onViewTableData"
                    @edit-table-structure="onEditTableStructure"
                    @view-table-ddl="onViewTableDdl"
                    @open-object-source="onOpenObjectSource"
                    @open-object-table="
                      (target) =>
                        activeTab &&
                        openTableTarget({
                          connectionId: activeTab.connectionId,
                          database: activeTab.database,
                          schema: target.schema,
                          catalog: target.catalog,
                          tableName: target.tableName,
                          tableType: target.tableType,
                        })
                    "
                    @object-schema-change="(schema) => activeTab && queryStore.updateSchema(activeTab.id, schema)"
                    @object-browser-viewport-change="(tabId, viewport) => queryStore.updateObjectBrowserViewport(tabId, viewport)"
                    @structure-editor-saved="
                      (commentChanged) =>
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
                    @structure-editor-close="activeTab && queryStore.closeTab(activeTab.id)"
                    @open-settings="openSettings"
                    @open-connection-settings="openConnectionSettings"
                  />
                </KeepAlive>
              </div>
              <WelcomeScreen
                v-else-if="!driverStoreActive && !settingsStore.settingsPageActive"
                :connection-stats="connectionStats"
                :recent-connections="recentConnections"
                :saved-sql-history-items="savedSqlHistoryItems"
                :app-version="appVersion"
                :has-connections="connectionStore.connections.length > 0"
                @open-connection-query="openConnectionQuery"
                @open-saved-sql="openSavedSqlFromWelcome"
                @new-connection="showConnectionDialog = true"
                @new-query="newQuery"
                @show-history="openRightSidebarPanel('history')"
                @import-config="dialogs.onImportClick"
                @open-github="openGitHub"
                @open-mcp-guide="openMcpGuide"
              />
            </div>
          </div>

          <div v-if="showAiPanel" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: aiPanelWidth + 'px' }">
            <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startAiPanelResize" />
            <div class="h-full min-h-0 overflow-hidden">
              <AiAssistant
                v-if="aiPanelReady"
                ref="aiAssistantRef"
                :tab="activeTab"
                :connection="activeConnection"
                @replace-sql="onAiReplaceSql"
                @execute-sql="onAiExecuteSql"
                @temp-run-sql="onAiTempRunSql"
                @request-auto-execute-sql="onAiRequestAutoExecuteSql"
                @insert-redis-command="(command: string) => routeAiRedisCommand(command, false)"
                @execute-redis-command="(command: string) => routeAiRedisCommand(command, true)"
                @open-explain-plan="onAiOpenExplainPlan"
                @close="closeRightSidebarPanel('ai')"
              />
            </div>
          </div>

          <div v-if="showHistory" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: historyWidth + 'px' }">
            <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startHistoryResize" />
            <QueryHistory :current-connection-id="activeTab?.connectionId" :current-database="activeTab?.database" @restore="restoreHistorySql" @analyze-ai="analyzeHistoryWithAi" @close="closeRightSidebarPanel('history')" />
          </div>

          <div v-if="showSqlLibraryPanel" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: sqlLibraryWidth + 'px' }">
            <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startSqlLibraryResize" />
            <div class="h-full min-h-0 overflow-hidden">
              <SqlLibraryPanel @close="closeRightSidebarPanel('sqlLibrary')" />
            </div>
          </div>

          <div v-if="showSqlFilePanel" :class="isClassicLayout ? 'h-full shrink-0 relative z-30 isolate bg-background' : 'h-full shrink-0 relative z-30 isolate rounded-md border border-border/80 bg-background'" :style="{ width: sqlFilePanelWidth + 'px' }">
            <div class="panel-resize-handle panel-resize-handle--left" @mousedown="startSqlFilePanelResize" />
            <div class="h-full min-h-0 overflow-hidden">
              <SqlFilePanel @close="closeRightSidebarPanel('sqlFile')" />
            </div>
          </div>
        </div>

        <AppDialogs
          :show-connection-dialog="showConnectionDialog"
          :connection-prefill="connectionDialogPrefill"
          :connection-initial-tab="connectionDialogInitialTab"
          :show-danger-dialog="showDangerDialog"
          :danger-sql="dangerSql"
          :suppress-danger-confirm="suppressDangerConfirm"
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
          @connect-failed="
            (msg: string) =>
              toast(
                t('connection.connectFailed', {
                  message: translateBackendError(t, msg),
                }),
                5000,
              )
          "
          @open-driver-store="
            setConnectionDialogOpen(false);
            openDriverStorePage($event);
          "
          @open-tunnel-profile-settings="
            setConnectionDialogOpen(false);
            openSettings('tunnels');
          "
          @open-lineage-target="openLineageTarget"
          @open-database-search-target="openDatabaseSearchTarget"
          @open-diagram-target="openDiagramTarget"
        />
        <UpdateDialog
          v-if="showUpdateDialog"
          v-model:open="showUpdateDialog"
          :update-info="updateInfo"
          :update-check-message="updateCheckMessage"
          :is-downloading-update="isDownloadingUpdate"
          :download-progress="downloadProgress"
          :update-downloaded="updateDownloaded"
          :is-installing-update="isInstallingUpdate"
          :update-ready="updateReady"
          :active-task-count="activeUpdateTaskCount"
          @open-latest-release="openLatestRelease"
          @download-and-install="downloadAndInstallUpdate"
          @install-downloaded="installDownloadedUpdate"
          @restart="restartApp"
        />
        <CloseActionPromptDialog v-if="isDesktop && showCloseActionPrompt" :open="showCloseActionPrompt" @update:open="handleCloseActionPromptOpenChange" @quit="chooseQuit" @minimize="chooseMinimize" />
        <QuickOpenDialog :open="showQuickOpen" @update:open="showQuickOpen = $event" @select="handleQuickOpenSelect" />
      </div>
      <Teleport to="body">
        <Transition name="toast">
          <div v-if="toastVisible" class="fixed bottom-6 inset-x-0 w-max max-w-[90vw] sm:max-w-3xl mx-auto z-99999 px-4 py-2 rounded-lg bg-foreground text-background text-sm shadow-lg select-text whitespace-pre-wrap break-words">
            {{ toastMessage }}
          </div>
        </Transition>
      </Teleport>

      <Dialog
        :open="showSaveSqlDialog"
        @update:open="
          (open: boolean) => {
            showSaveSqlDialog = open;
            if (!open) {
              invalidateSaveSqlFolderSelection();
              if (pendingSaveAndCloseTabId) cancelPendingSaveAndClose();
            }
          }
        "
      >
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
              <SearchableSelect
                :model-value="saveSqlFolderId"
                :options="[ROOT_SAVED_SQL_FOLDER, ...saveSqlFolders.map((f) => f.id)]"
                :display-name="saveSqlFolderDisplayName"
                :normalize-custom="saveSqlFolderNormalizeCustom"
                :placeholder="t('savedSql.folderPlaceholder')"
                :search-placeholder="t('savedSql.searchPlaceholder')"
                :empty-text="t('common.noResults')"
                :disabled="saveSqlFolderCreationPending"
                allow-custom
                trigger-variant="outline"
                trigger-class="h-8 w-full max-w-none text-sm"
                content-class="w-[var(--reka-popover-trigger-width)]"
                @update:model-value="handleSaveSqlFolderSelect"
              >
                <template #custom-option-label="{ value }">
                  <span class="truncate">{{ t("savedSql.createFolderOption", { name: value }) }}</span>
                </template>
              </SearchableSelect>
            </div>
          </div>
          <DialogFooter>
            <Button v-if="isDesktop" variant="secondary" @click="saveActiveSqlAsLocalFile">{{ t("savedSql.saveToFile") }}</Button>
            <Button variant="outline" @click="cancelPendingSaveAndClose()">{{ t("dangerDialog.cancel") }}</Button>
            <Button :disabled="saveSqlFolderCreationPending || !saveSqlName.trim()" @click="confirmSaveSqlToLibrary">{{ t("savedSql.save") }}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
    </TooltipProvider>
  </div>
</template>

<style scoped>
.toast-enter-active,
.toast-leave-active {
  transition: 0.25s ease;
  transition-property: transform, opacity;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(100%) scale(0.95);
}
</style>

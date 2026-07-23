<script setup lang="ts">
import { ref, watch, shallowRef, computed, onMounted, onUnmounted, nextTick } from "vue";
import type { Ref } from "vue";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { useI18n } from "vue-i18n";
import { AlertTriangle, ArrowLeft, Check, CheckCircle2, CircleHelp, Cloud, Copy, Download, ExternalLink, GripVertical, Loader2, Moon, PackageSearch, Pencil, Plus, RefreshCw, RotateCcw, Search, Settings, Sun, SunMoon, Terminal, Trash2, Upload, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HelpTooltip, Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from "@/components/ui/tooltip";
import {
  useSettingsStore,
  AI_PROVIDER_PRESETS,
  EDITOR_THEMES,
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_DESKTOP_SETTINGS,
  DEFAULT_SIDEBAR_TABLE_PAGE_SIZE,
  DUCKDB_WORKER_MAX_PROCESSES_MAX,
  DUCKDB_WORKER_MAX_PROCESSES_MIN,
  normalizeDuckDbWorkerMaxProcesses,
  normalizeAiEnv,
  type AiProvider,
  type AiApiStyle,
  type AiAuthMethod,
  type AiConfiguredModel,
  type AiEffortLevel,
  type AiReasoningLevel,
  type EditorTheme,
  type DesktopIconTheme,
  type InterfaceLayout,
  type DisconnectTabHandlingMode,
  type OpenTabsRestoreMode,
  type SidebarObjectInfoMode,
  type SqlSemanticDiagnosticsMode,
  type UpdateDownloadSource,
  type CustomThemeColors,
  type CustomTheme,
} from "@/stores/settingsStore";
import { createRunStatementButtonDom, loadEditorTheme, editorFontTheme } from "@/lib/editor/editorThemes";
import { orderAiConfigsForDisplay } from "@/lib/ai/aiConfigOrdering";
import { normalizeAiModelEffortLevels, normalizeClaudeCodeReasoningLevel } from "@/lib/ai/aiModelEffort";
import ThemeCustomizerDialog from "./ThemeCustomizerDialog.vue";
import TunnelProfileManager from "@/components/connection/TunnelProfileManager.vue";
import DangerConfirmDialog from "./DangerConfirmDialog.vue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useTheme } from "@/composables/useTheme";
import { copyToClipboard } from "@/lib/common/clipboard";
import { clearDebugLogs as clearStoredDebugLogs, downloadDebugLogs, getDebugLogBundleText } from "@/lib/backend/debugLog";
import {
  aiListModels,
  aiTestConnection,
  checkMcpServerStatus,
  installMcpServer,
  forgetSnippetSavedToken,
  forgetWebdavSyncSecretsPassphrase,
  forgetWebdavSavedPassword,
  getAppSupportInfo,
  saveWebdavSyncSecretsPreference,
  saveWebdavSavedPassword,
  saveSnippetSavedToken,
  snippetSyncDownload,
  snippetSyncTest,
  snippetSyncUpload,
  snippetTokenStatus,
  webdavPasswordStatus,
  webdavSyncDownload,
  webdavSyncSecretsStatus,
  webdavSyncTest,
  webdavSyncUpload,
  type AppSupportInfo,
  type AiModelInfo,
  type McpServerStatus,
  type SnippetProvider,
  type SnippetSyncConfig,
  type WebDavConfig,
} from "@/lib/backend/api";
import { eventToModifierOnlyShortcut, eventToShortcut } from "@/lib/editor/keyboardShortcuts";
import { SHORTCUT_DEFINITIONS, findShortcutConflict, normalizeShortcutSettings, type ShortcutActionId } from "@/lib/editor/shortcutRegistry";
import { formatShortcutDisplay } from "@/lib/editor/shortcutDisplay";
import { normalizeSidebarHiddenTablePrefixes } from "@/lib/sidebar/sidebarTableNameDisplay";
import { currentStatementFrameRangeTo, visualSqlColumnsWithInlineHints } from "@/lib/sql/currentStatementFrame";
import { normalizeSqlFormatterSettings, type SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";
import { validateConfigName, generateId, type AiConfigItem, type ConfigNameValidationResult } from "@/lib/ai/aiConfigList";
import { currentExecutableStatementRange, type SqlTextRange } from "@/lib/sql/sqlStatementRanges";
import { executableStatementRangeCacheForDoc, executableStatementRangeStartingAt, type ExecutableStatementRangeCache } from "@/lib/sql/executableStatementRangeCache";
import { EMPTY_TABLE_COLUMN_TEMPLATE_DATA_TYPE, parseTableColumnTemplateFields, TABLE_COLUMN_TEMPLATE_DATABASE_TYPES } from "@/lib/table/tableColumnTemplates";
import { DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES, normalizeSqlVariableSyntaxOverrides, SQL_VARIABLE_SYNTAX_DATABASE_TYPES, SQL_VARIABLE_SYNTAX_KEYS, SQL_VARIABLE_SYNTAX_TOKENS, type SqlVariableSyntaxOverrides, type SqlVariableSyntaxToggles } from "@/lib/sql/sqlVariableSyntax";
import { buildMcpCherryStudioConfig, buildMcpCodexConfig, buildMcpJsonConfig, buildMcpOpenCodeConfig, buildMcpTraeConfig, buildMcpVsCodeConfig, mcpWebBackendUrl, type McpLaunchConfig } from "@/lib/mcp/mcpConfigTemplates";
import { isMcpPolicyMutationBlocked, MCP_CAPABILITY_ROWS, MCP_EXECUTION_MODE_COLUMNS, mcpExecutionModeFromPolicy, mcpPolicyFieldsForExecutionMode, type McpExecutionMode } from "@/lib/mcp/mcpPolicySelection";
import { isMacOS, isWindows } from "@/lib/backend/platform";
import { combineDataTypeForDatabase, dataTypeLengthInputValue, getDataTypeOptions, getDefaultLengthForType, isDataTypeLengthDisabled, splitDataType } from "@/lib/table/tableStructureEditorState";
import { useToast } from "@/composables/useToast";
import type { DatabaseType, SqlSnippet } from "@/types/database";
import { uuid } from "@/lib/common/utils";
import { DEFAULT_SQL_SNIPPETS } from "@/lib/sql/sqlCompletion";
import AiProviderLogo from "@/components/icons/AiProviderLogo.vue";
import AppLogo from "@/components/icons/AppLogo.vue";
import ChangelogPanel from "@/components/settings/ChangelogPanel.vue";
import McpConnectionScopePicker from "@/components/settings/McpConnectionScopePicker.vue";
import ScheduledDatabaseBackupSettings from "@/components/backup/ScheduledDatabaseBackupSettings.vue";
import SqlFormatterSettingsPanel from "./SqlFormatterSettingsPanel.vue";
import { APP_THEME_PALETTES, type AppThemeAppearance, type AppThemeMode, type AppThemePalette } from "@/lib/app/appTheme";
import { editorSettingsDraftChanged, editorSettingsDraftFromSettings, editorSettingsPatchFromDraft, normalizeTableOpenPageSizeDraft, type EditorSettingsDraft } from "@/lib/settings/editorSettingsDraft";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { usePromptTemplateStore } from "@/stores/promptTemplateStore";
import { useTunnelProfileStore } from "@/stores/tunnelProfileStore";
import { currentLocale, setLocale, type Locale } from "@/i18n";
import { LOCALE_OPTIONS } from "@/lib/app/localeOptions";
import { DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES, DEFAULT_WEB_DAV_REMOTE_PATH, normalizedWebDavAutoUploadInterval, writeWebDavAutoUploadFields } from "@/lib/webdav/webdavAutoUploadConfig";
import { apiUrl } from "@/lib/common/webPath";
import { DEFAULT_DATA_GRID_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY, normalizeCustomFontFamilyInput, readableFontFamily, SYSTEM_UI_FONT_FAMILY } from "@/lib/app/appFonts";
import { buildFontFamilyOptions, displayFontFamily, isPresetFontFamily, loadSystemFontNames } from "@/lib/app/fontFamilyOptions";
import { buildAppSupportInfoRows, formatAppSupportInfoForClipboard, type AppSupportInfoLabels } from "@/lib/app/supportInfo";
import { DateTimePatterns, normalizeSupportedDateTimePattern } from "@/lib/dataGrid/columnFormatter";
import { MAX_RESULT_PAGE_SIZE, MIN_RESULT_PAGE_SIZE } from "@/lib/dataGrid/paginationPageSize";
import type { PromptTemplate } from "@/types/promptTemplate";
import { GLOBAL_INSTRUCTIONS_MAX, PROMPT_TEMPLATE_CONTENT_MAX, PROMPT_TEMPLATE_NAME_MAX, promptTemplateCharacterCount } from "@/types/promptTemplate";

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();
const savedSqlStore = useSavedSqlStore();
const promptTemplateStore = usePromptTemplateStore();
const tunnelProfileStore = useTunnelProfileStore();
const { isDark, themeMode, themePalette, setThemeMode, setThemePalette } = useTheme();

const appThemePaletteOptions = computed(
  (): Array<{ value: AppThemePalette; label: string; previewColor: string }> =>
    APP_THEME_PALETTES.map((palette) => ({
      value: palette.value,
      label: t(palette.labelKey),
      previewColor: palette.previewColor,
    })),
);
const selectedThemePaletteOption = computed(() => appThemePaletteOptions.value.find((option) => option.value === themePalette.value) ?? appThemePaletteOptions.value[0]);
const selectedLocaleOption = computed(() => LOCALE_OPTIONS.find((locale) => locale.value === currentLocale()) ?? LOCALE_OPTIONS[0]);
const appThemeModeOptions = computed(() => [
  { value: "light" as AppThemeMode, label: t("toolbar.themeLight"), icon: Sun },
  { value: "dark" as AppThemeMode, label: t("toolbar.themeDark"), icon: Moon },
  { value: "system" as AppThemeMode, label: t("toolbar.themeSystem"), icon: SunMoon },
]);

const props = defineProps<{
  open?: boolean;
  variant?: "dialog" | "page";
  initialTab?: string;
  initialSection?: string;
  appVersion?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const isSettingsPage = computed(() => props.variant === "page");
const settingsVisible = computed(() => isSettingsPage.value || props.open === true);
const settingsRootComponent = computed(() => (isSettingsPage.value ? "div" : Dialog));
const settingsRootProps = computed(() => (isSettingsPage.value ? {} : { open: props.open === true }));
const settingsRootClass = computed(() => (isSettingsPage.value ? "h-full min-h-0 overflow-hidden bg-background" : ""));
const settingsContentComponent = computed(() => (isSettingsPage.value ? "div" : DialogContent));
const settingsContentClass = computed(() =>
  isSettingsPage.value ? "flex h-full min-h-0 flex-col gap-4 overflow-hidden bg-background p-4" : "h-[min(660px,calc(var(--dbx-viewport-height)-80px))] !max-w-[min(920px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] gap-3 p-4 sm:!max-w-[min(920px,calc(100vw-48px))]",
);
const settingsTitleComponent = computed(() => (isSettingsPage.value ? "h2" : DialogTitle));

function onSettingsRootOpenChange(value: boolean) {
  if (!isSettingsPage.value) emit("update:open", value);
}

function closeSettings() {
  emit("update:open", false);
}

interface TableColumnTemplateOverrideRow {
  id: string;
  databaseType: DatabaseType;
  dataType: string;
}

interface TableColumnTemplateGridRow {
  id: string;
  name: string;
  defaultValue: string;
  required: boolean;
  comment: string;
  overrides: TableColumnTemplateOverrideRow[];
}

interface AiEnvRow {
  id: string;
  key: string;
  value: string;
}

function tableColumnTemplateRowsFromSettings(lines: readonly string[]): TableColumnTemplateGridRow[] {
  return parseTableColumnTemplateFields([...lines]).map((field) => ({
    id: uuid(),
    name: field.name,
    defaultValue: field.defaultValue ?? "",
    required: !(field.isNullable ?? false),
    comment: field.comment ?? "",
    overrides: Object.entries(field.dataTypesByDatabase).map(([databaseType, dataType]) => ({
      id: uuid(),
      databaseType: databaseType as DatabaseType,
      dataType: dataType === EMPTY_TABLE_COLUMN_TEMPLATE_DATA_TYPE ? "" : dataType,
    })),
  }));
}

function tableColumnTemplateRowsToSettings(rows: readonly TableColumnTemplateGridRow[]): string[] {
  const seenNames = new Set<string>();
  const settings: string[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seenNames.has(key)) continue;
    seenNames.add(key);

    const parts = [name];

    const seenDatabaseTypes = new Set<DatabaseType>();
    for (const override of row.overrides) {
      const dataType = override.dataType.trim();
      if (seenDatabaseTypes.has(override.databaseType)) continue;
      seenDatabaseTypes.add(override.databaseType);
      parts.push(`${override.databaseType}:${dataType || EMPTY_TABLE_COLUMN_TEMPLATE_DATA_TYPE}`);
    }
    if (!row.required) parts.push("required:false");
    const defaultValue = row.defaultValue.trim();
    if (defaultValue) parts.push(`default:${defaultValue}`);
    const comment = row.comment.trim();
    if (comment) parts.push(`comment:${comment}`);
    settings.push(parts.join(" | "));
  }
  return settings;
}

function createEmptyTableColumnTemplateRow(): TableColumnTemplateGridRow {
  return {
    id: uuid(),
    name: "",
    defaultValue: "",
    required: true,
    comment: "",
    overrides: [],
  };
}

// Local edit state
const editFontFamily = ref(settingsStore.editorSettings.fontFamily);
const editFontSize = ref(settingsStore.editorSettings.fontSize);
const editTableFontFamily = ref(settingsStore.editorSettings.tableFontFamily);
const editUiFontFamily = ref(settingsStore.editorSettings.uiFontFamily);
const editUiScale = ref(settingsStore.editorSettings.uiScale);
const editTheme = ref(settingsStore.editorSettings.theme);
const editCustomThemes = ref<CustomTheme[]>([...settingsStore.editorSettings.customThemes]);
const editActiveCustomThemeId = ref(settingsStore.editorSettings.activeCustomThemeId);
const showThemeCustomizer = ref(false);
const editExecuteMode = ref(settingsStore.editorSettings.executeMode);
const editShowExecutionTargetPicker = ref(settingsStore.editorSettings.showExecutionTargetPicker);
const editShowStatementRunButtons = ref(settingsStore.editorSettings.showStatementRunButtons);
const editShowCurrentStatementFrame = ref(settingsStore.editorSettings.showCurrentStatementFrame);
const editShowInsertValueHints = ref(settingsStore.editorSettings.showInsertValueHints);
const editAutoAliasTables = ref(settingsStore.editorSettings.autoAliasTables);
const editWordWrap = ref(settingsStore.editorSettings.wordWrap);
const editVimModeEnabled = ref(settingsStore.editorSettings.vimModeEnabled);
const editAutoCloseBrackets = ref(settingsStore.editorSettings.autoCloseBrackets);
const editSqlSemanticDiagnosticsMode = ref<SqlSemanticDiagnosticsMode>(settingsStore.editorSettings.sqlSemanticDiagnosticsMode);
const editSqlSemanticDiagnosticsEnabled = ref(settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled);
const editConfirmDangerousSqlExecution = ref(settingsStore.editorSettings.confirmDangerousSqlExecution);
const editContinueOnErrorOnBatch = ref(settingsStore.editorSettings.continueOnErrorOnBatch);
const editConfirmUnsavedSqlClose = ref(settingsStore.editorSettings.confirmUnsavedSqlClose);
const editAppLayout = ref(settingsStore.editorSettings.appLayout);
const editTabLayout = ref(settingsStore.editorSettings.tabLayout);
const editShowTrayIcon = ref(settingsStore.desktopSettings.show_tray_icon);
const editQuitOnClose = ref(settingsStore.desktopSettings.quit_on_close);
const desktopCloseBehaviorResetPending = ref(false);
const editIconTheme = ref<DesktopIconTheme>(settingsStore.desktopSettings.icon_theme);
const editDebugLoggingEnabled = ref(settingsStore.desktopSettings.debug_logging_enabled);
const editDuckDbWorkerProcessIsolation = ref(settingsStore.desktopSettings.duckdb_worker_process_isolation);
const editDuckDbWorkerMaxProcesses = ref(settingsStore.desktopSettings.duckdb_worker_max_processes);
const startupDuckDbWorkerProcessIsolation = ref(settingsStore.desktopSettings.duckdb_worker_process_isolation);
const startupDuckDbWorkerMaxProcesses = ref(settingsStore.desktopSettings.duckdb_worker_max_processes);
const duckDbWorkerStartupCaptured = ref(false);
const duckDbRestarting = ref(false);
const editSidebarTablePageSize = ref(settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE);
const debugLogCopied = ref(false);
const debugLogDownloaded = ref(false);
const editShowColumnCommentsInHeader = ref(settingsStore.editorSettings.showColumnCommentsInHeader);
const editShowColumnTypesInHeader = ref(settingsStore.editorSettings.showColumnTypesInHeader);
const editCompactColumnHeaderActions = ref(settingsStore.editorSettings.compactColumnHeaderActions);
const editDataGridQuickEntry = ref(settingsStore.editorSettings.dataGridQuickEntry);
const editTableOpenPageSize = ref(settingsStore.editorSettings.tableOpenPageSize);
const editInfiniteScroll = ref(settingsStore.editorSettings.infiniteScroll);
const editInfiniteScrollMaxRows = ref(settingsStore.editorSettings.infiniteScrollMaxRows);
const editAutoCalculateTotalRows = ref(settingsStore.editorSettings.autoCalculateTotalRows);
const editTableColumnTemplateRows = ref<TableColumnTemplateGridRow[]>(tableColumnTemplateRowsFromSettings(settingsStore.editorSettings.tableColumnTemplateFields));
const editTableColumnTemplateDatabaseType = ref<DatabaseType>(TABLE_COLUMN_TEMPLATE_DATABASE_TYPES[0] ?? "mysql");
const editSqlVariableSyntaxOverrides = ref<SqlVariableSyntaxOverrides>(normalizeSqlVariableSyntaxOverrides(settingsStore.editorSettings.sqlVariableSyntaxOverrides));
const editSqlVariableSyntaxDatabaseType = ref<DatabaseType>(SQL_VARIABLE_SYNTAX_DATABASE_TYPES[0] ?? "mysql");

function updateTableOpenPageSizeDraft(value: string | number) {
  editTableOpenPageSize.value = normalizeTableOpenPageSizeDraft(value);
}

function sqlVariableSyntaxToggle(key: keyof SqlVariableSyntaxToggles): boolean {
  return editSqlVariableSyntaxOverrides.value[editSqlVariableSyntaxDatabaseType.value]?.[key] ?? true;
}

function setSqlVariableSyntaxToggle(key: keyof SqlVariableSyntaxToggles, value: boolean) {
  const dbType = editSqlVariableSyntaxDatabaseType.value;
  const merged: SqlVariableSyntaxToggles = {
    ...DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES,
    ...editSqlVariableSyntaxOverrides.value[dbType],
    [key]: value,
  };
  const next: SqlVariableSyntaxOverrides = { ...editSqlVariableSyntaxOverrides.value };
  // Keep storage sparse: an all-enabled type has no entry; otherwise persist only the disabled syntaxes.
  if (SQL_VARIABLE_SYNTAX_KEYS.every((toggleKey) => merged[toggleKey])) {
    delete next[dbType];
  } else {
    const partial: Partial<SqlVariableSyntaxToggles> = {};
    for (const toggleKey of SQL_VARIABLE_SYNTAX_KEYS) {
      if (!merged[toggleKey]) partial[toggleKey] = false;
    }
    next[dbType] = partial;
  }
  editSqlVariableSyntaxOverrides.value = next;
}
const tableColumnTemplateSectionRef = ref<HTMLElement | null>(null);
const draggedTableColumnTemplateRowId = ref<string | null>(null);
let tableColumnTemplatePointerDragCleanup: (() => void) | null = null;
const editShortcuts = ref(normalizeShortcutSettings(settingsStore.editorSettings.shortcuts));
const editSqlFormatter = ref<SqlFormatterSettings>(normalizeSqlFormatterSettings(settingsStore.editorSettings.sqlFormatter));
const sqlFormatterConfigValid = ref(true);
const editingShortcutId = ref<ShortcutActionId | null>(null);
const editSidebarActivation = ref(settingsStore.editorSettings.sidebarActivation);
const editSidebarObjectDisplay = ref(settingsStore.editorSettings.sidebarObjectDisplay);
const sidebarObjectDisplayHelp = ref<"grouped" | "simple" | null>(null);
const editSidebarTableSearchEnabled = ref(settingsStore.editorSettings.sidebarTableSearchEnabled);
const editAutoSelectActiveSidebarNode = ref(settingsStore.editorSettings.autoSelectActiveSidebarNode);
const editOpenTabsRestoreMode = ref<OpenTabsRestoreMode>(settingsStore.editorSettings.openTabsRestoreMode);
const editDisconnectTabHandlingMode = ref<DisconnectTabHandlingMode>(settingsStore.editorSettings.disconnectTabHandlingMode);
const editReuseDataTab = ref(settingsStore.editorSettings.reuseDataTab);
const editPrefillNewQueryWithSelect = ref(settingsStore.editorSettings.prefillNewQueryWithSelect);
const editUpdateNotificationsEnabled = ref(settingsStore.editorSettings.updateNotificationsEnabled);
const editSidebarHiddenTablePrefixes = ref(settingsStore.editorSettings.sidebarHiddenTablePrefixes.join("\n"));
const editSidebarObjectInfoMode = ref<SidebarObjectInfoMode>(settingsStore.editorSettings.sidebarObjectInfoMode);
const editSidebarAllowHorizontalScroll = ref(settingsStore.editorSettings.sidebarAllowHorizontalScroll);
const editExportBatchSize = ref(settingsStore.editorSettings.exportBatchSize);
const editGlobalDateTimeDisplayFormat = ref(settingsStore.editorSettings.globalDateTimeDisplayFormat);
const editGlobalDateTimeExportFormat = ref(settingsStore.editorSettings.globalDateTimeExportFormat);
const editGlobalDateTimeImportFormat = ref(settingsStore.editorSettings.globalDateTimeImportFormat);
/** Empty first option restores default (raw/auto); avoids using tab-wide "reset defaults". */
const globalDateTimeFormatOptions = ["", ...DateTimePatterns];
function globalDateTimeRawFormatLabel(option: string): string {
  return option || t("settings.dateTimeFormatRaw");
}
function globalDateTimeAutoFormatLabel(option: string): string {
  return option || t("settings.dateTimeFormatAuto");
}
const editExportRowLimitEnabled = ref(settingsStore.editorSettings.exportRowLimitEnabled);
const editExportRowLimit = ref(settingsStore.editorSettings.exportRowLimit);
const editQueryExportKeysetOptimizationEnabled = ref(settingsStore.editorSettings.queryExportKeysetOptimizationEnabled);
const editUpdateDownloadSource = ref<UpdateDownloadSource>(settingsStore.editorSettings.updateDownloadSource);
const editToolbarItems = ref({ ...settingsStore.editorSettings.toolbarItems });
const systemFonts = ref<string[]>([]);
const systemFontsLoading = ref(false);
const systemFontsLoaded = ref(false);
const uiScaleOptions = [0.75, 0.9, 0.95, 1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.5, 1.75];
const fontSearchTriggerClass =
  "h-8 w-full max-w-none justify-between gap-1.5 rounded-[6px] border border-input bg-transparent py-2 pl-2.5 pr-2 text-sm font-normal shadow-none hover:bg-transparent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-transparent dark:bg-input/30 dark:hover:bg-input/50";
const appearanceFontSearchTriggerClass = `${fontSearchTriggerClass} gap-0 pl-2 pr-1.5`;
const fontSearchTriggerIconClass = "size-4 text-muted-foreground";
const appearanceFontSearchTriggerIconClass = "size-2.5 text-muted-foreground";
const disconnectTabHandlingModeDescriptionKey = computed(() => {
  switch (editDisconnectTabHandlingMode.value) {
    case "close-tabs":
      return "disconnectTabHandlingModeCloseTabsDescription";
    case "keep-tabs-clear-results":
      return "disconnectTabHandlingModeKeepTabsClearResultsDescription";
    case "keep-tabs-keep-results":
      return "disconnectTabHandlingModeKeepTabsKeepResultsDescription";
  }

  return "disconnectTabHandlingModeCloseTabsDescription";
});
const normalizedEditTableColumnTemplateFields = computed(() => tableColumnTemplateRowsToSettings(editTableColumnTemplateRows.value));
const visibleTableColumnTemplateRows = computed(() =>
  editTableColumnTemplateRows.value.filter((row) => {
    if (row.overrides.length === 0) return true;
    return row.overrides.some((override) => override.databaseType === editTableColumnTemplateDatabaseType.value);
  }),
);

// --- Snippet state ---
function editableSnippet(snippet: SqlSnippet): SqlSnippet {
  return { ...snippet, enabled: snippet.enabled !== false };
}

const editSnippets = ref<SqlSnippet[]>(settingsStore.editorSettings.snippets.map(editableSnippet));

function currentEditorSettingsDraft(): EditorSettingsDraft {
  return {
    fontFamily: editFontFamily.value,
    fontSize: editFontSize.value,
    tableFontFamily: editTableFontFamily.value,
    uiFontFamily: editUiFontFamily.value,
    uiScale: editUiScale.value,
    theme: editTheme.value,
    customThemes: editCustomThemes.value,
    activeCustomThemeId: editActiveCustomThemeId.value,
    executeMode: editExecuteMode.value,
    showExecutionTargetPicker: editShowExecutionTargetPicker.value,
    showStatementRunButtons: editShowStatementRunButtons.value,
    showCurrentStatementFrame: editShowCurrentStatementFrame.value,
    showInsertValueHints: editShowInsertValueHints.value,
    autoAliasTables: editAutoAliasTables.value,
    wordWrap: editWordWrap.value,
    vimModeEnabled: editVimModeEnabled.value,
    autoCloseBrackets: editAutoCloseBrackets.value,
    sqlSemanticDiagnosticsMode: editSqlSemanticDiagnosticsMode.value,
    confirmDangerousSqlExecution: editConfirmDangerousSqlExecution.value,
    continueOnErrorOnBatch: editContinueOnErrorOnBatch.value,
    confirmUnsavedSqlClose: editConfirmUnsavedSqlClose.value,
    appLayout: editAppLayout.value,
    tabLayout: editTabLayout.value,
    showColumnCommentsInHeader: editShowColumnCommentsInHeader.value,
    showColumnTypesInHeader: editShowColumnTypesInHeader.value,
    compactColumnHeaderActions: editCompactColumnHeaderActions.value,
    dataGridQuickEntry: editDataGridQuickEntry.value,
    tableOpenPageSize: editTableOpenPageSize.value,
    infiniteScroll: editInfiniteScroll.value,
    infiniteScrollMaxRows: editInfiniteScrollMaxRows.value,
    autoCalculateTotalRows: editAutoCalculateTotalRows.value,
    tableColumnTemplateFields: normalizedEditTableColumnTemplateFields.value,
    shortcuts: editShortcuts.value,
    sqlFormatter: normalizeSqlFormatterSettings(editSqlFormatter.value),
    sidebarActivation: editSidebarActivation.value,
    sidebarObjectDisplay: editSidebarObjectDisplay.value,
    sidebarTableSearchEnabled: editSidebarTableSearchEnabled.value,
    autoSelectActiveSidebarNode: editAutoSelectActiveSidebarNode.value,
    openTabsRestoreMode: editOpenTabsRestoreMode.value,
    disconnectTabHandlingMode: editDisconnectTabHandlingMode.value,
    reuseDataTab: editReuseDataTab.value,
    prefillNewQueryWithSelect: editPrefillNewQueryWithSelect.value,
    updateNotificationsEnabled: editUpdateNotificationsEnabled.value,
    sidebarObjectInfoMode: editSidebarObjectInfoMode.value,
    sidebarAllowHorizontalScroll: editSidebarAllowHorizontalScroll.value,
    sidebarHiddenTablePrefixes: normalizeSidebarHiddenTablePrefixes(editSidebarHiddenTablePrefixes.value),
    exportBatchSize: editExportBatchSize.value,
    globalDateTimeDisplayFormat: editGlobalDateTimeDisplayFormat.value,
    globalDateTimeExportFormat: editGlobalDateTimeExportFormat.value,
    globalDateTimeImportFormat: editGlobalDateTimeImportFormat.value,
    exportRowLimitEnabled: editExportRowLimitEnabled.value,
    exportRowLimit: editExportRowLimit.value,
    queryExportKeysetOptimizationEnabled: editQueryExportKeysetOptimizationEnabled.value,
    updateDownloadSource: editUpdateDownloadSource.value,
    toolbarItems: { ...editToolbarItems.value },
    snippets: editSnippets.value,
    sqlVariableSyntaxOverrides: editSqlVariableSyntaxOverrides.value,
  };
}

const editEditorSettingsBase = ref<EditorSettingsDraft>(editorSettingsDraftFromSettings(settingsStore.editorSettings));
const hasEditorDraftChanges = computed(() => editorSettingsDraftChanged(currentEditorSettingsDraft(), editEditorSettingsBase.value));

const snippetDialogOpen = ref(false);
const snippetEditingId = ref<string | null>(null);
const snippetForm = ref({ label: "", prefix: "", body: "" });
const snippetFormPrefixError = ref("");
const iconThemeDescTruncated = { default: ref<boolean>(false), black: ref<boolean>(false) };
const iconThemeDescRef = {
  default: ref<HTMLElement | null>(null),
  black: ref<HTMLElement | null>(null),
};
const iconThemeBlackDescriptionText = computed(() => (isMacOS() ? t("settings.iconThemeBlackDescriptionMac") : t("settings.iconThemeBlackDescription")));
const layoutDescTruncated = { separated: ref<boolean>(false), classic: ref<boolean>(false) };
const layoutDescRefs = {
  separated: ref<HTMLElement | null>(null),
  classic: ref<HTMLElement | null>(null),
};
let layoutDescObservers: Record<InterfaceLayout, ResizeObserver | undefined> = {
  separated: undefined,
  classic: undefined,
};
let iconThemeDescObservers: Record<DesktopIconTheme, ResizeObserver | undefined> = {
  default: undefined,
  black: undefined,
};

function observeElementTruncation(el: Ref<HTMLElement | null>, truncated: Ref<boolean>) {
  if (!el.value) return;

  const observer = new ResizeObserver(() => {
    truncated.value = checkElementTruncation(el.value);
  });

  observer.observe(el.value);
  return observer;
}

function initTruncationObservers() {
  layoutDescObservers.separated = observeElementTruncation(layoutDescRefs.separated, layoutDescTruncated.separated);
  layoutDescObservers.classic = observeElementTruncation(layoutDescRefs.classic, layoutDescTruncated.classic);
  iconThemeDescObservers.default = observeElementTruncation(iconThemeDescRef.default, iconThemeDescTruncated.default);
  iconThemeDescObservers.black = observeElementTruncation(iconThemeDescRef.black, iconThemeDescTruncated.black);
}

function cleanupTruncationObservers() {
  layoutDescObservers.separated?.disconnect();
  layoutDescObservers.classic?.disconnect();
  iconThemeDescObservers.default?.disconnect();
  iconThemeDescObservers.black?.disconnect();
}

function setLayoutDescRef(layout: InterfaceLayout, el: unknown) {
  layoutDescRefs[layout].value = el instanceof HTMLElement ? el : null;
}

function setIconThemeDescRef(theme: DesktopIconTheme, el: unknown) {
  iconThemeDescRef[theme].value = el instanceof HTMLElement ? el : null;
}

function checkLayoutDescTruncation() {
  checkTruncationForRefs([
    { el: layoutDescRefs.separated, truncated: layoutDescTruncated.separated },
    { el: layoutDescRefs.classic, truncated: layoutDescTruncated.classic },
  ]);
}

function checkIconThemeDescTruncation() {
  checkTruncationForRefs([
    { el: iconThemeDescRef.default, truncated: iconThemeDescTruncated.default },
    { el: iconThemeDescRef.black, truncated: iconThemeDescTruncated.black },
  ]);
}

function checkTruncationForRefs(items: Array<{ el: Ref<HTMLElement | null>; truncated: Ref<boolean> }>) {
  nextTick(() => {
    for (const item of items) {
      if (item.el.value) {
        item.truncated.value = checkElementTruncation(item.el.value);
      }
    }
  });
}

function checkElementTruncation(el: HTMLElement | null) {
  return el ? el.scrollWidth > el.clientWidth : false;
}

function openAddSnippetDialog() {
  snippetEditingId.value = null;
  snippetForm.value = { label: "", prefix: "", body: "" };
  snippetFormPrefixError.value = "";
  snippetDialogOpen.value = true;
}

function openEditSnippetDialog(snippet: SqlSnippet) {
  snippetEditingId.value = snippet.id;
  snippetForm.value = { label: snippet.label, prefix: snippet.prefix, body: snippet.body };
  snippetFormPrefixError.value = "";
  snippetDialogOpen.value = true;
}

function saveSnippet() {
  const prefix = snippetForm.value.prefix.trim();
  if (!prefix) {
    snippetFormPrefixError.value = "Prefix is required.";
    return;
  }
  const duplicate = editSnippets.value.find((s) => s.prefix === prefix && s.id !== snippetEditingId.value);
  if (duplicate) {
    snippetFormPrefixError.value = "Prefix must be unique.";
    return;
  }
  if (snippetEditingId.value) {
    const idx = editSnippets.value.findIndex((s) => s.id === snippetEditingId.value);
    if (idx !== -1) {
      editSnippets.value[idx] = {
        id: snippetEditingId.value,
        label: snippetForm.value.label.trim() || prefix,
        prefix,
        body: snippetForm.value.body,
        enabled: editSnippets.value[idx].enabled !== false,
      };
    }
  } else {
    editSnippets.value.push({
      id: uuid(),
      label: snippetForm.value.label.trim() || prefix,
      prefix,
      body: snippetForm.value.body,
      enabled: true,
    });
  }
  snippetDialogOpen.value = false;
}

function setSnippetEnabled(id: string, enabled: boolean) {
  const idx = editSnippets.value.findIndex((s) => s.id === id);
  if (idx === -1) return;
  editSnippets.value[idx] = { ...editSnippets.value[idx], enabled };
}

function deleteSnippet(id: string) {
  editSnippets.value = editSnippets.value.filter((s) => s.id !== id);
}

function confirmDeleteSnippet(snippet: SqlSnippet) {
  if (window.confirm(`Delete snippet "${snippet.label}"?`)) {
    deleteSnippet(snippet.id);
  }
}

const uiFontPreviewValues = new Set([DEFAULT_UI_FONT_FAMILY, SYSTEM_UI_FONT_FAMILY]);

const systemFontOptions = computed(() => {
  return buildFontFamilyOptions(systemFonts.value, [editFontFamily.value]);
});

const tableFontOptions = computed(() => buildFontFamilyOptions(systemFonts.value, [editTableFontFamily.value], [DEFAULT_DATA_GRID_FONT_FAMILY]));

const uiFontOptions = computed(() => {
  const options = new Set([SYSTEM_UI_FONT_FAMILY, DEFAULT_UI_FONT_FAMILY, ...systemFontOptions.value]);
  if (editUiFontFamily.value) options.add(editUiFontFamily.value);
  return [...options];
});

function displayUiFontFamily(value: string): string {
  if (value === SYSTEM_UI_FONT_FAMILY) return t("settings.uiFontSystemDefault");
  if (value === DEFAULT_UI_FONT_FAMILY) return t("settings.uiFontAppDefault");
  return displayFontFamily(value);
}

function fontOptionStyle(value: string, selectedValue = editFontFamily.value) {
  return isPresetFontFamily(value) || uiFontPreviewValues.has(value) || value === selectedValue ? { fontFamily: value } : undefined;
}

async function loadSystemFontOptions() {
  if (systemFontsLoaded.value || systemFontsLoading.value) return;
  systemFontsLoading.value = true;
  try {
    systemFonts.value = await loadSystemFontNames();
    systemFontsLoaded.value = true;
  } catch {
    systemFonts.value = [];
  } finally {
    systemFontsLoading.value = false;
  }
}

function syncEditorSettingsDraftFromStore() {
  editFontFamily.value = settingsStore.editorSettings.fontFamily;
  editFontSize.value = settingsStore.editorSettings.fontSize;
  editTableFontFamily.value = settingsStore.editorSettings.tableFontFamily;
  editUiFontFamily.value = settingsStore.editorSettings.uiFontFamily;
  editUiScale.value = settingsStore.editorSettings.uiScale;
  editTheme.value = settingsStore.editorSettings.theme;
  editCustomThemes.value = [...settingsStore.editorSettings.customThemes];
  editActiveCustomThemeId.value = settingsStore.editorSettings.activeCustomThemeId;
  editExecuteMode.value = settingsStore.editorSettings.executeMode;
  editShowExecutionTargetPicker.value = settingsStore.editorSettings.showExecutionTargetPicker;
  editShowStatementRunButtons.value = settingsStore.editorSettings.showStatementRunButtons;
  editShowCurrentStatementFrame.value = settingsStore.editorSettings.showCurrentStatementFrame;
  editShowInsertValueHints.value = settingsStore.editorSettings.showInsertValueHints;
  editAutoAliasTables.value = settingsStore.editorSettings.autoAliasTables;
  editWordWrap.value = settingsStore.editorSettings.wordWrap;
  editVimModeEnabled.value = settingsStore.editorSettings.vimModeEnabled;
  editAutoCloseBrackets.value = settingsStore.editorSettings.autoCloseBrackets;
  editSqlSemanticDiagnosticsMode.value = settingsStore.editorSettings.sqlSemanticDiagnosticsMode;
  editSqlSemanticDiagnosticsEnabled.value = settingsStore.editorSettings.sqlSemanticDiagnosticsEnabled;
  editConfirmDangerousSqlExecution.value = settingsStore.editorSettings.confirmDangerousSqlExecution;
  editContinueOnErrorOnBatch.value = settingsStore.editorSettings.continueOnErrorOnBatch;
  editConfirmUnsavedSqlClose.value = settingsStore.editorSettings.confirmUnsavedSqlClose;
  editAppLayout.value = settingsStore.editorSettings.appLayout;
  editTabLayout.value = settingsStore.editorSettings.tabLayout;
  editShowColumnCommentsInHeader.value = settingsStore.editorSettings.showColumnCommentsInHeader;
  editShowColumnTypesInHeader.value = settingsStore.editorSettings.showColumnTypesInHeader;
  editCompactColumnHeaderActions.value = settingsStore.editorSettings.compactColumnHeaderActions;
  editDataGridQuickEntry.value = settingsStore.editorSettings.dataGridQuickEntry;
  editTableOpenPageSize.value = settingsStore.editorSettings.tableOpenPageSize;
  editInfiniteScroll.value = settingsStore.editorSettings.infiniteScroll;
  editInfiniteScrollMaxRows.value = settingsStore.editorSettings.infiniteScrollMaxRows;
  editAutoCalculateTotalRows.value = settingsStore.editorSettings.autoCalculateTotalRows;
  editTableColumnTemplateRows.value = tableColumnTemplateRowsFromSettings(settingsStore.editorSettings.tableColumnTemplateFields);
  editShortcuts.value = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
  editSqlFormatter.value = normalizeSqlFormatterSettings(settingsStore.editorSettings.sqlFormatter);
  sqlFormatterConfigValid.value = true;
  editSidebarActivation.value = settingsStore.editorSettings.sidebarActivation;
  editSidebarObjectDisplay.value = settingsStore.editorSettings.sidebarObjectDisplay;
  editSidebarTableSearchEnabled.value = settingsStore.editorSettings.sidebarTableSearchEnabled;
  editAutoSelectActiveSidebarNode.value = settingsStore.editorSettings.autoSelectActiveSidebarNode;
  editOpenTabsRestoreMode.value = settingsStore.editorSettings.openTabsRestoreMode;
  editDisconnectTabHandlingMode.value = settingsStore.editorSettings.disconnectTabHandlingMode;
  editReuseDataTab.value = settingsStore.editorSettings.reuseDataTab;
  editPrefillNewQueryWithSelect.value = settingsStore.editorSettings.prefillNewQueryWithSelect;
  editUpdateNotificationsEnabled.value = settingsStore.editorSettings.updateNotificationsEnabled;
  editSidebarHiddenTablePrefixes.value = settingsStore.editorSettings.sidebarHiddenTablePrefixes.join("\n");
  editSidebarObjectInfoMode.value = settingsStore.editorSettings.sidebarObjectInfoMode;
  editSidebarAllowHorizontalScroll.value = settingsStore.editorSettings.sidebarAllowHorizontalScroll;
  editExportBatchSize.value = settingsStore.editorSettings.exportBatchSize;
  editGlobalDateTimeDisplayFormat.value = settingsStore.editorSettings.globalDateTimeDisplayFormat;
  editGlobalDateTimeExportFormat.value = settingsStore.editorSettings.globalDateTimeExportFormat;
  editGlobalDateTimeImportFormat.value = settingsStore.editorSettings.globalDateTimeImportFormat;
  editExportRowLimitEnabled.value = settingsStore.editorSettings.exportRowLimitEnabled;
  editExportRowLimit.value = settingsStore.editorSettings.exportRowLimit;
  editQueryExportKeysetOptimizationEnabled.value = settingsStore.editorSettings.queryExportKeysetOptimizationEnabled;
  editUpdateDownloadSource.value = settingsStore.editorSettings.updateDownloadSource;
  editToolbarItems.value = { ...settingsStore.editorSettings.toolbarItems };
  editSnippets.value = settingsStore.editorSettings.snippets.map(editableSnippet);
  editSqlVariableSyntaxOverrides.value = normalizeSqlVariableSyntaxOverrides(settingsStore.editorSettings.sqlVariableSyntaxOverrides);
  editEditorSettingsBase.value = editorSettingsDraftFromSettings(settingsStore.editorSettings);
}

// Sync from store when dialog opens
watch(
  () => settingsVisible.value,
  (open) => {
    if (open) {
      syncEditorSettingsDraftFromStore();
      editShowTrayIcon.value = settingsStore.desktopSettings.show_tray_icon;
      editQuitOnClose.value = settingsStore.desktopSettings.quit_on_close;
      editIconTheme.value = settingsStore.desktopSettings.icon_theme;
      editDebugLoggingEnabled.value = settingsStore.desktopSettings.debug_logging_enabled;
      editDuckDbWorkerProcessIsolation.value = settingsStore.desktopSettings.duckdb_worker_process_isolation;
      editSidebarTablePageSize.value = settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE;
    }
  },
  { immediate: true },
);

watch(
  () => settingsStore.editorSettings,
  () => {
    if (settingsVisible.value && !hasEditorDraftChanges.value) {
      syncEditorSettingsDraftFromStore();
    }
  },
  { deep: true },
);

const shortcutConflicts = computed(() =>
  SHORTCUT_DEFINITIONS.flatMap((definition) => {
    const conflict = findShortcutConflict(definition.id, editShortcuts.value[definition.id], editShortcuts.value);
    return conflict ? [definition.id] : [];
  }),
);
const shortcutSearchQuery = ref("");
const formatterEditorShortcutIds: ShortcutActionId[] = [
  "formatSql",
  "toggleLineComment",
  "find",
  "replace",
  "saveSql",
  "acceptCompletion",
  "indentMore",
  "indentLess",
  "duplicateLine",
  "deleteLine",
  "moveLineUp",
  "moveLineDown",
  "copyLineUp",
  "copyLineDown",
  "undo",
  "redo",
  "selectAll",
  "uppercaseSelection",
  "lowercaseSelection",
];
const formatterEditorShortcutDefinitions = computed(() => formatterEditorShortcutIds.map((id) => SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)).filter((definition): definition is (typeof SHORTCUT_DEFINITIONS)[number] => !!definition));
const filteredShortcutDefinitions = computed(() => {
  const query = shortcutSearchQuery.value.trim().toLowerCase();
  if (!query) return SHORTCUT_DEFINITIONS;
  return SHORTCUT_DEFINITIONS.filter((definition) => {
    const scope = t(`settings.shortcutScope${definition.scope[0].toUpperCase()}${definition.scope.slice(1)}`);
    const shortcut = formatShortcutPill(editShortcuts.value[definition.id]);
    return [definition.id, t(definition.labelKey), scope, shortcut].some((value) => value.toLowerCase().includes(query));
  });
});
const hasShortcutConflicts = computed(() => shortcutConflicts.value.length > 0);
const shortcutsChanged = computed(() => JSON.stringify(editShortcuts.value) !== JSON.stringify(editEditorSettingsBase.value.shortcuts));
const duckDbWorkerSettingsRequireRestart = computed(() => editDuckDbWorkerProcessIsolation.value !== startupDuckDbWorkerProcessIsolation.value || normalizeDuckDbWorkerMaxProcesses(editDuckDbWorkerMaxProcesses.value) !== startupDuckDbWorkerMaxProcesses.value);
const hasBlockingShortcutConflicts = computed(() => shortcutsChanged.value && hasShortcutConflicts.value);
const hasBlockingFormatterConfig = computed(() => activeSettingsTab.value === "formatter" && !sqlFormatterConfigValid.value);
const hasApplyBlocker = computed(() => hasBlockingShortcutConflicts.value || hasBlockingFormatterConfig.value);

function hasChanges(): boolean {
  return (
    hasEditorDraftChanges.value ||
    editShowTrayIcon.value !== settingsStore.desktopSettings.show_tray_icon ||
    editQuitOnClose.value !== settingsStore.desktopSettings.quit_on_close ||
    editIconTheme.value !== settingsStore.desktopSettings.icon_theme ||
    editDebugLoggingEnabled.value !== settingsStore.desktopSettings.debug_logging_enabled ||
    editDuckDbWorkerProcessIsolation.value !== settingsStore.desktopSettings.duckdb_worker_process_isolation ||
    normalizeDuckDbWorkerMaxProcesses(editDuckDbWorkerMaxProcesses.value) !== settingsStore.desktopSettings.duckdb_worker_max_processes ||
    editSidebarTablePageSize.value !== (settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE)
  );
}

async function persistSettings() {
  if (hasApplyBlocker.value) return;
  const editorSettingsPatch = editorSettingsPatchFromDraft(currentEditorSettingsDraft(), editEditorSettingsBase.value);
  const sidebarObjectDisplayChanged = editorSettingsPatch.sidebarObjectDisplay !== undefined && editorSettingsPatch.sidebarObjectDisplay !== settingsStore.editorSettings.sidebarObjectDisplay;
  const sidebarTablePageSizeChanged = editSidebarTablePageSize.value !== (settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE);
  if (Object.keys(editorSettingsPatch).length > 0) {
    settingsStore.updateEditorSettings(editorSettingsPatch);
    await settingsStore.persistEditorSettings();
    editEditorSettingsBase.value = editorSettingsDraftFromSettings(settingsStore.editorSettings);
  }
  await settingsStore.updateDesktopSettings({
    show_tray_icon: editShowTrayIcon.value,
    quit_on_close: editQuitOnClose.value,
    close_action_prompted: desktopCloseBehaviorResetPending.value ? false : true,
    icon_theme: editIconTheme.value,
    debug_logging_enabled: editDebugLoggingEnabled.value,
    duckdb_worker_process_isolation: editDuckDbWorkerProcessIsolation.value,
    duckdb_worker_max_processes: normalizeDuckDbWorkerMaxProcesses(editDuckDbWorkerMaxProcesses.value),
    sidebar_table_page_size: editSidebarTablePageSize.value,
  });
  desktopCloseBehaviorResetPending.value = false;
  if (sidebarObjectDisplayChanged) {
    await connectionStore.refreshAllTree();
  } else if (sidebarTablePageSizeChanged) {
    await connectionStore.refreshSidebarObjectPagination();
  }
}

async function applySettings() {
  await persistSettings();
}

async function applySettingsAndClose() {
  await persistSettings();
  closeSettings();
}

async function restartDbxForDuckDbIsolation() {
  if (duckDbRestarting.value || hasApplyBlocker.value || isWeb) return;
  duckDbRestarting.value = true;
  try {
    await persistSettings();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e: any) {
    toast(t("settings.restartDbxFailed", { error: e?.message || String(e) }), 5000);
  } finally {
    duckDbRestarting.value = false;
  }
}

function resetDefaultsForTab(tab: SettingsCategory) {
  if (tab === "editor") {
    editFontFamily.value = DEFAULT_EDITOR_SETTINGS.fontFamily;
    editFontSize.value = DEFAULT_EDITOR_SETTINGS.fontSize;
    editExecuteMode.value = DEFAULT_EDITOR_SETTINGS.executeMode;
    editShowExecutionTargetPicker.value = DEFAULT_EDITOR_SETTINGS.showExecutionTargetPicker;
    editShowStatementRunButtons.value = DEFAULT_EDITOR_SETTINGS.showStatementRunButtons;
    editShowCurrentStatementFrame.value = DEFAULT_EDITOR_SETTINGS.showCurrentStatementFrame;
    editShowInsertValueHints.value = DEFAULT_EDITOR_SETTINGS.showInsertValueHints;
    editAutoAliasTables.value = DEFAULT_EDITOR_SETTINGS.autoAliasTables;
    editWordWrap.value = DEFAULT_EDITOR_SETTINGS.wordWrap;
    editVimModeEnabled.value = DEFAULT_EDITOR_SETTINGS.vimModeEnabled;
    editAutoCloseBrackets.value = DEFAULT_EDITOR_SETTINGS.autoCloseBrackets;
    editSqlSemanticDiagnosticsMode.value = DEFAULT_EDITOR_SETTINGS.sqlSemanticDiagnosticsMode;
    editSqlSemanticDiagnosticsEnabled.value = DEFAULT_EDITOR_SETTINGS.sqlSemanticDiagnosticsEnabled;
    editConfirmDangerousSqlExecution.value = DEFAULT_EDITOR_SETTINGS.confirmDangerousSqlExecution;
    editContinueOnErrorOnBatch.value = DEFAULT_EDITOR_SETTINGS.continueOnErrorOnBatch;
    editConfirmUnsavedSqlClose.value = DEFAULT_EDITOR_SETTINGS.confirmUnsavedSqlClose;
    editSqlVariableSyntaxOverrides.value = normalizeSqlVariableSyntaxOverrides(DEFAULT_EDITOR_SETTINGS.sqlVariableSyntaxOverrides);
  } else if (tab === "formatter") {
    editSqlFormatter.value = normalizeSqlFormatterSettings(DEFAULT_EDITOR_SETTINGS.sqlFormatter);
    sqlFormatterConfigValid.value = true;
  } else if (tab === "appearance") {
    editTableFontFamily.value = DEFAULT_EDITOR_SETTINGS.tableFontFamily;
    editUiFontFamily.value = DEFAULT_EDITOR_SETTINGS.uiFontFamily;
    editUiScale.value = DEFAULT_EDITOR_SETTINGS.uiScale;
    editTheme.value = DEFAULT_EDITOR_SETTINGS.theme;
    editCustomThemes.value = [...DEFAULT_EDITOR_SETTINGS.customThemes];
    editActiveCustomThemeId.value = DEFAULT_EDITOR_SETTINGS.activeCustomThemeId;
    editAppLayout.value = DEFAULT_EDITOR_SETTINGS.appLayout;
    editTabLayout.value = DEFAULT_EDITOR_SETTINGS.tabLayout;
    editShowTrayIcon.value = DEFAULT_DESKTOP_SETTINGS.show_tray_icon;
    editQuitOnClose.value = DEFAULT_DESKTOP_SETTINGS.quit_on_close;
    desktopCloseBehaviorResetPending.value = true;
    editIconTheme.value = DEFAULT_DESKTOP_SETTINGS.icon_theme;
    editDebugLoggingEnabled.value = DEFAULT_DESKTOP_SETTINGS.debug_logging_enabled;
  } else if (tab === "navigation") {
    editSidebarTablePageSize.value = DEFAULT_SIDEBAR_TABLE_PAGE_SIZE;
    editSidebarActivation.value = DEFAULT_EDITOR_SETTINGS.sidebarActivation;
    editSidebarObjectDisplay.value = DEFAULT_EDITOR_SETTINGS.sidebarObjectDisplay;
    editSidebarTableSearchEnabled.value = DEFAULT_EDITOR_SETTINGS.sidebarTableSearchEnabled;
    editAutoSelectActiveSidebarNode.value = DEFAULT_EDITOR_SETTINGS.autoSelectActiveSidebarNode;
    editOpenTabsRestoreMode.value = DEFAULT_EDITOR_SETTINGS.openTabsRestoreMode;
    editDisconnectTabHandlingMode.value = DEFAULT_EDITOR_SETTINGS.disconnectTabHandlingMode;
    editReuseDataTab.value = DEFAULT_EDITOR_SETTINGS.reuseDataTab;
    editPrefillNewQueryWithSelect.value = DEFAULT_EDITOR_SETTINGS.prefillNewQueryWithSelect;
    editUpdateNotificationsEnabled.value = DEFAULT_EDITOR_SETTINGS.updateNotificationsEnabled;
    editSidebarObjectInfoMode.value = DEFAULT_EDITOR_SETTINGS.sidebarObjectInfoMode;
    editSidebarAllowHorizontalScroll.value = DEFAULT_EDITOR_SETTINGS.sidebarAllowHorizontalScroll;
    editSidebarHiddenTablePrefixes.value = DEFAULT_EDITOR_SETTINGS.sidebarHiddenTablePrefixes.join("\n");
    editToolbarItems.value = { ...DEFAULT_EDITOR_SETTINGS.toolbarItems };
  } else if (tab === "data") {
    editShowColumnCommentsInHeader.value = DEFAULT_EDITOR_SETTINGS.showColumnCommentsInHeader;
    editShowColumnTypesInHeader.value = DEFAULT_EDITOR_SETTINGS.showColumnTypesInHeader;
    editCompactColumnHeaderActions.value = DEFAULT_EDITOR_SETTINGS.compactColumnHeaderActions;
    editDataGridQuickEntry.value = DEFAULT_EDITOR_SETTINGS.dataGridQuickEntry;
    editTableOpenPageSize.value = DEFAULT_EDITOR_SETTINGS.tableOpenPageSize;
    editInfiniteScroll.value = DEFAULT_EDITOR_SETTINGS.infiniteScroll;
    editInfiniteScrollMaxRows.value = DEFAULT_EDITOR_SETTINGS.infiniteScrollMaxRows;
    editAutoCalculateTotalRows.value = DEFAULT_EDITOR_SETTINGS.autoCalculateTotalRows;
    editDuckDbWorkerProcessIsolation.value = DEFAULT_DESKTOP_SETTINGS.duckdb_worker_process_isolation;
    editDuckDbWorkerMaxProcesses.value = DEFAULT_DESKTOP_SETTINGS.duckdb_worker_max_processes;
    editTableColumnTemplateRows.value = tableColumnTemplateRowsFromSettings(DEFAULT_EDITOR_SETTINGS.tableColumnTemplateFields);
    editExportBatchSize.value = DEFAULT_EDITOR_SETTINGS.exportBatchSize;
    editGlobalDateTimeDisplayFormat.value = DEFAULT_EDITOR_SETTINGS.globalDateTimeDisplayFormat;
    editGlobalDateTimeExportFormat.value = DEFAULT_EDITOR_SETTINGS.globalDateTimeExportFormat;
    editGlobalDateTimeImportFormat.value = DEFAULT_EDITOR_SETTINGS.globalDateTimeImportFormat;
    editExportRowLimitEnabled.value = DEFAULT_EDITOR_SETTINGS.exportRowLimitEnabled;
    editExportRowLimit.value = DEFAULT_EDITOR_SETTINGS.exportRowLimit;
    editQueryExportKeysetOptimizationEnabled.value = DEFAULT_EDITOR_SETTINGS.queryExportKeysetOptimizationEnabled;
  } else if (tab === "shortcuts") {
    editShortcuts.value = normalizeShortcutSettings(DEFAULT_EDITOR_SETTINGS.shortcuts);
  } else if (tab === "snippets") {
    editSnippets.value = DEFAULT_SQL_SNIPPETS.map((s) => ({ ...s }));
  } else if (tab === "about") {
    editUpdateDownloadSource.value = DEFAULT_EDITOR_SETTINGS.updateDownloadSource;
  }
}

function resetAllDefaults() {
  editFontFamily.value = DEFAULT_EDITOR_SETTINGS.fontFamily;
  editFontSize.value = DEFAULT_EDITOR_SETTINGS.fontSize;
  editTableFontFamily.value = DEFAULT_EDITOR_SETTINGS.tableFontFamily;
  editUiFontFamily.value = DEFAULT_EDITOR_SETTINGS.uiFontFamily;
  editUiScale.value = DEFAULT_EDITOR_SETTINGS.uiScale;
  editTheme.value = DEFAULT_EDITOR_SETTINGS.theme;
  editCustomThemes.value = [...DEFAULT_EDITOR_SETTINGS.customThemes];
  editActiveCustomThemeId.value = DEFAULT_EDITOR_SETTINGS.activeCustomThemeId;
  editExecuteMode.value = DEFAULT_EDITOR_SETTINGS.executeMode;
  editShowExecutionTargetPicker.value = DEFAULT_EDITOR_SETTINGS.showExecutionTargetPicker;
  editShowStatementRunButtons.value = DEFAULT_EDITOR_SETTINGS.showStatementRunButtons;
  editShowCurrentStatementFrame.value = DEFAULT_EDITOR_SETTINGS.showCurrentStatementFrame;
  editShowInsertValueHints.value = DEFAULT_EDITOR_SETTINGS.showInsertValueHints;
  editAutoAliasTables.value = DEFAULT_EDITOR_SETTINGS.autoAliasTables;
  editWordWrap.value = DEFAULT_EDITOR_SETTINGS.wordWrap;
  editVimModeEnabled.value = DEFAULT_EDITOR_SETTINGS.vimModeEnabled;
  editAutoCloseBrackets.value = DEFAULT_EDITOR_SETTINGS.autoCloseBrackets;
  editSqlSemanticDiagnosticsMode.value = DEFAULT_EDITOR_SETTINGS.sqlSemanticDiagnosticsMode;
  editSqlSemanticDiagnosticsEnabled.value = DEFAULT_EDITOR_SETTINGS.sqlSemanticDiagnosticsEnabled;
  editConfirmDangerousSqlExecution.value = DEFAULT_EDITOR_SETTINGS.confirmDangerousSqlExecution;
  editConfirmUnsavedSqlClose.value = DEFAULT_EDITOR_SETTINGS.confirmUnsavedSqlClose;
  editSqlVariableSyntaxOverrides.value = normalizeSqlVariableSyntaxOverrides(DEFAULT_EDITOR_SETTINGS.sqlVariableSyntaxOverrides);
  editAppLayout.value = DEFAULT_EDITOR_SETTINGS.appLayout;
  editShowTrayIcon.value = DEFAULT_DESKTOP_SETTINGS.show_tray_icon;
  editQuitOnClose.value = DEFAULT_DESKTOP_SETTINGS.quit_on_close;
  desktopCloseBehaviorResetPending.value = true;
  editIconTheme.value = DEFAULT_DESKTOP_SETTINGS.icon_theme;
  editDebugLoggingEnabled.value = DEFAULT_DESKTOP_SETTINGS.debug_logging_enabled;
  editDuckDbWorkerProcessIsolation.value = DEFAULT_DESKTOP_SETTINGS.duckdb_worker_process_isolation;
  editDuckDbWorkerMaxProcesses.value = DEFAULT_DESKTOP_SETTINGS.duckdb_worker_max_processes;
  editSidebarTablePageSize.value = DEFAULT_SIDEBAR_TABLE_PAGE_SIZE;
  editShowColumnCommentsInHeader.value = DEFAULT_EDITOR_SETTINGS.showColumnCommentsInHeader;
  editShowColumnTypesInHeader.value = DEFAULT_EDITOR_SETTINGS.showColumnTypesInHeader;
  editCompactColumnHeaderActions.value = DEFAULT_EDITOR_SETTINGS.compactColumnHeaderActions;
  editDataGridQuickEntry.value = DEFAULT_EDITOR_SETTINGS.dataGridQuickEntry;
  editTableOpenPageSize.value = DEFAULT_EDITOR_SETTINGS.tableOpenPageSize;
  editInfiniteScroll.value = DEFAULT_EDITOR_SETTINGS.infiniteScroll;
  editInfiniteScrollMaxRows.value = DEFAULT_EDITOR_SETTINGS.infiniteScrollMaxRows;
  editAutoCalculateTotalRows.value = DEFAULT_EDITOR_SETTINGS.autoCalculateTotalRows;
  editTableColumnTemplateRows.value = tableColumnTemplateRowsFromSettings(DEFAULT_EDITOR_SETTINGS.tableColumnTemplateFields);
  editShortcuts.value = normalizeShortcutSettings(DEFAULT_EDITOR_SETTINGS.shortcuts);
  editSqlFormatter.value = normalizeSqlFormatterSettings(DEFAULT_EDITOR_SETTINGS.sqlFormatter);
  sqlFormatterConfigValid.value = true;
  editSidebarActivation.value = DEFAULT_EDITOR_SETTINGS.sidebarActivation;
  editSidebarObjectDisplay.value = DEFAULT_EDITOR_SETTINGS.sidebarObjectDisplay;
  editSidebarTableSearchEnabled.value = DEFAULT_EDITOR_SETTINGS.sidebarTableSearchEnabled;
  editAutoSelectActiveSidebarNode.value = DEFAULT_EDITOR_SETTINGS.autoSelectActiveSidebarNode;
  editOpenTabsRestoreMode.value = DEFAULT_EDITOR_SETTINGS.openTabsRestoreMode;
  editDisconnectTabHandlingMode.value = DEFAULT_EDITOR_SETTINGS.disconnectTabHandlingMode;
  editReuseDataTab.value = DEFAULT_EDITOR_SETTINGS.reuseDataTab;
  editPrefillNewQueryWithSelect.value = DEFAULT_EDITOR_SETTINGS.prefillNewQueryWithSelect;
  editUpdateNotificationsEnabled.value = DEFAULT_EDITOR_SETTINGS.updateNotificationsEnabled;
  editSidebarObjectInfoMode.value = DEFAULT_EDITOR_SETTINGS.sidebarObjectInfoMode;
  editSidebarAllowHorizontalScroll.value = DEFAULT_EDITOR_SETTINGS.sidebarAllowHorizontalScroll;
  editSidebarHiddenTablePrefixes.value = DEFAULT_EDITOR_SETTINGS.sidebarHiddenTablePrefixes.join("\n");
  editExportBatchSize.value = DEFAULT_EDITOR_SETTINGS.exportBatchSize;
  editGlobalDateTimeDisplayFormat.value = DEFAULT_EDITOR_SETTINGS.globalDateTimeDisplayFormat;
  editGlobalDateTimeExportFormat.value = DEFAULT_EDITOR_SETTINGS.globalDateTimeExportFormat;
  editGlobalDateTimeImportFormat.value = DEFAULT_EDITOR_SETTINGS.globalDateTimeImportFormat;
  editExportRowLimitEnabled.value = DEFAULT_EDITOR_SETTINGS.exportRowLimitEnabled;
  editExportRowLimit.value = DEFAULT_EDITOR_SETTINGS.exportRowLimit;
  editQueryExportKeysetOptimizationEnabled.value = DEFAULT_EDITOR_SETTINGS.queryExportKeysetOptimizationEnabled;
  editUpdateDownloadSource.value = DEFAULT_EDITOR_SETTINGS.updateDownloadSource;
  editToolbarItems.value = { ...DEFAULT_EDITOR_SETTINGS.toolbarItems };
  editSnippets.value = DEFAULT_SQL_SNIPPETS.map((s) => ({ ...s }));
}

function addTableColumnTemplateRow() {
  const row = createEmptyTableColumnTemplateRow();
  row.overrides.push({
    id: uuid(),
    databaseType: editTableColumnTemplateDatabaseType.value,
    dataType: "",
  });
  editTableColumnTemplateRows.value.push(row);
}

function removeTableColumnTemplateRow(id: string) {
  const row = editTableColumnTemplateRows.value.find((item) => item.id === id);
  if (!row) return;
  if (row.overrides.some((override) => override.databaseType === editTableColumnTemplateDatabaseType.value)) {
    row.overrides = row.overrides.filter((override) => override.databaseType !== editTableColumnTemplateDatabaseType.value);
    if (row.overrides.length > 0) return;
  }
  editTableColumnTemplateRows.value = editTableColumnTemplateRows.value.filter((item) => item.id !== id);
}

function moveTableColumnTemplateRow(sourceId: string, targetId: string, placement: "before" | "after") {
  if (!sourceId || sourceId === targetId) return;
  const rows = [...editTableColumnTemplateRows.value];
  const sourceIndex = rows.findIndex((row) => row.id === sourceId);
  const targetIndex = rows.findIndex((row) => row.id === targetId);
  if (sourceIndex === -1 || targetIndex === -1) return;
  const [source] = rows.splice(sourceIndex, 1);
  if (!source) return;
  const nextTargetIndex = rows.findIndex((row) => row.id === targetId);
  const insertIndex = placement === "after" ? nextTargetIndex + 1 : nextTargetIndex;
  rows.splice(nextTargetIndex === -1 ? rows.length : insertIndex, 0, source);
  editTableColumnTemplateRows.value = rows;
}

function cleanupTableColumnTemplatePointerDrag() {
  tableColumnTemplatePointerDragCleanup?.();
  tableColumnTemplatePointerDragCleanup = null;
  draggedTableColumnTemplateRowId.value = null;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
}

function startTableColumnTemplateRowDrag(id: string, event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  cleanupTableColumnTemplatePointerDrag();
  draggedTableColumnTemplateRowId.value = id;
  document.body.style.cursor = "grabbing";
  document.body.style.userSelect = "none";

  const onPointerMove = (moveEvent: PointerEvent) => {
    const sourceId = draggedTableColumnTemplateRowId.value;
    if (!sourceId) return;
    const targetRow = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)?.closest<HTMLElement>("[data-table-column-template-row-id]");
    const targetId = targetRow?.dataset.tableColumnTemplateRowId;
    if (!targetRow || !targetId || targetId === sourceId) return;
    const rect = targetRow.getBoundingClientRect();
    moveTableColumnTemplateRow(sourceId, targetId, moveEvent.clientY > rect.top + rect.height / 2 ? "after" : "before");
  };
  const onPointerUp = () => cleanupTableColumnTemplatePointerDrag();

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
  window.addEventListener("pointercancel", onPointerUp, { once: true });
  tableColumnTemplatePointerDragCleanup = () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
  };
}

function tableColumnTemplateTypeOptions(databaseType: DatabaseType): string[] {
  return getDataTypeOptions(databaseType);
}

function tableColumnTemplateDataTypeForSelectedDatabase(row: TableColumnTemplateGridRow): string {
  return row.overrides.find((override) => override.databaseType === editTableColumnTemplateDatabaseType.value)?.dataType ?? "";
}

function tableColumnTemplateBaseTypeForSelectedDatabase(row: TableColumnTemplateGridRow): string {
  return splitDataType(tableColumnTemplateDataTypeForSelectedDatabase(row)).baseType;
}

function tableColumnTemplateLengthForSelectedDatabase(row: TableColumnTemplateGridRow): string {
  return dataTypeLengthInputValue(editTableColumnTemplateDatabaseType.value, tableColumnTemplateDataTypeForSelectedDatabase(row));
}

function setTableColumnTemplateDataTypeForSelectedDatabase(row: TableColumnTemplateGridRow, value: string) {
  const dataType = value.trim();
  const databaseType = editTableColumnTemplateDatabaseType.value;
  const existing = row.overrides.find((override) => override.databaseType === databaseType);
  if (!dataType) {
    row.overrides = row.overrides.filter((override) => override.databaseType !== databaseType);
    return;
  }
  if (existing) {
    existing.dataType = dataType;
  } else {
    row.overrides.push({ id: uuid(), databaseType, dataType });
  }
}

function setTableColumnTemplateBaseTypeForSelectedDatabase(row: TableColumnTemplateGridRow, value: string) {
  const baseType = value.trim();
  if (!baseType) {
    setTableColumnTemplateDataTypeForSelectedDatabase(row, "");
    return;
  }
  const databaseType = editTableColumnTemplateDatabaseType.value;
  setTableColumnTemplateDataTypeForSelectedDatabase(row, combineDataTypeForDatabase(databaseType, baseType, getDefaultLengthForType(databaseType, baseType)));
}

function setTableColumnTemplateLengthForSelectedDatabase(row: TableColumnTemplateGridRow, value: string) {
  const databaseType = editTableColumnTemplateDatabaseType.value;
  const baseType = tableColumnTemplateBaseTypeForSelectedDatabase(row);
  if (!baseType || isDataTypeLengthDisabled(databaseType, baseType)) return;
  setTableColumnTemplateDataTypeForSelectedDatabase(row, combineDataTypeForDatabase(databaseType, baseType, value));
}

function isTableColumnTemplateLengthDisabled(row: TableColumnTemplateGridRow): boolean {
  const baseType = tableColumnTemplateBaseTypeForSelectedDatabase(row);
  return !baseType || isDataTypeLengthDisabled(editTableColumnTemplateDatabaseType.value, baseType);
}

function onExecuteModeChange(v: any) {
  if (v === "all" || v === "current") editExecuteMode.value = v;
}

function onSqlSemanticDiagnosticsEnabledChange(value: boolean) {
  editSqlSemanticDiagnosticsEnabled.value = value;
  editSqlSemanticDiagnosticsMode.value = value ? "enabled" : "disabled";
}

function onFontFamilyChange(v: any) {
  if (typeof v === "string") editFontFamily.value = v;
}

function onTableFontFamilyChange(v: any) {
  if (typeof v === "string") editTableFontFamily.value = v;
}

function onUiFontFamilyChange(v: any) {
  if (typeof v === "string") editUiFontFamily.value = v;
}

const themeSelectValue = computed(() => {
  if (editTheme.value === "custom") {
    return `custom:${editActiveCustomThemeId.value}`;
  }
  return editTheme.value;
});

const themeSelectOptions = computed(() => [
  ...EDITOR_THEMES.filter((theme) => theme.value !== "custom").map((theme) => ({
    value: theme.value,
    label: theme.value === "app" ? t("settings.followAppTheme") : theme.label,
    dark: theme.dark,
    isCustom: false,
  })),
  ...editCustomThemes.value.map((theme) => ({
    value: `custom:${theme.id}`,
    label: theme.name,
    dark: true,
    isCustom: true,
  })),
]);

function onThemeChange(v: any) {
  if (typeof v !== "string") return;
  if (v.startsWith("custom:")) {
    editTheme.value = "custom";
    editActiveCustomThemeId.value = v.slice(7);
  } else {
    editTheme.value = v as typeof DEFAULT_EDITOR_SETTINGS.theme;
  }
}

function handleThemeSave(updatedThemes: CustomTheme[], activeId: string) {
  editCustomThemes.value = updatedThemes;
  editActiveCustomThemeId.value = activeId;
  editTheme.value = "custom";
  showThemeCustomizer.value = false;
}

function onDisconnectTabHandlingModeChange(v: any) {
  if (v === "close-tabs" || v === "keep-tabs-clear-results" || v === "keep-tabs-keep-results") {
    editDisconnectTabHandlingMode.value = v;
  }
}

function onLocaleChange(v: any) {
  if (typeof v === "string") void setLocale(v as Locale);
}

function onUpdateDownloadSourceChange(v: any) {
  if (v === "official" || v === "cnb") editUpdateDownloadSource.value = v;
}

function setSidebarObjectDisplay(value: "grouped" | "simple") {
  editSidebarObjectDisplay.value = value;
}

function setIconTheme(value: DesktopIconTheme) {
  editIconTheme.value = value;
}

function onShortcutChange(actionId: ShortcutActionId, value: any) {
  if (typeof value !== "string") return;
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
  if (!definition) return;
  editShortcuts.value = { ...editShortcuts.value, [actionId]: value };
}

function onShortcutKeydown(actionId: ShortcutActionId, event: KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  if (editingShortcutId.value !== actionId) return;
  if (event.key === "Escape") {
    editingShortcutId.value = null;
    return;
  }
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
  const shortcut = definition?.inputKind === "modifier-only" ? eventToModifierOnlyShortcut(event) : eventToShortcut(event);
  if (!shortcut) return;
  onShortcutChange(actionId, shortcut);
  editingShortcutId.value = null;
}

function formatShortcutPill(shortcut: string): string {
  return formatShortcutDisplay(shortcut);
}

const shortcutPressShortcutLabel = computed(() => t("settings.shortcutPressShortcut"));
const shortcutPressShortcutInputWidth = computed(() => `${shortcutPressShortcutLabel.value.length + 2}em`);

function focusShortcutInput(actionId: ShortcutActionId) {
  editingShortcutId.value = actionId;
  const input = document.querySelector<HTMLInputElement>(`[data-shortcut-input="${actionId}"]`);
  requestAnimationFrame(() => {
    input?.focus();
    input?.select();
  });
}

function cancelShortcutEdit() {
  editingShortcutId.value = null;
}

function resetShortcut(actionId: ShortcutActionId) {
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.id === actionId);
  if (!definition) return;
  editShortcuts.value = { ...editShortcuts.value, [actionId]: definition.defaultShortcut };
}

function clearShortcut(actionId: ShortcutActionId) {
  editShortcuts.value = { ...editShortcuts.value, [actionId]: "" };
}

function setAppLayout(value: InterfaceLayout) {
  editAppLayout.value = value;
}

function setTabLayout(value: "scroll" | "wrap") {
  editTabLayout.value = value;
}

function setSidebarActivation(value: "single" | "double") {
  editSidebarActivation.value = value;
}

const activeSettingsTab = ref("appearance");
const isWeb = !isTauriRuntime();
const appSupportInfo = ref<AppSupportInfo | null>(null);
const appSupportInfoLoading = ref(false);
const appSupportInfoError = ref("");
const appSupportInfoCopied = ref(false);
const appSupportInfoLabels = computed<AppSupportInfoLabels>(() => ({
  appVersion: t("settings.supportInfoAppVersion"),
  runtime: t("settings.supportInfoRuntime"),
  runtimeDesktop: t("settings.supportInfoRuntimeDesktop"),
  runtimeWeb: t("settings.supportInfoRuntimeWeb"),
  operatingSystem: t("settings.supportInfoOperatingSystem"),
  architecture: t("settings.supportInfoArchitecture"),
  unknown: t("settings.supportInfoUnknown"),
}));
const appSupportInfoRows = computed(() => (appSupportInfo.value ? buildAppSupportInfoRows(appSupportInfo.value, appSupportInfoLabels.value) : []));
type SettingsCategory = "editor" | "formatter" | "appearance" | "navigation" | "data" | "backups" | "tunnels" | "shortcuts" | "snippets" | "sync" | "ai" | "mcp" | "security" | "about";
const settingsCategoryNav = computed<{ value: SettingsCategory; label: string }[]>(() => [
  { value: "appearance", label: t("settings.appearanceTab") },
  { value: "editor", label: t("settings.editorTab") },
  { value: "formatter", label: t("settings.sqlFormatterTab") },
  { value: "navigation", label: t("settings.navigationTab") },
  { value: "data", label: t("settings.dataTab") },
  ...(isWeb ? [] : [{ value: "backups" as const, label: t("databaseBackup.title") }]),
  { value: "tunnels", label: t("settings.tunnelsTab") },
  { value: "shortcuts", label: t("settings.shortcutsTab") },
  { value: "snippets", label: t("settings.snippetsTab") },
  ...(isWeb ? [] : [{ value: "sync" as const, label: t("settings.syncTab") }]),
  { value: "ai", label: t("settings.aiTab") },
  { value: "mcp" as const, label: t("settings.mcpTab") },
  ...(isWeb ? [{ value: "security" as const, label: t("settings.securityTab") }] : []),
  { value: "about", label: t("settings.aboutTab") },
]);
const settingsTabsWithApplyFooter = new Set<SettingsCategory>(["editor", "formatter", "appearance", "navigation", "data", "shortcuts", "snippets"]);

function hasSettingsApplyFooter(value: SettingsCategory): boolean {
  return settingsTabsWithApplyFooter.has(value);
}

function settingsCategoryButton(value: SettingsCategory): string {
  return [
    "settings-category-button w-auto shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-left text-sm transition-colors lg:w-full",
    value === activeSettingsTab.value ? "settings-category-button--active bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground",
  ].join(" ");
}

function openExternalUrl(url: string) {
  if (isTauriRuntime()) {
    import("@tauri-apps/plugin-shell").then(({ open }) => open(url));
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function copyDebugLogs() {
  await copyToClipboard(await getDebugLogBundleText());
  debugLogCopied.value = true;
  window.setTimeout(() => {
    debugLogCopied.value = false;
  }, 1500);
}

function fallbackAppSupportInfo(): AppSupportInfo {
  return {
    appVersion: props.appVersion || "",
    runtime: isWeb ? "web" : "desktop",
    osName: "",
    osVersion: null,
    arch: "",
  };
}

async function refreshAppSupportInfo() {
  if (appSupportInfoLoading.value) return;
  appSupportInfoLoading.value = true;
  appSupportInfoError.value = "";
  try {
    appSupportInfo.value = await getAppSupportInfo();
  } catch (e: any) {
    appSupportInfo.value = appSupportInfo.value || fallbackAppSupportInfo();
    appSupportInfoError.value = e?.message || String(e);
  } finally {
    appSupportInfoLoading.value = false;
  }
}

async function copyAppSupportInfo() {
  if (!appSupportInfo.value) await refreshAppSupportInfo();
  if (!appSupportInfo.value) return;
  try {
    await copyToClipboard(formatAppSupportInfoForClipboard(appSupportInfo.value, appSupportInfoLabels.value));
    appSupportInfoCopied.value = true;
    window.setTimeout(() => {
      appSupportInfoCopied.value = false;
    }, 1500);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function clearDebugLogs() {
  clearStoredDebugLogs();
  debugLogCopied.value = false;
  debugLogDownloaded.value = false;
}

async function exportDebugLogs() {
  const saved = await downloadDebugLogs();
  if (!saved) return;
  debugLogDownloaded.value = true;
  window.setTimeout(() => {
    debugLogDownloaded.value = false;
  }, 1500);
}

// ---------- MCP Server ----------
type McpConfigTab = "claude" | "cursor" | "trae" | "vscode" | "windsurf" | "codex" | "opencode" | "cherry-studio";
type McpCopyKind = "install" | `${McpConfigTab}-config`;

const mcpStatus = ref<McpServerStatus | null>(null);
const mcpStatusLoading = ref(false);
const mcpStatusError = ref("");
const mcpCopied = ref<"" | McpCopyKind>("");
const mcpConfigTab = ref<McpConfigTab>("claude");
const MCP_READONLY_STORAGE_KEY = "dbx-mcp-config-readonly";
const MCP_SCOPE_CONNECTION_STORAGE_KEY = "dbx-mcp-config-scope-connection";
const mcpPolicyLoading = ref(false);
const mcpPolicySaving = ref(false);
const mcpPolicyLoadError = ref("");
const mcpInstalling = ref(false);
const mcpInstallMessage = ref("");
const mcpInstallError = ref(false);
const mcpExecutionMode = computed(() => mcpExecutionModeFromPolicy(settingsStore.mcpGlobalPolicy));
const mcpExecutionModeOptions: McpExecutionMode[] = ["read_only", "safe_write", "high_risk_write"];
const mcpAllowedConnectionIds = computed(() => settingsStore.mcpGlobalPolicy.allowedConnectionIds);
const mcpSelectableConnections = computed(() => connectionStore.connections);
const mcpPolicyControlsDisabled = computed(() =>
  isMcpPolicyMutationBlocked({
    loading: mcpPolicyLoading.value,
    saving: mcpPolicySaving.value,
    loadError: mcpPolicyLoadError.value,
  }),
);

async function saveMcpPolicy(partial: { readOnly?: boolean; allowDangerousSql?: boolean; allowedConnectionIds?: string[] | null }) {
  if (mcpPolicyControlsDisabled.value) return;
  mcpPolicySaving.value = true;
  try {
    await settingsStore.updateMcpGlobalPolicy(partial);
  } catch (e: any) {
    toast(t("settings.mcpPolicySaveFailed", { error: e?.message || String(e) }), 5000);
  } finally {
    mcpPolicySaving.value = false;
  }
}

function onMcpExecutionModeChange(mode: McpExecutionMode) {
  if (mode === mcpExecutionMode.value) return;
  if (mode === "high_risk_write" && !window.confirm(t("settings.mcpExecutionModeHighRiskConfirm"))) {
    return;
  }
  void saveMcpPolicy(mcpPolicyFieldsForExecutionMode(mode));
}

function onMcpExecutionModeKeydown(event: KeyboardEvent, mode: McpExecutionMode) {
  if (mcpPolicyControlsDisabled.value) return;
  const currentIndex = mcpExecutionModeOptions.indexOf(mode);
  let nextIndex: number | undefined;
  if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = mcpExecutionModeOptions.length - 1;
  else if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (currentIndex + 1) % mcpExecutionModeOptions.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (currentIndex - 1 + mcpExecutionModeOptions.length) % mcpExecutionModeOptions.length;
  if (nextIndex === undefined || nextIndex === currentIndex) return;

  event.preventDefault();
  event.stopPropagation();
  const nextMode = mcpExecutionModeOptions[nextIndex];
  // These cards visually replace native radios, so preserve the radio-group keyboard contract.
  const currentTarget = event.currentTarget;
  const group = currentTarget instanceof HTMLElement ? currentTarget.closest<HTMLElement>('[role="radiogroup"]') : null;
  group?.querySelector<HTMLElement>(`[data-mcp-execution-mode="${nextMode}"]`)?.focus();
  onMcpExecutionModeChange(nextMode);
}

function onMcpAllowedConnectionIdsChange(allowedConnectionIds: string[] | null) {
  void saveMcpPolicy({ allowedConnectionIds });
}

const mcpLaunchConfig = computed<McpLaunchConfig | undefined>(() => {
  if (isWeb) {
    return {
      command: "dbx-mcp-server",
      env: {
        DBX_WEB_URL: mcpWebBackendUrl(window.location.origin, apiUrl("/api")),
        DBX_WEB_PASSWORD: "your-web-login-password",
      },
    };
  }
  if (mcpStatus.value?.node_path && mcpStatus.value.script_path) {
    return {
      command: mcpStatus.value.node_path,
      args: [mcpStatus.value.script_path],
    };
  }
  if (mcpStatus.value?.bin_path) {
    return { command: mcpStatus.value.bin_path };
  }
  return undefined;
});

const mcpJsonRecommendedConfig = computed(() => buildMcpJsonConfig(mcpLaunchConfig.value));

const mcpTraeRecommendedConfig = computed(() => {
  // TRAE currently splits Windows executable paths containing spaces, so bypass Node and launch the native MCP binary directly.
  const nativeBinPath = !isWeb && isWindows() ? mcpStatus.value?.native_bin_path : undefined;
  return buildMcpTraeConfig(mcpLaunchConfig.value, nativeBinPath ?? undefined);
});

const mcpVsCodeRecommendedConfig = computed(() => buildMcpVsCodeConfig(mcpLaunchConfig.value));

const mcpCherryStudioRecommendedConfig = computed(() => buildMcpCherryStudioConfig(mcpLaunchConfig.value));

const mcpCodexRecommendedConfig = computed(() => buildMcpCodexConfig(mcpLaunchConfig.value));

const mcpOpenCodeRecommendedConfig = computed(() => buildMcpOpenCodeConfig(mcpLaunchConfig.value));

const mcpStatusTone = computed<"ok" | "warning" | "muted">(() => {
  if (!mcpStatus.value) return "muted";
  if (!mcpStatus.value.installed || mcpStatus.value.update_available || mcpStatus.value.error) return "warning";
  return "ok";
});

const mcpStatusLabel = computed(() => {
  if (mcpStatusLoading.value) return t("settings.mcpChecking");
  if (mcpStatusError.value) return t("settings.mcpStatusError");
  if (!mcpStatus.value) return t("settings.mcpStatusUnknown");
  if (!mcpStatus.value.installed) return t("settings.mcpNotInstalled");
  if (mcpStatus.value.update_available) return t("settings.mcpUpdateAvailable");
  return t("settings.mcpReady");
});

const mcpCommand = computed(() => {
  if (!mcpStatus.value) return "npm install -g @dbx-app/mcp-server@latest --registry=https://registry.npmjs.org";
  return mcpStatus.value.installed ? mcpStatus.value.update_command : mcpStatus.value.install_command;
});

async function refreshMcpStatus() {
  if (mcpStatusLoading.value) return;
  mcpStatusLoading.value = true;
  mcpStatusError.value = "";
  try {
    mcpStatus.value = await checkMcpServerStatus();
  } catch (e: any) {
    mcpStatusError.value = e?.message || String(e);
  } finally {
    mcpStatusLoading.value = false;
  }
}

async function copyMcpText(kind: McpCopyKind, value: string) {
  mcpCopied.value = kind;
  try {
    await copyToClipboard(value);
  } catch {
    mcpCopied.value = "";
    return;
  }
  window.setTimeout(() => {
    if (mcpCopied.value === kind) mcpCopied.value = "";
  }, 1500);
}

async function installMcp() {
  if (mcpInstalling.value) return;
  mcpInstalling.value = true;
  mcpInstallMessage.value = "";
  mcpInstallError.value = false;
  try {
    const result = await installMcpServer();
    mcpInstallMessage.value = result;
    mcpInstallError.value = false;
    // 安装成功后刷新状态
    await refreshMcpStatus();
  } catch (e: any) {
    mcpInstallMessage.value = e?.message || String(e);
    mcpInstallError.value = true;
  } finally {
    mcpInstalling.value = false;
    // 3秒后清除消息
    window.setTimeout(() => {
      mcpInstallMessage.value = "";
      mcpInstallError.value = false;
    }, 3000);
  }
}

// ---------- WebDAV Sync ----------
const webdavEndpoint = ref(localStorage.getItem("dbx-webdav-endpoint") || "");
const webdavUsername = ref(localStorage.getItem("dbx-webdav-username") || "");
const webdavPassword = ref("");
const webdavRememberPassword = ref(localStorage.getItem("dbx-webdav-remember-password") === "true");
const webdavHasSavedPassword = ref(false);
const webdavRemotePath = ref(localStorage.getItem("dbx-webdav-remote-path") || DEFAULT_WEB_DAV_REMOTE_PATH);
const webdavSyncSecrets = ref(false);
const webdavSecretsPassphrase = ref("");
const webdavHasSavedSecretsPassphrase = ref(false);
const webdavAutoUploadEnabled = ref(localStorage.getItem("dbx-webdav-auto-upload-enabled") === "true");
const webdavAutoUploadIntervalMinutes = ref(Number(localStorage.getItem("dbx-webdav-auto-upload-interval-minutes") || String(DEFAULT_WEB_DAV_AUTO_UPLOAD_INTERVAL_MINUTES)));
const webdavBusy = ref<"" | "test" | "upload" | "download">("");
const webdavMessage = ref("");
const webdavError = ref(false);
const syncMethodTab = ref<"webdav" | "snippet">("webdav");

const snippetProvider = ref<SnippetProvider>((localStorage.getItem("dbx-snippet-provider") as SnippetProvider) || "github");
const snippetId = ref(localStorage.getItem(`dbx-snippet-id-${snippetProvider.value}`) || "");
const snippetToken = ref("");
const snippetRememberToken = ref(localStorage.getItem(`dbx-snippet-remember-token-${snippetProvider.value}`) === "true");
const snippetHasSavedToken = ref(false);
const snippetBusy = ref<"" | "test" | "upload" | "download">("");
const snippetMessage = ref("");
const snippetError = ref(false);

const webdavReady = computed(() => !!webdavEndpoint.value.trim() && !webdavBusy.value && (!webdavSyncSecrets.value || !!webdavSecretsPassphrase.value.trim() || webdavHasSavedSecretsPassphrase.value));
const snippetReady = computed(() => !snippetBusy.value && (!!snippetToken.value.trim() || snippetHasSavedToken.value));

function currentSnippetConfig(): SnippetSyncConfig {
  return {
    provider: snippetProvider.value,
    token: snippetToken.value.trim() || undefined,
    snippetId: snippetId.value.trim() || undefined,
  };
}

function currentSnippetAccountConfig(): SnippetSyncConfig {
  return { ...currentSnippetConfig(), token: undefined };
}

async function refreshSnippetTokenStatus() {
  try {
    const status = await snippetTokenStatus(currentSnippetAccountConfig());
    snippetHasSavedToken.value = status.hasSavedToken;
    if (status.hasSavedToken) snippetRememberToken.value = true;
  } catch {
    snippetHasSavedToken.value = false;
  }
}

async function applySnippetTokenPreference() {
  const token = snippetToken.value.trim();
  if (snippetRememberToken.value && token) {
    await saveSnippetSavedToken(currentSnippetAccountConfig(), token);
    snippetHasSavedToken.value = true;
    return;
  }
  if (!snippetRememberToken.value && snippetHasSavedToken.value) {
    await forgetSnippetSavedToken(currentSnippetAccountConfig());
    snippetHasSavedToken.value = false;
  }
}

async function runSnippetAction(kind: "test" | "upload" | "download", action: () => Promise<string>) {
  snippetBusy.value = kind;
  snippetMessage.value = "";
  snippetError.value = false;
  try {
    localStorage.setItem("dbx-snippet-provider", snippetProvider.value);
    localStorage.setItem(`dbx-snippet-id-${snippetProvider.value}`, snippetId.value.trim());
    localStorage.setItem(`dbx-snippet-remember-token-${snippetProvider.value}`, String(snippetRememberToken.value));
    await applySnippetTokenPreference();
    await applyWebDavSyncSecretsPreference();
    snippetMessage.value = await action();
  } catch (e: any) {
    snippetMessage.value = e?.message || String(e);
    snippetError.value = true;
  } finally {
    snippetBusy.value = "";
  }
}

async function testSnippetSync() {
  await runSnippetAction("test", async () => {
    await snippetSyncTest(currentSnippetConfig());
    return t("settings.syncSnippetTestSuccess");
  });
}

async function uploadSnippetSnapshot() {
  await runSnippetAction("upload", async () => {
    const summary = await snippetSyncUpload(currentSnippetConfig(), settingsStore.editorSettings, webdavSyncSecrets.value ? webdavSecretsPassphrase.value : undefined);
    snippetId.value = summary.snippetId;
    localStorage.setItem(`dbx-snippet-id-${snippetProvider.value}`, summary.snippetId);
    return t("settings.syncSnippetUploadSuccess", { bytes: summary.bytes, id: summary.snippetId });
  });
}

async function downloadSnippetSnapshot() {
  if (!snippetId.value.trim() || !window.confirm(t("settings.syncDownloadConfirm"))) return;
  await runSnippetAction("download", async () => {
    const result = await snippetSyncDownload(currentSnippetConfig(), webdavSyncSecrets.value ? webdavSecretsPassphrase.value : undefined);
    if (result.editorSettings && typeof result.editorSettings === "object") settingsStore.updateEditorSettings(result.editorSettings as any);
    await settingsStore.updateDesktopSettings(result.desktopSettings);
    await connectionStore.initFromDisk();
    await savedSqlStore.initFromStorage();
    // Snapshot downloads replace backend-managed tunnel profiles, so refresh
    // the already-loaded Pinia store instead of leaving the UI stale.
    await tunnelProfileStore.refresh();
    await settingsStore.reloadAiConfigs();
    let message = t("settings.syncSnippetDownloadSuccess", { bytes: result.summary.bytes, id: result.summary.snippetId });
    if (result.applySummary.encryptedSecretsPresent && !result.applySummary.secretsApplied) message += ` ${t("settings.syncSecretsSkipped")}`;
    if (result.applySummary.secretsApplied) message += ` ${t("settings.syncSecretsApplied")}`;
    return message;
  });
}

function currentWebDavConfig(): WebDavConfig {
  return {
    endpoint: webdavEndpoint.value.trim(),
    username: webdavUsername.value.trim() || undefined,
    password: webdavPassword.value || undefined,
    remotePath: webdavRemotePath.value.trim() || DEFAULT_WEB_DAV_REMOTE_PATH,
  };
}

function currentWebDavAccountConfig(): WebDavConfig {
  const config = currentWebDavConfig();
  return { ...config, password: undefined };
}

function rememberWebDavFields() {
  writeWebDavAutoUploadFields(currentWebDavConfig(), {
    enabled: webdavAutoUploadEnabled.value,
    intervalMinutes: webdavAutoUploadIntervalMinutes.value,
  });
  window.dispatchEvent(new Event("dbx:webdav-auto-upload-config-changed"));
}

function setWebDavResult(message: string, error = false) {
  webdavMessage.value = message;
  webdavError.value = error;
}

async function runWebDavAction(kind: "test" | "upload" | "download", action: () => Promise<string>) {
  webdavBusy.value = kind;
  webdavMessage.value = "";
  webdavError.value = false;
  try {
    rememberWebDavFields();
    await applyWebDavPasswordPreference();
    await applyWebDavSyncSecretsPreference();
    setWebDavResult(await action());
  } catch (e: any) {
    setWebDavResult(e?.message || String(e), true);
  } finally {
    webdavBusy.value = "";
  }
}

async function refreshWebDavPasswordStatus() {
  if (!webdavEndpoint.value.trim()) {
    webdavHasSavedPassword.value = false;
    webdavRememberPassword.value = false;
    return;
  }
  try {
    const status = await webdavPasswordStatus(currentWebDavAccountConfig());
    webdavHasSavedPassword.value = status.hasSavedPassword;
    if (status.hasSavedPassword) webdavRememberPassword.value = true;
  } catch {
    webdavHasSavedPassword.value = false;
  }
}

async function applyWebDavPasswordPreference() {
  const password = webdavPassword.value;
  if (webdavRememberPassword.value && password) {
    await saveWebdavSavedPassword(currentWebDavAccountConfig(), password);
    webdavHasSavedPassword.value = true;
    return;
  }
  if (!webdavRememberPassword.value && webdavHasSavedPassword.value) {
    await forgetWebdavSavedPassword(currentWebDavAccountConfig());
    webdavHasSavedPassword.value = false;
  }
}

async function refreshWebDavSyncSecretsStatus() {
  try {
    const status = await webdavSyncSecretsStatus();
    webdavSyncSecrets.value = status.enabled;
    webdavHasSavedSecretsPassphrase.value = status.hasSavedPassphrase;
  } catch {
    webdavSyncSecrets.value = false;
    webdavHasSavedSecretsPassphrase.value = false;
  }
}

async function applyWebDavSyncSecretsPreference() {
  const passphrase = webdavSecretsPassphrase.value.trim();
  if (!webdavSyncSecrets.value) {
    await saveWebdavSyncSecretsPreference(false);
    return;
  }
  await saveWebdavSyncSecretsPreference(true, passphrase || undefined);
  if (passphrase) {
    webdavHasSavedSecretsPassphrase.value = true;
    webdavSecretsPassphrase.value = "";
  }
}

async function clearWebDavSyncSecretsPassphrase() {
  try {
    await forgetWebdavSyncSecretsPassphrase();
    webdavHasSavedSecretsPassphrase.value = false;
    webdavSecretsPassphrase.value = "";
  } catch (e: any) {
    setWebDavResult(e?.message || String(e), true);
  }
}

async function testWebDav() {
  await runWebDavAction("test", async () => {
    await webdavSyncTest(currentWebDavConfig());
    return t("settings.syncTestSuccess");
  });
}

async function uploadWebDavSnapshot() {
  await runWebDavAction("upload", async () => {
    const summary = await webdavSyncUpload(currentWebDavConfig(), settingsStore.editorSettings, webdavSyncSecrets.value ? webdavSecretsPassphrase.value : undefined);
    return t("settings.syncUploadSuccess", { bytes: summary.bytes, path: summary.remotePath });
  });
}

async function downloadWebDavSnapshot() {
  if (!window.confirm(t("settings.syncDownloadConfirm"))) return;
  await runWebDavAction("download", async () => {
    const result = await webdavSyncDownload(currentWebDavConfig(), webdavSyncSecrets.value ? webdavSecretsPassphrase.value : undefined);
    if (result.editorSettings && typeof result.editorSettings === "object") {
      settingsStore.updateEditorSettings(result.editorSettings as any);
    }
    await settingsStore.updateDesktopSettings(result.desktopSettings);
    await connectionStore.initFromDisk();
    await savedSqlStore.initFromStorage();
    // Keep the shared tunnel profile UI consistent with the downloaded snapshot.
    await tunnelProfileStore.refresh();
    await settingsStore.reloadAiConfigs();
    const message = t("settings.syncDownloadSuccess", {
      bytes: result.summary.bytes,
      path: result.summary.remotePath,
    });
    if (result.applySummary.encryptedSecretsPresent && !result.applySummary.secretsApplied) {
      return `${message} ${t("settings.syncSecretsSkipped")}`;
    }
    if (result.applySummary.secretsApplied) {
      return `${message} ${t("settings.syncSecretsApplied")}`;
    }
    return message;
  });
}

const oldPassword = ref("");
const newPassword = ref("");
const confirmNewPassword = ref("");
const passwordMessage = ref("");
const passwordError = ref(false);
const changingPassword = ref(false);

async function scrollToInitialSettingsSection() {
  await nextTick();
  if (props.initialSection === "tableColumnTemplates") {
    tableColumnTemplateSectionRef.value?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
}

// AI Config List Mode — declared before the immediate watcher to avoid TDZ crash
const aiConfigListMode = ref<"list" | "edit">("list");
const aiEditConfigName = ref("");
const aiEditConfigId = ref<string | null>(null);
const displayedAiConfigs = computed(() => orderAiConfigsForDisplay(settingsStore.aiConfigs));

watch(
  () => settingsVisible.value,
  async (open) => {
    if (open) {
      mcpPolicyLoading.value = true;
      mcpPolicyLoadError.value = "";
      aiConfigListMode.value = "list";
      aiEditConfigId.value = null;
      activeSettingsTab.value = props.initialTab || "appearance";
      passwordMessage.value = "";
      oldPassword.value = "";
      newPassword.value = "";
      confirmNewPassword.value = "";
      try {
        await settingsStore.initMcpGlobalPolicy(true);
        if (!settingsStore.mcpGlobalPolicy.configured && localStorage.getItem(MCP_READONLY_STORAGE_KEY) === "true") {
          await settingsStore.updateMcpGlobalPolicy({ readOnly: true });
        }
        if (settingsStore.mcpGlobalPolicy.configured) localStorage.removeItem(MCP_READONLY_STORAGE_KEY);
        localStorage.removeItem(MCP_SCOPE_CONNECTION_STORAGE_KEY);
      } catch (e: any) {
        mcpPolicyLoadError.value = e?.message || String(e);
        toast(t("settings.mcpPolicyLoadFailed", { error: mcpPolicyLoadError.value }), 5000);
      } finally {
        mcpPolicyLoading.value = false;
      }
      await settingsStore.initAiConfigs();
      await settingsStore.initDesktopSettings();
      editShowTrayIcon.value = settingsStore.desktopSettings.show_tray_icon;
      editQuitOnClose.value = settingsStore.desktopSettings.quit_on_close;
      editIconTheme.value = settingsStore.desktopSettings.icon_theme;
      editDebugLoggingEnabled.value = settingsStore.desktopSettings.debug_logging_enabled;
      editDuckDbWorkerProcessIsolation.value = settingsStore.desktopSettings.duckdb_worker_process_isolation;
      editDuckDbWorkerMaxProcesses.value = settingsStore.desktopSettings.duckdb_worker_max_processes;
      if (!duckDbWorkerStartupCaptured.value) {
        startupDuckDbWorkerProcessIsolation.value = settingsStore.desktopSettings.duckdb_worker_process_isolation;
        startupDuckDbWorkerMaxProcesses.value = settingsStore.desktopSettings.duckdb_worker_max_processes;
        duckDbWorkerStartupCaptured.value = true;
      }
      editSidebarTablePageSize.value = settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE;
      webdavPassword.value = "";
      snippetToken.value = "";
      webdavSecretsPassphrase.value = "";
      await refreshWebDavPasswordStatus();
      await refreshWebDavSyncSecretsStatus();
      await refreshSnippetTokenStatus();
      syncAiEditState();
      if (!isWeb && activeSettingsTab.value === "mcp") void refreshMcpStatus();
      if (!isWeb && activeSettingsTab.value === "ai" && aiIsCliProvider.value) void ensureCliMcpStatus();
      if (activeSettingsTab.value === "about") void refreshAppSupportInfo();
      await scrollToInitialSettingsSection();
    }
  },
  { immediate: true },
);

watch(
  () => props.initialSection,
  () => {
    if (settingsVisible.value) void scrollToInitialSettingsSection();
  },
);

watch(
  () => props.initialTab,
  (tab) => {
    if (!settingsVisible.value || !tab) return;
    activeSettingsTab.value = tab;
    void scrollToInitialSettingsSection();
  },
);

watch([webdavEndpoint, webdavUsername], () => {
  void refreshWebDavPasswordStatus();
});
watch(webdavRememberPassword, (val) => {
  localStorage.setItem("dbx-webdav-remember-password", String(val));
});
watch([webdavAutoUploadEnabled, webdavAutoUploadIntervalMinutes], () => {
  webdavAutoUploadIntervalMinutes.value = normalizedWebDavAutoUploadInterval(webdavAutoUploadIntervalMinutes.value);
  rememberWebDavFields();
});
watch(snippetProvider, (provider) => {
  localStorage.setItem("dbx-snippet-provider", provider);
  snippetId.value = localStorage.getItem(`dbx-snippet-id-${provider}`) || "";
  snippetRememberToken.value = localStorage.getItem(`dbx-snippet-remember-token-${provider}`) === "true";
  snippetToken.value = "";
  void refreshSnippetTokenStatus();
});

watch(activeSettingsTab, async (tab) => {
  if (tab === "mcp" && !mcpStatus.value && !mcpStatusLoading.value) void refreshMcpStatus();
  if (tab === "ai" && aiIsCliProvider.value) void ensureCliMcpStatus();
  if (tab === "ai") {
    // Await completion so we don't snapshot an empty default when the store
    // is still loading its first payload (init via App.vue is fire-and-forget).
    await promptTemplateStore.ensureLoaded();
    editGlobalInstructions.value = promptTemplateStore.globalInstructions;
  }
  if (tab === "about" && !appSupportInfo.value) void refreshAppSupportInfo();
  if (tab === "appearance") {
    checkLayoutDescTruncation();
    checkIconThemeDescTruncation();
  }
});

// If the store finishes loading while the AI tab is already open (e.g. a retry
// from another entry point succeeded after the tab-switch snapshot saw a failed
// load), backfill the textarea — but never clobber text the user already typed.
watch(
  () => promptTemplateStore.isLoaded,
  (loaded) => {
    if (loaded && activeSettingsTab.value === "ai" && !editGlobalInstructions.value) {
      editGlobalInstructions.value = promptTemplateStore.globalInstructions;
    }
  },
);

onMounted(() => {
  void refreshWebDavPasswordStatus();
  checkLayoutDescTruncation();
  checkIconThemeDescTruncation();
  initTruncationObservers();
});

onUnmounted(() => {
  cleanupTableColumnTemplatePointerDrag();
  cleanupTruncationObservers();
});

async function changePassword() {
  if (newPassword.value !== confirmNewPassword.value) {
    passwordMessage.value = t("auth.passwordMismatch");
    passwordError.value = true;
    return;
  }
  changingPassword.value = true;
  passwordMessage.value = "";
  try {
    const res = await fetch(apiUrl("/api/auth/change-password"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ old_password: oldPassword.value, new_password: newPassword.value }),
    });
    if (res.ok) {
      passwordMessage.value = t("auth.passwordChanged");
      passwordError.value = false;
      oldPassword.value = "";
      newPassword.value = "";
      confirmNewPassword.value = "";
    } else if (res.status === 401) {
      passwordMessage.value = t("auth.oldPasswordWrong");
      passwordError.value = true;
    } else {
      passwordMessage.value = t("auth.changePasswordFailed");
      passwordError.value = true;
    }
  } catch {
    passwordMessage.value = t("auth.connectFailed");
    passwordError.value = true;
  } finally {
    changingPassword.value = false;
  }
}

// ---------- AI Settings ----------

// Global Custom Instructions
const editGlobalInstructions = ref("");
const globalInstructionsSaving = ref(false);

// Prompt Templates Management
const templateEditing = ref<PromptTemplate | null>(null);
const templateFormOpen = ref(false);
const templateForm = ref<{ name: string; content: string }>({ name: "", content: "" });
const templateFormIsNew = ref(true);
const templateSaving = ref(false);
const templateDeleteConfirm = ref<PromptTemplate | null>(null);
const templateDeleteConfirmOpen = ref(false);

watch(templateDeleteConfirm, (val) => {
  templateDeleteConfirmOpen.value = val !== null;
});
watch(templateDeleteConfirmOpen, (val) => {
  if (!val) templateDeleteConfirm.value = null;
});

function openNewTemplate() {
  templateForm.value = { name: "", content: "" };
  templateFormIsNew.value = true;
  templateEditing.value = null;
  templateFormOpen.value = true;
}

function openEditTemplate(tpl: PromptTemplate) {
  templateForm.value = { name: tpl.name, content: tpl.content };
  templateFormIsNew.value = false;
  templateEditing.value = tpl;
  templateFormOpen.value = true;
}

function closeTemplateForm() {
  templateForm.value = { name: "", content: "" };
  templateEditing.value = null;
  templateFormOpen.value = false;
}

function templateNameValid(): boolean {
  return templateForm.value.name.trim().length > 0;
}

function templateContentValid(): boolean {
  return templateForm.value.content.trim().length > 0;
}

function templateNameTooLong(): boolean {
  return promptTemplateCharacterCount(templateForm.value.name) > PROMPT_TEMPLATE_NAME_MAX;
}

function templateContentTooLong(): boolean {
  return promptTemplateCharacterCount(templateForm.value.content) > PROMPT_TEMPLATE_CONTENT_MAX;
}

function localNameDuplicate(): boolean {
  const name = templateForm.value.name.trim();
  if (!name) return false;
  const existingId = templateEditing.value?.id ?? "";
  return promptTemplateStore.templates.some((t) => t.id !== existingId && t.name.toLowerCase() === name.toLowerCase());
}

function templateSaveDisabled(): boolean {
  return templateSaving.value || !templateNameValid() || !templateContentValid() || templateNameTooLong() || templateContentTooLong();
}

async function saveTemplateForm() {
  if (templateSaveDisabled()) return;
  templateSaving.value = true;
  try {
    const id = templateEditing.value?.id ?? uuid();
    await promptTemplateStore.save(id, templateForm.value.name.trim(), templateForm.value.content.trim());
    closeTemplateForm();
    toast(t("ai.promptTemplateSaved"));
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    templateSaving.value = false;
  }
}

async function confirmDeleteTemplate(tpl: PromptTemplate) {
  try {
    await promptTemplateStore.remove(tpl.id);
    toast(t("ai.promptTemplateDeleted"));
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    templateDeleteConfirm.value = null;
  }
}

async function saveGlobalInstructions() {
  if (promptTemplateCharacterCount(editGlobalInstructions.value) > GLOBAL_INSTRUCTIONS_MAX) return;
  globalInstructionsSaving.value = true;
  try {
    await promptTemplateStore.saveGlobalInstructions(editGlobalInstructions.value);
    toast(t("ai.globalInstructionsSaved"));
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    globalInstructionsSaving.value = false;
  }
}

function globalInstructionsTooLong(): boolean {
  return promptTemplateCharacterCount(editGlobalInstructions.value) > GLOBAL_INSTRUCTIONS_MAX;
}

// AI Config Delete Confirmation
const aiDeleteConfirmOpen = ref(false);
const aiDeleteConfigId = ref<string | null>(null);

// Model list management
const aiEditModels = ref<AiConfiguredModel[]>([]);
const aiModelListLoading = ref(false);
let aiModelListRequestToken = 0;

// AI Model Multi-Select
const aiModelMultiSelectOpen = ref(false);
const aiModelMultiSelectSearch = ref("");
const aiFetchedModels = ref<AiModelInfo[]>([]);

const CLI_AI_PROVIDERS = new Set<AiProvider>(["claude-code-cli", "codex-cli"]);
const aiProviderOptions = computed(() => Object.values(AI_PROVIDER_PRESETS).filter((provider) => !isWeb || !CLI_AI_PROVIDERS.has(provider.provider)));
const selectedAiProviderPreset = computed(() => AI_PROVIDER_PRESETS[aiEditProvider.value]);

const aiEditProvider = ref<AiProvider>("claude");
const aiEditApiKey = ref("");
const aiEditAuthMethod = ref<AiAuthMethod>("api-key");
const aiEditEndpoint = ref("");
const aiEditModel = ref("");
const aiEditApiStyle = ref<AiApiStyle>("completions");
const aiEditProxyEnabled = ref(false);
const aiEditProxyUrl = ref("");
const aiEditEnableThinking = ref(true);
const aiEditReasoningLevel = ref<AiReasoningLevel>("default");
const aiEditContextWindow = ref<number | undefined>(undefined);
const aiEditCodexCliPath = ref("");
const aiEditCodexCliEnvRows = ref<AiEnvRow[]>([]);
const aiEditClaudeCodeCliPath = ref("");
const aiEditClaudeCodeCliEnvRows = ref<AiEnvRow[]>([]);

const aiModelError = ref("");

const aiCompletionsMode = computed(() => aiEditApiStyle.value === "completions");
const aiAnthropicMessagesMode = computed(() => aiEditApiStyle.value === "anthropic-messages");
const codexReasoningLevelOptions: Array<{ value: AiReasoningLevel; labelKey: string }> = [
  { value: "default", labelKey: "ai.reasoningLevelDefault" },
  { value: "minimal", labelKey: "ai.reasoningLevelMinimal" },
  { value: "low", labelKey: "ai.reasoningLevelLow" },
  { value: "medium", labelKey: "ai.reasoningLevelMedium" },
  { value: "high", labelKey: "ai.reasoningLevelHigh" },
];
const effortLevelLabelKeys: Record<AiEffortLevel, string> = {
  low: "ai.reasoningLevelLow",
  medium: "ai.reasoningLevelMedium",
  high: "ai.reasoningLevelHigh",
  xhigh: "ai.reasoningLevelXhigh",
  max: "ai.reasoningLevelMax",
};

const aiTesting = ref(false);
const aiTestResult = ref<"" | "success" | "error">("");
const aiTestError = ref("");
const aiTestLatency = ref<number | null>(null);
const aiTestErrorCopied = ref(false);
const aiIsCodexCli = computed(() => aiEditProvider.value === "codex-cli");
const aiIsClaudeCodeCli = computed(() => aiEditProvider.value === "claude-code-cli");
const aiIsCliProvider = computed(() => CLI_AI_PROVIDERS.has(aiEditProvider.value));
const aiCliProviderLabel = computed(() => selectedAiProviderPreset.value.label);
const aiCliCommandName = computed(() => (aiIsClaudeCodeCli.value ? "claude" : "codex"));
const aiCliLoginCommand = computed(() => (aiIsClaudeCodeCli.value ? "claude auth login" : "codex login"));
const aiEditCliPath = computed({
  get: () => (aiIsClaudeCodeCli.value ? aiEditClaudeCodeCliPath.value : aiEditCodexCliPath.value),
  set: (value: string) => {
    if (aiIsClaudeCodeCli.value) {
      aiEditClaudeCodeCliPath.value = value;
    } else {
      aiEditCodexCliPath.value = value;
    }
  },
});
const aiEditCliEnvRows = computed(() => (aiIsClaudeCodeCli.value ? aiEditClaudeCodeCliEnvRows.value : aiEditCodexCliEnvRows.value));
watch(aiIsCliProvider, (isCliProvider) => {
  if (isCliProvider) void ensureCliMcpStatus();
});
const aiRequiresApiKey = computed(() => AI_PROVIDER_PRESETS[aiEditProvider.value].requiresApiKey);
const aiSupportsAuthMethod = computed(() => aiEditProvider.value === "claude" || (aiEditProvider.value === "custom" && aiAnthropicMessagesMode.value));
const aiCredentialLabel = computed(() => (aiSupportsAuthMethod.value && aiEditAuthMethod.value === "bearer" ? "Auth Token" : "API Key"));
const aiCredentialPlaceholder = computed(() => {
  if (!aiRequiresApiKey.value) return "Optional";
  if (aiSupportsAuthMethod.value && aiEditAuthMethod.value === "bearer") return "ANTHROPIC_AUTH_TOKEN";
  return "";
});
const aiEndpointPlaceholder = computed(() => {
  if (aiEditProvider.value === "custom" && aiAnthropicMessagesMode.value) {
    return "https://api.example.com/v1/messages";
  }
  if (aiEditProvider.value === "openai-compatible" || aiEditProvider.value === "custom") {
    return "https://api.example.com/v1";
  }
  return "https://api.openai.com/v1";
});
const aiEndpointHint = computed(() => {
  if (aiEditProvider.value === "custom" && aiAnthropicMessagesMode.value) {
    return t("ai.anthropicMessagesHint");
  }
  if (aiEditProvider.value === "openai-compatible" || aiEditProvider.value === "custom") {
    return "大多数 OpenAI 兼容 API 需要 /v1 路径前缀";
  }
  return "";
});
const aiSupportsApiStyle = computed(() => !aiIsCliProvider.value && (aiEditProvider.value === "openai" || aiEditProvider.value === "openai-compatible" || aiEditProvider.value === "custom"));
const aiSupportsAnthropicApiStyle = computed(() => aiEditProvider.value === "custom");
const aiCliMcpNeedsInstall = computed(() => aiIsCliProvider.value && (!mcpStatus.value || !mcpStatus.value.installed));
const aiCliMcpCanInstall = computed(() => {
  const status = mcpStatus.value;
  return !mcpInstalling.value && !!status?.npm_available && (!status.installed || status.update_available);
});
const aiCliMcpActionLabel = computed(() => {
  if (!mcpStatus.value?.installed) return t("settings.mcpInstallButton");
  if (mcpStatus.value.update_available) return t("settings.mcpUpdateButton");
  return t("settings.mcpUpToDate");
});
const aiModelListSupported = computed(() => aiEditProvider.value !== "gemini");
const aiCanListModels = computed(() => aiModelListSupported.value && (aiIsCliProvider.value || !!aiEditEndpoint.value.trim()) && (!aiRequiresApiKey.value || !!aiEditApiKey.value.trim()));
const aiCliEnvError = computed(() => cliEnvValidationError());
const aiCliPathError = computed(() => {
  const path = aiEditCliPath.value.trim();
  const firstToken = path.split(/\s+/)[0] || "";
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken) ? t("ai.cliPathEnvError", { provider: aiCliProviderLabel.value }) : "";
});
const aiCliValidationError = computed(() => (aiIsCliProvider.value ? aiCliPathError.value || aiCliEnvError.value : ""));

function aiEnvRowsFromConfig(env: unknown): AiEnvRow[] {
  return Object.entries(normalizeAiEnv(env)).map(([key, value]) => ({ id: uuid(), key, value }));
}

function cliEnvFromRows(rows = aiEditCliEnvRows.value): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.toUpperCase().startsWith("DBX_MCP_")) continue;
    result[key] = row.value;
  }
  return result;
}

function cliEnvValidationError(): string {
  for (const row of aiEditCliEnvRows.value) {
    const key = row.key.trim();
    if (key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return t("ai.cliEnvInvalidName", { name: key });
    if (key.toUpperCase().startsWith("DBX_MCP_")) return t("ai.cliEnvReservedName", { name: key });
  }
  return "";
}

function addCliEnvRow() {
  aiEditCliEnvRows.value.push({ id: uuid(), key: "", value: "" });
}

function removeCliEnvRow(id: string) {
  if (aiIsClaudeCodeCli.value) {
    aiEditClaudeCodeCliEnvRows.value = aiEditClaudeCodeCliEnvRows.value.filter((row) => row.id !== id);
  } else {
    aiEditCodexCliEnvRows.value = aiEditCodexCliEnvRows.value.filter((row) => row.id !== id);
  }
}

function currentAiEditConfig() {
  const reasoningLevel = aiIsClaudeCodeCli.value ? normalizeClaudeCodeReasoningLevel(aiEditReasoningLevel.value, aiSelectedModelInfo.value) : aiEditReasoningLevel.value;
  return {
    provider: aiEditProvider.value,
    apiKey: aiEditApiKey.value,
    authMethod: aiEditAuthMethod.value,
    endpoint: aiEditEndpoint.value,
    model: aiEditModel.value,
    apiStyle: aiEditApiStyle.value,
    proxyEnabled: aiEditProxyEnabled.value,
    proxyUrl: aiEditProxyUrl.value,
    enableThinking: aiEditEnableThinking.value,
    reasoningLevel,
    contextWindow: aiEditContextWindow.value || undefined,
    codexCliPath: aiEditCodexCliPath.value.trim() || undefined,
    codexCliEnv: aiIsCodexCli.value ? cliEnvFromRows(aiEditCodexCliEnvRows.value) : {},
    claudeCodeCliPath: aiEditClaudeCodeCliPath.value.trim() || undefined,
    claudeCodeCliEnv: aiIsClaudeCodeCli.value ? cliEnvFromRows(aiEditClaudeCodeCliEnvRows.value) : {},
  };
}

function syncAiEditState() {
  aiTestResult.value = "";
  aiTestError.value = "";
  aiTestLatency.value = null;
  aiTestErrorCopied.value = false;
}

function aiSelectProvider(provider: AiProvider) {
  if (isWeb && CLI_AI_PROVIDERS.has(provider)) return;
  if (provider === aiEditProvider.value) return;

  // Apply new provider's preset defaults to edit state
  const preset = AI_PROVIDER_PRESETS[provider];
  aiEditProvider.value = provider;
  aiEditApiKey.value = "";
  aiEditAuthMethod.value = preset.authMethod;
  aiEditEndpoint.value = preset.endpoint;
  aiEditModel.value = preset.model;
  aiEditApiStyle.value = preset.apiStyle;
  aiEditReasoningLevel.value = "default";
  aiEditModels.value = [];
  aiFetchedModels.value = [];
  aiLastModelFetchSignature = "";
  aiModelListRequestToken += 1;
  aiModelListLoading.value = false;
  if (CLI_AI_PROVIDERS.has(provider)) void ensureCliMcpStatus();
  if (provider === "claude-code-cli") void aiFetchModelList();
}

function aiSelectApiStyle(style: AiApiStyle) {
  aiEditApiStyle.value = style;
  if (aiEditProvider.value === "custom") {
    aiEditAuthMethod.value = style === "anthropic-messages" ? "api-key" : "bearer";
  }
}

function aiEnterListMode() {
  aiConfigListMode.value = "list";
  aiEditConfigId.value = null;
}

function aiEnterEditMode(configId?: string) {
  aiConfigListMode.value = "edit";
  aiEditConfigId.value = configId || null;

  if (configId) {
    const config = settingsStore.aiConfigs.find((c) => c.id === configId);
    if (config) {
      aiEditConfigName.value = config.name;
      aiEditProvider.value = config.provider;
      aiEditApiKey.value = config.apiKey;
      aiEditAuthMethod.value = config.authMethod;
      aiEditEndpoint.value = config.endpoint;
      aiEditModel.value = config.model;
      aiEditApiStyle.value = config.apiStyle;
      aiEditProxyEnabled.value = config.proxyEnabled ?? false;
      aiEditProxyUrl.value = config.proxyUrl ?? "";
      aiEditEnableThinking.value = config.enableThinking ?? true;
      aiEditReasoningLevel.value = config.reasoningLevel ?? "default";
      aiEditContextWindow.value = config.contextWindow;
      aiEditCodexCliPath.value = config.codexCliPath ?? "";
      aiEditCodexCliEnvRows.value = aiEnvRowsFromConfig(config.codexCliEnv);
      aiEditClaudeCodeCliPath.value = config.claudeCodeCliPath ?? "";
      aiEditClaudeCodeCliEnvRows.value = aiEnvRowsFromConfig(config.claudeCodeCliEnv);
      aiEditModels.value = config.models ? config.models.map((model) => ({ ...model, supportedEffortLevels: model.supportedEffortLevels ? [...model.supportedEffortLevels] : undefined })) : [];
    }
  } else {
    aiEditConfigName.value = "";
    aiEditModels.value = [];
    aiEditProvider.value = "claude";
    aiEditApiKey.value = "";
    aiEditAuthMethod.value = AI_PROVIDER_PRESETS["claude"].authMethod;
    aiEditEndpoint.value = AI_PROVIDER_PRESETS["claude"].endpoint;
    aiEditModel.value = AI_PROVIDER_PRESETS["claude"].model;
    aiEditApiStyle.value = AI_PROVIDER_PRESETS["claude"].apiStyle;
    aiEditProxyEnabled.value = false;
    aiEditProxyUrl.value = "";
    aiEditEnableThinking.value = true;
    aiEditReasoningLevel.value = "default";
    aiEditContextWindow.value = undefined;
    aiEditCodexCliPath.value = "";
    aiEditCodexCliEnvRows.value = [];
    aiEditClaudeCodeCliPath.value = "";
    aiEditClaudeCodeCliEnvRows.value = [];
  }
  aiFetchedModels.value = [];
  aiLastModelFetchSignature = "";
  if (aiIsClaudeCodeCli.value) void aiFetchModelList();
}

function aiAddModel() {
  aiEditModels.value.push({ name: "", label: "" });
}

function aiRemoveModel(index: number) {
  aiEditModels.value.splice(index, 1);
}

async function aiFetchModelList() {
  if (aiModelListLoading.value) return;
  if (!aiCanListModels.value) return;
  const token = ++aiModelListRequestToken;
  const signature = aiModelFetchSignature.value;
  aiModelListLoading.value = true;
  aiModelError.value = "";
  try {
    const models = await aiListModels({
      provider: aiEditProvider.value,
      apiKey: aiEditApiKey.value,
      endpoint: aiEditEndpoint.value,
      model: aiEditModel.value,
      authMethod: aiEditAuthMethod.value,
      apiStyle: aiEditApiStyle.value,
      proxyEnabled: aiEditProxyEnabled.value,
      proxyUrl: aiEditProxyUrl.value,
      enableThinking: aiEditEnableThinking.value,
      reasoningLevel: aiEditReasoningLevel.value,
      contextWindow: aiEditContextWindow.value,
      codexCliPath: aiEditCodexCliPath.value,
      codexCliEnv: cliEnvFromRows(aiEditCodexCliEnvRows.value),
      claudeCodeCliPath: aiEditClaudeCodeCliPath.value,
      claudeCodeCliEnv: cliEnvFromRows(aiEditClaudeCodeCliEnvRows.value),
    });
    if (token !== aiModelListRequestToken) return;
    aiFetchedModels.value = normalizeAiModelOptions(models);
    aiLastModelFetchSignature = signature;
    const fetchedById = new Map(aiFetchedModels.value.map((model) => [model.id, model]));
    aiEditModels.value = aiEditModels.value.map((model) => {
      const fetched = fetchedById.get(model.name);
      if (!fetched) return model;
      return {
        name: model.name,
        label: fetched.displayName || model.label,
        supportedEffortLevels: fetched.supportedEffortLevels,
      };
    });
    if (aiIsClaudeCodeCli.value) {
      aiEditReasoningLevel.value = normalizeClaudeCodeReasoningLevel(aiEditReasoningLevel.value, aiSelectedModelInfo.value);
    }
  } catch (e: any) {
    if (token === aiModelListRequestToken) {
      aiModelError.value = e?.message || String(e);
    }
  } finally {
    if (token === aiModelListRequestToken) aiModelListLoading.value = false;
  }
}

function aiIsModelSelected(modelId: string): boolean {
  return aiEditModels.value.some((m) => m.name === modelId);
}

function aiToggleModel(model: AiModelInfo) {
  const index = aiEditModels.value.findIndex((m) => m.name === model.id);
  if (index >= 0) {
    aiEditModels.value.splice(index, 1);
  } else {
    aiEditModels.value.push({
      name: model.id,
      label: model.displayName || model.id,
      supportedEffortLevels: normalizeAiModelEffortLevels(model.supportedEffortLevels),
    });
  }
}

const aiFilteredFetchedModels = computed(() => {
  const search = aiModelMultiSelectSearch.value.trim().toLowerCase();
  if (!search) return aiFetchedModels.value;
  return aiFetchedModels.value.filter((m) => m.id.toLowerCase().includes(search) || (m.displayName && m.displayName.toLowerCase().includes(search)));
});

const aiModelFetchSignature = computed(() =>
  JSON.stringify({
    provider: aiEditProvider.value,
    endpoint: aiEditEndpoint.value.trim(),
    apiKey: aiEditApiKey.value.trim(),
    authMethod: aiEditAuthMethod.value,
    apiStyle: aiEditApiStyle.value,
    codexCliPath: aiEditCodexCliPath.value.trim(),
    codexCliEnv: cliEnvFromRows(aiEditCodexCliEnvRows.value),
    claudeCodeCliPath: aiEditClaudeCodeCliPath.value.trim(),
    claudeCodeCliEnv: cliEnvFromRows(aiEditClaudeCodeCliEnvRows.value),
  }),
);

let aiLastModelFetchSignature = "";

function normalizeAiModelOptions(models: AiModelInfo[]): AiModelInfo[] {
  const seen = new Set<string>();
  const normalized: AiModelInfo[] = [];
  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const supportedEffortLevels = normalizeAiModelEffortLevels(model.supportedEffortLevels);
    normalized.push({
      id,
      displayName: model.displayName?.trim() || undefined,
      supportedEffortLevels: supportedEffortLevels.length ? supportedEffortLevels : undefined,
    });
  }
  return normalized;
}

const aiSelectedModelInfo = computed<AiModelInfo | undefined>(() => {
  if (aiModelFetchSignature.value === aiLastModelFetchSignature) {
    const fetched = aiFetchedModels.value.find((model) => model.id === aiEditModel.value);
    if (fetched) return fetched;
  }
  const configured = aiEditModels.value.find((model) => model.name === aiEditModel.value);
  if (!configured) return undefined;
  return {
    id: configured.name,
    displayName: configured.label,
    supportedEffortLevels: configured.supportedEffortLevels,
  };
});
const aiClaudeCodeEffortLevels = computed(() => normalizeAiModelEffortLevels(aiSelectedModelInfo.value?.supportedEffortLevels));
const aiReasoningLevelOptions = computed<Array<{ value: AiReasoningLevel; labelKey: string }>>(() => {
  if (!aiIsClaudeCodeCli.value) return codexReasoningLevelOptions;
  return [{ value: "default", labelKey: "ai.reasoningLevelDefault" }, ...aiClaudeCodeEffortLevels.value.map((value) => ({ value, labelKey: effortLevelLabelKeys[value] }))];
});
const aiReasoningLevelDisabled = computed(() => aiIsClaudeCodeCli.value && aiClaudeCodeEffortLevels.value.length === 0);
const aiReasoningLevelHint = computed(() => {
  if (!aiIsClaudeCodeCli.value) return t("ai.reasoningLevelHint");
  if (aiModelListLoading.value && aiClaudeCodeEffortLevels.value.length === 0) return t("ai.loadingModels");
  return aiClaudeCodeEffortLevels.value.length ? t("ai.claudeCodeEffortHint") : t("ai.claudeCodeEffortUnavailable");
});

watch([aiIsClaudeCodeCli, aiSelectedModelInfo], () => {
  if (!aiIsClaudeCodeCli.value) return;
  aiEditReasoningLevel.value = normalizeClaudeCodeReasoningLevel(aiEditReasoningLevel.value, aiSelectedModelInfo.value);
});

function aiModelsForSave(): AiConfiguredModel[] | undefined {
  const models = aiEditModels.value
    .map((model) => {
      const supportedEffortLevels = normalizeAiModelEffortLevels(model.supportedEffortLevels);
      return {
        name: model.name.trim(),
        label: model.label?.trim() || undefined,
        supportedEffortLevels: supportedEffortLevels.length ? supportedEffortLevels : undefined,
      };
    })
    .filter((model) => model.name);

  if (aiIsClaudeCodeCli.value && aiEditModel.value.trim() && aiSelectedModelInfo.value) {
    const modelId = aiEditModel.value.trim();
    const supportedEffortLevels = normalizeAiModelEffortLevels(aiSelectedModelInfo.value.supportedEffortLevels);
    const configuredModel = models.find((model) => model.name === modelId);
    if (configuredModel) {
      configuredModel.label = aiSelectedModelInfo.value.displayName || configuredModel.label;
      configuredModel.supportedEffortLevels = supportedEffortLevels.length ? supportedEffortLevels : undefined;
    } else {
      models.unshift({
        name: modelId,
        label: aiSelectedModelInfo.value.displayName,
        supportedEffortLevels: supportedEffortLevels.length ? supportedEffortLevels : undefined,
      });
    }
  }

  return models.length ? models : undefined;
}

function aiOnModelPopoverOpen(open: boolean) {
  if (!open) return;
  if (aiModelFetchSignature.value !== aiLastModelFetchSignature) {
    aiFetchedModels.value = [];
    if (aiCanListModels.value) void aiFetchModelList();
  } else if (aiFetchedModels.value.length === 0 && aiCanListModels.value) {
    void aiFetchModelList();
  }
}

async function aiSaveConfig() {
  const validationResult: ConfigNameValidationResult = validateConfigName(aiEditConfigName.value, settingsStore.aiConfigs, aiEditConfigId.value || undefined);
  if (validationResult === "empty") {
    toast(t("ai.configNameEmpty"), 3000);
    return;
  }
  if (validationResult === "duplicate") {
    toast(t("ai.configNameExists", { name: aiEditConfigName.value }), 3000);
    return;
  }

  const editConfig = currentAiEditConfig();
  aiEditReasoningLevel.value = editConfig.reasoningLevel;
  const models = aiModelsForSave();
  const config: AiConfigItem = {
    id: aiEditConfigId.value || generateId(),
    name: aiEditConfigName.value,
    ...editConfig,
    models,
  };

  try {
    if (aiEditConfigId.value) {
      await settingsStore.updateAiConfigItem(aiEditConfigId.value, config);
    } else {
      await settingsStore.createAiConfig(config);
    }
    aiEnterListMode();
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  }
}

function aiDeleteConfig(id: string) {
  aiDeleteConfigId.value = id;
  aiDeleteConfirmOpen.value = true;
}

async function aiConfirmDeleteConfig() {
  if (aiDeleteConfigId.value) {
    if (settingsStore.activeModel?.configId === aiDeleteConfigId.value) {
      toast(t("ai.cannotDeleteActiveConfig"), 5000);
      aiDeleteConfirmOpen.value = false;
      aiDeleteConfigId.value = null;
      return;
    }
    try {
      await settingsStore.deleteAiConfig(aiDeleteConfigId.value);
    } catch (e: any) {
      toast(e?.message || String(e), 5000);
    }
  }
  aiDeleteConfirmOpen.value = false;
  aiDeleteConfigId.value = null;
}

async function aiSetDefaultConfig(id: string) {
  try {
    await settingsStore.setDefaultAiConfig(id);
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  }
}

async function aiTestConn() {
  if ((aiRequiresApiKey.value && !aiEditApiKey.value.trim()) || (!aiIsCliProvider.value && !aiEditEndpoint.value.trim()) || (!aiIsCliProvider.value && !aiEditModel.value.trim())) return;
  if (aiCliValidationError.value) {
    aiTestResult.value = "error";
    aiTestError.value = aiCliValidationError.value;
    return;
  }
  aiTesting.value = true;
  aiTestResult.value = "";
  aiTestError.value = "";
  aiTestLatency.value = null;
  aiTestErrorCopied.value = false;
  try {
    const result = await aiTestConnection(currentAiEditConfig());
    aiTestResult.value = "success";
    aiTestLatency.value = result.latencyMs ?? null;
  } catch (e: any) {
    aiTestResult.value = "error";
    aiTestError.value = e?.message || String(e);
  } finally {
    aiTesting.value = false;
  }
}

async function copyAiTestError() {
  if (!aiTestError.value) return;
  await copyToClipboard(aiTestError.value);
  aiTestErrorCopied.value = true;
  window.setTimeout(() => {
    aiTestErrorCopied.value = false;
  }, 1500);
}

async function ensureCliMcpStatus() {
  if (isWeb || activeSettingsTab.value !== "ai" || !aiIsCliProvider.value || mcpStatus.value || mcpStatusLoading.value) return;
  await refreshMcpStatus();
}

// ---------- CodeMirror preview ----------
const previewRef = ref<HTMLDivElement>();
const previewView = shallowRef<EditorViewType | null>(null);

interface PreviewSqlDiagnostic {
  from: number;
  to: number;
  message: string;
}

function getPreviewCustomThemeColors(): CustomThemeColors | undefined {
  if (editTheme.value !== "custom") return undefined;
  const activeTheme = editCustomThemes.value.find((t) => t.id === editActiveCustomThemeId.value);
  return activeTheme?.colors;
}

const previewSettings = computed<{
  fontFamily: string;
  fontSize: number;
  theme: EditorTheme;
  appAppearance: AppThemeAppearance;
  appPalette: AppThemePalette;
  customColors?: CustomThemeColors;
  showStatementRunButtons: boolean;
  showCurrentStatementFrame: boolean;
}>(() => ({
  fontFamily: editFontFamily.value,
  fontSize: editFontSize.value,
  theme: editTheme.value,
  appAppearance: isDark.value ? "dark" : "light",
  appPalette: themePalette.value,
  customColors: getPreviewCustomThemeColors(),
  showStatementRunButtons: editShowStatementRunButtons.value,
  showCurrentStatementFrame: editShowCurrentStatementFrame.value,
}));

const previewSqlNormal = `SELECT u.id, u.name
FROM users u
ORDER BY u.id LIMIT 5;

SELECT o.id, o.total
FROM orders o
WHERE o.total > 100;`;
const previewSqlWithSyntaxError = `SELECT u.id, u.name
FOM users u
ORDER BY u.id LIMIT 5;

SELECT o.id, o.total
FROM orders o
WHERE o.total > 100;`;

let fontThemeComp: import("@codemirror/state").Compartment | null = null;
let themeComp: import("@codemirror/state").Compartment | null = null;
let diagnosticComp: import("@codemirror/state").Compartment | null = null;
let previewRunGutterComp: import("@codemirror/state").Compartment | null = null;
let currentStatementFrameComp: import("@codemirror/state").Compartment | null = null;
let setPreviewDiagnosticsEffect: import("@codemirror/state").StateEffectType<PreviewSqlDiagnostic[]> | null = null;
let setPreviewRunHighlightEffect: import("@codemirror/state").StateEffectType<{ from: number; to: number } | null> | null = null;
let editorViewModule: typeof import("@codemirror/view") | null = null;
let previewSqlDiagnostics: PreviewSqlDiagnostic[] = [];
let previewExecutableCache: ExecutableStatementRangeCache | null = null;
let previewRunHighlightRange: { from: number; to: number } | null = null;
let previewRunHighlightTimer: ReturnType<typeof setTimeout> | null = null;
let buildPreviewRunGutterExtension: () => import("@codemirror/state").Extension = () => [];

function currentPreviewSql(): string {
  return editSqlSemanticDiagnosticsEnabled.value ? previewSqlWithSyntaxError : previewSqlNormal;
}

function previewDiagnosticsForSql(sql: string): PreviewSqlDiagnostic[] {
  if (!editSqlSemanticDiagnosticsEnabled.value) return [];
  const from = sql.indexOf("FOM");
  return from >= 0 ? [{ from, to: from + 3, message: "Syntax error: expected FROM" }] : [];
}

function updatePreviewSqlDiagnostics() {
  const view = previewView.value;
  if (!view || !setPreviewDiagnosticsEffect) return;
  const nextSql = currentPreviewSql();
  const currentSql = view.state.doc.toString();
  previewSqlDiagnostics = previewDiagnosticsForSql(nextSql);
  const effects = setPreviewDiagnosticsEffect.of(previewSqlDiagnostics);
  if (currentSql === nextSql) {
    view.dispatch({ effects });
    return;
  }
  previewExecutableCache = null;
  view.dispatch({
    changes: { from: 0, to: currentSql.length, insert: nextSql },
    effects,
  });
}

function previewExecutableStatementRangeStartingAt(currentView: EditorViewType, lineFrom: number) {
  previewExecutableCache = executableStatementRangeCacheForDoc(previewExecutableCache, currentView.state.doc, "mysql");
  return executableStatementRangeStartingAt(previewExecutableCache, lineFrom);
}

function clearPreviewRunHighlight() {
  previewRunHighlightRange = null;
  if (previewView.value && setPreviewRunHighlightEffect) {
    previewView.value.dispatch({ effects: setPreviewRunHighlightEffect.of(null) });
  }
}

function flashPreviewRunHighlight(range: { from: number; to: number }, event: Event) {
  previewRunHighlightRange = range;
  if (previewView.value && setPreviewRunHighlightEffect) {
    previewView.value.dispatch({ effects: setPreviewRunHighlightEffect.of(range) });
  }
  if (event.target instanceof Element) {
    const marker = event.target.closest(".cm-run-statement-marker");
    marker?.classList.add("cm-run-statement-marker--executed");
    window.setTimeout(() => marker?.classList.remove("cm-run-statement-marker--executed"), 650);
  }
  if (previewRunHighlightTimer) clearTimeout(previewRunHighlightTimer);
  previewRunHighlightTimer = window.setTimeout(() => {
    previewRunHighlightTimer = null;
    clearPreviewRunHighlight();
  }, 650);
}

function handlePreviewRunGutterMouseDown(currentView: EditorViewType, line: { from: number; to: number }, event: Event): boolean {
  if (!(event instanceof MouseEvent) || event.button !== 0) return false;
  const statementRange = previewExecutableStatementRangeStartingAt(currentView, line.from);
  if (!statementRange) return false;
  event.preventDefault();
  event.stopPropagation();
  flashPreviewRunHighlight({ from: statementRange.from, to: statementRange.to }, event);
  currentView.focus();
  return true;
}

function buildPreviewCurrentStatementFrameExtension(viewModule: Pick<typeof import("@codemirror/view"), "Decoration" | "EditorView" | "ViewPlugin">, enabled: boolean) {
  if (!enabled) return [];
  const { Decoration, EditorView, ViewPlugin } = viewModule;
  const frameTheme = EditorView.baseTheme({
    ".cm-db-current-statement-line": {
      position: "relative",
    },
    ".cm-db-current-statement-line::after": {
      content: '""',
      position: "absolute",
      top: "0",
      bottom: "0",
      left: "0",
      boxSizing: "border-box",
      width: "var(--dbx-current-statement-frame-width, 100%)",
      borderRight: "1px solid rgb(34 197 94 / 0.75)",
      borderLeft: "1px solid rgb(34 197 94 / 0.75)",
      pointerEvents: "none",
    },
    ".cm-db-current-statement-line--first::after": {
      borderTop: "1px solid rgb(34 197 94 / 0.75)",
    },
    ".cm-db-current-statement-line--last::after": {
      borderBottom: "1px solid rgb(34 197 94 / 0.75)",
    },
  });
  const framePlugin = ViewPlugin.fromClass(
    class {
      decorations: import("@codemirror/view").DecorationSet;
      constructor(view: import("@codemirror/view").EditorView) {
        this.decorations = this.getDeco(view);
      }
      update(update: import("@codemirror/view").ViewUpdate) {
        this.decorations = this.getDeco(update.view);
      }
      getDeco(view: import("@codemirror/view").EditorView) {
        if (view.state.selection.ranges.some((range) => !range.empty)) return Decoration.none;
        const range = currentExecutableStatementRange(view.state.doc.toString(), view.state.selection.main.head, "mysql");
        if (!range) return Decoration.none;

        const startLine = view.state.doc.lineAt(range.from);
        const frameTo = previewCurrentStatementFrameTo(view, range);
        const endLine = view.state.doc.lineAt(Math.max(range.from, frameTo - 1));
        let maxWidth = 1;
        for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
          const line = view.state.doc.line(lineNumber);
          const lineRangeTo = Math.min(line.to, frameTo);
          maxWidth = Math.max(maxWidth, visualSqlColumnsWithInlineHints(view.state.doc.sliceString(line.from, lineRangeTo), line.from, lineRangeTo));
        }

        const deco: any[] = [];
        const frameWidth = `calc(${maxWidth}ch + 2ch)`;
        for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
          const line = view.state.doc.line(lineNumber);
          const classes = ["cm-db-current-statement-line"];
          if (lineNumber === startLine.number) classes.push("cm-db-current-statement-line--first");
          if (lineNumber === endLine.number) classes.push("cm-db-current-statement-line--last");
          deco.push(Decoration.line({ class: classes.join(" "), attributes: { style: `--dbx-current-statement-frame-width: ${frameWidth};` } }).range(line.from));
        }
        return Decoration.set(deco);
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [framePlugin, frameTheme];
}

function previewCurrentStatementFrameTo(view: import("@codemirror/view").EditorView, range: SqlTextRange): number {
  const nextChar = range.to < view.state.doc.length ? view.state.doc.sliceString(range.to, range.to + 1) : "";
  return currentStatementFrameRangeTo(nextChar, range);
}

watch(
  [previewSettings, editCustomThemes, editActiveCustomThemeId],
  async ([ss]) => {
    if (!previewView.value || !fontThemeComp || !themeComp || !editorViewModule) return;

    const themeExt = await loadEditorTheme(ss.theme, ss.appAppearance, ss.customColors, ss.appPalette);
    previewView.value.dispatch({
      effects: [
        themeComp.reconfigure(themeExt),
        fontThemeComp.reconfigure(editorFontTheme(editorViewModule.EditorView, ss.fontSize, ss.fontFamily)),
        ...(previewRunGutterComp ? [previewRunGutterComp.reconfigure(buildPreviewRunGutterExtension())] : []),
        ...(currentStatementFrameComp ? [currentStatementFrameComp.reconfigure(buildPreviewCurrentStatementFrameExtension(editorViewModule, ss.showCurrentStatementFrame))] : []),
      ],
    });
  },
  { deep: true },
);

watch(editSqlSemanticDiagnosticsEnabled, () => {
  updatePreviewSqlDiagnostics();
});

let previewInitialized = false;

function cleanupPreviewEditor() {
  if (!previewView.value) return;
  previewView.value.destroy();
  previewView.value = null;
  previewInitialized = false;
  fontThemeComp = null;
  themeComp = null;
  diagnosticComp = null;
  previewRunGutterComp = null;
  currentStatementFrameComp = null;
  setPreviewDiagnosticsEffect = null;
  setPreviewRunHighlightEffect = null;
  editorViewModule = null;
  previewSqlDiagnostics = [];
  previewExecutableCache = null;
  previewRunHighlightRange = null;
  buildPreviewRunGutterExtension = () => [];
  if (previewRunHighlightTimer) {
    clearTimeout(previewRunHighlightTimer);
    previewRunHighlightTimer = null;
  }
}

watch(activeSettingsTab, (tab) => {
  if (tab !== "editor" && previewView.value) {
    cleanupPreviewEditor();
  }
});

watch(previewRef, async (el) => {
  if (!el || previewInitialized) return;
  previewInitialized = true;
  if (previewView.value) return;

  const [{ EditorView, Decoration, ViewPlugin, gutter, GutterMarker }, { EditorState, Compartment, StateEffect, StateField }, { sql, MySQL }, { basicSetup }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror")]);

  editorViewModule = { Decoration, EditorView, ViewPlugin } as typeof import("@codemirror/view");
  fontThemeComp = new Compartment();
  themeComp = new Compartment();
  diagnosticComp = new Compartment();
  previewRunGutterComp = new Compartment();
  currentStatementFrameComp = new Compartment();
  setPreviewDiagnosticsEffect = StateEffect.define<PreviewSqlDiagnostic[]>();
  setPreviewRunHighlightEffect = StateEffect.define<{ from: number; to: number } | null>();
  previewSqlDiagnostics = previewDiagnosticsForSql(currentPreviewSql());

  const ss = previewSettings.value;
  const themeExt = await loadEditorTheme(ss.theme, ss.appAppearance, ss.customColors, ss.appPalette);
  const diagnosticTheme = EditorView.baseTheme({
    ".cm-settings-preview-sql-error": {
      textDecoration: "underline wavy var(--destructive)",
      textUnderlineOffset: "3px",
    },
  });
  const buildPreviewDiagnosticExtension = () => {
    const diagnosticEffect = setPreviewDiagnosticsEffect;
    const buildDecorations = () =>
      Decoration.set(
        previewSqlDiagnostics.map((diagnostic) =>
          Decoration.mark({
            class: "cm-settings-preview-sql-error",
            attributes: { title: diagnostic.message },
          }).range(diagnostic.from, diagnostic.to),
        ),
        true,
      );

    const field = StateField.define({
      create: buildDecorations,
      update(value, transaction) {
        const diagnosticsChanged = !!diagnosticEffect && transaction.effects.some((effect) => effect.is(diagnosticEffect));
        return transaction.docChanged || diagnosticsChanged ? buildDecorations() : value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });

    return [field, diagnosticTheme];
  };

  class PreviewRunStatementGutterMarker extends GutterMarker {
    toDOM() {
      return createRunStatementButtonDom(t("settings.previewStatementRunButton"));
    }
  }

  const previewRunMarker = new PreviewRunStatementGutterMarker();
  buildPreviewRunGutterExtension = () =>
    editShowStatementRunButtons.value
      ? gutter({
          class: "cm-run-statement-gutter",
          lineMarker(currentView, line) {
            return previewExecutableStatementRangeStartingAt(currentView, line.from) ? previewRunMarker : null;
          },
          domEventHandlers: {
            mousedown: handlePreviewRunGutterMouseDown,
          },
        })
      : [];

  const buildPreviewRunHighlightExtension = () => {
    const highlightEffect = setPreviewRunHighlightEffect;
    const buildDecorations = () => (previewRunHighlightRange ? Decoration.set([Decoration.mark({ class: "cm-settings-preview-run-highlight" }).range(previewRunHighlightRange.from, previewRunHighlightRange.to)], true) : Decoration.none);
    const field = StateField.define({
      create: buildDecorations,
      update(value, transaction) {
        const highlightChanged = !!highlightEffect && transaction.effects.some((effect) => effect.is(highlightEffect));
        return transaction.docChanged || highlightChanged ? buildDecorations() : value;
      },
      provide: (field) => EditorView.decorations.from(field),
    });
    return field;
  };

  const state = EditorState.create({
    doc: currentPreviewSql(),
    extensions: [
      basicSetup,
      sql({ dialect: MySQL }),
      themeComp.of(themeExt),
      fontThemeComp.of(editorFontTheme(EditorView, ss.fontSize, ss.fontFamily)),
      previewRunGutterComp.of(buildPreviewRunGutterExtension()),
      currentStatementFrameComp.of(buildPreviewCurrentStatementFrameExtension(editorViewModule, ss.showCurrentStatementFrame)),
      diagnosticComp.of(buildPreviewDiagnosticExtension()),
      buildPreviewRunHighlightExtension(),
    ],
  });

  previewView.value = new EditorView({ state, parent: previewRef.value });
});

watch(
  () => settingsVisible.value,
  (open) => {
    if (!open) cleanupPreviewEditor();
  },
);

onUnmounted(cleanupPreviewEditor);
</script>

<template>
  <component :is="settingsRootComponent" v-bind="settingsRootProps" :class="settingsRootClass" @update:open="onSettingsRootOpenChange">
    <component :is="settingsContentComponent" :class="settingsContentClass">
      <DialogHeader>
        <component :is="settingsTitleComponent" class="flex items-center gap-2 text-base leading-none font-medium cn-font-heading">
          <Settings class="h-4 w-4" />
          {{ t("settings.title") }}
        </component>
      </DialogHeader>

      <div class="settings-layout flex min-h-0 flex-1 flex-col gap-3 overflow-hidden lg:flex-row">
        <nav class="settingsCategoryNav settings-category-nav flex min-h-0 shrink-0 gap-1 overflow-x-auto border-b pb-3 lg:w-40 lg:flex-col lg:overflow-x-hidden lg:overflow-y-auto lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3">
          <button v-for="category in settingsCategoryNav" :key="category.value" type="button" :class="settingsCategoryButton(category.value)" @click="activeSettingsTab = category.value">
            {{ category.label }}
          </button>
        </nav>

        <div class="min-w-0 flex-1 overflow-hidden px-1 flex flex-col">
          <div class="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 pr-2">
            <section v-if="activeSettingsTab === 'editor'" class="flex flex-col gap-5 py-2">
              <div class="grid gap-4 md:grid-cols-[1fr_auto]">
                <!-- Font Family -->
                <div class="space-y-2 min-w-0">
                  <Label>{{ t("settings.fontFamily") }}</Label>
                  <SearchableSelect
                    :model-value="editFontFamily"
                    :options="systemFontOptions"
                    :placeholder="t('settings.selectFont')"
                    :search-placeholder="t('settings.searchFont')"
                    :empty-text="t('settings.noFontsFound')"
                    :loading-text="t('settings.loadingFonts')"
                    allow-custom
                    :display-name="displayFontFamily"
                    :normalize-custom="normalizeCustomFontFamilyInput"
                    :trigger-class="fontSearchTriggerClass"
                    :trigger-icon-class="fontSearchTriggerIconClass"
                    content-class="w-[var(--reka-popover-trigger-width)] min-w-[260px]"
                    @update:model-value="onFontFamilyChange"
                    @update:open="(open: boolean) => open && loadSystemFontOptions()"
                  >
                    <template #trigger-label="{ label, loading }">
                      <span class="truncate" :style="{ fontFamily: editFontFamily }">
                        {{ loading ? t("settings.loadingFonts") : label }}
                      </span>
                    </template>
                    <template #option-label="{ option, label }">
                      <span class="truncate" :style="fontOptionStyle(option)">{{ label }}</span>
                    </template>
                    <template #custom-option-label="{ value }">
                      <span class="truncate" :style="{ fontFamily: value }">
                        {{ t("settings.useCustomFont", { font: readableFontFamily(value) }) }}
                      </span>
                    </template>
                  </SearchableSelect>
                </div>

                <!-- Theme + Custom Theme Button -->
                <div class="flex gap-2 items-end">
                  <div class="space-y-2">
                    <Label>{{ t("settings.theme") }}</Label>
                    <Select :model-value="themeSelectValue" @update:model-value="onThemeChange">
                      <SelectTrigger class="min-w-[80px] max-w-[200px]">
                        <SelectValue :placeholder="t('settings.selectTheme')" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="theme in themeSelectOptions" :key="theme.value" :value="theme.value">
                          <div class="flex items-center gap-2">
                            <span class="h-3 w-3 rounded-full border" :class="theme.dark ? 'bg-foreground border-foreground/20' : 'bg-muted-foreground/30 border-muted-foreground/40'" />
                            {{ theme.label }}
                          </div>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button v-if="editTheme === 'custom'" variant="outline" class="h-9 w-auto px-4" @click="showThemeCustomizer = true">
                    <Settings class="mr-2 h-4 w-4" />
                    {{ t("settings.customThemeConfigure") }}
                  </Button>
                </div>
              </div>

              <!-- Font Size -->
              <div class="space-y-2">
                <div class="flex items-center justify-between">
                  <Label>{{ t("settings.fontSize") }}</Label>
                  <span class="text-xs text-muted-foreground tabular-nums">{{ editFontSize }}px</span>
                </div>
                <input type="range" min="10" max="24" step="1" :value="editFontSize" @input="editFontSize = Number(($event.target as HTMLInputElement).value)" class="w-full accent-primary" />
                <div class="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>10px</span>
                  <span class="flex-1 border-b border-dashed border-muted-foreground/30" />
                  <span>24px</span>
                </div>
              </div>

              <Separator />

              <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div class="space-y-2">
                  <Label>{{ t("settings.executeMode") }}</Label>
                  <Select :model-value="editExecuteMode" @update:model-value="onExecuteModeChange">
                    <SelectTrigger>
                      <SelectValue :placeholder="t('settings.executeMode')" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{{ t("settings.executeModeAll") }}</SelectItem>
                      <SelectItem value="current">{{ t("settings.executeModeCurrent") }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-show-execution-target-picker">{{ t("settings.showExecutionTargetPicker") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.showExecutionTargetPickerDescription") }}</p>
                  </div>
                  <Switch id="editor-show-execution-target-picker" v-model="editShowExecutionTargetPicker" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-show-statement-run-buttons">{{ t("settings.showStatementRunButtons") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.showStatementRunButtonsDescription") }}</p>
                  </div>
                  <Switch id="editor-show-statement-run-buttons" v-model="editShowStatementRunButtons" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-show-current-statement-frame">{{ t("settings.showCurrentStatementFrame") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.showCurrentStatementFrameDescription") }}</p>
                  </div>
                  <Switch id="editor-show-current-statement-frame" v-model="editShowCurrentStatementFrame" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-show-insert-value-hints">{{ t("settings.showInsertValueHints") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.showInsertValueHintsDescription") }}</p>
                  </div>
                  <Switch id="editor-show-insert-value-hints" v-model="editShowInsertValueHints" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-word-wrap">{{ t("settings.wordWrap") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.wordWrapDescription") }}</p>
                  </div>
                  <Switch id="editor-word-wrap" v-model="editWordWrap" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-vim-mode">{{ t("settings.vimMode") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.vimModeDescription") }}</p>
                  </div>
                  <Switch id="editor-vim-mode" v-model="editVimModeEnabled" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-auto-close-brackets">{{ t("settings.autoCloseBrackets") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.autoCloseBracketsDescription") }}</p>
                  </div>
                  <Switch id="editor-auto-close-brackets" v-model="editAutoCloseBrackets" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-auto-alias-tables">{{ t("settings.autoAliasTables") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.autoAliasTablesDescription") }}</p>
                  </div>
                  <Switch id="editor-auto-alias-tables" v-model="editAutoAliasTables" class="mt-0.5" />
                </div>
              </div>

              <div class="grid gap-3 md:grid-cols-2">
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-sql-semantic-diagnostics">{{ t("settings.sqlSemanticDiagnosticsEnabled") }}</Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.sqlSemanticDiagnosticsEnabledDescription") }}
                    </p>
                  </div>
                  <Switch id="editor-sql-semantic-diagnostics" :model-value="editSqlSemanticDiagnosticsEnabled" class="mt-0.5" @update:model-value="onSqlSemanticDiagnosticsEnabledChange" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-confirm-dangerous-sql">{{ t("settings.confirmDangerousSqlExecution") }}</Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.confirmDangerousSqlExecutionDescription") }}
                    </p>
                  </div>
                  <Switch id="editor-confirm-dangerous-sql" v-model="editConfirmDangerousSqlExecution" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-continue-on-error">{{ t("settings.continueOnErrorOnBatch") }}</Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.continueOnErrorOnBatchDescription") }}
                    </p>
                  </div>
                  <Switch id="editor-continue-on-error" v-model="editContinueOnErrorOnBatch" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-confirm-unsaved-sql-close">{{ t("settings.confirmUnsavedSqlClose") }}</Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.confirmUnsavedSqlCloseDescription") }}
                    </p>
                  </div>
                  <Switch id="editor-confirm-unsaved-sql-close" v-model="editConfirmUnsavedSqlClose" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-prefill-new-query">{{ t("settings.prefillNewQueryWithSelect") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.prefillNewQueryWithSelectDescription") }}</p>
                  </div>
                  <Switch id="editor-prefill-new-query" v-model="editPrefillNewQueryWithSelect" class="mt-0.5" />
                </div>
              </div>

              <Separator />

              <div class="space-y-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="space-y-1">
                    <div class="text-sm font-medium text-muted-foreground">{{ t("settings.sqlVariableSyntax") }}</div>
                    <p class="text-xs text-muted-foreground">{{ t("settings.sqlVariableSyntaxDescription") }}</p>
                  </div>
                  <Select v-model="editSqlVariableSyntaxDatabaseType">
                    <SelectTrigger class="h-8 w-44 px-2 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent class="max-h-72">
                      <SelectItem v-for="dbType in SQL_VARIABLE_SYNTAX_DATABASE_TYPES" :key="dbType" :value="dbType">
                        {{ dbType }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div class="grid gap-3 md:grid-cols-2">
                  <div v-for="key in SQL_VARIABLE_SYNTAX_KEYS" :key="key" class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                    <div class="min-w-0 space-y-1">
                      <Label :for="`sql-var-syntax-${key}`" class="flex items-center gap-1.5">
                        <span class="font-mono text-xs text-primary">{{ SQL_VARIABLE_SYNTAX_TOKENS[key] }}</span>
                        <span>{{ t(`settings.sqlVariableSyntax_${key}`) }}</span>
                      </Label>
                      <p class="text-xs text-muted-foreground">{{ t(`settings.sqlVariableSyntax_${key}Description`) }}</p>
                    </div>
                    <Switch :id="`sql-var-syntax-${key}`" :model-value="sqlVariableSyntaxToggle(key)" class="mt-0.5 shrink-0" @update:model-value="(value) => setSqlVariableSyntaxToggle(key, value as boolean)" />
                  </div>
                </div>
              </div>

              <Separator />

              <!-- Live Preview -->
              <div class="space-y-2">
                <Label>{{ t("settings.preview") }}</Label>
                <div class="rounded-md border overflow-auto max-w-full" :class="editTheme === 'vscode-light' || editTheme === 'duotone-light' || editTheme === 'xcode' ? 'border-border' : 'border-border/50'">
                  <div ref="previewRef" style="min-width: 100%" />
                </div>
              </div>
            </section>

            <section v-else-if="activeSettingsTab === 'formatter'" class="flex flex-col gap-5 py-2">
              <div class="space-y-3 rounded-md border border-border/70 bg-muted/10 p-3">
                <div class="text-sm font-medium">{{ t("settings.sqlFormatterEditorShortcuts") }}</div>
                <div class="overflow-hidden rounded-md border border-border/70 bg-background">
                  <div v-for="definition in formatterEditorShortcutDefinitions" :key="definition.id" class="group -mt-px grid gap-2 border-t border-border/70 px-3 py-2 transition-colors first:mt-0 first:border-t-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                    <div class="min-w-0">
                      <Label class="min-w-0 truncate leading-none">{{ t(definition.labelKey) }}</Label>
                    </div>
                    <div class="min-w-0 space-y-1">
                      <div class="flex items-center justify-end gap-1.5">
                        <input
                          :data-shortcut-input="definition.id"
                          :value="editingShortcutId === definition.id ? '' : formatShortcutPill(editShortcuts[definition.id])"
                          :style="{
                            width: editingShortcutId === definition.id ? shortcutPressShortcutInputWidth : `${Math.max(4, formatShortcutPill(editShortcuts[definition.id]).length + 3)}ch`,
                          }"
                          readonly
                          :aria-invalid="shortcutConflicts.includes(definition.id)"
                          :placeholder="t('settings.shortcutPressShortcut')"
                          class="h-7 w-auto min-w-12 max-w-64 shrink-0 cursor-default rounded-[6px] border border-transparent bg-background px-2.5 text-center font-mono text-[13px] font-semibold text-foreground/75 shadow-inner outline-none selection:bg-transparent placeholder:text-muted-foreground aria-invalid:border-destructive/70 aria-invalid:text-destructive aria-invalid:ring-destructive/20"
                          :class="editingShortcutId === definition.id ? 'max-w-64 cursor-text border-border/80 bg-background text-left text-foreground shadow-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35' : ''"
                          @keydown="(event: KeyboardEvent) => onShortcutKeydown(definition.id, event)"
                        />
                        <Button
                          v-if="editingShortcutId !== definition.id"
                          type="button"
                          variant="ghost"
                          size="icon"
                          class="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          :aria-label="t('settings.shortcutPressShortcut')"
                          @click="focusShortcutInput(definition.id)"
                        >
                          <Pencil class="h-4 w-4" />
                        </Button>
                        <Button v-else type="button" variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-sm font-medium text-muted-foreground hover:text-foreground" @click="cancelShortcutEdit">
                          {{ t("settings.cancel") }}
                        </Button>
                        <Button
                          v-if="editingShortcutId !== definition.id"
                          type="button"
                          variant="ghost"
                          size="icon"
                          class="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          :aria-label="t('settings.reset')"
                          @click="resetShortcut(definition.id)"
                        >
                          <RotateCcw class="h-4 w-4" />
                        </Button>
                        <Button
                          v-if="editingShortcutId !== definition.id && editShortcuts[definition.id]"
                          type="button"
                          variant="ghost"
                          size="icon"
                          class="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                          :aria-label="t('settings.shortcutClear')"
                          @click="clearShortcut(definition.id)"
                        >
                          <X class="h-4 w-4" />
                        </Button>
                        <span v-else-if="editingShortcutId !== definition.id" class="h-7 w-7 shrink-0" aria-hidden="true" />
                      </div>
                      <p v-if="shortcutConflicts.includes(definition.id)" class="text-xs text-destructive">
                        {{ t("settings.shortcutConflict") }}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <SqlFormatterSettingsPanel v-model="editSqlFormatter" @validity-change="(value: boolean) => (sqlFormatterConfigValid = value)" />
            </section>

            <section v-else-if="activeSettingsTab === 'appearance'" class="settings-appearance-section flex flex-col gap-4 py-2">
              <div class="settings-appearance-top-grid">
                <div class="settings-appearance-field min-w-0">
                  <div class="flex h-9 items-end">
                    <Label class="whitespace-normal leading-tight">{{ t("settings.languageTitle") }}</Label>
                  </div>
                  <Select :model-value="currentLocale()" @update:model-value="onLocaleChange">
                    <SelectTrigger class="h-8 w-full gap-0.5 px-0.5">
                      <SelectValue>
                        <span v-if="selectedLocaleOption" class="flex min-w-0 items-center gap-0.5">
                          <span class="inline-flex h-5 shrink-0 items-center justify-center text-sm font-medium leading-none">
                            {{ selectedLocaleOption.flag }}
                          </span>
                          <span class="truncate">{{ selectedLocaleOption.label }}</span>
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent class="w-[150px]">
                      <SelectItem v-for="locale in LOCALE_OPTIONS" :key="locale.value" :value="locale.value">
                        <div class="flex items-center gap-1">
                          <span class="inline-flex h-5 w-6 shrink-0 items-center justify-center text-sm font-medium leading-none">
                            {{ locale.flag }}
                          </span>
                          <span>{{ locale.label }}</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div class="settings-appearance-field min-w-0">
                  <div class="flex h-9 items-end">
                    <Label class="whitespace-normal leading-tight">{{ t("settings.colorTheme") }}</Label>
                  </div>
                  <Select :model-value="themePalette" @update:model-value="(value) => setThemePalette(value as AppThemePalette)">
                    <SelectTrigger class="h-8 w-full gap-1">
                      <SelectValue :placeholder="t('settings.selectColorTheme')">
                        <span v-if="selectedThemePaletteOption" class="flex min-w-0 items-center gap-1">
                          <span class="h-3 w-3 shrink-0 rounded-full border border-border shadow-xs" :style="{ background: selectedThemePaletteOption.previewColor }" />
                          <span class="truncate">{{ selectedThemePaletteOption.label }}</span>
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="option in appThemePaletteOptions" :key="option.value" :value="option.value">
                        <div class="flex items-center gap-2">
                          <span class="h-3 w-3 rounded-full border border-border shadow-xs" :style="{ background: option.previewColor }" />
                          {{ option.label }}
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div class="settings-appearance-field min-w-0">
                  <div class="flex h-9 items-end">
                    <div class="flex min-w-0 items-center gap-1">
                      <Label class="min-w-0 whitespace-normal leading-tight">{{ t("settings.uiScale") }}</Label>
                      <HelpTooltip :label="t('settings.uiScale')" trigger-class="[&_svg]:h-3 [&_svg]:w-3" content-class="max-w-64">
                        <p>{{ t("settings.uiScaleDescription") }}</p>
                      </HelpTooltip>
                    </div>
                  </div>
                  <Select
                    :model-value="String(editUiScale)"
                    @update:model-value="
                      (value: any) => {
                        const next = Number(value);
                        if (Number.isFinite(next)) editUiScale = next;
                      }
                    "
                  >
                    <SelectTrigger class="h-8 w-full">
                      <SelectValue>{{ Math.round(editUiScale * 100) }}%</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="scale in uiScaleOptions" :key="scale" :value="String(scale)" class="pl-2.5"> {{ Math.round(scale * 100) }}% </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div class="grid gap-3 md:grid-cols-2">
                <div class="settings-appearance-field min-w-0">
                  <div class="flex min-w-0 items-center gap-1">
                    <Label class="min-w-0 whitespace-normal leading-tight">{{ t("settings.uiFontFamily") }}</Label>
                    <HelpTooltip :label="t('settings.uiFontFamily')" trigger-class="[&_svg]:h-3 [&_svg]:w-3" content-class="max-w-64">
                      <p>{{ t("settings.uiFontFamilyDescription") }}</p>
                    </HelpTooltip>
                  </div>
                  <SearchableSelect
                    :model-value="editUiFontFamily"
                    :options="uiFontOptions"
                    :placeholder="t('settings.selectFont')"
                    :search-placeholder="t('settings.searchFont')"
                    :empty-text="t('settings.noFontsFound')"
                    :loading-text="t('settings.loadingFonts')"
                    allow-custom
                    :display-name="displayUiFontFamily"
                    :normalize-custom="normalizeCustomFontFamilyInput"
                    :trigger-class="appearanceFontSearchTriggerClass"
                    :trigger-icon-class="appearanceFontSearchTriggerIconClass"
                    content-class="w-[var(--reka-popover-trigger-width)] min-w-[260px]"
                    @update:model-value="onUiFontFamilyChange"
                    @update:open="(open: boolean) => open && loadSystemFontOptions()"
                  >
                    <template #trigger-label="{ label, loading }">
                      <span class="truncate" :style="{ fontFamily: editUiFontFamily }">
                        {{ loading ? t("settings.loadingFonts") : label }}
                      </span>
                    </template>
                    <template #option-label="{ option, label }">
                      <span class="truncate" :style="fontOptionStyle(option, editUiFontFamily)">{{ label }}</span>
                    </template>
                    <template #custom-option-label="{ value }">
                      <span class="truncate" :style="{ fontFamily: value }">
                        {{ t("settings.useCustomFont", { font: readableFontFamily(value) }) }}
                      </span>
                    </template>
                  </SearchableSelect>
                </div>

                <div class="settings-appearance-field min-w-0">
                  <div class="flex min-w-0 items-center gap-1">
                    <Label class="min-w-0 whitespace-normal leading-tight">{{ t("settings.dataGridFontFamily") }}</Label>
                    <HelpTooltip :label="t('settings.dataGridFontFamily')" trigger-class="[&_svg]:h-3 [&_svg]:w-3" content-class="max-w-64">
                      <p>{{ t("settings.dataGridFontFamilyDescription") }}</p>
                    </HelpTooltip>
                  </div>
                  <SearchableSelect
                    :model-value="editTableFontFamily"
                    :options="tableFontOptions"
                    :placeholder="t('settings.selectFont')"
                    :search-placeholder="t('settings.searchFont')"
                    :empty-text="t('settings.noFontsFound')"
                    :loading-text="t('settings.loadingFonts')"
                    allow-custom
                    :display-name="displayFontFamily"
                    :normalize-custom="normalizeCustomFontFamilyInput"
                    trigger-variant="outline"
                    trigger-class="h-9 w-full max-w-none justify-between"
                    content-class="w-[var(--reka-popover-trigger-width)] min-w-[260px]"
                    @update:model-value="onTableFontFamilyChange"
                    @update:open="(open: boolean) => open && loadSystemFontOptions()"
                  >
                    <template #trigger-label="{ label, loading }">
                      <span class="truncate" :style="{ fontFamily: editTableFontFamily }">
                        {{ loading ? t("settings.loadingFonts") : label }}
                      </span>
                    </template>
                    <template #option-label="{ option, label }">
                      <span class="truncate" :style="fontOptionStyle(option, editTableFontFamily)">{{ label }}</span>
                    </template>
                    <template #custom-option-label="{ value }">
                      <span class="truncate" :style="{ fontFamily: value }">
                        {{ t("settings.useCustomFont", { font: readableFontFamily(value) }) }}
                      </span>
                    </template>
                  </SearchableSelect>
                </div>
              </div>

              <div class="settings-appearance-group">
                <Label>{{ t("settings.theme") }}</Label>
                <div class="settings-appearance-button-row flex flex-wrap gap-2">
                  <Button
                    v-for="option in appThemeModeOptions"
                    :key="option.value"
                    type="button"
                    variant="outline"
                    size="sm"
                    class="settings-choice-button h-8 gap-1.5 rounded-[6px] px-3"
                    :class="themeMode === option.value ? 'settings-choice-button--selected border-primary/40 bg-primary/10 text-primary ring-1 ring-primary/30' : 'text-foreground'"
                    @click="setThemeMode(option.value)"
                  >
                    <component :is="option.icon" class="h-3.5 w-3.5" />
                    {{ option.label }}
                  </Button>
                </div>
              </div>

              <Separator />

              <div class="settings-appearance-group">
                <Label>{{ t("settings.appLayout") }}</Label>
                <div class="settings-appearance-choice-grid">
                  <Button type="button" variant="outline" class="settings-choice-card h-auto justify-start border p-3" :class="editAppLayout === 'separated' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setAppLayout('separated')">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger as-child>
                          <div class="w-full min-w-0 text-left">
                            <div class="text-sm font-medium">{{ t("settings.appLayoutSeparated") }}</div>
                            <div :ref="(el) => setLayoutDescRef('separated', el)" class="text-xs text-muted-foreground truncate">{{ t("settings.appLayoutSeparatedDescription") }}</div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent v-if="layoutDescTruncated.separated.value" class="max-w-[320px] text-xs leading-relaxed">
                          {{ t("settings.appLayoutSeparatedDescription") }}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Button>
                  <Button type="button" variant="outline" class="settings-choice-card h-auto justify-start border p-3" :class="editAppLayout === 'classic' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setAppLayout('classic')">
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger as-child>
                          <div class="w-full min-w-0 text-left">
                            <div class="text-sm font-medium">{{ t("settings.appLayoutClassic") }}</div>
                            <div :ref="(el) => setLayoutDescRef('classic', el)" class="text-xs text-muted-foreground truncate">{{ t("settings.appLayoutClassicDescription") }}</div>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent v-if="layoutDescTruncated.classic.value" class="max-w-[320px] text-xs leading-relaxed">
                          {{ t("settings.appLayoutClassicDescription") }}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </Button>
                </div>
              </div>

              <Separator />

              <div class="settings-appearance-group">
                <Label>{{ t("settings.tabLayout") }}</Label>
                <div class="settings-appearance-choice-grid">
                  <Button type="button" variant="outline" class="settings-choice-card h-auto justify-start border p-3" :class="editTabLayout === 'scroll' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setTabLayout('scroll')">
                    <div class="w-full min-w-0 text-left">
                      <div class="text-sm font-medium">{{ t("settings.tabLayoutScroll") }}</div>
                      <div class="text-xs text-muted-foreground">{{ t("settings.tabLayoutScrollDescription") }}</div>
                    </div>
                  </Button>
                  <Button type="button" variant="outline" class="settings-choice-card h-auto justify-start border p-3" :class="editTabLayout === 'wrap' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setTabLayout('wrap')">
                    <div class="w-full min-w-0 text-left">
                      <div class="text-sm font-medium">{{ t("settings.tabLayoutWrap") }}</div>
                      <div class="text-xs text-muted-foreground">{{ t("settings.tabLayoutWrapDescription") }}</div>
                    </div>
                  </Button>
                </div>
              </div>

              <!-- <div v-if="!isWeb" class="space-y-2"> -->
              <div class="settings-appearance-group">
                <Label>{{ t("settings.iconTheme") }}</Label>
                <div class="settings-appearance-choice-grid">
                  <Button type="button" variant="outline" class="settings-choice-card h-auto justify-start border p-3" :class="editIconTheme === 'default' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setIconTheme('default')">
                    <div class="flex items-center gap-3 text-left w-full min-w-0">
                      <img src="/icon-preview-default.png" alt="DBX" class="h-12 w-12 shrink-0" />
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger as-child>
                            <div class="w-full min-w-0 text-left">
                              <div class="text-sm font-medium">{{ t("settings.iconThemeDefault") }}</div>
                              <div :ref="(el) => setIconThemeDescRef('default', el)" class="text-xs text-muted-foreground truncate">{{ t("settings.iconThemeDefaultDescription") }}</div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent v-if="iconThemeDescTruncated.default.value" class="max-w-[320px] text-xs leading-relaxed">
                            {{ t("settings.iconThemeDefaultDescription") }}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </Button>
                  <Button type="button" variant="outline" class="settings-choice-card h-auto justify-start border p-3" :class="editIconTheme === 'black' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setIconTheme('black')">
                    <div class="flex items-center gap-3 text-left w-full min-w-0">
                      <img src="/icon-preview-black.png" alt="DBX" class="h-12 w-12 shrink-0" />
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger as-child>
                            <div class="w-full min-w-0 text-left">
                              <div class="text-sm font-medium">{{ t("settings.iconThemeBlack") }}</div>
                              <div :ref="(el) => setIconThemeDescRef('black', el)" class="text-xs text-muted-foreground truncate">{{ iconThemeBlackDescriptionText }}</div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent v-if="iconThemeDescTruncated.black.value" class="max-w-[320px] text-xs leading-relaxed">
                            {{ iconThemeBlackDescriptionText }}
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  </Button>
                </div>
              </div>

              <div v-if="!isWeb" class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="space-y-1">
                  <Label for="show-tray-icon">{{ t("settings.showTrayIcon") }}</Label>
                  <p class="text-xs text-muted-foreground">{{ t("settings.showTrayIconDescription") }}</p>
                </div>
                <Switch id="show-tray-icon" v-model="editShowTrayIcon" />
              </div>

              <div v-if="!isWeb" class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="space-y-1">
                  <Label for="quit-on-close">{{ t("settings.quitOnClose") }}</Label>
                  <p class="text-xs text-muted-foreground">{{ t("settings.quitOnCloseDescription") }}</p>
                </div>
                <Switch id="quit-on-close" v-model="editQuitOnClose" />
              </div>

              <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="space-y-1">
                  <Label for="update-notifications-enabled">{{ t("settings.updateNotificationsEnabled") }}</Label>
                  <p class="text-xs text-muted-foreground">
                    {{ t("settings.updateNotificationsEnabledDescription") }}
                  </p>
                </div>
                <Switch id="update-notifications-enabled" v-model="editUpdateNotificationsEnabled" />
              </div>

              <div v-if="!isWeb" class="flex flex-col gap-3 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center justify-between gap-4">
                  <div class="space-y-1">
                    <Label for="debug-logging-enabled">{{ t("settings.debugLoggingEnabled") }}</Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.debugLoggingEnabledDescription") }}
                    </p>
                  </div>
                  <Switch id="debug-logging-enabled" v-model="editDebugLoggingEnabled" />
                </div>
                <div class="flex justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" @click="clearDebugLogs">
                    {{ t("settings.debugLogsClear") }}
                  </Button>
                  <Button type="button" variant="outline" size="sm" @click="copyDebugLogs">
                    {{ debugLogCopied ? t("settings.debugLogsCopied") : t("settings.debugLogsCopy") }}
                  </Button>
                  <Button type="button" variant="outline" size="sm" @click="exportDebugLogs">
                    {{ debugLogDownloaded ? t("settings.debugLogsDownloaded") : t("settings.debugLogsDownload") }}
                  </Button>
                </div>
              </div>

              <Separator />

              <div class="settings-appearance-group settings-option-stack">
                <Label>{{ t("settings.dataGridDisplay") }}</Label>
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="show-column-comments-in-header">
                      {{ t("settings.showColumnCommentsInHeader") }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.showColumnCommentsInHeaderDescription") }}
                    </p>
                  </div>
                  <Switch id="show-column-comments-in-header" v-model="editShowColumnCommentsInHeader" />
                </div>
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="show-column-types-in-header">
                      {{ t("settings.showColumnTypesInHeader") }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.showColumnTypesInHeaderDescription") }}
                    </p>
                  </div>
                  <Switch id="show-column-types-in-header" v-model="editShowColumnTypesInHeader" />
                </div>
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="compact-column-header-actions">
                      {{ t("settings.compactColumnHeaderActions") }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.compactColumnHeaderActionsDescription") }}
                    </p>
                  </div>
                  <Switch id="compact-column-header-actions" v-model="editCompactColumnHeaderActions" />
                </div>
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="data-grid-quick-entry">
                      {{ t("settings.dataGridQuickEntry") }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.dataGridQuickEntryDescription") }}
                    </p>
                  </div>
                  <Switch id="data-grid-quick-entry" v-model="editDataGridQuickEntry" />
                </div>
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="infinite-scroll">
                      {{ t("settings.infiniteScroll") }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.infiniteScrollDescription") }}
                    </p>
                  </div>
                  <Switch id="infinite-scroll" v-model="editInfiniteScroll" />
                </div>
                <div v-if="editInfiniteScroll" class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="infinite-scroll-max-rows">
                      {{ t("settings.infiniteScrollMaxRows") }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.infiniteScrollMaxRowsDescription") }}
                    </p>
                  </div>
                  <Input
                    id="infinite-scroll-max-rows"
                    v-model="editInfiniteScrollMaxRows"
                    type="number"
                    inputmode="numeric"
                    :min="1000"
                    :max="50000"
                    class="h-7 w-24 px-2 text-xs tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  />
                </div>
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="auto-calculate-total-rows">
                      {{ t("settings.autoCalculateTotalRows") }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.autoCalculateTotalRowsDescription") }}
                    </p>
                  </div>
                  <Switch id="auto-calculate-total-rows" v-model="editAutoCalculateTotalRows" />
                </div>
              </div>

              <Separator />

              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <Label>{{ t("settings.toolbarTitle") }}</Label>
                  <HelpTooltip :label="t('settings.toolbarTitle')" content-class="max-w-64">
                    <p>{{ t("settings.toolbarHiddenHint") }}</p>
                  </HelpTooltip>
                </div>
                <div class="flex items-center justify-between gap-4 rounded-md border border-border/60 p-3">
                  <div class="space-y-1">
                    <Label for="exclusive-right-sidebar-panels" class="text-sm cursor-pointer">{{ t("settings.exclusiveRightSidebarPanels") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.exclusiveRightSidebarPanelsDescription") }}</p>
                  </div>
                  <Switch id="exclusive-right-sidebar-panels" v-model="editToolbarItems.exclusiveRightSidebarPanels" />
                </div>
                <div class="grid grid-cols-3 gap-2 mt-2">
                  <div
                    v-for="item in [
                      { key: 'dataTransfer', label: t('transfer.dataTransfer') },
                      { key: 'driverManager', label: t('toolbar.driverManager') },
                      { key: 'sqlFile', label: t('sqlFile.title') },
                      { key: 'schemaDiff', label: t('diff.title') },
                      { key: 'dataCompare', label: t('dataCompare.title') },
                      { key: 'checkUpdates', label: t('updates.check') },
                      { key: 'sqlLibrary', label: t('sqlLibrary.title') },
                      { key: 'sqlFileTree', label: t('sqlFileTree.title') },
                      { key: 'history', label: t('history.title') },
                      { key: 'ai', label: 'AI' },
                      { key: 'theme', label: t('toolbar.theme') },
                      { key: 'github', label: 'GitHub' },
                    ]"
                    :key="item.key"
                    class="flex items-center gap-2"
                  >
                    <Switch :id="`toolbar-${item.key}`" :model-value="(editToolbarItems as any)[item.key]" @update:model-value="(v: boolean) => ((editToolbarItems as any)[item.key] = v)" />
                    <Label :for="`toolbar-${item.key}`" class="text-sm cursor-pointer">{{ item.label }}</Label>
                  </div>
                </div>
              </div>
            </section>

            <section v-else-if="activeSettingsTab === 'navigation'" class="flex flex-col gap-5 py-2">
              <div class="space-y-2">
                <Label>{{ t("settings.sidebarActivation") }}</Label>
                <div class="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="editSidebarActivation === 'single' ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setSidebarActivation('single')">
                    <div class="text-left">
                      <div class="text-sm font-medium">{{ t("settings.sidebarActivationSingle") }}</div>
                      <div class="text-xs text-muted-foreground">
                        {{ t("settings.sidebarActivationSingleDescription") }}
                      </div>
                    </div>
                  </Button>
                  <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="editSidebarActivation === 'double' ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setSidebarActivation('double')">
                    <div class="text-left">
                      <div class="text-sm font-medium">{{ t("settings.sidebarActivationDouble") }}</div>
                      <div class="text-xs text-muted-foreground">
                        {{ t("settings.sidebarActivationDoubleDescription") }}
                      </div>
                    </div>
                  </Button>
                </div>
              </div>
              <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center gap-2">
                  <Label for="reuse-data-tab">{{ t("settings.reuseDataTab") }}</Label>
                  <HelpTooltip :label="t('settings.reuseDataTab')">
                    {{ t("settings.reuseDataTabDescription") }}
                  </HelpTooltip>
                </div>
                <Switch id="reuse-data-tab" v-model="editReuseDataTab" />
              </div>
              <div class="space-y-2">
                <Label>{{ t("settings.sidebarObjectDisplay") }}</Label>
                <div class="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="editSidebarObjectDisplay === 'grouped' ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setSidebarObjectDisplay('grouped')">
                    <div class="text-left">
                      <div class="flex items-center gap-2">
                        <div class="text-sm font-medium">{{ t("settings.sidebarObjectDisplayGrouped") }}</div>
                        <Tooltip :open="sidebarObjectDisplayHelp === 'grouped'">
                          <TooltipTrigger as-child>
                            <span class="inline-flex shrink-0 cursor-help text-muted-foreground hover:text-foreground" @click.stop @pointerdown.stop @mouseenter="sidebarObjectDisplayHelp = 'grouped'" @mouseleave="sidebarObjectDisplayHelp = null">
                              <CircleHelp class="h-3.5 w-3.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent class="max-w-[320px] text-xs leading-relaxed" side="top" align="center" :side-offset="8">
                            {{ t("settings.sidebarObjectDisplayGroupedDescription") }}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </Button>
                  <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="editSidebarObjectDisplay === 'simple' ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setSidebarObjectDisplay('simple')">
                    <div class="text-left">
                      <div class="flex items-center gap-2">
                        <div class="text-sm font-medium">{{ t("settings.sidebarObjectDisplaySimple") }}</div>
                        <Tooltip :open="sidebarObjectDisplayHelp === 'simple'">
                          <TooltipTrigger as-child>
                            <span class="inline-flex shrink-0 cursor-help text-muted-foreground hover:text-foreground" @click.stop @pointerdown.stop @mouseenter="sidebarObjectDisplayHelp = 'simple'" @mouseleave="sidebarObjectDisplayHelp = null">
                              <CircleHelp class="h-3.5 w-3.5" />
                            </span>
                          </TooltipTrigger>
                          <TooltipContent class="max-w-[320px] text-xs leading-relaxed" side="top" align="center" :side-offset="8">
                            {{ t("settings.sidebarObjectDisplaySimpleDescription") }}
                          </TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </Button>
                </div>
              </div>
              <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center gap-2">
                  <Label for="sidebar-table-search-enabled">{{ t("settings.sidebarTableSearchEnabled") }}</Label>
                  <HelpTooltip :label="t('settings.sidebarTableSearchEnabled')">
                    {{ t("settings.sidebarTableSearchEnabledDescription") }}
                  </HelpTooltip>
                </div>
                <Switch id="sidebar-table-search-enabled" v-model="editSidebarTableSearchEnabled" />
              </div>
              <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center gap-2">
                  <Label for="auto-select-active-sidebar-node">{{ t("settings.autoSelectActiveSidebarNode") }}</Label>
                  <HelpTooltip :label="t('settings.autoSelectActiveSidebarNode')">
                    {{ t("settings.autoSelectActiveSidebarNodeDescription") }}
                  </HelpTooltip>
                </div>
                <Switch id="auto-select-active-sidebar-node" v-model="editAutoSelectActiveSidebarNode" />
              </div>
              <div class="space-y-2 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center gap-2">
                  <Label for="open-tabs-restore-mode">{{ t("settings.openTabsRestoreMode") }}</Label>
                  <HelpTooltip :label="t('settings.openTabsRestoreMode')">
                    {{ t("settings.openTabsRestoreModeDescription") }}
                  </HelpTooltip>
                </div>
                <Select :model-value="editOpenTabsRestoreMode" @update:model-value="(value) => (editOpenTabsRestoreMode = value as OpenTabsRestoreMode)">
                  <SelectTrigger id="open-tabs-restore-mode" class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{{ t("settings.openTabsRestoreModeAll") }}</SelectItem>
                    <SelectItem value="pinned">{{ t("settings.openTabsRestoreModePinned") }}</SelectItem>
                    <SelectItem value="none">{{ t("settings.openTabsRestoreModeNone") }}</SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">
                  {{ t("settings.openTabsRestoreModeHint") }}
                </p>
              </div>
              <div class="space-y-2 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center gap-2">
                  <Label for="disconnect-tab-handling-mode">{{ t("settings.disconnectTabHandlingMode") }}</Label>
                  <HelpTooltip :label="t('settings.disconnectTabHandlingMode')">
                    {{ t("settings.disconnectTabHandlingModeDescription") }}
                  </HelpTooltip>
                </div>
                <Select :model-value="editDisconnectTabHandlingMode" @update:model-value="onDisconnectTabHandlingModeChange">
                  <SelectTrigger id="disconnect-tab-handling-mode" class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="close-tabs">{{ t("settings.disconnectTabHandlingModeCloseTabs") }}</SelectItem>
                    <SelectItem value="keep-tabs-clear-results">
                      {{ t("settings.disconnectTabHandlingModeKeepTabsClearResults") }}
                    </SelectItem>
                    <SelectItem value="keep-tabs-keep-results">
                      {{ t("settings.disconnectTabHandlingModeKeepTabsKeepResults") }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">
                  {{ t(`settings.${disconnectTabHandlingModeDescriptionKey}`) }}
                </p>
              </div>
              <div class="space-y-2 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center gap-2">
                  <Label for="sidebar-object-info-mode">{{ t("settings.sidebarObjectInfoMode") }}</Label>
                  <HelpTooltip :label="t('settings.sidebarObjectInfoMode')">
                    {{ t("settings.sidebarObjectInfoModeDescription") }}
                  </HelpTooltip>
                </div>
                <Select :model-value="editSidebarObjectInfoMode" @update:model-value="(value) => (editSidebarObjectInfoMode = value as SidebarObjectInfoMode)">
                  <SelectTrigger id="sidebar-object-info-mode" class="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="comment-aligned">{{ t("settings.sidebarObjectInfoModeCommentAligned") }}</SelectItem>
                    <SelectItem value="comment-inline">{{ t("settings.sidebarObjectInfoModeCommentInline") }}</SelectItem>
                    <SelectItem value="size">{{ t("settings.sidebarObjectInfoModeSize") }}</SelectItem>
                    <SelectItem value="hidden">{{ t("settings.sidebarObjectInfoModeHidden") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center gap-2">
                  <Label for="sidebar-allow-horizontal-scroll">
                    {{ t("settings.sidebarAllowHorizontalScroll") }}
                  </Label>
                  <HelpTooltip :label="t('settings.sidebarAllowHorizontalScroll')">
                    {{ t("settings.sidebarAllowHorizontalScrollDescription") }}
                  </HelpTooltip>
                </div>
                <Switch id="sidebar-allow-horizontal-scroll" v-model="editSidebarAllowHorizontalScroll" />
              </div>
              <div class="space-y-2">
                <Label for="sidebar-hidden-table-prefixes">{{ t("settings.sidebarHiddenTablePrefixes") }}</Label>
                <textarea
                  id="sidebar-hidden-table-prefixes"
                  v-model="editSidebarHiddenTablePrefixes"
                  class="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none transition-colors placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  :placeholder="t('settings.sidebarHiddenTablePrefixesPlaceholder')"
                />
                <p class="text-xs text-muted-foreground">
                  {{ t("settings.sidebarHiddenTablePrefixesDescription") }}
                </p>
              </div>
              <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="space-y-1">
                  <Label for="sidebar-table-page-size">{{ t("settings.sidebarTablePageSize") }}</Label>
                  <p class="text-xs text-muted-foreground">
                    {{ t("settings.sidebarTablePageSizeDescription") }}
                  </p>
                </div>
                <Input
                  id="sidebar-table-page-size"
                  type="number"
                  class="w-24 text-right"
                  :min="100"
                  :max="10000"
                  :step="100"
                  :model-value="editSidebarTablePageSize"
                  @update:model-value="
                    (value: string | number) => {
                      const n = typeof value === 'string' ? parseInt(value) : value;
                      if (!isNaN(n)) editSidebarTablePageSize = n;
                    }
                  "
                />
              </div>
            </section>

            <!-- Data Tab -->
            <section v-else-if="activeSettingsTab === 'data'" class="flex flex-col gap-5 py-2">
              <div class="space-y-3">
                <div class="text-sm font-medium text-muted-foreground">{{ t("settings.dataGridDisplay") }}</div>
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="table-open-page-size">
                      {{ t("settings.tableOpenPageSize") }}
                    </Label>
                    <p class="text-xs text-muted-foreground">
                      {{ t("settings.tableOpenPageSizeDescription") }}
                    </p>
                  </div>
                  <Input id="table-open-page-size" type="number" inputmode="numeric" class="h-7 w-24 px-2 text-right text-xs tabular-nums" :min="MIN_RESULT_PAGE_SIZE" :max="MAX_RESULT_PAGE_SIZE" :model-value="editTableOpenPageSize" @update:model-value="updateTableOpenPageSizeDraft" />
                </div>
              </div>

              <template v-if="!isWeb">
                <div class="space-y-3">
                  <div class="text-sm font-medium text-muted-foreground">DuckDB</div>
                  <div class="space-y-3 rounded-md border bg-muted/20 px-3 py-2">
                    <div class="flex items-start justify-between gap-4">
                      <div class="space-y-1">
                        <Label for="duckdb-worker-process-isolation">
                          {{ t("settings.duckDbWorkerProcessIsolation") }}
                        </Label>
                        <p class="text-xs text-muted-foreground">
                          {{ t("settings.duckDbWorkerProcessIsolationDescription") }}
                        </p>
                      </div>
                      <Switch id="duckdb-worker-process-isolation" v-model="editDuckDbWorkerProcessIsolation" class="mt-0.5" />
                    </div>
                    <div class="flex items-start justify-between gap-4">
                      <div class="space-y-1">
                        <Label for="duckdb-worker-max-processes">
                          {{ t("settings.duckDbWorkerMaxProcesses") }}
                        </Label>
                        <p class="text-xs text-muted-foreground">
                          {{ t("settings.duckDbWorkerMaxProcessesDescription") }}
                        </p>
                      </div>
                      <Input
                        id="duckdb-worker-max-processes"
                        v-model.number="editDuckDbWorkerMaxProcesses"
                        type="number"
                        class="h-8 w-20 text-right [&::-webkit-inner-spin-button]:appearance-none"
                        :min="DUCKDB_WORKER_MAX_PROCESSES_MIN"
                        :max="DUCKDB_WORKER_MAX_PROCESSES_MAX"
                        :step="1"
                        @blur="editDuckDbWorkerMaxProcesses = normalizeDuckDbWorkerMaxProcesses(editDuckDbWorkerMaxProcesses)"
                      />
                    </div>
                    <div v-if="duckDbWorkerSettingsRequireRestart" class="flex flex-wrap items-center gap-2 border-t pt-2">
                      <p class="text-xs font-medium text-amber-600 dark:text-amber-400">
                        {{ t("settings.duckDbWorkerProcessIsolationRestartRequired") }}
                      </p>
                      <Button type="button" variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="duckDbRestarting || hasApplyBlocker" @click="restartDbxForDuckDbIsolation">
                        <Loader2 v-if="duckDbRestarting" class="size-3.5 animate-spin" />
                        <RefreshCw v-else class="size-3.5" />
                        {{ t("settings.restartDbx") }}
                      </Button>
                    </div>
                  </div>
                </div>

                <Separator />
              </template>

              <div class="space-y-3">
                <div class="text-sm font-medium text-muted-foreground">{{ t("settings.dateTimeSection") }}</div>
                <div class="grid gap-3 rounded-md border bg-muted/20 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(220px,0.8fr)] sm:items-center">
                  <div>
                    <Label>{{ t("settings.globalDateTimeDisplayFormat") }}</Label>
                    <p class="mt-1 text-xs text-muted-foreground">{{ t("settings.globalDateTimeDisplayFormatDescription") }}</p>
                  </div>
                  <SearchableSelect
                    v-model="editGlobalDateTimeDisplayFormat"
                    :options="globalDateTimeFormatOptions"
                    :display-name="globalDateTimeRawFormatLabel"
                    :placeholder="t('settings.dateTimeFormatRaw')"
                    :search-placeholder="t('settings.dateTimeFormatSearchPlaceholder')"
                    :empty-text="t('settings.dateTimeFormatEmpty')"
                    :normalize-custom="normalizeSupportedDateTimePattern"
                    allow-custom
                    clearable
                    trigger-variant="outline"
                    trigger-class="h-9 w-full max-w-none justify-between"
                  />
                  <div>
                    <Label>{{ t("settings.globalDateTimeExportFormat") }}</Label>
                    <p class="mt-1 text-xs text-muted-foreground">{{ t("settings.globalDateTimeExportFormatDescription") }}</p>
                  </div>
                  <SearchableSelect
                    v-model="editGlobalDateTimeExportFormat"
                    :options="globalDateTimeFormatOptions"
                    :display-name="globalDateTimeRawFormatLabel"
                    :placeholder="t('settings.dateTimeFormatRaw')"
                    :search-placeholder="t('settings.dateTimeFormatSearchPlaceholder')"
                    :empty-text="t('settings.dateTimeFormatEmpty')"
                    :normalize-custom="normalizeSupportedDateTimePattern"
                    allow-custom
                    clearable
                    trigger-variant="outline"
                    trigger-class="h-9 w-full max-w-none justify-between"
                  />
                  <div>
                    <Label>{{ t("settings.globalDateTimeImportFormat") }}</Label>
                    <p class="mt-1 text-xs text-muted-foreground">{{ t("settings.globalDateTimeImportFormatDescription") }}</p>
                  </div>
                  <SearchableSelect
                    v-model="editGlobalDateTimeImportFormat"
                    :options="globalDateTimeFormatOptions"
                    :display-name="globalDateTimeAutoFormatLabel"
                    :placeholder="t('settings.dateTimeFormatAuto')"
                    :search-placeholder="t('settings.dateTimeFormatSearchPlaceholder')"
                    :empty-text="t('settings.dateTimeFormatEmpty')"
                    :normalize-custom="normalizeSupportedDateTimePattern"
                    allow-custom
                    clearable
                    trigger-variant="outline"
                    trigger-class="h-9 w-full max-w-none justify-between"
                  />
                </div>
              </div>

              <Separator />

              <div class="space-y-3">
                <div class="text-sm font-medium text-muted-foreground">{{ t("settings.exportSection") }}</div>
                <div class="space-y-2">
                  <Label>{{ t("settings.exportBatchSize") }}</Label>
                  <div class="flex items-center gap-3">
                    <Input type="number" list="export-batch-sizes" min="100" max="100000" step="100" v-model.number="editExportBatchSize" class="h-9 w-28 [&::-webkit-inner-spin-button]:appearance-none" />
                    <datalist id="export-batch-sizes">
                      <option value="500" />
                      <option value="1000" />
                      <option value="2000" />
                      <option value="5000" />
                      <option value="10000" />
                    </datalist>
                    <span class="text-xs text-muted-foreground">{{ t("settings.exportBatchSizeDescription") }}</span>
                  </div>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <div class="space-y-0.5">
                    <Label for="export-row-limit-enabled">{{ t("settings.exportRowLimitEnabled") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.exportRowLimitEnabledDescription") }}</p>
                  </div>
                  <Switch id="export-row-limit-enabled" v-model="editExportRowLimitEnabled" class="mt-0.5" />
                </div>
                <div class="space-y-2">
                  <Label for="export-row-limit">{{ t("settings.exportRowLimit") }}</Label>
                  <div class="flex items-center gap-3">
                    <Input id="export-row-limit" type="number" min="100" max="2147483647" step="100" v-model.number="editExportRowLimit" :disabled="!editExportRowLimitEnabled" class="h-9 w-32 [&::-webkit-inner-spin-button]:appearance-none" />
                    <span class="text-xs text-muted-foreground">
                      {{ editExportRowLimitEnabled ? t("settings.exportRowLimitDescription") : t("settings.exportRowLimitUnlimited") }}
                    </span>
                  </div>
                </div>
                <div class="flex items-start justify-between gap-3">
                  <div class="space-y-0.5">
                    <Label for="query-export-keyset-enabled">{{ t("settings.queryExportKeysetOptimizationEnabled") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.queryExportKeysetOptimizationEnabledDescription") }}</p>
                  </div>
                  <Switch id="query-export-keyset-enabled" v-model="editQueryExportKeysetOptimizationEnabled" class="mt-0.5" />
                </div>
              </div>

              <Separator />

              <div class="space-y-3">
                <div class="text-sm font-medium text-muted-foreground">{{ t("settings.tableStructureSection") }}</div>
                <div ref="tableColumnTemplateSectionRef" class="space-y-2 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="flex items-start justify-between gap-3">
                    <div class="space-y-1">
                      <Label>{{ t("settings.tableColumnTemplateFields") }}</Label>
                      <p class="text-xs text-muted-foreground">{{ t("settings.tableColumnTemplateFieldsDescription") }}</p>
                    </div>
                    <div class="flex items-center gap-2">
                      <Select v-model="editTableColumnTemplateDatabaseType">
                        <SelectTrigger class="h-8 w-44 px-2 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent class="max-h-72">
                          <SelectItem v-for="dbType in TABLE_COLUMN_TEMPLATE_DATABASE_TYPES" :key="dbType" :value="dbType">
                            {{ dbType }}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <Button type="button" size="sm" variant="outline" @click="addTableColumnTemplateRow">
                        {{ t("settings.tableColumnTemplateAdd") }}
                      </Button>
                    </div>
                  </div>
                  <div class="overflow-x-auto rounded-md border bg-background">
                    <table class="w-full min-w-[900px] border-separate border-spacing-0 text-xs">
                      <thead class="bg-muted/50 text-muted-foreground">
                        <tr>
                          <th class="w-8 border-b px-2 py-1.5" />
                          <th class="border-b px-2 py-1.5 text-left font-medium">{{ t("settings.tableColumnTemplateColumn") }}</th>
                          <th class="border-b px-2 py-1.5 text-left font-medium">{{ t("settings.tableColumnTemplateType") }}</th>
                          <th class="border-b px-2 py-1.5 text-left font-medium">{{ t("settings.tableColumnTemplateLength") }}</th>
                          <th class="border-b px-2 py-1.5 text-left font-medium">{{ t("settings.tableColumnTemplateDefault") }}</th>
                          <th class="border-b px-2 py-1.5 text-left font-medium">{{ t("settings.tableColumnTemplateRequired") }}</th>
                          <th class="border-b px-2 py-1.5 text-left font-medium">{{ t("settings.tableColumnTemplateComment") }}</th>
                          <th class="w-10 border-b px-2 py-1.5" />
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="row in visibleTableColumnTemplateRows" :key="row.id" :data-table-column-template-row-id="row.id" :class="draggedTableColumnTemplateRowId === row.id ? 'opacity-60' : ''">
                          <td class="border-b px-2 py-1.5 align-middle">
                            <button
                              type="button"
                              class="flex h-7 w-6 cursor-grab touch-none items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground active:cursor-grabbing"
                              :aria-label="t('settings.tableColumnTemplateDragHandle')"
                              @pointerdown="startTableColumnTemplateRowDrag(row.id, $event)"
                            >
                              <GripVertical class="h-3.5 w-3.5" />
                            </button>
                          </td>
                          <td class="border-b px-2 py-1.5">
                            <Input v-model="row.name" class="h-7 px-2 text-xs" />
                          </td>
                          <td class="border-b px-2 py-1.5">
                            <SearchableSelect
                              :model-value="tableColumnTemplateBaseTypeForSelectedDatabase(row)"
                              :options="tableColumnTemplateTypeOptions(editTableColumnTemplateDatabaseType)"
                              :placeholder="t('settings.tableColumnTemplateNoPresetType')"
                              :search-placeholder="t('structureEditor.typePlaceholder')"
                              :empty-text="t('structureEditor.noMatchingType')"
                              :loading-text="t('common.loading')"
                              :allow-custom="true"
                              :trigger-class="['h-7 w-full px-2 font-mono text-xs']"
                              @update:model-value="setTableColumnTemplateBaseTypeForSelectedDatabase(row, $event)"
                            />
                          </td>
                          <td class="border-b px-2 py-1.5">
                            <Input :model-value="tableColumnTemplateLengthForSelectedDatabase(row)" class="h-7 w-28 px-2 font-mono text-xs" :disabled="isTableColumnTemplateLengthDisabled(row)" @update:model-value="setTableColumnTemplateLengthForSelectedDatabase(row, String($event))" />
                          </td>
                          <td class="border-b px-2 py-1.5">
                            <Input v-model="row.defaultValue" class="h-7 px-2 font-mono text-xs" />
                          </td>
                          <td class="border-b px-2 py-1.5">
                            <Switch v-model="row.required" />
                          </td>
                          <td class="border-b px-2 py-1.5">
                            <Input v-model="row.comment" class="h-7 px-2 text-xs" />
                          </td>
                          <td class="border-b px-2 py-1.5 text-right">
                            <Button type="button" variant="ghost" size="icon" class="h-7 w-7" @click="removeTableColumnTemplateRow(row.id)">
                              <X class="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </section>

            <section v-else-if="activeSettingsTab === 'shortcuts'" class="flex flex-col gap-2 py-2">
              <div class="relative">
                <Search class="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="shortcutSearchQuery" autocomplete="off" :placeholder="t('settings.shortcutSearchPlaceholder')" class="h-9 pl-9 text-sm" />
              </div>
              <div class="overflow-hidden rounded-md border border-border/70 bg-background">
                <div v-if="filteredShortcutDefinitions.length === 0" class="px-3 py-8 text-center text-sm text-muted-foreground">
                  {{ t("settings.shortcutSearchNoResults") }}
                </div>
                <div v-for="definition in filteredShortcutDefinitions" :key="definition.id" class="group -mt-px grid gap-2 border-t border-border/70 px-3 py-2 transition-colors first:mt-0 first:border-t-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <div class="min-w-0">
                    <div class="flex min-w-0 items-center gap-2">
                      <Label class="min-w-0 truncate leading-none">{{ t(definition.labelKey) }}</Label>
                      <Badge variant="outline" class="h-5 shrink-0 rounded-md border-border/60 px-1.5 text-[11px] font-normal text-muted-foreground">
                        {{ t(`settings.shortcutScope${definition.scope[0].toUpperCase()}${definition.scope.slice(1)}`) }}
                      </Badge>
                    </div>
                  </div>
                  <div class="min-w-0 space-y-1">
                    <div class="flex items-center justify-end gap-1.5">
                      <input
                        :data-shortcut-input="definition.id"
                        :value="editingShortcutId === definition.id ? '' : formatShortcutPill(editShortcuts[definition.id])"
                        :style="{
                          width: editingShortcutId === definition.id ? shortcutPressShortcutInputWidth : `${Math.max(4, formatShortcutPill(editShortcuts[definition.id]).length + 3)}ch`,
                        }"
                        readonly
                        :aria-invalid="shortcutConflicts.includes(definition.id)"
                        :placeholder="t('settings.shortcutPressShortcut')"
                        class="h-7 w-auto min-w-12 max-w-64 shrink-0 cursor-default rounded-[6px] border border-transparent bg-muted px-2.5 text-center font-mono text-[13px] font-semibold text-foreground/75 shadow-inner outline-none selection:bg-transparent placeholder:text-muted-foreground aria-invalid:border-destructive/70 aria-invalid:text-destructive aria-invalid:ring-destructive/20"
                        :class="editingShortcutId === definition.id ? 'max-w-64 cursor-text border-border/80 bg-background text-left text-foreground shadow-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35' : ''"
                        @keydown="(event: KeyboardEvent) => onShortcutKeydown(definition.id, event)"
                      />
                      <Button
                        v-if="editingShortcutId !== definition.id"
                        type="button"
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        :aria-label="t('settings.shortcutPressShortcut')"
                        @click="focusShortcutInput(definition.id)"
                      >
                        <Pencil class="h-4 w-4" />
                      </Button>
                      <Button v-else type="button" variant="ghost" size="sm" class="h-7 shrink-0 px-2 text-sm font-medium text-muted-foreground hover:text-foreground" @click="cancelShortcutEdit">
                        {{ t("settings.cancel") }}
                      </Button>
                      <Button
                        v-if="editingShortcutId !== definition.id"
                        type="button"
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                        :aria-label="t('settings.reset')"
                        @click="resetShortcut(definition.id)"
                      >
                        <RotateCcw class="h-4 w-4" />
                      </Button>
                      <Button
                        v-if="editingShortcutId !== definition.id && editShortcuts[definition.id]"
                        type="button"
                        variant="ghost"
                        size="icon"
                        class="h-7 w-7 shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                        :aria-label="t('settings.shortcutClear')"
                        @click="clearShortcut(definition.id)"
                      >
                        <X class="h-4 w-4" />
                      </Button>
                      <span v-else-if="editingShortcutId !== definition.id" class="h-7 w-7 shrink-0" aria-hidden="true" />
                    </div>
                    <p v-if="shortcutConflicts.includes(definition.id)" class="text-xs text-destructive">
                      {{ t("settings.shortcutConflict") }}
                    </p>
                  </div>
                </div>
              </div>
            </section>

            <!-- Snippets Tab -->
            <section v-else-if="activeSettingsTab === 'snippets'" class="flex flex-col gap-4 py-2">
              <div class="flex items-center justify-between">
                <p class="text-sm text-muted-foreground">{{ t("settings.snippetsDescription") }}</p>
                <Button variant="outline" size="sm" @click="openAddSnippetDialog">
                  <Plus class="mr-2 h-4 w-4" />
                  {{ t("settings.snippetsAdd") }}
                </Button>
              </div>

              <div class="overflow-x-auto rounded-md border">
                <table class="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr class="border-b bg-muted/50">
                      <th class="px-3 py-2 text-left font-medium whitespace-nowrap">
                        {{ t("settings.snippetsLabel") }}
                      </th>
                      <th class="px-3 py-2 text-left font-medium whitespace-nowrap">
                        {{ t("settings.snippetsPrefix") }}
                      </th>
                      <th class="px-3 py-2 text-left font-medium whitespace-nowrap">
                        {{ t("settings.snippetsStatus") }}
                      </th>
                      <th class="px-3 py-2 text-left font-medium whitespace-nowrap">
                        {{ t("settings.snippetsBody") }}
                      </th>
                      <th class="px-3 py-2 w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="snippet in editSnippets" :key="snippet.id" class="border-b last:border-b-0 hover:bg-muted/30" :class="snippet.enabled === false ? 'text-muted-foreground' : ''">
                      <td class="px-3 py-2">{{ snippet.label }}</td>
                      <td class="px-3 py-2">
                        <Badge variant="outline" class="h-5 rounded-md px-1.5 text-[11px] font-mono text-muted-foreground">
                          {{ snippet.prefix }}
                        </Badge>
                      </td>
                      <td class="px-3 py-2">
                        <div class="flex items-center gap-2">
                          <Switch :id="`snippet-enabled-${snippet.id}`" :model-value="snippet.enabled !== false" size="sm" :aria-label="t('settings.snippetsToggle')" @update:model-value="(value: boolean) => setSnippetEnabled(snippet.id, value)" />
                          <Label :for="`snippet-enabled-${snippet.id}`" class="text-xs font-normal text-muted-foreground">
                            {{ snippet.enabled === false ? t("settings.snippetsDisabled") : t("settings.snippetsEnabled") }}
                          </Label>
                        </div>
                      </td>
                      <td class="px-3 py-2 font-mono text-xs text-muted-foreground max-w-[300px] truncate">
                        {{ snippet.body }}
                      </td>
                      <td class="px-3 py-2">
                        <div class="flex items-center gap-1">
                          <Button variant="ghost" size="icon-xs" @click="openEditSnippetDialog(snippet)">
                            <Pencil class="size-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon-xs" @click="confirmDeleteSnippet(snippet)">
                            <Trash2 class="size-3.5" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section v-else-if="activeSettingsTab === 'backups' && !isWeb" class="py-2">
              <ScheduledDatabaseBackupSettings />
            </section>

            <section v-else-if="activeSettingsTab === 'sync'" class="py-2">
              <Tabs v-model="syncMethodTab" class="w-full">
                <TabsList class="grid w-full grid-cols-2">
                  <TabsTrigger value="webdav">WebDAV</TabsTrigger>
                  <TabsTrigger value="snippet">GitHub / Gitee</TabsTrigger>
                </TabsList>

                <TabsContent value="webdav" class="mt-5 space-y-5">
                  <div class="space-y-1">
                    <div class="flex items-center gap-2 text-sm font-medium">
                      <Cloud class="h-4 w-4 text-muted-foreground" />
                      {{ t("settings.syncWebDavTitle") }}
                    </div>
                    <p class="text-xs text-muted-foreground">{{ t("settings.syncWebDavDescription") }}</p>
                  </div>

                  <div class="grid gap-4 md:grid-cols-2">
                    <div class="space-y-2 md:col-span-2">
                      <Label for="webdav-endpoint">{{ t("settings.syncEndpoint") }}</Label>
                      <Input id="webdav-endpoint" v-model="webdavEndpoint" autocomplete="off" placeholder="https://example.com/remote.php/dav/files/user/" />
                    </div>
                    <div class="space-y-2">
                      <Label for="webdav-username">{{ t("settings.syncUsername") }}</Label>
                      <Input id="webdav-username" v-model="webdavUsername" autocomplete="username" />
                    </div>
                    <div class="space-y-2">
                      <Label for="webdav-password">{{ t("settings.syncPassword") }}</Label>
                      <div class="relative">
                        <PasswordInput id="webdav-password" v-model="webdavPassword" :placeholder="webdavHasSavedPassword ? '••••••••' : t('settings.syncPasswordPlaceholder')" :disabled="webdavHasSavedPassword" :show-toggle="!webdavHasSavedPassword" autocomplete="current-password" />
                        <button
                          v-if="webdavHasSavedPassword"
                          type="button"
                          class="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
                          :title="t('settings.syncClearSavedPassword')"
                          @click="
                            webdavRememberPassword = false;
                            forgetWebdavSavedPassword(currentWebDavAccountConfig());
                            webdavHasSavedPassword = false;
                            webdavPassword = '';
                          "
                        >
                          <X class="size-3.5" />
                        </button>
                      </div>
                      <div class="flex items-center gap-2 text-xs text-muted-foreground">
                        <label class="flex items-center gap-2">
                          <input v-model="webdavRememberPassword" type="checkbox" class="h-4 w-4 shrink-0 accent-primary" />
                          <span>
                            {{ t("settings.syncRememberWebDavPassword") }}
                            <span v-if="webdavHasSavedPassword">{{ t("settings.syncSavedPassword") }}</span>
                          </span>
                        </label>
                        <HelpTooltip :label="t('settings.syncRememberWebDavPassword')">
                          {{ t("settings.syncRememberWebDavPasswordDescription") }}
                        </HelpTooltip>
                      </div>
                    </div>
                    <div class="space-y-2 md:col-span-2">
                      <Label for="webdav-remote-path">{{ t("settings.syncRemotePath") }}</Label>
                      <Input id="webdav-remote-path" v-model="webdavRemotePath" autocomplete="off" />
                      <p class="text-xs text-muted-foreground">{{ t("settings.syncRemotePathDescription") }}</p>
                    </div>
                    <div class="space-y-2 md:col-span-2 rounded-md border bg-muted/20 px-3 py-3">
                      <label class="flex items-center gap-2 text-xs">
                        <input v-model="webdavAutoUploadEnabled" type="checkbox" class="h-4 w-4 shrink-0 accent-primary" />
                        <span class="font-medium">{{ t("settings.syncAutoUpload") }}</span>
                      </label>
                      <div class="flex items-center gap-2">
                        <Label for="webdav-auto-upload-interval" class="text-xs text-muted-foreground">{{ t("settings.syncAutoUploadInterval") }}</Label>
                        <Input id="webdav-auto-upload-interval" v-model.number="webdavAutoUploadIntervalMinutes" type="number" min="1" max="1440" step="1" class="h-7 w-24 text-xs" :disabled="!webdavAutoUploadEnabled" />
                        <span class="text-xs text-muted-foreground">{{ t("settings.syncAutoUploadMinutes") }}</span>
                      </div>
                      <p class="text-xs text-muted-foreground">{{ t("settings.syncAutoUploadDescription") }}</p>
                    </div>
                  </div>

                  <div v-if="webdavMessage" class="text-xs" :class="webdavError ? 'text-destructive' : 'text-green-600 dark:text-green-400'">
                    {{ webdavMessage }}
                  </div>
                  <div class="flex flex-wrap justify-end gap-2">
                    <Button variant="outline" size="sm" :disabled="!webdavReady" @click="testWebDav">
                      <Loader2 v-if="webdavBusy === 'test'" class="mr-1 h-3 w-3 animate-spin" />
                      {{ t("settings.syncTest") }}
                    </Button>
                    <Button variant="outline" size="sm" :disabled="!webdavReady" @click="downloadWebDavSnapshot">
                      <Loader2 v-if="webdavBusy === 'download'" class="mr-1 h-3 w-3 animate-spin" />
                      <Download v-else class="mr-1 h-3 w-3" />
                      {{ t("settings.syncDownload") }}
                    </Button>
                    <Button size="sm" :disabled="!webdavReady" @click="uploadWebDavSnapshot">
                      <Loader2 v-if="webdavBusy === 'upload'" class="mr-1 h-3 w-3 animate-spin" />
                      <Upload v-else class="mr-1 h-3 w-3" />
                      {{ t("settings.syncUpload") }}
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="snippet" class="mt-5 space-y-5">
                  <div class="space-y-1">
                    <div class="flex items-center justify-between gap-3">
                      <div class="flex items-center gap-2 text-sm font-medium">
                        <Cloud class="h-4 w-4 text-muted-foreground" />
                        {{ t("settings.syncSnippetTitle") }}
                      </div>
                      <Button type="button" variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="openExternalUrl(`https://dbxio.com/${currentLocale() === 'zh-CN' ? 'cn' : 'en'}/docs/cloud-sync`)">
                        <ExternalLink class="mr-1 h-3 w-3" />
                        {{ t("settings.syncSnippetGuide") }}
                      </Button>
                    </div>
                    <p class="text-xs text-muted-foreground">{{ t("settings.syncSnippetDescription") }}</p>
                  </div>

                  <div class="grid gap-4 rounded-md border p-4 md:grid-cols-2">
                    <div class="space-y-2">
                      <Label>{{ t("settings.syncSnippetProvider") }}</Label>
                      <Select v-model="snippetProvider">
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="github">GitHub Gist</SelectItem>
                          <SelectItem value="gitee">Gitee 代码片段</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div class="space-y-2">
                      <Label for="snippet-sync-id">{{ t("settings.syncSnippetId") }}</Label>
                      <Input id="snippet-sync-id" v-model="snippetId" autocomplete="off" :placeholder="t('settings.syncSnippetIdPlaceholder')" />
                    </div>
                    <div class="space-y-2 md:col-span-2">
                      <Label for="snippet-sync-token">{{ t("settings.syncSnippetToken") }}</Label>
                      <div class="relative">
                        <PasswordInput id="snippet-sync-token" v-model="snippetToken" :placeholder="snippetHasSavedToken ? '••••••••' : ''" :disabled="snippetHasSavedToken" :show-toggle="!snippetHasSavedToken" autocomplete="off" />
                        <button
                          v-if="snippetHasSavedToken"
                          type="button"
                          class="absolute right-1 top-1/2 inline-flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                          :title="t('settings.syncClearSavedPassword')"
                          @click="
                            snippetRememberToken = false;
                            forgetSnippetSavedToken(currentSnippetAccountConfig());
                            snippetHasSavedToken = false;
                            snippetToken = '';
                          "
                        >
                          <X class="size-3.5" />
                        </button>
                      </div>
                      <label class="flex items-center gap-2 text-xs text-muted-foreground">
                        <input v-model="snippetRememberToken" type="checkbox" class="h-4 w-4 shrink-0 accent-primary" />
                        <span>{{ t("settings.syncSnippetRememberToken") }}</span>
                      </label>
                      <p class="text-xs text-muted-foreground">{{ t("settings.syncSnippetTokenDescription") }}</p>
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-3 md:col-span-2">
                      <div v-if="snippetMessage" class="min-w-0 flex-1 text-xs" :class="snippetError ? 'text-destructive' : 'text-green-600 dark:text-green-400'">
                        {{ snippetMessage }}
                      </div>
                      <div v-else class="flex-1" />
                      <div class="flex shrink-0 flex-wrap justify-end gap-2">
                        <Button variant="outline" size="sm" :disabled="!snippetReady" @click="testSnippetSync">
                          <Loader2 v-if="snippetBusy === 'test'" class="mr-1 h-3 w-3 animate-spin" />
                          {{ t("settings.syncTest") }}
                        </Button>
                        <Button variant="outline" size="sm" :disabled="!snippetReady || !snippetId.trim()" @click="downloadSnippetSnapshot">
                          <Loader2 v-if="snippetBusy === 'download'" class="mr-1 h-3 w-3 animate-spin" />
                          <Download v-else class="mr-1 h-3 w-3" />
                          {{ t("settings.syncDownload") }}
                        </Button>
                        <Button size="sm" :disabled="!snippetReady" @click="uploadSnippetSnapshot">
                          <Loader2 v-if="snippetBusy === 'upload'" class="mr-1 h-3 w-3 animate-spin" />
                          <Upload v-else class="mr-1 h-3 w-3" />
                          {{ t("settings.syncUpload") }}
                        </Button>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>

              <div class="mt-5 space-y-3 rounded-md border bg-muted/20 px-3 py-3">
                <div class="flex items-center justify-between gap-4">
                  <div class="space-y-1">
                    <Label for="sync-secrets">{{ t("settings.syncSecrets") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.syncSecretsSharedDescription") }}</p>
                  </div>
                  <Switch id="sync-secrets" v-model="webdavSyncSecrets" />
                </div>
                <div class="rounded-md border bg-background/60 px-3 py-2 text-xs text-muted-foreground">
                  {{ t("settings.syncSecretNotice") }}
                </div>
                <div v-if="webdavSyncSecrets" class="space-y-2">
                  <Label for="sync-secrets-passphrase">{{ t("settings.syncSecretsPassphrase") }}</Label>
                  <div class="flex items-center gap-2">
                    <PasswordInput id="sync-secrets-passphrase" v-model="webdavSecretsPassphrase" class="min-w-0 flex-1" :placeholder="webdavHasSavedSecretsPassphrase ? '••••••••' : ''" :show-toggle="!webdavHasSavedSecretsPassphrase || !!webdavSecretsPassphrase" autocomplete="new-password" />
                    <Button
                      v-if="webdavHasSavedSecretsPassphrase"
                      type="button"
                      variant="ghost"
                      size="icon"
                      class="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                      :title="t('settings.syncClearSavedPassword')"
                      :aria-label="t('settings.syncClearSavedPassword')"
                      @click="clearWebDavSyncSecretsPassphrase"
                    >
                      <X class="size-3.5" />
                    </Button>
                  </div>
                  <p class="text-xs text-muted-foreground">{{ t("settings.syncSecretsPassphraseDescription") }}</p>
                </div>
              </div>
            </section>

            <!-- AI Settings Tab -->
            <section v-else-if="activeSettingsTab === 'ai'" class="flex flex-col gap-5 py-2">
              <!-- Config List View -->
              <div v-if="aiConfigListMode === 'list'" class="space-y-4">
                <div class="flex items-center justify-between">
                  <h3 class="text-sm font-medium">{{ t("ai.configList") }}</h3>
                  <Button type="button" size="sm" @click="aiEnterEditMode()">
                    <Plus class="mr-1 h-3.5 w-3.5" />
                    {{ t("ai.addConfig") }}
                  </Button>
                </div>

                <div v-if="settingsStore.aiConfigs.length === 0" class="rounded-md border border-dashed p-6 text-center">
                  <p class="text-sm text-muted-foreground">{{ t("ai.noAiConfigs") }}</p>
                  <Button type="button" size="sm" class="mt-2" @click="aiEnterEditMode()">
                    <Plus class="mr-1 h-3.5 w-3.5" />
                    {{ t("ai.addConfig") }}
                  </Button>
                </div>

                <div v-else class="space-y-2">
                  <div v-for="config in displayedAiConfigs" :key="config.id" class="flex items-center justify-between rounded-md border p-3" :class="{ 'border-primary bg-primary/5': config.isDefault }">
                    <div class="flex items-center gap-3">
                      <AiProviderLogo :provider="config.provider" :label="config.provider" :icon-slug="AI_PROVIDER_PRESETS[config.provider].iconSlug" />
                      <div>
                        <div class="flex items-center gap-2">
                          <span class="text-sm font-medium">{{ config.name }}</span>
                          <Badge v-if="config.isDefault" variant="default" class="h-5 text-[10px]"> {{ t("ai.default") }} </Badge>
                        </div>
                        <div class="text-xs text-muted-foreground">{{ AI_PROVIDER_PRESETS[config.provider].label }} - {{ config.model }}</div>
                      </div>
                    </div>
                    <div class="flex items-center gap-1">
                      <Button v-if="!config.isDefault" type="button" size="sm" variant="ghost" @click="aiSetDefaultConfig(config.id)"> {{ t("ai.setDefault") }} </Button>
                      <Button type="button" size="sm" variant="ghost" @click="aiEnterEditMode(config.id)"> {{ t("common.edit") }} </Button>
                      <Button v-if="!config.isDefault" type="button" size="sm" variant="ghost" class="text-destructive" @click="aiDeleteConfig(config.id)"> {{ t("common.delete") }} </Button>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Global Custom Instructions (list mode) -->
              <div v-if="aiConfigListMode === 'list'" class="space-y-3">
                <Separator />
                <div>
                  <h3 class="text-sm font-medium">{{ t("ai.globalInstructions") }}</h3>
                  <p class="text-xs text-muted-foreground">{{ t("ai.globalInstructionsDescription") }}</p>
                </div>
                <textarea v-model="editGlobalInstructions" class="w-full rounded-md border bg-background px-3 py-2 text-xs font-mono resize-y min-h-[80px]" rows="4" :placeholder="t('ai.globalInstructionsDescription')"></textarea>
                <div class="flex items-center justify-between">
                  <span class="text-xs" :class="globalInstructionsTooLong() ? 'text-destructive' : 'text-muted-foreground'">
                    {{ t("ai.globalInstructionsCharCount", { count: promptTemplateCharacterCount(editGlobalInstructions), max: GLOBAL_INSTRUCTIONS_MAX }) }}
                  </span>
                  <Button type="button" size="sm" :disabled="!promptTemplateStore.isLoaded || globalInstructionsTooLong() || globalInstructionsSaving" @click="saveGlobalInstructions">
                    {{ globalInstructionsSaving ? t("common.processing") : t("ai.globalInstructionsSave") }}
                  </Button>
                </div>
              </div>

              <!-- Prompt Templates Management (list mode) -->
              <div v-if="aiConfigListMode === 'list'" class="space-y-3">
                <Separator />
                <div class="flex items-center justify-between">
                  <div>
                    <h3 class="text-sm font-medium">{{ t("ai.promptTemplates") }}</h3>
                    <p class="text-xs text-muted-foreground">{{ t("ai.promptTemplatesDescription") }}</p>
                  </div>
                  <Button v-if="!templateFormOpen" type="button" size="sm" @click="openNewTemplate">
                    <Plus class="mr-1 h-3.5 w-3.5" />
                    {{ t("ai.promptTemplateNew") }}
                  </Button>
                </div>

                <!-- Template list -->
                <div v-if="!templateFormOpen && promptTemplateStore.templates.length > 0" class="space-y-1.5">
                  <div v-for="tpl in promptTemplateStore.templates" :key="tpl.id" class="flex items-center justify-between rounded-md border p-3">
                    <div class="min-w-0 flex-1">
                      <div class="text-sm font-medium truncate">{{ tpl.name }}</div>
                      <div class="text-xs text-muted-foreground truncate">{{ tpl.content.slice(0, 100) }}{{ tpl.content.length > 100 ? "..." : "" }}</div>
                    </div>
                    <div class="flex items-center gap-1 shrink-0 ml-2">
                      <Button type="button" size="sm" variant="ghost" @click="openEditTemplate(tpl)">{{ t("common.edit") }}</Button>
                      <Button type="button" size="sm" variant="ghost" class="text-destructive" @click="templateDeleteConfirm = tpl">{{ t("common.delete") }}</Button>
                    </div>
                  </div>
                </div>

                <div v-if="!templateFormOpen && promptTemplateStore.templates.length === 0" class="rounded-md border border-dashed p-6 text-center">
                  <p class="text-sm text-muted-foreground">{{ t("ai.promptTemplateNoTemplates") }}</p>
                </div>

                <!-- Template Edit Form -->
                <div v-if="templateFormOpen" class="rounded-md border p-4 space-y-3">
                  <div class="flex items-center justify-between">
                    <h4 class="text-sm font-medium">{{ templateFormIsNew ? t("ai.promptTemplateNew") : t("ai.promptTemplateEdit") }}</h4>
                    <Button type="button" variant="ghost" size="sm" @click="closeTemplateForm">
                      <X class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div>
                    <Label class="text-xs">{{ t("ai.promptTemplateName") }}</Label>
                    <Input v-model="templateForm.name" class="mt-1 h-8 text-xs" :placeholder="t('ai.promptTemplateNamePlaceholder')" />
                    <div class="flex justify-between mt-0.5">
                      <p v-if="templateNameTooLong()" class="text-xs text-destructive">{{ t("ai.promptTemplateNameTooLong", { max: PROMPT_TEMPLATE_NAME_MAX }) }}</p>
                      <p v-else-if="localNameDuplicate()" class="text-xs text-destructive">{{ t("ai.promptTemplateNameExists", { name: templateForm.name.trim() }) }}</p>
                      <span v-else></span>
                      <span class="text-xs" :class="templateNameTooLong() ? 'text-destructive' : 'text-muted-foreground'">{{ promptTemplateCharacterCount(templateForm.name) }}/{{ PROMPT_TEMPLATE_NAME_MAX }}</span>
                    </div>
                  </div>
                  <div>
                    <Label class="text-xs">{{ t("ai.promptTemplateContent") }}</Label>
                    <textarea v-model="templateForm.content" class="mt-1 w-full rounded-md border bg-background px-3 py-2 text-xs font-mono resize-y min-h-[80px]" rows="4" :placeholder="t('ai.promptTemplateContentPlaceholder')"></textarea>
                    <div class="flex justify-between mt-0.5">
                      <p v-if="templateContentTooLong()" class="text-xs text-destructive">{{ t("ai.promptTemplateTooLong", { max: PROMPT_TEMPLATE_CONTENT_MAX }) }}</p>
                      <span v-else></span>
                      <span class="text-xs" :class="templateContentTooLong() ? 'text-destructive' : 'text-muted-foreground'">{{ promptTemplateCharacterCount(templateForm.content) }}/{{ PROMPT_TEMPLATE_CONTENT_MAX }}</span>
                    </div>
                  </div>
                  <div class="flex justify-end gap-2">
                    <Button type="button" variant="outline" size="sm" @click="closeTemplateForm">{{ t("common.cancel") }}</Button>
                    <Button type="button" size="sm" :disabled="templateSaveDisabled()" @click="saveTemplateForm">
                      {{ templateSaving ? t("common.processing") : t("common.save") }}
                    </Button>
                  </div>
                </div>
              </div>

              <!-- Config Edit View -->
              <div v-else class="space-y-4">
                <div class="flex items-center justify-between">
                  <Button type="button" variant="ghost" size="sm" @click="aiEnterListMode()">
                    <ArrowLeft class="mr-1 h-3.5 w-3.5" />
                    {{ t("common.back") }}
                  </Button>
                  <h3 class="text-sm font-medium">{{ aiEditConfigId ? t("ai.editConfig") : t("ai.addConfig") }}</h3>
                </div>

                <!-- Config Name Input -->
                <div class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ t("ai.configName") }}</Label>
                  <Input v-model="aiEditConfigName" class="col-span-2 h-8 text-xs" :placeholder="t('ai.configNamePlaceholder')" />
                </div>

                <!-- Provider Selection -->
                <div class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ t("ai.provider") }}</Label>
                  <Select :model-value="aiEditProvider" @update:model-value="(v: any) => aiSelectProvider(v)">
                    <SelectTrigger class="col-span-2" inputClass="h-8 text-xs">
                      <SelectValue>
                        <span class="flex items-center gap-2">
                          <AiProviderLogo :provider="selectedAiProviderPreset.provider" :label="selectedAiProviderPreset.label" :icon-slug="selectedAiProviderPreset.iconSlug" />
                          <span>{{ selectedAiProviderPreset.label }}</span>
                        </span>
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="provider in aiProviderOptions" :key="provider.provider" :value="provider.provider">
                        <span class="flex w-full items-center justify-between gap-4">
                          <span class="flex items-center gap-2">
                            <AiProviderLogo :provider="provider.provider" :label="provider.label" :icon-slug="provider.iconSlug" />
                            <span>{{ provider.label }}</span>
                          </span>
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <!-- CLI MCP Status -->
                <div v-if="aiIsCliProvider && !isWeb" class="rounded-md border px-3 py-2.5 text-xs" :class="aiCliMcpNeedsInstall ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'">
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div class="min-w-0 space-y-1">
                      <div class="flex min-w-0 items-center gap-2 font-medium">
                        <Loader2 v-if="mcpStatusLoading" class="h-3.5 w-3.5 shrink-0 animate-spin" />
                        <AlertTriangle v-else-if="aiCliMcpNeedsInstall || mcpStatus?.error || mcpStatusError" class="h-3.5 w-3.5 shrink-0" />
                        <CheckCircle2 v-else class="h-3.5 w-3.5 shrink-0" />
                        <span>{{ t("ai.cliMcpRequiredTitle") }}</span>
                        <Badge variant="outline" class="h-5 shrink-0 rounded-md border-current/30 px-1.5 text-[11px] font-normal">
                          {{ mcpStatusLabel }}
                        </Badge>
                      </div>
                      <p class="leading-relaxed">
                        {{ t("ai.cliMcpRequiredDescription", { provider: aiCliProviderLabel }) }}
                      </p>
                      <p v-if="mcpStatus?.error || mcpStatusError" class="select-text leading-relaxed">
                        {{ mcpStatusError || mcpStatus?.error }}
                      </p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <Button type="button" size="sm" variant="outline" class="h-7 bg-background/80 px-2 text-xs" :disabled="mcpStatusLoading" @click="refreshMcpStatus">
                        <Loader2 v-if="mcpStatusLoading" class="mr-1 h-3 w-3 animate-spin" />
                        <RefreshCw v-else class="mr-1 h-3 w-3" />
                        {{ t("settings.mcpRefresh") }}
                      </Button>
                      <Button v-if="aiCliMcpNeedsInstall || mcpStatus?.update_available" type="button" size="sm" class="h-7 px-2 text-xs" :disabled="!aiCliMcpCanInstall" @click="installMcp">
                        <Loader2 v-if="mcpInstalling" class="mr-1 h-3 w-3 animate-spin" />
                        {{ mcpInstalling ? t("settings.mcpInstalling") : aiCliMcpActionLabel }}
                      </Button>
                    </div>
                  </div>
                </div>

                <!-- Authentication -->
                <div v-if="!aiIsCliProvider && aiSupportsAuthMethod" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">Authentication</Label>
                  <Select v-model="aiEditAuthMethod">
                    <SelectTrigger class="col-span-2" inputClass="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="api-key">API Key</SelectItem>
                      <SelectItem value="bearer">Auth Token</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <!-- API Key -->
                <div v-if="!aiIsCliProvider" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ aiCredentialLabel }}</Label>
                  <PasswordInput v-model="aiEditApiKey" autocomplete="off" class="col-span-2" inputClass="h-8 text-xs" :placeholder="aiCredentialPlaceholder" />
                </div>

                <!-- Endpoint -->
                <div v-if="!aiIsCliProvider" class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">Endpoint</Label>
                  <div class="col-span-2 space-y-1.5">
                    <Input v-model="aiEditEndpoint" :placeholder="aiEndpointPlaceholder" autocomplete="off" class="h-8 text-xs" />
                    <p v-if="aiEndpointHint" class="text-[11px] text-muted-foreground">{{ aiEndpointHint }}</p>
                  </div>
                </div>

                <!-- CLI Path -->
                <div v-if="aiIsCliProvider" class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.cliPath", { provider: aiCliProviderLabel }) }}</Label>
                  <div class="col-span-2 space-y-1.5">
                    <Input v-model="aiEditCliPath" autocomplete="off" class="h-8 text-xs" :placeholder="aiCliCommandName" />
                    <p class="text-[11px] text-muted-foreground">{{ t("ai.cliPathHint", { command: aiCliCommandName, loginCommand: aiCliLoginCommand }) }}</p>
                    <p v-if="aiCliPathError" class="text-[11px] text-destructive">{{ aiCliPathError }}</p>
                  </div>
                </div>

                <!-- CLI Env -->
                <div v-if="aiIsCliProvider" class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.cliEnv") }}</Label>
                  <div class="col-span-2 space-y-2">
                    <div class="space-y-1.5">
                      <div v-for="row in aiEditCliEnvRows" :key="row.id" class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_2rem] gap-2">
                        <Input v-model="row.key" autocomplete="off" class="h-8 font-mono text-xs" :placeholder="t('ai.cliEnvKeyPlaceholder')" />
                        <Input v-model="row.value" autocomplete="off" class="h-8 font-mono text-xs" :placeholder="t('ai.cliEnvValuePlaceholder')" />
                        <Button type="button" variant="ghost" size="icon" class="h-8 w-8" :title="t('common.remove')" :aria-label="t('common.remove')" @click="removeCliEnvRow(row.id)">
                          <X class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <Button type="button" variant="outline" size="sm" class="h-7 px-2 text-xs" @click="addCliEnvRow">
                      <Plus class="mr-1 h-3.5 w-3.5" />
                      {{ t("ai.cliEnvAdd") }}
                    </Button>
                    <p v-if="aiCliEnvError" class="text-[11px] text-destructive">{{ aiCliEnvError }}</p>
                    <p v-else class="text-[11px] text-muted-foreground">{{ t("ai.cliEnvHint", { provider: aiCliProviderLabel }) }}</p>
                  </div>
                </div>

                <!-- Model -->
                <div class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.defaultModel") }}</Label>
                  <div class="col-span-2">
                    <Input v-model="aiEditModel" autocomplete="off" class="h-8 text-xs" />
                  </div>
                </div>

                <!-- Model List -->
                <div class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.modelList") }}</Label>
                  <div class="col-span-2 space-y-2">
                    <div v-for="(m, index) in aiEditModels" :key="index" class="flex items-center gap-2">
                      <Input v-model="m.name" :placeholder="t('ai.modelId')" class="h-8 flex-1 text-xs" />
                      <Input v-model="m.label" :placeholder="t('ai.modelDisplayName')" class="h-8 flex-1 text-xs" />
                      <Button type="button" variant="ghost" size="icon" class="h-8 w-8 shrink-0" @click="aiRemoveModel(index)">
                        <X class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <div class="flex gap-2">
                      <Button type="button" size="sm" variant="outline" class="h-7 px-2 text-xs" @click="aiAddModel">
                        <Plus class="mr-1 h-3 w-3" />
                        {{ t("ai.add") }}
                      </Button>
                      <Popover v-model:open="aiModelMultiSelectOpen" @update:open="aiOnModelPopoverOpen">
                        <PopoverTrigger as-child>
                          <Button type="button" size="sm" variant="outline" class="h-7 px-2 text-xs" :disabled="!aiCanListModels">
                            <Loader2 v-if="aiModelListLoading" class="mr-1 h-3 w-3 animate-spin" />
                            <Download v-else class="mr-1 h-3 w-3" />
                            {{ aiModelListLoading ? t("ai.fetching") : t("ai.fetchModelList") }}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent class="w-56 p-0" align="start">
                          <div class="flex flex-col">
                            <div class="border-b px-3 py-2">
                              <Input v-model="aiModelMultiSelectSearch" :placeholder="t('ai.searchModels')" class="h-8 text-xs" />
                            </div>
                            <div class="max-h-60 overflow-y-auto p-1">
                              <div v-if="aiFilteredFetchedModels.length === 0" class="px-3 py-4 text-center text-xs text-muted-foreground">
                                {{ aiModelListLoading ? t("ai.loadingModels") : aiModelError || t("ai.noModels") }}
                              </div>
                              <button v-for="model in aiFilteredFetchedModels" :key="model.id" type="button" class="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs hover:bg-muted" @click="aiToggleModel(model)">
                                <div class="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border" :class="aiIsModelSelected(model.id) ? 'border-primary bg-primary text-primary-foreground' : ''">
                                  <Check v-if="aiIsModelSelected(model.id)" class="h-3 w-3" />
                                </div>
                                <span class="flex-1 truncate text-left">{{ model.displayName || model.id }}</span>
                              </button>
                            </div>
                          </div>
                        </PopoverContent>
                      </Popover>
                    </div>
                    <p v-if="aiModelError" class="text-xs text-destructive">{{ aiModelError }}</p>
                  </div>
                </div>

                <!-- Reasoning Level -->
                <div v-if="aiIsCodexCli || aiIsClaudeCodeCli" class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.reasoningLevel") }}</Label>
                  <div class="col-span-2 space-y-1.5">
                    <Select v-model="aiEditReasoningLevel" :disabled="aiReasoningLevelDisabled">
                      <SelectTrigger inputClass="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="option in aiReasoningLevelOptions" :key="option.value" :value="option.value">
                          {{ t(option.labelKey) }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-[11px] text-muted-foreground">{{ aiReasoningLevelHint }}</p>
                  </div>
                </div>

                <!-- API Style -->
                <div v-if="aiSupportsApiStyle" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">API</Label>
                  <div class="col-span-2 flex gap-2">
                    <Button size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'border-blue-300 border-2 ring-2 ring-blue-300/50': aiEditApiStyle === 'completions' }" @click="aiSelectApiStyle('completions')">/chat/completions</Button>
                    <Button size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'border-blue-300 border-2 ring-2 ring-blue-300/50': aiEditApiStyle === 'responses' }" @click="aiSelectApiStyle('responses')">/responses</Button>
                    <Button v-if="aiSupportsAnthropicApiStyle" size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'border-blue-300 border-2 ring-2 ring-blue-300/50': aiEditApiStyle === 'anthropic-messages' }" @click="aiSelectApiStyle('anthropic-messages')">/messages</Button>
                  </div>
                </div>

                <!-- Enable Thinking -->
                <div v-if="!aiIsCliProvider" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ t("ai.enableThinking") }}</Label>
                  <div class="col-span-2 flex items-center gap-2">
                    <label class="flex items-center gap-2 text-xs text-muted-foreground">
                      <input v-model="aiEditEnableThinking" type="checkbox" class="h-4 w-4 shrink-0 accent-primary" :disabled="!aiCompletionsMode || aiEditProvider === 'gemini'" />
                      {{ aiEditEnableThinking ? t("ai.enableThinkingOn") : t("ai.enableThinkingOff") }}
                    </label>
                    <Popover>
                      <PopoverTrigger as-child>
                        <CircleHelp class="h-3.5 w-3.5 cursor-help text-muted-foreground hover:text-foreground" />
                      </PopoverTrigger>
                      <PopoverContent class="max-w-[320px] text-xs leading-relaxed" side="top" align="start">
                        {{ t("ai.enableThinkingHint") }}
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>

                <!-- Context Window -->
                <div v-if="!aiIsCliProvider" class="grid grid-cols-3 items-start gap-3">
                  <Label class="text-right text-xs">{{ t("ai.contextWindow") }}</Label>
                  <div class="col-span-2">
                    <Input v-model.number="aiEditContextWindow" type="number" min="1000" step="1000" class="h-8 text-xs" :placeholder="t('ai.contextWindowAuto')" />
                    <p class="mt-1 text-xs text-muted-foreground">{{ t("ai.contextWindowHint") }}</p>
                  </div>
                </div>

                <!-- Proxy -->
                <div v-if="!aiIsCliProvider" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ t("ai.proxy") }}</Label>
                  <label class="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <input v-model="aiEditProxyEnabled" type="checkbox" class="h-4 w-4 shrink-0 accent-primary" />
                    {{ t("ai.proxyEnable") }}
                  </label>
                </div>

                <!-- Proxy URL -->
                <div v-if="!aiIsCliProvider" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ t("ai.proxyUrl") }}</Label>
                  <Input v-model="aiEditProxyUrl" autocomplete="off" class="col-span-2" inputClass="h-8 text-xs" placeholder="socks5://127.0.0.1:7890" :disabled="!aiEditProxyEnabled" />
                </div>
              </div>
            </section>

            <section v-else-if="activeSettingsTab === 'mcp'" class="flex flex-col gap-5 py-2">
              <div class="rounded-md border bg-muted/20 p-4">
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0 space-y-2">
                    <div class="flex items-center gap-2">
                      <PackageSearch class="h-4 w-4 text-muted-foreground" />
                      <Label class="text-base">{{ t("settings.mcpTitle") }}</Label>
                      <HelpTooltip :label="t('settings.mcpTitle')">
                        {{ t("settings.mcpDescription") }}
                      </HelpTooltip>
                    </div>
                  </div>
                  <Badge v-if="!isWeb" variant="outline" class="shrink-0 rounded-md" :class="mcpStatusTone === 'ok' ? 'border-green-500/40 text-green-600 dark:text-green-400' : mcpStatusTone === 'warning' ? 'border-amber-500/40 text-amber-600 dark:text-amber-400' : 'text-muted-foreground'">
                    <Loader2 v-if="mcpStatusLoading" class="mr-1 h-3 w-3 animate-spin" />
                    <CheckCircle2 v-else-if="mcpStatusTone === 'ok'" class="mr-1 h-3 w-3" />
                    <AlertTriangle v-else-if="mcpStatusTone === 'warning'" class="mr-1 h-3 w-3" />
                    {{ mcpStatusLabel }}
                  </Badge>
                </div>
              </div>

              <div v-if="!isWeb" class="grid gap-3 sm:grid-cols-2">
                <div class="rounded-md border p-3">
                  <div class="text-xs font-medium uppercase text-muted-foreground">{{ t("settings.mcpCurrent") }}</div>
                  <div class="mt-2 font-mono text-sm">
                    {{ mcpStatus?.current_version ? `v${mcpStatus.current_version}` : t("settings.mcpVersionMissing") }}
                  </div>
                </div>
                <div class="rounded-md border p-3">
                  <div class="text-xs font-medium uppercase text-muted-foreground">{{ t("settings.mcpLatest") }}</div>
                  <div class="mt-2 font-mono text-sm">
                    {{ mcpStatus?.latest_version ? `v${mcpStatus.latest_version}` : t("settings.mcpVersionUnknown") }}
                  </div>
                </div>
                <div class="rounded-md border p-3">
                  <div class="text-xs font-medium uppercase text-muted-foreground">Node.js</div>
                  <div class="mt-2 font-mono text-sm">
                    {{ mcpStatus?.node_version || t("settings.mcpVersionUnknown") }}
                  </div>
                </div>
                <div class="rounded-md border p-3">
                  <div class="text-xs font-medium uppercase text-muted-foreground">npm</div>
                  <div class="mt-2 font-mono text-sm">
                    {{ mcpStatus?.npm_available ? t("settings.mcpAvailable") : t("settings.mcpUnavailable") }}
                  </div>
                </div>
              </div>

              <div v-if="mcpStatus?.bin_path" class="space-y-2">
                <Label>{{ t("settings.mcpBinPath") }}</Label>
                <div class="rounded-md border bg-muted/20 px-3 py-2 font-mono text-xs text-muted-foreground">
                  {{ mcpStatus.bin_path }}
                </div>
              </div>

              <div v-if="!isWeb" class="space-y-2">
                <Label>{{ mcpStatus?.installed ? t("settings.mcpUpdateCommand") : t("settings.mcpInstallCommand") }}</Label>
                <div class="flex min-w-0 items-center gap-2">
                  <div class="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-3 py-2 font-mono text-xs whitespace-nowrap">
                    {{ mcpCommand }}
                  </div>
                  <Button type="button" variant="outline" size="icon" :title="t('common.copy')" @click="copyMcpText('install', mcpCommand)">
                    <CheckCircle2 v-if="mcpCopied === 'install'" class="h-4 w-4 text-green-500" />
                    <Copy v-else class="h-4 w-4" />
                  </Button>
                  <Button type="button" variant="default" :disabled="mcpInstalling || !mcpStatus?.npm_available || (mcpStatus?.installed && !mcpStatus?.update_available)" @click="installMcp">
                    <Loader2 v-if="mcpInstalling" class="mr-2 h-4 w-4 animate-spin" />
                    <CheckCircle2 v-if="!mcpInstalling && mcpStatus?.installed && !mcpStatus?.update_available" class="mr-2 h-4 w-4" />
                    {{ mcpInstalling ? t("settings.mcpInstalling") : !mcpStatus?.installed ? t("settings.mcpInstallButton") : mcpStatus?.update_available ? t("settings.mcpUpdateButton") : t("settings.mcpUpToDate") }}
                  </Button>
                </div>
                <div
                  v-if="mcpInstallMessage"
                  :class="['text-xs px-3 py-2 rounded-md border', mcpInstallError ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-800' : 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/30 dark:text-green-300 dark:border-green-800']"
                >
                  {{ mcpInstallMessage }}
                </div>
              </div>

              <div class="space-y-2">
                <p class="text-xs text-muted-foreground">{{ t("settings.mcpConfigOptionsHint") }}</p>
                <p v-if="mcpPolicyLoadError" class="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{{ t("settings.mcpPolicyLoadFailed", { error: mcpPolicyLoadError }) }}</p>
                <McpConnectionScopePicker :connections="mcpSelectableConnections" :allowed-connection-ids="mcpAllowedConnectionIds" :disabled="mcpPolicyControlsDisabled" :busy="mcpPolicyLoading || mcpPolicySaving" @update:allowed-connection-ids="onMcpAllowedConnectionIdsChange" />
                <div class="space-y-3 rounded-md border bg-muted/20 p-3">
                  <div class="space-y-1">
                    <Label id="mcp-execution-mode-label">{{ t("settings.mcpExecutionMode") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.mcpExecutionModeDescription") }}</p>
                  </div>
                  <div class="grid grid-cols-1 p-1 sm:grid-cols-3 gap-2.5" role="radiogroup" aria-labelledby="mcp-execution-mode-label">
                    <Button
                      :disabled="mcpPolicyControlsDisabled"
                      type="button"
                      role="radio"
                      data-mcp-execution-mode="read_only"
                      :aria-checked="mcpExecutionMode === 'read_only'"
                      :tabindex="mcpExecutionMode === 'read_only' ? 0 : -1"
                      variant="outline"
                      class="settings-choice-card h-auto justify-center border p-3"
                      :class="mcpExecutionMode === 'read_only' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''"
                      @click="onMcpExecutionModeChange('read_only')"
                      @keydown="onMcpExecutionModeKeydown($event, 'read_only')"
                    >
                      <span>{{ t("settings.mcpExecutionModeReadOnly") }}</span>
                    </Button>
                    <Button
                      :disabled="mcpPolicyControlsDisabled"
                      type="button"
                      role="radio"
                      data-mcp-execution-mode="safe_write"
                      :aria-checked="mcpExecutionMode === 'safe_write'"
                      :tabindex="mcpExecutionMode === 'safe_write' ? 0 : -1"
                      variant="outline"
                      class="settings-choice-card h-auto justify-center border p-3"
                      :class="mcpExecutionMode === 'safe_write' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''"
                      @click="onMcpExecutionModeChange('safe_write')"
                      @keydown="onMcpExecutionModeKeydown($event, 'safe_write')"
                    >
                      <span>{{ t("settings.mcpExecutionModeSafeWrite") }}</span>
                      <span class="text-[10px] font-normal text-green-600 dark:text-green-400">{{ t("settings.mcpExecutionModeRecommended") }}</span>
                    </Button>
                    <Button
                      :disabled="mcpPolicyControlsDisabled"
                      type="button"
                      role="radio"
                      data-mcp-execution-mode="high_risk_write"
                      :aria-checked="mcpExecutionMode === 'high_risk_write'"
                      :tabindex="mcpExecutionMode === 'high_risk_write' ? 0 : -1"
                      variant="outline"
                      class="settings-choice-card h-auto justify-center border p-3"
                      :class="mcpExecutionMode === 'high_risk_write' ? 'settings-choice-card--selected border-blue-300 ring-2 ring-blue-300/50' : ''"
                      @click="onMcpExecutionModeChange('high_risk_write')"
                      @keydown="onMcpExecutionModeKeydown($event, 'high_risk_write')"
                    >
                      <span>{{ t("settings.mcpExecutionModeHighRiskWrite") }}</span>
                    </Button>
                  </div>
                  <!-- Keep every translation in one grid cell so mode changes cannot reflow the capability matrix. -->
                  <div data-mcp-execution-mode-description class="grid text-xs">
                    <p class="col-start-1 row-start-1 text-muted-foreground" :class="mcpExecutionMode === 'read_only' ? 'visible' : 'invisible'">
                      {{ t("settings.mcpExecutionModeReadOnlyDescription") }}
                    </p>
                    <p class="col-start-1 row-start-1 text-muted-foreground" :class="mcpExecutionMode === 'safe_write' ? 'visible' : 'invisible'">
                      {{ t("settings.mcpExecutionModeSafeWriteDescription") }}
                    </p>
                    <p class="col-start-1 row-start-1 flex items-start gap-1.5 text-amber-600 dark:text-amber-400" :class="mcpExecutionMode === 'high_risk_write' ? 'visible' : 'invisible'">
                      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>{{ t("settings.mcpExecutionModeHighRiskWriteDescription") }}</span>
                    </p>
                  </div>
                  <div class="space-y-1.5">
                    <div class="space-y-0.5">
                      <p class="text-xs font-medium">{{ t("settings.mcpCapabilityTitle") }}</p>
                      <p class="text-[11px] text-muted-foreground">{{ t("settings.mcpCapabilityDescription") }}</p>
                    </div>
                    <div class="overflow-x-auto rounded-md border bg-background">
                      <table class="w-full min-w-[36rem] table-fixed text-xs">
                        <thead class="bg-muted/50 text-muted-foreground">
                          <tr>
                            <th scope="col" class="w-[46%] px-3 py-2 text-left font-medium">{{ t("settings.mcpCapabilityOperation") }}</th>
                            <th v-for="column in MCP_EXECUTION_MODE_COLUMNS" :key="column.mode" scope="col" class="px-2 py-2 text-center font-medium">
                              {{ t(column.labelKey) }}
                            </th>
                          </tr>
                        </thead>
                        <tbody class="divide-y">
                          <tr v-for="row in MCP_CAPABILITY_ROWS" :key="row.labelKey">
                            <th scope="row" class="px-3 py-2 text-left font-normal leading-relaxed">{{ t(row.labelKey) }}</th>
                            <td v-for="column in MCP_EXECUTION_MODE_COLUMNS" :key="column.mode" class="px-2 py-2 text-center">
                              <span class="inline-flex items-center justify-center" :class="row[column.mode] ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground/60'">
                                <Check v-if="row[column.mode]" class="h-4 w-4" aria-hidden="true" />
                                <X v-else class="h-4 w-4" aria-hidden="true" />
                                <span class="sr-only">{{ t(row[column.mode] ? "settings.mcpCapabilityAllowed" : "settings.mcpCapabilityBlocked") }}</span>
                              </span>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <p class="text-[11px] leading-relaxed text-muted-foreground">{{ t("settings.mcpCapabilityAlwaysEnforced") }}</p>
                  </div>
                </div>
              </div>

              <div class="space-y-2">
                <Label>{{ t("settings.mcpConfig") }}</Label>
                <Tabs v-model="mcpConfigTab" class="space-y-3">
                  <TabsList class="grid h-auto w-full grid-cols-2 gap-1 overflow-visible group-data-horizontal/tabs:h-auto sm:grid-cols-4 xl:grid-cols-8">
                    <TabsTrigger value="claude" class="h-8 min-w-0 px-2">Claude Code</TabsTrigger>
                    <TabsTrigger value="cursor" class="h-8 min-w-0 px-2">Cursor</TabsTrigger>
                    <TabsTrigger value="trae" class="h-8 min-w-0 px-2">TRAE</TabsTrigger>
                    <TabsTrigger value="vscode" class="h-8 min-w-0 px-2">VS Code</TabsTrigger>
                    <TabsTrigger value="windsurf" class="h-8 min-w-0 px-2">Windsurf</TabsTrigger>
                    <TabsTrigger value="codex" class="h-8 min-w-0 px-2">Codex</TabsTrigger>
                    <TabsTrigger value="opencode" class="h-8 min-w-0 px-2">OpenCode</TabsTrigger>
                    <TabsTrigger value="cherry-studio" class="h-8 min-w-0 px-2">Cherry Studio</TabsTrigger>
                  </TabsList>

                  <TabsContent value="claude" class="m-0">
                    <div class="relative rounded-md border bg-background p-3">
                      <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpJsonRecommendedConfig }}</code></pre>
                      <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('claude-config', mcpJsonRecommendedConfig)">
                        <CheckCircle2 v-if="mcpCopied === 'claude-config'" class="h-3.5 w-3.5 text-green-500" />
                        <Copy v-else class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TabsContent>

                  <TabsContent value="cursor" class="m-0">
                    <div class="space-y-2">
                      <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {{ t("settings.mcpCursorConfigPath") }}
                      </div>
                      <div class="relative rounded-md border bg-background p-3">
                        <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpJsonRecommendedConfig }}</code></pre>
                        <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('cursor-config', mcpJsonRecommendedConfig)">
                          <CheckCircle2 v-if="mcpCopied === 'cursor-config'" class="h-3.5 w-3.5 text-green-500" />
                          <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="trae" class="m-0">
                    <div class="space-y-2">
                      <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {{ t("settings.mcpTraeConfigPath") }}
                      </div>
                      <div class="relative rounded-md border bg-background p-3">
                        <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpTraeRecommendedConfig }}</code></pre>
                        <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('trae-config', mcpTraeRecommendedConfig)">
                          <CheckCircle2 v-if="mcpCopied === 'trae-config'" class="h-3.5 w-3.5 text-green-500" />
                          <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="vscode" class="m-0">
                    <div class="space-y-2">
                      <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {{ t("settings.mcpVsCodeConfigPath") }}
                      </div>
                      <div class="relative rounded-md border bg-background p-3">
                        <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpVsCodeRecommendedConfig }}</code></pre>
                        <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('vscode-config', mcpVsCodeRecommendedConfig)">
                          <CheckCircle2 v-if="mcpCopied === 'vscode-config'" class="h-3.5 w-3.5 text-green-500" />
                          <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="windsurf" class="m-0">
                    <div class="space-y-2">
                      <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {{ t("settings.mcpWindsurfConfigPath") }}
                      </div>
                      <div class="relative rounded-md border bg-background p-3">
                        <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpJsonRecommendedConfig }}</code></pre>
                        <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('windsurf-config', mcpJsonRecommendedConfig)">
                          <CheckCircle2 v-if="mcpCopied === 'windsurf-config'" class="h-3.5 w-3.5 text-green-500" />
                          <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="codex" class="m-0">
                    <div class="space-y-2">
                      <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {{ t("settings.mcpCodexConfigPath") }}
                      </div>
                      <div class="relative rounded-md border bg-background p-3">
                        <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpCodexRecommendedConfig }}</code></pre>
                        <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('codex-config', mcpCodexRecommendedConfig)">
                          <CheckCircle2 v-if="mcpCopied === 'codex-config'" class="h-3.5 w-3.5 text-green-500" />
                          <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="opencode" class="m-0">
                    <div class="space-y-2">
                      <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {{ t("settings.mcpOpenCodeConfigPath") }}
                      </div>
                      <div class="relative rounded-md border bg-background p-3">
                        <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpOpenCodeRecommendedConfig }}</code></pre>
                        <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('opencode-config', mcpOpenCodeRecommendedConfig)">
                          <CheckCircle2 v-if="mcpCopied === 'opencode-config'" class="h-3.5 w-3.5 text-green-500" />
                          <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </TabsContent>

                  <TabsContent value="cherry-studio" class="m-0">
                    <div class="space-y-2">
                      <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                        {{ t("settings.mcpCherryStudioConfigPath") }}
                      </div>
                      <div class="relative rounded-md border bg-background p-3">
                        <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpCherryStudioRecommendedConfig }}</code></pre>
                        <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('cherry-studio-config', mcpCherryStudioRecommendedConfig)">
                          <CheckCircle2 v-if="mcpCopied === 'cherry-studio-config'" class="h-3.5 w-3.5 text-green-500" />
                          <Copy v-else class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </TabsContent>
                </Tabs>
              </div>

              <div v-if="mcpStatus?.error || mcpStatusError" class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {{ mcpStatusError || mcpStatus?.error }}
              </div>

              <div class="flex items-center gap-2 text-xs text-muted-foreground">
                <Terminal class="h-3.5 w-3.5" />
                <span>{{ t("settings.mcpDetectionTiming") }} {{ t("settings.mcpNpmBoundary") }}</span>
              </div>
            </section>

            <section v-else-if="activeSettingsTab === 'security' && isWeb" class="flex flex-col gap-5 py-2">
              <div class="space-y-3">
                <Label class="text-base">{{ t("auth.changePassword") }}</Label>
                <p class="text-sm text-muted-foreground">{{ t("auth.changePasswordDescription") }}</p>
                <PasswordInput v-model="oldPassword" :placeholder="t('auth.oldPassword')" inputClass="h-9" autocomplete="off" />
                <PasswordInput v-model="newPassword" :placeholder="t('auth.newPassword')" inputClass="h-9" autocomplete="off" />
                <PasswordInput v-model="confirmNewPassword" :placeholder="t('auth.confirmPassword')" inputClass="h-9" autocomplete="off" />
                <p v-if="passwordMessage" class="text-xs" :class="passwordError ? 'text-destructive' : 'text-green-500'">
                  {{ passwordMessage }}
                </p>
              </div>
            </section>

            <section v-else-if="activeSettingsTab === 'tunnels'" class="flex flex-col gap-5 py-2">
              <TunnelProfileManager />
            </section>

            <section v-else-if="activeSettingsTab === 'about'" class="flex flex-col gap-5 py-2">
              <div class="rounded-lg border p-4">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div class="min-w-0 space-y-1">
                    <Label>{{ t("settings.supportInfoTitle") }}</Label>
                    <p class="text-sm text-muted-foreground">{{ t("settings.supportInfoDescription") }}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" class="shrink-0" :disabled="appSupportInfoLoading && !appSupportInfo" @click="copyAppSupportInfo">
                    <Loader2 v-if="appSupportInfoLoading && !appSupportInfo" class="mr-1 h-3.5 w-3.5 animate-spin" />
                    <CheckCircle2 v-else-if="appSupportInfoCopied" class="mr-1 h-3.5 w-3.5" />
                    <Copy v-else class="mr-1 h-3.5 w-3.5" />
                    {{ appSupportInfoCopied ? t("settings.supportInfoCopied") : t("settings.supportInfoCopy") }}
                  </Button>
                </div>
                <div v-if="appSupportInfoRows.length" class="mt-4 grid gap-3 sm:grid-cols-2">
                  <div v-for="row in appSupportInfoRows" :key="row.key" class="min-w-0 rounded-md bg-muted/30 px-3 py-2">
                    <div class="text-xs font-medium text-muted-foreground">{{ row.label }}</div>
                    <div class="mt-1 min-w-0 select-text break-words font-mono text-xs text-foreground">{{ row.value }}</div>
                  </div>
                </div>
                <p v-else class="mt-4 text-sm text-muted-foreground">{{ t("settings.supportInfoLoading") }}</p>
                <p v-if="appSupportInfoError" class="mt-3 text-xs text-destructive">{{ t("settings.supportInfoLoadFailed", { message: appSupportInfoError }) }}</p>
              </div>

              <ChangelogPanel />

              <div class="rounded-lg border p-4">
                <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div class="min-w-0 space-y-1">
                    <Label>{{ t("settings.updateDownloadSource") }}</Label>
                    <p class="text-sm text-muted-foreground">{{ t("settings.updateDownloadSourceDescription") }}</p>
                  </div>
                  <Select :model-value="editUpdateDownloadSource" @update:model-value="onUpdateDownloadSourceChange">
                    <SelectTrigger class="h-9 w-full sm:w-[180px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="official">{{ t("settings.updateDownloadSourceOfficial") }}</SelectItem>
                      <SelectItem value="cnb">{{ t("settings.updateDownloadSourceCnb") }}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
                <button type="button" class="rounded-lg border p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="openExternalUrl('https://qm.qq.com/cgi-bin/qm/qr?k=&group_code=1087880322')">
                  <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {{ t("settings.community") }}
                  </div>
                  <div class="mt-3 flex items-center gap-2 text-sm font-medium">
                    <img
                      src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIGhlaWdodD0iODYiIHdpZHRoPSI4NiIgdmlld0JveD0iMCAwIDEyMCAxNDUiPjxwYXRoIGZpbGw9IiNmYWFiMDciIGQ9Ik02MC41MDMgMTQyLjIzN2MtMTIuNTMzIDAtMjQuMDM4LTQuMTk1LTMxLjQ0NS0xMC40Ni0zLjc2MiAxLjEyNC04LjU3NCAyLjkzMi0xMS42MSA1LjE3NS0yLjYgMS45MTgtMi4yNzUgMy44NzQtMS44MDcgNC42NjMgMi4wNTYgMy40NyAzNS4yNzMgMi4yMTYgNDQuODYyIDEuMTM2em0wIDBjMTIuNTM1IDAgMjQuMDM5LTQuMTk1IDMxLjQ0Ny0xMC40NiAzLjc2IDEuMTI0IDguNTczIDIuOTMyIDExLjYxIDUuMTc1IDIuNTk4IDEuOTE4IDIuMjc0IDMuODc0IDEuODA1IDQuNjYzLTIuMDU2IDMuNDctMzUuMjcyIDIuMjE2LTQ0Ljg2MiAxLjEzNnptMCAwIi8+PHBhdGggZD0iTTYwLjU3NiA2Ny4xMTljMjAuNjk4LS4xNCAzNy4yODYtNC4xNDcgNDIuOTA3LTUuNjgzIDEuMzQtLjM2NyAyLjA1Ni0xLjAyNCAyLjA1Ni0xLjAyNC4wMDUtLjE4OS4wODUtMy4zNy4wODUtNS4wMUMxMDUuNjI0IDI3Ljc2OCA5Mi41OC4wMDEgNjAuNSAwIDI4LjQyLjAwMSAxNS4zNzUgMjcuNzY5IDE1LjM3NSA1NS40MDFjMCAxLjY0Mi4wOCA0LjgyMi4wODYgNS4wMSAwIDAgLjU4My42MTUgMS42NS45MTMgNS4xOSAxLjQ0NCAyMi4wOSA1LjY1IDQzLjMxMiA1Ljc5NXptNTYuMjQ1IDIzLjAyYy0xLjI4My00LjEyOS0zLjAzNC04Ljk0NC00LjgwOC0xMy41NjggMCAwLTEuMDItLjEyNi0xLjUzNy4wMjMtMTUuOTEzIDQuNjIzLTM1LjIwMiA3LjU3LTQ5LjkgNy4zOTJoLS4xNTNjLTE0LjYxNi4xNzUtMzMuNzc0LTIuNzM3LTQ5LjYzNC03LjMxNS0uNjA2LS4xNzUtMS44MDItLjEtMS44MDItLjEtMS43NzQgNC42MjQtMy41MjUgOS40NC00LjgwOCAxMy41NjgtNi4xMTkgMTkuNjktNC4xMzYgMjcuODM4LTIuNjI3IDI4LjAyIDMuMjM5LjM5MiAxMi42MDYtMTQuODIxIDEyLjYwNi0xNC44MjEgMCAxNS40NTkgMTMuOTU3IDM5LjE5NSA0NS45MTggMzkuNDEzaC44NDhjMzEuOTYtLjIxOCA0NS45MTctMjMuOTU0IDQ1LjkxNy0zOS40MTMgMCAwIDkuMzY4IDE1LjIxMyAxMi42MDcgMTQuODIyIDEuNTA4LS4xODMgMy40OTEtOC4zMzItMi42MjctMjguMDIxIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTQ5LjA4NSA0MC44MjRjLTQuMzUyLjE5Ny04LjA3LTQuNzYtOC4zMDQtMTEuMDYzLS4yMzYtNi4zMDUgMy4wOTgtMTEuNTc2IDcuNDUtMTEuNzczIDQuMzQ3LS4xOTUgOC4wNjQgNC43NiA4LjMgMTEuMDY1LjIzOCA2LjMwNi0zLjA5NyAxMS41NzctNy40NDYgMTEuNzcxbTMxLjEzMy0xMS4wNjNjLS4yMzMgNi4zMDItMy45NTEgMTEuMjYtOC4zMDMgMTEuMDYzLTQuMzUtLjE5NS03LjY4NC01LjQ2NS03LjQ0Ni0xMS43Ny4yMzYtNi4zMDUgMy45NTItMTEuMjYgOC4zLTExLjA2NiA0LjM1Mi4xOTcgNy42ODYgNS40NjggNy40NDkgMTEuNzczIi8+PHBhdGggZmlsbD0iI2ZhYWIwNyIgZD0iTTg3Ljk1MiA0OS43MjVDODYuNzkgNDcuMTUgNzUuMDc3IDQ0LjI4IDYwLjU3OCA0NC4yOGgtLjE1NmMtMTQuNSAwLTI2LjIxMiAyLjg3LTI3LjM3NSA1LjQ0NmEuODYzLjg2MyAwIDAwLS4wODUuMzY3Ljg4Ljg4IDAgMDAuMTYuNDk2Yy45OCAxLjQyNyAxMy45ODUgOC40ODcgMjcuMyA4LjQ4N2guMTU2YzEzLjMxNCAwIDI2LjMxOS03LjA1OCAyNy4yOTktOC40ODdhLjg3My44NzMgMCAwMC4xNi0uNDk4Ljg1Ni44NTYgMCAwMC0uMDg1LS4zNjUiLz48cGF0aCBkPSJNNTQuNDM0IDI5Ljg1NGMuMTk5IDIuNDktMS4xNjcgNC43MDItMy4wNDYgNC45NDMtMS44ODMuMjQyLTMuNTY4LTEuNTgtMy43NjgtNC4wNy0uMTk3LTIuNDkyIDEuMTY3LTQuNzA0IDMuMDQzLTQuOTQ0IDEuODg2LS4yNDQgMy41NzQgMS41OCAzLjc3MSA0LjA3bTExLjk1Ni44MzNjLjM4NS0uNjg5IDMuMDA0LTQuMzEyIDguNDI3LTIuOTkzIDEuNDI1LjM0NyAyLjA4NC44NTcgMi4yMjMgMS4wNTcuMjA1LjI5Ni4yNjIuNzE4LjA1MyAxLjI4Ni0uNDEyIDEuMTI2LTEuMjYzIDEuMDk1LTEuNzM0Ljg3NS0uMzA1LS4xNDItNC4wODItMi42Ni03LjU2MiAxLjA5Ny0uMjQuMjU3LS42NjguMzQ2LTEuMDczLjA0LS40MDctLjMwOC0uNTc0LS45My0uMzM0LTEuMzYyIi8+PHBhdGggZmlsbD0iI2ZmZiIgZD0iTTYwLjU3NiA4My4wOGgtLjE1M2MtOS45OTYuMTItMjIuMTE2LTEuMjA0LTMzLjg1NC0zLjUxOC0xLjAwNCA1LjgxOC0xLjYxIDEzLjEzMi0xLjA5IDIxLjg1MyAxLjMxNiAyMi4wNDMgMTQuNDA3IDM1LjkgMzQuNjE0IDM2LjFoLjgyYzIwLjIwOC0uMiAzMy4yOTgtMTQuMDU3IDM0LjYxNi0zNi4xLjUyLTguNzIzLS4wODctMTYuMDM1LTEuMDkyLTIxLjg1NC0xMS43MzkgMi4zMTUtMjMuODYyIDMuNjQtMzMuODYgMy41MTgiLz48cGF0aCBmaWxsPSIjZWIxOTIzIiBkPSJNMzIuMTAyIDgxLjIzNXYyMS42OTNzOS45MzcgMi4wMDQgMTkuODkzLjYxNlY4My41MzVjLTYuMzA3LS4zNTctMTMuMTA5LTEuMTUyLTE5Ljg5My0yLjMiLz48cGF0aCBmaWxsPSIjZWIxOTIzIiBkPSJNMTA1LjUzOSA2MC40MTJzLTE5LjMzIDYuMTAyLTQ0Ljk2MyA2LjI3NWgtLjE1M2MtMjUuNTkxLS4xNzItNDQuODk2LTYuMjU1LTQ0Ljk2Mi02LjI3NUw4Ljk4NyA3Ni41N2MxNi4xOTMgNC44ODIgMzYuMjYxIDguMDI4IDUxLjQzNiA3Ljg0NWguMTUzYzE1LjE3NS4xODMgMzUuMjQyLTIuOTYzIDUxLjQzNy03Ljg0NXptMCAwIi8+PC9zdmc+"
                      alt="QQ"
                      class="h-7 w-7 rounded-md bg-white p-1"
                    />
                    {{ t("settings.qqGroup") }}
                    <ExternalLink class="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div class="mt-1 font-mono text-base">1087880322</div>
                </button>
                <button type="button" class="rounded-lg border p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="openExternalUrl('https://discord.gg/W7NyVDRt6a')">
                  <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {{ t("settings.community") }}
                  </div>
                  <div class="mt-3 flex items-center gap-2 text-sm font-medium">
                    <img src="https://cdn.simpleicons.org/discord/5865F2" alt="Discord" class="h-7 w-7 rounded-md bg-white p-1" />
                    Discord
                    <ExternalLink class="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div class="mt-1 text-sm text-primary">discord.gg/W7NyVDRt6a</div>
                </button>
                <button type="button" class="rounded-lg border p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="openExternalUrl('https://docs.qq.com/doc/DVVhMY0h1ekJqc0tz')">
                  <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {{ t("settings.community") }}
                  </div>
                  <div class="mt-3 flex items-center gap-2 text-sm font-medium">
                    <span class="flex h-7 w-7 items-center justify-center rounded-md bg-[#07C160] text-white">
                      <svg class="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <path
                          d="M9.5 4C5.36 4 2 6.69 2 10c0 1.89 1.08 3.56 2.78 4.66l-.7 2.1 2.46-1.23c.87.27 1.8.42 2.78.42.24 0 .48-.01.71-.03A5.93 5.93 0 0 1 10 14c0-3.31 3.13-6 7-6 .34 0 .67.03 1 .07C17.27 5.56 13.72 4 9.5 4Zm-3 4.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2Zm5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2ZM22 14c0-2.76-2.69-5-6-5s-6 2.24-6 5 2.69 5 6 5c.73 0 1.43-.11 2.09-.3l1.72.86-.49-1.46C20.94 17.07 22 15.64 22 14Zm-7.5-.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Zm4 0a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5Z"
                        />
                      </svg>
                    </span>
                    {{ t("settings.wechatGroup") }}
                    <ExternalLink class="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div class="mt-1 text-sm text-primary">{{ t("settings.wechatGroupInvite") }}</div>
                </button>
                <button type="button" class="rounded-lg border p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="openExternalUrl('https://github.com/t8y2/dbx')">
                  <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {{ t("settings.project") }}
                  </div>
                  <div class="mt-3 flex items-center gap-2 text-sm font-medium">
                    <img src="https://cdn.simpleicons.org/github/181717" alt="GitHub" class="h-7 w-7 rounded-md bg-white p-1" />
                    {{ t("settings.openSource") }}
                    <ExternalLink class="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div class="mt-1 text-sm text-primary">github.com/t8y2/dbx</div>
                </button>
                <button type="button" class="rounded-lg border p-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" @click="openExternalUrl('https://dbxio.com')">
                  <div class="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    {{ t("settings.project") }}
                  </div>
                  <div class="mt-3 flex items-center gap-2 text-sm font-medium">
                    <AppLogo class="h-7 w-7" />
                    {{ t("settings.officialDocs") }}
                    <ExternalLink class="ml-auto h-3.5 w-3.5 text-muted-foreground" />
                  </div>
                  <div class="mt-1 text-sm text-primary">dbxio.com</div>
                </button>
              </div>
            </section>
          </div>

          <DialogFooter v-if="hasSettingsApplyFooter(activeSettingsTab as SettingsCategory)" class="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-2 rounded-none border-t border-border/60 bg-transparent px-0 pb-0 pt-3 sm:flex-row sm:gap-2 [&>button]:w-auto [&>button]:shrink-0">
            <Button variant="outline" @click="resetDefaultsForTab(activeSettingsTab as SettingsCategory)">
              {{ t("settings.resetDefaults") }}
            </Button>
            <div class="flex-1" />
            <Button variant="outline" @click="closeSettings">
              {{ t("common.close") }}
            </Button>
            <Button :disabled="!hasChanges() || hasApplyBlocker" @click="applySettings">
              {{ t("settings.apply") }}
            </Button>
            <Button :disabled="!hasChanges() || hasApplyBlocker" @click="applySettingsAndClose">
              {{ t("settings.applyAndClose") }}
            </Button>
          </DialogFooter>

          <DialogFooter v-else-if="activeSettingsTab === 'ai'" class="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-2 rounded-none border-t border-border/60 bg-transparent px-0 pb-0 pt-3 sm:flex-row sm:gap-2 [&>button]:w-auto [&>button]:shrink-0">
            <template v-if="aiConfigListMode === 'list'">
              <div class="flex-1" />
              <Button variant="outline" @click="closeSettings">{{ t("common.close") }}</Button>
            </template>
            <template v-else>
              <div class="flex flex-1 items-center gap-2">
                <Button size="sm" variant="outline" :disabled="aiTesting || !!aiCliValidationError || (aiRequiresApiKey && !aiEditApiKey?.trim()) || (!aiIsCliProvider && !aiEditEndpoint?.trim()) || (!aiIsCliProvider && !aiEditModel?.trim())" @click="aiTestConn">
                  <Loader2 v-if="aiTesting" class="h-3 w-3 animate-spin mr-1" />
                  {{ t("connection.test") }}
                </Button>
                <span v-if="aiTestResult === 'success'" class="text-xs text-green-500 flex items-center gap-1.5">
                  <span>{{ t("connection.testSuccess") }}</span>
                  <span v-if="aiTestLatency != null" class="text-green-500/70">{{ aiTestLatency }}ms</span>
                </span>
                <span v-else-if="aiTestResult === 'error'" class="min-w-0 max-w-[360px] flex items-center gap-1.5 text-xs text-destructive">
                  <span class="select-text truncate" :title="aiTestError">{{ aiTestError }}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    class="h-6 w-6 shrink-0 text-destructive/80 hover:text-destructive"
                    :title="aiTestErrorCopied ? t('ai.copied') : t('ai.copyTestResult')"
                    :aria-label="aiTestErrorCopied ? t('ai.copied') : t('ai.copyTestResult')"
                    @click="copyAiTestError"
                  >
                    <CheckCircle2 v-if="aiTestErrorCopied" class="h-3.5 w-3.5" />
                    <Copy v-else class="h-3.5 w-3.5" />
                  </Button>
                </span>
              </div>
              <Button variant="outline" @click="aiEnterListMode()">{{ t("common.cancel") }}</Button>
              <Button :disabled="!aiEditConfigName.trim() || !!aiCliValidationError" @click="aiSaveConfig">{{ t("settings.apply") }}</Button>
            </template>
          </DialogFooter>

          <DialogFooter v-else-if="activeSettingsTab === 'sync' || activeSettingsTab === 'backups'" class="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-2 rounded-none border-t border-border/60 bg-transparent px-0 pb-0 pt-3 sm:flex-row sm:gap-2 [&>button]:w-auto [&>button]:shrink-0">
            <Button variant="outline" @click="closeSettings">
              {{ t("common.close") }}
            </Button>
          </DialogFooter>

          <DialogFooter v-else-if="activeSettingsTab === 'mcp'" class="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-2 rounded-none border-t border-border/60 bg-transparent px-0 pb-0 pt-3 sm:flex-row sm:gap-2 [&>button]:w-auto [&>button]:shrink-0">
            <Button variant="outline" @click="closeSettings">
              {{ t("common.close") }}
            </Button>
            <div class="flex-1" />
            <Button v-if="!isWeb" variant="outline" :disabled="mcpStatusLoading" @click="refreshMcpStatus">
              <Loader2 v-if="mcpStatusLoading" class="mr-1 h-3 w-3 animate-spin" />
              <RefreshCw v-else class="mr-1 h-3 w-3" />
              {{ t("settings.mcpRefresh") }}
            </Button>
            <Button variant="outline" @click="openExternalUrl('https://dbxio.com/cn/docs/mcp')">
              <ExternalLink class="mr-1 h-3 w-3" />
              {{ t("settings.mcpGuide") }}
            </Button>
          </DialogFooter>

          <DialogFooter v-else-if="activeSettingsTab === 'security' && isWeb" class="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-2 rounded-none border-t border-border/60 bg-transparent px-0 pb-0 pt-3 sm:flex-row sm:gap-2 [&>button]:w-auto [&>button]:shrink-0">
            <Button variant="outline" @click="closeSettings">
              {{ t("common.close") }}
            </Button>
            <Button :disabled="changingPassword || !oldPassword || !newPassword || !confirmNewPassword" @click="changePassword">
              {{ t("auth.changePassword") }}
            </Button>
          </DialogFooter>

          <DialogFooter v-else-if="activeSettingsTab === 'about'" class="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-2 rounded-none border-t border-border/60 bg-transparent px-0 pb-0 pt-3 sm:flex-row sm:gap-2 [&>button]:w-auto [&>button]:shrink-0">
            <Button variant="outline" @click="resetAllDefaults">
              {{ t("settings.resetAllDefaults") }}
            </Button>
            <div class="flex-1" />
            <Button variant="outline" @click="closeSettings">
              {{ t("common.close") }}
            </Button>
            <Button :disabled="!hasChanges() || hasApplyBlocker" @click="applySettings">
              {{ t("settings.apply") }}
            </Button>
            <Button :disabled="!hasChanges() || hasApplyBlocker" @click="applySettingsAndClose">
              {{ t("settings.applyAndClose") }}
            </Button>
          </DialogFooter>
        </div>
      </div>
    </component>

    <!-- Theme Customizer Dialog -->
    <ThemeCustomizerDialog v-model:open="showThemeCustomizer" :themes="editCustomThemes" :active-theme-id="editActiveCustomThemeId" @save="handleThemeSave" />

    <!-- Snippet Add/Edit Dialog -->
    <Dialog :open="snippetDialogOpen" @update:open="snippetDialogOpen = $event">
      <DialogContent class="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>
            {{ snippetEditingId ? t("settings.snippetsEditTitle") : t("settings.snippetsAddTitle") }}
          </DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-4 py-2">
          <div class="flex flex-col gap-1.5">
            <Label for="snippet-label">{{ t("settings.snippetsLabel") }}</Label>
            <Input id="snippet-label" v-model="snippetForm.label" :placeholder="t('settings.snippetsLabelPlaceholder')" />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="snippet-prefix">{{ t("settings.snippetsPrefix") }}</Label>
            <Input id="snippet-prefix" v-model="snippetForm.prefix" :placeholder="t('settings.snippetsPrefixPlaceholder')" />
            <p v-if="snippetFormPrefixError" class="text-xs text-destructive">{{ snippetFormPrefixError }}</p>
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="snippet-body">{{ t("settings.snippetsBody") }}</Label>
            <textarea
              id="snippet-body"
              v-model="snippetForm.body"
              :placeholder="t('settings.snippetsBodyPlaceholder')"
              rows="6"
              class="flex min-h-[120px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm font-mono shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="snippetDialogOpen = false">{{ t("settings.cancel") }}</Button>
          <Button @click="saveSnippet">{{ t("settings.save") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- AI Config Delete Confirmation -->
    <DangerConfirmDialog v-model:open="aiDeleteConfirmOpen" :title="t('ai.deleteConfigTitle')" :message="t('ai.deleteConfigConfirm')" :confirm-label="t('common.delete')" @confirm="aiConfirmDeleteConfig" />
    <DangerConfirmDialog
      v-model:open="templateDeleteConfirmOpen"
      :title="t('ai.promptTemplateDeleteTitle')"
      :message="t('ai.promptTemplateDeleteConfirm', { name: templateDeleteConfirm?.name ?? '' })"
      :confirm-label="t('common.delete')"
      @confirm="templateDeleteConfirm && confirmDeleteTemplate(templateDeleteConfirm)"
    />
  </component>
</template>

<style>
@media (min-width: 1024px) {
  .settings-layout {
    flex-direction: row !important;
  }

  .settings-category-nav {
    width: 10rem !important;
    flex-direction: column !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    border-bottom-width: 0 !important;
    border-right: 1px solid var(--border) !important;
    padding-bottom: 0 !important;
    padding-right: 0.75rem !important;
  }

  .settings-category-button {
    width: 100% !important;
    text-align: left !important;
  }
}

.settings-category-button--active {
  background-color: rgb(23, 23, 23) !important;
  color: rgb(255, 255, 255) !important;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
}

.settings-choice-button {
  color: rgb(23, 23, 23);
}

.settings-choice-button--selected {
  border-color: rgb(96, 165, 250) !important;
  background-color: rgba(59, 130, 246, 0.1) !important;
  color: rgb(29, 78, 216) !important;
  box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.45) !important;
}

.settings-choice-button--selected svg {
  color: currentColor !important;
}

.settings-choice-card--selected {
  border-color: rgb(96, 165, 250) !important;
  background-color: rgba(59, 130, 246, 0.04) !important;
  color: rgb(23, 23, 23) !important;
  box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.45) !important;
}

.settings-appearance-top-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  column-gap: 0.75rem;
  row-gap: 1rem;
}

.settings-appearance-field > * + * {
  margin-top: 0.5rem;
}

.settings-appearance-group > * + * {
  margin-top: 0.625rem;
}

.settings-appearance-button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.settings-appearance-choice-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.625rem;
}

.settings-option-stack > * + * {
  margin-top: 0.625rem;
}

@media (max-width: 760px) {
  .settings-appearance-top-grid,
  .settings-appearance-choice-grid {
    grid-template-columns: 1fr;
  }
}

.dark .settings-category-button--active {
  background-color: rgb(245, 245, 245) !important;
  color: rgb(23, 23, 23) !important;
}

.dark .settings-choice-button {
  color: rgb(245, 245, 245);
}

.dark .settings-choice-button--selected {
  border-color: rgb(147, 197, 253) !important;
  background-color: rgba(96, 165, 250, 0.18) !important;
  color: rgb(191, 219, 254) !important;
  box-shadow: 0 0 0 1px rgba(147, 197, 253, 0.5) !important;
}

.dark .settings-choice-card--selected {
  border-color: rgb(147, 197, 253) !important;
  background-color: rgba(96, 165, 250, 0.12) !important;
  color: rgb(245, 245, 245) !important;
  box-shadow: 0 0 0 2px rgba(147, 197, 253, 0.45) !important;
}
</style>

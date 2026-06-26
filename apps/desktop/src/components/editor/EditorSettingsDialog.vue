<script setup lang="ts">
import { ref, watch, shallowRef, computed, onMounted, onUnmounted, nextTick } from "vue";
import type { Ref } from "vue";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { useI18n } from "vue-i18n";
import { AlertTriangle, CheckCircle2, CircleHelp, Cloud, Copy, Download, ExternalLink, GripVertical, Loader2, Moon, PackageSearch, Pencil, Plus, RefreshCw, RotateCcw, Settings, Sun, SunMoon, Terminal, Trash2, Upload, X } from "@lucide/vue";
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
  FONT_FAMILIES,
  DEFAULT_EDITOR_SETTINGS,
  DEFAULT_DESKTOP_SETTINGS,
  DEFAULT_SIDEBAR_TABLE_PAGE_SIZE,
  normalizeAiEnv,
  type AiProvider,
  type AiApiStyle,
  type AiAuthMethod,
  type AiReasoningLevel,
  type EditorTheme,
  type DesktopIconTheme,
  type InterfaceLayout,
  type DisconnectTabHandlingMode,
  type CustomThemeColors,
  type CustomTheme,
} from "@/stores/settingsStore";
import { loadEditorTheme, editorFontTheme } from "@/lib/editorThemes";
import { formatAiModelOption } from "@/lib/aiModelPresentation";
import ThemeCustomizerDialog from "./ThemeCustomizerDialog.vue";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { useTheme } from "@/composables/useTheme";
import { copyToClipboard } from "@/lib/clipboard";
import { clearDebugLogs as clearStoredDebugLogs, downloadDebugLogs, getDebugLogBundleText } from "@/lib/debugLog";
import {
  aiListModels,
  aiTestConnection,
  checkMcpServerStatus,
  installMcpServer,
  forgetWebdavSavedPassword,
  listSystemFonts,
  saveWebdavSavedPassword,
  webdavPasswordStatus,
  webdavSyncDownload,
  webdavSyncTest,
  webdavSyncUpload,
  type AiModelInfo,
  type McpServerStatus,
  type WebDavConfig,
} from "@/lib/api";
import { eventToShortcut } from "@/lib/keyboardShortcuts";
import { SHORTCUT_DEFINITIONS, findShortcutConflict, normalizeShortcutSettings, type ShortcutActionId } from "@/lib/shortcutRegistry";
import { normalizeSidebarHiddenTablePrefixes } from "@/lib/sidebarTableNameDisplay";
import { normalizeSqlFormatterSettings, type SqlFormatterSettings } from "@/lib/sqlFormatterConfig";
import { EMPTY_TABLE_COLUMN_TEMPLATE_DATA_TYPE, parseTableColumnTemplateFields, TABLE_COLUMN_TEMPLATE_DATABASE_TYPES } from "@/lib/tableColumnTemplates";
import { combineDataTypeForDatabase, getDataTypeOptions, getDefaultLengthForType, isDataTypeLengthDisabled, splitDataType } from "@/lib/tableStructureEditorState";
import type { DatabaseType, SqlSnippet } from "@/types/database";
import { uuid } from "@/lib/utils";
import { DEFAULT_SQL_SNIPPETS } from "@/lib/sqlCompletion";
import AiProviderLogo from "@/components/icons/AiProviderLogo.vue";
import AppLogo from "@/components/icons/AppLogo.vue";
import SqlFormatterSettingsPanel from "./SqlFormatterSettingsPanel.vue";
import type { AppThemeAppearance } from "@/lib/appTheme";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSavedSqlStore } from "@/stores/savedSqlStore";
import { currentLocale, setLocale, type Locale } from "@/i18n";
import { LOCALE_OPTIONS } from "@/lib/localeOptions";

const { t } = useI18n();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();
const savedSqlStore = useSavedSqlStore();
const { isDark, themeMode, setThemeMode } = useTheme();

let cachedSystemFonts: string[] | null = null;
let pendingSystemFonts: Promise<string[]> | null = null;

const props = defineProps<{
  open: boolean;
  initialTab?: string;
  initialSection?: string;
  appVersion?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

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
const editUiScale = ref(settingsStore.editorSettings.uiScale);
const editTheme = ref(settingsStore.editorSettings.theme);
const editCustomThemes = ref<CustomTheme[]>([...settingsStore.editorSettings.customThemes]);
const editActiveCustomThemeId = ref(settingsStore.editorSettings.activeCustomThemeId);
const showThemeCustomizer = ref(false);
const editExecuteMode = ref(settingsStore.editorSettings.executeMode);
const editShowExecutionTargetPicker = ref(settingsStore.editorSettings.showExecutionTargetPicker);
const editAutoAliasTables = ref(settingsStore.editorSettings.autoAliasTables);
const editWordWrap = ref(settingsStore.editorSettings.wordWrap);
const editConfirmDangerousSqlExecution = ref(settingsStore.editorSettings.confirmDangerousSqlExecution);
const editAppLayout = ref(settingsStore.editorSettings.appLayout);
const editShowTrayIcon = ref(settingsStore.desktopSettings.show_tray_icon);
const editQuitOnClose = ref(settingsStore.desktopSettings.quit_on_close);
const desktopCloseBehaviorResetPending = ref(false);
const editIconTheme = ref<DesktopIconTheme>(settingsStore.desktopSettings.icon_theme);
const editDebugLoggingEnabled = ref(settingsStore.desktopSettings.debug_logging_enabled);
const editSidebarTablePageSize = ref(settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE);
const debugLogCopied = ref(false);
const debugLogDownloaded = ref(false);
const editShowColumnCommentsInHeader = ref(settingsStore.editorSettings.showColumnCommentsInHeader);
const editShowColumnTypesInHeader = ref(settingsStore.editorSettings.showColumnTypesInHeader);
const editCompactColumnHeaderActions = ref(settingsStore.editorSettings.compactColumnHeaderActions);
const editInfiniteScroll = ref(settingsStore.editorSettings.infiniteScroll);
const editInfiniteScrollMaxRows = ref(settingsStore.editorSettings.infiniteScrollMaxRows);
const editTableColumnTemplateRows = ref<TableColumnTemplateGridRow[]>(tableColumnTemplateRowsFromSettings(settingsStore.editorSettings.tableColumnTemplateFields));
const editTableColumnTemplateDatabaseType = ref<DatabaseType>(TABLE_COLUMN_TEMPLATE_DATABASE_TYPES[0] ?? "mysql");
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
const editAutoSelectActiveSidebarNode = ref(settingsStore.editorSettings.autoSelectActiveSidebarNode);
const editDisconnectTabHandlingMode = ref<DisconnectTabHandlingMode>(settingsStore.editorSettings.disconnectTabHandlingMode);
const editReuseDataTab = ref(settingsStore.editorSettings.reuseDataTab);
const editUpdateNotificationsEnabled = ref(settingsStore.editorSettings.updateNotificationsEnabled);
const editSidebarHiddenTablePrefixes = ref(settingsStore.editorSettings.sidebarHiddenTablePrefixes.join("\n"));
const editSidebarHideTableComments = ref(settingsStore.editorSettings.sidebarHideTableComments);
const editSidebarAllowHorizontalScroll = ref(settingsStore.editorSettings.sidebarAllowHorizontalScroll);
const editExportBatchSize = ref(settingsStore.editorSettings.exportBatchSize);
const editExportRowLimitEnabled = ref(settingsStore.editorSettings.exportRowLimitEnabled);
const editExportRowLimit = ref(settingsStore.editorSettings.exportRowLimit);
const editQueryExportKeysetOptimizationEnabled = ref(settingsStore.editorSettings.queryExportKeysetOptimizationEnabled);
const editToolbarItems = ref({ ...settingsStore.editorSettings.toolbarItems });
const systemFonts = ref<string[]>([]);
const systemFontsLoading = ref(false);
const systemFontsLoaded = ref(false);
const uiScaleOptions = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
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
const editSnippets = ref<SqlSnippet[]>(settingsStore.editorSettings.snippets.map((s) => ({ ...s })));

const snippetDialogOpen = ref(false);
const snippetEditingId = ref<string | null>(null);
const snippetForm = ref({ label: "", prefix: "", body: "" });
const snippetFormPrefixError = ref("");
const iconThemeDescTruncated = { default: ref<boolean>(false), black: ref<boolean>(false) };
const iconThemeDescRef = {
  default: ref<HTMLElement | null>(null),
  black: ref<HTMLElement | null>(null),
};
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
    truncated.value = el.value!.scrollWidth > el.value!.clientWidth;
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
      };
    }
  } else {
    editSnippets.value.push({
      id: uuid(),
      label: snippetForm.value.label.trim() || prefix,
      prefix,
      body: snippetForm.value.body,
    });
  }
  snippetDialogOpen.value = false;
}

function deleteSnippet(id: string) {
  editSnippets.value = editSnippets.value.filter((s) => s.id !== id);
}

function confirmDeleteSnippet(snippet: SqlSnippet) {
  if (window.confirm(`Delete snippet "${snippet.label}"?`)) {
    deleteSnippet(snippet.id);
  }
}

const presetFontLabels = new Map(FONT_FAMILIES.map((font) => [font.value, font.label]));
const presetFontValues = new Set(FONT_FAMILIES.map((font) => font.value));

function cssFontFamilyForName(name: string): string {
  return `'${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}', monospace`;
}

function readableFontFamily(value: string): string {
  const first = value.split(",")[0]?.trim() ?? value;
  return first.replace(/^['"]|['"]$/g, "").replace(/\\'/g, "'");
}

function normalizeCustomFontFamilyInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.includes(",") || trimmed.includes("'") || trimmed.includes('"')) return trimmed;
  return cssFontFamilyForName(trimmed);
}

const systemFontOptions = computed(() => {
  const options = new Set(FONT_FAMILIES.map((font) => font.value));
  for (const font of systemFonts.value) options.add(cssFontFamilyForName(font));
  if (editFontFamily.value) options.add(editFontFamily.value);
  return [...options];
});

function displayFontFamily(value: string): string {
  return presetFontLabels.get(value) ?? readableFontFamily(value);
}

function fontOptionStyle(value: string) {
  return presetFontValues.has(value) || value === editFontFamily.value ? { fontFamily: value } : undefined;
}

async function loadSystemFontOptions() {
  if (systemFontsLoaded.value || systemFontsLoading.value) return;
  systemFontsLoading.value = true;
  try {
    if (cachedSystemFonts) {
      systemFonts.value = cachedSystemFonts;
    } else {
      pendingSystemFonts ??= listSystemFonts().finally(() => {
        pendingSystemFonts = null;
      });
      cachedSystemFonts = await pendingSystemFonts;
      systemFonts.value = cachedSystemFonts;
    }
    systemFontsLoaded.value = true;
  } catch {
    systemFonts.value = [];
  } finally {
    systemFontsLoading.value = false;
  }
}

// Sync from store when dialog opens
watch(
  () => props.open,
  (open) => {
    if (open) {
      editFontFamily.value = settingsStore.editorSettings.fontFamily;
      editFontSize.value = settingsStore.editorSettings.fontSize;
      editUiScale.value = settingsStore.editorSettings.uiScale;
      editTheme.value = settingsStore.editorSettings.theme;
      editCustomThemes.value = [...settingsStore.editorSettings.customThemes];
      editActiveCustomThemeId.value = settingsStore.editorSettings.activeCustomThemeId;
      editExecuteMode.value = settingsStore.editorSettings.executeMode;
      editShowExecutionTargetPicker.value = settingsStore.editorSettings.showExecutionTargetPicker;
      editAutoAliasTables.value = settingsStore.editorSettings.autoAliasTables;
      editWordWrap.value = settingsStore.editorSettings.wordWrap;
      editConfirmDangerousSqlExecution.value = settingsStore.editorSettings.confirmDangerousSqlExecution;
      editAppLayout.value = settingsStore.editorSettings.appLayout;
      editShowTrayIcon.value = settingsStore.desktopSettings.show_tray_icon;
      editQuitOnClose.value = settingsStore.desktopSettings.quit_on_close;
      editIconTheme.value = settingsStore.desktopSettings.icon_theme;
      editDebugLoggingEnabled.value = settingsStore.desktopSettings.debug_logging_enabled;
      editSidebarTablePageSize.value = settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE;
      editShowColumnCommentsInHeader.value = settingsStore.editorSettings.showColumnCommentsInHeader;
      editShowColumnTypesInHeader.value = settingsStore.editorSettings.showColumnTypesInHeader;
      editCompactColumnHeaderActions.value = settingsStore.editorSettings.compactColumnHeaderActions;
      editInfiniteScroll.value = settingsStore.editorSettings.infiniteScroll;
      editInfiniteScrollMaxRows.value = settingsStore.editorSettings.infiniteScrollMaxRows;
      editTableColumnTemplateRows.value = tableColumnTemplateRowsFromSettings(settingsStore.editorSettings.tableColumnTemplateFields);
      editShortcuts.value = normalizeShortcutSettings(settingsStore.editorSettings.shortcuts);
      editSqlFormatter.value = normalizeSqlFormatterSettings(settingsStore.editorSettings.sqlFormatter);
      sqlFormatterConfigValid.value = true;
      editSidebarActivation.value = settingsStore.editorSettings.sidebarActivation;
      editSidebarObjectDisplay.value = settingsStore.editorSettings.sidebarObjectDisplay;
      editAutoSelectActiveSidebarNode.value = settingsStore.editorSettings.autoSelectActiveSidebarNode;
      editDisconnectTabHandlingMode.value = settingsStore.editorSettings.disconnectTabHandlingMode;
      editReuseDataTab.value = settingsStore.editorSettings.reuseDataTab;
      editUpdateNotificationsEnabled.value = settingsStore.editorSettings.updateNotificationsEnabled;
      editSidebarHiddenTablePrefixes.value = settingsStore.editorSettings.sidebarHiddenTablePrefixes.join("\n");
      editSidebarHideTableComments.value = settingsStore.editorSettings.sidebarHideTableComments;
      editSidebarAllowHorizontalScroll.value = settingsStore.editorSettings.sidebarAllowHorizontalScroll;
      editExportBatchSize.value = settingsStore.editorSettings.exportBatchSize;
      editExportRowLimitEnabled.value = settingsStore.editorSettings.exportRowLimitEnabled;
      editExportRowLimit.value = settingsStore.editorSettings.exportRowLimit;
      editQueryExportKeysetOptimizationEnabled.value = settingsStore.editorSettings.queryExportKeysetOptimizationEnabled;
      editToolbarItems.value = { ...settingsStore.editorSettings.toolbarItems };
      editSnippets.value = settingsStore.editorSettings.snippets.map((s) => ({ ...s }));
    }
  },
  { immediate: true },
);

const shortcutConflicts = computed(() =>
  SHORTCUT_DEFINITIONS.flatMap((definition) => {
    const conflict = findShortcutConflict(definition.id, editShortcuts.value[definition.id], editShortcuts.value);
    return conflict ? [definition.id] : [];
  }),
);
const formatterEditorShortcutIds: ShortcutActionId[] = ["formatSql", "find", "replace", "saveSql", "acceptCompletion", "indentMore", "indentLess", "duplicateLine", "deleteLine", "moveLineUp", "moveLineDown", "copyLineUp", "copyLineDown", "undo", "redo", "selectAll"];
const formatterEditorShortcutDefinitions = computed(() => formatterEditorShortcutIds.map((id) => SHORTCUT_DEFINITIONS.find((definition) => definition.id === id)).filter((definition): definition is (typeof SHORTCUT_DEFINITIONS)[number] => !!definition));
const hasShortcutConflicts = computed(() => shortcutConflicts.value.length > 0);
const shortcutsChanged = computed(() => JSON.stringify(editShortcuts.value) !== JSON.stringify(settingsStore.editorSettings.shortcuts));
const hasBlockingShortcutConflicts = computed(() => shortcutsChanged.value && hasShortcutConflicts.value);
const hasBlockingFormatterConfig = computed(() => activeSettingsTab.value === "formatter" && !sqlFormatterConfigValid.value);
const hasApplyBlocker = computed(() => hasBlockingShortcutConflicts.value || hasBlockingFormatterConfig.value);

function hasChanges(): boolean {
  return (
    editFontFamily.value !== settingsStore.editorSettings.fontFamily ||
    editFontSize.value !== settingsStore.editorSettings.fontSize ||
    editUiScale.value !== settingsStore.editorSettings.uiScale ||
    editTheme.value !== settingsStore.editorSettings.theme ||
    JSON.stringify(editCustomThemes.value) !== JSON.stringify(settingsStore.editorSettings.customThemes) ||
    editActiveCustomThemeId.value !== settingsStore.editorSettings.activeCustomThemeId ||
    editExecuteMode.value !== settingsStore.editorSettings.executeMode ||
    editShowExecutionTargetPicker.value !== settingsStore.editorSettings.showExecutionTargetPicker ||
    editAutoAliasTables.value !== settingsStore.editorSettings.autoAliasTables ||
    editWordWrap.value !== settingsStore.editorSettings.wordWrap ||
    editConfirmDangerousSqlExecution.value !== settingsStore.editorSettings.confirmDangerousSqlExecution ||
    editAppLayout.value !== settingsStore.editorSettings.appLayout ||
    editShowTrayIcon.value !== settingsStore.desktopSettings.show_tray_icon ||
    editQuitOnClose.value !== settingsStore.desktopSettings.quit_on_close ||
    editIconTheme.value !== settingsStore.desktopSettings.icon_theme ||
    editDebugLoggingEnabled.value !== settingsStore.desktopSettings.debug_logging_enabled ||
    editSidebarTablePageSize.value !== (settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE) ||
    editShowColumnCommentsInHeader.value !== settingsStore.editorSettings.showColumnCommentsInHeader ||
    editShowColumnTypesInHeader.value !== settingsStore.editorSettings.showColumnTypesInHeader ||
    editCompactColumnHeaderActions.value !== settingsStore.editorSettings.compactColumnHeaderActions ||
    editInfiniteScroll.value !== settingsStore.editorSettings.infiniteScroll ||
    editInfiniteScrollMaxRows.value !== settingsStore.editorSettings.infiniteScrollMaxRows ||
    JSON.stringify(normalizedEditTableColumnTemplateFields.value) !== JSON.stringify(settingsStore.editorSettings.tableColumnTemplateFields) ||
    JSON.stringify(editShortcuts.value) !== JSON.stringify(settingsStore.editorSettings.shortcuts) ||
    JSON.stringify(editSqlFormatter.value) !== JSON.stringify(normalizeSqlFormatterSettings(settingsStore.editorSettings.sqlFormatter)) ||
    editSidebarActivation.value !== settingsStore.editorSettings.sidebarActivation ||
    editSidebarObjectDisplay.value !== settingsStore.editorSettings.sidebarObjectDisplay ||
    editAutoSelectActiveSidebarNode.value !== settingsStore.editorSettings.autoSelectActiveSidebarNode ||
    editDisconnectTabHandlingMode.value !== settingsStore.editorSettings.disconnectTabHandlingMode ||
    editReuseDataTab.value !== settingsStore.editorSettings.reuseDataTab ||
    editUpdateNotificationsEnabled.value !== settingsStore.editorSettings.updateNotificationsEnabled ||
    editSidebarHideTableComments.value !== settingsStore.editorSettings.sidebarHideTableComments ||
    editSidebarAllowHorizontalScroll.value !== settingsStore.editorSettings.sidebarAllowHorizontalScroll ||
    editExportBatchSize.value !== settingsStore.editorSettings.exportBatchSize ||
    editExportRowLimitEnabled.value !== settingsStore.editorSettings.exportRowLimitEnabled ||
    editExportRowLimit.value !== settingsStore.editorSettings.exportRowLimit ||
    editQueryExportKeysetOptimizationEnabled.value !== settingsStore.editorSettings.queryExportKeysetOptimizationEnabled ||
    JSON.stringify(editToolbarItems.value) !== JSON.stringify(settingsStore.editorSettings.toolbarItems) ||
    JSON.stringify(normalizeSidebarHiddenTablePrefixes(editSidebarHiddenTablePrefixes.value)) !== JSON.stringify(settingsStore.editorSettings.sidebarHiddenTablePrefixes) ||
    JSON.stringify(editSnippets.value) !== JSON.stringify(settingsStore.editorSettings.snippets)
  );
}

async function persistSettings() {
  if (hasApplyBlocker.value) return;
  const sidebarObjectDisplayChanged = editSidebarObjectDisplay.value !== settingsStore.editorSettings.sidebarObjectDisplay;
  const sidebarTablePageSizeChanged = editSidebarTablePageSize.value !== (settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE);
  settingsStore.updateEditorSettings({
    fontFamily: editFontFamily.value,
    fontSize: editFontSize.value,
    uiScale: editUiScale.value,
    theme: editTheme.value,
    customThemes: editCustomThemes.value,
    activeCustomThemeId: editActiveCustomThemeId.value,
    executeMode: editExecuteMode.value,
    showExecutionTargetPicker: editShowExecutionTargetPicker.value,
    autoAliasTables: editAutoAliasTables.value,
    wordWrap: editWordWrap.value,
    confirmDangerousSqlExecution: editConfirmDangerousSqlExecution.value,
    appLayout: editAppLayout.value,
    showColumnCommentsInHeader: editShowColumnCommentsInHeader.value,
    showColumnTypesInHeader: editShowColumnTypesInHeader.value,
    compactColumnHeaderActions: editCompactColumnHeaderActions.value,
    infiniteScroll: editInfiniteScroll.value,
    infiniteScrollMaxRows: editInfiniteScrollMaxRows.value,
    tableColumnTemplateFields: normalizedEditTableColumnTemplateFields.value,
    shortcuts: editShortcuts.value,
    sqlFormatter: normalizeSqlFormatterSettings(editSqlFormatter.value),
    sidebarActivation: editSidebarActivation.value,
    sidebarObjectDisplay: editSidebarObjectDisplay.value,
    autoSelectActiveSidebarNode: editAutoSelectActiveSidebarNode.value,
    disconnectTabHandlingMode: editDisconnectTabHandlingMode.value,
    reuseDataTab: editReuseDataTab.value,
    updateNotificationsEnabled: editUpdateNotificationsEnabled.value,
    sidebarHideTableComments: editSidebarHideTableComments.value,
    sidebarAllowHorizontalScroll: editSidebarAllowHorizontalScroll.value,
    sidebarHiddenTablePrefixes: normalizeSidebarHiddenTablePrefixes(editSidebarHiddenTablePrefixes.value),
    exportBatchSize: editExportBatchSize.value,
    exportRowLimitEnabled: editExportRowLimitEnabled.value,
    exportRowLimit: editExportRowLimit.value,
    queryExportKeysetOptimizationEnabled: editQueryExportKeysetOptimizationEnabled.value,
    toolbarItems: { ...editToolbarItems.value },
    snippets: editSnippets.value,
  });
  await settingsStore.updateDesktopSettings({
    show_tray_icon: editShowTrayIcon.value,
    quit_on_close: editQuitOnClose.value,
    close_action_prompted: desktopCloseBehaviorResetPending.value ? false : true,
    icon_theme: editIconTheme.value,
    debug_logging_enabled: editDebugLoggingEnabled.value,
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
  emit("update:open", false);
}

function resetDefaultsForTab(tab: SettingsCategory) {
  if (tab === "editor") {
    editFontFamily.value = DEFAULT_EDITOR_SETTINGS.fontFamily;
    editFontSize.value = DEFAULT_EDITOR_SETTINGS.fontSize;
    editExecuteMode.value = DEFAULT_EDITOR_SETTINGS.executeMode;
    editShowExecutionTargetPicker.value = DEFAULT_EDITOR_SETTINGS.showExecutionTargetPicker;
    editAutoAliasTables.value = DEFAULT_EDITOR_SETTINGS.autoAliasTables;
    editWordWrap.value = DEFAULT_EDITOR_SETTINGS.wordWrap;
    editConfirmDangerousSqlExecution.value = DEFAULT_EDITOR_SETTINGS.confirmDangerousSqlExecution;
  } else if (tab === "formatter") {
    editSqlFormatter.value = normalizeSqlFormatterSettings(DEFAULT_EDITOR_SETTINGS.sqlFormatter);
    sqlFormatterConfigValid.value = true;
  } else if (tab === "appearance") {
    editUiScale.value = DEFAULT_EDITOR_SETTINGS.uiScale;
    editTheme.value = DEFAULT_EDITOR_SETTINGS.theme;
    editCustomThemes.value = [...DEFAULT_EDITOR_SETTINGS.customThemes];
    editActiveCustomThemeId.value = DEFAULT_EDITOR_SETTINGS.activeCustomThemeId;
    editAppLayout.value = DEFAULT_EDITOR_SETTINGS.appLayout;
    editShowTrayIcon.value = DEFAULT_DESKTOP_SETTINGS.show_tray_icon;
    editQuitOnClose.value = DEFAULT_DESKTOP_SETTINGS.quit_on_close;
    desktopCloseBehaviorResetPending.value = true;
    editIconTheme.value = DEFAULT_DESKTOP_SETTINGS.icon_theme;
    editDebugLoggingEnabled.value = DEFAULT_DESKTOP_SETTINGS.debug_logging_enabled;
  } else if (tab === "navigation") {
    editSidebarTablePageSize.value = DEFAULT_SIDEBAR_TABLE_PAGE_SIZE;
    editSidebarActivation.value = DEFAULT_EDITOR_SETTINGS.sidebarActivation;
    editSidebarObjectDisplay.value = DEFAULT_EDITOR_SETTINGS.sidebarObjectDisplay;
    editAutoSelectActiveSidebarNode.value = DEFAULT_EDITOR_SETTINGS.autoSelectActiveSidebarNode;
    editDisconnectTabHandlingMode.value = DEFAULT_EDITOR_SETTINGS.disconnectTabHandlingMode;
    editReuseDataTab.value = DEFAULT_EDITOR_SETTINGS.reuseDataTab;
    editUpdateNotificationsEnabled.value = DEFAULT_EDITOR_SETTINGS.updateNotificationsEnabled;
    editSidebarHideTableComments.value = DEFAULT_EDITOR_SETTINGS.sidebarHideTableComments;
    editSidebarAllowHorizontalScroll.value = DEFAULT_EDITOR_SETTINGS.sidebarAllowHorizontalScroll;
    editSidebarHiddenTablePrefixes.value = DEFAULT_EDITOR_SETTINGS.sidebarHiddenTablePrefixes.join("\n");
    editToolbarItems.value = { ...DEFAULT_EDITOR_SETTINGS.toolbarItems };
  } else if (tab === "data") {
    editShowColumnCommentsInHeader.value = DEFAULT_EDITOR_SETTINGS.showColumnCommentsInHeader;
    editShowColumnTypesInHeader.value = DEFAULT_EDITOR_SETTINGS.showColumnTypesInHeader;
    editCompactColumnHeaderActions.value = DEFAULT_EDITOR_SETTINGS.compactColumnHeaderActions;
    editInfiniteScroll.value = DEFAULT_EDITOR_SETTINGS.infiniteScroll;
    editInfiniteScrollMaxRows.value = DEFAULT_EDITOR_SETTINGS.infiniteScrollMaxRows;
    editTableColumnTemplateRows.value = tableColumnTemplateRowsFromSettings(DEFAULT_EDITOR_SETTINGS.tableColumnTemplateFields);
    editExportBatchSize.value = DEFAULT_EDITOR_SETTINGS.exportBatchSize;
    editExportRowLimitEnabled.value = DEFAULT_EDITOR_SETTINGS.exportRowLimitEnabled;
    editExportRowLimit.value = DEFAULT_EDITOR_SETTINGS.exportRowLimit;
    editQueryExportKeysetOptimizationEnabled.value = DEFAULT_EDITOR_SETTINGS.queryExportKeysetOptimizationEnabled;
  } else if (tab === "shortcuts") {
    editShortcuts.value = normalizeShortcutSettings(DEFAULT_EDITOR_SETTINGS.shortcuts);
  } else if (tab === "snippets") {
    editSnippets.value = DEFAULT_SQL_SNIPPETS.map((s) => ({ ...s }));
  }
}

function resetAllDefaults() {
  editFontFamily.value = DEFAULT_EDITOR_SETTINGS.fontFamily;
  editFontSize.value = DEFAULT_EDITOR_SETTINGS.fontSize;
  editUiScale.value = DEFAULT_EDITOR_SETTINGS.uiScale;
  editTheme.value = DEFAULT_EDITOR_SETTINGS.theme;
  editCustomThemes.value = [...DEFAULT_EDITOR_SETTINGS.customThemes];
  editActiveCustomThemeId.value = DEFAULT_EDITOR_SETTINGS.activeCustomThemeId;
  editExecuteMode.value = DEFAULT_EDITOR_SETTINGS.executeMode;
  editShowExecutionTargetPicker.value = DEFAULT_EDITOR_SETTINGS.showExecutionTargetPicker;
  editAutoAliasTables.value = DEFAULT_EDITOR_SETTINGS.autoAliasTables;
  editWordWrap.value = DEFAULT_EDITOR_SETTINGS.wordWrap;
  editConfirmDangerousSqlExecution.value = DEFAULT_EDITOR_SETTINGS.confirmDangerousSqlExecution;
  editAppLayout.value = DEFAULT_EDITOR_SETTINGS.appLayout;
  editShowTrayIcon.value = DEFAULT_DESKTOP_SETTINGS.show_tray_icon;
  editQuitOnClose.value = DEFAULT_DESKTOP_SETTINGS.quit_on_close;
  desktopCloseBehaviorResetPending.value = true;
  editIconTheme.value = DEFAULT_DESKTOP_SETTINGS.icon_theme;
  editDebugLoggingEnabled.value = DEFAULT_DESKTOP_SETTINGS.debug_logging_enabled;
  editSidebarTablePageSize.value = DEFAULT_SIDEBAR_TABLE_PAGE_SIZE;
  editShowColumnCommentsInHeader.value = DEFAULT_EDITOR_SETTINGS.showColumnCommentsInHeader;
  editShowColumnTypesInHeader.value = DEFAULT_EDITOR_SETTINGS.showColumnTypesInHeader;
  editCompactColumnHeaderActions.value = DEFAULT_EDITOR_SETTINGS.compactColumnHeaderActions;
  editInfiniteScroll.value = DEFAULT_EDITOR_SETTINGS.infiniteScroll;
  editInfiniteScrollMaxRows.value = DEFAULT_EDITOR_SETTINGS.infiniteScrollMaxRows;
  editTableColumnTemplateRows.value = tableColumnTemplateRowsFromSettings(DEFAULT_EDITOR_SETTINGS.tableColumnTemplateFields);
  editShortcuts.value = normalizeShortcutSettings(DEFAULT_EDITOR_SETTINGS.shortcuts);
  editSqlFormatter.value = normalizeSqlFormatterSettings(DEFAULT_EDITOR_SETTINGS.sqlFormatter);
  sqlFormatterConfigValid.value = true;
  editSidebarActivation.value = DEFAULT_EDITOR_SETTINGS.sidebarActivation;
  editSidebarObjectDisplay.value = DEFAULT_EDITOR_SETTINGS.sidebarObjectDisplay;
  editAutoSelectActiveSidebarNode.value = DEFAULT_EDITOR_SETTINGS.autoSelectActiveSidebarNode;
  editDisconnectTabHandlingMode.value = DEFAULT_EDITOR_SETTINGS.disconnectTabHandlingMode;
  editReuseDataTab.value = DEFAULT_EDITOR_SETTINGS.reuseDataTab;
  editUpdateNotificationsEnabled.value = DEFAULT_EDITOR_SETTINGS.updateNotificationsEnabled;
  editSidebarHideTableComments.value = DEFAULT_EDITOR_SETTINGS.sidebarHideTableComments;
  editSidebarAllowHorizontalScroll.value = DEFAULT_EDITOR_SETTINGS.sidebarAllowHorizontalScroll;
  editSidebarHiddenTablePrefixes.value = DEFAULT_EDITOR_SETTINGS.sidebarHiddenTablePrefixes.join("\n");
  editExportBatchSize.value = DEFAULT_EDITOR_SETTINGS.exportBatchSize;
  editExportRowLimitEnabled.value = DEFAULT_EDITOR_SETTINGS.exportRowLimitEnabled;
  editExportRowLimit.value = DEFAULT_EDITOR_SETTINGS.exportRowLimit;
  editQueryExportKeysetOptimizationEnabled.value = DEFAULT_EDITOR_SETTINGS.queryExportKeysetOptimizationEnabled;
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
  return splitDataType(tableColumnTemplateDataTypeForSelectedDatabase(row)).params;
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

function onFontFamilyChange(v: any) {
  if (typeof v === "string") editFontFamily.value = v;
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
  const shortcut = eventToShortcut(event);
  if (!shortcut) return;
  onShortcutChange(actionId, shortcut);
  editingShortcutId.value = null;
}

function formatShortcutPill(shortcut: string): string {
  if (!shortcut) return "—";
  const isMac = globalThis.navigator?.platform?.toLowerCase().includes("mac") ?? false;
  return shortcut
    .split("+")
    .filter(Boolean)
    .map((part) => {
      if (part === "Mod") return isMac ? "⌘" : "Ctrl";
      if (part === "Meta") return isMac ? "⌘" : "Meta";
      if (part === "Shift") return isMac ? "⇧" : "Shift";
      if (part === "Alt") return isMac ? "⌥" : "Alt";
      if (part === "Control" || part === "Ctrl") return isMac ? "⌃" : "Ctrl";
      if (part === "Enter") return "↵";
      if (part === "Backspace") return "⌫";
      if (part === "Delete") return isMac ? "⌦" : "Del";
      if (part === "Escape") return "Esc";
      if (part === "ArrowUp") return "↑";
      if (part === "ArrowDown") return "↓";
      if (part === "ArrowLeft") return "←";
      if (part === "ArrowRight") return "→";
      if (part === " ") return "Space";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(isMac ? " " : " + ");
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

function setSidebarActivation(value: "single" | "double") {
  editSidebarActivation.value = value;
}

const activeSettingsTab = ref("editor");
const isWeb = !isTauriRuntime();
const displayedAppVersion = computed(() => (props.appVersion ? `v${props.appVersion}` : ""));
type SettingsCategory = "editor" | "formatter" | "appearance" | "navigation" | "data" | "shortcuts" | "snippets" | "sync" | "ai" | "mcp" | "security" | "about";
const settingsCategoryNav = computed<{ value: SettingsCategory; label: string }[]>(() => [
  { value: "editor", label: t("settings.editorTab") },
  { value: "formatter", label: t("settings.sqlFormatterTab") },
  { value: "appearance", label: t("settings.appearanceTab") },
  { value: "navigation", label: t("settings.navigationTab") },
  { value: "data", label: t("settings.dataTab") },
  { value: "shortcuts", label: t("settings.shortcutsTab") },
  { value: "snippets", label: t("settings.snippetsTab") },
  ...(isWeb ? [] : [{ value: "sync" as const, label: t("settings.syncTab") }]),
  { value: "ai", label: t("settings.aiTab") },
  ...(isWeb ? [] : [{ value: "mcp" as const, label: t("settings.mcpTab") }]),
  ...(isWeb ? [{ value: "security" as const, label: t("settings.securityTab") }] : []),
  { value: "about", label: t("settings.aboutTab") },
]);
const settingsTabsWithApplyFooter = new Set<SettingsCategory>(["editor", "formatter", "appearance", "navigation", "data", "shortcuts", "snippets"]);

function hasSettingsApplyFooter(value: SettingsCategory): boolean {
  return settingsTabsWithApplyFooter.has(value);
}

function settingsCategoryButton(value: SettingsCategory): string {
  return ["w-full rounded-md px-3 py-2 text-left text-sm transition-colors", value === activeSettingsTab.value ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground"].join(" ");
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
const mcpStatus = ref<McpServerStatus | null>(null);
const mcpStatusLoading = ref(false);
const mcpStatusError = ref("");
const mcpCopied = ref<"" | "install" | "claude-config" | "codex-config" | "opencode-config">("");
const mcpConfigTab = ref<"claude" | "codex" | "opencode">("claude");
const mcpReadonlyMode = ref(false);
const mcpAllowDangerous = ref(false);
const mcpInstalling = ref(false);
const mcpInstallMessage = ref("");
const mcpInstallError = ref(false);

const mcpEnvEntries = computed(() => {
  const entries: Array<[string, string]> = [];
  if (mcpReadonlyMode.value) {
    entries.push(["DBX_MCP_ALLOW_WRITES", "0"]);
  }
  if (!mcpReadonlyMode.value && mcpAllowDangerous.value) {
    entries.push(["DBX_MCP_ALLOW_DANGEROUS_SQL", "1"]);
  }
  return entries;
});

const mcpClaudeRecommendedConfig = computed(() => {
  const config: Record<string, unknown> = {
    mcpServers: {
      dbx: {
        command: "dbx-mcp-server",
      } as Record<string, unknown>,
    },
  };
  if (mcpEnvEntries.value.length > 0) {
    const env = Object.fromEntries(mcpEnvEntries.value);
    ((config.mcpServers as Record<string, any>).dbx as Record<string, unknown>).env = env;
  }
  return JSON.stringify(config, null, 2);
});

const mcpCodexRecommendedConfig = computed(() => {
  const lines = ["[mcp_servers.dbx]", 'command = "dbx-mcp-server"'];
  if (mcpEnvEntries.value.length > 0) {
    lines.push("");
    lines.push("[mcp_servers.dbx.env]");
    for (const [key, value] of mcpEnvEntries.value) {
      lines.push(`${key} = "${value}"`);
    }
  }
  return lines.join("\n");
});

const mcpOpenCodeRecommendedConfig = computed(() => {
  const config: Record<string, unknown> = {
    mcp: {
      dbx: {
        type: "local",
        command: ["dbx-mcp-server"],
      } as Record<string, unknown>,
    },
  };
  if (mcpEnvEntries.value.length > 0) {
    const env = Object.fromEntries(mcpEnvEntries.value);
    ((config.mcp as Record<string, unknown>).dbx as Record<string, unknown>).environment = env;
  }
  return JSON.stringify(config, null, 2);
});

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

watch(mcpReadonlyMode, (value) => {
  if (value) mcpAllowDangerous.value = false;
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

async function copyMcpText(kind: "install" | "claude-config" | "codex-config" | "opencode-config", value: string) {
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
const webdavRemotePath = ref(localStorage.getItem("dbx-webdav-remote-path") || "DBX/sync/snapshot.json");
const webdavSyncSecrets = ref(false);
const webdavSecretsPassphrase = ref("");
const webdavAutoUploadEnabled = ref(localStorage.getItem("dbx-webdav-auto-upload-enabled") === "true");
const webdavAutoUploadIntervalMinutes = ref(Number(localStorage.getItem("dbx-webdav-auto-upload-interval-minutes") || "30"));
const webdavBusy = ref<"" | "test" | "upload" | "download">("");
const webdavMessage = ref("");
const webdavError = ref(false);
let webdavAutoUploadTimer: ReturnType<typeof window.setInterval> | undefined;

const webdavReady = computed(() => !!webdavEndpoint.value.trim() && !webdavBusy.value && (!webdavSyncSecrets.value || !!webdavSecretsPassphrase.value.trim()));

function currentWebDavConfig(): WebDavConfig {
  return {
    endpoint: webdavEndpoint.value.trim(),
    username: webdavUsername.value.trim() || undefined,
    password: webdavPassword.value || undefined,
    remotePath: webdavRemotePath.value.trim() || "DBX/sync/snapshot.json",
  };
}

function currentWebDavAccountConfig(): WebDavConfig {
  const config = currentWebDavConfig();
  return { ...config, password: undefined };
}

function rememberWebDavFields() {
  localStorage.setItem("dbx-webdav-endpoint", webdavEndpoint.value.trim());
  localStorage.setItem("dbx-webdav-username", webdavUsername.value.trim());
  localStorage.setItem("dbx-webdav-remote-path", webdavRemotePath.value.trim() || "DBX/sync/snapshot.json");
  localStorage.setItem("dbx-webdav-auto-upload-enabled", String(webdavAutoUploadEnabled.value));
  localStorage.setItem("dbx-webdav-auto-upload-interval-minutes", String(normalizedWebDavAutoUploadInterval()));
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

function normalizedWebDavAutoUploadInterval() {
  const value = Number(webdavAutoUploadIntervalMinutes.value);
  if (!Number.isFinite(value)) return 30;
  return Math.max(1, Math.min(1440, Math.round(value)));
}

function scheduleWebDavAutoUpload() {
  if (webdavAutoUploadTimer) {
    window.clearInterval(webdavAutoUploadTimer);
    webdavAutoUploadTimer = undefined;
  }
  if (!webdavAutoUploadEnabled.value) return;

  const intervalMinutes = normalizedWebDavAutoUploadInterval();
  webdavAutoUploadIntervalMinutes.value = intervalMinutes;
  webdavAutoUploadTimer = window.setInterval(() => {
    void runWebDavAutoUpload();
  }, intervalMinutes * 60_000);
}

async function runWebDavAutoUpload() {
  if (!webdavEndpoint.value.trim() || webdavBusy.value) return;
  webdavBusy.value = "upload";
  webdavMessage.value = "";
  webdavError.value = false;
  try {
    rememberWebDavFields();
    await applyWebDavPasswordPreference();
    const summary = await webdavSyncUpload(currentWebDavConfig(), settingsStore.editorSettings, webdavSyncSecrets.value ? webdavSecretsPassphrase.value : undefined);
    setWebDavResult(t("settings.syncAutoUploadSuccess", { bytes: summary.bytes, path: summary.remotePath }));
  } catch (e: any) {
    setWebDavResult(e?.message || String(e), true);
  } finally {
    webdavBusy.value = "";
  }
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

watch(
  () => props.open,
  async (open) => {
    if (open) {
      activeSettingsTab.value = props.initialTab || "editor";
      passwordMessage.value = "";
      oldPassword.value = "";
      newPassword.value = "";
      confirmNewPassword.value = "";
      await settingsStore.initAiConfig();
      await settingsStore.initDesktopSettings();
      editShowTrayIcon.value = settingsStore.desktopSettings.show_tray_icon;
      editQuitOnClose.value = settingsStore.desktopSettings.quit_on_close;
      editIconTheme.value = settingsStore.desktopSettings.icon_theme;
      editDebugLoggingEnabled.value = settingsStore.desktopSettings.debug_logging_enabled;
      editSidebarTablePageSize.value = settingsStore.desktopSettings.sidebar_table_page_size ?? DEFAULT_SIDEBAR_TABLE_PAGE_SIZE;
      webdavPassword.value = "";
      await refreshWebDavPasswordStatus();
      syncAiEditState();
      if (!isWeb && activeSettingsTab.value === "mcp") void refreshMcpStatus();
      if (!isWeb && activeSettingsTab.value === "ai" && aiIsCodexCli.value) void ensureCodexMcpStatus();
      await scrollToInitialSettingsSection();
    }
  },
  { immediate: true },
);

watch(
  () => props.initialSection,
  () => {
    if (props.open) void scrollToInitialSettingsSection();
  },
);

watch([webdavEndpoint, webdavUsername], () => {
  void refreshWebDavPasswordStatus();
});
watch(webdavRememberPassword, (val) => {
  localStorage.setItem("dbx-webdav-remember-password", String(val));
});
watch([webdavAutoUploadEnabled, webdavAutoUploadIntervalMinutes], () => {
  rememberWebDavFields();
  scheduleWebDavAutoUpload();
});

watch(activeSettingsTab, (tab) => {
  if (tab === "mcp" && !mcpStatus.value && !mcpStatusLoading.value) void refreshMcpStatus();
  if (tab === "ai" && aiIsCodexCli.value) void ensureCodexMcpStatus();
  if (tab === "appearance") {
    checkLayoutDescTruncation();
    checkIconThemeDescTruncation();
  }
});

onMounted(() => {
  void refreshWebDavPasswordStatus();
  scheduleWebDavAutoUpload();
  checkLayoutDescTruncation();
  checkIconThemeDescTruncation();
  initTruncationObservers();
});

onUnmounted(() => {
  if (webdavAutoUploadTimer) {
    window.clearInterval(webdavAutoUploadTimer);
    webdavAutoUploadTimer = undefined;
  }
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
    const res = await fetch("/api/auth/change-password", {
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
const aiProviderOptions = computed(() => Object.values(AI_PROVIDER_PRESETS).filter((provider) => !isWeb || provider.provider !== "codex-cli"));
const selectedAiProviderPreset = computed(() => AI_PROVIDER_PRESETS[aiEditProvider.value]);

const aiEditProvider = ref<AiProvider>(settingsStore.aiConfig.provider);
const aiEditApiKey = ref(settingsStore.aiConfig.apiKey);
const aiEditAuthMethod = ref<AiAuthMethod>(settingsStore.aiConfig.authMethod || AI_PROVIDER_PRESETS[settingsStore.aiConfig.provider].authMethod);
const aiEditEndpoint = ref(settingsStore.aiConfig.endpoint);
const aiEditModel = ref(settingsStore.aiConfig.model);
const aiEditApiStyle = ref<AiApiStyle>(settingsStore.aiConfig.apiStyle || "completions");
const aiEditProxyEnabled = ref(!!settingsStore.aiConfig.proxyEnabled);
const aiEditProxyUrl = ref(settingsStore.aiConfig.proxyUrl || "");
const aiEditEnableThinking = ref(settingsStore.aiConfig.enableThinking ?? true);
const aiEditReasoningLevel = ref<AiReasoningLevel>(settingsStore.aiConfig.reasoningLevel || "default");
const aiEditContextWindow = ref<number | undefined>(settingsStore.aiConfig.contextWindow);
const aiEditCodexCliPath = ref(settingsStore.aiConfig.codexCliPath || "");
const aiEditCodexCliEnvRows = ref<AiEnvRow[]>(aiEnvRowsFromConfig(settingsStore.aiConfig.codexCliEnv));

const aiModelOptions = ref<AiModelInfo[]>([]);
const aiModelLoading = ref(false);
const aiModelError = ref("");
const aiModelLoadedSignature = ref("");
let aiModelRequestToken = 0;

const aiCompletionsMode = computed(() => aiEditApiStyle.value === "completions");
const aiReasoningLevelOptions: Array<{ value: AiReasoningLevel; labelKey: string }> = [
  { value: "default", labelKey: "ai.reasoningLevelDefault" },
  { value: "minimal", labelKey: "ai.reasoningLevelMinimal" },
  { value: "low", labelKey: "ai.reasoningLevelLow" },
  { value: "medium", labelKey: "ai.reasoningLevelMedium" },
  { value: "high", labelKey: "ai.reasoningLevelHigh" },
];

const aiTesting = ref(false);
const aiTestResult = ref<"" | "success" | "error">("");
const aiTestError = ref("");
const aiTestLatency = ref<number | null>(null);
const aiTestErrorCopied = ref(false);
const aiIsCodexCli = computed(() => aiEditProvider.value === "codex-cli");
watch(aiIsCodexCli, (isCodex) => {
  if (isCodex) void ensureCodexMcpStatus();
});
const aiRequiresApiKey = computed(() => AI_PROVIDER_PRESETS[aiEditProvider.value].requiresApiKey);
const aiSupportsAuthMethod = computed(() => aiEditProvider.value === "claude");
const aiCredentialLabel = computed(() => (aiSupportsAuthMethod.value && aiEditAuthMethod.value === "bearer" ? "Auth Token" : "API Key"));
const aiCredentialPlaceholder = computed(() => {
  if (!aiRequiresApiKey.value) return "Optional";
  if (aiSupportsAuthMethod.value && aiEditAuthMethod.value === "bearer") return "ANTHROPIC_AUTH_TOKEN";
  return "";
});
const aiEndpointPlaceholder = computed(() => {
  if (aiEditProvider.value === "openai-compatible" || aiEditProvider.value === "custom") {
    return "https://api.example.com/v1";
  }
  return "https://api.openai.com/v1";
});
const aiEndpointHint = computed(() => {
  if (aiEditProvider.value === "openai-compatible" || aiEditProvider.value === "custom") {
    return "大多数 OpenAI 兼容 API 需要 /v1 路径前缀";
  }
  return "";
});
const aiSupportsApiStyle = computed(() => !aiIsCodexCli.value && (aiEditProvider.value === "openai" || aiEditProvider.value === "openai-compatible" || aiEditProvider.value === "custom"));
const aiCodexMcpNeedsInstall = computed(() => aiIsCodexCli.value && (!mcpStatus.value || !mcpStatus.value.installed));
const aiCodexMcpCanInstall = computed(() => {
  const status = mcpStatus.value;
  return !mcpInstalling.value && !!status?.npm_available && (!status.installed || status.update_available);
});
const aiCodexMcpActionLabel = computed(() => {
  if (!mcpStatus.value?.installed) return t("settings.mcpInstallButton");
  if (mcpStatus.value.update_available) return t("settings.mcpUpdateButton");
  return t("settings.mcpUpToDate");
});
const aiModelListSupported = computed(() => aiEditProvider.value !== "gemini");
const aiCanListModels = computed(() => aiModelListSupported.value && (aiIsCodexCli.value || !!aiEditEndpoint.value.trim()) && (!aiRequiresApiKey.value || !!aiEditApiKey.value.trim()));
const aiModelOptionIds = computed(() => aiModelOptions.value.map((model) => model.id));
const aiModelEmptyText = computed(() => {
  if (aiModelError.value) return aiModelError.value;
  if (!aiModelListSupported.value) return t("ai.modelListUnsupported");
  return t("ai.noModels");
});
const aiCodexEnvError = computed(() => codexEnvValidationError());
const aiCodexPathError = computed(() => {
  const path = aiEditCodexCliPath.value.trim();
  const firstToken = path.split(/\s+/)[0] || "";
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(firstToken) ? t("ai.codexCliPathEnvError") : "";
});
const aiCodexValidationError = computed(() => (aiIsCodexCli.value ? aiCodexPathError.value || aiCodexEnvError.value : ""));

function aiEnvRowsFromConfig(env: unknown): AiEnvRow[] {
  return Object.entries(normalizeAiEnv(env)).map(([key, value]) => ({ id: uuid(), key, value }));
}

function codexEnvFromRows(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of aiEditCodexCliEnvRows.value) {
    const key = row.key.trim();
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key.toUpperCase().startsWith("DBX_MCP_")) continue;
    result[key] = row.value;
  }
  return result;
}

function codexEnvSignature(): string {
  return JSON.stringify(Object.entries(codexEnvFromRows()).sort(([left], [right]) => left.localeCompare(right)));
}

function savedCodexEnvSignature(): string {
  return JSON.stringify(Object.entries(normalizeAiEnv(settingsStore.aiConfig.codexCliEnv)).sort(([left], [right]) => left.localeCompare(right)));
}

function codexEnvValidationError(): string {
  for (const row of aiEditCodexCliEnvRows.value) {
    const key = row.key.trim();
    if (key && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return t("ai.codexCliEnvInvalidName", { name: key });
    if (key.toUpperCase().startsWith("DBX_MCP_")) return t("ai.codexCliEnvReservedName", { name: key });
  }
  return "";
}

function addCodexEnvRow() {
  aiEditCodexCliEnvRows.value.push({ id: uuid(), key: "", value: "" });
}

function removeCodexEnvRow(id: string) {
  aiEditCodexCliEnvRows.value = aiEditCodexCliEnvRows.value.filter((row) => row.id !== id);
}

function clearAiModelOptions() {
  aiModelRequestToken += 1;
  aiModelOptions.value = [];
  aiModelError.value = "";
  aiModelLoadedSignature.value = "";
  aiModelLoading.value = false;
}

function aiModelConfigSignature() {
  return JSON.stringify({
    provider: aiEditProvider.value,
    endpoint: aiEditEndpoint.value.trim(),
    apiKey: aiEditApiKey.value.trim(),
    authMethod: aiEditAuthMethod.value,
    proxyEnabled: aiEditProxyEnabled.value,
    proxyUrl: aiEditProxyUrl.value.trim(),
    codexCliPath: aiEditCodexCliPath.value.trim(),
    codexCliEnv: codexEnvSignature(),
  });
}

function currentAiEditConfig() {
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
    reasoningLevel: aiEditReasoningLevel.value,
    contextWindow: aiEditContextWindow.value || undefined,
    codexCliPath: aiEditCodexCliPath.value.trim() || undefined,
    codexCliEnv: aiIsCodexCli.value ? codexEnvFromRows() : {},
  };
}

function normalizeAiModelOptions(models: AiModelInfo[]): AiModelInfo[] {
  const seen = new Set<string>();
  const normalized: AiModelInfo[] = [];
  for (const model of models) {
    const id = model.id?.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, displayName: model.displayName?.trim() || undefined });
  }
  return normalized;
}

function displayAiModelName(modelId: string): string {
  return aiModelOptions.value.find((model) => model.id === modelId)?.displayName || modelId;
}

function aiModelOptionPresentation(modelId: string, label = displayAiModelName(modelId)) {
  return formatAiModelOption(label, modelId);
}

function aiModelOptionSecondary(modelId: string, label = displayAiModelName(modelId)) {
  return aiModelOptionPresentation(modelId, label).secondary;
}

async function aiRefreshModels() {
  if (aiModelLoading.value) return;
  if (!aiModelListSupported.value) {
    aiModelError.value = t("ai.modelListUnsupported");
    return;
  }
  if (!aiIsCodexCli.value && !aiEditEndpoint.value.trim()) {
    aiModelError.value = t("ai.modelListEndpointRequired");
    return;
  }
  if (aiRequiresApiKey.value && !aiEditApiKey.value.trim()) {
    aiModelError.value = t("ai.modelListApiKeyRequired");
    return;
  }

  const token = ++aiModelRequestToken;
  const signature = aiModelConfigSignature();
  aiModelLoading.value = true;
  aiModelError.value = "";
  try {
    const models = normalizeAiModelOptions(await aiListModels(currentAiEditConfig()));
    if (token !== aiModelRequestToken) return;
    aiModelOptions.value = models;
    aiModelLoadedSignature.value = signature;
    if (!aiEditModel.value.trim() && models[0]) aiEditModel.value = models[0].id;
  } catch (e: any) {
    if (token !== aiModelRequestToken) return;
    aiModelOptions.value = [];
    aiModelError.value = e?.message || String(e);
  } finally {
    if (token === aiModelRequestToken) aiModelLoading.value = false;
  }
}

function onAiModelListOpen(open: boolean) {
  if (open && aiCanListModels.value && !aiModelLoading.value && (!aiModelOptions.value.length || aiModelLoadedSignature.value !== aiModelConfigSignature())) {
    void aiRefreshModels();
  }
}

function aiSelectModel(modelId: string) {
  aiEditModel.value = modelId;
}

function syncAiEditState() {
  const provider = isWeb && settingsStore.aiConfig.provider === "codex-cli" ? "claude" : settingsStore.aiConfig.provider;
  aiEditProvider.value = provider;
  aiEditApiKey.value = settingsStore.aiConfig.apiKey;
  aiEditAuthMethod.value = settingsStore.aiConfig.authMethod || AI_PROVIDER_PRESETS[provider].authMethod;
  aiEditEndpoint.value = provider === settingsStore.aiConfig.provider ? settingsStore.aiConfig.endpoint : AI_PROVIDER_PRESETS[provider].endpoint;
  aiEditModel.value = provider === settingsStore.aiConfig.provider ? settingsStore.aiConfig.model : AI_PROVIDER_PRESETS[provider].model;
  aiEditApiStyle.value = provider === settingsStore.aiConfig.provider ? settingsStore.aiConfig.apiStyle || "completions" : AI_PROVIDER_PRESETS[provider].apiStyle;
  aiEditProxyEnabled.value = !!settingsStore.aiConfig.proxyEnabled;
  aiEditProxyUrl.value = settingsStore.aiConfig.proxyUrl || "";
  aiEditEnableThinking.value = settingsStore.aiConfig.enableThinking ?? true;
  aiEditReasoningLevel.value = settingsStore.aiConfig.reasoningLevel || "default";
  aiEditContextWindow.value = settingsStore.aiConfig.contextWindow;
  aiEditCodexCliPath.value = settingsStore.aiConfig.codexCliPath || "";
  aiEditCodexCliEnvRows.value = aiEnvRowsFromConfig(settingsStore.aiConfig.codexCliEnv);
  aiTestResult.value = "";
  aiTestError.value = "";
  aiTestLatency.value = null;
  aiTestErrorCopied.value = false;
  clearAiModelOptions();
}

function aiSelectProvider(provider: AiProvider) {
  if (isWeb && provider === "codex-cli") return;
  aiEditProvider.value = provider;
  aiEditEndpoint.value = AI_PROVIDER_PRESETS[provider].endpoint;
  aiEditModel.value = AI_PROVIDER_PRESETS[provider].model;
  aiEditApiStyle.value = AI_PROVIDER_PRESETS[provider].apiStyle;
  aiEditAuthMethod.value = AI_PROVIDER_PRESETS[provider].authMethod;
  aiEditReasoningLevel.value = "default";
  if (!AI_PROVIDER_PRESETS[provider].requiresApiKey) aiEditApiKey.value = "";
  aiEditCodexCliPath.value = "";
  aiEditCodexCliEnvRows.value = [];
  aiTestResult.value = "";
  aiTestError.value = "";
  aiTestLatency.value = null;
  aiTestErrorCopied.value = false;
  clearAiModelOptions();
  if (provider === "codex-cli") void ensureCodexMcpStatus();
}

function aiHasChanges(): boolean {
  return (
    aiEditProvider.value !== settingsStore.aiConfig.provider ||
    aiEditApiKey.value !== settingsStore.aiConfig.apiKey ||
    aiEditAuthMethod.value !== (settingsStore.aiConfig.authMethod || AI_PROVIDER_PRESETS[settingsStore.aiConfig.provider].authMethod) ||
    aiEditEndpoint.value !== settingsStore.aiConfig.endpoint ||
    aiEditModel.value !== settingsStore.aiConfig.model ||
    aiEditApiStyle.value !== (settingsStore.aiConfig.apiStyle || "completions") ||
    aiEditProxyEnabled.value !== !!settingsStore.aiConfig.proxyEnabled ||
    aiEditProxyUrl.value !== (settingsStore.aiConfig.proxyUrl || "") ||
    aiEditEnableThinking.value !== (settingsStore.aiConfig.enableThinking ?? true) ||
    aiEditReasoningLevel.value !== (settingsStore.aiConfig.reasoningLevel || "default") ||
    aiEditContextWindow.value !== settingsStore.aiConfig.contextWindow ||
    aiEditCodexCliPath.value !== (settingsStore.aiConfig.codexCliPath || "") ||
    codexEnvSignature() !== savedCodexEnvSignature()
  );
}

function aiApplySettings() {
  if (aiCodexValidationError.value) {
    aiTestResult.value = "error";
    aiTestError.value = aiCodexValidationError.value;
    return;
  }
  settingsStore.updateAiConfig(currentAiEditConfig());
}

async function aiTestConn() {
  if ((aiRequiresApiKey.value && !aiEditApiKey.value.trim()) || (!aiIsCodexCli.value && !aiEditEndpoint.value.trim()) || (!aiIsCodexCli.value && !aiEditModel.value.trim())) return;
  if (aiCodexValidationError.value) {
    aiTestResult.value = "error";
    aiTestError.value = aiCodexValidationError.value;
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

async function ensureCodexMcpStatus() {
  if (isWeb || activeSettingsTab.value !== "ai" || !aiIsCodexCli.value || mcpStatus.value || mcpStatusLoading.value) return;
  await refreshMcpStatus();
}

// ---------- CodeMirror preview ----------
const previewRef = ref<HTMLDivElement>();
const previewView = shallowRef<EditorViewType | null>(null);

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
  customColors?: CustomThemeColors;
}>(() => ({
  fontFamily: editFontFamily.value,
  fontSize: editFontSize.value,
  theme: editTheme.value,
  appAppearance: isDark.value ? "dark" : "light",
  customColors: getPreviewCustomThemeColors(),
}));

const previewSql = `SELECT u.id, u.name
FROM users u
ORDER BY u.id LIMIT 5;`;

let fontThemeComp: import("@codemirror/state").Compartment | null = null;
let themeComp: import("@codemirror/state").Compartment | null = null;
let editorViewModule: typeof import("@codemirror/view") | null = null;

watch(
  [previewSettings, editCustomThemes, editActiveCustomThemeId],
  async ([ss]) => {
    if (!previewView.value || !fontThemeComp || !themeComp || !editorViewModule) return;

    const themeExt = await loadEditorTheme(ss.theme, ss.appAppearance, ss.customColors);
    previewView.value.dispatch({
      effects: [themeComp.reconfigure(themeExt), fontThemeComp.reconfigure(editorFontTheme(editorViewModule.EditorView, ss.fontSize, ss.fontFamily))],
    });
  },
  { deep: true },
);

let previewInitialized = false;

watch(activeSettingsTab, (tab) => {
  if (tab !== "editor" && previewView.value) {
    previewView.value.destroy();
    previewView.value = null;
    previewInitialized = false;
    fontThemeComp = null;
    themeComp = null;
    editorViewModule = null;
  }
});

watch(previewRef, async (el) => {
  if (!el || previewInitialized) return;
  previewInitialized = true;
  if (previewView.value) return;

  const [{ EditorView }, { EditorState, Compartment }, { sql, MySQL }, { basicSetup }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror")]);

  editorViewModule = { EditorView } as typeof import("@codemirror/view");
  fontThemeComp = new Compartment();
  themeComp = new Compartment();

  const ss = previewSettings.value;
  const themeExt = await loadEditorTheme(ss.theme, ss.appAppearance, ss.customColors);

  const state = EditorState.create({
    doc: previewSql,
    extensions: [basicSetup, sql({ dialect: MySQL }), themeComp.of(themeExt), fontThemeComp.of(editorFontTheme(EditorView, ss.fontSize, ss.fontFamily))],
  });

  previewView.value = new EditorView({ state, parent: previewRef.value });
});

watch(
  () => props.open,
  (open) => {
    if (!open && previewView.value) {
      previewView.value.destroy();
      previewView.value = null;
      previewInitialized = false;
      fontThemeComp = null;
      themeComp = null;
      editorViewModule = null;
    }
  },
);
</script>

<template>
  <Dialog :open="open" @update:open="(v: boolean) => emit('update:open', v)">
    <DialogContent class="h-[min(660px,calc(100dvh-80px))] !max-w-[min(920px,calc(100vw-32px))] grid-rows-[auto_minmax(0,1fr)] gap-3 p-4 sm:!max-w-[min(920px,calc(100vw-48px))]">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Settings class="h-4 w-4" />
          {{ t("settings.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden sm:flex-row">
        <nav class="settingsCategoryNav flex min-h-0 shrink-0 gap-1 overflow-x-auto border-b pb-3 sm:w-40 sm:flex-col sm:overflow-x-hidden sm:overflow-y-auto sm:border-b-0 sm:border-r sm:pb-0 sm:pr-3">
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
                    trigger-class="h-9 w-full max-w-none justify-between border bg-background px-3 text-sm shadow-xs hover:bg-accent"
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
                    <Label for="editor-word-wrap">{{ t("settings.wordWrap") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.wordWrapDescription") }}</p>
                  </div>
                  <Switch id="editor-word-wrap" v-model="editWordWrap" class="mt-0.5" />
                </div>

                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="editor-auto-alias-tables">{{ t("settings.autoAliasTables") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.autoAliasTablesDescription") }}</p>
                  </div>
                  <Switch id="editor-auto-alias-tables" v-model="editAutoAliasTables" class="mt-0.5" />
                </div>
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
                          class="h-7 w-auto min-w-12 max-w-32 shrink-0 cursor-default rounded-full border border-transparent bg-background px-2.5 text-center font-mono text-[13px] font-semibold text-foreground/75 shadow-inner outline-none selection:bg-transparent placeholder:text-muted-foreground aria-invalid:border-destructive/70 aria-invalid:text-destructive aria-invalid:ring-destructive/20"
                          :class="editingShortcutId === definition.id ? 'max-w-44 cursor-text border-border/80 bg-background text-left text-foreground shadow-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35' : ''"
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

            <section v-else-if="activeSettingsTab === 'appearance'" class="flex flex-col gap-5 py-2">
              <div class="space-y-2">
                <Label>{{ t("settings.languageTitle") }}</Label>
                <Select :model-value="currentLocale()" @update:model-value="onLocaleChange">
                  <SelectTrigger class="min-w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="locale in LOCALE_OPTIONS" :key="locale.value" :value="locale.value">
                      <div class="flex items-center gap-2">
                        <span class="inline-flex h-5 w-6 shrink-0 items-center justify-center text-sm font-medium leading-none">
                          {{ locale.flag }}
                        </span>
                        <span>{{ locale.label }}</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div class="space-y-2">
                <Label>{{ t("settings.theme") }}</Label>
                <div class="flex gap-2">
                  <Button
                    v-for="option in [
                      { value: 'light', label: t('toolbar.themeLight'), icon: Sun },
                      { value: 'dark', label: t('toolbar.themeDark'), icon: Moon },
                      { value: 'system', label: t('toolbar.themeSystem'), icon: SunMoon },
                    ]"
                    :key="option.value"
                    type="button"
                    variant="outline"
                    size="sm"
                    class="h-auto gap-1.5 px-3 py-1.5"
                    :class="themeMode === option.value ? 'border-blue-300 ring-2 ring-blue-300/50' : ''"
                    @click="setThemeMode(option.value as 'light' | 'dark' | 'system')"
                  >
                    <component :is="option.icon" class="h-3.5 w-3.5" />
                    {{ option.label }}
                  </Button>
                </div>
              </div>

              <Separator />

              <div class="space-y-2">
                <Label>{{ t("settings.uiScale") }}</Label>
                <Select
                  :model-value="String(editUiScale)"
                  @update:model-value="
                    (value: any) => {
                      const next = Number(value);
                      if (Number.isFinite(next)) editUiScale = next;
                    }
                  "
                >
                  <SelectTrigger class="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="scale in uiScaleOptions" :key="scale" :value="String(scale)"> {{ Math.round(scale * 100) }}% </SelectItem>
                  </SelectContent>
                </Select>
                <p class="text-xs text-muted-foreground">{{ t("settings.uiScaleDescription") }}</p>
              </div>

              <Separator />

              <div class="space-y-2">
                <Label>{{ t("settings.appLayout") }}</Label>
                <div class="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="editAppLayout === 'separated' ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setAppLayout('separated')">
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
                  <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="editAppLayout === 'classic' ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setAppLayout('classic')">
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

              <!-- <div v-if="!isWeb" class="space-y-2"> -->
              <div class="space-y-2">
                <Label>{{ t("settings.iconTheme") }}</Label>
                <div class="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="editIconTheme === 'default' ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setIconTheme('default')">
                    <div class="flex items-center gap-3 text-left w-full min-w-0">
                      <img src="/logo.png" alt="DBX" class="h-8 w-8 rounded-md" />
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
                  <Button type="button" variant="outline" class="h-auto justify-start border p-3" :class="editIconTheme === 'black' ? 'border-blue-300 ring-2 ring-blue-300/50' : ''" @click="setIconTheme('black')">
                    <div class="flex items-center gap-3 text-left w-full min-w-0">
                      <img src="/logo-black.png" alt="DBX" class="h-8 w-8 dark:invert shrink-0" />
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger as-child>
                            <div class="w-full min-w-0 text-left">
                              <div class="text-sm font-medium">{{ t("settings.iconThemeBlack") }}</div>
                              <div :ref="(el) => setIconThemeDescRef('black', el)" class="text-xs text-muted-foreground truncate">{{ t("settings.iconThemeBlackDescription") }}</div>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent v-if="iconThemeDescTruncated.black.value" class="max-w-[320px] text-xs leading-relaxed">
                            {{ t("settings.iconThemeBlackDescription") }}
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

              <div class="space-y-3">
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
              </div>

              <Separator />

              <div class="space-y-2">
                <div class="flex items-center gap-2">
                  <Label>{{ t("settings.toolbarTitle") }}</Label>
                  <HelpTooltip :label="t('settings.toolbarTitle')" content-class="max-w-64">
                    <p>{{ t("settings.toolbarHiddenHint") }}</p>
                  </HelpTooltip>
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
                  <Label for="auto-select-active-sidebar-node">{{ t("settings.autoSelectActiveSidebarNode") }}</Label>
                  <HelpTooltip :label="t('settings.autoSelectActiveSidebarNode')">
                    {{ t("settings.autoSelectActiveSidebarNodeDescription") }}
                  </HelpTooltip>
                </div>
                <Switch id="auto-select-active-sidebar-node" v-model="editAutoSelectActiveSidebarNode" />
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
              <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                <div class="flex items-center gap-2">
                  <Label for="sidebar-hide-table-comments">{{ t("settings.sidebarHideTableComments") }}</Label>
                  <HelpTooltip :label="t('settings.sidebarHideTableComments')">
                    {{ t("settings.sidebarHideTableCommentsDescription") }}
                  </HelpTooltip>
                </div>
                <Switch id="sidebar-hide-table-comments" v-model="editSidebarHideTableComments" />
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
              <div class="overflow-hidden rounded-md border border-border/70 bg-background">
                <div v-for="definition in SHORTCUT_DEFINITIONS" :key="definition.id" class="group -mt-px grid gap-2 border-t border-border/70 px-3 py-2 transition-colors first:mt-0 first:border-t-0 hover:bg-muted/40 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
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
                        class="h-7 w-auto min-w-12 max-w-32 shrink-0 cursor-default rounded-full border border-transparent bg-muted px-2.5 text-center font-mono text-[13px] font-semibold text-foreground/75 shadow-inner outline-none selection:bg-transparent placeholder:text-muted-foreground aria-invalid:border-destructive/70 aria-invalid:text-destructive aria-invalid:ring-destructive/20"
                        :class="editingShortcutId === definition.id ? 'max-w-44 cursor-text border-border/80 bg-background text-left text-foreground shadow-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/35' : ''"
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
                  {{ t("settings.snippetsAdd") }}
                </Button>
              </div>

              <div class="rounded-md border">
                <table class="w-full text-sm">
                  <thead>
                    <tr class="border-b bg-muted/50">
                      <th class="px-3 py-2 text-left font-medium whitespace-nowrap">
                        {{ t("settings.snippetsLabel") }}
                      </th>
                      <th class="px-3 py-2 text-left font-medium whitespace-nowrap">
                        {{ t("settings.snippetsPrefix") }}
                      </th>
                      <th class="px-3 py-2 text-left font-medium whitespace-nowrap">
                        {{ t("settings.snippetsBody") }}
                      </th>
                      <th class="px-3 py-2 w-20"></th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="snippet in editSnippets" :key="snippet.id" class="border-b last:border-b-0 hover:bg-muted/30">
                      <td class="px-3 py-2">{{ snippet.label }}</td>
                      <td class="px-3 py-2">
                        <Badge variant="outline" class="h-5 rounded-md px-1.5 text-[11px] font-mono text-muted-foreground">
                          {{ snippet.prefix }}
                        </Badge>
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

            <section v-else-if="activeSettingsTab === 'sync'" class="flex flex-col gap-5 py-2">
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

              <div class="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                {{ t("settings.syncSecretNotice") }}
              </div>

              <div class="space-y-3 rounded-md border bg-muted/20 px-3 py-3">
                <div class="flex items-center justify-between gap-4">
                  <div class="space-y-1">
                    <Label for="webdav-sync-secrets">{{ t("settings.syncSecrets") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.syncSecretsDescription") }}</p>
                  </div>
                  <Switch id="webdav-sync-secrets" v-model="webdavSyncSecrets" />
                </div>
                <div v-if="webdavSyncSecrets" class="space-y-2">
                  <Label for="webdav-secrets-passphrase">{{ t("settings.syncSecretsPassphrase") }}</Label>
                  <PasswordInput id="webdav-secrets-passphrase" v-model="webdavSecretsPassphrase" autocomplete="new-password" />
                  <p class="text-xs text-muted-foreground">{{ t("settings.syncSecretsPassphraseDescription") }}</p>
                </div>
              </div>
            </section>

            <!-- AI Settings Tab -->
            <section v-else-if="activeSettingsTab === 'ai'" class="flex flex-col gap-5 py-2">
              <div class="space-y-3">
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
                        <span class="flex items-center gap-2">
                          <AiProviderLogo :provider="provider.provider" :label="provider.label" :icon-slug="provider.iconSlug" />
                          <span>{{ provider.label }}</span>
                        </span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div v-if="aiIsCodexCli && !isWeb" class="rounded-md border px-3 py-2.5 text-xs" :class="aiCodexMcpNeedsInstall ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300'">
                  <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div class="min-w-0 space-y-1">
                      <div class="flex min-w-0 items-center gap-2 font-medium">
                        <Loader2 v-if="mcpStatusLoading" class="h-3.5 w-3.5 shrink-0 animate-spin" />
                        <AlertTriangle v-else-if="aiCodexMcpNeedsInstall || mcpStatus?.error || mcpStatusError" class="h-3.5 w-3.5 shrink-0" />
                        <CheckCircle2 v-else class="h-3.5 w-3.5 shrink-0" />
                        <span>{{ t("ai.codexMcpRequiredTitle") }}</span>
                        <Badge variant="outline" class="h-5 shrink-0 rounded-md border-current/30 px-1.5 text-[11px] font-normal">
                          {{ mcpStatusLabel }}
                        </Badge>
                      </div>
                      <p class="leading-relaxed">
                        {{ t("ai.codexMcpRequiredDescription") }}
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
                      <Button v-if="aiCodexMcpNeedsInstall || mcpStatus?.update_available" type="button" size="sm" class="h-7 px-2 text-xs" :disabled="!aiCodexMcpCanInstall" @click="installMcp">
                        <Loader2 v-if="mcpInstalling" class="mr-1 h-3 w-3 animate-spin" />
                        {{ mcpInstalling ? t("settings.mcpInstalling") : aiCodexMcpActionLabel }}
                      </Button>
                    </div>
                  </div>
                </div>

                <div v-if="!aiIsCodexCli && aiSupportsAuthMethod" class="grid grid-cols-3 items-center gap-3">
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

                <div v-if="!aiIsCodexCli" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ aiCredentialLabel }}</Label>
                  <PasswordInput v-model="aiEditApiKey" autocomplete="off" class="col-span-2" inputClass="h-8 text-xs" :placeholder="aiCredentialPlaceholder" />
                </div>

                <div v-if="!aiIsCodexCli" class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">Endpoint</Label>
                  <div class="col-span-2 space-y-1.5">
                    <Input v-model="aiEditEndpoint" :placeholder="aiEndpointPlaceholder" autocomplete="off" class="h-8 text-xs" />
                    <p v-if="aiEndpointHint" class="text-[11px] text-muted-foreground">{{ aiEndpointHint }}</p>
                  </div>
                </div>

                <div v-if="aiIsCodexCli" class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.codexCliPath") }}</Label>
                  <div class="col-span-2 space-y-1.5">
                    <Input v-model="aiEditCodexCliPath" autocomplete="off" class="h-8 text-xs" placeholder="codex" />
                    <p class="text-[11px] text-muted-foreground">{{ t("ai.codexCliPathHint") }}</p>
                    <p v-if="aiCodexPathError" class="text-[11px] text-destructive">{{ aiCodexPathError }}</p>
                  </div>
                </div>

                <div v-if="aiIsCodexCli" class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.codexCliEnv") }}</Label>
                  <div class="col-span-2 space-y-2">
                    <div class="space-y-1.5">
                      <div v-for="row in aiEditCodexCliEnvRows" :key="row.id" class="grid grid-cols-[minmax(0,0.9fr)_minmax(0,1.3fr)_2rem] gap-2">
                        <Input v-model="row.key" autocomplete="off" class="h-8 font-mono text-xs" :placeholder="t('ai.codexCliEnvKeyPlaceholder')" />
                        <Input v-model="row.value" autocomplete="off" class="h-8 font-mono text-xs" :placeholder="t('ai.codexCliEnvValuePlaceholder')" />
                        <Button type="button" variant="ghost" size="icon" class="h-8 w-8" :title="t('common.remove')" :aria-label="t('common.remove')" @click="removeCodexEnvRow(row.id)">
                          <X class="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                    <Button type="button" variant="outline" size="sm" class="h-7 px-2 text-xs" @click="addCodexEnvRow">
                      <Plus class="mr-1 h-3.5 w-3.5" />
                      {{ t("ai.codexCliEnvAdd") }}
                    </Button>
                    <p v-if="aiCodexEnvError" class="text-[11px] text-destructive">{{ aiCodexEnvError }}</p>
                    <p v-else class="text-[11px] text-muted-foreground">{{ t("ai.codexCliEnvHint") }}</p>
                  </div>
                </div>

                <div class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.model") }}</Label>
                  <div class="col-span-2 space-y-1.5">
                    <div class="flex min-w-0 items-center gap-2">
                      <Input v-model="aiEditModel" autocomplete="off" class="h-8 min-w-0 flex-1 text-xs" />
                      <SearchableSelect
                        :model-value="aiEditModel"
                        :options="aiModelOptionIds"
                        :placeholder="t('ai.browseModels')"
                        :search-placeholder="t('ai.searchModels')"
                        :empty-text="aiModelEmptyText"
                        :loading-text="t('ai.loadingModels')"
                        :loading="aiModelLoading"
                        :display-name="displayAiModelName"
                        trigger-class="h-8 min-w-[104px] max-w-[150px] shrink-0 border border-border bg-background px-2 text-xs shadow-none hover:bg-muted/50"
                        content-class="w-72"
                        item-class="h-auto min-h-8 py-1.5"
                        @update:model-value="aiSelectModel"
                        @update:open="onAiModelListOpen"
                      >
                        <template #trigger-label="{ loading }">
                          <span class="truncate">{{ loading ? t("ai.loadingModels") : t("ai.browseModels") }}</span>
                        </template>
                        <template #option-label="{ option, label }">
                          <span class="flex min-w-0 flex-col leading-tight">
                            <span class="truncate">{{ aiModelOptionPresentation(option, label).primary }}</span>
                            <span v-if="aiModelOptionSecondary(option, label)" class="mt-0.5 truncate text-[11px] text-muted-foreground">{{ aiModelOptionSecondary(option, label) }}</span>
                          </span>
                        </template>
                      </SearchableSelect>
                      <Button type="button" size="icon" variant="outline" class="shrink-0" :disabled="aiModelLoading || !aiModelListSupported" :title="t('ai.refreshModels')" :aria-label="t('ai.refreshModels')" @click="aiRefreshModels">
                        <Loader2 v-if="aiModelLoading" class="h-3.5 w-3.5 animate-spin" />
                        <RefreshCw v-else class="h-3.5 w-3.5" />
                      </Button>
                    </div>
                    <p v-if="aiModelError" class="text-xs text-destructive">{{ aiModelError }}</p>
                    <p v-else-if="!aiModelOptionIds.length" class="text-xs text-muted-foreground">
                      {{ aiModelListSupported ? t("ai.modelListHint") : t("ai.modelListUnsupported") }}
                    </p>
                  </div>
                </div>

                <div v-if="aiIsCodexCli" class="grid grid-cols-3 items-start gap-3">
                  <Label class="pt-2 text-right text-xs">{{ t("ai.reasoningLevel") }}</Label>
                  <div class="col-span-2 space-y-1.5">
                    <Select v-model="aiEditReasoningLevel">
                      <SelectTrigger inputClass="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="option in aiReasoningLevelOptions" :key="option.value" :value="option.value">
                          {{ t(option.labelKey) }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <p class="text-[11px] text-muted-foreground">{{ t("ai.reasoningLevelHint") }}</p>
                  </div>
                </div>

                <div v-if="aiSupportsApiStyle" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">API</Label>
                  <div class="col-span-2 flex gap-2">
                    <Button size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'border-blue-300 border-2 ring-2 ring-blue-300/50': aiEditApiStyle === 'completions' }" @click="aiEditApiStyle = 'completions'">/chat/completions</Button>
                    <Button size="sm" variant="outline" class="h-8 flex-1 text-xs" :class="{ 'border-blue-300 border-2 ring-2 ring-blue-300/50': aiEditApiStyle === 'responses' }" @click="aiEditApiStyle = 'responses'">/responses</Button>
                  </div>
                </div>

                <div v-if="!aiIsCodexCli" class="grid grid-cols-3 items-center gap-3">
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

                <div v-if="!aiIsCodexCli" class="grid grid-cols-3 items-start gap-3">
                  <Label class="text-right text-xs">{{ t("ai.contextWindow") }}</Label>
                  <div class="col-span-2">
                    <Input v-model.number="aiEditContextWindow" type="number" min="1000" step="1000" class="h-8 text-xs" :placeholder="t('ai.contextWindowAuto')" />
                    <p class="mt-1 text-xs text-muted-foreground">{{ t("ai.contextWindowHint") }}</p>
                  </div>
                </div>

                <div v-if="!aiIsCodexCli" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ t("ai.proxy") }}</Label>
                  <label class="col-span-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <input v-model="aiEditProxyEnabled" type="checkbox" class="h-4 w-4 shrink-0 accent-primary" />
                    {{ t("ai.proxyEnable") }}
                  </label>
                </div>

                <div v-if="!aiIsCodexCli" class="grid grid-cols-3 items-center gap-3">
                  <Label class="text-right text-xs">{{ t("ai.proxyUrl") }}</Label>
                  <Input v-model="aiEditProxyUrl" autocomplete="off" class="col-span-2" inputClass="h-8 text-xs" placeholder="socks5://127.0.0.1:7890" :disabled="!aiEditProxyEnabled" />
                </div>
              </div>
            </section>

            <section v-else-if="activeSettingsTab === 'mcp' && !isWeb" class="flex flex-col gap-5 py-2">
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
                  <Badge variant="outline" class="shrink-0 rounded-md" :class="mcpStatusTone === 'ok' ? 'border-green-500/40 text-green-600 dark:text-green-400' : mcpStatusTone === 'warning' ? 'border-amber-500/40 text-amber-600 dark:text-amber-400' : 'text-muted-foreground'">
                    <Loader2 v-if="mcpStatusLoading" class="mr-1 h-3 w-3 animate-spin" />
                    <CheckCircle2 v-else-if="mcpStatusTone === 'ok'" class="mr-1 h-3 w-3" />
                    <AlertTriangle v-else-if="mcpStatusTone === 'warning'" class="mr-1 h-3 w-3" />
                    {{ mcpStatusLabel }}
                  </Badge>
                </div>
              </div>

              <div class="grid gap-3 sm:grid-cols-2">
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

              <div class="space-y-2">
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
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="mcp-readonly-mode">{{ t("settings.mcpReadonlyMode") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.mcpReadonlyModeDescription") }}</p>
                  </div>
                  <Switch id="mcp-readonly-mode" v-model="mcpReadonlyMode" />
                </div>
              </div>

              <div class="space-y-2">
                <div class="flex items-center justify-between gap-4 rounded-md border bg-muted/20 px-3 py-2">
                  <div class="space-y-1">
                    <Label for="mcp-allow-dangerous">{{ t("settings.mcpAllowDangerous") }}</Label>
                    <p class="text-xs text-muted-foreground">{{ t("settings.mcpAllowDangerousDescription") }}</p>
                  </div>
                  <Switch id="mcp-allow-dangerous" v-model="mcpAllowDangerous" :disabled="mcpReadonlyMode" />
                </div>
              </div>

              <div class="space-y-2">
                <Label>{{ t("settings.mcpConfig") }}</Label>
                <Tabs v-model="mcpConfigTab" class="space-y-3">
                  <TabsList>
                    <TabsTrigger value="claude">Claude Code</TabsTrigger>
                    <TabsTrigger value="codex">Codex</TabsTrigger>
                    <TabsTrigger value="opencode">OpenCode</TabsTrigger>
                  </TabsList>

                  <TabsContent value="claude" class="m-0">
                    <div class="relative rounded-md border bg-background p-3">
                      <pre class="overflow-x-auto whitespace-pre text-xs leading-relaxed"><code>{{ mcpClaudeRecommendedConfig }}</code></pre>
                      <Button type="button" variant="outline" size="icon" class="absolute right-2 top-2 h-7 w-7" :title="t('common.copy')" @click="copyMcpText('claude-config', mcpClaudeRecommendedConfig)">
                        <CheckCircle2 v-if="mcpCopied === 'claude-config'" class="h-3.5 w-3.5 text-green-500" />
                        <Copy v-else class="h-3.5 w-3.5" />
                      </Button>
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

            <section v-else-if="activeSettingsTab === 'about'" class="flex flex-col gap-5 py-2">
              <div class="rounded-lg border bg-muted/20 p-4">
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0 space-y-1">
                    <div class="text-lg font-semibold">DBX</div>
                    <p class="text-sm text-muted-foreground">{{ t("settings.aboutDescription") }}</p>
                  </div>
                  <div v-if="displayedAppVersion" class="rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">
                    {{ displayedAppVersion }}
                  </div>
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
            <Button variant="outline" @click="emit('update:open', false)">
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
            <div class="flex flex-1 items-center gap-2">
              <Button size="sm" variant="outline" :disabled="aiTesting || !!aiCodexValidationError || (aiRequiresApiKey && !aiEditApiKey?.trim()) || (!aiIsCodexCli && !aiEditEndpoint?.trim()) || (!aiIsCodexCli && !aiEditModel?.trim())" @click="aiTestConn">
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
            <Button variant="outline" @click="emit('update:open', false)">{{ t("common.close") }}</Button>
            <Button :disabled="!aiHasChanges() || !!aiCodexValidationError" @click="aiApplySettings">{{ t("settings.apply") }}</Button>
          </DialogFooter>

          <DialogFooter v-else-if="activeSettingsTab === 'sync'" class="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-2 rounded-none border-t border-border/60 bg-transparent px-0 pb-0 pt-3 sm:flex-row sm:gap-2 [&>button]:w-auto [&>button]:shrink-0">
            <Button variant="outline" @click="emit('update:open', false)">
              {{ t("common.close") }}
            </Button>
            <p v-if="webdavMessage" class="text-xs self-center truncate max-w-[280px]" :class="webdavError ? 'text-destructive' : 'text-green-500'">
              {{ webdavMessage }}
            </p>
            <div class="flex-1" />
            <Button variant="outline" :disabled="!webdavReady" @click="testWebDav">
              <Loader2 v-if="webdavBusy === 'test'" class="mr-1 h-3 w-3 animate-spin" />
              {{ t("settings.syncTest") }}
            </Button>
            <Button variant="outline" :disabled="!webdavReady" @click="downloadWebDavSnapshot">
              <Loader2 v-if="webdavBusy === 'download'" class="mr-1 h-3 w-3 animate-spin" />
              <Download v-else class="mr-1 h-3 w-3" />
              {{ t("settings.syncDownload") }}
            </Button>
            <Button :disabled="!webdavReady" @click="uploadWebDavSnapshot">
              <Loader2 v-if="webdavBusy === 'upload'" class="mr-1 h-3 w-3 animate-spin" />
              <Upload v-else class="mr-1 h-3 w-3" />
              {{ t("settings.syncUpload") }}
            </Button>
          </DialogFooter>

          <DialogFooter v-else-if="activeSettingsTab === 'mcp' && !isWeb" class="mx-0 mb-0 flex-row flex-wrap items-center justify-end gap-2 rounded-none border-t border-border/60 bg-transparent px-0 pb-0 pt-3 sm:flex-row sm:gap-2 [&>button]:w-auto [&>button]:shrink-0">
            <Button variant="outline" @click="emit('update:open', false)">
              {{ t("common.close") }}
            </Button>
            <div class="flex-1" />
            <Button variant="outline" :disabled="mcpStatusLoading" @click="refreshMcpStatus">
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
            <Button variant="outline" @click="emit('update:open', false)">
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
            <Button variant="outline" @click="emit('update:open', false)">
              {{ t("common.close") }}
            </Button>
          </DialogFooter>
        </div>
      </div>
    </DialogContent>

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
  </Dialog>
</template>

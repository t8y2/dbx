import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/lib/backend/api";
import { normalizeColumnFormatter, normalizeCustomColumnFormatter, type ColumnFormatterConfig, type CustomColumnFormatterConfig } from "@/lib/dataGrid/columnFormatter";
import { normalizeShortcutSettings, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";
import { normalizeResultPageSize } from "@/lib/dataGrid/paginationPageSize";
import { normalizeSidebarHiddenTablePrefixes } from "@/lib/sidebar/sidebarTableNameDisplay";
import { DEFAULT_SQL_FORMATTER_SETTINGS, normalizeSqlFormatterSettings, type SqlFormatterSettings } from "@/lib/sql/sqlFormatterConfig";
import { normalizeSqlVariableSyntaxOverrides, type SqlVariableSyntaxOverrides } from "@/lib/sql/sqlVariableSyntax";
import type { SidebarActivation } from "@/lib/sidebar/treeNodeClick";
import type { SqlSnippet } from "@/types/database";
import { DEFAULT_SQL_SNIPPETS } from "@/lib/sql/sqlCompletion";
import { setDebugLoggingEnabled } from "@/lib/backend/debugLog";
import { DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS, normalizeTableColumnTemplateFields } from "@/lib/table/tableColumnTemplates";
import { DEFAULT_UI_FONT_FAMILY } from "@/lib/app/appFonts";
import { safeLocalStorageGet, safeLocalStorageRemove } from "@/lib/backend/safeStorage";

export type AiProvider = "claude" | "openai" | "gemini" | "deepseek" | "qwen" | "ollama" | "openai-compatible" | "codex-cli" | "custom";
export type AiApiStyle = "completions" | "responses" | "anthropic-messages";
export type AiAuthMethod = "api-key" | "bearer";
export type AiReasoningLevel = "default" | "minimal" | "low" | "medium" | "high";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  authMethod: AiAuthMethod;
  endpoint: string;
  model: string;
  apiStyle: AiApiStyle;
  proxyEnabled?: boolean;
  proxyUrl?: string;
  enableThinking?: boolean;
  reasoningLevel?: AiReasoningLevel;
  contextWindow?: number;
  codexCliPath?: string | null;
  codexCliEnv?: Record<string, string>;
}

export interface AiTestConnectionResult {
  success: boolean;
  message: string;
  latencyMs?: number;
  modelUsed: string;
  errorCategory?: string;
}

export interface DesktopSettings {
  show_tray_icon: boolean;
  icon_theme: DesktopIconTheme;
  quit_on_close: boolean;
  close_action_prompted: boolean;
  debug_logging_enabled: boolean;
  duckdb_worker_process_isolation: boolean;
  duckdb_worker_max_processes: number;
  saved_sql_sync_dir?: string | null;
  driver_store_dir?: string | null;
  plugin_store_dir?: string | null;
  agent_store_dir?: string | null;
  sidebar_table_page_size?: number | null;
}

export type DesktopIconTheme = "default" | "black";

export type InterfaceLayout = "separated" | "classic";

export type UpdateDownloadSource = "official" | "cnb" | "atomgit";
export type SqlSemanticDiagnosticsMode = "auto" | "enabled" | "disabled";
export type OpenTabsRestoreMode = "all" | "pinned" | "none";

export const DEFAULT_SIDEBAR_TABLE_PAGE_SIZE = 1000;
export const DUCKDB_WORKER_MAX_PROCESSES_MIN = 1;
export const DUCKDB_WORKER_MAX_PROCESSES_MAX = 16;
export const DUCKDB_WORKER_MAX_PROCESSES_DEFAULT = 4;
const SQL_SEMANTIC_DIAGNOSTICS_AUTO_ENABLED = false;

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  show_tray_icon: true,
  icon_theme: "default",
  quit_on_close: false,
  close_action_prompted: false,
  debug_logging_enabled: false,
  duckdb_worker_process_isolation: false,
  duckdb_worker_max_processes: DUCKDB_WORKER_MAX_PROCESSES_DEFAULT,
  saved_sql_sync_dir: null,
  driver_store_dir: null,
  plugin_store_dir: null,
  agent_store_dir: null,
  sidebar_table_page_size: DEFAULT_SIDEBAR_TABLE_PAGE_SIZE,
};

export function normalizeDesktopSettings(settings: Partial<DesktopSettings> | null | undefined): DesktopSettings {
  const iconTheme = settings?.icon_theme === "black" ? "black" : DEFAULT_DESKTOP_SETTINGS.icon_theme;
  const sidebarTablePageSize = typeof settings?.sidebar_table_page_size === "number" && settings.sidebar_table_page_size > 0 ? settings.sidebar_table_page_size : DEFAULT_DESKTOP_SETTINGS.sidebar_table_page_size;
  return {
    show_tray_icon: settings?.show_tray_icon ?? DEFAULT_DESKTOP_SETTINGS.show_tray_icon,
    icon_theme: iconTheme,
    quit_on_close: settings?.quit_on_close ?? DEFAULT_DESKTOP_SETTINGS.quit_on_close,
    close_action_prompted: settings?.close_action_prompted ?? DEFAULT_DESKTOP_SETTINGS.close_action_prompted,
    debug_logging_enabled: settings?.debug_logging_enabled ?? DEFAULT_DESKTOP_SETTINGS.debug_logging_enabled,
    duckdb_worker_process_isolation: settings?.duckdb_worker_process_isolation ?? DEFAULT_DESKTOP_SETTINGS.duckdb_worker_process_isolation,
    duckdb_worker_max_processes: normalizeDuckDbWorkerMaxProcesses(settings?.duckdb_worker_max_processes),
    saved_sql_sync_dir: settings?.saved_sql_sync_dir?.trim() || DEFAULT_DESKTOP_SETTINGS.saved_sql_sync_dir,
    driver_store_dir: settings?.driver_store_dir?.trim() || DEFAULT_DESKTOP_SETTINGS.driver_store_dir,
    plugin_store_dir: settings?.plugin_store_dir?.trim() || DEFAULT_DESKTOP_SETTINGS.plugin_store_dir,
    agent_store_dir: settings?.agent_store_dir?.trim() || DEFAULT_DESKTOP_SETTINGS.agent_store_dir,
    sidebar_table_page_size: sidebarTablePageSize,
  };
}

export function normalizeDuckDbWorkerMaxProcesses(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DUCKDB_WORKER_MAX_PROCESSES_DEFAULT;
  return Math.min(DUCKDB_WORKER_MAX_PROCESSES_MAX, Math.max(DUCKDB_WORKER_MAX_PROCESSES_MIN, Math.round(value)));
}

export interface AiProviderPreset extends Omit<AiConfig, "apiKey"> {
  label: string;
  iconSlug?: string;
  requiresApiKey: boolean;
}

export const AI_PROVIDER_PRESETS: Record<AiProvider, AiProviderPreset> = {
  claude: {
    label: "Claude",
    iconSlug: "anthropic",
    provider: "claude",
    endpoint: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-20250514",
    apiStyle: "completions",
    authMethod: "api-key",
    requiresApiKey: true,
  },
  openai: {
    label: "OpenAI",
    iconSlug: "openai",
    provider: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiStyle: "completions",
    authMethod: "bearer",
    requiresApiKey: true,
  },
  gemini: {
    label: "Gemini",
    iconSlug: "googlegemini",
    provider: "gemini",
    endpoint: "https://generativelanguage.googleapis.com",
    model: "gemini-1.5-pro",
    apiStyle: "completions",
    authMethod: "api-key",
    requiresApiKey: true,
  },
  deepseek: {
    label: "DeepSeek",
    iconSlug: "deepseek",
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
    apiStyle: "completions",
    authMethod: "bearer",
    requiresApiKey: true,
  },
  qwen: {
    label: "Qwen",
    iconSlug: "alibabacloud",
    provider: "qwen",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    apiStyle: "completions",
    authMethod: "bearer",
    requiresApiKey: true,
  },
  ollama: {
    label: "Ollama",
    iconSlug: "ollama",
    provider: "ollama",
    endpoint: "http://localhost:11434/v1",
    model: "llama3.1",
    apiStyle: "completions",
    authMethod: "bearer",
    requiresApiKey: false,
  },
  "openai-compatible": {
    label: "OpenAI Compatible",
    iconSlug: "openai",
    provider: "openai-compatible",
    endpoint: "",
    model: "",
    apiStyle: "completions",
    authMethod: "bearer",
    requiresApiKey: true,
  },
  "codex-cli": {
    label: "Codex CLI",
    iconSlug: "codex",
    provider: "codex-cli",
    endpoint: "",
    model: "default",
    apiStyle: "completions",
    authMethod: "bearer",
    requiresApiKey: false,
  },
  custom: {
    label: "Custom",
    provider: "custom",
    endpoint: "",
    model: "",
    apiStyle: "completions",
    authMethod: "bearer",
    requiresApiKey: true,
  },
};

const defaultConfigs: Record<AiProvider, Omit<AiConfig, "apiKey">> = Object.fromEntries(
  Object.entries(AI_PROVIDER_PRESETS).map(([provider, preset]) => {
    const { label: _label, iconSlug: _iconSlug, requiresApiKey: _requiresApiKey, ...config } = preset;
    return [provider, config];
  }),
) as Record<AiProvider, Omit<AiConfig, "apiKey">>;

const AI_REASONING_LEVELS: AiReasoningLevel[] = ["default", "minimal", "low", "medium", "high"];
const AI_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizeAiReasoningLevel(value: unknown): AiReasoningLevel {
  return typeof value === "string" && AI_REASONING_LEVELS.includes(value as AiReasoningLevel) ? (value as AiReasoningLevel) : "default";
}

export function normalizeAiEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    if (!key || !AI_ENV_KEY_RE.test(key)) continue;
    result[key] = rawValue == null ? "" : String(rawValue);
  }
  return result;
}

export function normalizeAiConfig(config: Partial<AiConfig> | null | undefined): AiConfig {
  const provider = config?.provider && config.provider in AI_PROVIDER_PRESETS ? config.provider : inferAiProviderFromConfig(config);
  return {
    ...defaultConfigs[provider],
    apiKey: config?.apiKey ?? "",
    ...config,
    provider,
    apiStyle: config?.apiStyle ?? defaultConfigs[provider].apiStyle,
    authMethod: config?.authMethod ?? defaultConfigs[provider].authMethod,
    proxyEnabled: !!config?.proxyEnabled,
    proxyUrl: config?.proxyUrl ?? "",
    enableThinking: config?.enableThinking ?? true,
    reasoningLevel: normalizeAiReasoningLevel(config?.reasoningLevel),
    contextWindow: config?.contextWindow ?? undefined,
    codexCliPath: config?.codexCliPath?.trim() || undefined,
    codexCliEnv: normalizeAiEnv(config?.codexCliEnv),
  };
}

function inferAiProviderFromConfig(config: Partial<AiConfig> | null | undefined): AiProvider {
  const endpoint = config?.endpoint?.toLowerCase() ?? "";
  const model = config?.model?.toLowerCase() ?? "";
  if (endpoint.includes("deepseek") || model.includes("deepseek")) return "deepseek";
  if (endpoint.includes("dashscope") || endpoint.includes("aliyuncs") || model.includes("qwen")) return "qwen";
  if (endpoint.includes("generativelanguage.googleapis.com") || model.includes("gemini")) return "gemini";
  if (endpoint.includes("localhost:11434") || endpoint.includes("127.0.0.1:11434")) return "ollama";
  if (endpoint.includes("openai.com") || model.startsWith("gpt-")) return "openai";
  return "claude";
}

export type EditorTheme =
  | "app"
  | "one-dark"
  | "vscode-dark"
  | "vscode-light"
  | "nord"
  | "okaidia"
  | "material"
  | "duotone-light"
  | "duotone-dark"
  | "xcode"
  | "xcode-dark"
  | "idea-light"
  | "idea-dark"
  | "jetbrains-light"
  | "jetbrains-dark"
  | "cursor-light"
  | "cursor-dark"
  | "claude-light"
  | "claude-dark"
  | "custom";

const STRUCTURE_EDITOR_DENSITIES = ["compact", "standard", "comfortable"] as const;
export type StructureEditorDensity = (typeof STRUCTURE_EDITOR_DENSITIES)[number];
const COLUMN_WIDTH_DENSITIES = ["compact", "standard", "comfortable"] as const;
export type ColumnWidthDensity = (typeof COLUMN_WIDTH_DENSITIES)[number];
const CELL_DETAIL_PANEL_LAYOUTS = ["bottom", "right"] as const;
export type CellDetailPanelLayout = (typeof CELL_DETAIL_PANEL_LAYOUTS)[number];
const DATA_GRID_RENDER_MODES = ["dom", "canvas"] as const;
export type DataGridRenderMode = (typeof DATA_GRID_RENDER_MODES)[number];
const DATA_GRID_SEARCH_MODES = ["filter", "highlight"] as const;
export type DataGridSearchMode = (typeof DATA_GRID_SEARCH_MODES)[number];
export const TABLE_FONT_SIZE_MIN = 8;
export const TABLE_FONT_SIZE_MAX = 16;
export const TABLE_FONT_SIZE_DEFAULT = 13;
const DISCONNECT_TAB_HANDLING_MODES = ["close-tabs", "keep-tabs-clear-results", "keep-tabs-keep-results"] as const;
export type DisconnectTabHandlingMode = (typeof DISCONNECT_TAB_HANDLING_MODES)[number];

export interface CustomThemeColors {
  keyword: string;
  field: string;
  function: string;
  string: string;
  number: string;
  comment: string;
  table: string;
  operator: string;
  type: string;
  builtin: string;
  background?: string;
  foreground?: string;
}

export const DEFAULT_CUSTOM_THEME_COLORS: CustomThemeColors = {
  keyword: "#cba6f7",
  field: "#f9e2af",
  function: "#89dceb",
  string: "#a6e3a1",
  number: "#fab387",
  comment: "#6c7086",
  table: "#a6e3a1",
  operator: "#89b4fa",
  type: "#89b4fa",
  builtin: "#f38ba8",
};

export interface CustomThemeDdlColors {
  addedRowBg: string;
  addedRowBgAlpha: number;
  removedRowBg: string;
  removedRowBgAlpha: number;
  modifiedRowBg: string;
  modifiedRowBgAlpha: number;
  modifiedCharBg: string;
  modifiedCharBgAlpha: number;
}

export const DEFAULT_CUSTOM_THEME_DDL_COLORS: CustomThemeDdlColors = {
  addedRowBg: "#22c55e",
  addedRowBgAlpha: 10,
  removedRowBg: "#ef4444",
  removedRowBgAlpha: 10,
  modifiedRowBg: "#eab308",
  modifiedRowBgAlpha: 10,
  modifiedCharBg: "#f59e0b",
  modifiedCharBgAlpha: 50,
};

export interface CustomTheme {
  id: string;
  name: string;
  colors: CustomThemeColors;
  ddlColors: CustomThemeDdlColors;
}

export const DEFAULT_CUSTOM_THEMES: CustomTheme[] = [{ id: "default", name: "Custom", colors: { ...DEFAULT_CUSTOM_THEME_COLORS }, ddlColors: { ...DEFAULT_CUSTOM_THEME_DDL_COLORS } }];

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  uiFontFamily: string;
  uiScale: number;
  theme: EditorTheme;
  customThemeColors: CustomThemeColors;
  customThemes: CustomTheme[];
  activeCustomThemeId: string;
  executeMode: "all" | "current";
  showExecutionTargetPicker: boolean;
  showStatementRunButtons: boolean;
  showCurrentStatementFrame: boolean;
  showInsertValueHints: boolean;
  autoAliasTables: boolean;
  wordWrap: boolean;
  vimModeEnabled: boolean;
  autoCloseBrackets: boolean;
  sqlSemanticDiagnosticsMode: SqlSemanticDiagnosticsMode;
  sqlSemanticDiagnosticsEnabled: boolean;
  confirmDangerousSqlExecution: boolean;
  confirmUnsavedSqlClose: boolean;
  compactTabTitle: boolean;
  appLayout: "separated" | "classic";
  pageSize: number;
  infiniteScroll: boolean;
  infiniteScrollMaxRows: number;
  autoCalculateTotalRows: boolean;
  mongoViewMode: "document" | "table";
  showColumnCommentsInHeader: boolean;
  showColumnTypesInHeader: boolean;
  compactColumnHeaderActions: boolean;
  columnWidthDensity: ColumnWidthDensity;
  dataGridQuickEntry: boolean;
  dataGridRenderMode: DataGridRenderMode;
  dataGridSearchMode: DataGridSearchMode;
  tableFontSize: number;
  structureEditorDensity: StructureEditorDensity;
  tableInfoDrawerWidth: number;
  cellDetailDrawerWidth: number;
  cellDetailPanelLayout: CellDetailPanelLayout;
  cellDetailJsonFormatted: boolean;
  shortcuts: ShortcutSettings;
  sqlFormatter: SqlFormatterSettings;
  sidebarActivation: SidebarActivation;
  sidebarObjectDisplay: "grouped" | "simple";
  sidebarTableSearchEnabled: boolean;
  autoSelectActiveSidebarNode: boolean;
  openTabsRestoreMode: OpenTabsRestoreMode;
  disconnectTabHandlingMode: DisconnectTabHandlingMode;
  reuseDataTab: boolean;
  prefillNewQueryWithSelect: boolean;
  updateNotificationsEnabled: boolean;
  sidebarHiddenTablePrefixes: string[];
  sidebarHideTableComments: boolean;
  sidebarAllowHorizontalScroll: boolean;
  columnFormatters: Record<string, ColumnFormatterConfig>;
  customColumnFormatters: Record<string, CustomColumnFormatterConfig>;
  snippets: SqlSnippet[];
  tableColumnTemplateFields: string[];
  exportBatchSize: number;
  exportRowLimitEnabled: boolean;
  exportRowLimit: number;
  queryExportKeysetOptimizationEnabled: boolean;
  updateDownloadSource: UpdateDownloadSource;
  toolbarItems: ToolbarItems;
  objectBrowserShowCheckbox: boolean;
  objectBrowserViewMode: "list" | "grid";
  sqlVariableSyntaxOverrides: SqlVariableSyntaxOverrides;
}

export interface ToolbarItems {
  dataTransfer: boolean;
  driverManager: boolean;
  sqlFile: boolean;
  schemaDiff: boolean;
  dataCompare: boolean;
  checkUpdates: boolean;
  sqlLibrary: boolean;
  sqlFileTree: boolean;
  history: boolean;
  ai: boolean;
  theme: boolean;
  github: boolean;
}

export const DEFAULT_TOOLBAR_ITEMS: ToolbarItems = {
  dataTransfer: true,
  driverManager: true,
  sqlFile: true,
  schemaDiff: true,
  dataCompare: true,
  checkUpdates: true,
  sqlLibrary: true,
  sqlFileTree: true,
  history: true,
  ai: true,
  theme: true,
  github: true,
};

export const EDITOR_THEMES: { value: EditorTheme; label: string; dark: boolean }[] = [
  { value: "app", label: "Follow app theme", dark: false },
  { value: "one-dark", label: "One Dark", dark: true },
  { value: "vscode-dark", label: "VS Dark+", dark: true },
  { value: "vscode-light", label: "VS Light+", dark: false },
  { value: "nord", label: "Nord", dark: true },
  { value: "okaidia", label: "Okaidia", dark: true },
  { value: "material", label: "Material", dark: true },
  { value: "duotone-light", label: "Duotone Light", dark: false },
  { value: "duotone-dark", label: "Duotone Dark", dark: true },
  { value: "xcode", label: "Xcode", dark: false },
  { value: "xcode-dark", label: "Xcode Dark", dark: true },
  { value: "idea-light", label: "IDEA Light", dark: false },
  { value: "idea-dark", label: "IDEA Darcula", dark: true },
  { value: "jetbrains-light", label: "JetBrains Light", dark: false },
  { value: "jetbrains-dark", label: "JetBrains Dark", dark: true },
  { value: "cursor-light", label: "Cursor Light", dark: false },
  { value: "cursor-dark", label: "Cursor Dark", dark: true },
  { value: "claude-light", label: "Claude Code Light", dark: false },
  { value: "claude-dark", label: "Claude Code Dark", dark: true },
  { value: "custom", label: "Custom", dark: true },
];

const EDITOR_THEME_VALUES = new Set<EditorTheme>(EDITOR_THEMES.map((theme) => theme.value));

export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: "'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', monospace", label: "Fira Code" },
  { value: "'JetBrains Mono', 'Fira Code', monospace", label: "JetBrains Mono" },
  { value: "'Cascadia Code', 'Cascadia Mono', monospace", label: "Cascadia Code" },
  { value: "'Source Code Pro', monospace", label: "Source Code Pro" },
  { value: "'SF Mono', 'Menlo', monospace", label: "SF Mono / Menlo" },
  { value: "'Consolas', 'Courier New', monospace", label: "Consolas" },
  { value: "monospace", label: "System Monospace" },
];

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontFamily: "'Fira Code', 'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', monospace",
  fontSize: 13,
  uiFontFamily: DEFAULT_UI_FONT_FAMILY,
  uiScale: 1,
  theme: "app",
  customThemeColors: { ...DEFAULT_CUSTOM_THEME_COLORS },
  customThemes: [...DEFAULT_CUSTOM_THEMES],
  activeCustomThemeId: "default",
  executeMode: "all",
  showExecutionTargetPicker: false,
  showStatementRunButtons: true,
  showCurrentStatementFrame: true,
  showInsertValueHints: true,
  autoAliasTables: true,
  wordWrap: false,
  vimModeEnabled: false,
  autoCloseBrackets: true,
  sqlSemanticDiagnosticsMode: "auto",
  sqlSemanticDiagnosticsEnabled: SQL_SEMANTIC_DIAGNOSTICS_AUTO_ENABLED,
  confirmDangerousSqlExecution: true,
  confirmUnsavedSqlClose: true,
  compactTabTitle: false,
  appLayout: "classic",
  pageSize: 100,
  infiniteScroll: false,
  infiniteScrollMaxRows: 5000,
  autoCalculateTotalRows: false,
  mongoViewMode: "document",
  showColumnCommentsInHeader: true,
  showColumnTypesInHeader: true,
  compactColumnHeaderActions: true,
  columnWidthDensity: "standard",
  dataGridQuickEntry: false,
  dataGridRenderMode: "canvas",
  dataGridSearchMode: "filter",
  tableFontSize: TABLE_FONT_SIZE_DEFAULT,
  structureEditorDensity: "compact",
  tableInfoDrawerWidth: 320,
  cellDetailDrawerWidth: 380,
  cellDetailPanelLayout: "bottom",
  cellDetailJsonFormatted: false,
  shortcuts: normalizeShortcutSettings(),
  sqlFormatter: normalizeSqlFormatterSettings(DEFAULT_SQL_FORMATTER_SETTINGS),
  sidebarActivation: "single",
  sidebarObjectDisplay: "grouped",
  sidebarTableSearchEnabled: false,
  autoSelectActiveSidebarNode: false,
  openTabsRestoreMode: "all",
  disconnectTabHandlingMode: "close-tabs",
  reuseDataTab: false,
  prefillNewQueryWithSelect: true,
  updateNotificationsEnabled: true,
  sidebarHiddenTablePrefixes: [],
  sidebarHideTableComments: false,
  sidebarAllowHorizontalScroll: false,
  columnFormatters: {},
  customColumnFormatters: {},
  snippets: DEFAULT_SQL_SNIPPETS,
  tableColumnTemplateFields: [...DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS],
  exportBatchSize: 2000,
  exportRowLimitEnabled: false,
  exportRowLimit: 100000,
  queryExportKeysetOptimizationEnabled: true,
  updateDownloadSource: "official",
  toolbarItems: { ...DEFAULT_TOOLBAR_ITEMS },
  objectBrowserShowCheckbox: false,
  objectBrowserViewMode: "list",
  sqlVariableSyntaxOverrides: {},
};

export const STORAGE_KEY = "dbx-editor-settings";
const OLD_FONT_SIZE_KEY = "dbx-query-editor-font-size";
const EXPORT_BATCH_SIZE_DEFAULT_MIGRATION_KEY = "dbx-export-batch-size-default-migrated-v1";
const LEGACY_DEFAULT_EXPORT_BATCH_SIZE = 10000;
const MIN_UI_SCALE = 0.75;
const MAX_UI_SCALE = 2;

function normalizeUiScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_EDITOR_SETTINGS.uiScale;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Math.round(value * 100) / 100));
}

function normalizeFontFamily(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeDrawerWidth(value: unknown, min: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(900, Math.max(min, Math.round(value)));
}

function normalizeStructureEditorDensity(value: unknown): StructureEditorDensity {
  return STRUCTURE_EDITOR_DENSITIES.includes(value as StructureEditorDensity) ? (value as StructureEditorDensity) : DEFAULT_EDITOR_SETTINGS.structureEditorDensity;
}
function normalizeColumnWidthDensity(value: unknown): ColumnWidthDensity {
  return COLUMN_WIDTH_DENSITIES.includes(value as ColumnWidthDensity) ? (value as ColumnWidthDensity) : DEFAULT_EDITOR_SETTINGS.columnWidthDensity;
}

function normalizeCellDetailPanelLayout(value: unknown): CellDetailPanelLayout {
  return CELL_DETAIL_PANEL_LAYOUTS.includes(value as CellDetailPanelLayout) ? (value as CellDetailPanelLayout) : DEFAULT_EDITOR_SETTINGS.cellDetailPanelLayout;
}

function normalizeDataGridRenderMode(value: unknown): DataGridRenderMode {
  return DATA_GRID_RENDER_MODES.includes(value as DataGridRenderMode) ? (value as DataGridRenderMode) : DEFAULT_EDITOR_SETTINGS.dataGridRenderMode;
}

function normalizeDataGridSearchMode(value: unknown): DataGridSearchMode {
  return DATA_GRID_SEARCH_MODES.includes(value as DataGridSearchMode) ? (value as DataGridSearchMode) : DEFAULT_EDITOR_SETTINGS.dataGridSearchMode;
}

function normalizeTableFontSize(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return TABLE_FONT_SIZE_DEFAULT;
  return Math.min(TABLE_FONT_SIZE_MAX, Math.max(TABLE_FONT_SIZE_MIN, Math.round(value)));
}

function normalizeUpdateDownloadSource(value: unknown): UpdateDownloadSource {
  if (value === "atomgit") return "atomgit";
  return value === "cnb" ? "cnb" : DEFAULT_EDITOR_SETTINGS.updateDownloadSource;
}

function normalizeSqlSemanticDiagnosticsMode(value: unknown, legacyEnabled?: unknown): SqlSemanticDiagnosticsMode {
  if (value === "auto" || value === "enabled" || value === "disabled") return value;
  if (typeof legacyEnabled === "boolean") return legacyEnabled ? "enabled" : "disabled";
  return DEFAULT_EDITOR_SETTINGS.sqlSemanticDiagnosticsMode;
}

function sqlSemanticDiagnosticsEnabledForMode(mode: SqlSemanticDiagnosticsMode): boolean {
  if (mode === "enabled") return true;
  if (mode === "disabled") return false;
  return SQL_SEMANTIC_DIAGNOSTICS_AUTO_ENABLED;
}

function normalizeDisconnectTabHandlingMode(value: unknown, legacyCloseTabsOnDisconnect?: unknown): DisconnectTabHandlingMode {
  if (DISCONNECT_TAB_HANDLING_MODES.includes(value as DisconnectTabHandlingMode)) {
    return value as DisconnectTabHandlingMode;
  }
  if (value === "clear-state") return "keep-tabs-clear-results";
  if (value === "keep-tabs") return "keep-tabs-keep-results";
  if (typeof legacyCloseTabsOnDisconnect === "boolean") {
    return legacyCloseTabsOnDisconnect ? "close-tabs" : "keep-tabs-clear-results";
  }
  return DEFAULT_EDITOR_SETTINGS.disconnectTabHandlingMode;
}

function normalizeOpenTabsRestoreMode(value: unknown, legacyRestoreOpenTabsOnLaunch?: unknown): OpenTabsRestoreMode {
  if (value === "all" || value === "pinned" || value === "none") return value;
  if (typeof legacyRestoreOpenTabsOnLaunch === "boolean") return legacyRestoreOpenTabsOnLaunch ? "all" : "none";
  return DEFAULT_EDITOR_SETTINGS.openTabsRestoreMode;
}

function normalizeColumnFormatters(value: unknown): Record<string, ColumnFormatterConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const formatters: Record<string, ColumnFormatterConfig> = {};
  for (const [key, formatter] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeColumnFormatter(formatter);
    if (normalized) formatters[key] = normalized;
  }
  return formatters;
}

function normalizeCustomColumnFormatters(value: unknown): Record<string, CustomColumnFormatterConfig> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const formatters: Record<string, CustomColumnFormatterConfig> = {};
  for (const formatter of Object.values(value as Record<string, unknown>)) {
    const normalized = normalizeCustomColumnFormatter(formatter);
    if (normalized) formatters[normalized.id] = normalized;
  }
  return formatters;
}

function normalizeSqlSnippets(value: unknown, existing?: SqlSnippet[]): SqlSnippet[] {
  if (!Array.isArray(value)) return existing ?? DEFAULT_SQL_SNIPPETS;
  if (value.length === 0) return [];
  const valid: SqlSnippet[] = [];
  const seenPrefixes = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || typeof item.label !== "string" || !item.label || typeof item.prefix !== "string" || !item.prefix || typeof item.body !== "string") {
      continue;
    }
    if (seenPrefixes.has(item.prefix)) continue;
    seenPrefixes.add(item.prefix);
    // Older settings do not have this field; only an explicit false disables a snippet.
    valid.push({ id: item.id, label: item.label, prefix: item.prefix, body: item.body, enabled: item.enabled !== false });
  }
  if (valid.length === 0) return existing ?? DEFAULT_SQL_SNIPPETS;
  return valid;
}

function normalizeToolbarItems(items: Partial<ToolbarItems> | undefined): ToolbarItems {
  const defaults = DEFAULT_TOOLBAR_ITEMS;
  if (!items || typeof items !== "object") return { ...defaults };
  return {
    dataTransfer: items.dataTransfer ?? defaults.dataTransfer,
    driverManager: items.driverManager ?? defaults.driverManager,
    sqlFile: items.sqlFile ?? defaults.sqlFile,
    schemaDiff: items.schemaDiff ?? defaults.schemaDiff,
    dataCompare: items.dataCompare ?? defaults.dataCompare,
    checkUpdates: items.checkUpdates ?? defaults.checkUpdates,
    sqlLibrary: items.sqlLibrary ?? defaults.sqlLibrary,
    sqlFileTree: items.sqlFileTree ?? defaults.sqlFileTree,
    history: items.history ?? defaults.history,
    ai: items.ai ?? defaults.ai,
    theme: items.theme ?? defaults.theme,
    github: items.github ?? defaults.github,
  };
}

export function normalizeEditorSettings(settings: Partial<EditorSettings>, existing?: EditorSettings): EditorSettings {
  const sqlSemanticDiagnosticsMode = normalizeSqlSemanticDiagnosticsMode(settings.sqlSemanticDiagnosticsMode, settings.sqlSemanticDiagnosticsEnabled);
  return {
    fontFamily: normalizeFontFamily(settings.fontFamily, DEFAULT_EDITOR_SETTINGS.fontFamily),
    fontSize: settings.fontSize ?? DEFAULT_EDITOR_SETTINGS.fontSize,
    uiFontFamily: normalizeFontFamily(settings.uiFontFamily, DEFAULT_EDITOR_SETTINGS.uiFontFamily),
    uiScale: normalizeUiScale(settings.uiScale),
    theme: settings.theme && EDITOR_THEME_VALUES.has(settings.theme) ? settings.theme : DEFAULT_EDITOR_SETTINGS.theme,
    customThemeColors: {
      ...DEFAULT_CUSTOM_THEME_COLORS,
      ...settings.customThemeColors,
    },
    customThemes: (() => {
      if (Array.isArray(settings.customThemes) && settings.customThemes.length > 0) {
        return settings.customThemes.map((theme) => {
          const renamed = theme.name === "默认" ? { ...theme, name: "Custom" } : { ...theme };
          return {
            ...renamed,
            colors: { ...DEFAULT_CUSTOM_THEME_COLORS, ...renamed.colors },
            ddlColors: { ...DEFAULT_CUSTOM_THEME_DDL_COLORS, ...(renamed as any).ddlColors },
          };
        });
      }
      return settings.customThemeColors
        ? [
            {
              id: "migrated",
              name: "Migrated",
              colors: { ...DEFAULT_CUSTOM_THEME_COLORS, ...settings.customThemeColors },
              ddlColors: { ...DEFAULT_CUSTOM_THEME_DDL_COLORS },
            },
          ]
        : [];
    })(),
    activeCustomThemeId: settings.activeCustomThemeId ?? "default",
    executeMode: settings.executeMode ?? DEFAULT_EDITOR_SETTINGS.executeMode,
    showExecutionTargetPicker: settings.showExecutionTargetPicker ?? DEFAULT_EDITOR_SETTINGS.showExecutionTargetPicker,
    showStatementRunButtons: typeof settings.showStatementRunButtons === "boolean" ? settings.showStatementRunButtons : DEFAULT_EDITOR_SETTINGS.showStatementRunButtons,
    showCurrentStatementFrame: typeof settings.showCurrentStatementFrame === "boolean" ? settings.showCurrentStatementFrame : DEFAULT_EDITOR_SETTINGS.showCurrentStatementFrame,
    showInsertValueHints: typeof settings.showInsertValueHints === "boolean" ? settings.showInsertValueHints : DEFAULT_EDITOR_SETTINGS.showInsertValueHints,
    autoAliasTables: settings.autoAliasTables ?? DEFAULT_EDITOR_SETTINGS.autoAliasTables,
    wordWrap: settings.wordWrap ?? DEFAULT_EDITOR_SETTINGS.wordWrap,
    vimModeEnabled: typeof settings.vimModeEnabled === "boolean" ? settings.vimModeEnabled : DEFAULT_EDITOR_SETTINGS.vimModeEnabled,
    autoCloseBrackets: typeof settings.autoCloseBrackets === "boolean" ? settings.autoCloseBrackets : DEFAULT_EDITOR_SETTINGS.autoCloseBrackets,
    sqlSemanticDiagnosticsMode,
    sqlSemanticDiagnosticsEnabled: sqlSemanticDiagnosticsEnabledForMode(sqlSemanticDiagnosticsMode),
    confirmDangerousSqlExecution: settings.confirmDangerousSqlExecution ?? DEFAULT_EDITOR_SETTINGS.confirmDangerousSqlExecution,
    confirmUnsavedSqlClose: settings.confirmUnsavedSqlClose ?? DEFAULT_EDITOR_SETTINGS.confirmUnsavedSqlClose,
    compactTabTitle: settings.compactTabTitle ?? DEFAULT_EDITOR_SETTINGS.compactTabTitle,
    appLayout: settings.appLayout ?? DEFAULT_EDITOR_SETTINGS.appLayout,
    pageSize: normalizeResultPageSize(settings.pageSize),
    infiniteScroll: settings.infiniteScroll ?? DEFAULT_EDITOR_SETTINGS.infiniteScroll,
    infiniteScrollMaxRows: typeof settings.infiniteScrollMaxRows === "number" && settings.infiniteScrollMaxRows >= 1000 && settings.infiniteScrollMaxRows <= 50000 ? Math.round(settings.infiniteScrollMaxRows) : DEFAULT_EDITOR_SETTINGS.infiniteScrollMaxRows,
    autoCalculateTotalRows: settings.autoCalculateTotalRows ?? DEFAULT_EDITOR_SETTINGS.autoCalculateTotalRows,
    mongoViewMode: settings.mongoViewMode === "table" ? "table" : DEFAULT_EDITOR_SETTINGS.mongoViewMode,
    showColumnCommentsInHeader: settings.showColumnCommentsInHeader ?? DEFAULT_EDITOR_SETTINGS.showColumnCommentsInHeader,
    showColumnTypesInHeader: settings.showColumnTypesInHeader ?? DEFAULT_EDITOR_SETTINGS.showColumnTypesInHeader,
    compactColumnHeaderActions: settings.compactColumnHeaderActions ?? DEFAULT_EDITOR_SETTINGS.compactColumnHeaderActions,
    columnWidthDensity: normalizeColumnWidthDensity(settings.columnWidthDensity),
    dataGridQuickEntry: settings.dataGridQuickEntry ?? DEFAULT_EDITOR_SETTINGS.dataGridQuickEntry,
    dataGridRenderMode: normalizeDataGridRenderMode(settings.dataGridRenderMode),
    dataGridSearchMode: normalizeDataGridSearchMode(settings.dataGridSearchMode),
    tableFontSize: normalizeTableFontSize(settings.tableFontSize),
    structureEditorDensity: normalizeStructureEditorDensity(settings.structureEditorDensity),
    tableInfoDrawerWidth: normalizeDrawerWidth(settings.tableInfoDrawerWidth, 240, DEFAULT_EDITOR_SETTINGS.tableInfoDrawerWidth),
    cellDetailDrawerWidth: normalizeDrawerWidth(settings.cellDetailDrawerWidth, 260, DEFAULT_EDITOR_SETTINGS.cellDetailDrawerWidth),
    cellDetailPanelLayout: normalizeCellDetailPanelLayout(settings.cellDetailPanelLayout),
    cellDetailJsonFormatted: typeof settings.cellDetailJsonFormatted === "boolean" ? settings.cellDetailJsonFormatted : DEFAULT_EDITOR_SETTINGS.cellDetailJsonFormatted,
    shortcuts: normalizeShortcutSettings(settings.shortcuts),
    sqlFormatter: normalizeSqlFormatterSettings(settings.sqlFormatter),
    sidebarActivation: settings.sidebarActivation === "single" || settings.sidebarActivation === "double" ? settings.sidebarActivation : DEFAULT_EDITOR_SETTINGS.sidebarActivation,
    sidebarObjectDisplay: settings.sidebarObjectDisplay === "simple" || settings.sidebarObjectDisplay === "grouped" ? settings.sidebarObjectDisplay : DEFAULT_EDITOR_SETTINGS.sidebarObjectDisplay,
    sidebarTableSearchEnabled: typeof settings.sidebarTableSearchEnabled === "boolean" ? settings.sidebarTableSearchEnabled : DEFAULT_EDITOR_SETTINGS.sidebarTableSearchEnabled,
    autoSelectActiveSidebarNode: settings.autoSelectActiveSidebarNode ?? DEFAULT_EDITOR_SETTINGS.autoSelectActiveSidebarNode,
    openTabsRestoreMode: normalizeOpenTabsRestoreMode((settings as Partial<EditorSettings>).openTabsRestoreMode, (settings as Partial<EditorSettings> & { restoreOpenTabsOnLaunch?: boolean }).restoreOpenTabsOnLaunch),
    disconnectTabHandlingMode: normalizeDisconnectTabHandlingMode((settings as Partial<EditorSettings>).disconnectTabHandlingMode, (settings as Partial<EditorSettings> & { closeQueryTabsOnDisconnect?: boolean }).closeQueryTabsOnDisconnect),
    reuseDataTab: settings.reuseDataTab ?? DEFAULT_EDITOR_SETTINGS.reuseDataTab,
    prefillNewQueryWithSelect: typeof settings.prefillNewQueryWithSelect === "boolean" ? settings.prefillNewQueryWithSelect : DEFAULT_EDITOR_SETTINGS.prefillNewQueryWithSelect,
    updateNotificationsEnabled: settings.updateNotificationsEnabled ?? DEFAULT_EDITOR_SETTINGS.updateNotificationsEnabled,
    sidebarHiddenTablePrefixes: normalizeSidebarHiddenTablePrefixes(settings.sidebarHiddenTablePrefixes),
    sidebarHideTableComments: settings.sidebarHideTableComments ?? DEFAULT_EDITOR_SETTINGS.sidebarHideTableComments,
    sidebarAllowHorizontalScroll: settings.sidebarAllowHorizontalScroll ?? DEFAULT_EDITOR_SETTINGS.sidebarAllowHorizontalScroll,
    columnFormatters: normalizeColumnFormatters(settings.columnFormatters),
    customColumnFormatters: normalizeCustomColumnFormatters(settings.customColumnFormatters),
    snippets: normalizeSqlSnippets(settings.snippets, existing?.snippets),
    tableColumnTemplateFields: normalizeTableColumnTemplateFields(settings.tableColumnTemplateFields),
    exportBatchSize: typeof settings.exportBatchSize === "number" && settings.exportBatchSize >= 100 && settings.exportBatchSize <= 100000 ? Math.round(settings.exportBatchSize) : DEFAULT_EDITOR_SETTINGS.exportBatchSize,
    exportRowLimitEnabled: typeof settings.exportRowLimitEnabled === "boolean" ? settings.exportRowLimitEnabled : DEFAULT_EDITOR_SETTINGS.exportRowLimitEnabled,
    exportRowLimit: typeof settings.exportRowLimit === "number" && settings.exportRowLimit >= 100 && settings.exportRowLimit <= 2147483647 ? Math.round(settings.exportRowLimit) : DEFAULT_EDITOR_SETTINGS.exportRowLimit,
    queryExportKeysetOptimizationEnabled: typeof settings.queryExportKeysetOptimizationEnabled === "boolean" ? settings.queryExportKeysetOptimizationEnabled : DEFAULT_EDITOR_SETTINGS.queryExportKeysetOptimizationEnabled,
    updateDownloadSource: normalizeUpdateDownloadSource(settings.updateDownloadSource),
    toolbarItems: normalizeToolbarItems(settings.toolbarItems),
    objectBrowserShowCheckbox: typeof settings.objectBrowserShowCheckbox === "boolean" ? settings.objectBrowserShowCheckbox : DEFAULT_EDITOR_SETTINGS.objectBrowserShowCheckbox,
    objectBrowserViewMode: settings.objectBrowserViewMode === "grid" ? "grid" : DEFAULT_EDITOR_SETTINGS.objectBrowserViewMode,
    sqlVariableSyntaxOverrides: normalizeSqlVariableSyntaxOverrides(settings.sqlVariableSyntaxOverrides),
  };
}

function loadLegacyEditorSettings(): EditorSettings | null {
  const raw = safeLocalStorageGet(STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<EditorSettings>;
      if (parsed.exportBatchSize === LEGACY_DEFAULT_EXPORT_BATCH_SIZE && safeLocalStorageGet(EXPORT_BATCH_SIZE_DEFAULT_MIGRATION_KEY) !== "1") {
        parsed.exportBatchSize = DEFAULT_EDITOR_SETTINGS.exportBatchSize;
      }
      return normalizeEditorSettings(parsed);
    } catch {
      return null;
    }
  }

  const oldSize = safeLocalStorageGet(OLD_FONT_SIZE_KEY);
  if (!oldSize) return null;
  const parsed = parseInt(oldSize, 10);
  return Number.isNaN(parsed) ? null : normalizeEditorSettings({ fontSize: parsed });
}

function clearLegacyEditorSettings() {
  safeLocalStorageRemove(STORAGE_KEY);
  safeLocalStorageRemove(OLD_FONT_SIZE_KEY);
  safeLocalStorageRemove(EXPORT_BATCH_SIZE_DEFAULT_MIGRATION_KEY);
}

function saveEditorSettings(settings: EditorSettings) {
  void api.saveEditorSettings(settings).catch(() => {});
}

export const useSettingsStore = defineStore("settings", () => {
  const settingsPageActive = ref(false);
  const aiConfig = ref<AiConfig>(normalizeAiConfig({ provider: "claude" }));
  const isAiConfigLoaded = ref(false);
  const aiProviderConfigs = ref<Partial<Record<AiProvider, AiConfig>>>({});
  const desktopSettings = ref<DesktopSettings>({ ...DEFAULT_DESKTOP_SETTINGS });
  const isDesktopSettingsLoaded = ref(false);
  const isEditorSettingsLoaded = ref(false);

  const editorSettings = ref<EditorSettings>(normalizeEditorSettings({}));

  async function initEditorSettings() {
    if (isEditorSettingsLoaded.value) return;
    const saved = await api.loadEditorSettings().catch(() => null);
    if (saved && typeof saved === "object" && !Array.isArray(saved)) {
      editorSettings.value = normalizeEditorSettings(saved as Partial<EditorSettings>);
      isEditorSettingsLoaded.value = true;
      return;
    }

    const legacy = loadLegacyEditorSettings();
    if (legacy) {
      editorSettings.value = legacy;
      try {
        await api.saveEditorSettings(legacy);
        // Existing desktop users keep settings in localStorage; remove them only
        // after the async store has accepted the migrated value.
        clearLegacyEditorSettings();
      } catch {
        /* keep legacy values for a later migration attempt */
      }
    }
    isEditorSettingsLoaded.value = true;
  }

  async function initDesktopSettings() {
    if (isDesktopSettingsLoaded.value) return;
    desktopSettings.value = normalizeDesktopSettings(await api.loadDesktopSettings().catch(() => null));
    setDebugLoggingEnabled(desktopSettings.value.debug_logging_enabled);
    isDesktopSettingsLoaded.value = true;
  }

  async function updateDesktopSettings(partial: Partial<DesktopSettings>) {
    const previous = desktopSettings.value;
    const next = {
      ...desktopSettings.value,
      ...partial,
    };
    desktopSettings.value = normalizeDesktopSettings(next);
    setDebugLoggingEnabled(desktopSettings.value.debug_logging_enabled);
    try {
      await api.saveDesktopSettings(desktopSettings.value);
    } catch (error) {
      desktopSettings.value = previous;
      setDebugLoggingEnabled(previous.debug_logging_enabled);
      throw error;
    }
  }

  async function initAiConfig() {
    if (isAiConfigLoaded.value) return;
    const legacy = localStorage.getItem("dbx-ai-config");
    const [savedActive, savedProviderConfigs] = await Promise.all([api.loadAiConfig().catch(() => null), api.loadAiProviderConfigs().catch(() => null) as Promise<Partial<Record<AiProvider, AiConfig>> | null>]);

    if (savedActive) {
      aiConfig.value = normalizeAiConfig(savedActive);
    } else if (legacy) {
      aiConfig.value = normalizeAiConfig(JSON.parse(legacy));
      await api.saveAiConfig(aiConfig.value).catch(() => {});
      localStorage.removeItem("dbx-ai-config");
    }

    if (savedProviderConfigs) {
      aiProviderConfigs.value = savedProviderConfigs;
    }

    // Ensure active config is reflected in provider map (overwrite if exists, to guarantee consistency)
    const activeProvider = aiConfig.value.provider;
    aiProviderConfigs.value[activeProvider] = { ...aiConfig.value };

    isAiConfigLoaded.value = true;
  }

  function updateAiConfig(config: Partial<AiConfig>) {
    const previousProvider = aiConfig.value.provider;
    const targetProvider = config.provider;
    const switchingProvider = !!targetProvider && targetProvider !== previousProvider;

    if (switchingProvider) {
      // Save current provider's config before switching
      aiProviderConfigs.value[previousProvider] = { ...aiConfig.value };
      api.saveAiProviderConfig(previousProvider, aiConfig.value).catch(() => {});

      // Restore saved config for target provider, or use preset defaults
      const savedConfig = aiProviderConfigs.value[targetProvider];
      if (savedConfig) {
        aiConfig.value = normalizeAiConfig({ ...savedConfig, provider: targetProvider });
      } else {
        aiConfig.value = normalizeAiConfig({ provider: targetProvider });
      }
      // Don't merge caller fields when switching — caller passes only { provider }
    } else {
      // Not switching provider — apply partial update
      Object.assign(aiConfig.value, config);
    }

    aiProviderConfigs.value[aiConfig.value.provider] = { ...aiConfig.value };
    api.saveAiConfig(aiConfig.value).catch(() => {});
    api.saveAiProviderConfig(aiConfig.value.provider, aiConfig.value).catch(() => {});
  }

  function isConfigured(): boolean {
    const preset = AI_PROVIDER_PRESETS[aiConfig.value.provider];
    if (aiConfig.value.provider === "codex-cli") return true;
    return !!aiConfig.value.endpoint && !!aiConfig.value.model && (!preset.requiresApiKey || !!aiConfig.value.apiKey);
  }

  function isAiProviderConfigured(provider: AiProvider): boolean {
    const config = aiProviderConfigs.value[provider];
    if (!config) return false;
    if (provider === "codex-cli") return true;
    const preset = AI_PROVIDER_PRESETS[provider];
    return !!config.endpoint?.trim() && !!config.model?.trim() && (!preset.requiresApiKey || !!config.apiKey?.trim());
  }

  function updateEditorSettings(partial: Partial<EditorSettings>) {
    if (partial.fontFamily !== undefined) editorSettings.value.fontFamily = normalizeFontFamily(partial.fontFamily, DEFAULT_EDITOR_SETTINGS.fontFamily);
    if (partial.fontSize !== undefined) editorSettings.value.fontSize = partial.fontSize;
    if (partial.uiFontFamily !== undefined) editorSettings.value.uiFontFamily = normalizeFontFamily(partial.uiFontFamily, DEFAULT_EDITOR_SETTINGS.uiFontFamily);
    if (partial.uiScale !== undefined) editorSettings.value.uiScale = normalizeUiScale(partial.uiScale);
    if (partial.theme !== undefined) editorSettings.value.theme = partial.theme;
    if (partial.customThemeColors !== undefined) {
      editorSettings.value.customThemeColors = {
        ...editorSettings.value.customThemeColors,
        ...partial.customThemeColors,
      };
    }
    if (partial.customThemes !== undefined) {
      editorSettings.value.customThemes = Array.isArray(partial.customThemes) ? partial.customThemes : editorSettings.value.customThemes;
    }
    if (partial.activeCustomThemeId !== undefined) {
      editorSettings.value.activeCustomThemeId = partial.activeCustomThemeId;
    }
    if (partial.customThemes !== undefined || partial.activeCustomThemeId !== undefined) {
      const themes = editorSettings.value.customThemes;
      const activeId = editorSettings.value.activeCustomThemeId;
      const activeTheme = themes.find((t) => t.id === activeId) || themes[0];
      if (activeTheme) {
        editorSettings.value.customThemeColors = { ...activeTheme.colors };
      }
    }
    if (partial.executeMode !== undefined) editorSettings.value.executeMode = partial.executeMode;
    if (partial.showExecutionTargetPicker !== undefined) editorSettings.value.showExecutionTargetPicker = partial.showExecutionTargetPicker;
    if (partial.showStatementRunButtons !== undefined) editorSettings.value.showStatementRunButtons = partial.showStatementRunButtons === true;
    if (partial.showCurrentStatementFrame !== undefined) editorSettings.value.showCurrentStatementFrame = partial.showCurrentStatementFrame === true;
    if (partial.showInsertValueHints !== undefined) editorSettings.value.showInsertValueHints = partial.showInsertValueHints === true;
    if (partial.autoAliasTables !== undefined) editorSettings.value.autoAliasTables = partial.autoAliasTables;
    if (partial.wordWrap !== undefined) editorSettings.value.wordWrap = partial.wordWrap;
    if (partial.vimModeEnabled !== undefined) editorSettings.value.vimModeEnabled = partial.vimModeEnabled === true;
    if (partial.autoCloseBrackets !== undefined) editorSettings.value.autoCloseBrackets = partial.autoCloseBrackets === true;
    if (partial.sqlSemanticDiagnosticsMode !== undefined || partial.sqlSemanticDiagnosticsEnabled !== undefined) {
      const nextMode = normalizeSqlSemanticDiagnosticsMode(partial.sqlSemanticDiagnosticsMode, partial.sqlSemanticDiagnosticsEnabled);
      editorSettings.value.sqlSemanticDiagnosticsMode = nextMode;
      editorSettings.value.sqlSemanticDiagnosticsEnabled = sqlSemanticDiagnosticsEnabledForMode(nextMode);
    }
    if (partial.confirmDangerousSqlExecution !== undefined) editorSettings.value.confirmDangerousSqlExecution = partial.confirmDangerousSqlExecution;
    if (partial.confirmUnsavedSqlClose !== undefined) editorSettings.value.confirmUnsavedSqlClose = partial.confirmUnsavedSqlClose;
    if (partial.compactTabTitle !== undefined) editorSettings.value.compactTabTitle = partial.compactTabTitle;
    if (partial.appLayout !== undefined) editorSettings.value.appLayout = partial.appLayout;
    if (partial.pageSize !== undefined) editorSettings.value.pageSize = normalizeResultPageSize(partial.pageSize);
    if (partial.infiniteScroll !== undefined) editorSettings.value.infiniteScroll = partial.infiniteScroll;
    if (partial.infiniteScrollMaxRows !== undefined)
      editorSettings.value.infiniteScrollMaxRows = typeof partial.infiniteScrollMaxRows === "number" && partial.infiniteScrollMaxRows >= 1000 && partial.infiniteScrollMaxRows <= 50000 ? Math.round(partial.infiniteScrollMaxRows) : DEFAULT_EDITOR_SETTINGS.infiniteScrollMaxRows;
    if (partial.autoCalculateTotalRows !== undefined) editorSettings.value.autoCalculateTotalRows = partial.autoCalculateTotalRows === true;
    if (partial.mongoViewMode !== undefined) editorSettings.value.mongoViewMode = partial.mongoViewMode;
    if (partial.showColumnCommentsInHeader !== undefined) editorSettings.value.showColumnCommentsInHeader = partial.showColumnCommentsInHeader;
    if (partial.showColumnTypesInHeader !== undefined) editorSettings.value.showColumnTypesInHeader = partial.showColumnTypesInHeader;
    if (partial.compactColumnHeaderActions !== undefined) editorSettings.value.compactColumnHeaderActions = partial.compactColumnHeaderActions;
    if (partial.columnWidthDensity !== undefined) editorSettings.value.columnWidthDensity = normalizeColumnWidthDensity(partial.columnWidthDensity);
    if (partial.dataGridQuickEntry !== undefined) editorSettings.value.dataGridQuickEntry = partial.dataGridQuickEntry;
    if (partial.dataGridRenderMode !== undefined) editorSettings.value.dataGridRenderMode = normalizeDataGridRenderMode(partial.dataGridRenderMode);
    if (partial.dataGridSearchMode !== undefined) editorSettings.value.dataGridSearchMode = normalizeDataGridSearchMode(partial.dataGridSearchMode);
    if (partial.tableFontSize !== undefined) editorSettings.value.tableFontSize = normalizeTableFontSize(partial.tableFontSize);
    if (partial.structureEditorDensity !== undefined) editorSettings.value.structureEditorDensity = normalizeStructureEditorDensity(partial.structureEditorDensity);
    if (partial.tableInfoDrawerWidth !== undefined) editorSettings.value.tableInfoDrawerWidth = normalizeDrawerWidth(partial.tableInfoDrawerWidth, 240, DEFAULT_EDITOR_SETTINGS.tableInfoDrawerWidth);
    if (partial.cellDetailDrawerWidth !== undefined) editorSettings.value.cellDetailDrawerWidth = normalizeDrawerWidth(partial.cellDetailDrawerWidth, 260, DEFAULT_EDITOR_SETTINGS.cellDetailDrawerWidth);
    if (partial.cellDetailPanelLayout !== undefined) editorSettings.value.cellDetailPanelLayout = normalizeCellDetailPanelLayout(partial.cellDetailPanelLayout);
    if (partial.cellDetailJsonFormatted !== undefined) editorSettings.value.cellDetailJsonFormatted = partial.cellDetailJsonFormatted === true;
    if (partial.shortcuts !== undefined) editorSettings.value.shortcuts = normalizeShortcutSettings(partial.shortcuts);
    if (partial.sqlFormatter !== undefined) editorSettings.value.sqlFormatter = normalizeSqlFormatterSettings(partial.sqlFormatter);
    if (partial.sidebarActivation !== undefined) editorSettings.value.sidebarActivation = partial.sidebarActivation;
    if (partial.sidebarObjectDisplay !== undefined) editorSettings.value.sidebarObjectDisplay = partial.sidebarObjectDisplay;
    if (partial.sidebarTableSearchEnabled !== undefined) editorSettings.value.sidebarTableSearchEnabled = partial.sidebarTableSearchEnabled;
    if (partial.autoSelectActiveSidebarNode !== undefined) editorSettings.value.autoSelectActiveSidebarNode = partial.autoSelectActiveSidebarNode;
    if (partial.openTabsRestoreMode !== undefined) editorSettings.value.openTabsRestoreMode = normalizeOpenTabsRestoreMode(partial.openTabsRestoreMode);
    if (partial.disconnectTabHandlingMode !== undefined) editorSettings.value.disconnectTabHandlingMode = normalizeDisconnectTabHandlingMode(partial.disconnectTabHandlingMode);
    if (partial.reuseDataTab !== undefined) editorSettings.value.reuseDataTab = partial.reuseDataTab;
    if (partial.prefillNewQueryWithSelect !== undefined) editorSettings.value.prefillNewQueryWithSelect = partial.prefillNewQueryWithSelect;
    if (partial.updateNotificationsEnabled !== undefined) editorSettings.value.updateNotificationsEnabled = partial.updateNotificationsEnabled;
    if (partial.sidebarHiddenTablePrefixes !== undefined) editorSettings.value.sidebarHiddenTablePrefixes = normalizeSidebarHiddenTablePrefixes(partial.sidebarHiddenTablePrefixes);
    if (partial.sidebarHideTableComments !== undefined) editorSettings.value.sidebarHideTableComments = partial.sidebarHideTableComments;
    if (partial.sidebarAllowHorizontalScroll !== undefined) editorSettings.value.sidebarAllowHorizontalScroll = partial.sidebarAllowHorizontalScroll;
    if (partial.columnFormatters !== undefined) editorSettings.value.columnFormatters = partial.columnFormatters;
    if (partial.customColumnFormatters !== undefined) editorSettings.value.customColumnFormatters = partial.customColumnFormatters;
    if (partial.snippets !== undefined) editorSettings.value.snippets = normalizeSqlSnippets(partial.snippets);
    if (partial.tableColumnTemplateFields !== undefined) editorSettings.value.tableColumnTemplateFields = normalizeTableColumnTemplateFields(partial.tableColumnTemplateFields);
    if (partial.exportBatchSize !== undefined) editorSettings.value.exportBatchSize = Math.min(100000, Math.max(100, Math.round(partial.exportBatchSize)));
    if (partial.exportRowLimitEnabled !== undefined) editorSettings.value.exportRowLimitEnabled = partial.exportRowLimitEnabled;
    if (partial.exportRowLimit !== undefined) editorSettings.value.exportRowLimit = Math.min(2147483647, Math.max(100, Math.round(partial.exportRowLimit)));
    if (partial.queryExportKeysetOptimizationEnabled !== undefined) editorSettings.value.queryExportKeysetOptimizationEnabled = partial.queryExportKeysetOptimizationEnabled;
    if (partial.updateDownloadSource !== undefined) editorSettings.value.updateDownloadSource = normalizeUpdateDownloadSource(partial.updateDownloadSource);
    if (partial.toolbarItems !== undefined) editorSettings.value.toolbarItems = normalizeToolbarItems(partial.toolbarItems);
    if (partial.objectBrowserShowCheckbox !== undefined) editorSettings.value.objectBrowserShowCheckbox = partial.objectBrowserShowCheckbox === true;
    if (partial.objectBrowserViewMode !== undefined) editorSettings.value.objectBrowserViewMode = partial.objectBrowserViewMode === "grid" ? "grid" : "list";
    if (partial.sqlVariableSyntaxOverrides !== undefined) editorSettings.value.sqlVariableSyntaxOverrides = normalizeSqlVariableSyntaxOverrides(partial.sqlVariableSyntaxOverrides);
    saveEditorSettings(editorSettings.value);
  }

  function updateColumnFormatter(key: string, formatter: ColumnFormatterConfig | undefined) {
    const columnFormatters = { ...editorSettings.value.columnFormatters };
    const normalized = normalizeColumnFormatter(formatter);
    if (normalized) {
      columnFormatters[key] = normalized;
    } else {
      delete columnFormatters[key];
    }
    updateEditorSettings({ columnFormatters });
  }

  function upsertCustomColumnFormatter(formatter: CustomColumnFormatterConfig): CustomColumnFormatterConfig | undefined {
    const normalized = normalizeCustomColumnFormatter(formatter);
    if (!normalized) return undefined;
    updateEditorSettings({
      customColumnFormatters: {
        ...editorSettings.value.customColumnFormatters,
        [normalized.id]: normalized,
      },
    });
    return normalized;
  }

  function deleteCustomColumnFormatter(id: string) {
    const customColumnFormatters = { ...editorSettings.value.customColumnFormatters };
    delete customColumnFormatters[id];
    const columnFormatters = Object.fromEntries(
      Object.entries(editorSettings.value.columnFormatters).filter(([, formatter]) => {
        return formatter.kind !== "custom-ref" || formatter.formatterId !== id;
      }),
    );
    updateEditorSettings({ customColumnFormatters, columnFormatters });
  }

  return {
    settingsPageActive,
    aiConfig,
    isAiConfigLoaded,
    aiProviderConfigs,
    initAiConfig,
    updateAiConfig,
    isConfigured,
    isAiProviderConfigured,
    isEditorSettingsLoaded,
    editorSettings,
    desktopSettings,
    initEditorSettings,
    updateEditorSettings,
    initDesktopSettings,
    updateDesktopSettings,
    updateColumnFormatter,
    upsertCustomColumnFormatter,
    deleteCustomColumnFormatter,
  };
});

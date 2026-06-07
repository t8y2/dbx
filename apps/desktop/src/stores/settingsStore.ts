import { defineStore } from "pinia";
import { ref } from "vue";
import * as api from "@/lib/api";
import {
  normalizeColumnFormatter,
  normalizeCustomColumnFormatter,
  type ColumnFormatterConfig,
  type CustomColumnFormatterConfig,
} from "@/lib/columnFormatter";
import { normalizeShortcutSettings, type ShortcutSettings } from "@/lib/shortcutRegistry";
import { normalizeResultPageSize } from "@/lib/paginationPageSize";
import { normalizeSidebarHiddenTablePrefixes } from "@/lib/sidebarTableNameDisplay";
import type { SidebarActivation } from "@/lib/treeNodeClick";
import type { SqlSnippet } from "@/types/database";
import { DEFAULT_SQL_SNIPPETS } from "@/lib/sqlCompletion";

export type AiProvider =
  | "claude"
  | "openai"
  | "gemini"
  | "deepseek"
  | "qwen"
  | "ollama"
  | "openai-compatible"
  | "custom";
export type AiApiStyle = "completions" | "responses";

export interface AiConfig {
  provider: AiProvider;
  apiKey: string;
  endpoint: string;
  model: string;
  apiStyle: AiApiStyle;
  proxyEnabled?: boolean;
  proxyUrl?: string;
  enableThinking?: boolean;
}

export interface DesktopSettings {
  show_tray_icon: boolean;
  icon_theme: DesktopIconTheme;
}

export type DesktopIconTheme = "default" | "black";

export const DEFAULT_DESKTOP_SETTINGS: DesktopSettings = {
  show_tray_icon: true,
  icon_theme: "default",
};

function normalizeDesktopSettings(settings: Partial<DesktopSettings> | null | undefined): DesktopSettings {
  const iconTheme = settings?.icon_theme === "black" ? "black" : DEFAULT_DESKTOP_SETTINGS.icon_theme;
  return {
    show_tray_icon: settings?.show_tray_icon ?? DEFAULT_DESKTOP_SETTINGS.show_tray_icon,
    icon_theme: iconTheme,
  };
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
    requiresApiKey: true,
  },
  openai: {
    label: "OpenAI",
    iconSlug: "openai",
    provider: "openai",
    endpoint: "https://api.openai.com/v1/chat/completions",
    model: "gpt-4o-mini",
    apiStyle: "completions",
    requiresApiKey: true,
  },
  gemini: {
    label: "Gemini",
    iconSlug: "googlegemini",
    provider: "gemini",
    endpoint: "https://generativelanguage.googleapis.com",
    model: "gemini-1.5-pro",
    apiStyle: "completions",
    requiresApiKey: true,
  },
  deepseek: {
    label: "DeepSeek",
    iconSlug: "deepseek",
    provider: "deepseek",
    endpoint: "https://api.deepseek.com/v1",
    model: "deepseek-v4-flash",
    apiStyle: "completions",
    requiresApiKey: true,
  },
  qwen: {
    label: "Qwen",
    iconSlug: "alibabacloud",
    provider: "qwen",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    apiStyle: "completions",
    requiresApiKey: true,
  },
  ollama: {
    label: "Ollama",
    iconSlug: "ollama",
    provider: "ollama",
    endpoint: "http://localhost:11434/v1",
    model: "llama3.1",
    apiStyle: "completions",
    requiresApiKey: false,
  },
  "openai-compatible": {
    label: "OpenAI Compatible",
    iconSlug: "openai",
    provider: "openai-compatible",
    endpoint: "",
    model: "",
    apiStyle: "completions",
    requiresApiKey: true,
  },
  custom: {
    label: "Custom",
    provider: "custom",
    endpoint: "",
    model: "",
    apiStyle: "completions",
    requiresApiKey: true,
  },
};

const defaultConfigs: Record<AiProvider, Omit<AiConfig, "apiKey">> = Object.fromEntries(
  Object.entries(AI_PROVIDER_PRESETS).map(([provider, preset]) => {
    const { label: _label, iconSlug: _iconSlug, requiresApiKey: _requiresApiKey, ...config } = preset;
    return [provider, config];
  }),
) as Record<AiProvider, Omit<AiConfig, "apiKey">>;

export function normalizeAiConfig(config: Partial<AiConfig> | null | undefined): AiConfig {
  const provider =
    config?.provider && config.provider in AI_PROVIDER_PRESETS ? config.provider : inferAiProviderFromConfig(config);
  return {
    ...defaultConfigs[provider],
    apiKey: config?.apiKey ?? "",
    ...config,
    provider,
    apiStyle: config?.apiStyle ?? defaultConfigs[provider].apiStyle,
    proxyEnabled: !!config?.proxyEnabled,
    proxyUrl: config?.proxyUrl ?? "",
    enableThinking: config?.enableThinking ?? true,
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
  | "custom";

const STRUCTURE_EDITOR_DENSITIES = ["compact", "standard", "comfortable"] as const;
export type StructureEditorDensity = (typeof STRUCTURE_EDITOR_DENSITIES)[number];
const CELL_DETAIL_PANEL_LAYOUTS = ["bottom", "right"] as const;
export type CellDetailPanelLayout = (typeof CELL_DETAIL_PANEL_LAYOUTS)[number];
const DATA_GRID_RENDER_MODES = ["dom", "canvas"] as const;
export type DataGridRenderMode = (typeof DATA_GRID_RENDER_MODES)[number];
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

export interface CustomTheme {
  id: string;
  name: string;
  colors: CustomThemeColors;
}

export const DEFAULT_CUSTOM_THEMES: CustomTheme[] = [
  { id: "default", name: "Custom", colors: { ...DEFAULT_CUSTOM_THEME_COLORS } },
];

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  uiScale: number;
  theme: EditorTheme;
  customThemeColors: CustomThemeColors;
  customThemes: CustomTheme[];
  activeCustomThemeId: string;
  executeMode: "all" | "current";
  wordWrap: boolean;
  confirmDangerousSqlExecution: boolean;
  compactTabTitle: boolean;
  appLayout: "separated" | "classic";
  pageSize: number;
  redisScanPageSize: number;
  mongoViewMode: "document" | "table";
  showColumnCommentsInHeader: boolean;
  showColumnTypesInHeader: boolean;
  compactColumnHeaderActions: boolean;
  dataGridRenderMode: DataGridRenderMode;
  structureEditorDensity: StructureEditorDensity;
  tableInfoDrawerWidth: number;
  cellDetailDrawerWidth: number;
  cellDetailPanelLayout: CellDetailPanelLayout;
  shortcuts: ShortcutSettings;
  sidebarActivation: SidebarActivation;
  sidebarObjectDisplay: "grouped" | "simple";
  autoSelectActiveSidebarNode: boolean;
  disconnectTabHandlingMode: DisconnectTabHandlingMode;
  reuseDataTab: boolean;
  updateNotificationsEnabled: boolean;
  sidebarHiddenTablePrefixes: string[];
  sidebarHideTableComments: boolean;
  sidebarAllowHorizontalScroll: boolean;
  columnFormatters: Record<string, ColumnFormatterConfig>;
  customColumnFormatters: Record<string, CustomColumnFormatterConfig>;
  snippets: SqlSnippet[];
  exportBatchSize: number;
}

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
  { value: "custom", label: "Custom", dark: true },
];

const EDITOR_THEME_VALUES = new Set<EditorTheme>(EDITOR_THEMES.map((theme) => theme.value));

export const FONT_FAMILIES: { value: string; label: string }[] = [
  { value: "'JetBrains Mono', 'Fira Code', monospace", label: "JetBrains Mono" },
  { value: "'Fira Code', monospace", label: "Fira Code" },
  { value: "'Cascadia Code', monospace", label: "Cascadia Code" },
  { value: "'Source Code Pro', monospace", label: "Source Code Pro" },
  { value: "'SF Mono', 'Menlo', monospace", label: "SF Mono / Menlo" },
  { value: "'Consolas', 'Courier New', monospace", label: "Consolas" },
  { value: "monospace", label: "System Monospace" },
];

export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
  fontSize: 13,
  uiScale: 1,
  theme: "app",
  customThemeColors: { ...DEFAULT_CUSTOM_THEME_COLORS },
  customThemes: [...DEFAULT_CUSTOM_THEMES],
  activeCustomThemeId: "default",
  executeMode: "all",
  wordWrap: false,
  confirmDangerousSqlExecution: true,
  compactTabTitle: false,
  appLayout: "classic",
  pageSize: 100,
  redisScanPageSize: 1000,
  mongoViewMode: "document",
  showColumnCommentsInHeader: false,
  showColumnTypesInHeader: true,
  compactColumnHeaderActions: true,
  dataGridRenderMode: "canvas",
  structureEditorDensity: "compact",
  tableInfoDrawerWidth: 320,
  cellDetailDrawerWidth: 320,
  cellDetailPanelLayout: "bottom",
  shortcuts: normalizeShortcutSettings(),
  sidebarActivation: "single",
  sidebarObjectDisplay: "grouped",
  autoSelectActiveSidebarNode: false,
  disconnectTabHandlingMode: "close-tabs",
  reuseDataTab: false,
  updateNotificationsEnabled: true,
  sidebarHiddenTablePrefixes: [],
  sidebarHideTableComments: false,
  sidebarAllowHorizontalScroll: false,
  columnFormatters: {},
  customColumnFormatters: {},
  snippets: DEFAULT_SQL_SNIPPETS,
  exportBatchSize: 10000,
};

export const STORAGE_KEY = "dbx-editor-settings";
const OLD_FONT_SIZE_KEY = "dbx-query-editor-font-size";
const MIN_UI_SCALE = 0.75;
const MAX_UI_SCALE = 2;

function normalizeUiScale(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_EDITOR_SETTINGS.uiScale;
  return Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, Math.round(value * 100) / 100));
}

function normalizeDrawerWidth(value: unknown, min: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(900, Math.max(min, Math.round(value)));
}

function normalizeStructureEditorDensity(value: unknown): StructureEditorDensity {
  return STRUCTURE_EDITOR_DENSITIES.includes(value as StructureEditorDensity)
    ? (value as StructureEditorDensity)
    : DEFAULT_EDITOR_SETTINGS.structureEditorDensity;
}

function normalizeCellDetailPanelLayout(value: unknown): CellDetailPanelLayout {
  return CELL_DETAIL_PANEL_LAYOUTS.includes(value as CellDetailPanelLayout)
    ? (value as CellDetailPanelLayout)
    : DEFAULT_EDITOR_SETTINGS.cellDetailPanelLayout;
}

function normalizeDataGridRenderMode(value: unknown): DataGridRenderMode {
  return DATA_GRID_RENDER_MODES.includes(value as DataGridRenderMode)
    ? (value as DataGridRenderMode)
    : DEFAULT_EDITOR_SETTINGS.dataGridRenderMode;
}

function normalizeDisconnectTabHandlingMode(
  value: unknown,
  legacyCloseTabsOnDisconnect?: unknown,
): DisconnectTabHandlingMode {
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
  const valid: SqlSnippet[] = [];
  const seenPrefixes = new Set<string>();
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      typeof item.id !== "string" ||
      !item.id ||
      typeof item.label !== "string" ||
      !item.label ||
      typeof item.prefix !== "string" ||
      !item.prefix ||
      typeof item.body !== "string"
    ) {
      continue;
    }
    if (seenPrefixes.has(item.prefix)) continue;
    seenPrefixes.add(item.prefix);
    valid.push({ id: item.id, label: item.label, prefix: item.prefix, body: item.body });
  }
  if (valid.length === 0) return existing ?? DEFAULT_SQL_SNIPPETS;
  return valid;
}

export function normalizeEditorSettings(settings: Partial<EditorSettings>, existing?: EditorSettings): EditorSettings {
  return {
    fontFamily: settings.fontFamily ?? DEFAULT_EDITOR_SETTINGS.fontFamily,
    fontSize: settings.fontSize ?? DEFAULT_EDITOR_SETTINGS.fontSize,
    uiScale: normalizeUiScale(settings.uiScale),
    theme: settings.theme && EDITOR_THEME_VALUES.has(settings.theme) ? settings.theme : DEFAULT_EDITOR_SETTINGS.theme,
    customThemeColors: {
      ...DEFAULT_CUSTOM_THEME_COLORS,
      ...settings.customThemeColors,
    },
    customThemes: (() => {
      if (Array.isArray(settings.customThemes) && settings.customThemes.length > 0) {
        return settings.customThemes.map((theme) => (theme.name === "默认" ? { ...theme, name: "Custom" } : theme));
      }
      return [
        ...(settings.customThemeColors
          ? [
              {
                id: "migrated",
                name: "Migrated",
                colors: { ...DEFAULT_CUSTOM_THEME_COLORS, ...settings.customThemeColors },
              },
            ]
          : []),
        ...DEFAULT_CUSTOM_THEMES,
      ];
    })(),
    activeCustomThemeId: settings.activeCustomThemeId ?? "default",
    executeMode: settings.executeMode ?? DEFAULT_EDITOR_SETTINGS.executeMode,
    wordWrap: settings.wordWrap ?? DEFAULT_EDITOR_SETTINGS.wordWrap,
    confirmDangerousSqlExecution:
      settings.confirmDangerousSqlExecution ?? DEFAULT_EDITOR_SETTINGS.confirmDangerousSqlExecution,
    compactTabTitle: settings.compactTabTitle ?? DEFAULT_EDITOR_SETTINGS.compactTabTitle,
    appLayout: settings.appLayout ?? DEFAULT_EDITOR_SETTINGS.appLayout,
    pageSize: normalizeResultPageSize(settings.pageSize),
    redisScanPageSize: settings.redisScanPageSize ?? DEFAULT_EDITOR_SETTINGS.redisScanPageSize,
    mongoViewMode: settings.mongoViewMode === "table" ? "table" : DEFAULT_EDITOR_SETTINGS.mongoViewMode,
    showColumnCommentsInHeader:
      settings.showColumnCommentsInHeader ?? DEFAULT_EDITOR_SETTINGS.showColumnCommentsInHeader,
    showColumnTypesInHeader: settings.showColumnTypesInHeader ?? DEFAULT_EDITOR_SETTINGS.showColumnTypesInHeader,
    compactColumnHeaderActions:
      settings.compactColumnHeaderActions ?? DEFAULT_EDITOR_SETTINGS.compactColumnHeaderActions,
    dataGridRenderMode: normalizeDataGridRenderMode(settings.dataGridRenderMode),
    structureEditorDensity: normalizeStructureEditorDensity(settings.structureEditorDensity),
    tableInfoDrawerWidth: normalizeDrawerWidth(
      settings.tableInfoDrawerWidth,
      240,
      DEFAULT_EDITOR_SETTINGS.tableInfoDrawerWidth,
    ),
    cellDetailDrawerWidth: normalizeDrawerWidth(
      settings.cellDetailDrawerWidth,
      260,
      DEFAULT_EDITOR_SETTINGS.cellDetailDrawerWidth,
    ),
    cellDetailPanelLayout: normalizeCellDetailPanelLayout(settings.cellDetailPanelLayout),
    shortcuts: normalizeShortcutSettings(settings.shortcuts),
    sidebarActivation:
      settings.sidebarActivation === "single" || settings.sidebarActivation === "double"
        ? settings.sidebarActivation
        : DEFAULT_EDITOR_SETTINGS.sidebarActivation,
    sidebarObjectDisplay:
      settings.sidebarObjectDisplay === "simple" || settings.sidebarObjectDisplay === "grouped"
        ? settings.sidebarObjectDisplay
        : DEFAULT_EDITOR_SETTINGS.sidebarObjectDisplay,
    autoSelectActiveSidebarNode:
      settings.autoSelectActiveSidebarNode ?? DEFAULT_EDITOR_SETTINGS.autoSelectActiveSidebarNode,
    disconnectTabHandlingMode: normalizeDisconnectTabHandlingMode(
      (settings as Partial<EditorSettings>).disconnectTabHandlingMode,
      (settings as Partial<EditorSettings> & { closeQueryTabsOnDisconnect?: boolean }).closeQueryTabsOnDisconnect,
    ),
    reuseDataTab: settings.reuseDataTab ?? DEFAULT_EDITOR_SETTINGS.reuseDataTab,
    updateNotificationsEnabled:
      settings.updateNotificationsEnabled ?? DEFAULT_EDITOR_SETTINGS.updateNotificationsEnabled,
    sidebarHiddenTablePrefixes: normalizeSidebarHiddenTablePrefixes(settings.sidebarHiddenTablePrefixes),
    sidebarHideTableComments: settings.sidebarHideTableComments ?? DEFAULT_EDITOR_SETTINGS.sidebarHideTableComments,
    sidebarAllowHorizontalScroll:
      settings.sidebarAllowHorizontalScroll ?? DEFAULT_EDITOR_SETTINGS.sidebarAllowHorizontalScroll,
    columnFormatters: normalizeColumnFormatters(settings.columnFormatters),
    customColumnFormatters: normalizeCustomColumnFormatters(settings.customColumnFormatters),
    snippets: normalizeSqlSnippets(settings.snippets, existing?.snippets),
    exportBatchSize:
      typeof settings.exportBatchSize === "number" &&
      settings.exportBatchSize >= 100 &&
      settings.exportBatchSize <= 100000
        ? Math.round(settings.exportBatchSize)
        : DEFAULT_EDITOR_SETTINGS.exportBatchSize,
  };
}

function loadEditorSettings(): EditorSettings {
  // Try new format first
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<EditorSettings>;
      return normalizeEditorSettings(parsed);
    }
  } catch {
    /* ignore */
  }

  // Migrate old font-size key if new settings don't exist
  try {
    const oldSize = localStorage.getItem(OLD_FONT_SIZE_KEY);
    if (oldSize) {
      const parsed = parseInt(oldSize, 10);
      if (!isNaN(parsed)) {
        const migrated: EditorSettings = {
          ...DEFAULT_EDITOR_SETTINGS,
          fontSize: parsed,
        };
        saveEditorSettings(migrated);
        localStorage.removeItem(OLD_FONT_SIZE_KEY);
        return migrated;
      }
    }
  } catch {
    /* ignore */
  }

  return { ...DEFAULT_EDITOR_SETTINGS };
}

function saveEditorSettings(settings: EditorSettings) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

export const useSettingsStore = defineStore("settings", () => {
  const aiConfig = ref<AiConfig>(normalizeAiConfig({ provider: "claude" }));
  const isAiConfigLoaded = ref(false);
  const desktopSettings = ref<DesktopSettings>({ ...DEFAULT_DESKTOP_SETTINGS });
  const isDesktopSettingsLoaded = ref(false);

  const editorSettings = ref<EditorSettings>(loadEditorSettings());

  async function initDesktopSettings() {
    if (isDesktopSettingsLoaded.value) return;
    desktopSettings.value = normalizeDesktopSettings(await api.loadDesktopSettings().catch(() => null));
    isDesktopSettingsLoaded.value = true;
  }

  async function updateDesktopSettings(partial: Partial<DesktopSettings>) {
    const previous = desktopSettings.value;
    const next = {
      ...desktopSettings.value,
      ...partial,
    };
    desktopSettings.value = normalizeDesktopSettings(next);
    try {
      await api.saveDesktopSettings(desktopSettings.value);
    } catch (error) {
      desktopSettings.value = previous;
      throw error;
    }
  }

  async function initAiConfig() {
    if (isAiConfigLoaded.value) return;
    const legacy = localStorage.getItem("dbx-ai-config");
    const saved = await api.loadAiConfig().catch(() => null);
    if (saved) {
      aiConfig.value = normalizeAiConfig(saved);
    } else if (legacy) {
      aiConfig.value = normalizeAiConfig(JSON.parse(legacy));
      await api.saveAiConfig(aiConfig.value).catch(() => {});
      localStorage.removeItem("dbx-ai-config");
    }
    isAiConfigLoaded.value = true;
  }

  function updateAiConfig(config: Partial<AiConfig>) {
    const previousProvider = aiConfig.value.provider;
    if (config.provider && config.provider !== previousProvider) {
      Object.assign(aiConfig.value, defaultConfigs[config.provider]);
    }
    Object.assign(aiConfig.value, config);
    api.saveAiConfig(aiConfig.value).catch(() => {});
  }

  function isConfigured(): boolean {
    const preset = AI_PROVIDER_PRESETS[aiConfig.value.provider];
    return !!aiConfig.value.endpoint && !!aiConfig.value.model && (!preset.requiresApiKey || !!aiConfig.value.apiKey);
  }

  function updateEditorSettings(partial: Partial<EditorSettings>) {
    if (partial.fontFamily !== undefined) editorSettings.value.fontFamily = partial.fontFamily;
    if (partial.fontSize !== undefined) editorSettings.value.fontSize = partial.fontSize;
    if (partial.uiScale !== undefined) editorSettings.value.uiScale = normalizeUiScale(partial.uiScale);
    if (partial.theme !== undefined) editorSettings.value.theme = partial.theme;
    if (partial.customThemeColors !== undefined) {
      editorSettings.value.customThemeColors = {
        ...editorSettings.value.customThemeColors,
        ...partial.customThemeColors,
      };
    }
    if (partial.customThemes !== undefined) {
      editorSettings.value.customThemes = Array.isArray(partial.customThemes)
        ? partial.customThemes
        : editorSettings.value.customThemes;
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
    if (partial.wordWrap !== undefined) editorSettings.value.wordWrap = partial.wordWrap;
    if (partial.confirmDangerousSqlExecution !== undefined)
      editorSettings.value.confirmDangerousSqlExecution = partial.confirmDangerousSqlExecution;
    if (partial.compactTabTitle !== undefined) editorSettings.value.compactTabTitle = partial.compactTabTitle;
    if (partial.appLayout !== undefined) editorSettings.value.appLayout = partial.appLayout;
    if (partial.pageSize !== undefined) editorSettings.value.pageSize = normalizeResultPageSize(partial.pageSize);
    if (partial.redisScanPageSize !== undefined) editorSettings.value.redisScanPageSize = partial.redisScanPageSize;
    if (partial.mongoViewMode !== undefined) editorSettings.value.mongoViewMode = partial.mongoViewMode;
    if (partial.showColumnCommentsInHeader !== undefined)
      editorSettings.value.showColumnCommentsInHeader = partial.showColumnCommentsInHeader;
    if (partial.showColumnTypesInHeader !== undefined)
      editorSettings.value.showColumnTypesInHeader = partial.showColumnTypesInHeader;
    if (partial.compactColumnHeaderActions !== undefined)
      editorSettings.value.compactColumnHeaderActions = partial.compactColumnHeaderActions;
    if (partial.dataGridRenderMode !== undefined)
      editorSettings.value.dataGridRenderMode = normalizeDataGridRenderMode(partial.dataGridRenderMode);
    if (partial.structureEditorDensity !== undefined)
      editorSettings.value.structureEditorDensity = normalizeStructureEditorDensity(partial.structureEditorDensity);
    if (partial.tableInfoDrawerWidth !== undefined)
      editorSettings.value.tableInfoDrawerWidth = normalizeDrawerWidth(partial.tableInfoDrawerWidth, 240, 320);
    if (partial.cellDetailDrawerWidth !== undefined)
      editorSettings.value.cellDetailDrawerWidth = normalizeDrawerWidth(partial.cellDetailDrawerWidth, 260, 320);
    if (partial.cellDetailPanelLayout !== undefined)
      editorSettings.value.cellDetailPanelLayout = normalizeCellDetailPanelLayout(partial.cellDetailPanelLayout);
    if (partial.shortcuts !== undefined) editorSettings.value.shortcuts = normalizeShortcutSettings(partial.shortcuts);
    if (partial.sidebarActivation !== undefined) editorSettings.value.sidebarActivation = partial.sidebarActivation;
    if (partial.sidebarObjectDisplay !== undefined)
      editorSettings.value.sidebarObjectDisplay = partial.sidebarObjectDisplay;
    if (partial.autoSelectActiveSidebarNode !== undefined)
      editorSettings.value.autoSelectActiveSidebarNode = partial.autoSelectActiveSidebarNode;
    if (partial.disconnectTabHandlingMode !== undefined)
      editorSettings.value.disconnectTabHandlingMode = normalizeDisconnectTabHandlingMode(
        partial.disconnectTabHandlingMode,
      );
    if (partial.reuseDataTab !== undefined) editorSettings.value.reuseDataTab = partial.reuseDataTab;
    if (partial.updateNotificationsEnabled !== undefined)
      editorSettings.value.updateNotificationsEnabled = partial.updateNotificationsEnabled;
    if (partial.sidebarHiddenTablePrefixes !== undefined)
      editorSettings.value.sidebarHiddenTablePrefixes = normalizeSidebarHiddenTablePrefixes(
        partial.sidebarHiddenTablePrefixes,
      );
    if (partial.sidebarHideTableComments !== undefined)
      editorSettings.value.sidebarHideTableComments = partial.sidebarHideTableComments;
    if (partial.sidebarAllowHorizontalScroll !== undefined)
      editorSettings.value.sidebarAllowHorizontalScroll = partial.sidebarAllowHorizontalScroll;
    if (partial.columnFormatters !== undefined) editorSettings.value.columnFormatters = partial.columnFormatters;
    if (partial.customColumnFormatters !== undefined)
      editorSettings.value.customColumnFormatters = partial.customColumnFormatters;
    if (partial.snippets !== undefined) editorSettings.value.snippets = normalizeSqlSnippets(partial.snippets);
    if (partial.exportBatchSize !== undefined)
      editorSettings.value.exportBatchSize = Math.min(100000, Math.max(100, Math.round(partial.exportBatchSize)));
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

  function upsertCustomColumnFormatter(
    formatter: CustomColumnFormatterConfig,
  ): CustomColumnFormatterConfig | undefined {
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
    aiConfig,
    isAiConfigLoaded,
    initAiConfig,
    updateAiConfig,
    isConfigured,
    editorSettings,
    desktopSettings,
    updateEditorSettings,
    initDesktopSettings,
    updateDesktopSettings,
    updateColumnFormatter,
    upsertCustomColumnFormatter,
    deleteCustomColumnFormatter,
  };
});

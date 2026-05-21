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
import type { SidebarActivation } from "@/lib/treeNodeClick";

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
  | "one-dark"
  | "vscode-dark"
  | "vscode-light"
  | "nord"
  | "okaidia"
  | "material"
  | "duotone-light"
  | "duotone-dark"
  | "xcode";

export interface EditorSettings {
  fontFamily: string;
  fontSize: number;
  theme: EditorTheme;
  executeMode: "all" | "current";
  wordWrap: boolean;
  appLayout: "separated" | "classic";
  pageSize: number;
  redisScanPageSize: number;
  mongoViewMode: "document" | "table";
  shortcuts: ShortcutSettings;
  sidebarActivation: SidebarActivation;
  columnFormatters: Record<string, ColumnFormatterConfig>;
  customColumnFormatters: Record<string, CustomColumnFormatterConfig>;
}

export const EDITOR_THEMES: { value: EditorTheme; label: string; dark: boolean }[] = [
  { value: "one-dark", label: "One Dark", dark: true },
  { value: "vscode-dark", label: "VS Dark+", dark: true },
  { value: "vscode-light", label: "VS Light+", dark: false },
  { value: "nord", label: "Nord", dark: true },
  { value: "okaidia", label: "Okaidia", dark: true },
  { value: "material", label: "Material", dark: true },
  { value: "duotone-light", label: "Duotone Light", dark: false },
  { value: "duotone-dark", label: "Duotone Dark", dark: true },
  { value: "xcode", label: "Xcode", dark: false },
];

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
  theme: "one-dark",
  executeMode: "all",
  wordWrap: false,
  appLayout: "classic",
  pageSize: 100,
  redisScanPageSize: 1000,
  mongoViewMode: "document",
  shortcuts: normalizeShortcutSettings(),
  sidebarActivation: "single",
  columnFormatters: {},
  customColumnFormatters: {},
};

export const STORAGE_KEY = "dbx-editor-settings";
const OLD_FONT_SIZE_KEY = "dbx-query-editor-font-size";

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

export function normalizeEditorSettings(settings: Partial<EditorSettings>): EditorSettings {
  return {
    fontFamily: settings.fontFamily ?? DEFAULT_EDITOR_SETTINGS.fontFamily,
    fontSize: settings.fontSize ?? DEFAULT_EDITOR_SETTINGS.fontSize,
    theme: settings.theme ?? DEFAULT_EDITOR_SETTINGS.theme,
    executeMode: settings.executeMode ?? DEFAULT_EDITOR_SETTINGS.executeMode,
    wordWrap: settings.wordWrap ?? DEFAULT_EDITOR_SETTINGS.wordWrap,
    appLayout: settings.appLayout ?? DEFAULT_EDITOR_SETTINGS.appLayout,
    pageSize: normalizeResultPageSize(settings.pageSize),
    redisScanPageSize: settings.redisScanPageSize ?? DEFAULT_EDITOR_SETTINGS.redisScanPageSize,
    mongoViewMode: settings.mongoViewMode === "table" ? "table" : DEFAULT_EDITOR_SETTINGS.mongoViewMode,
    shortcuts: normalizeShortcutSettings(settings.shortcuts),
    sidebarActivation:
      settings.sidebarActivation === "single" || settings.sidebarActivation === "double"
        ? settings.sidebarActivation
        : DEFAULT_EDITOR_SETTINGS.sidebarActivation,
    columnFormatters: normalizeColumnFormatters(settings.columnFormatters),
    customColumnFormatters: normalizeCustomColumnFormatters(settings.customColumnFormatters),
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

  const editorSettings = ref<EditorSettings>(loadEditorSettings());

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
    const normalizedPartial = {
      ...partial,
      ...(partial.pageSize !== undefined ? { pageSize: normalizeResultPageSize(partial.pageSize) } : {}),
    };
    Object.assign(editorSettings.value, normalizedPartial);
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
    updateEditorSettings,
    updateColumnFormatter,
    upsertCustomColumnFormatter,
    deleteCustomColumnFormatter,
  };
});

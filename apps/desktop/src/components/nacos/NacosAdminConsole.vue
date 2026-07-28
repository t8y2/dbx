<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from "vue";
import { Compartment, type Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { Archive, ArrowLeftRight, CheckCircle2, ChevronDown, Clipboard, Download, FileClock, FileInput, FileText, Loader2, Network, Plus, RefreshCw, Save, Search, Send, Server, Trash2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import NacosConfigDiffDialog from "@/components/nacos/NacosConfigDiffDialog.vue";
import NacosConfigHistoryDialog from "@/components/nacos/NacosConfigHistoryDialog.vue";
import NacosConfigBatchDialog, { type NacosBatchDialogMode, type NacosConfigTransferTarget } from "@/components/nacos/NacosConfigBatchDialog.vue";
import NacosContentSearchDialog from "@/components/nacos/NacosContentSearchDialog.vue";
import { useToast } from "@/composables/useToast";
import { useNacosConfigListColumnResize } from "@/composables/useNacosConfigListColumnResize";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import {
  buildNacosConfigDeleteConfirm,
  buildNacosConfigExportFileName,
  buildNacosConfigHistoryRollbackConfirm,
  buildNacosContentSearchCsv,
  buildNacosInstanceConfirm,
  canStartNacosConfigDelete,
  canStartNacosConfigSave,
  createNacosConfigDeleteSnapshot,
  createNacosConfigSaveSnapshot,
  createNacosLatestRequestGuard,
  createNacosSaveAsCopy,
  isNacosErrorCode,
  isNacosConfigDeleteSnapshotInScope,
  resolveNacosConfigCopyText,
  resolveNacosConfigSaveCompletion,
  type NacosConfigDeleteSnapshot,
} from "@/lib/nacos/nacosAdmin";
import { createNacosNamespaceRequestGuard, subscribeNacosNamespacesChanged, type NacosNamespacesChangedDetail } from "@/lib/nacos/nacosNamespaceCache";
import { copyToClipboard, readTextFromClipboard } from "@/lib/common/clipboard";
import { trimmedSelectionLayer } from "@/lib/editor/codemirrorTrimmedSelectionLayer";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import type {
  NacosBatchPreview,
  NacosBatchReport,
  NacosConfigHistoryItem,
  NacosConfigItem,
  NacosConfigKey,
  NacosConfigSelectionScope,
  NacosConfigSelector,
  NacosConfigTransferRequest,
  NacosConnectionInfo,
  NacosContentMatch,
  NacosContentSearchResult,
  NacosConflictPolicy,
  NacosInstanceInfo,
  NacosNamespaceInfo,
  NacosNamespaceScope,
  NacosSearchProgress,
  NacosServiceInfo,
} from "@/types/nacos";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

const props = defineProps<{
  connectionId: string;
  namespace?: string;
  namespaceName?: string;
  targetDataId?: string;
  targetGroup?: string;
  targetKeyword?: string;
  targetRequestId?: number;
  readOnly?: boolean;
}>();

type AdminTab = "configs" | "services";

const { toast } = useToast();
const { t } = useI18n();
const configWorkbenchId = useId();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { isDark, themePalette } = useTheme();
const activeTab = ref<AdminTab>("configs");
const connectionInfo = ref<NacosConnectionInfo | null>(null);
const connectionError = ref("");
const infoLoading = ref(false);

const configLoading = ref(false);
const configError = ref("");
const configGroup = ref("");
const configDataId = ref("");
const configAppName = ref("");
const configPageNo = ref(1);
const configPageSize = ref(20);
const configs = ref<NacosConfigItem[]>([]);
const configTotal = ref(0);
const selectedConfig = ref<NacosConfigItem | null>(null);
const selectedConfigOriginalKey = ref<NacosConfigKey | null>(null);
const configContent = ref("");
const originalConfigContent = ref("");
const configType = ref("text");
const originalConfigType = ref("text");
const originalConfigMetadata = ref({ appName: "", desc: "", tags: "" });
const savingConfig = ref(false);
const deletingConfig = ref(false);
const configAdvancedOpen = ref(false);
const configSaveNotice = ref("");
const pendingConfigSave = ref(false);
const pendingDeleteConfig = ref<NacosConfigDeleteSnapshot | null>(null);
const historyOpen = ref(false);
const historyLoading = ref(false);
const historyError = ref("");
const historyItems = ref<NacosConfigHistoryItem[]>([]);
const historyPageNo = ref(1);
const historyPageSize = ref(20);
const historyTotal = ref(0);
const historyViewingItem = ref<NacosConfigHistoryItem | null>(null);
const historyViewingContent = ref("");
const historyViewingLoading = ref(false);
const historyCompareOpen = ref(false);
const historyCompareCurrent = ref("");
const historyCompareContent = ref("");
const historyCompareLoading = ref(false);
const historyCompareItem = ref<NacosConfigHistoryItem | null>(null);
const pendingHistoryRollback = ref<NacosConfigHistoryItem | null>(null);
const rollingBackHistory = ref(false);
const rnacosConsoleAuthOpen = ref(false);
const rnacosConsoleCaptchaImage = ref("");
const rnacosConsoleCaptcha = ref("");
const rnacosConsoleAuthError = ref("");
const rnacosConsoleAuthLoading = ref(false);
const rnacosConsoleRetryAction = shallowRef<(() => Promise<void>) | null>(null);
const rnacosConsoleRetryErrorTarget = ref<"config" | "history">("history");
const configFormatOptions = ["text", "json", "xml", "yaml", "html", "properties", "toml"];
const configEditorHost = ref<HTMLDivElement | null>(null);
const configEditorView = shallowRef<EditorView | null>(null);
const configSearchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const knownConfigFormats = ref<Record<string, string>>({});
const selectedConfigKeys = ref<string[]>([]);
const searchOpen = ref(false);
const searchLoading = ref(false);
const searchError = ref("");
const searchResult = ref<NacosContentSearchResult | null>(null);
const searchProgress = ref<NacosSearchProgress | null>(null);
const activeSearchOperationId = ref("");
const searchExportLoading = ref(false);
const searchSessionResetKey = ref(0);
const batchOpen = ref(false);
const batchMode = ref<NacosBatchDialogMode>("export");
const batchLoading = ref(false);
const batchError = ref("");
const batchPreview = ref<NacosBatchPreview | null>(null);
const batchReport = ref<NacosBatchReport | null>(null);
const batchNamespaces = ref<NacosNamespaceInfo[]>([]);
const batchNamespacesRequestGuard = createNacosNamespaceRequestGuard();
const batchTargetConnectionId = ref("");
const batchTargetNamespaces = ref<NacosNamespaceInfo[]>([]);
const batchTargetNamespacesRequestGuard = createNacosNamespaceRequestGuard();
let stopNacosNamespacesChangedListener: (() => void) | null = null;
const importSource = shallowRef<string | File | null>(null);
const importSourceName = ref("");
const configEditorTheme = new Compartment();
const configEditorFontTheme = new Compartment();
const configEditorLanguage = new Compartment();
const configDetailRequestGuard = createNacosLatestRequestGuard();
let configEditorGeneration = 0;
let configEditorSessionId = 0;
let latestConfigSaveRequestId = 0;

const servicesLoading = ref(false);
const servicesError = ref("");
const serviceGroup = ref("");
const serviceName = ref("");
const serviceCluster = ref("");
const servicePageNo = ref(1);
const servicePageSize = ref(20);
const services = ref<NacosServiceInfo[]>([]);
const serviceTotal = ref(0);
const selectedService = ref<NacosServiceInfo | null>(null);
const instances = ref<NacosInstanceInfo[]>([]);
const instancesLoading = ref(false);
const instancesError = ref("");
const updatingInstanceKey = ref("");
const pendingInstanceUpdate = ref<{ instance: NacosInstanceInfo; patch: Partial<NacosInstanceInfo> } | null>(null);

const NACOS_SPLIT_SIZE_KEY = "dbx-nacos-admin-split-size";
const savedNacosSplitSize = Number(safeLocalStorageGet(NACOS_SPLIT_SIZE_KEY));
const nacosSplitSize = ref(savedNacosSplitSize >= 20 && savedNacosSplitSize <= 80 ? savedNacosSplitSize : 42);
const CONNECTION_NOT_FOUND_RETRY_DELAYS_MS = [150, 350, 700];
const configListViewport = ref<HTMLElement | null>(null);
const configListViewportWidth = ref(0);
let configListResizeObserver: ResizeObserver | null = null;
const { gridTemplateColumns: configListGridTemplate, minWidth: configListMinWidth, resizingColumnIndex: configListResizingColumnIndex, onResizeStart: onConfigListColumnResizeStart } = useNacosConfigListColumnResize(configListViewportWidth);

const namespace = computed(() => props.namespace ?? connectionInfo.value?.namespace ?? "");
const batchTargetConnections = computed<NacosConfigTransferTarget[]>(() =>
  connectionStore.connections
    .filter((connection) => connection.db_type === "nacos" && !connection.read_only)
    .map((connection) => {
      const address = [connection.host, connection.port].filter(Boolean).join(":");
      return { id: connection.id, label: connection.name ? `${connection.name} (${address})` : address || connection.id };
    }),
);
const supportsConfigHistory = computed(() => connectionInfo.value?.capabilities.supportsConfigHistory !== false);
const configHistoryUnavailableTitle = computed(() => {
  if (supportsConfigHistory.value) return undefined;
  const reason = connectionInfo.value?.capabilities.historyUnavailableReason;
  if (reason === "historyDisabled") return t("nacos.historyDisabled");
  if (reason === "consoleUrlMissing") return t("nacos.historyConsoleUrlMissing");
  if (reason === "consoleCredentialsMissing") return t("nacos.historyConsoleCredentialsMissing");
  return t("nacos.historyUnavailable");
});
const namespaceLabel = computed(() => props.namespaceName || namespace.value || "public");
const namespaceIdLabel = computed(() => {
  if (!namespace.value || namespace.value === namespaceLabel.value) return "";
  return namespace.value;
});
const configTotalPages = computed(() => Math.max(1, Math.ceil(configTotal.value / Math.max(1, configPageSize.value))));
const serviceTotalPages = computed(() => Math.max(1, Math.ceil(serviceTotal.value / Math.max(1, servicePageSize.value))));
const isCreatingConfig = computed(() => !!selectedConfig.value && !selectedConfigOriginalKey.value);
const isConfigDirty = computed(() => {
  if (!selectedConfig.value) return false;
  return (
    configContent.value !== originalConfigContent.value ||
    configType.value !== originalConfigType.value ||
    (selectedConfig.value.appName || "") !== originalConfigMetadata.value.appName ||
    (selectedConfig.value.desc || "") !== originalConfigMetadata.value.desc ||
    (selectedConfig.value.tags || "") !== originalConfigMetadata.value.tags
  );
});
const configMutationGuardState = computed(() => ({
  readOnly: !!props.readOnly,
  saving: savingConfig.value,
  deleting: deletingConfig.value,
  hasPendingDelete: !!pendingDeleteConfig.value,
  hasPendingSave: pendingConfigSave.value,
}));
const canRequestConfigSave = computed(() => canStartNacosConfigSave(configMutationGuardState.value));
const canRequestConfigDelete = computed(() => canStartNacosConfigDelete(configMutationGuardState.value, selectedConfigOriginalKey.value));
const pendingDeleteDetails = computed(() => (pendingDeleteConfig.value ? buildNacosConfigDeleteConfirm(pendingDeleteConfig.value.config, pendingDeleteConfig.value.key.namespace || "") : ""));
const pendingHistoryRollbackDetails = computed(() => (pendingHistoryRollback.value ? buildNacosConfigHistoryRollbackConfirm(pendingHistoryRollback.value, namespace.value) : ""));
const pendingInstanceDetails = computed(() => (pendingInstanceUpdate.value && selectedService.value ? buildNacosInstanceConfirm(selectedService.value, pendingInstanceUpdate.value.instance, pendingInstanceUpdate.value.patch, serviceGroup.value, namespace.value) : ""));
const selectedConfigCount = computed(() => selectedConfigKeys.value.length);
const hasSearchSession = computed(() => !!(searchResult.value || searchProgress.value || searchError.value));
const retainedSearchMatchCount = computed(() => searchResult.value?.matches.length ?? searchProgress.value?.matches.length ?? 0);
const currentPageConfigKeys = computed(() => configs.value.map((item) => configIdentityKey(item)));
const allCurrentPageSelected = computed(() => currentPageConfigKeys.value.length > 0 && currentPageConfigKeys.value.every((key) => selectedConfigKeys.value.includes(key)));

function configIdentityKey(item: Pick<NacosConfigItem, "namespace" | "group" | "dataId">): string {
  return [item.namespace || namespace.value || "", item.group || "DEFAULT_GROUP", item.dataId].join("\u0000");
}

function toggleConfigSelection(item: NacosConfigItem, checked: boolean) {
  const key = configIdentityKey(item);
  const next = new Set(selectedConfigKeys.value);
  if (checked) next.add(key);
  else next.delete(key);
  selectedConfigKeys.value = [...next];
}

function toggleCurrentPageSelection(checked: boolean) {
  const next = new Set(selectedConfigKeys.value);
  for (const key of currentPageConfigKeys.value) {
    if (checked) next.add(key);
    else next.delete(key);
  }
  selectedConfigKeys.value = [...next];
}

function selectedKeys(): NacosConfigKey[] {
  return selectedConfigKeys.value.map((value) => {
    const [selectedNamespace = "", group = "DEFAULT_GROUP", dataId = ""] = value.split("\u0000");
    return { namespace: selectedNamespace || undefined, group, dataId };
  });
}

function buildConfigSelector(scope: NacosConfigSelectionScope): NacosConfigSelector {
  return {
    namespace: namespace.value,
    scope,
    keys: scope === "selected" ? selectedKeys() : [],
    query:
      scope === "filtered"
        ? {
            namespace: namespace.value || undefined,
            group: configGroup.value.trim() || undefined,
            dataId: configDataId.value.trim() || undefined,
            appName: configAppName.value.trim() || undefined,
          }
        : undefined,
  };
}

function editorThemeAppearance() {
  return isDark.value ? "dark" : "light";
}

function currentCustomThemeColors() {
  const settings = settingsStore.editorSettings;
  if (settings.theme !== "custom") return settings.customThemeColors;
  const activeTheme = settings.customThemes?.find((theme) => theme.id === settings.activeCustomThemeId) || settings.customThemes?.[0];
  return activeTheme?.colors ?? settings.customThemeColors;
}

async function configLanguageExtension(format: string): Promise<Extension[]> {
  switch (format) {
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return [json()];
    }
    case "yaml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return [yaml()];
    }
    case "xml": {
      const { xml } = await import("@codemirror/lang-xml");
      return [xml()];
    }
    case "html": {
      const { html } = await import("@codemirror/lang-html");
      return [html({ matchClosingTags: false })];
    }
    case "properties": {
      const { properties } = await import("@codemirror/legacy-modes/mode/properties");
      return [StreamLanguage.define(properties)];
    }
    case "toml": {
      const { toml } = await import("@codemirror/legacy-modes/mode/toml");
      return [StreamLanguage.define(toml)];
    }
    default:
      return [];
  }
}

async function mountConfigEditor() {
  await nextTick();
  if (!configEditorHost.value || configEditorView.value || !selectedConfig.value) return;
  const generation = ++configEditorGeneration;
  const editorSessionId = configEditorSessionId;
  const host = configEditorHost.value;
  const content = configContent.value;
  const format = configType.value;
  const [{ EditorState, Prec }, { EditorView, keymap }, { basicSetup }, { defaultKeymap, historyKeymap, indentWithTab }, { search: cmSearch }, language] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("codemirror"),
    import("@codemirror/commands"),
    import("@codemirror/search"),
    configLanguageExtension(format),
  ]);
  const editorSettings = settingsStore.editorSettings;
  const theme = await loadEditorTheme(editorSettings.theme, editorThemeAppearance(), currentCustomThemeColors(), themePalette.value);
  if (generation !== configEditorGeneration || editorSessionId !== configEditorSessionId || host !== configEditorHost.value || configEditorView.value || !selectedConfig.value) return;
  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: content,
      extensions: [
        cmSearch({
          top: true,
          createPanel: () => {
            const dom = document.createElement("span");
            dom.style.display = "none";
            return { dom };
          },
        }),
        basicSetup,
        trimmedSelectionLayer(),
        Prec.highest(keymap.of([{ key: "Mod-f", run: () => configSearchPanelRef.value?.openSearch() ?? false, preventDefault: true }, { key: "Mod-h", run: () => configSearchPanelRef.value?.openReplace() ?? false, preventDefault: true }, indentWithTab])),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        configEditorLanguage.of(language),
        configEditorTheme.of(theme),
        configEditorFontTheme.of(editorFontTheme(EditorView, editorSettings.fontSize, editorSettings.fontFamily, { fixedHeight: true, scrollable: true })),
        EditorView.lineWrapping,
        EditorState.readOnly.of(!!props.readOnly),
        EditorView.editable.of(!props.readOnly),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged || generation !== configEditorGeneration || editorSessionId !== configEditorSessionId) return;
          configContent.value = update.state.doc.toString();
          configSaveNotice.value = "";
        }),
        EditorView.theme({
          "&": {
            height: "100%",
          },
          ".cm-scroller": {
            overflow: "auto",
          },
          ".cm-content": {
            minHeight: "100%",
            userSelect: "text",
            WebkitUserSelect: "text",
          },
          ".cm-lineNumbers .cm-gutterElement": {
            padding: "0 10px 0 8px",
          },
        }),
      ],
    }),
  });
  if (generation !== configEditorGeneration || editorSessionId !== configEditorSessionId || host !== configEditorHost.value) {
    view.destroy();
    return;
  }
  configEditorView.value = view;
}

function destroyConfigEditor() {
  configEditorGeneration += 1;
  configEditorView.value?.destroy();
  configEditorView.value = null;
}

async function refreshConfigEditor() {
  destroyConfigEditor();
  await mountConfigEditor();
}

function handleNacosSplitResized(payload: { panes?: { size: number }[] }) {
  const size = payload.panes?.[0]?.size;
  if (typeof size !== "number" || size < 20 || size > 80) return;
  nacosSplitSize.value = size;
  safeLocalStorageSet(NACOS_SPLIT_SIZE_KEY, String(size));
}

function observeConfigListViewport(element: HTMLElement | null) {
  configListResizeObserver?.disconnect();
  configListResizeObserver = null;
  configListViewportWidth.value = element?.clientWidth ?? 0;
  if (!element || typeof ResizeObserver === "undefined") return;
  configListResizeObserver = new ResizeObserver(() => {
    configListViewportWidth.value = element.clientWidth;
  });
  configListResizeObserver.observe(element);
}

function inferConfigFormat(dataId: string): string {
  const ext = dataId.trim().toLowerCase().split(".").pop() || "";
  if (ext === "yml") return "yaml";
  if (["yaml", "json", "xml", "html", "properties", "text"].includes(ext)) return ext;
  if (ext === "txt") return "text";
  return "";
}

function configFormatValue(item: Pick<NacosConfigItem, "dataId" | "configType">): string {
  const value = normalizeConfigFormat(item.configType);
  return value || inferConfigFormat(item.dataId);
}

function normalizeConfigFormat(value?: string): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "txt") return "text";
  if (normalized === "yml") return "yaml";
  if (normalized === "props") return "properties";
  return normalized;
}

function normalizeConfigItemFormat<T extends NacosConfigItem>(item: T): T {
  const value = normalizeConfigFormat(item.configType);
  if (!value || value === item.configType) return item;
  return { ...item, configType: value };
}

function rememberOriginalConfigState(item: NacosConfigItem, content = item.content || "", format = configFormatValue(item) || "text") {
  originalConfigContent.value = content;
  originalConfigType.value = format;
  originalConfigMetadata.value = {
    appName: item.appName || "",
    desc: item.desc || "",
    tags: item.tags || "",
  };
}

function configFormatCacheKey(key: { namespace?: string; dataId: string; group: string }): string {
  return [props.connectionId, key.namespace || namespace.value || "", key.dataId, key.group || "DEFAULT_GROUP"].join("\u0000");
}

function rememberConfigFormat(item: { namespace?: string; dataId: string; group: string; configType?: string }) {
  const value = configFormatValue(item);
  if (!value) return;
  knownConfigFormats.value = {
    ...knownConfigFormats.value,
    [configFormatCacheKey(item)]: value,
  };
}

function applyKnownConfigFormats(items: NacosConfigItem[]): NacosConfigItem[] {
  return items.map((item) => {
    const existingFormat = configFormatValue(item);
    if (existingFormat) {
      rememberConfigFormat({ ...item, configType: existingFormat });
      return item.configType === existingFormat ? item : { ...item, configType: existingFormat };
    }
    const knownFormat = knownConfigFormats.value[configFormatCacheKey(item)];
    return knownFormat ? { ...item, configType: knownFormat } : item;
  });
}

function configFormatDisplayLabel(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return "-";
  if (normalized === "properties") return "Properties";
  return normalized.toUpperCase();
}

function configFormatLabel(item: Pick<NacosConfigItem, "dataId" | "configType">): string {
  return configFormatDisplayLabel(configFormatValue(item));
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isConnectionNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /\bConnection not found\b/i.test(message);
}

function isSameConfigKey(item: NacosConfigItem, key: NacosConfigKey): boolean {
  return (item.namespace || namespace.value || "") === (key.namespace || namespace.value || "") && item.dataId === key.dataId && item.group === key.group;
}

function upsertConfigInList(item: NacosConfigItem) {
  item = normalizeConfigItemFormat(item);
  const key = {
    namespace: item.namespace || namespace.value || undefined,
    dataId: item.dataId,
    group: item.group,
  };
  const existingIndex = configs.value.findIndex((candidate) => isSameConfigKey(candidate, key));
  if (existingIndex >= 0) {
    configs.value.splice(existingIndex, 1, { ...configs.value[existingIndex], ...item });
    return;
  }
  configs.value = [item, ...configs.value];
  configTotal.value = Math.max(configTotal.value, configs.value.length);
}

async function loadInfo() {
  infoLoading.value = true;
  connectionError.value = "";
  try {
    connectionInfo.value = await api.nacosTestConnection(props.connectionId);
  } catch (error) {
    connectionError.value = error instanceof Error ? error.message : String(error);
  } finally {
    infoLoading.value = false;
  }
}

async function loadConfigs(page = configPageNo.value) {
  configLoading.value = true;
  configError.value = "";
  configPageNo.value = page;
  try {
    const result = await api.nacosListConfigs(props.connectionId, {
      namespace: namespace.value || undefined,
      group: configGroup.value.trim() || undefined,
      dataId: configDataId.value.trim() || undefined,
      appName: configAppName.value.trim() || undefined,
      pageNo: configPageNo.value,
      pageSize: configPageSize.value,
    });
    configs.value = applyKnownConfigFormats(result.items.map(normalizeConfigItemFormat));
    configTotal.value = result.totalCount;
  } catch (error) {
    await handleRNacosConsoleError(error, () => loadConfigs(page), "config");
  } finally {
    configLoading.value = false;
  }
}

async function loadConfigsWithRetry(page = configPageNo.value) {
  for (let attempt = 0; ; attempt += 1) {
    await loadConfigs(page);
    if (!isConnectionNotFoundError(configError.value) || attempt >= CONNECTION_NOT_FOUND_RETRY_DELAYS_MS.length) return;
    await delay(CONNECTION_NOT_FOUND_RETRY_DELAYS_MS[attempt]);
  }
}

function closePendingConfigMutationConfirmations() {
  pendingConfigSave.value = false;
  if (!deletingConfig.value) pendingDeleteConfig.value = null;
}

async function selectConfig(item: NacosConfigItem) {
  closePendingConfigMutationConfirmations();
  const detailRequestId = configDetailRequestGuard.begin();
  configEditorSessionId += 1;
  const listItemHadFormat = !!configFormatValue(item);
  destroyConfigEditor();
  configSaveNotice.value = "";
  selectedConfigOriginalKey.value = {
    namespace: item.namespace || namespace.value || undefined,
    dataId: item.dataId,
    group: item.group,
  };
  selectedConfig.value = { ...item };
  configContent.value = item.content || "";
  configType.value = configFormatValue(item) || "text";
  rememberOriginalConfigState(item, configContent.value, configType.value);
  try {
    const detail = await api.nacosGetConfig(props.connectionId, {
      namespace: item.namespace || namespace.value || undefined,
      dataId: item.dataId,
      group: item.group,
    });
    if (!configDetailRequestGuard.isCurrent(detailRequestId)) return;
    const normalizedDetail = normalizeConfigItemFormat(detail);
    selectedConfig.value = normalizedDetail;
    selectedConfigOriginalKey.value = {
      namespace: normalizedDetail.namespace || item.namespace || namespace.value || undefined,
      dataId: normalizedDetail.dataId || item.dataId,
      group: normalizedDetail.group || item.group,
    };
    rememberConfigFormat({
      ...normalizedDetail,
      namespace: selectedConfigOriginalKey.value.namespace,
      dataId: selectedConfigOriginalKey.value.dataId,
      group: selectedConfigOriginalKey.value.group,
    });
    upsertConfigInList({
      ...normalizedDetail,
      namespace: selectedConfigOriginalKey.value.namespace || "",
      dataId: selectedConfigOriginalKey.value.dataId,
      group: selectedConfigOriginalKey.value.group,
    });
    configContent.value = normalizedDetail.content || "";
    configType.value = configFormatValue(normalizedDetail) || configFormatValue(item) || "text";
    rememberOriginalConfigState(normalizedDetail, configContent.value, configType.value);
    await refreshConfigEditor();
    if (!listItemHadFormat && configFormatValue(normalizedDetail)) {
      await loadConfigs(configPageNo.value);
    }
  } catch (error) {
    if (!configDetailRequestGuard.isCurrent(detailRequestId)) return;
    await handleRNacosConsoleError(error, () => selectConfig(item), "config");
    await refreshConfigEditor();
  }
}

function newConfig() {
  closePendingConfigMutationConfirmations();
  configDetailRequestGuard.invalidate();
  configEditorSessionId += 1;
  destroyConfigEditor();
  configSaveNotice.value = "";
  selectedConfigOriginalKey.value = null;
  selectedConfig.value = {
    namespace: namespace.value,
    dataId: configDataId.value.trim(),
    group: configGroup.value.trim() || "DEFAULT_GROUP",
    configType: inferConfigFormat(configDataId.value) || "text",
    content: "",
    appName: "",
    desc: "",
    tags: "",
  };
  configContent.value = "";
  configType.value = selectedConfig.value.configType || "text";
  rememberOriginalConfigState(selectedConfig.value, "", configType.value);
  configAdvancedOpen.value = false;
  void mountConfigEditor();
}

function saveConfigAsCopy() {
  if (!selectedConfig.value) return;
  closePendingConfigMutationConfirmations();
  configDetailRequestGuard.invalidate();
  configEditorSessionId += 1;
  const copy = createNacosSaveAsCopy({ ...selectedConfig.value, content: configContent.value, configType: configType.value });
  destroyConfigEditor();
  selectedConfigOriginalKey.value = null;
  selectedConfig.value = copy;
  configContent.value = copy.content || "";
  originalConfigContent.value = "";
  configType.value = copy.configType || configType.value || "text";
  originalConfigType.value = configType.value;
  originalConfigMetadata.value = {
    appName: copy.appName || "",
    desc: copy.desc || "",
    tags: copy.tags || "",
  };
  configSaveNotice.value = "";
  void mountConfigEditor();
}

async function copyConfigIdentity() {
  if (!selectedConfig.value) return;
  const view = configEditorView.value;
  const selection = view?.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) || "";
  const text = resolveNacosConfigCopyText(selection, view?.state.doc.toString(), configContent.value);
  try {
    await copyToClipboard(text);
    try {
      const copiedText = await readTextFromClipboard();
      if (copiedText !== text) {
        throw new Error(t("nacos.copyVerifyFailed"));
      }
    } catch (verifyError) {
      if (isTauriRuntime()) throw verifyError;
    }
    toast(t("nacos.copied"), 2000);
  } catch (error) {
    toast(t("grid.copyFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  }
}

async function downloadConfigText(content: string, fileName: string, mimeType = "text/plain;charset=utf-8") {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportConfig() {
  if (!selectedConfig.value) return;
  const item = { ...selectedConfig.value, configType: configType.value };
  const fileName = buildNacosConfigExportFileName(item);
  try {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: fileName,
        filters: [{ name: configFormatDisplayLabel(configType.value || item.configType || "text"), extensions: [fileName.split(".").pop() || "txt"] }],
      });
      if (!path) return;
      await writeTextFile(path, configContent.value);
      toast(t("nacos.exportedTo", { path }), 2000);
      return;
    }
    await downloadConfigText(configContent.value, fileName);
    toast(t("nacos.exported"), 2000);
  } catch (error) {
    toast(t("nacos.exportFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  }
}

function createOperationId(prefix: string): string {
  const suffix = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${suffix}`;
}

async function searchConfigContent(payload: { query: string; scope: NacosNamespaceScope }) {
  const operationId = createOperationId("nacos-search");
  activeSearchOperationId.value = operationId;
  searchLoading.value = true;
  searchError.value = "";
  searchResult.value = null;
  searchProgress.value = null;
  const accumulatedMatches = new Map<string, NacosContentMatch>();
  const accumulatedFailures = new Map<string, string>();
  try {
    const result = await api.nacosSearchConfigContent(
      props.connectionId,
      {
        operationId,
        namespace: namespace.value || undefined,
        scope: payload.scope,
        query: payload.query,
        group: configGroup.value.trim() || undefined,
        dataId: configDataId.value.trim() || undefined,
        maxResults: 10_000,
      },
      (progress) => {
        if (progress.operationId !== activeSearchOperationId.value) return;
        for (const match of progress.matches) accumulatedMatches.set(configIdentityKey(match), match);
        for (const failure of progress.failures) accumulatedFailures.set(failure.namespace, failure.error);
        searchProgress.value = {
          ...progress,
          matches: [...accumulatedMatches.values()],
          failures: [...accumulatedFailures].map(([failedNamespace, error]) => ({ namespace: failedNamespace, error })),
        };
      },
    );
    if (activeSearchOperationId.value === operationId && searchOpen.value) searchResult.value = result;
  } catch (error) {
    if (activeSearchOperationId.value === operationId && searchOpen.value) searchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (activeSearchOperationId.value === operationId) {
      searchLoading.value = false;
      activeSearchOperationId.value = "";
    }
  }
}

async function cancelConfigContentSearch() {
  if (!activeSearchOperationId.value) return;
  try {
    await api.nacosCancelConfigContentSearch(activeSearchOperationId.value);
  } catch (error) {
    searchError.value = error instanceof Error ? error.message : String(error);
  }
}

function clearContentSearchSession() {
  const operationId = activeSearchOperationId.value;
  activeSearchOperationId.value = "";
  searchLoading.value = false;
  searchResult.value = null;
  searchProgress.value = null;
  searchError.value = "";
  searchSessionResetKey.value += 1;
  if (operationId) void api.nacosCancelConfigContentSearch(operationId);
}

async function exportContentSearchResults() {
  const matches = searchResult.value?.matches ?? searchProgress.value?.matches ?? [];
  if (!matches.length || searchExportLoading.value) return;
  searchExportLoading.value = true;
  const content = buildNacosContentSearchCsv(matches);
  const fileName = "nacos-content-search-results.csv";
  try {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: fileName,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (!path) return;
      await writeTextFile(path, content);
      toast(t("nacos.searchResultsExportedTo", { path }), 2500);
      return;
    }
    await downloadConfigText(content, fileName, "text/csv;charset=utf-8");
    toast(t("nacos.searchResultsExported"), 2500);
  } catch (error) {
    toast(t("nacos.exportFailed", { message: error instanceof Error ? error.message : String(error) }), 5000);
  } finally {
    searchExportLoading.value = false;
  }
}

async function focusConfigKeyword(keyword?: string) {
  if (!keyword) return;
  await nextTick();
  const view = configEditorView.value;
  if (!view) return;
  const content = view.state.doc.toString();
  const from = content.indexOf(keyword);
  if (from < 0) return;
  view.dispatch({ selection: { anchor: from, head: from + keyword.length }, scrollIntoView: true });
  configSearchPanelRef.value?.openSearch();
}

async function openTargetConfig(dataId: string, group: string, keyword?: string) {
  try {
    await selectConfig({
      namespace: namespace.value,
      dataId,
      group: group || "DEFAULT_GROUP",
    });
    await focusConfigKeyword(keyword);
  } finally {
    if (props.targetRequestId !== undefined) queryStore.clearNacosNavigationTarget(props.connectionId, namespace.value, props.targetRequestId);
  }
}

async function navigateToContentMatch(match: NacosContentMatch, keyword: string) {
  const targetNamespace = match.namespace || "";
  if (targetNamespace === namespace.value) {
    searchOpen.value = false;
    await openTargetConfig(match.dataId, match.group, keyword);
    return;
  }
  const namespaceInfo = batchNamespaces.value.find((item) => item.namespace === targetNamespace);
  queryStore.openNacosAdmin(props.connectionId, {
    namespace: targetNamespace,
    namespaceName: namespaceInfo?.namespaceShowName || targetNamespace || "public",
    dataId: match.dataId,
    group: match.group,
    keyword,
  });
}

async function loadBatchNamespaces(options: { force?: boolean } = {}) {
  if (!options.force && batchNamespaces.value.length) return;
  const connectionId = props.connectionId;
  const requestId = batchNamespacesRequestGuard.start(connectionId);
  try {
    const namespaces = await api.nacosListNamespaces(connectionId);
    if (!batchNamespacesRequestGuard.isCurrent(requestId, props.connectionId)) return;
    batchNamespaces.value = namespaces;
  } catch (error) {
    if (!batchNamespacesRequestGuard.isCurrent(requestId, props.connectionId)) return;
    batchError.value = error instanceof Error ? error.message : String(error);
  }
}

async function loadBatchTargetNamespaces(connectionId: string, options: { force?: boolean } = {}) {
  if (!connectionId) return;
  if (!options.force && batchTargetConnectionId.value === connectionId && batchTargetNamespaces.value.length) return;
  const requestId = batchTargetNamespacesRequestGuard.start(connectionId);
  try {
    const namespaces = await api.nacosListNamespaces(connectionId);
    if (!batchTargetNamespacesRequestGuard.isCurrent(requestId, connectionId) || batchTargetConnectionId.value !== connectionId) return;
    batchTargetNamespaces.value = namespaces;
  } catch (error) {
    if (!batchTargetNamespacesRequestGuard.isCurrent(requestId, connectionId) || batchTargetConnectionId.value !== connectionId) return;
    batchError.value = error instanceof Error ? error.message : String(error);
  }
}

function invalidateBatchNamespaces(refreshOpenDialog = true) {
  batchNamespacesRequestGuard.invalidate();
  batchNamespaces.value = [];
  if (refreshOpenDialog && ((batchOpen.value && batchMode.value === "copy") || searchOpen.value)) {
    void loadBatchNamespaces({ force: true });
  }
}

function invalidateBatchTargetNamespaces(connectionId: string, refreshOpenDialog = true) {
  if (batchTargetConnectionId.value !== connectionId) return;
  batchTargetNamespacesRequestGuard.invalidate();
  batchTargetNamespaces.value = [];
  if (refreshOpenDialog && batchOpen.value && batchMode.value === "copy") {
    void loadBatchTargetNamespaces(connectionId, { force: true });
  }
}

function handleNacosNamespacesChanged(detail: NacosNamespacesChangedDetail) {
  if (detail.connectionId === props.connectionId) invalidateBatchNamespaces();
  invalidateBatchTargetNamespaces(detail.connectionId);
}

async function openSearchDialog() {
  searchOpen.value = true;
  await loadBatchNamespaces();
}

async function openBatchDialog(mode: NacosBatchDialogMode) {
  batchMode.value = mode;
  resetBatchDialogState();
  if (mode === "import") {
    importSource.value = null;
    importSourceName.value = "";
  }
  batchOpen.value = true;
  if (mode === "copy") {
    const currentConnectionIsWritable = batchTargetConnections.value.some((connection) => connection.id === props.connectionId);
    const targetConnectionId = currentConnectionIsWritable ? props.connectionId : (batchTargetConnections.value[0]?.id ?? "");
    batchTargetConnectionId.value = targetConnectionId;
    batchTargetNamespaces.value = [];
    batchTargetNamespacesRequestGuard.invalidate();
    if (targetConnectionId) await loadBatchTargetNamespaces(targetConnectionId, { force: true });
  }
}

async function selectBatchTargetConnection(connectionId: string) {
  if (connectionId === batchTargetConnectionId.value) return;
  batchTargetConnectionId.value = connectionId;
  batchTargetNamespaces.value = [];
  batchTargetNamespacesRequestGuard.invalidate();
  resetBatchDialogState();
  await loadBatchTargetNamespaces(connectionId, { force: true });
}

function resetBatchDialogState() {
  batchPreview.value = null;
  batchReport.value = null;
  batchError.value = "";
}

async function chooseImportArchive() {
  if (isTauriRuntime()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({ multiple: false, directory: false, filters: [{ name: "Nacos ZIP", extensions: ["zip"] }] });
    if (typeof selected !== "string") return;
    importSource.value = selected;
    importSourceName.value = selected.split(/[\\/]/).pop() || selected;
  } else {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,application/zip";
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      importSource.value = file;
      importSourceName.value = file.name;
    };
    input.click();
  }
  resetBatchDialogState();
}

async function exportConfigArchive(scope: NacosConfigSelectionScope) {
  batchLoading.value = true;
  batchError.value = "";
  const fileName = `${namespaceLabel.value || "public"}-nacos-configs.zip`;
  try {
    let destination = "";
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      destination =
        (await save({
          defaultPath: fileName,
          filters: [{ name: "ZIP Archive", extensions: ["zip"] }],
        })) || "";
      if (!destination) return;
    }
    await api.nacosExportConfigs(props.connectionId, buildConfigSelector(scope), destination, fileName);
    toast(destination ? t("nacos.exportedTo", { path: destination }) : t("nacos.exported"), 2500);
    batchOpen.value = false;
  } catch (error) {
    batchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    batchLoading.value = false;
  }
}

const batchTransferRequest = shallowRef<NacosConfigTransferRequest | null>(null);

async function previewBatch(payload: { scope: NacosConfigSelectionScope; targetConnectionId: string; targetNamespace: string; policy: NacosConflictPolicy }) {
  batchLoading.value = true;
  batchError.value = "";
  batchPreview.value = null;
  batchReport.value = null;
  try {
    if (batchMode.value === "import") {
      if (!importSource.value) throw new Error(t("nacos.noArchiveSelected"));
      batchPreview.value = await api.nacosPreviewConfigImport(props.connectionId, namespace.value, importSource.value);
    } else {
      const req: NacosConfigTransferRequest = {
        operationId: createOperationId("nacos-copy-preview"),
        sourceConnectionId: props.connectionId,
        targetConnectionId: payload.targetConnectionId,
        source: buildConfigSelector(payload.scope),
        targetNamespace: payload.targetNamespace,
        conflictPolicy: payload.policy,
      };
      batchTransferRequest.value = req;
      batchPreview.value = await api.nacosPreviewConfigTransfer(req);
    }
  } catch (error) {
    batchError.value = error instanceof Error ? error.message : String(error);
  } finally {
    batchLoading.value = false;
  }
}

async function applyBatch(payload: { scope: NacosConfigSelectionScope; targetConnectionId: string; targetNamespace: string; policy: NacosConflictPolicy }) {
  if (batchLoading.value || batchReport.value || !batchPreview.value) return;
  if (payload.policy === "OVERWRITE" && !window.confirm(t("nacos.overwriteConfirm"))) return;
  batchLoading.value = true;
  batchError.value = "";
  try {
    if (batchMode.value === "import") {
      if (!importSource.value) throw new Error(t("nacos.noArchiveSelected"));
      batchReport.value = await api.nacosApplyConfigImport(props.connectionId, createOperationId("nacos-import"), namespace.value, importSource.value, batchPreview.value.planHash, payload.policy, batchPreview.value.archiveToken);
    } else {
      if (!batchTransferRequest.value) throw new Error(t("nacos.previewExpired"));
      const req = { ...batchTransferRequest.value, operationId: createOperationId("nacos-copy"), conflictPolicy: payload.policy };
      batchReport.value = await api.nacosApplyConfigTransfer(req, batchPreview.value.planHash);
    }
    batchPreview.value = null;
    batchTransferRequest.value = null;
    selectedConfigKeys.value = [];
    await loadConfigsWithRetry(1);
  } catch (error) {
    if (isNacosErrorCode(error, "stalePreview")) {
      batchPreview.value = null;
      batchTransferRequest.value = null;
      batchError.value = t("nacos.previewExpired");
    } else {
      batchError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    batchLoading.value = false;
  }
}

function historyKeyFor(item: NacosConfigHistoryItem) {
  return {
    namespace: item.namespace || namespace.value || undefined,
    dataId: item.dataId,
    group: item.group,
    historyId: item.historyId,
    nid: item.nid,
  };
}

async function openConfigHistory() {
  if (!selectedConfigOriginalKey.value || !selectedConfig.value || !supportsConfigHistory.value) return;
  historyOpen.value = true;
  await loadConfigHistory(1);
}

async function loadConfigHistory(page = historyPageNo.value) {
  if (!selectedConfigOriginalKey.value) return;
  historyLoading.value = true;
  historyError.value = "";
  historyPageNo.value = page;
  try {
    const result = await api.nacosListConfigHistory(props.connectionId, {
      ...selectedConfigOriginalKey.value,
      pageNo: historyPageNo.value,
      pageSize: historyPageSize.value,
    });
    historyItems.value = result.items;
    historyTotal.value = result.totalCount;
  } catch (error) {
    await handleRNacosConsoleError(error, () => loadConfigHistory(historyPageNo.value), "history");
  } finally {
    historyLoading.value = false;
  }
}

function setRNacosConsoleActionError(target: "config" | "history", message: string) {
  if (target === "config") configError.value = message;
  else historyError.value = message;
}

async function handleRNacosConsoleError(error: unknown, retryAction: () => Promise<void>, target: "config" | "history") {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.includes("[rnacosConsoleCaptchaRequired]")) {
    setRNacosConsoleActionError(target, message);
    return false;
  }
  rnacosConsoleRetryAction.value = retryAction;
  rnacosConsoleRetryErrorTarget.value = target;
  await requestRNacosConsoleAuthentication();
  return true;
}

function retryRNacosConsoleAction() {
  const retryAction = rnacosConsoleRetryAction.value;
  rnacosConsoleRetryAction.value = null;
  rnacosConsoleRetryErrorTarget.value = "history";
  // Run after the failed action has finished its own catch/finally cleanup;
  // otherwise that stale cleanup can close or clear the successfully retried UI.
  setTimeout(() => void (retryAction ? retryAction() : loadConfigHistory(historyPageNo.value)), 0);
}

function rnacosCaptchaImageSource(image: string) {
  return image.startsWith("data:") ? image : `data:image/png;base64,${image}`;
}

async function requestRNacosConsoleAuthentication() {
  rnacosConsoleAuthError.value = "";
  rnacosConsoleCaptcha.value = "";
  rnacosConsoleAuthLoading.value = true;
  try {
    const challenge = await api.nacosGetRNacosConsoleCaptcha(props.connectionId);
    if (!challenge.required) {
      await api.nacosLoginRNacosConsole(props.connectionId);
      void loadInfo();
      retryRNacosConsoleAction();
      return;
    }
    if (!challenge.image) throw new Error(t("nacos.rnacosCaptchaUnavailable"));
    rnacosConsoleCaptchaImage.value = rnacosCaptchaImageSource(challenge.image);
    rnacosConsoleAuthOpen.value = true;
  } catch (error) {
    setRNacosConsoleActionError(rnacosConsoleRetryErrorTarget.value, error instanceof Error ? error.message : String(error));
  } finally {
    rnacosConsoleAuthLoading.value = false;
  }
}

async function submitRNacosConsoleAuthentication() {
  if (!rnacosConsoleCaptcha.value.trim()) {
    rnacosConsoleAuthError.value = t("nacos.rnacosCaptchaRequired");
    return;
  }
  rnacosConsoleAuthLoading.value = true;
  rnacosConsoleAuthError.value = "";
  try {
    await api.nacosLoginRNacosConsole(props.connectionId, rnacosConsoleCaptcha.value);
    rnacosConsoleAuthOpen.value = false;
    void loadInfo();
    retryRNacosConsoleAction();
  } catch (error) {
    rnacosConsoleAuthError.value = error instanceof Error ? error.message : String(error);
  } finally {
    rnacosConsoleAuthLoading.value = false;
  }
}

async function loadHistoryDetail(item: NacosConfigHistoryItem): Promise<NacosConfigItem | null> {
  try {
    return await api.nacosGetConfigHistory(props.connectionId, historyKeyFor(item));
  } catch (error) {
    await handleRNacosConsoleError(error, () => viewConfigHistory(item), "history");
    return null;
  }
}

async function viewConfigHistory(item: NacosConfigHistoryItem) {
  historyViewingItem.value = null;
  await nextTick();
  historyViewingItem.value = item;
  historyViewingContent.value = "";
  historyViewingLoading.value = true;
  const detail = await loadHistoryDetail(item);
  historyViewingContent.value = detail?.content || "";
  historyViewingLoading.value = false;
}

function closeHistoryDetail() {
  historyViewingItem.value = null;
  historyViewingContent.value = "";
  historyViewingLoading.value = false;
}

async function compareConfigHistory(item: NacosConfigHistoryItem) {
  if (!selectedConfigOriginalKey.value) return;
  historyCompareLoading.value = true;
  historyCompareOpen.value = true;
  historyCompareItem.value = item;
  historyCompareCurrent.value = "";
  historyCompareContent.value = "";
  try {
    const [current, history] = await Promise.all([api.nacosGetConfig(props.connectionId, selectedConfigOriginalKey.value), api.nacosGetConfigHistory(props.connectionId, historyKeyFor(item))]);
    historyCompareCurrent.value = current.content || "";
    historyCompareContent.value = history.content || "";
  } catch (error) {
    await handleRNacosConsoleError(error, () => compareConfigHistory(item), "history");
    historyCompareOpen.value = false;
  } finally {
    historyCompareLoading.value = false;
  }
}

function requestRollbackComparedHistory() {
  if (!historyCompareItem.value || props.readOnly) return;
  historyCompareOpen.value = false;
  requestRollbackHistory(historyCompareItem.value);
}

function requestRollbackHistory(item: NacosConfigHistoryItem) {
  if (props.readOnly) return;
  pendingHistoryRollback.value = item;
}

async function rollbackConfigHistory() {
  if (!pendingHistoryRollback.value || props.readOnly) return;
  rollingBackHistory.value = true;
  try {
    await api.nacosRollbackConfig(props.connectionId, historyKeyFor(pendingHistoryRollback.value));
    pendingHistoryRollback.value = null;
    configSaveNotice.value = t("nacos.rollbackSuccess");
    if (selectedConfigOriginalKey.value) {
      const detail = await api.nacosGetConfig(props.connectionId, selectedConfigOriginalKey.value);
      const normalizedDetail = normalizeConfigItemFormat(detail);
      selectedConfig.value = normalizedDetail;
      configContent.value = normalizedDetail.content || "";
      configType.value = configFormatValue(normalizedDetail) || "text";
      rememberOriginalConfigState(normalizedDetail, configContent.value, configType.value);
      await refreshConfigEditor();
    }
    await Promise.all([loadConfigs(configPageNo.value), loadConfigHistory(historyPageNo.value)]);
  } catch (error) {
    await handleRNacosConsoleError(error, () => rollbackConfigHistory(), "history");
  } finally {
    rollingBackHistory.value = false;
  }
}

async function setConfigFormat(format: string) {
  configType.value = format;
  if (selectedConfig.value) selectedConfig.value.configType = format;
  if (selectedConfigOriginalKey.value) rememberConfigFormat({ ...selectedConfigOriginalKey.value, configType: format });
  configSaveNotice.value = "";
  await refreshConfigEditor();
}

function requestSaveConfig() {
  if (!selectedConfig.value || !canRequestConfigSave.value) return;
  if (!isCreatingConfig.value && configContent.value !== originalConfigContent.value) {
    pendingConfigSave.value = true;
    return;
  }
  void saveConfig();
}

async function saveConfig() {
  if (!selectedConfig.value || !canRequestConfigSave.value) return;
  pendingConfigSave.value = false;
  const requestId = ++latestConfigSaveRequestId;
  const snapshot = createNacosConfigSaveSnapshot({
    requestId,
    editorSessionId: configEditorSessionId,
    connectionId: props.connectionId,
    fallbackNamespace: namespace.value,
    originalKey: selectedConfigOriginalKey.value,
    config: selectedConfig.value,
    content: configContent.value,
    configType: configType.value,
  });
  if (!snapshot.targetKey.dataId) {
    configError.value = t("nacos.dataIdRequired");
    return;
  }
  const pageAtRequest = configPageNo.value;
  savingConfig.value = true;
  configError.value = "";
  configSaveNotice.value = "";
  try {
    await api.nacosPublishConfig(snapshot.connectionId, {
      namespace: snapshot.targetKey.namespace,
      dataId: snapshot.targetKey.dataId,
      group: snapshot.targetKey.group,
      content: snapshot.content,
      configType: snapshot.configType || undefined,
      appName: snapshot.config.appName,
      desc: snapshot.config.desc,
      tags: snapshot.config.tags,
    });
    toast(t("nacos.saved"), 2000);
    const remainsInSnapshotScope = requestId === latestConfigSaveRequestId && props.connectionId === snapshot.connectionId && (namespace.value || "") === (snapshot.targetKey.namespace || "");
    if (remainsInSnapshotScope) {
      await loadConfigsWithRetry(snapshot.wasCreating ? 1 : pageAtRequest);
      rememberConfigFormat(snapshot.config);
      upsertConfigInList(snapshot.config);
    }
    const currentEditorState = {
      latestRequestId: latestConfigSaveRequestId,
      editorSessionId: configEditorSessionId,
      connectionId: props.connectionId,
      originalKey: selectedConfigOriginalKey.value,
      config: selectedConfig.value,
      content: configContent.value,
      configType: configType.value,
    };
    const completion = resolveNacosConfigSaveCompletion(snapshot, currentEditorState);
    if (completion.kind !== "stale") {
      rememberOriginalConfigState(completion.savedConfig, completion.baseline.content, completion.baseline.configType);
      selectedConfigOriginalKey.value = completion.originalKey;
      if (completion.kind === "saved") {
        selectedConfig.value = completion.savedConfig;
        configAdvancedOpen.value = false;
        configSaveNotice.value = t(snapshot.wasCreating ? "nacos.createdAndLoaded" : "nacos.savedAndLoaded", { dataId: snapshot.targetKey.dataId });
      } else {
        configSaveNotice.value = "";
      }
    }
  } catch (error) {
    if (requestId === latestConfigSaveRequestId && snapshot.editorSessionId === configEditorSessionId && snapshot.connectionId === props.connectionId) {
      configError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (requestId === latestConfigSaveRequestId) savingConfig.value = false;
  }
}

function requestDeleteConfig() {
  const key = selectedConfigOriginalKey.value;
  if (!selectedConfig.value || !key || !canRequestConfigDelete.value) return;
  pendingDeleteConfig.value = createNacosConfigDeleteSnapshot(props.connectionId, key, selectedConfig.value);
}

async function deleteConfig() {
  const snapshot = pendingDeleteConfig.value;
  if (!snapshot || !isNacosConfigDeleteSnapshotInScope(snapshot, props.connectionId, namespace.value)) {
    pendingDeleteConfig.value = null;
    return;
  }
  if (
    !canStartNacosConfigDelete(
      {
        ...configMutationGuardState.value,
        hasPendingDelete: false,
      },
      snapshot.key,
    )
  )
    return;
  const editorSessionId = configEditorSessionId;
  pendingDeleteConfig.value = null;
  deletingConfig.value = true;
  configError.value = "";
  configSaveNotice.value = "";
  try {
    await api.nacosDeleteConfig(snapshot.connectionId, snapshot.key);
    const remainsInDeletedScope = isNacosConfigDeleteSnapshotInScope(snapshot, props.connectionId, namespace.value);
    if (remainsInDeletedScope) await loadConfigs();
    const stillViewingDeletedConfig =
      remainsInDeletedScope &&
      editorSessionId === configEditorSessionId &&
      selectedConfigOriginalKey.value?.dataId === snapshot.key.dataId &&
      (selectedConfigOriginalKey.value?.group || "DEFAULT_GROUP") === snapshot.key.group &&
      (selectedConfigOriginalKey.value?.namespace || "") === (snapshot.key.namespace || "");
    if (stillViewingDeletedConfig) {
      configDetailRequestGuard.invalidate();
      configEditorSessionId += 1;
      selectedConfig.value = null;
      selectedConfigOriginalKey.value = null;
      configContent.value = "";
      originalConfigContent.value = "";
      destroyConfigEditor();
    }
    toast(t("nacos.deleted"), 2000);
  } catch (error) {
    if (isNacosConfigDeleteSnapshotInScope(snapshot, props.connectionId, namespace.value)) configError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deletingConfig.value = false;
  }
}

async function loadServices(page = servicePageNo.value) {
  servicesLoading.value = true;
  servicesError.value = "";
  servicePageNo.value = page;
  try {
    const result = await api.nacosListServices(props.connectionId, {
      namespace: namespace.value || undefined,
      groupName: serviceGroup.value.trim() || undefined,
      serviceName: serviceName.value.trim() || undefined,
      pageNo: servicePageNo.value,
      pageSize: servicePageSize.value,
    });
    services.value = result.items;
    serviceTotal.value = result.totalCount;
  } catch (error) {
    servicesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    servicesLoading.value = false;
  }
}

async function loadServicesWithRetry(page = servicePageNo.value) {
  for (let attempt = 0; ; attempt += 1) {
    await loadServices(page);
    if (!isConnectionNotFoundError(servicesError.value) || attempt >= CONNECTION_NOT_FOUND_RETRY_DELAYS_MS.length) return;
    await delay(CONNECTION_NOT_FOUND_RETRY_DELAYS_MS[attempt]);
  }
}

async function selectService(service: NacosServiceInfo) {
  selectedService.value = service;
  await loadInstances();
}

async function loadInstances() {
  if (!selectedService.value) return;
  instancesLoading.value = true;
  instancesError.value = "";
  try {
    instances.value = await api.nacosListInstances(props.connectionId, {
      namespace: namespace.value || undefined,
      serviceName: selectedService.value.serviceName,
      groupName: selectedService.value.groupName || serviceGroup.value || undefined,
      clusters: serviceCluster.value.trim() || undefined,
    });
  } catch (error) {
    instancesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    instancesLoading.value = false;
  }
}

function requestUpdateInstance(instance: NacosInstanceInfo, patch: Partial<NacosInstanceInfo>) {
  if (!selectedService.value || props.readOnly) return;
  pendingInstanceUpdate.value = { instance, patch };
}

async function updateInstance(instance: NacosInstanceInfo, patch: Partial<NacosInstanceInfo>) {
  if (!selectedService.value || props.readOnly) return;
  updatingInstanceKey.value = `${instance.ip}:${instance.port}`;
  try {
    await api.nacosUpdateInstance(props.connectionId, {
      namespace: namespace.value || undefined,
      serviceName: selectedService.value.serviceName,
      groupName: instance.groupName || selectedService.value.groupName || serviceGroup.value || undefined,
      clusterName: instance.clusterName,
      ip: instance.ip,
      port: instance.port,
      healthy: patch.healthy ?? instance.healthy,
      enabled: patch.enabled ?? instance.enabled,
      ephemeral: patch.ephemeral ?? instance.ephemeral,
      weight: patch.weight ?? instance.weight,
      metadata: instance.metadata,
    });
    pendingInstanceUpdate.value = null;
    await loadInstances();
  } catch (error) {
    instancesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    updatingInstanceKey.value = "";
  }
}

watch(historyCompareOpen, (value) => {
  if (!value && !historyCompareLoading.value) historyCompareItem.value = null;
});

watch(searchOpen, (value) => {
  if (value) return;
  const operationId = activeSearchOperationId.value;
  activeSearchOperationId.value = "";
  searchLoading.value = false;
  if (operationId) void api.nacosCancelConfigContentSearch(operationId);
});

watch(configListViewport, observeConfigListViewport, { flush: "post" });

watch(
  () => props.targetRequestId,
  () => {
    if (props.targetDataId) void openTargetConfig(props.targetDataId, props.targetGroup || "DEFAULT_GROUP", props.targetKeyword);
  },
);

watch(
  [() => settingsStore.editorSettings, () => isDark.value, () => themePalette.value],
  async ([settings]) => {
    const view = configEditorView.value;
    if (!view) return;
    const [{ EditorView }, theme] = await Promise.all([import("@codemirror/view"), loadEditorTheme(settings.theme, editorThemeAppearance(), currentCustomThemeColors(), themePalette.value)]);
    if (configEditorView.value !== view) return;
    view.dispatch({
      effects: [configEditorTheme.reconfigure(theme), configEditorFontTheme.reconfigure(editorFontTheme(EditorView, settings.fontSize, settings.fontFamily, { fixedHeight: true, scrollable: true }))],
    });
  },
  { deep: true },
);

watch(
  () => [props.connectionId, props.namespace] as const,
  async () => {
    closePendingConfigMutationConfirmations();
    configDetailRequestGuard.invalidate();
    configEditorSessionId += 1;
    latestConfigSaveRequestId += 1;
    savingConfig.value = false;
    invalidateBatchNamespaces(false);
    batchTargetNamespacesRequestGuard.invalidate();
    batchTargetNamespaces.value = [];
    batchTargetConnectionId.value = "";
    searchOpen.value = false;
    clearContentSearchSession();
    selectedConfig.value = null;
    selectedConfigOriginalKey.value = null;
    configContent.value = "";
    originalConfigContent.value = "";
    destroyConfigEditor();
    selectedService.value = null;
    selectedConfigKeys.value = [];
    try {
      await connectionStore.ensureConnected(props.connectionId);
    } catch (e) {
      console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
    }
    await loadInfo();
    await Promise.all([loadConfigsWithRetry(1), loadServicesWithRetry(1)]);
  },
);

onMounted(async () => {
  stopNacosNamespacesChangedListener = subscribeNacosNamespacesChanged(handleNacosNamespacesChanged);
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  await loadInfo();
  await Promise.all([loadConfigsWithRetry(1), loadServicesWithRetry(1)]);
  if (props.targetDataId) await openTargetConfig(props.targetDataId, props.targetGroup || "DEFAULT_GROUP", props.targetKeyword);
});

onBeforeUnmount(() => {
  configDetailRequestGuard.invalidate();
  configEditorSessionId += 1;
  latestConfigSaveRequestId += 1;
  batchNamespacesRequestGuard.invalidate();
  batchTargetNamespacesRequestGuard.invalidate();
  stopNacosNamespacesChangedListener?.();
  stopNacosNamespacesChangedListener = null;
  if (activeSearchOperationId.value) void api.nacosCancelConfigContentSearch(activeSearchOperationId.value);
  configListResizeObserver?.disconnect();
  destroyConfigEditor();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
      <div class="flex min-w-0 items-center gap-2 text-sm">
        <Network class="h-4 w-4 text-sky-600" />
        <span class="truncate font-medium">{{ connectionInfo?.displayServerAddr || connectionInfo?.serverAddr || "Nacos" }}</span>
        <Badge v-if="connectionInfo?.serverVersion" variant="secondary">{{ connectionInfo.serverVersion }}</Badge>
        <Badge variant="outline">{{ namespaceLabel }}</Badge>
        <Badge v-if="namespaceIdLabel" variant="outline" class="max-w-72 truncate font-mono">{{ namespaceIdLabel }}</Badge>
        <Badge v-if="readOnly" variant="outline">{{ t("nacos.readOnly") }}</Badge>
      </div>
      <div class="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <span v-if="connectionError" class="max-w-96 truncate text-xs text-destructive">{{ connectionError }}</span>
        <Button v-if="connectionError" size="sm" variant="outline" class="h-8 w-8 px-0" :title="t('nacos.retryConnectionInfo')" :aria-label="t('nacos.retryConnectionInfo')" :disabled="infoLoading" @click="loadInfo">
          <Loader2 v-if="infoLoading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
        </Button>
        <div class="inline-flex">
          <Button size="sm" :variant="hasSearchSession ? 'secondary' : 'outline'" class="h-8 gap-1.5" :class="hasSearchSession ? 'rounded-r-none pr-2' : ''" :title="hasSearchSession ? t('nacos.searchResultsRetainedHint') : t('nacos.contentSearch')" @click="openSearchDialog">
            <Search class="h-3.5 w-3.5" />
            {{ t(hasSearchSession ? "nacos.searchResults" : "nacos.contentSearch") }}
            <Badge v-if="retainedSearchMatchCount" variant="outline" class="h-5 min-w-5 justify-center px-1.5">{{ retainedSearchMatchCount }}</Badge>
          </Button>
          <Button v-if="hasSearchSession" type="button" size="sm" variant="secondary" class="h-8 w-8 rounded-l-none border-l border-border px-0" :title="t('nacos.clearSearchResults')" :aria-label="t('nacos.clearSearchResults')" @click="clearContentSearchSession">
            <X class="h-3.5 w-3.5" />
          </Button>
        </div>
        <Button size="sm" variant="outline" class="h-8 gap-1.5" @click="openBatchDialog('export')">
          <Archive class="h-3.5 w-3.5" />
          {{ t("nacos.batchExport") }}
        </Button>
        <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="readOnly" @click="openBatchDialog('import')">
          <FileInput class="h-3.5 w-3.5" />
          {{ t("nacos.batchImport") }}
        </Button>
        <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="readOnly" @click="openBatchDialog('copy')">
          <ArrowLeftRight class="h-3.5 w-3.5" />
          {{ t("nacos.copyToNamespace") }}
        </Button>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
      <button class="rounded px-3 py-1.5 text-sm" :class="activeTab === 'configs' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60'" @click="activeTab = 'configs'">{{ t("nacos.configs") }}</button>
      <button class="rounded px-3 py-1.5 text-sm" :class="activeTab === 'services' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60'" @click="activeTab = 'services'">{{ t("nacos.services") }}</button>
    </div>

    <Splitpanes v-if="activeTab === 'configs'" class="nacos-admin-splitpanes min-h-0 flex-1" @resized="handleNacosSplitResized">
      <Pane :size="nacosSplitSize" min-size="24">
        <div class="flex h-full min-h-0 flex-col">
          <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-2 border-b p-2">
            <Input v-model="configDataId" class="h-8 min-w-0" placeholder="dataId" @keyup.enter="loadConfigsWithRetry(1)" />
            <Input v-model="configGroup" class="h-8 min-w-0" :placeholder="t('nacos.allGroups')" @keyup.enter="loadConfigsWithRetry(1)" />
            <Input v-model="configAppName" class="h-8 min-w-0" :placeholder="t('nacos.application')" @keyup.enter="loadConfigsWithRetry(1)" />
            <Button size="sm" variant="outline" class="h-8 w-9 px-0" :title="t('nacos.load')" :disabled="configLoading" @click="loadConfigsWithRetry(1)">
              <Loader2 v-if="configLoading" class="h-3.5 w-3.5 animate-spin" />
              <RefreshCw v-else class="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" class="h-8 w-9 px-0" :disabled="readOnly" @click="newConfig">
              <Plus class="h-3.5 w-3.5" />
            </Button>
          </div>
          <div v-if="configError" class="border-b px-3 py-2 text-xs text-destructive">{{ configError }}</div>
          <div ref="configListViewport" class="min-h-0 flex-1 overflow-auto">
            <div class="w-max min-w-full" :style="{ minWidth: configListMinWidth }">
              <div class="sticky top-0 z-20 grid border-b bg-muted px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm" :style="{ gridTemplateColumns: configListGridTemplate }">
                <div class="relative min-w-0 pr-3">
                  <span class="flex items-center gap-2">
                    <input type="checkbox" :checked="allCurrentPageSelected" :aria-label="t('nacos.selectCurrentPage')" @change="toggleCurrentPageSelection(($event.target as HTMLInputElement).checked)" />
                    <span class="block truncate">dataID</span>
                  </span>
                  <div
                    data-column-resize-handle
                    role="separator"
                    aria-orientation="vertical"
                    :aria-label="t('nacos.resizeColumn')"
                    class="group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/10"
                    :class="configListResizingColumnIndex === 0 ? 'bg-primary/15' : ''"
                    @mousedown="onConfigListColumnResizeStart(0, $event)"
                  >
                    <span class="pointer-events-none absolute left-1/2 top-1/2 h-5 w-px -translate-x-1/2 -translate-y-1/2 bg-border/90 transition-colors group-hover:bg-primary" />
                  </div>
                </div>
                <div class="relative min-w-0 px-3">
                  <span class="block truncate">{{ t("nacos.group") }}</span>
                  <div
                    data-column-resize-handle
                    role="separator"
                    aria-orientation="vertical"
                    :aria-label="t('nacos.resizeColumn')"
                    class="group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/10"
                    :class="configListResizingColumnIndex === 1 ? 'bg-primary/15' : ''"
                    @mousedown="onConfigListColumnResizeStart(1, $event)"
                  >
                    <span class="pointer-events-none absolute left-1/2 top-1/2 h-5 w-px -translate-x-1/2 -translate-y-1/2 bg-border/90 transition-colors group-hover:bg-primary" />
                  </div>
                </div>
                <div class="relative min-w-0 px-3">
                  <span class="block truncate">{{ t("nacos.application") }}</span>
                  <div
                    data-column-resize-handle
                    role="separator"
                    aria-orientation="vertical"
                    :aria-label="t('nacos.resizeColumn')"
                    class="group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/10"
                    :class="configListResizingColumnIndex === 2 ? 'bg-primary/15' : ''"
                    @mousedown="onConfigListColumnResizeStart(2, $event)"
                  >
                    <span class="pointer-events-none absolute left-1/2 top-1/2 h-5 w-px -translate-x-1/2 -translate-y-1/2 bg-border/90 transition-colors group-hover:bg-primary" />
                  </div>
                </div>
                <div class="relative min-w-0 pl-3">
                  <span class="block truncate">{{ t("nacos.format") }}</span>
                </div>
              </div>
              <div
                v-for="item in configs"
                :key="`${item.namespace}:${item.group}:${item.dataId}`"
                class="grid w-full cursor-pointer items-center border-b px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50"
                :class="{ 'bg-accent': selectedConfig?.dataId === item.dataId && selectedConfig?.group === item.group && (selectedConfig?.namespace || namespace) === (item.namespace || namespace) }"
                :style="{ gridTemplateColumns: configListGridTemplate }"
                @click="selectConfig(item)"
              >
                <span class="flex min-w-0 items-center gap-2 pr-3" :title="item.dataId">
                  <input type="checkbox" :checked="selectedConfigKeys.includes(configIdentityKey(item))" :aria-label="t('nacos.selectConfigForBatch', { dataId: item.dataId })" @click.stop @change.stop="toggleConfigSelection(item, ($event.target as HTMLInputElement).checked)" />
                  <button type="button" class="flex min-w-0 items-center gap-2 text-left" @click.stop="selectConfig(item)">
                    <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span class="truncate font-medium text-foreground">{{ item.dataId }}</span>
                  </button>
                </span>
                <span class="truncate px-3 text-xs text-muted-foreground" :title="item.group || 'DEFAULT_GROUP'">{{ item.group || "DEFAULT_GROUP" }}</span>
                <span class="truncate px-3 text-xs text-muted-foreground" :title="item.appName || '-'">{{ item.appName || "-" }}</span>
                <span class="truncate pl-3 text-xs text-muted-foreground" :title="configFormatLabel(item)">{{ configFormatLabel(item) }}</span>
              </div>
            </div>
            <div v-if="!configLoading && configs.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("nacos.noConfigs") }}</div>
          </div>
          <div class="flex shrink-0 items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <div class="flex items-center gap-3">
              <span>{{ t("nacos.total", { count: configTotal }) }}</span>
              <span>{{ t("nacos.selectedCount", { count: selectedConfigCount }) }}</span>
            </div>
            <div class="flex items-center gap-2">
              <Button size="sm" variant="outline" class="h-7" :disabled="configPageNo <= 1 || configLoading" @click="loadConfigs(configPageNo - 1)">{{ t("nacos.prev") }}</Button>
              <span>{{ configPageNo }} / {{ configTotalPages }}</span>
              <Button size="sm" variant="outline" class="h-7" :disabled="configPageNo >= configTotalPages || configLoading" @click="loadConfigs(configPageNo + 1)">{{ t("nacos.next") }}</Button>
            </div>
          </div>
        </div>
      </Pane>

      <Pane :size="100 - nacosSplitSize" min-size="20">
        <div class="nacos-config-workbench flex h-full min-h-0 flex-col">
          <template v-if="selectedConfig">
            <header class="nacos-config-context-bar shrink-0 border-b bg-background px-3 py-2.5">
              <div class="flex min-w-0 items-center gap-2.5">
                <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border bg-muted/35 text-muted-foreground">
                  <FileText class="h-4 w-4" />
                </div>
                <div class="min-w-0">
                  <div class="flex min-w-0 items-center gap-2">
                    <h2 class="truncate text-sm font-semibold leading-5" :title="selectedConfig.dataId || t('nacos.newConfigDraft')">
                      {{ selectedConfig.dataId || t("nacos.newConfigDraft") }}
                    </h2>
                    <span v-if="isCreatingConfig" class="shrink-0 rounded border border-dashed px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                      {{ t("nacos.draft") }}
                    </span>
                  </div>
                  <div class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span class="truncate" :title="namespaceLabel">{{ namespaceLabel }}</span>
                    <span aria-hidden="true">/</span>
                    <span class="truncate" :title="selectedConfig.group || 'DEFAULT_GROUP'">{{ selectedConfig.group || "DEFAULT_GROUP" }}</span>
                  </div>
                </div>
              </div>

              <div class="nacos-config-state shrink-0" aria-live="polite">
                <span v-if="readOnly" class="rounded-md border bg-muted/30 px-2 py-1 text-[11px] font-medium text-muted-foreground">{{ t("nacos.readOnlyState") }}</span>
                <span v-else-if="savingConfig" class="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 class="h-3.5 w-3.5 animate-spin" />
                  {{ t("nacos.saving") }}
                </span>
                <span v-else-if="isConfigDirty" class="flex items-center gap-1.5 text-xs font-medium text-amber-600 dark:text-amber-400">
                  <span class="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
                  {{ t("nacos.unsaved") }}
                </span>
                <span v-else-if="configSaveNotice" class="flex max-w-64 items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 class="h-3.5 w-3.5 shrink-0" />
                  <span class="truncate" :title="configSaveNotice">{{ configSaveNotice }}</span>
                </span>
                <span v-else-if="isCreatingConfig" class="text-xs text-muted-foreground">{{ t("nacos.draft") }}</span>
                <span v-else class="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 class="h-3.5 w-3.5" />
                  {{ t("nacos.published") }}
                </span>
              </div>
            </header>

            <section v-if="isCreatingConfig" class="nacos-config-identity-grid shrink-0 border-b bg-muted/10 px-3 py-2.5" :aria-label="t('nacos.configIdentity')">
              <div class="min-w-0 space-y-1">
                <Label :for="`${configWorkbenchId}-data-id`" class="text-[11px] font-medium text-muted-foreground">
                  <span class="text-destructive">*</span>
                  {{ t("nacos.dataId") }}
                </Label>
                <Input :id="`${configWorkbenchId}-data-id`" v-model="selectedConfig.dataId" class="h-8" :placeholder="t('nacos.dataId')" @input="configSaveNotice = ''" />
              </div>
              <div class="min-w-0 space-y-1">
                <Label :for="`${configWorkbenchId}-group`" class="text-[11px] font-medium text-muted-foreground">
                  <span class="text-destructive">*</span>
                  {{ t("nacos.group") }}
                </Label>
                <Input :id="`${configWorkbenchId}-group`" v-model="selectedConfig.group" class="h-8" :placeholder="t('nacos.group')" @input="configSaveNotice = ''" />
              </div>
            </section>

            <section class="nacos-config-inspector shrink-0 border-b">
              <button
                type="button"
                class="flex h-8 w-full items-center justify-between px-3 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                :aria-expanded="configAdvancedOpen"
                :aria-controls="`${configWorkbenchId}-inspector`"
                :aria-label="configAdvancedOpen ? t('nacos.collapse') : t('nacos.advanced')"
                @click="configAdvancedOpen = !configAdvancedOpen"
              >
                <span>{{ configAdvancedOpen ? t("nacos.collapse") : t("nacos.advanced") }}</span>
                <ChevronDown class="h-3.5 w-3.5 transition-transform" :class="{ 'rotate-180': configAdvancedOpen }" />
              </button>
              <div v-if="configAdvancedOpen" :id="`${configWorkbenchId}-inspector`" class="nacos-config-inspector-grid border-t bg-muted/10 px-3 py-2.5">
                <div class="min-w-0 space-y-1">
                  <Label :for="`${configWorkbenchId}-tags`" class="text-[11px] font-medium text-muted-foreground">{{ t("nacos.tags") }}</Label>
                  <Input :id="`${configWorkbenchId}-tags`" v-model="selectedConfig.tags" class="h-8" placeholder="tag1,tag2" :disabled="readOnly" @input="configSaveNotice = ''" />
                </div>
                <div class="min-w-0 space-y-1">
                  <Label :for="`${configWorkbenchId}-application`" class="text-[11px] font-medium text-muted-foreground">{{ t("nacos.application") }}</Label>
                  <Input :id="`${configWorkbenchId}-application`" v-model="selectedConfig.appName" class="h-8" :disabled="readOnly" @input="configSaveNotice = ''" />
                </div>
                <div class="nacos-config-description min-w-0 space-y-1">
                  <Label :for="`${configWorkbenchId}-description`" class="text-[11px] font-medium text-muted-foreground">{{ t("nacos.description") }}</Label>
                  <Input :id="`${configWorkbenchId}-description`" v-model="selectedConfig.desc" class="h-8" :disabled="readOnly" @input="configSaveNotice = ''" />
                </div>
              </div>
            </section>

            <div class="nacos-editor-toolbar shrink-0 border-b bg-muted/15 px-3 py-2">
              <div class="nacos-editor-toolbar-format flex min-w-0 items-center gap-2">
                <span class="shrink-0 text-xs font-semibold">{{ t("nacos.content") }}</span>
                <div class="h-4 w-px shrink-0 bg-border" aria-hidden="true" />
                <div role="group" class="nacos-config-format-options flex min-w-0 gap-1 overflow-x-auto" :aria-label="t('nacos.format')">
                  <button
                    v-for="format in configFormatOptions"
                    :key="format"
                    type="button"
                    class="shrink-0 rounded border px-2 py-0.5 text-[11px] font-medium transition-colors"
                    :class="configType === format ? 'border-foreground/80 bg-foreground text-background' : 'border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground'"
                    :disabled="readOnly"
                    :aria-pressed="configType === format"
                    @click="setConfigFormat(format)"
                  >
                    {{ configFormatDisplayLabel(format) }}
                  </button>
                </div>
              </div>

              <div class="nacos-editor-actions min-w-0">
                <div class="nacos-editor-actions-secondary flex min-w-0 items-center gap-1.5 overflow-x-auto">
                  <Button size="sm" variant="outline" class="h-8 shrink-0 gap-1.5 px-2.5" :title="t('nacos.copy')" :aria-label="t('nacos.copy')" @click="copyConfigIdentity">
                    <Clipboard class="h-3.5 w-3.5" />
                    <span class="nacos-config-secondary-label">{{ t("nacos.copy") }}</span>
                  </Button>
                  <Button size="sm" variant="outline" class="h-8 shrink-0 gap-1.5 px-2.5" :title="t('nacos.export')" :aria-label="t('nacos.export')" @click="exportConfig">
                    <Download class="h-3.5 w-3.5" />
                    <span class="nacos-config-secondary-label">{{ t("nacos.export") }}</span>
                  </Button>
                  <span class="inline-flex shrink-0" :title="configHistoryUnavailableTitle || t('nacos.history')">
                    <Button size="sm" variant="outline" class="h-8 gap-1.5 px-2.5" :aria-label="t('nacos.history')" :disabled="!selectedConfigOriginalKey || !supportsConfigHistory" @click="openConfigHistory">
                      <FileClock class="h-3.5 w-3.5" />
                      <span class="nacos-config-secondary-label">{{ t("nacos.history") }}</span>
                    </Button>
                  </span>
                  <Button size="sm" variant="outline" class="h-8 shrink-0 gap-1.5 px-2.5" :title="t('nacos.saveAs')" :aria-label="t('nacos.saveAs')" :disabled="readOnly" @click="saveConfigAsCopy">
                    <Save class="h-3.5 w-3.5" />
                    <span class="nacos-config-secondary-label">{{ t("nacos.saveAs") }}</span>
                  </Button>
                </div>
                <div class="nacos-editor-actions-primary flex shrink-0 items-center gap-1.5 bg-muted/15">
                  <div class="mx-0.5 h-5 w-px shrink-0 bg-border" aria-hidden="true" />
                  <Button size="sm" class="h-8 gap-1.5 px-3" :disabled="!canRequestConfigSave || (!isCreatingConfig && !isConfigDirty)" @click="requestSaveConfig">
                    <Loader2 v-if="savingConfig" class="h-3.5 w-3.5 animate-spin" />
                    <Send v-else class="h-3.5 w-3.5" />
                    {{ savingConfig ? t("nacos.saving") : t("nacos.save") }}
                  </Button>
                  <Button size="sm" variant="ghost" class="h-8 w-8 p-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" :title="t('nacos.delete')" :aria-label="t('nacos.delete')" :disabled="!canRequestConfigDelete || isCreatingConfig" @click="requestDeleteConfig">
                    <Loader2 v-if="deletingConfig" class="h-3.5 w-3.5 animate-spin" />
                    <Trash2 v-else class="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          </template>
          <div v-if="selectedConfig" class="relative min-h-0 flex-1 overflow-hidden bg-background">
            <div ref="configEditorHost" class="nacos-config-editor h-full min-h-0 overflow-hidden" />
            <EditorSearchPanel ref="configSearchPanelRef" :view="configEditorView" tone="editor" />
          </div>
          <div v-else class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("nacos.selectConfig") }}</div>
        </div>
      </Pane>
    </Splitpanes>

    <Splitpanes v-else-if="activeTab === 'services'" class="nacos-admin-splitpanes min-h-0 flex-1" @resized="handleNacosSplitResized">
      <Pane :size="nacosSplitSize" min-size="24">
        <div class="flex h-full min-h-0 flex-col">
          <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 border-b p-2">
            <Input v-model="serviceName" class="h-8 min-w-0" :placeholder="t('nacos.service')" @keyup.enter="loadServicesWithRetry(1)" />
            <Input v-model="serviceGroup" class="h-8 min-w-0" :placeholder="t('nacos.allGroups')" @keyup.enter="loadServicesWithRetry(1)" />
            <Input v-model="serviceCluster" class="h-8 min-w-0" :placeholder="t('nacos.cluster')" @keyup.enter="loadInstances" />
            <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="servicesLoading" @click="loadServicesWithRetry(1)">
              <Loader2 v-if="servicesLoading" class="h-3.5 w-3.5 animate-spin" />
              <RefreshCw v-else class="h-3.5 w-3.5" />
              {{ t("nacos.load") }}
            </Button>
          </div>
          <div v-if="servicesError" class="border-b px-3 py-2 text-xs text-destructive">{{ servicesError }}</div>
          <div class="min-h-0 flex-1 overflow-auto">
            <button
              v-for="service in services"
              :key="`${service.groupName}:${service.serviceName}`"
              type="button"
              class="grid w-full gap-1 border-b px-3 py-2 text-left text-sm hover:bg-accent/60"
              :class="{ 'bg-accent': selectedService?.serviceName === service.serviceName && selectedService?.groupName === service.groupName }"
              @click="selectService(service)"
            >
              <span class="truncate font-medium">{{ service.serviceName }}</span>
              <span class="flex items-center gap-2 text-xs text-muted-foreground">
                <Server class="h-3.5 w-3.5" />
                {{ service.groupName || serviceGroup }}
                <span v-if="service.ipCount != null">· {{ t("nacos.instanceCount", { count: service.ipCount }) }}</span>
              </span>
            </button>
            <div v-if="!servicesLoading && services.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("nacos.noServices") }}</div>
          </div>
          <div class="flex shrink-0 items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>{{ t("nacos.total", { count: serviceTotal }) }}</span>
            <div class="flex items-center gap-2">
              <Button size="sm" variant="outline" class="h-7" :disabled="servicePageNo <= 1 || servicesLoading" @click="loadServices(servicePageNo - 1)">{{ t("nacos.prev") }}</Button>
              <span>{{ servicePageNo }} / {{ serviceTotalPages }}</span>
              <Button size="sm" variant="outline" class="h-7" :disabled="servicePageNo >= serviceTotalPages || servicesLoading" @click="loadServices(servicePageNo + 1)">{{ t("nacos.next") }}</Button>
            </div>
          </div>
        </div>
      </Pane>

      <Pane :size="100 - nacosSplitSize" min-size="20">
        <div class="flex h-full min-h-0 flex-col">
          <div class="flex shrink-0 items-center justify-between border-b px-3 py-2">
            <div class="truncate text-sm font-medium">{{ selectedService?.serviceName || t("nacos.instances") }}</div>
            <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="!selectedService || instancesLoading" @click="loadInstances">
              <Loader2 v-if="instancesLoading" class="h-3.5 w-3.5 animate-spin" />
              <RefreshCw v-else class="h-3.5 w-3.5" />
              {{ t("nacos.refresh") }}
            </Button>
          </div>
          <div v-if="instancesError" class="border-b px-3 py-2 text-xs text-destructive">{{ instancesError }}</div>
          <div class="min-h-0 flex-1 overflow-auto">
            <table v-if="instances.length" class="w-full text-left text-sm">
              <thead class="sticky top-0 bg-muted/80 text-xs text-muted-foreground">
                <tr>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.address") }}</th>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.cluster") }}</th>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.weight") }}</th>
                  <th class="px-3 py-2 font-medium">metadata</th>
                  <th class="px-3 py-2 font-medium">{{ t("nacos.state") }}</th>
                  <th class="px-3 py-2 text-right font-medium">{{ t("nacos.actions") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="instance in instances" :key="`${instance.ip}:${instance.port}`" class="border-b">
                  <td class="px-3 py-2 font-mono text-xs">{{ instance.ip }}:{{ instance.port }}</td>
                  <td class="px-3 py-2">{{ instance.clusterName || "-" }}</td>
                  <td class="px-3 py-2">
                    <Input
                      :model-value="instance.weight ?? 1"
                      type="number"
                      min="0"
                      step="0.1"
                      class="h-7 w-20 text-xs"
                      :disabled="readOnly || updatingInstanceKey === `${instance.ip}:${instance.port}`"
                      @change="(event: Event) => requestUpdateInstance(instance, { weight: Number((event.target as HTMLInputElement).value) })"
                    />
                  </td>
                  <td class="max-w-56 truncate px-3 py-2 font-mono text-xs" :title="JSON.stringify(instance.metadata ?? null)">{{ JSON.stringify(instance.metadata ?? null) }}</td>
                  <td class="px-3 py-2">
                    <div class="flex flex-wrap gap-1">
                      <Badge :variant="instance.healthy === false ? 'outline' : 'secondary'">{{ instance.healthy === false ? t("nacos.unhealthy") : t("nacos.healthy") }}</Badge>
                      <Badge :variant="instance.enabled === false ? 'outline' : 'secondary'">{{ instance.enabled === false ? t("nacos.offline") : t("nacos.enabled") }}</Badge>
                      <Badge v-if="instance.ephemeral != null" variant="outline">{{ instance.ephemeral ? t("nacos.ephemeral") : t("nacos.persistent") }}</Badge>
                    </div>
                  </td>
                  <td class="px-3 py-2 text-right">
                    <div class="inline-flex gap-2">
                      <Button size="sm" variant="outline" class="h-7 gap-1" :disabled="readOnly || updatingInstanceKey === `${instance.ip}:${instance.port}`" @click="requestUpdateInstance(instance, { enabled: !instance.enabled })">
                        <Loader2 v-if="updatingInstanceKey === `${instance.ip}:${instance.port}`" class="h-3 w-3 animate-spin" />
                        {{ instance.enabled === false ? t("nacos.enable") : t("nacos.disable") }}
                      </Button>
                      <Button size="sm" variant="outline" class="h-7" :disabled="readOnly || updatingInstanceKey === `${instance.ip}:${instance.port}`" @click="requestUpdateInstance(instance, { healthy: !instance.healthy })">
                        {{ instance.healthy === false ? t("nacos.markHealthy") : t("nacos.markUnhealthy") }}
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("nacos.selectService") }}</div>
          </div>
        </div>
      </Pane>
    </Splitpanes>

    <NacosConfigDiffDialog v-model:open="pendingConfigSave" :before="originalConfigContent" :after="configContent" :loading="savingConfig" @confirm="saveConfig" />

    <NacosContentSearchDialog
      v-model:open="searchOpen"
      :loading="searchLoading"
      :exporting="searchExportLoading"
      :reset-key="searchSessionResetKey"
      :result="searchResult"
      :progress="searchProgress"
      :error="searchError"
      @search="searchConfigContent"
      @cancel="cancelConfigContentSearch"
      @navigate="navigateToContentMatch"
      @export="exportContentSearchResults"
      @clear="clearContentSearchSession"
    />

    <NacosConfigBatchDialog
      v-model:open="batchOpen"
      :mode="batchMode"
      :loading="batchLoading"
      :selected-count="selectedConfigCount"
      :filtered-count="configTotal"
      :target-connections="batchTargetConnections"
      :target-connection-id="batchTargetConnectionId"
      :source-connection-id="connectionId"
      :namespaces="batchTargetNamespaces"
      :current-namespace="namespace"
      :preview="batchPreview"
      :report="batchReport"
      :source-name="importSourceName"
      :error="batchError"
      @choose-file="chooseImportArchive"
      @reset="resetBatchDialogState"
      @target-connection-change="selectBatchTargetConnection"
      @preview="previewBatch"
      @apply="applyBatch"
      @export="exportConfigArchive"
    />

    <NacosConfigHistoryDialog
      v-model:open="historyOpen"
      :config="selectedConfig"
      :items="historyItems"
      :loading="historyLoading"
      :error="historyError"
      :page-no="historyPageNo"
      :page-size="historyPageSize"
      :total-count="historyTotal"
      :read-only="readOnly"
      :viewing-item="historyViewingItem"
      :viewing-content="historyViewingContent"
      :viewing-loading="historyViewingLoading"
      @load="loadConfigHistory"
      @view="viewConfigHistory"
      @close-detail="closeHistoryDetail"
      @compare="compareConfigHistory"
      @rollback="requestRollbackHistory"
    />

    <Dialog v-model:open="rnacosConsoleAuthOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t("nacos.rnacosConsoleAuthTitle") }}</DialogTitle>
          <DialogDescription>{{ t("nacos.rnacosConsoleAuthDescription") }}</DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <img v-if="rnacosConsoleCaptchaImage" :src="rnacosConsoleCaptchaImage" :alt="t('nacos.rnacosCaptchaLabel')" class="h-28 w-full rounded-md border bg-muted/30 object-contain" />
          <div class="space-y-1.5">
            <Label for="rnacos-console-captcha">{{ t("nacos.rnacosCaptchaLabel") }}</Label>
            <Input id="rnacos-console-captcha" v-model="rnacosConsoleCaptcha" autocomplete="off" :placeholder="t('nacos.rnacosCaptchaPlaceholder')" @keyup.enter="submitRNacosConsoleAuthentication" />
          </div>
          <p v-if="rnacosConsoleAuthError" class="text-xs text-destructive">{{ rnacosConsoleAuthError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="rnacosConsoleAuthLoading" @click="requestRNacosConsoleAuthentication">{{ t("nacos.rnacosRefreshCaptcha") }}</Button>
          <Button :disabled="rnacosConsoleAuthLoading" @click="submitRNacosConsoleAuthentication">
            <Loader2 v-if="rnacosConsoleAuthLoading" class="mr-2 h-4 w-4 animate-spin" />
            {{ t("nacos.rnacosConsoleAuthSubmit") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <NacosConfigDiffDialog
      v-model:open="historyCompareOpen"
      :title="t('nacos.historyCompareTitle')"
      :before-label="t('nacos.currentPublishedContent')"
      :after-label="t('nacos.historyVersionContent')"
      :before="historyCompareCurrent"
      :after="historyCompareContent"
      :loading="historyCompareLoading"
      :show-confirm="!readOnly"
      :confirm-label="t('nacos.rollback')"
      confirm-variant="destructive"
      @confirm="requestRollbackComparedHistory"
    />

    <DangerConfirmDialog
      :open="!!pendingDeleteConfig"
      :title="t('nacos.confirmDeleteTitle')"
      :message="t('nacos.confirmDeleteMessage')"
      :details="pendingDeleteDetails"
      :confirm-label="t('nacos.delete')"
      :loading="deletingConfig"
      :close-on-confirm="false"
      @update:open="
        (value: boolean) => {
          if (!value && !deletingConfig) pendingDeleteConfig = null;
        }
      "
      @confirm="deleteConfig"
    />

    <DangerConfirmDialog
      :open="!!pendingHistoryRollback"
      :title="t('nacos.confirmRollbackTitle')"
      :message="t('nacos.confirmRollbackMessage')"
      :details="pendingHistoryRollbackDetails"
      :confirm-label="t('nacos.rollback')"
      :loading="rollingBackHistory"
      :close-on-confirm="false"
      @update:open="
        (value: boolean) => {
          if (!value && !rollingBackHistory) pendingHistoryRollback = null;
        }
      "
      @confirm="rollbackConfigHistory"
    />

    <DangerConfirmDialog
      :open="!!pendingInstanceUpdate"
      :title="t('nacos.confirmInstanceTitle')"
      :message="t('nacos.confirmInstanceMessage')"
      :details="pendingInstanceDetails"
      :confirm-label="t('dangerDialog.confirm')"
      :loading="!!updatingInstanceKey"
      :close-on-confirm="false"
      @update:open="
        (value: boolean) => {
          if (!value && !updatingInstanceKey) pendingInstanceUpdate = null;
        }
      "
      @confirm="pendingInstanceUpdate && updateInstance(pendingInstanceUpdate.instance, pendingInstanceUpdate.patch)"
    />
  </div>
</template>

<style scoped>
.nacos-config-editor :deep(.cm-content),
.nacos-config-editor :deep(.cm-line) {
  cursor: text;
  user-select: text !important;
  -webkit-user-select: text !important;
}

.nacos-config-editor :deep(.cm-selectionBackground),
.nacos-config-editor :deep(.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground),
.nacos-config-editor :deep(.cm-trimmedSelection) {
  display: block !important;
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

.nacos-config-editor :deep(.cm-content ::selection) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

.nacos-config-workbench {
  container-type: inline-size;
}

.nacos-config-context-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.nacos-config-identity-grid,
.nacos-config-inspector-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 13rem), 1fr));
  gap: 0.625rem 0.75rem;
}

.nacos-editor-toolbar {
  display: grid;
  gap: 0.5rem;
}

.nacos-editor-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.375rem;
}

.nacos-config-format-options,
.nacos-editor-actions-secondary {
  scrollbar-width: thin;
}

@container (min-width: 960px) {
  .nacos-config-inspector-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .nacos-config-description {
    grid-column: span 2;
  }

  .nacos-editor-toolbar {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
}

@container (max-width: 620px) {
  .nacos-config-context-bar {
    align-items: flex-start;
  }

  .nacos-config-state {
    padding-top: 0.25rem;
  }

  .nacos-editor-actions-secondary,
  .nacos-config-format-options {
    padding-bottom: 0.125rem;
  }
}

@container (max-width: 480px) {
  .nacos-config-secondary-label {
    display: none;
  }
}

.nacos-admin-splitpanes :deep(.splitpanes--vertical > .splitpanes__splitter) {
  width: 4px !important;
  border-left: 1px solid var(--border);
  background: transparent;
  cursor: col-resize;
}

.nacos-admin-splitpanes :deep(.splitpanes__splitter:hover) {
  background: oklch(0.6 0.15 250) !important;
}
</style>

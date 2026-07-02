<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { Compartment, type Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { CheckCircle2, Clipboard, Download, FileClock, FileText, Loader2, Network, Plus, RefreshCw, Save, Send, Server, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import NacosConfigDiffDialog from "@/components/nacos/NacosConfigDiffDialog.vue";
import NacosConfigHistoryDialog from "@/components/nacos/NacosConfigHistoryDialog.vue";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/api";
import { buildNacosConfigDeleteConfirm, buildNacosConfigExportFileName, buildNacosConfigHistoryRollbackConfirm, buildNacosInstanceConfirm, createNacosSaveAsCopy, resolveNacosConfigCopyText } from "@/lib/nacosAdmin";
import { copyToClipboard, readTextFromClipboard } from "@/lib/clipboard";
import { trimmedSelectionLayer } from "@/lib/codemirrorTrimmedSelectionLayer";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/safeStorage";
import { editorFontTheme, loadEditorTheme } from "@/lib/editorThemes";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import type { NacosConfigHistoryItem, NacosConfigItem, NacosConfigKey, NacosConnectionInfo, NacosInstanceInfo, NacosServiceInfo } from "@/types/nacos";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";

const props = defineProps<{
  connectionId: string;
  namespace?: string;
  namespaceName?: string;
  readOnly?: boolean;
}>();

type AdminTab = "configs" | "services";

const { toast } = useToast();
const { t } = useI18n();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();
const { isDark } = useTheme();
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
const savingConfig = ref(false);
const deletingConfig = ref(false);
const configAdvancedOpen = ref(false);
const configSaveNotice = ref("");
const pendingConfigSave = ref(false);
const pendingDeleteConfig = ref<NacosConfigItem | null>(null);
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
const configFormatOptions = ["text", "json", "xml", "yaml", "html", "properties", "toml"];
const configEditorHost = ref<HTMLDivElement | null>(null);
const configEditorView = shallowRef<EditorView | null>(null);
const configSearchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const knownConfigFormats = ref<Record<string, string>>({});
const configEditorTheme = new Compartment();
const configEditorFontTheme = new Compartment();
const configEditorLanguage = new Compartment();

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

const namespace = computed(() => props.namespace ?? connectionInfo.value?.namespace ?? "");
const namespaceLabel = computed(() => props.namespaceName || namespace.value || "public");
const namespaceIdLabel = computed(() => {
  if (!namespace.value || namespace.value === namespaceLabel.value) return "";
  return namespace.value;
});
const configTotalPages = computed(() => Math.max(1, Math.ceil(configTotal.value / Math.max(1, configPageSize.value))));
const serviceTotalPages = computed(() => Math.max(1, Math.ceil(serviceTotal.value / Math.max(1, servicePageSize.value))));
const isCreatingConfig = computed(() => !!selectedConfig.value && !selectedConfigOriginalKey.value);
const isConfigDirty = computed(() => !!selectedConfig.value && (configContent.value !== originalConfigContent.value || configFormatValue(selectedConfig.value) !== configType.value));
const pendingDeleteDetails = computed(() => (pendingDeleteConfig.value ? buildNacosConfigDeleteConfirm(pendingDeleteConfig.value, namespace.value) : ""));
const pendingHistoryRollbackDetails = computed(() => (pendingHistoryRollback.value ? buildNacosConfigHistoryRollbackConfirm(pendingHistoryRollback.value, namespace.value) : ""));
const pendingInstanceDetails = computed(() => (pendingInstanceUpdate.value && selectedService.value ? buildNacosInstanceConfirm(selectedService.value, pendingInstanceUpdate.value.instance, pendingInstanceUpdate.value.patch, serviceGroup.value, namespace.value) : ""));
const selectedConfigKey = computed<NacosConfigKey | null>(() => {
  if (selectedConfigOriginalKey.value) return selectedConfigOriginalKey.value;
  if (!selectedConfig.value) return null;
  return {
    namespace: selectedConfig.value.namespace || namespace.value || undefined,
    dataId: selectedConfig.value.dataId,
    group: selectedConfig.value.group,
  };
});

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
  const [{ EditorState, Prec }, { EditorView, keymap }, { basicSetup }, { defaultKeymap, historyKeymap, indentWithTab }, { search: cmSearch }, language] = await Promise.all([
    import("@codemirror/state"),
    import("@codemirror/view"),
    import("codemirror"),
    import("@codemirror/commands"),
    import("@codemirror/search"),
    configLanguageExtension(configType.value),
  ]);
  const editorSettings = settingsStore.editorSettings;
  const theme = await loadEditorTheme(editorSettings.theme, editorThemeAppearance(), currentCustomThemeColors());
  const view = new EditorView({
    parent: configEditorHost.value,
    state: EditorState.create({
      doc: configContent.value,
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
          if (!update.docChanged) return;
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
  configEditorView.value = view;
}

function destroyConfigEditor() {
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
    configError.value = error instanceof Error ? error.message : String(error);
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

async function selectConfig(item: NacosConfigItem) {
  destroyConfigEditor();
  configSaveNotice.value = "";
  selectedConfigOriginalKey.value = {
    namespace: item.namespace || namespace.value || undefined,
    dataId: item.dataId,
    group: item.group,
  };
  selectedConfig.value = item;
  configContent.value = item.content || "";
  originalConfigContent.value = configContent.value;
  configType.value = configFormatValue(item) || "text";
  try {
    const detail = await api.nacosGetConfig(props.connectionId, {
      namespace: item.namespace || namespace.value || undefined,
      dataId: item.dataId,
      group: item.group,
    });
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
    configContent.value = normalizedDetail.content || "";
    originalConfigContent.value = configContent.value;
    configType.value = configFormatValue(normalizedDetail) || configFormatValue(item) || "text";
    await refreshConfigEditor();
  } catch (error) {
    configError.value = error instanceof Error ? error.message : String(error);
    await refreshConfigEditor();
  }
}

function newConfig() {
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
  originalConfigContent.value = "";
  configType.value = selectedConfig.value.configType || "text";
  configAdvancedOpen.value = false;
  void mountConfigEditor();
}

function saveConfigAsCopy() {
  if (!selectedConfig.value) return;
  const copy = createNacosSaveAsCopy({ ...selectedConfig.value, content: configContent.value, configType: configType.value });
  destroyConfigEditor();
  selectedConfigOriginalKey.value = null;
  selectedConfig.value = copy;
  configContent.value = copy.content || "";
  originalConfigContent.value = "";
  configType.value = copy.configType || configType.value || "text";
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

async function downloadConfigText(content: string, fileName: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
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
  if (!selectedConfigOriginalKey.value || !selectedConfig.value) return;
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
    historyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    historyLoading.value = false;
  }
}

async function loadHistoryDetail(item: NacosConfigHistoryItem): Promise<NacosConfigItem | null> {
  try {
    return await api.nacosGetConfigHistory(props.connectionId, historyKeyFor(item));
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : String(error);
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
    historyError.value = error instanceof Error ? error.message : String(error);
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
      originalConfigContent.value = configContent.value;
      configType.value = configFormatValue(normalizedDetail) || "text";
      await refreshConfigEditor();
    }
    await Promise.all([loadConfigs(configPageNo.value), loadConfigHistory(historyPageNo.value)]);
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : String(error);
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
  if (!selectedConfig.value || props.readOnly) return;
  if (!isCreatingConfig.value && configContent.value !== originalConfigContent.value) {
    pendingConfigSave.value = true;
    return;
  }
  void saveConfig();
}

async function saveConfig() {
  if (!selectedConfig.value || props.readOnly) return;
  pendingConfigSave.value = false;
  const originalKey = selectedConfigOriginalKey.value;
  const wasCreating = !originalKey;
  const dataId = selectedConfig.value.dataId.trim();
  const group = selectedConfig.value.group.trim() || "DEFAULT_GROUP";
  if (!dataId) {
    configError.value = t("nacos.dataIdRequired");
    return;
  }
  savingConfig.value = true;
  configError.value = "";
  configSaveNotice.value = "";
  try {
    await api.nacosPublishConfig(props.connectionId, {
      namespace: originalKey?.namespace || selectedConfig.value.namespace || namespace.value || undefined,
      dataId,
      group,
      content: configContent.value,
      configType: configType.value || undefined,
      appName: selectedConfig.value.appName,
      desc: selectedConfig.value.desc,
      tags: selectedConfig.value.tags,
    });
    const savedConfig = { ...selectedConfig.value, dataId, group, content: configContent.value, configType: configType.value };
    selectedConfig.value = savedConfig;
    rememberConfigFormat({ ...savedConfig, namespace: savedConfig.namespace || namespace.value || undefined });
    originalConfigContent.value = configContent.value;
    selectedConfigOriginalKey.value = {
      namespace: savedConfig.namespace || namespace.value || undefined,
      dataId,
      group,
    };
    configAdvancedOpen.value = false;
    configSaveNotice.value = t(wasCreating ? "nacos.createdAndLoaded" : "nacos.savedAndLoaded", { dataId });
    toast(t("nacos.saved"), 2000);
    await loadConfigsWithRetry(wasCreating ? 1 : configPageNo.value);
    upsertConfigInList(savedConfig);
  } catch (error) {
    configError.value = error instanceof Error ? error.message : String(error);
  } finally {
    savingConfig.value = false;
  }
}

function requestDeleteConfig() {
  if (!selectedConfig.value || props.readOnly) return;
  pendingDeleteConfig.value = selectedConfig.value;
}

async function deleteConfig() {
  const key = selectedConfigKey.value;
  if (!key || props.readOnly) return;
  deletingConfig.value = true;
  configError.value = "";
  configSaveNotice.value = "";
  try {
    await api.nacosDeleteConfig(props.connectionId, key);
    selectedConfig.value = null;
    selectedConfigOriginalKey.value = null;
    configContent.value = "";
    originalConfigContent.value = "";
    pendingDeleteConfig.value = null;
    destroyConfigEditor();
    await loadConfigs();
    toast(t("nacos.deleted"), 2000);
  } catch (error) {
    configError.value = error instanceof Error ? error.message : String(error);
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

watch(
  [() => settingsStore.editorSettings, () => isDark.value],
  async ([settings]) => {
    const view = configEditorView.value;
    if (!view) return;
    const [{ EditorView }, theme] = await Promise.all([import("@codemirror/view"), loadEditorTheme(settings.theme, editorThemeAppearance(), currentCustomThemeColors())]);
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
    selectedConfig.value = null;
    selectedConfigOriginalKey.value = null;
    configContent.value = "";
    originalConfigContent.value = "";
    destroyConfigEditor();
    selectedService.value = null;
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
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  await loadInfo();
  await Promise.all([loadConfigsWithRetry(1), loadServicesWithRetry(1)]);
});

onBeforeUnmount(() => {
  destroyConfigEditor();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center justify-between gap-3 border-b px-3 py-2">
      <div class="flex min-w-0 items-center gap-2 text-sm">
        <Network class="h-4 w-4 text-sky-600" />
        <span class="truncate font-medium">{{ connectionInfo?.displayServerAddr || connectionInfo?.serverAddr || "Nacos" }}</span>
        <Badge v-if="connectionInfo?.serverVersion" variant="secondary">{{ connectionInfo.serverVersion }}</Badge>
        <Badge variant="outline">{{ namespaceLabel }}</Badge>
        <Badge v-if="namespaceIdLabel" variant="outline" class="max-w-72 truncate font-mono">{{ namespaceIdLabel }}</Badge>
        <Badge v-if="readOnly" variant="outline">{{ t("nacos.readOnly") }}</Badge>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="connectionError" class="max-w-96 truncate text-xs text-destructive">{{ connectionError }}</span>
        <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="infoLoading" @click="loadInfo">
          <Loader2 v-if="infoLoading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCw v-else class="h-3.5 w-3.5" />
          {{ t("nacos.test") }}
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
          <div class="min-h-0 flex-1 overflow-auto">
            <div class="sticky top-0 z-20 grid grid-cols-4 border-b bg-muted px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground shadow-sm">
              <span class="truncate pr-3">dataID</span>
              <span class="truncate pr-3">{{ t("nacos.group") }}</span>
              <span class="truncate pr-3">{{ t("nacos.application") }}</span>
              <span class="truncate">{{ t("nacos.format") }}</span>
            </div>
            <button
              v-for="item in configs"
              :key="`${item.namespace}:${item.group}:${item.dataId}`"
              type="button"
              class="grid w-full grid-cols-4 items-center border-b px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50"
              :class="{ 'bg-accent': selectedConfig?.dataId === item.dataId && selectedConfig?.group === item.group }"
              @click="selectConfig(item)"
            >
              <span class="flex min-w-0 items-center gap-2 pr-3" :title="item.dataId">
                <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span class="truncate font-medium text-foreground">{{ item.dataId }}</span>
              </span>
              <span class="truncate pr-3 text-xs text-muted-foreground" :title="item.group || 'DEFAULT_GROUP'">{{ item.group || "DEFAULT_GROUP" }}</span>
              <span class="truncate pr-3 text-xs text-muted-foreground" :title="item.appName || '-'">{{ item.appName || "-" }}</span>
              <span class="truncate text-xs text-muted-foreground" :title="configFormatLabel(item)">{{ configFormatLabel(item) }}</span>
            </button>
            <div v-if="!configLoading && configs.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("nacos.noConfigs") }}</div>
          </div>
          <div class="flex shrink-0 items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
            <span>{{ t("nacos.total", { count: configTotal }) }}</span>
            <div class="flex items-center gap-2">
              <Button size="sm" variant="outline" class="h-7" :disabled="configPageNo <= 1 || configLoading" @click="loadConfigs(configPageNo - 1)">{{ t("nacos.prev") }}</Button>
              <span>{{ configPageNo }} / {{ configTotalPages }}</span>
              <Button size="sm" variant="outline" class="h-7" :disabled="configPageNo >= configTotalPages || configLoading" @click="loadConfigs(configPageNo + 1)">{{ t("nacos.next") }}</Button>
            </div>
          </div>
        </div>
      </Pane>

      <Pane :size="100 - nacosSplitSize" min-size="20">
        <div class="flex h-full min-h-0 flex-col">
          <div v-if="selectedConfig" class="shrink-0 border-b p-3">
            <div class="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
              <Label class="text-right text-xs text-muted-foreground">{{ t("nacos.namespace") }}</Label>
              <div class="truncate text-sm font-medium">{{ namespaceLabel }}</div>

              <Label class="text-right text-xs">
                <span class="text-destructive">*</span>
                {{ t("nacos.dataId") }}
              </Label>
              <Input v-model="selectedConfig.dataId" class="h-8" :readonly="!isCreatingConfig" :class="{ 'bg-muted text-muted-foreground': !isCreatingConfig }" @input="configSaveNotice = ''" />

              <Label class="text-right text-xs">
                <span class="text-destructive">*</span>
                {{ t("nacos.group") }}
              </Label>
              <Input v-model="selectedConfig.group" class="h-8" :readonly="!isCreatingConfig" :class="{ 'bg-muted text-muted-foreground': !isCreatingConfig }" @input="configSaveNotice = ''" />

              <span />
              <button type="button" class="w-fit text-xs font-medium text-primary hover:underline" @click="configAdvancedOpen = !configAdvancedOpen">
                {{ configAdvancedOpen ? t("nacos.collapse") : t("nacos.advanced") }}
              </button>

              <template v-if="configAdvancedOpen">
                <Label class="text-right text-xs text-muted-foreground">{{ t("nacos.tags") }}</Label>
                <Input v-model="selectedConfig.tags" class="h-8" placeholder="tag1,tag2" @input="configSaveNotice = ''" />

                <Label class="text-right text-xs text-muted-foreground">{{ t("nacos.application") }}</Label>
                <Input v-model="selectedConfig.appName" class="h-8" @input="configSaveNotice = ''" />

                <Label class="text-right text-xs text-muted-foreground">{{ t("nacos.description") }}</Label>
                <Input v-model="selectedConfig.desc" class="h-8" @input="configSaveNotice = ''" />
              </template>

              <Label class="text-right text-xs">
                <span class="text-destructive">*</span>
                {{ t("nacos.format") }}
              </Label>
              <div class="flex min-w-0 flex-wrap gap-2">
                <button
                  v-for="format in configFormatOptions"
                  :key="format"
                  type="button"
                  class="rounded-md border px-2.5 py-1 text-xs font-medium transition-colors"
                  :class="configType === format ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-accent'"
                  @click="setConfigFormat(format)"
                >
                  {{ configFormatDisplayLabel(format) }}
                </button>
              </div>
            </div>
            <div class="mt-3 flex items-center justify-between gap-3">
              <div v-if="configSaveNotice" class="flex min-w-0 items-center gap-1.5 text-xs text-emerald-600">
                <CheckCircle2 class="h-3.5 w-3.5 shrink-0" />
                <span class="truncate">{{ configSaveNotice }}</span>
              </div>
              <span v-else />
              <div class="flex shrink-0 gap-2">
                <Button size="sm" variant="outline" class="h-8 gap-1.5" @click="copyConfigIdentity">
                  <Clipboard class="h-3.5 w-3.5" />
                  {{ t("nacos.copy") }}
                </Button>
                <Button size="sm" variant="outline" class="h-8 gap-1.5" @click="exportConfig">
                  <Download class="h-3.5 w-3.5" />
                  {{ t("nacos.export") }}
                </Button>
                <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="!selectedConfigOriginalKey" @click="openConfigHistory">
                  <FileClock class="h-3.5 w-3.5" />
                  {{ t("nacos.history") }}
                </Button>
                <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="readOnly" @click="saveConfigAsCopy">
                  <Save class="h-3.5 w-3.5" />
                  {{ t("nacos.saveAs") }}
                </Button>
                <Button size="sm" class="h-8 gap-1.5" :disabled="readOnly || savingConfig || !isConfigDirty" @click="requestSaveConfig">
                  <Loader2 v-if="savingConfig" class="h-3.5 w-3.5 animate-spin" />
                  <Send v-else class="h-3.5 w-3.5" />
                  {{ savingConfig ? t("nacos.saving") : t("nacos.save") }}
                </Button>
                <Button size="sm" variant="outline" class="h-8" :disabled="readOnly || deletingConfig" @click="requestDeleteConfig">
                  <Loader2 v-if="deletingConfig" class="h-3.5 w-3.5 animate-spin" />
                  <Trash2 v-else class="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </div>
          <div v-if="selectedConfig" class="relative min-h-0 flex-1 overflow-hidden bg-background">
            <div ref="configEditorHost" class="h-full min-h-0 overflow-hidden" />
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

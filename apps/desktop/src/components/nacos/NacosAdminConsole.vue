<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, useId, watch } from "vue";
import { Compartment, type Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { Archive, ArrowLeftRight, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Columns3, Download, FileClock, FileInput, FileText, Loader2, Network, Plus, RefreshCw, Save, Search, Send, Server, Trash2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import ProductionContextBadge from "@/components/common/ProductionContextBadge.vue";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import EditorSearchPanel from "@/components/editor/EditorSearchPanel.vue";
import NacosConfigDiffDialog from "@/components/nacos/NacosConfigDiffDialog.vue";
import NacosConfigHistoryDialog from "@/components/nacos/NacosConfigHistoryDialog.vue";
import NacosConfigBatchDialog, { type NacosBatchDialogMode, type NacosConfigTransferTarget } from "@/components/nacos/NacosConfigBatchDialog.vue";
import NacosContentSearchDialog from "@/components/nacos/NacosContentSearchDialog.vue";
import { useToast } from "@/composables/useToast";
import { useNacosConfigListColumnResize, type ToggleableNacosConfigListColumnKey } from "@/composables/useNacosConfigListColumnResize";
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
import { nacosInstanceMatchesPatch, nacosInstanceRefIdentity, nacosIpAddressIsValid, nacosServiceDetailMatches } from "@/lib/nacos/nacosServiceManagement";
import { nacosNamespaceIdentity, normalizeNacosNamespacesForDisplay } from "@/lib/nacos/nacosNamespaceVisibility";
import { copyToClipboard, readTextFromClipboard } from "@/lib/common/clipboard";
import { trimmedSelectionLayer } from "@/lib/editor/codemirrorTrimmedSelectionLayer";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";
import { editorFontTheme, loadEditorTheme } from "@/lib/editor/editorThemes";
import { clampEditorFontSize, createEditorZoomCommitScheduler, fontSizeFromWheelDelta } from "@/lib/editor/editorZoom";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
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
  NacosInstancePatch,
  NacosInstanceRef,
  NacosOperationCapability,
  NacosNamespaceInfo,
  NacosNamespaceScope,
  NacosSearchProgress,
  NacosServiceInfo,
  NacosServiceDetail,
  NacosServiceUpsert,
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
const NACOS_CONFIG_PAGE_SIZE_OPTIONS = [20, 50, 100, 200, 500] as const;
const NACOS_CONFIG_PAGE_SIZE_STORAGE_KEY = "dbx-nacos-config-page-size";
const savedNacosConfigPageSize = Number(safeLocalStorageGet(NACOS_CONFIG_PAGE_SIZE_STORAGE_KEY));
const configPageSize = ref<number>(NACOS_CONFIG_PAGE_SIZE_OPTIONS.find((size) => size === savedNacosConfigPageSize) ?? 20);
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
interface NacosBatchDeleteSnapshot {
  connectionId: string;
  namespace: string;
  keys: NacosConfigKey[];
}
const pendingBatchDelete = ref<NacosBatchDeleteSnapshot | null>(null);
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
const rnacosConsoleRetryErrorTarget = ref<"config" | "history" | "instances">("history");
const configFormatOptions = ["text", "json", "xml", "yaml", "html", "properties", "toml"];
const configEditorHost = ref<HTMLDivElement | null>(null);
const configEditorView = shallowRef<EditorView | null>(null);
const configSearchPanelRef = ref<InstanceType<typeof EditorSearchPanel>>();
const configEditorFontSize = ref(clampEditorFontSize(settingsStore.editorSettings.fontSize));
const configEditorZoomCommitScheduler = createEditorZoomCommitScheduler((fontSize) => {
  if (settingsStore.editorSettings.fontSize === fontSize) return;
  settingsStore.updateEditorSettings({ fontSize });
});
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
const configEditorWordWrap = new Compartment();
const configEditorLanguage = new Compartment();
const configListRequestGuard = createNacosLatestRequestGuard();
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
const selectedServiceDetail = ref<NacosServiceDetail | null>(null);
const serviceDetailLoading = ref(false);
const serviceDetailError = ref("");
const serviceDetailExpanded = ref(false);
const instances = ref<NacosInstanceInfo[]>([]);
const instancesLoading = ref(false);
const instancesError = ref("");
const updatingInstanceKeys = ref<Record<string, number>>({});
const instanceWeightDrafts = ref<Record<string, string>>({});
const pendingInstanceUpdate = ref<{ instance: NacosInstanceInfo; patch: NacosInstancePatch } | null>(null);
const instanceEditorOpen = ref(false);
const instanceEditorError = ref("");
const instanceEditorTarget = ref<NacosInstanceInfo | null>(null);
const instanceEditor = ref({ weight: "1", metadata: "{}" });
const serviceEditorOpen = ref(false);
const serviceEditorLoading = ref(false);
const serviceEditorError = ref("");
const serviceEditorMode = ref<"create" | "update">("create");
const serviceEditor = ref({ serviceName: "", groupName: "", metadata: "{}", protectThreshold: "0", selector: "" });
const pendingServiceDelete = ref<NacosServiceInfo | null>(null);
const deletingService = ref(false);
const registeringInstance = ref(false);
const registerInstanceOpen = ref(false);
const registerInstanceError = ref("");
const registerInstance = ref({ ip: "", port: "", clusterName: "DEFAULT", weight: "1", metadata: "{}" });
const pendingInstanceDeregister = ref<NacosInstanceInfo | null>(null);
const servicesRequestGuard = createNacosLatestRequestGuard();
const serviceDetailRequestGuard = createNacosLatestRequestGuard();
const instancesRequestGuard = createNacosLatestRequestGuard();
let instanceUpdateSequence = 0;
let instanceOperationToken = 0;
let serviceMutationSequence = 0;

const NACOS_SPLIT_SIZE_KEY = "dbx-nacos-admin-split-size";
const savedNacosSplitSize = Number(safeLocalStorageGet(NACOS_SPLIT_SIZE_KEY));
const nacosSplitSize = ref(savedNacosSplitSize >= 20 && savedNacosSplitSize <= 80 ? savedNacosSplitSize : 42);
const CONNECTION_NOT_FOUND_RETRY_DELAYS_MS = [150, 350, 700];
const configListViewport = ref<HTMLElement | null>(null);
const configListViewportWidth = ref(0);
let configListResizeObserver: ResizeObserver | null = null;
const {
  visibleColumns: configListColumns,
  toggleableColumns: configListToggleableColumns,
  gridTemplateColumns: configListGridTemplate,
  minWidth: configListMinWidth,
  resizingColumnIndex: configListResizingColumnIndex,
  onResizeStart: onConfigListColumnResizeStart,
  isColumnVisible: isConfigListColumnVisible,
  setColumnVisible: setConfigListColumnVisible,
} = useNacosConfigListColumnResize(configListViewportWidth);

function configListColumnLabel(column: ToggleableNacosConfigListColumnKey) {
  if (column === "group") return t("nacos.group");
  if (column === "application") return t("nacos.configListApplication");
  return t("nacos.configListFormat");
}

function isSelectedConfigListItem(item: NacosConfigItem) {
  return selectedConfig.value?.dataId === item.dataId && selectedConfig.value?.group === item.group && (selectedConfig.value?.namespace || namespace.value) === (item.namespace || namespace.value);
}

const namespace = computed(() => props.namespace ?? connectionInfo.value?.namespace ?? "");
const nacosProductionContext = computed(() => productionContextForDatabase(connectionStore.getConfig(props.connectionId), namespace.value));
const batchTargetConnections = computed<NacosConfigTransferTarget[]>(() =>
  connectionStore.connections
    .filter((connection) => connection.db_type === "nacos" && !connection.read_only)
    .map((connection) => {
      const address = [connection.host, connection.port].filter(Boolean).join(":");
      return { id: connection.id, label: connection.name ? `${connection.name} (${address})` : address || connection.id };
    }),
);
const supportsConfigHistory = computed(() => connectionInfo.value?.capabilities.supportsConfigHistory !== false);

async function confirmNacosMutation(reviewText: string, targetConnectionId = props.connectionId, targetNamespace = namespace.value): Promise<boolean> {
  const confirmed = await executeWithProductionContextGuard({
    connection: connectionStore.getConfig(targetConnectionId),
    database: targetNamespace,
    reviewText,
    source: t("production.sourceAdmin"),
    execute: async () => true,
  });
  return confirmed === true;
}
function operationCapability(capability: NacosOperationCapability | boolean | undefined, legacySupported = true): NacosOperationCapability {
  if (typeof capability === "boolean") return { supported: capability, reason: capability ? undefined : "notVerified" };
  return capability ?? { supported: legacySupported, reason: legacySupported ? undefined : "notVerified" };
}

const serviceCapabilities = computed(() => connectionInfo.value?.capabilities.serviceManagement);
const legacyServiceManagementSupported = computed(() => connectionInfo.value != null && connectionInfo.value.capabilities.supportsServiceManagement !== false);
const legacyInstanceUpdateSupported = computed(() => connectionInfo.value != null && connectionInfo.value.capabilities.supportsInstanceUpdate !== false);
const listServicesCapability = computed(() => operationCapability(serviceCapabilities.value?.listServices, legacyServiceManagementSupported.value));
const getServiceCapability = computed(() => operationCapability(serviceCapabilities.value?.getService, listServicesCapability.value.supported));
const createServiceCapability = computed(() => operationCapability(serviceCapabilities.value?.createService, legacyServiceManagementSupported.value));
const updateServiceCapability = computed(() => operationCapability(serviceCapabilities.value?.updateService, createServiceCapability.value.supported));
const deleteServiceCapability = computed(() => operationCapability(serviceCapabilities.value?.deleteService, createServiceCapability.value.supported));
const listInstancesCapability = computed(() => operationCapability(serviceCapabilities.value?.listInstances, listServicesCapability.value.supported));
const updateInstanceCapability = computed(() => operationCapability(serviceCapabilities.value?.updateInstance, legacyInstanceUpdateSupported.value));
const registerInstanceCapability = computed(() => operationCapability(serviceCapabilities.value?.registerInstance, updateInstanceCapability.value.supported));
const deregisterInstanceCapability = computed(() => operationCapability(serviceCapabilities.value?.deregisterInstance, updateInstanceCapability.value.supported));
const supportsServiceManagement = computed(() => listServicesCapability.value.supported);
const supportsInstanceUpdate = computed(() => updateInstanceCapability.value.supported);

function capabilityReason(capability: NacosOperationCapability) {
  if (props.readOnly) return t("nacos.capabilityReadOnly");
  switch (capability.reason) {
    case "implementationReadOnly":
      return t("nacos.capabilityReadOnlyWrite");
    case "versionUnsupported":
      return t("nacos.capabilityVersionUnsupported");
    case "endpointUnavailable":
      return t("nacos.capabilityEndpointUnavailable");
    case "connectionReadOnly":
      return t("nacos.capabilityReadOnly");
    default:
      return t("nacos.capabilityNotVerified");
  }
}

const serviceWriteNotice = computed(() => {
  if (props.readOnly) return t("nacos.capabilityHeaderReadOnly");
  const unsupported = [createServiceCapability.value, updateServiceCapability.value, deleteServiceCapability.value, updateInstanceCapability.value, registerInstanceCapability.value, deregisterInstanceCapability.value].find((capability) => !capability.supported);
  return unsupported ? capabilityReason(unsupported) : "";
});
const selectedServiceProtectionTriggered = computed(() => {
  if (selectedService.value?.triggerFlag === "true") return true;
  const threshold = selectedServiceDetail.value?.protectThreshold;
  if (threshold == null || threshold <= 0 || serviceCluster.value.trim()) return false;
  const total = selectedService.value?.ipCount ?? instances.value.length;
  const healthy = selectedService.value?.healthyInstanceCount ?? instances.value.filter((instance) => instance.healthy === true).length;
  return total > 0 && healthy / total < threshold;
});
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
const selectedConfigCount = computed(() => selectedConfigKeys.value.length);
const canRequestConfigSave = computed(() => canStartNacosConfigSave(configMutationGuardState.value));
const canRequestConfigDelete = computed(() => canStartNacosConfigDelete(configMutationGuardState.value, selectedConfigOriginalKey.value));
const pendingDeleteDetails = computed(() => (pendingDeleteConfig.value ? buildNacosConfigDeleteConfirm(pendingDeleteConfig.value.config, pendingDeleteConfig.value.key.namespace || "") : ""));
const canRequestBatchDeleteConfigs = computed(() => !props.readOnly && !savingConfig.value && !deletingConfig.value && !pendingConfigSave.value && !pendingDeleteConfig.value && selectedConfigCount.value > 0);
const pendingBatchDeleteDetails = computed(() => pendingBatchDelete.value?.keys.map((key) => `namespace=${key.namespace || "public"}\ndataId=${key.dataId}\ngroup=${key.group || "DEFAULT_GROUP"}`).join("\n\n") || "");
const pendingHistoryRollbackDetails = computed(() => (pendingHistoryRollback.value ? buildNacosConfigHistoryRollbackConfirm(pendingHistoryRollback.value, namespace.value) : ""));
const pendingInstanceDetails = computed(() => (pendingInstanceUpdate.value && selectedService.value ? buildNacosInstanceConfirm(selectedService.value, pendingInstanceUpdate.value.instance, pendingInstanceUpdate.value.patch, serviceGroup.value, namespace.value) : ""));
const pendingInstanceDeregisterDetails = computed(() => {
  if (!pendingInstanceDeregister.value || !selectedService.value) return "";
  const ref = instanceRef(pendingInstanceDeregister.value);
  const lifetime = ref.ephemeral === true ? t("nacos.instanceEphemeral") : ref.ephemeral === false ? t("nacos.instancePersistent") : t("nacos.instanceUnknown");
  return t("nacos.instanceConfirmDetails", {
    namespace: ref.namespace || "public",
    service: `${ref.groupName || "DEFAULT_GROUP"}@@${ref.serviceName}`,
    ip: ref.ip,
    port: ref.port,
    cluster: ref.clusterName || "DEFAULT",
    type: lifetime,
  });
});
const hasSearchSession = computed(() => !!(searchResult.value || searchProgress.value || searchError.value));
const retainedSearchMatchCount = computed(() => searchResult.value?.matches.length ?? searchProgress.value?.matches.length ?? 0);
const currentPageConfigKeys = computed(() => configs.value.map((item) => configIdentityKey(item)));
const allCurrentPageSelected = computed(() => currentPageConfigKeys.value.length > 0 && currentPageConfigKeys.value.every((key) => selectedConfigKeys.value.includes(key)));

function configIdentityKey(item: { namespace?: string; group?: string; dataId: string }): string {
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

function isBatchDeleteSnapshotInScope(snapshot: NacosBatchDeleteSnapshot) {
  return snapshot.connectionId === props.connectionId && snapshot.namespace === namespace.value;
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
            groupContains: true,
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
  configEditorFontSize.value = clampEditorFontSize(editorSettings.fontSize);
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
        EditorState.allowMultipleSelections.of(true),
        trimmedSelectionLayer(),
        Prec.highest(keymap.of([{ key: "Mod-f", run: () => configSearchPanelRef.value?.openSearch() ?? false, preventDefault: true }, { key: "Mod-h", run: () => configSearchPanelRef.value?.openReplace() ?? false, preventDefault: true }, indentWithTab])),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.domEventHandlers({
          wheel(event, eventView) {
            if (!event.metaKey && !event.ctrlKey) return false;
            event.preventDefault();
            const next = fontSizeFromWheelDelta(configEditorFontSize.value, event.deltaY);
            if (next !== configEditorFontSize.value) {
              configEditorFontSize.value = next;
              eventView.dispatch({
                effects: configEditorFontTheme.reconfigure(editorFontTheme(EditorView, next, settingsStore.editorSettings.fontFamily, { fixedHeight: true, scrollable: true })),
              });
            }
            configEditorZoomCommitScheduler.schedule(next);
            return true;
          },
        }),
        configEditorLanguage.of(language),
        configEditorTheme.of(theme),
        configEditorFontTheme.of(editorFontTheme(EditorView, editorSettings.fontSize, editorSettings.fontFamily, { fixedHeight: true, scrollable: true })),
        configEditorWordWrap.of(editorSettings.wordWrap ? EditorView.lineWrapping : []),
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

async function loadConfigs(page = configPageNo.value): Promise<boolean> {
  const requestId = configListRequestGuard.begin();
  const connectionId = props.connectionId;
  const requestNamespace = namespace.value;
  const requestGroup = configGroup.value.trim();
  const requestDataId = configDataId.value.trim();
  const requestAppName = configAppName.value.trim();
  const requestPageSize = configPageSize.value;
  const isCurrentRequest = () =>
    configListRequestGuard.isCurrent(requestId) &&
    connectionId === props.connectionId &&
    requestNamespace === namespace.value &&
    requestGroup === configGroup.value.trim() &&
    requestDataId === configDataId.value.trim() &&
    requestAppName === configAppName.value.trim() &&
    requestPageSize === configPageSize.value;
  configLoading.value = true;
  configError.value = "";
  configPageNo.value = page;
  try {
    const result = await api.nacosListConfigs(connectionId, {
      namespace: requestNamespace || undefined,
      group: requestGroup || undefined,
      groupContains: true,
      dataId: requestDataId || undefined,
      appName: requestAppName || undefined,
      pageNo: page,
      pageSize: requestPageSize,
    });
    if (!isCurrentRequest()) return false;
    const lastPage = Math.max(1, Math.ceil(result.totalCount / Math.max(1, requestPageSize)));
    if (page > lastPage) return loadConfigs(lastPage);
    configs.value = applyKnownConfigFormats(result.items.map(normalizeConfigItemFormat));
    configTotal.value = result.totalCount;
    return true;
  } catch (error) {
    if (!isCurrentRequest()) return false;
    await handleRNacosConsoleError(
      error,
      async () => {
        await loadConfigs(page);
      },
      "config",
    );
    return true;
  } finally {
    if (configListRequestGuard.isCurrent(requestId)) configLoading.value = false;
  }
}

async function loadConfigsWithRetry(page = configPageNo.value) {
  for (let attempt = 0; ; attempt += 1) {
    const current = await loadConfigs(page);
    if (!current || !isConnectionNotFoundError(configError.value) || attempt >= CONNECTION_NOT_FOUND_RETRY_DELAYS_MS.length) return;
    await delay(CONNECTION_NOT_FOUND_RETRY_DELAYS_MS[attempt]);
  }
}

function clearConfigFilter(filter: "dataId" | "group" | "appName") {
  if (filter === "dataId") configDataId.value = "";
  else if (filter === "group") configGroup.value = "";
  else configAppName.value = "";
  void loadConfigsWithRetry(1);
}

function setConfigPageSize(value: string) {
  const nextPageSize = Number(value);
  if (!NACOS_CONFIG_PAGE_SIZE_OPTIONS.some((size) => size === nextPageSize) || nextPageSize === configPageSize.value) return;
  configPageSize.value = nextPageSize;
  safeLocalStorageSet(NACOS_CONFIG_PAGE_SIZE_STORAGE_KEY, String(nextPageSize));
  void loadConfigsWithRetry(1);
}

function closePendingConfigMutationConfirmations() {
  pendingConfigSave.value = false;
  if (!deletingConfig.value) {
    pendingDeleteConfig.value = null;
    pendingBatchDelete.value = null;
  }
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
  const namespaceInfo = batchNamespaces.value.find((item) => nacosNamespaceIdentity(item.namespace) === nacosNamespaceIdentity(targetNamespace));
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
    batchNamespaces.value = normalizeNacosNamespacesForDisplay(namespaces);
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
    batchTargetNamespaces.value = normalizeNacosNamespacesForDisplay(namespaces);
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
  const targetConnectionId = batchMode.value === "import" ? props.connectionId : payload.targetConnectionId;
  const targetNamespace = batchMode.value === "import" ? namespace.value : payload.targetNamespace;
  const operation = batchMode.value === "import" ? t("nacos.batchImport") : t("nacos.copyToNamespace");
  if (!(await confirmNacosMutation(operation, targetConnectionId, targetNamespace))) return;
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

function setRNacosConsoleActionError(target: "config" | "history" | "instances", message: string) {
  if (target === "config") configError.value = message;
  else if (target === "history") historyError.value = message;
  else instancesError.value = message;
}

async function handleRNacosConsoleError(error: unknown, retryAction: () => Promise<void>, target: "config" | "history" | "instances") {
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
  if (!(await confirmNacosMutation(t("nacos.historyRollback"), props.connectionId, pendingHistoryRollback.value.namespace || namespace.value))) return;
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
  if (!(await confirmNacosMutation(t("nacos.publish"), snapshot.connectionId, snapshot.targetKey.namespace || namespace.value))) return;
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

function reconcileDeletedConfigSelection(deletedKeys: ReadonlySet<string>) {
  if (!deletedKeys.size) return;
  selectedConfigKeys.value = selectedConfigKeys.value.filter((key) => !deletedKeys.has(key));
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
  if (!(await confirmNacosMutation(t("nacos.delete"), snapshot.connectionId, snapshot.key.namespace || namespace.value))) return;
  const editorSessionId = configEditorSessionId;
  pendingDeleteConfig.value = null;
  deletingConfig.value = true;
  configError.value = "";
  configSaveNotice.value = "";
  try {
    await api.nacosDeleteConfig(snapshot.connectionId, snapshot.key);
    const remainsInDeletedScope = isNacosConfigDeleteSnapshotInScope(snapshot, props.connectionId, namespace.value);
    if (remainsInDeletedScope) {
      reconcileDeletedConfigSelection(new Set([configIdentityKey(snapshot.key)]));
      await loadConfigs();
    }
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

function requestBatchDeleteConfigs() {
  if (!canRequestBatchDeleteConfigs.value) return;
  const keys = selectedKeys();
  if (!keys.length) return;
  pendingBatchDelete.value = {
    connectionId: props.connectionId,
    namespace: namespace.value,
    keys: keys.map((key) => ({
      namespace: key.namespace || undefined,
      dataId: key.dataId,
      group: key.group || "DEFAULT_GROUP",
    })),
  };
}

async function deleteSelectedConfigs() {
  const snapshot = pendingBatchDelete.value;
  if (!snapshot || !isBatchDeleteSnapshotInScope(snapshot)) {
    pendingBatchDelete.value = null;
    return;
  }
  if (!canRequestBatchDeleteConfigs.value) return;
  if (!(await confirmNacosMutation(t("nacos.batchDelete"), snapshot.connectionId, snapshot.namespace))) return;
  if (!isBatchDeleteSnapshotInScope(snapshot)) {
    pendingBatchDelete.value = null;
    return;
  }

  const editorSessionId = configEditorSessionId;
  pendingBatchDelete.value = null;
  deletingConfig.value = true;
  configError.value = "";
  configSaveNotice.value = "";
  const deletedKeys = new Set<string>();
  let firstError = "";
  let interrupted = false;
  try {
    // Reuse the version-aware single-config delete path rather than relying on a batch API that differs across Nacos implementations.
    for (const key of snapshot.keys) {
      if (!isBatchDeleteSnapshotInScope(snapshot)) {
        interrupted = true;
        break;
      }
      try {
        await api.nacosDeleteConfig(snapshot.connectionId, key);
        deletedKeys.add(configIdentityKey(key));
      } catch (error) {
        if (!firstError) firstError = error instanceof Error ? error.message : String(error);
      }
    }

    if (!isBatchDeleteSnapshotInScope(snapshot)) interrupted = true;
    if (!interrupted) {
      if (deletedKeys.size) {
        reconcileDeletedConfigSelection(deletedKeys);
        await loadConfigs();
      }
      const selectedKey = selectedConfigOriginalKey.value;
      const stillViewingDeletedConfig = editorSessionId === configEditorSessionId && selectedKey != null && deletedKeys.has(configIdentityKey(selectedKey));
      if (stillViewingDeletedConfig) {
        configDetailRequestGuard.invalidate();
        configEditorSessionId += 1;
        selectedConfig.value = null;
        selectedConfigOriginalKey.value = null;
        configContent.value = "";
        originalConfigContent.value = "";
        destroyConfigEditor();
      }

      if (firstError) {
        configError.value = `${t("nacos.batchDeletePartial", { deleted: deletedKeys.size, failed: snapshot.keys.length - deletedKeys.size })} ${firstError}`;
        toast(t("nacos.batchDeletePartial", { deleted: deletedKeys.size, failed: snapshot.keys.length - deletedKeys.size }), 3000);
      } else {
        toast(t("nacos.batchDeleteSuccess", { count: deletedKeys.size }), 2000);
      }
    } else {
      toast(t("nacos.batchDeleteInterrupted", { deleted: deletedKeys.size }), 3000);
    }
  } finally {
    deletingConfig.value = false;
  }
}

async function loadServices(page = servicePageNo.value) {
  const requestId = servicesRequestGuard.begin();
  const connectionId = props.connectionId;
  const requestNamespace = namespace.value;
  const requestGroup = serviceGroup.value.trim();
  const requestName = serviceName.value.trim();
  servicesLoading.value = true;
  servicesError.value = "";
  servicePageNo.value = page;
  try {
    const result = await api.nacosListServices(connectionId, {
      namespace: requestNamespace || undefined,
      groupName: requestGroup || undefined,
      serviceName: requestName || undefined,
      pageNo: page,
      pageSize: servicePageSize.value,
    });
    if (!servicesRequestGuard.isCurrent(requestId) || connectionId !== props.connectionId || requestNamespace !== namespace.value || requestGroup !== serviceGroup.value.trim() || requestName !== serviceName.value.trim()) return;
    services.value = result.items;
    serviceTotal.value = result.totalCount;
    const selectedIdentity = serviceIdentity(selectedService.value);
    if (selectedIdentity) {
      const refreshedSelection = result.items.find((item) => serviceIdentity(item) === selectedIdentity);
      if (refreshedSelection) selectedService.value = refreshedSelection;
    }
  } catch (error) {
    if (!servicesRequestGuard.isCurrent(requestId)) return;
    servicesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (servicesRequestGuard.isCurrent(requestId)) servicesLoading.value = false;
  }
}

async function loadServicesWithRetry(page = servicePageNo.value) {
  for (let attempt = 0; ; attempt += 1) {
    await loadServices(page);
    if (!isConnectionNotFoundError(servicesError.value) || attempt >= CONNECTION_NOT_FOUND_RETRY_DELAYS_MS.length) return;
    await delay(CONNECTION_NOT_FOUND_RETRY_DELAYS_MS[attempt]);
  }
}

function clearServiceFilter(filter: "name" | "group") {
  if (filter === "name") serviceName.value = "";
  else serviceGroup.value = "";
  void loadServicesWithRetry(1);
}

async function selectService(service: NacosServiceInfo) {
  serviceMutationSequence += 1;
  instanceUpdateSequence += 1;
  selectedService.value = service;
  selectedServiceDetail.value = null;
  serviceDetailError.value = "";
  instances.value = [];
  instancesError.value = "";
  await Promise.all([loadServiceDetail(), loadInstances()]);
}

function serviceIdentity(service: NacosServiceInfo | null) {
  return service ? `${service.groupName || "DEFAULT_GROUP"}\u0000${service.serviceName}` : "";
}

async function loadServiceDetail() {
  const service = selectedService.value ? { ...selectedService.value } : null;
  if (!service || !getServiceCapability.value.supported) return;
  const requestId = serviceDetailRequestGuard.begin();
  const connectionId = props.connectionId;
  const requestNamespace = namespace.value;
  const identity = serviceIdentity(service);
  serviceDetailLoading.value = true;
  serviceDetailError.value = "";
  try {
    const detail = await api.nacosGetService(connectionId, {
      namespace: requestNamespace || undefined,
      serviceName: service.serviceName,
      groupName: service.groupName || serviceGroup.value || undefined,
    });
    if (!serviceDetailRequestGuard.isCurrent(requestId) || connectionId !== props.connectionId || requestNamespace !== namespace.value || identity !== serviceIdentity(selectedService.value)) return;
    selectedServiceDetail.value = detail;
  } catch (error) {
    if (!serviceDetailRequestGuard.isCurrent(requestId)) return;
    serviceDetailError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (serviceDetailRequestGuard.isCurrent(requestId)) serviceDetailLoading.value = false;
  }
}

async function reconcileServiceMutation(expected: NacosServiceUpsert, mutationId: number) {
  const expectedIdentity = `${expected.groupName || "DEFAULT_GROUP"}\u0000${expected.serviceName}`;
  for (const retryDelay of [0, 250, 750]) {
    if (retryDelay) await delay(retryDelay);
    if (mutationId !== serviceMutationSequence || expectedIdentity !== serviceIdentity(selectedService.value)) return;
    try {
      const detail = await api.nacosGetService(props.connectionId, {
        namespace: expected.namespace,
        serviceName: expected.serviceName,
        groupName: expected.groupName,
      });
      if (mutationId !== serviceMutationSequence || expectedIdentity !== serviceIdentity(selectedService.value)) return;
      if (nacosServiceDetailMatches(detail, expected)) {
        selectedServiceDetail.value = detail;
        serviceDetailError.value = "";
        await loadServicesWithRetry(1);
        if (expectedIdentity === serviceIdentity(selectedService.value)) await loadInstances();
        return;
      }
    } catch {
      // The explicit warning below preserves the optimistic detail and gives
      // the user a deliberate refresh path when Nacos is briefly stale.
    }
  }
  if (mutationId === serviceMutationSequence) serviceDetailError.value = t("nacos.serviceUpdateUnconfirmed");
}

function instanceRef(instance: NacosInstanceInfo, service = selectedService.value): NacosInstanceRef {
  return {
    namespace: namespace.value || undefined,
    serviceName: service?.serviceName || instance.serviceName || "",
    groupName: instance.groupName || service?.groupName || serviceGroup.value || undefined,
    ip: instance.ip,
    port: instance.port,
    clusterName: instance.clusterName,
    ephemeral: instance.ephemeral,
  };
}

function instanceIdentity(instance: NacosInstanceInfo, service = selectedService.value) {
  return instanceRefIdentity(instanceRef(instance, service));
}

function instanceRefIdentity(ref: NacosInstanceRef) {
  return nacosInstanceRefIdentity(ref);
}

function beginInstanceOperation(key: string) {
  const token = ++instanceOperationToken;
  updatingInstanceKeys.value = { ...updatingInstanceKeys.value, [key]: token };
  return token;
}

function isInstanceUpdating(instance: NacosInstanceInfo) {
  return Object.prototype.hasOwnProperty.call(updatingInstanceKeys.value, instanceIdentity(instance));
}

function clearInstanceOperation(key: string, token: number) {
  if (updatingInstanceKeys.value[key] !== token) return;
  const next = { ...updatingInstanceKeys.value };
  delete next[key];
  updatingInstanceKeys.value = next;
}

function instanceWeightDraft(instance: NacosInstanceInfo) {
  return instanceWeightDrafts.value[instanceIdentity(instance)] ?? String(instance.weight ?? 1);
}

function updateInstanceWeightDraft(instance: NacosInstanceInfo, value: string | number) {
  instanceWeightDrafts.value[instanceIdentity(instance)] = String(value);
}

function hasInstanceWeightDraft(instance: NacosInstanceInfo) {
  const value = instanceWeightDraft(instance).trim();
  return value !== "" && Number.isFinite(Number(value)) && Number(value) !== (instance.weight ?? 1);
}

function resetInstanceWeightDraft(instance: NacosInstanceInfo) {
  delete instanceWeightDrafts.value[instanceIdentity(instance)];
}

function requestInstanceWeightUpdate(instance: NacosInstanceInfo) {
  const value = instanceWeightDraft(instance).trim();
  const weight = Number(value);
  if (!value || !Number.isFinite(weight) || weight < 0) {
    instancesError.value = t("nacos.invalidWeight");
    return;
  }
  requestUpdateInstance(instance, { weight });
}

function openInstanceEditor(instance: NacosInstanceInfo) {
  instanceEditorTarget.value = instance;
  instanceEditor.value = {
    weight: String(instance.weight ?? 1),
    metadata: JSON.stringify(instance.metadata ?? {}, null, 2),
  };
  instanceEditorError.value = "";
  instanceEditorOpen.value = true;
}

function submitInstanceEditor() {
  const instance = instanceEditorTarget.value;
  const weight = Number(instanceEditor.value.weight);
  if (!instance || !Number.isFinite(weight) || weight < 0) {
    instanceEditorError.value = t("nacos.invalidWeightInput");
    return;
  }
  try {
    const metadata = parseJsonObject(instanceEditor.value.metadata, t("nacos.metadataLabel"));
    instanceEditorOpen.value = false;
    requestUpdateInstance(instance, { weight, metadata });
  } catch (error) {
    instanceEditorError.value = error instanceof Error ? error.message : String(error);
  }
}

function instanceMatchesPatch(instance: NacosInstanceInfo, patch: NacosInstancePatch) {
  return nacosInstanceMatchesPatch(instance, patch);
}

async function loadInstances() {
  if (!selectedService.value) return;
  instanceUpdateSequence += 1;
  if (!listInstancesCapability.value.supported) {
    instancesError.value = capabilityReason(listInstancesCapability.value);
    return;
  }
  const requestId = instancesRequestGuard.begin();
  const connectionId = props.connectionId;
  const requestNamespace = namespace.value;
  const service = { ...selectedService.value };
  const selectedIdentity = serviceIdentity(service);
  const clusters = serviceCluster.value.trim();
  instancesLoading.value = true;
  instancesError.value = "";
  try {
    const result = await api.nacosListInstances(connectionId, {
      namespace: requestNamespace || undefined,
      serviceName: service.serviceName,
      groupName: service.groupName || serviceGroup.value || undefined,
      clusters: clusters || undefined,
    });
    if (!instancesRequestGuard.isCurrent(requestId) || connectionId !== props.connectionId || requestNamespace !== namespace.value || selectedIdentity !== serviceIdentity(selectedService.value) || clusters !== serviceCluster.value.trim()) return;
    instances.value = result;
  } catch (error) {
    if (!instancesRequestGuard.isCurrent(requestId)) return;
    await handleRNacosConsoleError(error, () => loadInstances(), "instances");
  } finally {
    if (instancesRequestGuard.isCurrent(requestId)) instancesLoading.value = false;
  }
}

async function refreshSelectedService() {
  if (!selectedService.value) return;
  await Promise.all([loadServiceDetail(), loadInstances(), loadServices(servicePageNo.value)]);
}

function requestUpdateInstance(instance: NacosInstanceInfo, patch: NacosInstancePatch) {
  if (!selectedService.value || props.readOnly || !supportsInstanceUpdate.value) return;
  if (patch.weight != null && (!Number.isFinite(patch.weight) || patch.weight < 0)) {
    instancesError.value = t("nacos.invalidWeight");
    return;
  }
  pendingInstanceUpdate.value = { instance, patch };
}

async function reconcileInstanceUpdate(ref: NacosInstanceRef, patch: NacosInstancePatch, updateId: number) {
  const currentService = selectedService.value;
  if (!currentService || serviceIdentity(currentService) !== `${ref.groupName || "DEFAULT_GROUP"}\u0000${ref.serviceName}`) return;
  for (const retryDelay of [0, 250, 750]) {
    if (retryDelay) await delay(retryDelay);
    if (updateId !== instanceUpdateSequence || serviceIdentity(selectedService.value) !== serviceIdentity(currentService)) return;
    try {
      const result = await api.nacosListInstances(props.connectionId, {
        namespace: ref.namespace,
        serviceName: ref.serviceName,
        groupName: ref.groupName,
        clusters: serviceCluster.value.trim() || undefined,
      });
      if (updateId !== instanceUpdateSequence || serviceIdentity(selectedService.value) !== serviceIdentity(currentService)) return;
      const actual = result.find((candidate) => instanceIdentity(candidate, currentService) === instanceRefIdentity(ref));
      if (actual && instanceMatchesPatch(actual, patch)) {
        instances.value = result;
        void loadServices(servicePageNo.value);
        return;
      }
    } catch {
      // Keep the optimistic result visible. The final warning gives the user a
      // deliberate refresh path instead of silently replacing it with stale data.
    }
  }
  if (updateId === instanceUpdateSequence) instancesError.value = t("nacos.instanceUpdateUnconfirmed");
}

async function reconcileInstancePresence(ref: NacosInstanceRef, shouldExist: boolean, updateId: number) {
  const currentService = selectedService.value;
  if (!currentService || serviceIdentity(currentService) !== `${ref.groupName || "DEFAULT_GROUP"}\u0000${ref.serviceName}`) return;
  for (const retryDelay of [0, 250, 750]) {
    if (retryDelay) await delay(retryDelay);
    if (updateId !== instanceUpdateSequence || serviceIdentity(selectedService.value) !== serviceIdentity(currentService)) return;
    try {
      const result = await api.nacosListInstances(props.connectionId, {
        namespace: ref.namespace,
        serviceName: ref.serviceName,
        groupName: ref.groupName,
        clusters: serviceCluster.value.trim() || undefined,
      });
      if (updateId !== instanceUpdateSequence || serviceIdentity(selectedService.value) !== serviceIdentity(currentService)) return;
      const exists = result.some((candidate) => instanceIdentity(candidate, currentService) === instanceRefIdentity(ref));
      if (exists === shouldExist) {
        instances.value = result;
        instancesError.value = "";
        void loadServices(servicePageNo.value);
        return;
      }
    } catch {
      // Keep the optimistic list until the final warning offers a refresh.
    }
  }
  if (updateId === instanceUpdateSequence) instancesError.value = shouldExist ? t("nacos.instanceRegisterUnconfirmed") : t("nacos.instanceDeregisterUnconfirmed");
}

async function updateInstance(instance: NacosInstanceInfo, patch: NacosInstancePatch) {
  if (!selectedService.value || props.readOnly || !supportsInstanceUpdate.value) return;
  const ref = instanceRef(instance);
  if (!(await confirmNacosMutation(t("nacos.confirmInstanceTitle"), props.connectionId, ref.namespace || namespace.value))) return;
  const key = instanceIdentity(instance);
  const updateId = ++instanceUpdateSequence;
  const operationToken = beginInstanceOperation(key);
  try {
    await api.nacosUpdateInstance(props.connectionId, { target: ref, patch });
    if (updateId !== instanceUpdateSequence) return;
    instances.value = instances.value.map((candidate) => (instanceIdentity(candidate) === key ? { ...candidate, ...patch } : candidate));
    if (patch.weight != null) delete instanceWeightDrafts.value[key];
    pendingInstanceUpdate.value = null;
    void reconcileInstanceUpdate(ref, patch, updateId);
  } catch (error) {
    if (updateId === instanceUpdateSequence) {
      pendingInstanceUpdate.value = null;
      instancesError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    clearInstanceOperation(key, operationToken);
  }
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(`${label}${t("nacos.jsonObjectValidation")}`);
  return parsed as Record<string, unknown>;
}

function parseOptionalJsonObject(value: string, label: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  // Nacos rejects an empty selector object because it has no selector type.
  // Treat an empty editor or `{}` as the absence of a selector instead.
  if (!trimmed || trimmed === "{}") return undefined;
  return parseJsonObject(trimmed, label);
}

function openCreateService() {
  serviceEditorMode.value = "create";
  serviceEditor.value = { serviceName: "", groupName: serviceGroup.value || "DEFAULT_GROUP", metadata: "{}", protectThreshold: "0", selector: "" };
  serviceEditorError.value = "";
  serviceEditorOpen.value = true;
}

async function openUpdateService(service: NacosServiceInfo) {
  serviceEditorLoading.value = true;
  serviceEditorError.value = "";
  try {
    const detail: NacosServiceDetail = await api.nacosGetService(props.connectionId, { namespace: namespace.value || undefined, serviceName: service.serviceName, groupName: service.groupName });
    serviceEditorMode.value = "update";
    serviceEditor.value = {
      serviceName: detail.serviceName,
      groupName: detail.groupName || service.groupName || "DEFAULT_GROUP",
      metadata: JSON.stringify(detail.metadata ?? {}, null, 2),
      protectThreshold: String(detail.protectThreshold ?? 0),
      selector: detail.selector && typeof detail.selector === "object" && !Array.isArray(detail.selector) && Object.keys(detail.selector).length > 0 ? JSON.stringify(detail.selector, null, 2) : "",
    };
    serviceEditorOpen.value = true;
  } catch (error) {
    instancesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    serviceEditorLoading.value = false;
  }
}

async function submitServiceEditor() {
  const threshold = Number(serviceEditor.value.protectThreshold);
  if (!serviceEditor.value.serviceName.trim() || !serviceEditor.value.groupName.trim() || !Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    serviceEditorError.value = t("nacos.serviceValidation");
    return;
  }
  serviceEditorLoading.value = true;
  serviceEditorError.value = "";
  try {
    const isCreating = serviceEditorMode.value === "create";
    const targetGroup = isCreating ? serviceEditor.value.groupName.trim() : selectedService.value?.groupName || serviceEditor.value.groupName.trim();
    const req: NacosServiceUpsert = {
      namespace: namespace.value || undefined,
      serviceName: serviceEditor.value.serviceName.trim(),
      groupName: targetGroup,
      metadata: parseJsonObject(serviceEditor.value.metadata, t("nacos.metadataLabel")),
      protectThreshold: threshold,
      selector: parseOptionalJsonObject(serviceEditor.value.selector, t("nacos.selectorLabel")),
    };
    const operation = isCreating ? t("nacos.createNacosService") : t("nacos.editNacosService");
    if (!(await confirmNacosMutation(operation, props.connectionId, req.namespace || namespace.value))) return;
    const mutationId = ++serviceMutationSequence;
    if (isCreating) await api.nacosCreateService(props.connectionId, req);
    else await api.nacosUpdateService(props.connectionId, req);
    serviceEditorOpen.value = false;
    if (isCreating && req.groupName) serviceGroup.value = req.groupName;
    selectedService.value = isCreating ? { serviceName: req.serviceName, groupName: req.groupName } : { ...(selectedService.value ?? {}), serviceName: req.serviceName, groupName: req.groupName };
    if (isCreating) instances.value = [];
    selectedServiceDetail.value = {
      serviceName: req.serviceName,
      groupName: req.groupName,
      metadata: req.metadata ?? {},
      protectThreshold: req.protectThreshold,
      selector: req.selector,
      ephemeral: selectedServiceDetail.value?.ephemeral,
    };
    serviceDetailError.value = "";
    await loadServicesWithRetry(1);
    void reconcileServiceMutation(req, mutationId);
  } catch (error) {
    serviceEditorError.value = error instanceof Error ? error.message : String(error);
  } finally {
    serviceEditorLoading.value = false;
  }
}

async function requestDeleteService(service: NacosServiceInfo) {
  try {
    const existing = await api.nacosListInstances(props.connectionId, { namespace: namespace.value || undefined, serviceName: service.serviceName, groupName: service.groupName });
    if (existing.length) {
      instancesError.value = t("nacos.serviceHasInstances");
      return;
    }
    pendingServiceDelete.value = service;
  } catch (error) {
    instancesError.value = error instanceof Error ? error.message : String(error);
  }
}

async function reconcileServiceDeletion(service: NacosServiceInfo, mutationId: number) {
  const groupName = service.groupName || "DEFAULT_GROUP";
  for (const retryDelay of [0, 250, 750]) {
    if (retryDelay) await delay(retryDelay);
    if (mutationId !== serviceMutationSequence) return;
    try {
      const result = await api.nacosListServices(props.connectionId, {
        namespace: namespace.value || undefined,
        groupName,
        serviceName: service.serviceName,
        pageNo: 1,
        pageSize: servicePageSize.value,
      });
      if (mutationId !== serviceMutationSequence) return;
      const stillExists = result.items.some((item) => serviceIdentity(item) === `${groupName}\u0000${service.serviceName}`);
      if (!stillExists) {
        servicesError.value = "";
        await loadServicesWithRetry(1);
        return;
      }
    } catch {
      // A transient read failure is not proof that the service disappeared.
    }
  }
  if (mutationId === serviceMutationSequence) servicesError.value = t("nacos.serviceDeleteUnconfirmed");
}

async function deleteService(service: NacosServiceInfo) {
  if (!(await confirmNacosMutation(t("nacos.deleteNacosService"), props.connectionId, namespace.value))) return;
  deletingService.value = true;
  try {
    const mutationId = ++serviceMutationSequence;
    await api.nacosDeleteService(props.connectionId, { namespace: namespace.value || undefined, serviceName: service.serviceName, groupName: service.groupName });
    pendingServiceDelete.value = null;
    services.value = services.value.filter((candidate) => serviceIdentity(candidate) !== serviceIdentity(service));
    if (serviceIdentity(selectedService.value) === serviceIdentity(service)) {
      selectedService.value = null;
      selectedServiceDetail.value = null;
      instances.value = [];
    }
    void reconcileServiceDeletion(service, mutationId);
  } catch (error) {
    pendingServiceDelete.value = null;
    servicesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    deletingService.value = false;
  }
}

async function submitInstanceRegistration() {
  if (!selectedService.value) return;
  const port = Number(registerInstance.value.port);
  const weight = Number(registerInstance.value.weight);
  if (!nacosIpAddressIsValid(registerInstance.value.ip) || !Number.isInteger(port) || port < 1 || port > 65535 || !Number.isFinite(weight) || weight < 0) {
    registerInstanceError.value = t("nacos.instanceValidation");
    return;
  }
  registeringInstance.value = true;
  registerInstanceError.value = "";
  try {
    const registration = {
      namespace: namespace.value || undefined,
      serviceName: selectedService.value.serviceName,
      groupName: selectedService.value.groupName || serviceGroup.value || undefined,
      ip: registerInstance.value.ip.trim(),
      port,
      clusterName: registerInstance.value.clusterName.trim() || undefined,
      weight,
      metadata: parseJsonObject(registerInstance.value.metadata, t("nacos.metadataLabel")),
    };
    if (!(await confirmNacosMutation(t("nacos.registerInstance"), props.connectionId, registration.namespace || namespace.value))) return;
    const updateId = ++instanceUpdateSequence;
    await api.nacosRegisterInstance(props.connectionId, registration);
    const ref: NacosInstanceRef = { ...registration, ephemeral: false };
    if (!instances.value.some((candidate) => instanceIdentity(candidate) === instanceRefIdentity(ref))) {
      instances.value = [
        ...instances.value,
        {
          ip: registration.ip,
          port: registration.port,
          serviceName: registration.serviceName,
          groupName: registration.groupName,
          clusterName: registration.clusterName,
          enabled: true,
          ephemeral: false,
          weight: registration.weight,
          metadata: registration.metadata,
        },
      ];
    }
    registerInstanceOpen.value = false;
    void reconcileInstancePresence(ref, true, updateId);
  } catch (error) {
    registerInstanceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    registeringInstance.value = false;
  }
}

async function deregisterInstance(instance: NacosInstanceInfo) {
  if (!selectedService.value) return;
  const ref = instanceRef(instance);
  if (!(await confirmNacosMutation(t("nacos.deregisterNacosInstance"), props.connectionId, ref.namespace || namespace.value))) return;
  const key = instanceIdentity(instance);
  const operationToken = beginInstanceOperation(key);
  try {
    const updateId = ++instanceUpdateSequence;
    await api.nacosDeregisterInstance(props.connectionId, ref);
    pendingInstanceDeregister.value = null;
    instances.value = instances.value.filter((candidate) => instanceIdentity(candidate) !== instanceIdentity(instance));
    void reconcileInstancePresence(ref, false, updateId);
  } catch (error) {
    pendingInstanceDeregister.value = null;
    instancesError.value = error instanceof Error ? error.message : String(error);
  } finally {
    clearInstanceOperation(key, operationToken);
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
    configEditorFontSize.value = clampEditorFontSize(settings.fontSize);
    view.dispatch({
      effects: [configEditorTheme.reconfigure(theme), configEditorFontTheme.reconfigure(editorFontTheme(EditorView, settings.fontSize, settings.fontFamily, { fixedHeight: true, scrollable: true })), configEditorWordWrap.reconfigure(settings.wordWrap ? EditorView.lineWrapping : [])],
    });
  },
  { deep: true },
);

watch(
  () => [props.connectionId, props.namespace] as const,
  async () => {
    closePendingConfigMutationConfirmations();
    configListRequestGuard.invalidate();
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
    selectedServiceDetail.value = null;
    serviceDetailError.value = "";
    servicesRequestGuard.invalidate();
    serviceDetailRequestGuard.invalidate();
    instancesRequestGuard.invalidate();
    instanceUpdateSequence += 1;
    serviceMutationSequence += 1;
    instances.value = [];
    instancesError.value = "";
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
  configListRequestGuard.invalidate();
  configDetailRequestGuard.invalidate();
  servicesRequestGuard.invalidate();
  serviceDetailRequestGuard.invalidate();
  instancesRequestGuard.invalidate();
  instanceUpdateSequence += 1;
  serviceMutationSequence += 1;
  configEditorSessionId += 1;
  latestConfigSaveRequestId += 1;
  batchNamespacesRequestGuard.invalidate();
  batchTargetNamespacesRequestGuard.invalidate();
  stopNacosNamespacesChangedListener?.();
  stopNacosNamespacesChangedListener = null;
  if (activeSearchOperationId.value) void api.nacosCancelConfigContentSearch(activeSearchOperationId.value);
  configListResizeObserver?.disconnect();
  configEditorZoomCommitScheduler.dispose();
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
        <ProductionContextBadge v-if="nacosProductionContext.active" compact />
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
        <Button v-if="activeTab === 'configs' && selectedConfigCount > 0" size="sm" variant="destructive" class="h-8 gap-1.5" :disabled="!canRequestBatchDeleteConfigs" @click="requestBatchDeleteConfigs">
          <Trash2 class="h-3.5 w-3.5" />
          {{ t("nacos.batchDelete") }}
          <span class="border-l border-current/30 pl-1.5 text-xs font-semibold tabular-nums">{{ selectedConfigCount }}</span>
        </Button>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
      <button class="rounded px-3 py-1.5 text-sm" :class="activeTab === 'configs' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60'" @click="activeTab = 'configs'">{{ t("nacos.configs") }}</button>
      <button class="rounded px-3 py-1.5 text-sm" :class="activeTab === 'services' ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60'" :disabled="!supportsServiceManagement" @click="activeTab = 'services'">{{ t("nacos.services") }}</button>
    </div>

    <Splitpanes v-if="activeTab === 'configs'" class="nacos-admin-splitpanes min-h-0 flex-1" @resized="handleNacosSplitResized">
      <Pane :size="nacosSplitSize" min-size="24">
        <div class="flex h-full min-h-0 flex-col">
          <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-2 border-b p-2">
            <div class="relative min-w-0">
              <Input v-model="configDataId" class="h-8 min-w-0 pr-8" placeholder="dataId" @keyup.enter="loadConfigsWithRetry(1)" />
              <button
                v-if="configDataId"
                type="button"
                class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                :title="t('nacos.clear')"
                :aria-label="t('nacos.clear')"
                @click="clearConfigFilter('dataId')"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
            <div class="relative min-w-0">
              <Input v-model="configGroup" class="h-8 min-w-0 pr-8" :placeholder="t('nacos.configListGroup')" @keyup.enter="loadConfigsWithRetry(1)" />
              <button
                v-if="configGroup"
                type="button"
                class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                :title="t('nacos.clear')"
                :aria-label="t('nacos.clear')"
                @click="clearConfigFilter('group')"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
            <div class="relative min-w-0">
              <Input v-model="configAppName" class="h-8 min-w-0 pr-8" :placeholder="t('nacos.configListApplication')" @keyup.enter="loadConfigsWithRetry(1)" />
              <button
                v-if="configAppName"
                type="button"
                class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                :title="t('nacos.clear')"
                :aria-label="t('nacos.clear')"
                @click="clearConfigFilter('appName')"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
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
                <div v-for="(column, columnIndex) in configListColumns" :key="column" class="relative min-w-0" :class="column === 'dataId' ? 'pr-3' : columnIndex === configListColumns.length - 1 ? 'pl-3 pr-10' : 'px-3'">
                  <span v-if="column === 'dataId'" class="flex items-center gap-2">
                    <input type="checkbox" :checked="allCurrentPageSelected" :aria-label="t('nacos.selectCurrentPage')" @change="toggleCurrentPageSelection(($event.target as HTMLInputElement).checked)" />
                    <span class="block truncate">dataID</span>
                  </span>
                  <span v-else-if="column === 'group'" class="block truncate">{{ t("nacos.group") }}</span>
                  <span v-else-if="column === 'application'" class="block truncate">{{ configListColumnLabel("application") }}</span>
                  <span v-else class="block truncate">{{ configListColumnLabel("format") }}</span>
                  <div
                    v-if="columnIndex < configListColumns.length - 1"
                    data-column-resize-handle
                    role="separator"
                    aria-orientation="vertical"
                    :aria-label="t('nacos.resizeColumn')"
                    class="group absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-primary/10"
                    :class="configListResizingColumnIndex === columnIndex ? 'bg-primary/15' : ''"
                    @mousedown="onConfigListColumnResizeStart(columnIndex, $event)"
                  >
                    <span class="pointer-events-none absolute left-1/2 top-1/2 h-5 w-px -translate-x-1/2 -translate-y-1/2 bg-border/90 transition-colors group-hover:bg-primary" />
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger as-child>
                    <Button size="sm" variant="ghost" class="absolute right-1 top-1/2 z-20 h-7 w-7 -translate-y-1/2 p-0" :title="t('nacos.visibleColumns')" :aria-label="t('nacos.visibleColumns')">
                      <Columns3 class="h-3.5 w-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" class="min-w-40" @close-auto-focus.prevent>
                    <DropdownMenuCheckboxItem v-for="column in configListToggleableColumns" :key="column" :model-value="isConfigListColumnVisible(column)" @select.prevent @update:model-value="setConfigListColumnVisible(column, $event)">
                      {{ configListColumnLabel(column) }}
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
              <div
                v-for="item in configs"
                :key="`${item.namespace}:${item.group}:${item.dataId}`"
                class="grid w-full cursor-pointer items-center border-b px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent/50"
                :class="{ 'border-l-2 border-l-primary': isSelectedConfigListItem(item) }"
                :style="{ gridTemplateColumns: configListGridTemplate }"
                @click="selectConfig(item)"
              >
                <template v-for="column in configListColumns" :key="column">
                  <span v-if="column === 'dataId'" class="flex min-w-0 items-center gap-2 pr-3" :title="item.dataId">
                    <input type="checkbox" :checked="selectedConfigKeys.includes(configIdentityKey(item))" :aria-label="t('nacos.selectConfigForBatch', { dataId: item.dataId })" @click.stop @change.stop="toggleConfigSelection(item, ($event.target as HTMLInputElement).checked)" />
                    <button type="button" class="flex min-w-0 items-center gap-2 text-left" @click.stop="selectConfig(item)">
                      <FileText class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span class="truncate font-medium text-foreground">{{ item.dataId }}</span>
                    </button>
                  </span>
                  <span v-else-if="column === 'group'" class="truncate px-3 text-xs text-muted-foreground" :title="item.group || 'DEFAULT_GROUP'">{{ item.group || "DEFAULT_GROUP" }}</span>
                  <span v-else-if="column === 'application'" class="truncate px-3 text-xs text-muted-foreground" :title="item.appName || '-'">{{ item.appName || "-" }}</span>
                  <span v-else class="truncate pl-3 text-xs text-muted-foreground" :title="configFormatLabel(item)">{{ configFormatLabel(item) }}</span>
                </template>
              </div>
            </div>
            <div v-if="!configLoading && configs.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("nacos.noConfigs") }}</div>
          </div>
          <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
            <div class="flex min-w-0 items-center gap-3 overflow-hidden">
              <span class="min-w-0 truncate">{{ t("nacos.total", { count: configTotal }) }}</span>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <div class="flex items-center gap-1.5 whitespace-nowrap">
                <span>{{ t("nacos.configPageSize") }}</span>
                <Select :model-value="String(configPageSize)" :disabled="configLoading" @update:model-value="setConfigPageSize(String($event))">
                  <SelectTrigger size="sm" class="w-16 text-xs" :aria-label="t('nacos.configPageSize')"><SelectValue /></SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem v-for="size in NACOS_CONFIG_PAGE_SIZE_OPTIONS" :key="size" :value="String(size)">{{ size }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button size="icon" variant="outline" class="h-7 w-7" :title="t('nacos.prev')" :aria-label="t('nacos.prev')" :disabled="configPageNo <= 1 || configLoading" @click="loadConfigs(configPageNo - 1)">
                <ChevronLeft class="h-3.5 w-3.5" />
              </Button>
              <span>{{ configPageNo }} / {{ configTotalPages }}</span>
              <Button size="icon" variant="outline" class="h-7 w-7" :title="t('nacos.next')" :aria-label="t('nacos.next')" :disabled="configPageNo >= configTotalPages || configLoading" @click="loadConfigs(configPageNo + 1)">
                <ChevronRight class="h-3.5 w-3.5" />
              </Button>
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
          <div class="grid shrink-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto_auto] gap-2 border-b p-2">
            <div class="relative min-w-0">
              <Input v-model="serviceName" class="h-8 min-w-0 pr-8" :placeholder="t('nacos.service')" @keyup.enter="loadServicesWithRetry(1)" />
              <button
                v-if="serviceName"
                type="button"
                class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                :title="t('nacos.clear')"
                :aria-label="t('nacos.clear')"
                @click="clearServiceFilter('name')"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
            <div class="relative min-w-0">
              <Input v-model="serviceGroup" class="h-8 min-w-0 pr-8" :placeholder="t('nacos.allGroups')" @keyup.enter="loadServicesWithRetry(1)" />
              <button
                v-if="serviceGroup"
                type="button"
                class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                :title="t('nacos.clear')"
                :aria-label="t('nacos.clear')"
                @click="clearServiceFilter('group')"
              >
                <X class="h-3.5 w-3.5" />
              </button>
            </div>
            <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="readOnly || !createServiceCapability.supported" :title="readOnly || !createServiceCapability.supported ? capabilityReason(createServiceCapability) : undefined" @click="openCreateService">
              <Plus class="h-3.5 w-3.5" />
              {{ t("nacos.service") }}
            </Button>
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
              <span class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Server class="h-3.5 w-3.5" />
                {{ service.groupName || serviceGroup }}
                <span v-if="service.ipCount != null">· {{ t("nacos.instanceCount", { count: service.ipCount }) }}</span>
                <span v-if="service.healthyInstanceCount != null">· {{ t("nacos.healthy") }} {{ service.healthyInstanceCount }}</span>
                <span v-if="service.clusterCount != null">· {{ t("nacos.cluster") }} {{ service.clusterCount }}</span>
                <Badge v-if="service.triggerFlag === 'true'" variant="outline" class="h-5 border-amber-500 text-amber-700">{{ t("nacos.protectionTriggered") }}</Badge>
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
          <header class="shrink-0 border-b bg-background">
            <div class="flex min-h-16 flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
              <div class="min-w-0 flex-1">
                <div class="truncate text-base font-semibold">{{ selectedService?.serviceName || t("nacos.instances") }}</div>
                <div v-if="selectedService" class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span>{{ selectedService.groupName || "DEFAULT_GROUP" }}</span>
                  <span>· {{ t("nacos.loadedInstances", { count: instances.length }) }}</span>
                  <Badge v-if="selectedServiceProtectionTriggered" variant="outline" class="h-5 border-amber-500 text-amber-700">{{ t("nacos.protectionTriggered") }}</Badge>
                </div>
              </div>
              <Button size="sm" variant="outline" class="h-8 shrink-0 gap-1.5" :disabled="!selectedService || instancesLoading || serviceDetailLoading" @click="refreshSelectedService">
                <Loader2 v-if="instancesLoading" class="h-3.5 w-3.5 animate-spin" />
                <RefreshCw v-else class="h-3.5 w-3.5" />
                {{ t("nacos.refresh") }}
              </Button>
            </div>
            <div v-if="selectedService" class="flex flex-wrap items-center gap-x-4 gap-y-2 border-t bg-muted/30 px-4 py-2">
              <div class="flex shrink-0 items-center gap-1">
                <Input v-model="serviceCluster" class="h-8 w-40" :placeholder="t('nacos.filterInstanceCluster')" @keyup.enter="loadInstances" />
                <Button size="sm" variant="secondary" class="h-8" :disabled="instancesLoading" @click="loadInstances">{{ t("nacos.filter") }}</Button>
                <Button
                  size="sm"
                  variant="ghost"
                  class="h-8 px-2"
                  :class="{ invisible: !serviceCluster }"
                  :disabled="instancesLoading || !serviceCluster"
                  @click="
                    serviceCluster = '';
                    loadInstances();
                  "
                  >{{ t("nacos.clear") }}</Button
                >
              </div>
              <div class="ml-auto flex flex-wrap items-center gap-2">
                <div class="flex items-center gap-1 rounded-md border bg-background p-1">
                  <span class="px-1 text-xs text-muted-foreground">{{ t("nacos.serviceSettings") }}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    class="h-7"
                    :disabled="readOnly || !updateServiceCapability.supported || serviceEditorLoading"
                    :title="readOnly || !updateServiceCapability.supported ? capabilityReason(updateServiceCapability) : undefined"
                    @click="openUpdateService(selectedService)"
                    >{{ t("nacos.edit") }}</Button
                  >
                  <Button
                    size="sm"
                    variant="ghost"
                    class="h-7 text-destructive hover:text-destructive"
                    :disabled="readOnly || !deleteServiceCapability.supported"
                    :title="readOnly || !deleteServiceCapability.supported ? capabilityReason(deleteServiceCapability) : undefined"
                    @click="requestDeleteService(selectedService)"
                    >{{ t("nacos.delete") }}</Button
                  >
                </div>
                <div class="flex items-center gap-1 rounded-md border bg-background p-1">
                  <span class="px-1 text-xs text-muted-foreground">{{ t("nacos.instances") }}</span>
                  <Button size="sm" class="h-7" :disabled="readOnly || !registerInstanceCapability.supported" :title="readOnly || !registerInstanceCapability.supported ? capabilityReason(registerInstanceCapability) : undefined" @click="registerInstanceOpen = true">{{
                    t("nacos.registerInstance")
                  }}</Button>
                </div>
              </div>
            </div>
          </header>
          <div v-if="serviceWriteNotice" class="shrink-0 border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            {{ serviceWriteNotice }}
          </div>
          <div v-if="selectedServiceProtectionTriggered" class="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
            {{ t("nacos.protectionTriggeredDescription") }}
          </div>
          <section v-if="selectedService" class="shrink-0 border-b bg-background px-3 py-2">
            <button type="button" class="flex w-full items-center justify-between gap-3 text-left" @click="serviceDetailExpanded = !serviceDetailExpanded">
              <span class="text-xs font-medium">{{ t("nacos.serviceDetails") }}</span>
              <span class="text-xs text-muted-foreground">{{ serviceDetailExpanded ? t("nacos.collapse") : t("nacos.expand") }}</span>
            </button>
            <div class="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div class="rounded border bg-muted/20 px-2 py-1.5">
                <div class="text-muted-foreground">{{ t("nacos.instanceStat") }}</div>
                <div class="mt-0.5 font-medium">{{ selectedService.ipCount ?? instances.length }}</div>
              </div>
              <div class="rounded border bg-muted/20 px-2 py-1.5">
                <div class="text-muted-foreground">{{ t("nacos.healthyInstances") }}</div>
                <div class="mt-0.5 font-medium">{{ selectedService.healthyInstanceCount ?? instances.filter((instance) => instance.healthy === true).length }}</div>
              </div>
              <div class="rounded border bg-muted/20 px-2 py-1.5">
                <div class="text-muted-foreground">{{ t("nacos.clusterCount") }}</div>
                <div class="mt-0.5 font-medium">{{ selectedService.clusterCount ?? new Set(instances.map((instance) => instance.clusterName || "DEFAULT")).size }}</div>
              </div>
              <div class="rounded border bg-muted/20 px-2 py-1.5">
                <div class="text-muted-foreground">{{ t("nacos.protectThreshold") }}</div>
                <div class="mt-0.5 font-medium">{{ selectedServiceDetail?.protectThreshold ?? "-" }}</div>
              </div>
            </div>
            <div v-if="serviceDetailExpanded" class="mt-2 grid gap-2 text-xs lg:grid-cols-2">
              <div class="min-w-0 rounded border p-2">
                <div class="mb-1 flex items-center justify-between text-muted-foreground">
                  <span>{{ t("nacos.metadataLabel") }}</span
                  ><span>{{ t("nacos.itemCount", { count: selectedServiceDetail?.metadata && typeof selectedServiceDetail.metadata === "object" ? Object.keys(selectedServiceDetail.metadata).length : 0 }) }}</span>
                </div>
                <pre class="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">{{ JSON.stringify(selectedServiceDetail?.metadata ?? {}, null, 2) }}</pre>
              </div>
              <div class="min-w-0 rounded border p-2">
                <div class="mb-1 flex items-center justify-between text-muted-foreground">
                  <span>{{ t("nacos.selectorLabel") }}</span
                  ><span v-if="selectedServiceDetail?.ephemeral != null">{{ selectedServiceDetail.ephemeral ? t("nacos.temporaryService") : t("nacos.persistent") }}</span>
                </div>
                <pre class="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-[11px]">{{ JSON.stringify(selectedServiceDetail?.selector ?? {}, null, 2) }}</pre>
              </div>
            </div>
            <div v-if="serviceDetailLoading" class="mt-2 text-xs text-muted-foreground">{{ t("nacos.loadingServiceDetail") }}</div>
            <div v-if="serviceDetailError" class="mt-2 flex items-center justify-between gap-2 text-xs text-destructive">
              <span>{{ serviceDetailError }}</span>
              <Button size="sm" variant="outline" class="h-7 shrink-0" @click="loadServiceDetail">{{ t("nacos.refreshDetail") }}</Button>
            </div>
          </section>
          <div v-if="instancesError" class="border-b px-3 py-2 text-xs text-destructive">{{ instancesError }}</div>
          <div class="min-h-0 flex-1 overflow-auto bg-muted/20 p-3">
            <div v-if="instances.length" class="space-y-2">
              <article v-for="instance in instances" :key="instanceIdentity(instance)" class="rounded-lg border bg-background p-3 shadow-sm">
                <div class="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="font-mono text-sm font-medium">{{ instance.ip }}:{{ instance.port }}</span>
                      <Badge variant="outline">{{ instance.clusterName || "DEFAULT" }}</Badge>
                      <Badge variant="outline" :class="instance.healthy === false ? 'border-destructive/50 text-destructive' : 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300'">{{ instance.healthy === false ? t("nacos.unhealthy") : t("nacos.healthy") }}</Badge>
                      <Badge :variant="instance.enabled === false ? 'outline' : 'secondary'" :class="instance.enabled === false ? 'border-muted-foreground/50 text-muted-foreground' : ''">{{ instance.enabled === false ? t("nacos.offline") : t("nacos.enabled") }}</Badge>
                      <Badge v-if="instance.ephemeral != null" variant="outline">{{ instance.ephemeral ? t("nacos.ephemeral") : t("nacos.persistent") }}</Badge>
                    </div>
                    <div class="mt-3 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-[auto_minmax(0,1fr)]">
                      <div class="flex items-end gap-1 self-start">
                        <label class="grid gap-1 text-muted-foreground">
                          <span>{{ t("nacos.weight") }}</span>
                          <Input
                            :model-value="instanceWeightDraft(instance)"
                            type="number"
                            min="0"
                            step="0.1"
                            class="h-7 w-24 text-xs text-foreground"
                            :disabled="readOnly || !supportsInstanceUpdate || isInstanceUpdating(instance)"
                            @update:model-value="(value: string | number) => updateInstanceWeightDraft(instance, value)"
                          />
                        </label>
                        <div v-if="hasInstanceWeightDraft(instance)" class="flex items-end gap-1">
                          <Button size="sm" class="h-7" :disabled="readOnly || !supportsInstanceUpdate || isInstanceUpdating(instance)" @click="requestInstanceWeightUpdate(instance)">{{ t("nacos.save") }}</Button>
                          <Button size="sm" variant="ghost" class="h-7 px-2" :disabled="isInstanceUpdating(instance)" @click="resetInstanceWeightDraft(instance)">{{ t("nacos.restore") }}</Button>
                        </div>
                      </div>
                      <details v-if="instance.metadata && Object.keys(instance.metadata).length" class="min-w-0 self-start text-muted-foreground">
                        <summary class="cursor-pointer select-none hover:text-foreground">{{ t("nacos.metadataLabel") }}（{{ t("nacos.itemCount", { count: Object.keys(instance.metadata).length }) }}）</summary>
                        <pre class="mt-1 max-h-32 max-w-full overflow-auto rounded bg-muted p-2 font-mono text-[11px] text-foreground">{{ JSON.stringify(instance.metadata, null, 2) }}</pre>
                      </details>
                      <span v-else class="self-start text-muted-foreground">{{ t("nacos.noMetadata") }}</span>
                    </div>
                  </div>
                  <div class="flex shrink-0 flex-wrap items-center gap-2 xl:justify-end">
                    <Button size="sm" variant="outline" class="h-7" :disabled="readOnly || !supportsInstanceUpdate || isInstanceUpdating(instance)" @click="openInstanceEditor(instance)">{{ t("nacos.edit") }}</Button>
                    <Button
                      size="sm"
                      variant="outline"
                      class="h-7 gap-1"
                      :class="instance.enabled === false ? 'border-emerald-500/50 text-emerald-700 hover:bg-emerald-500/10 hover:text-emerald-800 dark:text-emerald-300 dark:hover:text-emerald-200' : 'border-destructive/50 text-destructive hover:bg-destructive/10'"
                      :disabled="readOnly || !supportsInstanceUpdate || isInstanceUpdating(instance)"
                      @click="requestUpdateInstance(instance, { enabled: !instance.enabled })"
                    >
                      <Loader2 v-if="isInstanceUpdating(instance)" class="h-3 w-3 animate-spin" />
                      {{ instance.enabled === false ? t("nacos.enable") : t("nacos.disable") }}
                    </Button>
                    <Button size="sm" variant="outline" class="h-7" :disabled="readOnly || !supportsInstanceUpdate || isInstanceUpdating(instance)" @click="requestUpdateInstance(instance, { healthy: !instance.healthy })">
                      {{ instance.healthy === false ? t("nacos.markHealthy") : t("nacos.markUnhealthy") }}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      class="h-7 text-destructive"
                      :disabled="readOnly || !deregisterInstanceCapability.supported || isInstanceUpdating(instance)"
                      :title="readOnly || !deregisterInstanceCapability.supported ? capabilityReason(deregisterInstanceCapability) : undefined"
                      @click="pendingInstanceDeregister = instance"
                      >{{ t("nacos.deregister") }}</Button
                    >
                  </div>
                </div>
              </article>
            </div>
            <div v-else class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ selectedService ? t("nacos.noInstances") : t("nacos.selectService") }}</div>
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

    <Dialog v-model:open="serviceEditorOpen">
      <DialogContent class="sm:max-w-xl" @pointer-down-outside.prevent @interact-outside.prevent @escape-key-down.prevent>
        <DialogHeader>
          <DialogTitle>{{ serviceEditorMode === "create" ? t("nacos.createNacosService") : t("nacos.editNacosService") }}</DialogTitle>
          <DialogDescription>{{ t("nacos.manageServiceMetadata") }}</DialogDescription>
        </DialogHeader>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label>{{ t("nacos.serviceName") }}</Label
            ><Input v-model="serviceEditor.serviceName" :disabled="serviceEditorMode === 'update'" />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t("nacos.groupName") }}</Label
            ><Input v-model="serviceEditor.groupName" :disabled="serviceEditorMode === 'update'" />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t("nacos.protectThreshold") }}</Label
            ><Input v-model="serviceEditor.protectThreshold" inputmode="decimal" :placeholder="t('nacos.thresholdExample')" />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t("nacos.metadataLabel") }}（{{ t("nacos.jsonObject") }}）</Label><textarea v-model="serviceEditor.metadata" class="min-h-24 w-full rounded-md border bg-background p-2 font-mono text-xs" />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <Label>{{ t("nacos.selectorLabel") }}（{{ t("nacos.optionalJsonObject") }}）</Label><textarea v-model="serviceEditor.selector" class="min-h-20 w-full rounded-md border bg-background p-2 font-mono text-xs" />
          </div>
          <p v-if="serviceEditorError" class="text-xs text-destructive sm:col-span-2">{{ serviceEditorError }}</p>
        </div>
        <DialogFooter
          ><Button variant="outline" :disabled="serviceEditorLoading" @click="serviceEditorOpen = false">{{ t("nacos.cancel") }}</Button
          ><Button :disabled="serviceEditorLoading" @click="submitServiceEditor"><Loader2 v-if="serviceEditorLoading" class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.save") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="registerInstanceOpen">
      <DialogContent class="sm:max-w-lg" @pointer-down-outside.prevent @interact-outside.prevent @escape-key-down.prevent>
        <DialogHeader
          ><DialogTitle>{{ t("nacos.registerPersistentInstance") }}</DialogTitle
          ><DialogDescription>{{ t("nacos.persistentInstanceHint") }}</DialogDescription></DialogHeader
        >
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1.5">
            <Label>{{ t("nacos.ipAddress") }}</Label
            ><Input v-model="registerInstance.ip" />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t("nacos.port") }}</Label
            ><Input v-model="registerInstance.port" type="number" min="1" max="65535" />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t("nacos.cluster") }}</Label
            ><Input v-model="registerInstance.clusterName" />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t("nacos.weight") }}</Label
            ><Input v-model="registerInstance.weight" type="number" min="0" step="0.1" />
          </div>
          <div class="space-y-1.5 sm:col-span-2">
            <Label>{{ t("nacos.metadataLabel") }}（{{ t("nacos.jsonObject") }}）</Label><textarea v-model="registerInstance.metadata" class="min-h-20 w-full rounded-md border bg-background p-2 font-mono text-xs" />
          </div>
          <p v-if="registerInstanceError" class="text-xs text-destructive sm:col-span-2">{{ registerInstanceError }}</p>
        </div>
        <DialogFooter
          ><Button variant="outline" :disabled="registeringInstance" @click="registerInstanceOpen = false">{{ t("nacos.cancel") }}</Button
          ><Button :disabled="registeringInstance" @click="submitInstanceRegistration"><Loader2 v-if="registeringInstance" class="mr-2 h-4 w-4 animate-spin" />{{ t("nacos.registerInstance") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="instanceEditorOpen">
      <DialogContent class="sm:max-w-lg" @pointer-down-outside.prevent @interact-outside.prevent @escape-key-down.prevent>
        <DialogHeader>
          <DialogTitle>{{ t("nacos.instanceEditorTitle") }}</DialogTitle>
          <DialogDescription>{{ instanceEditorTarget ? `${instanceEditorTarget.ip}:${instanceEditorTarget.port} · ${instanceEditorTarget.clusterName || "DEFAULT"}` : "" }}</DialogDescription>
        </DialogHeader>
        <div class="grid gap-3">
          <div class="space-y-1.5">
            <Label>{{ t("nacos.weight") }}</Label>
            <Input v-model="instanceEditor.weight" type="number" min="0" step="0.1" />
          </div>
          <div class="space-y-1.5">
            <Label>{{ t("nacos.metadataLabel") }}（{{ t("nacos.jsonObject") }}）</Label>
            <textarea v-model="instanceEditor.metadata" class="min-h-36 w-full rounded-md border bg-background p-2 font-mono text-xs" />
          </div>
          <p v-if="instanceEditorError" class="text-xs text-destructive">{{ instanceEditorError }}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="instanceEditorOpen = false">{{ t("nacos.cancel") }}</Button>
          <Button @click="submitInstanceEditor">{{ t("nacos.save") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

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
      :open="!!pendingBatchDelete"
      :title="t('nacos.batchDeleteTitle')"
      :message="t('nacos.batchDeleteConfirm', { count: pendingBatchDelete?.keys.length || 0 })"
      :details="pendingBatchDeleteDetails"
      :confirm-label="t('nacos.batchDelete')"
      :loading="deletingConfig"
      :close-on-confirm="false"
      @update:open="
        (value: boolean) => {
          if (!value && !deletingConfig) pendingBatchDelete = null;
        }
      "
      @confirm="deleteSelectedConfigs"
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
      :loading="pendingInstanceUpdate ? isInstanceUpdating(pendingInstanceUpdate.instance) : false"
      :close-on-confirm="false"
      @update:open="
        (value: boolean) => {
          if (!value && (!pendingInstanceUpdate || !isInstanceUpdating(pendingInstanceUpdate.instance))) pendingInstanceUpdate = null;
        }
      "
      @confirm="pendingInstanceUpdate && updateInstance(pendingInstanceUpdate.instance, pendingInstanceUpdate.patch)"
    />

    <DangerConfirmDialog
      :open="!!pendingServiceDelete"
      :title="t('nacos.deleteNacosService')"
      :message="t('nacos.confirmEmptyServiceDelete')"
      :details="pendingServiceDelete ? `${pendingServiceDelete.groupName || 'DEFAULT_GROUP'}@@${pendingServiceDelete.serviceName}` : ''"
      :confirm-label="t('nacos.delete')"
      :loading="deletingService"
      :close-on-confirm="false"
      @update:open="
        (value: boolean) => {
          if (!value && !deletingService) pendingServiceDelete = null;
        }
      "
      @confirm="pendingServiceDelete && deleteService(pendingServiceDelete)"
    />

    <DangerConfirmDialog
      :open="!!pendingInstanceDeregister"
      :title="t('nacos.deregisterNacosInstance')"
      :message="t('nacos.confirmInstanceDeregister')"
      :details="pendingInstanceDeregisterDetails"
      :confirm-label="t('nacos.deregister')"
      :loading="pendingInstanceDeregister ? isInstanceUpdating(pendingInstanceDeregister) : false"
      :close-on-confirm="false"
      @update:open="
        (value: boolean) => {
          if (!value && (!pendingInstanceDeregister || !isInstanceUpdating(pendingInstanceDeregister))) pendingInstanceDeregister = null;
        }
      "
      @confirm="pendingInstanceDeregister && deregisterInstance(pendingInstanceDeregister)"
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

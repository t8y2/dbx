<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { useConnectionStore } from "@/stores/connectionStore";
import { Activity, ChevronDown, ChevronRight, Clock3, Copy, Download, FolderClosed, FolderOpen, KeyRound, Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import NacosConfigDiffDialog from "@/components/nacos/NacosConfigDiffDialog.vue";
import KvValueEditor from "@/components/kv/KvValueEditor.vue";
import type { KvCreateMode, KvDeleteOptions, KvGetOptions, KvGetResponse, KvHistoryEvent, KvHistoryResponse, KvInt64, KvKeySummary, KvListPrefixOptions, KvPutOptions, KvPutResponse, KvValue } from "@/lib/backend/api";
import type { KvExportScopeRequest } from "@/lib/kv/kvExportScope";
import { buildKvKeyTree, flattenVisibleKvKeyTree, kvKeyTreeNodePath, preserveKvExpandedGroupIds, type KvKeyTreeNode } from "@/lib/kv/kvKeyTree";
import { decideKvMetadataRefresh, hasPositiveKvLease, knownKvLeaseSummaries, mergeKvKeyMetadata, mergeKvValueRefresh, nextKvLeaseRefreshDelay, removeMissingKvKey, updateKvResponseTtl } from "@/lib/kv/kvMetadataRefresh";
import { classifyKvMutationError, type KvMutationErrorKind } from "@/lib/kv/kvMutationError";
import { refreshedKvSelectionSummary } from "@/lib/kv/kvRefreshSelection";
import { parseKvLeaseId, parseOptionalTtl } from "@/lib/kv/kvTtl";
import { formatZooKeeperMetadataRows, formatZooKeeperSummaryBadges, prettyPrintJsonText } from "@/lib/kv/kvValueDisplay";
import { formatTtl } from "@/lib/common/ttlFormat";
import {
  createLazyKvKeyTreeState,
  createZooKeeperChildPathDraft,
  flattenLazyKvKeyTree,
  lazyExpandedKeyFromId,
  normalizeZooKeeperPath,
  parentZooKeeperPath,
  replaceLazyKvChildren,
  replaceLazyKvFocusedRoot,
  resetLazyKvKeyTree,
  type LazyKvKeyTreeNode,
  type LazyKvKeyTreeRow,
} from "@/lib/zookeeper/zookeeperLazyKeyTree";
import { useToast } from "@/composables/useToast";
import { detectKvValueFormat, validateKvValue, type KvValueFormat } from "@/lib/kv/kvValueFormat";
import { safeLocalStorageGet, safeLocalStorageSet } from "@/lib/backend/safeStorage";

interface KvKeyBrowserLabels {
  prefixPlaceholder: string;
  newKey: string;
  loadingKeys: string;
  empty: string;
  loadMore: string;
  selectKey: string;
  loadingValue: string;
  notFound: string;
  edit: string;
  editKey: string;
  delete: string;
  deleteTitle: string;
  keyPlaceholder: string;
  keyRequired: string;
  rootReadonly?: string;
  saved: string;
  deleted: string;
  base64Readonly: string;
  rename?: string;
  clone?: string;
  copyKey?: string;
  export?: string;
  history?: string;
  restore?: string;
  compare?: string;
  format?: string;
  savePreview?: string;
  conflict?: string;
  keyAlreadyExists?: string;
  createMode?: string;
  ttl?: string;
  ttlPlaceholder?: string;
  ttlInvalid?: string;
  ttlUnavailable?: string;
  expiryMode?: string;
  expiryPermanent?: string;
  expiryPermanentHint?: string;
  expiryTtl?: string;
  expiryTtlHint?: string;
  expiryLease?: string;
  expiryLeaseHint?: string;
  leaseId?: string;
  leasePlaceholder?: string;
  leaseInvalid?: string;
  valueContent?: string;
  add?: string;
  value?: string;
  metadata?: string;
  prettyJson?: string;
  invalidJson?: string;
  summaryRevision?: string;
  summaryVersion?: string;
  summaryLease?: string;
  summarySize?: string;
  watch?: string;
  selectExistingLease?: string;
  enterLeaseId?: string;
  leasePickerHint?: string;
  noLeasePickerHint?: string;
  registryWarning?: string;
}

interface KvCreateModeOption {
  value: KvCreateMode;
  label: string;
}

interface KvKeyBrowserApi {
  listPrefix: (connectionId: string, prefix: string, limit: number, continuation?: string | null, options?: KvListPrefixOptions | null) => Promise<{ keys: KvKeySummary[]; continuation?: string | null; revision?: string | number | null }>;
  get: (connectionId: string, key: string, options?: KvGetOptions | null) => Promise<KvGetResponse>;
  getMetadata?: (connectionId: string, key: string, options?: KvGetOptions | null) => Promise<KvGetResponse>;
  put: (connectionId: string, key: string, value: KvValue, options?: KvPutOptions | null) => Promise<KvPutResponse>;
  deleteKey: (connectionId: string, key: string, options?: KvDeleteOptions | null) => Promise<{ deleted: number }>;
  rename?: (connectionId: string, request: { key: string; keyBytes?: KvValue | null; newKey: string; expectedModRevision?: KvInt64 | null }) => Promise<{ renamed: boolean }>;
  history?: (connectionId: string, request: { key: string; keyBytes?: KvValue | null; startRevision?: KvInt64 | null; endRevision?: KvInt64 | null; limit: number }) => Promise<KvHistoryResponse>;
  exportScope?: (connectionId: string, request: KvExportScopeRequest) => Promise<void>;
}

interface KvKeyRoute {
  key: string;
  keyIdentity?: string | null;
  keyBytes?: KvValue | null;
}

type BrowserTreeNode = KvKeyTreeNode | LazyKvKeyTreeNode;
type BrowserTreeRow = { type: "node"; node: BrowserTreeNode; depth: number } | LazyKvKeyTreeRow;
type KvExpiryMode = "permanent" | "ttl" | "lease";

const valueFormatOptions: { value: KvValueFormat; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "base64", label: "Blob (Base64)" },
  { value: "json", label: "JSON" },
  { value: "yaml", label: "YAML" },
  { value: "xml", label: "XML" },
  { value: "sql", label: "SQL" },
  { value: "properties", label: "Properties" },
  { value: "shell", label: "Shell" },
  { value: "dockerfile", label: "Dockerfile" },
  { value: "nginx", label: "Nginx" },
  { value: "kubernetes", label: "Kubernetes" },
];

const props = withDefaults(
  defineProps<{
    connectionId: string;
    labels: KvKeyBrowserLabels;
    api: KvKeyBrowserApi;
    supportsCreateModes?: boolean;
    supportsTtl?: boolean;
    supportsLeaseBinding?: boolean;
    ttlCapabilityKnown?: boolean;
    createModeOptions?: KvCreateModeOption[];
    enableNodeActions?: boolean;
    metadataStyle?: "default" | "zookeeper";
    lazyHierarchy?: boolean;
    safeWrite?: boolean;
    allowBinaryEdit?: boolean;
    readOnly?: boolean;
    onWatchKey?: (route: KvKeyRoute) => void;
    leaseOptions?: Array<{ id: KvInt64; ttl: number; grantedTtl?: number }>;
    onLeaseOptionsRequested?: () => void;
  }>(),
  {
    supportsCreateModes: false,
    supportsTtl: false,
    supportsLeaseBinding: false,
    ttlCapabilityKnown: true,
    createModeOptions: () => [],
    enableNodeActions: false,
    metadataStyle: "default",
    lazyHierarchy: false,
    safeWrite: false,
    allowBinaryEdit: false,
    readOnly: false,
    leaseOptions: () => [],
  },
);

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const searchInputRef = ref<HTMLInputElement>();
const prefix = ref("");
const keySuggestionOpen = ref(false);
const keySuggestionIndex = ref(-1);
const keys = ref<KvKeySummary[]>([]);
const continuation = ref<string | null>(null);
const listRevision = ref<KvInt64 | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const expandedGroupIds = ref<Set<string>>(new Set());
const selectedKey = ref<string | null>(null);
const selectedKeyIdentity = ref<string | null>(null);
const selectedRouteKeyBytes = ref<KvValue | null>(null);
const selectedValue = ref<KvGetResponse | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const showEditDialog = ref(false);
const isCreating = ref(false);
const editKey = ref("");
const editValue = ref("");
const editTtl = ref<string | number>("");
const editExpiryMode = ref<KvExpiryMode>("permanent");
const editLeaseId = ref("");
const editFormat = ref<KvValueFormat>("text");
const editEncoding = ref<"utf8" | "base64">("utf8");
const editError = ref("");
const editErrorKind = ref<KvMutationErrorKind>("request");
const saving = ref(false);
const showSaveDiff = ref(false);
const pendingSave = ref<{ key: string; value: KvValue; options?: KvPutOptions } | null>(null);
const showDeleteConfirm = ref(false);
const deleting = ref(false);
const showRenameDialog = ref(false);
const renameValue = ref("");
const renameError = ref("");
const renaming = ref(false);
const showHistoryDialog = ref(false);
const historyLoading = ref(false);
const historyError = ref("");
const historyEvents = ref<KvHistoryEvent[]>([]);
const selectedHistoryEvent = ref<KvHistoryEvent | null>(null);
const showHistoryDiff = ref(false);
const restoring = ref(false);
const selectedCreateMode = ref<KvCreateMode>("persistent");
const selectedPrettyValue = ref<string | null>(null);
const lazyTreeState = reactive(createLazyKvKeyTreeState());
const pageSize = 200;
const metadataRefreshIntervalMs = 1000;
const keyListRefreshBaseIntervalMs = 2000;
const keyListRefreshMaxIntervalMs = 30000;
const kvBrowserSplitSizeStorageKey = "dbx-kv-browser-split-size";
const savedKvBrowserSplitSize = Number(safeLocalStorageGet(kvBrowserSplitSizeStorageKey));
const kvBrowserSplitSize = ref(savedKvBrowserSplitSize >= 20 && savedKvBrowserSplitSize <= 70 ? savedKvBrowserSplitSize : 38);
let keyLoadGeneration = 0;
let detailRequestId = 0;
let metadataRefreshTimer: ReturnType<typeof setInterval> | null = null;
let metadataRefreshGeneration = 0;
let metadataRefreshInFlight = false;
let keyListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let keyListRefreshGeneration = 0;
let keyListRefreshDelayMs = keyListRefreshBaseIntervalMs;
let initialLoadPromise: Promise<void> | null = null;
type LoadKeysOptions = {
  preserveSelection?: boolean;
};

function summaryIdentity(summary: KvKeySummary): string {
  return summary.keyIdentity ?? summary.key;
}

function routeIdentity(route: KvKeyRoute): string {
  return route.keyIdentity ?? route.key;
}

function routeFromKey(input: string | KvKeyRoute): KvKeyRoute {
  return typeof input === "string" ? { key: input } : input;
}

function routeFromSummary(summary: KvKeySummary): KvKeyRoute {
  return { key: summary.key, keyIdentity: summary.keyIdentity, keyBytes: summary.keyBytes };
}

function routeFromNode(node: BrowserTreeNode): KvKeyRoute {
  if (node.kind === "lazy") return { key: node.key };
  return { key: kvKeyTreeNodePath(node), keyIdentity: node.keyIdentity, keyBytes: node.keyBytes };
}

function knownLeaseKeyRoutes(): KvKeyRoute[] {
  return knownKvLeaseSummaries(keys.value, selectedKeyIdentity.value).map(routeFromSummary);
}

const tree = computed(() => buildKvKeyTree(keys.value));
const keySuggestions = computed(() => {
  const query = prefix.value.trim();
  if (!query) return [];

  const seen = new Set<string>();
  const suggestions: KvKeySummary[] = [];
  for (const key of keys.value) {
    if (key.key === query || !key.key.startsWith(query) || seen.has(summaryIdentity(key))) continue;
    seen.add(summaryIdentity(key));
    suggestions.push(key);
    if (suggestions.length === 8) break;
  }
  return suggestions;
});
const showKeySuggestions = computed(() => keySuggestionOpen.value && keySuggestions.value.length > 0);
const visibleRows = computed<BrowserTreeRow[]>(() => {
  if (props.lazyHierarchy) return flattenLazyKvKeyTree(lazyTreeState, expandedGroupIds.value);
  return flattenVisibleKvKeyTree(tree.value, expandedGroupIds.value).map((row) => ({ type: "node", node: row.node, depth: row.depth }));
});
const selectedMetadata = computed(() => {
  if (selectedValue.value?.metadata) return selectedValue.value.metadata;
  if (props.lazyHierarchy && selectedKey.value) return lazyTreeState.nodeByKey.get(selectedKey.value);
  return keys.value.find((key) => summaryIdentity(key) === selectedKeyIdentity.value);
});
const selectedTextValue = computed(() => {
  const value = selectedValue.value?.value;
  if (!value) return "";
  return value.encoding === "utf8" ? value.data : value.data;
});
const displayedSelectedTextValue = computed(() => selectedPrettyValue.value ?? selectedTextValue.value);
const selectedValueIsBase64 = computed(() => selectedValue.value?.value?.encoding === "base64");
const selectedKeyBytes = computed(() => selectedValue.value?.keyBytes ?? selectedRouteKeyBytes.value ?? null);
const showExpiryControls = computed(() => props.supportsTtl || props.supportsLeaseBinding);
const showTtlUnavailable = computed(() => props.ttlCapabilityKnown && !props.supportsTtl && !!props.labels.ttlUnavailable);
const showCreateModeSelect = computed(() => props.supportsCreateModes && isCreating.value && props.createModeOptions.length > 0);
const expiryModeOptions = computed<{ value: KvExpiryMode; label: string; hint: string; disabled?: boolean }[]>(() => [
  {
    value: "permanent",
    label: props.labels.expiryPermanent || "Permanent",
    hint: props.labels.expiryPermanentHint || "The key does not expire automatically",
  },
  {
    value: "ttl",
    label: props.labels.expiryTtl || "Time to live (TTL)",
    hint: props.labels.expiryTtlHint || "Create a lease that expires after the configured duration",
    disabled: !props.supportsTtl,
  },
  {
    value: "lease",
    label: props.labels.expiryLease || "Bind lease",
    hint: props.labels.expiryLeaseHint || "Attach the key to an existing Lease ID",
    disabled: !props.supportsLeaseBinding,
  },
]);
const zookeeperSummaryBadges = computed(() =>
  formatZooKeeperSummaryBadges(selectedMetadata.value, {
    revision: props.labels.summaryRevision,
    version: props.labels.summaryVersion,
    lease: props.labels.summaryLease,
    size: props.labels.summarySize,
  }),
);
const zookeeperMetadataRows = computed(() => formatZooKeeperMetadataRows(selectedMetadata.value));
const selectedTtlLabel = computed(() => {
  const ttl = selectedMetadata.value?.ttl;
  return typeof ttl === "number" && ttl > 0 ? formatTtl(ttl, t) : null;
});
const selectedValueCanPrettyJson = computed(() => selectedValue.value?.value?.encoding === "utf8" && prettyPrintJsonText(selectedTextValue.value).ok);
const editValueCanPrettyJson = computed(() => prettyPrintJsonText(editValue.value).ok);
const editValueSize = computed(() => {
  if (editEncoding.value === "base64") {
    const normalized = editValue.value.replace(/\s+/g, "");
    return Math.max(0, Math.floor((normalized.length * 3) / 4) - (normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0));
  }
  return new TextEncoder().encode(editValue.value).length;
});
const canEditSelectedValue = computed(() => !props.readOnly && (!selectedValueIsBase64.value || props.allowBinaryEdit));
const saveDiffBefore = computed(() => (isCreating.value ? "" : selectedTextValue.value));
const saveDiffAfter = computed(() => pendingSave.value?.value.data ?? editValue.value);
const historyRestoreValue = computed(() => selectedHistoryEvent.value?.value ?? selectedHistoryEvent.value?.previousValue ?? null);
const highRiskRegistryKey = computed(() => editKey.value === "/registry" || editKey.value.startsWith("/registry/"));

function preserveExpandedGroups(expandAll = false) {
  expandedGroupIds.value = preserveKvExpandedGroupIds(tree.value, expandedGroupIds.value, expandAll);
}

function closeKeySuggestions() {
  keySuggestionOpen.value = false;
  keySuggestionIndex.value = -1;
}

function onPrefixInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  keySuggestionOpen.value = Boolean(value.trim());
  keySuggestionIndex.value = -1;
}

function moveKeySuggestion(delta: number) {
  if (!keySuggestions.value.length) return;
  keySuggestionOpen.value = true;
  keySuggestionIndex.value = (keySuggestionIndex.value + delta + keySuggestions.value.length) % keySuggestions.value.length;
}

function acceptKeySuggestion(index: number) {
  const suggestion = keySuggestions.value[index];
  if (!suggestion) return;
  prefix.value = suggestion.key;
  closeKeySuggestions();
  void loadKeys(true);
}

function onPrefixKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;

  if (event.key === "Escape") {
    closeKeySuggestions();
    return;
  }
  if (event.key === "ArrowDown") {
    if (!keySuggestions.value.length) return;
    event.preventDefault();
    moveKeySuggestion(1);
    return;
  }
  if (event.key === "ArrowUp") {
    if (!keySuggestions.value.length) return;
    event.preventDefault();
    moveKeySuggestion(-1);
    return;
  }
  if (event.key !== "Enter") return;

  event.preventDefault();
  if (showKeySuggestions.value && keySuggestionIndex.value >= 0) {
    acceptKeySuggestion(keySuggestionIndex.value);
    return;
  }
  closeKeySuggestions();
  void loadKeys(true);
}

function handleKvBrowserSplitResized(payload: { panes?: { size: number }[] }) {
  const size = payload.panes?.[0]?.size;
  if (typeof size !== "number" || size < 20 || size > 70) return;
  kvBrowserSplitSize.value = size;
  safeLocalStorageSet(kvBrowserSplitSizeStorageKey, String(size));
}

async function loadKeys(reset = true, options: LoadKeysOptions = {}) {
  if (props.lazyHierarchy) {
    await loadLazyRoot(reset, options);
    return;
  }
  const generation = ++keyLoadGeneration;
  const connectionId = props.connectionId;
  const searchQuery = prefix.value.trim();
  stopKeyListRefresh();
  const keyIdentityToRestore = options.preserveSelection ? selectedKeyIdentity.value : null;
  if (reset) {
    loading.value = true;
    continuation.value = null;
    listRevision.value = null;
    keys.value = [];
    if (!options.preserveSelection) {
      clearSelectedKey();
    }
  } else {
    loadingMore.value = true;
  }
  try {
    const result = await props.api.listPrefix(connectionId, searchQuery, pageSize, reset ? null : continuation.value, reset || !listRevision.value ? undefined : { revision: listRevision.value });
    if (generation !== keyLoadGeneration || props.connectionId !== connectionId) return;
    if (reset && result.revision != null) listRevision.value = String(result.revision);
    const existing = new Set(keys.value.map(summaryIdentity));
    const merged = reset ? result.keys : [...keys.value, ...result.keys.filter((key) => !existing.has(summaryIdentity(key)))];
    keys.value = merged;
    continuation.value = result.continuation || null;
    preserveExpandedGroups();
    if (reset && options.preserveSelection) {
      const restoredSummary = refreshedKvSelectionSummary(keyIdentityToRestore, merged);
      if (restoredSummary) {
        await loadSelectedKey(routeFromSummary(restoredSummary));
      } else {
        clearSelectedKey();
      }
    }
  } finally {
    if (generation === keyLoadGeneration && props.connectionId === connectionId) {
      loading.value = false;
      loadingMore.value = false;
      startKeyListRefresh();
    }
  }
}

async function loadLazyRoot(reset = true, options: LoadKeysOptions = {}) {
  const keyToRestore = options.preserveSelection ? selectedKey.value : null;
  if (!reset) {
    await loadMoreLazyChildren(null);
    return;
  }

  const previousExpanded = new Set(expandedGroupIds.value);
  loading.value = true;
  loadingMore.value = false;
  if (!options.preserveSelection) {
    clearSelectedKey();
  }

  try {
    const rootPath = normalizeZooKeeperPath(prefix.value);
    resetLazyKvKeyTree(lazyTreeState, rootPath);
    const result = await props.api.listPrefix(props.connectionId, rootPath, pageSize, null, { recursive: false });
    if (rootPath === "/") {
      replaceLazyKvChildren(lazyTreeState, null, result.keys, result.continuation);
    } else {
      const rootSummary = await loadLazyRootSummary(rootPath, result.keys, result.continuation);
      if (rootSummary) {
        replaceLazyKvFocusedRoot(lazyTreeState, rootSummary, result.keys, result.continuation);
      } else {
        replaceLazyKvChildren(lazyTreeState, null, result.keys, result.continuation);
      }
    }

    if (options.preserveSelection) {
      await restoreLazyExpandedBranches(previousExpanded);
      expandFocusedRoot(rootPath);
      if (keyToRestore && lazyTreeState.nodeByKey.has(keyToRestore)) {
        await loadSelectedKey(keyToRestore);
      } else {
        clearSelectedKey();
      }
    } else {
      expandedGroupIds.value = focusedRootExpansion(rootPath);
    }
  } finally {
    loading.value = false;
  }
}

async function loadLazyRootSummary(rootPath: string, children: KvKeySummary[], continuation?: string | null): Promise<KvKeySummary | null> {
  try {
    const rootValue = await props.api.get(props.connectionId, rootPath);
    if (rootValue.found) return { key: rootValue.key || rootPath, ...rootValue.metadata };
    if (children.length === 0 && !continuation) return null;
  } catch {
    if (children.length === 0 && !continuation) return null;
  }
  return { key: rootPath, numChildren: children.length + (continuation ? 1 : 0) };
}

function focusedRootExpansion(rootPath: string): Set<string> {
  const normalized = normalizeZooKeeperPath(rootPath);
  if (normalized === "/") return new Set();
  return new Set(
    focusedPathKeys(normalized)
      .filter((key) => lazyTreeState.nodeByKey.has(key))
      .map((key) => `lazy:${key}`),
  );
}

function expandFocusedRoot(rootPath: string) {
  expandedGroupIds.value = new Set([...expandedGroupIds.value, ...focusedRootExpansion(rootPath)]);
}

function focusedPathKeys(rootPath: string): string[] {
  const segments = normalizeZooKeeperPath(rootPath).split("/").filter(Boolean);
  return segments.map((_, index) => `/${segments.slice(0, index + 1).join("/")}`);
}

async function restoreLazyExpandedBranches(previousExpanded: ReadonlySet<string>) {
  const restored = new Set<string>();
  const keysToExpand = [...previousExpanded]
    .map((id) => lazyExpandedKeyFromId(id))
    .filter((key): key is string => !!key)
    .sort((a, b) => a.split("/").length - b.split("/").length);

  for (const key of keysToExpand) {
    const node = lazyTreeState.nodeByKey.get(key);
    if (!node?.hasChildren) continue;
    restored.add(node.id);
    await loadLazyChildren(key, true);
  }

  expandedGroupIds.value = restored;
}

async function loadLazyChildren(parentKey: string, reset = true) {
  const node = lazyTreeState.nodeByKey.get(parentKey);
  if (!node || node.loading) return;
  node.loading = true;
  try {
    const continuationToUse = reset ? null : node.continuation;
    const result = await props.api.listPrefix(props.connectionId, parentKey, pageSize, continuationToUse, { recursive: false });
    replaceLazyKvChildren(lazyTreeState, parentKey, result.keys, result.continuation, { append: !reset });
  } finally {
    const latest = lazyTreeState.nodeByKey.get(parentKey);
    if (latest) latest.loading = false;
  }
}

async function loadMoreLazyChildren(parentKey: string | null) {
  if (parentKey) {
    await loadLazyChildren(parentKey, false);
    return;
  }

  if (loadingMore.value || !lazyTreeState.rootContinuation) return;
  loadingMore.value = true;
  try {
    const result = await props.api.listPrefix(props.connectionId, lazyTreeState.rootPath, pageSize, lazyTreeState.rootContinuation, { recursive: false });
    replaceLazyKvChildren(lazyTreeState, null, result.keys, result.continuation, { append: true });
  } finally {
    loadingMore.value = false;
  }
}

async function refreshLazyParent(parentPath: string) {
  const normalizedParent = normalizeZooKeeperPath(parentPath);
  if (normalizedParent === lazyTreeState.rootPath) {
    if (lazyTreeState.rootPath === "/") {
      const result = await props.api.listPrefix(props.connectionId, lazyTreeState.rootPath, pageSize, null, { recursive: false });
      replaceLazyKvChildren(lazyTreeState, null, result.keys, result.continuation);
    } else {
      await loadLazyChildren(lazyTreeState.rootPath, true);
      expandFocusedRoot(lazyTreeState.rootPath);
    }
    return;
  }

  if (lazyTreeState.nodeByKey.has(normalizedParent)) {
    await loadLazyChildren(normalizedParent, true);
  } else {
    await loadLazyRoot(true, { preserveSelection: true });
  }
}

async function loadSelectedKey(input: string | KvKeyRoute) {
  const route = routeFromKey(input);
  const key = route.key;
  const keyIdentity = routeIdentity(route);
  stopMetadataRefresh();
  const requestId = ++detailRequestId;
  selectedKey.value = key;
  selectedKeyIdentity.value = keyIdentity;
  selectedRouteKeyBytes.value = route.keyBytes ?? null;
  selectedValue.value = null;
  selectedPrettyValue.value = null;
  detailLoading.value = true;
  detailError.value = "";
  try {
    const result = await props.api.get(props.connectionId, key, route.keyBytes ? { keyBytes: route.keyBytes } : undefined);
    if (requestId !== detailRequestId || selectedKey.value !== key) return;
    if (!result.found) {
      removeExpiredSelectedKey(key);
      return;
    }
    selectedValue.value = result;
    selectedKeyIdentity.value = result.keyIdentity ?? selectedKeyIdentity.value;
    selectedRouteKeyBytes.value = result.keyBytes ?? selectedRouteKeyBytes.value;
    startMetadataRefresh(key);
    startKeyListRefresh();
  } catch (error) {
    if (requestId !== detailRequestId || selectedKey.value !== key) return;
    detailError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (requestId === detailRequestId) detailLoading.value = false;
  }
}

function clearSelectedKey() {
  stopMetadataRefresh();
  detailRequestId++;
  selectedKey.value = null;
  selectedKeyIdentity.value = null;
  selectedRouteKeyBytes.value = null;
  selectedValue.value = null;
  selectedPrettyValue.value = null;
  detailLoading.value = false;
}

function startMetadataRefresh(key: string) {
  stopMetadataRefresh();
  const metadata = selectedValue.value?.metadata;
  if (!props.api.getMetadata || !hasPositiveKvLease(metadata?.lease) || typeof metadata?.ttl !== "number") return;

  const generation = metadataRefreshGeneration;
  metadataRefreshTimer = setInterval(() => {
    void refreshSelectedMetadata(key, generation);
  }, metadataRefreshIntervalMs);
}

function stopMetadataRefresh() {
  metadataRefreshGeneration++;
  metadataRefreshInFlight = false;
  if (metadataRefreshTimer !== null) {
    clearInterval(metadataRefreshTimer);
    metadataRefreshTimer = null;
  }
}

function startKeyListRefresh() {
  stopKeyListRefresh();
  keyListRefreshDelayMs = keyListRefreshBaseIntervalMs;
  scheduleKeyListRefresh(keyListRefreshGeneration);
}

function scheduleKeyListRefresh(generation: number) {
  if (generation !== keyListRefreshGeneration || !props.supportsTtl || props.lazyHierarchy || !props.api.getMetadata || knownLeaseKeyRoutes().length === 0) {
    return;
  }

  keyListRefreshTimer = setTimeout(() => {
    keyListRefreshTimer = null;
    void refreshKnownLeaseKeys(generation);
  }, keyListRefreshDelayMs);
}

function stopKeyListRefresh() {
  keyListRefreshGeneration++;
  if (keyListRefreshTimer !== null) {
    clearTimeout(keyListRefreshTimer);
    keyListRefreshTimer = null;
  }
}

async function refreshKnownLeaseKeys(generation: number) {
  const getMetadata = props.api.getMetadata;
  if (!props.supportsTtl || props.lazyHierarchy || !getMetadata || loading.value || loadingMore.value || generation !== keyListRefreshGeneration) {
    return;
  }

  const connectionId = props.connectionId;
  const leaseRoutes = knownLeaseKeyRoutes();
  let failed = false;
  for (const route of leaseRoutes) {
    try {
      const result = await getMetadata(connectionId, route.key, route.keyBytes ? { keyBytes: route.keyBytes } : undefined);
      if (generation !== keyListRefreshGeneration || props.connectionId !== connectionId) return;
      if (result.found && !result.metadata) {
        failed = true;
        continue;
      }

      const previousLength = keys.value.length;
      keys.value = mergeKvKeyMetadata(keys.value, route.key, result, route.keyIdentity);
      if (keys.value.length !== previousLength) preserveExpandedGroups();
    } catch {
      if (generation !== keyListRefreshGeneration || props.connectionId !== connectionId) return;
      failed = true;
    }
  }

  if (generation !== keyListRefreshGeneration || props.connectionId !== connectionId) return;
  keyListRefreshDelayMs = nextKvLeaseRefreshDelay(keyListRefreshDelayMs, failed, keyListRefreshBaseIntervalMs, keyListRefreshMaxIntervalMs);
  scheduleKeyListRefresh(generation);
}

function removeExpiredSelectedKey(key: string) {
  keys.value = selectedKeyIdentity.value ? keys.value.filter((item) => summaryIdentity(item) !== selectedKeyIdentity.value) : removeMissingKvKey(keys.value, key);
  preserveExpandedGroups();
  clearSelectedKey();
}

async function refreshSelectedValueSilently(key: string, generation: number) {
  const result = await props.api.get(props.connectionId, key, selectedKeyBytes.value ? { keyBytes: selectedKeyBytes.value } : undefined);
  if (generation !== metadataRefreshGeneration || selectedKey.value !== key) return;
  if (!result.found) {
    removeExpiredSelectedKey(key);
    return;
  }

  selectedValue.value = mergeKvValueRefresh(selectedValue.value, result);
  const metadata = selectedValue.value.metadata;
  if (!hasPositiveKvLease(metadata?.lease) || typeof metadata?.ttl !== "number") {
    stopMetadataRefresh();
  }
}

async function refreshSelectedMetadata(key: string, generation: number) {
  const getMetadata = props.api.getMetadata;
  if (!getMetadata || metadataRefreshInFlight || generation !== metadataRefreshGeneration || selectedKey.value !== key) return;

  metadataRefreshInFlight = true;
  try {
    const result = await getMetadata(props.connectionId, key, selectedKeyBytes.value ? { keyBytes: selectedKeyBytes.value } : undefined);
    if (generation !== metadataRefreshGeneration || selectedKey.value !== key) return;

    const current = selectedValue.value;
    const decision = decideKvMetadataRefresh(current, result);
    if (decision.type === "notFound") {
      removeExpiredSelectedKey(key);
    } else if (decision.type === "stop") {
      stopMetadataRefresh();
    } else if (decision.type === "reload") {
      await refreshSelectedValueSilently(key, generation);
    } else if (!current || !updateKvResponseTtl(current, decision.ttl)) {
      stopMetadataRefresh();
    }
  } catch {
    // Keep polling after transient failures so the countdown can recover.
  } finally {
    if (generation === metadataRefreshGeneration) metadataRefreshInFlight = false;
  }
}

async function toggleGroup(node: BrowserTreeNode) {
  if (!nodeIsExpandable(node)) return;
  const next = new Set(expandedGroupIds.value);
  if (next.has(node.id)) {
    next.delete(node.id);
  } else {
    next.add(node.id);
    if (node.kind === "lazy" && node.hasChildren && !node.loaded) {
      void loadLazyChildren(node.key, true);
    }
  }
  expandedGroupIds.value = next;
}

function nodePath(node: BrowserTreeNode): string {
  if (node.kind === "lazy") return node.key;
  return kvKeyTreeNodePath(node);
}

function onRowClick(node: BrowserTreeNode) {
  if (nodeIsExpandable(node)) {
    void toggleGroup(node);
    if (props.enableNodeActions && nodeHasValue(node)) void loadSelectedKey(routeFromNode(node));
  } else {
    void loadSelectedKey(routeFromNode(node));
  }
}

function onRowDoubleClick(node: BrowserTreeNode) {
  if (!nodeIsExpandable(node)) {
    void loadSelectedKey(routeFromNode(node)).then(() => openEditDialog());
  }
}

function createKeyPrefix(parentPath?: string): string {
  if (props.lazyHierarchy) return createZooKeeperChildPathDraft(parentPath ?? prefix.value);
  const path = parentPath ?? prefix.value.trim();
  if (!path) return "";
  if (path === "/") return "/";
  return path.endsWith("/") ? path : `${path}/`;
}

function openCreateDialog(parentPath?: string) {
  if (props.readOnly) return;
  isCreating.value = true;
  editKey.value = createKeyPrefix(parentPath);
  editValue.value = "";
  editTtl.value = "";
  editExpiryMode.value = "permanent";
  editLeaseId.value = "";
  editEncoding.value = "utf8";
  editFormat.value = "text";
  editError.value = "";
  editErrorKind.value = "request";
  selectedCreateMode.value = props.createModeOptions[0]?.value || "persistent";
  showEditDialog.value = true;
}

function selectExpiryMode(mode: KvExpiryMode) {
  editExpiryMode.value = mode;
  if (mode === "lease") props.onLeaseOptionsRequested?.();
}

function openEditDialog() {
  if (!selectedKey.value || !canEditSelectedValue.value) return;
  isCreating.value = false;
  editKey.value = selectedKey.value;
  editValue.value = selectedTextValue.value;
  editEncoding.value = selectedValueIsBase64.value ? "base64" : "utf8";
  editFormat.value = detectKvValueFormat(editValue.value, editEncoding.value);
  const existingLease = String(selectedMetadata.value?.lease ?? "").trim();
  editExpiryMode.value = existingLease && existingLease !== "0" ? "lease" : "permanent";
  editLeaseId.value = editExpiryMode.value === "lease" ? existingLease : "";
  editTtl.value = "";
  editError.value = "";
  editErrorKind.value = "request";
  showEditDialog.value = true;
}

function parsedLeaseId(): KvInt64 | null {
  return parseKvLeaseId(editLeaseId.value);
}

function putOptions(): KvPutOptions | undefined {
  const options: KvPutOptions = {};
  if (props.safeWrite) {
    if (isCreating.value) options.expectedCreateRevision = "0";
    else {
      options.expectedModRevision = revisionString(selectedMetadata.value?.modRevision);
      options.keyBytes = selectedKeyBytes.value;
    }
  }
  if (props.supportsCreateModes) {
    if (isCreating.value) {
      options.writeMode = "create";
      options.createMode = selectedCreateMode.value;
    } else {
      options.writeMode = "update";
    }
  }
  if (showExpiryControls.value && editExpiryMode.value === "ttl") {
    const parsed = parseOptionalTtl(editTtl.value);
    if (parsed.ok && parsed.ttl != null) options.ttl = parsed.ttl;
  }
  if (showExpiryControls.value && editExpiryMode.value === "lease") {
    const lease = parsedLeaseId();
    if (lease) options.lease = lease;
  }
  return Object.keys(options).length ? options : undefined;
}

async function saveKey() {
  editErrorKind.value = "request";
  const rawKey = editKey.value.trim();
  if (!rawKey) {
    editError.value = props.labels.keyRequired;
    return;
  }
  if (props.lazyHierarchy && normalizeZooKeeperPath(rawKey) === "/") {
    editError.value = props.labels.rootReadonly || props.labels.keyRequired;
    return;
  }
  if (showExpiryControls.value && editExpiryMode.value === "ttl") {
    const parsed = parseOptionalTtl(editTtl.value);
    if (!props.supportsTtl) {
      editError.value = props.labels.ttlUnavailable || "TTL is not supported by the installed agent";
      return;
    }
    if (!String(editTtl.value).trim() || !parsed.ok || parsed.ttl == null) {
      editError.value = props.labels.ttlInvalid || "TTL must be a positive integer";
      return;
    }
  }
  if (showExpiryControls.value && editExpiryMode.value === "lease" && !parsedLeaseId()) {
    editError.value = props.labels.leaseInvalid || "Lease ID must be a positive 64-bit integer";
    return;
  }
  const key = props.lazyHierarchy ? normalizeZooKeeperPath(rawKey) : rawKey;
  const validationError = validateKvValue(editValue.value, editFormat.value);
  if (validationError) {
    editError.value = validationError;
    return;
  }
  const value: KvValue = { encoding: editEncoding.value, data: editValue.value.replace(editEncoding.value === "base64" ? /\s+/g : /$^/, "") };
  pendingSave.value = { key, value, options: putOptions() };
  showSaveDiff.value = true;
}

async function confirmSaveKey() {
  if (!pendingSave.value) return;
  const { key, value, options } = pendingSave.value;
  saving.value = true;
  editError.value = "";
  editErrorKind.value = "request";
  try {
    const response = await props.api.put(props.connectionId, key, value, options);
    const keyToSelect = response.createdKey || response.key || key;
    showSaveDiff.value = false;
    showEditDialog.value = false;
    pendingSave.value = null;
    if (props.lazyHierarchy) {
      await refreshLazyParent(parentZooKeeperPath(keyToSelect));
    } else {
      await loadKeys(true);
    }
    await loadSelectedKey(options?.keyBytes ? { key: keyToSelect, keyIdentity: selectedKeyIdentity.value, keyBytes: options.keyBytes } : keyToSelect);
    toast(props.labels.saved, 2500);
  } catch (error) {
    const classified = classifyKvMutationError(error, isCreating.value, {
      keyAlreadyExists: props.labels.keyAlreadyExists,
      conflict: props.labels.conflict,
    });
    editError.value = classified.message;
    editErrorKind.value = classified.kind;
    showSaveDiff.value = false;
  } finally {
    saving.value = false;
  }
}

async function deleteSelectedKey() {
  if (!selectedKey.value) return;
  const parentPath = parentZooKeeperPath(selectedKey.value);
  deleting.value = true;
  try {
    await props.api.deleteKey(
      props.connectionId,
      selectedKey.value,
      props.safeWrite
        ? {
            keyBytes: selectedKeyBytes.value,
            expectedModRevision: revisionString(selectedMetadata.value?.modRevision),
          }
        : undefined,
    );
    showDeleteConfirm.value = false;
    clearSelectedKey();
    if (props.lazyHierarchy) {
      await refreshLazyParent(parentPath);
    } else {
      await loadKeys(true);
    }
    toast(props.labels.deleted, 2500);
  } catch (error) {
    detailError.value = error instanceof Error ? error.message : String(error);
    showDeleteConfirm.value = false;
  } finally {
    deleting.value = false;
  }
}

async function selectNodeForAction(node: BrowserTreeNode) {
  if (!nodeHasValue(node)) return;
  const route = routeFromNode(node);
  if (selectedKeyIdentity.value !== routeIdentity(route)) await loadSelectedKey(route);
  else {
    selectedKey.value = route.key;
    selectedKeyIdentity.value = routeIdentity(route);
    selectedRouteKeyBytes.value = route.keyBytes ?? selectedRouteKeyBytes.value;
  }
}

async function openDeleteForNode(node: BrowserTreeNode) {
  if (props.readOnly) return;
  await selectNodeForAction(node);
  showDeleteConfirm.value = true;
}

function revisionString(value: string | number | null | undefined): KvInt64 | undefined {
  return value == null ? undefined : String(value);
}

async function copySelectedKey() {
  if (!selectedKey.value) return;
  await navigator.clipboard.writeText(selectedKey.value);
}

function watchSelectedKey() {
  if (!selectedKey.value || !props.onWatchKey) return;
  props.onWatchKey({
    key: selectedKey.value,
    keyIdentity: selectedKeyIdentity.value,
    keyBytes: selectedKeyBytes.value,
  });
}

function downloadText(filename: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function exportSelectedKey() {
  if (!selectedKey.value || !selectedValue.value?.found) return;
  downloadText(
    `${selectedKey.value.split("/").filter(Boolean).pop() || "etcd-key"}.dbx-etcd.json`,
    JSON.stringify(
      {
        format: "dbx-etcd-bundle",
        version: 1,
        exportedAt: new Date().toISOString(),
        prefix: selectedKey.value,
        scopeKind: "key",
        entries: [
          {
            key: selectedKeyBytes.value ?? { encoding: "utf8", data: selectedKey.value },
            value: selectedValue.value.value,
            metadata: selectedValue.value.metadata,
            formatHint: detectKvValueFormat(selectedTextValue.value, selectedValueIsBase64.value ? "base64" : "utf8"),
          },
        ],
      },
      null,
      2,
    ),
  );
}

async function exportNode(node: BrowserTreeNode) {
  const request: KvExportScopeRequest = {
    path: nodePath(node),
    kind: nodeIsExpandable(node) ? "prefix" : "key",
    keyBytes: node.kind === "lazy" ? null : node.keyBytes,
  };
  if (props.api.exportScope) {
    await props.api.exportScope(props.connectionId, request);
    return;
  }
  if (!nodeHasValue(node)) return;
  await loadSelectedKey(routeFromNode(node));
  exportSelectedKey();
}

async function openCloneDialog() {
  if (!selectedKey.value || !selectedValue.value?.found || props.readOnly) return;
  isCreating.value = true;
  editKey.value = selectedKey.value;
  editValue.value = selectedTextValue.value;
  editEncoding.value = selectedValueIsBase64.value ? "base64" : "utf8";
  editFormat.value = detectKvValueFormat(editValue.value, editEncoding.value);
  editExpiryMode.value = "permanent";
  editLeaseId.value = "";
  editTtl.value = "";
  editError.value = "";
  editErrorKind.value = "request";
  showEditDialog.value = true;
}

function onEditFormatChange(value: unknown) {
  const format = String(value) as KvValueFormat;
  if (!valueFormatOptions.some((option) => option.value === format)) return;
  editFormat.value = format;
  editEncoding.value = format === "base64" ? "base64" : "utf8";
  editError.value = "";
  editErrorKind.value = "request";
}

function openRenameDialog() {
  if (!selectedKey.value || !props.api.rename || props.readOnly) return;
  renameValue.value = selectedKey.value;
  renameError.value = "";
  showRenameDialog.value = true;
}

async function renameSelectedKey() {
  if (!selectedKey.value || !props.api.rename) return;
  const next = renameValue.value.trim();
  if (!next) {
    renameError.value = props.labels.keyRequired;
    return;
  }
  renaming.value = true;
  renameError.value = "";
  try {
    await props.api.rename(props.connectionId, {
      key: selectedKey.value,
      keyBytes: selectedKeyBytes.value,
      newKey: next,
      expectedModRevision: revisionString(selectedMetadata.value?.modRevision),
    });
    showRenameDialog.value = false;
    await loadKeys(true);
    await loadSelectedKey({ key: next, keyIdentity: next, keyBytes: { encoding: "utf8", data: next } });
    toast(props.labels.saved, 2500);
  } catch (error) {
    renameError.value = error instanceof Error ? error.message : String(error);
  } finally {
    renaming.value = false;
  }
}

async function openHistory() {
  if (!selectedKey.value || !props.api.history) return;
  showHistoryDialog.value = true;
  historyLoading.value = true;
  historyError.value = "";
  selectedHistoryEvent.value = null;
  try {
    const response = await props.api.history(props.connectionId, {
      key: selectedKey.value,
      keyBytes: selectedKeyBytes.value,
      startRevision: undefined,
      endRevision: undefined,
      limit: 100,
    });
    historyEvents.value = response.events;
  } catch (error) {
    historyEvents.value = [];
    historyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    historyLoading.value = false;
  }
}

function compareHistory(event: KvHistoryEvent) {
  selectedHistoryEvent.value = event;
  showHistoryDiff.value = true;
}

async function restoreHistory() {
  if (!selectedKey.value || !historyRestoreValue.value) return;
  restoring.value = true;
  try {
    await props.api.put(props.connectionId, selectedKey.value, historyRestoreValue.value, {
      keyBytes: selectedKeyBytes.value,
      expectedModRevision: revisionString(selectedMetadata.value?.modRevision),
    });
    showHistoryDiff.value = false;
    showHistoryDialog.value = false;
    await loadKeys(true, { preserveSelection: true });
    toast(props.labels.saved, 2500);
  } catch (error) {
    historyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    restoring.value = false;
  }
}

function nodeContextMenuItems(node: BrowserTreeNode): ContextMenuItem[] {
  if (!props.enableNodeActions) return [];
  const items: ContextMenuItem[] = [
    {
      label: props.labels.add || props.labels.newKey,
      icon: Plus,
      action: () => openCreateDialog(nodePath(node)),
      disabled: props.readOnly,
    },
  ];
  if (nodeHasValue(node)) {
    items.push(
      {
        label: props.labels.edit,
        icon: Pencil,
        action: () => void loadSelectedKey(routeFromNode(node)).then(openEditDialog),
        disabled: props.readOnly,
      },
      {
        label: props.labels.rename || "Rename",
        icon: Pencil,
        action: () => void loadSelectedKey(routeFromNode(node)).then(openRenameDialog),
        disabled: props.readOnly || !props.api.rename,
      },
      {
        label: props.labels.clone || "Clone",
        icon: Copy,
        action: () => void loadSelectedKey(routeFromNode(node)).then(openCloneDialog),
        disabled: props.readOnly,
      },
      {
        label: props.labels.copyKey || "Copy key",
        icon: Copy,
        action: () => void copySelectedKey(),
      },
      {
        label: props.labels.history || "History",
        icon: Clock3,
        action: () => void loadSelectedKey(routeFromNode(node)).then(openHistory),
        disabled: !props.api.history,
      },
    );
  }
  if (props.api.exportScope || nodeHasValue(node)) {
    items.push({
      label: props.labels.export || "Export",
      icon: Download,
      action: () => void exportNode(node),
    });
  }
  items.push({
    label: props.labels.delete,
    icon: Trash2,
    variant: "destructive",
    action: () => void openDeleteForNode(node),
    disabled: props.readOnly || !nodeHasValue(node),
  });
  return items;
}

function onRowContextMenu(event: MouseEvent, node: BrowserTreeNode, openContextMenu: (event: MouseEvent) => void) {
  if (!props.enableNodeActions) return;
  void selectNodeForAction(node);
  openContextMenu(event);
}

function rowIsSelected(node: BrowserTreeNode): boolean {
  return routeIdentity(routeFromNode(node)) === selectedKeyIdentity.value;
}

function nodeIsExpandable(node: BrowserTreeNode): boolean {
  return node.kind === "group" || (node.kind === "lazy" && node.hasChildren);
}

function nodeHasValue(node: BrowserTreeNode): boolean {
  return node.kind === "leaf" || node.kind === "lazy" || Boolean(node.key);
}

function nodeIsExpanded(node: BrowserTreeNode): boolean {
  return expandedGroupIds.value.has(node.id);
}

function nodeIsLoading(node: BrowserTreeNode): boolean {
  return node.kind === "lazy" && node.loading;
}

function prettifySelectedJson() {
  const result = prettyPrintJsonText(selectedTextValue.value);
  if (result.ok && result.value != null) {
    selectedPrettyValue.value = result.value;
  } else {
    toast(props.labels.invalidJson || "Invalid JSON", 2500);
  }
}

function prettifyEditJson() {
  const result = prettyPrintJsonText(editValue.value);
  if (result.ok && result.value != null) {
    editValue.value = result.value;
    editError.value = "";
    editErrorKind.value = "request";
  } else {
    editError.value = props.labels.invalidJson || "Invalid JSON";
    editErrorKind.value = "request";
  }
}

function metadataLabel(value: string | number | null | undefined): string {
  return value == null ? "-" : String(value);
}

function focusSearch(): boolean {
  searchInputRef.value?.focus();
  return true;
}

function refresh(): boolean {
  void loadKeys(true, { preserveSelection: true });
  return true;
}

function expandPathToKey(key: string) {
  if (props.lazyHierarchy) return;
  const segments = key.split("/").filter(Boolean);
  if (segments.length < 2) return;
  const next = new Set(expandedGroupIds.value);
  const groupPrefix = key.startsWith("/") ? "/" : "";
  for (let index = 1; index < segments.length; index++) {
    next.add(`group:${groupPrefix}${segments.slice(0, index).join("\u0000")}`);
  }
  expandedGroupIds.value = next;
}

async function selectKeyFromNavigation(key: string | KvKeyRoute) {
  // Search results can remount this browser. Wait for the initial list reset
  // before applying the selection so it cannot clear the detail pane afterward.
  await initialLoadPromise?.catch(() => undefined);
  const route = routeFromKey(key);
  expandPathToKey(route.key);
  await loadSelectedKey(route);
}

watch(
  () => props.connectionId,
  async () => {
    stopKeyListRefresh();
    clearSelectedKey();
    try {
      await connectionStore.ensureConnected(props.connectionId);
    } catch {
      // Connection failed — loadKeys will show the error state
    }
    void loadKeys(true);
  },
);

watch(
  () => props.supportsTtl,
  (supported) => {
    if (supported) startKeyListRefresh();
    else stopKeyListRefresh();
  },
);

watch(
  () => selectedKey.value,
  () => {
    startKeyListRefresh();
  },
);

watch(
  () => props.createModeOptions,
  (options) => {
    if (!options.some((option) => option.value === selectedCreateMode.value)) {
      selectedCreateMode.value = options[0]?.value || "persistent";
    }
  },
  { immediate: true },
);

watch(editKey, () => {
  if (editErrorKind.value !== "keyAlreadyExists") return;
  editError.value = "";
  editErrorKind.value = "request";
});

onMounted(() => {
  initialLoadPromise = (async () => {
    try {
      await connectionStore.ensureConnected(props.connectionId);
    } catch (e) {
      console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
    }
    try {
      await loadKeys(true);
    } catch {
      // The browser's normal refresh path can retry after a transient failure.
    }
  })();
});

onBeforeUnmount(() => {
  clearSelectedKey();
  stopKeyListRefresh();
});
defineExpose({
  focusSearch,
  refresh,
  selectKey: selectKeyFromNavigation,
  openCreate: (parentPath?: string) => openCreateDialog(parentPath),
  selection: () => ({ key: selectedKey.value, value: selectedValue.value }),
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <div class="relative min-w-0 flex-1">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref="searchInputRef"
          v-model="prefix"
          class="h-8 pl-8"
          role="combobox"
          aria-autocomplete="list"
          :aria-expanded="showKeySuggestions"
          aria-controls="kv-key-prefix-suggestions"
          :aria-activedescendant="keySuggestionIndex >= 0 ? `kv-key-prefix-suggestion-${keySuggestionIndex}` : undefined"
          :placeholder="labels.prefixPlaceholder"
          @input="onPrefixInput"
          @focus="keySuggestionOpen = Boolean(prefix.trim())"
          @blur="closeKeySuggestions"
          @keydown="onPrefixKeydown"
        />
        <div v-if="showKeySuggestions" id="kv-key-prefix-suggestions" role="listbox" class="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-lg">
          <button
            v-for="(suggestion, index) in keySuggestions"
            :id="`kv-key-prefix-suggestion-${index}`"
            :key="summaryIdentity(suggestion)"
            type="button"
            role="option"
            :aria-selected="keySuggestionIndex === index"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-xs"
            :class="keySuggestionIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70'"
            @mouseenter="keySuggestionIndex = index"
            @mousedown.prevent="acceptKeySuggestion(index)"
          >
            <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ suggestion.key }}</span>
          </button>
        </div>
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="loadKeys(true, { preserveSelection: true })">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
      <Button size="sm" class="h-8 gap-1.5" :disabled="readOnly" @click="openCreateDialog()">
        <Plus class="h-3.5 w-3.5" />
        {{ labels.newKey }}
      </Button>
    </div>

    <Splitpanes class="kv-browser-splitpanes min-h-0 flex-1" @resized="handleKvBrowserSplitResized">
      <Pane :size="kvBrowserSplitSize" min-size="20" max-size="70">
        <div class="h-full min-h-0">
          <div v-if="loading" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {{ labels.loadingKeys }}
          </div>
          <div v-else-if="visibleRows.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {{ labels.empty }}
          </div>
          <div v-else class="h-full overflow-auto py-1 text-sm">
            <template v-for="row in visibleRows" :key="row.type === 'node' ? row.node.id : row.id">
              <CustomContextMenu v-if="row.type === 'node'" :items="nodeContextMenuItems(row.node)" v-slot="{ onContextMenu }">
                <button
                  type="button"
                  class="flex h-8 w-full items-center gap-1.5 px-2 text-left transition-colors hover:bg-accent"
                  :class="rowIsSelected(row.node) ? 'bg-primary/10 font-medium text-foreground shadow-[inset_3px_0_0_hsl(var(--primary))]' : ''"
                  :style="{ paddingLeft: `${8 + row.depth * 18}px` }"
                  @click="onRowClick(row.node)"
                  @dblclick.stop.prevent="onRowDoubleClick(row.node)"
                  @contextmenu="(event) => onRowContextMenu(event, row.node, onContextMenu)"
                >
                  <template v-if="nodeIsExpandable(row.node)">
                    <Loader2 v-if="nodeIsLoading(row.node)" class="h-3.5 w-3.5 shrink-0 animate-spin" />
                    <ChevronDown v-else-if="nodeIsExpanded(row.node)" class="h-3.5 w-3.5 shrink-0" />
                    <ChevronRight v-else class="h-3.5 w-3.5 shrink-0" />
                    <FolderOpen v-if="nodeIsExpanded(row.node)" class="h-4 w-4 shrink-0 text-sky-500" />
                    <FolderClosed v-else class="h-4 w-4 shrink-0 text-sky-500" />
                  </template>
                  <template v-else>
                    <span class="w-3.5 shrink-0" />
                    <KeyRound class="h-4 w-4 shrink-0 text-sky-500" />
                  </template>
                  <span class="truncate">{{ row.node.label }}</span>
                </button>
              </CustomContextMenu>
              <div v-else class="px-2 py-1" :style="{ paddingLeft: `${8 + row.depth * 18}px` }">
                <Button size="sm" variant="outline" class="h-7 w-full gap-1.5" :disabled="row.loading || loadingMore" @click="loadMoreLazyChildren(row.parentKey)">
                  <Loader2 v-if="row.loading || (row.parentKey === null && loadingMore)" class="h-3.5 w-3.5 animate-spin" />
                  {{ labels.loadMore }}
                </Button>
              </div>
            </template>
            <div v-if="!lazyHierarchy && continuation" class="border-t p-2">
              <Button size="sm" variant="outline" class="h-8 w-full gap-1.5" :disabled="loadingMore" @click="loadKeys(false)">
                <Loader2 v-if="loadingMore" class="h-3.5 w-3.5 animate-spin" />
                {{ labels.loadMore }}
              </Button>
            </div>
          </div>
        </div>
      </Pane>

      <Pane :size="100 - kvBrowserSplitSize" min-size="30">
        <div class="h-full min-h-0 overflow-auto">
          <div v-if="!selectedKey" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {{ labels.selectKey }}
          </div>
          <div v-else class="flex min-h-full flex-col">
            <div class="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
              <div class="min-w-0">
                <div class="truncate font-medium" :class="{ 'text-blue-600 dark:text-blue-400': metadataStyle === 'zookeeper' }">{{ selectedKey }}</div>
                <div class="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                  <template v-if="metadataStyle === 'zookeeper'">
                    <Badge v-for="badge in zookeeperSummaryBadges" :key="badge.label" variant="outline" class="rounded-full">
                      {{ `${badge.label} ${badge.value}` }}
                    </Badge>
                  </template>
                  <template v-else>
                    <Badge variant="secondary">rev {{ metadataLabel(selectedMetadata?.modRevision) }}</Badge>
                    <Badge variant="outline">ver {{ metadataLabel(selectedMetadata?.version) }}</Badge>
                    <Badge variant="outline">lease {{ metadataLabel(selectedMetadata?.lease) }}</Badge>
                    <Badge v-if="selectedTtlLabel" variant="outline">TTL {{ selectedTtlLabel }}</Badge>
                    <Badge variant="outline">{{ metadataLabel(selectedMetadata?.valueSize) }} B</Badge>
                  </template>
                </div>
              </div>
              <div class="flex shrink-0 gap-2">
                <Button v-if="onWatchKey" size="sm" variant="outline" class="h-8 gap-1.5" @click="watchSelectedKey">
                  <Activity class="h-3.5 w-3.5" />
                  {{ labels.watch || "Watch" }}
                </Button>
                <Button v-if="api.history" size="sm" variant="outline" class="h-8 gap-1.5" @click="openHistory">
                  <Clock3 class="h-3.5 w-3.5" />
                  {{ labels.history || "History" }}
                </Button>
                <Button size="sm" variant="outline" class="h-8" :disabled="!canEditSelectedValue" @click="openEditDialog">
                  {{ labels.edit }}
                </Button>
                <Button size="sm" variant="destructive" class="h-8 gap-1.5" :disabled="readOnly" @click="showDeleteConfirm = true">
                  <Trash2 class="h-3.5 w-3.5" />
                  {{ labels.delete }}
                </Button>
              </div>
            </div>
            <div v-if="detailLoading" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              <Loader2 class="mr-2 h-4 w-4 animate-spin" />
              {{ labels.loadingValue }}
            </div>
            <div v-else-if="detailError" class="p-4 text-sm text-destructive">{{ detailError }}</div>
            <div v-else-if="selectedValue && !selectedValue.found" class="p-4 text-sm text-muted-foreground">
              {{ labels.notFound }}
            </div>
            <div v-else class="flex min-h-0 flex-1 flex-col gap-4 p-4">
              <div class="min-h-0">
                <div v-if="metadataStyle === 'zookeeper'" class="mb-2 text-xs font-medium text-muted-foreground">{{ labels.value || "Value" }}</div>
                <pre class="dbx-editor-font-family m-0 max-h-[40vh] min-h-32 overflow-auto rounded-md border bg-muted/20 whitespace-pre-wrap break-words p-3 text-sm">{{ displayedSelectedTextValue }}</pre>
                <div v-if="selectedValueCanPrettyJson" class="mt-2 flex justify-end">
                  <Button size="sm" variant="outline" class="h-8" @click="prettifySelectedJson">
                    {{ labels.prettyJson || "Pretty" }}
                  </Button>
                </div>
              </div>
              <div v-if="metadataStyle === 'zookeeper'" class="grid gap-3 border-t pt-4">
                <div class="text-xs font-medium text-muted-foreground">{{ labels.metadata || "Metadata" }}</div>
                <div class="grid gap-x-10 gap-y-4 sm:grid-cols-2">
                  <div v-for="row in zookeeperMetadataRows" :key="row.label" class="grid grid-cols-[minmax(96px,auto)_1fr] items-baseline gap-5 text-sm">
                    <div class="text-foreground">{{ row.label }}</div>
                    <div class="dbx-editor-font-family min-w-0 break-all text-blue-600 dark:text-blue-400">{{ row.value }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Pane>
    </Splitpanes>

    <Dialog v-model:open="showEditDialog">
      <DialogContent class="flex max-h-[min(90vh,860px)] max-w-[min(94vw,920px)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader class="shrink-0 border-b px-6 py-4">
          <DialogTitle>{{ isCreating ? labels.newKey : labels.editKey }}</DialogTitle>
        </DialogHeader>
        <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-5">
          <div class="grid gap-2">
            <Label for="kv-edit-key">Key</Label>
            <Input id="kv-edit-key" v-model="editKey" class="h-10 font-mono" :aria-invalid="editErrorKind === 'keyAlreadyExists'" :disabled="!isCreating" :placeholder="labels.keyPlaceholder" />
            <div v-if="editError && editErrorKind === 'keyAlreadyExists'" class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
              {{ editError }}
            </div>
            <div v-if="highRiskRegistryKey" class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
              {{ labels.registryWarning || "This key is under /registry/, a namespace commonly used by control-plane components. Verify the owner and impact before saving." }}
            </div>
          </div>

          <div v-if="showCreateModeSelect" class="grid gap-2">
            <Label>{{ labels.createMode || "Create Mode" }}</Label>
            <Select v-model="selectedCreateMode">
              <SelectTrigger class="h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in createModeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <section v-if="showExpiryControls" class="space-y-3 rounded-lg border bg-muted/15 p-4">
            <Label>{{ labels.expiryMode || "Expiry policy" }}</Label>
            <div class="grid gap-2 md:grid-cols-3">
              <button
                v-for="option in expiryModeOptions"
                :key="option.value"
                type="button"
                class="flex min-h-20 items-start gap-3 rounded-md border bg-background px-3 py-3 text-left transition-colors hover:border-primary/50 disabled:cursor-not-allowed disabled:opacity-45"
                :class="editExpiryMode === option.value ? 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-input'"
                :disabled="option.disabled"
                @click="selectExpiryMode(option.value)"
              >
                <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border" :class="editExpiryMode === option.value ? 'border-primary' : 'border-muted-foreground/50'">
                  <span v-if="editExpiryMode === option.value" class="h-2 w-2 rounded-full bg-primary" />
                </span>
                <span class="min-w-0">
                  <span class="block text-sm font-medium">{{ option.label }}</span>
                  <span class="mt-1 block text-xs leading-4 text-muted-foreground">{{ option.hint }}</span>
                </span>
              </button>
            </div>
            <div v-if="editExpiryMode === 'ttl'" class="grid gap-2 md:grid-cols-[160px_1fr] md:items-center">
              <Label for="kv-edit-ttl">{{ labels.ttl || "TTL (seconds)" }}</Label>
              <Input id="kv-edit-ttl" v-model="editTtl" class="h-10" type="number" min="1" step="1" :placeholder="labels.ttlPlaceholder || 'Positive integer'" />
            </div>
            <div v-else-if="editExpiryMode === 'lease'" class="grid gap-2 md:grid-cols-[160px_1fr] md:items-center">
              <Label for="kv-edit-lease">{{ labels.leaseId || "Lease ID" }}</Label>
              <div class="grid gap-2">
                <Select v-if="leaseOptions.length" :model-value="editLeaseId" @update:model-value="(value) => (editLeaseId = String(value))">
                  <SelectTrigger class="h-10 font-mono"><SelectValue :placeholder="labels.selectExistingLease || 'Select an existing Lease'" /></SelectTrigger>
                  <SelectContent
                    ><SelectItem v-for="lease in leaseOptions" :key="lease.id" :value="String(lease.id)">{{ lease.id }} · TTL {{ lease.ttl }}s</SelectItem></SelectContent
                  >
                </Select>
                <Input id="kv-edit-lease" v-model="editLeaseId" class="h-10 font-mono" inputmode="numeric" :placeholder="leaseOptions.length ? labels.enterLeaseId || 'Or enter a Lease ID manually' : labels.leasePlaceholder || 'Existing Lease ID'" />
                <span class="text-xs text-muted-foreground">{{ leaseOptions.length ? labels.leasePickerHint || "Choose a Lease from this session or enter a Lease ID manually." : labels.noLeasePickerHint || "No Lease is available in this session. Enter an ID manually and save." }}</span>
              </div>
            </div>
            <div v-if="showTtlUnavailable" class="text-xs text-amber-700 dark:text-amber-300">
              {{ labels.ttlUnavailable }}
            </div>
          </section>

          <section class="space-y-3">
            <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div class="min-w-0">
                <Label>{{ labels.valueContent || "Value" }}</Label>
                <div class="mt-1 text-xs text-muted-foreground">{{ editValueSize.toLocaleString() }} B</div>
              </div>
              <div class="flex shrink-0 items-center gap-3">
                <Label class="whitespace-nowrap text-sm">{{ labels.format || "Format" }}</Label>
                <Select :model-value="editFormat" @update:model-value="onEditFormatChange">
                  <SelectTrigger class="h-9 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent class="max-h-72">
                    <SelectItem v-for="option in valueFormatOptions" :key="option.value" :value="option.value">
                      {{ option.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div class="h-[min(38vh,360px)] min-h-64">
              <KvValueEditor v-model="editValue" class="h-full" :format="editFormat" />
            </div>
            <div v-if="editFormat === 'json' && editValueCanPrettyJson" class="flex justify-end">
              <Button size="sm" variant="outline" class="h-8" @click="prettifyEditJson">
                {{ labels.prettyJson || "Pretty" }}
              </Button>
            </div>
          </section>
          <div v-if="editError && editErrorKind !== 'keyAlreadyExists'" class="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ editError }}</div>
        </div>
        <DialogFooter class="mx-0 mb-0 shrink-0 gap-3 border-t bg-muted/10 px-6 py-5">
          <Button variant="outline" class="h-10 min-w-20" @click="showEditDialog = false">{{ t("common.cancel") }}</Button>
          <Button class="h-10 min-w-20" :disabled="saving || readOnly" @click="saveKey">
            <Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />
            {{ t("common.save") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <NacosConfigDiffDialog v-model:open="showSaveDiff" :title="labels.savePreview || 'Review value changes'" :before="saveDiffBefore" :after="saveDiffAfter" :loading="saving" :confirm-label="t('common.save')" @confirm="confirmSaveKey" />

    <Dialog v-model:open="showRenameDialog">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ labels.rename || "Rename key" }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-2 py-2">
          <Input v-model="renameValue" :placeholder="labels.keyPlaceholder" @keyup.enter="renameSelectedKey" />
          <div v-if="renameError" class="text-sm text-destructive">{{ renameError }}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="renaming" @click="showRenameDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="renaming || readOnly" @click="renameSelectedKey">
            <Loader2 v-if="renaming" class="mr-2 h-4 w-4 animate-spin" />
            {{ labels.rename || "Rename" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showHistoryDialog">
      <DialogContent class="flex h-[min(82vh,760px)] max-w-[min(94vw,1050px)] flex-col gap-0 overflow-hidden p-0">
        <DialogHeader class="shrink-0 border-b px-5 py-4">
          <DialogTitle>{{ labels.history || "History" }} · {{ selectedKey }}</DialogTitle>
        </DialogHeader>
        <div v-if="historyError" class="border-b px-5 py-2 text-sm text-destructive">{{ historyError }}</div>
        <div class="min-h-0 flex-1 overflow-auto">
          <div v-if="historyLoading" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {{ labels.loadingValue }}
          </div>
          <table v-else class="w-full text-left text-sm">
            <thead class="sticky top-0 bg-muted/90 text-xs text-muted-foreground">
              <tr>
                <th class="px-4 py-2 font-medium">Revision</th>
                <th class="px-4 py-2 font-medium">Operation</th>
                <th class="px-4 py-2 font-medium">Size</th>
                <th class="px-4 py-2 text-right font-medium">{{ labels.compare || "Compare" }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="event in historyEvents" :key="`${event.revision}:${event.eventType}`" class="border-b">
                <td class="px-4 py-2 font-mono text-xs">{{ event.revision }}</td>
                <td class="px-4 py-2">
                  <Badge :variant="event.eventType === 'delete' ? 'destructive' : 'outline'">{{ event.eventType }}</Badge>
                </td>
                <td class="px-4 py-2 text-xs text-muted-foreground">{{ event.metadata?.valueSize ?? 0 }} B</td>
                <td class="px-4 py-2 text-right">
                  <Button size="sm" variant="ghost" class="h-7" @click="compareHistory(event)">{{ labels.compare || "Compare" }}</Button>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!historyLoading && !historyError && historyEvents.length === 0" class="flex h-52 items-center justify-center text-sm text-muted-foreground">
            {{ labels.empty }}
          </div>
        </div>
        <DialogFooter class="mx-0 mb-0 shrink-0 border-t px-6 py-5">
          <Button variant="outline" class="h-10 min-w-20" @click="showHistoryDialog = false">{{ t("common.cancel") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <NacosConfigDiffDialog
      v-model:open="showHistoryDiff"
      :title="`${labels.compare || 'Compare'} · rev ${selectedHistoryEvent?.revision || ''}`"
      :before="selectedTextValue"
      :after="historyRestoreValue?.data || ''"
      :loading="restoring"
      :show-confirm="!readOnly && !!historyRestoreValue"
      :confirm-label="labels.restore || 'Restore'"
      @confirm="restoreHistory"
    />

    <DangerConfirmDialog v-model:open="showDeleteConfirm" :title="labels.deleteTitle" :details="selectedKey || ''" :confirm-label="labels.delete" @confirm="deleteSelectedKey" />
  </div>
</template>

<style scoped>
.kv-browser-splitpanes :deep(.splitpanes--vertical > .splitpanes__splitter) {
  width: 5px !important;
  border-left: 1px solid var(--border);
  background: transparent;
  cursor: col-resize;
}

.kv-browser-splitpanes :deep(.splitpanes__splitter:hover) {
  background: oklch(0.6 0.15 250) !important;
}
</style>

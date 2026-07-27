<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { ChevronDown, ChevronRight, FolderClosed, FolderOpen, KeyRound, Loader2, Plus, RefreshCw, Search, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import type { KvCreateMode, KvGetResponse, KvKeySummary, KvListPrefixOptions, KvPutOptions, KvPutResponse, KvValue } from "@/lib/backend/api";
import { buildKvKeyTree, flattenVisibleKvKeyTree, preserveKvExpandedGroupIds, type KvKeyTreeNode } from "@/lib/kv/kvKeyTree";
import { refreshedKvSelectionKey } from "@/lib/kv/kvRefreshSelection";
import { decideKvMetadataRefresh, knownKvLeaseKeys, KvListRequestGuard, mergeKvKeyMetadata, mergeKvValueRefresh, nextKvLeaseRefreshDelay, removeMissingKvKey, updateKvResponseTtl } from "@/lib/kv/kvMetadataRefresh";
import { parseOptionalTtl } from "@/lib/kv/kvTtl";
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
  createMode?: string;
  ttl?: string;
  ttlPlaceholder?: string;
  ttlInvalid?: string;
  ttlUnavailable?: string;
  add?: string;
  value?: string;
  metadata?: string;
  prettyJson?: string;
  invalidJson?: string;
  summaryRevision?: string;
  summaryVersion?: string;
  summaryLease?: string;
  summarySize?: string;
}

interface KvCreateModeOption {
  value: KvCreateMode;
  label: string;
}

interface KvKeyBrowserApi {
  listPrefix: (connectionId: string, prefix: string, limit: number, continuation?: string | null, options?: KvListPrefixOptions | null) => Promise<{ keys: KvKeySummary[]; continuation?: string | null }>;
  get: (connectionId: string, key: string) => Promise<KvGetResponse>;
  getMetadata?: (connectionId: string, key: string) => Promise<KvGetResponse>;
  put: (connectionId: string, key: string, value: KvValue, options?: KvPutOptions | null) => Promise<KvPutResponse>;
  deleteKey: (connectionId: string, key: string) => Promise<{ deleted: number }>;
}

type BrowserTreeNode = KvKeyTreeNode | LazyKvKeyTreeNode;
type BrowserTreeRow = { type: "node"; node: BrowserTreeNode; depth: number } | LazyKvKeyTreeRow;

const props = withDefaults(
  defineProps<{
    connectionId: string;
    labels: KvKeyBrowserLabels;
    api: KvKeyBrowserApi;
    supportsCreateModes?: boolean;
    supportsTtl?: boolean;
    ttlCapabilityKnown?: boolean;
    createModeOptions?: KvCreateModeOption[];
    enableNodeActions?: boolean;
    metadataStyle?: "default" | "zookeeper";
    lazyHierarchy?: boolean;
  }>(),
  {
    supportsCreateModes: false,
    supportsTtl: false,
    ttlCapabilityKnown: true,
    createModeOptions: () => [],
    enableNodeActions: false,
    metadataStyle: "default",
    lazyHierarchy: false,
  },
);
const emit = defineEmits<{
  refreshRequested: [];
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const searchInputRef = ref<HTMLInputElement>();
const prefix = ref("");
const keys = ref<KvKeySummary[]>([]);
const continuation = ref<string | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const expandedGroupIds = ref<Set<string>>(new Set());
const selectedKey = ref<string | null>(null);
const selectedValue = ref<KvGetResponse | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const showEditDialog = ref(false);
const isCreating = ref(false);
const editKey = ref("");
const editValue = ref("");
const editTtl = ref<string | number>("");
const editError = ref("");
const saving = ref(false);
const showDeleteConfirm = ref(false);
const deleting = ref(false);
const selectedCreateMode = ref<KvCreateMode>("persistent");
const selectedPrettyValue = ref<string | null>(null);
const lazyTreeState = reactive(createLazyKvKeyTreeState());
const pageSize = 200;
const metadataRefreshIntervalMs = 1000;
const keyListRefreshBaseIntervalMs = 2000;
const keyListRefreshMaxIntervalMs = 30000;
let detailRequestId = 0;
let metadataRefreshTimer: ReturnType<typeof setInterval> | null = null;
let metadataRefreshGeneration = 0;
let metadataRefreshInFlight = false;
let keyListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let keyListRefreshGeneration = 0;
let keyListRefreshDelayMs = keyListRefreshBaseIntervalMs;
let loadedPrefix = "";
const keyListRequestGuard = new KvListRequestGuard();
type LoadKeysOptions = {
  preserveSelection?: boolean;
};

const tree = computed(() => buildKvKeyTree(keys.value));
const visibleRows = computed<BrowserTreeRow[]>(() => {
  if (props.lazyHierarchy) return flattenLazyKvKeyTree(lazyTreeState, expandedGroupIds.value);
  return flattenVisibleKvKeyTree(tree.value, expandedGroupIds.value).map((row) => ({ type: "node", node: row.node, depth: row.depth }));
});
const selectedMetadata = computed(() => selectedValue.value?.metadata ?? (props.lazyHierarchy && selectedKey.value ? lazyTreeState.nodeByKey.get(selectedKey.value) : keys.value.find((key) => key.key === selectedKey.value)));
const selectedTextValue = computed(() => {
  const value = selectedValue.value?.value;
  if (!value) return "";
  return value.encoding === "utf8" ? value.data : value.data;
});
const displayedSelectedTextValue = computed(() => selectedPrettyValue.value ?? selectedTextValue.value);
const selectedValueIsBase64 = computed(() => selectedValue.value?.value?.encoding === "base64");
const showCreateModeSelect = computed(() => props.supportsCreateModes && isCreating.value && props.createModeOptions.length > 0);
const showTtlInput = computed(() => props.supportsTtl && isCreating.value);
const showTtlUnavailable = computed(() => props.ttlCapabilityKnown && !props.supportsTtl && isCreating.value && !!props.labels.ttlUnavailable);
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

function preserveExpandedGroups(expandAll = false) {
  expandedGroupIds.value = preserveKvExpandedGroupIds(tree.value, expandedGroupIds.value, expandAll);
}

async function loadKeys(reset = true, options: LoadKeysOptions = {}) {
  if (props.lazyHierarchy) {
    await loadLazyRoot(reset, options);
    return;
  }

  const loadGeneration = keyListRequestGuard.beginForegroundRequest();
  stopKeyListRefresh();
  const connectionId = props.connectionId;
  const keyToRestore = options.preserveSelection ? selectedKey.value : null;
  const requestedPrefix = reset ? prefix.value.trim() : loadedPrefix;
  const continuationToUse = reset ? null : continuation.value;
  if (reset) {
    loading.value = true;
    continuation.value = null;
    keys.value = [];
    if (!options.preserveSelection) {
      clearSelectedKey();
    }
  } else {
    loadingMore.value = true;
  }
  try {
    const result = await props.api.listPrefix(connectionId, requestedPrefix, pageSize, continuationToUse);
    if (!keyListRequestGuard.isForegroundRequestCurrent(loadGeneration) || props.connectionId !== connectionId) return;

    const existing = new Set(keys.value.map((key) => key.key));
    const merged = reset ? result.keys : [...keys.value, ...result.keys.filter((key) => !existing.has(key.key))];
    keys.value = merged;
    continuation.value = result.continuation || null;
    if (reset) {
      loadedPrefix = requestedPrefix;
    }
    preserveExpandedGroups(!!requestedPrefix);
    if (reset && options.preserveSelection) {
      const restoredKey = refreshedKvSelectionKey(keyToRestore, merged);
      if (restoredKey) {
        await loadSelectedKey(restoredKey);
      } else {
        clearSelectedKey();
      }
    }
  } catch (error) {
    if (!keyListRequestGuard.isForegroundRequestCurrent(loadGeneration) || props.connectionId !== connectionId) return;
    throw error;
  } finally {
    if (keyListRequestGuard.isForegroundRequestCurrent(loadGeneration) && props.connectionId === connectionId) {
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

async function loadSelectedKey(key: string) {
  stopMetadataRefresh();
  const requestId = ++detailRequestId;
  selectedKey.value = key;
  selectedValue.value = null;
  selectedPrettyValue.value = null;
  detailLoading.value = true;
  detailError.value = "";
  try {
    const result = await props.api.get(props.connectionId, key);
    if (requestId !== detailRequestId || selectedKey.value !== key) return;
    if (!result.found) {
      removeExpiredSelectedKey(key);
      return;
    }
    selectedValue.value = result;
    startMetadataRefresh(key);
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
  selectedValue.value = null;
  selectedPrettyValue.value = null;
  detailLoading.value = false;
}

function startMetadataRefresh(key: string) {
  stopMetadataRefresh();
  const metadata = selectedValue.value?.metadata;
  if (!props.api.getMetadata || typeof metadata?.lease !== "number" || metadata.lease <= 0 || typeof metadata.ttl !== "number") return;

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

function activeMetadataRefreshKey(): string | null {
  return metadataRefreshTimer !== null ? selectedKey.value : null;
}

function scheduleKeyListRefresh(generation: number) {
  if (generation !== keyListRefreshGeneration || !props.supportsTtl || props.lazyHierarchy || !props.api.getMetadata || knownKvLeaseKeys(keys.value, activeMetadataRefreshKey()).length === 0) {
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
  const leaseKeys = knownKvLeaseKeys(keys.value, activeMetadataRefreshKey());
  let failed = false;
  for (const key of leaseKeys) {
    try {
      const result = await getMetadata(connectionId, key);
      if (generation !== keyListRefreshGeneration || props.connectionId !== connectionId) return;
      if (result.found && !result.metadata) {
        failed = true;
        continue;
      }
      if (!result.found && selectedKey.value === key) {
        removeExpiredSelectedKey(key);
        continue;
      }

      const previousLength = keys.value.length;
      keys.value = mergeKvKeyMetadata(keys.value, key, result);
      if (keys.value.length !== previousLength) {
        preserveExpandedGroups();
      }
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
  keys.value = removeMissingKvKey(keys.value, key);
  preserveExpandedGroups();
  clearSelectedKey();
}

async function refreshSelectedValueSilently(key: string, generation: number) {
  const result = await props.api.get(props.connectionId, key);
  if (generation !== metadataRefreshGeneration || selectedKey.value !== key) return;
  if (!result.found) {
    removeExpiredSelectedKey(key);
    return;
  }

  selectedValue.value = mergeKvValueRefresh(selectedValue.value, result);
  const metadata = selectedValue.value.metadata;
  if (typeof metadata?.lease !== "number" || metadata.lease <= 0 || typeof metadata.ttl !== "number") {
    stopMetadataRefresh();
  }
}

async function refreshSelectedMetadata(key: string, generation: number) {
  const getMetadata = props.api.getMetadata;
  if (!getMetadata || metadataRefreshInFlight || generation !== metadataRefreshGeneration || selectedKey.value !== key) return;

  metadataRefreshInFlight = true;
  try {
    const result = await getMetadata(props.connectionId, key);
    if (generation !== metadataRefreshGeneration || selectedKey.value !== key) return;

    const current = selectedValue.value;
    const decision = decideKvMetadataRefresh(current, result);
    if (decision.type === "notFound") {
      removeExpiredSelectedKey(key);
    } else if (decision.type === "stop") {
      stopMetadataRefresh();
    } else if (decision.type === "reload") {
      await refreshSelectedValueSilently(key, generation);
    } else {
      if (!current || !updateKvResponseTtl(current, decision.ttl)) {
        stopMetadataRefresh();
      }
    }
  } catch {
    // Keep the timer alive so transient failures do not freeze the countdown.
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
  if (node.kind === "leaf") return node.key;
  return `/${node.pathSegments.join("/")}`;
}

function onRowClick(node: BrowserTreeNode) {
  if (nodeIsExpandable(node)) {
    void toggleGroup(node);
    if (props.enableNodeActions) void loadSelectedKey(nodePath(node));
  } else {
    void loadSelectedKey(nodePath(node));
  }
}

function onRowDoubleClick(node: BrowserTreeNode) {
  if (!nodeIsExpandable(node)) {
    void loadSelectedKey(nodePath(node)).then(() => openEditDialog());
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
  isCreating.value = true;
  editKey.value = createKeyPrefix(parentPath);
  editValue.value = "";
  editTtl.value = "";
  editError.value = "";
  selectedCreateMode.value = props.createModeOptions[0]?.value || "persistent";
  showEditDialog.value = true;
}

function openEditDialog() {
  if (!selectedKey.value) return;
  isCreating.value = false;
  editKey.value = selectedKey.value;
  editValue.value = selectedTextValue.value;
  editError.value = selectedValueIsBase64.value ? props.labels.base64Readonly : "";
  showEditDialog.value = true;
}

function putOptions(): KvPutOptions | undefined {
  const options: KvPutOptions = {};
  if (props.supportsCreateModes) {
    if (isCreating.value) {
      options.writeMode = "create";
      options.createMode = selectedCreateMode.value;
    } else {
      options.writeMode = "update";
    }
  }
  if (props.supportsTtl && isCreating.value) {
    const parsed = parseOptionalTtl(editTtl.value);
    if (parsed.ok && parsed.ttl != null) options.ttl = parsed.ttl;
  }
  if (!isCreating.value && typeof selectedMetadata.value?.lease === "number" && selectedMetadata.value.lease > 0) {
    options.preserveLease = true;
  }
  return Object.keys(options).length > 0 ? options : undefined;
}

async function saveKey() {
  const rawKey = editKey.value.trim();
  if (!rawKey) {
    editError.value = props.labels.keyRequired;
    return;
  }
  if (props.lazyHierarchy && normalizeZooKeeperPath(rawKey) === "/") {
    editError.value = props.labels.rootReadonly || props.labels.keyRequired;
    return;
  }
  if (showTtlInput.value && !parseOptionalTtl(editTtl.value).ok) {
    editError.value = props.labels.ttlInvalid || "TTL must be a positive integer";
    return;
  }
  const key = props.lazyHierarchy ? normalizeZooKeeperPath(rawKey) : rawKey;
  saving.value = true;
  editError.value = "";
  try {
    const value: KvValue = { encoding: "utf8", data: editValue.value };
    const response = await props.api.put(props.connectionId, key, value, putOptions());
    const keyToSelect = response.createdKey || response.key || key;
    showEditDialog.value = false;
    if (props.lazyHierarchy) {
      await refreshLazyParent(parentZooKeeperPath(keyToSelect));
    } else {
      await loadKeys(true);
    }
    await loadSelectedKey(keyToSelect);
    toast(props.labels.saved, 2500);
  } catch (error) {
    editError.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

async function deleteSelectedKey() {
  if (!selectedKey.value) return;
  const parentPath = parentZooKeeperPath(selectedKey.value);
  deleting.value = true;
  try {
    await props.api.deleteKey(props.connectionId, selectedKey.value);
    showDeleteConfirm.value = false;
    clearSelectedKey();
    if (props.lazyHierarchy) {
      await refreshLazyParent(parentPath);
    } else {
      await loadKeys(true);
    }
    toast(props.labels.deleted, 2500);
  } finally {
    deleting.value = false;
  }
}

function selectNodeForAction(node: BrowserTreeNode) {
  const key = nodePath(node);
  if (selectedKey.value !== key) void loadSelectedKey(key);
  else selectedKey.value = key;
}

function openDeleteForNode(node: BrowserTreeNode) {
  selectNodeForAction(node);
  showDeleteConfirm.value = true;
}

function nodeContextMenuItems(node: BrowserTreeNode): ContextMenuItem[] {
  if (!props.enableNodeActions) return [];
  return [
    {
      label: props.labels.add || props.labels.newKey,
      icon: Plus,
      action: () => openCreateDialog(nodePath(node)),
    },
    {
      label: props.labels.delete,
      icon: Trash2,
      variant: "destructive",
      action: () => openDeleteForNode(node),
    },
  ];
}

function onRowContextMenu(event: MouseEvent, node: BrowserTreeNode, openContextMenu: (event: MouseEvent) => void) {
  if (!props.enableNodeActions) return;
  selectNodeForAction(node);
  openContextMenu(event);
}

function rowIsSelected(node: BrowserTreeNode): boolean {
  return nodePath(node) === selectedKey.value;
}

function nodeIsExpandable(node: BrowserTreeNode): boolean {
  return node.kind === "group" || (node.kind === "lazy" && node.hasChildren);
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
  } else {
    editError.value = props.labels.invalidJson || "Invalid JSON";
  }
}

function metadataLabel(value: number | null | undefined): string {
  return value == null ? "-" : String(value);
}

function focusSearch(): boolean {
  searchInputRef.value?.focus();
  return true;
}

async function refreshKeys() {
  emit("refreshRequested");
  await loadKeys(true, { preserveSelection: true });
}

function refresh(): boolean {
  void refreshKeys().catch((error) => {
    console.warn("[DBX] KV key refresh failed", error);
  });
  return true;
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
    await loadKeys(true);
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

onMounted(async () => {
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  await loadKeys(true);
});

onBeforeUnmount(() => {
  clearSelectedKey();
  stopKeyListRefresh();
});
defineExpose({ focusSearch, refresh });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <div class="relative min-w-0 flex-1">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input ref="searchInputRef" v-model="prefix" class="h-8 pl-8" :placeholder="labels.prefixPlaceholder" @keyup.enter="loadKeys(true)" />
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="refreshKeys">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
      <Button size="sm" class="h-8 gap-1.5" @click="openCreateDialog()">
        <Plus class="h-3.5 w-3.5" />
        {{ labels.newKey }}
      </Button>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-[minmax(260px,38%)_1fr]">
      <div class="min-h-0 border-r">
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
                class="flex h-8 w-full items-center gap-1.5 px-2 text-left hover:bg-accent"
                :class="{ 'bg-accent/70': rowIsSelected(row.node) }"
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

      <div class="min-h-0 overflow-auto">
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
              <Button size="sm" variant="outline" class="h-8" :disabled="selectedValueIsBase64" @click="openEditDialog">
                {{ labels.edit }}
              </Button>
              <Button size="sm" variant="destructive" class="h-8 gap-1.5" @click="showDeleteConfirm = true">
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
    </div>

    <Dialog v-model:open="showEditDialog">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ isCreating ? labels.newKey : labels.editKey }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 py-2">
          <Input v-model="editKey" :placeholder="labels.keyPlaceholder" />
          <div v-if="showCreateModeSelect" class="grid grid-cols-4 items-center gap-3">
            <Label class="text-right text-xs">{{ labels.createMode || "Create Mode" }}</Label>
            <Select v-model="selectedCreateMode">
              <SelectTrigger class="col-span-3 h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in createModeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div v-if="showTtlInput" class="grid grid-cols-4 items-center gap-3">
            <Label class="text-right text-xs">{{ labels.ttl || "TTL (seconds)" }}</Label>
            <Input v-model="editTtl" class="col-span-3" type="number" min="1" step="1" :placeholder="labels.ttlPlaceholder || 'Optional; leave blank for no expiry'" />
          </div>
          <div v-else-if="showTtlUnavailable" class="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
            {{ labels.ttlUnavailable }}
          </div>
          <textarea v-model="editValue" class="min-h-52 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" spellcheck="false" />
          <div v-if="editValueCanPrettyJson" class="flex justify-end">
            <Button size="sm" variant="outline" class="h-8" @click="prettifyEditJson">
              {{ labels.prettyJson || "Pretty" }}
            </Button>
          </div>
          <div v-if="editError" class="text-sm text-destructive">{{ editError }}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showEditDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="saving || (!!editError && selectedValueIsBase64)" @click="saveKey">
            <Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />
            {{ t("common.save") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <DangerConfirmDialog v-model:open="showDeleteConfirm" :title="labels.deleteTitle" :details="selectedKey || ''" :confirm-label="labels.delete" @confirm="deleteSelectedKey" />
  </div>
</template>

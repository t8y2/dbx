<script setup lang="ts">
import { computed, markRaw, nextTick, ref, shallowRef, onMounted, onUnmounted, onActivated, onDeactivated, watch } from "vue";
import type { CalendarDateTime } from "@internationalized/date";
import { useI18n } from "vue-i18n";
import { Search, RefreshCw, Loader2, ChevronRight, ChevronDown, FolderClosed, FolderOpen, Trash2, Plus, KeyRound, TerminalSquare, Asterisk, History, Radio, Clock, Copy } from "@lucide/vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { OptionHelpPanel } from "@/components/ui/option-help-panel";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import DateTimePicker from "@/components/ui/date-time-picker/DateTimePicker.vue";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import RedisValueViewer from "./RedisValueViewer.vue";
import RedisPubSubPanel from "./RedisPubSubPanel.vue";
import RedisSlowlogPanel from "./RedisSlowlogPanel.vue";
import * as api from "@/lib/backend/api";
import type { RedisKeyInfo, RedisScanResult, RedisValue, HistoryEntry } from "@/lib/backend/api";
import { uuid } from "@/lib/common/utils";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { continuousQueryResultMaxRows } from "@/lib/dataGrid/queryResultRowLimit";
import {
  appendRedisKeysToTreeIndex,
  buildRedisKeyTree,
  buildRedisKeySnapshotCooperatively,
  canBuildRedisFuzzyTree,
  collectExpandedGroupIds,
  collectRedisGroupKeyRaws,
  createRedisKeyTreeIndex,
  flattenVisibleRedisKeyTree,
  redisKeyNameCopyText,
  redisKeyToFlatTreeRow,
  updateRedisKeyInfoMetadataByRaw,
  updateRedisKeyTreeLeafMetadata,
  type RedisKeyTreeGroupNode,
  type RedisKeyTreeIndex,
  type RedisKeyTreeNode,
  type RedisKeyTreeRow,
} from "@/lib/redis/redisKeyTree";
import { classifyRedisCommandSafety } from "@/lib/redis/redisCommandSafety";
import { isRedisMutatingCommand } from "@/lib/redis/redisCommandTable";
import { isRedisClearScreenCommand, nextRedisCommandDb, redisKeyTextToRaw } from "@/lib/redis/redisCommandSession";
import { buildRedisCompletionItemsFromContext, getRedisCompletionContext, takesKeyArgument, type RedisCompletionItem } from "@/lib/redis/redisCompletion";
import type { RedisCommandDocumentation } from "@/lib/redis/redisCommandDocs";
import { formatRedisConsoleValue, redisValuePreview, redisValueSize } from "@/lib/redis/redisValuePresentation";
import { isCancelSearchShortcut } from "@/lib/editor/keyboardShortcuts";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useEditorFontFamilyStyle } from "@/composables/useEditorFontFamilyStyle";
import { useToast } from "@/composables/useToast";
import { redisFuzzySearchScanBudget, redisKeySearchPattern, redisGroupSubtreePattern } from "@/lib/redis/redisKeyPattern";
import { filterRedisKeyTemplates, resolveRedisKeyTemplates } from "@/lib/redis/redisKeyTemplates";
import { REDIS_SCAN_PAGE_SIZE_DEFAULT } from "@/lib/redis/redisKeyPattern";
import { chunkRedisKeyRaws, collectUniqueRedisKeys } from "@/lib/redis/redisKeyBatch";
import { getRedisCreateKeyTypeHelp, redisCreateKeyTypeHelpOptionOnOpen, shouldActivateRedisCreateKeyTypeHelpOnFocus } from "@/lib/redis/redisCreateKeyTypeHelp";
import { optionHelpPanelOffsetTop } from "@/lib/common/optionHelpPanelOffset";
import { applyRedisExpiryPolicy, type RedisExpiryMode, validateRedisExpiry } from "@/lib/redis/redisExpiry";
import { shouldLoadMoreRedisKeys } from "@/lib/redis/redisKeyInfiniteScroll";
import { formatTtl } from "@/lib/common/ttlFormat";
import { computeTtlCountdownValue } from "@/lib/redis/redisAutoRefresh";

const { t, locale } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const editorFontFamilyStyle = useEditorFontFamilyStyle();

type RedisSearchMode = "key" | "value" | "all";
type RedisCreateKeyType = "string" | "hash" | "list" | "set" | "zset" | "stream" | "json";

interface CreateKeyEntry {
  id: number;
  value: string;
  field?: string;
  score?: string;
}
type RedisSidePanel = "detail" | "command" | "pubsub" | "slowlog";
type RedisCommandHistoryEntry = {
  id: number;
  prompt: string;
  command: string;
  output: string;
  error: boolean;
};

const props = defineProps<{
  connectionId: string;
  db: number;
  blockDangerousRedisCommands: boolean;
}>();

const redisExpiryTransport = {
  setTtl: api.redisSetTtl,
  setExpireAt: api.redisSetExpireAt,
};

const flatKeys = shallowRef<RedisKeyInfo[]>([]);
const treeKeys = shallowRef<RedisKeyTreeNode[]>([]);
let flatKeyByRaw = new Map<string, RedisKeyInfo>();
const loading = ref(false);
const loadingMore = ref(false);
const searchPending = ref(false);
const isFetchingAll = ref(false);
const fetchAllStopRequested = ref(false);
const fetchAllLoadedCount = ref(0);
const rootRef = ref<HTMLElement>();
const keyPaneRef = ref<HTMLElement>();
const redisKeyScrollerRef = ref<InstanceType<typeof RecycleScroller> | null>(null);
let redisKeyScrollRevision = 0;
let latestRedisKeyScrollAnchor: RedisKeyViewportAnchor | null = null;
const valueViewerRef = ref<{ focusSearch: () => boolean } | null>(null);
const commandTerminalRef = ref<HTMLElement>();
const searchPattern = ref("");
const searchMode = ref<RedisSearchMode>("key");
const fuzzyKeySearch = ref(false);
const keyTemplateMenuOpen = ref(false);
const keyTemplateSelectedIndex = ref(0);
const keyTemplateListboxId = `redis-key-template-suggestions-${uuid()}`;
let keyTemplateBlurTimer: ReturnType<typeof setTimeout> | null = null;
const selectedKeyRaw = ref<string | null>(null);
const hasMore = ref(false);
const scanCursor = ref(0);
const expandedGroupIds = ref<Set<string>>(new Set());
const checkedKeys = ref<Set<string>>(new Set());
/** Bumped when selection or tree counts change so virtualized rows re-evaluate state. */
const selectionEpoch = ref(0);
/** Bumped when mutable metadata changes; it must never invalidate visibleRows. */
const keyMetadataEpoch = ref(0);
/** Bumped only when a TTL refresh changes membership in the no-expiry projection. */
const noExpiryProjectionEpoch = ref(0);
const selectionAnchorRowId = ref<string | null>(null);
const selectedGroupLeafCounts = shallowRef<Map<string, number>>(new Map());
const deletingKeys = ref(false);
const pendingDanger = ref<{ kind: "delete-keys"; title: string; keyRaws: string[]; loadedSearchResults: boolean } | { kind: "command"; command: string } | null>(null);
const showDangerConfirm = ref(false);
const commandText = ref("");
const commandRunning = ref(false);
const commandDb = ref(props.db);
const commandHistory = ref<RedisCommandHistoryEntry[]>([]);
const commandHistoryIndex = ref(-1);
const commandCompletionItems = ref<RedisCompletionItem[]>([]);
const commandCompletionSelectedIndex = ref(0);
const commandCompletionLoading = ref(false);
const commandCompletionListboxId = `redis-command-completions-${uuid()}`;
const commandCompletionSelectedItem = computed(() => commandCompletionItems.value[commandCompletionSelectedIndex.value]);
const commandCompletionActiveDescendant = computed(() => (commandCompletionSelectedItem.value ? `${commandCompletionListboxId}-option-${commandCompletionSelectedIndex.value}` : undefined));
const commandDocumentationLoading = ref(false);
const commandCompletionOpen = computed(() => commandDocumentationLoading.value || commandCompletionLoading.value || commandCompletionItems.value.length > 0);
const commandDocumentation = shallowRef<RedisCommandDocumentation[]>([]);
const activeSidePanel = ref<RedisSidePanel>("detail");
const showCreateKeyDialog = ref(false);
const creatingKey = ref(false);
const createKeyName = ref("");
const createKeyType = ref<RedisCreateKeyType>("string");
const createKeyValue = ref("");
const createKeyField = ref("");
const createKeyScore = ref("0");
const createKeyError = ref("");
const createKeyExpiryMode = ref<RedisExpiryMode>("none");
const createKeyTtl = ref("");
const createKeyExpireAt = shallowRef<CalendarDateTime | null>(null);
const createKeyEntries = ref<CreateKeyEntry[]>([]);
const createKeyRawMode = ref(false);
const createKeyEntryId = ref("*");
const createKeyPartiallyWritten = ref(false);
const jsonModuleAvailable = ref<boolean | null>(null);
const checkingJsonModule = ref(false);
const activeCreateKeyTypeHelp = ref<RedisCreateKeyType>();
const createKeyTypeKeyboardNavigation = ref(false);
const createKeyTypeOpenedByArrow = ref(false);
const createKeyTypeListCard = ref<HTMLElement>();
const createKeyTypeHelpPanel = ref<{ element?: HTMLElement }>();
const createKeyTypeHelpOffsetTop = ref(0);
let nextEntryId = 0;
let searchRequestId = 0;
let loadMoreOperationId = 0;
// Mutable so `fetchScanPage` can decrement it in place as it consumes real
// backend calls, without changing its return type.
interface ScanIterationBudget {
  remaining: number;
}
// Automatic continuation (see `maybeAutoLoadMoreRedisKeys`) has no natural stop
// condition when a search is sparse: unique visible keys barely grow, so the
// scroller keeps reporting a short viewport forever. A *page count* budget is
// not enough on its own: each page's `fetchScanPage` already retries within
// its own cumulative COUNT budget while a page comes back empty, so a single
// automatic "page" can still cost dozens of backend calls and SCAN
// iterations. Give the whole automatic-fill operation ONE shared budget of
// actual SCAN iterations (the same unit as the `max_iterations` sent to the
// backend), decremented by every backend call the automatic path makes —
// regardless of how many pages/keys those calls span — and stop deterministically
// the moment it's spent. Reset for genuine new load/search/scope operations;
// KeepAlive deactivation only invalidates ownership so it cannot replenish the
// same retained operation. An explicit "Load more" click or a real scroll
// event is a single user-triggered request and keeps its own uncapped
// per-call budget (see `fetchScanPage`); only the automatic follow-up check
// they hand off to afterward is constrained by this shared budget.
const AUTO_LOAD_TOTAL_SCAN_ITERATIONS = 50;
const REDIS_VALUE_SCAN_COUNT = 100;
let autoLoadBudget: ScanIterationBudget = { remaining: AUTO_LOAD_TOTAL_SCAN_ITERATIONS };
let redisBrowserIsActive = true;
let reloadKeysOnActivation = false;
let fetchAllPreparingSnapshot = false;
let redisDbFlushedListenerRegistered = false;
let redisInfiniteScrollFrame = 0;
let loadedKeyRaws = new Set<string>();
let treeIndex: RedisKeyTreeIndex | null = null;
let fetchAllPublicationRollback: null | {
  flatKeys: RedisKeyInfo[];
  flatKeyByRaw: Map<string, RedisKeyInfo>;
  loadedKeyRaws: Set<string>;
  treeKeys: RedisKeyTreeNode[];
  treeIndex: RedisKeyTreeIndex | null;
  expandedGroupIds: Set<string>;
  scanCursor: number;
  hasMore: boolean;
  lastTotalKeys: number;
  bufferedKeyRaws: Set<string>;
} = null;
// 展开分组时已定向补扫且已扫尽的子树（见 fillGroupSubtree）；在 loadKeys 重置。
const subtreeFilledGroupIds = new Set<string>();
// 尚未扫尽的分组：保存已应用的最新 SCAN 游标，包括下一个请求还在飞行中时。
// 这样预算停止、折叠或 KeepAlive 失效都能从已确认的位置续扫；“加载更多”/
// 滚动按展开顺序续扫（见 resumePendingGroupSubtrees）。loadKeys 会重置该状态。
const subtreePendingGroupCursors = new Map<string, number>();
// 正在补扫中的分组及其操作所有权：避免展开与续扫并发重复扫同一子树，并防止
// 旧 generation 的 catch/finally 清掉或覆盖同 id 的新补扫。
const subtreeFillOperations = new Map<string, number>();
let subtreeFillOperationId = 0;
// 刷新前已展开分组的快照（#7173）：刷新首屏重建树时，本轮尚未扫到的分组会被
// rebuildTree 从 expandedGroupIds 中裁掉；后续 load-more 页面让这些分组重新
// 出现时，用该快照恢复展开状态。SCAN 游标归零（本轮已扫尽，仍未出现的分组
// 确实不存在）或连接/db 切换（resetLoadedKeys）时清除，避免过期 id 累积。
const refreshExpandedGroupIds = new Set<string>();
const REDIS_COMMAND_COMPLETION_MENU_LIMIT = 12;
let commandCompletionRequestId = 0;
let commandDocumentationConnectionId: string | null = null;
let commandDocumentationRequestId = 0;

const valueQuery = computed(() => searchPattern.value.trim());
const isValueSearchMode = computed(() => searchMode.value === "value" || searchMode.value === "all");
const effectivePattern = computed(() => (searchMode.value === "key" ? redisKeySearchPattern(searchPattern.value, fuzzyKeySearch.value) : "*"));
const isSearchMode = computed(() => (searchMode.value === "key" ? effectivePattern.value !== "*" : valueQuery.value !== ""));
// Keep regular glob search on the low-cost flat path. The explicit fuzzy mode
// opts into the namespace hierarchy that users need for group selection.
const isFuzzyKeySearch = computed(() => searchMode.value === "key" && isSearchMode.value && fuzzyKeySearch.value);
const fuzzyTreeLimitReached = computed(() => isFuzzyKeySearch.value && !canBuildRedisFuzzyTree(flatKeys.value.length));
const useFlatKeySearchRows = computed(() => (searchMode.value === "key" && isSearchMode.value && !fuzzyKeySearch.value) || fuzzyTreeLimitReached.value);
const isFuzzyHierarchyView = computed(() => isFuzzyKeySearch.value && !fuzzyTreeLimitReached.value);
const selectionBusy = computed(() => deletingKeys.value || loading.value || loadingMore.value || isFetchingAll.value || searchPending.value);
// checkedKeys is always a subset of loaded keys, so size equality is enough.
const allLoadedKeysSelected = computed(() => flatKeys.value.length > 0 && checkedKeys.value.size === flatKeys.value.length);
const allKeysSelected = computed(() => allLoadedKeysSelected.value && !hasMore.value);
const searchPlaceholder = computed(() => {
  if (searchMode.value === "key") return fuzzyKeySearch.value ? t("redis.fuzzyPattern") : t("redis.pattern");
  return searchMode.value === "all" ? t("redis.allSearchPlaceholder") : t("redis.valueSearchPlaceholder");
});
const redisKeyTemplates = computed(() => resolveRedisKeyTemplates(connectionStore.getConfig(props.connectionId)?.redis_key_templates, settingsStore.editorSettings.redisKeyTemplates ?? []));
const keyTemplateSuggestions = computed(() => (searchMode.value === "key" ? filterRedisKeyTemplates(redisKeyTemplates.value, searchPattern.value) : []));
const keyTemplateMenuVisible = computed(() => keyTemplateMenuOpen.value && searchMode.value === "key" && keyTemplateSuggestions.value.length > 0);
const keyTemplateActiveDescendant = computed(() => (keyTemplateMenuVisible.value ? `${keyTemplateListboxId}-option-${keyTemplateSelectedIndex.value}` : undefined));
const loadingEmptyText = computed(() => (isValueSearchMode.value && valueQuery.value ? t(searchMode.value === "all" ? "redis.searchingAll" : "redis.searchingValues") : t("redis.loadingKeys")));
const redisKeySeparator = computed(() => connectionStore.getConfig(props.connectionId)?.redis_key_separator ?? ":");
const redisScanPageSize = computed(() => connectionStore.getConfig(props.connectionId)?.redis_scan_page_size ?? REDIS_SCAN_PAGE_SIZE_DEFAULT);
const redisInfiniteScrollEnabled = computed(() => settingsStore.editorSettings.infiniteScroll);
const redisInfiniteScrollMaxKeys = computed(() => continuousQueryResultMaxRows(settingsStore.editorSettings.queryResultMaxRowsEnabled, settingsStore.editorSettings.queryResultMaxRows));
watch(redisKeySeparator, () => {
  if (flatKeys.value.length === 0) return;
  invalidateScanRequests();
  if (useFlatKeySearchRows.value) {
    treeKeys.value = [];
    treeIndex = null;
    expandedGroupIds.value = new Set();
    return;
  }
  rebuildTree(false);
});
const lastTotalKeys = ref(0);
// “仅看无过期”过滤开关：开启后只保留 TTL 为 -1（永不过期）的已加载 key。
// TTL 为 -2 的行（fetch-all 链路未查询 TTL）不会出现在过滤结果里。
const noExpiryOnly = ref(false);
const fetchAllFilteredKeyCount = ref<number | null>(null);
// 过滤后的平铺 key 列表：未开启过滤时与 flatKeys 完全一致，避免额外开销
const filteredFlatKeys = computed(() => {
  if (!noExpiryOnly.value) return flatKeys.value;
  void noExpiryProjectionEpoch.value;
  return flatKeys.value.filter((key) => key.ttl === -1);
});
// 过滤后的树：独立重建而不复用 treeIndex，避免污染后续 SCAN 增量合并的全量树基准；
// 分组 id 只由 db+路径决定，与全量树一致，因此展开状态可直接复用
const filteredTreeKeys = computed(() => {
  if (!noExpiryOnly.value) return treeKeys.value;
  return buildRedisKeyTree(filteredFlatKeys.value, props.db, redisKeySeparator.value);
});
const displayedKeyCount = computed(() => {
  if (isFetchingAll.value) return fetchAllLoadedCount.value;
  // 过滤时展示匹配数量，便于确认“无过期”key 的规模
  if (noExpiryOnly.value) return fetchAllFilteredKeyCount.value ?? filteredFlatKeys.value.length;
  return flatKeys.value.length;
});
const fetchAllProgressText = computed(() => {
  if (!isFetchingAll.value) return "";
  if (lastTotalKeys.value > 0) {
    return t("redis.fetchAllProgress", { loaded: displayedKeyCount.value, total: lastTotalKeys.value });
  }
  return t("redis.fetchAllProgressUnknown", { loaded: displayedKeyCount.value });
});
const keyCountText = computed(() => {
  if (loading.value && flatKeys.value.length === 0) return loadingEmptyText.value;
  if (!isSearchMode.value && lastTotalKeys.value > 0) {
    return t("redis.loadedKeys", { loaded: displayedKeyCount.value, total: lastTotalKeys.value });
  }
  const count = isSearchMode.value && hasMore.value && !isFetchingAll.value ? `${displayedKeyCount.value}+` : displayedKeyCount.value;
  return t("redis.keys", { count });
});
const selectedKey = computed(() => {
  void keyMetadataEpoch.value;
  return selectedKeyRaw.value ? (flatKeyByRaw.get(selectedKeyRaw.value) ?? null) : null;
});
const dangerDetails = computed(() => {
  if (!pendingDanger.value) return "";
  if (pendingDanger.value.kind === "delete-keys") {
    return t(pendingDanger.value.loadedSearchResults ? "redis.deleteLoadedSearchKeysDetails" : "redis.deleteGroupDetails", {
      target: pendingDanger.value.title,
      count: pendingDanger.value.keyRaws.length,
    });
  }
  return pendingDanger.value.command;
});
const dangerConfirmLabel = computed(() => {
  if (pendingDanger.value?.kind === "command") return t("dangerDialog.confirm");
  return t("dangerDialog.deleteConfirm");
});
const dangerMessage = computed(() => {
  // Redis write commands such as SET/HSET are mutating but not necessarily delete operations.
  if (pendingDanger.value?.kind === "command") return t("dangerDialog.redisCommandMessage");
  return t("dangerDialog.deleteMessage");
});
const commandPrompt = computed(() => `db${commandDb.value}>`);
const createKeyTypeOptions = computed<{ value: RedisCreateKeyType; label: string }[]>(() => [
  { value: "string", label: "String" },
  { value: "hash", label: "Hash" },
  { value: "list", label: "List" },
  { value: "set", label: "Set" },
  { value: "zset", label: "Sorted Set" },
  { value: "stream", label: "Stream" },
  { value: "json", label: "JSON" },
]);
function createKeyTypeTooltip(type: RedisCreateKeyType): string | undefined {
  const help = getRedisCreateKeyTypeHelp(type);
  return help ? t(`redis.createKeyTypeHelp.${help.key}`) : undefined;
}
const activeCreateKeyTypeHelpContent = computed(() => (activeCreateKeyTypeHelp.value ? createKeyTypeTooltip(activeCreateKeyTypeHelp.value) : undefined));

function activateCreateKeyTypeHelp(type: RedisCreateKeyType) {
  activeCreateKeyTypeHelp.value = createKeyTypeTooltip(type) ? type : undefined;
}

function onCreateKeyTypeSelectOpen(open: boolean) {
  if (open) {
    activeCreateKeyTypeHelp.value = redisCreateKeyTypeHelpOptionOnOpen(createKeyType.value);
    return;
  }
  activeCreateKeyTypeHelp.value = undefined;
  createKeyTypeKeyboardNavigation.value = false;
  createKeyTypeOpenedByArrow.value = false;
}

function onCreateKeyTypeTriggerKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  createKeyTypeOpenedByArrow.value = true;
  createKeyTypeKeyboardNavigation.value = true;
}

function onCreateKeyTypeSelectKeydown(event: KeyboardEvent) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  createKeyTypeKeyboardNavigation.value = true;
}

function onCreateKeyTypeOptionFocus(type: RedisCreateKeyType) {
  if (!shouldActivateRedisCreateKeyTypeHelpOnFocus({ openedByArrow: createKeyTypeOpenedByArrow.value, keyboardNavigating: createKeyTypeKeyboardNavigation.value })) return;
  activateCreateKeyTypeHelp(type);
  createKeyTypeOpenedByArrow.value = false;
  createKeyTypeKeyboardNavigation.value = false;
}

async function updateCreateKeyTypeHelpOffset() {
  if (!activeCreateKeyTypeHelp.value) {
    createKeyTypeHelpOffsetTop.value = 0;
    return;
  }
  await nextTick();
  const card = createKeyTypeListCard.value;
  const panel = createKeyTypeHelpPanel.value?.element;
  const option = card?.querySelector<HTMLElement>(`[data-option-help-value="${activeCreateKeyTypeHelp.value}"]`);
  if (!card || !panel || !option) {
    createKeyTypeHelpOffsetTop.value = 0;
    return;
  }
  createKeyTypeHelpOffsetTop.value = optionHelpPanelOffsetTop({
    activeItemTop: option.getBoundingClientRect().top - card.getBoundingClientRect().top,
    listCardHeight: card.clientHeight,
    panelHeight: panel.clientHeight,
  });
}

watch(activeCreateKeyTypeHelp, () => {
  void updateCreateKeyTypeHelpOffset();
});
const regularVisibleRows = computed(() => {
  return useFlatKeySearchRows.value ? filteredFlatKeys.value.map((key) => redisKeyToFlatTreeRow(key, props.db)) : flattenVisibleRedisKeyTree(filteredTreeKeys.value, expandedGroupIds.value);
});
let fetchAllVisibleRowsSource: readonly RedisKeyTreeRow[] = [];

function facadeArrayIndex(property: PropertyKey): number {
  if (typeof property !== "string" || property === "") return -1;
  const index = Number(property);
  return Number.isInteger(index) && index >= 0 && String(index) === property ? index : -1;
}

// Keep one raw Array-shaped identity bound throughout Fetch All. Array methods
// such as slice use both indexed reads and `has`, so proxy both operations;
// switching the complete backing snapshot is then O(1) and cannot expose holes.
const fetchAllVisibleRowsFacade = markRaw(
  new Proxy([] as RedisKeyTreeRow[], {
    get(target, property, receiver) {
      if (property === "length") return fetchAllVisibleRowsSource.length;
      const index = facadeArrayIndex(property);
      return index >= 0 ? fetchAllVisibleRowsSource[index] : Reflect.get(target, property, receiver);
    },
    has(target, property) {
      const index = facadeArrayIndex(property);
      return index >= 0 ? index < fetchAllVisibleRowsSource.length : Reflect.has(target, property);
    },
  }),
);
const fetchAllVisibleRows = shallowRef<RedisKeyTreeRow[]>(fetchAllVisibleRowsFacade);
const fetchAllVisibleRowsActive = ref(false);
const visibleRows = computed(() => (fetchAllVisibleRowsActive.value ? fetchAllVisibleRows.value : regularVisibleRows.value));
const redisKeyScrollerRows = fetchAllVisibleRowsFacade;

watch(
  regularVisibleRows,
  (rows) => {
    if (fetchAllVisibleRowsActive.value) return;
    fetchAllVisibleRowsSource = rows;
    void nextTick(() => {
      if (!fetchAllVisibleRowsActive.value && fetchAllVisibleRowsSource === rows) refreshRedisKeyScroller();
    });
  },
  { immediate: true },
);

function activateFetchAllVisibleRows() {
  if (fetchAllVisibleRowsActive.value) return;
  fetchAllVisibleRowsSource = regularVisibleRows.value;
  fetchAllVisibleRowsActive.value = true;
}

function deactivateFetchAllVisibleRows() {
  if (!fetchAllVisibleRowsActive.value) return;
  fetchAllVisibleRowsActive.value = false;
  fetchAllVisibleRowsSource = regularVisibleRows.value;
  fetchAllFilteredKeyCount.value = null;
  refreshRedisKeyScroller();
}

function rollbackFetchAllPublication() {
  const rollback = fetchAllPublicationRollback;
  if (!rollback) return;
  flatKeys.value = rollback.flatKeys;
  flatKeyByRaw = rollback.flatKeyByRaw;
  loadedKeyRaws = rollback.loadedKeyRaws;
  treeKeys.value = rollback.treeKeys;
  treeIndex = rollback.treeIndex;
  expandedGroupIds.value = rollback.expandedGroupIds;
  scanCursor.value = rollback.scanCursor;
  hasMore.value = rollback.hasMore;
  lastTotalKeys.value = rollback.lastTotalKeys;
  for (const keyRaw of rollback.bufferedKeyRaws) {
    ttlObservedAtByRaw.delete(keyRaw);
    positiveTtlKeyRaws.delete(keyRaw);
  }
  fetchAllPublicationRollback = null;
  if (selectedKeyRaw.value && !flatKeyByRaw.has(selectedKeyRaw.value)) selectedKeyRaw.value = null;
  refreshSelectedGroupLeafCounts();
}

function redisRowKeyInfo(node: RedisKeyTreeNode): RedisKeyInfo | null {
  void keyMetadataEpoch.value;
  return node.kind === "leaf" ? (flatKeyByRaw.get(node.keyRaw) ?? null) : null;
}

function redisRowKeyType(node: RedisKeyTreeNode): string {
  return redisRowKeyInfo(node)?.key_type ?? "";
}

function redisRowTtl(node: RedisKeyTreeNode): number {
  return redisRowKeyInfo(node)?.ttl ?? -2;
}
// 列表行的 TTL 徽标文案：-1 表示永不过期，展示本地化文案；
// 大于 0 时展示本地倒计时后的剩余时间，倒计时归零展示已过期；其余（-2 未查询）不显示
function redisTtlBadgeText(ttl: number, displayTtl: number): string | null {
  if (ttl === -1) return t("redis.noExpiry");
  if (ttl > 0 && displayTtl <= 0) return t("redis.expired");
  return formatTtl(displayTtl, t);
}
// 列表行的 TTL 徽标配色：永不过期用琥珀色，已过期或 1 小时内即将过期用红色警示，其余用中性色
function redisTtlBadgeClass(ttl: number, displayTtl: number): string {
  if (ttl === -1) return "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300";
  if (displayTtl <= 3600) return "border-red-300 bg-red-50 text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-300";
  return "border-border bg-muted/60 text-muted-foreground";
}
// 记录每个 key 的 TTL 被观测到的时刻（毫秒）；本地倒计时 = 观测时的 TTL - 已流逝时间，
// 与右侧详情面板同源（computeTtlCountdownValue），不需要额外的网络请求
const ttlObservedAtByRaw = new Map<string, number>();
const positiveTtlKeyRaws = new Set<string>();
// 驱动列表行 TTL 倒计时的当前时刻，仅在存在需要倒计时的 key 时每秒更新
const listTtlNowMs = ref(Date.now());
let listTtlTimer: ReturnType<typeof setInterval> | null = null;

// 批次加载/详情回写等入口统一记录 key 的 TTL 观测时刻；非正 TTL 无需倒计时，移除旧记录
function recordKeyTtlObservedAt(key: RedisKeyInfo) {
  const ttl = key.ttl ?? -2;
  if (ttl > 0) {
    ttlObservedAtByRaw.set(key.key_raw, Date.now());
    positiveTtlKeyRaws.add(key.key_raw);
  } else {
    ttlObservedAtByRaw.delete(key.key_raw);
    positiveTtlKeyRaws.delete(key.key_raw);
  }
}

function appendFlatKeyRecords(keys: readonly RedisKeyInfo[]) {
  if (keys.length === 0) return;
  for (const key of keys) flatKeyByRaw.set(key.key_raw, key);
  flatKeys.value = [...flatKeys.value, ...keys];
}

function replaceFlatKeyRecords(keys: RedisKeyInfo[]) {
  flatKeyByRaw.clear();
  for (const key of keys) flatKeyByRaw.set(key.key_raw, key);
  flatKeys.value = keys;
}

// 列表行展示的 TTL：正 TTL 按观测时刻到当前时刻的流逝本地递减；-1/-2 原样透传
function redisRowDisplayTtl(ttl: number, keyRaw: string): number {
  if (ttl <= 0) return ttl;
  const observedAt = ttlObservedAtByRaw.get(keyRaw) ?? Date.now();
  return computeTtlCountdownValue(ttl, observedAt, listTtlNowMs.value);
}

// 按需启停倒计时定时器：只在组件激活且存在正 TTL 的 key 时运行，避免空转
function syncListTtlTimer() {
  const needed = redisBrowserIsActive && positiveTtlKeyRaws.size > 0;
  if (needed && !listTtlTimer) {
    listTtlNowMs.value = Date.now();
    listTtlTimer = setInterval(() => {
      listTtlNowMs.value = Date.now();
    }, 1000);
  } else if (!needed && listTtlTimer) {
    clearInterval(listTtlTimer);
    listTtlTimer = null;
  }
}

// flatKeys 的每次变更都是整体替换数组，浅监听即可感知增删改
watch(flatKeys, syncListTtlTimer);
let commandHistoryId = 0;

function resetCheckedKeys() {
  checkedKeys.value = new Set();
  selectedGroupLeafCounts.value = new Map();
  selectionAnchorRowId.value = null;
  selectionEpoch.value++;
}

/** Parent folder selected-count derived only from currently checked leaves. */
function groupLeafCountsFromChecked(checked: ReadonlySet<string>): Map<string, number> {
  const nextCounts = new Map<string, number>();
  const ancestors = treeIndex?.ancestorGroupIdsByKeyRaw;
  if (!ancestors) return nextCounts;
  for (const keyRaw of checked) {
    for (const groupId of ancestors.get(keyRaw) ?? []) {
      nextCounts.set(groupId, (nextCounts.get(groupId) ?? 0) + 1);
    }
  }
  return nextCounts;
}

function refreshSelectedGroupLeafCounts() {
  const nextChecked = new Set<string>();
  for (const keyRaw of checkedKeys.value) {
    if (loadedKeyRaws.has(keyRaw)) nextChecked.add(keyRaw);
  }
  checkedKeys.value = nextChecked;
  selectedGroupLeafCounts.value = groupLeafCountsFromChecked(nextChecked);
  selectionEpoch.value++;
}

function setKeysChecked(keyRaws: Iterable<string>, checked: boolean) {
  const nextChecked = new Set(checkedKeys.value);
  let changed = false;

  for (const keyRaw of keyRaws) {
    if (!loadedKeyRaws.has(keyRaw) && !nextChecked.has(keyRaw)) continue;
    if (nextChecked.has(keyRaw) === checked) continue;
    if (checked) nextChecked.add(keyRaw);
    else nextChecked.delete(keyRaw);
    changed = true;
  }
  if (!changed) return;

  checkedKeys.value = nextChecked;
  // Always recompute parent counts from the full leaf set so parent/child never drift.
  selectedGroupLeafCounts.value = groupLeafCountsFromChecked(nextChecked);
  selectionEpoch.value++;
}

function nodeKeyRaws(node: RedisKeyTreeNode): string[] {
  return node.kind === "leaf" ? [node.keyRaw] : collectRedisGroupKeyRaws(node);
}

function focusKeyPane() {
  keyPaneRef.value?.focus({ preventScroll: true });
}

function groupSelectedCount(group: RedisKeyTreeGroupNode): number {
  void selectionEpoch.value;
  return selectedGroupLeafCounts.value.get(group.id) ?? 0;
}

function isNodeChecked(node: RedisKeyTreeNode): boolean {
  void selectionEpoch.value;
  if (node.kind === "leaf") return checkedKeys.value.has(node.keyRaw);
  return node.loadedLeafCount > 0 && groupSelectedCount(node) === node.loadedLeafCount;
}

function isGroupPartiallyChecked(group: RedisKeyTreeGroupNode): boolean {
  void selectionEpoch.value;
  const selectedCount = groupSelectedCount(group);
  return selectedCount > 0 && selectedCount < group.loadedLeafCount;
}

function isLeafChecked(keyRaw: string): boolean {
  void selectionEpoch.value;
  return checkedKeys.value.has(keyRaw);
}

/** Check/uncheck a leaf or folder; Shift expands an inclusive visible-row range. */
function toggleNodeCheck(node: RedisKeyTreeNode, event: MouseEvent) {
  // Let the native checkbox handle ordinary clicks; custom range selection owns Shift clicks.
  if (event.shiftKey) event.preventDefault();
  event.stopPropagation();
  if (selectionBusy.value) return;
  focusKeyPane();

  if (event.shiftKey) {
    const rows = visibleRows.value;
    const to = rows.findIndex((row) => row.node.id === node.id);
    if (to < 0) return;
    let from = selectionAnchorRowId.value ? rows.findIndex((row) => row.id === selectionAnchorRowId.value) : to;
    if (from < 0) from = to;
    const keyRaws: string[] = [];
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) keyRaws.push(...nodeKeyRaws(rows[i].node));
    setKeysChecked(keyRaws, true);
    if (!selectionAnchorRowId.value) selectionAnchorRowId.value = node.id;
    return;
  }

  setKeysChecked(nodeKeyRaws(node), !isNodeChecked(node));
  selectionAnchorRowId.value = node.id;
}

function selectAllLoadedKeys() {
  if (selectionBusy.value || loadedKeyRaws.size === 0) return;
  focusKeyPane();
  setKeysChecked(loadedKeyRaws, true);
  selectionAnchorRowId.value = visibleRows.value[0]?.id ?? null;
}

async function selectAllKeys() {
  if (selectionBusy.value || (loadedKeyRaws.size === 0 && !hasMore.value)) return;
  const requestId = searchRequestId;
  if (hasMore.value) {
    let fetchedAll = false;
    try {
      fetchedAll = await fetchAll();
    } catch (error) {
      toast(errorMessage(error), 5000);
      return;
    }
    // A search or scope change may have replaced the result while SCAN was running.
    // If the user stopped the scan, do not silently downgrade Ctrl+A to a partial selection.
    if (!fetchedAll || requestId !== searchRequestId || !redisBrowserIsActive) return;
  }
  selectAllLoadedKeys();
}

function clearAllCheckedKeys() {
  if (selectionBusy.value || checkedKeys.value.size === 0) return;
  focusKeyPane();
  resetCheckedKeys();
}

function onKeyPaneKeydown(event: KeyboardEvent) {
  if (selectionBusy.value || event.isComposing) return;
  if ((event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "a") return;
  event.preventDefault();
  if (allKeysSelected.value) clearAllCheckedKeys();
  else void selectAllKeys();
}

function rebuildTree(expandAll = false) {
  deactivateFetchAllVisibleRows();
  if (useFlatKeySearchRows.value) {
    treeKeys.value = [];
    treeIndex = null;
    expandedGroupIds.value = new Set();
    refreshSelectedGroupLeafCounts();
    return;
  }
  treeIndex = createRedisKeyTreeIndex(flatKeys.value, props.db, redisKeySeparator.value);
  const nextTree = treeIndex.root;
  treeKeys.value = nextTree;

  const nextExpanded = new Set<string>();
  const availableExpanded = collectExpandedGroupIds(nextTree);
  if (expandAll) {
    for (const id of availableExpanded) nextExpanded.add(id);
  } else {
    for (const id of expandedGroupIds.value) {
      if (availableExpanded.has(id)) nextExpanded.add(id);
    }
  }
  expandedGroupIds.value = nextExpanded;
  refreshSelectedGroupLeafCounts();

  if (selectedKeyRaw.value && !flatKeyByRaw.has(selectedKeyRaw.value)) {
    selectedKeyRaw.value = null;
  }
}

function mergeTree(newKeys: RedisKeyInfo[]) {
  if (newKeys.length === 0) return;
  deactivateFetchAllVisibleRows();
  if (!treeIndex) {
    rebuildTree(isSearchMode.value);
    return;
  }
  const { addedGroupIds } = appendRedisKeysToTreeIndex(treeIndex, newKeys, props.db, redisKeySeparator.value);
  // Trigger the shallow ref without proxying the whole namespace hierarchy.
  treeKeys.value = [...treeIndex.root];

  const nextExpanded = new Set<string>();
  for (const id of expandedGroupIds.value) {
    if (treeIndex.groupById.has(id)) nextExpanded.add(id);
  }
  // 刷新快照恢复（#7173）：首屏重建时被裁掉、后续页面重新出现的分组保持展开
  for (const id of refreshExpandedGroupIds) {
    if (treeIndex.groupById.has(id)) nextExpanded.add(id);
  }
  if (isFuzzyHierarchyView.value) {
    for (const id of addedGroupIds) nextExpanded.add(id);
  }
  expandedGroupIds.value = nextExpanded;
  // loadedLeafCount changed — re-evaluate parent checked/partial state in the UI.
  if (checkedKeys.value.size > 0) selectionEpoch.value++;
}

function invalidateScanRequests(resetAutoLoadBudget = true): number {
  rollbackFetchAllPublication();
  deactivateFetchAllVisibleRows();
  // Keep invalidation authoritative even when the old Fetch All continuation
  // observes the generation mismatch and therefore skips its own finalizer.
  isFetchingAll.value = false;
  fetchAllStopRequested.value = true;
  fetchAllLoadedCount.value = 0;
  fetchAllPreparingSnapshot = false;
  searchRequestId++;
  loadMoreOperationId++;
  loadingMore.value = false;
  subtreeFillOperations.clear();
  if (resetAutoLoadBudget) autoLoadBudget = { remaining: AUTO_LOAD_TOTAL_SCAN_ITERATIONS };
  return searchRequestId;
}

function invalidateFetchAllForStructuralMutation() {
  if (isFetchingAll.value || fetchAllPublicationRollback) invalidateScanRequests();
}

function isCurrentScanOperation(requestId: number, operationId?: number): boolean {
  return requestId === searchRequestId && (operationId === undefined || operationId === loadMoreOperationId);
}

async function fetchScanPage(requestId = searchRequestId, operationId?: number, iterationBudget?: ScanIterationBudget): Promise<RedisScanResult> {
  const pageSize = redisScanPageSize.value;
  if (isValueSearchMode.value) {
    return api.redisScanValues(props.connectionId, props.db, scanCursor.value, "*", valueQuery.value, Math.min(pageSize, REDIS_VALUE_SCAN_COUNT), searchMode.value === "all");
  }

  // Keep each backend call small so a changed search can cancel between calls.
  // COUNT is only a hint, so an empty batch does not mean the iteration is
  // complete. Bound every user-triggered page to a cumulative COUNT budget,
  // preserve the returned cursor, and let the existing "Load more" action
  // continue sparse searches without turning one request into a full scan.
  const isFuzzyKeySearch = searchMode.value === "key" && fuzzyKeySearch.value;
  let scanCountBudget = redisFuzzySearchScanBudget(0);
  const iterationsPerCall = 8;
  const perCallMaxIterations = Math.max(1, Math.ceil(scanCountBudget / Math.max(1, pageSize)));
  // When part of the automatic-fill chain, also cap this call to whatever is
  // left of the shared iteration budget — this is what actually bounds the
  // total backend work across every page that chain triggers, not just this
  // one call's own per-call cap.
  let maxIterations = iterationBudget ? Math.max(0, Math.min(perCallMaxIterations, iterationBudget.remaining)) : perCallMaxIterations;
  let completedIterations = 0;
  let cursor = scanCursor.value;
  let totalKeys = 0;

  while (completedIterations < maxIterations) {
    if (!isCurrentScanOperation(requestId, operationId)) break;
    const iterations = Math.min(iterationsPerCall, maxIterations - completedIterations);
    if (iterationBudget) iterationBudget.remaining -= iterations;
    const result = await api.redisScanKeysBatch(props.connectionId, props.db, cursor, effectivePattern.value, pageSize, iterations, true);
    completedIterations += iterations;
    if (totalKeys === 0) totalKeys = result.total_keys;
    if (isFuzzyKeySearch && totalKeys > 0) {
      scanCountBudget = redisFuzzySearchScanBudget(totalKeys);
      const fuzzyMaxIterations = Math.ceil(scanCountBudget / Math.max(1, pageSize));
      const availableIterations = iterationBudget ? completedIterations + iterationBudget.remaining : fuzzyMaxIterations;
      maxIterations = Math.min(fuzzyMaxIterations, Math.max(maxIterations, availableIterations));
    }
    if (result.keys.length > 0 || result.cursor === 0) {
      return { ...result, total_keys: totalKeys };
    }
    cursor = result.cursor;
  }

  return { cursor, keys: [], total_keys: totalKeys };
}

/// Batch-scan variant that performs multiple SCAN iterations server-side.
/// Dramatically reduces frontend↔backend roundtrips for bulk loading.
async function fetchScanBatchPage(maxIterations: number, options: { count?: number; includeTypes?: boolean } = {}): Promise<RedisScanResult> {
  const pageSize = options.count ?? redisScanPageSize.value;
  // Value search cannot be batched because each key requires a GET.
  if (isValueSearchMode.value) {
    return api.redisScanValues(props.connectionId, props.db, scanCursor.value, "*", valueQuery.value, Math.min(pageSize, REDIS_VALUE_SCAN_COUNT), searchMode.value === "all");
  }
  return api.redisScanKeysBatch(props.connectionId, props.db, scanCursor.value, effectivePattern.value, pageSize, maxIterations, options.includeTypes ?? false);
}

function appendScanResult(result: RedisScanResult, options: { updateTree?: boolean; buffer?: RedisKeyInfo[] } = {}): number {
  const newKeys = collectUniqueRedisKeys(result.keys, loadedKeyRaws);
  // 批次到达前端即为 TTL 的观测时刻，直连合并与 Fetch All 缓冲两条路径在此统一记录
  for (const key of newKeys) recordKeyTtlObservedAt(key);
  if (options.buffer) {
    for (const key of newKeys) options.buffer.push(key);
  } else if (newKeys.length > 0) {
    appendFlatKeyRecords(newKeys);
  }
  const loadedCount = flatKeys.value.length + (options.buffer?.length ?? 0);
  scanCursor.value = result.cursor;
  hasMore.value = result.cursor !== 0;
  // DBSIZE is only called on the first batch page (cursor==0); subsequent
  // pages return total_keys=0. Preserve the previously-fetched total when
  // we get a zero from a continuation. A truly empty DB returns cursor==0
  // and keys==[] along with total_keys==0, which we do record.
  if (result.total_keys > 0 || (result.cursor === 0 && result.keys.length === 0)) {
    lastTotalKeys.value = result.total_keys;
  }

  if (options.updateTree ?? true) {
    if (useFlatKeySearchRows.value) {
      treeKeys.value = [];
      treeIndex = null;
      expandedGroupIds.value = new Set();
    } else if (treeKeys.value.length === 0) {
      rebuildTree(isSearchMode.value);
    } else {
      mergeTree(newKeys);
    }
  }
  // 本轮 SCAN 已扫尽：上方树已并入本页数据（mergeTree 先完成快照恢复），快照
  // 中仍未恢复的分组确实已不存在，丢弃避免过期累积
  if (!hasMore.value) refreshExpandedGroupIds.clear();

  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : loadedCount,
    total: result.total_keys > 0 || (result.cursor === 0 && result.keys.length === 0) ? result.total_keys : undefined,
  });

  return newKeys.length;
}

function bufferFetchAllScanResult(result: RedisScanResult, buffer: RedisKeyInfo[], bufferedKeyRaws: Set<string>): number {
  let added = 0;
  for (const key of result.keys) {
    if (loadedKeyRaws.has(key.key_raw) || bufferedKeyRaws.has(key.key_raw)) continue;
    bufferedKeyRaws.add(key.key_raw);
    buffer.push(key);
    recordKeyTtlObservedAt(key);
    added++;
  }
  scanCursor.value = result.cursor;
  hasMore.value = result.cursor !== 0;
  if (result.total_keys > 0 || (result.cursor === 0 && result.keys.length === 0)) lastTotalKeys.value = result.total_keys;
  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : flatKeys.value.length + buffer.length,
    total: result.total_keys > 0 || (result.cursor === 0 && result.keys.length === 0) ? result.total_keys : undefined,
  });
  return added;
}

async function scanNextPage(requestId = searchRequestId, operationId?: number, iterationBudget?: ScanIterationBudget): Promise<boolean> {
  const result = await fetchScanPage(requestId, operationId, iterationBudget);
  if (!isCurrentScanOperation(requestId, operationId)) return false;
  appendScanResult(result);
  return true;
}

async function loadKeys() {
  if (!redisBrowserIsActive) return;
  // Consume a deferred reload only once an active load actually starts; a
  // connection check may finish after KeepAlive has paused the browser again.
  reloadKeysOnActivation = false;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  searchPending.value = false;
  const requestId = invalidateScanRequests();
  isFetchingAll.value = false;
  fetchAllStopRequested.value = false;
  fetchAllLoadedCount.value = 0;
  loading.value = true;
  loadedKeyRaws.clear();
  ttlObservedAtByRaw.clear();
  positiveTtlKeyRaws.clear();
  subtreeFilledGroupIds.clear();
  subtreePendingGroupCursors.clear();
  subtreeFillOperations.clear();
  replaceFlatKeyRecords([]);
  treeKeys.value = [];
  treeIndex = null;
  selectedKeyRaw.value = null;
  resetCheckedKeys();
  // 刷新/重载不清空展开状态（#7173）：首屏重建树时由 rebuildTree 裁掉已消失
  // 的分组；这里快照一份，供后续页面让分组重新出现时恢复展开。连接/db 切换
  // 先走 resetLoadedKeys 清空快照与展开集，仍保持从折叠开始。
  refreshExpandedGroupIds.clear();
  for (const id of expandedGroupIds.value) refreshExpandedGroupIds.add(id);
  scanCursor.value = 0;
  lastTotalKeys.value = 0;
  // Only chain the automatic continuation after a page actually applied. A
  // throw (network/backend failure) must not schedule another attempt — the
  // `finally` block below always runs on failure too, so success is tracked
  // separately and checked once we're clear of it.
  let succeeded = false;
  try {
    if (isValueSearchMode.value && !valueQuery.value) {
      hasMore.value = false;
      return;
    }
    const initialScanBudget = isFuzzyKeySearch.value ? autoLoadBudget : undefined;
    const applied = await scanNextPage(requestId, undefined, initialScanBudget);
    succeeded = applied;
  } finally {
    if (requestId === searchRequestId) {
      loading.value = false;
    }
  }
  if (succeeded && requestId === searchRequestId) {
    void maybeAutoLoadMoreRedisKeys();
  }
}

async function loadMore(iterationBudget?: ScanIterationBudget) {
  // 与 loadKeys 对称：组件被 keep-alive 包裹且停用后，挂起的 rAF 仍可能触发本函数，
  // 守卫掉停用态避免对隐藏组件跑一次冗余 SCAN。
  if (!redisBrowserIsActive) return;
  if (!hasMore.value || loadingMore.value) return;
  const requestId = searchRequestId;
  const operationId = ++loadMoreOperationId;
  loadingMore.value = true;
  // Same reasoning as `loadKeys`: a failed page must not trigger another
  // automatic attempt from `finally`, or a persistent failure retries forever
  // (bounded only by hasMore/viewport state, neither of which a failure changes).
  let applied = false;
  try {
    applied = await scanNextPage(requestId, operationId, iterationBudget);
  } finally {
    if (isCurrentScanOperation(requestId, operationId)) {
      loadingMore.value = false;
    }
  }
  // A manual "Load more" click or scroll-driven page is one user-triggered
  // request, uncapped by the shared budget (see `iterationBudget` above); but
  // if the viewport is still short afterward, hand off to the same bounded
  // automatic-fill check as everywhere else instead of relying on the user to
  // notice and click again.
  if (applied && isCurrentScanOperation(requestId, operationId)) {
    if (!iterationBudget) {
      // 只有用户点击“加载更多”或真实滚动时，才按展开顺序续扫一个停在预算上限
      // 的子树；短视口自动主补页不得额外获得一份独立子树预算。
      resumePendingGroupSubtrees(requestId);
    }
    void maybeAutoLoadMoreRedisKeys();
  }
}

// Tree mode collapses most rows by default, so the loaded key count and the
// rendered row count can diverge wildly (e.g. 1000 loaded keys folded into a
// handful of visible top-level groups). When that happens the scroller never
// overflows its viewport, so it never emits a native `scroll` event and
// `onRedisKeyScroll` — the only other caller of `loadMore` — never runs,
// silently stranding the browser on the first sparse SCAN page forever. Keep
// pulling pages after any load until the view is either actually scrollable
// or genuinely out of keys/budget, mirroring the same threshold logic the
// scroll handler already uses.
async function maybeAutoLoadMoreRedisKeys() {
  await nextTick();
  // Value/all pages load per-key metadata and values. Layout changes must not
  // turn a sparse query into an implicit background scan.
  if (isValueSearchMode.value) return;
  // Unique visible/loaded keys are a poor stop condition on their own: an
  // empty, all-duplicate, or sparsely-matching page grows that count by ~0,
  // so relying on it alone lets a short viewport turn an ordinary tree load
  // into an unbounded chain of SCAN pages. Stop deterministically — with zero
  // further backend calls — the instant the shared iteration budget for this
  // operation is spent, independent of how many (if any) new keys prior calls
  // yielded.
  if (autoLoadBudget.remaining <= 0) return;
  const scroller = redisKeyScrollerRef.value?.$el as HTMLElement | undefined;
  if (!scroller) return;
  const shouldLoad = shouldLoadMoreRedisKeys({
    enabled: redisInfiniteScrollEnabled.value,
    hasMore: hasMore.value,
    busy: loading.value || loadingMore.value || searchPending.value || deletingKeys.value || isFetchingAll.value,
    loadedKeys: flatKeys.value.length,
    maxKeys: redisInfiniteScrollMaxKeys.value,
    scrollTop: scroller.scrollTop,
    clientHeight: scroller.clientHeight,
    scrollHeight: scroller.scrollHeight,
  });
  if (shouldLoad) {
    await loadMore(autoLoadBudget).catch((error) => toast(errorMessage(error), 5000));
  }
}

function onRedisKeyScroll(event: Event) {
  const scroller = event.target;
  if (!(scroller instanceof HTMLElement)) return;
  if (isFetchingAll.value && fetchAllVisibleRowsActive.value) {
    redisKeyScrollRevision++;
    latestRedisKeyScrollAnchor = captureRedisKeyViewportAnchor(redisKeyScrollRevision);
  }
  if (redisInfiniteScrollFrame) return;
  redisInfiniteScrollFrame = requestAnimationFrame(() => {
    redisInfiniteScrollFrame = 0;
    const shouldLoad = shouldLoadMoreRedisKeys({
      enabled: redisInfiniteScrollEnabled.value,
      hasMore: hasMore.value,
      busy: loading.value || loadingMore.value || searchPending.value || deletingKeys.value || isFetchingAll.value,
      loadedKeys: flatKeys.value.length,
      maxKeys: redisInfiniteScrollMaxKeys.value,
      scrollTop: scroller.scrollTop,
      clientHeight: scroller.clientHeight,
      scrollHeight: scroller.scrollHeight,
    });
    if (shouldLoad) {
      void loadMore().catch((error) => toast(errorMessage(error), 5000));
    }
  });
}

// Fetch-all uses large key-only SCAN pages and rebuilds the tree once at the
// end; per-page tree sorting dominates runtime on million-key pattern scans.
const FETCH_ALL_SCAN_COUNT = 50000;
const FETCH_ALL_BATCH_ITERATIONS = 8;
const FETCH_ALL_PUBLISH_CHUNK_SIZE = 25_000;

type RedisKeyViewportAnchor = {
  rowId: string;
  rowIndex: number;
  scrollRevision: number;
};

type RedisKeyScroller = {
  getScroll: () => { start: number; end: number };
  findItemIndex: (offset: number) => number;
  scrollToItem: (index: number, options?: { align?: "start" | "center" | "end" | "nearest"; smooth?: boolean; offset?: number }) => void;
  updateVisibleItems?: (itemsChanged: boolean, checkPositionDiff?: boolean) => unknown;
  $forceUpdate?: () => void;
};

function yieldForRedisKeyBrowserPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function redisKeyScroller(): RedisKeyScroller | null {
  return redisKeyScrollerRef.value as unknown as RedisKeyScroller | null;
}

function captureRedisKeyViewportAnchor(scrollRevision = redisKeyScrollRevision): RedisKeyViewportAnchor | null {
  const scroller = redisKeyScroller();
  if (!scroller) return null;
  const rowIndex = scroller.findItemIndex(scroller.getScroll().start);
  if (!Number.isInteger(rowIndex) || rowIndex < 0) return null;
  const rowId = fetchAllVisibleRows.value[rowIndex]?.id;
  return rowId ? { rowId, rowIndex, scrollRevision } : null;
}

function refreshRedisKeyScroller() {
  const scroller = redisKeyScroller();
  // The facade source changed while its array identity stayed stable. Tell the
  // scroller to invalidate its keyed view pool for the currently rendered
  // range; `false` preserves old key/view mappings and can combine row labels.
  // The method is public on RecycleScroller, but keep the structural guard for
  // lightweight renderers (including tests) that do not implement scrolling.
  if (typeof scroller?.updateVisibleItems === "function") {
    scroller.updateVisibleItems(true);
  } else {
    scroller?.$forceUpdate?.();
  }
}

function fetchAllPublicationIsCurrent(requestId: number): boolean {
  return requestId === searchRequestId && redisBrowserIsActive && !fetchAllStopRequested.value;
}

async function resolveFetchAllViewportAnchor(rows: readonly RedisKeyTreeRow[], requestId: number): Promise<{ anchor: RedisKeyViewportAnchor; rowIndex: number } | null | undefined> {
  let anchor = captureRedisKeyViewportAnchor();
  if (!anchor) return null;

  while (fetchAllPublicationIsCurrent(requestId)) {
    let rowIndex = -1;
    let anchorChanged = false;
    for (let offset = 0; offset < rows.length; offset += FETCH_ALL_PUBLISH_CHUNK_SIZE) {
      if (!fetchAllPublicationIsCurrent(requestId)) return undefined;
      const end = Math.min(offset + FETCH_ALL_PUBLISH_CHUNK_SIZE, rows.length);
      for (let index = offset; index < end; index++) {
        if (rows[index]?.id === anchor.rowId) {
          rowIndex = index;
          break;
        }
      }
      if (rowIndex >= 0) break;
      if (end < rows.length) await yieldForRedisKeyBrowserPaint();
      const latest = latestRedisKeyScrollAnchor;
      if (latest && latest.scrollRevision > anchor.scrollRevision) {
        anchor = latest;
        anchorChanged = true;
        break;
      }
    }

    const latest = latestRedisKeyScrollAnchor;
    if (latest && latest.scrollRevision > anchor.scrollRevision) {
      anchor = latest;
      continue;
    }
    if (!anchorChanged) return rowIndex >= 0 ? { anchor, rowIndex } : null;
  }
  return undefined;
}

async function publishFetchAllVisibleRows(rows: readonly RedisKeyTreeRow[], requestId: number): Promise<boolean> {
  const anchorResolution = await resolveFetchAllViewportAnchor(rows, requestId);
  if (anchorResolution === undefined) return false;
  if (!fetchAllPublicationIsCurrent(requestId)) return false;
  // The facade stays bound while its complete backing source switches. If an
  // anchor survived, install the source and reposition before refreshing the
  // pool in this same browser turn, making the visual handoff atomic.
  fetchAllVisibleRowsSource = rows;
  if (anchorResolution) redisKeyScroller()?.scrollToItem(anchorResolution.rowIndex, { align: "start" });
  refreshRedisKeyScroller();
  if (anchorResolution) {
    // updateVisibleItems updates the scroller's reactive total size, but Vue
    // applies the corresponding spacer height on its next DOM flush. A target
    // beyond the old list's scroll range is clamped by the browser until that
    // happens, so repeat the bounded viewport update after nextTick. Both
    // flushes stay in the same event-loop turn (there is no paint-capable
    // yield), preserving an atomic visual handoff.
    await nextTick();
    if (!fetchAllPublicationIsCurrent(requestId)) return false;
    redisKeyScroller()?.scrollToItem(anchorResolution.rowIndex, { align: "start" });
    refreshRedisKeyScroller();
  }
  return fetchAllPublicationIsCurrent(requestId);
}

async function fetchAll(): Promise<boolean> {
  if (!hasMore.value || isFetchingAll.value) return false;
  const requestId = searchRequestId;
  const bufferedKeys: RedisKeyInfo[] = [];
  const bufferedKeyRaws = new Set<string>();
  const initialFlatKeys = flatKeys.value;
  const initialFlatKeyByRaw = flatKeyByRaw;
  const initialLoadedKeyRaws = loadedKeyRaws;
  const initialTreeKeys = treeKeys.value;
  const initialTreeIndex = treeIndex;
  const initialExpandedGroupIds = expandedGroupIds.value;
  const initialScanCursor = scanCursor.value;
  const initialHasMore = hasMore.value;
  const initialLastTotalKeys = lastTotalKeys.value;
  const snapshotConfig = {
    db: props.db,
    separator: redisKeySeparator.value,
    flatRows: useFlatKeySearchRows.value,
    expandAll: isSearchMode.value,
    expandedGroupIds: expandedGroupIds.value,
    noExpiryOnly: noExpiryOnly.value,
  };
  fetchAllPublicationRollback = {
    flatKeys: initialFlatKeys,
    flatKeyByRaw: initialFlatKeyByRaw,
    loadedKeyRaws: initialLoadedKeyRaws,
    treeKeys: initialTreeKeys,
    treeIndex: initialTreeIndex,
    expandedGroupIds: initialExpandedGroupIds,
    scanCursor: initialScanCursor,
    hasMore: initialHasMore,
    lastTotalKeys: initialLastTotalKeys,
    bufferedKeyRaws,
  };
  activateFetchAllVisibleRows();
  isFetchingAll.value = true;
  fetchAllStopRequested.value = false;
  fetchAllLoadedCount.value = flatKeys.value.length;
  let changed = false;
  let completed = false;
  let publicationSucceeded = true;
  try {
    while (requestId === searchRequestId && !fetchAllStopRequested.value && hasMore.value) {
      const result = await fetchScanBatchPage(FETCH_ALL_BATCH_ITERATIONS, {
        count: FETCH_ALL_SCAN_COUNT,
        includeTypes: false,
      });
      if (requestId !== searchRequestId) break;
      changed = bufferFetchAllScanResult(result, bufferedKeys, bufferedKeyRaws) > 0 || changed;
      fetchAllLoadedCount.value = flatKeys.value.length + bufferedKeys.length;
    }
    completed = requestId === searchRequestId && !fetchAllStopRequested.value && !hasMore.value;
  } finally {
    if (requestId === searchRequestId) {
      let published = !changed && !fetchAllStopRequested.value;
      try {
        if (changed) {
          snapshotConfig.flatRows = (searchMode.value === "key" && isSearchMode.value && !fuzzyKeySearch.value) || (isFuzzyKeySearch.value && !canBuildRedisFuzzyTree(initialFlatKeys.length + bufferedKeys.length));
          snapshotConfig.expandAll = isSearchMode.value;
          snapshotConfig.expandedGroupIds = expandedGroupIds.value;
          snapshotConfig.noExpiryOnly = noExpiryOnly.value;
          activateFetchAllVisibleRows();
          fetchAllPreparingSnapshot = true;
          const snapshot = await buildRedisKeySnapshotCooperatively([initialFlatKeys, bufferedKeys], snapshotConfig, {
            shouldContinue: () => requestId === searchRequestId && redisBrowserIsActive && !fetchAllStopRequested.value,
          });
          if (snapshot && requestId === searchRequestId && redisBrowserIsActive) {
            flatKeys.value = snapshot.flatKeys;
            flatKeyByRaw = snapshot.flatKeyByRaw;
            loadedKeyRaws = snapshot.loadedKeyRaws;
            treeIndex = snapshot.treeIndex;
            treeKeys.value = snapshot.treeIndex?.root ?? [];
            expandedGroupIds.value = snapshot.expandedGroupIds;
            fetchAllFilteredKeyCount.value = snapshotConfig.noExpiryOnly ? snapshot.filteredKeyCount : null;
            refreshSelectedGroupLeafCounts();
            published = await publishFetchAllVisibleRows(snapshot.visibleRows, requestId);
          }
        }
      } finally {
        fetchAllPreparingSnapshot = false;
        publicationSucceeded = published;
        if (published) {
          fetchAllPublicationRollback = null;
          if (!hasMore.value) refreshExpandedGroupIds.clear();
        }
        if (!published) {
          rollbackFetchAllPublication();
          deactivateFetchAllVisibleRows();
          if (requestId === searchRequestId) {
            scanCursor.value = initialScanCursor;
            hasMore.value = initialHasMore;
            lastTotalKeys.value = initialLastTotalKeys;
            for (const keyRaw of bufferedKeyRaws) {
              ttlObservedAtByRaw.delete(keyRaw);
              positiveTtlKeyRaws.delete(keyRaw);
            }
            connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
              loaded: isSearchMode.value ? undefined : initialFlatKeys.length,
              total: initialLastTotalKeys,
            });
          }
        }
        isFetchingAll.value = false;
        fetchAllStopRequested.value = false;
        fetchAllLoadedCount.value = 0;
      }
    } else {
      publicationSucceeded = false;
    }
  }
  return completed && publicationSucceeded;
}

function stopFetchAll() {
  fetchAllStopRequested.value = true;
}

// 展开分组时的定向补扫：树模式的自动加载只覆盖有界 SCAN 预算内的键，
// 未扫到的分组在树里完全不存在（搜索能找到、树里看不到）。展开分组时用
// `前缀:*` 模式以独立游标扫描该子树，让"展开即可见"成立；补扫结果经
// loadedKeyRaws 去重后并入主树，主 SCAN 游标不受影响。
const SUBTREE_SCAN_ITERATIONS_PER_CALL = 8;
// 单次补扫（一次展开或一次续扫）的预算上限：新并入的键数与 SCAN 迭代数
// 各设一个，取先到者。巨大前缀（如上万键，#7918）一次展开就扫尽子树会把
// 集群打满，改为每次交互只推进有界预算；未扫尽的分组把游标留在
// subtreePendingGroupCursors，由“加载更多”/滚动按展开顺序续扫，折叠后
// 重新展开也会从断点继续。小于预算的分组仍一次扫完，行为不变。
const SUBTREE_FILL_MAX_NEW_KEYS = 500;
const SUBTREE_FILL_MAX_SCAN_ITERATIONS = 50;

function shouldFillGroupSubtree(): boolean {
  return hasMore.value && !useFlatKeySearchRows.value && !isSearchMode.value && !isFetchingAll.value;
}

function mergeScannedKeys(newKeys: RedisKeyInfo[]) {
  if (newKeys.length === 0) return;
  for (const key of newKeys) recordKeyTtlObservedAt(key);
  appendFlatKeyRecords(newKeys);
  mergeTree(newKeys);
  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : flatKeys.value.length,
  });
}

async function fillGroupSubtree(group: RedisKeyTreeGroupNode, requestId = searchRequestId) {
  if (subtreeFilledGroupIds.has(group.id)) return;
  if (subtreeFillOperations.has(group.id)) return;
  const operationId = ++subtreeFillOperationId;
  subtreeFillOperations.set(group.id, operationId);
  // 续扫从上次停在的游标继续，避免把已扫过的前缀重扫一遍
  const resumeCursor = subtreePendingGroupCursors.get(group.id) ?? 0;
  const pattern = redisGroupSubtreePattern(group.pathSegments, redisKeySeparator.value);
  let cursor = resumeCursor;
  let mergedNewKeys = 0;
  let iterationsLeft = SUBTREE_FILL_MAX_SCAN_ITERATIONS;
  try {
    while (requestId === searchRequestId && subtreeFillOperations.get(group.id) === operationId && expandedGroupIds.value.has(group.id) && !isFetchingAll.value && iterationsLeft > 0) {
      if (flatKeys.value.length >= redisInfiniteScrollMaxKeys.value) break;
      if (mergedNewKeys >= SUBTREE_FILL_MAX_NEW_KEYS) break;
      const iterations = Math.min(SUBTREE_SCAN_ITERATIONS_PER_CALL, iterationsLeft);
      const result = await api.redisScanKeysBatch(props.connectionId, props.db, cursor, pattern, redisScanPageSize.value, iterations, true);
      iterationsLeft -= iterations;
      if (requestId !== searchRequestId || subtreeFillOperations.get(group.id) !== operationId) return;
      const newKeys = collectUniqueRedisKeys(result.keys, loadedKeyRaws);
      mergeScannedKeys(newKeys);
      mergedNewKeys += newKeys.length;
      cursor = result.cursor;
      if (cursor === 0) {
        subtreePendingGroupCursors.delete(group.id);
        subtreeFilledGroupIds.add(group.id);
        return;
      }
      // Keep the last applied cursor available while the next request is in
      // flight. A KeepAlive pause can invalidate that request, but must not
      // force the retained subtree to restart from cursor zero.
      subtreePendingGroupCursors.set(group.id, cursor);
    }
    // 子树未扫尽（预算用尽或触到全局键数上限）：保留游标等待续扫
    if (requestId === searchRequestId && subtreeFillOperations.get(group.id) === operationId) subtreePendingGroupCursors.set(group.id, cursor);
  } catch (error) {
    // 失败不阻塞浏览；已并入的进度保留在游标里，下次展开/续扫从断点重试
    if (requestId === searchRequestId && subtreeFillOperations.get(group.id) === operationId) {
      subtreePendingGroupCursors.set(group.id, cursor);
      toast(errorMessage(error), 5000);
    }
  } finally {
    if (requestId === searchRequestId && subtreeFillOperations.get(group.id) === operationId) {
      // Keep confirmed progress during the pass, then let other pending groups
      // take the next continuation. Completed or invalidated fills stay removed.
      const pendingCursor = subtreePendingGroupCursors.get(group.id);
      if (pendingCursor !== undefined) {
        subtreePendingGroupCursors.delete(group.id);
        subtreePendingGroupCursors.set(group.id, pendingCursor);
      }
      subtreeFillOperations.delete(group.id);
    }
  }
}

// “加载更多”/滚动推进主扫描的同时，按展开顺序续扫一个未扫尽的子树：巨大
// 分组不会一次扫尽，用户每点一次“加载更多”（或滚动触底触发 loadMore）就
// 前进一段有界预算，循环往复直至扫尽。
function resumePendingGroupSubtrees(requestId = searchRequestId) {
  if (!shouldFillGroupSubtree()) return;
  for (const groupId of subtreePendingGroupCursors.keys()) {
    if (subtreeFillOperations.has(groupId)) continue;
    const group = treeIndex?.groupById.get(groupId);
    if (!group) {
      // 分组已不存在（键被删除或树被重建），游标作废
      subtreePendingGroupCursors.delete(groupId);
      continue;
    }
    if (!expandedGroupIds.value.has(groupId)) continue;
    void fillGroupSubtree(group, requestId);
    return;
  }
}

function toggleGroup(groupId: string) {
  if (fetchAllPreparingSnapshot) {
    invalidateScanRequests();
    isFetchingAll.value = false;
    fetchAllStopRequested.value = false;
    fetchAllLoadedCount.value = 0;
  }
  deactivateFetchAllVisibleRows();
  const next = new Set(expandedGroupIds.value);
  const expanding = !next.has(groupId);
  if (expanding) next.add(groupId);
  else next.delete(groupId);
  expandedGroupIds.value = next;
  void maybeAutoLoadMoreRedisKeys();
  if (expanding && shouldFillGroupSubtree()) {
    const group = treeIndex?.groupById.get(groupId);
    if (group) void fillGroupSubtree(group);
  }
}

function onRowClick(node: RedisKeyTreeNode, event?: MouseEvent) {
  if (event && !selectionBusy.value && (event.shiftKey || event.ctrlKey || event.metaKey)) {
    toggleNodeCheck(node, event);
    if (node.kind === "leaf") {
      focusKeyPane();
      selectedKeyRaw.value = node.keyRaw;
      activeSidePanel.value = "detail";
    }
    return;
  }
  if (node.kind === "group") {
    toggleGroup(node.id);
    return;
  }
  focusKeyPane();
  selectedKeyRaw.value = node.keyRaw;
  activeSidePanel.value = "detail";
}

function removeKnownKey(keyRaw: string) {
  if (!flatKeyByRaw.has(keyRaw)) return;
  invalidateFetchAllForStructuralMutation();
  loadedKeyRaws.delete(keyRaw);
  ttlObservedAtByRaw.delete(keyRaw);
  positiveTtlKeyRaws.delete(keyRaw);
  replaceFlatKeyRecords(flatKeys.value.filter((key) => key.key_raw !== keyRaw));
  if (selectedKeyRaw.value === keyRaw) selectedKeyRaw.value = null;
  if (useFlatKeySearchRows.value) {
    treeKeys.value = [];
    treeIndex = null;
    refreshSelectedGroupLeafCounts();
  } else {
    rebuildTree(false);
  }
  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : flatKeys.value.length,
    totalDelta: -1,
  });
}

function onKeyDeleted(keyRaw: string) {
  removeKnownKey(keyRaw);
}

function onKeyRenamed(oldKeyRaw: string, newKeyRaw: string, newKeyDisplay: string) {
  connectionStore.invalidateCompletionCache(props.connectionId, String(props.db));
  if (isSearchMode.value) {
    void loadKeys();
    return;
  }

  invalidateFetchAllForStructuralMutation();
  const previous = flatKeyByRaw.get(oldKeyRaw);
  if (!previous) {
    void loadKeys();
    return;
  }

  loadedKeyRaws.delete(oldKeyRaw);
  loadedKeyRaws.add(newKeyRaw);
  // 改名不换 TTL，观测时刻随 key 一起迁移，倒计时不中断
  const observedAt = ttlObservedAtByRaw.get(oldKeyRaw);
  ttlObservedAtByRaw.delete(oldKeyRaw);
  if (observedAt !== undefined) ttlObservedAtByRaw.set(newKeyRaw, observedAt);
  if (positiveTtlKeyRaws.delete(oldKeyRaw)) positiveTtlKeyRaws.add(newKeyRaw);
  replaceFlatKeyRecords(flatKeys.value.map((key) => (key.key_raw === oldKeyRaw ? { ...key, key_raw: newKeyRaw, key_display: newKeyDisplay } : key)));
  if (selectedKeyRaw.value === oldKeyRaw) selectedKeyRaw.value = newKeyRaw;
  if (checkedKeys.value.has(oldKeyRaw)) {
    const nextCheckedKeys = new Set(checkedKeys.value);
    nextCheckedKeys.delete(oldKeyRaw);
    nextCheckedKeys.add(newKeyRaw);
    checkedKeys.value = nextCheckedKeys;
  }
  if (useFlatKeySearchRows.value) {
    treeKeys.value = [];
    treeIndex = null;
    refreshSelectedGroupLeafCounts();
  } else {
    rebuildTree(false);
  }
}

function redisValueToKeyInfo(value: RedisValue): RedisKeyInfo {
  return {
    key_display: value.key_display,
    key_raw: value.key_raw,
    key_type: value.redis_type,
    ttl: value.ttl,
    size: redisValueSize(value),
    value_preview: redisValuePreview(value),
  };
}

function onKeyLoaded(value: RedisValue) {
  if (value.redis_type === "none") {
    removeKnownKey(value.key_raw);
    return;
  }
  const keyInfo = redisValueToKeyInfo(value);
  const previousTtl = flatKeyByRaw.get(keyInfo.key_raw)?.ttl ?? -2;
  const noExpiryMembershipChanged = (previousTtl === -1) !== (keyInfo.ttl === -1);
  if (!updateRedisKeyInfoMetadataByRaw(flatKeyByRaw, keyInfo)) return;
  // 详情面板回写了最新的 TTL，同步刷新观测时刻，保证两侧倒计时一致
  recordKeyTtlObservedAt(keyInfo);
  loadedKeyRaws.add(keyInfo.key_raw);
  if (treeIndex) updateRedisKeyTreeLeafMetadata(treeIndex, keyInfo);
  if (noExpiryMembershipChanged) {
    noExpiryProjectionEpoch.value++;
    // A Fetch All stable row snapshot intentionally ignores ordinary metadata
    // writes. Filter membership is structural, though, so leave that snapshot
    // and let the canonical no-expiry projection include/exclude the key.
    if (noExpiryOnly.value) deactivateFetchAllVisibleRows();
  }
  keyMetadataEpoch.value++;
  syncListTtlTimer();
}

function requestBatchDelete() {
  if (checkedKeys.value.size === 0 || selectionBusy.value) return;
  pendingDanger.value = {
    kind: "delete-keys",
    title: t("redis.selectedKeys"),
    keyRaws: [...checkedKeys.value],
    loadedSearchResults: isFuzzyKeySearch.value,
  };
  showDangerConfirm.value = true;
}

function requestGroupDelete(node: RedisKeyTreeNode, event?: Event) {
  event?.stopPropagation();
  if (node.kind !== "group" || selectionBusy.value) return;
  const keyRaws = collectRedisGroupKeyRaws(node);
  if (keyRaws.length === 0) return;
  pendingDanger.value = {
    kind: "delete-keys",
    title: node.pathSegments.join(redisKeySeparator.value),
    keyRaws,
    loadedSearchResults: false,
  };
  showDangerConfirm.value = true;
}

function requestKeyDelete(node: RedisKeyTreeNode, event: Event) {
  event.stopPropagation();
  if (node.kind !== "leaf" || selectionBusy.value) return;
  pendingDanger.value = {
    kind: "delete-keys",
    title: node.fullKeyDisplay,
    keyRaws: [node.keyRaw],
    loadedSearchResults: false,
  };
  showDangerConfirm.value = true;
}

async function copyRedisKeyName(keyName: string) {
  try {
    await copyToClipboard(keyName);
    toast(t("redis.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function redisKeyContextMenuItems(node: RedisKeyTreeNode): ContextMenuItem[] {
  if (node.kind === "group") {
    const groupPath = node.pathSegments.join(redisKeySeparator.value);
    const items: ContextMenuItem[] = [
      {
        label: t("redis.createKey"),
        icon: Plus,
        action: () => openCreateKeyDialog(`${groupPath}${redisKeySeparator.value}`),
      },
      {
        label: t("redis.copyKeyPath"),
        icon: Copy,
        action: () => copyRedisKeyName(groupPath),
      },
    ];
    // Fuzzy hierarchy represents only the loaded matching subset. Keep its
    // destructive actions hidden, matching the inline group-delete button.
    if (!isFuzzyHierarchyView.value) {
      items.push({
        label: t("redis.deleteGroupKeys"),
        icon: Trash2,
        variant: "destructive",
        action: () => requestGroupDelete(node),
        disabled: () => selectionBusy.value,
      });
    }
    return items;
  }

  const copyText = redisKeyNameCopyText(node);
  if (copyText === null) return [];
  return [
    {
      label: t("redis.copyKeyName"),
      icon: Copy,
      action: () => copyRedisKeyName(copyText),
    },
  ];
}

function onRedisRowContextMenu(event: MouseEvent, node: RedisKeyTreeNode, openContextMenu: (event: MouseEvent) => void) {
  if (node.kind === "leaf") selectedKeyRaw.value = node.keyRaw;
  openContextMenu(event);
}

function resetLoadedKeys() {
  invalidateScanRequests();
  isFetchingAll.value = false;
  fetchAllStopRequested.value = false;
  fetchAllLoadedCount.value = 0;
  loadedKeyRaws.clear();
  ttlObservedAtByRaw.clear();
  positiveTtlKeyRaws.clear();
  replaceFlatKeyRecords([]);
  treeKeys.value = [];
  treeIndex = null;
  selectedKeyRaw.value = null;
  resetCheckedKeys();
  expandedGroupIds.value = new Set();
  refreshExpandedGroupIds.clear();
  hasMore.value = false;
  lastTotalKeys.value = 0;
}

async function deleteKeyRaws(keys: string[]) {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0 || deletingKeys.value) return;

  // Ignore a late SCAN page while an explicit mutation changes this result set.
  invalidateScanRequests();
  fetchAllStopRequested.value = true;
  deletingKeys.value = true;
  try {
    let deletedCount = 0;
    for (const batch of chunkRedisKeyRaws(uniqueKeys)) {
      deletedCount += await api.redisDeleteKeys(props.connectionId, props.db, batch);
    }
    const deleted = new Set(uniqueKeys);
    for (const key of deleted) {
      loadedKeyRaws.delete(key);
      ttlObservedAtByRaw.delete(key);
      positiveTtlKeyRaws.delete(key);
    }
    replaceFlatKeyRecords(flatKeys.value.filter((key) => !deleted.has(key.key_raw)));
    if (selectedKeyRaw.value && deleted.has(selectedKeyRaw.value)) {
      selectedKeyRaw.value = null;
    }
    resetCheckedKeys();
    if (useFlatKeySearchRows.value) {
      treeKeys.value = [];
      treeIndex = null;
    } else {
      rebuildTree(false);
    }
    connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
      loaded: isSearchMode.value ? undefined : flatKeys.value.length,
      totalDelta: -deletedCount,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    toast(message, 5000);
    // A Cluster request may have deleted an earlier shard before a later error.
    // Reload instead of leaving a potentially stale partial result in the tree.
    if (redisBrowserIsActive) await loadKeys();
    else reloadKeysOnActivation = true;
  } finally {
    deletingKeys.value = false;
  }
}

function scrollCommandTerminalToEnd() {
  void nextTick(() => {
    if (!commandTerminalRef.value) return;
    commandTerminalRef.value.scrollTop = commandTerminalRef.value.scrollHeight;
  });
}

function appendCommandHistory(entry: Omit<RedisCommandHistoryEntry, "id">): number {
  const id = ++commandHistoryId;
  commandHistory.value = [...commandHistory.value, { id, ...entry }];
  scrollCommandTerminalToEnd();
  return id;
}

function updateCommandHistory(id: number, patch: Partial<Omit<RedisCommandHistoryEntry, "id">>) {
  commandHistory.value = commandHistory.value.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
  scrollCommandTerminalToEnd();
}

function appendCommandOutput(entry: Omit<RedisCommandHistoryEntry, "id">) {
  // 显示输出但不记入历史（用于错误提示、空命令提示等）
  const tempEntry = { id: ++commandHistoryId, ...entry };
  commandHistory.value = [...commandHistory.value, tempEntry];
  scrollCommandTerminalToEnd();
  // 1秒后自动移除提示
  setTimeout(() => {
    commandHistory.value = commandHistory.value.filter((e) => e.id !== tempEntry.id);
  }, 1000);
}

async function runRedisCommand(command: string) {
  const prompt = commandPrompt.value;
  commandRunning.value = true;
  // Echo the command to the terminal immediately so it doesn't look like the
  // keystroke was lost while the request is in flight — the output is filled
  // in on the same entry once the response (or error) arrives.
  const entryId = appendCommandHistory({ prompt, command, output: "", error: false });
  try {
    const result = await api.redisExecuteCommand(props.connectionId, commandDb.value, command, !props.blockDangerousRedisCommands);
    updateCommandHistory(entryId, { output: formatRedisConsoleValue(result.value), error: false });
    // The db this command ran on — capture before nextRedisCommandDb() advances it.
    const executedDb = commandDb.value;
    commandDb.value = nextRedisCommandDb(commandDb.value, command, result.value);
    // Drop the cached key-name completion for this db so the editor's autocomplete
    // reflects keys added/removed/renamed by SET/DEL/RENAME/...
    const mutatesKeys = isRedisMutatingCommand(command);
    if (mutatesKeys) {
      await loadKeys();
      connectionStore.invalidateCompletionCache(props.connectionId, String(executedDb));
      // Refresh the sidebar db key counts (INFO keyspace) so `dbN (count)` stays accurate
      // after the write. Fire-and-forget so the terminal stays responsive.
      void connectionStore.refreshRedisDbKeyCounts(props.connectionId);
    }
    // Persist to history
    persistRedisHistory(command, true, result.value);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateCommandHistory(entryId, { output: errorMessage, error: true });
    // Persist failed command too
    persistRedisHistory(command, false, null, errorMessage);
  } finally {
    commandRunning.value = false;
    scrollCommandTerminalToEnd();
  }
}

function persistRedisHistory(command: string, success: boolean, resultValue?: unknown, errorMessage?: string) {
  const connName = connectionStore.getConfig(props.connectionId)?.name || "";
  const entry: HistoryEntry = {
    id: uuid(),
    connection_id: props.connectionId,
    connection_name: connName,
    database: String(commandDb.value),
    sql: command,
    executed_at: new Date().toISOString(),
    execution_time_ms: 0,
    success,
    error: errorMessage,
    activity_kind: "redis_command",
    operation: command.split(" ")[0].toUpperCase(),
    target: "",
    affected_rows: null,
    rollback_sql: null,
    details_json: resultValue != null ? JSON.stringify(resultValue) : null,
  };
  void api.saveHistory(entry);
}

async function openCommandPanel() {
  activeSidePanel.value = "command";
  await nextTick();
  getCommandInput()?.focus();
  requestCommandDocumentation();
}

function makeEntry(): CreateKeyEntry {
  return { id: nextEntryId++, value: "", field: "", score: "0" };
}

function resetEntries() {
  createKeyEntries.value = [makeEntry()];
}

function addEntry() {
  createKeyEntries.value.push(makeEntry());
}

function removeEntry(idx: number) {
  if (createKeyEntries.value.length > 1) {
    createKeyEntries.value.splice(idx, 1);
  }
}

function removeWrittenCreateKeyEntry(entryId: number) {
  createKeyEntries.value = createKeyEntries.value.filter((entry) => entry.id !== entryId);
}

function resetCreateKeyForm() {
  createKeyName.value = "";
  createKeyType.value = "string";
  createKeyValue.value = "";
  createKeyField.value = "";
  createKeyScore.value = "0";
  createKeyError.value = "";
  createKeyExpiryMode.value = "none";
  createKeyTtl.value = "";
  createKeyExpireAt.value = null;
  createKeyRawMode.value = false;
  createKeyEntryId.value = "*";
  createKeyPartiallyWritten.value = false;
  jsonModuleAvailable.value = null;
  checkingJsonModule.value = false;
  activeCreateKeyTypeHelp.value = undefined;
  createKeyTypeKeyboardNavigation.value = false;
  createKeyTypeOpenedByArrow.value = false;
  resetEntries();
}

function expiryValidationMessage(reason: "ttl" | "date" | "past"): string {
  if (reason === "ttl") return t("redis.expiryTtlInvalid");
  if (reason === "date") return t("redis.expiryDateRequired");
  return t("redis.expiryDatePast");
}

function onCreateKeyTypeChange(type: any) {
  if (creatingKey.value || createKeyPartiallyWritten.value) return;
  createKeyType.value = (type || "string") as RedisCreateKeyType;
  createKeyRawMode.value = false;
  jsonModuleAvailable.value = null;
  checkingJsonModule.value = false;
  activeCreateKeyTypeHelp.value = undefined;
  createKeyTypeKeyboardNavigation.value = false;
  createKeyTypeOpenedByArrow.value = false;
  resetEntries();
  if (createKeyType.value === "json") {
    createKeyError.value = "";
    checkingJsonModule.value = true;
    api
      .redisCheckJsonModule(props.connectionId, props.db)
      .then((ok) => {
        jsonModuleAvailable.value = ok;
        if (!ok) {
          createKeyError.value = t("redis.jsonModuleNotAvailable");
        }
      })
      .catch(() => {
        jsonModuleAvailable.value = false;
        createKeyError.value = t("redis.jsonModuleNotAvailable");
      })
      .finally(() => {
        checkingJsonModule.value = false;
      });
  } else {
    createKeyError.value = "";
  }
}

function openCreateKeyDialog(initialKeyName = "") {
  resetCreateKeyForm();
  createKeyName.value = initialKeyName;
  showCreateKeyDialog.value = true;
}

function onCreateKeyDialogOpenChange(open: boolean) {
  // A create request may have already written a Redis value; keep its recovery state visible.
  if (!open && creatingKey.value) return;
  showCreateKeyDialog.value = open;
}

function upsertCreatedKey(value: RedisValue) {
  const keyInfo: RedisKeyInfo = {
    key_display: value.key_display,
    key_raw: value.key_raw,
    key_type: value.redis_type,
    ttl: value.ttl,
    size: redisValueSize(value),
    value_preview: redisValuePreview(value),
  };
  invalidateFetchAllForStructuralMutation();
  const existing = flatKeyByRaw.get(keyInfo.key_raw);
  // 新建 key 携带的 TTL 以当前时刻为观测起点
  recordKeyTtlObservedAt(keyInfo);
  if (existing) {
    replaceFlatKeyRecords(flatKeys.value.map((key) => (key.key_raw === keyInfo.key_raw ? keyInfo : key)));
  } else {
    replaceFlatKeyRecords([keyInfo, ...flatKeys.value]);
  }
  loadedKeyRaws.add(keyInfo.key_raw);
  selectedKeyRaw.value = keyInfo.key_raw;
  rebuildTree(isSearchMode.value);
  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : flatKeys.value.length,
    totalDelta: existing ? 0 : 1,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRedisMissingKeyError(error: unknown): boolean {
  return /^Redis(?:JSON)? key no longer exists(?:;|$)/.test(errorMessage(error));
}

async function syncWrittenKey(keyRaw: string): Promise<boolean> {
  const created = await api.redisGetValue(props.connectionId, props.db, keyRaw);
  if (created.redis_type === "none") {
    removeKnownKey(keyRaw);
    return false;
  }
  upsertCreatedKey(created);
  return true;
}

async function reflectWrittenKey(keyRaw: string) {
  try {
    await syncWrittenKey(keyRaw);
  } catch (error) {
    // RedisJSON can lose a key between TYPE and JSON.GET. Confirm the race
    // before removing a possibly recreated key from the browser.
    if (!isRedisMissingKeyError(error)) return;
    try {
      await syncWrittenKey(keyRaw);
    } catch (retryError) {
      if (isRedisMissingKeyError(retryError)) removeKnownKey(keyRaw);
    }
  }
}

async function createRedisKey() {
  if (creatingKey.value) return;

  const keyName = createKeyName.value.trim();
  if (!keyName) {
    createKeyError.value = t("redis.createKeyNameRequired");
    toast(t("redis.createKeyNameRequired"), 3000);
    return;
  }

  const expiryValidation = validateRedisExpiry(createKeyExpiryMode.value, createKeyTtl.value, createKeyExpireAt.value);
  if (!expiryValidation.valid) {
    const message = expiryValidationMessage(expiryValidation.reason);
    createKeyError.value = message;
    toast(message, 3000);
    return;
  }

  const keyType = createKeyType.value;
  const rawMode = createKeyRawMode.value;
  creatingKey.value = true;
  createKeyError.value = "";
  let wroteValue = false;
  let writtenKeyRaw: string | null = null;
  let writingStructuredEntries = false;
  try {
    const keyRaw = redisKeyTextToRaw(keyName);
    writtenKeyRaw = keyRaw;
    const expiry = expiryValidation.policy;

    if (keyType === "string" || keyType === "json" || rawMode) {
      // Raw text/JSON mode — single value
      if (keyType === "string") {
        await api.redisSetString(props.connectionId, props.db, keyRaw, createKeyValue.value);
        wroteValue = true;
      } else if (keyType === "json") {
        await api.redisJsonSet(props.connectionId, props.db, keyRaw, createKeyValue.value);
        wroteValue = true;
      } else if (keyType === "hash") {
        await api.redisHashSet(props.connectionId, props.db, keyRaw, createKeyField.value, createKeyValue.value);
        wroteValue = true;
      } else if (keyType === "list") {
        await api.redisListPush(props.connectionId, props.db, keyRaw, createKeyValue.value);
        wroteValue = true;
      } else if (keyType === "set") {
        await api.redisSetAdd(props.connectionId, props.db, keyRaw, createKeyValue.value);
        wroteValue = true;
      } else if (keyType === "zset") {
        const score = Number.parseFloat(createKeyScore.value || "0");
        await api.redisZadd(props.connectionId, props.db, keyRaw, createKeyValue.value, score);
        wroteValue = true;
      }
    } else {
      // Write every member first so a single policy is applied to every key type.
      writingStructuredEntries = true;
      const pendingEntries = createKeyEntries.value.slice();
      if (keyType === "hash") {
        for (const entry of pendingEntries) {
          if (entry.field && entry.field.trim()) {
            await api.redisHashSet(props.connectionId, props.db, keyRaw, entry.field, entry.value);
            wroteValue = true;
            createKeyPartiallyWritten.value = true;
            removeWrittenCreateKeyEntry(entry.id);
          }
        }
      } else if (keyType === "list") {
        for (const entry of pendingEntries) {
          if (entry.value) {
            await api.redisListPush(props.connectionId, props.db, keyRaw, entry.value);
            wroteValue = true;
            createKeyPartiallyWritten.value = true;
            removeWrittenCreateKeyEntry(entry.id);
          }
        }
      } else if (keyType === "set") {
        for (const entry of pendingEntries) {
          if (entry.value) {
            await api.redisSetAdd(props.connectionId, props.db, keyRaw, entry.value);
            wroteValue = true;
            createKeyPartiallyWritten.value = true;
            removeWrittenCreateKeyEntry(entry.id);
          }
        }
      } else if (keyType === "zset") {
        for (const entry of pendingEntries) {
          if (entry.value) {
            const s = Number.parseFloat(entry.score || "0");
            if (!Number.isNaN(s)) {
              await api.redisZadd(props.connectionId, props.db, keyRaw, entry.value, s);
              wroteValue = true;
              createKeyPartiallyWritten.value = true;
              removeWrittenCreateKeyEntry(entry.id);
            }
          }
        }
      } else if (keyType === "stream") {
        const fields: [string, string][] = pendingEntries.filter((e) => e.field && e.field.trim()).map((e) => [e.field!.trim(), e.value]);
        if (fields.length > 0) {
          const entryId = createKeyEntryId.value.trim() || "*";
          await api.redisStreamAdd(props.connectionId, props.db, keyRaw, entryId, fields);
          wroteValue = true;
        }
      }
      writingStructuredEntries = false;
    }

    if (!wroteValue) {
      const message = keyType === "hash" || keyType === "stream" ? t("redis.fieldRequired") : t("redis.valueRequired");
      createKeyError.value = message;
      toast(message, 3000);
      return;
    }

    // Do not roll back a successful write if this separate policy command fails.
    await applyRedisExpiryPolicy(redisExpiryTransport, props.connectionId, props.db, keyRaw, expiry);

    if (!(await syncWrittenKey(keyRaw))) {
      showCreateKeyDialog.value = false;
      toast(t("redis.keyExpiredBeforeDisplay"), 3000);
      return;
    }
    showCreateKeyDialog.value = false;
  } catch (error) {
    const message = errorMessage(error);
    if (writingStructuredEntries) {
      if (wroteValue && writtenKeyRaw) {
        await reflectWrittenKey(writtenKeyRaw);
        createKeyError.value = `${message} ${t("redis.createKeyPartialWrite")}`;
        toast(message, 5000);
      } else {
        createKeyError.value = message;
      }
      return;
    }
    if (wroteValue && writtenKeyRaw) {
      await reflectWrittenKey(writtenKeyRaw);
      showCreateKeyDialog.value = false;
      toast(message, 5000);
      return;
    }
    createKeyError.value = message;
  } finally {
    creatingKey.value = false;
  }
}

async function executeCommand() {
  const command = commandText.value.trim();
  dismissCommandCompletions();
  if (!command) {
    // 空命令显示提示但不记入历史
    appendCommandOutput({
      prompt: commandPrompt.value,
      command: "",
      output: t("redis.commandEmpty"),
      error: true,
    });
    return;
  }
  if (isRedisClearScreenCommand(command)) {
    commandHistory.value = [];
    commandText.value = "";
    commandHistoryIndex.value = -1;
    scrollCommandTerminalToEnd();
    return;
  }

  const safety = classifyRedisCommandSafety(command);
  if (safety === "blocked") {
    if (!props.blockDangerousRedisCommands) {
      // 安全模式已关闭，放行 blocked 命令
      commandText.value = "";
      commandHistoryIndex.value = -1;
      await runRedisCommand(command);
      return;
    }
    appendCommandHistory({
      prompt: commandPrompt.value,
      command,
      output: t("redis.commandBlocked"),
      error: true,
    });
    commandText.value = "";
    commandHistoryIndex.value = -1;
    return;
  }
  if (safety === "confirm") {
    if (!props.blockDangerousRedisCommands) {
      // 安全模式已关闭，跳过确认弹窗直接执行
      commandText.value = "";
      commandHistoryIndex.value = -1;
      await runRedisCommand(command);
      return;
    }
    pendingDanger.value = { kind: "command", command };
    showDangerConfirm.value = true;
    commandText.value = "";
    commandHistoryIndex.value = -1;
    return;
  }
  commandText.value = "";
  commandHistoryIndex.value = -1;
  await runRedisCommand(command);
}

async function applyDangerAction() {
  const pending = pendingDanger.value;
  if (!pending) return;

  if (pending.kind === "delete-keys") {
    await deleteKeyRaws(pending.keyRaws);
    pendingDanger.value = null;
    showDangerConfirm.value = false;
  } else {
    pendingDanger.value = null;
    showDangerConfirm.value = false;
    await runRedisCommand(pending.command);
  }
}

function typeColor(type: string): string {
  switch (type) {
    case "string":
      return "text-green-500";
    case "list":
      return "text-blue-500";
    case "set":
      return "text-purple-500";
    case "zset":
      return "text-amber-500";
    case "hash":
      return "text-orange-500";
    case "stream":
      return "text-teal-500";
    default:
      return "text-muted-foreground";
  }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let hasAutoFocusedSearch = false;

function dismissKeyTemplateMenu() {
  keyTemplateMenuOpen.value = false;
  keyTemplateSelectedIndex.value = 0;
  if (keyTemplateBlurTimer) {
    clearTimeout(keyTemplateBlurTimer);
    keyTemplateBlurTimer = null;
  }
}

function openKeyTemplateMenu() {
  if (searchMode.value !== "key" || redisKeyTemplates.value.length === 0) {
    dismissKeyTemplateMenu();
    return;
  }
  keyTemplateMenuOpen.value = true;
  keyTemplateSelectedIndex.value = 0;
}

function clampKeyTemplateSelection() {
  const max = Math.max(keyTemplateSuggestions.value.length - 1, 0);
  if (keyTemplateSelectedIndex.value > max) keyTemplateSelectedIndex.value = max;
}

function selectKeyTemplate(index: number) {
  const template = keyTemplateSuggestions.value[index];
  if (!template) return;
  if (searchTimer) {
    clearTimeout(searchTimer);
    searchTimer = null;
  }
  searchPending.value = false;
  searchPattern.value = template;
  dismissKeyTemplateMenu();
  void nextTick(() => getSearchInput()?.focus());
}

function moveKeyTemplateSelection(direction: number): boolean {
  if (!keyTemplateMenuVisible.value) return false;
  const count = keyTemplateSuggestions.value.length;
  if (count === 0) return false;
  keyTemplateSelectedIndex.value = Math.min(Math.max(keyTemplateSelectedIndex.value + direction, 0), count - 1);
  void nextTick(() => {
    document.getElementById(`${keyTemplateListboxId}-option-${keyTemplateSelectedIndex.value}`)?.scrollIntoView({ block: "nearest" });
  });
  return true;
}

function onSearchFocus() {
  openKeyTemplateMenu();
}

function onSearchBlur() {
  if (keyTemplateBlurTimer) clearTimeout(keyTemplateBlurTimer);
  keyTemplateBlurTimer = setTimeout(() => {
    dismissKeyTemplateMenu();
    keyTemplateBlurTimer = null;
  }, 150);
}

function onSearchInput() {
  if (searchMode.value === "key" && redisKeyTemplates.value.length > 0) {
    keyTemplateMenuOpen.value = true;
    keyTemplateSelectedIndex.value = 0;
    clampKeyTemplateSelection();
  } else {
    dismissKeyTemplateMenu();
  }
  // Key search is Enter-only so users can finish editing templates / patterns
  // (including {$placeholders}) without triggering SCAN on every keystroke.
  if (searchMode.value === "key") {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    searchPending.value = false;
    invalidateScanRequests();
    loading.value = false;
    isFetchingAll.value = false;
    fetchAllStopRequested.value = true;
    fetchAllLoadedCount.value = 0;
    selectedKeyRaw.value = null;
    resetCheckedKeys();
    // The rendered rows may stay visible while editing, but their cursor
    // belongs to the last submitted pattern and must not be continued.
    hasMore.value = false;
    return;
  }
  if (searchTimer) clearTimeout(searchTimer);
  // Invalidate in-flight SCAN work as soon as the query changes instead of
  // waiting for the debounce timer to start the replacement search.
  invalidateScanRequests();
  loading.value = false;
  isFetchingAll.value = false;
  fetchAllStopRequested.value = true;
  fetchAllLoadedCount.value = 0;
  searchPending.value = true;
  searchTimer = setTimeout(() => {
    void loadKeys();
  }, 400);
}

function setSearchMode(mode: RedisSearchMode) {
  if (searchMode.value === mode) return;
  searchMode.value = mode;
  if (mode !== "key") dismissKeyTemplateMenu();
  void loadKeys();
}

function toggleFuzzyKeySearch() {
  fuzzyKeySearch.value = !fuzzyKeySearch.value;
  if (searchMode.value === "key") void loadKeys();
}

function toggleNoExpiryOnly() {
  if (isFetchingAll.value) return;
  deactivateFetchAllVisibleRows();
  noExpiryOnly.value = !noExpiryOnly.value;
}

function getSearchInput(): HTMLInputElement | null {
  return rootRef.value?.querySelector<HTMLInputElement>("[data-redis-search-input]") ?? null;
}

async function autofocusSearchOnce() {
  if (hasAutoFocusedSearch) return;
  await nextTick();
  const input = getSearchInput();
  if (!input) return;
  hasAutoFocusedSearch = true;
  input.focus({ preventScroll: true });
}

function getCommandInput(): HTMLInputElement | null {
  return rootRef.value?.querySelector<HTMLInputElement>("[data-redis-command-input]") ?? null;
}

function resetCommandDocumentation() {
  commandDocumentationRequestId++;
  commandDocumentationConnectionId = null;
  commandDocumentationLoading.value = false;
  commandDocumentation.value = [];
}

function requestCommandDocumentation() {
  if (commandDocumentationLoading.value || commandDocumentationConnectionId === props.connectionId) return;
  const requestId = ++commandDocumentationRequestId;
  const connectionId = props.connectionId;
  const database = String(commandDb.value);
  commandDocumentationLoading.value = true;
  void connectionStore
    .listRedisCompletionCommandDocs(connectionId, database)
    .then((docs) => {
      if (requestId !== commandDocumentationRequestId || connectionId !== props.connectionId) return;
      commandDocumentation.value = docs;
      commandDocumentationConnectionId = connectionId;
      if (commandText.value) void refreshCommandCompletions();
    })
    .catch(() => {
      if (requestId !== commandDocumentationRequestId || connectionId !== props.connectionId) return;
      // Do not offer guessed commands when the instance's metadata is unavailable.
      commandDocumentation.value = [];
      commandDocumentationConnectionId = connectionId;
    })
    .finally(() => {
      if (requestId === commandDocumentationRequestId) commandDocumentationLoading.value = false;
    });
}

function dismissCommandCompletions() {
  commandCompletionRequestId++;
  commandCompletionItems.value = [];
  commandCompletionSelectedIndex.value = 0;
  commandCompletionLoading.value = false;
}

async function refreshCommandCompletions(options: { force?: boolean } = {}) {
  const input = getCommandInput();
  const text = commandText.value;
  if (!options.force && !text) {
    dismissCommandCompletions();
    return;
  }

  const cursor = input?.selectionStart ?? text.length;
  requestCommandDocumentation();
  const completionInput = { commands: commandDocumentation.value };
  const context = getRedisCompletionContext(text, cursor, completionInput);
  const requestId = ++commandCompletionRequestId;
  commandCompletionItems.value = [];
  commandCompletionSelectedIndex.value = 0;

  let keys: string[] = [];
  const needsKeys = context.mode === "argument" && takesKeyArgument(context.commandName, completionInput, context.argumentIndex, context.argumentValues);
  commandCompletionLoading.value = needsKeys;
  if (needsKeys) {
    try {
      keys = await connectionStore.listRedisCompletionKeys(props.connectionId, String(commandDb.value));
    } catch {
      keys = [];
    }
  }

  if (requestId !== commandCompletionRequestId) return;
  commandCompletionItems.value = buildRedisCompletionItemsFromContext(context, { keys, ...completionInput }).slice(0, REDIS_COMMAND_COMPLETION_MENU_LIMIT);
  commandCompletionLoading.value = false;
}

function onCommandInput() {
  void refreshCommandCompletions();
}

function onCommandInputClick() {
  void refreshCommandCompletions();
}

function selectCommandCompletion(index: number) {
  if (index < 0 || index >= commandCompletionItems.value.length) return;
  commandCompletionSelectedIndex.value = index;
  void nextTick(() => {
    const listbox = document.getElementById(commandCompletionListboxId);
    const option = document.getElementById(`${commandCompletionListboxId}-option-${index}`);
    if (!listbox || !option) return;
    const listboxRect = listbox.getBoundingClientRect();
    const optionRect = option.getBoundingClientRect();
    if (optionRect.top < listboxRect.top) listbox.scrollTop -= listboxRect.top - optionRect.top;
    else if (optionRect.bottom > listboxRect.bottom) listbox.scrollTop += optionRect.bottom - listboxRect.bottom;
  });
}

function moveCommandCompletionSelection(direction: 1 | -1): boolean {
  const count = commandCompletionItems.value.length;
  if (count === 0) return false;
  const nextIndex = Math.min(Math.max(commandCompletionSelectedIndex.value + direction, 0), count - 1);
  if (nextIndex !== commandCompletionSelectedIndex.value) selectCommandCompletion(nextIndex);
  return true;
}

function commandCompletionInsertion(index = commandCompletionSelectedIndex.value) {
  const item = commandCompletionItems.value[index];
  const input = getCommandInput();
  if (!item || !input) return null;

  const text = commandText.value;
  const context = getRedisCompletionContext(text, input.selectionStart ?? text.length, { commands: commandDocumentation.value });
  const from = context.from;
  const to = input.selectionEnd ?? text.length;
  const insert = item.apply ?? item.label;
  const commandHead = context.mode === "command" || context.mode === "subcommand";
  const appendSpace = (commandHead || item.appendSpace === true) && !/^\s/.test(text.slice(to));
  const hasCommandExample = commandHead && item.apply !== undefined && item.apply !== item.label;
  const replacement = `${insert}${appendSpace && !hasCommandExample ? " " : ""}`;
  return { text, from, to, insert, replacement, appendSpace: appendSpace && !hasCommandExample, commandHead };
}

function selectedCompletionMatchesInput(): boolean {
  const completion = commandCompletionInsertion();
  if (!completion) return false;
  const current = completion.text.slice(completion.from, completion.to);
  return completion.commandHead ? current.toUpperCase() === completion.insert.toUpperCase() : current === completion.insert;
}

function acceptCommandCompletion(index = commandCompletionSelectedIndex.value): boolean {
  const completion = commandCompletionInsertion(index);
  if (!completion) return false;

  commandText.value = `${completion.text.slice(0, completion.from)}${completion.replacement}${completion.text.slice(completion.to)}`;
  dismissCommandCompletions();

  void nextTick(() => {
    const nextInput = getCommandInput();
    if (!nextInput) return;
    const cursor = completion.from + completion.replacement.length;
    nextInput.focus();
    nextInput.setSelectionRange(cursor, cursor);
    if (completion.appendSpace) void refreshCommandCompletions({ force: true });
  });
  return true;
}

function focusSearch(): boolean {
  if (activeSidePanel.value === "detail" && valueViewerRef.value?.focusSearch()) {
    return true;
  }
  const input = getSearchInput();
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

function onSearchKeydown(event: KeyboardEvent) {
  if (keyTemplateMenuVisible.value) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveKeyTemplateSelection(1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveKeyTemplateSelection(-1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      selectKeyTemplate(keyTemplateSelectedIndex.value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      dismissKeyTemplateMenu();
      return;
    }
  }
  if (event.key === "Enter") {
    void loadKeys();
    return;
  }
  if (!isCancelSearchShortcut(event)) return;
  event.preventDefault();
  searchPattern.value = "";
  dismissKeyTemplateMenu();
  void loadKeys();
}

function onRedisDbFlushed(event: Event) {
  const detail = (event as CustomEvent<{ connectionId: string; db: number }>).detail;
  if (!detail || detail.connectionId !== props.connectionId || detail.db !== props.db) return;
  resetLoadedKeys();
}

function registerRedisDbFlushedListener() {
  if (redisDbFlushedListenerRegistered) return;
  window.addEventListener("dbx-redis-db-flushed", onRedisDbFlushed);
  redisDbFlushedListenerRegistered = true;
}

function unregisterRedisDbFlushedListener() {
  if (!redisDbFlushedListenerRegistered) return;
  window.removeEventListener("dbx-redis-db-flushed", onRedisDbFlushed);
  redisDbFlushedListenerRegistered = false;
}

function pauseRedisBrowserBackgroundWork() {
  // Fetch All advances the cursor and duplicate filter before its local buffer
  // is committed. Discard that incomplete session so reactivation cannot skip
  // keys that were never rendered.
  const discardIncompleteFetchAll = isFetchingAll.value;
  redisBrowserIsActive = false;
  // 组件停用/卸载后不再展示列表，停掉 TTL 倒计时定时器
  syncListTtlTimer();
  // 与 onUnmounted 对称：组件被 keep-alive 包裹，停用时（onDeactivated）若不取消挂起的 rAF，
  // 帧回调仍会在隐藏组件上触发并调用 loadMore() 跑一次冗余 SCAN，故在此一并取消并置 0。
  if (redisInfiniteScrollFrame) cancelAnimationFrame(redisInfiniteScrollFrame);
  redisInfiniteScrollFrame = 0;
  // KeepAlive retains this operation's rows and cursor, so pausing invalidates
  // ownership without granting the same operation another automatic budget.
  invalidateScanRequests(false);
  isFetchingAll.value = false;
  fetchAllStopRequested.value = false;
  fetchAllLoadedCount.value = 0;
  loading.value = false;
  // The edited value/all query has not run yet; its old cursor cannot be
  // retained as progress for the new query when we cancel the debounce.
  if (searchPending.value) reloadKeysOnActivation = true;
  searchPending.value = false;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  if (discardIncompleteFetchAll) resetLoadedKeys();
  unregisterRedisDbFlushedListener();
}

function resumeRedisBrowserBackgroundWork() {
  redisBrowserIsActive = true;
  registerRedisDbFlushedListener();
  // 重新激活后恢复 TTL 倒计时定时器
  syncListTtlTimer();
}

async function clearInMemoryHistory() {
  commandHistory.value = [];
}

function onCommandAreaClick() {
  // 只有在没有选中文本时才聚焦输入框，避免清除用户的文本选择
  const selection = window.getSelection();
  if (!selection || selection.toString().length === 0) {
    getCommandInput()?.focus();
  }
}

function onCommandInputKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.code === "Space") {
    event.preventDefault();
    void refreshCommandCompletions({ force: true });
    return;
  }
  if (event.key === "Tab" && !event.shiftKey && acceptCommandCompletion()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && commandCompletionOpen.value) {
    event.preventDefault();
    dismissCommandCompletions();
    return;
  }
  if (event.key === "ArrowUp" && moveCommandCompletionSelection(-1)) {
    event.preventDefault();
    return;
  }
  if (event.key === "ArrowDown" && moveCommandCompletionSelection(1)) {
    event.preventDefault();
    return;
  }
  // Do not execute a partial command before instance metadata can resolve it.
  if (event.key === "Enter" && commandDocumentationLoading.value) {
    event.preventDefault();
    return;
  }
  if (event.key === "Enter" && !selectedCompletionMatchesInput() && acceptCommandCompletion()) {
    event.preventDefault();
    return;
  }

  // 上下键切换历史命令
  if (event.key === "ArrowUp") {
    event.preventDefault();
    if (commandHistory.value.length === 0) return;

    if (commandHistoryIndex.value === -1) {
      // 首次按上键，从最后一条开始
      commandHistoryIndex.value = commandHistory.value.length - 1;
    } else if (commandHistoryIndex.value > 0) {
      // 继续往前
      commandHistoryIndex.value--;
    }
    commandText.value = commandHistory.value[commandHistoryIndex.value].command;
    dismissCommandCompletions();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    if (commandHistoryIndex.value === -1) return;

    if (commandHistoryIndex.value < commandHistory.value.length - 1) {
      // 往后
      commandHistoryIndex.value++;
      commandText.value = commandHistory.value[commandHistoryIndex.value].command;
    } else {
      // 到达末尾，清空输入
      commandHistoryIndex.value = -1;
      commandText.value = "";
    }
    dismissCommandCompletions();
  } else if (event.key === "Enter") {
    event.preventDefault();
    void executeCommand();
  }
}

onMounted(async () => {
  resumeRedisBrowserBackgroundWork();
  void autofocusSearchOnce();
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  void loadKeys();
});

onActivated(async () => {
  resumeRedisBrowserBackgroundWork();
  void autofocusSearchOnce();
  // Ensure the connection is still alive after reactivation (e.g. tab switch).
  // Retry an empty failed/interrupted load, but retain successful sparse pages.
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  // loadKeys resets the cursor before requesting its first page. A nonzero
  // retained cursor therefore distinguishes an applied empty page from a
  // failed/interrupted reload even if hasMore still reflects the previous load.
  const hasRetainedScanCursor = hasMore.value && scanCursor.value !== 0;
  if ((reloadKeysOnActivation || (flatKeys.value.length === 0 && !hasRetainedScanCursor)) && !loading.value) {
    void loadKeys();
  }
});

onDeactivated(pauseRedisBrowserBackgroundWork);

onUnmounted(() => {
  pauseRedisBrowserBackgroundWork();
  if (redisInfiniteScrollFrame) cancelAnimationFrame(redisInfiniteScrollFrame);
  redisInfiniteScrollFrame = 0;
});

watch(
  () => [props.connectionId, props.db] as const,
  async ([connectionId, db]) => {
    // ContentArea remounts this browser for scope changes; keep embedded uses
    // in sync as well so an old scan cannot populate the new scope.
    commandDb.value = db;
    resetCommandDocumentation();
    resetLoadedKeys();
    try {
      await connectionStore.ensureConnected(connectionId);
    } catch (error) {
      console.warn("[DBX] ensureConnected failed for", connectionId, error);
    }
    if (connectionId !== props.connectionId || db !== props.db) return;
    void loadKeys();
  },
);

async function insertCommand(command: string): Promise<boolean> {
  const normalizedCommand = command.trim();
  if (!normalizedCommand || commandRunning.value) return false;
  await openCommandPanel();
  commandText.value = normalizedCommand;
  await nextTick();
  getCommandInput()?.focus();
  return true;
}

async function executeAiCommand(command: string): Promise<boolean> {
  if (!(await insertCommand(command))) return false;
  // Reuse the interactive console path so blocked commands, confirmations, and
  // the disabled-safety preference behave exactly like manually entered commands.
  await executeCommand();
  return true;
}

defineExpose({ focusSearch, insertCommand, executeCommand: executeAiCommand });
</script>

<template>
  <div ref="rootRef" class="h-full" :style="editorFontFamilyStyle">
    <Splitpanes class="redis-workspace-splitpanes h-full">
      <!-- Key tree (left) -->
      <Pane :size="36" :min-size="24">
        <div ref="keyPaneRef" class="redis-key-pane relative h-full flex flex-col overflow-hidden outline-none" tabindex="0" @keydown="onKeyPaneKeydown">
          <!-- Toolbar -->
          <div class="border-b px-2 py-2 shrink-0">
            <div class="redis-key-toolbar-header">
              <div class="redis-search-mode-group flex rounded-md border bg-muted/30 p-0.5" role="group">
                <button type="button" class="redis-search-mode-button h-5 px-2 text-xs rounded-sm transition-colors" :class="searchMode === 'key' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="setSearchMode('key')">
                  {{ t("redis.searchByKey") }}
                </button>
                <button type="button" class="redis-search-mode-button h-5 px-2 text-xs rounded-sm transition-colors" :class="searchMode === 'value' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="setSearchMode('value')">
                  {{ t("redis.searchByValue") }}
                </button>
                <button type="button" class="redis-search-mode-button h-5 px-2 text-xs rounded-sm transition-colors" :class="searchMode === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'" @click="setSearchMode('all')">
                  {{ t("redis.searchByAll") }}
                </button>
              </div>
              <span class="redis-key-count truncate text-xs text-muted-foreground" :title="keyCountText">{{ keyCountText }}</span>
              <div class="redis-key-toolbar-actions flex items-center justify-end gap-1">
                <Button v-if="(flatKeys.length > 0 || hasMore) && !allKeysSelected" variant="ghost" size="sm" class="h-6 shrink-0 px-1.5 text-xs" :disabled="selectionBusy" :title="t('redis.selectAllLoadedTitle')" data-redis-select-all @click="selectAllKeys">{{ t("redis.selectAllLoaded") }}</Button>
                <Button v-if="checkedKeys.size > 0" variant="ghost" size="sm" class="h-6 shrink-0 px-1.5 text-xs" :disabled="selectionBusy" data-redis-deselect-all @click="clearAllCheckedKeys">{{ t("redis.deselectAll") }}</Button>
                <Button v-if="checkedKeys.size > 0" variant="ghost" size="sm" class="h-6 shrink-0 text-xs text-destructive" :disabled="selectionBusy" data-redis-batch-delete @click="requestBatchDelete"><Trash2 class="w-3 h-3 mr-1" />{{ checkedKeys.size }}</Button>
                <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :disabled="deletingKeys || loading || loadingMore || isFetchingAll" @click="loadKeys">
                  <Loader2 v-if="loading" class="h-3 w-3 animate-spin" />
                  <RefreshCw v-else class="h-3 w-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :title="t('redis.createKey')" @click="openCreateKeyDialog">
                  <Plus class="h-3 w-3" />
                </Button>
              </div>
            </div>
            <div class="redis-key-search-row mt-2">
              <div class="relative min-w-0">
                <Search class="pointer-events-none absolute left-2.5 top-1/2 z-[1] h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/80" />
                <Input
                  v-model="searchPattern"
                  data-redis-search-input
                  role="combobox"
                  class="h-8 border-border/70 bg-background pl-8 pr-3 text-xs shadow-sm caret-primary placeholder:text-muted-foreground/80 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20"
                  :placeholder="searchPlaceholder"
                  :aria-expanded="keyTemplateMenuVisible"
                  :aria-controls="keyTemplateMenuVisible ? keyTemplateListboxId : undefined"
                  :aria-activedescendant="keyTemplateActiveDescendant"
                  autocomplete="off"
                  @input="onSearchInput"
                  @keydown="onSearchKeydown"
                  @focus="onSearchFocus"
                  @blur="onSearchBlur"
                />
                <div v-if="keyTemplateMenuVisible" :id="keyTemplateListboxId" role="listbox" :aria-label="t('redis.keyTemplateSuggestions')" class="absolute left-0 right-0 top-[calc(100%+0.25rem)] z-30 max-h-60 overflow-y-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-md">
                  <button
                    v-for="(template, index) in keyTemplateSuggestions"
                    :id="`${keyTemplateListboxId}-option-${index}`"
                    :key="template"
                    type="button"
                    role="option"
                    class="dbx-editor-font-family flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                    :class="keyTemplateSelectedIndex === index ? 'bg-accent text-accent-foreground' : ''"
                    :aria-selected="keyTemplateSelectedIndex === index"
                    @mousedown.prevent="selectKeyTemplate(index)"
                  >
                    <span class="truncate">{{ template }}</span>
                  </button>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <Button
                  v-if="searchMode === 'key'"
                  variant="ghost"
                  size="sm"
                  class="h-8 max-w-full shrink-0 whitespace-nowrap px-2 text-xs"
                  :class="fuzzyKeySearch ? 'bg-accent text-accent-foreground' : 'border border-dashed border-border/70 text-muted-foreground hover:text-foreground'"
                  :title="t('redis.fuzzyMatchTitle')"
                  :aria-pressed="fuzzyKeySearch"
                  @click="toggleFuzzyKeySearch"
                >
                  <Asterisk class="redis-fuzzy-icon h-3 w-3 mr-1" />
                  <span class="redis-fuzzy-label">{{ t("redis.fuzzyMatch") }}</span>
                </Button>
                <!-- 仅看无过期：在已加载结果里过滤出 TTL 为 -1 的 key，方便批量定位未设置过期时间的缓存 -->
                <Button
                  variant="ghost"
                  size="sm"
                  class="h-8 shrink-0 whitespace-nowrap px-2 text-xs"
                  :class="noExpiryOnly ? 'bg-accent text-accent-foreground' : 'border border-dashed border-border/70 text-muted-foreground hover:text-foreground'"
                  :title="t('redis.noExpiryOnlyTitle')"
                  :aria-pressed="noExpiryOnly"
                  :disabled="isFetchingAll"
                  data-redis-no-expiry-filter
                  @click="toggleNoExpiryOnly"
                >
                  <Clock class="h-3 w-3 mr-1" />
                  <span>{{ t("redis.noExpiryOnly") }}</span>
                </Button>
              </div>
            </div>
          </div>

          <div v-if="flatKeys.length === 0 && !loading" class="flex-1 flex flex-col items-center justify-center text-muted-foreground text-xs p-4 text-center">
            <template v-if="hasMore">
              <span class="mb-3">{{ t("redis.noKeysInScanHint") }}</span>
              <Button variant="outline" size="sm" class="h-7 text-xs" :disabled="loadingMore || searchPending || deletingKeys" @click="loadMore()">
                <Loader2 v-if="loadingMore" class="w-3 h-3 mr-1.5 animate-spin" />
                {{ t("redis.loadMoreKeys") }}
              </Button>
            </template>
            <template v-else>
              {{ t("redis.noKeys") }}
            </template>
          </div>
          <div v-else-if="loading && flatKeys.length === 0" class="flex-1 flex items-center justify-center gap-2 text-muted-foreground text-xs">
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>{{ loadingEmptyText }}</span>
          </div>
          <!-- 过滤开启但没有命中任何无过期 key 时，给出明确空态提示而不是空白列表 -->
          <div v-else-if="noExpiryOnly && visibleRows.length === 0" class="flex-1 flex items-center justify-center text-muted-foreground text-xs p-4 text-center">
            {{ t("redis.noExpiryKeysEmpty") }}
          </div>
          <RecycleScroller v-else ref="redisKeyScrollerRef" class="redis-key-scroller flex-1" :items="redisKeyScrollerRows" :item-size="30" :buffer="600" :skip-hover="true" key-field="id" @scroll="onRedisKeyScroll" @resize="maybeAutoLoadMoreRedisKeys">
            <template #default="{ item: row }">
              <CustomContextMenu :items="redisKeyContextMenuItems(row.node)" v-slot="{ onContextMenu, isOpen }">
                <div
                  class="flex items-center gap-2 border-b px-1.5 text-[13px] cursor-pointer select-none group"
                  :class="[
                    isOpen || (row.node.kind === 'leaf' && selectedKeyRaw === row.node.keyRaw) ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/40',
                    row.node.kind === 'leaf' ? (isLeafChecked(row.node.keyRaw) && selectedKeyRaw !== row.node.keyRaw ? 'bg-primary/10' : undefined) : groupSelectedCount(row.node) > 0 ? 'bg-primary/10' : undefined,
                  ]"
                  :style="{ height: '30px' }"
                  @click="onRowClick(row.node, $event)"
                  @contextmenu="(event) => onRedisRowContextMenu(event, row.node, onContextMenu)"
                >
                  <div class="min-w-0 flex flex-1 items-center gap-1 overflow-hidden" :style="{ paddingLeft: `${4 + row.depth * 10}px` }">
                    <template v-if="row.node.kind === 'group'">
                      <input
                        type="checkbox"
                        class="h-3.5 w-3.5 shrink-0 accent-primary cursor-pointer"
                        :checked="isNodeChecked(row.node)"
                        :indeterminate="isGroupPartiallyChecked(row.node)"
                        :aria-label="t('redis.selectLoadedGroupKeys', { count: row.node.loadedLeafCount })"
                        :disabled="selectionBusy"
                        :data-redis-group="row.node.id"
                        @click="toggleNodeCheck(row.node, $event)"
                      />
                      <component :is="expandedGroupIds.has(row.node.id) ? ChevronDown : ChevronRight" class="w-3 h-3 shrink-0 text-muted-foreground" />
                      <component :is="expandedGroupIds.has(row.node.id) ? FolderOpen : FolderClosed" class="h-3.5 w-3.5 shrink-0 text-amber-500" />
                      <span class="dbx-editor-font-family truncate">{{ row.node.label }}</span>
                      <span class="text-muted-foreground ml-1" :title="isFuzzyHierarchyView ? t('redis.loadedMatchingKeys', { count: row.node.loadedLeafCount }) : hasMore ? t('redis.loadedGroupKeysPartial', { count: row.node.loadedLeafCount }) : undefined"
                        >({{ row.node.loadedLeafCount }}{{ !isFuzzyHierarchyView && hasMore ? "+" : "" }})</span
                      >
                    </template>
                    <template v-else>
                      <span class="relative flex h-4 w-4 shrink-0 items-center justify-center">
                        <KeyRound class="h-3.5 w-3.5 text-muted-foreground/70 transition-opacity group-hover:opacity-0" :class="{ 'opacity-0': isLeafChecked(row.node.keyRaw) }" />
                        <input
                          type="checkbox"
                          class="absolute h-3.5 w-3.5 accent-primary cursor-pointer opacity-0 group-hover:opacity-100"
                          :class="{ 'opacity-100': isLeafChecked(row.node.keyRaw) }"
                          :disabled="selectionBusy"
                          :checked="isLeafChecked(row.node.keyRaw)"
                          :data-redis-leaf="row.node.keyRaw"
                          @click="toggleNodeCheck(row.node, $event)"
                        />
                      </span>
                      <span class="dbx-editor-font-family truncate">{{ row.node.label }}</span>
                    </template>
                  </div>
                  <div class="flex shrink-0 items-center justify-end gap-1">
                    <Badge v-if="row.node.kind === 'leaf' && redisRowKeyType(row.node)" variant="outline" class="text-xs px-1.5 py-0" :class="typeColor(redisRowKeyType(row.node))">{{ redisRowKeyType(row.node) }}</Badge>
                    <!-- TTL 徽标：与类型徽标保持一致的胶囊样式，永不过期为琥珀色、临近过期/已过期为红色警示 -->
                    <span
                      v-if="row.node.kind === 'leaf' && redisTtlBadgeText(redisRowTtl(row.node), redisRowDisplayTtl(redisRowTtl(row.node), row.node.keyRaw))"
                      class="inline-flex shrink-0 items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] leading-none"
                      :class="redisTtlBadgeClass(redisRowTtl(row.node), redisRowDisplayTtl(redisRowTtl(row.node), row.node.keyRaw))"
                      :title="redisRowTtl(row.node) === -1 ? t('redis.noExpiry') : t('redis.ttlCountdownTitle')"
                      >{{ redisTtlBadgeText(redisRowTtl(row.node), redisRowDisplayTtl(redisRowTtl(row.node), row.node.keyRaw)) }}</span
                    >
                    <Button v-if="row.node.kind === 'group' && !isFuzzyHierarchyView" variant="ghost" size="icon" class="h-5 w-5 shrink-0 text-destructive opacity-0 group-hover:opacity-100" :title="t('redis.deleteGroup')" :disabled="selectionBusy" @click="requestGroupDelete(row.node, $event)">
                      <Trash2 class="h-3 w-3" />
                    </Button>
                    <Button
                      v-else-if="row.node.kind === 'leaf'"
                      variant="ghost"
                      size="icon"
                      class="h-5 w-5 shrink-0 text-destructive opacity-0 group-hover:opacity-100"
                      :title="t('redis.deleteKey')"
                      :aria-label="t('redis.deleteKey')"
                      :disabled="selectionBusy"
                      @click="requestKeyDelete(row.node, $event)"
                    >
                      <Trash2 class="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </CustomContextMenu>
            </template>
          </RecycleScroller>
          <div v-if="fuzzyTreeLimitReached" class="shrink-0 border-t px-3 py-2 text-center text-xs text-muted-foreground">
            {{ t("redis.fuzzyTreeLimit", { count: flatKeys.length }) }}
          </div>
          <div v-if="hasMore && !isFetchingAll" class="shrink-0 border-t px-2 py-1.5 flex items-center gap-1.5">
            <Button variant="outline" size="sm" class="h-7 text-xs flex-1" :disabled="loadingMore || loading || searchPending || deletingKeys" @click="loadMore()">
              <Loader2 v-if="loadingMore" class="w-3 h-3 mr-1.5 animate-spin" />
              {{ t("redis.loadMoreKeys") }}
            </Button>
            <Button variant="outline" size="sm" class="h-7 text-xs flex-1" :disabled="loading || searchPending || deletingKeys || !hasMore" @click="fetchAll">
              {{ t("redis.fetchAllKeys") }}
            </Button>
          </div>
          <div v-if="isFetchingAll" class="shrink-0 border-t px-2 py-1.5 space-y-1">
            <div class="text-xs text-muted-foreground text-center">
              {{ fetchAllProgressText }}
            </div>
            <Button variant="destructive" size="sm" class="h-7 text-xs w-full" :disabled="fetchAllStopRequested || deletingKeys" @click="stopFetchAll">
              {{ t("redis.stopFetchAll") }}
            </Button>
          </div>
        </div>
      </Pane>

      <!-- Workspace (right) -->
      <Pane :size="64" :min-size="36">
        <div class="h-full min-w-0 bg-background flex flex-col overflow-hidden">
          <Tabs v-model="activeSidePanel" :unmount-on-hide="false" class="h-full min-h-0 gap-0">
            <div class="h-9 shrink-0 border-b bg-background px-3 flex items-center justify-between">
              <TabsList class="h-7 gap-1 p-0.5">
                <TabsTrigger value="detail" class="h-6 flex-none gap-1.5 rounded-md px-2 text-xs">
                  <KeyRound class="size-3.5" />
                  {{ t("redis.keyDetail") }}
                </TabsTrigger>
                <TabsTrigger value="command" class="h-6 flex-none gap-1.5 rounded-md px-2 text-xs" @click="openCommandPanel">
                  <TerminalSquare class="size-3.5" />
                  {{ t("redis.commandLine") }}
                </TabsTrigger>
                <TabsTrigger value="pubsub" class="h-6 flex-none gap-1.5 rounded-md px-2 text-xs">
                  <Radio class="size-3.5" />
                  {{ t("redis.pubsub") }}
                </TabsTrigger>
                <TabsTrigger value="slowlog" class="h-6 flex-none gap-1.5 rounded-md px-2 text-xs">
                  <Clock class="size-3.5" />
                  {{ t("redis.slowlog") }}
                </TabsTrigger>
              </TabsList>
              <Button v-if="activeSidePanel === 'command'" variant="ghost" size="icon" class="h-6 w-6" :title="t('redis.clearHistory')" @click="clearInMemoryHistory">
                <History class="size-3.5" />
              </Button>
            </div>

            <TabsContent value="detail" class="m-0 min-h-0 flex-1 flex flex-col">
              <RedisValueViewer
                v-if="selectedKey"
                ref="valueViewerRef"
                :key="selectedKey.key_raw"
                :connection-id="connectionId"
                :db="db"
                :key-display="selectedKey.key_display"
                :key-raw="selectedKey.key_raw"
                :metadata="selectedKey"
                @deleted="onKeyDeleted"
                @renamed="onKeyRenamed"
                @loaded="onKeyLoaded"
              />
              <div v-else class="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                {{ t("redis.selectKeyForDetail") }}
              </div>
            </TabsContent>

            <TabsContent value="command" class="m-0 min-h-0 flex-1 flex flex-col">
              <div class="dbx-editor-font-family relative flex min-h-0 flex-1 flex-col bg-[#171b21] text-[13px] leading-5 text-slate-200" @click="onCommandAreaClick">
                <div ref="commandTerminalRef" class="redis-command-terminal min-h-0 flex-1 overflow-auto px-4 pb-3 pt-4">
                  <div class="mb-4 text-slate-400">
                    <span class="text-slate-200">{{ t("redis.commandWelcome") }}</span>
                  </div>

                  <div v-for="entry in commandHistory" :key="entry.id" class="mb-2">
                    <div class="flex min-w-0 items-start gap-2 whitespace-pre-wrap break-words">
                      <span class="shrink-0 text-[#d7ba7d]">{{ entry.prompt }}</span>
                      <span class="min-w-0 text-slate-200">{{ entry.command }}</span>
                    </div>
                    <pre v-if="entry.output" class="ml-0 whitespace-pre-wrap break-words pl-0" :class="entry.error ? 'text-[#ff6b6b]' : 'text-slate-300'">{{ entry.output }}</pre>
                  </div>
                </div>

                <form class="flex shrink-0 items-center gap-2 border-t border-white/10 bg-[#171b21] px-4 py-2" @submit.prevent="executeCommand">
                  <span class="shrink-0 text-[#d7ba7d]">{{ commandPrompt }}</span>
                  <div class="relative min-w-0 flex-1">
                    <div v-if="commandCompletionOpen" class="absolute bottom-[calc(100%+0.5rem)] left-0 z-20 w-full overflow-hidden rounded-md border border-white/15 bg-[#20262f] py-1 shadow-xl">
                      <div v-if="commandDocumentationLoading || commandCompletionLoading" class="flex items-center justify-center px-3 py-2 text-slate-400">
                        <Loader2 class="h-3.5 w-3.5 animate-spin" />
                      </div>
                      <div v-else :id="commandCompletionListboxId" role="listbox" aria-label="Redis command completions" class="max-h-60 overflow-y-auto">
                        <button
                          v-for="(item, index) in commandCompletionItems"
                          :id="`${commandCompletionListboxId}-option-${index}`"
                          :key="`${item.type}:${item.label}:${index}`"
                          type="button"
                          role="option"
                          class="flex w-full items-center gap-3 px-3 py-1.5 text-left text-xs transition-colors"
                          :class="commandCompletionSelectedIndex === index ? 'bg-[#2b3440] text-white' : 'text-slate-200 hover:text-white'"
                          :aria-selected="commandCompletionSelectedIndex === index"
                          :aria-description="item.info"
                          @pointerenter="selectCommandCompletion(index)"
                          @mousedown.prevent
                          @click.stop="acceptCommandCompletion(index)"
                        >
                          <span class="min-w-0 flex-1">
                            <span class="block truncate font-mono">{{ item.label }}</span>
                            <span v-if="item.summary" class="block truncate text-[11px] text-slate-400">{{ item.summary }}</span>
                            <span v-if="item.apply && item.apply !== item.label" class="block truncate text-[11px] text-slate-500">{{ item.apply }}</span>
                          </span>
                          <span v-if="item.detail" class="shrink-0 text-slate-400">{{ item.detail }}</span>
                        </button>
                      </div>
                    </div>
                    <input
                      v-model="commandText"
                      data-redis-command-input
                      class="dbx-editor-font-family min-w-0 w-full border-0 bg-transparent p-0 text-[13px] text-slate-200 caret-[#d7ba7d] outline-none placeholder:text-slate-500"
                      :class="{ 'opacity-50': commandRunning }"
                      :readonly="commandRunning"
                      autocomplete="off"
                      autocapitalize="off"
                      spellcheck="false"
                      aria-autocomplete="list"
                      aria-haspopup="listbox"
                      :aria-controls="commandCompletionOpen ? commandCompletionListboxId : undefined"
                      :aria-activedescendant="commandCompletionOpen ? commandCompletionActiveDescendant : undefined"
                      :aria-expanded="commandCompletionOpen"
                      @click.stop="onCommandInputClick"
                      @input="onCommandInput"
                      @keydown="onCommandInputKeydown"
                    />
                  </div>
                  <Loader2 v-if="commandRunning" class="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500" />
                </form>
              </div>
            </TabsContent>

            <TabsContent value="pubsub" class="m-0 min-h-0 flex-1 flex flex-col">
              <RedisPubSubPanel :connection-id="connectionId" :db="db" />
            </TabsContent>

            <TabsContent value="slowlog" class="m-0 min-h-0 flex-1 flex flex-col">
              <RedisSlowlogPanel :connection-id="connectionId" :db="db" />
            </TabsContent>
          </Tabs>
        </div>
      </Pane>
    </Splitpanes>

    <DangerConfirmDialog v-model:open="showDangerConfirm" :message="dangerMessage" :details="dangerDetails" :confirm-label="dangerConfirmLabel" :loading="deletingKeys" :close-on-confirm="pendingDanger?.kind !== 'delete-keys'" @confirm="applyDangerAction" />

    <Dialog :open="showCreateKeyDialog" @update:open="onCreateKeyDialogOpenChange">
      <DialogContent class="sm:max-w-md" :show-close-button="!creatingKey" :style="editorFontFamilyStyle">
        <DialogHeader>
          <DialogTitle>{{ t("redis.createKey") }}</DialogTitle>
        </DialogHeader>

        <div class="grid gap-3">
          <label class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.createKeyName") }}</span>
            <Input v-model="createKeyName" class="dbx-editor-font-family h-8 text-xs" :disabled="creatingKey || createKeyPartiallyWritten" :placeholder="t('redis.createKeyNamePlaceholder')" @keydown.enter="createRedisKey" />
          </label>

          <label class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.createKeyType") }}</span>
            <Select :model-value="createKeyType" :disabled="creatingKey || createKeyPartiallyWritten" @update:open="onCreateKeyTypeSelectOpen" @update:model-value="onCreateKeyTypeChange">
              <SelectTrigger class="h-8 text-xs" @keydown.capture="onCreateKeyTypeTriggerKeydown">
                <SelectValue />
              </SelectTrigger>
              <SelectContent data-naked-surface class="w-auto max-w-[calc(100vw-1rem)] border-0 bg-transparent p-0 shadow-none ring-0">
                <div class="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-start" @keydown.capture="onCreateKeyTypeSelectKeydown">
                  <div ref="createKeyTypeListCard" class="min-w-40 rounded-md border bg-popover p-1 shadow-md" @scroll="updateCreateKeyTypeHelpOffset">
                    <SelectItem v-for="option in createKeyTypeOptions" :key="option.value" :value="option.value" :data-option-help-value="option.value" @pointerenter="activateCreateKeyTypeHelp(option.value)" @focus="onCreateKeyTypeOptionFocus(option.value)">
                      {{ option.label }}
                    </SelectItem>
                  </div>
                  <OptionHelpPanel v-if="activeCreateKeyTypeHelpContent" ref="createKeyTypeHelpPanel" :content="activeCreateKeyTypeHelpContent" :offset-top="createKeyTypeHelpOffsetTop" />
                </div>
              </SelectContent>
            </Select>
          </label>

          <label v-if="createKeyType === 'hash' && createKeyRawMode" class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.createField") }}</span>
            <Input v-model="createKeyField" class="dbx-editor-font-family h-8 text-xs" :disabled="creatingKey" :placeholder="t('redis.createFieldPlaceholder')" @keydown.enter="createRedisKey" />
          </label>

          <label v-if="createKeyType === 'zset' && createKeyRawMode" class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.createScore") }}</span>
            <Input v-model="createKeyScore" class="dbx-editor-font-family h-8 text-xs" :disabled="creatingKey" placeholder="0" @keydown.enter="createRedisKey" />
          </label>

          <div class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.expiry") }}</span>
            <Select v-model="createKeyExpiryMode" :disabled="creatingKey">
              <SelectTrigger class="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{{ t("redis.expiryNone") }}</SelectItem>
                <SelectItem value="ttl">{{ t("redis.expiryTtl") }}</SelectItem>
                <SelectItem value="at">{{ t("redis.expiryAt") }}</SelectItem>
              </SelectContent>
            </Select>
            <label v-if="createKeyExpiryMode === 'ttl'" class="grid gap-1.5 text-xs font-medium">
              <span>{{ t("redis.createKeyTtl") }}</span>
              <Input v-model="createKeyTtl" class="dbx-editor-font-family h-8 text-xs" :disabled="creatingKey" inputmode="numeric" :placeholder="t('redis.createKeyTtlPlaceholder')" @keydown.enter="createRedisKey" />
            </label>
            <label v-else-if="createKeyExpiryMode === 'at'" class="grid gap-1.5 text-xs font-medium">
              <span>{{ t("redis.expiryAt") }}</span>
              <DateTimePicker v-model="createKeyExpireAt" full-width :locale="locale" :disabled="creatingKey" />
            </label>
          </div>

          <!-- Raw mode toggle (non-string, non-stream, non-json types) -->
          <div v-if="createKeyType !== 'string' && createKeyType !== 'stream' && createKeyType !== 'json'" class="flex items-center justify-end gap-1.5">
            <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span>{{ t("redis.createKeyRawMode") }}</span>
              <Switch size="sm" v-model="createKeyRawMode" :disabled="creatingKey || createKeyPartiallyWritten" />
            </label>
          </div>

          <!-- Structured entries (non-string, non-json, non-raw mode) -->
          <template v-if="createKeyType !== 'string' && createKeyType !== 'json' && !createKeyRawMode">
            <!-- Stream entry ID -->
            <label v-if="createKeyType === 'stream'" class="grid gap-1.5 text-xs font-medium">
              <span>{{ t("redis.createKeyEntryId") }}</span>
              <Input v-model="createKeyEntryId" class="dbx-editor-font-family h-8 text-xs font-mono" :disabled="creatingKey" placeholder="*" />
            </label>

            <div class="grid gap-2">
              <div class="flex items-center justify-between">
                <span class="text-xs font-medium">{{ t("redis.createKeyEntries") }}</span>
                <Button variant="outline" size="sm" class="h-6 gap-1 text-xs" :disabled="creatingKey" @click="addEntry">
                  <Plus class="h-3 w-3" />
                  {{ t("redis.createKeyAddEntry") }}
                </Button>
              </div>
              <div v-for="(entry, idx) in createKeyEntries" :key="entry.id" class="flex items-start gap-2">
                <!-- Hash / Stream: field + value -->
                <template v-if="createKeyType === 'hash' || createKeyType === 'stream'">
                  <Input v-model="entry.field" class="dbx-editor-font-family h-8 w-2/5 text-xs" :disabled="creatingKey" :placeholder="t('redis.createFieldPlaceholder')" />
                  <Input v-model="entry.value" class="dbx-editor-font-family h-8 flex-1 text-xs" :disabled="creatingKey" :placeholder="t('redis.createValuePlaceholder')" />
                </template>
                <!-- ZSet: score + member -->
                <template v-else-if="createKeyType === 'zset'">
                  <Input v-model="entry.score" class="dbx-editor-font-family h-8 w-20 text-xs" :disabled="creatingKey" type="number" step="any" placeholder="0" />
                  <Input v-model="entry.value" class="dbx-editor-font-family h-8 flex-1 text-xs" :disabled="creatingKey" :placeholder="t('redis.createMember')" />
                </template>
                <!-- List / Set: single value -->
                <template v-else>
                  <Input v-model="entry.value" class="dbx-editor-font-family h-8 flex-1 text-xs" :disabled="creatingKey" :placeholder="t('redis.createValuePlaceholder')" />
                </template>
                <Button variant="ghost" size="sm" class="h-8 w-8 shrink-0 p-0 text-muted-foreground hover:text-destructive" :disabled="creatingKey || createKeyEntries.length <= 1" @click="removeEntry(idx)">
                  <Trash2 class="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </template>

          <!-- Raw value textarea (string, json, or raw mode for other types) -->
          <label v-if="createKeyType === 'string' || createKeyType === 'json' || createKeyRawMode" class="grid gap-1.5 text-xs font-medium">
            <span>{{ t(createKeyType === "set" || createKeyType === "zset" ? "redis.createMember" : "redis.createValue") }}</span>
            <textarea v-model="createKeyValue" class="dbx-editor-font-family min-h-28 resize-y rounded-md border bg-background p-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring" :disabled="creatingKey" spellcheck="false" :placeholder="t('redis.createValuePlaceholder')" />
          </label>

          <p v-if="createKeyError" class="text-xs text-destructive">{{ createKeyError }}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" :disabled="creatingKey" @click="showCreateKeyDialog = false">
            {{ t("dangerDialog.cancel") }}
          </Button>
          <Button :disabled="creatingKey || checkingJsonModule || (createKeyType === 'json' && jsonModuleAvailable !== true)" @click="createRedisKey">
            <Loader2 v-if="creatingKey" class="h-4 w-4 animate-spin" />
            <Plus v-else class="h-4 w-4" />
            {{ t("redis.createKeySubmit") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.redis-key-pane {
  container-type: inline-size;
}

.redis-key-toolbar-header {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.375rem;
}

.redis-search-mode-group,
.redis-key-toolbar-actions {
  flex-wrap: nowrap;
  min-width: 0;
}

.redis-search-mode-group {
  justify-self: start;
}

.redis-search-mode-button {
  flex: 0 0 auto;
  white-space: nowrap;
}

.redis-key-count {
  min-width: 0;
  text-align: right;
  white-space: nowrap;
}

.redis-key-search-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.375rem;
}

@container (max-width: 320px) {
  .redis-key-toolbar-header {
    grid-template-columns: auto auto minmax(0, 1fr);
  }

  .redis-key-count {
    grid-column: 1 / -1;
    grid-row: 2;
    text-align: left;
  }

  .redis-key-toolbar-actions {
    grid-column: 2;
    grid-row: 1;
  }
}

@container (max-width: 240px) {
  .redis-search-mode-group {
    grid-column: 1 / -1;
    grid-row: 1;
  }

  .redis-key-count {
    grid-column: 1;
    grid-row: 2;
  }

  .redis-key-toolbar-actions {
    grid-column: 2;
    grid-row: 2;
  }

  .redis-fuzzy-label {
    display: none;
  }

  .redis-fuzzy-icon {
    margin-right: 0;
  }
}

.redis-key-scroller {
  will-change: scroll-position;
  contain: content;
}

.redis-key-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.redis-workspace-splitpanes > :deep(.splitpanes__pane:first-child) {
  min-width: min(256px, 64%);
}

.redis-workspace-splitpanes :deep(.splitpanes--vertical > .splitpanes__splitter) {
  width: 1px !important;
  border-left: 0;
  background: var(--border);
}

.redis-workspace-splitpanes :deep(.splitpanes__splitter:hover) {
  background: var(--primary) !important;
}

.redis-command-terminal {
  user-select: text;
  -webkit-user-select: text;
}
</style>

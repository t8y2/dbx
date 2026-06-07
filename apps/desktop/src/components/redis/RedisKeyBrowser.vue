<script setup lang="ts">
import { computed, nextTick, ref, onMounted, onUnmounted, onActivated, onDeactivated, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Search,
  RefreshCw,
  Loader2,
  ChevronRight,
  ChevronDown,
  FolderClosed,
  FolderOpen,
  Trash2,
  Plus,
  KeyRound,
  TerminalSquare,
  Asterisk,
} from "@lucide/vue";
import { RecycleScroller } from "vue-virtual-scroller";
import "vue-virtual-scroller/dist/vue-virtual-scroller.css";
import { Splitpanes, Pane } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import RedisValueViewer from "./RedisValueViewer.vue";
import * as api from "@/lib/api";
import type { RedisKeyInfo, RedisScanResult } from "@/lib/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import {
  buildRedisKeyTree,
  collectExpandedGroupIds,
  collectRedisGroupKeyRaws,
  flattenVisibleRedisKeyTree,
  mergeKeysIntoRedisKeyTree,
  type RedisKeyTreeNode,
} from "@/lib/redisKeyTree";
import { classifyRedisCommandSafety } from "@/lib/redisCommandSafety";
import { isRedisClearScreenCommand, nextRedisCommandDb, redisKeyTextToRaw } from "@/lib/redisCommandSession";
import { formatRedisCommandResult, formatRedisStringValue } from "@/lib/redisValuePresentation";
import { isCancelSearchShortcut } from "@/lib/keyboardShortcuts";
import { useEditorFontFamilyStyle } from "@/composables/useEditorFontFamilyStyle";
import { useToast } from "@/composables/useToast";
import { redisKeySearchPattern } from "@/lib/redisKeyPattern";

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const editorFontFamilyStyle = useEditorFontFamilyStyle();

type RedisSearchMode = "key" | "value";
type RedisCreateKeyType = "string" | "hash" | "list" | "set" | "zset";
type RedisSidePanel = "detail" | "command";
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
}>();

const flatKeys = ref<RedisKeyInfo[]>([]);
const treeKeys = ref<RedisKeyTreeNode[]>([]);
const loading = ref(false);
const loadingMore = ref(false);
const isFetchingAll = ref(false);
const rootRef = ref<HTMLElement>();
const commandTerminalRef = ref<HTMLElement>();
const searchPattern = ref("");
const searchMode = ref<RedisSearchMode>("key");
const fuzzyKeySearch = ref(false);
const selectedKeyRaw = ref<string | null>(null);
const hasMore = ref(false);
const scanCursor = ref(0);
const expandedGroupIds = ref<Set<string>>(new Set());
const checkedKeys = ref<Set<string>>(new Set());
const pendingDanger = ref<
  { kind: "delete-keys"; title: string; keyRaws: string[] } | { kind: "command"; command: string } | null
>(null);
const showDangerConfirm = ref(false);
const commandText = ref("");
const commandRunning = ref(false);
const commandDb = ref(props.db);
const commandHistory = ref<RedisCommandHistoryEntry[]>([]);
const activeSidePanel = ref<RedisSidePanel>("detail");
const showCreateKeyDialog = ref(false);
const creatingKey = ref(false);
const createKeyName = ref("");
const createKeyType = ref<RedisCreateKeyType>("string");
const createKeyValue = ref("");
const createKeyField = ref("");
const createKeyScore = ref("0");
const createKeyError = ref("");
let searchRequestId = 0;
let redisBrowserIsActive = true;
let redisDbFlushedListenerRegistered = false;

const valueQuery = computed(() => searchPattern.value.trim());
const effectivePattern = computed(() =>
  searchMode.value === "key" ? redisKeySearchPattern(searchPattern.value, fuzzyKeySearch.value) : "*",
);
const isSearchMode = computed(() =>
  searchMode.value === "key" ? effectivePattern.value !== "*" : valueQuery.value !== "",
);
const searchPlaceholder = computed(() =>
  searchMode.value === "key"
    ? fuzzyKeySearch.value
      ? t("redis.fuzzyPattern")
      : t("redis.pattern")
    : t("redis.valueSearchPlaceholder"),
);
const loadingEmptyText = computed(() =>
  searchMode.value === "value" && valueQuery.value ? t("redis.searchingValues") : t("redis.loadingKeys"),
);
const lastTotalKeys = ref(0);
const fetchAllProgressText = computed(() => {
  if (!isFetchingAll.value) return "";
  if (lastTotalKeys.value > 0) {
    return t("redis.fetchAllProgress", { loaded: flatKeys.value.length, total: lastTotalKeys.value });
  }
  return t("redis.fetchAllProgressUnknown", { loaded: flatKeys.value.length });
});
const selectedKey = computed(() => flatKeys.value.find((key) => key.key_raw === selectedKeyRaw.value) ?? null);
const dangerDetails = computed(() => {
  if (!pendingDanger.value) return "";
  if (pendingDanger.value.kind === "delete-keys") {
    return t("redis.deleteGroupDetails", {
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
const commandPrompt = computed(() => `db${commandDb.value}>`);
const createKeyTypeOptions = computed<{ value: RedisCreateKeyType; label: string }[]>(() => [
  { value: "string", label: "String" },
  { value: "hash", label: "Hash" },
  { value: "list", label: "List" },
  { value: "set", label: "Set" },
  { value: "zset", label: "Sorted Set" },
]);
const visibleRows = computed(() =>
  flattenVisibleRedisKeyTree(treeKeys.value, expandedGroupIds.value).map((row) => ({
    ...row,
    id: row.node.id,
  })),
);
let commandHistoryId = 0;

function countLeaves(node: RedisKeyTreeNode): number {
  if (node.kind === "leaf") return 1;
  return node.children.reduce((sum, child) => sum + countLeaves(child), 0);
}

function rebuildTree(expandAll = false) {
  const nextTree = buildRedisKeyTree(flatKeys.value, props.db);
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

  if (selectedKeyRaw.value && !flatKeys.value.some((key) => key.key_raw === selectedKeyRaw.value)) {
    selectedKeyRaw.value = null;
  }
}

function mergeTree(newKeys: RedisKeyInfo[]) {
  if (newKeys.length === 0) return;
  treeKeys.value = mergeKeysIntoRedisKeyTree(treeKeys.value, newKeys, props.db);

  const availableExpanded = collectExpandedGroupIds(treeKeys.value);
  const nextExpanded = new Set<string>();
  for (const id of expandedGroupIds.value) {
    if (availableExpanded.has(id)) nextExpanded.add(id);
  }
  expandedGroupIds.value = nextExpanded;

  if (selectedKeyRaw.value && !flatKeys.value.some((key) => key.key_raw === selectedKeyRaw.value)) {
    selectedKeyRaw.value = null;
  }
}

async function fetchScanPage(): Promise<RedisScanResult> {
  const pageSize = settingsStore.editorSettings.redisScanPageSize;
  return searchMode.value === "value"
    ? await api.redisScanValues(props.connectionId, props.db, scanCursor.value, "*", valueQuery.value, pageSize)
    : await api.redisScanKeys(props.connectionId, props.db, scanCursor.value, effectivePattern.value, pageSize);
}

function appendScanResult(result: RedisScanResult) {
  const existingKeys = new Set(flatKeys.value.map((key) => key.key_raw));
  const newKeys = result.keys.filter((key) => !existingKeys.has(key.key_raw));
  flatKeys.value = [...flatKeys.value, ...newKeys];
  scanCursor.value = result.cursor;
  hasMore.value = result.cursor !== 0;
  lastTotalKeys.value = result.total_keys;

  if (treeKeys.value.length === 0) {
    rebuildTree(isSearchMode.value);
  } else {
    mergeTree(newKeys);
  }

  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : flatKeys.value.length,
    total: result.total_keys,
  });
}

async function scanNextPage(requestId = searchRequestId): Promise<boolean> {
  const result = await fetchScanPage();
  if (requestId !== searchRequestId) return false;
  appendScanResult(result);
  return true;
}

async function streamValueSearch(requestId: number) {
  while (requestId === searchRequestId && searchMode.value === "value" && valueQuery.value && hasMore.value) {
    const applied = await scanNextPage(requestId);
    if (!applied) return;
  }
}

async function fillInitialKeyBatch(requestId: number) {
  const targetCount = Math.max(1, settingsStore.editorSettings.redisScanPageSize);
  let rounds = 0;
  while (
    requestId === searchRequestId &&
    searchMode.value === "key" &&
    hasMore.value &&
    flatKeys.value.length < targetCount
  ) {
    const beforeCount = flatKeys.value.length;
    const applied = await scanNextPage(requestId);
    if (!applied) return;
    rounds += 1;
    if (flatKeys.value.length >= targetCount) return;
    if (rounds >= 12 && flatKeys.value.length === beforeCount) return;
    if (rounds >= 24) return;
  }
}

async function loadKeys() {
  if (!redisBrowserIsActive) return;
  const requestId = ++searchRequestId;
  isFetchingAll.value = false;
  loading.value = true;
  flatKeys.value = [];
  treeKeys.value = [];
  selectedKeyRaw.value = null;
  checkedKeys.value = new Set();
  expandedGroupIds.value = new Set();
  scanCursor.value = 0;
  try {
    if (searchMode.value === "value" && !valueQuery.value) {
      hasMore.value = false;
      return;
    }
    const applied = await scanNextPage(requestId);
    if (applied) {
      if (searchMode.value === "value") {
        await streamValueSearch(requestId);
      } else {
        await fillInitialKeyBatch(requestId);
      }
    }
  } finally {
    if (requestId === searchRequestId) {
      loading.value = false;
    }
  }
}

async function loadMore() {
  if (!hasMore.value || loadingMore.value) return;
  const requestId = searchRequestId;
  loadingMore.value = true;
  try {
    await scanNextPage(requestId);
  } finally {
    loadingMore.value = false;
  }
}

async function fetchAll() {
  if (!hasMore.value || isFetchingAll.value) return;
  const requestId = searchRequestId;
  isFetchingAll.value = true;
  try {
    while (requestId === searchRequestId && isFetchingAll.value && hasMore.value) {
      const applied = await scanNextPage(requestId);
      if (!applied) break;
    }
  } finally {
    if (requestId === searchRequestId) {
      isFetchingAll.value = false;
    }
  }
}

function stopFetchAll() {
  isFetchingAll.value = false;
}

function toggleGroup(groupId: string) {
  const next = new Set(expandedGroupIds.value);
  if (next.has(groupId)) next.delete(groupId);
  else next.add(groupId);
  expandedGroupIds.value = next;
}

function onRowClick(node: RedisKeyTreeNode) {
  if (node.kind === "group") {
    toggleGroup(node.id);
    return;
  }

  selectedKeyRaw.value = node.keyRaw;
  activeSidePanel.value = "detail";
}

function onKeyDeleted() {
  if (!selectedKeyRaw.value) return;
  flatKeys.value = flatKeys.value.filter((key) => key.key_raw !== selectedKeyRaw.value);
  selectedKeyRaw.value = null;
  rebuildTree(false);
  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : flatKeys.value.length,
    totalDelta: -1,
  });
}

function toggleCheck(keyRaw: string, event: Event) {
  event.stopPropagation();
  const next = new Set(checkedKeys.value);
  if (next.has(keyRaw)) next.delete(keyRaw);
  else next.add(keyRaw);
  checkedKeys.value = next;
}

function requestBatchDelete() {
  if (checkedKeys.value.size === 0) return;
  pendingDanger.value = { kind: "delete-keys", title: t("redis.selectedKeys"), keyRaws: [...checkedKeys.value] };
  showDangerConfirm.value = true;
}

function requestGroupDelete(node: RedisKeyTreeNode, event: Event) {
  event.stopPropagation();
  if (node.kind !== "group") return;
  const keyRaws = collectRedisGroupKeyRaws(node);
  if (keyRaws.length === 0) return;
  pendingDanger.value = { kind: "delete-keys", title: node.pathSegments.join(":"), keyRaws };
  showDangerConfirm.value = true;
}

function resetLoadedKeys() {
  flatKeys.value = [];
  treeKeys.value = [];
  selectedKeyRaw.value = null;
  checkedKeys.value = new Set();
  expandedGroupIds.value = new Set();
  hasMore.value = false;
}

async function deleteKeyRaws(keys: string[]) {
  const deletedCount = await api.redisDeleteKeys(props.connectionId, props.db, keys);
  const deleted = new Set(keys);
  flatKeys.value = flatKeys.value.filter((k) => !deleted.has(k.key_raw));
  if (selectedKeyRaw.value && deleted.has(selectedKeyRaw.value)) {
    selectedKeyRaw.value = null;
  }
  checkedKeys.value = new Set();
  rebuildTree(false);
  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : flatKeys.value.length,
    totalDelta: -deletedCount,
  });
}

function scrollCommandTerminalToEnd() {
  void nextTick(() => {
    if (!commandTerminalRef.value) return;
    commandTerminalRef.value.scrollTop = commandTerminalRef.value.scrollHeight;
  });
}

function appendCommandHistory(entry: Omit<RedisCommandHistoryEntry, "id">) {
  commandHistory.value = [...commandHistory.value, { id: ++commandHistoryId, ...entry }];
  scrollCommandTerminalToEnd();
}

async function runRedisCommand(command: string) {
  const prompt = commandPrompt.value;
  commandRunning.value = true;
  try {
    const result = await api.redisExecuteCommand(props.connectionId, commandDb.value, command);
    appendCommandHistory({
      prompt,
      command,
      output: formatRedisCommandResult(result.value),
      error: false,
    });
    commandDb.value = nextRedisCommandDb(commandDb.value, command, result.value);
    if (result.safety === "confirm") {
      await loadKeys();
    }
  } catch (error) {
    appendCommandHistory({
      prompt,
      command,
      output: error instanceof Error ? error.message : String(error),
      error: true,
    });
  } finally {
    commandRunning.value = false;
    scrollCommandTerminalToEnd();
  }
}

async function openCommandPanel() {
  activeSidePanel.value = "command";
  await nextTick();
  getCommandInput()?.focus();
}

function resetCreateKeyForm() {
  createKeyName.value = "";
  createKeyType.value = "string";
  createKeyValue.value = "";
  createKeyField.value = "";
  createKeyScore.value = "0";
  createKeyError.value = "";
}

function openCreateKeyDialog() {
  resetCreateKeyForm();
  showCreateKeyDialog.value = true;
}

function createdKeyPreview(value: any): string {
  if (typeof value === "string") {
    const text = formatRedisStringValue(value).replace(/\s+/g, " ").trim();
    return text.length > 160 ? `${text.slice(0, 160)}…` : text;
  }
  if (Array.isArray(value) && value.length > 0) return String(value.length);
  return "";
}

function upsertCreatedKey(value: any) {
  const keyInfo: RedisKeyInfo = {
    key_display: value.key_display,
    key_raw: value.key_raw,
    key_type: value.key_type,
    ttl: value.ttl,
    size: typeof value.value === "string" ? value.value.length : (value.total ?? 0),
    value_preview: createdKeyPreview(value.value),
  };
  const existingIndex = flatKeys.value.findIndex((key) => key.key_raw === keyInfo.key_raw);
  if (existingIndex >= 0) {
    flatKeys.value = flatKeys.value.map((key, index) => (index === existingIndex ? keyInfo : key));
  } else {
    flatKeys.value = [keyInfo, ...flatKeys.value];
  }
  selectedKeyRaw.value = keyInfo.key_raw;
  rebuildTree(isSearchMode.value);
  connectionStore.updateRedisDbKeyStats(props.connectionId, props.db, {
    loaded: isSearchMode.value ? undefined : flatKeys.value.length,
    totalDelta: existingIndex >= 0 ? 0 : 1,
  });
}

async function createRedisKey() {
  const keyName = createKeyName.value.trim();
  if (!keyName) {
    createKeyError.value = t("redis.createKeyNameRequired");
    toast(t("redis.createKeyNameRequired"), 3000);
    return;
  }
  if (createKeyType.value === "hash" && !createKeyField.value.trim()) {
    createKeyError.value = t("redis.createFieldRequired");
    toast(t("redis.createFieldRequired"), 3000);
    return;
  }
  const score = Number.parseFloat(createKeyScore.value || "0");
  if (createKeyType.value === "zset" && Number.isNaN(score)) {
    createKeyError.value = t("redis.createScoreInvalid");
    toast(t("redis.createScoreInvalid"), 3000);
    return;
  }

  creatingKey.value = true;
  createKeyError.value = "";
  try {
    const keyRaw = redisKeyTextToRaw(keyName);
    if (createKeyType.value === "string") {
      await api.redisSetString(props.connectionId, props.db, keyRaw, createKeyValue.value);
    } else if (createKeyType.value === "hash") {
      await api.redisHashSet(props.connectionId, props.db, keyRaw, createKeyField.value, createKeyValue.value);
    } else if (createKeyType.value === "list") {
      await api.redisListPush(props.connectionId, props.db, keyRaw, createKeyValue.value);
    } else if (createKeyType.value === "set") {
      await api.redisSetAdd(props.connectionId, props.db, keyRaw, createKeyValue.value);
    } else if (createKeyType.value === "zset") {
      await api.redisZadd(props.connectionId, props.db, keyRaw, createKeyValue.value, score);
    }
    const created = await api.redisGetValue(props.connectionId, props.db, keyRaw);
    upsertCreatedKey(created);
    showCreateKeyDialog.value = false;
  } catch (error) {
    createKeyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    creatingKey.value = false;
  }
}

async function executeCommand() {
  const command = commandText.value.trim();
  if (!command) {
    appendCommandHistory({
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
    scrollCommandTerminalToEnd();
    return;
  }

  const safety = classifyRedisCommandSafety(command);
  if (safety === "blocked") {
    appendCommandHistory({
      prompt: commandPrompt.value,
      command,
      output: t("redis.commandBlocked"),
      error: true,
    });
    commandText.value = "";
    return;
  }
  if (safety === "confirm") {
    pendingDanger.value = { kind: "command", command };
    showDangerConfirm.value = true;
    commandText.value = "";
    return;
  }
  commandText.value = "";
  await runRedisCommand(command);
}

async function applyDangerAction() {
  const pending = pendingDanger.value;
  pendingDanger.value = null;
  showDangerConfirm.value = false;
  if (!pending) return;

  if (pending.kind === "delete-keys") {
    await deleteKeyRaws(pending.keyRaws);
  } else {
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

function onSearchInput() {
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(loadKeys, 400);
}

function setSearchMode(mode: RedisSearchMode) {
  if (searchMode.value === mode) return;
  searchMode.value = mode;
  void loadKeys();
}

function toggleFuzzyKeySearch() {
  fuzzyKeySearch.value = !fuzzyKeySearch.value;
  if (searchMode.value === "key") void loadKeys();
}

function getSearchInput(): HTMLInputElement | null {
  return rootRef.value?.querySelector<HTMLInputElement>("[data-redis-search-input]") ?? null;
}

function getCommandInput(): HTMLInputElement | null {
  return rootRef.value?.querySelector<HTMLInputElement>("[data-redis-command-input]") ?? null;
}

function focusSearch(): boolean {
  const input = getSearchInput();
  if (!input) return false;
  input.focus();
  input.select();
  return true;
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    void loadKeys();
    return;
  }
  if (!isCancelSearchShortcut(event)) return;
  event.preventDefault();
  searchPattern.value = "";
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
  redisBrowserIsActive = false;
  searchRequestId++;
  isFetchingAll.value = false;
  loading.value = false;
  loadingMore.value = false;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = null;
  unregisterRedisDbFlushedListener();
}

function resumeRedisBrowserBackgroundWork() {
  redisBrowserIsActive = true;
  registerRedisDbFlushedListener();
}

onMounted(() => {
  resumeRedisBrowserBackgroundWork();
  void loadKeys();
});

onActivated(resumeRedisBrowserBackgroundWork);

onDeactivated(pauseRedisBrowserBackgroundWork);

onUnmounted(pauseRedisBrowserBackgroundWork);

watch(
  () => props.db,
  (db) => {
    commandDb.value = db;
  },
);

defineExpose({ focusSearch });
</script>

<template>
  <div ref="rootRef" class="h-full" :style="editorFontFamilyStyle">
    <Splitpanes class="redis-workspace-splitpanes h-full">
      <!-- Key tree (left) -->
      <Pane :size="36" :min-size="24">
        <div class="relative h-full flex flex-col overflow-hidden">
          <!-- Toolbar -->
          <div class="h-9 flex items-center gap-1 px-2 border-b shrink-0">
            <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <div class="h-6 flex rounded-md border bg-muted/30 p-0.5 shrink-0" role="group">
              <button
                type="button"
                class="h-5 px-2 text-xs rounded-sm transition-colors"
                :class="
                  searchMode === 'key'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                "
                @click="setSearchMode('key')"
              >
                {{ t("redis.searchByKey") }}
              </button>
              <button
                type="button"
                class="h-5 px-2 text-xs rounded-sm transition-colors"
                :class="
                  searchMode === 'value'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                "
                @click="setSearchMode('value')"
              >
                {{ t("redis.searchByValue") }}
              </button>
            </div>
            <Input
              v-model="searchPattern"
              data-redis-search-input
              class="h-6 text-xs border-0 shadow-none focus-visible:ring-0"
              :placeholder="searchPlaceholder"
              @input="onSearchInput"
              @keydown="onSearchKeydown"
            />
            <Button
              v-if="searchMode === 'key'"
              variant="ghost"
              size="sm"
              class="h-6 shrink-0 px-2 text-xs"
              :class="fuzzyKeySearch ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'"
              :title="t('redis.fuzzyMatchTitle')"
              :aria-pressed="fuzzyKeySearch"
              @click="toggleFuzzyKeySearch"
            >
              <Asterisk class="h-3 w-3 mr-1" />
              {{ t("redis.fuzzyMatch") }}
            </Button>
            <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" @click="loadKeys">
              <Loader2 v-if="loading" class="h-3 w-3 animate-spin" />
              <RefreshCw v-else class="h-3 w-3" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              class="h-6 w-6 shrink-0"
              :title="t('redis.createKey')"
              @click="openCreateKeyDialog"
            >
              <Plus class="h-3 w-3" />
            </Button>
            <span class="text-xs text-muted-foreground shrink-0 ml-1">{{
              loading && flatKeys.length === 0 ? loadingEmptyText : t("redis.keys", { count: flatKeys.length })
            }}</span>
            <Button
              v-if="checkedKeys.size > 0"
              variant="ghost"
              size="sm"
              class="h-6 text-xs text-destructive shrink-0 ml-1"
              @click="requestBatchDelete"
            >
              <Trash2 class="w-3 h-3 mr-1" />{{ checkedKeys.size }}
            </Button>
          </div>

          <div
            v-if="flatKeys.length === 0 && !loading"
            class="flex-1 flex items-center justify-center text-muted-foreground text-xs"
          >
            {{ t("redis.noKeys") }}
          </div>
          <div
            v-else-if="loading && flatKeys.length === 0"
            class="flex-1 flex items-center justify-center gap-2 text-muted-foreground text-xs"
          >
            <Loader2 class="w-3.5 h-3.5 animate-spin" />
            <span>{{ loadingEmptyText }}</span>
          </div>
          <RecycleScroller
            v-else
            class="redis-key-scroller flex-1"
            :items="visibleRows"
            :item-size="30"
            :buffer="600"
            :skip-hover="true"
            key-field="id"
          >
            <template #default="{ item: row }">
              <div
                class="flex items-center gap-2 border-b px-3 text-[13px] cursor-pointer hover:bg-accent/50 group"
                :class="{ 'bg-accent': row.node.kind === 'leaf' && selectedKeyRaw === row.node.keyRaw }"
                :style="{ height: '30px' }"
                @click="onRowClick(row.node)"
              >
                <div
                  class="min-w-0 flex flex-1 items-center gap-1 overflow-hidden"
                  :style="{ paddingLeft: `${12 + row.depth * 16}px` }"
                >
                  <template v-if="row.node.kind === 'group'">
                    <component
                      :is="expandedGroupIds.has(row.node.id) ? ChevronDown : ChevronRight"
                      class="w-3 h-3 shrink-0 text-muted-foreground"
                    />
                    <component
                      :is="expandedGroupIds.has(row.node.id) ? FolderOpen : FolderClosed"
                      class="w-3 h-3 shrink-0 text-amber-500"
                    />
                    <span class="dbx-editor-font-family truncate">{{ row.node.label }}</span>
                    <span class="text-muted-foreground ml-1">({{ countLeaves(row.node) }})</span>
                  </template>
                  <template v-else>
                    <span class="relative flex h-4 w-4 shrink-0 items-center justify-center">
                      <KeyRound
                        class="h-3.5 w-3.5 text-muted-foreground/70 transition-opacity group-hover:opacity-0"
                        :class="{ 'opacity-0': checkedKeys.has(row.node.keyRaw) }"
                      />
                      <input
                        type="checkbox"
                        class="absolute h-3.5 w-3.5 accent-primary cursor-pointer opacity-0 group-hover:opacity-100"
                        :class="{ 'opacity-100': checkedKeys.has(row.node.keyRaw) }"
                        :checked="checkedKeys.has(row.node.keyRaw)"
                        @click="toggleCheck(row.node.keyRaw, $event)"
                      />
                    </span>
                    <span class="dbx-editor-font-family truncate">{{ row.node.label }}</span>
                  </template>
                </div>

                <div class="flex shrink-0 items-center justify-end gap-1">
                  <Badge
                    v-if="row.node.kind === 'leaf'"
                    variant="outline"
                    class="text-xs px-1.5 py-0"
                    :class="typeColor(row.node.keyType)"
                    >{{ row.node.keyType }}</Badge
                  >
                  <Button
                    v-if="row.node.kind === 'group'"
                    variant="ghost"
                    size="icon"
                    class="h-5 w-5 shrink-0 text-destructive opacity-0 group-hover:opacity-100"
                    :title="t('redis.deleteGroup')"
                    @click="requestGroupDelete(row.node, $event)"
                  >
                    <Trash2 class="h-3 w-3" />
                  </Button>
                </div>
              </div>
            </template>
          </RecycleScroller>
          <div v-if="hasMore && !isFetchingAll" class="shrink-0 border-t px-2 py-1.5 flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              class="h-7 text-xs flex-1"
              :disabled="loadingMore || loading"
              @click="loadMore"
            >
              <Loader2 v-if="loadingMore" class="w-3 h-3 mr-1.5 animate-spin" />
              {{ t("redis.loadMoreKeys") }}
            </Button>
            <Button
              variant="outline"
              size="sm"
              class="h-7 text-xs flex-1"
              :disabled="loading || !hasMore"
              @click="fetchAll"
            >
              {{ t("redis.fetchAllKeys") }}
            </Button>
          </div>
          <div v-if="isFetchingAll" class="shrink-0 border-t px-2 py-1.5 space-y-1">
            <div class="text-xs text-muted-foreground text-center">
              {{ fetchAllProgressText }}
            </div>
            <Button variant="destructive" size="sm" class="h-7 text-xs w-full" @click="stopFetchAll">
              {{ t("redis.stopFetchAll") }}
            </Button>
          </div>
        </div>
      </Pane>

      <!-- Workspace (right) -->
      <Pane :size="64" :min-size="36">
        <div class="h-full min-w-0 bg-background flex flex-col overflow-hidden">
          <Tabs v-model="activeSidePanel" :unmount-on-hide="false" class="h-full min-h-0 gap-0">
            <div class="h-9 shrink-0 border-b bg-background px-3 flex items-center">
              <TabsList class="h-7 gap-1 p-0.5">
                <TabsTrigger value="detail" class="h-6 flex-none gap-1.5 rounded-md px-2 text-xs">
                  <KeyRound class="size-3.5" />
                  {{ t("redis.keyDetail") }}
                </TabsTrigger>
                <TabsTrigger
                  value="command"
                  class="h-6 flex-none gap-1.5 rounded-md px-2 text-xs"
                  @click="openCommandPanel"
                >
                  <TerminalSquare class="size-3.5" />
                  {{ t("redis.commandLine") }}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="detail" class="m-0 min-h-0 flex-1 flex flex-col">
              <RedisValueViewer
                v-if="selectedKey"
                :key="selectedKey.key_raw"
                :connection-id="connectionId"
                :db="db"
                :key-display="selectedKey.key_display"
                :key-raw="selectedKey.key_raw"
                :metadata="selectedKey"
                @deleted="onKeyDeleted"
              />
              <div v-else class="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                {{ t("redis.selectKeyForDetail") }}
              </div>
            </TabsContent>

            <TabsContent value="command" class="m-0 min-h-0 flex-1 flex flex-col">
              <div
                class="dbx-editor-font-family relative flex min-h-0 flex-1 flex-col bg-[#171b21] text-[13px] leading-5 text-slate-200"
                @click="getCommandInput()?.focus()"
              >
                <div ref="commandTerminalRef" class="min-h-0 flex-1 overflow-auto px-4 pb-3 pt-4">
                  <div class="mb-4 text-slate-400">
                    <span class="text-slate-200">{{ t("redis.commandWelcome") }}</span>
                  </div>

                  <div v-for="entry in commandHistory" :key="entry.id" class="mb-2">
                    <div class="flex min-w-0 items-start gap-2 whitespace-pre-wrap break-words">
                      <span class="shrink-0 text-[#d7ba7d]">{{ entry.prompt }}</span>
                      <span class="min-w-0 text-slate-200">{{ entry.command }}</span>
                    </div>
                    <pre
                      v-if="entry.output"
                      class="ml-0 whitespace-pre-wrap break-words pl-0"
                      :class="entry.error ? 'text-[#ff6b6b]' : 'text-slate-300'"
                      >{{ entry.output }}</pre
                    >
                  </div>
                </div>

                <form
                  class="flex shrink-0 items-center gap-2 border-t border-white/10 bg-[#171b21] px-4 py-2"
                  @submit.prevent="executeCommand"
                >
                  <span class="shrink-0 text-[#d7ba7d]">{{ commandPrompt }}</span>
                  <input
                    v-model="commandText"
                    data-redis-command-input
                    class="dbx-editor-font-family min-w-0 flex-1 border-0 bg-transparent p-0 text-[13px] text-slate-200 caret-[#d7ba7d] outline-none placeholder:text-slate-500"
                    :disabled="commandRunning"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck="false"
                    @keydown.enter.prevent="executeCommand"
                  />
                  <Loader2 v-if="commandRunning" class="h-3.5 w-3.5 shrink-0 animate-spin text-slate-500" />
                </form>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </Pane>
    </Splitpanes>

    <DangerConfirmDialog
      v-model:open="showDangerConfirm"
      :message="t('dangerDialog.deleteMessage')"
      :details="dangerDetails"
      :confirm-label="dangerConfirmLabel"
      @confirm="applyDangerAction"
    />

    <Dialog v-model:open="showCreateKeyDialog">
      <DialogContent class="sm:max-w-md" :style="editorFontFamilyStyle">
        <DialogHeader>
          <DialogTitle>{{ t("redis.createKey") }}</DialogTitle>
        </DialogHeader>

        <div class="grid gap-3">
          <label class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.createKeyName") }}</span>
            <Input
              v-model="createKeyName"
              class="dbx-editor-font-family h-8 text-xs"
              :placeholder="t('redis.createKeyNamePlaceholder')"
              @keydown.enter="createRedisKey"
            />
          </label>

          <label class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.createKeyType") }}</span>
            <Select
              :model-value="createKeyType"
              @update:model-value="(value: any) => (createKeyType = value as RedisCreateKeyType)"
            >
              <SelectTrigger class="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="option in createKeyTypeOptions" :key="option.value" :value="option.value">
                  {{ option.label }}
                </SelectItem>
              </SelectContent>
            </Select>
          </label>

          <label v-if="createKeyType === 'hash'" class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.createField") }}</span>
            <Input
              v-model="createKeyField"
              class="dbx-editor-font-family h-8 text-xs"
              :placeholder="t('redis.createFieldPlaceholder')"
              @keydown.enter="createRedisKey"
            />
          </label>

          <label v-if="createKeyType === 'zset'" class="grid gap-1.5 text-xs font-medium">
            <span>{{ t("redis.createScore") }}</span>
            <Input
              v-model="createKeyScore"
              class="dbx-editor-font-family h-8 text-xs"
              placeholder="0"
              @keydown.enter="createRedisKey"
            />
          </label>

          <label class="grid gap-1.5 text-xs font-medium">
            <span>{{
              t(createKeyType === "set" || createKeyType === "zset" ? "redis.createMember" : "redis.createValue")
            }}</span>
            <textarea
              v-model="createKeyValue"
              class="dbx-editor-font-family min-h-28 resize-y rounded-md border bg-background p-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
              spellcheck="false"
              :placeholder="t('redis.createValuePlaceholder')"
            />
          </label>

          <p v-if="createKeyError" class="text-xs text-destructive">{{ createKeyError }}</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" :disabled="creatingKey" @click="showCreateKeyDialog = false">
            {{ t("dangerDialog.cancel") }}
          </Button>
          <Button :disabled="creatingKey" @click="createRedisKey">
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
.redis-key-scroller {
  will-change: scroll-position;
  contain: content;
}

.redis-key-scroller :deep(.vue-recycle-scroller__item-view) {
  contain: layout style paint;
}

.redis-workspace-splitpanes :deep(.splitpanes--vertical > .splitpanes__splitter) {
  width: 1px !important;
  border-left: 0;
  background: var(--border);
}

.redis-workspace-splitpanes :deep(.splitpanes__splitter:hover) {
  background: var(--primary) !important;
}
</style>

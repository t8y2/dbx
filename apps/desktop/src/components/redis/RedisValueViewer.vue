<script setup lang="ts">
import { computed, ref, nextTick, onBeforeUnmount, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { onClickOutside } from "@vueuse/core";
import { DynamicScroller, DynamicScrollerItem, RecycleScroller } from "vue-virtual-scroller";
import { Copy, Eye, Terminal, Trash2, Save, RefreshCw, Plus, Loader2, Pencil, WrapText, IndentIncrease, IndentDecrease, ArrowUp, ArrowDown, ArrowUpDown, Search, Clock } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import JsonTree from "@/components/common/JsonTree.vue";
import * as api from "@/lib/backend/api";
import type { RedisBlob, RedisHashItem, RedisKeyInfo, RedisListItem, RedisSetItem, RedisStreamEntry, RedisValue, RedisZsetItem } from "@/lib/backend/api";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useEditorFontFamilyStyle } from "@/composables/useEditorFontFamilyStyle";
import { createShikiJsonHighlighter, type JsonHighlighter } from "@/lib/common/shikiJsonHighlighter";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatTtl } from "@/lib/common/ttlFormat";
import { computeAutoRefreshTick, computeDisplayTtl, shouldStopAutoRefresh } from "@/lib/redis/redisAutoRefresh";
import {
  canRenderRedisValueFormat,
  canEditRedisMemberDetail,
  clampRedisMemberDetailSheetWidth,
  formatRedisMemberDetail,
  getRedisMemberSelectionKey,
  isRedisBlob,
  preferredRedisValueFormat,
  REDIS_VALUE_FORMAT_DISPLAY_ORDER,
  redisBlobText,
  redisCollectionPageItems,
  redisMemberCopyText,
  redisValueCopyText,
  redisValueCollectionItems,
  redisValueCollectionScanCursor,
  redisValueCollectionTotal,
  type RedisCollectionItem,
  type RedisValueFormat,
} from "@/lib/redis/redisValuePresentation";
import { safeJsonFormat } from "@/lib/common/safeJsonFormat";

const { t } = useI18n();
const { toast } = useToast();
const { isDark } = useTheme();
const editorFontFamilyStyle = useEditorFontFamilyStyle();

const props = defineProps<{
  connectionId: string;
  db: number;
  keyDisplay: string;
  keyRaw: string;
  metadata?: RedisKeyInfo | null;
}>();

const emit = defineEmits<{ deleted: []; loaded: [value: RedisValue] }>();

const REDIS_JSON_WRAP_STORAGE_KEY = "dbx-redis-json-word-wrap";
const REDIS_VALUE_FORMAT_STORAGE_KEY = "dbx-redis-value-format";
const REDIS_COLLECTION_ROW_HEIGHT = 32;
const REDIS_STREAM_MIN_ROW_HEIGHT = 96;

const data = ref<RedisValue | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const editValue = ref("");
const isEditing = ref(false);
const newField = ref("");
const newValue = ref("");
const newScore = ref("");
const showDeleteConfirm = ref(false);
const showMemberDetail = ref(false);
const editingTtl = ref(false);
const ttlInput = ref("");
const ttlInputEl = ref<InstanceType<typeof Input>>();
const editTtlWrapper = ref<HTMLElement>();
onClickOutside(editTtlWrapper, () => {
  if (editingTtl.value) cancelEditTtl();
});
const collectionItems = ref<RedisCollectionItem[]>([]);
const scanCursor = ref<number | undefined>(undefined);
const selectedMemberTitle = ref("");
const selectedMemberRaw = ref<unknown>("");
const selectedMemberKey = ref("");
const selectedMemberContext = ref<RedisMemberContext | null>(null);
const isEditingMember = ref(false);
const savingMember = ref(false);
const memberEditValue = ref("");
const memberDetailSheetWidth = ref(420);
const isResizingMemberSheet = ref(false);
const hashTableRef = ref<HTMLElement | null>(null);
const hashFieldWidth = ref(280);
const isResizingHashColumns = ref(false);
const zsetTableRef = ref<HTMLElement | null>(null);
const zsetScoreWidth = ref(220);
const isResizingZsetColumns = ref(false);
const stringValueView = ref<RedisValueFormat>(readPreferredRedisValueFormat());
const memberValueView = ref<RedisValueFormat>(readPreferredRedisValueFormat());
const redisJsonView = ref<"raw" | "tree">("raw");
const redisJsonWordWrap = ref(readRedisJsonWordWrap());
const redisJsonHighlighter = ref<JsonHighlighter>();

// Auto-refresh
const autoRefreshEnabled = ref(true);
const countdownTtl = ref(0);
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

function toggleAutoRefresh() {
  autoRefreshEnabled.value = !autoRefreshEnabled.value;
  if (autoRefreshEnabled.value) {
    startAutoRefresh();
  } else {
    stopAutoRefresh();
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (data.value && data.value.ttl > 0) {
    countdownTtl.value = data.value.ttl;
  }
  autoRefreshTimer = setInterval(() => {
    const action = computeAutoRefreshTick(autoRefreshEnabled.value, countdownTtl.value, loading.value);
    if (action.type === "decrement") {
      countdownTtl.value--;
      return;
    }
    if (action.type === "refresh") {
      load()
        .then(() => {
          if (!autoRefreshEnabled.value) return;
          if (!data.value || shouldStopAutoRefresh(data.value.ttl)) {
            stopAutoRefresh();
            autoRefreshEnabled.value = false;
          }
        })
        .catch(() => {
          // Network / connection error — stop auto-refresh to avoid tight retry loop
          if (autoRefreshEnabled.value) {
            stopAutoRefresh();
            autoRefreshEnabled.value = false;
          }
        });
    }
  }, 1000);
}

function stopAutoRefresh() {
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

const hashSortBy = ref<"field" | "value" | null>(null);
const hashSortDir = ref<"asc" | "desc">("asc");
const hashSearchQuery = ref("");
const activeHashSearchQuery = ref("");
const searchLoading = ref(false);

function toggleHashSort(column: "field" | "value") {
  if (hashSortBy.value === column && hashSortDir.value === "desc") {
    hashSortBy.value = null;
  } else if (hashSortBy.value === column) {
    hashSortDir.value = "desc";
  } else {
    hashSortBy.value = column;
    hashSortDir.value = "asc";
  }
}

const redisKind = computed(() => data.value?.data.kind ?? "unknown");
const isStringLikeKind = computed(() => redisKind.value === "string");
const stringBlob = computed<RedisBlob | null>(() => {
  const value = data.value;
  if (!value) return null;
  return value.data.kind === "string" ? value.data.content : null;
});
const stringValueDetail = computed(() => (stringBlob.value ? formatRedisMemberDetail(stringBlob.value, { allowJsonText: true }) : null));
const redisJsonValue = computed(() => (data.value?.data.kind === "json" ? data.value.data.value : null));
const selectedMemberDetail = computed(() => formatRedisMemberDetail(selectedMemberRaw.value, { allowJsonText: true }));
const redisJsonAppearance = computed(() => (isDark.value ? "dark" : "light"));
const isBinaryStringValue = computed(() => Boolean(stringValueDetail.value?.binary));
const selectedMemberCanEdit = computed(() => selectedMemberContext.value?.canEdit ?? false);
const canEditCurrentStringFormat = computed(() => Boolean(stringValueDetail.value?.editable) && stringValueView.value === "utf8");
const showStringEditActions = computed(() => canEditCurrentStringFormat.value);
const originalStringEditValue = computed(() => (stringBlob.value ? rawRedisValueText(stringBlob.value) : ""));
const stringValueChanged = computed(() => canEditCurrentStringFormat.value && editValue.value !== originalStringEditValue.value);
const canEditCurrentMemberFormat = computed(() => selectedMemberCanEdit.value && memberValueView.value === "utf8");
const hasMore = computed(() => scanCursor.value != null && scanCursor.value > 0);
const collectionTotal = computed(() => (data.value ? redisValueCollectionTotal(data.value) : null));
const hashGridStyle = computed(() => ({
  gridTemplateColumns: `${hashFieldWidth.value}px minmax(12rem, 1fr) 84px`,
}));
const zsetGridStyle = computed(() => ({
  gridTemplateColumns: `${zsetScoreWidth.value}px minmax(0, 1fr) 84px`,
}));
const metadataSizeLabel = computed(() => {
  const metadata = props.metadata;
  const size = metadata?.size ?? 0;
  if (!metadata || size <= 0) return "";
  if (metadata.key_type === "string") {
    if (size >= 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${size} B`;
  }
  return String(size);
});
const streamRows = computed<RedisStreamRow[]>(() => {
  if (data.value?.data.kind !== "stream") return [];
  return data.value.data.entries.map((entry, index) => ({
    id: `${index}:${entry.id}`,
    index,
    entry,
  }));
});

const sortedHashItems = computed<RedisHashItem[]>(() => {
  if (redisKind.value !== "hash") return [];
  const items = [...(collectionItems.value as RedisHashItem[])];
  if (!hashSortBy.value) return items;
  const multiplier = hashSortDir.value === "asc" ? 1 : -1;
  const key = hashSortBy.value;
  items.sort((a, b) => {
    const av = key === "field" ? formatRedisMemberDetail(a.field).rawText : formatRedisMemberDetail(a.value).rawText;
    const bv = key === "field" ? formatRedisMemberDetail(b.field).rawText : formatRedisMemberDetail(b.value).rawText;
    return av.localeCompare(bv) * multiplier;
  });
  return items;
});

const hashCollectionRows = computed<RedisCollectionRow<RedisHashItem>[]>(() =>
  sortedHashItems.value.map((value, index) => ({
    id: `hash-${index}`,
    index,
    value,
  })),
);

const listRows = computed<RedisCollectionRow<RedisListItem>[]>(() =>
  redisKind.value === "list"
    ? (collectionItems.value as RedisListItem[]).map((value, index) => ({
        id: collectionRowId(value, index),
        index,
        value,
      }))
    : [],
);
const setRows = computed<RedisCollectionRow<RedisSetItem>[]>(() =>
  redisKind.value === "set"
    ? (collectionItems.value as RedisSetItem[]).map((value, index) => ({
        id: collectionRowId(value, index),
        index,
        value,
      }))
    : [],
);
const zsetRows = computed<RedisCollectionRow<RedisZsetItem>[]>(() =>
  redisKind.value === "zset"
    ? (collectionItems.value as RedisZsetItem[]).map((value, index) => ({
        id: collectionRowId(value, index),
        index,
        value,
      }))
    : [],
);

let hashSearchTimer: ReturnType<typeof setTimeout> | null = null;
let hashSearchRequestId = 0;
let memberSheetResizeStartX = 0;
let memberSheetResizeStartWidth = 0;
let hashResizeStartX = 0;
let hashResizeStartWidth = 0;
let zsetResizeStartX = 0;
let zsetResizeStartWidth = 0;

type PendingDelete = { kind: "key" } | { kind: "hash"; field: string } | { kind: "list"; index: number } | { kind: "set"; member: string } | { kind: "zset"; member: string };
const pendingDelete = ref<PendingDelete | null>(null);

type RedisMemberContext =
  | { kind: "list"; index: number; canEdit: boolean }
  | { kind: "set"; member: string | null; canEdit: boolean }
  | { kind: "hash"; field: string | null; canEdit: boolean }
  | { kind: "zset"; member: string | null; score: string; canEdit: boolean }
  | { kind: "stream"; field: string; canEdit: false };

type RedisCollectionRow<T> = {
  id: string;
  index: number;
  value: T;
};

type RedisStreamRow = {
  id: string;
  index: number;
  entry: RedisStreamEntry;
};

function collectionCountLabel(kind: "items" | "fields" | "members", loaded: number, total?: number | null) {
  if (total == null || total === loaded) return t(`redis.${kind}`, { count: loaded });
  return t(`redis.loaded${kind[0].toUpperCase()}${kind.slice(1)}`, { loaded, total });
}

function onHashSearchInput() {
  if (hashSearchTimer) clearTimeout(hashSearchTimer);
  hashSearchTimer = setTimeout(() => void onHashSearch(), 400);
}

function onHashSearchKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    if (hashSearchTimer) clearTimeout(hashSearchTimer);
    hashSearchTimer = null;
    void onHashSearch();
    return;
  }
  if (event.key === "Escape") {
    if (hashSearchTimer) clearTimeout(hashSearchTimer);
    hashSearchTimer = null;
    hashSearchQuery.value = "";
    void onHashSearch();
  }
}

async function onHashSearch() {
  const query = hashSearchQuery.value.trim();
  if (redisKind.value !== "hash") return;
  const requestId = ++hashSearchRequestId;
  searchLoading.value = true;
  try {
    const result = await api.redisLoadMore(props.connectionId, props.db, props.keyRaw, "hash", 0, 200, query || undefined);
    if (requestId !== hashSearchRequestId || result.kind !== "hash") return;
    activeHashSearchQuery.value = query;
    collectionItems.value = result.items;
    scanCursor.value = result.scan_cursor ?? undefined;
    clearSelectedMember();
  } finally {
    if (requestId === hashSearchRequestId) searchLoading.value = false;
  }
}

function readRedisJsonWordWrap(): boolean {
  try {
    return localStorage.getItem(REDIS_JSON_WRAP_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

function setRedisJsonWordWrap(value: boolean) {
  redisJsonWordWrap.value = value;
  try {
    localStorage.setItem(REDIS_JSON_WRAP_STORAGE_KEY, value ? "true" : "false");
  } catch {
    // Ignore storage failures; the toggle still works for the current session.
  }
}

function readPreferredRedisValueFormat(): RedisValueFormat {
  try {
    const stored = localStorage.getItem(REDIS_VALUE_FORMAT_STORAGE_KEY);
    if (stored === "raw") return "utf8";
    return stored === "utf8" || stored === "ascii" || stored === "binary" || stored === "json" || stored === "javaserialize" || stored === "hex" || stored === "base64" ? stored : "utf8";
  } catch {
    return "utf8";
  }
}

function formatJsonText(raw: string): string | null {
  try {
    return safeJsonFormat(raw, 2);
  } catch {
    return null;
  }
}

function compressJsonText(raw: string): string | null {
  try {
    return safeJsonFormat(raw);
  } catch {
    return null;
  }
}

function rememberRedisValueFormat(format: RedisValueFormat) {
  try {
    localStorage.setItem(REDIS_VALUE_FORMAT_STORAGE_KEY, format);
  } catch {
    // Ignore storage failures; the toggle still works for the current session.
  }
}

function setStringValueFormat(format: RedisValueFormat) {
  stringValueView.value = format;
  if (stringValueDetail.value && canRenderRedisValueFormat(stringValueDetail.value, format)) {
    rememberRedisValueFormat(format);
  }
}

function setMemberValueFormat(format: RedisValueFormat) {
  memberValueView.value = format;
  if (canRenderRedisValueFormat(selectedMemberDetail.value, format)) {
    rememberRedisValueFormat(format);
  }
}

function redisFormatLabel(format: RedisValueFormat, rawLabel?: string): string {
  switch (format) {
    case "utf8":
      return "UTF-8";
    case "ascii":
      return "ASCII";
    case "binary":
      return "Binary";
    case "json":
      return t("redis.jsonView");
    case "javaserialize":
      return "Java Serialized";
    case "hex":
      return t("grid.hexViewerHex");
    case "base64":
      return "Base64";
    default:
      return rawLabel || t("redis.rawContent");
  }
}

function isTextRedisFormat(format: RedisValueFormat): boolean {
  return format === "utf8" || format === "ascii" || format === "binary";
}

function highlightRedisJson(json: string): string {
  return redisJsonHighlighter.value?.(json, redisJsonAppearance.value) ?? escapeHtml(json);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function detailTextForFormat(detail: ReturnType<typeof formatRedisMemberDetail>, format: RedisValueFormat): string {
  switch (format) {
    case "utf8":
      return detail.utf8Text;
    case "ascii":
      return detail.asciiText;
    case "binary":
      return detail.binaryText;
    case "json":
      return detail.json?.formattedText ?? detail.rawText;
    case "javaserialize":
      return detail.javaSerialized?.formattedText ?? detail.rawText;
    case "hex":
      return detail.hexRows.map((row) => row.hex).join("\n");
    case "base64":
      return detail.base64Text;
    default:
      return detail.rawText;
  }
}

function detailTextClass(format: RedisValueFormat): string {
  if (!redisJsonWordWrap.value) return "whitespace-pre";
  return format === "ascii" || format === "binary" ? "whitespace-pre-wrap break-all" : "whitespace-pre-wrap break-words";
}

function rawRedisValueText(value: unknown): string {
  return formatRedisMemberDetail(value).rawText;
}

const deleteDetails = computed(() => {
  const pending = pendingDelete.value;
  if (!pending) return "";
  const key = formatValue(props.keyDisplay);
  if (pending.kind === "key") return t("dangerDialog.redisKeyDetails", { key });
  if (pending.kind === "hash") return t("dangerDialog.redisHashFieldDetails", { key, field: formatValue(pending.field) });
  if (pending.kind === "list") return t("dangerDialog.redisListItemDetails", { key, index: pending.index });
  if (pending.kind === "zset") return t("dangerDialog.redisSetMemberDetails", { key, member: formatValue(pending.member) });
  return t("dangerDialog.redisSetMemberDetails", { key, member: formatValue(pending.member) });
});

async function load(options: { selectDefaultMember?: boolean } = {}) {
  const shouldSelectDefaultMember = options.selectDefaultMember ?? true;
  if (hashSearchTimer) clearTimeout(hashSearchTimer);
  hashSearchTimer = null;
  hashSearchRequestId++;
  hashSearchQuery.value = "";
  activeHashSearchQuery.value = "";
  searchLoading.value = false;
  loading.value = true;
  try {
    const loadedValue = await api.redisGetValue(props.connectionId, props.db, props.keyRaw);
    data.value = loadedValue;
    emit("loaded", loadedValue);
    scanCursor.value = redisValueCollectionScanCursor(loadedValue);
    collectionItems.value = redisValueCollectionItems(loadedValue);
    isEditing.value = false;

    if (loadedValue.data.kind === "string") {
      const detail = formatRedisMemberDetail(loadedValue.data.content, { allowJsonText: true });
      editValue.value = detail.rawText;
      stringValueView.value = preferredRedisValueFormat(loadedValue.data.content, readPreferredRedisValueFormat(), { allowJsonText: true });
      clearSelectedMember();
    } else if (loadedValue.data.kind === "json") {
      editValue.value = JSON.stringify(loadedValue.data.value, null, 2);
      redisJsonView.value = "raw";
      clearSelectedMember();
    } else if (loadedValue.data.kind === "stream") {
      if (shouldSelectDefaultMember) selectDefaultMember(loadedValue);
    } else if (["list", "set", "hash", "zset"].includes(loadedValue.data.kind)) {
      if (shouldSelectDefaultMember) selectDefaultMember(loadedValue);
    } else {
      clearSelectedMember();
    }
  } finally {
    loading.value = false;
    if (autoRefreshEnabled.value && data.value && data.value.ttl > 0) {
      startAutoRefresh();
    }
  }
}

async function loadMore() {
  if (!data.value || !hasMore.value || loadingMore.value || (redisKind.value === "hash" && searchLoading.value)) return;
  if (!(redisKind.value === "list" || redisKind.value === "set" || redisKind.value === "hash" || redisKind.value === "zset")) return;
  const keyType = redisKind.value;
  const hashFilter = keyType === "hash" ? activeHashSearchQuery.value || undefined : undefined;
  const requestId = hashSearchRequestId;
  loadingMore.value = true;
  try {
    const result = await api.redisLoadMore(props.connectionId, props.db, props.keyRaw, keyType, scanCursor.value!, 200, hashFilter);
    if (keyType === "hash" && requestId !== hashSearchRequestId) return;
    const newItems = redisCollectionPageItems(result);
    collectionItems.value = [...collectionItems.value, ...newItems];
    scanCursor.value = result.scan_cursor ?? undefined;
  } finally {
    loadingMore.value = false;
  }
}

async function saveString() {
  if (!data.value || !stringBlob.value || isBinaryStringValue.value || !stringValueChanged.value) return;
  await api.redisSetString(props.connectionId, props.db, props.keyRaw, editValue.value);
  isEditing.value = false;
  await load();
}

function handleStringInput() {
  if (canEditCurrentStringFormat.value) {
    isEditing.value = stringValueChanged.value;
  }
}

function discardStringEdit() {
  isEditing.value = false;
  editValue.value = originalStringEditValue.value;
}

async function saveJson() {
  if (!data.value || data.value.data.kind !== "json") return;
  await api.redisJsonSet(props.connectionId, props.db, props.keyRaw, editValue.value);
  isEditing.value = false;
  await load();
}

function handleJsonInput() {
  if (redisJsonView.value === "raw") {
    isEditing.value = true;
  }
}

function handleFormatJsonEditor() {
  const result = formatJsonText(editValue.value);
  if (result != null) {
    editValue.value = result;
    isEditing.value = true;
  } else {
    toast(t("redis.jsonFormatError"), 3000);
  }
}

function handleCompressJsonEditor() {
  const result = compressJsonText(editValue.value);
  if (result != null) {
    editValue.value = result;
    isEditing.value = true;
  } else {
    toast(t("redis.jsonFormatError"), 3000);
  }
}

async function applyDeleteKey() {
  await api.redisDeleteKey(props.connectionId, props.db, props.keyRaw);
  emit("deleted");
}

function requestDeleteKey() {
  pendingDelete.value = { kind: "key" };
  showDeleteConfirm.value = true;
}

async function copyValue() {
  if (!data.value) return;
  const text = redisValueCopyText(data.value, collectionItems.value);
  try {
    await copyToClipboard(text);
    toast(t("redis.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

async function copyText(text: string) {
  try {
    await copyToClipboard(text);
    toast(t("redis.copied"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function escapeRedisArg(val: string): string {
  return `"${val.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function blobWriteText(blob: RedisBlob): string | null {
  return redisBlobText(blob);
}

function generateInsertStatements(): string | null {
  if (!data.value) return null;

  const key = data.value.key_display;
  const commands: string[] = [];
  const total = collectionTotal.value;
  if (total != null && total > collectionItems.value.length) {
    commands.push(`-- Note: Only ${collectionItems.value.length} of ${total} items included`);
  }

  switch (data.value.data.kind) {
    case "string": {
      const text = blobWriteText(data.value.data.content);
      if (text == null) return null;
      commands.push(`SET ${escapeRedisArg(key)} ${escapeRedisArg(text)}`);
      break;
    }
    case "json": {
      commands.push(`JSON.SET ${escapeRedisArg(key)} $ ${escapeRedisArg(JSON.stringify(data.value.data.value))}`);
      break;
    }
    case "list": {
      const items = (collectionItems.value as RedisListItem[]).map((item) => blobWriteText(item.value));
      if (items.some((item) => item == null)) return null;
      commands.push(`RPUSH ${escapeRedisArg(key)} ${(items as string[]).map(escapeRedisArg).join(" ")}`);
      break;
    }
    case "set": {
      const items = (collectionItems.value as RedisSetItem[]).map((item) => blobWriteText(item.member));
      if (items.some((item) => item == null)) return null;
      commands.push(`SADD ${escapeRedisArg(key)} ${(items as string[]).map(escapeRedisArg).join(" ")}`);
      break;
    }
    case "zset": {
      const pairs = (collectionItems.value as RedisZsetItem[]).map((item) => {
        const member = blobWriteText(item.member);
        return member == null ? null : `${item.score} ${escapeRedisArg(member)}`;
      });
      if (pairs.some((item) => item == null)) return null;
      commands.push(`ZADD ${escapeRedisArg(key)} ${(pairs as string[]).join(" ")}`);
      break;
    }
    case "hash": {
      const pairs = (collectionItems.value as RedisHashItem[]).map((item) => {
        const field = blobWriteText(item.field);
        const value = blobWriteText(item.value);
        return field == null || value == null ? null : `${escapeRedisArg(field)} ${escapeRedisArg(value)}`;
      });
      if (pairs.some((item) => item == null)) return null;
      commands.push(`HSET ${escapeRedisArg(key)} ${(pairs as string[]).join(" ")}`);
      break;
    }
    case "stream": {
      for (const entry of data.value.data.entries) {
        const fields = entry.fields.map(({ field, value }) => `${escapeRedisArg(field)} ${escapeRedisArg(value)}`).join(" ");
        commands.push(`XADD ${escapeRedisArg(key)} * ${fields}`);
      }
      break;
    }
    default:
      return null;
  }

  if (data.value.ttl > 0) {
    commands.push(`EXPIRE ${escapeRedisArg(key)} ${data.value.ttl}`);
  }

  return commands.join("\n");
}

async function copyInsertStatement() {
  const stmt = generateInsertStatements();
  if (!stmt) {
    toast(t("redis.copyInsertStatementBinary"), 3000);
    return;
  }
  try {
    await copyToClipboard(stmt);
    toast(t("redis.copyInsertStatement"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function copyMember(value: unknown) {
  void copyText(redisMemberCopyText(value));
}

function selectMember(title: string, value: unknown, context: RedisMemberContext, identity?: string) {
  const detail = formatRedisMemberDetail(value, { allowJsonText: true });
  selectedMemberTitle.value = title;
  selectedMemberRaw.value = value;
  selectedMemberKey.value = getRedisMemberSelectionKey(title, value, identity);
  selectedMemberContext.value = context;
  isEditingMember.value = false;
  memberEditValue.value = detail.rawText;
  memberValueView.value = preferredRedisValueFormat(value, readPreferredRedisValueFormat(), { allowJsonText: true });
}

function clearSelectedMember() {
  selectedMemberTitle.value = "";
  selectedMemberRaw.value = "";
  selectedMemberKey.value = "";
  selectedMemberContext.value = null;
  isEditingMember.value = false;
  memberEditValue.value = "";
}

function isSelectedMember(title: string, value: unknown, identity?: string) {
  return selectedMemberKey.value === getRedisMemberSelectionKey(title, value, identity);
}

function viewMember(title: string, value: unknown, context: RedisMemberContext, identity?: string) {
  selectMember(title, value, context, identity);
  showMemberDetail.value = true;
}

function handleMemberDetailOpenChange(open: boolean) {
  showMemberDetail.value = open;
  if (!open) isEditingMember.value = false;
}

function finishMemberDetailClose() {
  isEditingMember.value = false;
}

function stopResizeMemberSheet() {
  isResizingMemberSheet.value = false;
  window.removeEventListener("pointermove", resizeMemberSheet);
  window.removeEventListener("pointerup", stopResizeMemberSheet);
}

function resizeMemberSheet(event: PointerEvent) {
  if (!isResizingMemberSheet.value) return;
  const delta = memberSheetResizeStartX - event.clientX;
  memberDetailSheetWidth.value = clampRedisMemberDetailSheetWidth(memberSheetResizeStartWidth + delta, window.innerWidth);
}

function startResizeMemberSheet(event: PointerEvent) {
  isResizingMemberSheet.value = true;
  memberSheetResizeStartX = event.clientX;
  memberSheetResizeStartWidth = memberDetailSheetWidth.value;
  window.addEventListener("pointermove", resizeMemberSheet);
  window.addEventListener("pointerup", stopResizeMemberSheet);
}

function clampHashFieldWidth(width: number) {
  const containerWidth = hashTableRef.value?.clientWidth ?? 900;
  const min = 120;
  const max = Math.max(min, containerWidth - 220);
  return Math.min(max, Math.max(min, width));
}

function stopResizeHashColumns() {
  isResizingHashColumns.value = false;
  window.removeEventListener("pointermove", resizeHashColumns);
  window.removeEventListener("pointerup", stopResizeHashColumns);
}

function resizeHashColumns(event: PointerEvent) {
  if (!isResizingHashColumns.value) return;
  const delta = event.clientX - hashResizeStartX;
  hashFieldWidth.value = clampHashFieldWidth(hashResizeStartWidth + delta);
}

function startResizeHashColumns(event: PointerEvent) {
  isResizingHashColumns.value = true;
  hashResizeStartX = event.clientX;
  hashResizeStartWidth = hashFieldWidth.value;
  window.addEventListener("pointermove", resizeHashColumns);
  window.addEventListener("pointerup", stopResizeHashColumns);
}

function clampZsetScoreWidth(width: number) {
  const containerWidth = zsetTableRef.value?.clientWidth ?? 900;
  const min = 120;
  const max = Math.max(min, containerWidth - 220);
  return Math.min(max, Math.max(min, width));
}

function stopResizeZsetColumns() {
  isResizingZsetColumns.value = false;
  window.removeEventListener("pointermove", resizeZsetColumns);
  window.removeEventListener("pointerup", stopResizeZsetColumns);
}

function resizeZsetColumns(event: PointerEvent) {
  if (!isResizingZsetColumns.value) return;
  const delta = event.clientX - zsetResizeStartX;
  zsetScoreWidth.value = clampZsetScoreWidth(zsetResizeStartWidth + delta);
}

function startResizeZsetColumns(event: PointerEvent) {
  isResizingZsetColumns.value = true;
  zsetResizeStartX = event.clientX;
  zsetResizeStartWidth = zsetScoreWidth.value;
  window.addEventListener("pointermove", resizeZsetColumns);
  window.addEventListener("pointerup", stopResizeZsetColumns);
}

function startEditMember() {
  if (!canEditCurrentMemberFormat.value) return;
  memberEditValue.value = selectedMemberDetail.value.rawText;
  isEditingMember.value = true;
}

function cancelEditMember() {
  memberEditValue.value = selectedMemberDetail.value.rawText;
  isEditingMember.value = false;
}

async function saveMemberEdit() {
  const context = selectedMemberContext.value;
  if (!context || !canEditCurrentMemberFormat.value) return;
  let nextContext: RedisMemberContext = context;
  savingMember.value = true;
  try {
    if (context.kind === "list") {
      await api.redisListSet(props.connectionId, props.db, props.keyRaw, context.index, memberEditValue.value);
    } else if (context.kind === "hash") {
      if (!context.field) return;
      await api.redisHashSet(props.connectionId, props.db, props.keyRaw, context.field, memberEditValue.value);
    } else if (context.kind === "set") {
      if (!context.member) return;
      await api.redisSetRemove(props.connectionId, props.db, props.keyRaw, context.member);
      await api.redisSetAdd(props.connectionId, props.db, props.keyRaw, memberEditValue.value);
      nextContext = { kind: "set", member: memberEditValue.value, canEdit: true };
    } else if (context.kind === "zset") {
      if (!context.member) return;
      await api.redisZrem(props.connectionId, props.db, props.keyRaw, context.member);
      await api.redisZadd(props.connectionId, props.db, props.keyRaw, memberEditValue.value, Number(context.score));
      nextContext = { kind: "zset", member: memberEditValue.value, score: context.score, canEdit: true };
    }
    const editedValue = memberEditValue.value;
    isEditingMember.value = false;
    await load({ selectDefaultMember: false });
    restoreSelectedMember(nextContext, editedValue);
  } finally {
    savingMember.value = false;
  }
}

function selectDefaultMember(redisValue: RedisValue) {
  switch (redisValue.data.kind) {
    case "list": {
      const first = redisValue.data.items[0];
      if (!first) return clearSelectedMember();
      return selectMember(`#${first.index}`, first.value, { kind: "list", index: first.index, canEdit: canEditRedisMemberDetail("list", first.value) });
    }
    case "set": {
      const first = redisValue.data.items[0];
      if (!first) return clearSelectedMember();
      const member = redisBlobText(first.member);
      return selectMember(t("redis.member"), first.member, { kind: "set", member, canEdit: member != null && canEditRedisMemberDetail("set", first.member) });
    }
    case "hash": {
      const first = redisValue.data.items[0];
      if (!first) return clearSelectedMember();
      const field = redisBlobText(first.field);
      return selectMember(formatValue(first.field), first.value, { kind: "hash", field, canEdit: field != null && canEditRedisMemberDetail("hash", first.value) });
    }
    case "zset": {
      const first = redisValue.data.items[0];
      if (!first) return clearSelectedMember();
      const member = redisBlobText(first.member);
      return selectMember(first.score, first.member, { kind: "zset", member, score: first.score, canEdit: member != null && canEditRedisMemberDetail("zset", first.member) });
    }
    case "stream": {
      const firstEntry = redisValue.data.entries[0];
      const firstField = firstEntry?.fields[0];
      if (!firstField) return clearSelectedMember();
      return selectMember(firstField.field, firstField.value, { kind: "stream", field: firstField.field, canEdit: false }, streamFieldSelectionIdentity(firstEntry.id, 0));
    }
    default:
      clearSelectedMember();
  }
}

function streamFieldCount(row: RedisStreamRow): number {
  return row.entry.fields.length;
}

function streamFieldSelectionIdentity(entryId: string, fieldIndex: string | number): string {
  return `stream:${entryId}:${fieldIndex}`;
}

function collectionRowId(value: RedisCollectionItem, index: number): string {
  if ("index" in value) return `list-${value.index}`;
  if ("field" in value) return `hash-${value.field.raw_base64}-${index}`;
  if ("score" in value) return `zset-${value.member.raw_base64}-${index}`;
  return `set-${value.member.raw_base64}-${index}`;
}

function canDeleteHashItem(item: RedisHashItem): boolean {
  return redisBlobText(item.field) != null;
}

function canDeleteSetItem(item: RedisSetItem): boolean {
  return redisBlobText(item.member) != null;
}

function canDeleteZsetItem(item: RedisZsetItem): boolean {
  return redisBlobText(item.member) != null;
}

function restoreSelectedMember(context: RedisMemberContext, fallbackValue: string) {
  const restored = resolveSelectedMember(context);
  if (restored) {
    selectMember(restored.title, restored.value, restored.context);
    return;
  }
  const title = context.kind === "list" ? `#${context.index}` : context.kind === "set" ? t("redis.member") : context.kind === "hash" ? (context.field ?? selectedMemberTitle.value) : context.kind === "zset" ? context.score : context.field;
  selectMember(title, fallbackValue, context);
}

function resolveSelectedMember(context: RedisMemberContext): { title: string; value: unknown; context: RedisMemberContext } | null {
  switch (context.kind) {
    case "list": {
      if (redisKind.value !== "list") return null;
      const item = (collectionItems.value as RedisListItem[]).find((candidate) => candidate.index === context.index);
      if (!item) return null;
      return {
        title: `#${item.index}`,
        value: item.value,
        context: { kind: "list", index: item.index, canEdit: canEditRedisMemberDetail("list", item.value) },
      };
    }
    case "set": {
      if (redisKind.value !== "set" || !context.member) return null;
      const item = (collectionItems.value as RedisSetItem[]).find((candidate) => redisBlobText(candidate.member) === context.member);
      if (!item) return null;
      const member = redisBlobText(item.member);
      return {
        title: t("redis.member"),
        value: item.member,
        context: { kind: "set", member, canEdit: member != null && canEditRedisMemberDetail("set", item.member) },
      };
    }
    case "hash": {
      if (redisKind.value !== "hash" || !context.field) return null;
      const item = (collectionItems.value as RedisHashItem[]).find((candidate) => redisBlobText(candidate.field) === context.field);
      if (!item) return null;
      const field = redisBlobText(item.field);
      return {
        title: formatValue(item.field),
        value: item.value,
        context: { kind: "hash", field, canEdit: field != null && canEditRedisMemberDetail("hash", item.value) },
      };
    }
    case "zset": {
      if (redisKind.value !== "zset" || !context.member) return null;
      const item = (collectionItems.value as RedisZsetItem[]).find((candidate) => redisBlobText(candidate.member) === context.member && candidate.score === context.score);
      if (!item) return null;
      const member = redisBlobText(item.member);
      return {
        title: item.score,
        value: item.member,
        context: { kind: "zset", member, score: item.score, canEdit: member != null && canEditRedisMemberDetail("zset", item.member) },
      };
    }
    case "stream":
      return null;
  }
}

function requestHashDel(field: string | null) {
  if (!field) return;
  pendingDelete.value = { kind: "hash", field };
  showDeleteConfirm.value = true;
}

function requestSetRemove(member: string | null) {
  if (!member) return;
  pendingDelete.value = { kind: "set", member };
  showDeleteConfirm.value = true;
}

function requestZsetRemove(member: string | null) {
  if (!member) return;
  pendingDelete.value = { kind: "zset", member };
  showDeleteConfirm.value = true;
}

// TTL
function startEditTtl() {
  if (!data.value) return;
  ttlInput.value = data.value.ttl > 0 ? String(data.value.ttl) : "";
  editingTtl.value = true;
  void nextTick(() => ttlInputEl.value?.$el?.focus());
}

async function saveTtl() {
  const val = ttlInput.value.trim();
  const ttl = val === "" || val === "-1" ? -1 : parseInt(val, 10);
  if (isNaN(ttl)) {
    toast(t("redis.ttlInvalid"), 3000);
    return;
  }
  await api.redisSetTtl(props.connectionId, props.db, props.keyRaw, ttl);
  editingTtl.value = false;
  await load();
}

function cancelEditTtl() {
  editingTtl.value = false;
}

// Hash
async function hashSet() {
  if (!newField.value.trim()) {
    toast(t("redis.fieldRequired"), 3000);
    return;
  }
  await api.redisHashSet(props.connectionId, props.db, props.keyRaw, newField.value, newValue.value);
  newField.value = "";
  newValue.value = "";
  await load();
}
async function applyHashDel(field: string) {
  await api.redisHashDel(props.connectionId, props.db, props.keyRaw, field);
  await load();
}

// List
async function listPush() {
  if (!newValue.value.trim()) {
    toast(t("redis.valueRequired"), 3000);
    return;
  }
  await api.redisListPush(props.connectionId, props.db, props.keyRaw, newValue.value);
  newValue.value = "";
  await load();
}
async function applyListRemove(index: number) {
  await api.redisListRemove(props.connectionId, props.db, props.keyRaw, index);
  await load();
}
function requestListRemove(index: number) {
  pendingDelete.value = { kind: "list", index };
  showDeleteConfirm.value = true;
}

// Set
async function setAdd() {
  if (!newValue.value.trim()) {
    toast(t("redis.memberRequired"), 3000);
    return;
  }
  await api.redisSetAdd(props.connectionId, props.db, props.keyRaw, newValue.value);
  newValue.value = "";
  await load();
}
async function applySetRemove(member: string) {
  await api.redisSetRemove(props.connectionId, props.db, props.keyRaw, member);
  await load();
}

// ZSet
async function zsetAdd() {
  if (!newValue.value.trim()) {
    toast(t("redis.memberRequired"), 3000);
    return;
  }
  const score = parseFloat(newScore.value || "0");
  await api.redisZadd(props.connectionId, props.db, props.keyRaw, newValue.value, score);
  newValue.value = "";
  newScore.value = "";
  await load();
}
async function applyZsetRemove(member: string) {
  await api.redisZrem(props.connectionId, props.db, props.keyRaw, member);
  await load();
}

async function confirmDelete() {
  const pending = pendingDelete.value;
  if (!pending) return;
  if (pending.kind === "key") await applyDeleteKey();
  else if (pending.kind === "hash") await applyHashDel(pending.field);
  else if (pending.kind === "list") await applyListRemove(pending.index);
  else if (pending.kind === "set") await applySetRemove(pending.member);
  else if (pending.kind === "zset") await applyZsetRemove(pending.member);
  pendingDelete.value = null;
}

function formatValue(val: unknown): string {
  if (isRedisBlob(val)) return formatRedisMemberDetail(val).text;
  if (typeof val === "string") return formatRedisMemberDetail(val).text;
  return JSON.stringify(val, null, 2);
}

onMounted(() => {
  void load();
  void createShikiJsonHighlighter({
    appearance: () => redisJsonAppearance.value,
  })
    .then((highlight) => {
      redisJsonHighlighter.value = highlight;
    })
    .catch(() => {
      redisJsonHighlighter.value = undefined;
    });
});
onBeforeUnmount(() => {
  stopAutoRefresh();
  stopResizeMemberSheet();
  stopResizeHashColumns();
  stopResizeZsetColumns();
  if (hashSearchTimer) clearTimeout(hashSearchTimer);
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden" :style="editorFontFamilyStyle">
    <div v-if="loading" class="flex-1 flex items-center justify-center text-muted-foreground">
      {{ t("common.loading") }}
    </div>

    <template v-else-if="data">
      <!-- Header -->
      <div class="shrink-0 border-b bg-background">
        <div class="flex h-9 items-center gap-2 px-4">
          <span class="dbx-editor-font-family min-w-0 flex-1 truncate text-sm font-semibold">{{ formatValue(data.key_display) }}</span>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 animate-none" @click="load"><RefreshCw class="h-3.5 w-3.5 animate-none" /></Button>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" @click="copyValue"><Copy class="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="t('redis.copyInsertStatement')" @click="copyInsertStatement"><Terminal class="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-destructive" @click="requestDeleteKey"><Trash2 class="h-3.5 w-3.5" /></Button>
        </div>

        <div class="flex min-h-7 flex-wrap items-center gap-2 px-4 pb-1">
          <Badge variant="secondary" class="dbx-editor-font-family text-xs uppercase">{{ data.redis_type }}</Badge>
          <Badge v-if="metadataSizeLabel" variant="outline" class="text-xs text-muted-foreground"> {{ t("redis.columnSize") }}: {{ metadataSizeLabel }} </Badge>
          <template v-if="!editingTtl">
            <Badge v-if="data.ttl > 0" variant="outline" class="text-xs cursor-pointer text-muted-foreground hover:bg-accent" @click="startEditTtl">TTL: {{ formatTtl(computeDisplayTtl(autoRefreshEnabled, countdownTtl, data.ttl), t) }}</Badge>
            <Badge v-else-if="data.ttl === -1" variant="outline" class="text-xs cursor-pointer text-muted-foreground hover:bg-accent" @click="startEditTtl">{{ t("redis.noExpiry") }}</Badge>
          </template>
          <div ref="editTtlWrapper" v-else class="flex items-center gap-1">
            <Input ref="ttlInputEl" v-model="ttlInput" class="h-6 w-20 text-xs" placeholder="seconds (-1=no expiry)" @keydown.enter="saveTtl" @keydown.escape="cancelEditTtl" />
            <Button variant="ghost" size="icon" class="h-6 w-6" @click="saveTtl"><Save class="h-3 w-3" /></Button>
          </div>
          <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :class="{ 'text-primary bg-accent': autoRefreshEnabled }" :title="t('redis.autoRefresh')" @click="toggleAutoRefresh">
            <Clock class="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <!-- String -->
      <div v-if="isStringLikeKind && stringValueDetail" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex h-9 items-center gap-2 border-b px-4 text-xs shrink-0">
          <div class="flex max-w-full overflow-x-auto rounded-md border bg-muted/20 p-0.5">
            <Button
              v-for="format in REDIS_VALUE_FORMAT_DISPLAY_ORDER"
              :key="format"
              variant="ghost"
              size="sm"
              class="h-6 shrink-0 rounded-[5px] px-2 text-xs"
              :class="{ 'bg-background shadow-sm': stringValueView === format }"
              :disabled="!canRenderRedisValueFormat(stringValueDetail, format)"
              @click="setStringValueFormat(format)"
            >
              {{ redisFormatLabel(format, stringValueDetail.rawLabel) }}
            </Button>
          </div>
          <span class="flex-1" />
          <label v-if="isTextRedisFormat(stringValueView)" class="flex items-center gap-1.5 text-muted-foreground">
            <WrapText class="h-3.5 w-3.5" />
            {{ t("redis.wordWrap") }}
            <Switch size="sm" :model-value="redisJsonWordWrap" @update:model-value="setRedisJsonWordWrap(Boolean($event))" />
          </label>
        </div>
        <div v-if="stringValueView === 'json' && stringValueDetail.json" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-4 text-sm leading-6">
          <JsonTree :value="stringValueDetail.json.value" :word-wrap="redisJsonWordWrap" :highlight-json="highlightRedisJson" />
        </div>
        <div v-else-if="stringValueView === 'javaserialize' && stringValueDetail.javaSerialized" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-4 text-sm leading-6">
          <JsonTree :value="stringValueDetail.javaSerialized.value" :word-wrap="redisJsonWordWrap" :highlight-json="highlightRedisJson" />
        </div>
        <div v-else-if="stringValueView === 'hex'" class="min-h-0 flex-1 overflow-auto bg-background p-4 text-xs leading-5">
          <div class="mb-3 flex items-center justify-between text-muted-foreground">
            <span>{{ t("grid.hexViewer") }}</span>
            <span>{{ t("grid.hexViewerByteCount", { count: stringValueDetail.byteCount }) }}</span>
          </div>
          <pre v-if="stringValueDetail.hexRows.length > 0" class="dbx-editor-font-family w-full min-w-0 max-w-full select-all whitespace-pre-wrap break-all">{{ detailTextForFormat(stringValueDetail, "hex") }}</pre>
          <div v-else class="text-muted-foreground">{{ t("grid.hexViewerEmpty") }}</div>
        </div>
        <pre v-else-if="stringValueView === 'base64'" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-4 text-sm leading-6 whitespace-pre-wrap break-all">{{ stringValueDetail.base64Text }}</pre>
        <textarea
          v-else-if="stringValueView === 'utf8' && canEditCurrentStringFormat"
          v-model="editValue"
          class="dbx-editor-font-family flex-1 resize-none bg-background p-4 text-sm outline-none"
          :class="redisJsonWordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
          :readonly="!canEditCurrentStringFormat"
          spellcheck="false"
          @input="handleStringInput"
        />
        <pre v-else-if="stringValueView === 'utf8'" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-4 text-sm leading-6" :class="detailTextClass(stringValueView)">{{ detailTextForFormat(stringValueDetail, stringValueView) }}</pre>
        <pre v-else class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-4 text-sm leading-6" :class="detailTextClass(stringValueView)">{{ detailTextForFormat(stringValueDetail, stringValueView) }}</pre>
        <div v-if="isBinaryStringValue" class="px-4 py-2 border-t text-xs text-muted-foreground shrink-0">
          {{ t("redis.binaryStringReadonlyHint") }}
        </div>
        <div v-if="showStringEditActions" class="px-4 py-2 border-t flex justify-end gap-2 shrink-0">
          <Button variant="ghost" size="sm" :disabled="!stringValueChanged" @click="discardStringEdit">{{ t("grid.discard") }}</Button>
          <Button size="sm" :disabled="!stringValueChanged" @click="saveString"><Save class="w-3 h-3 mr-1" /> {{ t("grid.save") }}</Button>
        </div>
      </div>

      <!-- Redis JSON -->
      <div v-else-if="redisKind === 'json' && redisJsonValue != null" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex h-9 items-center gap-2 border-b px-4 text-xs shrink-0">
          <div class="flex overflow-hidden rounded-md border bg-muted/20 p-0.5">
            <Button variant="ghost" size="sm" class="h-6 rounded-[5px] px-2 text-xs" :class="{ 'bg-background shadow-sm': redisJsonView === 'raw' }" @click="redisJsonView = 'raw'">
              {{ t("redis.rawContent") }}
            </Button>
            <Button variant="ghost" size="sm" class="h-6 rounded-[5px] px-2 text-xs" :class="{ 'bg-background shadow-sm': redisJsonView === 'tree' }" @click="redisJsonView = 'tree'">
              {{ t("redis.jsonView") }}
            </Button>
          </div>
          <span class="flex-1" />
          <Button v-if="redisJsonView === 'raw'" variant="ghost" size="sm" class="h-6 rounded-[5px] px-2 text-xs" :title="t('redis.formatJson')" @click="handleFormatJsonEditor">
            <IndentIncrease class="h-3.5 w-3.5" />
          </Button>
          <Button v-if="redisJsonView === 'raw'" variant="ghost" size="sm" class="h-6 rounded-[5px] px-2 text-xs" :title="t('redis.compressJson')" @click="handleCompressJsonEditor">
            <IndentDecrease class="h-3.5 w-3.5" />
          </Button>
          <label v-if="redisJsonView === 'raw'" class="flex items-center gap-1.5 text-muted-foreground">
            <WrapText class="h-3.5 w-3.5" />
            {{ t("redis.wordWrap") }}
            <Switch size="sm" :model-value="redisJsonWordWrap" @update:model-value="setRedisJsonWordWrap(Boolean($event))" />
          </label>
        </div>
        <div v-if="redisJsonView === 'tree'" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-4 text-sm leading-6">
          <JsonTree :value="redisJsonValue" :word-wrap="redisJsonWordWrap" :highlight-json="highlightRedisJson" />
        </div>
        <textarea v-else v-model="editValue" class="dbx-editor-font-family flex-1 resize-none bg-background p-4 text-sm outline-none" :class="redisJsonWordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'" spellcheck="false" @input="handleJsonInput" />
        <div v-if="isEditing" class="px-4 py-2 border-t flex justify-end gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            @click="
              isEditing = false;
              editValue = JSON.stringify(redisJsonValue, null, 2);
            "
            >{{ t("grid.discard") }}</Button
          >
          <Button size="sm" @click="saveJson"><Save class="w-3 h-3 mr-1" /> {{ t("grid.save") }}</Button>
        </div>
      </div>

      <!-- List -->
      <div v-else-if="redisKind === 'list'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{ collectionCountLabel("items", listRows.length, collectionTotal) }}</span>
          <span class="flex-1" />
          <Input v-model="newValue" class="h-6 w-40 text-xs" placeholder="value" @keydown.enter="listPush" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="listPush"><Plus class="w-3 h-3 mr-1" />Push</Button>
        </div>
        <div class="grid grid-cols-[60px_1fr_84px] border-b bg-muted/50 shrink-0">
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground border-r">#</div>
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground">Value</div>
          <div />
        </div>
        <RecycleScroller class="flex-1 overflow-y-auto" :items="listRows" :item-size="REDIS_COLLECTION_ROW_HEIGHT" :buffer="600" :skip-hover="true" key-field="id">
          <template #default="{ item: row }">
            <div
              data-redis-value-row
              class="dbx-editor-font-family grid grid-cols-[60px_1fr_84px] border-b text-sm hover:bg-accent/50 group cursor-pointer"
              :class="{ 'bg-accent/60': isSelectedMember(`#${row.value.index}`, row.value.value) }"
              :style="{ height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }"
              @click="viewMember(`#${row.value.index}`, row.value.value, { kind: 'list', index: row.value.index, canEdit: canEditRedisMemberDetail('list', row.value.value) })"
            >
              <div class="px-3 py-1.5 text-xs text-muted-foreground border-r">{{ row.value.index }}</div>
              <div class="px-3 py-1.5 truncate">{{ formatValue(row.value.value) }}</div>
              <div class="flex items-center justify-center gap-1">
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.viewMember')" @click.stop="viewMember(`#${row.value.index}`, row.value.value, { kind: 'list', index: row.value.index, canEdit: canEditRedisMemberDetail('list', row.value.value) })"
                  ><Eye class="w-3 h-3"
                /></Button>
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.copyMember')" @click.stop="copyMember(row.value.value)"><Copy class="w-3 h-3" /></Button>
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive" @click.stop="requestListRemove(row.value.index)"><Trash2 class="w-3 h-3" /></Button>
              </div>
            </div>
          </template>
          <template #after>
            <div v-if="hasMore" class="p-2">
              <Button variant="outline" size="sm" class="w-full h-7 text-xs" :disabled="loadingMore" @click="loadMore">
                <Loader2 v-if="loadingMore" class="w-3 h-3 mr-1.5 animate-spin" />
                {{ t("redis.loadMoreKeys") }}
              </Button>
            </div>
          </template>
        </RecycleScroller>
      </div>

      <!-- Set -->
      <div v-else-if="redisKind === 'set'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{ collectionCountLabel("items", setRows.length, collectionTotal) }}</span>
          <span class="flex-1" />
          <Input v-model="newValue" class="h-6 w-40 text-xs" placeholder="member" @keydown.enter="setAdd" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="setAdd"><Plus class="w-3 h-3 mr-1" />Add</Button>
        </div>
        <div class="grid grid-cols-[1fr_84px] border-b bg-muted/50 shrink-0">
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground">Member</div>
          <div />
        </div>
        <RecycleScroller class="flex-1 overflow-y-auto" :items="setRows" :item-size="REDIS_COLLECTION_ROW_HEIGHT" :buffer="600" :skip-hover="true" key-field="id">
          <template #default="{ item: row }">
            <div
              data-redis-value-row
              class="dbx-editor-font-family grid grid-cols-[1fr_84px] border-b text-sm hover:bg-accent/50 group cursor-pointer"
              :class="{ 'bg-accent/60': isSelectedMember(t('redis.member'), row.value.member) }"
              :style="{ height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }"
              @click="viewMember(t('redis.member'), row.value.member, { kind: 'set', member: redisBlobText(row.value.member), canEdit: redisBlobText(row.value.member) != null && canEditRedisMemberDetail('set', row.value.member) })"
            >
              <div class="px-3 py-1.5 truncate">{{ formatValue(row.value.member) }}</div>
              <div class="flex items-center justify-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.viewMember')"
                  @click.stop="viewMember(t('redis.member'), row.value.member, { kind: 'set', member: redisBlobText(row.value.member), canEdit: redisBlobText(row.value.member) != null && canEditRedisMemberDetail('set', row.value.member) })"
                  ><Eye class="w-3 h-3"
                /></Button>
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.copyMember')" @click.stop="copyMember(row.value.member)"><Copy class="w-3 h-3" /></Button>
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive" :disabled="!canDeleteSetItem(row.value)" @click.stop="requestSetRemove(redisBlobText(row.value.member))"><Trash2 class="w-3 h-3" /></Button>
              </div>
            </div>
          </template>
          <template #after>
            <div v-if="hasMore" class="p-2">
              <Button variant="outline" size="sm" class="w-full h-7 text-xs" :disabled="loadingMore" @click="loadMore">
                <Loader2 v-if="loadingMore" class="w-3 h-3 mr-1.5 animate-spin" />
                {{ t("redis.loadMoreKeys") }}
              </Button>
            </div>
          </template>
        </RecycleScroller>
      </div>

      <!-- Hash -->
      <div v-else-if="redisKind === 'hash'" ref="hashTableRef" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground shrink-0">{{ collectionCountLabel("fields", hashCollectionRows.length, activeHashSearchQuery ? null : collectionTotal) }}</span>
          <div class="relative flex-1 max-w-60">
            <Search class="pointer-events-none absolute left-1.5 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground/80" />
            <Input v-model="hashSearchQuery" class="h-6 w-full pl-5 pr-2 text-xs" :placeholder="t('redis.searchFields')" @input="onHashSearchInput" @keydown="onHashSearchKeydown" />
          </div>
          <span class="flex-1" />
          <Input v-model="newField" class="h-6 w-24 text-xs" placeholder="field" />
          <Input v-model="newValue" class="h-6 w-32 text-xs" placeholder="value" @keydown.enter="hashSet" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="hashSet"><Plus class="w-3 h-3 mr-1" />Set</Button>
        </div>
        <div class="grid border-b bg-muted/50 shrink-0" :style="hashGridStyle">
          <div
            class="relative px-3 py-1 text-xs font-medium text-muted-foreground border-r select-none cursor-pointer hover:bg-accent/50 flex items-center gap-1"
            role="columnheader"
            :aria-sort="hashSortBy === 'field' ? (hashSortDir === 'asc' ? 'ascending' : 'descending') : 'none'"
            @click="toggleHashSort('field')"
          >
            Field
            <ArrowUp v-if="hashSortBy === 'field' && hashSortDir === 'asc'" class="h-3 w-3 shrink-0" />
            <ArrowDown v-else-if="hashSortBy === 'field' && hashSortDir === 'desc'" class="h-3 w-3 shrink-0" />
            <ArrowUpDown v-else class="h-3 w-3 shrink-0 text-muted-foreground/40" />
            <div class="absolute -right-1 top-0 h-full w-2 cursor-col-resize touch-none" @pointerdown.prevent="startResizeHashColumns" />
          </div>
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground cursor-pointer hover:bg-accent/50 flex items-center gap-1 select-none" role="columnheader" :aria-sort="hashSortBy === 'value' ? (hashSortDir === 'asc' ? 'ascending' : 'descending') : 'none'" @click="toggleHashSort('value')">
            Value
            <ArrowUp v-if="hashSortBy === 'value' && hashSortDir === 'asc'" class="h-3 w-3 shrink-0" />
            <ArrowDown v-else-if="hashSortBy === 'value' && hashSortDir === 'desc'" class="h-3 w-3 shrink-0" />
            <ArrowUpDown v-else class="h-3 w-3 shrink-0 text-muted-foreground/40" />
          </div>
          <div />
        </div>
        <RecycleScroller class="flex-1 overflow-y-auto" :items="hashCollectionRows" :item-size="REDIS_COLLECTION_ROW_HEIGHT" :buffer="600" :skip-hover="true" key-field="id">
          <template #default="{ item: row }">
            <div
              data-redis-value-row
              class="dbx-editor-font-family grid border-b text-sm hover:bg-accent/50 group cursor-pointer"
              :style="{ ...hashGridStyle, height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }"
              :class="{ 'bg-accent/60': isSelectedMember(formatValue(row.value.field), row.value.value) }"
              @click="viewMember(formatValue(row.value.field), row.value.value, { kind: 'hash', field: redisBlobText(row.value.field), canEdit: redisBlobText(row.value.field) != null && canEditRedisMemberDetail('hash', row.value.value) })"
            >
              <div class="px-3 py-1.5 text-blue-500 truncate border-r">{{ formatValue(row.value.field) }}</div>
              <div class="px-3 py-1.5 truncate text-muted-foreground">{{ formatValue(row.value.value) }}</div>
              <div class="flex items-center justify-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.viewMember')"
                  @click.stop="viewMember(formatValue(row.value.field), row.value.value, { kind: 'hash', field: redisBlobText(row.value.field), canEdit: redisBlobText(row.value.field) != null && canEditRedisMemberDetail('hash', row.value.value) })"
                  ><Eye class="w-3 h-3"
                /></Button>
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.copyMember')" @click.stop="copyMember(row.value.value)"><Copy class="w-3 h-3" /></Button>
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive" :disabled="!canDeleteHashItem(row.value)" @click.stop="requestHashDel(redisBlobText(row.value.field))"><Trash2 class="w-3 h-3" /></Button>
              </div>
            </div>
          </template>
          <template #after>
            <div v-if="hasMore" class="p-2">
              <Button variant="outline" size="sm" class="w-full h-7 text-xs" :disabled="loadingMore || searchLoading" @click="loadMore">
                <Loader2 v-if="loadingMore" class="w-3 h-3 mr-1.5 animate-spin" />
                {{ t("redis.loadMoreKeys") }}
              </Button>
            </div>
          </template>
        </RecycleScroller>
      </div>

      <!-- Sorted Set -->
      <div v-else-if="redisKind === 'zset'" ref="zsetTableRef" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{ collectionCountLabel("members", zsetRows.length, collectionTotal) }}</span>
          <span class="flex-1" />
          <Input v-model="newScore" class="h-6 w-20 text-xs" placeholder="score" />
          <Input v-model="newValue" class="h-6 w-32 text-xs" placeholder="member" @keydown.enter="zsetAdd" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="zsetAdd"><Plus class="w-3 h-3 mr-1" />Add</Button>
        </div>
        <div class="grid border-b bg-muted/50 shrink-0" :style="zsetGridStyle">
          <div class="relative px-3 py-1 text-xs font-medium text-muted-foreground border-r select-none">
            Score
            <div class="absolute -right-1 top-0 h-full w-2 cursor-col-resize touch-none" @pointerdown.prevent="startResizeZsetColumns" />
          </div>
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground min-w-0">Member</div>
          <div />
        </div>
        <RecycleScroller class="flex-1 overflow-y-auto" :items="zsetRows" :item-size="REDIS_COLLECTION_ROW_HEIGHT" :buffer="600" :skip-hover="true" key-field="id">
          <template #default="{ item: row }">
            <div
              data-redis-value-row
              class="dbx-editor-font-family grid border-b text-sm hover:bg-accent/50 group cursor-pointer"
              :class="{ 'bg-accent/60': isSelectedMember(String(row.value.score), row.value.member) }"
              :style="{ ...zsetGridStyle, height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }"
              @click="viewMember(row.value.score, row.value.member, { kind: 'zset', member: redisBlobText(row.value.member), score: row.value.score, canEdit: redisBlobText(row.value.member) != null && canEditRedisMemberDetail('zset', row.value.member) })"
            >
              <div class="px-3 py-1.5 text-muted-foreground text-xs border-r min-w-0 truncate" :title="String(row.value.score)">
                {{ row.value.score }}
              </div>
              <div class="px-3 py-1.5 min-w-0 truncate" :title="formatValue(row.value.member)">
                {{ formatValue(row.value.member) }}
              </div>
              <div class="flex items-center justify-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.viewMember')"
                  @click.stop="viewMember(row.value.score, row.value.member, { kind: 'zset', member: redisBlobText(row.value.member), score: row.value.score, canEdit: redisBlobText(row.value.member) != null && canEditRedisMemberDetail('zset', row.value.member) })"
                  ><Eye class="w-3 h-3"
                /></Button>
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.copyMember')" @click.stop="copyMember(row.value.member)"><Copy class="w-3 h-3" /></Button>
                <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive" :disabled="!canDeleteZsetItem(row.value)" @click.stop="requestZsetRemove(redisBlobText(row.value.member))"><Trash2 class="w-3 h-3" /></Button>
              </div>
            </div>
          </template>
          <template #after>
            <div v-if="hasMore" class="p-2">
              <Button variant="outline" size="sm" class="w-full h-7 text-xs" :disabled="loadingMore" @click="loadMore">
                <Loader2 v-if="loadingMore" class="w-3 h-3 mr-1.5 animate-spin" />
                {{ t("redis.loadMoreKeys") }}
              </Button>
            </div>
          </template>
        </RecycleScroller>
      </div>

      <!-- Stream (readonly) -->
      <div v-else-if="redisKind === 'stream'" class="flex-1 flex flex-col overflow-hidden">
        <div class="px-4 py-1 text-xs text-muted-foreground border-b shrink-0">
          {{ t("redis.entries", { count: streamRows.length }) }}
        </div>
        <DynamicScroller class="flex-1 overflow-y-auto" :items="streamRows" :min-item-size="REDIS_STREAM_MIN_ROW_HEIGHT" :buffer="600" key-field="id">
          <template #default="{ item: row, active }">
            <DynamicScrollerItem :item="row" :active="active" :size-dependencies="[streamFieldCount(row)]" :data-index="row.index">
              <div data-redis-stream-entry class="dbx-editor-font-family px-4 py-2 border-b text-sm hover:bg-accent/50">
                <div class="mb-1 text-xs text-muted-foreground">{{ row.entry.id }}</div>
                <div
                  v-for="(field, fieldIndex) in row.entry.fields"
                  :key="`${row.id}:${field.field}:${fieldIndex}`"
                  class="grid grid-cols-[minmax(6rem,0.35fr)_1fr_56px] gap-3 py-0.5 group cursor-pointer"
                  :class="{ 'bg-accent/60': isSelectedMember(field.field, field.value, streamFieldSelectionIdentity(row.entry.id, fieldIndex)) }"
                  @click="viewMember(field.field, field.value, { kind: 'stream', field: field.field, canEdit: false }, streamFieldSelectionIdentity(row.entry.id, fieldIndex))"
                >
                  <span class="truncate text-blue-500">{{ field.field }}</span>
                  <span class="truncate text-muted-foreground">{{ field.value }}</span>
                  <span class="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.viewMember')" @click.stop="viewMember(field.field, field.value, { kind: 'stream', field: field.field, canEdit: false }, streamFieldSelectionIdentity(row.entry.id, fieldIndex))"
                      ><Eye class="w-3 h-3"
                    /></Button>
                    <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.copyMember')" @click.stop="copyMember(field.value)"><Copy class="w-3 h-3" /></Button>
                  </span>
                </div>
              </div>
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>
      </div>

      <!-- Unknown -->
      <div v-else class="flex-1 overflow-auto p-4">
        <pre class="dbx-editor-font-family text-sm whitespace-pre-wrap">{{ formatValue(data.data) }}</pre>
      </div>
    </template>

    <DangerConfirmDialog v-model:open="showDeleteConfirm" :message="t('dangerDialog.deleteMessage')" :details="deleteDetails" :confirm-label="t('dangerDialog.deleteConfirm')" @confirm="confirmDelete" />

    <Sheet :open="showMemberDetail" @update:open="handleMemberDetailOpenChange">
      <SheetContent
        side="right"
        class="gap-0 p-0 sm:max-w-[calc(100vw-2rem)]"
        :class="{ 'select-none': isResizingMemberSheet }"
        :style="[editorFontFamilyStyle, { width: `${memberDetailSheetWidth}px`, maxWidth: 'calc(100vw - 2rem)' }]"
        @close-auto-focus="finishMemberDetailClose"
        @pointer-down-outside.prevent
        @interact-outside.prevent
      >
        <div class="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize border-l border-transparent hover:border-primary/60" @pointerdown.prevent="startResizeMemberSheet" />
        <SheetHeader class="border-b px-5 py-4 pr-12">
          <SheetTitle class="flex items-center gap-2">
            <span class="truncate">{{ selectedMemberTitle ? formatValue(selectedMemberTitle) : t("redis.memberDetail") }}</span>
            <Badge variant="outline" class="shrink-0 text-xs">{{ redisFormatLabel(memberValueView, selectedMemberDetail.rawLabel) }}</Badge>
          </SheetTitle>
        </SheetHeader>
        <template v-if="isEditingMember">
          <textarea v-model="memberEditValue" class="dbx-editor-font-family min-h-0 flex-1 resize-none bg-background p-5 text-[13px] leading-6 outline-none" spellcheck="false" />
        </template>
        <template v-else>
          <div class="flex h-9 items-center gap-2 border-b px-5 text-xs">
            <div class="flex max-w-full overflow-x-auto rounded-md border bg-muted/20 p-0.5">
              <Button
                v-for="format in REDIS_VALUE_FORMAT_DISPLAY_ORDER"
                :key="format"
                variant="ghost"
                size="sm"
                class="h-6 shrink-0 rounded-[5px] px-2 text-xs"
                :class="{ 'bg-background shadow-sm': memberValueView === format }"
                :disabled="!canRenderRedisValueFormat(selectedMemberDetail, format)"
                @click="setMemberValueFormat(format)"
              >
                {{ redisFormatLabel(format, selectedMemberDetail.rawLabel) }}
              </Button>
            </div>
            <span class="flex-1" />
            <label v-if="isTextRedisFormat(memberValueView)" class="flex items-center gap-1.5 text-muted-foreground">
              <WrapText class="h-3.5 w-3.5" />
              {{ t("redis.wordWrap") }}
              <Switch size="sm" :model-value="redisJsonWordWrap" @update:model-value="setRedisJsonWordWrap(Boolean($event))" />
            </label>
          </div>
          <div v-if="memberValueView === 'json' && selectedMemberDetail.json" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-5 text-[13px] leading-6">
            <JsonTree :value="selectedMemberDetail.json.value" :word-wrap="redisJsonWordWrap" :highlight-json="highlightRedisJson" />
          </div>
          <div v-else-if="memberValueView === 'javaserialize' && selectedMemberDetail.javaSerialized" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-5 text-[13px] leading-6">
            <JsonTree :value="selectedMemberDetail.javaSerialized.value" :word-wrap="redisJsonWordWrap" :highlight-json="highlightRedisJson" />
          </div>
          <div v-else-if="memberValueView === 'hex'" class="min-h-0 flex-1 overflow-auto bg-background p-5 text-xs leading-5">
            <div class="mb-3 flex items-center justify-between text-muted-foreground">
              <span>{{ t("grid.hexViewer") }}</span>
              <span>{{ t("grid.hexViewerByteCount", { count: selectedMemberDetail.byteCount }) }}</span>
            </div>
            <pre v-if="selectedMemberDetail.hexRows.length > 0" class="dbx-editor-font-family w-full min-w-0 max-w-full select-all whitespace-pre-wrap break-all">{{ detailTextForFormat(selectedMemberDetail, "hex") }}</pre>
            <div v-else class="text-muted-foreground">{{ t("grid.hexViewerEmpty") }}</div>
          </div>
          <pre v-else-if="memberValueView === 'base64'" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-5 text-[13px] leading-6 whitespace-pre-wrap break-all">{{ selectedMemberDetail.base64Text }}</pre>
          <pre v-else class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-5 text-[13px] leading-6" :class="detailTextClass(memberValueView)">{{ detailTextForFormat(selectedMemberDetail, memberValueView) }}</pre>
        </template>
        <SheetFooter class="shrink-0 border-t px-5 py-3">
          <template v-if="isEditingMember">
            <Button variant="ghost" :disabled="savingMember" @click="cancelEditMember">
              {{ t("grid.discard") }}
            </Button>
            <Button :disabled="savingMember" @click="saveMemberEdit">
              <Loader2 v-if="savingMember" class="h-4 w-4 animate-spin" />
              <Save v-else class="h-4 w-4" />
              {{ t("grid.save") }}
            </Button>
          </template>
          <Button v-else-if="canEditCurrentMemberFormat" variant="outline" @click="startEditMember">
            <Pencil class="h-4 w-4" />
            {{ t("redis.editMember") }}
          </Button>
          <Button variant="outline" @click="copyText(detailTextForFormat(selectedMemberDetail, memberValueView))">
            <Copy class="h-4 w-4" />
            {{ t("redis.copyMember") }}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  </div>
</template>

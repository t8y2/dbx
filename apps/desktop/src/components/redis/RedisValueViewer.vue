<script setup lang="ts">
import { computed, ref, shallowRef, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, watch } from "vue";
import type { CalendarDateTime } from "@internationalized/date";
import { useI18n } from "vue-i18n";
import { onClickOutside } from "@vueuse/core";
import { DynamicScroller, DynamicScrollerItem, RecycleScroller } from "vue-virtual-scroller";
import { Check, ChevronDown, Copy, ClipboardCopy, Eye, Trash2, Save, RefreshCw, Plus, Loader2, Pencil, WrapText, ArrowUp, ArrowDown, ArrowUpDown, Search, X, FileArchive } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DateTimePicker from "@/components/ui/date-time-picker/DateTimePicker.vue";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import JsonTree from "@/components/common/JsonTree.vue";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import * as api from "@/lib/backend/api";
import type { RedisBlob, RedisHashItem, RedisKeyInfo, RedisListItem, RedisSetItem, RedisStreamConsumer, RedisStreamEntry, RedisStreamGroup, RedisStreamPendingEntry, RedisValue, RedisZsetItem } from "@/lib/backend/api";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useEditorFontFamilyStyle } from "@/composables/useEditorFontFamilyStyle";
import { createShikiJsonHighlighter, type JsonHighlighter } from "@/lib/common/shikiJsonHighlighter";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatTtl } from "@/lib/common/ttlFormat";
import { computeDisplayTtl, computeTtlCountdownTick, computeTtlCountdownValue, computeTtlForExpiryEdit, DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS, normalizeRedisAutoRefreshInterval } from "@/lib/redis/redisAutoRefresh";
import {
  canRenderRedisValueFormat,
  canEditRedisMemberDetail,
  decodeRedisBlob,
  formatRedisMemberDetail,
  getRedisMemberSelectionKey,
  isRedisBlob,
  parseRedisJsonDetail,
  preferredRedisValueFormat,
  REDIS_VALUE_FORMAT_DISPLAY_ORDER,
  redisBlobText,
  redisCollectionPageItems,
  redisJsonValueText,
  normalizeRedisJsonDraft,
  redisClipboardSafeText,
  redisMemberCopyText,
  redisValueCopyText,
  redisValueCollectionItems,
  redisValueCollectionScanCursor,
  redisValueCollectionTotal,
  type RedisCollectionItem,
  type RedisValueFormat,
} from "@/lib/redis/redisValuePresentation";
import { decompressRedisValue, isGzipMagic, type RedisDecompressAlgorithm } from "@/lib/redis/redisCompression";
import { canFullHighlightRedisText, findRedisTextMatches, nextRedisSearchMatchIndex, REDIS_VALUE_SEARCH_MATCH_LIMIT, renderRedisTextSearchHtml, redisValueSearchStatus } from "@/lib/redis/redisValueSearch";
import TextContentSearchBar from "@/components/common/TextContentSearchBar.vue";
import { decodeJsonUnicodeEscapes, formatJsonSource, mapDisplayToRaw } from "@/lib/common/safeJsonFormat";
import { unixSecondsToCalendarDateTime } from "@/components/ui/date-time-picker/dateTimePicker";
import { applyRedisExpiryPolicy, type RedisExpiryMode, redisExpiryModeForTtl, validateRedisExpiry } from "@/lib/redis/redisExpiry";

const { t, locale } = useI18n();
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

const redisExpiryTransport = {
  setTtl: api.redisSetTtl,
  setExpireAt: api.redisSetExpireAt,
};

const emit = defineEmits<{ deleted: [keyRaw: string]; loaded: [value: RedisValue] }>();

const REDIS_JSON_WRAP_STORAGE_KEY = "dbx-redis-json-word-wrap";
const REDIS_JSON_UNICODE_MODE_STORAGE_KEY = "dbx-redis-json-unicode-mode";
const REDIS_VALUE_FORMAT_STORAGE_KEY = "dbx-redis-value-format";
// Versioned after moving the setting into the refresh menu so the previous
// always-on default does not carry into the new manual-refresh default.
const REDIS_AUTO_REFRESH_ENABLED_STORAGE_KEY = "dbx-redis-auto-refresh-enabled-v2";
const REDIS_AUTO_REFRESH_INTERVAL_STORAGE_KEY = "dbx-redis-auto-refresh-interval-seconds-v2";
const REDIS_AUTO_REFRESH_INTERVAL_OPTIONS = [1, 3, 5, 10] as const;
const REDIS_COLLECTION_ROW_HEIGHT = 32;
const REDIS_STREAM_MIN_ROW_HEIGHT = 96;

const data = ref<RedisValue | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
let loadRequestId = 0;
const streamTab = ref<"entries" | "groups">("entries");
const streamEntries = ref<RedisStreamEntry[]>([]);
const streamEntriesCursor = ref<string | undefined>();
const streamEntriesLoadingMore = ref(false);
const streamGroups = ref<RedisStreamGroup[]>([]);
const streamGroupsLoaded = ref(false);
const streamGroupsLoading = ref(false);
const streamGroupsError = ref("");
const selectedStreamGroup = ref<RedisStreamGroup | null>(null);
const selectedStreamConsumer = ref<RedisStreamConsumer | null>(null);
const streamConsumers = ref<RedisStreamConsumer[]>([]);
const streamConsumersLoading = ref(false);
const streamConsumersError = ref("");
const streamPendingEntries = ref<RedisStreamPendingEntry[]>([]);
const streamPendingCursor = ref<string | undefined>();
const streamPendingLoading = ref(false);
const streamPendingLoadingMore = ref(false);
const streamPendingError = ref("");
const streamDateTimeFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }),
);
let streamGroupsRequestId = 0;
let streamGroupDetailRequestId = 0;
let streamConsumersRequestId = 0;
let streamPendingRequestId = 0;
let streamEntriesRequestId = 0;
const editValue = ref("");
const savingString = ref(false);
const savingJson = ref(false);
const newField = ref("");
const newValue = ref("");
const newScore = ref("");
const showDeleteConfirm = ref(false);
const showMemberDetail = ref(false);
const editingTtl = ref(false);
const savingTtl = ref(false);
const ttlExpiryMode = ref<RedisExpiryMode>("none");
const ttlInput = ref("");
const ttlExpireAt = shallowRef<CalendarDateTime | null>(null);
const ttlInputEl = ref<InstanceType<typeof Input>>();
const editTtlWrapper = ref<HTMLElement>();
onClickOutside(
  editTtlWrapper,
  () => {
    if (editingTtl.value && !savingTtl.value) cancelEditTtl();
  },
  { ignore: ["[data-date-time-picker-content]", "[data-redis-expiry-mode-content]"] },
);
const collectionItems = ref<RedisCollectionItem[]>([]);
const scanCursor = ref<number | undefined>(undefined);
const selectedMemberTitle = ref("");
const selectedMemberRaw = ref<unknown>("");
const selectedMemberKey = ref("");
const selectedMemberContext = ref<RedisMemberContext | null>(null);
const isEditingMember = ref(false);
const savingMember = ref(false);
const memberEditValue = ref("");
const editingZsetMemberKey = ref<string | null>(null);
const savingZsetMember = ref(false);
const zsetInlineMember = ref("");
const zsetInlineScore = ref("");
const hashTableRef = ref<HTMLElement | null>(null);
const hashFieldWidth = ref(280);
const isResizingHashColumns = ref(false);
const zsetTableRef = ref<HTMLElement | null>(null);
const zsetScoreWidth = ref(220);
const isResizingZsetColumns = ref(false);
const stringValueView = ref<RedisValueFormat>(readPreferredRedisValueFormat());
const memberValueView = ref<RedisValueFormat>(readPreferredRedisValueFormat());
const redisJsonWordWrap = ref(readRedisJsonWordWrap());
const redisJsonUnicodeMode = ref(readRedisJsonUnicodeMode());
const redisJsonDecoded = computed(() => redisJsonUnicodeMode.value === "decoded");
const redisJsonHighlighter = ref<JsonHighlighter>();
const showHashFieldTtlDialog = ref(false);
const editingHashField = ref<string | null>(null);
const savingHashFieldTtl = ref(false);
const hashFieldTtlMode = ref<RedisExpiryMode>("none");
const hashFieldTtlInput = ref("");
const hashFieldExpireAt = shallowRef<CalendarDateTime | null>(null);

// Decompressed view state. Decompression yields to the event loop so the
// loading state paints before the synchronous bounded inflate runs; the result
// intentionally lives outside the synchronous format pipeline built by
// formatRedisMemberDetail, and the request id guards against stale results when
// the user switches values or formats mid-flight.
type RedisDecompressedState = { status: "idle" } | { status: "loading" } | { status: "success"; text: string; algorithm: RedisDecompressAlgorithm } | { status: "error"; reason: "corrupt" | "limit" };
const decompressedState = ref<RedisDecompressedState>({ status: "idle" });
let decompressRequestId = 0;

async function runDecompress(bytes: Uint8Array, algorithm?: RedisDecompressAlgorithm) {
  const requestId = ++decompressRequestId;
  decompressedState.value = { status: "loading" };
  const result = await decompressRedisValue(bytes, algorithm ? { algorithm } : {});
  if (requestId !== decompressRequestId) return;
  if (result.ok) decompressedState.value = { status: "success", text: result.text, algorithm: result.algorithm };
  else decompressedState.value = { status: "error", reason: result.reason };
}

/** Bytes of whichever decompressed view is active (string value or member), or null when there is nothing to decode. */
function currentDecompressTargetBytes(): Uint8Array | null {
  if (stringValueView.value === "decompressed") {
    const blob = stringBlob.value;
    return blob ? decodeRedisBlob(blob) : null;
  }
  if (memberValueView.value === "decompressed") {
    const raw = selectedMemberRaw.value;
    if (raw == null) return null;
    // Plain-string members (not blobs) still attempt decompression so the user
    // gets the non-blocking "not compressed" notice instead of silence.
    return isRedisBlob(raw) ? decodeRedisBlob(raw) : new TextEncoder().encode(typeof raw === "string" ? raw : formatRedisMemberDetail(raw).rawText);
  }
  return null;
}

function refreshDecompressedView(algorithm?: RedisDecompressAlgorithm) {
  const bytes = currentDecompressTargetBytes();
  if (bytes) void runDecompress(bytes, algorithm);
  else decompressedState.value = { status: "idle" };
}

/** Last-resort explicit decode for values that are raw RFC 1951 DEFLATE (never auto-detected). */
function retryDecompressAsDeflate() {
  refreshDecompressedView("deflate");
}

const decompressedJsonDetail = computed(() => {
  const state = decompressedState.value;
  return state.status === "success" ? parseRedisJsonDetail(state.text) : null;
});

const decompressedFailureMessage = computed(() => {
  const state = decompressedState.value;
  if (state.status !== "error") return "";
  if (state.reason === "limit") return t("redis.decompressedLimitExceeded");
  return t("redis.decompressedFailed");
});

/** Format label shows the algorithm that actually succeeded, e.g. "Decompressed (zlib)". */
const decompressedLabel = computed(() => {
  const state = decompressedState.value;
  const base = t("redis.decompressedView");
  return state.status === "success" ? `${base} (${state.algorithm})` : base;
});

// Auto-refresh keeps the displayed TTL moving locally and periodically reloads
// the complete key detail. The full reload updates changed values as well as
// the authoritative TTL without rebuilding the parent key tree.
const autoRefreshEnabled = ref(readRedisAutoRefreshEnabled());
const autoRefreshIntervalSeconds = ref(readRedisAutoRefreshInterval());
const countdownTtl = ref(0);
const refreshingValue = ref(false);
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let autoRefreshRequestId = 0;
let countdownTtlObservedAtMs = Date.now();
let redisValueViewerIsActive = true;

function canRunAutoRefresh(): boolean {
  return redisValueViewerIsActive && document.visibilityState !== "hidden";
}

function disableAutoRefresh() {
  autoRefreshEnabled.value = false;
  persistRedisAutoRefreshEnabled(false);
  stopAutoRefresh();
}

function selectAutoRefreshInterval(interval: number) {
  autoRefreshIntervalSeconds.value = interval;
  persistRedisAutoRefreshInterval(interval);
  if (!autoRefreshEnabled.value) {
    autoRefreshEnabled.value = true;
    persistRedisAutoRefreshEnabled(true);
  }
  startAutoRefresh();
}

function startAutoRefresh() {
  stopAutoRefresh();
  if (!autoRefreshEnabled.value || !data.value || !canRunAutoRefresh()) return;

  autoRefreshTimer = setInterval(() => void refreshAutoValue(), autoRefreshIntervalSeconds.value * 1000);
}

function startCountdown() {
  stopCountdown();
  if (!data.value || !canRunAutoRefresh()) return;

  updateCountdownTtl();
  countdownTimer = setInterval(() => {
    const action = computeTtlCountdownTick(countdownTtl.value);
    if (action.type === "decrement") {
      updateCountdownTtl();
    }
  }, 1000);
}

function syncCountdownTtl(serverTtl: number) {
  countdownTtl.value = serverTtl;
  countdownTtlObservedAtMs = Date.now();
}

function updateCountdownTtl() {
  if (!data.value) return;
  countdownTtl.value = computeTtlCountdownValue(data.value.ttl, countdownTtlObservedAtMs, Date.now());
}

function startRefreshTimers() {
  startCountdown();
  startAutoRefresh();
}

async function refreshAutoValue() {
  if (refreshingValue.value || loading.value || editingTtl.value || savingTtl.value || hasUnsavedRedisDraft.value || shouldPauseAutoValueRefresh() || !autoRefreshEnabled.value || !data.value || !canRunAutoRefresh()) return;

  const requestId = ++autoRefreshRequestId;
  refreshingValue.value = true;
  try {
    const applied = await load({
      background: true,
      preserveDraft: true,
      notifyParent: false,
      shouldApply: () => requestId === autoRefreshRequestId && !hasUnsavedRedisDraft.value && !shouldPauseAutoValueRefresh() && autoRefreshEnabled.value && canRunAutoRefresh(),
    });
    if (requestId !== autoRefreshRequestId || !applied || !data.value) return;
  } catch {
    // A failed background read must not retry in a tight loop. Manual refresh
    // remains available and starts a fresh polling lifecycle on success.
    if (requestId === autoRefreshRequestId) {
      stopAutoRefresh();
      // The user did not turn the preference off, so do not persist this
      // transient failure. The visible state must still match the stopped
      // timers and let one click restart polling.
      autoRefreshEnabled.value = false;
    }
  } finally {
    if (requestId === autoRefreshRequestId) refreshingValue.value = false;
  }
}

function stopAutoRefresh() {
  autoRefreshRequestId++;
  refreshingValue.value = false;
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function stopCountdown() {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function stopRefreshTimers() {
  stopAutoRefresh();
  stopCountdown();
}

function handleDocumentVisibilityChange() {
  if (document.visibilityState === "hidden") {
    stopRefreshTimers();
    return;
  }
  startRefreshTimers();
}

const hashSortBy = ref<"field" | "value" | null>(null);
const hashSortDir = ref<"asc" | "desc">("asc");
const zsetSortDir = ref<"asc" | "desc">("asc");
/**
 * In-content find (Ctrl+F) for:
 * - Redis STRING keys
 * - Member detail dialog (set/list/hash/zset field values — string-like body)
 * Hash field list keeps its own toolbar search. No collection-list filter.
 */
const valueSearchOpen = ref(false);
const valueSearchQuery = ref("");
const valueSearchMatchIndex = ref(0);
const valueSearchHasNavigated = ref(false);
const hashSearchQuery = ref("");
const activeHashSearchQuery = ref("");
const searchLoading = ref(false);
const valueSearchBarRef = ref<{ focusInput: (select?: boolean) => void } | null>(null);
type JsonEditorHandle = { openSearch: () => boolean; selectRange?: (from: number, to: number, options?: { focus?: boolean }) => boolean };
const stringJsonEditorRef = ref<JsonEditorHandle | null>(null);
const redisJsonEditorRef = ref<JsonEditorHandle | null>(null);
const memberJsonEditorRef = ref<JsonEditorHandle | null>(null);
const stringTextareaRef = ref<HTMLTextAreaElement | null>(null);
const memberTextareaRef = ref<HTMLTextAreaElement | null>(null);
const valueViewerSearchActive = ref(false);

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

async function toggleZsetSort() {
  if (redisKind.value !== "zset" || loading.value || loadingMore.value || editingZsetMemberKey.value !== null) return;
  const previousDirection = zsetSortDir.value;
  zsetSortDir.value = previousDirection === "asc" ? "desc" : "asc";
  try {
    await load({ notifyParent: false });
  } catch (error) {
    zsetSortDir.value = previousDirection;
    toast(errorMessage(error), 3000);
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
const selectedMemberDetail = computed(() => formatRedisMemberDetail(selectedMemberRaw.value, { allowJsonText: true }));

// The Decompressed view depends on the value/format refs above, so these
// watchers and computeds live here rather than next to the state declarations.
watch([stringValueView, stringBlob], ([view]) => {
  if (view !== "decompressed") return;
  refreshDecompressedView();
});

watch([memberValueView, selectedMemberRaw], ([view]) => {
  if (view !== "decompressed") return;
  refreshDecompressedView();
});

const stringGzipBadge = computed(() => (stringBlob.value ? isGzipMagic(decodeRedisBlob(stringBlob.value)) : false));
const memberGzipBadge = computed(() => (isRedisBlob(selectedMemberRaw.value) ? isGzipMagic(decodeRedisBlob(selectedMemberRaw.value)) : false));

/** Raw fallback shown while Decompressed fails: keep the original content visible, never an error string in its place. */
const decompressedRawFallbackText = computed(() => {
  if (stringValueView.value === "decompressed" && stringValueDetail.value) {
    return detailTextForFormat(stringValueDetail.value, stringValueDetail.value.defaultFormat);
  }
  if (memberValueView.value === "decompressed" && selectedMemberDetail.value) {
    return detailTextForFormat(selectedMemberDetail.value, selectedMemberDetail.value.defaultFormat);
  }
  return "";
});

/** Copy targets the decompressed text while the Decompressed view is showing it. */
const memberCopyText = computed(() => {
  if (memberValueView.value === "decompressed") {
    const state = decompressedState.value;
    if (state.status === "success") return state.text;
  }
  return detailTextForFormat(selectedMemberDetail.value, memberValueView.value);
});

const redisJsonAppearance = computed(() => (isDark.value ? "dark" : "light"));
const isBinaryStringValue = computed(() => Boolean(stringValueDetail.value?.binary));
const selectedMemberCanEdit = computed(() => selectedMemberContext.value?.canEdit ?? false);
const canEditCurrentStringFormat = computed(() => Boolean(stringValueDetail.value?.editable) && (stringValueView.value === "utf8" || stringValueView.value === "json"));
const showStringEditActions = computed(() => canEditCurrentStringFormat.value);
const originalStringEditValue = computed(() => (stringBlob.value ? rawRedisValueText(stringBlob.value) : ""));
const stringJsonRawBaseline = ref("");
const stringJsonDraftBaseline = ref("");
const redisJsonRawBaseline = ref("");
const redisJsonDraftBaseline = ref("");
const memberJsonRawBaseline = ref("");
const memberJsonDraftBaseline = ref("");
// Keep the comparison semantics from the last editable String view. A draft is
// retained when the user switches to a read-only representation such as Hex.
const stringDraftFormat = ref<"utf8" | "json">("utf8");
function isStringDraftDirty(format: "utf8" | "json"): boolean {
  if (!stringValueDetail.value?.editable) return false;
  if (format === "json" && stringValueDetail.value.json) return editValue.value !== stringJsonDraftBaseline.value;
  return editValue.value !== originalStringEditValue.value;
}
const stringValueChanged = computed(() => {
  if (!canEditCurrentStringFormat.value) return false;
  return isStringDraftDirty(stringValueView.value === "json" ? "json" : "utf8");
});
const hasRetainedStringDraft = computed(() => isStringDraftDirty(stringDraftFormat.value));
const redisJsonValueChanged = computed(() => data.value?.data.kind === "json" && editValue.value !== redisJsonDraftBaseline.value);
const canEditCurrentMemberFormat = computed(() => selectedMemberCanEdit.value && memberValueView.value === "utf8");
const isEditingHashJson = computed(() => selectedMemberContext.value?.kind === "hash" && selectedMemberCanEdit.value && memberValueView.value === "json" && Boolean(selectedMemberDetail.value.json));
const memberValueChanged = computed(() => {
  if (!selectedMemberCanEdit.value) return false;
  const original = selectedMemberDetail.value.rawText;
  if (isEditingHashJson.value && selectedMemberDetail.value.json) return memberEditValue.value !== memberJsonDraftBaseline.value;
  return memberEditValue.value !== original;
});
// A member sheet can close without discarding its draft, so its dirty state
// must outlive the sheet and whichever display format is currently selected.
const memberDraftFormat = ref<"utf8" | "json" | null>(null);
const hasRetainedMemberDraft = computed(() => {
  const format = memberDraftFormat.value;
  if (!format || !selectedMemberCanEdit.value) return false;

  const original = selectedMemberDetail.value.rawText;
  if (format === "json" && selectedMemberContext.value?.kind === "hash" && selectedMemberDetail.value.json) {
    return memberEditValue.value !== memberJsonDraftBaseline.value;
  }
  return memberEditValue.value !== original;
});
const hasUnsavedRedisDraft = computed(() => hasRetainedStringDraft.value || redisJsonValueChanged.value || hasRetainedMemberDraft.value || editingZsetMemberKey.value !== null || showHashFieldTtlDialog.value);
const hasMore = computed(() => scanCursor.value != null && scanCursor.value > 0);
const collectionTotal = computed(() => (data.value ? redisValueCollectionTotal(data.value) : null));
const hashFieldTtlSupported = computed(() => {
  if (redisKind.value !== "hash") return false;
  return (collectionItems.value as RedisHashItem[]).some((item) => item.field_ttl !== undefined);
});
const hashGridStyle = computed(() => ({
  gridTemplateColumns: hashFieldTtlSupported.value ? `${hashFieldWidth.value}px minmax(12rem, 1fr) minmax(7rem, 9rem) 84px` : `${hashFieldWidth.value}px minmax(12rem, 1fr) 84px`,
}));
const zsetGridStyle = computed(() => ({
  gridTemplateColumns: `60px ${zsetScoreWidth.value}px minmax(0, 1fr) 104px`,
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
  if (redisKind.value !== "stream") return [];
  return streamEntries.value.map((entry, index) => ({
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
function zsetScoreValue(score: string): number {
  const normalized = score.toLowerCase();
  if (normalized === "-inf") return -Infinity;
  if (normalized === "inf" || normalized === "+inf") return Infinity;
  return Number(score);
}

function isValidZsetScore(score: string): boolean {
  const normalized = score.toLowerCase();
  return normalized === "-inf" || normalized === "inf" || normalized === "+inf" || Number.isFinite(Number(score));
}

const sortedZsetItems = computed<RedisZsetItem[]>(() => {
  if (redisKind.value !== "zset") return [];
  const multiplier = zsetSortDir.value === "asc" ? 1 : -1;
  return [...(collectionItems.value as RedisZsetItem[])].sort((a, b) => {
    const difference = zsetScoreValue(a.score) - zsetScoreValue(b.score);
    return Number.isNaN(difference) ? a.score.localeCompare(b.score) * multiplier : difference * multiplier;
  });
});

const zsetRows = computed<RedisCollectionRow<RedisZsetItem>[]>(() =>
  sortedZsetItems.value.map((value, index) => ({
    id: collectionRowId(value, index),
    index,
    value,
  })),
);

const usesJsonEditorForMain = computed(() => (isStringLikeKind.value && stringValueView.value === "json" && Boolean(stringValueDetail.value?.json)) || redisKind.value === "json");
const usesJsonEditorForMember = computed(() => isEditingHashJson.value);
/** True when Ctrl+F content find applies (STRING, RedisJSON, or open member detail). */
const valueSearchSupported = computed(() => showMemberDetail.value || isStringLikeKind.value || redisKind.value === "json");
const contentSearchText = computed(() => {
  if (showMemberDetail.value) {
    if (isEditingMember.value || isEditingHashJson.value) return memberEditValue.value;
    if (memberValueView.value === "decompressed") {
      const state = decompressedState.value;
      return state.status === "success" ? state.text : "";
    }
    return detailTextForFormat(selectedMemberDetail.value, memberValueView.value);
  }
  if (redisKind.value === "json") return editValue.value;
  if (!isStringLikeKind.value || !stringValueDetail.value) return "";
  if (stringValueView.value === "decompressed") {
    const state = decompressedState.value;
    return state.status === "success" ? state.text : "";
  }
  if (stringValueView.value === "json" && stringValueDetail.value.json) return editValue.value;
  if (stringValueView.value === "utf8" && canEditCurrentStringFormat.value) return editValue.value;
  return detailTextForFormat(stringValueDetail.value, stringValueView.value);
});
const contentSearchMatches = computed(() => findRedisTextMatches(contentSearchText.value, valueSearchQuery.value));
const contentSearchMatchLimited = computed(() => contentSearchMatches.value.length >= REDIS_VALUE_SEARCH_MATCH_LIMIT);
const contentSearchActiveIndex = computed(() => {
  if (contentSearchMatches.value.length === 0) return 0;
  return Math.min(valueSearchMatchIndex.value, contentSearchMatches.value.length - 1);
});
const valueSearchStatus = computed(() => redisValueSearchStatus(contentSearchActiveIndex.value, contentSearchMatches.value.length, contentSearchMatchLimited.value));
const valueSearchMatchCount = computed(() => contentSearchMatches.value.length);
const contentSearchHighlightedHtml = computed(() => {
  if (!valueSearchOpen.value || !valueSearchQuery.value) return "";
  return renderRedisTextSearchHtml(contentSearchText.value, valueSearchQuery.value, contentSearchActiveIndex.value);
});
const canHighlightContentSearch = computed(() => valueSearchOpen.value && Boolean(valueSearchQuery.value) && canFullHighlightRedisText(contentSearchText.value.length));
const canHighlightStringSurface = computed(() => canHighlightContentSearch.value && !showMemberDetail.value);
const canHighlightMemberSurface = computed(() => canHighlightContentSearch.value && showMemberDetail.value);

let hashSearchTimer: ReturnType<typeof setTimeout> | null = null;
let hashSearchRequestId = 0;
let hashResizeStartX = 0;
let hashResizeStartWidth = 0;
let zsetResizeStartX = 0;
let zsetResizeStartWidth = 0;

function shouldPauseAutoValueRefresh(): boolean {
  const loadedPageSize = data.value ? redisValueCollectionItems(data.value).length : 0;
  const hasExpandedCollectionPage = collectionItems.value.length > loadedPageSize;
  return showMemberDetail.value || editingZsetMemberKey.value !== null || showHashFieldTtlDialog.value || valueSearchOpen.value || Boolean(hashSearchQuery.value.trim()) || Boolean(activeHashSearchQuery.value) || searchLoading.value || loadingMore.value || hasExpandedCollectionPage;
}

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

function replaceStreamEntries(value: RedisValue) {
  streamEntriesRequestId++;
  streamEntriesLoadingMore.value = false;
  if (value.data.kind === "stream") {
    streamEntries.value = [...value.data.entries];
    streamEntriesCursor.value = value.data.next_cursor;
    return;
  }
  streamEntries.value = [];
  streamEntriesCursor.value = undefined;
}

function resetStreamEntries() {
  streamEntriesRequestId++;
  streamEntries.value = [];
  streamEntriesCursor.value = undefined;
  streamEntriesLoadingMore.value = false;
}

function isSelectedStreamGroup(group: RedisStreamGroup, requestId = streamGroupDetailRequestId): boolean {
  return requestId === streamGroupDetailRequestId && selectedStreamGroup.value?.name.raw_base64 === group.name.raw_base64;
}

function resetStreamGroupDetail() {
  streamGroupDetailRequestId++;
  streamConsumersRequestId++;
  streamPendingRequestId++;
  selectedStreamGroup.value = null;
  selectedStreamConsumer.value = null;
  streamConsumers.value = [];
  streamConsumersLoading.value = false;
  streamConsumersError.value = "";
  streamPendingEntries.value = [];
  streamPendingCursor.value = undefined;
  streamPendingLoading.value = false;
  streamPendingLoadingMore.value = false;
  streamPendingError.value = "";
}

function resetStreamMonitoring() {
  streamGroupsRequestId++;
  resetStreamGroupDetail();
  streamTab.value = "entries";
  streamGroups.value = [];
  streamGroupsLoaded.value = false;
  streamGroupsLoading.value = false;
  streamGroupsError.value = "";
}

async function loadMoreStreamEntries() {
  const cursor = streamEntriesCursor.value;
  if (redisKind.value !== "stream" || !cursor || loading.value || streamEntriesLoadingMore.value) return;

  const requestId = ++streamEntriesRequestId;
  streamEntriesLoadingMore.value = true;
  try {
    const page = await api.redisGetStreamEntries(props.connectionId, props.db, props.keyRaw, cursor);
    if (requestId !== streamEntriesRequestId || redisKind.value !== "stream" || streamEntriesCursor.value !== cursor) return;

    streamEntries.value = [...streamEntries.value, ...page.entries];
    streamEntriesCursor.value = page.next_cursor;
  } catch (error) {
    if (requestId === streamEntriesRequestId) toast(errorMessage(error), 3000);
  } finally {
    if (requestId === streamEntriesRequestId) streamEntriesLoadingMore.value = false;
  }
}

async function loadStreamGroups(force = false): Promise<boolean> {
  if (redisKind.value !== "stream") return false;
  if (!force && (streamGroupsLoaded.value || streamGroupsLoading.value)) return streamGroupsLoaded.value;

  const requestId = ++streamGroupsRequestId;
  streamGroupsLoading.value = true;
  streamGroupsError.value = "";
  try {
    const groups = await api.redisGetStreamGroups(props.connectionId, props.db, props.keyRaw);
    if (requestId !== streamGroupsRequestId || redisKind.value !== "stream") return false;

    streamGroups.value = groups;
    streamGroupsLoaded.value = true;
    const selected = selectedStreamGroup.value;
    if (selected && !groups.some((group) => group.name.raw_base64 === selected.name.raw_base64)) {
      resetStreamGroupDetail();
    }
    return true;
  } catch (error) {
    if (requestId === streamGroupsRequestId) streamGroupsError.value = errorMessage(error);
    return false;
  } finally {
    if (requestId === streamGroupsRequestId) streamGroupsLoading.value = false;
  }
}

async function loadStreamConsumers(group: RedisStreamGroup, requestId: number) {
  if (!isSelectedStreamGroup(group, requestId)) return;
  const consumerRequestId = ++streamConsumersRequestId;
  streamConsumersLoading.value = true;
  streamConsumersError.value = "";
  try {
    const consumers = await api.redisGetStreamConsumers(props.connectionId, props.db, props.keyRaw, group.name.raw_base64);
    if (!isSelectedStreamGroup(group, requestId) || consumerRequestId !== streamConsumersRequestId) return;
    streamConsumers.value = consumers;
    const selectedConsumerRaw = selectedStreamConsumer.value?.name.raw_base64;
    if (selectedConsumerRaw) {
      const selectedConsumer = consumers.find((consumer) => consumer.name.raw_base64 === selectedConsumerRaw);
      if (selectedConsumer) {
        selectedStreamConsumer.value = selectedConsumer;
      } else {
        // A refresh can race with XGROUP DELCONSUMER. Do not leave a stale
        // consumer detail open or allow its pending request to update the view.
        resetStreamConsumerDetail();
      }
    }
  } catch (error) {
    if (isSelectedStreamGroup(group, requestId) && consumerRequestId === streamConsumersRequestId) {
      streamConsumersError.value = errorMessage(error);
    }
  } finally {
    if (isSelectedStreamGroup(group, requestId) && consumerRequestId === streamConsumersRequestId) {
      streamConsumersLoading.value = false;
    }
  }
}

async function loadStreamPendingPage(group: RedisStreamGroup, cursor?: string, append = false, requestId = streamGroupDetailRequestId) {
  if (!isSelectedStreamGroup(group, requestId)) return;
  const pendingRequestId = ++streamPendingRequestId;
  const consumerRaw = selectedStreamConsumer.value?.name.raw_base64;
  if (append) {
    streamPendingLoadingMore.value = true;
  } else {
    streamPendingLoading.value = true;
    streamPendingError.value = "";
    streamPendingEntries.value = [];
    streamPendingCursor.value = undefined;
  }

  try {
    const page = consumerRaw ? await api.redisGetStreamPending(props.connectionId, props.db, props.keyRaw, group.name.raw_base64, cursor, consumerRaw) : await api.redisGetStreamPending(props.connectionId, props.db, props.keyRaw, group.name.raw_base64, cursor);
    if (!isSelectedStreamGroup(group, requestId) || pendingRequestId !== streamPendingRequestId || selectedStreamConsumer.value?.name.raw_base64 !== consumerRaw) return;
    streamPendingEntries.value = append ? [...streamPendingEntries.value, ...page.entries] : page.entries;
    streamPendingCursor.value = page.next_cursor;
  } catch (error) {
    if (isSelectedStreamGroup(group, requestId) && pendingRequestId === streamPendingRequestId && selectedStreamConsumer.value?.name.raw_base64 === consumerRaw) {
      streamPendingError.value = errorMessage(error);
    }
  } finally {
    if (isSelectedStreamGroup(group, requestId) && pendingRequestId === streamPendingRequestId && selectedStreamConsumer.value?.name.raw_base64 === consumerRaw) {
      if (append) streamPendingLoadingMore.value = false;
      else streamPendingLoading.value = false;
    }
  }
}

function selectStreamGroup(group: RedisStreamGroup, reload = false) {
  if (!reload && selectedStreamGroup.value?.name.raw_base64 === group.name.raw_base64) return;

  const preservedConsumer = reload && selectedStreamGroup.value?.name.raw_base64 === group.name.raw_base64 ? selectedStreamConsumer.value : null;
  streamGroupDetailRequestId++;
  streamConsumersRequestId++;
  streamPendingRequestId++;
  const requestId = streamGroupDetailRequestId;
  selectedStreamGroup.value = group;
  selectedStreamConsumer.value = preservedConsumer;
  streamConsumers.value = [];
  streamConsumersLoading.value = false;
  streamConsumersError.value = "";
  streamPendingEntries.value = [];
  streamPendingCursor.value = undefined;
  streamPendingLoading.value = false;
  streamPendingLoadingMore.value = false;
  streamPendingError.value = "";
  void loadStreamConsumers(group, requestId);
  if (selectedStreamConsumer.value) void loadStreamPendingPage(group, undefined, false, requestId);
}

function selectStreamConsumer(consumer: RedisStreamConsumer) {
  const group = selectedStreamGroup.value;
  if (!group || selectedStreamConsumer.value?.name.raw_base64 === consumer.name.raw_base64) return;

  streamPendingRequestId++;
  selectedStreamConsumer.value = consumer;
  streamPendingEntries.value = [];
  streamPendingCursor.value = undefined;
  streamPendingLoading.value = false;
  streamPendingLoadingMore.value = false;
  streamPendingError.value = "";
  void loadStreamPendingPage(group, undefined, false, streamGroupDetailRequestId);
}

function resetStreamConsumerDetail() {
  if (!selectedStreamConsumer.value) return;

  streamPendingRequestId++;
  selectedStreamConsumer.value = null;
  streamPendingEntries.value = [];
  streamPendingCursor.value = undefined;
  streamPendingLoading.value = false;
  streamPendingLoadingMore.value = false;
  streamPendingError.value = "";
}

function retryStreamGroups() {
  void loadStreamGroups(true);
}

function retryStreamConsumers() {
  const group = selectedStreamGroup.value;
  if (!group) return;
  void loadStreamConsumers(group, streamGroupDetailRequestId);
}

function retryStreamPending() {
  const group = selectedStreamGroup.value;
  if (!group || !selectedStreamConsumer.value) return;
  void loadStreamPendingPage(group, undefined, false, streamGroupDetailRequestId);
}

function loadMoreStreamPending() {
  const group = selectedStreamGroup.value;
  const cursor = streamPendingCursor.value;
  if (!group || !selectedStreamConsumer.value || !cursor || streamPendingLoading.value || streamPendingLoadingMore.value) return;
  void loadStreamPendingPage(group, cursor, true, streamGroupDetailRequestId);
}

async function refreshValueAndStreamGroups() {
  const refreshGroups = redisKind.value === "stream" && streamTab.value === "groups";
  const selectedGroupRaw = selectedStreamGroup.value?.name.raw_base64;
  try {
    const applied = await load();
    if (!applied || !refreshGroups || redisKind.value !== "stream") return;
    const loaded = await loadStreamGroups(true);
    if (!loaded || !selectedGroupRaw) return;
    const selected = streamGroups.value.find((group) => group.name.raw_base64 === selectedGroupRaw);
    if (selected) selectStreamGroup(selected, true);
  } catch (error) {
    toast(errorMessage(error), 3000);
  }
}

function streamMetricInteger(value: number | string | undefined): bigint | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function formatStreamMetric(value: number | string | undefined): string {
  const integer = streamMetricInteger(value);
  return integer == null ? "-" : integer.toLocaleString();
}

function formatStreamDuration(value: number | string | undefined): string {
  const integer = streamMetricInteger(value);
  if (integer == null) return "-";
  if (integer > BigInt(Number.MAX_SAFE_INTEGER)) return `${integer.toLocaleString()} ms`;

  const milliseconds = Number(integer);
  if (milliseconds < 1_000) return `${milliseconds.toLocaleString()} ms`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.floor(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function formatStreamDurationTitle(value: number | string | undefined): string {
  const formatted = formatStreamMetric(value);
  return formatted === "-" ? formatted : `${formatted} ms`;
}

function formatStreamDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return streamDateTimeFormatter.value.format(new Date(timestamp));
}

function formatStreamLastDelivery(value: number | string | undefined): string {
  const idle = streamMetricInteger(value);
  if (idle == null || idle > BigInt(Number.MAX_SAFE_INTEGER)) return "-";
  return formatStreamDateTime(Date.now() - Number(idle));
}

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
    if (!hasRetainedMemberDraft.value) clearSelectedMember();
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

function readRedisAutoRefreshEnabled(): boolean {
  try {
    return localStorage.getItem(REDIS_AUTO_REFRESH_ENABLED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function persistRedisAutoRefreshEnabled(enabled: boolean) {
  try {
    localStorage.setItem(REDIS_AUTO_REFRESH_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // Keep the preference for this component if storage is unavailable.
  }
}

function readRedisAutoRefreshInterval(): number {
  try {
    const stored = localStorage.getItem(REDIS_AUTO_REFRESH_INTERVAL_STORAGE_KEY);
    return stored === null ? DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS : normalizeRedisAutoRefreshInterval(stored);
  } catch {
    return DEFAULT_REDIS_AUTO_REFRESH_INTERVAL_SECONDS;
  }
}

function persistRedisAutoRefreshInterval(interval: number) {
  try {
    localStorage.setItem(REDIS_AUTO_REFRESH_INTERVAL_STORAGE_KEY, String(interval));
  } catch {
    // Keep the current interval if storage is unavailable.
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

/** How JSON string tokens are shown in the JSON editors: source (`\uXXXX`) or decoded text. */
type RedisJsonUnicodeMode = "raw" | "decoded";

function readRedisJsonUnicodeMode(): RedisJsonUnicodeMode {
  try {
    return localStorage.getItem(REDIS_JSON_UNICODE_MODE_STORAGE_KEY) === "raw" ? "raw" : "decoded";
  } catch {
    return "decoded";
  }
}

function rememberRedisJsonUnicodeMode(mode: RedisJsonUnicodeMode) {
  try {
    localStorage.setItem(REDIS_JSON_UNICODE_MODE_STORAGE_KEY, mode);
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

function formatJsonText(raw: string, decodeUnicode: boolean): string | null {
  try {
    // Keep Redis JSON baselines source-preserving (duplicate keys, number text),
    // then apply the display-only unicode decode when the user chose "decoded".
    const formatted = formatJsonSource(raw, 2);
    return decodeUnicode ? decodeJsonUnicodeEscapes(formatted) : formatted;
  } catch {
    return null;
  }
}

function jsonDraftForEditor(raw: string, decodeUnicode: boolean): string {
  return formatJsonText(raw, decodeUnicode) ?? raw;
}

/** Apply the display-only unicode decode to an already-formatted JSON baseline. */
function jsonDraftBaseline(formattedText: string, decodeUnicode: boolean): string {
  return decodeUnicode ? decodeJsonUnicodeEscapes(formattedText) : formattedText;
}

/**
 * Canonical JSON baseline for an editor surface: the source-preserving raw
 * formatted text (what saves write back to Redis) plus its display baseline.
 * Keeping the raw baseline separately lets decoded-mode saves map the user's
 * draft back onto the source so untouched escapes are never rewritten.
 */
function jsonDraftPairForEditor(raw: string): { rawBaseline: string; displayBaseline: string } {
  const rawBaseline = formatJsonText(raw, false) ?? raw;
  return { rawBaseline, displayBaseline: jsonDraftBaseline(rawBaseline, redisJsonDecoded.value) };
}

/** Convert a JSON editor draft from the previous unicode display mode to the new one. */
function convertJsonDraftAcrossMode(draft: string, rawBaseline: string, decoded: boolean): string {
  return decoded ? decodeJsonUnicodeEscapes(draft) : mapDisplayToRaw(rawBaseline, draft);
}

/** Re-derive the JSON editor surfaces from their raw baselines after the mode changes. */
function setRedisJsonUnicodeMode(mode: RedisJsonUnicodeMode) {
  redisJsonUnicodeMode.value = mode;
  rememberRedisJsonUnicodeMode(mode);
  const decoded = mode === "decoded";
  stringJsonDraftBaseline.value = jsonDraftBaseline(stringJsonRawBaseline.value, decoded);
  redisJsonDraftBaseline.value = jsonDraftBaseline(redisJsonRawBaseline.value, decoded);
  memberJsonDraftBaseline.value = jsonDraftBaseline(memberJsonRawBaseline.value, decoded);
  if (!data.value) return;
  // Convert the active surface's draft through the mode transform so unsaved
  // edits survive the toggle; when the draft is clean this equals the baseline.
  if (data.value.data.kind === "string" && stringValueView.value === "json" && stringValueDetail.value?.json) {
    editValue.value = convertJsonDraftAcrossMode(editValue.value, stringJsonRawBaseline.value, decoded);
  } else if (data.value.data.kind === "json") {
    editValue.value = convertJsonDraftAcrossMode(editValue.value, redisJsonRawBaseline.value, decoded);
  } else if (selectedMemberDetail.value?.json && memberValueView.value === "json") {
    memberEditValue.value = convertJsonDraftAcrossMode(memberEditValue.value, memberJsonRawBaseline.value, decoded);
  }
}

/**
 * Resolve the raw draft that Save should write for a JSON editor surface.
 * In decoded mode the editor holds display text, so the draft is mapped back
 * onto the raw baseline (preserving untouched escapes); in raw mode the editor
 * already holds source text and passes through unchanged.
 */
function jsonDraftForSave(rawBaseline: string, displayValue: string): string {
  return redisJsonDecoded.value ? mapDisplayToRaw(rawBaseline, displayValue) : displayValue;
}

function rememberRedisValueFormat(format: RedisValueFormat) {
  try {
    localStorage.setItem(REDIS_VALUE_FORMAT_STORAGE_KEY, format);
  } catch {
    // Ignore storage failures; the toggle still works for the current session.
  }
}

function setStringValueFormat(format: RedisValueFormat) {
  if (stringValueView.value === "json" && format !== "json" && stringValueDetail.value?.json && editValue.value === stringJsonDraftBaseline.value) {
    editValue.value = originalStringEditValue.value;
    stringDraftFormat.value = "utf8";
  }
  stringValueView.value = format;
  if (stringValueDetail.value && canRenderRedisValueFormat(stringValueDetail.value, format)) {
    if (format === "json") {
      editValue.value = editValue.value === originalStringEditValue.value ? stringJsonDraftBaseline.value : jsonDraftForEditor(editValue.value, redisJsonDecoded.value);
      stringDraftFormat.value = "json";
    } else if (format === "utf8") {
      // Keep a dirty JSON draft marked as json so save still compact-writes after a tab switch.
      if (!(stringDraftFormat.value === "json" && isStringDraftDirty("json"))) stringDraftFormat.value = "utf8";
    }
    // Decompressed is a per-value view, never a persisted preference.
    if (format !== "decompressed") rememberRedisValueFormat(format);
  }
}

function setMemberValueFormat(format: RedisValueFormat) {
  if (memberValueView.value === "json" && format !== "json" && selectedMemberDetail.value.json && memberEditValue.value === memberJsonDraftBaseline.value) {
    memberEditValue.value = selectedMemberDetail.value.rawText;
    // Mirror string drafts: a clean leave from JSON must drop the pretty baseline
    // comparison, or rawText vs formattedText looks dirty and blocks refresh.
    if (selectedMemberContext.value?.kind === "hash" && selectedMemberCanEdit.value) memberDraftFormat.value = null;
  }
  memberValueView.value = format;
  if (canRenderRedisValueFormat(selectedMemberDetail.value, format)) {
    if (format === "json") {
      memberEditValue.value = memberEditValue.value === selectedMemberDetail.value.rawText ? memberJsonDraftBaseline.value : jsonDraftForEditor(memberEditValue.value, redisJsonDecoded.value);
      if (selectedMemberContext.value?.kind === "hash" && selectedMemberCanEdit.value) memberDraftFormat.value = "json";
    } else if (format === "utf8") {
      // Dirty JSON drafts keep format "json" so save/normalize still runs after leaving the JSON tab.
      if (selectedMemberContext.value?.kind === "hash" && selectedMemberCanEdit.value && memberDraftFormat.value !== "json") {
        memberDraftFormat.value = "utf8";
      }
    }
    // Decompressed is a per-value view, never a persisted preference.
    if (format !== "decompressed") rememberRedisValueFormat(format);
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
    case "decompressed":
      return decompressedLabel.value;
    default:
      return rawLabel || t("redis.rawContent");
  }
}

function isTextRedisFormat(format: RedisValueFormat): boolean {
  return format === "utf8" || format === "ascii" || format === "binary" || format === "json" || format === "decompressed";
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

async function load(options: { background?: boolean; notifyParent?: boolean; preserveDraft?: boolean; selectDefaultMember?: boolean; shouldApply?: () => boolean } = {}): Promise<boolean> {
  const background = options.background ?? false;
  const notifyParent = options.notifyParent ?? true;
  const shouldSelectDefaultMember = options.selectDefaultMember ?? true;
  const requestId = ++loadRequestId;
  if (!background) loading.value = true;
  try {
    let loadedValue = await api.redisGetValue(props.connectionId, props.db, props.keyRaw);
    if (loadedValue.data.kind === "zset" && zsetSortDir.value === "desc") {
      const sortedPage = await api.redisLoadMore(props.connectionId, props.db, props.keyRaw, "zset", 0, 200, undefined, "desc");
      if (sortedPage.kind === "zset") {
        loadedValue = {
          ...loadedValue,
          data: {
            ...loadedValue.data,
            items: sortedPage.items,
            scan_cursor: sortedPage.scan_cursor,
          },
        };
      }
    }
    if (requestId !== loadRequestId || (options.shouldApply && !options.shouldApply())) return false;

    // Redis reports a key that expired between refreshes as a `none` value.
    // Tell the browser to remove it instead of rendering a stale detail shell.
    if (loadedValue.redis_type === "none") {
      // A background read can finish after the user starts editing. Preserve
      // the draft and defer even a missing-key update until the user decides
      // whether to save or discard it.
      if (background && options.preserveDraft && hasUnsavedRedisDraft.value) return false;
      resetZsetInlineEdit();
      data.value = null;
      collectionItems.value = [];
      scanCursor.value = undefined;
      resetStreamEntries();
      resetStreamMonitoring();
      stopRefreshTimers();
      emit("deleted", props.keyRaw);
      return true;
    }

    if (options.preserveDraft && hasUnsavedRedisDraft.value) {
      const currentValue = data.value;
      if (currentValue) {
        const preservedValue = { ...currentValue, ttl: loadedValue.ttl };
        data.value = preservedValue;
        syncCountdownTtl(loadedValue.ttl);
        if (notifyParent) emit("loaded", preservedValue);
      }
      return false;
    }

    if (hashSearchTimer) clearTimeout(hashSearchTimer);
    hashSearchTimer = null;
    hashSearchRequestId++;
    hashSearchQuery.value = "";
    activeHashSearchQuery.value = "";
    searchLoading.value = false;
    resetValueSearch();
    data.value = loadedValue;
    syncCountdownTtl(loadedValue.ttl);
    if (notifyParent) emit("loaded", loadedValue);
    scanCursor.value = redisValueCollectionScanCursor(loadedValue);
    collectionItems.value = redisValueCollectionItems(loadedValue);
    if (editingZsetMemberKey.value !== null && (loadedValue.data.kind !== "zset" || !loadedValue.data.items.some((item) => zsetInlineEditKey(item) === editingZsetMemberKey.value))) {
      resetZsetInlineEdit();
    }
    replaceStreamEntries(loadedValue);
    if (loadedValue.data.kind !== "stream") resetStreamMonitoring();

    // A foreground load replaces the current value, so it also starts a new
    // draft lifecycle. Member saves opt out until selection is restored.
    if (shouldSelectDefaultMember) {
      stringDraftFormat.value = "utf8";
      memberDraftFormat.value = null;
    }

    if (loadedValue.data.kind === "string") {
      const detail = formatRedisMemberDetail(loadedValue.data.content, { allowJsonText: true });
      stringValueView.value = preferredRedisValueFormat(loadedValue.data.content, readPreferredRedisValueFormat(), { allowJsonText: true });
      stringJsonRawBaseline.value = detail.json?.formattedText ?? "";
      stringJsonDraftBaseline.value = jsonDraftBaseline(stringJsonRawBaseline.value, redisJsonDecoded.value);
      editValue.value = stringValueView.value === "json" && detail.json ? stringJsonDraftBaseline.value : detail.rawText;
      stringDraftFormat.value = stringValueView.value === "json" ? "json" : "utf8";
      clearSelectedMember();
    } else if (loadedValue.data.kind === "json") {
      const pair = jsonDraftPairForEditor(redisJsonValueText(loadedValue.data));
      redisJsonRawBaseline.value = pair.rawBaseline;
      redisJsonDraftBaseline.value = pair.displayBaseline;
      editValue.value = redisJsonDraftBaseline.value;
      stringDraftFormat.value = "utf8";
      clearSelectedMember();
    } else if (loadedValue.data.kind === "stream") {
      if (shouldSelectDefaultMember) selectDefaultMember(loadedValue);
    } else if (["list", "set", "hash", "zset"].includes(loadedValue.data.kind)) {
      if (shouldSelectDefaultMember) selectDefaultMember(loadedValue);
    } else {
      clearSelectedMember();
    }
    return true;
  } catch (error) {
    if (requestId !== loadRequestId) return false;
    throw error;
  } finally {
    if (requestId === loadRequestId) {
      if (!background) loading.value = false;
      if (!background && data.value) startRefreshTimers();
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
    const sortDirection = keyType === "zset" ? zsetSortDir.value : undefined;
    const result = await api.redisLoadMore(props.connectionId, props.db, props.keyRaw, keyType, scanCursor.value!, 200, hashFilter, sortDirection);
    if (keyType === "hash" && requestId !== hashSearchRequestId) return;
    const newItems = redisCollectionPageItems(result);
    collectionItems.value = [...collectionItems.value, ...newItems];
    scanCursor.value = result.scan_cursor ?? undefined;
  } finally {
    loadingMore.value = false;
  }
}

async function saveString() {
  if (!data.value || !stringBlob.value || isBinaryStringValue.value || !stringValueChanged.value || savingString.value) return;

  let value = editValue.value;
  // Compact whenever this draft is/was JSON-edited, even if the user switched tabs before Save.
  if (stringValueView.value === "json" || stringDraftFormat.value === "json") {
    const normalized = normalizeRedisJsonDraft(jsonDraftForSave(stringJsonRawBaseline.value, value));
    if (!normalized.ok) {
      toast(t("redis.jsonFormatError"), 3000);
      return;
    }
    value = normalized.compactText;
  }

  savingString.value = true;
  try {
    await api.redisSetString(props.connectionId, props.db, props.keyRaw, value);
    await load();
  } finally {
    savingString.value = false;
  }
}

function discardStringEdit() {
  editValue.value = stringValueView.value === "json" ? stringJsonDraftBaseline.value : originalStringEditValue.value;
  stringDraftFormat.value = stringValueView.value === "json" ? "json" : "utf8";
}

async function saveJson() {
  if (!data.value || data.value.data.kind !== "json" || !redisJsonValueChanged.value || savingJson.value) return;
  const normalized = normalizeRedisJsonDraft(jsonDraftForSave(redisJsonRawBaseline.value, editValue.value));
  if (!normalized.ok) {
    toast(t("redis.jsonFormatError"), 3000);
    return;
  }
  savingJson.value = true;
  try {
    // Keep JSON.SET semantics while matching the other JSON editors' validation and compact writes.
    await api.redisJsonSet(props.connectionId, props.db, props.keyRaw, normalized.compactText);
    await load();
  } finally {
    savingJson.value = false;
  }
}

function discardRedisJsonEdit() {
  editValue.value = redisJsonDraftBaseline.value;
}

async function applyDeleteKey() {
  await api.redisDeleteKey(props.connectionId, props.db, props.keyRaw);
  emit("deleted", props.keyRaw);
}

function requestDeleteKey() {
  pendingDelete.value = { kind: "key" };
  showDeleteConfirm.value = true;
}

async function copyValue() {
  if (!data.value) return;
  // Copy the decompressed text while the Decompressed view is showing it.
  if (stringValueView.value === "decompressed") {
    const state = decompressedState.value;
    if (state.status === "success") {
      await copyText(state.text);
      return;
    }
  }
  const value = data.value.data.kind === "stream" ? { ...data.value, data: { ...data.value.data, entries: streamEntries.value } } : data.value;
  const text = redisValueCopyText(value, collectionItems.value);
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
      commands.push(`JSON.SET ${escapeRedisArg(key)} $ ${escapeRedisArg(redisJsonValueText(data.value.data))}`);
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
      const hashItems = collectionItems.value as RedisHashItem[];
      const pairs = hashItems.map((item) => {
        const field = blobWriteText(item.field);
        const value = blobWriteText(item.value);
        return field == null || value == null ? null : `${escapeRedisArg(field)} ${escapeRedisArg(value)}`;
      });
      if (pairs.some((item) => item == null)) return null;
      commands.push(`HSET ${escapeRedisArg(key)} ${(pairs as string[]).join(" ")}`);
      for (const item of hashItems) {
        const field = blobWriteText(item.field);
        if (field != null && item.field_ttl !== undefined && item.field_ttl > 0) {
          commands.push(`HEXPIRE ${escapeRedisArg(key)} ${item.field_ttl} FIELDS 1 ${escapeRedisArg(field)}`);
        }
      }
      break;
    }
    case "stream": {
      for (const entry of streamEntries.value) {
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
  memberValueView.value = preferredRedisValueFormat(value, readPreferredRedisValueFormat(), { allowJsonText: true });
  memberJsonRawBaseline.value = detail.json?.formattedText ?? "";
  memberJsonDraftBaseline.value = jsonDraftBaseline(memberJsonRawBaseline.value, redisJsonDecoded.value);
  memberEditValue.value = memberValueView.value === "json" && detail.json ? memberJsonDraftBaseline.value : detail.rawText;
  memberDraftFormat.value = context.kind === "hash" && context.canEdit && memberValueView.value === "json" && detail.json ? "json" : null;
}

function clearSelectedMember() {
  selectedMemberTitle.value = "";
  selectedMemberRaw.value = "";
  selectedMemberKey.value = "";
  selectedMemberContext.value = null;
  isEditingMember.value = false;
  memberEditValue.value = "";
  memberJsonDraftBaseline.value = "";
  memberDraftFormat.value = null;
}

function isSelectedMember(title: string, value: unknown, identity?: string) {
  return selectedMemberKey.value === getRedisMemberSelectionKey(title, value, identity);
}

function viewMember(title: string, value: unknown, context: RedisMemberContext, identity?: string) {
  // Do not replace a retained draft just because another row was clicked.
  // Save or discard it first, then select the next member.
  if (!isSelectedMember(title, value, identity) && hasRetainedMemberDraft.value) {
    showMemberDetail.value = true;
    return;
  }
  if (!isSelectedMember(title, value, identity) || !memberValueChanged.value) {
    selectMember(title, value, context, identity);
  }
  showMemberDetail.value = true;
}

function handleMemberDetailOpenChange(open: boolean) {
  showMemberDetail.value = open;
  if (!open) isEditingMember.value = false;
}

function finishMemberDetailClose() {
  isEditingMember.value = false;
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
  window.removeEventListener("pointercancel", stopResizeHashColumns);
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
  window.addEventListener("pointercancel", stopResizeHashColumns);
}

function clampZsetScoreWidth(width: number) {
  const containerWidth = zsetTableRef.value?.clientWidth ?? 900;
  const min = 120;
  const max = Math.max(min, containerWidth - 300);
  return Math.min(max, Math.max(min, width));
}

function stopResizeZsetColumns() {
  isResizingZsetColumns.value = false;
  window.removeEventListener("pointermove", resizeZsetColumns);
  window.removeEventListener("pointerup", stopResizeZsetColumns);
  window.removeEventListener("pointercancel", stopResizeZsetColumns);
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
  window.addEventListener("pointercancel", stopResizeZsetColumns);
}

function zsetInlineEditKey(item: RedisZsetItem): string {
  return item.member.raw_base64;
}

function isEditingZsetRow(item: RedisZsetItem): boolean {
  return editingZsetMemberKey.value === zsetInlineEditKey(item);
}

function startZsetInlineEdit(item: RedisZsetItem) {
  const member = redisBlobText(item.member);
  if (member == null || savingZsetMember.value) return;
  editingZsetMemberKey.value = zsetInlineEditKey(item);
  zsetInlineMember.value = member;
  zsetInlineScore.value = item.score;
}

function resetZsetInlineEdit() {
  editingZsetMemberKey.value = null;
  zsetInlineMember.value = "";
  zsetInlineScore.value = "";
}

function cancelZsetInlineEdit() {
  if (savingZsetMember.value) return;
  resetZsetInlineEdit();
}

async function saveZsetInlineEdit(item: RedisZsetItem) {
  const originalMember = redisBlobText(item.member);
  const scoreText = zsetInlineScore.value.trim();
  if (originalMember == null || savingZsetMember.value) return;
  if (!scoreText || !isValidZsetScore(scoreText)) {
    toast(t("redis.createScoreInvalid"), 3000);
    return;
  }
  if (!zsetInlineMember.value.trim()) {
    toast(t("redis.memberRequired"), 3000);
    return;
  }

  savingZsetMember.value = true;
  try {
    try {
      const usedAclCompatibility = await api.redisZsetUpdate(props.connectionId, props.db, props.keyRaw, originalMember, item.score, zsetInlineMember.value, scoreText);
      if (usedAclCompatibility) toast(t("redis.zsetAclCompatibilityWarning"), 5000);
    } catch (error) {
      toast(errorMessage(error), 3000);
      return;
    }

    resetZsetInlineEdit();
    try {
      await load();
    } catch (error) {
      toast(t("redis.updateAppliedRefreshFailed", { message: errorMessage(error) }), 5000);
    }
  } finally {
    savingZsetMember.value = false;
  }
}

function startEditMember() {
  if (!canEditCurrentMemberFormat.value) return;
  if (!memberValueChanged.value) memberEditValue.value = selectedMemberDetail.value.rawText;
  // Do not demote a retained JSON draft to utf8; save still needs compact normalization.
  if (memberDraftFormat.value !== "json") memberDraftFormat.value = "utf8";
  isEditingMember.value = true;
  nextTick(() => memberTextareaRef.value?.focus());
}

function cancelEditMember() {
  memberEditValue.value = selectedMemberDetail.value.rawText;
  memberDraftFormat.value = null;
  isEditingMember.value = false;
}

function discardHashJsonEdit() {
  memberEditValue.value = memberJsonDraftBaseline.value;
  memberDraftFormat.value = "json";
}

async function saveMemberEdit() {
  const context = selectedMemberContext.value;
  const savingHashJson = isEditingHashJson.value || (context?.kind === "hash" && memberDraftFormat.value === "json");
  if (!context || savingMember.value || (!canEditCurrentMemberFormat.value && !savingHashJson)) return;

  let writeValue = memberEditValue.value;
  // Hash JSON drafts may still be open under UTF-8 after a format switch; keep compact writes.
  if (savingHashJson) {
    const normalized = normalizeRedisJsonDraft(jsonDraftForSave(memberJsonRawBaseline.value, writeValue));
    if (!normalized.ok) {
      toast(t("redis.jsonFormatError"), 3000);
      return;
    }
    writeValue = normalized.compactText;
  }

  let nextContext: RedisMemberContext = context;
  savingMember.value = true;
  try {
    if (context.kind === "list") {
      await api.redisListSet(props.connectionId, props.db, props.keyRaw, context.index, writeValue);
    } else if (context.kind === "hash") {
      if (!context.field) return;
      await api.redisHashSet(props.connectionId, props.db, props.keyRaw, context.field, writeValue);
    } else if (context.kind === "set") {
      if (!context.member) return;
      await api.redisSetRemove(props.connectionId, props.db, props.keyRaw, context.member);
      await api.redisSetAdd(props.connectionId, props.db, props.keyRaw, writeValue);
      nextContext = { kind: "set", member: writeValue, canEdit: true };
    } else if (context.kind === "zset") {
      if (!context.member) return;
      try {
        const usedAclCompatibility = await api.redisZsetUpdate(props.connectionId, props.db, props.keyRaw, context.member, context.score, writeValue, context.score);
        if (usedAclCompatibility) toast(t("redis.zsetAclCompatibilityWarning"), 5000);
      } catch (error) {
        toast(errorMessage(error), 3000);
        return;
      }
      nextContext = { kind: "zset", member: writeValue, score: context.score, canEdit: true };
    }
    const editedValue = writeValue;
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
function currentEditableTtl(): number {
  if (!data.value) return -1;
  return computeTtlForExpiryEdit(countdownTtl.value, data.value.ttl);
}

function expiryValidationMessage(reason: "ttl" | "date" | "past"): string {
  if (reason === "ttl") return t("redis.expiryTtlInvalid");
  if (reason === "date") return t("redis.expiryDateRequired");
  return t("redis.expiryDatePast");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRedisMissingKeyError(error: unknown): boolean {
  return /^Redis(?:JSON)? key no longer exists(?:;|$)/.test(errorMessage(error));
}

async function refreshTtlState(missingSignal?: unknown): Promise<unknown | null> {
  try {
    await load({ preserveDraft: true });
    return null;
  } catch (error) {
    // RedisJSON can lose a key between TYPE and JSON.GET. Retry that specific
    // race, but do not remove a key based only on an earlier command result.
    if (!isRedisMissingKeyError(missingSignal) && !isRedisMissingKeyError(error)) return error;
    try {
      await load({ preserveDraft: true });
      return null;
    } catch (retryError) {
      if (isRedisMissingKeyError(retryError)) {
        emit("deleted", props.keyRaw);
        return null;
      }
      return retryError;
    }
  }
}

function focusTtlExpiryControl(mode = ttlExpiryMode.value) {
  void nextTick(() => {
    if (!editingTtl.value) return;
    if (mode === "ttl") {
      ttlInputEl.value?.$el?.focus();
      return;
    }

    const selector = mode === "at" ? "[data-date-time-picker-trigger]" : "[data-slot='select-trigger']";
    editTtlWrapper.value?.querySelector<HTMLElement>(selector)?.focus();
  });
}

function startEditTtl() {
  if (!data.value || savingTtl.value) return;
  const ttl = currentEditableTtl();
  ttlExpiryMode.value = redisExpiryModeForTtl(ttl);
  ttlInput.value = ttl > 0 ? String(ttl) : "";
  ttlExpireAt.value = null;
  editingTtl.value = true;
  focusTtlExpiryControl();
}

watch(ttlExpiryMode, (mode, previousMode) => {
  const ttl = currentEditableTtl();
  if (mode === "at" && previousMode !== "at" && ttl > 0) {
    // Convert the live TTL at the moment of switching, not the stale fetched value.
    ttlExpireAt.value = unixSecondsToCalendarDateTime(Math.ceil(Date.now() / 1_000) + ttl);
  }
  if (editingTtl.value && mode !== previousMode) focusTtlExpiryControl(mode);
});

async function saveTtl() {
  if (savingTtl.value) return;
  const validation = validateRedisExpiry(ttlExpiryMode.value, ttlInput.value, ttlExpireAt.value);
  if (!validation.valid) {
    const message = expiryValidationMessage(validation.reason);
    toast(message, 3000);
    return;
  }
  savingTtl.value = true;
  try {
    try {
      await applyRedisExpiryPolicy(redisExpiryTransport, props.connectionId, props.db, props.keyRaw, validation.policy);
    } catch (error) {
      // The expiry command may have raced with a deletion or succeeded before a transport error.
      await refreshTtlState(error);
      toast(errorMessage(error), 3000);
      return;
    }
    editingTtl.value = false;
    const refreshError = await refreshTtlState();
    if (refreshError) toast(errorMessage(refreshError), 3000);
  } finally {
    savingTtl.value = false;
  }
}

function cancelEditTtl() {
  if (savingTtl.value) return;
  editingTtl.value = false;
  ttlExpireAt.value = null;
}

// Hash
function hashFieldItem(field: string | null): RedisHashItem | null {
  if (!field || redisKind.value !== "hash") return null;
  return (collectionItems.value as RedisHashItem[]).find((item) => redisBlobText(item.field) === field) ?? null;
}

function hashFieldTtlLabel(item: RedisHashItem): string {
  if (item.field_ttl === undefined) return "-";
  if (item.field_ttl === -1) return t("redis.noExpiry");
  return formatTtl(item.field_ttl, t) ?? "-";
}

function currentHashFieldTtl(): number {
  return hashFieldItem(editingHashField.value)?.field_ttl ?? -1;
}

function startEditHashFieldTtl(field: string | null) {
  if (!field || savingHashFieldTtl.value || hashFieldItem(field)?.field_ttl === undefined) return;
  const ttl = hashFieldItem(field)?.field_ttl ?? -1;
  editingHashField.value = field;
  hashFieldTtlMode.value = redisExpiryModeForTtl(ttl);
  hashFieldTtlInput.value = ttl > 0 ? String(ttl) : "";
  hashFieldExpireAt.value = null;
  showHashFieldTtlDialog.value = true;
}

watch(hashFieldTtlMode, (mode, previousMode) => {
  const ttl = currentHashFieldTtl();
  if (mode === "at" && previousMode !== "at" && ttl > 0) {
    hashFieldExpireAt.value = unixSecondsToCalendarDateTime(Math.ceil(Date.now() / 1_000) + ttl);
  }
});

function cancelEditHashFieldTtl(force = false) {
  if (savingHashFieldTtl.value && !force) return;
  showHashFieldTtlDialog.value = false;
  editingHashField.value = null;
  hashFieldTtlInput.value = "";
  hashFieldExpireAt.value = null;
}

function handleHashFieldTtlOpenChange(open: boolean) {
  if (open) {
    showHashFieldTtlDialog.value = true;
  } else {
    cancelEditHashFieldTtl();
  }
}

async function reloadHashPreservingSearch() {
  const query = activeHashSearchQuery.value || hashSearchQuery.value.trim();
  await load({ selectDefaultMember: false });
  if (query) {
    hashSearchQuery.value = query;
    await onHashSearch();
  }
}

async function saveHashFieldTtl() {
  if (savingHashFieldTtl.value || !editingHashField.value) return;
  const validation = validateRedisExpiry(hashFieldTtlMode.value, hashFieldTtlInput.value, hashFieldExpireAt.value);
  if (!validation.valid) {
    toast(expiryValidationMessage(validation.reason), 3000);
    return;
  }

  savingHashFieldTtl.value = true;
  const field = editingHashField.value;
  try {
    if (validation.policy.mode === "none") {
      await api.redisHashFieldSetTtl(props.connectionId, props.db, props.keyRaw, field, -1);
    } else if (validation.policy.mode === "ttl") {
      await api.redisHashFieldSetTtl(props.connectionId, props.db, props.keyRaw, field, validation.policy.ttl);
    } else {
      await api.redisHashFieldSetExpireAt(props.connectionId, props.db, props.keyRaw, field, validation.policy.expireAt);
    }
    cancelEditHashFieldTtl(true);
    await reloadHashPreservingSearch();
  } catch (error) {
    toast(errorMessage(error), 3000);
  } finally {
    savingHashFieldTtl.value = false;
  }
}

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

function resetValueSearch() {
  valueSearchOpen.value = false;
  valueSearchQuery.value = "";
  valueSearchMatchIndex.value = 0;
  valueSearchHasNavigated.value = false;
}

function openValueSearch(): boolean {
  if (!data.value || !valueSearchSupported.value) return false;
  valueSearchOpen.value = true;
  valueSearchHasNavigated.value = false;
  valueViewerSearchActive.value = true;
  // Keep caret in the find input — do not jump focus into the value body.
  void nextTick(() => {
    valueSearchBarRef.value?.focusInput(true);
  });
  return true;
}

function closeValueSearch() {
  valueSearchOpen.value = false;
  valueSearchHasNavigated.value = false;
  valueSearchMatchIndex.value = 0;
  valueSearchQuery.value = "";
}

function moveContentSearchMatch(delta: -1 | 1) {
  const count = contentSearchMatches.value.length;
  if (count === 0) return;
  valueSearchMatchIndex.value = nextRedisSearchMatchIndex(contentSearchActiveIndex.value, delta, count);
  valueSearchHasNavigated.value = true;
  void scrollContentSearchMatchIntoView();
}

function activateValueSearchMatch(delta: -1 | 1) {
  if (contentSearchMatches.value.length === 0) return;
  if (!valueSearchHasNavigated.value) {
    valueSearchHasNavigated.value = true;
    void scrollContentSearchMatchIntoView();
    return;
  }
  moveContentSearchMatch(delta);
}

/** Scroll value body to the active match without stealing focus from the find input. */
function scrollTextareaToMatch(textarea: HTMLTextAreaElement, match: { start: number; end: number }) {
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight || "20") || 20;
  const textBefore = textarea.value.slice(0, match.start);
  const line = textBefore.split("\n").length - 1;
  textarea.scrollTop = Math.max(0, line * lineHeight - textarea.clientHeight / 3);
}

/**
 * Never focus the value body here — the find panel must keep the caret so typing stays in the search box.
 * Enter / prev / next only change the active match index and scroll the body into view.
 */
async function scrollContentSearchMatchIntoView() {
  await nextTick();
  const match = contentSearchMatches.value[contentSearchActiveIndex.value];
  if (!match) return;

  // CM: update selection + scroll, but do not focus (keeps find input active).
  if (showMemberDetail.value) {
    if (usesJsonEditorForMember.value && memberJsonEditorRef.value?.selectRange?.(match.start, match.end, { focus: false })) return;
    if (isEditingMember.value && memberTextareaRef.value) {
      scrollTextareaToMatch(memberTextareaRef.value, match);
      return;
    }
  } else if (redisKind.value === "json") {
    if (redisJsonEditorRef.value?.selectRange?.(match.start, match.end, { focus: false })) return;
  } else {
    if (usesJsonEditorForMain.value && stringJsonEditorRef.value?.selectRange?.(match.start, match.end, { focus: false })) return;
    if (stringValueView.value === "utf8" && canEditCurrentStringFormat.value && stringTextareaRef.value) {
      scrollTextareaToMatch(stringTextareaRef.value, match);
      return;
    }
  }

  document.querySelector<HTMLElement>('[data-document-search-active="true"]')?.scrollIntoView({ block: "center", inline: "nearest" });
}

/** Ctrl/Cmd+F on STRING body or member detail → floating find. */
function focusSearch(): boolean {
  // Member detail is portaled; treat an open dialog as an active value surface.
  if (!valueViewerSearchActive.value && !valueSearchOpen.value && !showMemberDetail.value) return false;
  return openValueSearch();
}

function handleValueViewerPointerDown(event: PointerEvent) {
  const target = event.target;
  valueViewerSearchActive.value = target instanceof Element && !!target.closest("[data-redis-value-viewer], [data-redis-value-search], [data-text-content-search], [data-draggable-search-panel], [data-redis-member-detail]");
}

watch(valueSearchQuery, () => {
  // Typing: recompute matches/highlights; keep caret in the find input.
  valueSearchMatchIndex.value = 0;
  valueSearchHasNavigated.value = false;
  if (valueSearchOpen.value) void scrollContentSearchMatchIntoView();
});

watch(contentSearchText, () => {
  valueSearchMatchIndex.value = 0;
  valueSearchHasNavigated.value = false;
  if (valueSearchOpen.value) void scrollContentSearchMatchIntoView();
});

watch(
  () => [props.connectionId, props.db, props.keyRaw],
  () => {
    resetValueSearch();
    valueViewerSearchActive.value = false;
    resetStreamEntries();
    resetStreamMonitoring();
  },
);

watch(streamTab, (tab) => {
  if (tab === "groups" && redisKind.value === "stream") void loadStreamGroups();
});

watch(stringValueView, () => {
  if (!showMemberDetail.value) {
    valueSearchMatchIndex.value = 0;
    valueSearchHasNavigated.value = false;
  }
});

watch(memberValueView, () => {
  if (showMemberDetail.value) {
    valueSearchMatchIndex.value = 0;
    valueSearchHasNavigated.value = false;
  }
});

watch(showMemberDetail, (open) => {
  valueSearchMatchIndex.value = 0;
  valueSearchHasNavigated.value = false;
  // Closing the dialog ends member-scoped search.
  if (!open && !isStringLikeKind.value) resetValueSearch();
});

onMounted(() => {
  window.addEventListener("pointerdown", handleValueViewerPointerDown, true);
  document.addEventListener("visibilitychange", handleDocumentVisibilityChange);
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
onActivated(() => {
  redisValueViewerIsActive = true;
  startRefreshTimers();
});
onDeactivated(() => {
  redisValueViewerIsActive = false;
  stopRefreshTimers();
});
onBeforeUnmount(() => {
  window.removeEventListener("pointerdown", handleValueViewerPointerDown, true);
  document.removeEventListener("visibilitychange", handleDocumentVisibilityChange);
  redisValueViewerIsActive = false;
  stopRefreshTimers();
  stopResizeHashColumns();
  stopResizeZsetColumns();
  if (hashSearchTimer) clearTimeout(hashSearchTimer);
});

defineExpose({ focusSearch });
</script>

<template>
  <div data-redis-value-viewer class="relative h-full flex flex-col overflow-hidden" :style="editorFontFamilyStyle">
    <!-- STRING body find — mounted inside the value pane (not teleported out of focus). -->
    <TextContentSearchBar
      v-if="valueSearchOpen && data && valueSearchSupported && !showMemberDetail"
      ref="valueSearchBarRef"
      v-model="valueSearchQuery"
      :status="valueSearchStatus"
      :match-count="valueSearchMatchCount"
      :show-navigation="true"
      :placeholder="t('editor.search.find')"
      @activate="activateValueSearchMatch"
      @prev="moveContentSearchMatch(-1)"
      @next="moveContentSearchMatch(1)"
      @close="closeValueSearch"
    />

    <div v-if="loading" class="flex-1 flex items-center justify-center text-muted-foreground">
      {{ t("common.loading") }}
    </div>

    <template v-else-if="data">
      <!-- Header -->
      <div class="shrink-0 border-b bg-background">
        <div class="flex h-9 items-center gap-2 px-4">
          <span class="dbx-editor-font-family min-w-0 flex-1 truncate text-sm font-semibold">{{ formatValue(data.key_display) }}</span>
          <div class="flex h-7 shrink-0 overflow-hidden rounded-md border">
            <Button data-redis-value-refresh variant="ghost" size="icon" class="h-7 w-7 rounded-none animate-none" :disabled="loading || refreshingValue || hasUnsavedRedisDraft" :title="t('grid.refresh')" :aria-label="t('grid.refresh')" @click="refreshValueAndStreamGroups">
              <RefreshCw class="h-3.5 w-3.5 animate-none" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger as-child>
                <Button
                  data-redis-auto-refresh-menu
                  variant="ghost"
                  size="icon"
                  class="h-7 w-5 rounded-none border-l px-0"
                  :class="autoRefreshEnabled ? 'bg-primary/10 text-primary hover:bg-primary/15' : ''"
                  :title="autoRefreshEnabled ? `${t('redis.autoRefresh')}: ${autoRefreshIntervalSeconds}s` : t('redis.autoRefresh')"
                  :aria-label="autoRefreshEnabled ? `${t('redis.autoRefresh')}: ${autoRefreshIntervalSeconds}s` : t('redis.autoRefresh')"
                >
                  <ChevronDown class="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" class="w-40">
                <DropdownMenuLabel>{{ t("redis.autoRefresh") }}</DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem class="gap-2" @select="disableAutoRefresh">
                  <Check v-if="!autoRefreshEnabled" class="h-3.5 w-3.5" />
                  <span v-else class="h-3.5 w-3.5" />
                  {{ t("serverDashboard.off") }}
                </DropdownMenuItem>
                <DropdownMenuItem v-for="interval in REDIS_AUTO_REFRESH_INTERVAL_OPTIONS" :key="interval" class="gap-2" @select="selectAutoRefreshInterval(interval)">
                  <Check v-if="autoRefreshEnabled && autoRefreshIntervalSeconds === interval" class="h-3.5 w-3.5" />
                  <span v-else class="h-3.5 w-3.5" />
                  {{ interval }}s
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="t('grid.copyValue')" :aria-label="t('grid.copyValue')" @click="copyValue"><Copy class="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" :title="t('redis.copyInsertStatement')" :aria-label="t('redis.copyInsertStatement')" @click="copyInsertStatement"><ClipboardCopy class="h-3.5 w-3.5" /></Button>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-destructive" @click="requestDeleteKey"><Trash2 class="h-3.5 w-3.5" /></Button>
        </div>

        <div class="flex min-h-7 flex-wrap items-center gap-2 px-4 pb-1">
          <Badge variant="secondary" class="dbx-editor-font-family text-xs uppercase">{{ data.redis_type }}</Badge>
          <Badge v-if="metadataSizeLabel" variant="outline" class="text-xs text-muted-foreground"> {{ t("redis.columnSize") }}: {{ metadataSizeLabel }} </Badge>
          <template v-if="!editingTtl">
            <Badge v-if="data.ttl > 0" as="button" type="button" variant="outline" class="text-xs cursor-pointer text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50" :disabled="savingTtl" :aria-label="t('redis.expiry')" @click="startEditTtl">
              TTL: {{ formatTtl(computeDisplayTtl(countdownTtl, data.ttl), t) }}
            </Badge>
            <Badge v-else-if="data.ttl === -1" as="button" type="button" variant="outline" class="text-xs cursor-pointer text-muted-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50" :disabled="savingTtl" :aria-label="t('redis.expiry')" @click="startEditTtl">
              {{ t("redis.noExpiry") }}
            </Badge>
          </template>
          <div ref="editTtlWrapper" v-else class="flex min-w-0 max-w-full flex-wrap items-center gap-1">
            <Select v-model="ttlExpiryMode" :disabled="savingTtl">
              <SelectTrigger size="sm" class="h-6 max-w-[min(100%,14rem)] shrink-0 gap-1 py-0 pl-2 pr-1.5 text-[11px]" :aria-label="t('redis.expiry')">
                <SelectValue />
              </SelectTrigger>
              <SelectContent data-redis-expiry-mode-content class="min-w-[12rem]">
                <SelectItem value="none">{{ t("redis.expiryNone") }}</SelectItem>
                <SelectItem value="ttl">{{ t("redis.expiryTtl") }}</SelectItem>
                <SelectItem value="at">{{ t("redis.expiryAt") }}</SelectItem>
              </SelectContent>
            </Select>
            <Input v-if="ttlExpiryMode === 'ttl'" ref="ttlInputEl" v-model="ttlInput" class="h-6 w-28 shrink-0 text-xs" :disabled="savingTtl" inputmode="numeric" :placeholder="t('redis.createKeyTtlPlaceholder')" @keydown.enter="saveTtl" @keydown.escape="cancelEditTtl" />
            <DateTimePicker v-else-if="ttlExpiryMode === 'at'" v-model="ttlExpireAt" compact :locale="locale" :disabled="savingTtl" />
            <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :disabled="savingTtl" :title="t('grid.save')" :aria-label="t('grid.save')" @click="saveTtl"><Save class="h-3 w-3" /></Button>
          </div>
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
          <Button v-if="stringGzipBadge" variant="outline" size="sm" class="h-6 shrink-0 rounded-[5px] px-2 text-xs text-muted-foreground" :title="t('redis.gzipBadgeTitle')" :aria-label="t('redis.gzipBadgeTitle')" @click="setStringValueFormat('decompressed')">
            <FileArchive class="h-3.5 w-3.5 mr-1" />
            Gzip
          </Button>
          <span class="flex-1" />
          <div v-if="stringValueView === 'json' && stringValueDetail.json" class="flex shrink-0 overflow-hidden rounded-md border bg-muted/20 p-0.5">
            <Button variant="ghost" size="sm" class="h-6 shrink-0 rounded-[5px] px-2 text-xs" :class="{ 'bg-background shadow-sm': !redisJsonDecoded }" @click="setRedisJsonUnicodeMode('raw')">{{ t("redis.jsonViewRaw") }}</Button>
            <Button variant="ghost" size="sm" class="h-6 shrink-0 rounded-[5px] px-2 text-xs" :class="{ 'bg-background shadow-sm': redisJsonDecoded }" @click="setRedisJsonUnicodeMode('decoded')">{{ t("redis.jsonViewDecoded") }}</Button>
          </div>
          <label v-if="isTextRedisFormat(stringValueView)" class="flex items-center gap-1.5 text-muted-foreground">
            <WrapText class="h-3.5 w-3.5" />
            {{ t("redis.wordWrap") }}
            <Switch size="sm" :model-value="redisJsonWordWrap" @update:model-value="setRedisJsonWordWrap(Boolean($event))" />
          </label>
        </div>
        <RedisJsonEditor
          v-if="stringValueView === 'json' && stringValueDetail.json"
          ref="stringJsonEditorRef"
          v-model="editValue"
          class="min-h-0 flex-1"
          :save-disabled="savingString || !stringValueChanged"
          :read-only="savingString"
          :word-wrap="redisJsonWordWrap"
          :enable-builtin-find="false"
          @save="saveString"
        />
        <div v-else-if="stringValueView === 'javaserialize' && stringValueDetail.javaSerialized" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-4 text-sm leading-6">
          <JsonTree :value="stringValueDetail.javaSerialized.value" :word-wrap="redisJsonWordWrap" :highlight-json="highlightRedisJson" />
        </div>
        <div v-else-if="stringValueView === 'hex'" class="min-h-0 flex-1 overflow-auto bg-background p-4 text-xs leading-5">
          <div class="mb-3 flex items-center justify-between text-muted-foreground">
            <span>{{ t("grid.hexViewer") }}</span>
            <span>{{ t("grid.hexViewerByteCount", { count: stringValueDetail.byteCount }) }}</span>
          </div>
          <pre v-if="stringValueDetail.hexRows.length > 0 && canHighlightStringSurface" class="dbx-editor-font-family w-full min-w-0 max-w-full select-all whitespace-pre-wrap break-all" v-html="contentSearchHighlightedHtml" />
          <pre v-else-if="stringValueDetail.hexRows.length > 0" class="dbx-editor-font-family w-full min-w-0 max-w-full select-all whitespace-pre-wrap break-all">{{ detailTextForFormat(stringValueDetail, "hex") }}</pre>
          <div v-else class="text-muted-foreground">{{ t("grid.hexViewerEmpty") }}</div>
        </div>
        <pre v-else-if="stringValueView === 'base64' && canHighlightStringSurface" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-4 text-sm leading-6 whitespace-pre-wrap break-all" v-html="contentSearchHighlightedHtml" />
        <pre v-else-if="stringValueView === 'base64'" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-4 text-sm leading-6 whitespace-pre-wrap break-all">{{ stringValueDetail.base64Text }}</pre>
        <div v-else-if="stringValueView === 'decompressed'" class="min-h-0 flex-1 flex flex-col overflow-hidden">
          <div v-if="decompressedState.status === 'loading'" class="flex min-h-0 flex-1 items-center justify-center gap-2 text-muted-foreground">
            <Loader2 class="h-4 w-4 animate-spin" />
            {{ t("redis.decompressedLoading") }}
          </div>
          <div v-else-if="decompressedState.status === 'success'" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background">
            <div v-if="decompressedJsonDetail" class="p-4">
              <JsonTree :value="decompressedJsonDetail.value" :word-wrap="redisJsonWordWrap" :highlight-json="highlightRedisJson" />
            </div>
            <pre v-else class="w-full min-w-0 max-w-full p-4 text-sm leading-6" :class="detailTextClass('decompressed')">{{ decompressedState.text }}</pre>
          </div>
          <template v-else>
            <pre class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-4 text-sm leading-6" :class="detailTextClass('decompressed')">{{ decompressedRawFallbackText }}</pre>
            <div v-if="decompressedFailureMessage" class="flex shrink-0 flex-wrap items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
              <span>{{ decompressedFailureMessage }}</span>
              <Button
                v-if="decompressedState.status === 'error' && decompressedState.reason !== 'limit'"
                variant="outline"
                size="sm"
                class="h-6 shrink-0 rounded-[5px] px-2 text-xs"
                :title="t('redis.decompressedRetryAsDeflate')"
                :aria-label="t('redis.decompressedRetryAsDeflate')"
                @click="retryDecompressAsDeflate"
              >
                {{ t("redis.decompressedRetryAsDeflate") }}
              </Button>
            </div>
          </template>
        </div>
        <textarea
          v-else-if="stringValueView === 'utf8' && canEditCurrentStringFormat"
          ref="stringTextareaRef"
          v-model="editValue"
          class="dbx-editor-font-family flex-1 resize-none bg-background p-4 text-sm outline-none"
          :class="redisJsonWordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
          :readonly="!canEditCurrentStringFormat || savingString"
          spellcheck="false"
        />
        <pre v-else-if="canHighlightStringSurface" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-4 text-sm leading-6" :class="detailTextClass(stringValueView)" v-html="contentSearchHighlightedHtml" />
        <pre v-else class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-4 text-sm leading-6" :class="detailTextClass(stringValueView)">{{ detailTextForFormat(stringValueDetail, stringValueView) }}</pre>
        <div v-if="isBinaryStringValue" class="px-4 py-2 border-t text-xs text-muted-foreground shrink-0">
          {{ t("redis.binaryStringReadonlyHint") }}
        </div>
        <div v-if="showStringEditActions" class="px-4 py-2 border-t flex justify-end gap-2 shrink-0">
          <Button variant="ghost" size="sm" :disabled="savingString || !stringValueChanged" @click="discardStringEdit">{{ t("grid.discard") }}</Button>
          <Button size="sm" :disabled="savingString || !stringValueChanged" @click="saveString"><Loader2 v-if="savingString" class="w-3 h-3 mr-1 animate-spin" /><Save v-else class="w-3 h-3 mr-1" /> {{ t("grid.save") }}</Button>
        </div>
      </div>

      <!-- Redis JSON -->
      <div v-else-if="redisKind === 'json'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex h-9 items-center gap-2 border-b px-4 text-xs shrink-0">
          <span class="flex-1" />
          <div class="flex shrink-0 overflow-hidden rounded-md border bg-muted/20 p-0.5">
            <Button variant="ghost" size="sm" class="h-6 shrink-0 rounded-[5px] px-2 text-xs" :class="{ 'bg-background shadow-sm': !redisJsonDecoded }" @click="setRedisJsonUnicodeMode('raw')">{{ t("redis.jsonViewRaw") }}</Button>
            <Button variant="ghost" size="sm" class="h-6 shrink-0 rounded-[5px] px-2 text-xs" :class="{ 'bg-background shadow-sm': redisJsonDecoded }" @click="setRedisJsonUnicodeMode('decoded')">{{ t("redis.jsonViewDecoded") }}</Button>
          </div>
          <label class="flex items-center gap-1.5 text-muted-foreground">
            <WrapText class="h-3.5 w-3.5" />
            {{ t("redis.wordWrap") }}
            <Switch size="sm" :model-value="redisJsonWordWrap" @update:model-value="setRedisJsonWordWrap(Boolean($event))" />
          </label>
        </div>
        <RedisJsonEditor ref="redisJsonEditorRef" v-model="editValue" class="min-h-0 flex-1" :save-disabled="savingJson || !redisJsonValueChanged" :read-only="savingJson" :word-wrap="redisJsonWordWrap" :enable-builtin-find="false" @save="saveJson" />
        <div v-if="redisJsonValueChanged" class="px-4 py-2 border-t flex justify-end gap-2 shrink-0">
          <Button variant="ghost" size="sm" :disabled="savingJson" @click="discardRedisJsonEdit">{{ t("grid.discard") }}</Button>
          <Button size="sm" :disabled="savingJson" @click="saveJson"><Loader2 v-if="savingJson" class="w-3 h-3 mr-1 animate-spin" /><Save v-else class="w-3 h-3 mr-1" /> {{ t("grid.save") }}</Button>
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
          <div class="relative border-r text-xs font-medium text-muted-foreground select-none" role="columnheader" :aria-sort="hashSortBy === 'field' ? (hashSortDir === 'asc' ? 'ascending' : 'descending') : 'none'">
            <button type="button" class="flex h-full w-full cursor-pointer items-center gap-1 px-3 py-1 text-left hover:bg-accent/50" @click="toggleHashSort('field')">
              Field
              <ArrowUp v-if="hashSortBy === 'field' && hashSortDir === 'asc'" class="h-3 w-3 shrink-0" />
              <ArrowDown v-else-if="hashSortBy === 'field' && hashSortDir === 'desc'" class="h-3 w-3 shrink-0" />
              <ArrowUpDown v-else class="h-3 w-3 shrink-0 text-muted-foreground/40" />
            </button>
            <div class="absolute -right-1 top-0 h-full w-2 cursor-col-resize touch-none" @pointerdown.stop.prevent="startResizeHashColumns" />
          </div>
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground cursor-pointer hover:bg-accent/50 flex items-center gap-1 select-none" role="columnheader" :aria-sort="hashSortBy === 'value' ? (hashSortDir === 'asc' ? 'ascending' : 'descending') : 'none'" @click="toggleHashSort('value')">
            Value
            <ArrowUp v-if="hashSortBy === 'value' && hashSortDir === 'asc'" class="h-3 w-3 shrink-0" />
            <ArrowDown v-else-if="hashSortBy === 'value' && hashSortDir === 'desc'" class="h-3 w-3 shrink-0" />
            <ArrowUpDown v-else class="h-3 w-3 shrink-0 text-muted-foreground/40" />
          </div>
          <div v-if="hashFieldTtlSupported" class="px-3 py-1 text-xs font-medium text-muted-foreground">{{ t("redis.columnTTL") }}</div>
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
              <div v-if="hashFieldTtlSupported" class="px-2 py-1 flex items-center min-w-0">
                <Button
                  v-if="redisBlobText(row.value.field) && row.value.field_ttl !== undefined"
                  variant="ghost"
                  size="sm"
                  class="h-6 min-w-0 max-w-full justify-start px-1.5 text-xs font-normal text-muted-foreground hover:text-foreground"
                  :title="t('redis.expiry')"
                  @click.stop="startEditHashFieldTtl(redisBlobText(row.value.field))"
                >
                  <span class="truncate">{{ hashFieldTtlLabel(row.value) }}</span>
                </Button>
                <span v-else class="px-1.5 text-xs text-muted-foreground">-</span>
              </div>
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
          <div class="px-3 py-1 text-center text-xs font-medium text-muted-foreground border-r" role="columnheader">#</div>
          <div class="relative border-r text-xs font-medium text-muted-foreground select-none" role="columnheader" :aria-sort="zsetSortDir === 'asc' ? 'ascending' : 'descending'">
            <button type="button" class="flex h-full w-full cursor-pointer items-center gap-1 px-3 py-1 text-left hover:bg-accent/50" @click="toggleZsetSort">
              Score
              <ArrowUp v-if="zsetSortDir === 'asc'" class="h-3 w-3 shrink-0" />
              <ArrowDown v-else class="h-3 w-3 shrink-0" />
            </button>
            <div class="absolute -right-1 top-0 h-full w-2 cursor-col-resize touch-none" @pointerdown.stop.prevent="startResizeZsetColumns" />
          </div>
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground min-w-0">Member</div>
          <div />
        </div>
        <RecycleScroller class="flex-1 overflow-y-auto" :items="zsetRows" :item-size="REDIS_COLLECTION_ROW_HEIGHT" :buffer="600" :skip-hover="true" key-field="id">
          <template #default="{ item: row }">
            <div data-redis-value-row class="dbx-editor-font-family grid border-b text-sm hover:bg-accent/50 group" :class="{ 'bg-accent/60': isEditingZsetRow(row.value) }" :style="{ ...zsetGridStyle, height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }">
              <div class="px-3 py-1.5 text-center text-xs text-muted-foreground border-r tabular-nums">{{ row.index + 1 }}</div>
              <div class="flex min-w-0 items-center border-r px-3 py-1.5 text-xs text-muted-foreground">
                <Input v-if="isEditingZsetRow(row.value)" v-model="zsetInlineScore" aria-label="Score" class="h-6 min-w-0 text-xs tabular-nums" :disabled="savingZsetMember" inputmode="decimal" @keydown.enter.prevent="saveZsetInlineEdit(row.value)" />
                <span v-else class="min-w-0 truncate" :title="String(row.value.score)">{{ row.value.score }}</span>
              </div>
              <div class="flex min-w-0 items-center px-3 py-1.5">
                <Input v-if="isEditingZsetRow(row.value)" v-model="zsetInlineMember" aria-label="Member" class="dbx-editor-font-family h-6 min-w-0 text-sm" :disabled="savingZsetMember" @keydown.enter.prevent="saveZsetInlineEdit(row.value)" />
                <span v-else class="min-w-0 truncate" :title="formatValue(row.value.member)">{{ formatValue(row.value.member) }}</span>
              </div>
              <div class="flex items-center justify-center gap-1">
                <template v-if="isEditingZsetRow(row.value)">
                  <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="savingZsetMember" :title="t('grid.save')" @click="saveZsetInlineEdit(row.value)"><Loader2 v-if="savingZsetMember" class="h-3 w-3 animate-spin" /><Save v-else class="h-3 w-3" /></Button>
                  <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="savingZsetMember" :title="t('grid.discard')" @click="cancelZsetInlineEdit"><X class="h-3 w-3" /></Button>
                </template>
                <template v-else>
                  <Button
                    data-redis-zset-view-member
                    variant="ghost"
                    size="icon"
                    class="h-5 w-5 opacity-0 group-hover:opacity-100"
                    :title="t('redis.viewMember')"
                    @click.stop="viewMember(row.value.score, row.value.member, { kind: 'zset', member: redisBlobText(row.value.member), score: row.value.score, canEdit: redisBlobText(row.value.member) != null && canEditRedisMemberDetail('zset', row.value.member) })"
                    ><Eye class="w-3 h-3"
                  /></Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-5 w-5 opacity-0 group-hover:opacity-100"
                    :disabled="editingZsetMemberKey !== null || redisBlobText(row.value.member) == null || !canEditRedisMemberDetail('zset', row.value.member)"
                    :title="t('redis.editMember')"
                    @click="startZsetInlineEdit(row.value)"
                    ><Pencil class="w-3 h-3"
                  /></Button>
                  <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.copyMember')" @click="copyMember(row.value.member)"><Copy class="w-3 h-3" /></Button>
                  <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive" :disabled="!canDeleteZsetItem(row.value)" @click="requestZsetRemove(redisBlobText(row.value.member))"><Trash2 class="w-3 h-3" /></Button>
                </template>
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

      <!-- Stream monitoring -->
      <div v-else-if="redisKind === 'stream'" class="flex-1 flex flex-col overflow-hidden">
        <Tabs v-model="streamTab" :unmount-on-hide="false" class="h-full min-h-0 gap-0">
          <div class="flex h-9 shrink-0 items-stretch overflow-x-auto border-b px-4">
            <TabsList variant="line" class="h-full shrink-0 gap-0 p-0">
              <TabsTrigger value="entries" data-redis-stream-entries-tab class="h-full flex-none rounded-none px-3 text-xs group-data-horizontal/tabs:after:bottom-0">{{ t("redis.streamData") }}</TabsTrigger>
              <TabsTrigger
                value="groups"
                data-redis-stream-groups-tab
                :class="['h-full flex-none rounded-none px-3 text-xs group-data-horizontal/tabs:after:bottom-0', selectedStreamGroup && 'data-active:text-foreground/60 group-data-[variant=line]/tabs-list:data-active:after:opacity-0']"
                @click="resetStreamGroupDetail"
              >
                {{ t("redis.consumerGroups") }}
              </TabsTrigger>
            </TabsList>
            <template v-if="streamTab === 'groups' && selectedStreamGroup">
              <span class="mx-1 h-4 w-px shrink-0 self-center bg-border" aria-hidden="true" />
              <button
                data-redis-stream-group-crumb
                type="button"
                class="relative inline-flex h-full max-w-48 shrink-0 items-center border-b-2 px-3 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                :class="selectedStreamConsumer ? 'border-transparent text-foreground/60 hover:text-foreground' : 'border-foreground text-foreground'"
                :title="formatValue(selectedStreamGroup.name)"
                @click="resetStreamConsumerDetail"
              >
                <span class="dbx-editor-font-family truncate">{{ formatValue(selectedStreamGroup.name) }}</span>
              </button>
              <span v-if="selectedStreamConsumer" data-redis-stream-consumer-crumb class="dbx-editor-font-family inline-flex h-full max-w-48 shrink-0 items-center truncate border-b-2 border-foreground px-3 text-xs font-medium text-foreground" :title="formatValue(selectedStreamConsumer.name)">
                <span class="truncate">{{ formatValue(selectedStreamConsumer.name) }}</span>
              </span>
            </template>
          </div>

          <TabsContent value="entries" class="m-0 min-h-0 flex-1 flex flex-col">
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
                        <Button
                          variant="ghost"
                          size="icon"
                          class="h-5 w-5 opacity-0 group-hover:opacity-100"
                          :title="t('redis.viewMember')"
                          @click.stop="viewMember(field.field, field.value, { kind: 'stream', field: field.field, canEdit: false }, streamFieldSelectionIdentity(row.entry.id, fieldIndex))"
                          ><Eye class="w-3 h-3"
                        /></Button>
                        <Button variant="ghost" size="icon" class="h-5 w-5 opacity-0 group-hover:opacity-100" :title="t('redis.copyMember')" @click.stop="copyMember(field.value)"><Copy class="w-3 h-3" /></Button>
                      </span>
                    </div>
                  </div>
                </DynamicScrollerItem>
              </template>
              <template #after>
                <div v-if="streamEntriesCursor" class="border-t p-2">
                  <Button data-redis-stream-entries-more variant="outline" size="sm" class="h-7 w-full text-xs" :disabled="loading || streamEntriesLoadingMore" @click="loadMoreStreamEntries">
                    <Loader2 v-if="streamEntriesLoadingMore" class="mr-1.5 h-3 w-3 animate-spin" />
                    {{ t("redis.loadMoreEntries") }}
                  </Button>
                </div>
              </template>
            </DynamicScroller>
          </TabsContent>

          <TabsContent value="groups" class="m-0 min-h-0 flex-1 flex flex-col">
            <template v-if="!selectedStreamGroup">
              <div class="flex shrink-0 items-center gap-2 border-b px-4 py-1.5 text-xs text-muted-foreground">
                <span>{{ t("redis.consumerGroups") }}</span>
                <Loader2 v-if="streamGroupsLoading" class="h-3 w-3 animate-spin" />
              </div>

              <div v-if="streamGroupsLoading && !streamGroupsLoaded" class="flex flex-1 items-center justify-center text-xs text-muted-foreground">
                <Loader2 class="mr-2 h-4 w-4 animate-spin" />
                {{ t("common.loading") }}
              </div>
              <div v-else-if="streamGroupsError && streamGroups.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-xs text-muted-foreground">
                <span>{{ t("redis.streamGroupsLoadFailed") }}: {{ streamGroupsError }}</span>
                <Button data-redis-stream-groups-retry variant="outline" size="sm" class="h-7 text-xs" @click="retryStreamGroups">{{ t("common.retry") }}</Button>
              </div>
              <div v-else class="min-h-0 flex-1 overflow-auto">
                <div v-if="streamGroupsError" class="flex items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
                  <span class="min-w-0 flex-1 truncate">{{ t("redis.streamGroupsLoadFailed") }}: {{ streamGroupsError }}</span>
                  <Button data-redis-stream-groups-retry variant="ghost" size="sm" class="h-6 text-xs text-destructive" @click="retryStreamGroups">{{ t("common.retry") }}</Button>
                </div>
                <div v-if="streamGroups.length === 0" class="flex h-full min-h-40 items-center justify-center p-4 text-xs text-muted-foreground">
                  {{ t("redis.noConsumerGroups") }}
                </div>
                <table v-else data-redis-stream-groups class="w-full min-w-[780px] border-collapse text-left text-sm">
                  <thead class="sticky top-0 bg-muted/95 text-xs text-muted-foreground backdrop-blur">
                    <tr>
                      <th class="px-4 py-2 font-medium">{{ t("redis.group") }}</th>
                      <th class="px-3 py-2 text-right font-medium">{{ t("redis.consumers") }}</th>
                      <th class="px-3 py-2 text-right font-medium">{{ t("redis.pending") }}</th>
                      <th class="px-3 py-2 font-medium">{{ t("redis.lastDeliveredId") }}</th>
                      <th class="px-3 py-2 text-right font-medium">{{ t("redis.entriesRead") }}</th>
                      <th class="px-4 py-2 text-right font-medium">{{ t("redis.lag") }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="group in streamGroups" :key="group.name.raw_base64" data-redis-stream-group-row class="cursor-pointer border-t hover:bg-accent/50" @click="selectStreamGroup(group)">
                      <td class="dbx-editor-font-family max-w-72 truncate px-4 py-2" :title="formatValue(group.name)">{{ formatValue(group.name) }}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{{ formatStreamMetric(group.consumers) }}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{{ formatStreamMetric(group.pending) }}</td>
                      <td class="dbx-editor-font-family max-w-56 truncate px-3 py-2 text-muted-foreground" :title="group.last_delivered_id">{{ group.last_delivered_id }}</td>
                      <td class="px-3 py-2 text-right tabular-nums">{{ formatStreamMetric(group.entries_read) }}</td>
                      <td class="px-4 py-2 text-right tabular-nums">{{ formatStreamMetric(group.lag) }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </template>

            <template v-else>
              <div data-redis-stream-group-detail class="min-h-0 flex-1 overflow-auto bg-muted/20 p-3">
                <div class="mx-auto flex w-full max-w-[1120px] flex-col gap-3">
                  <div v-if="selectedStreamConsumer" data-redis-stream-consumer-summary class="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
                    <div class="bg-card px-3 py-2.5">
                      <div class="text-xs text-muted-foreground">{{ t("redis.pending") }}</div>
                      <div class="mt-1 text-lg font-semibold tabular-nums">{{ formatStreamMetric(selectedStreamConsumer.pending) }}</div>
                    </div>
                    <div class="bg-card px-3 py-2.5">
                      <div class="text-xs text-muted-foreground">{{ t("redis.idle") }}</div>
                      <div class="mt-1 text-lg font-semibold tabular-nums" :title="formatStreamDurationTitle(selectedStreamConsumer.idle_ms)">{{ formatStreamDuration(selectedStreamConsumer.idle_ms) }}</div>
                    </div>
                    <div class="bg-card px-3 py-2.5">
                      <div class="text-xs text-muted-foreground">{{ t("redis.inactive") }}</div>
                      <div class="mt-1 text-lg font-semibold tabular-nums" :title="formatStreamDurationTitle(selectedStreamConsumer.inactive_ms)">{{ formatStreamDuration(selectedStreamConsumer.inactive_ms) }}</div>
                    </div>
                  </div>
                  <div v-else data-redis-stream-group-summary class="grid grid-cols-3 gap-px overflow-hidden rounded-lg border bg-border">
                    <div class="bg-card px-3 py-2.5">
                      <div class="text-xs text-muted-foreground">{{ t("redis.consumers") }}</div>
                      <div class="mt-1 text-lg font-semibold tabular-nums">{{ formatStreamMetric(selectedStreamGroup.consumers) }}</div>
                    </div>
                    <div class="bg-card px-3 py-2.5">
                      <div class="text-xs text-muted-foreground">{{ t("redis.pending") }}</div>
                      <div class="mt-1 text-lg font-semibold tabular-nums">{{ formatStreamMetric(selectedStreamGroup.pending) }}</div>
                    </div>
                    <div class="bg-card px-3 py-2.5">
                      <div class="text-xs text-muted-foreground">{{ t("redis.lag") }}</div>
                      <div class="mt-1 text-lg font-semibold tabular-nums">{{ formatStreamMetric(selectedStreamGroup.lag) }}</div>
                    </div>
                  </div>

                  <section v-if="!selectedStreamConsumer" data-redis-stream-consumers class="overflow-hidden rounded-lg border bg-card text-card-foreground">
                    <div class="flex min-h-10 items-center gap-2 border-b px-3 py-2">
                      <span class="text-sm font-medium">{{ t("redis.streamConsumers") }}</span>
                      <Badge v-if="streamConsumers.length" variant="secondary" class="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums">{{ formatStreamMetric(streamConsumers.length) }}</Badge>
                      <Loader2 v-if="streamConsumersLoading" class="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    </div>

                    <div v-if="streamConsumersLoading && streamConsumers.length === 0" class="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                      <Loader2 class="h-3.5 w-3.5 animate-spin" />
                      {{ t("common.loading") }}
                    </div>
                    <div v-else-if="streamConsumersError && streamConsumers.length === 0" class="flex items-center gap-2 px-3 py-5 text-xs text-destructive">
                      <span class="min-w-0 flex-1 truncate">{{ t("redis.streamConsumersLoadFailed") }}: {{ streamConsumersError }}</span>
                      <Button data-redis-stream-consumers-retry variant="ghost" size="sm" class="h-7 text-xs text-destructive" @click="retryStreamConsumers">{{ t("common.retry") }}</Button>
                    </div>
                    <template v-else>
                      <div v-if="streamConsumersError" class="flex items-center gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        <span class="min-w-0 flex-1 truncate">{{ t("redis.streamConsumersLoadFailed") }}: {{ streamConsumersError }}</span>
                        <Button data-redis-stream-consumers-retry variant="ghost" size="sm" class="h-6 text-xs text-destructive" @click="retryStreamConsumers">{{ t("common.retry") }}</Button>
                      </div>
                      <div v-if="streamConsumers.length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">{{ t("redis.noStreamConsumers") }}</div>
                      <table v-else data-redis-stream-consumers-table class="w-full table-fixed border-collapse text-sm">
                        <colgroup>
                          <col class="w-1/4" />
                          <col class="w-1/4" />
                          <col class="w-1/4" />
                          <col class="w-1/4" />
                        </colgroup>
                        <thead class="bg-muted/50 text-xs text-muted-foreground">
                          <tr data-redis-stream-consumer-header>
                            <th scope="col" class="px-3 py-1.5 text-left font-medium">{{ t("redis.consumer") }}</th>
                            <th scope="col" class="px-2 py-1.5 text-right font-medium">{{ t("redis.pending") }}</th>
                            <th scope="col" class="px-2 py-1.5 text-right font-medium">{{ t("redis.idle") }}</th>
                            <th scope="col" class="px-3 py-1.5 text-right font-medium">{{ t("redis.inactive") }}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="consumer in streamConsumers" :key="consumer.name.raw_base64" class="border-t hover:bg-muted/20">
                            <td class="px-3 py-2 text-left">
                              <button
                                data-redis-stream-consumer-row
                                type="button"
                                class="block w-full min-w-0 rounded-sm text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                                :title="t('redis.openConsumerDetails')"
                                @click="selectStreamConsumer(consumer)"
                              >
                                <span class="dbx-editor-font-family block truncate">{{ formatValue(consumer.name) }}</span>
                              </button>
                            </td>
                            <td class="px-2 py-2 text-right tabular-nums">{{ formatStreamMetric(consumer.pending) }}</td>
                            <td class="px-2 py-2 text-right tabular-nums" :title="formatStreamDurationTitle(consumer.idle_ms)">{{ formatStreamDuration(consumer.idle_ms) }}</td>
                            <td class="px-3 py-2 text-right tabular-nums" :title="formatStreamDurationTitle(consumer.inactive_ms)">{{ formatStreamDuration(consumer.inactive_ms) }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </template>
                  </section>

                  <section v-if="selectedStreamConsumer" data-redis-stream-pending class="overflow-hidden rounded-lg border bg-card text-card-foreground">
                    <div class="flex min-h-10 items-center gap-2 border-b px-3 py-2">
                      <span class="text-sm font-medium">{{ t("redis.pendingEntries") }}</span>
                      <Badge v-if="selectedStreamConsumer" variant="outline" class="dbx-editor-font-family min-w-0 max-w-48 truncate px-1.5 text-[10px]" :title="formatValue(selectedStreamConsumer.name)">{{ formatValue(selectedStreamConsumer.name) }}</Badge>
                      <Badge v-if="streamPendingEntries.length" variant="secondary" class="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums">{{ formatStreamMetric(streamPendingEntries.length) }}</Badge>
                      <Loader2 v-if="streamPendingLoading || streamPendingLoadingMore" class="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    </div>

                    <div v-if="streamPendingLoading && streamPendingEntries.length === 0" class="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
                      <Loader2 class="h-3.5 w-3.5 animate-spin" />
                      {{ t("common.loading") }}
                    </div>
                    <div v-else-if="streamPendingError && streamPendingEntries.length === 0" class="flex items-center gap-2 px-3 py-5 text-xs text-destructive">
                      <span class="min-w-0 flex-1 truncate">{{ t("redis.pendingEntriesLoadFailed") }}: {{ streamPendingError }}</span>
                      <Button data-redis-stream-pending-retry variant="ghost" size="sm" class="h-7 text-xs text-destructive" @click="retryStreamPending">{{ t("common.retry") }}</Button>
                    </div>
                    <template v-else>
                      <div v-if="streamPendingError" class="flex items-center gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive">
                        <span class="min-w-0 flex-1 truncate">{{ t("redis.pendingEntriesLoadFailed") }}: {{ streamPendingError }}</span>
                        <Button data-redis-stream-pending-retry variant="ghost" size="sm" class="h-6 text-xs text-destructive" @click="retryStreamPending">{{ t("common.retry") }}</Button>
                      </div>
                      <div v-if="streamPendingEntries.length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">{{ t("redis.noPendingEntries") }}</div>
                      <table v-else data-redis-stream-pending-table class="w-full table-fixed border-collapse text-sm">
                        <colgroup>
                          <col class="w-[44%]" />
                          <col class="w-[36%]" />
                          <col class="w-[20%]" />
                        </colgroup>
                        <thead class="bg-muted/50 text-xs text-muted-foreground">
                          <tr data-redis-stream-pending-header>
                            <th scope="col" class="px-3 py-1.5 text-left font-medium">{{ t("redis.entryId") }}</th>
                            <th scope="col" class="px-2 py-1.5 text-left font-medium">{{ t("redis.lastDelivered") }}</th>
                            <th scope="col" class="px-3 py-1.5 text-right font-medium">{{ t("redis.deliveries") }}</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="entry in streamPendingEntries" :key="entry.id" class="border-t hover:bg-muted/20">
                            <td class="px-3 py-2 text-left" :title="entry.id">
                              <div class="dbx-editor-font-family truncate">{{ entry.id }}</div>
                            </td>
                            <td class="px-2 py-2 text-left tabular-nums" :title="formatStreamDurationTitle(entry.idle_ms)">{{ formatStreamLastDelivery(entry.idle_ms) }}</td>
                            <td class="px-3 py-2 text-right tabular-nums">{{ formatStreamMetric(entry.deliveries) }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </template>

                    <div v-if="streamPendingCursor" class="border-t p-2">
                      <Button data-redis-stream-pending-more variant="outline" size="sm" class="h-7 w-full text-xs" :disabled="streamPendingLoadingMore" @click="loadMoreStreamPending">
                        <Loader2 v-if="streamPendingLoadingMore" class="mr-1.5 h-3 w-3 animate-spin" />
                        {{ t("redis.loadMorePending") }}
                      </Button>
                    </div>
                  </section>
                </div>
              </div>
            </template>
          </TabsContent>
        </Tabs>
      </div>

      <!-- Unknown -->
      <div v-else class="flex-1 overflow-auto p-4">
        <pre class="dbx-editor-font-family text-sm whitespace-pre-wrap">{{ formatValue(data.data) }}</pre>
      </div>
    </template>

    <DangerConfirmDialog v-model:open="showDeleteConfirm" :message="t('dangerDialog.deleteMessage')" :details="deleteDetails" :confirm-label="t('dangerDialog.deleteConfirm')" @confirm="confirmDelete" />

    <Dialog :open="showHashFieldTtlDialog" @update:open="handleHashFieldTtlOpenChange">
      <DialogContent class="w-[calc(100vw-2rem)] sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{{ t("redis.expiry") }}: {{ editingHashField ? formatValue(editingHashField) : "" }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 py-2">
          <Select v-model="hashFieldTtlMode" :disabled="savingHashFieldTtl">
            <SelectTrigger :aria-label="t('redis.expiry')">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{{ t("redis.expiryNone") }}</SelectItem>
              <SelectItem value="ttl">{{ t("redis.expiryTtl") }}</SelectItem>
              <SelectItem value="at">{{ t("redis.expiryAt") }}</SelectItem>
            </SelectContent>
          </Select>
          <Input v-if="hashFieldTtlMode === 'ttl'" v-model="hashFieldTtlInput" :disabled="savingHashFieldTtl" inputmode="numeric" :placeholder="t('redis.createKeyTtlPlaceholder')" @keydown.enter="saveHashFieldTtl" />
          <DateTimePicker v-else-if="hashFieldTtlMode === 'at'" v-model="hashFieldExpireAt" :locale="locale" :disabled="savingHashFieldTtl" />
        </div>
        <DialogFooter>
          <Button variant="ghost" :disabled="savingHashFieldTtl" @click="cancelEditHashFieldTtl">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="savingHashFieldTtl" @click="saveHashFieldTtl">
            <Loader2 v-if="savingHashFieldTtl" class="h-4 w-4 animate-spin" />
            <Save v-else class="h-4 w-4" />
            {{ t("grid.save") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog :open="showMemberDetail" @update:open="handleMemberDetailOpenChange">
      <DialogContent data-redis-member-detail class="relative flex h-[min(760px,85vh)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[960px]" :style="editorFontFamilyStyle" @close-auto-focus="finishMemberDetailClose" @pointer-down-outside.prevent @interact-outside.prevent>
        <!--
          Inside DialogContent (focus trap). absolute — not fixed — so dialog
          transform/overflow do not break hit-testing or caret.
        -->
        <TextContentSearchBar
          v-if="valueSearchOpen && showMemberDetail"
          ref="valueSearchBarRef"
          v-model="valueSearchQuery"
          :status="valueSearchStatus"
          :match-count="valueSearchMatchCount"
          :show-navigation="true"
          :placeholder="t('editor.search.find')"
          @activate="activateValueSearchMatch"
          @prev="moveContentSearchMatch(-1)"
          @next="moveContentSearchMatch(1)"
          @close="closeValueSearch"
        />
        <DialogHeader class="border-b px-5 py-4 pr-12">
          <DialogTitle class="flex items-center gap-2">
            <span class="truncate">{{ selectedMemberTitle ? formatValue(selectedMemberTitle) : t("redis.memberDetail") }}</span>
            <Badge variant="outline" class="shrink-0 text-xs">{{ redisFormatLabel(memberValueView, selectedMemberDetail.rawLabel) }}</Badge>
            <Badge v-if="memberGzipBadge" variant="outline" class="shrink-0 cursor-pointer text-xs text-muted-foreground" :title="t('redis.gzipBadgeTitle')" :aria-label="t('redis.gzipBadgeTitle')" @click="setMemberValueFormat('decompressed')">
              <FileArchive class="h-3 w-3 mr-1" />
              Gzip
            </Badge>
          </DialogTitle>
        </DialogHeader>
        <template v-if="isEditingMember">
          <textarea ref="memberTextareaRef" data-redis-member-utf8-editor v-model="memberEditValue" class="dbx-editor-font-family min-h-0 flex-1 resize-none bg-background p-5 text-[13px] leading-6 outline-none" :readonly="savingMember" spellcheck="false" />
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
            <div v-if="memberValueView === 'json' && selectedMemberDetail.json" class="flex shrink-0 overflow-hidden rounded-md border bg-muted/20 p-0.5">
              <Button variant="ghost" size="sm" class="h-6 shrink-0 rounded-[5px] px-2 text-xs" :class="{ 'bg-background shadow-sm': !redisJsonDecoded }" @click="setRedisJsonUnicodeMode('raw')">{{ t("redis.jsonViewRaw") }}</Button>
              <Button variant="ghost" size="sm" class="h-6 shrink-0 rounded-[5px] px-2 text-xs" :class="{ 'bg-background shadow-sm': redisJsonDecoded }" @click="setRedisJsonUnicodeMode('decoded')">{{ t("redis.jsonViewDecoded") }}</Button>
            </div>
            <label v-if="isTextRedisFormat(memberValueView)" class="flex items-center gap-1.5 text-muted-foreground">
              <WrapText class="h-3.5 w-3.5" />
              {{ t("redis.wordWrap") }}
              <Switch size="sm" :model-value="redisJsonWordWrap" @update:model-value="setRedisJsonWordWrap(Boolean($event))" />
            </label>
          </div>
          <RedisJsonEditor v-if="isEditingHashJson" ref="memberJsonEditorRef" v-model="memberEditValue" class="min-h-0 flex-1" :save-disabled="savingMember || !memberValueChanged" :read-only="savingMember" :word-wrap="redisJsonWordWrap" :enable-builtin-find="false" @save="saveMemberEdit" />
          <div v-else-if="memberValueView === 'json' && selectedMemberDetail.json" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-5 text-[13px] leading-6">
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
            <pre v-if="selectedMemberDetail.hexRows.length > 0 && canHighlightMemberSurface" class="dbx-editor-font-family w-full min-w-0 max-w-full select-all whitespace-pre-wrap break-all" v-html="contentSearchHighlightedHtml" />
            <pre v-else-if="selectedMemberDetail.hexRows.length > 0" class="dbx-editor-font-family w-full min-w-0 max-w-full select-all whitespace-pre-wrap break-all">{{ detailTextForFormat(selectedMemberDetail, "hex") }}</pre>
            <div v-else class="text-muted-foreground">{{ t("grid.hexViewerEmpty") }}</div>
          </div>
          <pre v-else-if="memberValueView === 'base64' && canHighlightMemberSurface" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-5 text-[13px] leading-6 whitespace-pre-wrap break-all" v-html="contentSearchHighlightedHtml" />
          <pre v-else-if="memberValueView === 'base64'" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-5 text-[13px] leading-6 whitespace-pre-wrap break-all">{{ selectedMemberDetail.base64Text }}</pre>
          <div v-else-if="memberValueView === 'decompressed'" class="min-h-0 flex-1 flex flex-col overflow-hidden">
            <div v-if="decompressedState.status === 'loading'" class="flex min-h-0 flex-1 items-center justify-center gap-2 text-muted-foreground">
              <Loader2 class="h-4 w-4 animate-spin" />
              {{ t("redis.decompressedLoading") }}
            </div>
            <div v-else-if="decompressedState.status === 'success'" class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background">
              <div v-if="decompressedJsonDetail" class="p-5">
                <JsonTree :value="decompressedJsonDetail.value" :word-wrap="redisJsonWordWrap" :highlight-json="highlightRedisJson" />
              </div>
              <pre v-else class="w-full min-w-0 max-w-full p-5 text-[13px] leading-6" :class="detailTextClass('decompressed')">{{ decompressedState.text }}</pre>
            </div>
            <template v-else>
              <pre class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-5 text-[13px] leading-6" :class="detailTextClass('decompressed')">{{ decompressedRawFallbackText }}</pre>
              <div v-if="decompressedFailureMessage" class="flex shrink-0 flex-wrap items-center gap-2 border-t px-5 py-2 text-xs text-muted-foreground">
                <span>{{ decompressedFailureMessage }}</span>
                <Button
                  v-if="decompressedState.status === 'error' && decompressedState.reason !== 'limit'"
                  variant="outline"
                  size="sm"
                  class="h-6 shrink-0 rounded-[5px] px-2 text-xs"
                  :title="t('redis.decompressedRetryAsDeflate')"
                  :aria-label="t('redis.decompressedRetryAsDeflate')"
                  @click="retryDecompressAsDeflate"
                >
                  {{ t("redis.decompressedRetryAsDeflate") }}
                </Button>
              </div>
            </template>
          </div>
          <div v-else-if="memberValueView === 'utf8' && canEditCurrentMemberFormat" data-redis-member-utf8-viewer class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background text-[13px] leading-6 cursor-text" @dblclick.self.prevent="startEditMember">
            <pre v-if="canHighlightMemberSurface" data-redis-member-utf8-text class="inline-block min-w-0 p-5 align-top select-text" :class="[detailTextClass('utf8'), redisJsonWordWrap ? 'max-w-full' : 'min-w-max']" v-html="contentSearchHighlightedHtml" />
            <pre v-else data-redis-member-utf8-text class="inline-block min-w-0 p-5 align-top select-text" :class="[detailTextClass('utf8'), redisJsonWordWrap ? 'max-w-full' : 'min-w-max']">{{ detailTextForFormat(selectedMemberDetail, "utf8") }}</pre>
          </div>
          <pre v-else-if="canHighlightMemberSurface" class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-5 text-[13px] leading-6" :class="detailTextClass(memberValueView)" v-html="contentSearchHighlightedHtml" />
          <pre v-else class="dbx-editor-font-family min-h-0 w-full min-w-0 max-w-full flex-1 overflow-auto bg-background p-5 text-[13px] leading-6" :class="detailTextClass(memberValueView)">{{ detailTextForFormat(selectedMemberDetail, memberValueView) }}</pre>
        </template>
        <DialogFooter class="mx-0 mb-0 shrink-0 border-t px-5 py-3">
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
          <template v-else-if="isEditingHashJson">
            <Button variant="ghost" :disabled="savingMember || !memberValueChanged" @click="discardHashJsonEdit">
              {{ t("grid.discard") }}
            </Button>
            <Button :disabled="savingMember || !memberValueChanged" @click="saveMemberEdit">
              <Loader2 v-if="savingMember" class="h-4 w-4 animate-spin" />
              <Save v-else class="h-4 w-4" />
              {{ t("grid.save") }}
            </Button>
          </template>
          <Button v-else-if="canEditCurrentMemberFormat" variant="outline" @click="startEditMember">
            <Pencil class="h-4 w-4" />
            {{ t("redis.editMember") }}
          </Button>
          <Button variant="outline" @click="copyText(redisClipboardSafeText(memberCopyText))">
            <Copy class="h-4 w-4" />
            {{ t("redis.copyMember") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
:deep(.document-search-match),
:deep(.redis-value-search-match) {
  border-radius: 2px;
  background: #fde68a;
  color: inherit;
  padding: 0;
}

:deep(.document-search-match-active),
:deep(.redis-value-search-match-active) {
  background: #f59e0b;
  color: #111827;
  outline: 1px solid #d97706;
}

:global(.dark) :deep(.document-search-match),
:global(.dark) :deep(.redis-value-search-match) {
  background: #854d0e;
}

:global(.dark) :deep(.document-search-match-active),
:global(.dark) :deep(.redis-value-search-match-active) {
  background: #fbbf24;
  color: #111827;
}
</style>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { DynamicScroller, DynamicScrollerItem, RecycleScroller } from "vue-virtual-scroller";
import {
  Braces,
  Copy,
  Eye,
  FileText,
  Terminal,
  Trash2,
  Save,
  RefreshCw,
  Plus,
  Loader2,
  Pencil,
  WrapText,
} from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import RedisJsonTree from "./RedisJsonTree.vue";
import * as api from "@/lib/api";
import type { RedisKeyInfo, RedisValue } from "@/lib/api";
import { useToast } from "@/composables/useToast";
import { useTheme } from "@/composables/useTheme";
import { useEditorFontFamilyStyle } from "@/composables/useEditorFontFamilyStyle";
import { createRedisShikiJsonHighlighter, type RedisJsonHighlighter } from "@/lib/redisJsonHighlighter";
import { copyToClipboard } from "@/lib/clipboard";
import {
  canEditRedisMemberDetail,
  clampRedisMemberDetailSheetWidth,
  formatRedisMemberDetail,
  getRedisMemberSelectionKey,
} from "@/lib/redisValuePresentation";

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

const emit = defineEmits<{ deleted: [] }>();

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
const collectionItems = ref<any[]>([]);
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
type RedisValueView = "json" | "raw";
const REDIS_JSON_WRAP_STORAGE_KEY = "dbx-redis-json-word-wrap";
const stringValueView = ref<RedisValueView>("raw");
const memberValueView = ref<RedisValueView>("raw");
const redisJsonWordWrap = ref(readRedisJsonWordWrap());
const redisJsonHighlighter = ref<RedisJsonHighlighter>();
const selectedMemberDetail = computed(() => formatRedisMemberDetail(selectedMemberRaw.value));
const selectedMemberJsonDetail = computed(() => selectedMemberDetail.value.json ?? null);
const stringValueDetail = computed(() =>
  data.value?.key_type === "string" ? formatRedisMemberDetail(data.value.value) : null,
);
const stringJsonDetail = computed(() => stringValueDetail.value?.json ?? null);
const redisJsonAppearance = computed(() => (isDark.value ? "dark" : "light"));
const memberRawJsonHtml = computed(() =>
  selectedMemberJsonDetail.value ? highlightRedisJson(selectedMemberJsonDetail.value.rawText) : "",
);
const hashGridStyle = computed(() => ({
  gridTemplateColumns: `${hashFieldWidth.value}px minmax(12rem, 1fr) 84px`,
}));
const selectedMemberCanEdit = computed(
  () => selectedMemberContext.value != null && canEditRedisMemberDetail(selectedMemberContext.value.kind),
);
const REDIS_COLLECTION_ROW_HEIGHT = 32;
const REDIS_STREAM_MIN_ROW_HEIGHT = 96;

type PendingDelete =
  | { kind: "key" }
  | { kind: "hash"; field: string }
  | { kind: "list"; index: number }
  | { kind: "set"; member: string }
  | { kind: "zset"; member: string };

const pendingDelete = ref<PendingDelete | null>(null);

let memberSheetResizeStartX = 0;
let memberSheetResizeStartWidth = 0;
let hashResizeStartX = 0;
let hashResizeStartWidth = 0;

type RedisMemberContext =
  | { kind: "list"; index: number }
  | { kind: "set"; member: string }
  | { kind: "hash"; field: string }
  | { kind: "zset"; member: string; score: number }
  | { kind: "stream"; field: string };

type RedisCollectionRow = {
  id: string;
  index: number;
  value: any;
};

type RedisStreamRow = {
  id: string;
  index: number;
  entry: {
    id?: string | number;
    fields?: Record<string, unknown>;
  };
};

const collectionRows = computed<RedisCollectionRow[]>(() =>
  collectionItems.value.map((value, index) => ({
    id: `${index}`,
    index,
    value,
  })),
);

const streamRows = computed<RedisStreamRow[]>(() => {
  if (!data.value || data.value.key_type !== "stream" || !Array.isArray(data.value.value)) return [];
  return data.value.value.map((entry, index) => ({
    id: `${index}:${String(entry?.id ?? "")}`,
    index,
    entry,
  }));
});

function streamFields(entry: RedisStreamRow["entry"]): [string, unknown][] {
  return Object.entries(entry.fields ?? {});
}

function streamFieldCount(row: RedisStreamRow): number {
  return streamFields(row.entry).length;
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

function rawRedisValueText(value: unknown): string {
  if (typeof value === "string") return value;
  return String(value ?? "");
}

function highlightRedisJson(json: string): string {
  return redisJsonHighlighter.value?.(json, redisJsonAppearance.value) ?? escapeHtml(json);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const deleteDetails = computed(() => {
  const pending = pendingDelete.value;
  if (!pending) return "";
  if (pending.kind === "key") return t("dangerDialog.redisKeyDetails", { key: props.keyDisplay });
  if (pending.kind === "hash")
    return t("dangerDialog.redisHashFieldDetails", { key: props.keyDisplay, field: pending.field });
  if (pending.kind === "list")
    return t("dangerDialog.redisListItemDetails", { key: props.keyDisplay, index: pending.index });
  if (pending.kind === "zset")
    return t("dangerDialog.redisSetMemberDetails", { key: props.keyDisplay, member: pending.member });
  return t("dangerDialog.redisSetMemberDetails", { key: props.keyDisplay, member: pending.member });
});

const isBinaryStringValue = computed(() => data.value?.key_type === "string" && data.value?.value_is_binary);
const hasMore = computed(() => scanCursor.value != null && scanCursor.value > 0);
const metadataSizeLabel = computed(() => {
  const metadata = props.metadata;
  if (!metadata || metadata.size <= 0) return "";
  if (metadata.key_type === "string") {
    if (metadata.size >= 1024) return `${(metadata.size / 1024).toFixed(1)} KB`;
    return `${metadata.size} B`;
  }
  return String(metadata.size);
});

function collectionCountLabel(kind: "items" | "fields" | "members", loaded: number, total?: number | null) {
  if (total == null || total === loaded) return t(`redis.${kind}`, { count: loaded });
  return t(`redis.loaded${kind[0].toUpperCase()}${kind.slice(1)}`, { loaded, total });
}

async function load(options: { selectDefaultMember?: boolean } = {}) {
  const shouldSelectDefaultMember = options.selectDefaultMember ?? true;
  loading.value = true;
  try {
    data.value = await api.redisGetValue(props.connectionId, props.db, props.keyRaw);
    scanCursor.value = data.value.scan_cursor ?? undefined;
    if (data.value.key_type === "string") {
      const detail = formatRedisMemberDetail(data.value.value);
      editValue.value = detail.rawText;
      stringValueView.value = detail.format === "json" ? "json" : "raw";
      clearSelectedMember();
    } else if (["list", "set", "zset", "hash"].includes(data.value.key_type)) {
      collectionItems.value = Array.isArray(data.value.value) ? [...data.value.value] : [];
      if (shouldSelectDefaultMember) selectDefaultMember(data.value);
    } else if (data.value.key_type === "stream") {
      if (shouldSelectDefaultMember) selectDefaultMember(data.value);
    } else {
      clearSelectedMember();
    }
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!data.value || !hasMore.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const result = await api.redisLoadMore(
      props.connectionId,
      props.db,
      props.keyRaw,
      data.value.key_type,
      scanCursor.value!,
      200,
    );
    const newItems = Array.isArray(result.value) ? result.value : [];
    collectionItems.value = [...collectionItems.value, ...newItems];
    scanCursor.value = result.scan_cursor ?? undefined;
  } finally {
    loadingMore.value = false;
  }
}

async function saveString() {
  if (isBinaryStringValue.value) return;
  await api.redisSetString(props.connectionId, props.db, props.keyRaw, editValue.value);
  isEditing.value = false;
  await load();
}

function handleStringInput() {
  if (!isBinaryStringValue.value) {
    isEditing.value = true;
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
  const text = typeof data.value.value === "string" ? data.value.value : JSON.stringify(data.value.value, null, 2);
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

function generateInsertStatements(): string | null {
  if (!data.value) return null;
  if (data.value.value_is_binary) return null;

  const key = data.value.key_display;
  const type = data.value.key_type;
  const commands: string[] = [];

  const isCollection = ["list", "set", "zset", "hash"].includes(type);
  if (isCollection) {
    const total = data.value.total;
    const loaded = collectionItems.value.length;
    if (total != null && total > loaded) {
      commands.push(`-- Note: Only ${loaded} of ${total} items included`);
    }
  }

  switch (type) {
    case "string":
      commands.push(`SET ${escapeRedisArg(key)} ${escapeRedisArg(String(data.value.value))}`);
      break;
    case "list": {
      const items = collectionItems.value.map((v) => escapeRedisArg(String(v))).join(" ");
      commands.push(`RPUSH ${escapeRedisArg(key)} ${items}`);
      break;
    }
    case "set": {
      const members = collectionItems.value.map((v) => escapeRedisArg(String(v))).join(" ");
      commands.push(`SADD ${escapeRedisArg(key)} ${members}`);
      break;
    }
    case "zset": {
      const pairs = collectionItems.value.map((v) => `${v.score} ${escapeRedisArg(String(v.member))}`).join(" ");
      commands.push(`ZADD ${escapeRedisArg(key)} ${pairs}`);
      break;
    }
    case "hash": {
      const pairs = collectionItems.value
        .map((v) => `${escapeRedisArg(String(v.field))} ${escapeRedisArg(String(v.value))}`)
        .join(" ");
      commands.push(`HSET ${escapeRedisArg(key)} ${pairs}`);
      break;
    }
    case "stream": {
      const entries = Array.isArray(data.value.value) ? data.value.value : [];
      for (const entry of entries) {
        const fields = Object.entries((entry as any).fields ?? {})
          .map(([f, v]) => `${escapeRedisArg(f)} ${escapeRedisArg(String(v))}`)
          .join(" ");
        commands.push(`XADD ${escapeRedisArg(key)} * ${fields}`);
      }
      break;
    }
    default:
      if (type === "ReJSON-RL" || type === "JSON") {
        const json = JSON.stringify(data.value.value);
        commands.push(`JSON.SET ${escapeRedisArg(key)} $ '${json}'`);
      }
      break;
  }

  if (data.value.ttl > 0) {
    commands.push(`EXPIRE ${escapeRedisArg(key)} ${data.value.ttl}`);
  }

  return commands.join("\n");
}

async function copyInsertStatement() {
  if (!data.value) return;
  if (data.value.value_is_binary) {
    toast(t("redis.copyInsertStatementBinary"), 3000);
    return;
  }
  const stmt = generateInsertStatements();
  if (!stmt) return;
  try {
    await copyToClipboard(stmt);
    toast(t("redis.copyInsertStatement"), 2000);
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function copyMember(value: unknown) {
  void copyText(formatRedisMemberDetail(value).text);
}

function selectMember(title: string, value: unknown, context: RedisMemberContext) {
  const detail = formatRedisMemberDetail(value);
  selectedMemberTitle.value = title;
  selectedMemberRaw.value = value;
  selectedMemberKey.value = getRedisMemberSelectionKey(title, value);
  selectedMemberContext.value = context;
  isEditingMember.value = false;
  memberEditValue.value = detail.rawText;
  memberValueView.value = detail.format === "json" ? "json" : "raw";
}

function clearSelectedMember() {
  selectedMemberTitle.value = "";
  selectedMemberRaw.value = "";
  selectedMemberKey.value = "";
  selectedMemberContext.value = null;
  isEditingMember.value = false;
  memberEditValue.value = "";
}

function isSelectedMember(title: string, value: unknown) {
  return selectedMemberKey.value === getRedisMemberSelectionKey(title, value);
}

function viewMember(title: string, value: unknown, context: RedisMemberContext) {
  selectMember(title, value, context);
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
  memberDetailSheetWidth.value = clampRedisMemberDetailSheetWidth(
    memberSheetResizeStartWidth + delta,
    window.innerWidth,
  );
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

function startEditMember() {
  memberEditValue.value = selectedMemberDetail.value.text;
  isEditingMember.value = true;
}

function cancelEditMember() {
  memberEditValue.value = selectedMemberDetail.value.text;
  isEditingMember.value = false;
}

async function saveMemberEdit() {
  const context = selectedMemberContext.value;
  if (!context || !selectedMemberCanEdit.value) return;
  const title = selectedMemberTitle.value;
  let nextContext: RedisMemberContext = context;
  savingMember.value = true;
  try {
    if (context.kind === "list") {
      await api.redisListSet(props.connectionId, props.db, props.keyRaw, context.index, memberEditValue.value);
    } else if (context.kind === "hash") {
      await api.redisHashSet(props.connectionId, props.db, props.keyRaw, context.field, memberEditValue.value);
    } else if (context.kind === "set") {
      await api.redisSetRemove(props.connectionId, props.db, props.keyRaw, context.member);
      await api.redisSetAdd(props.connectionId, props.db, props.keyRaw, memberEditValue.value);
      nextContext = { kind: "set", member: memberEditValue.value };
    } else if (context.kind === "zset") {
      await api.redisZrem(props.connectionId, props.db, props.keyRaw, context.member);
      await api.redisZadd(props.connectionId, props.db, props.keyRaw, memberEditValue.value, context.score);
      nextContext = { kind: "zset", member: memberEditValue.value, score: context.score };
    }
    const editedValue = memberEditValue.value;
    isEditingMember.value = false;
    await load({ selectDefaultMember: false });
    selectMember(title, editedValue, nextContext);
  } finally {
    savingMember.value = false;
  }
}

function selectDefaultMember(redisValue: RedisValue) {
  if (redisValue.key_type === "list" || redisValue.key_type === "set") {
    if (collectionItems.value.length === 0) {
      clearSelectedMember();
      return;
    }
    selectMember(
      redisValue.key_type === "list" ? "#0" : t("redis.member"),
      collectionItems.value[0],
      redisValue.key_type === "list"
        ? { kind: "list", index: 0 }
        : { kind: "set", member: String(collectionItems.value[0]) },
    );
    return;
  }

  if (redisValue.key_type === "hash") {
    const first = collectionItems.value[0];
    if (!first) {
      clearSelectedMember();
      return;
    }
    selectMember(String(first.field), first.value, { kind: "hash", field: String(first.field) });
    return;
  }

  if (redisValue.key_type === "zset") {
    const first = collectionItems.value[0];
    if (!first) {
      clearSelectedMember();
      return;
    }
    selectMember(String(first.score), first.member, {
      kind: "zset",
      member: String(first.member),
      score: Number(first.score),
    });
    return;
  }

  if (redisValue.key_type === "stream" && Array.isArray(redisValue.value)) {
    const firstEntry = redisValue.value[0];
    const firstField = firstEntry?.fields ? Object.entries(firstEntry.fields)[0] : undefined;
    if (!firstField) {
      clearSelectedMember();
      return;
    }
    selectMember(String(firstField[0]), firstField[1], { kind: "stream", field: String(firstField[0]) });
    return;
  }

  clearSelectedMember();
}

// TTL
function startEditTtl() {
  if (!data.value) return;
  ttlInput.value = data.value.ttl > 0 ? String(data.value.ttl) : "";
  editingTtl.value = true;
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
function requestHashDel(field: string) {
  pendingDelete.value = { kind: "hash", field };
  showDeleteConfirm.value = true;
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
function requestSetRemove(member: string) {
  pendingDelete.value = { kind: "set", member };
  showDeleteConfirm.value = true;
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
function requestZsetRemove(member: string) {
  pendingDelete.value = { kind: "zset", member };
  showDeleteConfirm.value = true;
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

function formatValue(val: any): string {
  if (typeof val === "string") return formatRedisMemberDetail(val).text;
  return JSON.stringify(val, null, 2);
}

onMounted(() => {
  void load();
  void createRedisShikiJsonHighlighter({
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
  stopResizeMemberSheet();
  stopResizeHashColumns();
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
          <span class="dbx-editor-font-family min-w-0 flex-1 truncate text-sm font-semibold">{{
            data.key_display
          }}</span>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" @click="load"
            ><RefreshCw class="h-3.5 w-3.5"
          /></Button>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0" @click="copyValue"
            ><Copy class="h-3.5 w-3.5"
          /></Button>
          <Button
            variant="ghost"
            size="icon"
            class="h-7 w-7 shrink-0"
            :title="t('redis.copyInsertStatement')"
            @click="copyInsertStatement"
            ><Terminal class="h-3.5 w-3.5"
          /></Button>
          <Button variant="ghost" size="icon" class="h-7 w-7 shrink-0 text-destructive" @click="requestDeleteKey"
            ><Trash2 class="h-3.5 w-3.5"
          /></Button>
        </div>

        <div class="flex min-h-7 flex-wrap items-center gap-2 px-4 pb-1">
          <Badge variant="secondary" class="dbx-editor-font-family text-xs uppercase">{{ data.key_type }}</Badge>
          <Badge v-if="metadataSizeLabel" variant="outline" class="text-xs text-muted-foreground">
            {{ t("redis.columnSize") }}: {{ metadataSizeLabel }}
          </Badge>
          <template v-if="!editingTtl">
            <Badge
              v-if="data.ttl > 0"
              variant="outline"
              class="text-xs cursor-pointer text-muted-foreground hover:bg-accent"
              @click="startEditTtl"
              >TTL: {{ data.ttl }}s</Badge
            >
            <Badge
              v-else-if="data.ttl === -1"
              variant="outline"
              class="text-xs cursor-pointer text-muted-foreground hover:bg-accent"
              @click="startEditTtl"
              >{{ t("redis.noExpiry") }}</Badge
            >
          </template>
          <div v-else class="flex items-center gap-1">
            <Input
              v-model="ttlInput"
              class="h-6 w-20 text-xs"
              placeholder="seconds (-1=no expiry)"
              autofocus
              @keydown.enter="saveTtl"
              @keydown.escape="cancelEditTtl"
            />
            <Button variant="ghost" size="icon" class="h-6 w-6" @click="saveTtl"><Save class="h-3 w-3" /></Button>
          </div>
        </div>
      </div>

      <!-- String -->
      <div v-if="data.key_type === 'string'" class="flex-1 flex flex-col overflow-hidden">
        <div v-if="stringJsonDetail" class="flex h-9 items-center gap-2 border-b px-4 text-xs shrink-0">
          <div class="flex overflow-hidden rounded-md border bg-muted/20 p-0.5">
            <Button
              variant="ghost"
              size="sm"
              class="h-6 rounded-[5px] px-2 text-xs"
              :class="{ 'bg-background shadow-sm': stringValueView === 'json' }"
              @click="stringValueView = 'json'"
            >
              <Braces class="h-3.5 w-3.5" />
              {{ t("redis.jsonView") }}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-6 rounded-[5px] px-2 text-xs"
              :class="{ 'bg-background shadow-sm': stringValueView === 'raw' }"
              @click="stringValueView = 'raw'"
            >
              <FileText class="h-3.5 w-3.5" />
              {{ t("redis.rawContent") }}
            </Button>
          </div>
          <span class="flex-1" />
          <label class="flex items-center gap-1.5 text-muted-foreground">
            <WrapText class="h-3.5 w-3.5" />
            {{ t("redis.wordWrap") }}
            <Switch
              size="sm"
              :model-value="redisJsonWordWrap"
              @update:model-value="setRedisJsonWordWrap(Boolean($event))"
            />
          </label>
        </div>
        <div
          v-if="stringJsonDetail && stringValueView === 'json'"
          class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-4 text-sm leading-6"
        >
          <RedisJsonTree
            :value="stringJsonDetail.value"
            :word-wrap="redisJsonWordWrap"
            :highlight-json="highlightRedisJson"
          />
        </div>
        <textarea
          v-else
          v-model="editValue"
          class="dbx-editor-font-family flex-1 p-4 text-sm bg-background resize-none outline-none"
          :class="{ 'whitespace-pre': stringJsonDetail && !redisJsonWordWrap }"
          :readonly="isBinaryStringValue"
          @input="handleStringInput"
        />
        <div v-if="isBinaryStringValue" class="px-4 py-2 border-t text-xs text-muted-foreground shrink-0">
          {{ t("redis.binaryStringReadonlyHint") }}
        </div>
        <div v-if="isEditing" class="px-4 py-2 border-t flex justify-end gap-2 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            @click="
              isEditing = false;
              editValue = rawRedisValueText(data.value);
            "
            >{{ t("grid.discard") }}</Button
          >
          <Button size="sm" @click="saveString"><Save class="w-3 h-3 mr-1" /> {{ t("grid.save") }}</Button>
        </div>
      </div>

      <!-- List -->
      <div v-else-if="data.key_type === 'list'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{
            collectionCountLabel("items", collectionItems.length, data.total)
          }}</span>
          <span class="flex-1" />
          <Input v-model="newValue" class="h-6 w-40 text-xs" placeholder="value" @keydown.enter="listPush" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="listPush"
            ><Plus class="w-3 h-3 mr-1" />Push</Button
          >
        </div>
        <div class="grid grid-cols-[60px_1fr_84px] border-b bg-muted/50 shrink-0">
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground border-r">#</div>
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground">Value</div>
          <div />
        </div>
        <RecycleScroller
          class="flex-1 overflow-y-auto"
          :items="collectionRows"
          :item-size="REDIS_COLLECTION_ROW_HEIGHT"
          :buffer="600"
          :skip-hover="true"
          key-field="id"
        >
          <template #default="{ item: row }">
            <div
              data-redis-value-row
              class="dbx-editor-font-family grid grid-cols-[60px_1fr_84px] border-b text-sm hover:bg-accent/50 group cursor-pointer"
              :class="{ 'bg-accent/60': isSelectedMember(`#${row.index}`, row.value) }"
              :style="{ height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }"
              @click="viewMember(`#${row.index}`, row.value, { kind: 'list', index: row.index })"
            >
              <div class="px-3 py-1.5 text-xs text-muted-foreground border-r">{{ row.index }}</div>
              <div class="px-3 py-1.5 truncate">{{ row.value }}</div>
              <div class="flex items-center justify-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.viewMember')"
                  @click.stop="viewMember(`#${row.index}`, row.value, { kind: 'list', index: row.index })"
                  ><Eye class="w-3 h-3"
                /></Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.copyMember')"
                  @click.stop="copyMember(row.value)"
                  ><Copy class="w-3 h-3"
                /></Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive"
                  @click.stop="requestListRemove(row.index)"
                  ><Trash2 class="w-3 h-3"
                /></Button>
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
      <div v-else-if="data.key_type === 'set'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{
            collectionCountLabel("items", collectionItems.length, data.total)
          }}</span>
          <span class="flex-1" />
          <Input v-model="newValue" class="h-6 w-40 text-xs" placeholder="member" @keydown.enter="setAdd" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="setAdd"
            ><Plus class="w-3 h-3 mr-1" />Add</Button
          >
        </div>
        <div class="grid grid-cols-[1fr_84px] border-b bg-muted/50 shrink-0">
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground">Member</div>
          <div />
        </div>
        <RecycleScroller
          class="flex-1 overflow-y-auto"
          :items="collectionRows"
          :item-size="REDIS_COLLECTION_ROW_HEIGHT"
          :buffer="600"
          :skip-hover="true"
          key-field="id"
        >
          <template #default="{ item: row }">
            <div
              data-redis-value-row
              class="dbx-editor-font-family grid grid-cols-[1fr_84px] border-b text-sm hover:bg-accent/50 group cursor-pointer"
              :class="{ 'bg-accent/60': isSelectedMember(t('redis.member'), row.value) }"
              :style="{ height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }"
              @click="viewMember(t('redis.member'), row.value, { kind: 'set', member: String(row.value) })"
            >
              <div class="px-3 py-1.5 truncate">{{ row.value }}</div>
              <div class="flex items-center justify-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.viewMember')"
                  @click.stop="viewMember(t('redis.member'), row.value, { kind: 'set', member: String(row.value) })"
                  ><Eye class="w-3 h-3"
                /></Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.copyMember')"
                  @click.stop="copyMember(row.value)"
                  ><Copy class="w-3 h-3"
                /></Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive"
                  @click.stop="requestSetRemove(String(row.value))"
                  ><Trash2 class="w-3 h-3"
                /></Button>
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
      <div v-else-if="data.key_type === 'hash'" ref="hashTableRef" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{
            collectionCountLabel("fields", collectionItems.length, data.total)
          }}</span>
          <span class="flex-1" />
          <Input v-model="newField" class="h-6 w-24 text-xs" placeholder="field" />
          <Input v-model="newValue" class="h-6 w-32 text-xs" placeholder="value" @keydown.enter="hashSet" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="hashSet"
            ><Plus class="w-3 h-3 mr-1" />Set</Button
          >
        </div>
        <div class="grid border-b bg-muted/50 shrink-0" :style="hashGridStyle">
          <div class="relative px-3 py-1 text-xs font-medium text-muted-foreground border-r select-none">
            Field
            <div
              class="absolute -right-1 top-0 h-full w-2 cursor-col-resize touch-none"
              @pointerdown.prevent="startResizeHashColumns"
            />
          </div>
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground">Value</div>
          <div />
        </div>
        <RecycleScroller
          class="flex-1 overflow-y-auto"
          :items="collectionRows"
          :item-size="REDIS_COLLECTION_ROW_HEIGHT"
          :buffer="600"
          :skip-hover="true"
          key-field="id"
        >
          <template #default="{ item: row }">
            <div
              data-redis-value-row
              class="dbx-editor-font-family grid border-b text-sm hover:bg-accent/50 group cursor-pointer"
              :style="{ ...hashGridStyle, height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }"
              :class="{ 'bg-accent/60': isSelectedMember(String(row.value.field), row.value.value) }"
              @click="
                viewMember(String(row.value.field), row.value.value, { kind: 'hash', field: String(row.value.field) })
              "
            >
              <div class="px-3 py-1.5 text-blue-500 truncate border-r">{{ row.value.field }}</div>
              <div class="px-3 py-1.5 truncate text-muted-foreground">{{ row.value.value }}</div>
              <div class="flex items-center justify-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.viewMember')"
                  @click.stop="
                    viewMember(String(row.value.field), row.value.value, {
                      kind: 'hash',
                      field: String(row.value.field),
                    })
                  "
                  ><Eye class="w-3 h-3"
                /></Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.copyMember')"
                  @click.stop="copyMember(row.value.value)"
                  ><Copy class="w-3 h-3"
                /></Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive"
                  @click.stop="requestHashDel(String(row.value.field))"
                  ><Trash2 class="w-3 h-3"
                /></Button>
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

      <!-- Sorted Set -->
      <div v-else-if="data.key_type === 'zset'" class="flex-1 flex flex-col overflow-hidden">
        <div class="flex items-center gap-2 px-4 py-1.5 border-b shrink-0">
          <span class="text-xs text-muted-foreground">{{
            collectionCountLabel("members", collectionItems.length, data.total)
          }}</span>
          <span class="flex-1" />
          <Input v-model="newScore" class="h-6 w-20 text-xs" placeholder="score" />
          <Input v-model="newValue" class="h-6 w-32 text-xs" placeholder="member" @keydown.enter="zsetAdd" />
          <Button variant="ghost" size="sm" class="h-6 text-xs" @click="zsetAdd"
            ><Plus class="w-3 h-3 mr-1" />Add</Button
          >
        </div>
        <div class="grid grid-cols-[100px_1fr_84px] border-b bg-muted/50 shrink-0">
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground border-r">Score</div>
          <div class="px-3 py-1 text-xs font-medium text-muted-foreground">Member</div>
          <div />
        </div>
        <RecycleScroller
          class="flex-1 overflow-y-auto"
          :items="collectionRows"
          :item-size="REDIS_COLLECTION_ROW_HEIGHT"
          :buffer="600"
          :skip-hover="true"
          key-field="id"
        >
          <template #default="{ item: row }">
            <div
              data-redis-value-row
              class="dbx-editor-font-family grid grid-cols-[100px_1fr_84px] border-b text-sm hover:bg-accent/50 group cursor-pointer"
              :class="{ 'bg-accent/60': isSelectedMember(String(row.value.score), row.value.member) }"
              :style="{ height: `${REDIS_COLLECTION_ROW_HEIGHT}px` }"
              @click="
                viewMember(String(row.value.score), row.value.member, {
                  kind: 'zset',
                  member: String(row.value.member),
                  score: Number(row.value.score),
                })
              "
            >
              <div class="px-3 py-1.5 text-muted-foreground text-xs border-r">{{ row.value.score }}</div>
              <div class="px-3 py-1.5 truncate">{{ row.value.member }}</div>
              <div class="flex items-center justify-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.viewMember')"
                  @click.stop="
                    viewMember(String(row.value.score), row.value.member, {
                      kind: 'zset',
                      member: String(row.value.member),
                      score: Number(row.value.score),
                    })
                  "
                  ><Eye class="w-3 h-3"
                /></Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100"
                  :title="t('redis.copyMember')"
                  @click.stop="copyMember(row.value.member)"
                  ><Copy class="w-3 h-3"
                /></Button>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-5 w-5 opacity-0 group-hover:opacity-100 text-destructive"
                  @click.stop="requestZsetRemove(String(row.value.member))"
                  ><Trash2 class="w-3 h-3"
                /></Button>
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
      <div v-else-if="data.key_type === 'stream'" class="flex-1 flex flex-col overflow-hidden">
        <div class="px-4 py-1 text-xs text-muted-foreground border-b shrink-0">
          {{ t("redis.entries", { count: streamRows.length }) }}
        </div>
        <DynamicScroller
          class="flex-1 overflow-y-auto"
          :items="streamRows"
          :min-item-size="REDIS_STREAM_MIN_ROW_HEIGHT"
          :buffer="600"
          key-field="id"
        >
          <template #default="{ item: row, active }">
            <DynamicScrollerItem
              :item="row"
              :active="active"
              :size-dependencies="[streamFieldCount(row)]"
              :data-index="row.index"
            >
              <div data-redis-stream-entry class="dbx-editor-font-family px-4 py-2 border-b text-sm hover:bg-accent/50">
                <div class="mb-1 text-xs text-muted-foreground">{{ row.entry.id }}</div>
                <div
                  v-for="[field, val] in streamFields(row.entry)"
                  :key="field"
                  class="grid grid-cols-[minmax(6rem,0.35fr)_1fr_56px] gap-3 py-0.5 group cursor-pointer"
                  :class="{ 'bg-accent/60': isSelectedMember(String(field), val) }"
                  @click="viewMember(String(field), val, { kind: 'stream', field: String(field) })"
                >
                  <span class="truncate text-blue-500">{{ field }}</span>
                  <span class="truncate text-muted-foreground">{{ val }}</span>
                  <span class="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-5 w-5 opacity-0 group-hover:opacity-100"
                      :title="t('redis.viewMember')"
                      @click.stop="viewMember(String(field), val, { kind: 'stream', field: String(field) })"
                      ><Eye class="w-3 h-3"
                    /></Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      class="h-5 w-5 opacity-0 group-hover:opacity-100"
                      :title="t('redis.copyMember')"
                      @click.stop="copyMember(val)"
                      ><Copy class="w-3 h-3"
                    /></Button>
                  </span>
                </div>
              </div>
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>
      </div>

      <!-- Unknown -->
      <div v-else class="flex-1 overflow-auto p-4">
        <pre class="dbx-editor-font-family text-sm whitespace-pre-wrap">{{ formatValue(data.value) }}</pre>
      </div>
    </template>

    <DangerConfirmDialog
      v-model:open="showDeleteConfirm"
      :message="t('dangerDialog.deleteMessage')"
      :details="deleteDetails"
      :confirm-label="t('dangerDialog.deleteConfirm')"
      @confirm="confirmDelete"
    />

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
        <div
          class="absolute inset-y-0 left-0 z-10 w-2 -translate-x-1 cursor-col-resize border-l border-transparent hover:border-primary/60"
          @pointerdown.prevent="startResizeMemberSheet"
        />
        <SheetHeader class="border-b px-5 py-4 pr-12">
          <SheetTitle class="flex items-center gap-2">
            <span class="truncate">{{ selectedMemberTitle || t("redis.memberDetail") }}</span>
            <Badge variant="outline" class="shrink-0 text-xs">{{ selectedMemberDetail.format.toUpperCase() }}</Badge>
          </SheetTitle>
        </SheetHeader>
        <textarea
          v-if="isEditingMember"
          v-model="memberEditValue"
          class="dbx-editor-font-family min-h-0 flex-1 resize-none bg-background p-5 text-[13px] leading-6 outline-none"
          spellcheck="false"
        />
        <template v-else-if="selectedMemberJsonDetail">
          <div class="flex h-9 items-center gap-2 border-b px-5 text-xs">
            <div class="flex overflow-hidden rounded-md border bg-muted/20 p-0.5">
              <Button
                variant="ghost"
                size="sm"
                class="h-6 rounded-[5px] px-2 text-xs"
                :class="{ 'bg-background shadow-sm': memberValueView === 'json' }"
                @click="memberValueView = 'json'"
              >
                <Braces class="h-3.5 w-3.5" />
                {{ t("redis.jsonView") }}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="h-6 rounded-[5px] px-2 text-xs"
                :class="{ 'bg-background shadow-sm': memberValueView === 'raw' }"
                @click="memberValueView = 'raw'"
              >
                <FileText class="h-3.5 w-3.5" />
                {{ t("redis.rawContent") }}
              </Button>
            </div>
            <span class="flex-1" />
            <label class="flex items-center gap-1.5 text-muted-foreground">
              <WrapText class="h-3.5 w-3.5" />
              {{ t("redis.wordWrap") }}
              <Switch
                size="sm"
                :model-value="redisJsonWordWrap"
                @update:model-value="setRedisJsonWordWrap(Boolean($event))"
              />
            </label>
          </div>
          <div
            v-if="memberValueView === 'json'"
            class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-5 text-[13px] leading-6"
          >
            <RedisJsonTree
              :value="selectedMemberJsonDetail.value"
              :word-wrap="redisJsonWordWrap"
              :highlight-json="highlightRedisJson"
            />
          </div>
          <pre
            v-else
            class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-5 text-[13px] leading-6"
            :class="redisJsonWordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'"
            v-html="memberRawJsonHtml"
          ></pre>
        </template>
        <pre
          v-else
          class="dbx-editor-font-family min-h-0 flex-1 overflow-auto bg-background p-5 text-[13px] leading-6 whitespace-pre-wrap break-words"
          >{{ selectedMemberDetail.text }}</pre
        >
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
          <Button v-else-if="selectedMemberCanEdit" variant="outline" @click="startEditMember">
            <Pencil class="h-4 w-4" />
            {{ t("redis.editMember") }}
          </Button>
          <Button variant="outline" @click="copyText(selectedMemberDetail.text)">
            <Copy class="h-4 w-4" />
            {{ t("redis.copyMember") }}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  </div>
</template>

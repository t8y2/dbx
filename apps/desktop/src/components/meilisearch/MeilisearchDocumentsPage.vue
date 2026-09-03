<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Component } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowDown, ArrowUp, Braces, ChevronLeft, ChevronRight, Copy, Download, LayoutGrid, LoaderCircle, Pencil, Save, Search, Table2, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import ErrorBanner from "@/components/ui/ErrorBanner.vue";
import QueryLoadingState from "@/components/common/QueryLoadingState.vue";
import JsonTree from "@/components/common/JsonTree.vue";
import RedisJsonEditor from "@/components/redis/RedisJsonEditor.vue";
import * as api from "@/lib/backend/api";
import { compactLocalTimestamp, sanitizeExportBaseName, saveTextFile } from "@/lib/export/saveTextFile";
import { parseDocumentStoreJsonDocument, serializeDocumentStoreId, stringifyDocumentStoreValue } from "@/lib/app/documentJsonValues";
import { parseJsonPreservingLargeNumbers, safeJsonFormat } from "@/lib/common/safeJsonFormat";
import { useToast } from "@/composables/useToast";

const props = defineProps<{
  connectionId: string;
  index: string;
}>();

const emit = defineEmits<{
  "refresh-stats": [];
}>();

type ViewMode = "json" | "table" | "grid";
/**
 * Search hit from the backend: `id` is the primary-key value and `formatted` /
 * `rankingScore` are requested response metadata — all kept outside `document`,
 * which is always the pure user payload.
 */
type Hit = { id?: unknown; document: Record<string, any>; formatted?: Record<string, any>; rankingScore?: unknown };

const { t } = useI18n();
const { toast } = useToast();

const q = ref("");
const filter = ref("");
const sort = ref("");
const limit = ref(20);
const offset = ref(0);

const AUTO_REFRESH_INTERVAL_MS = 7_000;
const autoRefresh = ref(false);
let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

const hybridOpen = ref(false);
const hybridEnabled = ref(false);
const hybridEmbedder = ref("");
const hybridSemanticRatio = ref(0.5);
const embedders = ref<string[]>([]);

const showRankingScore = ref(false);
const rankingScoreThreshold = ref(0);

const hits = ref<Hit[]>([]);
const totalHits = ref(0);
const processingTimeMs = ref(0);
const loading = ref(false);
const error = ref("");
const viewMode = ref<ViewMode>("json");

const editOpen = ref(false);
const editingHit = ref<Hit | null>(null);
const editJson = ref("");
const editError = ref("");
const isSaving = ref(false);
/** True while the canonical document is being fetched for the editor. */
const editLoading = ref(false);

const deleteOpen = ref(false);
const deletingHit = ref<Hit | null>(null);
const isDeleting = ref(false);

const cellDetailOpen = ref(false);
const cellDetailColumn = ref("");
const cellDetailValue = ref<unknown>(null);

function openCellDetail(hit: Hit, column: string) {
  cellDetailColumn.value = column;
  cellDetailValue.value = cellValue(hit, column);
  cellDetailOpen.value = true;
}

/** Plain-text rendering of the cell value with highlight tags removed. */
const cellDetailText = computed(() => String(stripSearchMarks(cellDetailValue.value) ?? ""));

/** Smart-render a cell value: objects/arrays (or JSON strings) as a tree, plain text otherwise. */
const cellDetailJson = computed<unknown>(() => {
  const value = cellDetailValue.value;
  if (value !== null && typeof value === "object") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return parseJsonPreservingLargeNumbers(trimmed);
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
});

const views = computed<Array<{ value: ViewMode; label: string; icon: Component }>>(() => [
  { value: "json", label: t("meilisearch.viewJson"), icon: Braces },
  { value: "table", label: t("meilisearch.viewTable"), icon: Table2 },
  { value: "grid", label: t("meilisearch.viewGrid"), icon: LayoutGrid },
]);

const page = computed(() => Math.max(0, Math.floor(offset.value / Math.max(1, limit.value))));
const totalPages = computed(() => Math.max(1, Math.ceil(totalHits.value / Math.max(1, limit.value))));
const canGoNext = computed(() => offset.value + limit.value < totalHits.value);

const resultSummary = computed(() => t("meilisearch.resultSummary", { count: totalHits.value, time: processingTimeMs.value }));

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return stringifyDocumentStoreValue(value, "meilisearch");
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function renderMarkHtml(value: string): string {
  return escapeHtml(value)
    .replace(/&lt;mark&gt;/g, "<mark>")
    .replace(/&lt;\/mark&gt;/g, "</mark>");
}

/**
 * Display value for the JSON/grid cards: prefer the hoisted `formatted` payload
 * so search `<mark>` highlights stay visible. `document` is already the pure
 * user payload — no name-based stripping, so user fields named `_formatted` or
 * `_rankingScore` survive untouched.
 */
function displayValue(hit: Hit): Record<string, any> {
  const formatted = hit?.formatted;
  return formatted && typeof formatted === "object" ? { ...formatted } : { ...hit.document };
}

/** Deep-remove `<mark>` search highlight tags to reconstruct the stored document. */
function stripSearchMarks(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/<\/?mark>/g, "");
  if (Array.isArray(value)) return value.map(stripSearchMarks);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, stripSearchMarks(entry)]));
  }
  return value;
}

/** The user payload exactly as returned by the search — already free of dbx/Meilisearch metadata. */
function rawDocument(hit: Hit): Record<string, unknown> {
  return { ...hit.document };
}

function rankingScore(hit: Hit): number | null {
  const value = hit?.rankingScore;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const tableColumns = computed(() => {
  // Columns mirror the stored document fields in their natural order.
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits.value) {
    for (const key of Object.keys(displayValue(hit))) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
});

/** Grid cards show the stored document as flat field rows instead of a JSON tree. */
function gridFields(hit: Hit): Array<[string, unknown]> {
  return Object.entries(displayValue(hit));
}

function cellValue(hit: Hit, column: string): unknown {
  const formatted = hit?.formatted;
  if (formatted && typeof formatted === "object" && column in formatted) return formatted[column];
  return hit?.document?.[column];
}

function isMarkedCell(hit: Hit, column: string): boolean {
  const value = cellValue(hit, column);
  return typeof value === "string" && value.includes("<mark>");
}

function markCellHtml(hit: Hit, column: string): string {
  return renderMarkHtml(String(cellValue(hit, column)));
}

function cellText(hit: Hit, column: string): string {
  return formatCellValue(cellValue(hit, column));
}

function documentId(hit: Hit | null | undefined): string {
  const id = hit?.id;
  if (id == null) return "";
  // The store-id serializer prefixes string ids so the backend keeps their
  // type — a string primary key like "123" must not round-trip as numeric 123.
  return serializeDocumentStoreId(id, "meilisearch");
}

/** Search params shared by the results view and the export. */
function buildSearchParams(batchLimit: number, batchOffset: number) {
  return {
    q: q.value.trim() || null,
    filter: filter.value.trim() || null,
    sort: sort.value.trim() || null,
    limit: Math.max(1, batchLimit),
    offset: Math.max(0, batchOffset),
    hybridEmbedder: hybridEnabled.value && hybridEmbedder.value.trim() ? hybridEmbedder.value.trim() : null,
    hybridSemanticRatio: hybridEnabled.value ? hybridSemanticRatio.value : null,
    showRankingScore: showRankingScore.value,
    rankingScoreThreshold: rankingScoreThreshold.value > 0 ? rankingScoreThreshold.value : null,
  };
}

async function runSearch() {
  loading.value = true;
  error.value = "";
  try {
    const result = await api.meilisearchSearchDocuments(props.connectionId, props.index, buildSearchParams(limit.value, offset.value));
    hits.value = result.hits ?? [];
    totalHits.value = result.totalHits ?? 0;
    processingTimeMs.value = result.processingTimeMs ?? 0;
  } catch (e: any) {
    hits.value = [];
    totalHits.value = 0;
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function prevPage() {
  offset.value = Math.max(0, offset.value - limit.value);
  void runSearch();
}

function nextPage() {
  offset.value = offset.value + limit.value;
  void runSearch();
}

/**
 * Open the editor with the canonical stored document. Search hits may be
 * partial (`displayedAttributes`) and are never used as the write payload.
 */
async function startEdit(hit: Hit) {
  const id = documentId(hit);
  if (!id) return;
  editingHit.value = hit;
  editError.value = "";
  editJson.value = "";
  editOpen.value = true;
  editLoading.value = true;
  try {
    const canonicalJson = await api.meilisearchGetDocument(props.connectionId, props.index, id);
    editJson.value = safeJsonFormat(canonicalJson, 2);
  } catch (e: any) {
    editError.value = e?.message || String(e);
  } finally {
    editLoading.value = false;
  }
}

/** Download every hit matching the current search as a JSON file of the stored documents. */
const exporting = ref(false);

const EXPORT_BATCH_SIZE = 1000;

async function exportResults() {
  if (exporting.value || totalHits.value === 0) return;
  if (q.value.trim() || hybridEnabled.value || rankingScoreThreshold.value > 0) {
    toast(t("meilisearch.exportSearchUnsupported"), 5000);
    return;
  }
  exporting.value = true;
  try {
    const documents: Record<string, unknown>[] = [];
    let batchOffset = 0;
    while (true) {
      const page = await api.meilisearchFetchDocuments(props.connectionId, props.index, {
        filter: filter.value.trim() || null,
        sort: sort.value.trim() || null,
        limit: EXPORT_BATCH_SIZE,
        offset: batchOffset,
      });
      const batch = page.documents ?? [];
      documents.push(...batch);
      if (batch.length < EXPORT_BATCH_SIZE) break;
      batchOffset += batch.length;
    }
    const content = stringifyDocumentStoreValue(documents, "meilisearch", 2);
    const baseName = sanitizeExportBaseName(props.index) || "search-results";
    await saveTextFile(content, `${baseName}-${compactLocalTimestamp()}.json`, "JSON", "json");
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    exporting.value = false;
  }
}

async function copyDocument(hit: Hit) {
  try {
    await navigator.clipboard.writeText(stringifyDocumentStoreValue(rawDocument(hit), "meilisearch", 2));
    toast(t("meilisearch.copied"));
  } catch {
    // Clipboard may be unavailable (e.g. permission denied); stay silent.
  }
}

async function copyCellDetail() {
  const value = stripSearchMarks(cellDetailValue.value);
  const text = value !== null && typeof value === "object" ? stringifyDocumentStoreValue(value, "meilisearch", 2) : String(value ?? "");
  try {
    await navigator.clipboard.writeText(text);
    toast(t("meilisearch.copied"));
  } catch {
    // Clipboard may be unavailable (e.g. permission denied); stay silent.
  }
}

async function saveEdit() {
  const id = documentId(editingHit.value);
  if (!id) {
    editError.value = t("meilisearch.invalidJson");
    return;
  }
  const parsed = parseDocumentStoreJsonDocument(editJson.value, "meilisearch");
  if (!parsed.ok) {
    editError.value = t("meilisearch.invalidJson");
    return;
  }

  isSaving.value = true;
  editError.value = "";
  try {
    await api.documentUpdateDocument(props.connectionId, "default", props.index, id, editJson.value);
    toast(t("meilisearch.documentSaved"));
    editOpen.value = false;
    emit("refresh-stats");
    await runSearch();
  } catch (e: any) {
    editError.value = e?.message || String(e);
  } finally {
    isSaving.value = false;
  }
}

function startDelete(hit: Hit) {
  deletingHit.value = hit;
  deleteOpen.value = true;
}

async function confirmDelete() {
  const id = documentId(deletingHit.value);
  if (!id) return;
  isDeleting.value = true;
  try {
    await api.documentDeleteDocument(props.connectionId, "default", props.index, id);
    toast(t("meilisearch.documentDeleted"));
    deleteOpen.value = false;
    emit("refresh-stats");
    await runSearch();
    // Deleting the last row of a page leaves offset out of range; step back one page.
    if (!error.value && hits.value.length === 0 && offset.value > 0) {
      offset.value = Math.max(0, offset.value - limit.value);
      await runSearch();
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    isDeleting.value = false;
  }
}

function clearAutoRefreshTimer() {
  if (autoRefreshTimer !== null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

watch(autoRefresh, (enabled) => {
  clearAutoRefreshTimer();
  if (enabled) {
    autoRefreshTimer = setInterval(() => {
      if (!loading.value) void runSearch();
    }, AUTO_REFRESH_INTERVAL_MS);
  }
});

/** Sortable attributes advertised by the index settings, for the sort picker. */
const sortableAttributes = ref<string[]>([]);

async function loadIndexSettings() {
  try {
    const settings = await api.meilisearchGetIndexSettings(props.connectionId, props.index);
    const configured = settings?.embedders;
    embedders.value = configured && typeof configured === "object" && !Array.isArray(configured) ? Object.keys(configured) : [];
    if (!hybridEmbedder.value && embedders.value.length > 0) {
      hybridEmbedder.value = embedders.value[0];
    }
    const sortable = settings?.sortableAttributes;
    sortableAttributes.value = Array.isArray(sortable) ? sortable.filter((item): item is string => typeof item === "string") : [];
  } catch {
    // Settings discovery is best-effort; the sort/filter inputs stay free-form.
    sortableAttributes.value = [];
  }
}

/** Hover/focus-driven sort picker anchored under the sort input. */
const sortPickerOpen = ref(false);
let sortPickerCloseTimer: ReturnType<typeof setTimeout> | undefined;

function openSortPicker() {
  if (sortPickerCloseTimer !== undefined) {
    clearTimeout(sortPickerCloseTimer);
    sortPickerCloseTimer = undefined;
  }
  sortPickerOpen.value = true;
}

function scheduleSortPickerClose() {
  if (sortPickerCloseTimer !== undefined) clearTimeout(sortPickerCloseTimer);
  // Small delay so the pointer can travel from the input into the panel.
  sortPickerCloseTimer = setTimeout(() => {
    sortPickerOpen.value = false;
    sortPickerCloseTimer = undefined;
  }, 150);
}

type SortDirection = "asc" | "desc";

function parseSortEntries(): Array<{ field: string; direction: SortDirection }> {
  return sort.value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const separator = entry.lastIndexOf(":");
      const field = (separator >= 0 ? entry.slice(0, separator) : entry).trim();
      const direction: SortDirection =
        separator >= 0 &&
        entry
          .slice(separator + 1)
          .trim()
          .toLowerCase() === "desc"
          ? "desc"
          : "asc";
      return { field, direction };
    })
    .filter((entry) => entry.field.length > 0);
}

function sortDirectionFor(field: string): SortDirection | null {
  return parseSortEntries().find((entry) => entry.field === field)?.direction ?? null;
}

/** Toggle `field:direction` in the sort expression; clicking the active direction removes it. */
function toggleSortField(field: string, direction: SortDirection) {
  const entries = parseSortEntries();
  const index = entries.findIndex((entry) => entry.field === field);
  if (index >= 0 && entries[index].direction === direction) entries.splice(index, 1);
  else if (index >= 0) entries[index] = { field, direction };
  else entries.push({ field, direction });
  sort.value = entries.map((entry) => `${entry.field}:${entry.direction}`).join(", ");
}

onMounted(() => {
  void runSearch();
  void loadIndexSettings();
});

onBeforeUnmount(() => {
  clearAutoRefreshTimer();
  if (sortPickerCloseTimer !== undefined) clearTimeout(sortPickerCloseTimer);
});
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <!-- Search form -->
    <div class="p-3 border-b shrink-0">
      <div class="rounded-lg border bg-card p-3 space-y-3">
        <div class="relative">
          <Search class="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="q" class="pl-8" :placeholder="t('meilisearch.keywordPlaceholder')" autofocus @keydown.enter="runSearch" />
        </div>

        <div class="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <div class="space-y-1 min-w-0">
            <Label class="text-xs text-muted-foreground">{{ t("meilisearch.filter") }}</Label>
            <Input v-model="filter" :placeholder="t('meilisearch.filterPlaceholder')" @keydown.enter="runSearch" />
          </div>
          <div class="space-y-1 min-w-0">
            <Label class="text-xs text-muted-foreground">{{ t("meilisearch.sort") }}</Label>
            <Popover v-model:open="sortPickerOpen">
              <PopoverAnchor as-child>
                <Input v-model="sort" class="w-full" :placeholder="t('meilisearch.sortPlaceholder')" @keydown.enter="runSearch" @mouseenter="openSortPicker" @mouseleave="scheduleSortPickerClose" @focus="openSortPicker" />
              </PopoverAnchor>
              <PopoverContent side="bottom" align="start" class="w-(--reka-popover-anchor-width) p-0" @open-auto-focus.prevent @mouseenter="openSortPicker" @mouseleave="scheduleSortPickerClose">
                <p class="border-b px-3 py-2 text-xs text-muted-foreground">{{ t("meilisearch.sortHint") }}</p>
                <p v-if="sortableAttributes.length === 0" class="px-3 py-2 text-xs text-muted-foreground">{{ t("meilisearch.sortNoAttributes") }}</p>
                <div v-else class="max-h-56 overflow-y-auto p-1">
                  <div v-for="attr in sortableAttributes" :key="attr" class="flex items-center gap-1 rounded px-2 py-1 hover:bg-muted/50">
                    <span class="min-w-0 flex-1 truncate font-mono text-xs" :title="attr">{{ attr }}</span>
                    <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :title="t('meilisearch.sortAsc')" @click="toggleSortField(attr, 'asc')">
                      <ArrowUp class="h-3.5 w-3.5" :class="sortDirectionFor(attr) === 'asc' ? 'text-primary' : 'text-muted-foreground/50'" />
                    </Button>
                    <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :title="t('meilisearch.sortDesc')" @click="toggleSortField(attr, 'desc')">
                      <ArrowDown class="h-3.5 w-3.5" :class="sortDirectionFor(attr) === 'desc' ? 'text-primary' : 'text-muted-foreground/50'" />
                    </Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          </div>
          <div class="space-y-1 min-w-0">
            <Label class="text-xs text-muted-foreground">{{ t("meilisearch.limit") }}</Label>
            <Input v-model.number="limit" type="number" min="1" @keydown.enter="runSearch" />
          </div>
          <div class="space-y-1 min-w-0">
            <Label class="text-xs text-muted-foreground">{{ t("meilisearch.offset") }}</Label>
            <Input v-model.number="offset" type="number" min="0" @keydown.enter="runSearch" />
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-end gap-2">
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="whitespace-nowrap text-xs text-muted-foreground">{{ t("meilisearch.showRankingScore") }}</span>
            <Switch v-model="showRankingScore" />
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="whitespace-nowrap text-xs text-muted-foreground">{{ t("meilisearch.rankingScoreThreshold") }}</span>
            <Input v-model.number="rankingScoreThreshold" type="number" min="0" max="1" step="0.1" class="h-8 w-16" @keydown.enter="runSearch" />
          </div>
          <div class="flex shrink-0 items-center gap-1.5">
            <span class="whitespace-nowrap text-xs text-muted-foreground">{{ t("meilisearch.autoRefresh") }}</span>
            <Switch v-model="autoRefresh" />
          </div>

          <Popover v-model:open="hybridOpen">
            <PopoverTrigger as-child>
              <Button variant="outline" size="sm" class="h-8 shrink-0 gap-1.5">
                {{ t("meilisearch.hybrid") }}
                <Badge :variant="hybridEnabled ? 'default' : 'secondary'" class="h-4 px-1 text-[10px]">{{ hybridEnabled ? "ON" : "OFF" }}</Badge>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" class="w-64 space-y-3 p-3">
              <div class="flex items-center justify-between gap-2">
                <Label class="text-xs">{{ t("meilisearch.hybrid") }}</Label>
                <Switch v-model="hybridEnabled" />
              </div>
              <div class="space-y-1">
                <Label class="text-xs text-muted-foreground">{{ t("meilisearch.hybridEmbedder") }}</Label>
                <div v-if="embedders.length > 0" class="flex flex-wrap gap-1">
                  <button
                    v-for="embedder in embedders"
                    :key="embedder"
                    type="button"
                    class="rounded-md border px-2 py-0.5 font-mono text-xs transition-colors disabled:opacity-50"
                    :class="hybridEmbedder === embedder ? 'border-primary/40 bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/70 hover:text-foreground'"
                    :disabled="!hybridEnabled"
                    @click="hybridEmbedder = embedder"
                  >
                    {{ embedder }}
                  </button>
                </div>
                <template v-else>
                  <Input v-model="hybridEmbedder" :disabled="!hybridEnabled" placeholder="default" />
                  <p class="text-xs text-muted-foreground">{{ t("meilisearch.hybridNoEmbedders") }}</p>
                </template>
              </div>
              <div class="space-y-1">
                <div class="flex items-center justify-between gap-2">
                  <Label class="text-xs text-muted-foreground">{{ t("meilisearch.hybridSemanticRatio") }}</Label>
                  <span class="text-xs tabular-nums text-foreground/80">{{ hybridSemanticRatio.toFixed(2) }}</span>
                </div>
                <input v-model.number="hybridSemanticRatio" type="range" min="0" max="1" step="0.05" :disabled="!hybridEnabled" class="w-full accent-primary" />
              </div>
            </PopoverContent>
          </Popover>

          <Button size="sm" class="h-8 shrink-0 gap-1" :disabled="loading" @click="runSearch">
            <LoaderCircle v-if="loading" class="h-3.5 w-3.5 animate-spin" />
            <Search v-else class="h-3.5 w-3.5" />
            {{ t("meilisearch.search") }}
          </Button>
        </div>
      </div>
    </div>

    <!-- Result toolbar -->
    <div class="flex items-center gap-3 px-3 pt-3 shrink-0">
      <span class="text-sm font-semibold">{{ t("meilisearch.results") }}</span>
      <div class="grid w-auto grid-cols-3 rounded-md bg-muted/40 p-0.5">
        <button
          v-for="view in views"
          :key="view.value"
          type="button"
          class="inline-flex h-5 min-w-0 items-center gap-1 truncate whitespace-nowrap rounded-[5px] px-1.5 text-xs transition-colors"
          :class="viewMode === view.value ? 'bg-background font-semibold text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'"
          @click="viewMode = view.value"
        >
          <component :is="view.icon" class="h-3 w-3 shrink-0" />
          <span>{{ view.label }}</span>
        </button>
      </div>
      <div class="flex-1" />
      <Button v-if="totalHits > 0" variant="ghost" size="sm" class="h-6 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground" :disabled="exporting" @click="exportResults">
        <Download class="h-3.5 w-3.5" />
        {{ t("meilisearch.exportResults") }} ({{ totalHits }})
      </Button>
      <span v-if="!loading && !error" class="text-muted-foreground text-xs tabular-nums">{{ resultSummary }}</span>
    </div>

    <!-- Results -->
    <div class="meilisearch-results flex-1 min-h-0 overflow-y-auto px-3 pb-3 pt-2">
      <QueryLoadingState v-if="loading" class="h-full" />
      <ErrorBanner v-else-if="error" :message="error" />

      <div v-else-if="hits.length === 0" class="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
        {{ t("meilisearch.empty") }}
      </div>

      <!-- JSON view -->
      <div v-else-if="viewMode === 'json'" class="space-y-3">
        <div v-for="(hit, idx) in hits" :key="documentId(hit) || idx" class="group relative rounded-lg border bg-card p-3">
          <Badge v-if="rankingScore(hit) != null" variant="secondary" class="absolute right-2 bottom-2 tabular-nums" :title="t('meilisearch.showRankingScore')">
            {{ rankingScore(hit)!.toFixed(2) }}
          </Badge>
          <div class="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Button variant="ghost" size="icon" class="h-6 w-7" :title="t('meilisearch.copyDocument')" @click="copyDocument(hit)">
              <Copy class="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="h-6 w-7" :title="t('meilisearch.editDocument')" :disabled="!documentId(hit)" @click="startEdit(hit)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="h-6 w-7 text-destructive" :title="t('meilisearch.deleteDocument')" :disabled="!documentId(hit)" @click="startDelete(hit)">
              <Trash2 class="h-3.5 w-3.5" />
            </Button>
          </div>
          <JsonTree :value="displayValue(hit)" :highlight-json="renderMarkHtml" :initial-expanded-depth="2" class="font-mono text-xs" />
        </div>
      </div>

      <!-- Table view -->
      <div v-else-if="viewMode === 'table'" class="rounded-lg border bg-card overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full table-fixed text-xs">
            <thead>
              <tr class="border-b bg-muted/40 text-left text-muted-foreground">
                <th v-for="column in tableColumns" :key="column" class="px-3 py-2 font-medium">
                  <span class="block truncate" :title="column">{{ column }}</span>
                </th>
                <th class="w-24 px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              <tr v-for="(hit, idx) in hits" :key="documentId(hit) || idx" class="group/row border-b last:border-b-0 hover:bg-muted/30">
                <td v-for="column in tableColumns" :key="column" class="cursor-pointer px-3 py-2 font-mono" @click="openCellDetail(hit, column)">
                  <div class="truncate">
                    <span v-if="isMarkedCell(hit, column)" v-html="markCellHtml(hit, column)" />
                    <template v-else>{{ cellText(hit, column) }}</template>
                  </div>
                </td>
                <td class="px-2 py-1">
                  <div class="flex items-center justify-end gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100">
                    <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('meilisearch.copyDocument')" @click="copyDocument(hit)">
                      <Copy class="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" class="h-6 w-6" :title="t('meilisearch.editDocument')" :disabled="!documentId(hit)" @click="startEdit(hit)">
                      <Pencil class="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" class="h-6 w-6 text-destructive" :title="t('meilisearch.deleteDocument')" :disabled="!documentId(hit)" @click="startDelete(hit)">
                      <Trash2 class="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- Grid view -->
      <div v-else class="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <div v-for="(hit, idx) in hits" :key="documentId(hit) || idx" class="group relative rounded-lg border bg-card px-4 py-3.5">
          <Badge v-if="rankingScore(hit) != null" variant="secondary" class="absolute right-2 bottom-2 tabular-nums" :title="t('meilisearch.showRankingScore')">
            {{ rankingScore(hit)!.toFixed(2) }}
          </Badge>
          <div class="absolute right-2 top-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
            <Button variant="ghost" size="icon" class="h-6 w-7" :title="t('meilisearch.copyDocument')" @click="copyDocument(hit)">
              <Copy class="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="h-6 w-7" :title="t('meilisearch.editDocument')" :disabled="!documentId(hit)" @click="startEdit(hit)">
              <Pencil class="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" class="h-6 w-7 text-destructive" :title="t('meilisearch.deleteDocument')" :disabled="!documentId(hit)" @click="startDelete(hit)">
              <Trash2 class="h-3.5 w-3.5" />
            </Button>
          </div>
          <dl class="space-y-2">
            <div v-for="[key, value] in gridFields(hit)" :key="key" class="flex cursor-pointer items-baseline gap-3 rounded px-1.5 py-1 text-xs hover:bg-muted/40" @click="openCellDetail(hit, key)">
              <dt class="w-28 shrink-0 truncate text-right text-muted-foreground" :title="key">{{ key }}</dt>
              <dd class="min-w-0 flex-1 truncate font-mono" :title="formatCellValue(stripSearchMarks(value))">
                <span v-if="isMarkedCell(hit, key)" v-html="markCellHtml(hit, key)" />
                <template v-else>{{ formatCellValue(stripSearchMarks(value)) }}</template>
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </div>

    <!-- Pagination -->
    <div class="h-9 flex items-center justify-end gap-1 px-3 border-t shrink-0 text-xs text-muted-foreground">
      <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="offset <= 0" @click="prevPage">
        <ChevronLeft class="h-3 w-3" />
      </Button>
      <span class="tabular-nums">{{ page + 1 }} / {{ totalPages }}</span>
      <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!canGoNext" @click="nextPage">
        <ChevronRight class="h-3 w-3" />
      </Button>
    </div>

    <!-- Edit dialog -->
    <Dialog v-model:open="editOpen">
      <DialogContent class="sm:max-w-2xl h-[70vh] max-h-[70vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>{{ t("meilisearch.editDocument") }}</DialogTitle>
        </DialogHeader>
        <div class="flex-1 min-h-0 overflow-hidden rounded-md border bg-muted/20">
          <QueryLoadingState v-if="editLoading" class="h-full" />
          <RedisJsonEditor v-else v-model="editJson" class="h-full" :read-only="isSaving" />
        </div>
        <div v-if="editError" class="shrink-0 text-xs text-destructive">{{ editError }}</div>
        <DialogFooter class="shrink-0">
          <Button variant="outline" :disabled="isSaving" @click="editOpen = false">{{ t("common.cancel") }}</Button>
          <Button class="gap-1" :disabled="isSaving || editLoading || !editJson" @click="saveEdit">
            <Save class="h-3.5 w-3.5" />
            {{ t("common.save") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Cell detail dialog -->
    <Dialog v-model:open="cellDetailOpen">
      <DialogContent class="sm:max-w-2xl max-h-[70vh] flex flex-col">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2 font-mono text-sm">
            <span class="min-w-0 truncate">{{ cellDetailColumn }}</span>
            <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0" :title="t('common.copy')" @click="copyCellDetail">
              <Copy class="h-3.5 w-3.5" />
            </Button>
          </DialogTitle>
        </DialogHeader>
        <div class="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/20">
          <JsonTree v-if="cellDetailJson !== undefined" :value="cellDetailJson" :highlight-json="renderMarkHtml" class="p-3 font-mono text-xs" virtualized />
          <div v-else class="whitespace-pre-wrap break-words p-3 font-mono text-xs">{{ cellDetailText }}</div>
        </div>
      </DialogContent>
    </Dialog>

    <!-- Delete confirm -->
    <DangerConfirmDialog v-model:open="deleteOpen" :message="t('meilisearch.deleteDocumentMessage')" :confirm-label="t('meilisearch.deleteDocument')" :loading="isDeleting" @confirm="confirmDelete" />
  </div>
</template>

<style scoped>
.meilisearch-results :deep(mark) {
  background: color-mix(in srgb, var(--primary) 20%, transparent);
  color: var(--foreground);
  border-radius: var(--dbx-radius-sm);
  padding-inline: 0.125rem;
}
</style>

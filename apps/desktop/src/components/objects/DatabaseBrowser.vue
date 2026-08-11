<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ArrowDown, ArrowUp, Database, GripVertical, LayoutGrid, List, Loader2, RefreshCw, Search } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/backend/api";
import { filterDatabaseNamesForConnection } from "@/lib/database/visibleDatabases";
import { formatObjectBrowserBytes, formatObjectBrowserTimestamp } from "@/lib/table/objectBrowserRows";
import { useQueryStore } from "@/stores/queryStore";
import { useSettingsStore } from "@/stores/settingsStore";
import type { ConnectionConfig } from "@/types/database";

type DatabaseRow = {
  name: string;
  sizeBytes: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  comment: string | null;
  defaultCharset: string | null;
  defaultCollation: string | null;
};

type DatabaseBrowserColumnKey = "name" | "sizeBytes" | "createdAt" | "updatedAt" | "defaultCharset" | "defaultCollation" | "comment";
type DatabaseBrowserSortKey = DatabaseBrowserColumnKey;
type SortDirection = "asc" | "desc";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

const { t } = useI18n();
const queryStore = useQueryStore();
const settingsStore = useSettingsStore();
const searchInput = ref<HTMLInputElement>();
const search = ref("");
const rows = ref<DatabaseRow[]>([]);
const loading = ref(false);
const error = ref("");
const sortKey = ref<DatabaseBrowserSortKey>("name");
const sortDirection = ref<SortDirection>("asc");
const columnWidths = ref<Record<DatabaseBrowserColumnKey, number>>({
  name: 260,
  sizeBytes: 100,
  createdAt: 150,
  updatedAt: 150,
  defaultCharset: 130,
  defaultCollation: 170,
  comment: 260,
});
let stopColumnResize: (() => void) | null = null;

const hasSize = computed(() => rows.value.some((row) => row.sizeBytes != null));
const hasCreatedAt = computed(() => rows.value.some((row) => !!row.createdAt?.trim()));
const hasUpdatedAt = computed(() => rows.value.some((row) => !!row.updatedAt?.trim()));
const hasComment = computed(() => rows.value.some((row) => !!row.comment?.trim()));
const hasDefaultCharset = computed(() => rows.value.some((row) => !!row.defaultCharset?.trim()));
const hasDefaultCollation = computed(() => rows.value.some((row) => !!row.defaultCollation?.trim()));
const isListView = computed(() => settingsStore.editorSettings.objectBrowserViewMode !== "grid");

const columns = computed<DatabaseBrowserColumnKey[]>(() => {
  const next: DatabaseBrowserColumnKey[] = ["name"];
  if (hasSize.value) next.push("sizeBytes");
  if (hasCreatedAt.value) next.push("createdAt");
  if (hasUpdatedAt.value) next.push("updatedAt");
  if (hasDefaultCharset.value) next.push("defaultCharset");
  if (hasDefaultCollation.value) next.push("defaultCollation");
  if (hasComment.value) next.push("comment");
  return next;
});

const gridTemplateColumns = computed(() => columns.value.map((key, index) => (index === columns.value.length - 1 ? `minmax(${columnWidths.value[key]}px, 1fr)` : `${columnWidths.value[key]}px`)).join(" "));
const gridMinWidth = computed(() => columns.value.reduce((total, key) => total + columnWidths.value[key], 0) + Math.max(0, columns.value.length - 1) * 12 + 24);
const sortKeyOptions = computed(() => columns.value);

const visibleRows = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = rows.value.filter((row) => !query || row.name.toLocaleLowerCase().includes(query) || row.comment?.toLocaleLowerCase().includes(query));
  return [...filtered].sort((left, right) => compareRows(left, right, sortKey.value, sortDirection.value));
});

function openDatabase(database: string) {
  queryStore.openObjectBrowser(props.connection.id, database);
}

function columnLabel(key: DatabaseBrowserColumnKey): string {
  if (key === "name") return t("objects.name");
  if (key === "sizeBytes") return t("objects.size");
  if (key === "createdAt") return t("objects.createdAt");
  if (key === "updatedAt") return t("objects.updatedAt");
  if (key === "defaultCharset") return t("databaseBrowser.defaultCharset");
  if (key === "defaultCollation") return t("databaseBrowser.defaultCollation");
  return t("objects.comment");
}

function displayValue(row: DatabaseRow, key: DatabaseBrowserColumnKey): string {
  if (key === "name") return row.name;
  if (key === "sizeBytes") return row.sizeBytes == null ? "" : formatObjectBrowserBytes(row.sizeBytes);
  if (key === "createdAt") return formatObjectBrowserTimestamp(row.createdAt);
  if (key === "updatedAt") return formatObjectBrowserTimestamp(row.updatedAt);
  if (key === "defaultCharset") return row.defaultCharset || "";
  if (key === "defaultCollation") return row.defaultCollation || "";
  return row.comment || "";
}

function compareRows(left: DatabaseRow, right: DatabaseRow, key: DatabaseBrowserSortKey, direction: SortDirection): number {
  const leftValue = key === "sizeBytes" ? (left.sizeBytes ?? -1) : displayValue(left, key).toLocaleLowerCase();
  const rightValue = key === "sizeBytes" ? (right.sizeBytes ?? -1) : displayValue(right, key).toLocaleLowerCase();
  const compared = typeof leftValue === "number" && typeof rightValue === "number" ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue), undefined, { numeric: true, sensitivity: "base" });
  if (compared !== 0) return direction === "asc" ? compared : -compared;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

function sortIconFor(key: DatabaseBrowserSortKey) {
  if (sortKey.value !== key) return null;
  return sortDirection.value === "asc" ? ArrowUp : ArrowDown;
}

function initialSortDirection(key: DatabaseBrowserSortKey): SortDirection {
  return key === "sizeBytes" || key === "createdAt" || key === "updatedAt" ? "desc" : "asc";
}

function toggleSort(key: DatabaseBrowserSortKey) {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === "asc" ? "desc" : "asc";
    return;
  }
  sortKey.value = key;
  sortDirection.value = initialSortDirection(key);
}

function setViewMode(mode: "list" | "grid") {
  settingsStore.updateEditorSettings({ objectBrowserViewMode: mode });
}

function minimumColumnWidth(key: DatabaseBrowserColumnKey): number {
  return key === "name" || key === "comment" ? 120 : 72;
}

function onColumnResizeStart(key: DatabaseBrowserColumnKey, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  stopColumnResize?.();
  const startX = event.clientX;
  const startWidth = columnWidths.value[key];
  const minWidth = minimumColumnWidth(key);
  document.body.classList.add("select-none", "cursor-col-resize");
  const onMove = (moveEvent: MouseEvent) => {
    columnWidths.value = { ...columnWidths.value, [key]: Math.max(minWidth, startWidth + moveEvent.clientX - startX) };
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    document.body.classList.remove("select-none", "cursor-col-resize");
    stopColumnResize = null;
  };
  stopColumnResize = onUp;
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function resetColumnWidth(key: DatabaseBrowserColumnKey, width: number, event: MouseEvent) {
  event.preventDefault();
  event.stopPropagation();
  columnWidths.value = { ...columnWidths.value, [key]: width };
}

async function refresh(): Promise<boolean> {
  loading.value = true;
  error.value = "";
  try {
    let databases;
    try {
      databases = await api.listDatabaseMetadata(props.connection.id);
    } catch (metadataError) {
      try {
        databases = await api.listDatabases(props.connection.id);
      } catch {
        throw metadataError;
      }
    }
    const visibleNames = new Set(
      filterDatabaseNamesForConnection(
        databases.map((database) => database.name),
        props.connection,
      ),
    );
    rows.value = databases
      .filter((database) => database.name.trim() && visibleNames.has(database.name))
      .map((database) => ({
        name: database.name,
        sizeBytes: database.size_bytes ?? null,
        createdAt: database.created_at ?? null,
        updatedAt: database.updated_at ?? null,
        comment: database.comment ?? null,
        defaultCharset: database.default_charset ?? null,
        defaultCollation: database.default_collation ?? null,
      }));
  } catch (cause: any) {
    rows.value = [];
    error.value = cause?.message || String(cause);
  } finally {
    loading.value = false;
  }
  return true;
}

function focusSearch(): boolean {
  searchInput.value?.focus();
  return true;
}

watch(sortKeyOptions, (options) => {
  if (!options.includes(sortKey.value)) {
    sortKey.value = "name";
    sortDirection.value = "asc";
  }
});

watch(
  () => props.connection.id,
  () => {
    search.value = "";
    void refresh();
  },
  { immediate: true },
);

onBeforeUnmount(() => stopColumnResize?.());

defineExpose({ focusSearch, refresh });
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col bg-background">
    <div class="flex h-10 shrink-0 items-center gap-2 border-b px-3">
      <span class="inline-flex max-w-[14rem] min-w-0 items-center truncate rounded border border-border bg-muted/50 px-2 py-0.5 text-xs font-medium" :title="connection.name">
        {{ connection.name }}
      </span>
      <div class="relative min-w-0 flex-1">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input ref="searchInput" v-model="search" class="h-7 pl-8 text-xs" :placeholder="t('databaseBrowser.search')" />
      </div>
      <div class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
        <select
          class="h-6 cursor-pointer appearance-none rounded-sm bg-transparent px-1.5 text-xs text-muted-foreground outline-none hover:text-foreground focus:text-foreground"
          :value="sortKey"
          :aria-label="t('objects.sortBy')"
          @change="toggleSort(($event.target as HTMLSelectElement).value as DatabaseBrowserSortKey)"
        >
          <option v-for="key in sortKeyOptions" :key="key" :value="key" class="bg-background text-foreground">{{ columnLabel(key) }}</option>
        </select>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :title="sortDirection === 'asc' ? t('objects.sortAsc') : t('objects.sortDesc')" @click="sortDirection = sortDirection === 'asc' ? 'desc' : 'asc'">
          <ArrowUp v-if="sortDirection === 'asc'" class="h-3 w-3" />
          <ArrowDown v-else class="h-3 w-3" />
        </button>
      </div>
      <div class="flex h-7 shrink-0 items-center rounded border bg-muted/20 p-0.5">
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :class="{ 'bg-background text-foreground shadow-sm': isListView }" :title="t('objects.viewList')" @click="setViewMode('list')">
          <List class="h-3.5 w-3.5" />
        </button>
        <button type="button" class="flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:text-foreground" :class="{ 'bg-background text-foreground shadow-sm': !isListView }" :title="t('objects.viewGrid')" @click="setViewMode('grid')">
          <LayoutGrid class="h-3.5 w-3.5" />
        </button>
      </div>
      <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('contextMenu.refreshTab')" :disabled="loading" @click="refresh">
        <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
      </Button>
    </div>

    <div v-if="loading && rows.length === 0" class="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("objects.loading") }}</div>
    <div v-else-if="error" class="flex flex-1 items-center justify-center px-6 text-center text-sm text-destructive">{{ t("databaseBrowser.loadFailed", { message: error }) }}</div>
    <div v-else-if="visibleRows.length === 0" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">{{ t("databaseBrowser.empty") }}</div>
    <div v-else class="flex min-h-0 min-w-0 flex-1">
      <div v-if="isListView" class="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-auto overflow-y-hidden">
        <div class="grid h-7 shrink-0 items-center gap-3 border-b bg-muted/40 px-3 text-xs font-medium text-muted-foreground" :style="{ gridTemplateColumns, minWidth: `${gridMinWidth}px` }">
          <div v-for="key in columns" :key="key" class="relative flex min-w-0 items-center">
            <button class="flex min-w-0 items-center gap-1 truncate pr-4 text-left" type="button" @click="toggleSort(key)">
              <span class="truncate">{{ columnLabel(key) }}</span
              ><component :is="sortIconFor(key)" v-if="sortIconFor(key)" class="h-3 w-3 shrink-0" />
            </button>
            <div
              class="absolute -right-2 top-0 bottom-0 z-10 flex w-3 cursor-col-resize items-center justify-center text-muted-foreground/70 hover:bg-primary/30 hover:text-primary"
              @mousedown="onColumnResizeStart(key, $event)"
              @dblclick="resetColumnWidth(key, key === 'name' || key === 'comment' ? 260 : key === 'defaultCollation' ? 170 : key === 'defaultCharset' ? 130 : key === 'sizeBytes' ? 100 : 150, $event)"
            >
              <GripVertical class="h-3 w-3" />
            </div>
          </div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto">
          <div
            v-for="row in visibleRows"
            :key="row.name"
            tabindex="0"
            class="grid h-[34px] cursor-pointer items-center gap-3 border-b px-3 outline-none hover:bg-accent/50 focus-visible:bg-accent/50"
            :style="{ gridTemplateColumns, minWidth: `${gridMinWidth}px` }"
            @dblclick="openDatabase(row.name)"
            @keydown.enter.prevent="openDatabase(row.name)"
          >
            <div
              v-for="key in columns"
              :key="key"
              class="min-w-0 truncate text-xs text-muted-foreground"
              :class="{ 'flex items-center gap-2 text-[13px] font-medium text-foreground': key === 'name', 'tabular-nums': key === 'sizeBytes' || key === 'createdAt' || key === 'updatedAt' }"
              :title="displayValue(row, key)"
            >
              <Database v-if="key === 'name'" class="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
              {{ displayValue(row, key) || "-" }}
            </div>
          </div>
        </div>
      </div>
      <div v-else class="grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(160px,1fr))] content-start gap-3 overflow-auto p-3">
        <div
          v-for="row in visibleRows"
          :key="row.name"
          tabindex="0"
          class="flex min-h-28 cursor-pointer flex-col items-center gap-1 rounded-lg border bg-card p-3 text-center outline-none transition-all hover:border-primary/40 hover:shadow-sm focus-visible:border-primary"
          @dblclick="openDatabase(row.name)"
          @keydown.enter.prevent="openDatabase(row.name)"
        >
          <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 shadow-sm"><Database class="h-6 w-6 text-emerald-600 dark:text-emerald-400" /></div>
          <span class="w-full truncate text-sm font-medium text-foreground" :title="row.name">{{ row.name }}</span>
          <div class="flex min-h-[15px] items-center gap-1 text-[10px] leading-[15px] text-muted-foreground">
            <span v-if="row.sizeBytes != null">{{ formatObjectBrowserBytes(row.sizeBytes) }}</span
            ><span v-if="row.createdAt && row.sizeBytes != null">·</span><span v-if="row.createdAt">{{ formatObjectBrowserTimestamp(row.createdAt) }}</span>
          </div>
          <div v-if="hasComment" class="w-full truncate text-[10px] leading-[15px] text-muted-foreground/60" :title="row.comment || ''">{{ row.comment || "\u00A0" }}</div>
        </div>
      </div>
    </div>
  </section>
</template>

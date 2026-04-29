<script setup lang="ts">
import { ref, computed, nextTick, watch } from "vue";
import { useElementSize } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { ArrowUp, ArrowDown, Download, Plus, Trash2, Save, ChevronLeft, ChevronRight, Search, Inbox, SearchX } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { QueryResult, ColumnInfo } from "@/types/database";
import { save as savePath } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

const { t } = useI18n();

const props = defineProps<{
  result: QueryResult;
  sql?: string;
  editable?: boolean;
  tableMeta?: {
    schema?: string;
    tableName: string;
    columns: ColumnInfo[];
    primaryKeys: string[];
  };
  onExecuteSql?: (sql: string) => Promise<void>;
}>();

const emit = defineEmits<{
  reload: [];
  paginate: [offset: number, limit: number];
  sort: [column: string, direction: "asc" | "desc" | null];
}>();

const hasData = computed(() => props.result.columns.length > 0);

const columnTypeMap = computed(() => {
  const map = new Map<string, string>();
  if (props.tableMeta?.columns) {
    for (const col of props.tableMeta.columns) {
      map.set(col.name, shortTypeName(col.data_type));
    }
  }
  return map;
});

function shortTypeName(t: string): string {
  const s = t.toLowerCase();
  if (s === "character varying") return "varchar";
  if (s === "character") return "char";
  if (s === "double precision") return "double";
  if (s === "timestamp without time zone") return "timestamp";
  if (s === "timestamp with time zone") return "timestamptz";
  if (s === "time without time zone") return "time";
  if (s === "time with time zone") return "timetz";
  if (s === "boolean") return "bool";
  if (s === "integer") return "int";
  if (s === "smallint") return "int2";
  if (s === "bigint") return "int8";
  if (s === "real") return "float4";
  return t;
}
const contextCell = ref<{ row: number; col: number } | null>(null);
const sortCol = ref<string | null>(null);
const sortDir = ref<"asc" | "desc">("asc");
const searchText = ref("");
const columnWidths = ref<number[]>([]);
const gridRef = ref<HTMLDivElement>();
const headerRef = ref<HTMLDivElement>();
const { width: gridWidth } = useElementSize(gridRef);

function initColumnWidths() {
  if (columnWidths.value.length !== props.result.columns.length) {
    columnWidths.value = props.result.columns.map(() => 150);
  }
}

function syncHeaderScroll(e: Event) {
  if (headerRef.value) {
    headerRef.value.scrollLeft = (e.target as HTMLElement).scrollLeft;
  }
}

let isResizing = false;

function onResizeStart(colIdx: number, event: MouseEvent) {
  event.preventDefault();
  isResizing = true;
  const startX = event.clientX;
  const startWidth = columnWidths.value[colIdx];
  const onMove = (e: MouseEvent) => {
    columnWidths.value[colIdx] = Math.max(60, startWidth + e.clientX - startX);
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    requestAnimationFrame(() => { isResizing = false; });
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

const baseTotalWidth = computed(() => columnWidths.value.reduce((a, b) => a + b, 0));
const renderedColumnWidths = computed(() => {
  const widths = columnWidths.value;
  if (widths.length === 0) return widths;

  const extraWidth = Math.max(0, gridWidth.value - baseTotalWidth.value);
  if (extraWidth === 0) return widths;

  const extraPerColumn = extraWidth / widths.length;
  return widths.map((width) => width + extraPerColumn);
});
const totalWidth = computed(() => renderedColumnWidths.value.reduce((a, b) => a + b, 0));

const columnVars = computed(() => {
  const vars: Record<string, string> = {};
  renderedColumnWidths.value.forEach((w, i) => {
    vars[`--col-w-${i}`] = `${w}px`;
  });
  vars['--total-w'] = `${totalWidth.value}px`;
  return vars;
});

initColumnWidths();
watch(() => props.result.columns.length, initColumnWidths);

// --- Pagination ---
const pageSize = ref(100);
const currentPage = ref(1);
const isFullPage = computed(() => props.result.rows.length >= pageSize.value);

function prevPage() {
  if (currentPage.value <= 1) return;
  currentPage.value--;
  emit("paginate", (currentPage.value - 1) * pageSize.value, pageSize.value);
}
function nextPage() {
  if (!isFullPage.value) return;
  currentPage.value++;
  emit("paginate", (currentPage.value - 1) * pageSize.value, pageSize.value);
}
function changePageSize(size: number) {
  pageSize.value = size;
  currentPage.value = 1;
  emit("paginate", 0, size);
}

// --- Editing ---
type CellValue = string | number | boolean | null;
const editingCell = ref<{ row: number; col: number } | null>(null);
const editValue = ref("");
const scrollerRef = ref<HTMLElement | { $el?: HTMLElement; el?: HTMLElement | { value?: HTMLElement } } | null>(null);
const dirtyRows = ref<Map<number, Map<number, CellValue>>>(new Map());
const newRows = ref<CellValue[][]>([]);
const deletedRows = ref<Set<number>>(new Set());

const hasPendingChanges = computed(() =>
  dirtyRows.value.size > 0 || newRows.value.length > 0 || deletedRows.value.size > 0
);

const sortedRows = computed(() => {
  let rows = props.result.rows;
  if (searchText.value) {
    const q = searchText.value.toLowerCase();
    rows = rows.filter((row) => row.some((cell) => cell !== null && String(cell).toLowerCase().includes(q)));
  }
  return rows;
});

interface RowItem {
  id: number;
  data: CellValue[];
  isNew: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
}

const displayItems = computed<RowItem[]>(() => {
  const cols = props.result.columns;
  const items: RowItem[] = sortedRows.value.map((row, i) => {
    const dirty = dirtyRows.value.get(i);
    const data = row.map((v, colIdx) => dirty?.get(colIdx) ?? v);
    const isDirtyCol = row.map((_, colIdx) => dirty?.has(colIdx) ?? false);
    return { id: i, data, isNew: false, isDeleted: deletedRows.value.has(i), isDirtyCol };
  });
  newRows.value.forEach((row, i) => {
    items.push({ id: 100000 + i, data: row, isNew: true, isDeleted: false, isDirtyCol: cols.map(() => false) });
  });
  return items;
});
const hasVisibleRows = computed(() => displayItems.value.length > 0);
const emptyTitle = computed(() => searchText.value ? t('grid.noSearchResults') : t('grid.noRows'));
const emptyDescription = computed(() => searchText.value ? t('grid.noSearchResultsDescription') : t('grid.noRowsDescription'));

function toggleSort(colName: string) {
  if (isResizing) return;
  if (sortCol.value === colName) {
    if (sortDir.value === "asc") { sortDir.value = "desc"; emit("sort", colName, "desc"); }
    else { sortCol.value = null; sortDir.value = "asc"; emit("sort", colName, null); }
  } else {
    sortCol.value = colName;
    sortDir.value = "asc";
    emit("sort", colName, "asc");
  }
}

function formatCell(value: CellValue): string {
  if (value === null) return "NULL";
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function isNull(value: unknown): boolean { return value === null; }

// --- Inline editor ---
let isCancelling = false;
let cancelScrollRestoreFrame = 0;

function getScrollerElement(): HTMLElement | null {
  const scroller = scrollerRef.value;
  if (!scroller) return null;
  if (scroller instanceof HTMLElement) return scroller;
  if (scroller.$el instanceof HTMLElement) return scroller.$el;
  if (scroller.el instanceof HTMLElement) return scroller.el;
  if (scroller.el?.value instanceof HTMLElement) return scroller.el.value;
  return null;
}

function preserveScrollPosition() {
  const el = getScrollerElement();
  if (!el) return () => {};
  const top = el.scrollTop;
  const left = el.scrollLeft;
  return () => {
    el.scrollTop = top;
    el.scrollLeft = left;
  };
}

function focusScrollerWithoutScrolling() {
  const el = getScrollerElement();
  if (!el) return;
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

function restoreScrollAcrossFrames(restoreScroll: () => void) {
  if (cancelScrollRestoreFrame) cancelAnimationFrame(cancelScrollRestoreFrame);
  restoreScroll();
  nextTick(() => {
    restoreScroll();
    cancelScrollRestoreFrame = requestAnimationFrame(() => {
      restoreScroll();
      cancelScrollRestoreFrame = requestAnimationFrame(() => {
        restoreScroll();
        cancelScrollRestoreFrame = 0;
        isCancelling = false;
      });
    });
  });
}

function startEdit(rowIdx: number, colIdx: number) {
  if (!props.editable) return;
  isCancelling = false;
  editingCell.value = { row: rowIdx, col: colIdx };
  const item = displayItems.value.find((it) => it.id === rowIdx);
  const val = item?.data[colIdx] ?? null;
  editValue.value = val === null ? "" : String(val);
  nextTick(() => {
    const input = document.querySelector(".cell-edit-input") as HTMLInputElement;
    input?.focus();
    input?.select();
  });
}

function commitEdit() {
  if (isCancelling) return;
  if (!editingCell.value) return;
  const { row, col } = editingCell.value;
  const oldVal = sortedRows.value[row]?.[col];
  let newVal: CellValue = editValue.value;
  if (newVal === "" && isNull(oldVal)) newVal = null;
  else if (newVal === "NULL") newVal = null;
  else if (typeof oldVal === "number") {
    const num = Number(newVal);
    if (!isNaN(num)) newVal = num;
  } else if (typeof oldVal === "boolean") {
    newVal = newVal === "true" || newVal === "1";
  }
  if (newVal !== oldVal) {
    if (!dirtyRows.value.has(row)) dirtyRows.value.set(row, new Map());
    dirtyRows.value.get(row)!.set(col, newVal);
  }
  editingCell.value = null;
}

function cancelEdit() {
  const restoreScroll = preserveScrollPosition();
  isCancelling = true;
  focusScrollerWithoutScrolling();
  editingCell.value = null;
  restoreScrollAcrossFrames(restoreScroll);
}

function onEditKeydown(e: KeyboardEvent) {
  if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
}

function addRow() {
  newRows.value.push(props.result.columns.map(() => null));
}

function deleteSelectedRow() {
  if (!contextCell.value) return;
  deletedRows.value.add(contextCell.value.row);
}

function escapeVal(v: CellValue): string {
  if (v === null) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  return `'${String(v).replace(/'/g, "''")}'`;
}

function qualifiedTableName(): string {
  if (!props.tableMeta) return "";
  const { schema, tableName } = props.tableMeta;
  return schema ? `"${schema}"."${tableName}"` : `"${tableName}"`;
}

function generateSaveStatements(): string[] {
  if (!props.tableMeta) return [];
  const { primaryKeys } = props.tableMeta;
  const cols = props.result.columns;
  const stmts: string[] = [];
  const tbl = qualifiedTableName();

  for (const [rowIdx, changes] of dirtyRows.value) {
    const row = sortedRows.value[rowIdx];
    if (!row) continue;
    const sets = Array.from(changes.entries())
      .map(([colIdx, val]) => `"${cols[colIdx]}" = ${escapeVal(val)}`)
      .join(", ");
    const where = primaryKeys
      .map((pk) => `"${pk}" = ${escapeVal(row[cols.indexOf(pk)])}`)
      .join(" AND ");
    stmts.push(`UPDATE ${tbl} SET ${sets} WHERE ${where};`);
  }

  for (const rowIdx of deletedRows.value) {
    const row = sortedRows.value[rowIdx];
    if (!row) continue;
    const where = primaryKeys
      .map((pk) => `"${pk}" = ${escapeVal(row[cols.indexOf(pk)])}`)
      .join(" AND ");
    stmts.push(`DELETE FROM ${tbl} WHERE ${where};`);
  }

  for (const newRow of newRows.value) {
    const colNames = cols.map((c) => `"${c}"`).join(", ");
    const vals = newRow.map((v) => escapeVal(v)).join(", ");
    stmts.push(`INSERT INTO ${tbl} (${colNames}) VALUES (${vals});`);
  }
  return stmts;
}

const saveError = ref("");

async function saveChanges() {
  const stmts = generateSaveStatements();
  if (stmts.length === 0) return;
  saveError.value = "";
  if (props.onExecuteSql) {
    try {
      for (const sql of stmts) {
        await props.onExecuteSql(sql);
      }
    } catch (e: any) {
      saveError.value = String(e.message || e);
      return;
    }
  }
  dirtyRows.value.clear();
  newRows.value = [];
  deletedRows.value.clear();
  emit("reload");
}

function discardChanges() {
  dirtyRows.value.clear();
  newRows.value = [];
  deletedRows.value.clear();
  editingCell.value = null;
}

// --- Copy/Export ---
function onCellContext(rowIdx: number, colIdx: number) {
  contextCell.value = { row: rowIdx, col: colIdx };
}

function copyCell() {
  if (!contextCell.value) return;
  const item = displayItems.value.find((it) => it.id === contextCell.value!.row);
  const val = item?.data[contextCell.value.col] ?? null;
  navigator.clipboard.writeText(formatCell(val));
}

function copyRow() {
  if (!contextCell.value) return;
  const row = sortedRows.value[contextCell.value.row];
  if (!row) return;
  const obj: Record<string, unknown> = {};
  props.result.columns.forEach((col, i) => { obj[col] = row[i]; });
  navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
}

function copyAll() {
  const header = props.result.columns.join("\t");
  const body = sortedRows.value.map((row) => row.map((c) => formatCell(c)).join("\t")).join("\n");
  navigator.clipboard.writeText(`${header}\n${body}`);
}

async function exportCsv() {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = props.result.columns.map(escape).join(",");
  const body = sortedRows.value.map((row) => row.map((c) => escape(formatCell(c))).join(",")).join("\n");
  const path = await savePath({ filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (path) await writeTextFile(path, `${header}\n${body}`);
}

async function exportJson() {
  const data = sortedRows.value.map((row) => {
    const obj: Record<string, unknown> = {};
    props.result.columns.forEach((col, i) => { obj[col] = row[i]; });
    return obj;
  });
  const path = await savePath({ filters: [{ name: "JSON", extensions: ["json"] }] });
  if (path) await writeTextFile(path, JSON.stringify(data, null, 2));
}

async function exportMarkdown() {
  const pad = (s: string, len: number) => s.padEnd(len);
  const cols = props.result.columns;
  const widths = cols.map((c, i) => Math.max(c.length, ...sortedRows.value.map((r) => formatCell(r[i]).length), 3));
  const header = `| ${cols.map((c, i) => pad(c, widths[i])).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const body = sortedRows.value.map((row) =>
    `| ${row.map((c, i) => pad(formatCell(c), widths[i])).join(" | ")} |`
  ).join("\n");
  const md = `${header}\n${sep}\n${body}\n`;
  const path = await savePath({ filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (path) await writeTextFile(path, md);
}

const sqlOneLiner = computed(() => props.sql?.replace(/\s+/g, " ").trim() || "");
</script>

<template>
  <div ref="gridRef" class="h-full flex flex-col overflow-hidden" :style="columnVars">
    <ContextMenu>
      <ContextMenuTrigger as-child>
        <div v-if="hasData" class="flex-1 flex flex-col overflow-hidden">
          <!-- Search bar -->
          <div class="flex items-center gap-1 px-2 py-1 border-b shrink-0 bg-muted/20">
            <Search class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            <input
              v-model="searchText"
              class="flex-1 h-5 text-xs bg-transparent outline-none placeholder:text-muted-foreground"
              :placeholder="t('grid.search')"
            />
            <span v-if="searchText" class="text-xs text-muted-foreground">
              {{ sortedRows.length }}/{{ result.rows.length }}
            </span>
          </div>
          <!-- Sticky header -->
          <div ref="headerRef" class="shrink-0 bg-muted z-10 border-b border-border overflow-hidden">
            <div class="flex text-xs font-medium" :style="{ width: 'var(--total-w)' }">
              <div
                v-for="(col, colIdx) in result.columns"
                :key="col"
                class="shrink-0 px-3 py-1.5 border-r border-border whitespace-nowrap cursor-pointer hover:bg-accent/50 select-none relative"
                :style="{ width: `var(--col-w-${colIdx})` }"
                @click="toggleSort(col)"
              >
                <span class="inline-flex items-center gap-1">
                  {{ col }}
                  <ArrowUp v-if="sortCol === col && sortDir === 'asc'" class="w-3 h-3" />
                  <ArrowDown v-else-if="sortCol === col && sortDir === 'desc'" class="w-3 h-3" />
                  <span v-if="columnTypeMap.get(col)" class="text-[10px] text-muted-foreground font-normal ml-auto">#{{ columnTypeMap.get(col) }}</span>
                </span>
                <div
                  class="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary/30"
                  @mousedown.stop="onResizeStart(colIdx, $event)"
                />
              </div>
            </div>
          </div>

          <div
            v-if="!hasVisibleRows"
            class="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground"
          >
            <component
              :is="searchText ? SearchX : Inbox"
              class="h-8 w-8 text-muted-foreground/50"
              aria-hidden="true"
            />
            <div class="space-y-1">
              <div class="text-sm font-medium text-foreground">{{ emptyTitle }}</div>
              <div class="text-xs">{{ emptyDescription }}</div>
            </div>
          </div>

          <!-- Virtual scrolled rows -->
          <RecycleScroller
            v-else
            ref="scrollerRef"
            class="data-grid-scroller flex-1 overflow-x-auto"
            :items="displayItems"
            :item-size="26"
            key-field="id"
            @scroll="syncHeaderScroll"
          >
            <template #default="{ item }">
              <div
                class="flex text-xs border-b border-border hover:bg-accent/50"
                :class="{
                  'line-through opacity-30': item.isDeleted,
                  'bg-green-500/10': item.isNew,
                }"
                :style="{ height: '26px', width: 'var(--total-w)' }"
              >
                <div
                  v-for="(cell, colIdx) in item.data"
                  :key="colIdx"
                  class="shrink-0 px-3 py-1 border-r border-border whitespace-nowrap overflow-hidden text-ellipsis relative"
                  :style="{ width: `var(--col-w-${colIdx})` }"
                  :class="{
                    'text-muted-foreground italic': isNull(cell),
                    'bg-yellow-500/10': item.isDirtyCol[colIdx],
                  }"
                  @dblclick="!item.isNew && !item.isDeleted && startEdit(item.id, colIdx)"
                  @contextmenu="onCellContext(item.id, colIdx)"
                >
                  <template v-if="editingCell?.row === item.id && editingCell?.col === colIdx">
                    <input
                      v-model="editValue"
                      class="cell-edit-input absolute inset-0 bg-background border-2 border-primary px-2 py-0.5 text-xs outline-none z-10"
                      @blur="commitEdit"
                      @keydown.stop="onEditKeydown"
                    />
                  </template>
                  <template v-else>
                    {{ formatCell(cell) }}
                  </template>
                </div>
              </div>
            </template>
          </RecycleScroller>
        </div>
      </ContextMenuTrigger>

      <ContextMenuContent class="w-48">
        <ContextMenuItem @click="copyCell">{{ t('grid.copyCell') }}</ContextMenuItem>
        <ContextMenuItem @click="copyRow">{{ t('grid.copyRow') }}</ContextMenuItem>
        <ContextMenuItem @click="copyAll">{{ t('grid.copyAll') }}</ContextMenuItem>
        <ContextMenuSeparator />
        <template v-if="editable">
          <ContextMenuItem class="text-destructive" @click="deleteSelectedRow">
            <Trash2 class="w-3.5 h-3.5 mr-2" /> {{ t('grid.deleteRow') }}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </template>
        <ContextMenuItem @click="exportCsv">{{ t('grid.exportCsv') }}</ContextMenuItem>
        <ContextMenuItem @click="exportJson">{{ t('grid.exportJson') }}</ContextMenuItem>
        <ContextMenuItem @click="exportMarkdown">{{ t('grid.exportMarkdown') }}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>

    <div v-if="!hasData" class="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      {{ t('grid.querySuccess') }}
    </div>

    <!-- Error bar -->
    <div v-if="saveError" class="px-3 py-1.5 border-t bg-destructive/10 text-destructive text-xs shrink-0 flex items-center gap-2">
      <span class="flex-1">{{ saveError }}</span>
      <button class="hover:underline" @click="saveError = ''">dismiss</button>
    </div>

    <!-- Bottom status bar -->
    <div class="flex items-center gap-2 px-3 py-1 border-t text-xs text-muted-foreground bg-muted/30 shrink-0">
      <span v-if="hasData">{{ t('grid.rows', { count: result.rows.length }) }}</span>
      <span v-else>{{ t('grid.rowsAffected', { count: result.affected_rows }) }}</span>
      <span>{{ result.execution_time_ms }}ms</span>

      <template v-if="editable && tableMeta">
        <Button v-if="hasPendingChanges" variant="default" size="sm" class="h-5 text-xs ml-2" @click="saveChanges">
          <Save class="w-3 h-3 mr-1" /> {{ t('grid.save') }}
        </Button>
        <Button v-if="hasPendingChanges" variant="ghost" size="sm" class="h-5 text-xs" @click="discardChanges">
          {{ t('grid.discard') }}
        </Button>
        <Button variant="ghost" size="sm" class="h-5 text-xs" @click="addRow">
          <Plus class="w-3 h-3 mr-1" /> {{ t('grid.addRow') }}
        </Button>
      </template>

      <span class="ml-auto flex items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="sm" class="h-5 text-xs px-1.5">
              {{ pageSize }}{{ t('grid.rowsPerPageShort') }}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem v-for="s in [50, 100, 500, 1000]" :key="s" @click="changePageSize(s)">
              {{ s }} {{ t('grid.rowsPerPageShort') }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="currentPage <= 1" @click="prevPage">
          <ChevronLeft class="h-3 w-3" />
        </Button>
        <span>{{ currentPage }}</span>
        <Button variant="ghost" size="icon" class="h-5 w-5" :disabled="!isFullPage" @click="nextPage">
          <ChevronRight class="h-3 w-3" />
        </Button>
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon" class="h-5 w-5">
            <Download class="h-3 w-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem @click="exportCsv">{{ t('grid.exportCsv') }}</DropdownMenuItem>
          <DropdownMenuItem @click="exportJson">{{ t('grid.exportJson') }}</DropdownMenuItem>
          <DropdownMenuItem @click="exportMarkdown">{{ t('grid.exportMarkdown') }}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <span v-if="sqlOneLiner" class="truncate max-w-[30%] opacity-60" :title="sqlOneLiner">
        {{ sqlOneLiner }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.data-grid-scroller {
  overflow-anchor: none;
}

.data-grid-scroller :deep(.vue-recycle-scroller__item-wrapper) {
  min-width: var(--total-w);
  overflow: visible;
}
</style>

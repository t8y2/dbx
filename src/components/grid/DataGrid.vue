<script lang="ts">
import { ref } from "vue";
const globalDdlOpen = ref(false);
</script>

<script setup lang="ts">
import { computed, nextTick, watch } from "vue";
import { useElementSize } from "@vueuse/core";
import { useI18n } from "vue-i18n";
import { ArrowUp, ArrowDown, Download, Plus, Trash2, Save, ChevronLeft, ChevronRight, Search, Inbox, SearchX, Code2, Copy, Loader2, X, Undo2 } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ContextMenu, ContextMenuContent, ContextMenuItem,
  ContextMenuSeparator, ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { QueryResult, ColumnInfo, DatabaseType } from "@/types/database";
import { save as savePath } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import * as api from "@/lib/tauri";

import { useToast } from "@/composables/useToast";

const { t } = useI18n();
const { toast } = useToast();

const props = defineProps<{
  result: QueryResult;
  sql?: string;
  editable?: boolean;
  databaseType?: DatabaseType;
  connectionId?: string;
  database?: string;
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

function typeColorClass(t: string): string {
  const s = t.toLowerCase();
  if (["int", "int2", "int4", "int8", "smallint", "bigint", "integer", "serial", "bigserial", "tinyint", "mediumint"].includes(s)) return "text-blue-500";
  if (["float4", "float8", "double", "decimal", "numeric", "real", "float", "money"].includes(s)) return "text-cyan-500";
  if (["varchar", "text", "char", "character varying", "character", "string", "nvarchar", "nchar", "ntext", "longtext", "mediumtext", "tinytext", "clob"].includes(s)) return "text-green-500";
  if (["bool", "boolean", "bit"].includes(s)) return "text-orange-500";
  if (["timestamp", "timestamptz", "datetime", "date", "time", "timetz", "datetime2", "smalldatetime"].includes(s)) return "text-purple-500";
  if (["json", "jsonb", "xml", "array"].includes(s)) return "text-pink-500";
  if (["uuid", "uniqueidentifier"].includes(s)) return "text-amber-500";
  if (["bytea", "blob", "binary", "varbinary", "image"].includes(s)) return "text-red-400";
  return "text-muted-foreground";
}
const contextCell = ref<{ rowId: number; col: number } | null>(null);
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

const ROW_NUM_WIDTH = 48;
const ACTION_COL_WIDTH = 112;
const baseTotalWidth = computed(() => columnWidths.value.reduce((a, b) => a + b, 0));
const rowActionWidth = computed(() => props.editable ? ACTION_COL_WIDTH : 0);
const renderedColumnWidths = computed(() => {
  const widths = columnWidths.value;
  if (widths.length === 0) return widths;

  const extraWidth = Math.max(0, gridWidth.value - ROW_NUM_WIDTH - rowActionWidth.value - baseTotalWidth.value);
  if (extraWidth === 0) return widths;

  const extraPerColumn = extraWidth / widths.length;
  return widths.map((width) => width + extraPerColumn);
});
const totalWidth = computed(() => renderedColumnWidths.value.reduce((a, b) => a + b, 0) + ROW_NUM_WIDTH + rowActionWidth.value);

const columnVars = computed(() => {
  const vars: Record<string, string> = {};
  renderedColumnWidths.value.forEach((w, i) => {
    vars[`--col-w-${i}`] = `${w}px`;
  });
  vars["--row-num-w"] = `${ROW_NUM_WIDTH}px`;
  vars["--row-action-w"] = `${rowActionWidth.value}px`;
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
type RowStatus = "clean" | "edited" | "new" | "deleted";
const editingCell = ref<{ rowId: number; col: number } | null>(null);
const editValue = ref("");
const scrollerRef = ref<HTMLElement | { $el?: HTMLElement; el?: HTMLElement | { value?: HTMLElement } } | null>(null);
const dirtyRows = ref<Map<number, Map<number, CellValue>>>(new Map());
const newRows = ref<CellValue[][]>([]);
const deletedRows = ref<Set<number>>(new Set());

const dirtyRowCount = computed(() => dirtyRows.value.size);
const newRowCount = computed(() => newRows.value.length);
const deletedRowCount = computed(() => deletedRows.value.size);
const pendingChangeCount = computed(() => dirtyRowCount.value + newRowCount.value + deletedRowCount.value);
const hasPendingChanges = computed(() =>
  pendingChangeCount.value > 0
);

const sortedRows = computed(() => {
  let rows = props.result.rows.map((row, sourceIndex) => ({ row, sourceIndex }));
  if (searchText.value) {
    const q = searchText.value.toLowerCase();
    rows = rows.filter(({ row, sourceIndex }) => {
      const data = rowDataWithChanges(row, sourceIndex);
      return data.some((cell) => cell !== null && String(cell).toLowerCase().includes(q));
    });
  }
  return rows;
});

function rowDataWithChanges(row: CellValue[], sourceIndex: number): CellValue[] {
  const dirty = dirtyRows.value.get(sourceIndex);
  return row.map((v, colIdx) => dirty?.get(colIdx) ?? v);
}

interface RowItem {
  id: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: RowStatus;
}

const displayItems = computed<RowItem[]>(() => {
  const cols = props.result.columns;
  const items: RowItem[] = sortedRows.value.map(({ row, sourceIndex }) => {
    const dirty = dirtyRows.value.get(sourceIndex);
    const data = rowDataWithChanges(row, sourceIndex);
    const isDirtyCol = row.map((_, colIdx) => dirty?.has(colIdx) ?? false);
    const isDeleted = deletedRows.value.has(sourceIndex);
    const status: RowStatus = isDeleted ? "deleted" : dirty ? "edited" : "clean";
    return { id: sourceIndex, sourceIndex, data, isNew: false, isDeleted, isDirtyCol, status };
  });
  newRows.value.forEach((row, i) => {
    items.push({ id: -(i + 1), newIndex: i, data: row, isNew: true, isDeleted: false, isDirtyCol: cols.map(() => false), status: "new" });
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

function rowStatusLabel(item: RowItem): string {
  if (item.status === "new") return t("grid.statusNew");
  if (item.status === "edited") return t("grid.statusEdited");
  if (item.status === "deleted") return t("grid.statusDeleted");
  return t("grid.statusClean");
}

function rowStatusVariant(item: RowItem): "default" | "secondary" | "destructive" | "outline" {
  if (item.status === "new") return "default";
  if (item.status === "edited") return "secondary";
  if (item.status === "deleted") return "destructive";
  return "outline";
}

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

function getRowItem(rowId: number): RowItem | undefined {
  return displayItems.value.find((item) => item.id === rowId);
}

function coerceCellValue(value: string, oldVal: CellValue | undefined): CellValue {
  if (value.toUpperCase() === "NULL") return null;
  if (value === "" && isNull(oldVal)) return null;
  if (typeof oldVal === "number") {
    const num = Number(value);
    if (!Number.isNaN(num)) return num;
  }
  if (typeof oldVal === "boolean") {
    return value === "true" || value === "1";
  }
  return value;
}

function startEdit(rowId: number, colIdx: number) {
  if (!props.editable) return;
  const item = getRowItem(rowId);
  if (!item || item.isDeleted) return;
  isCancelling = false;
  editingCell.value = { rowId, col: colIdx };
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
  const { rowId, col } = editingCell.value;
  const item = getRowItem(rowId);
  if (!item || item.isDeleted) {
    editingCell.value = null;
    return;
  }

  if (item.isNew && item.newIndex !== undefined) {
    const oldVal = newRows.value[item.newIndex]?.[col];
    const newVal = coerceCellValue(editValue.value, oldVal);
    if (newRows.value[item.newIndex]) {
      newRows.value[item.newIndex][col] = newVal;
    }
    editingCell.value = null;
    return;
  }

  if (item.sourceIndex === undefined) {
    editingCell.value = null;
    return;
  }

  const oldVal = props.result.rows[item.sourceIndex]?.[col];
  const newVal = coerceCellValue(editValue.value, oldVal);
  if (newVal !== oldVal) {
    if (!dirtyRows.value.has(item.sourceIndex)) dirtyRows.value.set(item.sourceIndex, new Map());
    dirtyRows.value.get(item.sourceIndex)!.set(col, newVal);
  } else {
    const rowChanges = dirtyRows.value.get(item.sourceIndex);
    rowChanges?.delete(col);
    if (rowChanges?.size === 0) dirtyRows.value.delete(item.sourceIndex);
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
  const rowId = -newRows.value.length;
  nextTick(() => {
    const el = getScrollerElement();
    if (el) el.scrollTop = el.scrollHeight;
    startEdit(rowId, 0);
  });
}

function deleteRow(rowId: number) {
  const item = getRowItem(rowId);
  if (!item) return;
  if (item.isNew && item.newIndex !== undefined) {
    newRows.value.splice(item.newIndex, 1);
  } else if (item.sourceIndex !== undefined) {
    dirtyRows.value.delete(item.sourceIndex);
    deletedRows.value.add(item.sourceIndex);
  }
  if (editingCell.value?.rowId === rowId) editingCell.value = null;
}

function restoreRow(rowId: number) {
  const item = getRowItem(rowId);
  if (item?.sourceIndex !== undefined) {
    deletedRows.value.delete(item.sourceIndex);
  }
}

function deleteSelectedRow() {
  if (!contextCell.value) return;
  deleteRow(contextCell.value.rowId);
}

function escapeVal(v: CellValue): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const s = String(v);
  if (s === "") return "''";
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  if (props.databaseType === "mysql") {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

function qualifiedTableName(): string {
  if (!props.tableMeta) return "";
  const { schema, tableName } = props.tableMeta;
  if ((props.databaseType === "postgres" || props.databaseType === "oracle") && schema) {
    return `${quoteIdent(schema)}.${quoteIdent(tableName)}`;
  }
  return quoteIdent(tableName);
}

function generateSaveStatements(): string[] {
  if (!props.tableMeta) return [];
  const { primaryKeys } = props.tableMeta;
  const cols = props.result.columns;
  const stmts: string[] = [];
  const tbl = qualifiedTableName();

  for (const [rowIdx, changes] of dirtyRows.value) {
    const row = props.result.rows[rowIdx];
    if (!row) continue;
    const sets = Array.from(changes.entries())
      .map(([colIdx, val]) => `${quoteIdent(cols[colIdx])} = ${escapeVal(val)}`)
      .join(", ");
    const where = primaryKeys
      .map((pk) => `${quoteIdent(pk)} = ${escapeVal(row[cols.indexOf(pk)])}`)
      .join(" AND ");
    stmts.push(`UPDATE ${tbl} SET ${sets} WHERE ${where};`);
  }

  for (const rowIdx of deletedRows.value) {
    const row = props.result.rows[rowIdx];
    if (!row) continue;
    const where = primaryKeys
      .map((pk) => `${quoteIdent(pk)} = ${escapeVal(row[cols.indexOf(pk)])}`)
      .join(" AND ");
    stmts.push(`DELETE FROM ${tbl} WHERE ${where};`);
  }

  for (const newRow of newRows.value) {
    const colNames = cols.map((c) => quoteIdent(c)).join(", ");
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

  if (props.connectionId && props.database) {
    try {
      await api.executeBatch(props.connectionId, props.database, stmts);
    } catch (e: any) {
      saveError.value = String(e.message || e);
      return;
    }
  } else if (props.onExecuteSql) {
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
function onCellContext(rowId: number, colIdx: number) {
  contextCell.value = { rowId, col: colIdx };
}

function copyCell() {
  if (!contextCell.value) return;
  const item = getRowItem(contextCell.value.rowId);
  const val = item?.data[contextCell.value.col] ?? null;
  navigator.clipboard.writeText(formatCell(val));
}

function copyRow() {
  if (!contextCell.value) return;
  const item = getRowItem(contextCell.value.rowId);
  if (!item) return;
  const obj: Record<string, unknown> = {};
  props.result.columns.forEach((col, i) => { obj[col] = item.data[i]; });
  navigator.clipboard.writeText(JSON.stringify(obj, null, 2));
}

function copyAll() {
  const header = props.result.columns.join("\t");
  const body = sortedRows.value
    .map(({ row, sourceIndex }) => rowDataWithChanges(row, sourceIndex).map((c) => formatCell(c)).join("\t"))
    .join("\n");
  navigator.clipboard.writeText(`${header}\n${body}`);
}

async function exportCsv() {
  const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = props.result.columns.map(escape).join(",");
  const body = sortedRows.value
    .map(({ row, sourceIndex }) => rowDataWithChanges(row, sourceIndex).map((c) => escape(formatCell(c))).join(","))
    .join("\n");
  const path = await savePath({ filters: [{ name: "CSV", extensions: ["csv"] }] });
  if (path) await writeTextFile(path, `${header}\n${body}`);
}

async function exportJson() {
  const data = sortedRows.value.map(({ row, sourceIndex }) => {
    const data = rowDataWithChanges(row, sourceIndex);
    const obj: Record<string, unknown> = {};
    props.result.columns.forEach((col, i) => { obj[col] = data[i]; });
    return obj;
  });
  const path = await savePath({ filters: [{ name: "JSON", extensions: ["json"] }] });
  if (path) await writeTextFile(path, JSON.stringify(data, null, 2));
}

async function exportMarkdown() {
  const pad = (s: string, len: number) => s.padEnd(len);
  const cols = props.result.columns;
  const visibleRows = sortedRows.value.map(({ row, sourceIndex }) => rowDataWithChanges(row, sourceIndex));
  const widths = cols.map((c, i) => Math.max(c.length, ...visibleRows.map((r) => formatCell(r[i]).length), 3));
  const header = `| ${cols.map((c, i) => pad(c, widths[i])).join(" | ")} |`;
  const sep = `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`;
  const body = visibleRows.map((row) =>
    `| ${row.map((c, i) => pad(formatCell(c), widths[i])).join(" | ")} |`
  ).join("\n");
  const md = `${header}\n${sep}\n${body}\n`;
  const path = await savePath({ filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (path) await writeTextFile(path, md);
}

const sqlOneLiner = computed(() => props.sql?.replace(/\s+/g, " ").trim() || "");

function copySql() {
  if (!props.sql) return;
  navigator.clipboard.writeText(props.sql);
  toast(t('grid.copied'));
}

const showDdl = globalDdlOpen;
const ddlContent = ref("");
const ddlLoading = ref(false);

async function toggleDdl() {
  if (showDdl.value) {
    showDdl.value = false;
    return;
  }
  await fetchDdl();
}

async function fetchDdl() {
  if (!props.connectionId || !props.tableMeta) return;
  showDdl.value = true;
  ddlLoading.value = true;
  try {
    ddlContent.value = await api.getTableDdl(
      props.connectionId,
      props.database || "",
      props.tableMeta.schema || props.database || "",
      props.tableMeta.tableName,
    );
  } catch (e: any) {
    ddlContent.value = `-- Error: ${e}`;
  } finally {
    ddlLoading.value = false;
  }
}

if (showDdl.value && props.tableMeta && props.connectionId) {
  fetchDdl();
}

function copyDdl() {
  navigator.clipboard.writeText(ddlContent.value);
  toast(t('grid.copied'));
}

const SQL_KEYWORDS = /\b(CREATE|TABLE|INDEX|UNIQUE|PRIMARY|KEY|FOREIGN|REFERENCES|CONSTRAINT|NOT|NULL|DEFAULT|INT|INTEGER|BIGINT|SMALLINT|VARCHAR|CHARACTER|VARYING|TEXT|BOOLEAN|DOUBLE|PRECISION|REAL|FLOAT|NUMERIC|DECIMAL|TIMESTAMP|DATE|TIME|SERIAL|AUTOINCREMENT|AUTO_INCREMENT|IF|EXISTS|ON|SET|CASCADE|RESTRICT|CHECK|WITH|WITHOUT|ZONE)\b/gi;

function highlightSql(sql: string): string {
  const tokens: string[] = [];
  let rest = sql;
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  let match: RegExpExecArray | null;
  let last = 0;
  while ((match = re.exec(rest)) !== null) {
    if (match.index > last) tokens.push(escapeAndHighlightKeywords(rest.slice(last, match.index)));
    const q = match[1];
    const escaped = q.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const cls = q.startsWith('"') ? "ddl-ident" : "ddl-str";
    tokens.push(`<span class="${cls}">${escaped}</span>`);
    last = re.lastIndex;
  }
  if (last < rest.length) tokens.push(escapeAndHighlightKeywords(rest.slice(last)));
  return tokens.join("");
}

function escapeAndHighlightKeywords(s: string): string {
  return s
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(SQL_KEYWORDS, '<span class="ddl-kw">$1</span>');
}
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
            <Button v-if="editable && tableMeta" variant="ghost" size="sm" class="h-5 text-xs px-1.5 shrink-0" @click="addRow">
              <Plus class="w-3 h-3 mr-1" /> {{ t('grid.addRow') }}
            </Button>
            <Button v-if="tableMeta && connectionId" variant="ghost" size="sm" class="h-5 text-xs px-1.5 shrink-0" :class="{ 'bg-accent': showDdl }" @click="toggleDdl">
              <Code2 class="w-3 h-3 mr-1" /> DDL
            </Button>
          </div>
          <!-- Content area: table + DDL drawer -->
          <div class="flex-1 flex min-h-0 overflow-hidden">
            <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
              <!-- Sticky header -->
          <div ref="headerRef" class="shrink-0 bg-muted z-10 border-b border-border overflow-hidden">
            <div class="flex text-xs font-medium" :style="{ width: 'var(--total-w)' }">
              <div class="shrink-0 px-2 py-1.5 border-r border-border text-center text-muted-foreground select-none" :style="{ width: 'var(--row-num-w)' }">#</div>
              <div v-if="editable" class="shrink-0 px-2 py-1.5 border-r border-border text-center text-muted-foreground select-none" :style="{ width: 'var(--row-action-w)' }">
                {{ t('grid.rowState') }}
              </div>
              <div
                v-for="(col, colIdx) in result.columns"
                :key="col"
                class="shrink-0 px-3 py-1.5 border-r border-border whitespace-nowrap cursor-pointer hover:bg-accent/50 select-none relative overflow-hidden"
                :style="{ width: `var(--col-w-${colIdx})` }"
                @click="toggleSort(col)"
              >
                <span class="flex min-w-0 items-center gap-1 overflow-hidden">
                  <span class="min-w-0 truncate">{{ col }}</span>
                  <ArrowUp v-if="sortCol === col && sortDir === 'asc'" class="h-3 w-3 shrink-0" />
                  <ArrowDown v-else-if="sortCol === col && sortDir === 'desc'" class="h-3 w-3 shrink-0" />
                  <span
                    v-if="columnTypeMap.get(col)"
                    class="shrink overflow-hidden truncate text-[10px] font-normal"
                    :class="typeColorClass(columnTypeMap.get(col)!)"
                  >
                    #{{ columnTypeMap.get(col) }}
                  </span>
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
            <template #default="{ item, index }">
              <div
                class="flex text-xs border-b border-border hover:bg-accent/50"
                :class="{
                  'bg-destructive/5 opacity-70': item.isDeleted,
                  'bg-primary/5': item.isNew,
                  'bg-muted/30': !item.isNew && !item.isDeleted && index % 2 === 1,
                }"
                :style="{ height: '26px', width: 'var(--total-w)' }"
              >
                <div class="shrink-0 px-2 py-1 border-r border-border text-center text-muted-foreground select-none" :style="{ width: 'var(--row-num-w)' }">{{ index + 1 }}</div>
                <div
                  v-if="editable"
                  class="shrink-0 px-1.5 py-0.5 border-r border-border flex items-center justify-between gap-1"
                  :style="{ width: 'var(--row-action-w)' }"
                >
                  <Badge :variant="rowStatusVariant(item)" class="h-4 px-1.5 text-[10px]">
                    {{ rowStatusLabel(item) }}
                  </Badge>
                  <Button
                    v-if="editable && !item.isDeleted"
                    variant="ghost"
                    size="icon"
                    class="h-5 w-5 shrink-0 text-destructive"
                    :title="t('grid.deleteRow')"
                    @click.stop="deleteRow(item.id)"
                  >
                    <Trash2 class="w-3 h-3" />
                  </Button>
                  <Button
                    v-else-if="editable && item.isDeleted"
                    variant="ghost"
                    size="icon"
                    class="h-5 w-5 shrink-0"
                    :title="t('grid.restoreRow')"
                    @click.stop="restoreRow(item.id)"
                  >
                    <Undo2 class="w-3 h-3" />
                  </Button>
                </div>
                <div
                  v-for="(cell, colIdx) in item.data"
                  :key="colIdx"
                  class="shrink-0 px-3 py-1 border-r border-border whitespace-nowrap overflow-hidden text-ellipsis relative"
                  :style="{ width: `var(--col-w-${colIdx})` }"
                  :class="{
                    'text-muted-foreground italic': isNull(cell),
                    'bg-yellow-500/10': item.isDirtyCol[colIdx],
                    'tabular-nums': typeof cell === 'number',
                    'cursor-text hover:bg-accent/50': editable && !item.isDeleted,
                    'line-through': item.isDeleted,
                  }"
                  @dblclick="editable && !item.isDeleted && startEdit(item.id, colIdx)"
                  @contextmenu="onCellContext(item.id, colIdx)"
                >
                  <template v-if="editingCell?.rowId === item.id && editingCell?.col === colIdx">
                    <input
                      v-model="editValue"
                      class="cell-edit-input absolute inset-0 bg-background border-2 border-primary px-2 py-0.5 text-xs outline-none z-10"
                      @blur="commitEdit"
                      @click.stop
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
            <!-- DDL Drawer -->
            <div v-if="showDdl" class="w-80 shrink-0 border-l flex flex-col bg-background">
              <div class="flex items-center gap-2 px-3 py-1.5 border-b shrink-0 bg-muted/20">
                <Code2 class="w-3.5 h-3.5 text-muted-foreground" />
                <span class="text-xs font-medium flex-1">{{ tableMeta?.tableName }} DDL</span>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click="copyDdl">
                  <Copy class="w-3 h-3" />
                </Button>
                <Button variant="ghost" size="icon" class="h-5 w-5" @click="showDdl = false">
                  <X class="w-3 h-3" />
                </Button>
              </div>
              <div v-if="ddlLoading" class="flex-1 flex items-center justify-center">
                <Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
              </div>
              <pre v-else class="flex-1 text-xs font-mono p-3 overflow-auto whitespace-pre-wrap ddl-code" v-html="highlightSql(ddlContent)"></pre>
            </div>
          </div>
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
      <button class="hover:underline" @click="saveError = ''">{{ t('grid.dismiss') }}</button>
    </div>

    <!-- Bottom status bar -->
    <div class="flex items-center gap-2 px-3 py-1 border-t text-xs text-muted-foreground bg-muted/30 shrink-0">
      <span v-if="hasData">{{ t('grid.rows', { count: result.rows.length }) }}</span>
      <span v-else>{{ t('grid.rowsAffected', { count: result.affected_rows }) }}</span>
      <span>{{ result.execution_time_ms }}ms</span>

      <template v-if="editable && tableMeta">
        <span v-if="hasPendingChanges" class="ml-2 text-foreground">
          {{ t('grid.pendingChanges', { count: pendingChangeCount }) }}
        </span>
        <Button v-if="hasPendingChanges" variant="default" size="sm" class="h-5 text-xs ml-2" @click="saveChanges">
          <Save class="w-3 h-3 mr-1" /> {{ t('grid.save') }}
        </Button>
        <Button v-if="hasPendingChanges" variant="ghost" size="sm" class="h-5 text-xs" @click="discardChanges">
          {{ t('grid.discard') }}
        </Button>
        <Button variant="ghost" size="sm" class="h-5 text-xs" @click="toggleDdl">
          <Code2 class="w-3 h-3 mr-1" /> DDL
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

      <Tooltip v-if="sqlOneLiner">
        <TooltipTrigger as-child>
          <span class="truncate max-w-[30%] opacity-60 cursor-pointer hover:opacity-100" @click="copySql">
            {{ sqlOneLiner }}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" class="max-w-md">
          <pre class="text-xs font-mono whitespace-pre-wrap">{{ props.sql }}</pre>
        </TooltipContent>
      </Tooltip>
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

.ddl-code :deep(.ddl-kw) {
  color: oklch(0.6 0.15 250);
  font-weight: 600;
}
.ddl-code :deep(.ddl-ident) {
  color: oklch(0.65 0.15 150);
}
.ddl-code :deep(.ddl-str) {
  color: oklch(0.65 0.15 50);
}
</style>

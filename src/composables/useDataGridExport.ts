import type { ComputedRef, Ref } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { formatCsv, formatJson } from "@/lib/exportFormats";
import {
  formatSelectionAsCsv,
  formatSelectionAsJson,
  formatSelectionAsSqlInList,
  formatSelectionAsTsv,
  type SelectionData,
} from "@/lib/gridSelection";
import { useToast } from "@/composables/useToast";
import { displayCellValue, type CellValue } from "@/lib/cellValue";

interface RowItem {
  id: number;
  sourceIndex?: number;
  newIndex?: number;
  data: CellValue[];
  isNew: boolean;
  isDeleted: boolean;
  isDirtyCol: boolean[];
  status: string;
}

export interface UseDataGridExportOptions {
  columns: ComputedRef<string[]>;
  displayItems: ComputedRef<RowItem[]>;
  sql: ComputedRef<string | undefined>;
  tableMeta: ComputedRef<{ schema?: string; tableName: string } | undefined>;
  databaseType: ComputedRef<string | undefined>;
  hasCellSelection: ComputedRef<boolean>;
  selectedCells: ComputedRef<SelectionData>;
  contextCell:
    | Ref<{ rowId: number; rowIndex: number; col: number } | null>
    | ComputedRef<{ rowId: number; rowIndex: number; col: number } | null>;
  getRowItem: (rowId: number) => RowItem | undefined;
  quoteIdent: (name: string) => string;
  escapeVal: (value: CellValue) => string;
}

export function useDataGridExport(options: UseDataGridExportOptions) {
  const { t } = useI18n();
  const { toast } = useToast();

  const {
    columns,
    displayItems,
    sql,
    tableMeta,
    hasCellSelection,
    selectedCells,
    contextCell,
    getRowItem,
    quoteIdent,
    escapeVal,
  } = options;

  function copyText(text: string) {
    navigator.clipboard.writeText(text);
    toast(t("grid.copied"));
  }

  // --- Selection copy functions ---
  function copySelectionTsv() {
    if (!hasCellSelection.value) return;
    copyText(formatSelectionAsTsv(selectedCells.value));
  }

  function copySelectionCsv() {
    if (!hasCellSelection.value) return;
    copyText(formatSelectionAsCsv(selectedCells.value));
  }

  function copySelectionJson() {
    if (!hasCellSelection.value) return;
    copyText(formatSelectionAsJson(selectedCells.value));
  }

  function copySelectionSqlInList() {
    if (!hasCellSelection.value) return;
    copyText(formatSelectionAsSqlInList(selectedCells.value));
  }

  // --- Cell/row copy ---
  function copyCell() {
    if (!contextCell.value || contextCell.value.col < 0) return;
    const item = getRowItem(contextCell.value.rowId);
    const val = item?.data[contextCell.value.col] ?? null;
    copyText(displayCellValue(val));
  }

  function copyRow() {
    if (!contextCell.value) return;
    const item = getRowItem(contextCell.value.rowId);
    if (!item) return;
    const obj: Record<string, unknown> = {};
    columns.value.forEach((col, i) => {
      obj[col] = item.data[i];
    });
    copyText(JSON.stringify(obj, null, 2));
  }

  function copyRowAsInsert() {
    if (!contextCell.value) return;
    const item = getRowItem(contextCell.value.rowId);
    if (!item) return;
    const cols = columns.value.map((c) => quoteIdent(c)).join(", ");
    const vals = item.data.map((v) => escapeVal(v)).join(", ");
    const table = tableMeta.value
      ? (tableMeta.value.schema ? `${quoteIdent(tableMeta.value.schema)}.` : "") + quoteIdent(tableMeta.value.tableName)
      : "table_name";
    copyText(`INSERT INTO ${table} (${cols}) VALUES (${vals});`);
  }

  function copyAll() {
    const header = columns.value.join("\t");
    const body = displayItems.value.map((item) => item.data.map((c) => displayCellValue(c)).join("\t")).join("\n");
    copyText(`${header}\n${body}`);
  }

  // --- File save helpers ---
  async function saveFileContent(
    content: string,
    defaultFileName: string,
    filterName: string,
    filterExt: string,
  ): Promise<boolean> {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: filterName, extensions: [filterExt] }],
      });
      if (!path) return false;
      await writeTextFile(path, "﻿" + content);
      return true;
    } else {
      const blob = new Blob(["﻿", content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultFileName;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    }
  }

  async function saveBinaryFileContent(
    content: Uint8Array,
    defaultFileName: string,
    filterName: string,
    filterExt: string,
  ): Promise<boolean> {
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({
        defaultPath: defaultFileName,
        filters: [{ name: filterName, extensions: [filterExt] }],
      });
      if (!path) return false;
      await writeFile(path, content);
      return true;
    } else {
      const blob = new Blob([content], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = defaultFileName;
      a.click();
      URL.revokeObjectURL(url);
      return true;
    }
  }

  // --- Export functions ---
  async function exportCsv() {
    try {
      const rows = displayItems.value.map((item) => item.data.map((c) => displayCellValue(c)));
      if (await saveFileContent(formatCsv(columns.value, rows), "export.csv", "CSV", "csv")) {
        toast(t("grid.exported"));
      }
    } catch (e: any) {
      toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  async function exportJson() {
    try {
      const rows = displayItems.value.map((item) => item.data);
      if (await saveFileContent(formatJson(columns.value, rows), "export.json", "JSON", "json")) {
        toast(t("grid.exported"));
      }
    } catch (e: any) {
      toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  async function exportMarkdown() {
    try {
      const cols = columns.value;
      const visibleRows = displayItems.value.map((item) => item.data);
      const { formatMarkdownTable } = await import("@/lib/markdownTable");
      const md = formatMarkdownTable({ columns: cols, rows: visibleRows });
      if (await saveFileContent(md, "export.md", "Markdown", "md")) {
        toast(t("grid.exported"));
      }
    } catch (e: any) {
      toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  async function exportXlsx() {
    try {
      const { buildXlsxWorkbook } = await import("@/lib/xlsxExport");
      const workbook = buildXlsxWorkbook({
        sheetName: tableMeta.value?.tableName || "Export",
        columns: columns.value,
        rows: displayItems.value.map((item) => item.data),
      });
      if (await saveBinaryFileContent(workbook, "export.xlsx", "Excel", "xlsx")) {
        toast(t("grid.exported"));
      }
    } catch (e: any) {
      toast(t("grid.exportFailed", { message: e?.message || String(e) }), 5000);
    }
  }

  function copySql() {
    if (!sql.value) return;
    navigator.clipboard.writeText(sql.value);
    toast(t("grid.copied"));
  }

  return {
    copyText,
    copyCell,
    copyRow,
    copyRowAsInsert,
    copyAll,
    copySelectionTsv,
    copySelectionCsv,
    copySelectionJson,
    copySelectionSqlInList,
    exportCsv,
    exportJson,
    exportMarkdown,
    exportXlsx,
    copySql,
  };
}

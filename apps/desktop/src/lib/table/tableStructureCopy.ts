import type { ColumnInfo } from "@/types/database";

export type TableStructureCopyFormat = "tsv" | "markdown";

export interface TableStructureCopyTarget {
  name: string;
  columns: readonly ColumnInfo[];
  /** Driver-specific display type, such as GaussDB-M's MySQL-compatible type names. */
  columnType?: (column: ColumnInfo) => string;
}

type Translate = (key: string) => string;

function cellValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function tsvCell(value: unknown): string {
  return cellValue(value).replace(/\t/g, " ").replace(/\r?\n/g, " ").trim();
}

function markdownCell(value: unknown): string {
  return cellValue(value).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>").trim();
}

function headers(includeTable: boolean, t: Translate): string[] {
  const columns = [t("contextMenu.structureDocColumn"), t("contextMenu.structureDocType"), t("contextMenu.structureDocPrimaryKey"), t("contextMenu.structureDocNullable"), t("contextMenu.structureDocDefault"), t("contextMenu.structureDocComment")];
  return includeTable ? [t("contextMenu.structureDocTable"), ...columns] : columns;
}

function columnCells(target: TableStructureCopyTarget, column: ColumnInfo, includeTable: boolean, t: Translate): unknown[] {
  const cells = [column.name, target.columnType?.(column) ?? column.data_type, column.is_primary_key ? t("contextMenu.structureDocYes") : t("contextMenu.structureDocNo"), column.is_nullable ? t("contextMenu.structureDocYes") : t("contextMenu.structureDocNo"), column.column_default, column.comment];
  return includeTable ? [target.name, ...cells] : cells;
}

/** Build the shared TSV/Markdown table-structure clipboard document. */
export function buildTableStructureCopyText(format: TableStructureCopyFormat, targets: readonly TableStructureCopyTarget[], t: Translate): string {
  if (!targets.length) return "";
  const includeTable = targets.length > 1;

  if (format === "tsv") {
    const lines = [headers(includeTable, t).map(tsvCell).join("\t")];
    for (const target of targets) {
      for (const column of target.columns) lines.push(columnCells(target, column, includeTable, t).map(tsvCell).join("\t"));
    }
    return `${lines.join("\n")}\n`;
  }

  const markdownHeaders = headers(false, t);
  const tables = targets.map((target) => {
    const tableLines = [`### ${markdownCell(target.name)}`, "", `| ${markdownHeaders.map(markdownCell).join(" | ")} |`, `| ${markdownHeaders.map(() => "---").join(" | ")} |`, ...target.columns.map((column) => `| ${columnCells(target, column, false, t).map(markdownCell).join(" | ")} |`)];
    return tableLines.join("\n");
  });
  return `${tables.join("\n\n")}\n`;
}

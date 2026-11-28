import { buildXlsxWorkbookMulti } from "@/lib/export/xlsxExport";
import { columnComment, qualifiedObjectName, typeLabel, type DataDictionaryLabels, type DictionaryTable } from "./dataDictionary";

export interface DictionaryTabularLabels extends DataDictionaryLabels {
  object: string;
  warnings: string;
}

type DictionarySection = { title: string; columns: string[]; rows: string[][] };

function objectType(table: DictionaryTable, labels: DataDictionaryLabels): string {
  if (table.kind === "VIEW") return labels.kindView;
  if (table.kind === "MATERIALIZED_VIEW") return labels.kindMaterializedView;
  return labels.kindTable;
}

function columnSection(table: DictionaryTable, labels: DataDictionaryLabels): DictionarySection {
  return {
    title: labels.column,
    columns: [labels.column, labels.type, labels.nullable, labels.primaryKey, labels.defaultValue, labels.extra, labels.comment],
    rows: table.columns.map((column) => [column.name, typeLabel(column), column.is_nullable ? labels.yes : labels.no, column.is_primary_key ? labels.yes : labels.no, column.column_default ?? "", column.extra ?? "", columnComment(table, column)]),
  };
}

function indexSection(table: DictionaryTable, labels: DataDictionaryLabels): DictionarySection {
  return {
    title: labels.indexesHeading,
    columns: [labels.indexName, labels.indexColumns, labels.indexType, labels.unique, labels.primaryKey, labels.comment],
    rows: table.indexes.map((index) => [index.name, index.columns.join(", "), index.index_type ?? "", index.is_unique ? labels.yes : labels.no, index.is_primary ? labels.yes : labels.no, index.comment ?? ""]),
  };
}

function foreignKeySection(table: DictionaryTable, labels: DataDictionaryLabels): DictionarySection {
  return {
    title: labels.foreignKeysHeading,
    columns: [labels.constraintName, labels.column, labels.refSchema, labels.refTable, labels.refColumn, labels.onUpdate, labels.onDelete],
    rows: table.foreignKeys.map((key) => [key.name, key.column, key.ref_schema ?? "", key.ref_table, key.ref_column, key.on_update ?? "", key.on_delete ?? ""]),
  };
}

function markdownText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/[\\`*_[\]()#!+|~-]/g, "\\$&")
    .replace(/\b(?:https?:|www\.)/gi, (prefix) => prefix.replace(":", "&#58;").replace(".", "&#46;"))
    .replace(/\r\n?|\n/g, "<br>");
}

function markdownTable({ columns, rows }: DictionarySection): string {
  const line = (values: string[]) => "| " + values.map(markdownText).join(" | ") + " |";
  return [line(columns), "| " + columns.map(() => "---").join(" | ") + " |", ...rows.map(line)].join("\n");
}

export function renderDataDictionaryTabular(format: "md" | "xlsx", tables: DictionaryTable[], labels: DictionaryTabularLabels, options: { title: string; includeIndexesAndForeignKeys: boolean; warnings: string[] }): Uint8Array {
  const buildSections = options.includeIndexesAndForeignKeys ? [columnSection, indexSection, foreignKeySection] : [columnSection];
  const objects = tables.map((table) => ({
    name: qualifiedObjectName(table),
    kind: objectType(table, labels),
    note: table.note ?? "",
    sections: buildSections.map((build) => build(table, labels)),
  }));
  if (format === "xlsx") {
    const sheets = [
      {
        sheetName: labels.object,
        columns: [labels.object, labels.type, labels.comment],
        rows: objects.map((object) => [object.name, object.kind, object.note]),
      },
    ];
    buildSections.forEach((_, index) => {
      const first = objects[0]?.sections[index];
      if (!first) return;
      const rows = objects.flatMap((object) => (object.sections[index]?.rows ?? []).map((row) => [object.name, ...row]));
      if (rows.length || index === 0) sheets.push({ sheetName: first.title, columns: [labels.object, ...first.columns], rows });
    });
    if (options.warnings.length) {
      sheets.push({ sheetName: labels.warnings, columns: [labels.warnings], rows: options.warnings.map((warning) => [warning]) });
    }
    return buildXlsxWorkbookMulti(sheets);
  }

  const documents = ["# " + markdownText(options.title)];
  if (options.warnings.length) {
    documents.push("## " + markdownText(labels.warnings), ...options.warnings.map((warning) => "- " + markdownText(warning)));
  }
  for (const object of objects) {
    documents.push("## " + markdownText(object.kind + ": " + object.name));
    if (object.note) documents.push(markdownText(object.note));
    for (const section of object.sections) {
      if (section.rows.length) documents.push("### " + markdownText(section.title), markdownTable(section));
    }
  }
  return new TextEncoder().encode(documents.join("\n\n") + "\n");
}

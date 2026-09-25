import type { ColumnInfo, DocTable, TableKind } from "@/docs/types";
import type { DatabaseType } from "@/types/database";
import { isSystemDatabaseName, isSystemSchemaName } from "@/lib/database/visibleDatabases";

export type DictionaryPaper = "A4" | "A3" | "Letter" | "Legal";
export type DictionaryOrientation = "portrait" | "landscape";
export type DictionaryTemplateId = "standard" | "detailed" | "compact" | "catalog" | "reference";

export interface DataDictionaryLabels {
  column: string;
  type: string;
  length: string;
  precision: string;
  scale: string;
  primaryKey: string;
  nullable: string;
  unique: string;
  defaultValue: string;
  extra: string;
  comment: string;
  indexName: string;
  indexColumns: string;
  indexType: string;
  constraintName: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
  onUpdate: string;
  onDelete: string;
  yes: string;
  no: string;
  indexesHeading: string;
  foreignKeysHeading: string;
  contentsHeading: string;
  kindTable: string;
  kindView: string;
  kindMaterializedView: string;
}

export interface DictionaryLayout {
  includeCover: boolean;
  header: string;
  title: string;
  subtitle: string;
  remarks: string;
  coverFooter: string;
  includeToc: boolean;
  includeBreadcrumbs: boolean;
  includeLeftFooter: boolean;
  leftFooter: string;
  includePageNumber: boolean;
  includeIntroduction: boolean;
  introduction: string;
  paper: DictionaryPaper;
  orientation: DictionaryOrientation;
  marginCm: number;
  headingSize: number;
  bodySize: number;
  includeIndexesAndForeignKeys: boolean;
}

export interface DictionaryObjectRef {
  database: string;
  schema: string;
  name: string;
  kind: TableKind;
}

export interface DictionaryProfile {
  version: 1;
  databases: string[];
  schemas: Array<{ database: string; name: string }>;
  objects: Array<{ database: string; schema: string; name: string }>;
  layout: DictionaryLayout;
  appendTimestamp: boolean;
  overwrite: boolean;
  continueOnError: boolean;
  fileName: string;
}

export interface DictionaryTable extends DocTable {
  database: string;
}

const TEMPLATES: Record<DictionaryTemplateId, Omit<DictionaryLayout, "header" | "title" | "subtitle" | "remarks" | "coverFooter" | "leftFooter" | "introduction">> = {
  standard: { includeCover: true, includeToc: true, includeBreadcrumbs: true, includeLeftFooter: true, includePageNumber: true, includeIntroduction: true, paper: "A4", orientation: "portrait", marginCm: 1.5, headingSize: 16, bodySize: 9, includeIndexesAndForeignKeys: true },
  detailed: { includeCover: true, includeToc: true, includeBreadcrumbs: true, includeLeftFooter: true, includePageNumber: true, includeIntroduction: true, paper: "A4", orientation: "landscape", marginCm: 1.5, headingSize: 18, bodySize: 9, includeIndexesAndForeignKeys: true },
  compact: { includeCover: false, includeToc: false, includeBreadcrumbs: true, includeLeftFooter: false, includePageNumber: true, includeIntroduction: false, paper: "A4", orientation: "landscape", marginCm: 1, headingSize: 14, bodySize: 8, includeIndexesAndForeignKeys: false },
  catalog: { includeCover: true, includeToc: true, includeBreadcrumbs: false, includeLeftFooter: true, includePageNumber: true, includeIntroduction: false, paper: "A4", orientation: "portrait", marginCm: 1.5, headingSize: 16, bodySize: 9, includeIndexesAndForeignKeys: false },
  reference: { includeCover: false, includeToc: true, includeBreadcrumbs: true, includeLeftFooter: true, includePageNumber: true, includeIntroduction: false, paper: "A3", orientation: "landscape", marginCm: 1.2, headingSize: 14, bodySize: 8, includeIndexesAndForeignKeys: true },
};

const INTERNAL_DICTIONARY_NAMES = new Set(["information_schema", "performance_schema", "mysql", "sys", "pg_catalog", "pg_toast"]);

export function isInternalDictionaryName(databaseType: DatabaseType | undefined, name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (INTERNAL_DICTIONARY_NAMES.has(normalized) || normalized.startsWith("pg_toast") || normalized.startsWith("pg_temp_")) return true;
  return isSystemDatabaseName(databaseType, name) || isSystemSchemaName(databaseType, name);
}

export function dictionaryCatalogNames(names: string[], databaseType: DatabaseType | undefined, pinned?: string): string[] {
  return names.filter((name) => name === pinned || !isInternalDictionaryName(databaseType, name));
}

export function objectKey(ref: { database: string; schema: string; name: string }): string {
  return `${ref.database}\u0000${ref.schema}\u0000${ref.name}`;
}

export function tableKindFrom(tableType: string): TableKind {
  const normalized = tableType.trim().toUpperCase().replaceAll("_", " ");
  if (normalized.includes("MATERIALIZED")) return "MATERIALIZED_VIEW";
  if (normalized.includes("VIEW")) return "VIEW";
  return "TABLE";
}

export function applyTemplate(id: DictionaryTemplateId, context: { title: string; introduction: string; detailedIntroduction: string; leftFooter: string }): DictionaryLayout {
  const preset = TEMPLATES[id];
  return {
    ...preset,
    header: context.title,
    title: context.title,
    subtitle: "",
    remarks: "",
    coverFooter: "",
    leftFooter: context.leftFooter,
    introduction: id === "detailed" ? context.detailedIntroduction : context.introduction,
  };
}

export function toggleOrderedKey(order: string[], key: string, checked: boolean): string[] {
  const without = order.filter((item) => item !== key);
  return checked ? [...without, key] : without;
}

export function moveOrderedKey(order: string[], key: string, direction: -1 | 1): string[] {
  const index = order.indexOf(key);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= order.length) return order;
  const copy = order.slice();
  const [item] = copy.splice(index, 1);
  copy.splice(next, 0, item!);
  return copy;
}

export function orderDictionaryTables(tables: DictionaryTable[], keys: string[]): DictionaryTable[] {
  const byKey = new Map(tables.map((table) => [objectKey({ database: table.database, schema: table.schema ?? "", name: table.name }), table]));
  return keys.flatMap((key) => {
    const table = byKey.get(key);
    return table ? [table] : [];
  });
}

export function dictionaryTimestamp(now = new Date()): string {
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
}

export function appendTimestampToFileName(path: string, now = new Date()): string {
  const stamp = dictionaryTimestamp(now);
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const extIndex = base.toLowerCase().endsWith(".pdf") ? base.length - 4 : -1;
  const stem = extIndex >= 0 ? base.slice(0, extIndex) : base;
  const ext = extIndex >= 0 ? base.slice(extIndex) : ".pdf";
  if (/_\d{14}$/.test(stem)) return `${dir}${stem}${ext}`;
  return `${dir}${stem}_${stamp}${ext}`;
}

export function dataDictionaryFileName(database: string, appendTimestamp: boolean, now = new Date()): string {
  const safe = database.replace(/[\\/:*?"<>|]/g, "_").trim() || "DataDictionary";
  const name = `${safe}-data-dictionary.pdf`;
  return appendTimestamp ? appendTimestampToFileName(name, now) : name;
}

/** Apply the timestamp choice to either a typed/browsed path or the fallback name. */
export function resolveDictionaryExportPath(existingPath: string, fallbackName: string, appendTimestamp: boolean, now = new Date()): string {
  const chosen = existingPath.trim();
  const name = chosen || fallbackName;
  return appendTimestamp ? appendTimestampToFileName(name, now) : name;
}

export function exportBlockedBySkippedTables(warnings: Array<{ kind: string }>, continueOnError: boolean): boolean {
  return !continueOnError && warnings.some((warning) => warning.kind === "tableSkipped");
}

function warningNamesSelectedTable(table: string, schema: string, name: string): boolean {
  if (table === name) return true;
  // Collector formats skips as `{schema}.{table}`, so an empty schema is `.orders`.
  return table === `${schema}.${name}`;
}

function schemaWideSkipMatches(table: string, selected: ReadonlyArray<{ schema?: string | null }>): boolean {
  if (table === "*") return true;
  if (!table.endsWith(".*")) return false;
  const schema = table.slice(0, -2);
  return selected.some((item) => (item.schema ?? "") === schema);
}

/** Drop skip warnings that do not name a selected object or that object's schema. */
export function warningsForSelection<T extends { kind: string; table?: string }>(warnings: T[], selected: ReadonlyArray<{ schema?: string | null; name: string }>): T[] {
  return warnings.filter((warning) => {
    const table = warning.table;
    if (!table) return true;
    if (table === "*" || table.endsWith(".*")) return schemaWideSkipMatches(table, selected);
    return selected.some((item) => warningNamesSelectedTable(table, item.schema ?? "", item.name));
  });
}

export function isDictionaryProfile(value: unknown): value is DictionaryProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<DictionaryProfile>;
  return profile.version === 1 && Array.isArray(profile.databases) && Array.isArray(profile.objects) && !!profile.layout && typeof profile.fileName === "string";
}

export function columnComment(table: DocTable, column: ColumnInfo): string {
  const note = table.columnNotes[column.name]?.note;
  if (note && note.trim() !== "") return note;
  return column.comment ?? "";
}

export function typeLabel(column: ColumnInfo): string {
  const base = column.data_type.trim();
  if (base.includes("(")) return base;
  if (column.character_maximum_length !== null) return `${base}(${column.character_maximum_length})`;
  if (column.numeric_precision !== null) {
    const scale = column.numeric_scale === null ? "" : `,${column.numeric_scale}`;
    return `${base}(${column.numeric_precision}${scale})`;
  }
  return base;
}

export function qualifiedObjectName(table: Pick<DictionaryTable, "database" | "schema" | "name">): string {
  const schema = table.schema ? `${table.schema}.` : "";
  return table.database ? `${table.database}.${schema}${table.name}` : `${schema}${table.name}`;
}

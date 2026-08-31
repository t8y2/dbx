import type { DatabaseType } from "@/types/database";
import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
import { manifestDatabaseTypes } from "@/lib/database/databaseDriverManifest";
import { getTableStructureCapabilities } from "@/lib/table/tableStructureCapabilities";

export interface TableColumnTemplate {
  id: string;
  labelKey: string;
  columnNames: string[];
}

export interface TableColumnTemplateField {
  name: string;
  dataTypesByDatabase: Partial<Record<DatabaseType, string>>;
  defaultValue?: string;
  isNullable?: boolean;
  comment?: string;
}

export interface TableColumnTemplateGridRowInput {
  name: string;
  required: boolean;
  defaultValue: string;
  comment: string;
  overrides: readonly { databaseType: DatabaseType; dataType: string }[];
}

export const PRESET_FIELDS_TEMPLATE_ID = "preset-fields";
export const EMPTY_TABLE_COLUMN_TEMPLATE_DATA_TYPE = "<empty>";
export const TABLE_COLUMN_TEMPLATE_DATABASE_TYPES: DatabaseType[] = manifestDatabaseTypes().filter(isTableColumnTemplateDatabaseType);
export const DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS: string[] = [];

export function normalizeTableColumnTemplateFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS];
  return parseTableColumnTemplateFieldLines(value).map(serializeTableColumnTemplateField);
}

export function parseTableColumnTemplateFields(value: unknown): TableColumnTemplateField[] {
  if (!Array.isArray(value)) return parseTableColumnTemplateFieldLines(DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS);
  return parseTableColumnTemplateFieldLines(value);
}

/**
 * Serialize settings-grid rows.
 * UI is filtered per database, so the same field name can appear as separate rows (one per
 * engine). Merge those into one stored field with per-DB types — dropping later names made
 * Apply look unchanged (#5579).
 */
export function tableColumnTemplateRowsToSettings(rows: readonly TableColumnTemplateGridRowInput[]): string[] {
  const fields: TableColumnTemplateField[] = [];
  for (const row of rows) {
    const field = fieldFromGridRow(row);
    if (field) fields.push(field);
  }
  return mergeTableColumnTemplateFields(fields).map(serializeTableColumnTemplateField);
}

export function tableColumnTemplates(columnNames: readonly string[] = DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS): TableColumnTemplate[] {
  const fields = parseTableColumnTemplateFields([...columnNames]);
  return [
    {
      id: PRESET_FIELDS_TEMPLATE_ID,
      labelKey: "structureEditor.presetFieldsTemplate",
      columnNames: fields.map((field) => field.name),
    },
  ];
}

export function createTableColumnTemplateDrafts(options: { templateId: string; databaseType?: DatabaseType; columnNames?: readonly string[]; existingColumnNames?: Iterable<string>; createId: () => string }): EditableStructureColumn[] {
  if (options.templateId !== PRESET_FIELDS_TEMPLATE_ID) return [];
  const existingNames = new Set([...(options.existingColumnNames ?? [])].map((name) => name.toLowerCase()));
  return presetFieldColumns(options.databaseType, parseTableColumnTemplateFields([...(options.columnNames ?? DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS)]), options.createId).filter((column) => !existingNames.has(column.name.toLowerCase()));
}

/** Case-insensitive name merge: first wins for field props; per-DB types are unioned. */
function mergeTableColumnTemplateFields(fields: readonly TableColumnTemplateField[]): TableColumnTemplateField[] {
  const order: string[] = [];
  const byName = new Map<string, TableColumnTemplateField>();

  for (const field of fields) {
    const name = field.name.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, {
        name,
        dataTypesByDatabase: { ...field.dataTypesByDatabase },
        isNullable: field.isNullable,
        defaultValue: field.defaultValue,
        comment: field.comment,
      });
      order.push(key);
      continue;
    }
    if (!existing.defaultValue && field.defaultValue) existing.defaultValue = field.defaultValue;
    if (!existing.comment && field.comment) existing.comment = field.comment;
    for (const [databaseType, dataType] of Object.entries(field.dataTypesByDatabase) as [DatabaseType, string][]) {
      if (existing.dataTypesByDatabase[databaseType] !== undefined) continue;
      existing.dataTypesByDatabase[databaseType] = dataType;
    }
  }

  return order.map((key) => byName.get(key)!);
}

function serializeTableColumnTemplateField(field: TableColumnTemplateField): string {
  const parts = [field.name];
  for (const [databaseType, dataType] of Object.entries(field.dataTypesByDatabase)) {
    if (!dataType) continue;
    parts.push(`${databaseType}:${dataType}`);
  }
  if (field.isNullable === true) parts.push("required:false");
  if (field.defaultValue) parts.push(`default:${field.defaultValue}`);
  if (field.comment) parts.push(`comment:${field.comment}`);
  return parts.join(" | ");
}

function fieldFromGridRow(row: TableColumnTemplateGridRowInput): TableColumnTemplateField | null {
  const name = row.name.trim();
  if (!name) return null;

  const dataTypesByDatabase: Partial<Record<DatabaseType, string>> = {};
  for (const override of row.overrides) {
    if (dataTypesByDatabase[override.databaseType] !== undefined) continue;
    dataTypesByDatabase[override.databaseType] = override.dataType.trim() || EMPTY_TABLE_COLUMN_TEMPLATE_DATA_TYPE;
  }

  return {
    name,
    dataTypesByDatabase,
    isNullable: row.required ? undefined : true,
    defaultValue: row.defaultValue.trim() || undefined,
    comment: row.comment.trim() || undefined,
  };
}

function parseTableColumnTemplateFieldLines(value: readonly unknown[]): TableColumnTemplateField[] {
  const parsed: TableColumnTemplateField[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || !trimmed.split("|")[0]?.trim()) continue;
    parsed.push(parseTableColumnTemplateField(trimmed));
  }
  return mergeTableColumnTemplateFields(parsed);
}

function presetFieldColumns(databaseType: DatabaseType | undefined, fields: readonly TableColumnTemplateField[], createId: () => string): EditableStructureColumn[] {
  return fields
    .filter((field) => isTableColumnTemplateFieldApplicable(field, databaseType))
    .map((field) => {
      return templateColumn(createId, field.name, configuredFieldDataType(field, databaseType) ?? "", field.isNullable ?? false, field.defaultValue ?? "", field.comment ?? "");
    });
}

function templateColumn(createId: () => string, name: string, dataType: string, isNullable: boolean, defaultValue = "", comment = ""): EditableStructureColumn {
  return {
    id: `new:${createId()}`,
    name,
    dataType,
    enumValues: [],
    isNullable,
    defaultValue,
    comment,
    isPrimaryKey: false,
    characterSet: "",
    collation: "",
    extra: {},
    markedForDrop: false,
  };
}

function parseTableColumnTemplateField(value: string): TableColumnTemplateField {
  const [rawName = "", ...rawParts] = value.split("|").map((part) => part.trim());
  const field: TableColumnTemplateField = { name: rawName, dataTypesByDatabase: {} };
  for (const part of rawParts) {
    const separator = part.indexOf(":");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const dataType = part.slice(separator + 1).trim();
    if (!dataType) continue;
    if (key === "nullable") {
      field.isNullable = parseBooleanConfigValue(dataType);
    } else if (key === "required") {
      const required = parseBooleanConfigValue(dataType);
      field.isNullable = required === undefined ? undefined : !required;
    } else if (key === "default" || key === "defaultvalue" || key === "default_value") {
      field.defaultValue = dataType;
    } else if (key === "comment" || key === "description") {
      field.comment = dataType;
    } else if (isDatabaseTypeKey(key)) {
      field.dataTypesByDatabase[key] = dataType;
    }
  }
  return field;
}

function parseBooleanConfigValue(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  return undefined;
}

function configuredFieldDataType(field: TableColumnTemplateField, databaseType: DatabaseType | undefined): string | undefined {
  const configuredDataType = databaseType ? field.dataTypesByDatabase[databaseType] : undefined;
  return configuredDataType && configuredDataType !== EMPTY_TABLE_COLUMN_TEMPLATE_DATA_TYPE ? configuredDataType : undefined;
}

function isTableColumnTemplateFieldApplicable(field: TableColumnTemplateField, databaseType: DatabaseType | undefined): boolean {
  return !!databaseType && Object.prototype.hasOwnProperty.call(field.dataTypesByDatabase, databaseType);
}

function isTableColumnTemplateDatabaseType(databaseType: DatabaseType): boolean {
  return databaseType !== "manticoresearch" && getTableStructureCapabilities(databaseType).createTable;
}

function isDatabaseTypeKey(value: string): value is DatabaseType {
  return TABLE_COLUMN_TEMPLATE_DATABASE_TYPES.includes(value as DatabaseType);
}

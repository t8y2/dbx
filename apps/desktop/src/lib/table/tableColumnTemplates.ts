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

export const PRESET_FIELDS_TEMPLATE_ID = "preset-fields";
export const EMPTY_TABLE_COLUMN_TEMPLATE_DATA_TYPE = "<empty>";
export const TABLE_COLUMN_TEMPLATE_DATABASE_TYPES: DatabaseType[] = manifestDatabaseTypes().filter(isTableColumnTemplateDatabaseType);
export const DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS: string[] = [];

export function normalizeTableColumnTemplateFields(value: unknown): string[] {
  if (!Array.isArray(value)) return [...DEFAULT_TABLE_COLUMN_TEMPLATE_FIELDS];
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const field = item.trim();
    const name = field.split("|")[0]?.trim();
    if (!field || !name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    fields.push(field);
  }
  return fields;
}

export function parseTableColumnTemplateFields(value: unknown): TableColumnTemplateField[] {
  return normalizeTableColumnTemplateFields(value).map(parseTableColumnTemplateField);
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

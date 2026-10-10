import type { EditableStructureColumn } from "@/lib/table/tableStructureEditorSql";
import { getStarRocksCapabilities } from "./starrocksCapabilities";

export interface DefaultValuePreset {
  label: string;
  value: string;
}
export interface ColumnDefaultPresetContext {
  databaseType?: string;
  dialect: string;
  serverVersion?: string;
  unsetLabel: string;
  isCreateMode?: boolean;
}
type DefaultColumn = Pick<EditableStructureColumn, "dataType" | "isNullable" | "isPrimaryKey" | "extra">;
type DefaultPresetProvider = (column: DefaultColumn, context: ColumnDefaultPresetContext) => DefaultValuePreset[];
const presets = (...values: string[]): DefaultValuePreset[] => values.map((value) => ({ label: value, value }));

// Keep product-specific defaults separate from the compatible wire/SQL dialect.
const providers: Record<string, DefaultPresetProvider> = {
  starrocks: starRocksDefaultPresets,
};

export function getColumnDefaultValuePresets(column: DefaultColumn, context: ColumnDefaultPresetContext): DefaultValuePreset[] {
  const provider = providers[context.databaseType ?? ""];
  return provider ? provider(column, context) : legacyDefaultPresets(context);
}

function starRocksDefaultPresets(column: DefaultColumn, context: ColumnDefaultPresetContext): DefaultValuePreset[] {
  const result = [{ label: context.unsetLabel, value: "" }];
  const base = column.dataType.split(/[<(]/)[0]!.trim().toLowerCase();
  if (column.extra?.autoIncrement || base === "hll" || base === "bitmap") return result;
  if (column.isNullable && !column.isPrimaryKey) result.push(...presets("NULL"));
  // ADD COLUMN cannot backfill per-row UUID expressions.
  const functions = context.isCreateMode === true && getStarRocksCapabilities(context.serverVersion).defaultFunctions;
  if (/^(tinyint|smallint|int|integer|bigint|largeint|float|double|decimal|decimalv2|decimal32|decimal64|decimal128|decimal256)$/.test(base)) {
    result.push(...presets("'0'", "'1'"));
    if (base === "largeint" && functions) result.push(...presets("(uuid_numeric())"));
  } else if (base === "boolean") {
    result.push(...presets("'false'", "'true'"));
  } else if (base === "date") {
    result.push(...presets("1970-01-01"));
  } else if (base === "datetime") {
    result.push(...presets("CURRENT_TIMESTAMP"));
  } else if (base === "char" || base === "varchar" || base === "string") {
    result.push(...presets("''"));
    const length = Number(column.dataType.match(/\(\s*(\d+)\s*\)/)?.[1] ?? 1);
    if (functions && (base === "string" || (base === "varchar" && length >= 36))) result.push(...presets("(uuid())"));
  }
  // 3.5 complex/JSON/binary columns do not use scalar or newer-version expression presets.
  // Other literals remain manually editable; changing type never discards user input.
  return result;
}

function legacyDefaultPresets(context: ColumnDefaultPresetContext): DefaultValuePreset[] {
  const universal: DefaultValuePreset[] = [
    { label: "''", value: "''" },
    { label: "NULL", value: "NULL" },
    { label: "0", value: "0" },
    { label: "1", value: "1" },
  ];

  const dialectPresets: Record<string, DefaultValuePreset[]> = {
    mysql: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
      { label: "CURRENT_TIME", value: "CURRENT_TIME" },
    ],
    postgres: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
      { label: "now()", value: "now()" },
      { label: "gen_random_uuid()", value: "gen_random_uuid()" },
    ],
    sqlite: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
      { label: "CURRENT_TIME", value: "CURRENT_TIME" },
    ],
    duckdb: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
    ],
    sqlserver: [
      { label: "GETDATE()", value: "GETDATE()" },
      { label: "GETUTCDATE()", value: "GETUTCDATE()" },
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "NEWID()", value: "NEWID()" },
    ],
    oracle: [
      { label: "SYSDATE", value: "SYSDATE" },
      { label: "SYSTIMESTAMP", value: "SYSTIMESTAMP" },
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
    ],
    h2: [
      { label: "CURRENT_TIMESTAMP", value: "CURRENT_TIMESTAMP" },
      { label: "CURRENT_DATE", value: "CURRENT_DATE" },
    ],
    clickhouse: [
      { label: "now()", value: "now()" },
      { label: "today()", value: "today()" },
    ],
    informix: [
      { label: "CURRENT", value: "CURRENT" },
      { label: "TODAY", value: "TODAY" },
    ],
  };

  return [...universal, ...(dialectPresets[context.dialect] ?? [])];
}

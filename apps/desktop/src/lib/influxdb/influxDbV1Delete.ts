import type { CellValue } from "@/lib/dataGrid/cellValue";
import type { ColumnInfo, ConnectionConfig } from "@/types/database";

export const INFLUXDB_V1_TIME_COLUMN_EXTRA = "influxdb:time";
export const INFLUXDB_V1_TAG_COLUMN_EXTRA = "influxdb:tag";
export const INFLUXDB_V1_FIELD_COLUMN_EXTRA = "influxdb:field";
export const INFLUXDB_V1_AMBIGUOUS_COLUMN_EXTRA = "influxdb:ambiguous";

const INFLUXDB_MIN_TIMESTAMP = -9_223_372_036_854_775_806n;
const INFLUXDB_MAX_TIMESTAMP = 9_223_372_036_854_775_806n;

export interface InfluxDbV1DeleteTarget {
  measurement: string;
  resultColumns: string[];
  timeColumnIndex: number;
  tagColumns: Array<{ name: string; resultColumnIndex: number }>;
  integerTimeIsNanoseconds: boolean;
}

export interface InfluxDbV1DeleteChanges {
  dirtyRows: ReadonlyMap<number, ReadonlyMap<number, CellValue>>;
  newRows: readonly (readonly CellValue[])[];
  deletedRows: ReadonlySet<number>;
  columns: readonly string[];
  rows: readonly (readonly CellValue[])[];
}

function configuredInfluxDbVersion(connection: Pick<ConnectionConfig, "db_type" | "external_config">): string | undefined {
  const external = connection.external_config;
  if (external == null) return undefined;
  if (typeof external !== "object" || Array.isArray(external)) return "unknown";
  const version = (external as Record<string, unknown>).version;
  if (version == null) return undefined;
  if (typeof version === "number") return String(version);
  return typeof version === "string" ? version.trim().toLowerCase() : "unknown";
}

/** Legacy InfluxDB connections without a version marker are v1, matching the Rust driver. */
export function isInfluxDbV1Connection(connection: Pick<ConnectionConfig, "db_type" | "external_config"> | undefined): boolean {
  if (connection?.db_type !== "influxdb") return false;
  const version = configuredInfluxDbVersion(connection);
  return version === undefined || version === "1" || version === "v1";
}

function influxColumnRole(column: Pick<ColumnInfo, "extra">): "time" | "tag" | "field" | "ambiguous" | undefined {
  switch (column.extra?.trim().toLowerCase()) {
    case INFLUXDB_V1_TIME_COLUMN_EXTRA:
      return "time";
    case INFLUXDB_V1_TAG_COLUMN_EXTRA:
      return "tag";
    case INFLUXDB_V1_FIELD_COLUMN_EXTRA:
      return "field";
    case INFLUXDB_V1_AMBIGUOUS_COLUMN_EXTRA:
      return "ambiguous";
    default:
      return undefined;
  }
}

function singleColumnIndex(columns: readonly string[], name: string): number | undefined {
  let found: number | undefined;
  for (let index = 0; index < columns.length; index++) {
    if (columns[index] !== name) continue;
    if (found !== undefined) return undefined;
    found = index;
  }
  return found;
}

function integerTimeIsNanoseconds(urlParams: string | undefined): boolean {
  if (!urlParams) return false;
  const params = new URLSearchParams(urlParams.startsWith("?") ? urlParams.slice(1) : urlParams);
  const epochs = params.getAll("epoch").map((value) => value.trim().toLowerCase());
  return epochs.length === 1 && epochs[0] === "ns";
}

/**
 * Resolves the only result shape that may use the guarded delete path.
 *
 * The InfluxDB driver annotates schema metadata with explicit column roles.
 * Requiring those roles, exact column names, and every tag prevents an aliased,
 * computed, stale, or otherwise ambiguous result from being treated as points.
 */
export function resolveInfluxDbV1DeleteTarget(options: { connection: Pick<ConnectionConfig, "db_type" | "external_config" | "url_params"> | undefined; measurement: string | undefined; tableColumns: readonly ColumnInfo[]; resultColumns: readonly string[] }): InfluxDbV1DeleteTarget | undefined {
  if (!options.connection || !isInfluxDbV1Connection(options.connection) || options.measurement === undefined || options.measurement.length === 0 || options.tableColumns.length === 0 || options.resultColumns.length === 0) {
    return undefined;
  }

  const metadataByName = new Map<string, ColumnInfo>();
  let timeColumn: ColumnInfo | undefined;
  const tagColumns: ColumnInfo[] = [];
  for (const column of options.tableColumns) {
    if (!column.name || metadataByName.has(column.name)) return undefined;
    const role = influxColumnRole(column);
    if (!role || role === "ambiguous") return undefined;
    metadataByName.set(column.name, column);
    if (role === "time") {
      if (timeColumn || column.name !== "time" || !column.is_primary_key) return undefined;
      timeColumn = column;
    } else if (role === "tag") {
      if (!column.is_primary_key) return undefined;
      tagColumns.push(column);
    } else if (column.is_primary_key) {
      return undefined;
    }
  }
  if (!timeColumn) return undefined;

  const resultColumnNames = new Set<string>();
  for (const column of options.resultColumns) {
    if (resultColumnNames.has(column) || !metadataByName.has(column)) return undefined;
    resultColumnNames.add(column);
  }

  const timeColumnIndex = singleColumnIndex(options.resultColumns, timeColumn.name);
  if (timeColumnIndex === undefined) return undefined;
  const resolvedTags: InfluxDbV1DeleteTarget["tagColumns"] = [];
  for (const tag of tagColumns) {
    const resultColumnIndex = singleColumnIndex(options.resultColumns, tag.name);
    if (resultColumnIndex === undefined) return undefined;
    resolvedTags.push({ name: tag.name, resultColumnIndex });
  }

  return {
    measurement: options.measurement,
    resultColumns: [...options.resultColumns],
    timeColumnIndex,
    tagColumns: resolvedTags,
    integerTimeIsNanoseconds: integerTimeIsNanoseconds(options.connection.url_params),
  };
}

function quoteInfluxIdentifier(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`;
}

function quoteInfluxString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("'", "\\'")}'`;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validRfc3339Timestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]! || hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  const milliseconds = Date.parse(`${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${secondText}${zone}`);
  if (!Number.isFinite(milliseconds)) return false;
  const nanoseconds = BigInt(milliseconds) * 1_000_000n + BigInt((fractionText ?? "").padEnd(9, "0") || "0");
  return nanoseconds >= INFLUXDB_MIN_TIMESTAMP && nanoseconds <= INFLUXDB_MAX_TIMESTAMP;
}

function influxTimeLiteral(value: CellValue, integerTimeIsNanoseconds: boolean): string | undefined {
  if (typeof value === "string") {
    if (validRfc3339Timestamp(value)) return quoteInfluxString(value);
    if (!integerTimeIsNanoseconds || !/^-?\d+$/.test(value)) return undefined;
    try {
      const timestamp = BigInt(value);
      return timestamp >= INFLUXDB_MIN_TIMESTAMP && timestamp <= INFLUXDB_MAX_TIMESTAMP ? timestamp.toString() : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || !integerTimeIsNanoseconds) return undefined;
  const timestamp = BigInt(value);
  return timestamp >= INFLUXDB_MIN_TIMESTAMP && timestamp <= INFLUXDB_MAX_TIMESTAMP ? timestamp.toString() : undefined;
}

function deleteCondition(target: InfluxDbV1DeleteTarget, row: readonly CellValue[]): string {
  if (row.length !== target.resultColumns.length) throw new Error("Cannot safely delete this InfluxDB point because the result row shape does not match its columns.");
  const time = influxTimeLiteral(row[target.timeColumnIndex] ?? null, target.integerTimeIsNanoseconds);
  if (!time) throw new Error("Cannot safely delete this InfluxDB point because its time value is missing or invalid.");

  const conditions = [`time = ${time}`];
  // Generic grid delete generators commonly fall back to every visible value
  // when no key exists. That is invalid for InfluxQL: only time and tag keys
  // are legal here, so field-role columns are deliberately never inspected.
  for (const tag of target.tagColumns) {
    const value = row[tag.resultColumnIndex];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Cannot safely delete this InfluxDB point because tag ${quoteInfluxIdentifier(tag.name)} is missing or invalid.`);
    }
    conditions.push(`${quoteInfluxIdentifier(tag.name)} = ${quoteInfluxString(value)}`);
  }
  return conditions.join(" AND ");
}

export function canDeleteInfluxDbV1Row(target: InfluxDbV1DeleteTarget, row: readonly CellValue[]): boolean {
  try {
    deleteCondition(target, row);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds one InfluxQL DELETE statement per point. InfluxDB 1.x rejects time
 * conditions joined through OR, so multi-row deletion cannot safely be folded
 * into one predicate. Callers must stop on the first failure and refresh after
 * an error because earlier statements may already have succeeded.
 */
export function buildInfluxDbV1DeleteStatements(target: InfluxDbV1DeleteTarget, changes: InfluxDbV1DeleteChanges): string[] {
  if (changes.dirtyRows.size > 0 || changes.newRows.length > 0) {
    throw new Error("InfluxDB result rows are delete-only; field and tag values cannot be edited or inserted here.");
  }
  if (changes.columns.length !== target.resultColumns.length || changes.columns.some((column, index) => column !== target.resultColumns[index])) {
    throw new Error("Cannot safely delete InfluxDB points because the result columns changed.");
  }
  if (changes.deletedRows.size === 0) return [];

  const conditions: string[] = [];
  const uniqueTargets = new Set<string>();
  for (const rowIndex of [...changes.deletedRows].sort((left, right) => left - right)) {
    if (!Number.isInteger(rowIndex) || rowIndex < 0) throw new Error("Cannot safely delete an InfluxDB point with an invalid row index.");
    const row = changes.rows[rowIndex];
    if (!row) throw new Error("Cannot safely delete an InfluxDB point that is no longer present in the result.");
    const condition = deleteCondition(target, row);
    if (uniqueTargets.has(condition)) {
      throw new Error("Cannot safely delete InfluxDB points because the selected rows contain a duplicate target.");
    }
    uniqueTargets.add(condition);
    conditions.push(`(${condition})`);
  }

  const measurement = quoteInfluxIdentifier(target.measurement);
  return conditions.map((condition) => `DELETE FROM ${measurement} WHERE ${condition};`);
}

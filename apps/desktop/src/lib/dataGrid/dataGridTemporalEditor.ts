import type { ColumnInfo, DatabaseType } from "@/types/database";

export type TemporalCellEditorKind = "date" | "time" | "datetime";
export type TemporalCellEditorColumn = Pick<ColumnInfo, "data_type" | "numeric_scale">;

export interface TemporalCellEditorConfig {
  kind: TemporalCellEditorKind;
  fractionPrecision: number;
}

export function temporalCellEditorConfig(columnOrDataType: string | TemporalCellEditorColumn | undefined, _databaseType?: DatabaseType): TemporalCellEditorConfig | undefined {
  const dataType = temporalColumnDataType(columnOrDataType);
  const numericScale = temporalColumnNumericScale(columnOrDataType);
  const normalized = normalizeTemporalType(dataType);
  if (!normalized) return undefined;
  if (/\b(?:datetime|datetime2|datetime64|smalldatetime|datetimeoffset|timestamp|timestamptz)\b/.test(normalized)) {
    return {
      kind: "datetime",
      fractionPrecision: normalized.includes("smalldatetime") ? 0 : temporalFractionPrecision(dataType, numericScale),
    };
  }
  if (/\bdate(?:32)?\b/.test(normalized)) return { kind: "date", fractionPrecision: 0 };
  if (/\b(?:time|timetz|time64)\b/.test(normalized)) {
    return {
      kind: "time",
      fractionPrecision: temporalFractionPrecision(dataType, numericScale),
    };
  }
  return undefined;
}

export function temporalCellEditorKind(dataType: string | undefined, databaseType?: DatabaseType): TemporalCellEditorKind | undefined {
  return temporalCellEditorConfig(dataType, databaseType)?.kind;
}

export function formatTemporalInputValue(value: string | number | boolean | null, kind: TemporalCellEditorKind): string {
  if (value === null || value === undefined) return "";
  const text = String(value).trim();
  if (!text) return "";

  if (kind === "date") {
    const date = text.match(/^(\d{4}-\d{2}-\d{2})/);
    return date?.[1] ?? "";
  }

  if (kind === "time") {
    return normalizeTimeInput(text);
  }

  const datetime = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(\.\d{1,9})?)?/);
  if (!datetime) return "";
  return `${datetime[1]}T${datetime[2]}:${datetime[3] ?? "00"}${datetime[4] ?? ""}`;
}

export function parseTemporalInputValue(value: string, kind: TemporalCellEditorKind): string | null {
  const text = value.trim();
  if (!text) return null;
  if (kind === "date") return text;
  if (kind === "time") return normalizeTimeInput(text) || text;

  const datetime = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2})(\.\d{1,9})?)?$/);
  if (!datetime) return text;
  return `${datetime[1]} ${datetime[2]}:${datetime[3] ?? "00"}${datetime[4] ?? ""}`;
}

export type TemporalCellEditorPart = "year" | "month" | "day" | "hour" | "minute" | "second";

export function stepTemporalInputValue(value: string, kind: TemporalCellEditorKind, part: TemporalCellEditorPart, delta: number): string {
  const dateParts = temporalDateParts(value);
  const timeParts = temporalTimeParts(value, kind);

  if (part === "year") dateParts.year = Math.max(1, Math.min(9999, dateParts.year + delta));
  else if (part === "month") dateParts.month = Math.max(1, Math.min(12, dateParts.month + delta));
  else if (part === "day") dateParts.day = Math.max(1, Math.min(31, dateParts.day + delta));
  else {
    const max = part === "hour" ? 23 : 59;
    timeParts[part] = (timeParts[part] + delta + max + 1) % (max + 1);
  }

  dateParts.day = Math.max(1, Math.min(daysInMonth(dateParts.year, dateParts.month), dateParts.day));
  const dateText = [String(dateParts.year).padStart(4, "0"), String(dateParts.month).padStart(2, "0"), String(dateParts.day).padStart(2, "0")].join("-");
  const timeText = [timeParts.hour, timeParts.minute, timeParts.second].map((item) => String(item).padStart(2, "0")).join(":") + timeParts.fraction;

  if (kind === "date") return dateText;
  if (kind === "time") return timeText;
  return `${dateText} ${timeText}`;
}

function normalizeTemporalType(dataType: string | undefined): string {
  return (dataType ?? "").toLowerCase().replace(/_/g, "").replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
}

function temporalColumnDataType(columnOrDataType: string | TemporalCellEditorColumn | undefined): string | undefined {
  return typeof columnOrDataType === "string" ? columnOrDataType : columnOrDataType?.data_type;
}

function temporalColumnNumericScale(columnOrDataType: string | TemporalCellEditorColumn | undefined): number | null | undefined {
  return typeof columnOrDataType === "string" ? undefined : columnOrDataType?.numeric_scale;
}

function temporalFractionPrecision(dataType: string | undefined, numericScale?: number | null): number {
  if (numericScale !== null && numericScale !== undefined) return clampFractionPrecision(numericScale);
  const precision = dataType?.match(/\((\d{1,2})/)?.[1];
  if (!precision) return 0;
  return clampFractionPrecision(Number(precision));
}

function clampFractionPrecision(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(9, Math.trunc(value)));
}

function normalizeTimeInput(text: string): string {
  const match = text.match(/^(\d{2}:\d{2})(?::(\d{2})(\.\d{1,9})?)?/);
  if (!match) return "";
  return `${match[1]}:${match[2] ?? "00"}${match[3] ?? ""}`;
}

function temporalDateParts(value: string): { year: number; month: number; day: number } {
  const text = formatTemporalInputValue(value, "date");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  }
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

function temporalTimeParts(value: string, kind: TemporalCellEditorKind): { hour: number; minute: number; second: number; fraction: string } {
  const time = kind === "time" ? formatTemporalInputValue(value, "time") || "00:00:00" : formatTemporalInputValue(value, "datetime").split("T")[1] || "00:00:00";
  const match = /^(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?$/.exec(time);
  if (!match) return { hour: 0, minute: 0, second: 0, fraction: "" };
  return { hour: Number(match[1]) || 0, minute: Number(match[2]) || 0, second: Number(match[3]) || 0, fraction: match[4] ?? "" };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

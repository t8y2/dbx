import type { DatabaseType } from "@/types/database";

export type TemporalCellEditorKind = "date" | "time" | "datetime";

export function temporalCellEditorKind(dataType: string | undefined, _databaseType?: DatabaseType): TemporalCellEditorKind | undefined {
  const normalized = normalizeTemporalType(dataType);
  if (!normalized) return undefined;
  if (/\b(?:datetime|datetime2|datetime64|smalldatetime|datetimeoffset|timestamp|timestamptz)\b/.test(normalized)) {
    return "datetime";
  }
  if (/\bdate(?:32)?\b/.test(normalized)) return "date";
  if (/\b(?:time|timetz|time64)\b/.test(normalized)) return "time";
  return undefined;
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

  const datetime = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (!datetime) return "";
  return `${datetime[1]}T${datetime[2]}:${datetime[3] ?? "00"}`;
}

export function parseTemporalInputValue(value: string, kind: TemporalCellEditorKind): string | null {
  const text = value.trim();
  if (!text) return null;
  if (kind === "date") return text;
  if (kind === "time") return normalizeTimeInput(text) || null;

  const [date, time = ""] = text.split("T");
  const normalizedTime = normalizeTimeInput(time);
  return date && normalizedTime ? `${date} ${normalizedTime}` : text.replace("T", " ");
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
  const timeText = [timeParts.hour, timeParts.minute, timeParts.second].map((item) => String(item).padStart(2, "0")).join(":");

  if (kind === "date") return dateText;
  if (kind === "time") return timeText;
  return `${dateText} ${timeText}`;
}

function normalizeTemporalType(dataType: string | undefined): string {
  return (dataType ?? "").toLowerCase().replace(/_/g, "").replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTimeInput(text: string): string {
  const match = text.match(/^(\d{2}:\d{2})(?::(\d{2}))?/);
  if (!match) return "";
  return `${match[1]}:${match[2] ?? "00"}`;
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

function temporalTimeParts(value: string, kind: TemporalCellEditorKind): { hour: number; minute: number; second: number } {
  const time = kind === "time" ? formatTemporalInputValue(value, "time") || "00:00:00" : formatTemporalInputValue(value, "datetime").split("T")[1] || "00:00:00";
  const [hour = "00", minute = "00", second = "00"] = time.split(":");
  return { hour: Number(hour) || 0, minute: Number(minute) || 0, second: Number(second) || 0 };
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

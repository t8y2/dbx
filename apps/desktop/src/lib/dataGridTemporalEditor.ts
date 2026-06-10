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

function normalizeTemporalType(dataType: string | undefined): string {
  return (dataType ?? "").toLowerCase().replace(/_/g, "").replace(/[(),]/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeTimeInput(text: string): string {
  const match = text.match(/^(\d{2}:\d{2})(?::(\d{2}))?/);
  if (!match) return "";
  return `${match[1]}:${match[2] ?? "00"}`;
}

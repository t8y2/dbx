export type RedisMemberDetailFormat = "json" | "text";

export interface RedisMemberDetail {
  text: string;
  rawText: string;
  format: RedisMemberDetailFormat;
  json?: RedisJsonDetail;
}

export interface RedisJsonDetail {
  rawText: string;
  formattedText: string;
  value: unknown;
}

export type RedisMemberDetailKind = "list" | "set" | "hash" | "zset" | "stream";

export const REDIS_MEMBER_DETAIL_SHEET_MIN_WIDTH = 360;
export const REDIS_MEMBER_DETAIL_SHEET_MAX_WIDTH = 900;

export function canEditRedisMemberDetail(kind: RedisMemberDetailKind): boolean {
  return kind !== "stream";
}

export function clampRedisMemberDetailSheetWidth(width: number, viewportWidth: number): number {
  const viewportMax = Math.max(REDIS_MEMBER_DETAIL_SHEET_MIN_WIDTH, viewportWidth - 32);
  return Math.min(Math.min(REDIS_MEMBER_DETAIL_SHEET_MAX_WIDTH, viewportMax), Math.max(REDIS_MEMBER_DETAIL_SHEET_MIN_WIDTH, width));
}

export function formatRedisMemberDetail(value: unknown): RedisMemberDetail {
  if (typeof value === "string") {
    const json = parseRedisJsonDetail(value);
    return json ? { text: json.formattedText, rawText: value, format: "json", json } : { text: value, rawText: value, format: "text" };
  }

  try {
    const formattedText = JSON.stringify(value, null, 2);
    return {
      text: formattedText,
      rawText: formattedText,
      format: "json",
      json: { rawText: formattedText, formattedText, value },
    };
  } catch {
    const text = String(value);
    return { text, rawText: text, format: "text" };
  }
}

export function formatRedisStringValue(value: unknown): string {
  if (typeof value !== "string") return String(value ?? "");
  return formatRedisJsonString(value) ?? value;
}

export function formatRedisCommandResult(value: unknown): string {
  if (typeof value === "string") return formatRedisStringValue(value);
  return JSON.stringify(value, null, 2);
}

function formatRedisJsonString(value: string): string | null {
  return parseRedisJsonDetail(value)?.formattedText ?? null;
}

export function parseRedisJsonDetail(value: unknown): RedisJsonDetail | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!looksLikeJsonContainer(trimmed)) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (!isJsonContainer(parsed)) return null;
    return {
      rawText: value,
      formattedText: JSON.stringify(parsed, null, 2),
      value: parsed,
    };
  } catch {
    return null;
  }
}

function looksLikeJsonContainer(value: string): boolean {
  return (value.startsWith("{") && value.endsWith("}")) || (value.startsWith("[") && value.endsWith("]"));
}

function isJsonContainer(value: unknown): boolean {
  return value !== null && typeof value === "object";
}

export function getRedisMemberSelectionKey(title: string, value: unknown): string {
  return `${title}\n${formatRedisMemberDetail(value).text}`;
}

export function highlightRedisJsonDetail(json: string): string {
  const escaped = json.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return escaped.replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (match) => {
    let cls = "json-number";
    if (match.startsWith('"')) cls = match.endsWith(":") ? "json-key" : "json-string";
    else if (match === "true" || match === "false") cls = "json-boolean";
    else if (match === "null") cls = "json-null";
    return `<span class="${cls}">${match}</span>`;
  });
}

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
    return json ? { text: json.formattedText, rawText: value, format: "json", json } : { text: sanitizeRedisDisplayText(value), rawText: value, format: "text" };
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
  return formatRedisJsonString(value) ?? sanitizeRedisDisplayText(value);
}

export function formatRedisCommandResult(value: unknown): string {
  if (typeof value === "string") return formatRedisStringValue(value);
  return JSON.stringify(value, null, 2);
}

/**
 * Detect if a value is a cluster-aggregated INFO response:
 * `[[addr, infoText], ...]` where each `infoText` starts with `"# "`
 * (the INFO section marker). This is the format produced by the backend
 * in `redis_driver.rs::execute_command` for cluster-mode INFO.
 */
function isRedisClusterInfoValue(value: unknown): value is [string, string][] {
  return Array.isArray(value) && value.length > 0 && (value as unknown[]).every((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === "string" && typeof item[1] === "string" && item[1].startsWith("# "));
}

/**
 * Format a Redis command result for the **command console terminal** (RedisKeyBrowser.vue).
 * Unlike `formatRedisCommandResult` (used by the query result table UI), this function
 * renders cluster-aggregated INFO output as plain text (not JSON), matching the native
 * redis-cli display style.
 *
 * - Cluster INFO `[[addr, infoText], ...]` → `"{addr}\n{infoText}"` per node, joined by newlines.
 * - Plain string → passthrough (handles single-node INFO text correctly).
 * - Everything else → JSON.stringify (arrays, objects, etc.).
 */
export function formatRedisConsoleValue(value: unknown): string {
  if (isRedisClusterInfoValue(value)) {
    return value.map(([addr, info]) => `${addr}\n${info}`).join("\n");
  }
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
  const detail = formatRedisMemberDetail(value);
  return `${title}\n${detail.format === "json" ? detail.text : detail.rawText}`;
}

export function sanitizeRedisDisplayText(value: string): string {
  let output = "";
  for (const ch of value) {
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      output += ch;
      continue;
    }
    if (ch >= " " && ch !== "\u007f" && !isUtf8ControlCharacter(ch)) {
      output += ch;
    }
  }
  return output;
}

function isUtf8ControlCharacter(ch: string): boolean {
  return /\p{Cc}/u.test(ch);
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

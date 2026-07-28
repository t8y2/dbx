import type { BinaryHexViewRow } from "@/lib/dataGrid/binaryHexViewer";
import { buildBinaryHexViewRows } from "@/lib/dataGrid/binaryHexViewer";
import { formatJsonSource, parseJsonPreservingLargeNumbers } from "@/lib/common/safeJsonFormat";
import type { RedisBlob, RedisCollectionPage, RedisHashItem, RedisListItem, RedisSetItem, RedisValue, RedisZsetItem } from "@/lib/backend/api";
import { parseJavaSerializedDetail, type RedisJavaSerializedDetail } from "@/lib/redis/javaSerialized";

export type RedisValueFormat = "utf8" | "ascii" | "binary" | "json" | "javaserialize" | "hex" | "base64";
export type RedisMemberDetailFormat = "json" | "text";

export const REDIS_VALUE_FORMAT_DISPLAY_ORDER: RedisValueFormat[] = ["utf8", "ascii", "binary", "json", "javaserialize", "hex", "base64"];

export interface RedisMemberDetail {
  text: string;
  rawText: string;
  rawLabel: string;
  utf8Text: string;
  asciiText: string;
  binaryText: string;
  format: RedisMemberDetailFormat;
  json?: RedisJsonDetail;
  javaSerialized?: RedisJavaSerializedDetail;
  availableFormats: RedisValueFormat[];
  defaultFormat: RedisValueFormat;
  byteCount: number;
  base64Text: string;
  hexRows: BinaryHexViewRow[];
  editable: boolean;
  binary: boolean;
}

export interface RedisJsonDetail {
  rawText: string;
  formattedText: string;
  value: unknown;
}

export type RedisJsonDraftNormalizationResult =
  | {
      ok: true;
      compactText: string;
    }
  | {
      ok: false;
      error: "invalid_json";
    };

export interface RedisMemberDetailOptions {
  allowJsonText?: boolean;
}

export type RedisMemberDetailKind = "list" | "set" | "hash" | "zset" | "stream";
export type RedisCollectionItem = RedisListItem | RedisSetItem | RedisHashItem | RedisZsetItem;

export const REDIS_MEMBER_DETAIL_SHEET_MIN_WIDTH = 360;
export const REDIS_MEMBER_DETAIL_SHEET_MAX_WIDTH = 900;

export function canEditRedisMemberDetail(kind: RedisMemberDetailKind, value?: unknown): boolean {
  if (kind === "stream") return false;
  if (value == null) return true;
  return !isRedisBlob(value) || value.encoding !== "binary";
}

export function clampRedisMemberDetailSheetWidth(width: number, viewportWidth: number): number {
  const viewportMax = Math.max(REDIS_MEMBER_DETAIL_SHEET_MIN_WIDTH, viewportWidth - 32);
  return Math.min(Math.min(REDIS_MEMBER_DETAIL_SHEET_MAX_WIDTH, viewportMax), Math.max(REDIS_MEMBER_DETAIL_SHEET_MIN_WIDTH, width));
}

export function isRedisBlob(value: unknown): value is RedisBlob {
  return typeof value === "object" && value !== null && "raw_base64" in value && "encoding" in value;
}

export function decodeRedisBlob(blob: RedisBlob): Uint8Array {
  return base64ToBytes(blob.raw_base64);
}

export function redisBlobText(blob: RedisBlob): string | null {
  if (blob.encoding === "binary") return null;
  return decodeUtf8Bytes(decodeRedisBlob(blob));
}

export function redisBlobRawText(blob: RedisBlob): string {
  return redisBlobText(blob) ?? escapeRedisBytes(decodeRedisBlob(blob));
}

export function redisBlobDisplayText(blob: RedisBlob): string {
  return sanitizeRedisDisplayText(redisBlobRawText(blob));
}

export function formatRedisMemberDetail(value: unknown, options: RedisMemberDetailOptions = {}): RedisMemberDetail {
  if (isRedisBlob(value)) return formatRedisBlobDetail(value, options);

  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    const json = options.allowJsonText ? (parseRedisJsonDetail(value) ?? undefined) : undefined;
    const textFormats: RedisValueFormat[] = ["utf8", "ascii", "binary"];
    return {
      text: sanitizeRedisDisplayText(value),
      rawText: value,
      rawLabel: isAsciiBytes(bytes) ? "ASCII" : "UTF-8",
      utf8Text: value,
      asciiText: asciiBytesToText(bytes),
      binaryText: binaryBytesToText(bytes),
      format: "text",
      json,
      availableFormats: formatOrderForValue("utf8", textFormats, json ? ["json"] : []),
      defaultFormat: "utf8",
      byteCount: bytes.byteLength,
      base64Text: bytesToBase64(bytes),
      hexRows: buildBinaryHexViewRows(bytes),
      editable: true,
      binary: false,
    };
  }

  try {
    const formattedText = JSON.stringify(value, null, 2);
    const bytes = new TextEncoder().encode(formattedText);
    return {
      text: formattedText,
      rawText: formattedText,
      rawLabel: "Raw",
      utf8Text: formattedText,
      asciiText: asciiBytesToText(bytes),
      binaryText: binaryBytesToText(bytes),
      format: "json",
      json: { rawText: formattedText, formattedText, value },
      availableFormats: formatOrderForValue("json", ["utf8"], ["json"]),
      defaultFormat: "json",
      byteCount: bytes.byteLength,
      base64Text: bytesToBase64(bytes),
      hexRows: buildBinaryHexViewRows(bytes),
      editable: false,
      binary: false,
    };
  } catch {
    const text = String(value);
    const bytes = new TextEncoder().encode(text);
    return {
      text,
      rawText: text,
      rawLabel: "Raw",
      utf8Text: text,
      asciiText: asciiBytesToText(bytes),
      binaryText: binaryBytesToText(bytes),
      format: "text",
      availableFormats: formatOrderForValue("utf8", ["utf8"], []),
      defaultFormat: "utf8",
      byteCount: bytes.byteLength,
      base64Text: bytesToBase64(bytes),
      hexRows: buildBinaryHexViewRows(bytes),
      editable: false,
      binary: false,
    };
  }
}

export function formatRedisStringValue(value: unknown): string {
  if (isRedisBlob(value)) return formatRedisMemberDetail(value).text;
  if (typeof value !== "string") return String(value ?? "");
  return formatRedisJsonString(value) ?? sanitizeRedisDisplayText(value);
}

export function formatRedisCommandResult(value: unknown): string {
  if (typeof value === "string") return formatRedisStringValue(value);
  return JSON.stringify(value, null, 2);
}

/** RedisJSON source text stays out of JavaScript's numeric representation. */
export function redisJsonValueText(value: { value: string }): string {
  return value.value;
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

export function parseRedisJsonDetail(value: unknown): RedisJsonDetail | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    // Pretty-print from source tokens so duplicate members and number spellings
    // stay intact when Redis string/hash values open in the JSON editor.
    const formattedText = formatJsonSource(trimmed, 2);
    const parsed = parseJsonPreservingLargeNumbers(trimmed);
    return {
      rawText: value,
      formattedText,
      value: parsed,
    };
  } catch {
    return null;
  }
}

/**
 * Validates a JSON editor draft and produces the compact text Redis should
 * store. Source-preserving minification keeps high-precision numbers and
 * duplicate object members intact.
 */
export function normalizeRedisJsonDraft(text: string): RedisJsonDraftNormalizationResult {
  try {
    return { ok: true, compactText: formatJsonSource(text) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

export function preferredRedisValueFormat(value: unknown, preferred?: RedisValueFormat | null, options: RedisMemberDetailOptions = {}): RedisValueFormat {
  const detail = formatRedisMemberDetail(value, options);
  if (preferred && detail.availableFormats.includes(preferred) && shouldReuseRedisValueFormatPreference(detail, preferred)) return preferred;
  return detail.defaultFormat;
}

export function canRenderRedisValueFormat(detail: RedisMemberDetail, format: RedisValueFormat): boolean {
  switch (format) {
    case "json":
      return Boolean(detail.json);
    case "javaserialize":
      return Boolean(detail.javaSerialized);
    default:
      return true;
  }
}

export function redisMemberCopyText(value: unknown): string {
  const text = isRedisBlob(value) ? redisBlobRawText(value) : formatRedisMemberDetail(value).rawText;
  return redisClipboardSafeText(text);
}

export function redisClipboardSafeText(value: string): string {
  let output = "";
  for (const ch of value) {
    if (ch === "\n" || ch === "\r" || ch === "\t" || !isUtf8ControlCharacter(ch)) {
      output += ch;
      continue;
    }

    // Native clipboard text backends may treat embedded controls such as NUL as string terminators.
    // Keep ordinary whitespace intact, but copy other controls as visible byte-style escapes.
    const codePoint = ch.codePointAt(0)!;
    output += codePoint <= 0xff ? `\\x${codePoint.toString(16).padStart(2, "0")}` : `\\u{${codePoint.toString(16)}}`;
  }
  return output;
}

export function getRedisMemberSelectionKey(title: string, value: unknown, identity = title): string {
  if (isRedisBlob(value)) return `${identity}\n${value.raw_base64}`;
  const detail = formatRedisMemberDetail(value);
  return `${identity}\n${detail.rawText}`;
}

export function redisValueCollectionItems(value: RedisValue): RedisCollectionItem[] {
  switch (value.data.kind) {
    case "list":
    case "set":
    case "hash":
    case "zset":
      return value.data.items;
    default:
      return [];
  }
}

export function redisCollectionPageItems(page: RedisCollectionPage): RedisCollectionItem[] {
  return page.items;
}

export function redisValueCollectionTotal(value: RedisValue): number | null {
  switch (value.data.kind) {
    case "list":
    case "set":
    case "hash":
    case "zset":
      return value.data.total;
    default:
      return null;
  }
}

export function redisValueCollectionScanCursor(value: RedisValue): number | undefined {
  switch (value.data.kind) {
    case "list":
    case "set":
    case "hash":
    case "zset":
      return value.data.scan_cursor;
    default:
      return undefined;
  }
}

export function redisValueSize(value: RedisValue): number {
  switch (value.data.kind) {
    case "string":
      return decodeRedisBlob(value.data.content).byteLength;
    case "json":
      return new TextEncoder().encode(redisJsonValueText(value.data)).byteLength;
    case "list":
    case "set":
    case "hash":
    case "zset":
      return value.data.total;
    case "stream":
      return value.data.entries.length;
    default:
      return 0;
  }
}

export function redisValuePreview(value: RedisValue): string {
  switch (value.data.kind) {
    case "string":
      return previewText(redisBlobRawText(value.data.content));
    case "json":
      return previewText(redisJsonValueText(value.data));
    case "list": {
      const first = value.data.items[0];
      return first ? previewText(redisBlobRawText(first.value)) : "";
    }
    case "set": {
      const first = value.data.items[0];
      return first ? previewText(redisBlobRawText(first.member)) : "";
    }
    case "hash": {
      const first = value.data.items[0];
      return first ? previewText(`${redisBlobRawText(first.field)} ${redisBlobRawText(first.value)}`) : "";
    }
    case "zset": {
      const first = value.data.items[0];
      return first ? previewText(`${first.score} ${redisBlobRawText(first.member)}`) : "";
    }
    case "stream": {
      const first = value.data.entries[0];
      if (!first) return "";
      const joined = first.fields.map(({ field, value: entryValue }) => `${field} ${entryValue}`).join(" ");
      return previewText(joined);
    }
    default:
      return "";
  }
}

export function redisValueCopyText(value: RedisValue, collectionItems: RedisCollectionItem[] = redisValueCollectionItems(value)): string {
  switch (value.data.kind) {
    case "string":
      return redisBlobRawText(value.data.content);
    case "json": {
      const rawText = redisJsonValueText(value.data);
      try {
        return formatJsonSource(rawText, 2);
      } catch {
        return rawText;
      }
    }
    case "list":
      return JSON.stringify(
        (collectionItems as RedisListItem[]).map((item) => redisBlobRawText(item.value)),
        null,
        2,
      );
    case "set":
      return JSON.stringify(
        (collectionItems as RedisSetItem[]).map((item) => redisBlobRawText(item.member)),
        null,
        2,
      );
    case "hash":
      return JSON.stringify(
        (collectionItems as RedisHashItem[]).map((item) => ({
          field: redisBlobRawText(item.field),
          value: redisBlobRawText(item.value),
        })),
        null,
        2,
      );
    case "zset":
      return JSON.stringify(
        (collectionItems as RedisZsetItem[]).map((item) => ({
          score: item.score,
          member: redisBlobRawText(item.member),
        })),
        null,
        2,
      );
    case "stream":
      return JSON.stringify(
        value.data.entries.map((entry) => ({
          id: entry.id,
          fields: entry.fields.map((field) => ({
            field: field.field,
            value: field.value,
          })),
        })),
        null,
        2,
      );
    default:
      return JSON.stringify(value.data, null, 2);
  }
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

function formatRedisBlobDetail(blob: RedisBlob, options: RedisMemberDetailOptions): RedisMemberDetail {
  const bytes = decodeRedisBlob(blob);
  const strictUtf8Text = blob.encoding === "binary" ? null : decodeUtf8Bytes(bytes);
  const utf8Text = strictUtf8Text ?? decodeUtf8BytesLossy(bytes);
  const asciiText = asciiBytesToText(bytes);
  const binaryText = binaryBytesToText(bytes);
  const rawText = strictUtf8Text ?? binaryText;
  const javaSerialized = parseJavaSerializedDetail(bytes);
  const defaultFormat: RedisValueFormat = javaSerialized ? "javaserialize" : strictUtf8Text != null ? "utf8" : "hex";
  const json = options.allowJsonText && strictUtf8Text != null ? (parseRedisJsonDetail(strictUtf8Text) ?? undefined) : undefined;
  const textFormats: RedisValueFormat[] = strictUtf8Text != null ? ["utf8", "ascii", "binary"] : ["binary"];
  const extraFormats: RedisValueFormat[] = [];
  if (json) extraFormats.push("json");
  if (javaSerialized) extraFormats.push("javaserialize");
  return {
    text: redisBlobDisplayText(blob),
    rawText,
    rawLabel: blob.encoding === "binary" ? "Binary" : isAsciiBytes(bytes) ? "ASCII" : "UTF-8",
    utf8Text,
    asciiText,
    binaryText,
    format: "text",
    json,
    javaSerialized: javaSerialized ?? undefined,
    availableFormats: formatOrderForValue(defaultFormat, textFormats, extraFormats),
    defaultFormat,
    byteCount: bytes.byteLength,
    base64Text: blob.raw_base64,
    hexRows: buildBinaryHexViewRows(bytes),
    editable: strictUtf8Text != null,
    binary: strictUtf8Text == null,
  };
}

function formatRedisJsonString(value: string): string | null {
  return parseRedisJsonDetail(value)?.formattedText ?? null;
}

function formatOrderForValue(defaultFormat: RedisValueFormat, textFormats: RedisValueFormat[], extraFormats: RedisValueFormat[]): RedisValueFormat[] {
  const availableFormats: RedisValueFormat[] = [...textFormats];
  availableFormats.push(...extraFormats);
  availableFormats.push("hex", "base64");
  return [defaultFormat, ...availableFormats.filter((format) => format !== defaultFormat)];
}

function shouldReuseRedisValueFormatPreference(detail: RedisMemberDetail, format: RedisValueFormat): boolean {
  if (!detail.editable) return true;
  return format === "utf8" || format === "json";
}

function previewText(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 160)}…` : singleLine;
}

function isUtf8ControlCharacter(ch: string): boolean {
  return /\p{Cc}/u.test(ch);
}

function escapeRedisBytes(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    if (byte === 0x5c) {
      output += "\\\\";
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      output += String.fromCharCode(byte);
      continue;
    }
    output += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return output;
}

function decodeUtf8Bytes(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeUtf8BytesLossy(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function asciiBytesToText(bytes: Uint8Array): string {
  let output = "";
  for (const byte of bytes) {
    if (byte === 0x0a) {
      output += "\n";
      continue;
    }
    if (byte === 0x0d) {
      output += "\r";
      continue;
    }
    if (byte === 0x09) {
      output += "\t";
      continue;
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      output += String.fromCharCode(byte);
      continue;
    }
    output += `\\x${byte.toString(16).padStart(2, "0")}`;
  }
  return output;
}

function binaryBytesToText(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(2).padStart(8, "0")).join("");
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob !== "function") throw new Error("Base64 decoding is unavailable in this runtime");
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa !== "function") throw new Error("Base64 encoding is unavailable in this runtime");
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function isAsciiBytes(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte <= 0x7f);
}

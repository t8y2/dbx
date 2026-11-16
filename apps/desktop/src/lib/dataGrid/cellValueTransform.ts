import { formatJsonSource } from "@/lib/common/safeJsonFormat";
import { formatXmlSource } from "@/lib/common/xmlFormat";
import { applyColumnFormatter, DataGridDateTimePatterns } from "@/lib/dataGrid/columnFormatter";

export const CELL_TRANSFORM_MAX_INPUT = 50_000;
export const CELL_TRANSFORM_MAX_OUTPUT = 200_000;
export const CELL_TRANSFORM_MAX_RADIX_DIGITS = 4_096;
/** Base64 二进制转换的输入字符上限（约 7.5MB 解码字节），与 BLOB 下载路径的量级一致。 */
export const CELL_TRANSFORM_MAX_BINARY_INPUT = 10_000_000;
export const CELL_TRANSFORM_KINDS = ["timestamp", "json", "jsonCompact", "xml", "html", "base64Encode", "base64Decode", "base64Image", "base64File", "urlEncode", "urlDecode", "radix"] as const;
export type CellTransformKind = (typeof CELL_TRANSFORM_KINDS)[number];
export const BINARY_CELL_TRANSFORM_KINDS: readonly CellTransformKind[] = ["base64Image", "base64File"];
export type CellTransformError = "tooLarge" | "invalid" | "invalidTimestamp" | "ambiguousUnit" | "invalidInteger" | "invalidBase64";
export interface CellTransformOptions {
  kind: CellTransformKind;
  unit?: "auto" | "seconds" | "milliseconds";
  timezone?: string;
  pattern?: string;
  fromBase?: number;
  toBase?: number;
}
export interface CellTransformBinaryResult {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
  isImage: boolean;
  /** False when neither magic bytes nor a declared data-URI MIME identified the payload; the UI lets the user pick a format. */
  recognized: boolean;
}
export type CellTransformResult = { ok: true; text: string; unit?: "seconds" | "milliseconds" } | { ok: true; binary: CellTransformBinaryResult } | { ok: false; error: CellTransformError };

function fail(error: CellTransformError): never {
  throw new TransformError(error);
}
class TransformError extends Error {
  constructor(readonly code: CellTransformError) {
    super(code);
  }
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Cells often store `data:image/png;base64,...` instead of bare base64; strip the URI prefix before decoding.
const DATA_URI_RE = /^data:([^,]*);base64,/i;

function splitDataUri(source: string): { payload: string; declaredMime: string | null } {
  const match = DATA_URI_RE.exec(source);
  if (!match) return { payload: source, declaredMime: null };
  const mime = (match[1] ?? "").split(";")[0].trim().toLowerCase();
  return { payload: source.slice(match[0].length), declaredMime: mime || null };
}

function decodeBase64Bytes(source: string): Uint8Array {
  // Auto-normalize the ways base64 shows up in cells: leading/trailing whitespace, an optional
  // data URI prefix, MIME-style line wrapping, base64url alphabets, and omitted `=` padding.
  let input = splitDataUri(source.trim()).payload.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const remainder = input.length % 4;
  // Truncated cell payloads often end in one orphan character that cannot encode a byte; drop it.
  if (remainder === 1) input = input.slice(0, -1);
  else if (remainder > 1) input += "=".repeat(4 - remainder);
  if (!BASE64_RE.test(input)) fail("invalidBase64");
  const binary = atob(input);
  if (btoa(binary) !== input) fail("invalidBase64");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

interface BinaryFormat {
  mimeType: string;
  extension: string;
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[], offset = 0): boolean {
  return prefix.every((byte, index) => bytes[offset + index] === byte);
}

const IMAGE_FORMATS: { format: BinaryFormat; match: (bytes: Uint8Array) => boolean }[] = [
  { format: { mimeType: "image/png", extension: "png" }, match: (bytes) => startsWithBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { format: { mimeType: "image/jpeg", extension: "jpg" }, match: (bytes) => startsWithBytes(bytes, [0xff, 0xd8, 0xff]) },
  { format: { mimeType: "image/gif", extension: "gif" }, match: (bytes) => startsWithBytes(bytes, [0x47, 0x49, 0x46, 0x38]) },
  { format: { mimeType: "image/webp", extension: "webp" }, match: (bytes) => startsWithBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWithBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8) },
  { format: { mimeType: "image/bmp", extension: "bmp" }, match: (bytes) => startsWithBytes(bytes, [0x42, 0x4d]) },
  { format: { mimeType: "image/x-icon", extension: "ico" }, match: (bytes) => startsWithBytes(bytes, [0x00, 0x00, 0x01, 0x00]) },
];

const OTHER_FILE_FORMATS: { format: BinaryFormat; match: (bytes: Uint8Array) => boolean }[] = [
  { format: { mimeType: "application/pdf", extension: "pdf" }, match: (bytes) => startsWithBytes(bytes, [0x25, 0x50, 0x44, 0x46]) },
  { format: { mimeType: "application/zip", extension: "zip" }, match: (bytes) => startsWithBytes(bytes, [0x50, 0x4b, 0x03, 0x04]) },
  { format: { mimeType: "application/gzip", extension: "gz" }, match: (bytes) => startsWithBytes(bytes, [0x1f, 0x8b]) },
];

/** Formats the user can pick manually when auto-detection fails. */
export const CELL_TRANSFORM_FORMAT_CHOICES: readonly BinaryFormat[] = [...IMAGE_FORMATS.map((entry) => entry.format), ...OTHER_FILE_FORMATS.map((entry) => entry.format), { mimeType: "text/plain", extension: "txt" }, { mimeType: "application/octet-stream", extension: "bin" }];

function detectImageFormat(bytes: Uint8Array): BinaryFormat | null {
  return IMAGE_FORMATS.find((candidate) => candidate.match(bytes))?.format ?? null;
}

function detectFileFormat(bytes: Uint8Array): { format: BinaryFormat; isImage: boolean } {
  const image = detectImageFormat(bytes);
  if (image) return { format: image, isImage: true };
  const other = OTHER_FILE_FORMATS.find((candidate) => candidate.match(bytes));
  return { format: other?.format ?? { mimeType: "application/octet-stream", extension: "bin" }, isImage: false };
}

function formatFromMime(mimeType: string | null): BinaryFormat | null {
  if (!mimeType) return null;
  return [...IMAGE_FORMATS, ...OTHER_FILE_FORMATS].find((candidate) => candidate.format.mimeType === mimeType)?.format ?? null;
}

/** Pure, opt-in text conversion. Never feed this result into the cell commit path. */
export function transformCellValue(source: string, options: CellTransformOptions): CellTransformResult {
  const maxInput = BINARY_CELL_TRANSFORM_KINDS.includes(options.kind) ? CELL_TRANSFORM_MAX_BINARY_INPUT : CELL_TRANSFORM_MAX_INPUT;
  if (source.length > maxInput) return { ok: false, error: "tooLarge" };
  try {
    let text: string;
    let unit: "seconds" | "milliseconds" | undefined;
    switch (options.kind) {
      case "timestamp": {
        const input = source.trim();
        if (!/^[+-]?\d+$/.test(input)) fail("invalidTimestamp");
        unit = options.unit === "seconds" || options.unit === "milliseconds" ? options.unit : undefined;
        if (!unit) {
          const digits = input.replace(/^[+-]/, "").length;
          if (digits !== 10 && digits !== 13) fail("ambiguousUnit");
          unit = digits === 10 ? "seconds" : "milliseconds";
        }
        const value = Number(input);
        const milliseconds = unit === "seconds" ? value * 1000 : value;
        if (!Number.isSafeInteger(value) || !Number.isSafeInteger(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000) fail("invalidTimestamp");
        const timezone = options.timezone === undefined ? "UTC" : options.timezone.trim();
        new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
        const pattern = options.pattern || "YYYY-MM-DD HH:mm:ss";
        if (!DataGridDateTimePatterns.includes(pattern)) fail("invalidTimestamp");
        text = applyColumnFormatter(value, { kind: "datetime", unit, timezone, pattern });
        // Column formatters intentionally fall back to the raw value. A conversion
        // must surface failure instead of presenting that fallback as a result.
        if (text === String(value) || text === "Invalid Date") fail("invalidTimestamp");
        break;
      }
      case "json":
        text = formatJsonSource(source, 2);
        break;
      case "jsonCompact":
        text = formatJsonSource(source);
        break;
      case "xml":
        text = formatXmlSource(source);
        break;
      case "html":
        text = source;
        break;
      case "urlEncode":
        text = encodeURIComponent(source);
        break;
      case "urlDecode":
        text = decodeURIComponent(source);
        break;
      case "base64Encode": {
        // Reject lone surrogates rather than silently replacing them during UTF-8 encoding.
        encodeURIComponent(source);
        const bytes = new TextEncoder().encode(source);
        text = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));
        break;
      }
      case "base64Decode": {
        const bytes = decodeBase64Bytes(source);
        try {
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          fail("invalidBase64");
        }
        break;
      }
      case "base64Image":
      case "base64File": {
        const bytes = decodeBase64Bytes(source);
        const detected = detectFileFormat(bytes);
        let format = detected.format;
        let isImage = detected.isImage;
        if (format.extension === "bin") {
          const declared = formatFromMime(splitDataUri(source).declaredMime);
          if (declared) {
            format = declared;
            isImage = IMAGE_FORMATS.some((candidate) => candidate.format.mimeType === declared.mimeType);
          }
        }
        return { ok: true, binary: { bytes, ...format, isImage, recognized: format.extension !== "bin" } };
      }
      case "radix": {
        const from = options.fromBase ?? 10;
        const to = options.toBase ?? 16;
        if (![2, 8, 10, 16].includes(from) || ![2, 8, 10, 16].includes(to)) fail("invalidInteger");
        const input = source.trim();
        if (input.length > CELL_TRANSFORM_MAX_RADIX_DIGITS) fail("tooLarge");
        const sign = input.startsWith("-") ? -1n : 1n;
        const digits = input.replace(/^[+-]/, "");
        const valid = from === 2 ? /^[01]+$/ : from === 8 ? /^[0-7]+$/ : from === 10 ? /^\d+$/ : /^[0-9a-f]+$/i;
        if (!valid.test(digits)) fail("invalidInteger");
        const prefix = from === 2 ? "0b" : from === 8 ? "0o" : from === 16 ? "0x" : "";
        text = (sign * BigInt(prefix + digits)).toString(to);
        break;
      }
      default:
        return { ok: false, error: "invalid" };
    }
    return text.length > CELL_TRANSFORM_MAX_OUTPUT ? { ok: false, error: "tooLarge" } : { ok: true, text, ...(unit ? { unit } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof TransformError ? error.code : "invalid" };
  }
}

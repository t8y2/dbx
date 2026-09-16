import { formatJsonSource } from "@/lib/common/safeJsonFormat";
import { formatXmlSource } from "@/lib/common/xmlFormat";
import { applyColumnFormatter, DataGridDateTimePatterns } from "@/lib/dataGrid/columnFormatter";

export const CELL_TRANSFORM_MAX_INPUT = 50_000;
export const CELL_TRANSFORM_MAX_OUTPUT = 200_000;
export const CELL_TRANSFORM_MAX_RADIX_DIGITS = 4_096;
export const CELL_TRANSFORM_KINDS = ["timestamp", "json", "jsonCompact", "xml", "base64Encode", "base64Decode", "urlEncode", "urlDecode", "radix"] as const;
export type CellTransformKind = (typeof CELL_TRANSFORM_KINDS)[number];
export type CellTransformError = "tooLarge" | "invalid" | "invalidTimestamp" | "ambiguousUnit" | "invalidInteger" | "invalidBase64";
export interface CellTransformOptions {
  kind: CellTransformKind;
  unit?: "auto" | "seconds" | "milliseconds";
  timezone?: string;
  pattern?: string;
  fromBase?: number;
  toBase?: number;
}
export type CellTransformResult = { ok: true; text: string; unit?: "seconds" | "milliseconds" } | { ok: false; error: CellTransformError };

function fail(error: CellTransformError): never {
  throw new TransformError(error);
}
class TransformError extends Error {
  constructor(readonly code: CellTransformError) {
    super(code);
  }
}

/** Pure, opt-in text conversion. Never feed this result into the cell commit path. */
export function transformCellValue(source: string, options: CellTransformOptions): CellTransformResult {
  if (source.length > CELL_TRANSFORM_MAX_INPUT) return { ok: false, error: "tooLarge" };
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
        const input = source.replace(/\s/g, "");
        if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) fail("invalidBase64");
        const binary = atob(input);
        if (btoa(binary) !== input) fail("invalidBase64");
        try {
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
        } catch {
          fail("invalidBase64");
        }
        break;
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

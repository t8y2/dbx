import type { CellValue } from "@/lib/cellValue";
import { isBinaryCellColumnType, parseBinaryCellBytes } from "@/lib/binaryCellDownload";

const IMAGE_PATH_RE = /\.(?:png|jpe?g|webp|gif|avif|bmp|svg)$/i;
const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
const MAX_BINARY_IMAGE_PREVIEW_BYTES = 8 * 1024 * 1024;
const HEX_PREFIX_RE = /^(?:0[xX]|\\x)([0-9a-fA-F\s]+)$/;
const HEX_ESCAPE_RE = /^(?:\\x[0-9a-fA-F]{2}|\s)+$/;
const BARE_HEX_RE = /^[0-9a-fA-F\s]+$/;

function isLocalHttpHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export interface CellImagePreviewOptions {
  binary?: boolean;
}

export function cellImagePreviewUrl(value: CellValue | unknown, columnType?: string, options: CellImagePreviewOptions = {}): string | null {
  const binaryPreviewUrl = options.binary === false ? null : binaryImagePreviewUrl(value, columnType);
  if (binaryPreviewUrl) return binaryPreviewUrl;

  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (SAFE_DATA_IMAGE_RE.test(text)) return text;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!IMAGE_PATH_RE.test(url.pathname)) return null;
  return text;
}

function binaryImagePreviewUrl(value: unknown, columnType?: string): string | null {
  if (estimatedBinaryByteLength(value, columnType) > MAX_BINARY_IMAGE_PREVIEW_BYTES) return null;
  const bytes = parseBinaryCellBytes(value, columnType);
  if (!bytes || bytes.length > MAX_BINARY_IMAGE_PREVIEW_BYTES) return null;
  const mimeType = detectImageMimeType(bytes);
  if (!mimeType) return null;
  return `data:${mimeType};base64,${bytesToBase64(bytes)}`;
}

function estimatedBinaryByteLength(value: unknown, columnType?: string): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)) {
    return (value as { data: unknown[] }).data.length;
  }
  if (typeof value !== "string") return 0;

  const trimmed = value.trim();
  const prefixed = trimmed.match(HEX_PREFIX_RE);
  if (prefixed) return prefixed[1].replace(/\s+/g, "").length / 2;
  if (HEX_ESCAPE_RE.test(trimmed)) return trimmed.replace(/\s+/g, "").replace(/\\x/gi, "").length / 2;
  if (isBinaryCellColumnType(columnType) && BARE_HEX_RE.test(trimmed)) return trimmed.replace(/\s+/g, "").length / 2;
  return 0;
}

function detectImageMimeType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (asciiAt(bytes, 0, "GIF87a") || asciiAt(bytes, 0, "GIF89a")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) return "image/webp";
  if (startsWith(bytes, [0x42, 0x4d])) return "image/bmp";
  if (asciiAt(bytes, 4, "ftyp") && (asciiAt(bytes, 8, "avif") || asciiAt(bytes, 8, "avis"))) return "image/avif";
  return safeSvgMimeType(bytes);
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  if (bytes.length < offset + value.length) return false;
  for (let i = 0; i < value.length; i++) {
    if (bytes[offset + i] !== value.charCodeAt(i)) return false;
  }
  return true;
}

function safeSvgMimeType(bytes: Uint8Array): string | null {
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (!/^(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(trimmed.slice(0, 2048))) {
    return null;
  }
  if (/<\s*script\b/i.test(text) || /<\s*foreignObject\b/i.test(text) || /\son[a-z]+\s*=/i.test(text) || /\b(?:href|xlink:href|src)\s*=\s*["']?\s*javascript:/i.test(text)) {
    return null;
  }
  return "image/svg+xml";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

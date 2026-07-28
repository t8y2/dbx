import type { CellValue } from "@/lib/dataGrid/cellValue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export type BinaryCellDownloadMode = "binary" | "utf8" | "gbk";

export interface BinaryCellPosition {
  rowIndex: number;
  col: number;
}

export interface BinaryCellDownloadPayload {
  data: Uint8Array | string;
  mimeType: string;
  extension: string;
}

export interface BinaryCellDownloadResult {
  kind: "saved" | "browser-download" | "cancelled";
  path?: string;
  fileName?: string;
}

export const BINARY_CELL_DOWNLOAD_MODES: BinaryCellDownloadMode[] = ["binary", "utf8", "gbk"];

export function retainBinaryCellDownloadMenuForHover(openCell: BinaryCellPosition | null, hoveredCell: BinaryCellPosition): BinaryCellPosition | null {
  return openCell?.rowIndex === hoveredCell.rowIndex && openCell.col === hoveredCell.col ? openCell : null;
}

const HEX_VALUE_RE = /^(?:0[xX]|\\x)([0-9a-fA-F\s]+)$/;
const BARE_HEX_RE = /^[0-9a-fA-F\s]+$/;
const HEX_ESCAPE_RE = /^(?:\\x[0-9a-fA-F]{2}|\s)+$/;
const BINARY_TYPE_RE = /^(?:blob|tinyblob|mediumblob|longblob|bytea|bytes|binary|varbinary|image|raw|long\s+raw)(?:\b|\()/i;

function copyBytesForBlob(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

export function parseBinaryCellHexValue(value: CellValue): Uint8Array | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(HEX_VALUE_RE);
  if (!match) return null;

  return bytesFromHex(match[1]);
}

function bytesFromHex(value: string): Uint8Array | null {
  const hex = value.replace(/\s+/g, "");
  if (!hex || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const parsed = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(parsed)) return null;
    bytes[i] = parsed;
  }
  return bytes;
}

function bytesFromByteArray(value: unknown): Uint8Array | null {
  if (!Array.isArray(value)) return null;
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (!Number.isInteger(item) || item < 0 || item > 255) return null;
    bytes[i] = item;
  }
  return bytes;
}

function bytesFromBufferLikeObject(value: unknown): Uint8Array | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  return bytesFromByteArray(data);
}

export function parseBinaryCellBytes(value: unknown, columnType?: string): Uint8Array | null {
  if (typeof value === "string") {
    const prefixed = parseBinaryCellHexValue(value);
    if (prefixed) return prefixed;

    const trimmed = value.trim();
    if (HEX_ESCAPE_RE.test(trimmed)) {
      return bytesFromHex(trimmed.replace(/\\x/gi, ""));
    }

    if (isBinaryCellColumnType(columnType) && BARE_HEX_RE.test(trimmed)) {
      return bytesFromHex(trimmed);
    }
  }

  return bytesFromByteArray(value) ?? bytesFromBufferLikeObject(value);
}

export function isBinaryCellColumnType(columnType?: string): boolean {
  const type = (columnType ?? "").trim();
  return !!type && BINARY_TYPE_RE.test(type);
}

export function canDownloadBinaryCellValue(value: unknown, columnType?: string): boolean {
  return !!parseBinaryCellBytes(value, columnType);
}

export function binaryCellDisplayText(value: unknown, columnType?: string): string | null {
  const bytes = parseBinaryCellBytes(value, columnType);
  if (!bytes || !isBinaryCellColumnType(columnType)) return null;
  return `${binaryCellDisplayLabel(columnType)} [${formatBinaryCellByteSize(bytes.length)}]`;
}

function binaryCellDisplayLabel(columnType?: string): string {
  const base = (columnType ?? "")
    .trim()
    .split(/[(:\s]/)[0]
    .toUpperCase();
  if (!base) return "BLOB";
  if (base.includes("BLOB")) return "BLOB";
  return base;
}

function formatBinaryCellByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function binaryCellDownloadPayload(value: unknown, mode: BinaryCellDownloadMode, columnType?: string): BinaryCellDownloadPayload {
  const bytes = parseBinaryCellBytes(value, columnType);
  if (!bytes) {
    throw new Error("Cell value is not a downloadable binary value.");
  }

  if (mode === "binary") {
    return {
      data: bytes,
      mimeType: "application/octet-stream",
      extension: "bin",
    };
  }

  const decoder = new TextDecoder(mode === "gbk" ? "gbk" : "utf-8", { fatal: false });
  return {
    data: decoder.decode(bytes),
    mimeType: "text/plain;charset=utf-8",
    extension: "txt",
  };
}

export function binaryCellDownloadFileName(options: { column: string; rowNumber: number; mode: BinaryCellDownloadMode; extension: string }): string {
  const column = options.column
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 48);
  const safeColumn = column || "cell";
  const suffix = options.mode === "binary" ? "" : `-${options.mode}`;
  return `${safeColumn}-row-${options.rowNumber}${suffix}.${options.extension}`;
}

export async function downloadBinaryCellPayload(payload: BinaryCellDownloadPayload, fileName: string): Promise<BinaryCellDownloadResult> {
  if (isTauriRuntime()) {
    const [{ save }, fs] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
    const path = await save({
      defaultPath: fileName,
      filters: [{ name: payload.extension.toUpperCase(), extensions: [payload.extension] }],
    });
    if (!path) return { kind: "cancelled" };
    if (typeof payload.data === "string") {
      await fs.writeTextFile(path, payload.data);
    } else {
      await fs.writeFile(path, payload.data);
    }
    return { kind: "saved", path };
  }

  const blob = new Blob([typeof payload.data === "string" ? payload.data : copyBytesForBlob(payload.data)], {
    type: payload.mimeType,
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return { kind: "browser-download", fileName };
}

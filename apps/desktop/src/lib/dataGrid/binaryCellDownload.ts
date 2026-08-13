import type { CellValue } from "@/lib/dataGrid/cellValue";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import type { DatabaseType } from "@/types/database";

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

/**
 * 单个 BLOB/BYTEA 单元格从文件导入的最大字节数。
 *
 * 设立此上限的原因：导入路径会用 `@tauri-apps/plugin-fs` 的 `readFile(path)` 把整个文件
 * 一次性读进 `Uint8Array` 经 IPC 返回前端，再经 `binaryCellBytesToHexValue` 转成
 * `0x<hex>` 字符串（长度约为文件字节的 2 倍）作为脏值常驻内存，直到保存或放弃编辑。
 * 几百 MB 的 BLOB 即可造成 OOM/卡死，故在进入 readFile + hex 转换路径之前先按文件大小拦截。
 * 16 MB 对单个单元格导入已相当宽裕，分块流式 + 后端参数绑定属后续更大改造，不在此处处理。
 */
export const MAX_BINARY_CELL_IMPORT_BYTES = 16 * 1024 * 1024;

/**
 * 文件超过 {@link MAX_BINARY_CELL_IMPORT_BYTES} 时抛出的错误。
 * 调用方据 `code === "binary-import-too-large"` 选择专门的提示文案，
 * 其余失败仍走通用错误提示。
 */
export class BinaryCellImportTooLargeError extends Error {
  readonly code = "binary-import-too-large" as const;
  readonly bytes: number;
  readonly limit: number;
  constructor(bytes: number, limit: number) {
    super(`File is ${bytes} bytes, exceeds the ${limit}-byte import limit.`);
    this.name = "BinaryCellImportTooLargeError";
    this.bytes = bytes;
    this.limit = limit;
  }
}

export function binaryCellBytesToHexValue(bytes: Uint8Array): string {
  let hex = "0x";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

function openBinaryCellFileInBrowser(): Promise<Uint8Array | undefined> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) {
          resolve(undefined);
          return;
        }
        // 尺寸闸门：File.size 在读取前即可用，避免大文件进入 arrayBuffer + hex 路径。
        if (file.size > MAX_BINARY_CELL_IMPORT_BYTES) {
          reject(new BinaryCellImportTooLargeError(file.size, MAX_BINARY_CELL_IMPORT_BYTES));
          return;
        }
        resolve(new Uint8Array(await file.arrayBuffer()));
      } catch (error) {
        reject(error);
      }
    };
    input.click();
  });
}

export async function openBinaryCellFile(): Promise<Uint8Array | undefined> {
  if (!isTauriRuntime()) return openBinaryCellFileInBrowser();

  const [{ open }, { readFile, stat }] = await Promise.all([import("@tauri-apps/plugin-dialog"), import("@tauri-apps/plugin-fs")]);
  const selected = await open({ multiple: false });
  const path = Array.isArray(selected) ? selected[0] : selected;
  if (!path) return undefined;
  // 尺寸闸门：在 readFile 之前用 stat 取文件大小，避免大文件被全量读入内存。
  // stat 不可用（权限/平台差异等）时降级为不阻断，保留原 readFile 行为，避免功能完全不可用。
  try {
    const info = await stat(path);
    if (info.size > MAX_BINARY_CELL_IMPORT_BYTES) {
      throw new BinaryCellImportTooLargeError(info.size, MAX_BINARY_CELL_IMPORT_BYTES);
    }
  } catch (error) {
    if (error instanceof BinaryCellImportTooLargeError) throw error;
    console.warn("[binaryCellDownload] stat failed, skipping size gate:", error);
  }
  return readFile(path);
}

export function retainBinaryCellDownloadMenuForHover(openCell: BinaryCellPosition | null, hoveredCell: BinaryCellPosition): BinaryCellPosition | null {
  return openCell?.rowIndex === hoveredCell.rowIndex && openCell.col === hoveredCell.col ? openCell : null;
}

const HEX_VALUE_RE = /^(?:0[xX]|\\x)([0-9a-fA-F\s]*)$/;
const BARE_HEX_RE = /^[0-9a-fA-F\s]+$/;
const HEX_ESCAPE_RE = /^(?:\\x[0-9a-fA-F]{2}|\s)+$/;
const BINARY_TYPE_RE = /^(?:blob|tinyblob|mediumblob|longblob|bytea|bytes|binary|varbinary|image|raw|long\s+raw)(?:\b|\()/i;
const FIXED_BINARY_TYPE_RE = /^binary(?:\b|\()/i;
const BINARY_STRING_TYPE_RE = /^(?:binary|varbinary)(?:\b|\()/i;
const MYSQL_FILE_IMPORT_TYPE_RE = /^(?:blob|tinyblob|mediumblob|longblob|binary|varbinary)(?:\b|\()/i;

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
  if (hex.length === 0) return new Uint8Array();
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

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

export function canImportBinaryCellFile(databaseType?: DatabaseType, columnType?: string): boolean {
  const type = (columnType ?? "").trim();
  if (databaseType === "postgres") return /^bytea(?:\b|\()/i.test(type);
  if (databaseType === "mysql") return MYSQL_FILE_IMPORT_TYPE_RE.test(type);
  return false;
}

export function canDownloadBinaryCellValue(value: unknown, columnType?: string): boolean {
  return !!parseBinaryCellBytes(value, columnType);
}

export function binaryCellDisplayText(value: unknown, columnType?: string): string | null {
  const bytes = parseBinaryCellBytes(value, columnType);
  if (!bytes || !isBinaryCellColumnType(columnType)) return null;
  if (BINARY_STRING_TYPE_RE.test((columnType ?? "").trim())) {
    const previewBytes = FIXED_BINARY_TYPE_RE.test((columnType ?? "").trim()) ? trimTrailingNullBytes(bytes) : bytes;
    const text = printableUtf8Text(previewBytes);
    if (text !== null) return text;
  }
  return `${binaryCellDisplayLabel(columnType)} [${formatBinaryCellByteSize(bytes.length)}]`;
}

function trimTrailingNullBytes(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return bytes.subarray(0, end);
}

function printableUtf8Text(bytes: Uint8Array): string | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    const allowedWhitespace = codePoint === 9 || codePoint === 10 || codePoint === 13;
    if (!allowedWhitespace && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))) return null;
  }
  return text;
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

export function formatBinaryCellByteSize(bytes: number): string {
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

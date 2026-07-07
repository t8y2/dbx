import dayjs from "dayjs";

export interface GridFsDownloadArchiveEntry {
  id: string;
  filename?: string;
  data: Uint8Array;
}

type ZipEntry = {
  path: string;
  data: Uint8Array;
  crc: number;
  localHeaderOffset: number;
};

const encoder = new TextEncoder();
const CRC_TABLE = buildCrcTable();
const GRIDFS_DATETIME_PATTERN = "YYYY-MM-DD HH:mm:ss";

export function formatGridFsUploadDate(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return "-";
  const parsed = dayjs(trimmed);
  return parsed.isValid() ? parsed.format(GRIDFS_DATETIME_PATTERN) : trimmed;
}

export function defaultGridFsArchiveFileName(bucket: string, now = new Date()): string {
  const safeBucket = sanitizePathStem(bucket) || "gridfs-files";
  return `${safeBucket}-gridfs-${dayjs(now).format("YYYYMMDD-HHmmss")}.zip`;
}

export function buildGridFsDownloadArchive(entries: readonly GridFsDownloadArchiveEntry[]): Uint8Array {
  if (entries.length === 0) {
    throw new Error("At least one GridFS file must be selected.");
  }
  const seen = new Set<string>();
  const files = entries.map((entry) => ({
    path: uniqueArchiveEntryName(entry, seen),
    data: entry.data,
  }));
  return buildZipArchive(files);
}

function uniqueArchiveEntryName(entry: GridFsDownloadArchiveEntry, seen: Set<string>): string {
  const baseName = normalizeArchiveEntryName(entry.filename, entry.id);
  let candidate = baseName;
  let suffix = 2;
  while (seen.has(candidate.toLowerCase())) {
    candidate = withDuplicateSuffix(baseName, suffix);
    suffix += 1;
  }
  seen.add(candidate.toLowerCase());
  return candidate;
}

function normalizeArchiveEntryName(filename: string | undefined, id: string): string {
  const fallback = `${sanitizePathStem(id) || "gridfs-file"}.bin`;
  const raw = filename?.trim();
  if (!raw) return fallback;

  const normalized = raw.replace(/[\\/]+/g, "-");
  const dotIndex = normalized.lastIndexOf(".");
  const hasExtension = dotIndex > 0 && dotIndex < normalized.length - 1;
  const rawStem = hasExtension ? normalized.slice(0, dotIndex) : normalized;
  const rawExtension = hasExtension ? normalized.slice(dotIndex + 1) : "";

  const stem = sanitizePathStem(rawStem) || sanitizePathStem(id) || "gridfs-file";
  const extension = sanitizeExtension(rawExtension);
  const fileName = extension ? `${stem}.${extension}` : stem;
  return fileName.slice(0, 180) || fallback;
}

function withDuplicateSuffix(fileName: string, index: number): string {
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex > 0 && dotIndex < fileName.length - 1) {
    const extension = fileName.slice(dotIndex);
    const stem = fileName.slice(0, dotIndex).slice(0, Math.max(1, 180 - extension.length - `${index}`.length - 1));
    return `${stem}-${index}${extension}`;
  }
  const stem = fileName.slice(0, Math.max(1, 180 - `${index}`.length - 1));
  return `${stem}-${index}`;
}

function sanitizePathStem(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
    .slice(0, 160);
}

function sanitizeExtension(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "").slice(0, 16);
}

function buildCrcTable(): number[] {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table.push(crc >>> 0);
  }
  return table;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buildZipArchive(files: ReadonlyArray<{ path: string; data: Uint8Array }>): Uint8Array {
  const entries: ZipEntry[] = [];
  const localParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const path = encoder.encode(file.path);
    const crc = crc32(file.data);
    const localHeader = concatBytes([uint32(0x04034b50), uint16(20), uint16(0), uint16(0), uint16(0), uint16(0), uint32(crc), uint32(file.data.length), uint32(file.data.length), uint16(path.length), uint16(0), path]);
    entries.push({ path: file.path, data: file.data, crc, localHeaderOffset: offset });
    localParts.push(localHeader, file.data);
    offset += localHeader.length + file.data.length;
  }

  const centralParts = entries.map((entry) => {
    const path = encoder.encode(entry.path);
    return concatBytes([
      uint32(0x02014b50),
      uint16(20),
      uint16(20),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(entry.crc),
      uint32(entry.data.length),
      uint32(entry.data.length),
      uint16(path.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(entry.localHeaderOffset),
      path,
    ]);
  });

  const centralDirectory = concatBytes(centralParts);
  const endOfCentralDirectory = concatBytes([uint32(0x06054b50), uint16(0), uint16(0), uint16(entries.length), uint16(entries.length), uint32(centralDirectory.length), uint32(offset), uint16(0)]);

  return concatBytes([...localParts, centralDirectory, endOfCentralDirectory]);
}

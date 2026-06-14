import { decode, encode } from "@msgpack/msgpack";
import type { QueryTab } from "@/types/database";
import { decodeTabResultSnapshot, encodeTabResultSnapshot, type TabResultSnapshot } from "@/lib/tabResultCache";

const ARCHIVE_MAGIC = "DBX_QUERY_RESULT_ARCHIVE";
const ARCHIVE_VERSION = 1;
const ARCHIVE_CODEC = "msgpack-tab-result-snapshot";

export interface QueryResultArchiveTab {
  title: string;
  connectionId: string;
  database: string;
  schema?: string;
  sql: string;
  lastExecutedSql?: string;
  resultBaseSql?: string;
  resultSortedSql?: string;
}

export interface DecodedQueryResultArchive {
  createdAt: number;
  tab: QueryResultArchiveTab;
  snapshot: TabResultSnapshot;
}

interface QueryResultArchiveEnvelope {
  magic: typeof ARCHIVE_MAGIC;
  version: typeof ARCHIVE_VERSION;
  codec: typeof ARCHIVE_CODEC;
  createdAt: number;
  tab: QueryResultArchiveTab;
  snapshot: Uint8Array;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBinaryLike(value: unknown): boolean {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function removeUndefinedFields<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => removeUndefinedFields(item)) as T;
  if (isBinaryLike(value)) return value;
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, removeUndefinedFields(entryValue)]),
  ) as T;
}

function archiveTabMetadata(tab: QueryTab): QueryResultArchiveTab {
  return removeUndefinedFields({
    title: tab.title,
    connectionId: tab.connectionId,
    database: tab.database,
    schema: tab.schema,
    sql: tab.sql,
    lastExecutedSql: tab.lastExecutedSql,
    resultBaseSql: tab.resultBaseSql,
    resultSortedSql: tab.resultSortedSql,
  });
}

function isArchiveTab(value: unknown): value is QueryResultArchiveTab {
  if (!isRecord(value)) return false;
  return typeof value.title === "string" && typeof value.connectionId === "string" && typeof value.database === "string" && typeof value.sql === "string";
}

function binaryPayload(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return undefined;
}

async function transformBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const output = new Response(stream.readable).arrayBuffer();
  const writer = stream.writable.getWriter();
  await writer.write(bytes.slice());
  await writer.close();
  return new Uint8Array(await output);
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined") return bytes;
  try {
    return await transformBytes(bytes, new CompressionStream("gzip"));
  } catch {
    return bytes;
  }
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b || typeof DecompressionStream === "undefined") return bytes;
  return transformBytes(bytes, new DecompressionStream("gzip"));
}

export function defaultQueryResultArchiveFileName(title: string | undefined): string {
  const base = (title ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return `${base || "query-results"}.dbxresults`;
}

export async function encodeQueryResultArchive(tab: QueryTab, snapshot: TabResultSnapshot): Promise<Uint8Array> {
  const envelope: QueryResultArchiveEnvelope = {
    magic: ARCHIVE_MAGIC,
    version: ARCHIVE_VERSION,
    codec: ARCHIVE_CODEC,
    createdAt: Date.now(),
    tab: archiveTabMetadata(tab),
    snapshot: encodeTabResultSnapshot(snapshot),
  };
  return gzipBytes(encode(removeUndefinedFields(envelope)));
}

export async function decodeQueryResultArchive(bytes: Uint8Array | ArrayBuffer): Promise<DecodedQueryResultArchive | undefined> {
  try {
    const rawBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const decoded = decode(await gunzipBytes(rawBytes));
    if (!isRecord(decoded)) return undefined;
    if (decoded.magic !== ARCHIVE_MAGIC || decoded.version !== ARCHIVE_VERSION || decoded.codec !== ARCHIVE_CODEC) return undefined;
    if (!isArchiveTab(decoded.tab)) return undefined;
    const snapshotBytes = binaryPayload(decoded.snapshot);
    if (!snapshotBytes) return undefined;
    const snapshot = decodeTabResultSnapshot(snapshotBytes);
    if (!snapshot) return undefined;
    return {
      createdAt: typeof decoded.createdAt === "number" ? decoded.createdAt : Date.now(),
      tab: decoded.tab,
      snapshot,
    };
  } catch {
    return undefined;
  }
}

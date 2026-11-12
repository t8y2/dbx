import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import type { ConnectionConfig } from "@/types/database";
import type { QuickSearchResultType } from "@/lib/quickOpen/quickSearch";

export const QUICK_OPEN_METADATA_CACHE_VERSION = 1 as const;
export const QUICK_OPEN_METADATA_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30;

const QUICK_OPEN_METADATA_CACHE_PREFIX = "dbx:quick-open-metadata-v1:";
const quickOpenMetadataCacheInvalidationGenerations = new Map<string, number>();

export type PersistedQuickOpenResultType = Extract<QuickSearchResultType, "database" | "schema" | "table" | "view" | "materialized_view" | "column" | "procedure" | "function" | "sequence" | "package" | "package-body">;

export interface PersistedQuickOpenItem {
  type: PersistedQuickOpenResultType;
  label: string;
  connectionId: string;
  database?: string;
  schema?: string;
  catalog?: string;
  tableName?: string;
  objectName?: string;
  columnName?: string;
  columnComment?: string;
  tableComment?: string;
  tableType?: string;
  signature?: string;
}

export interface QuickOpenMetadataCache {
  version: typeof QUICK_OPEN_METADATA_CACHE_VERSION;
  connectionId: string;
  connectionFingerprint: string;
  capturedAt: string;
  items: PersistedQuickOpenItem[];
}

const PERSISTED_RESULT_TYPES = new Set<PersistedQuickOpenResultType>(["database", "schema", "table", "view", "materialized_view", "column", "procedure", "function", "sequence", "package", "package-body"]);

export function quickOpenMetadataConnectionFingerprint(config: ConnectionConfig): string {
  // Metadata remains reusable when the password is intentionally not saved or
  // when the connection is merely renamed. The fingerprint still includes the
  // endpoint, driver, database and namespace settings that identify the target.
  const { name: _name, password: _password, redis_sentinel_password: _sentinelPassword, connection_secrets: _secrets, ...identity } = config;
  return connectionConfigFingerprint(identity as ConnectionConfig, "");
}

export function quickOpenMetadataCacheGeneration(connectionId: string): number {
  return quickOpenMetadataCacheInvalidationGenerations.get(connectionId) ?? 0;
}

export function invalidateQuickOpenMetadataCache(connectionId: string): number {
  const generation = quickOpenMetadataCacheGeneration(connectionId) + 1;
  quickOpenMetadataCacheInvalidationGenerations.set(connectionId, generation);
  return generation;
}

export function quickOpenMetadataCacheKey(connectionId: string): string {
  // Keep a delimiter after the encoded id so prefix deletion cannot remove a
  // different id that merely starts with the same characters.
  return `${QUICK_OPEN_METADATA_CACHE_PREFIX}${encodeURIComponent(connectionId)}:`;
}

export function quickOpenMetadataCachePrefix(): string {
  return QUICK_OPEN_METADATA_CACHE_PREFIX;
}

export function isPersistedQuickOpenResultType(value: unknown): value is PersistedQuickOpenResultType {
  return typeof value === "string" && PERSISTED_RESULT_TYPES.has(value as PersistedQuickOpenResultType);
}

export function encodeQuickOpenMetadataCache(connectionId: string, connectionFingerprint: string, items: readonly PersistedQuickOpenItem[], nowMs = Date.now()): QuickOpenMetadataCache {
  return {
    version: QUICK_OPEN_METADATA_CACHE_VERSION,
    connectionId,
    connectionFingerprint,
    capturedAt: new Date(nowMs).toISOString(),
    items: [...items],
  };
}

function decodeItem(value: unknown): PersistedQuickOpenItem | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<PersistedQuickOpenItem>;
  if (!isPersistedQuickOpenResultType(item.type) || typeof item.label !== "string" || typeof item.connectionId !== "string") return null;
  const stringFields = ["database", "schema", "catalog", "tableName", "objectName", "columnName", "columnComment", "tableComment", "tableType", "signature"] as const;
  if (stringFields.some((field) => item[field] !== undefined && typeof item[field] !== "string")) return null;
  return {
    type: item.type,
    label: item.label,
    connectionId: item.connectionId,
    ...(item.database === undefined ? {} : { database: item.database }),
    ...(item.schema === undefined ? {} : { schema: item.schema }),
    ...(item.catalog === undefined ? {} : { catalog: item.catalog }),
    ...(item.tableName === undefined ? {} : { tableName: item.tableName }),
    ...(item.objectName === undefined ? {} : { objectName: item.objectName }),
    ...(item.columnName === undefined ? {} : { columnName: item.columnName }),
    ...(item.columnComment === undefined ? {} : { columnComment: item.columnComment }),
    ...(item.tableComment === undefined ? {} : { tableComment: item.tableComment }),
    ...(item.tableType === undefined ? {} : { tableType: item.tableType }),
    ...(item.signature === undefined ? {} : { signature: item.signature }),
  };
}

export function decodeQuickOpenMetadataCache(payload: unknown, nowMs = Date.now(), maxAgeMs = QUICK_OPEN_METADATA_CACHE_MAX_AGE_MS): QuickOpenMetadataCache | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Partial<QuickOpenMetadataCache>;
  if (value.version !== QUICK_OPEN_METADATA_CACHE_VERSION || typeof value.connectionId !== "string" || typeof value.connectionFingerprint !== "string" || typeof value.capturedAt !== "string" || !Array.isArray(value.items)) return null;
  const capturedAtMs = Date.parse(value.capturedAt);
  if (!Number.isFinite(capturedAtMs) || nowMs - capturedAtMs >= maxAgeMs) return null;
  const items = value.items.map(decodeItem);
  if (items.some((item) => item === null)) return null;
  return {
    version: QUICK_OPEN_METADATA_CACHE_VERSION,
    connectionId: value.connectionId,
    connectionFingerprint: value.connectionFingerprint,
    capturedAt: value.capturedAt,
    items: items as PersistedQuickOpenItem[],
  };
}

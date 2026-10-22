import { executeQuery } from "@/lib/backend/api";
import type { DatabaseType } from "@/types/database";

/**
 * Doris/StarRocks/SelectDB clusters commonly guard ad-hoc queries with sql
 * block rules that cap the number of scanned partitions (`partition_num`).
 * An unfiltered data-tab preview on an hourly/daily partitioned table trips
 * those rules even with a small LIMIT, so preview SQL pins the scan to the
 * newest partition. The lookup is cached briefly because dynamic partitions
 * roll over frequently.
 */
const PARTITION_CACHE_TTL_MS = 10 * 60 * 1000;

interface PartitionCacheEntry {
  expiresAt: number;
  partition?: string;
}

const partitionCache = new Map<string, PartitionCacheEntry>();
const pendingPartitionReads = new Map<string, Promise<string | undefined>>();

export function isDorisFamilyDatabaseType(databaseType?: DatabaseType): boolean {
  return databaseType === "doris" || databaseType === "starrocks";
}

function quotePartitionIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

/** Reads the newest partition via `SHOW PARTITIONS`; partition ids increase
 * monotonically with creation time, so the greatest id is the latest data. */
async function queryLatestPartition(options: { connectionId: string; catalog?: string; database: string; tableName: string }): Promise<string | undefined> {
  const { connectionId, catalog, database, tableName } = options;
  const qualified = catalog && catalog !== "internal" ? `${quotePartitionIdentifier(catalog)}.${quotePartitionIdentifier(database)}.${quotePartitionIdentifier(tableName)}` : `${quotePartitionIdentifier(database)}.${quotePartitionIdentifier(tableName)}`;
  const result = await executeQuery(connectionId, database, `SHOW PARTITIONS FROM ${qualified}`, undefined, undefined, { catalog, maxRows: 10000 });
  if (!result || result.execution_error) return undefined;
  const nameIndex = result.columns.findIndex((column) => column.toLowerCase() === "partitionname");
  if (nameIndex < 0) return undefined;
  const idIndex = result.columns.findIndex((column) => column.toLowerCase() === "partitionid");
  let best: { id: number; name: string } | undefined;
  let fallbackName: string | undefined;
  for (const row of result.rows) {
    const name = row[nameIndex];
    if (typeof name !== "string" || !name) continue;
    const id = idIndex >= 0 ? Number(row[idIndex]) : Number.NaN;
    if (Number.isFinite(id)) {
      if (!best || id > best.id) best = { id, name };
    } else if (fallbackName === undefined || name > fallbackName) {
      fallbackName = name;
    }
  }
  return best?.name ?? fallbackName;
}

/**
 * Resolves the partition a Doris/StarRocks data preview should pin itself to.
 * Returns `undefined` for other engines, non-partitioned tables, external
 * catalogs without `SHOW PARTITIONS` support, and lookup failures — callers
 * then keep the historical unfiltered preview SQL.
 */
export function latestDorisPreviewPartition(options: { connectionId: string; databaseType?: DatabaseType; catalog?: string; database?: string; schema?: string; tableName: string }): Promise<string | undefined> {
  if (!isDorisFamilyDatabaseType(options.databaseType)) return Promise.resolve(undefined);
  const database = options.schema?.trim() || options.database?.trim() || "";
  const tableName = options.tableName.trim();
  if (!database || !tableName) return Promise.resolve(undefined);
  const catalog = options.catalog?.trim() || undefined;
  const cacheKey = [options.connectionId, catalog ?? "", database, tableName].join("\u0001");
  const cached = partitionCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.partition);
  let pending = pendingPartitionReads.get(cacheKey);
  if (!pending) {
    pending = queryLatestPartition({ connectionId: options.connectionId, catalog, database, tableName })
      .catch(() => undefined)
      .then((partition) => {
        partitionCache.set(cacheKey, { expiresAt: Date.now() + PARTITION_CACHE_TTL_MS, partition });
        pendingPartitionReads.delete(cacheKey);
        return partition;
      });
    pendingPartitionReads.set(cacheKey, pending);
  }
  return pending;
}

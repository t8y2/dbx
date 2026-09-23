import type { ColumnInfo, ForeignKeyInfo, IndexInfo, ObjectSourceKind, TableInfo, TriggerInfo } from "@/types/database";
import { isSchemaDiffView } from "@/lib/schema/schemaDiffTableFilter";
import type { SchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { TableSchemaDetail } from "@/lib/schema/schemaDiff";

const MYSQL_LARGE_SCHEMA_DIFF_METADATA_CONCURRENCY = 2;
const MYSQL_SMALL_SCHEMA_DIFF_METADATA_CONCURRENCY = 4;
const MYSQL_SMALL_SCHEMA_TABLE_LIMIT = 30;
const DEFAULT_SCHEMA_DIFF_METADATA_CONCURRENCY = 6;

/**
 * SQL Server metadata is served by a single serialized session per
 * (connection, database): the native pool holds one `Mutex<SqlServerClient>`
 * and the `sqlserver-legacy` profile holds one Agent session, while the
 * backend metadata gate admits `METADATA_POOL_SQLSERVER_LIMIT = 1` in-flight
 * request per (connection, database) and turns anything that still has to wait
 * after `METADATA_POOL_ACQUIRE_TIMEOUT` (5s) into
 * `DBX metadata pool is busy; please retry`
 * (crates/dbx-core/src/connection/mod.rs). Fanning out further cannot add
 * throughput because the backend serializes those same requests anyway; it
 * only builds a queue that is guaranteed to time out.
 *
 * Both drivers share the same limit, so this is a per-database-type metadata
 * capacity rather than a driver-capability check: `metadata_concurrency_limit`
 * returns `METADATA_POOL_SQLSERVER_LIMIT` whenever the config is `sqlserver`,
 * regardless of driver profile.
 */
const SQLSERVER_SCHEMA_DIFF_METADATA_CONCURRENCY = 1;

function normalizeConcurrencyLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
}

export function schemaDiffMetadataConcurrency(dbType: string | null | undefined, tableCount?: number): number {
  const normalizedDbType = (dbType || "").toLowerCase();
  if (normalizedDbType === "mysql" || normalizedDbType === "mariadb") {
    if (typeof tableCount === "number" && tableCount <= MYSQL_SMALL_SCHEMA_TABLE_LIMIT) {
      return MYSQL_SMALL_SCHEMA_DIFF_METADATA_CONCURRENCY;
    }
    return MYSQL_LARGE_SCHEMA_DIFF_METADATA_CONCURRENCY;
  }
  if (normalizedDbType === "sqlserver") {
    return SQLSERVER_SCHEMA_DIFF_METADATA_CONCURRENCY;
  }
  return DEFAULT_SCHEMA_DIFF_METADATA_CONCURRENCY;
}

export function shouldFetchSchemaDiffDdl(isView: boolean, options: Pick<SchemaDiffCompareOptions, "tables" | "views">): boolean {
  return isView ? options.views : options.tables;
}

export interface SchemaDiffMetadataLoadPlan {
  columns: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  triggers: boolean;
  ddl: boolean;
}

export function schemaDiffMetadataLoadPlan(isView: boolean, options: Pick<SchemaDiffCompareOptions, "tables" | "views" | "indexes" | "primaryKeys" | "uniqueKeys" | "foreignKeys" | "triggers">): SchemaDiffMetadataLoadPlan {
  if (isView) {
    return {
      columns: false,
      indexes: false,
      foreignKeys: false,
      triggers: false,
      ddl: shouldFetchSchemaDiffDdl(true, options),
    };
  }

  return {
    columns: options.tables,
    indexes: options.tables && (options.indexes || options.primaryKeys || options.uniqueKeys),
    foreignKeys: options.tables && options.foreignKeys,
    triggers: options.tables && options.triggers,
    ddl: shouldFetchSchemaDiffDdl(false, options),
  };
}

export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const workerCount = Math.min(normalizeConcurrencyLimit(limit), items.length);
  if (workerCount === 0) return [];

  const results: R[] = [];
  let nextIndex = 0;
  let hasError = false;
  let firstError: unknown;

  async function runWorker() {
    while (!hasError) {
      const index = nextIndex++;
      if (index >= items.length) return;

      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        hasError = true;
        firstError = error;
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  if (hasError) throw firstError;
  return results;
}

export function createConcurrencyLimiter(limit: number, onIdle?: () => void) {
  const maxActive = normalizeConcurrencyLimit(limit);
  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire() {
    if (active < maxActive) {
      active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) {
      next();
      return;
    }
    if (active === 0) onIdle?.();
  }

  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    await acquire();
    try {
      return await task();
    } finally {
      release();
    }
  };
}

/**
 * Schema compare metadata lanes are keyed exactly like the backend metadata
 * gate -- `(connection id, database)` -- so the fan-out limit belongs to the
 * resource instead of to one compare session. Two compares can hammer the same
 * resource at once (closing a compare dialog keeps the compare running in the
 * background) and adding their fan-out together would occupy the backend gate
 * and fail whoever loses the race with `DBX metadata pool is busy; please
 * retry`. Waiting here instead keeps the queue off the backend gate, where
 * `METADATA_POOL_ACQUIRE_TIMEOUT` (5s) would turn it into that error.
 *
 * A lane is held by every `loadSchemaDetails` call running on it: each call
 * registers itself as a holder before its first await and releases that hold
 * in a `finally`, and the lane leaves the map only once the last holder has
 * gone and every request it accepted has settled. The limiter's idle callback
 * cannot own this lifecycle: at SQL Server's concurrency of 1 the lane goes
 * idle at every table boundary, which used to evict it mid-compare so the next
 * compare built a second lane and the two 1-wide fan-outs together overran the
 * capacity-1 gate. The request count matters for the same reason on the way
 * out: a failed compare stops awaiting requests it already queued, and those
 * orphans must keep the lane alive so a retry still shares it instead of
 * racing it on the gate. An empty table list never runs a request at all, so
 * only the holder count can free its lane.
 */
interface SchemaDiffMetadataLane {
  key: string;
  run: ReturnType<typeof createConcurrencyLimiter>;
  holders: number;
  requests: number;
}

const schemaDiffMetadataLanes = new Map<string, SchemaDiffMetadataLane>();

function schemaDiffMetadataLaneKey(connectionId: string, database: string): string {
  return `${connectionId}\u0000${database}`;
}

function evictSchemaDiffMetadataLaneIfUnused(lane: SchemaDiffMetadataLane) {
  if (lane.holders <= 0 && lane.requests <= 0 && schemaDiffMetadataLanes.get(lane.key) === lane) {
    schemaDiffMetadataLanes.delete(lane.key);
  }
}

function acquireSchemaDiffMetadataLane(connectionId: string, database: string, limit: number): SchemaDiffMetadataLane {
  const key = schemaDiffMetadataLaneKey(connectionId, database);
  const existing = schemaDiffMetadataLanes.get(key);
  if (existing) {
    existing.holders += 1;
    return existing;
  }

  const lane: SchemaDiffMetadataLane = { key, run: createConcurrencyLimiter(limit), holders: 1, requests: 0 };
  schemaDiffMetadataLanes.set(key, lane);
  return lane;
}

function releaseSchemaDiffMetadataLane(lane: SchemaDiffMetadataLane) {
  lane.holders -= 1;
  evictSchemaDiffMetadataLaneIfUnused(lane);
}

export function schemaDiffMetadataLaneCountForTests(): number {
  return schemaDiffMetadataLanes.size;
}

export interface SchemaDiffMetadataApi {
  getTableDdl(connectionId: string, database: string, schema: string, table: string, objectType?: ObjectSourceKind): Promise<string>;
  getColumns(connectionId: string, database: string, schema: string, table: string): Promise<ColumnInfo[]>;
  listIndexes(connectionId: string, database: string, schema: string, table: string): Promise<IndexInfo[]>;
  listForeignKeys(connectionId: string, database: string, schema: string, table: string): Promise<ForeignKeyInfo[]>;
  listTriggers(connectionId: string, database: string, schema: string, table: string): Promise<TriggerInfo[]>;
}

export interface SchemaDiffMetadataProgress {
  current: number;
  total: number;
  objectName: string;
}

export interface SchemaDetailLoadContext {
  connectionId: string;
  database: string;
  schema: string;
  dbType: string;
  options: SchemaDiffCompareOptions;
  onProgress?: (progress: SchemaDiffMetadataProgress) => void;
}

function isViewOrMaterializedView(tableType: string): ObjectSourceKind | undefined {
  switch (tableType.toUpperCase().replace(/\s+/g, "_")) {
    case "VIEW":
      return "VIEW";
    case "MATERIALIZED_VIEW":
      return "MATERIALIZED_VIEW";
    default:
      return undefined;
  }
}

export async function loadSchemaDetails(tables: TableInfo[], context: SchemaDetailLoadContext, api: SchemaDiffMetadataApi): Promise<TableSchemaDetail[]> {
  const concurrency = schemaDiffMetadataConcurrency(context.dbType, tables.length);
  // Hold the lane from before the first await so a compare starting while this
  // one is between tables shares this lane instead of building a second one.
  const lane = acquireSchemaDiffMetadataLane(context.connectionId, context.database, concurrency);
  const runMetadataQuery = <T>(task: () => Promise<T>): Promise<T> => {
    lane.requests += 1;
    return lane.run(task).finally(() => {
      lane.requests -= 1;
      evictSchemaDiffMetadataLaneIfUnused(lane);
    });
  };
  let completed = 0;

  try {
    return await mapWithConcurrency(tables, concurrency, async (table) => {
      const objectType = isViewOrMaterializedView(table.table_type);
      const loadPlan = schemaDiffMetadataLoadPlan(isSchemaDiffView(table), context.options);
      const ddlPromise = loadPlan.ddl ? runMetadataQuery(() => api.getTableDdl(context.connectionId, context.database, context.schema, table.name, objectType)) : Promise.resolve("");
      const [columns, indexes, foreignKeys, triggers, ddl] = await Promise.all([
        loadPlan.columns ? runMetadataQuery(() => api.getColumns(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
        loadPlan.indexes ? runMetadataQuery(() => api.listIndexes(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
        loadPlan.foreignKeys ? runMetadataQuery(() => api.listForeignKeys(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
        loadPlan.triggers ? runMetadataQuery(() => api.listTriggers(context.connectionId, context.database, context.schema, table.name)) : Promise.resolve([]),
        ddlPromise,
      ]);

      const detail = { name: table.name, columns, indexes, foreignKeys, triggers, ddl };
      context.onProgress?.({ current: ++completed, total: tables.length, objectName: table.name });
      return detail;
    });
  } finally {
    releaseSchemaDiffMetadataLane(lane);
  }
}

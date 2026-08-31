import type { ColumnInfo, ForeignKeyInfo, IndexInfo, ObjectSourceKind, TableInfo, TriggerInfo } from "@/types/database";
import { isSchemaDiffView } from "@/lib/schema/schemaDiffTableFilter";
import type { SchemaDiffCompareOptions } from "@/types/schemaDiff";
import type { TableSchemaDetail } from "@/lib/schema/schemaDiff";

const MYSQL_LARGE_SCHEMA_DIFF_METADATA_CONCURRENCY = 2;
const MYSQL_SMALL_SCHEMA_DIFF_METADATA_CONCURRENCY = 4;
const MYSQL_SMALL_SCHEMA_TABLE_LIMIT = 30;
const DEFAULT_SCHEMA_DIFF_METADATA_CONCURRENCY = 6;

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

export function createConcurrencyLimiter(limit: number) {
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
    if (next) next();
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
  const runMetadataQuery = createConcurrencyLimiter(concurrency);
  let completed = 0;

  return mapWithConcurrency(tables, concurrency, async (table) => {
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
}

import type { ForeignKeyInfo, ObjectInfo } from "@/types/database";
import { buildBatchTableEmptyPlan, type BatchTableEmptyPlanItem } from "@/lib/sidebar/batchTableEmpty";

export interface DatabaseEmptyTable {
  name: string;
  schema: string;
}

export type DatabaseTableEmptyOperation = "empty" | "drop";

function quoteMysqlIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

export function buildMysqlTableMutationSql(operation: DatabaseTableEmptyOperation, database: string, tableName: string): string {
  const table = database ? `${quoteMysqlIdentifier(database)}.${quoteMysqlIdentifier(tableName)}` : quoteMysqlIdentifier(tableName);
  return `${operation === "empty" ? "DELETE FROM" : "DROP TABLE"} ${table};`;
}

export class DatabaseTableEmptyPlanError extends Error {
  constructor(
    public readonly reason: "cycle" | "scope" | "cancelled",
    public readonly tables: string[],
  ) {
    super(`${reason}: ${tables.join(", ")}`);
  }
}

export interface DatabaseEmptyTableLayer {
  items: BatchTableEmptyPlanItem<DatabaseEmptyTable>[];
  dependencies?: Record<string, string[]>;
}

interface BuildOptions {
  database: string;
  listTables: () => Promise<ObjectInfo[]>;
  listForeignKeys?: (table: DatabaseEmptyTable) => Promise<ForeignKeyInfo[]>;
  foreignKeysByTable?: Record<string, ForeignKeyInfo[]>;
  buildSql: (table: DatabaseEmptyTable) => Promise<string>;
  isCancelled?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
  onSqlProgress?: (completed: number, total: number) => void;
}

/** Only fresh, unfiltered metadata belongs in a database-wide destructive plan. */
async function buildLayers(options: BuildOptions): Promise<DatabaseEmptyTableLayer[]> {
  if (options.isCancelled?.()) throw new DatabaseTableEmptyPlanError("cancelled", []);
  const objects = await options.listTables();
  if (options.isCancelled?.()) throw new DatabaseTableEmptyPlanError("cancelled", []);
  const tables = new Map<string, DatabaseEmptyTable>();
  for (const object of objects) {
    if (object.object_type !== "TABLE") continue;
    if (object.schema && object.schema !== options.database) throw new DatabaseTableEmptyPlanError("scope", [object.name]);
    tables.set(object.name, { name: object.name, schema: options.database });
  }

  const tableNames = [...tables.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const dependencies = new Map<string, Set<string>>();
  const incoming = new Map(tableNames.map((name) => [name, 0]));
  let metadataCompleted = 0;
  for (const name of tableNames) {
    const table = tables.get(name)!;
    if (options.isCancelled?.()) throw new DatabaseTableEmptyPlanError("cancelled", []);
    const parents = new Set<string>();
    const hasBatchForeignKeys = options.foreignKeysByTable && Object.prototype.hasOwnProperty.call(options.foreignKeysByTable, table.name);
    const foreignKeys = hasBatchForeignKeys ? (options.foreignKeysByTable![table.name] ?? []) : options.listForeignKeys ? await options.listForeignKeys(table) : [];
    for (const fk of foreignKeys) {
      if (fk.ref_schema && fk.ref_schema !== options.database) continue;
      if (!tables.has(fk.ref_table)) throw new DatabaseTableEmptyPlanError("scope", [fk.ref_table]);
      parents.add(fk.ref_table);
    }
    dependencies.set(table.name, parents);
    for (const parent of parents) incoming.set(parent, incoming.get(parent)! + 1);
    options.onProgress?.(++metadataCompleted, tables.size);
  }

  const layers: DatabaseEmptyTableLayer[] = [];
  let ready = tableNames.filter((name) => incoming.get(name) === 0);
  let processed = 0;
  let sqlCompleted = 0;
  while (ready.length) {
    if (options.isCancelled?.()) throw new DatabaseTableEmptyPlanError("cancelled", []);
    const names = ready;
    ready = [];
    const targets = names.map((name) => tables.get(name)!);
    let items: BatchTableEmptyPlanItem<DatabaseEmptyTable>[];
    try {
      items = await buildBatchTableEmptyPlan(targets, options.buildSql, {
        concurrency: 8,
        isCancelled: options.isCancelled,
        onProgress: (completed) => options.onSqlProgress?.(sqlCompleted + completed, tables.size),
      });
    } catch (error) {
      if (options.isCancelled?.()) throw new DatabaseTableEmptyPlanError("cancelled", []);
      throw error;
    }
    const reverseDependencies = new Map<string, string[]>();
    for (const [child, parents] of dependencies) {
      for (const parent of parents) {
        const children = reverseDependencies.get(parent) ?? [];
        children.push(child);
        reverseDependencies.set(parent, children);
      }
    }
    layers.push({
      items,
      dependencies: Object.fromEntries(names.map((name) => [name, reverseDependencies.get(name) ?? []])),
    });
    sqlCompleted += targets.length;
    processed += names.length;
    for (const name of names) {
      for (const parent of dependencies.get(name)!) {
        const remaining = incoming.get(parent)! - 1;
        incoming.set(parent, remaining);
        if (remaining === 0) ready.push(parent);
      }
    }
    ready.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  }
  // Unlike the legacy drop sorter, never silently fall back to an unsafe order.
  if (processed !== tables.size) {
    throw new DatabaseTableEmptyPlanError(
      "cycle",
      [...incoming].filter(([, count]) => count > 0).map(([name]) => name),
    );
  }
  return layers;
}

export async function buildDatabaseTableEmptyPlanLayers(options: BuildOptions): Promise<DatabaseEmptyTableLayer[]> {
  return buildLayers(options);
}

export async function buildDatabaseTableEmptyPlan(options: BuildOptions) {
  const layers = await buildLayers(options);
  return layers.flatMap((layer) => layer.items);
}

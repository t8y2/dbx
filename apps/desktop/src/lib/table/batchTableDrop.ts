import type { DatabaseType, ForeignKeyInfo, QueryResult } from "@/types/database";
import type { ObjectBrowserRow } from "@/lib/table/objectBrowserRows";
import { sortTablesByFkDependency } from "@/lib/table/tableDependencySort";

export async function orderObjectBrowserDropRows(rows: readonly ObjectBrowserRow[], fallbackSchema: string | undefined, listForeignKeys: (row: ObjectBrowserRow) => Promise<ForeignKeyInfo[]>): Promise<ObjectBrowserRow[]> {
  if (rows.length <= 1) return [...rows];

  const key = (schema: string | null | undefined, name: string) => JSON.stringify([schema || fallbackSchema, name]);
  const tables = rows.filter((row) => row.type === "TABLE");
  const tableIds = new Map(tables.map((row) => [key(row.schema, row.name), row.id]));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const sortedTables =
    tables.length <= 1
      ? tables
      : sortTablesByFkDependency(
          await Promise.all(
            tables.map(async (row) => ({
              name: row.id,
              foreignKeys: (await listForeignKeys(row)).map((fk) => ({
                ...fk,
                ref_table: tableIds.get(key(fk.ref_schema || row.schema, fk.ref_table)) ?? "",
              })),
            })),
          ),
        ).map((table) => rowsById.get(table.name)!);

  const bodies = new Map(rows.filter((row) => row.type === "PACKAGE_BODY").map((row) => [key(row.schema, row.name), row]));
  const ordered: ObjectBrowserRow[] = [];
  const emitted = new Set<string>();
  let tableIndex = 0;
  for (const row of rows) {
    if (emitted.has(row.id)) continue;
    if (row.type === "PACKAGE") {
      // Dropping a specification also drops its body. Run an explicitly selected body first.
      const body = bodies.get(key(row.schema, row.name));
      if (body && !emitted.has(body.id)) {
        ordered.push(body);
        emitted.add(body.id);
      }
    }
    ordered.push(row.type === "TABLE" ? sortedTables[tableIndex++]! : row);
    emitted.add(row.id);
  }
  return ordered;
}

export interface BatchTableDropPlanItem<T> {
  target: T;
  sql: string;
}

export interface BatchTableDropProgress {
  completed: number;
  total: number;
  success: boolean;
}

export interface BatchTableDropResult<T> {
  succeeded: T[];
  failed?: Error;
}

interface RunBatchTableDropOptions<T> {
  databaseType: DatabaseType | undefined;
  plan: readonly BatchTableDropPlanItem<T>[];
  executeStatement: (sql: string) => Promise<unknown>;
  executeBatch: (sql: string, onProgress: (progress: BatchTableDropProgress) => void) => Promise<QueryResult[]>;
  onProgress: (progress: BatchTableDropProgress) => void;
}

function batchDropError(result: QueryResult): Error {
  const message = result.error?.detail || result.rows[0]?.[0];
  return new Error(String(message ?? "Batch drop failed"));
}

function isAtomicIndexlessBatch(databaseType: DatabaseType | undefined): boolean {
  return databaseType === "turso" || databaseType === "cloudflare-d1";
}

export async function runBatchTableDrop<T>({ databaseType, plan, executeStatement, executeBatch, onProgress }: RunBatchTableDropOptions<T>): Promise<BatchTableDropResult<T>> {
  if (plan.length === 0) {
    return { succeeded: [] };
  }

  if (databaseType === "sqlserver") {
    const succeeded: T[] = [];
    for (let index = 0; index < plan.length; index += 1) {
      try {
        await executeStatement(plan[index]!.sql);
        succeeded.push(plan[index]!.target);
        onProgress({ completed: index + 1, total: plan.length, success: true });
      } catch (error) {
        onProgress({ completed: index + 1, total: plan.length, success: false });
        return { succeeded, failed: error instanceof Error ? error : new Error(String(error)) };
      }
    }
    return { succeeded };
  }

  const results = await executeBatch(plan.map(({ sql }) => sql).join(";\n"), onProgress);
  const failedResult = results.find((result) => result.execution_error === true);

  const hasStatementIndexes = results.some((result) => Number.isInteger(result.statement_index));
  if (hasStatementIndexes) {
    const succeededIndexes = new Set(results.filter((result) => result.execution_error !== true && Number.isInteger(result.statement_index)).map((result) => result.statement_index!));
    const succeeded = plan.filter((_, index) => succeededIndexes.has(index)).map(({ target }) => target);
    if (failedResult) return { succeeded, failed: batchDropError(failedResult) };
    if (succeeded.length !== plan.length) {
      return { succeeded, failed: new Error("Batch drop did not report a result for every statement") };
    }
    return { succeeded };
  }

  if (!failedResult && isAtomicIndexlessBatch(databaseType) && results.every((result) => !Number.isInteger(result.statement_index))) {
    onProgress({ completed: plan.length, total: plan.length, success: true });
    return { succeeded: plan.map(({ target }) => target) };
  }

  if (results.length === plan.length) {
    const succeeded = plan.filter((_, index) => results[index] && results[index]!.execution_error !== true).map(({ target }) => target);
    if (failedResult) return { succeeded, failed: batchDropError(failedResult) };
    onProgress({ completed: plan.length, total: plan.length, success: true });
    return { succeeded };
  }

  if (failedResult) return { succeeded: [], failed: batchDropError(failedResult) };
  return { succeeded: [], failed: new Error("Batch drop did not report a result for every statement") };
}

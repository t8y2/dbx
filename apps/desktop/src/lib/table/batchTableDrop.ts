import type { DatabaseType, QueryResult } from "@/types/database";

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
  return new Error(String(result.rows[0]?.[0] ?? "Batch drop failed"));
}

function isAtomicIndexlessBatch(databaseType: DatabaseType | undefined): boolean {
  return databaseType === "turso" || databaseType === "cloudflare-d1";
}

export async function runBatchTableDrop<T>({ databaseType, plan, executeStatement, executeBatch, onProgress }: RunBatchTableDropOptions<T>): Promise<BatchTableDropResult<T>> {
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
  if (!failedResult && isAtomicIndexlessBatch(databaseType) && results.every((result) => !Number.isInteger(result.statement_index))) {
    onProgress({ completed: plan.length, total: plan.length, success: true });
    return { succeeded: plan.map(({ target }) => target) };
  }

  const succeededIndexes = new Set(results.filter((result) => result.execution_error !== true && Number.isInteger(result.statement_index)).map((result) => result.statement_index!));
  const succeeded = plan.filter((_, index) => succeededIndexes.has(index)).map(({ target }) => target);
  if (failedResult) return { succeeded, failed: batchDropError(failedResult) };
  if (succeeded.length !== plan.length) {
    return { succeeded, failed: new Error("Batch drop did not report a result for every statement") };
  }
  return { succeeded };
}

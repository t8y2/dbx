import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { assessProductionSql, productionContextForDatabase } from "@/lib/database/productionSafety";
import type { ConnectionConfig } from "@/types/database";

export interface ProductionSqlExecutionGuardOptions<T> {
  connection?: ConnectionConfig;
  database?: string | null;
  sql: string;
  source?: string;
  execute: () => Promise<T>;
}

export async function executeWithProductionSqlGuard<T>(options: ProductionSqlExecutionGuardOptions<T>): Promise<T | undefined> {
  const assessment = assessProductionSql(options.sql, options.connection, options.database);
  if (assessment.active && assessment.isMutation) {
    // Centralize production write confirmation so secondary tool surfaces cannot
    // bypass the same explicit review step used by the SQL editor.
    const confirmed = await useProductionSafetyStore().requestConfirmation({
      sql: options.sql,
      connectionName: options.connection?.name,
      database: options.database ?? undefined,
      productionDatabases: assessment.databases,
      source: options.source,
    });
    if (!confirmed) return undefined;
  }
  return options.execute();
}

export interface ProductionContextExecutionGuardOptions<T> {
  connection?: ConnectionConfig;
  database?: string | null;
  /** Review text shown in the production confirmation dialog (SQL or shell preview). */
  reviewText: string;
  source?: string;
  execute: () => Promise<T>;
}

/**
 * Gate non-SQL mutations (Mongo shell commands, structured editors, etc.) using
 * connection/database production scope rather than SQL risk classification.
 */
export async function executeWithProductionContextGuard<T>(options: ProductionContextExecutionGuardOptions<T>): Promise<T | undefined> {
  const productionContext = productionContextForDatabase(options.connection, options.database);
  if (productionContext.active) {
    const confirmed = await useProductionSafetyStore().requestConfirmation({
      sql: options.reviewText,
      connectionName: options.connection?.name,
      database: options.database ?? undefined,
      productionDatabases: productionContext.databases,
      source: options.source,
    });
    if (!confirmed) return undefined;
  }
  return options.execute();
}

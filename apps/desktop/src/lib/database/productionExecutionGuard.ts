import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { assessProductionSql } from "@/lib/database/productionSafety";
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

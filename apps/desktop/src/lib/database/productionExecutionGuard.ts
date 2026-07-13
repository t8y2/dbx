import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import * as api from "@/lib/backend/api";
import { assessProductionSql, productionContextForDatabase, productionPermitDatabase } from "@/lib/database/productionSafety";
import type { ConnectionConfig } from "@/types/database";

export interface ProductionSqlExecutionGuardOptions<T> {
  connection?: ConnectionConfig;
  database?: string | null;
  sql: string;
  source?: string;
  execute: () => Promise<T>;
}

export interface ProductionOperationExecutionGuardOptions<T> {
  connection?: ConnectionConfig;
  database?: string | null;
  reviewText: string;
  source?: string;
  execute: () => Promise<T>;
}

export async function executeWithProductionOperationGuard<T>(options: ProductionOperationExecutionGuardOptions<T>): Promise<T | undefined> {
  const production = productionContextForDatabase(options.connection, options.database);
  if (production.active && options.connection) {
    const confirmed = await useProductionSafetyStore().requestConfirmation({
      sql: options.reviewText,
      connectionName: options.connection.name,
      database: options.database ?? undefined,
      productionDatabases: production.databases,
      source: options.source,
    });
    if (!confirmed) return undefined;
    await api.authorizeProductionWrite(options.connection.id, productionPermitDatabase(options.connection, options.database));
  }
  return options.execute();
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
    if (options.connection && ["elasticsearch", "qdrant", "milvus", "weaviate", "chromadb"].includes(options.connection.db_type)) {
      await api.authorizeProductionWrite(options.connection.id);
    }
  }
  return options.execute();
}

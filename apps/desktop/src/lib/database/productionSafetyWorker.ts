import { createSqlAnalysisWorker } from "@/lib/sql/sqlAnalysisWorker";
import { assessProductionSql, type ProductionConnection, type ProductionSqlAssessment } from "./productionSafety";

export interface ProductionSafetyRequest {
  sql: string;
  connection?: ProductionConnection;
  database?: string | null;
}

export async function assessProductionSqlInBackground(input: ProductionSafetyRequest): Promise<ProductionSqlAssessment> {
  const analyzer = createSqlAnalysisWorker<ProductionSafetyRequest, ProductionSqlAssessment>(
    () => new Worker(new URL("./productionSafety.worker.ts", import.meta.url), { type: "module" }),
    ({ sql, connection, database }) => assessProductionSql(sql, connection, database),
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Project the connection explicitly: Vue proxies are not cloneable, and SQL
    // analysis needs neither credentials nor the rest of the connection config.
    const connection = input.connection;
    const result = await Promise.race([
      analyzer.analyze({
        sql: input.sql,
        database: input.database,
        connection: connection ? { db_type: connection.db_type, is_production: connection.is_production, production_databases: connection.production_databases ? [...connection.production_databases] : undefined } : undefined,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("SQL safety analysis timed out")), 30_000);
      }),
    ]);
    if (!result) throw new Error("SQL safety analysis failed");
    return result;
  } finally {
    clearTimeout(timeout);
    analyzer.dispose();
  }
}

import { analyzeSqlStatements } from "./sqlStatementAnalysis";
import { createSqlAnalysisWorker } from "./sqlAnalysisWorker";

export function createSqlStatementAnalysisWorker() {
  return createSqlAnalysisWorker(() => new Worker(new URL("./sqlStatementAnalysis.worker.ts", import.meta.url), { type: "module" }), analyzeSqlStatements);
}

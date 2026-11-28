import { analyzeSqlStatements, type SqlStatementAnalysisRequest } from "./sqlStatementAnalysis";
import { createSqlAnalysisWorker } from "./sqlAnalysisWorker";

export function createSqlStatementAnalysisWorker() {
  // Never run a blocking full-document Lezer fold parse on the main thread if module workers are
  // unavailable; visible folds still compute on demand via ensureWindowFolds / syntaxTree.
  return createSqlAnalysisWorker(
    () => new Worker(new URL("./sqlStatementAnalysis.worker.ts", import.meta.url), { type: "module" }),
    (request: SqlStatementAnalysisRequest) => analyzeSqlStatements({ ...request, includeFolds: false }),
  );
}

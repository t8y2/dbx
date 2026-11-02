import { analyzeSqlDiagnostics } from "./sqlDiagnosticAnalysis";
import { createSqlAnalysisWorker } from "./sqlAnalysisWorker";

export function createSqlDiagnosticAnalysisWorker() {
  return createSqlAnalysisWorker(() => new Worker(new URL("./sqlDiagnosticAnalysis.worker.ts", import.meta.url), { type: "module" }), analyzeSqlDiagnostics);
}

import { analyzeSqlDiagnostics, type SqlDiagnosticAnalysisRequest } from "./sqlDiagnosticAnalysis";

self.onmessage = (event: MessageEvent<{ id: number; input: SqlDiagnosticAnalysisRequest }>) => {
  try {
    self.postMessage({ id: event.data.id, result: analyzeSqlDiagnostics(event.data.input) });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) });
  }
};

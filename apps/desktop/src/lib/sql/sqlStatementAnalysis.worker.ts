import { analyzeSqlStatements, type SqlStatementAnalysisRequest } from "./sqlStatementAnalysis";

self.onmessage = (event: MessageEvent<{ id: number; input: SqlStatementAnalysisRequest }>) => {
  try {
    self.postMessage({ id: event.data.id, result: analyzeSqlStatements(event.data.input) });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) });
  }
};

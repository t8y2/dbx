import { SqlCompletionAnalysisEngine, type SqlCompletionAnalysisRequest } from "./sqlCompletionAnalysis";

interface SqlCompletionAnalysisWorkerRequest {
  id: number;
  input: SqlCompletionAnalysisRequest;
}

const engine = new SqlCompletionAnalysisEngine();

self.onmessage = (event: MessageEvent<SqlCompletionAnalysisWorkerRequest>) => {
  try {
    self.postMessage({ id: event.data.id, result: engine.analyze(event.data.input) });
  } catch (error) {
    self.postMessage({ id: event.data.id, error: error instanceof Error ? error.message : String(error) });
  }
};

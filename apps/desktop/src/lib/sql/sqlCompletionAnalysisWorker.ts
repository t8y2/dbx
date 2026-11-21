import type { EditorState } from "@codemirror/state";
import { analyzeSqlCompletion, type SqlCompletionAnalysisRequest } from "./sqlCompletionAnalysis";
import { createSqlAnalysisWorker } from "./sqlAnalysisWorker";

export function createSqlCompletionAnalysisWorker() {
  const worker = createSqlAnalysisWorker(() => new Worker(new URL("./sqlCompletionAnalysis.worker.ts", import.meta.url), { type: "module" }), analyzeSqlCompletion);
  return {
    ...worker,
    analyze: (input: SqlCompletionAnalysisRequest, editorState?: EditorState) => worker.analyze(input, () => analyzeSqlCompletion(input, editorState)),
  };
}

import type { QueryTab } from "@/types/database";

type QueryOutputState = Pick<QueryTab, "result" | "results" | "resultRuns" | "resultEvicted" | "explainPlan" | "explainError" | "explainTableResult" | "explainTableError" | "isExecuting" | "isExplaining" | "liveQueryMessages">;

export function hasFocusableQueryResult(tab: Pick<QueryTab, "mode" | "result"> | null | undefined): boolean {
  const result = tab?.result;
  return tab?.mode === "query" && !!result?.columns.length && result.server_message !== true && result.execution_error !== true;
}

export function hasQueryOutput(tab: QueryOutputState | null | undefined): boolean {
  return (
    !!tab && (!!tab.liveQueryMessages?.length || !!tab.result || !!tab.results?.length || !!tab.resultRuns?.length || tab.resultEvicted === true || !!tab.explainPlan || !!tab.explainError || !!tab.explainTableResult || !!tab.explainTableError || tab.isExecuting === true || tab.isExplaining === true)
  );
}

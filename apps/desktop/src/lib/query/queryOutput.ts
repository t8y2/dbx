import type { QueryTab } from "@/types/database";

type QueryOutputState = Pick<QueryTab, "result" | "results" | "resultRuns" | "resultEvicted" | "explainPlan" | "explainError" | "explainTableResult" | "explainTableError" | "isExecuting" | "isExplaining">;

export function hasQueryOutput(tab: QueryOutputState | null | undefined): boolean {
  return !!tab && (!!tab.result || !!tab.results?.length || !!tab.resultRuns?.length || tab.resultEvicted === true || !!tab.explainPlan || !!tab.explainError || !!tab.explainTableResult || !!tab.explainTableError || tab.isExecuting === true || tab.isExplaining === true);
}

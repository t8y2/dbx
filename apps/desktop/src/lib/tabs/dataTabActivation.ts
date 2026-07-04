import type { QueryResult, QueryTab } from "@/types/database";

function isErrorResult(result: QueryResult | undefined): boolean {
  return result?.columns.length === 1 && result.columns[0] === "Error";
}

export function canActivateExistingDataTableTab(tab: QueryTab): boolean {
  if (tab.isExecuting) return true;
  if (isErrorResult(tab.result)) return false;
  return !!tab.result || !!tab.results?.length;
}

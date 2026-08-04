import type { QueryTab } from "@/types/database";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";

export type DataTableDoubleClickAction = "activate" | "open" | "none";

export function canActivateExistingDataTableTab(tab: QueryTab, options: { activateExecuting?: boolean } = {}): boolean {
  if (tab.isExecuting) return options.activateExecuting !== false;
  if (tab.result && isQueryExecutionErrorResult(tab.result)) return false;
  return !!tab.result || !!tab.results?.length;
}

export function dataTableDoubleClickAction(tab: QueryTab | undefined, activation: "single" | "double", reuseDataTab = true): DataTableDoubleClickAction {
  if (activation === "single") return "none";
  if (!reuseDataTab) return "open";
  if (!tab) return activation === "double" ? "open" : "none";
  if (!canActivateExistingDataTableTab(tab)) return "open";
  return "activate";
}

import type { QueryTab } from "@/types/database";
import { isQueryExecutionErrorResult } from "@/lib/query/queryResultError";
import type { DataTabReuseMode } from "@/lib/tabs/dataTabReuseMode";

export type DataTableDoubleClickAction = "activate" | "open" | "none";

export function canActivateExistingDataTableTab(tab: QueryTab, options: { activateExecuting?: boolean } = {}): boolean {
  if (tab.isExecuting) return options.activateExecuting !== false;
  if (tab.result && isQueryExecutionErrorResult(tab.result)) return false;
  return !!tab.result || !!tab.results?.length;
}

export function dataTableDoubleClickAction(tab: QueryTab | undefined, activation: "single" | "double", reuseMode: DataTabReuseMode = "same-table"): DataTableDoubleClickAction {
  if (activation === "single") return "none";
  if (reuseMode === "always-new") return "open";
  if (!tab) return activation === "double" ? "open" : "none";
  if (!canActivateExistingDataTableTab(tab)) return "open";
  return "activate";
}

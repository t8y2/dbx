import type { QueryResult, QueryTab } from "@/types/database";

export type DataTableDoubleClickAction = "activate" | "open" | "refresh" | "none";

function isErrorResult(result: QueryResult | undefined): boolean {
  return result?.columns.length === 1 && result.columns[0] === "Error";
}

export function canActivateExistingDataTableTab(tab: QueryTab, options: { activateExecuting?: boolean } = {}): boolean {
  if (tab.isExecuting) return options.activateExecuting !== false;
  if (isErrorResult(tab.result)) return false;
  return !!tab.result || !!tab.results?.length;
}

export function canRefreshDataTableFromSingleActivationDoubleClick(tab: QueryTab | undefined): boolean {
  return !!tab && !tab.isExecuting && canActivateExistingDataTableTab(tab);
}

export function dataTableDoubleClickAction(tab: QueryTab | undefined, activation: "single" | "double", singleActivationRefreshAllowed = false): DataTableDoubleClickAction {
  if (activation === "single" && !singleActivationRefreshAllowed) return "none";
  if (!tab) return activation === "double" ? "open" : "none";
  if (!canActivateExistingDataTableTab(tab)) return "open";
  return tab.isExecuting ? "activate" : "refresh";
}

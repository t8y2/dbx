import type { QueryTab } from "@/types/database";

type RefreshableDataTab = Pick<QueryTab, "mode" | "result" | "isExecuting">;

export function canReloadUnavailableDataTab(tab: RefreshableDataTab): boolean {
  return tab.mode === "data" && !tab.result && !tab.isExecuting;
}

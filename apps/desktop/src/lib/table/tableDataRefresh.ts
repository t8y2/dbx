import type { QueryTab } from "@/types/database";

type RefreshableDataTab = Pick<QueryTab, "mode" | "result" | "isExecuting">;

export function canReloadUnavailableDataTab(tab: RefreshableDataTab): boolean {
  return tab.mode === "data" && !tab.result && !tab.isExecuting;
}

type RestoredDataTabFilters = Pick<QueryTab, "whereInput" | "orderByInput">;

// 恢复的数据标签页没有 result，刷新走的是 DataGrid 之外那条不带参数的 reload 入口。
// onReloadData 把缺省的 whereInput/orderBy 当成“用户已清空”（DataGrid 清空筛选时
// 正是传 undefined），所以这里必须显式回带标签页自己持久化的过滤/排序，
// 否则刷新会退回整张表的数据（#7963）。
export function restoredDataTabReloadFilters(tab: RestoredDataTabFilters): { whereInput?: string; orderBy?: string } {
  return {
    whereInput: tab.whereInput?.trim() || undefined,
    orderBy: tab.orderByInput?.trim() || undefined,
  };
}

import { reactive } from "vue";
import type { NavigationTarget } from "@/composables/useNavigationTargets";
import type { QueryTab } from "@/types/database";

/**
 * 外键跳转（mod 4）的返回栈（mod 43）。每次同面板跳转前压入"跳转前网格内容
 * 如何恢复"；返回时从栈顶向下找到仍与当前 tab 状态匹配的条目——table-data 条目
 * 比对到达表身份（tab 被侧边栏等其它导航改指别处即作废），query 条目比对当前
 * 显示结果的 SQL（用户重跑过其它查询即作废）——之上的失配条目视为过期丢弃，
 * 保证"返回"只回退一条未被打破的跳转链。
 */
export interface ForeignKeyDrillBackEntry {
  restore: { kind: "tableTarget"; target: NavigationTarget } | { kind: "queryResult"; sql: string };
  /** table-data 到达身份（与 tableMeta 同形，matchesNavigationDataTab 的比对口径） */
  arrivedAt?: { connectionId: string; database: string; catalog?: string; schema?: string; tableName: string };
  /** query 路径到达时执行的 SQL（跳转结果落地后 resultBaseSql 应等于它） */
  arrivedSql?: string;
  /** 返回目标描述：tableTarget 为源表名，queryResult 为上一个结果 */
  label?: string;
}

export const MAX_FOREIGN_KEY_DRILL_BACK = 20;

/** 两个恢复辅助函数实际读取的 tab 字段（结构性子集，便于复用与测试） */
export type ForeignKeyDrillBackTab = Pick<QueryTab, "connectionId" | "database" | "sql" | "mode" | "catalog" | "schema" | "lastExecutedSql" | "resultBaseSql" | "whereInput" | "tableMeta">;

const stacks = reactive(new Map<string, ForeignKeyDrillBackEntry[]>());

// 跳转"落地前"标记（mod 43 修正）：push 之后、新表元数据/新查询结果就位
// 之前，返回按钮的 computed 会立即重算——此刻 tab 仍显示跳转前内容，若无
// 此标记 peek 会把刚压入（或返回后重新等待匹配）的栈顶当失配条目丢掉，
// 按钮永远不出现。标记在条目首次匹配成功时清除；被更新的跳转覆盖时自愈。
const pendingArrivals = new Map<string, ForeignKeyDrillBackEntry>();

function stackTopEntry(tabId: string): ForeignKeyDrillBackEntry | undefined {
  const stack = stacks.get(tabId);
  return stack?.[stack.length - 1];
}

export function pushForeignKeyDrillBack(tabId: string, entry: ForeignKeyDrillBackEntry): void {
  const stack = stacks.get(tabId) ?? [];
  stack.push(entry);
  stacks.set(tabId, stack.slice(-MAX_FOREIGN_KEY_DRILL_BACK));
  // stacks 是 reactive Map：从栈里读出的条目是代理对象，而 entry 是原始
  // 引用——必须统一存"经栈读出的引用"，否则 peek 里的 === 恒为 false。
  pendingArrivals.set(tabId, stackTopEntry(tabId)!);
}

/** 返回导航发起后把（弹出后的）栈顶重新标记为等待落地：恢复途中 tab 内容被改写，期间不可把它当失配丢弃 */
export function markForeignKeyDrillBackPendingArrival(tabId: string): void {
  const top = stackTopEntry(tabId);
  if (top) pendingArrivals.set(tabId, top);
}

export function foreignKeyDrillBackEntries(tabId: string): readonly ForeignKeyDrillBackEntry[] {
  return stacks.get(tabId) ?? [];
}

/** 不出栈地找下一个可返回条目（同时丢弃栈顶已失配的过期条目；落地前的条目只隐藏不丢弃） */
export function peekForeignKeyDrillBack(tabId: string, matches: (entry: ForeignKeyDrillBackEntry) => boolean): ForeignKeyDrillBackEntry | null {
  const stack = stacks.get(tabId);
  if (!stack) return null;
  let entry = stack[stack.length - 1] ?? null;
  while (entry) {
    if (matches(entry)) {
      if (pendingArrivals.get(tabId) === entry) pendingArrivals.delete(tabId);
      return entry;
    }
    if (pendingArrivals.get(tabId) === entry) return null;
    stack.pop();
    entry = stack[stack.length - 1] ?? null;
  }
  if (!stack.length) {
    stacks.delete(tabId);
    pendingArrivals.delete(tabId);
  }
  return null;
}

export function popForeignKeyDrillBack(tabId: string, matches: (entry: ForeignKeyDrillBackEntry) => boolean): ForeignKeyDrillBackEntry | null {
  const entry = peekForeignKeyDrillBack(tabId, matches);
  if (entry) {
    const stack = stacks.get(tabId);
    const index = stack?.lastIndexOf(entry) ?? -1;
    if (stack && index >= 0) stack.splice(index, 1);
    if (!stack?.length) {
      stacks.delete(tabId);
      pendingArrivals.delete(tabId);
    }
  }
  return entry;
}

/** table-data 跳转前从 tab 捕获可恢复目标（含用户当前过滤条件；排序按默认重建） */
export function foreignKeyDrillTableTargetFromTab(tab: ForeignKeyDrillBackTab): NavigationTarget | null {
  const tableName = tab.tableMeta?.tableName;
  if (!tab.connectionId || !tab.database || !tableName) return null;
  return {
    connectionId: tab.connectionId,
    database: tab.database,
    catalog: tab.tableMeta?.catalog ?? tab.catalog,
    schema: tab.tableMeta?.schema ?? tab.schema,
    tableName,
    tableType: tab.tableMeta?.tableType,
    whereInput: tab.whereInput || undefined,
  };
}

export function foreignKeyDrillBackEntryMatchesTab(entry: ForeignKeyDrillBackEntry, tab: ForeignKeyDrillBackTab): boolean {
  if (entry.restore.kind === "tableTarget") {
    const arrivedAt = entry.arrivedAt;
    if (!arrivedAt) return false;
    return (
      tab.mode === "data" &&
      tab.connectionId === arrivedAt.connectionId &&
      tab.database === arrivedAt.database &&
      (tab.tableMeta?.catalog ?? tab.catalog ?? "") === (arrivedAt.catalog ?? "") &&
      (tab.tableMeta?.schema ?? tab.schema ?? "") === (arrivedAt.schema ?? "") &&
      tab.tableMeta?.tableName === arrivedAt.tableName
    );
  }
  return !!entry.arrivedSql && (tab.resultBaseSql ?? tab.lastExecutedSql ?? tab.sql) === entry.arrivedSql;
}

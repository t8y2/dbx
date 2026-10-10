/**
 * 监视（Watch）表达式的名字解析。
 *
 * 监视窗口只做一件事：把一个用户给的名字，对到当前帧的变量列表上。名字来自两处 ——
 * 变量行上的「加到监视」按钮（原样使用 DBMS_DEBUG 报出的名字）与手输。两处都要能容忍
 * 大小写与限定名的差异：
 *   - DBMS_DEBUG 的 `*name*type*value*` 文本按它自己的大小写回报（Oracle 通常是大写）；
 *   - OceanBase 的 JSON 摊平后是 `a.b.c` 这样的点号路径（见 dbx-core 的
 *     `collect_json_variables`），而用户往往只写最后一段。
 * 因此匹配规则是：**先整名（忽略大小写）**，再**退到最后一段**；两者都找不到就是不在
 * 当前作用域（`findWatchVariable` 返回 null），由界面显示明确的占位文案，而不是猜一个值。
 */

/** 监视窗口需要的最小变量形状（`plDebugStore.variables` 的元素）。 */
export interface PlDebugWatchVariable {
  name: string;
  value: string;
  /** DBMS_DEBUG 报出的类型名；服务器没报时为空串。 */
  type?: string;
}

/** 名字的最后一段（`S.P_ID` → `P_ID`），用作整名匹配失败后的兜底。 */
export function watchNameLeaf(name: string): string {
  const parts = name.trim().split(".");
  return (parts[parts.length - 1] ?? "").trim();
}

/**
 * 当前帧里与监视名对应的变量；不在作用域时返回 null。
 *
 * null 是**结论**而不是错误：变量面板在程序运行中、目标已结束、或名字属于别的栈帧时
 * 都会得到 null，界面据此显示「不在当前作用域」。
 */
export function findWatchVariable(name: string, variables: readonly PlDebugWatchVariable[]): PlDebugWatchVariable | null {
  const wanted = name.trim().toUpperCase();
  if (!wanted) return null;
  const exact = variables.find((entry) => entry.name.trim().toUpperCase() === wanted);
  if (exact) return exact;
  // 退到最后一段：监视名可能是裸名而变量是 `a.b.c` 路径，也可能反过来。两边都取最后一段
  // 再比一次，正是 `S.P_ID.LEAF` ↔ `LEAF` 这类配对的解法。
  const leaf = watchNameLeaf(wanted);
  if (!leaf) return null;
  return variables.find((entry) => watchNameLeaf(entry.name).toUpperCase() === leaf) ?? null;
}

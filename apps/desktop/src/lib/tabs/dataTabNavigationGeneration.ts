// data tab 的导航代次：每个 tab 只允许最新一次导航流程落地元数据/SQL/结果。
// 目标身份（canApplyDataTabMetadata）无法区分同表不同 whereInput 或同表连点
// 两次的请求代次，所有可复用 data tab 的导航入口（openTableTarget、侧边栏
// openData）都必须经由这里作废旧代次，否则旧请求晚返回会覆盖新导航。
const activeNavigationByTab = new Map<string, symbol>();

/** 开始一次导航流程：作废该 tab 的旧代次并返回本次 token */
export function beginDataTabNavigation(tabId: string): symbol {
  const token = Symbol("data-tab-navigation");
  activeNavigationByTab.set(tabId, token);
  return token;
}

/** 本次导航是否仍是该 tab 的最新代次 */
export function isCurrentDataTabNavigation(tabId: string, token: symbol): boolean {
  return activeNavigationByTab.get(tabId) === token;
}

/** 导航流程结束：仍持有最新代次时清掉登记，Map 只在在途导航期间持有条目 */
export function endDataTabNavigation(tabId: string, token: symbol): void {
  if (activeNavigationByTab.get(tabId) === token) activeNavigationByTab.delete(tabId);
}

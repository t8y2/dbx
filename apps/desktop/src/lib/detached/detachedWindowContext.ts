/**
 * 分离子窗口上下文判断。
 * 独立成无依赖模块，供 queryStore 等底层 store 使用（避免经由 detachedTabs 引入循环依赖）。
 */

export const DETACHED_PANEL_PARAM = "detached";
export const DETACHED_TAB_PARAM = "detached-tab";
export const DETACHED_TAB_SHELL_PARAM = "detached-tab-shell";

/** 判断当前窗口是否为分离子窗口（右侧面板/独立页签/预热 shell）。 */
export function isDetachedChildWindow(): boolean {
  if (typeof window === "undefined") return false;
  // 测试环境可能仅 stub 一个不完整的 window（无 location）；缺失时按主窗口处理。
  const search = window.location?.search;
  if (!search) return false;
  const params = new URLSearchParams(search);
  return params.has(DETACHED_PANEL_PARAM) || params.has(DETACHED_TAB_PARAM) || params.has(DETACHED_TAB_SHELL_PARAM);
}

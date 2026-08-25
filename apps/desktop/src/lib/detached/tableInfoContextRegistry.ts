import type { TableInfoContextSnapshot } from "@/lib/detached/detachedPanel";

/**
 * 表信息分离子窗口的主窗口侧上下文注册表。
 * 对象浏览器（可多实例）在选中表/页签变化时发布快照并成为属主；
 * App.vue 据此应答子窗口的 request-table-info-context，并在 dock 时通知属主重新内嵌打开。
 */
export interface TableInfoContextOwner {
  /** 属主唯一标识（对象浏览器实例 id）。 */
  id: string;
  /** 最近一次发布的上下文快照（属主卸载后仍保留，供子窗口继续展示）。 */
  snapshot: TableInfoContextSnapshot;
  /** dock 回主窗口时回调属主重新内嵌打开表面板（属主已卸载时为空）。 */
  dock?: () => void;
}

let activeOwner: TableInfoContextOwner | null = null;

/** 发布/更新表信息上下文（对象浏览器选中表、切换页签或重新激活时调用）。 */
export function publishTableInfoContext(owner: TableInfoContextOwner): void {
  activeOwner = owner;
}

/** 属主卸载时注销：仅当属主仍是当前属主才清除 dock 回调（保留快照供子窗口展示）。 */
export function unpublishTableInfoContext(ownerId: string): void {
  if (activeOwner?.id !== ownerId) return;
  activeOwner = { ...activeOwner, dock: undefined };
}

/** 当前表信息上下文（无属主发布过时为 null）。 */
export function currentTableInfoContext(): TableInfoContextSnapshot | null {
  return activeOwner?.snapshot ?? null;
}

/** dock 回主窗口：通知属主重新内嵌打开；属主已卸载时返回 false（调用方仅关闭子窗口即可）。 */
export function dockTableInfoToOwner(): boolean {
  if (!activeOwner?.dock) return false;
  activeOwner.dock();
  return true;
}

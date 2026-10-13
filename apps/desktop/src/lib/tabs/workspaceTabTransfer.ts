import type { DetachedTabHandoff } from "@/lib/app/detachedTabHandoff";

export type TransferStatus = "pending" | "committed" | "cancelled";
export interface WorkspaceTransferInfo {
  source: string;
  target: string;
  status: TransferStatus;
  tabId: string;
  title?: string;
}
export const WORKSPACE_STARTUP_ERROR_EVENT = "dbx:workspace-startup-error";

export function reportWorkspaceStartupError(error: unknown) {
  if (!new URLSearchParams(window.location.search).has("dbxWorkspaceTransfer")) return;
  window.dispatchEvent(new CustomEvent(WORKSPACE_STARTUP_ERROR_EVENT, { detail: error instanceof Error ? error.message : String(error) }));
}
export interface WorkspaceTabHandoff extends DetachedTabHandoff {
  dropCursorPhysical?: { x: number; y: number };
}

/** 交接只冻结输入，不借用更新屏障去拦截结果缓存等正常 I/O。 */
export function lockWorkspaceTransferInput(): () => void {
  const events = ["keydown", "keyup", "pointerdown", "mousedown", "click", "dblclick", "beforeinput", "paste", "cut", "drop", "contextmenu"];
  const stop = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const name of events) window.addEventListener(name, stop, true);
  return () => {
    for (const name of events) window.removeEventListener(name, stop, true);
  };
}

export function isWorkspaceTabWindowLabel(label: string): boolean {
  return label === "main" || (label.startsWith("dbx-tab-") && !label.startsWith("dbx-tab-drag-preview"));
}

export interface WorkspaceTransferTransport {
  status(): Promise<TransferStatus>;
  cancel(): Promise<TransferStatus>;
  delay(): Promise<void>;
}

/** 超时必须由后端原子取消；取消时若目标已提交，源端仍按成功处理。 */
export async function waitForWorkspaceTransfer(transport: WorkspaceTransferTransport, attempts = 200): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const status = await transport.status();
    if (status !== "pending") return status === "committed";
    await transport.delay();
  }
  return (await transport.cancel()) === "committed";
}

/** 接收端只撤回自己新增的标签，不覆盖目标窗口已经打开的同 ID 标签。 */
export async function acceptWorkspaceTransfer(options: {
  handoff: WorkspaceTabHandoff;
  hasTab(id: string): boolean;
  adopt(handoff: WorkspaceTabHandoff): Promise<void>;
  persist(): Promise<void>;
  commit(): Promise<TransferStatus>;
  abort(): Promise<TransferStatus>;
  remove(id: string): void;
}): Promise<boolean> {
  const id = options.handoff.tabId;
  if (options.hasTab(id)) throw new Error("The target window already contains this tab");
  try {
    await options.adopt(options.handoff);
    await options.persist();
    if ((await options.commit()) === "committed") return true;
  } catch (error) {
    // 提交响应丢失不等于提交失败；只有确认取消后才允许撤回接收端副本。
    const status = await options.abort();
    if (status === "committed") return true;
    if (status !== "cancelled") throw error;
    options.remove(id);
    await options.persist();
    throw error;
  }
  options.remove(id);
  await options.persist();
  return false;
}

import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/**
 * 拖拽分离面板时的跟随光标示意标签（原生窗口版）。
 * DOM 浮层无法绘制到主窗口之外，因此在 Tauri 桌面端用一个无边框、透明、
 * 置顶的小窗口充当标签，光标移出窗口甚至跨屏拖动时也能看到。
 */

const GHOST_WINDOW_LABEL = "detach-ghost";
/** 标签相对光标的偏移，与原 DOM ghost 一致（光标右下方）。 */
const GHOST_OFFSET_X = 12;
const GHOST_OFFSET_Y = 12;
const GHOST_HEIGHT = 30;
const GHOST_MIN_WIDTH = 70;
const GHOST_MAX_WIDTH = 600;

let ghostWindow: import("@tauri-apps/api/webviewWindow").WebviewWindow | null = null;
let creating = false;

/** 按字符估算标签宽度（CJK 按全角计），避免过宽的透明置顶窗遮挡点击。 */
function estimateGhostWidth(title: string): number {
  let textWidth = 0;
  for (const ch of title) textWidth += ch.codePointAt(0)! > 0xff ? 13 : 7;
  return Math.min(GHOST_MAX_WIDTH, Math.max(GHOST_MIN_WIDTH, Math.round(textWidth + 24)));
}

function ghostPosition(x: number, y: number) {
  return { x: Math.round(x + GHOST_OFFSET_X), y: Math.round(y + GHOST_OFFSET_Y) };
}

/** Tauri setPosition 需要 LogicalPosition 对象（事件里的 screenX/Y 即为逻辑像素）。 */
async function toLogicalPosition(x: number, y: number) {
  const { LogicalPosition } = await import("@tauri-apps/api/dpi");
  const position = ghostPosition(x, y);
  return new LogicalPosition(position.x, position.y);
}

/** 显示（或复用已存在的）跟随标签窗口；x/y 为光标的屏幕逻辑坐标。 */
export async function showDetachGhost(title: string, x: number, y: number): Promise<void> {
  if (!isTauriRuntime()) return;
  if (ghostWindow || creating) {
    await moveDetachGhost(x, y);
    return;
  }
  creating = true;
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel(GHOST_WINDOW_LABEL);
    if (existing) {
      ghostWindow = existing;
      await existing.setPosition(await toLogicalPosition(x, y));
      return;
    }
    const position = ghostPosition(x, y);
    const win = new WebviewWindow(GHOST_WINDOW_LABEL, {
      url: `detach-ghost.html?title=${encodeURIComponent(title)}`,
      width: estimateGhostWidth(title),
      height: GHOST_HEIGHT,
      x: position.x,
      y: position.y,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      shadow: false,
      // 不抢焦点，避免打断主窗口的 pointer capture。
      focus: false,
    });
    win.once("tauri://error", (error: unknown) => {
      console.error("[detach-ghost] create window failed", error);
      ghostWindow = null;
    });
    ghostWindow = win;
  } finally {
    creating = false;
  }
}

/** 移动跟随标签窗口；x/y 为光标的屏幕逻辑坐标。窗口尚未创建完成时的调用会被安全忽略。 */
export async function moveDetachGhost(x: number, y: number): Promise<void> {
  const win = ghostWindow;
  if (!win) return;
  try {
    await win.setPosition(await toLogicalPosition(x, y));
  } catch {
    // 窗口可能正在创建/已关闭，忽略。
  }
}

/** 关闭跟随标签窗口（拖动结束/取消时调用）。 */
export async function hideDetachGhost(): Promise<void> {
  const win = ghostWindow;
  ghostWindow = null;
  if (!win) return;
  try {
    await win.close();
  } catch (error) {
    console.error("[detach-ghost] close window failed", error);
  }
}

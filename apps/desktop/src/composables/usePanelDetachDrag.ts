import { onBeforeUnmount } from "vue";
import { hideDetachGhost, moveDetachGhost, showDetachGhost } from "@/lib/detached/detachGhostWindow";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

/** 拖拽触发阈值（像素），低于该位移视为普通点击。 */
const DRAG_THRESHOLD_PX = 8;

export interface PanelDetachDragOptions {
  /** 是否处于独立子窗口模式（该模式下禁用拖拽分离）。 */
  isDetached: () => boolean;
  /** 拖拽预览浮层显示的标题。 */
  title: () => string;
  /** 拖拽松手并确认分离时回调，参数为鼠标的屏幕逻辑坐标。 */
  onDetach: (position: { x: number; y: number }) => void;
}

/**
 * 面板头部拖拽分离交互：在 header 空白区域按下并拖动超过阈值后，
 * 显示跟随鼠标的预览浮层，松手时回调 onDetach 完成分离。
 */
export function usePanelDetachDrag(options: PanelDetachDragOptions) {
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let tracking = false;
  let ghostEl: HTMLDivElement | null = null;
  // 桌面端用原生置顶小窗口做跟随标签：光标拖出主窗口后 DOM 浮层会被裁掉看不见。
  const useNativeGhost = isTauriRuntime();

  function removeGhost() {
    ghostEl?.remove();
    ghostEl = null;
  }

  function moveGhost(clientX: number, clientY: number) {
    if (!ghostEl) return;
    ghostEl.style.transform = `translate(${clientX + 12}px, ${clientY + 12}px)`;
  }

  function createGhost(clientX: number, clientY: number) {
    removeGhost();
    ghostEl = document.createElement("div");
    ghostEl.textContent = options.title();
    ghostEl.style.cssText = [
      "position:fixed",
      "left:0",
      "top:0",
      "z-index:100001",
      "pointer-events:none",
      "padding:4px 10px",
      "border-radius:6px",
      "font-size:12px",
      "background:var(--background, #1e1e1e)",
      "color:var(--foreground, #e5e5e5)",
      "border:1px solid var(--border, #3f3f3f)",
      "box-shadow:0 8px 24px rgba(0,0,0,0.35)",
      "opacity:0.92",
      "white-space:nowrap",
    ].join(";");
    document.body.appendChild(ghostEl);
    moveGhost(clientX, clientY);
  }

  function onPointerMove(event: PointerEvent) {
    if (!tracking) return;
    if (!dragging) {
      const distance = Math.hypot(event.clientX - startX, event.clientY - startY);
      if (distance < DRAG_THRESHOLD_PX) return;
      dragging = true;
      if (useNativeGhost) void showDetachGhost(options.title(), event.screenX, event.screenY);
      else createGhost(event.clientX, event.clientY);
    }
    if (useNativeGhost) void moveDetachGhost(event.screenX, event.screenY);
    else moveGhost(event.clientX, event.clientY);
  }

  function onPointerUp(event: PointerEvent) {
    if (!tracking) return;
    const wasDragging = dragging;
    tracking = false;
    dragging = false;
    removeGhost();
    if (useNativeGhost) void hideDetachGhost();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
    if (wasDragging) {
      options.onDetach({ x: event.screenX, y: event.screenY });
    }
  }

  /** 绑定到面板 header 的 pointerdown 处理器。 */
  function onHeaderPointerDown(event: PointerEvent) {
    if (options.isDetached()) return;
    if (event.button !== 0) return;
    // 按钮/输入框等交互元素不触发拖拽。
    const target = event.target as HTMLElement | null;
    if (target?.closest("button, a, input, textarea, select, [data-no-panel-drag]")) return;
    // 阻止按住拖动时触发原生文字选择（否则会选中面板里的内容）。
    event.preventDefault();
    // 捕获指针：光标移出窗口后仍能持续收到 move/up 事件（跟随标签窗口依赖此）。
    try {
      (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    } catch {
      /* 不支持时忽略，拖动在窗口内仍可用 */
    }
    tracking = true;
    dragging = false;
    startX = event.clientX;
    startY = event.clientY;
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
  }

  onBeforeUnmount(() => {
    tracking = false;
    dragging = false;
    removeGhost();
    if (useNativeGhost) void hideDetachGhost();
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
  });

  return { onHeaderPointerDown };
}

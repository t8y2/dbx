import { onScopeDispose, reactive, watch, type Ref } from "vue";

interface SortOptions {
  container: Ref<HTMLElement | null>;
  /** Optional portalled vertical lists that share the same persisted order. */
  extraContainers?: Ref<HTMLElement[]>;
  ids: Ref<string[]>;
  horizontal: Ref<boolean>;
  disabled: Ref<boolean>;
  commit: (source: string, target: string, after: boolean) => void;
}

/** Internal pointer sorting deliberately avoids Windows WebView's native file-drop pipeline. */
export function usePluginShortcutSort(options: SortOptions) {
  const drag = reactive({ source: null as string | null, active: false, target: null as string | null, after: false, x: 0, y: 0 });
  let pointerId: number | null = null;
  let startX = 0;
  let startY = 0;
  let frame = 0;
  let suppressClickUntil = 0;
  let capture: HTMLElement | null = null;

  function hitContainer() {
    return [options.container.value, ...(options.extraContainers?.value ?? [])].find((container) => {
      if (!container) return false;
      const bounds = container.getBoundingClientRect();
      return drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom;
    });
  }

  function locate() {
    const container = hitContainer();
    drag.target = null;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) return;
    let distance = Infinity;
    for (const item of container.querySelectorAll<HTMLElement>("[data-shortcut-id]")) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) continue;
      const dx = Math.max(rect.left - drag.x, 0, drag.x - rect.right);
      const dy = Math.max(rect.top - drag.y, 0, drag.y - rect.bottom);
      const next = dx * dx + dy * dy;
      if (next >= distance) continue;
      distance = next;
      drag.target = item.dataset.shortcutId ?? null;
      drag.after = container === options.container.value && options.horizontal.value ? drag.x > rect.left + rect.width / 2 : drag.y > rect.top + rect.height / 2;
    }
  }

  function autoScroll() {
    if (!drag.active) return;
    const container = hitContainer();
    if (container) {
      const bounds = container.getBoundingClientRect();
      const edge = Math.min(24, bounds.height / 3);
      if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom) {
        const direction = drag.y < bounds.top + edge ? -1 : drag.y > bounds.bottom - edge ? 1 : 0;
        if (direction) {
          container.scrollTop += direction * 6;
          locate();
        }
      }
    }
    frame = requestAnimationFrame(autoScroll);
  }

  function cancel() {
    if (drag.active) suppressClickUntil = Date.now() + 250;
    drag.active = false;
    drag.source = null;
    drag.target = null;
    cancelAnimationFrame(frame);
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", keydown, true);
    window.removeEventListener("blur", cancel);
    capture?.removeEventListener("lostpointercapture", cancel);
    if (pointerId !== null && capture?.hasPointerCapture?.(pointerId)) capture.releasePointerCapture(pointerId);
    pointerId = null;
    capture = null;
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }
  function move(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active) {
      if (Math.hypot(drag.x - startX, drag.y - startY) <= 5) return;
      drag.active = true;
      capture = options.container.value;
      capture?.setPointerCapture?.(event.pointerId);
      capture?.addEventListener("lostpointercapture", cancel);
      frame = requestAnimationFrame(autoScroll);
    }
    event.preventDefault();
    locate();
  }
  function finish(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    const active = drag.active;
    if (active) {
      event.preventDefault();
      event.stopPropagation();
      drag.x = event.clientX;
      drag.y = event.clientY;
      locate();
    }
    const { source, target, after } = drag;
    cancel();
    if (active && source && target && source !== target) options.commit(source, target, after);
  }
  function start(event: PointerEvent, id: string) {
    if (event.button !== 0 || options.disabled.value || pointerId !== null) return;
    pointerId = event.pointerId;
    drag.source = id;
    drag.x = startX = event.clientX;
    drag.y = startY = event.clientY;
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("blur", cancel);
  }
  watch([options.ids, options.horizontal], cancel);
  onScopeDispose(cancel);
  return { drag, start, cancel, suppressClick: () => drag.active || Date.now() < suppressClickUntil };
}

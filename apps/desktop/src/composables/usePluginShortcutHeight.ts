import { computed, nextTick, onScopeDispose, ref, watch, type Ref } from "vue";
import { clampPluginShortcutHeight, pluginShortcutListHeight } from "@/lib/plugins/pluginShortcuts";
import { beginPanelResize, endPanelResize } from "@/lib/app/panelResizeState";

export function usePluginShortcutHeight(options: { section: Ref<HTMLElement | null>; scroll: Ref<HTMLElement | null>; sidebarList: Ref<boolean>; count: Ref<number>; savedHeight: Ref<number | null>; save: (height: number | null) => Promise<void> }) {
  const available = ref(0);
  const itemSize = ref(28);
  const gap = ref(0);
  const padding = ref(8);
  const minimum = computed(() => itemSize.value + padding.value);
  const draft = ref<number | null>(null);
  const resizing = ref(false);
  const height = computed(() => clampPluginShortcutHeight(draft.value ?? options.savedHeight.value ?? pluginShortcutListHeight(options.count.value, itemSize.value, gap.value, padding.value), available.value, minimum.value));
  let observer: ResizeObserver | null = null;
  let handle: HTMLElement | null = null;
  let pointerId: number | null = null;
  let startY = 0;
  let startHeight = 0;
  let scale = 1;

  function measure() {
    const section = options.section.value;
    const scroll = options.scroll.value;
    if (!section || !scroll || !options.sidebarList.value) return;
    const tree = section.previousElementSibling as HTMLElement | null;
    const divider = section.querySelector<HTMLElement>("[data-shortcut-resize]");
    available.value = (tree?.offsetHeight ?? 0) + section.offsetHeight - (divider?.offsetHeight ?? 0);
    const item = scroll.querySelector<HTMLElement>("[data-shortcut-id]");
    const grid = scroll.firstElementChild;
    itemSize.value = item?.offsetHeight || 28;
    gap.value = grid ? parseFloat(getComputedStyle(grid).gap) || 0 : 0;
    const style = getComputedStyle(scroll);
    padding.value = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  }
  watch(
    [options.section, options.sidebarList],
    async (_value, _previous, onCleanup) => {
      let cancelled = false;
      onCleanup(() => {
        cancelled = true;
        observer?.disconnect();
      });
      observer?.disconnect();
      if (!options.section.value || !options.sidebarList.value) cancel();
      await nextTick();
      if (cancelled || !options.sidebarList.value) return;
      measure();
      if (typeof ResizeObserver !== "undefined" && options.section.value?.parentElement) {
        observer = new ResizeObserver(measure);
        observer.observe(options.section.value.parentElement);
        if (options.scroll.value) observer.observe(options.scroll.value);
        // Sidebar font changes can resize rows without resizing the viewport.
        if (options.scroll.value?.firstElementChild) observer.observe(options.scroll.value.firstElementChild);
      }
    },
    { flush: "post" },
  );
  watch(options.count, () => void nextTick(measure));

  function cleanup() {
    window.removeEventListener("pointermove", move, true);
    window.removeEventListener("pointerup", finish, true);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    window.removeEventListener("keydown", keydown, true);
    handle?.removeEventListener("lostpointercapture", cancel);
    if (pointerId !== null && handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
    pointerId = null;
    handle = null;
    if (resizing.value) endPanelResize();
    resizing.value = false;
  }
  function cancel() {
    cleanup();
    draft.value = null;
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
    event.preventDefault();
    draft.value = clampPluginShortcutHeight(startHeight + (startY - event.clientY) / scale, available.value, minimum.value);
  }
  async function finish(event: PointerEvent) {
    if (event.pointerId !== pointerId) return;
    move(event);
    const next = draft.value;
    cleanup();
    try {
      if (next !== null && next !== startHeight) await options.save(next);
    } finally {
      draft.value = null;
    }
  }
  function start(event: PointerEvent) {
    if (event.button !== 0 || resizing.value) return;
    event.preventDefault();
    measure();
    startY = event.clientY;
    startHeight = height.value;
    const section = options.section.value;
    scale = section?.offsetHeight ? section.getBoundingClientRect().height / section.offsetHeight : 1;
    scale ||= 1;
    handle = event.currentTarget as HTMLElement;
    pointerId = event.pointerId;
    handle.setPointerCapture?.(pointerId);
    handle.addEventListener("lostpointercapture", cancel);
    resizing.value = true;
    beginPanelResize();
    window.addEventListener("pointermove", move, { capture: true, passive: false });
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", keydown, true);
  }
  async function reset() {
    cancel();
    await options.save(null);
  }
  async function resizeWithKeyboard(event: KeyboardEvent) {
    if (event.key === "Home") {
      event.preventDefault();
      await reset();
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      await options.save(clampPluginShortcutHeight(height.value + (event.key === "ArrowUp" ? 1 : -1) * (itemSize.value + gap.value), available.value, minimum.value));
    }
  }
  onScopeDispose(() => {
    observer?.disconnect();
    cancel();
  });
  return { height, resizing, start, reset, resizeWithKeyboard };
}

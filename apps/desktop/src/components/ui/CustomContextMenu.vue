<script setup lang="ts">
import { ref, watch, onBeforeUnmount, onMounted, nextTick } from "vue";
import { Check, ChevronRight } from "@lucide/vue";
import { shortcutDisplayKeys } from "@/lib/editor/shortcutDisplay";
import { registerGlobalContextMenu, type ContextMenuRegistration, type ContextMenuItem } from "@/components/ui/customContextMenuRegistry";
import { buildSubmenuGraceArea, isPointerInGraceArea, type GraceAreaPoint } from "@/lib/ui/pointerGraceArea";

export type { ContextMenuItem };

type ContextMenuItemsSource = ContextMenuItem[] | (() => ContextMenuItem[]);

const props = defineProps<{
  items: ContextMenuItemsSource;
}>();

const emit = defineEmits<{
  open: [];
  close: [];
}>();

defineSlots<{
  default(props: { onContextMenu: (event: MouseEvent) => void; isOpen: boolean }): any;
}>();

// The pointer must settle on another row before it takes the submenu over from
// the open panel: a diagonal slide towards that panel crosses the rows in
// between, and swinging straight into their menus is what makes the menu feel
// unusable.
const SUBMENU_SWITCH_DELAY_MS = 300;
// Travelling along the menu onto a neighbouring row is a deliberate request for
// that row's submenu, so the hand-over only waits long enough to ignore a row
// that was merely crossed on the way to another one.
const SUBMENU_HANDOVER_DELAY_MS = 80;
// How long the submenu survives while the pointer is outside both panels.
const SUBMENU_CLOSE_DELAY_MS = 150;

const show = ref(false);
const x = ref(0);
const y = ref(0);
const menuRef = ref<HTMLElement>();
const activeItems = ref<ContextMenuItem[]>([]);

// Submenu state
const activeSubIndex = ref<number | null>(null);
const subRef = ref<HTMLElement>();
const subX = ref(0);
const subY = ref(0);
let subCloseTimer: ReturnType<typeof setTimeout> | null = null;
let subSwitchTimer: ReturnType<typeof setTimeout> | null = null;
let subSwitchDelay = 0;
let subAnchorRect: { left: number; right: number; top: number; bottom: number } | null = null;
// The wedge between the trigger row and the submenu panel, rebuilt each time the
// pointer leaves a trigger. While the pointer stays inside it the submenu is
// treated as hovered, so a diagonal move towards the panel does not close it.
let subGraceArea: GraceAreaPoint[] | null = null;
// The row under the pointer, kept with its element so a delayed hand-over can
// anchor the panel without waiting for another hover.
let hoveredRow: { index: number; trigger: HTMLElement } | null = null;
let contextMenuRegistration: ContextMenuRegistration | null = null;
let menuRevision = 0;

function close() {
  if (!show.value) return;
  menuRevision += 1;
  activeSubIndex.value = null;
  subAnchorRect = null;
  subGraceArea = null;
  hoveredRow = null;
  cancelSubClose();
  cancelSubSwitch();
  pointerSamples = [];
  activeItems.value = [];
  show.value = false;
  emit("close");
}

defineExpose({ close, menuRef, subRef });

function onPointerDownOutside(e: PointerEvent) {
  // Only respond to primary (left) button presses. This avoids a macOS
  // issue where Ctrl+right-click generates a synthetic click event on
  // mouseup. By using pointerdown (which fires on press, before
  // contextmenu) instead of click, we never see that synthetic event.
  if (e.button !== 0) return;
  const target = e.target as Node;
  const inMenu = menuRef.value?.contains(target);
  const inSub = subRef.value?.contains(target);
  if (!inMenu && !inSub) {
    close();
  }
}

function isScrollInsideMenu(e: Event): boolean {
  const target = e.target;
  if (!(target instanceof Node)) return false;
  return !!(menuRef.value?.contains(target) || subRef.value?.contains(target));
}

function onScroll(e: Event) {
  // Submenus (and tall main menus) are scrollable; ignore their own scroll
  // so wheel/trackpad scrolling does not dismiss the menu.
  if (isScrollInsideMenu(e)) {
    if (e.target instanceof Node && menuRef.value?.contains(e.target)) {
      // Scrolling the main menu under a stationary pointer must not reopen the
      // submenu on the next pointer move.
      hoveredRow = null;
      closeSubmenu();
    }
    return;
  }
  close();
}

function onKeydown(e: KeyboardEvent) {
  if (["Alt", "Control", "Meta", "Shift"].includes(e.key)) return;
  close();
}

function onResize() {
  close();
}

watch(show, (val) => {
  contextMenuRegistration?.setOpen(val);
  if (val) {
    document.addEventListener("pointerdown", onPointerDownOutside, true);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("scroll", onScroll, true);
    // Tracked on the document, in the capture phase, so the trigger-to-submenu
    // journey is observed even where neither panel is under the cursor.
    document.addEventListener("pointermove", onDocumentPointerMove, true);
    window.addEventListener("resize", onResize);
  } else {
    document.removeEventListener("pointerdown", onPointerDownOutside, true);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("scroll", onScroll, true);
    document.removeEventListener("pointermove", onDocumentPointerMove, true);
    window.removeEventListener("resize", onResize);
  }
});

onMounted(() => {
  contextMenuRegistration = registerGlobalContextMenu(close);
});

function handleItemClick(item: ContextMenuItem, index: number, event: MouseEvent) {
  if (itemIsDisabled(item)) return;
  if (item.children?.length) {
    const trigger = event.currentTarget as HTMLElement;
    hoveredRow = { index, trigger };
    openSubmenu(index, trigger);
    return;
  }
  if (item.closeOnSelect !== false) close();
  runItemAction(item);
}

function handleSubItemClick(item: ContextMenuItem) {
  if (itemIsDisabled(item)) return;
  if (item.closeOnSelect !== false) close();
  runItemAction(item);
}

function adjustMenuPosition() {
  if (!menuRef.value) return;
  const rect = menuRef.value.getBoundingClientRect();
  x.value = Math.max(8, Math.min(x.value, window.innerWidth - rect.width - 8));
  y.value = Math.max(8, Math.min(y.value, window.innerHeight - rect.height - 8));
}

function runItemAction(item: ContextMenuItem) {
  const revision = menuRevision;
  const result = item.action?.() as unknown;
  if (item.closeOnSelect !== false || !item.refreshItems) return;
  const refresh = () => {
    if (!show.value || revision !== menuRevision) return;
    hoveredRow = null;
    subAnchorRect = null;
    closeSubmenu();
    activeItems.value = item.refreshItems!();
    nextTick(() => {
      if (!show.value || revision !== menuRevision) return;
      adjustMenuPosition();
      const button = [...(menuRef.value?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((entry) => entry.dataset.menuAction === item.sidebarActionId);
      button?.focus({ preventScroll: true });
      button?.scrollIntoView?.({ block: "nearest" });
    });
  };
  if (result && typeof (result as PromiseLike<unknown>).then === "function") void Promise.resolve(result).then(refresh, refresh);
  else refresh();
}

function onContextMenu(event: MouseEvent, itemsOverride?: ContextMenuItem[]) {
  // Some callers build large context menus; resolve them only for actual opens.
  // Tree-level hosts may replace their items and open in the same event turn.
  // Accepting the resolved items directly avoids reading the previous prop
  // value before Vue has flushed the parent-to-child update.
  const items = itemsOverride ?? (typeof props.items === "function" ? props.items() : props.items);
  if (items.length === 0) return;
  menuRevision += 1;
  activeSubIndex.value = null;
  activeItems.value = items;
  event.preventDefault();
  event.stopPropagation();
  x.value = event.clientX;
  y.value = event.clientY;
  // The pointer direction is only meaningful from the point the menu opened at.
  pointerSamples = [{ x: event.clientX, y: event.clientY }];
  contextMenuRegistration?.activate();
  show.value = true;
  emit("open");
  nextTick(adjustMenuPosition);
}

// ---- submenu ----

function onItemMouseEnter(index: number, event: MouseEvent) {
  rememberPointer(event.clientX, event.clientY);
  // A new row restarts the settle delay; moving within one row must not.
  if (hoveredRow?.index !== index) cancelSubSwitch();
  hoveredRow = { index, trigger: event.currentTarget as HTMLElement };
  syncSubmenu();
}

function onItemMouseLeave(event: MouseEvent) {
  rememberPointer(event.clientX, event.clientY);
  hoveredRow = null;
  // Leaving a trigger opens the wedge that keeps its submenu alive while the
  // pointer crosses the gap towards the panel.
  if (activeSubIndex.value !== null) subGraceArea = buildSubmenuGraceAreaForPointer(event.clientX, event.clientY);
  syncSubmenu();
}

// Last known pointer position. Updated by every row hover and by a document-level
// pointermove while the menu is open; hover events alone are not enough, because
// the pointer spends the trigger-to-submenu journey in the gap between the two
// panels, where nothing fires.
let lastMouseX = 0;
let lastMouseY = 0;
// Recent pointer positions, oldest first. A row hover can then tell which way
// the pointer is travelling (along the menu or diagonally into the open panel)
// instead of judging from a single jittery event delta.
const POINTER_SAMPLE_LIMIT = 3;
let pointerSamples: { x: number; y: number }[] = [];

function rememberPointer(x: number, y: number) {
  lastMouseX = x;
  lastMouseY = y;
  const previous = pointerSamples[pointerSamples.length - 1];
  if (previous?.x === x && previous.y === y) return;
  pointerSamples.push({ x, y });
  if (pointerSamples.length > POINTER_SAMPLE_LIMIT) pointerSamples.shift();
}

function buildSubmenuGraceAreaForPointer(x: number, y: number): GraceAreaPoint[] | null {
  const sub = subRef.value?.getBoundingClientRect();
  if (!sub) return null;
  // The submenu's edge facing the trigger is its left edge when the panel opens
  // to the right, and its right edge when it flips to the left. Comparing with
  // the pointer picks the correct one without tracking the flip separately.
  const nearEdgeX = x <= sub.left ? sub.left : sub.right;
  return buildSubmenuGraceArea({
    origin: { x, y },
    nearEdgeX,
    top: sub.top,
    bottom: sub.bottom,
  });
}

function isMouseOverSub(): boolean {
  if (!subRef.value) return false;
  const rect = subRef.value.getBoundingClientRect();
  return lastMouseX >= rect.left && lastMouseX <= rect.right && lastMouseY >= rect.top && lastMouseY <= rect.bottom;
}

function pointerIsHeadingToSubmenu(): boolean {
  return isMouseOverSub() || isPointerInGraceArea({ x: lastMouseX, y: lastMouseY }, subGraceArea);
}

/**
 * While the pointer sits on a row outside the wedge, tell a diagonal trip into
 * the open panel apart from a deliberate move along the menu. Movement between
 * rows is dominated by vertical travel; a sideways component towards the panel
 * is what a diagonal approach looks like.
 */
function pointerTravelsTowardSubmenu(): boolean {
  const sub = subRef.value?.getBoundingClientRect();
  const first = pointerSamples[0];
  const last = pointerSamples[pointerSamples.length - 1];
  // No measured panel or no movement history: stay with the conservative delay.
  if (!sub || !first || !last) return true;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  if (dx === 0 && dy === 0) return false;
  const panelIsRight = (sub.left + sub.right) / 2 >= last.x;
  const sidewaysTowardPanel = panelIsRight ? dx : -dx;
  return sidewaysTowardPanel > 0 && Math.abs(dx) >= Math.abs(dy);
}

/**
 * The one place that decides which row owns the submenu. Row hover and pointer
 * moves all funnel through it, so the panel is re-evaluated while the pointer
 * travels instead of being settled once, when it crosses a row edge.
 */
function syncSubmenu(fromTimer = false) {
  if (activeSubIndex.value === null && !hoveredRow) return;
  if (activeSubIndex.value !== null && pointerIsHeadingToSubmenu()) {
    // The pointer is in the panel, or in the wedge leading to it. Keep that panel
    // even while the pointer sits on a neighbouring row: handing it over here is
    // what made a diagonal slide land in the wrong list.
    cancelSubClose();
    cancelSubSwitch();
    return;
  }
  const row = hoveredRow;
  const item = row ? activeItems.value[row.index] : undefined;
  if (row && item?.children?.length && !itemIsDisabled(item)) {
    if (activeSubIndex.value === row.index) {
      cancelSubClose();
      cancelSubSwitch();
      return;
    }
    // A panel is already open for another row. The pointer may only be crossing
    // this one on its way to that panel, so let it settle before handing over.
    // Browsing along the menu does not need the long diagonal settle delay.
    if (activeSubIndex.value !== null && !fromTimer) {
      cancelSubClose();
      scheduleSubSwitch(pointerTravelsTowardSubmenu() ? SUBMENU_SWITCH_DELAY_MS : SUBMENU_HANDOVER_DELAY_MS);
      return;
    }
    openSubmenu(row.index, row.trigger);
    return;
  }
  cancelSubSwitch();
  if (row) {
    closeSubmenu();
    return;
  }
  if (activeSubIndex.value === null) return;
  if (fromTimer) closeSubmenu();
  else scheduleSubClose();
}

function onDocumentPointerMove(event: PointerEvent) {
  rememberPointer(event.clientX, event.clientY);
  syncSubmenu();
}

function scheduleSubClose() {
  if (subCloseTimer) return;
  subCloseTimer = setTimeout(() => {
    subCloseTimer = null;
    syncSubmenu(true);
  }, SUBMENU_CLOSE_DELAY_MS);
}

function cancelSubClose() {
  if (!subCloseTimer) return;
  clearTimeout(subCloseTimer);
  subCloseTimer = null;
}

function scheduleSubSwitch(delay: number) {
  // The pointer may change course while the hand-over is pending: switching from
  // diagonal travel to browsing rows (or back) restarts the wait with the delay
  // that matches the new intent. A repeated call with the same intent keeps the
  // existing timer so the row still settles on schedule.
  if (subSwitchTimer && subSwitchDelay === delay) return;
  cancelSubSwitch();
  subSwitchDelay = delay;
  subSwitchTimer = setTimeout(() => {
    subSwitchTimer = null;
    subSwitchDelay = 0;
    syncSubmenu(true);
  }, delay);
}

function cancelSubSwitch() {
  subSwitchDelay = 0;
  if (!subSwitchTimer) return;
  clearTimeout(subSwitchTimer);
  subSwitchTimer = null;
}

function openSubmenu(index: number, trigger: HTMLElement) {
  cancelSubClose();
  cancelSubSwitch();
  if (activeSubIndex.value === index) return;
  subGraceArea = null;
  const rect = trigger.getBoundingClientRect();
  subAnchorRect = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  subX.value = rect.right + 4;
  subY.value = rect.top;
  activeSubIndex.value = index;
  nextTick(() => adjustSubPosition());
}

function closeSubmenu() {
  cancelSubClose();
  cancelSubSwitch();
  activeSubIndex.value = null;
  subGraceArea = null;
}

function onSubMouseEnter() {
  cancelSubClose();
}

function onSubMouseLeave(event: MouseEvent) {
  rememberPointer(event.clientX, event.clientY);
  syncSubmenu();
}

function adjustSubPosition() {
  if (!subRef.value) return;
  const rect = subRef.value.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 8;
  const gap = 4;
  if (subAnchorRect) {
    const rightX = subAnchorRect.right + gap;
    const leftX = subAnchorRect.left - rect.width - gap;
    if (rightX + rect.width <= vw - margin) {
      subX.value = rightX;
    } else if (leftX >= margin) {
      subX.value = leftX;
    } else {
      subX.value = Math.max(margin, Math.min(rightX, vw - rect.width - margin));
    }
  } else if (rect.right > vw - margin) {
    subX.value = Math.max(margin, vw - rect.width - margin);
  }
  if (rect.bottom > vh - margin) {
    subY.value = Math.max(margin, vh - rect.height - margin);
  } else if (rect.top < margin) {
    subY.value = margin;
  }
  // When the submenu flips left due to right-edge overflow, it may land
  // under the mouse cursor. Since the mouse didn't move, mouseenter won't
  // fire — cancel any pending close to prevent the submenu from flashing.
  nextTick(() => {
    if (!isMouseOverSub()) return;
    cancelSubClose();
    cancelSubSwitch();
  });
}

function itemButtonClass(variant?: "default" | "destructive") {
  return [
    "w-full gap-2 rounded-md px-2 py-1 text-[13px] leading-4 outline-hidden select-none text-left cursor-default flex items-center disabled:pointer-events-none disabled:opacity-50",
    variant === "destructive" ? "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive" : "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
  ];
}

function activeSubmenuTriggerClass(item: ContextMenuItem, index: number) {
  if (activeSubIndex.value !== index) return "";
  return item.variant === "destructive" ? "bg-destructive/10 text-destructive" : "bg-accent text-accent-foreground";
}

function itemIsDisabled(item: ContextMenuItem): boolean {
  return typeof item.disabled === "function" ? item.disabled() : !!item.disabled;
}

function shortcutKeys(shortcut?: string): string[] {
  return shortcutDisplayKeys(shortcut);
}

onBeforeUnmount(() => {
  cancelSubClose();
  cancelSubSwitch();
  contextMenuRegistration?.dispose();
  contextMenuRegistration = null;
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("scroll", onScroll, true);
  document.removeEventListener("pointermove", onDocumentPointerMove, true);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <slot :onContextMenu="onContextMenu" :isOpen="show" />
  <!-- Main menu -->
  <Teleport to="body">
    <div
      v-if="show"
      ref="menuRef"
      data-dbx-context-menu
      :style="{ position: 'fixed', left: x + 'px', top: y + 'px', zIndex: 9999, maxHeight: 'calc(100vh - 16px)' }"
      class="pointer-events-auto bg-popover text-popover-foreground min-w-40 w-max max-w-[calc(100vw-16px)] rounded-md p-1 overflow-y-auto overscroll-contain ring-1 ring-foreground/10 shadow-lg"
    >
      <template v-for="(item, index) in activeItems" :key="item.sidebarActionId ?? index">
        <template v-if="item.visible !== false">
          <div v-if="item.separator" class="-mx-1 my-1 flex items-center px-1">
            <div class="h-px flex-1 bg-border/70" />
          </div>
          <button
            v-else
            :disabled="itemIsDisabled(item)"
            :aria-pressed="item.checkedStyle === 'switch' ? !!item.checked : undefined"
            :title="item.title"
            :data-menu-action="item.sidebarActionId"
            :class="[...itemButtonClass(item.variant), activeSubmenuTriggerClass(item, index)]"
            @click="(event) => handleItemClick(item, index, event)"
            @mouseenter="(e) => onItemMouseEnter(index, e)"
            @mouseleave="onItemMouseLeave"
          >
            <span v-if="item.checkedStyle !== 'switch'" class="flex size-4 shrink-0 items-center justify-center">
              <Check v-if="item.checked" class="size-4 text-primary" />
              <component :is="item.icon" v-else-if="item.icon" :class="['size-4', item.iconClass]" />
            </span>
            <span class="flex-1 whitespace-nowrap">{{ item.label }}</span>
            <span v-if="item.checkedStyle === 'switch'" aria-hidden="true" class="ml-3 flex h-3.5 w-6 shrink-0 items-center rounded-full p-0.5 transition-colors" :class="item.checked ? 'bg-primary' : 'bg-input'">
              <span class="size-2.5 rounded-full bg-primary-foreground shadow-xs transition-transform" :class="item.checked ? 'translate-x-2.5' : 'translate-x-0'" />
            </span>
            <span v-if="item.shortcut" class="ml-8 inline-flex shrink-0 items-center gap-1 text-muted-foreground">
              <kbd v-for="key in shortcutKeys(item.shortcut)" :key="key" class="min-w-4 rounded border border-border/70 bg-muted/60 px-1 py-0.5 text-center font-mono text-[10px] leading-none text-muted-foreground shadow-xs">{{ key }}</kbd>
            </span>
            <ChevronRight v-if="item.children?.length" :class="['ml-auto size-4', item.variant === 'destructive' ? 'text-destructive' : 'text-muted-foreground/80']" />
          </button>
        </template>
      </template>
    </div>
  </Teleport>
  <!-- Submenu -->
  <Teleport to="body">
    <div
      v-if="show && activeSubIndex !== null && activeItems[activeSubIndex]?.children?.length"
      ref="subRef"
      data-dbx-context-menu
      :style="{ position: 'fixed', left: subX + 'px', top: subY + 'px', zIndex: 10000, maxHeight: 'min(420px, calc(100vh - 16px))' }"
      class="pointer-events-auto bg-popover text-popover-foreground min-w-56 w-max max-w-[calc(100vw-16px)] rounded-md p-1 overflow-y-auto ring-1 ring-foreground/10 shadow-lg"
      @mouseenter="onSubMouseEnter"
      @mouseleave="onSubMouseLeave"
    >
      <template v-for="(child, ci) in activeItems[activeSubIndex]!.children!" :key="ci">
        <template v-if="child.visible !== false">
          <div v-if="child.separator" class="-mx-1 my-1 flex items-center px-1">
            <div class="h-px flex-1 bg-border/70" />
          </div>
          <button
            v-else
            :disabled="itemIsDisabled(child)"
            :aria-pressed="child.checkedStyle === 'switch' ? !!child.checked : undefined"
            :title="child.title"
            :class="itemButtonClass(child.variant)"
            :style="{ paddingInlineStart: `${0.5 + (child.indentLevel ?? 0) * 0.75}rem` }"
            @click="handleSubItemClick(child)"
          >
            <span v-if="child.checkedStyle !== 'switch'" class="flex size-4 shrink-0 items-center justify-center">
              <Check v-if="child.checked" class="size-4 text-primary" />
              <component :is="child.icon ?? activeItems[activeSubIndex]!.icon" v-else-if="child.icon || activeItems[activeSubIndex]!.icon" :class="['size-4', child.iconClass ?? (child.icon ? undefined : activeItems[activeSubIndex]!.iconClass)]" />
            </span>
            <span class="flex-1 whitespace-nowrap">{{ child.label }}</span>
            <span v-if="child.checkedStyle === 'switch'" aria-hidden="true" class="ml-3 flex h-3.5 w-6 shrink-0 items-center rounded-full p-0.5 transition-colors" :class="child.checked ? 'bg-primary' : 'bg-input'">
              <span class="size-2.5 rounded-full bg-primary-foreground shadow-xs transition-transform" :class="child.checked ? 'translate-x-2.5' : 'translate-x-0'" />
            </span>
            <span v-if="child.shortcut" class="ml-8 inline-flex shrink-0 items-center gap-1 text-muted-foreground">
              <kbd v-for="key in shortcutKeys(child.shortcut)" :key="key" class="min-w-4 rounded border border-border/70 bg-muted/60 px-1 py-0.5 text-center font-mono text-[10px] leading-none text-muted-foreground shadow-xs">{{ key }}</kbd>
            </span>
          </button>
        </template>
      </template>
    </div>
  </Teleport>
</template>

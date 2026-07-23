<script setup lang="ts">
import { ref, watch, onBeforeUnmount, onMounted, nextTick, type Component } from "vue";
import { ChevronRight } from "@lucide/vue";
import { shortcutDisplayKeys } from "@/lib/editor/shortcutDisplay";
import { registerGlobalContextMenu, type ContextMenuRegistration } from "@/components/ui/customContextMenuRegistry";

export interface ContextMenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean | (() => boolean);
  separator?: boolean;
  icon?: Component;
  iconClass?: string;
  // Raw shortcut syntax such as `Mod+C` or `Shift+Alt+U`; display formatting stays in this component.
  shortcut?: string;
  variant?: "default" | "destructive";
  visible?: boolean;
  children?: ContextMenuItem[];
}

type ContextMenuItemsSource = ContextMenuItem[] | (() => ContextMenuItem[]);

const props = defineProps<{
  items: ContextMenuItemsSource;
}>();

defineEmits<{
  close: [];
}>();

defineSlots<{
  default(props: { onContextMenu: (event: MouseEvent) => void }): any;
}>();

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
let subAnchorRect: { left: number; right: number; top: number; bottom: number } | null = null;
let contextMenuRegistration: ContextMenuRegistration | null = null;

function close() {
  activeSubIndex.value = null;
  subAnchorRect = null;
  activeItems.value = [];
  show.value = false;
}

defineExpose({ close });

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

function onScroll() {
  close();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

function onResize() {
  close();
}

watch(show, (val) => {
  contextMenuRegistration?.setOpen(val);
  if (val) {
    document.addEventListener("pointerdown", onPointerDownOutside, true);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
  } else {
    document.removeEventListener("pointerdown", onPointerDownOutside, true);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
  }
});

onMounted(() => {
  contextMenuRegistration = registerGlobalContextMenu(close);
});

function handleItemClick(item: ContextMenuItem) {
  if (itemIsDisabled(item)) return;
  if (item.children?.length) return; // submenu trigger — do nothing on click
  close();
  item.action?.();
}

function handleSubItemClick(item: ContextMenuItem) {
  if (itemIsDisabled(item)) return;
  close();
  item.action?.();
}

function onContextMenu(event: MouseEvent, itemsOverride?: ContextMenuItem[]) {
  // Some callers build large context menus; resolve them only for actual opens.
  // Tree-level hosts may replace their items and open in the same event turn.
  // Accepting the resolved items directly avoids reading the previous prop
  // value before Vue has flushed the parent-to-child update.
  const items = itemsOverride ?? (typeof props.items === "function" ? props.items() : props.items);
  if (items.length === 0) return;
  activeItems.value = items;
  event.preventDefault();
  event.stopPropagation();
  x.value = event.clientX;
  y.value = event.clientY;
  show.value = true;
  nextTick(() => {
    if (!menuRef.value) return;
    const rect = menuRef.value.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.right > vw) x.value = Math.max(0, vw - rect.width - 8);
    if (rect.bottom > vh) y.value = Math.max(0, vh - rect.height - 8);
  });
}

// ---- submenu ----

function onItemMouseEnter(index: number, event: MouseEvent) {
  lastMouseX = event.clientX;
  lastMouseY = event.clientY;
  const item = activeItems.value[index];
  if (!item?.children?.length || itemIsDisabled(item)) {
    // Moving to an item without children — close submenu immediately, no delay needed
    activeSubIndex.value = null;
    return;
  }
  if (subCloseTimer) {
    clearTimeout(subCloseTimer);
    subCloseTimer = null;
  }
  const trigger = event.currentTarget as HTMLElement;
  const rect = trigger.getBoundingClientRect();
  subAnchorRect = { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
  subX.value = rect.right + 4;
  subY.value = rect.top;
  activeSubIndex.value = index;
  nextTick(() => adjustSubPosition());
}

function onItemMouseLeave() {
  if (activeSubIndex.value !== null) {
    scheduleSubClose();
  }
}

// Last known mouse position (from hover events, without a global mousemove listener)
let lastMouseX = 0;
let lastMouseY = 0;

function isMouseOverSub(): boolean {
  if (!subRef.value) return false;
  const rect = subRef.value.getBoundingClientRect();
  return lastMouseX >= rect.left && lastMouseX <= rect.right && lastMouseY >= rect.top && lastMouseY <= rect.bottom;
}

function scheduleSubClose() {
  if (subCloseTimer) clearTimeout(subCloseTimer);
  subCloseTimer = setTimeout(() => {
    if (!isMouseOverSub()) {
      activeSubIndex.value = null;
    }
  }, 150);
}

function onSubMouseEnter() {
  if (subCloseTimer) {
    clearTimeout(subCloseTimer);
    subCloseTimer = null;
  }
}

function onSubMouseLeave() {
  activeSubIndex.value = null;
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
    if (isMouseOverSub() && subCloseTimer) {
      clearTimeout(subCloseTimer);
      subCloseTimer = null;
    }
  });
}

function itemButtonClass(variant?: "default" | "destructive") {
  return [
    "w-full gap-2 rounded-md px-2 py-1 text-[13px] leading-4 outline-hidden select-none text-left cursor-default flex items-center disabled:pointer-events-none disabled:opacity-50",
    variant === "destructive" ? "text-destructive hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive" : "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground",
  ];
}

function itemIsDisabled(item: ContextMenuItem): boolean {
  return typeof item.disabled === "function" ? item.disabled() : !!item.disabled;
}

function shortcutKeys(shortcut?: string): string[] {
  return shortcutDisplayKeys(shortcut);
}

onBeforeUnmount(() => {
  contextMenuRegistration?.dispose();
  contextMenuRegistration = null;
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <slot :onContextMenu="onContextMenu" />
  <!-- Main menu -->
  <Teleport to="body">
    <div v-if="show" ref="menuRef" :style="{ position: 'fixed', left: x + 'px', top: y + 'px', zIndex: 9999 }" class="bg-popover text-popover-foreground min-w-40 w-max max-w-[calc(100vw-16px)] rounded-md p-1 overflow-y-auto ring-1 ring-foreground/10 shadow-lg">
      <template v-for="(item, index) in activeItems" :key="index">
        <template v-if="item.visible !== false">
          <div v-if="item.separator" class="-mx-1 my-1 flex items-center px-1">
            <div class="h-px flex-1 bg-border/70" />
          </div>
          <button v-else :disabled="itemIsDisabled(item)" :class="[...itemButtonClass(item.variant), activeSubIndex === index ? 'bg-accent text-accent-foreground' : '']" @click="handleItemClick(item)" @mouseenter="(e) => onItemMouseEnter(index, e)" @mouseleave="onItemMouseLeave">
            <span class="flex size-4 shrink-0 items-center justify-center">
              <component :is="item.icon" v-if="item.icon" :class="['size-4', item.iconClass]" />
            </span>
            <span class="flex-1 whitespace-nowrap">{{ item.label }}</span>
            <span v-if="item.shortcut" class="ml-8 inline-flex shrink-0 items-center gap-1 text-muted-foreground">
              <kbd v-for="key in shortcutKeys(item.shortcut)" :key="key" class="min-w-4 rounded border border-border/70 bg-muted/60 px-1 py-0.5 text-center font-mono text-[10px] leading-none text-muted-foreground shadow-xs">{{ key }}</kbd>
            </span>
            <ChevronRight v-if="item.children?.length" class="ml-auto size-4 text-muted-foreground/80" />
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
      :style="{ position: 'fixed', left: subX + 'px', top: subY + 'px', zIndex: 10000, maxHeight: 'min(420px, calc(100vh - 16px))' }"
      class="bg-popover text-popover-foreground min-w-56 w-max max-w-[calc(100vw-16px)] rounded-md p-1 overflow-y-auto ring-1 ring-foreground/10 shadow-lg"
      @mouseenter="onSubMouseEnter"
      @mouseleave="onSubMouseLeave"
    >
      <template v-for="(child, ci) in activeItems[activeSubIndex]!.children!" :key="ci">
        <template v-if="child.visible !== false">
          <div v-if="child.separator" class="-mx-1 my-1 flex items-center px-1">
            <div class="h-px flex-1 bg-border/70" />
          </div>
          <button v-else :disabled="itemIsDisabled(child)" :class="itemButtonClass(child.variant)" @click="handleSubItemClick(child)">
            <span class="flex size-4 shrink-0 items-center justify-center">
              <component :is="child.icon" v-if="child.icon" :class="['size-4', child.iconClass]" />
            </span>
            <span class="flex-1 whitespace-nowrap">{{ child.label }}</span>
            <span v-if="child.shortcut" class="ml-8 inline-flex shrink-0 items-center gap-1 text-muted-foreground">
              <kbd v-for="key in shortcutKeys(child.shortcut)" :key="key" class="min-w-4 rounded border border-border/70 bg-muted/60 px-1 py-0.5 text-center font-mono text-[10px] leading-none text-muted-foreground shadow-xs">{{ key }}</kbd>
            </span>
          </button>
        </template>
      </template>
    </div>
  </Teleport>
</template>

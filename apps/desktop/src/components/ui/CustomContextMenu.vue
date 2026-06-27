<script setup lang="ts">
import { ref, watch, onBeforeUnmount, nextTick, type Component } from "vue";
import { ChevronRight } from "@lucide/vue";

export interface ContextMenuItem {
  label: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean;
  icon?: Component;
  iconClass?: string;
  shortcut?: string;
  variant?: "default" | "destructive";
  visible?: boolean;
  children?: ContextMenuItem[];
}

const props = defineProps<{
  items: ContextMenuItem[];
}>();

defineEmits<{
  close: [];
}>();

// ---- module-level singleton state ----
const openMenus = new Set<() => void>();
let globalSetup = false;

function ensureGlobalListeners() {
  if (globalSetup) return;
  globalSetup = true;
  const closeAll = () => {
    for (const c of openMenus) c();
    openMenus.clear();
  };
  document.addEventListener("contextmenu", closeAll, true);
  document.addEventListener("scroll", closeAll, true);
  window.addEventListener("resize", closeAll);
}
ensureGlobalListeners();
// -------------------------------------

const show = ref(false);
const x = ref(0);
const y = ref(0);
const menuRef = ref<HTMLElement>();

// Submenu state
const activeSubIndex = ref<number | null>(null);
const subRef = ref<HTMLElement>();
const subX = ref(0);
const subY = ref(0);
let subCloseTimer: ReturnType<typeof setTimeout> | null = null;

function close() {
  activeSubIndex.value = null;
  show.value = false;
}

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
  if (val) {
    openMenus.add(close);
    document.addEventListener("pointerdown", onPointerDownOutside, true);
    document.addEventListener("keydown", onKeydown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
  } else {
    openMenus.delete(close);
    document.removeEventListener("pointerdown", onPointerDownOutside, true);
    document.removeEventListener("keydown", onKeydown);
    document.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onResize);
  }
});

function handleItemClick(item: ContextMenuItem) {
  if (item.disabled) return;
  if (item.children?.length) return; // submenu trigger — do nothing on click
  close();
  item.action?.();
}

function handleSubItemClick(item: ContextMenuItem) {
  if (item.disabled) return;
  close();
  item.action?.();
}

function onContextMenu(event: MouseEvent) {
  if (props.items.length === 0) return;
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
  const item = props.items[index];
  if (!item?.children?.length || item.disabled) {
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
  if (rect.right > vw) {
    subX.value = Math.max(0, vw - rect.width - 8);
  }
  if (rect.bottom > vh) {
    subY.value = Math.max(0, vh - rect.height - 8);
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

function shortcutKeyLabel(part: string): string {
  if (part === "Cmd") return "⌘";
  if (part === "Meta") return "⌘";
  if (part === "Alt") return "⌥";
  if (part === "Shift") return "⇧";
  if (part === "Delete") return "Del";
  if (part === "Backspace") return "⌫";
  if (part === "Enter") return "↵";
  if (part === "Escape") return "Esc";
  return part;
}

function shortcutKeys(shortcut?: string): string[] {
  return shortcut?.split("+").filter(Boolean).map(shortcutKeyLabel) || [];
}

onBeforeUnmount(() => {
  openMenus.delete(close);
  document.removeEventListener("pointerdown", onPointerDownOutside, true);
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("scroll", onScroll, true);
  window.removeEventListener("resize", onResize);
});
</script>

<template>
  <slot :on-context-menu="onContextMenu" />
  <!-- Main menu -->
  <Teleport to="body">
    <div v-if="show" ref="menuRef" :style="{ position: 'fixed', left: x + 'px', top: y + 'px', zIndex: 9999 }" class="bg-popover text-popover-foreground min-w-40 rounded-[6px] p-1 overflow-x-hidden overflow-y-auto ring-1 ring-foreground/10 shadow-lg">
      <template v-for="(item, index) in items" :key="index">
        <template v-if="item.visible !== false">
          <div v-if="item.separator" class="-mx-1 my-1 flex items-center px-1">
            <div class="h-px flex-1 bg-border/70" />
          </div>
          <button v-else :disabled="item.disabled" :class="[...itemButtonClass(item.variant), activeSubIndex === index ? 'bg-accent text-accent-foreground' : '']" @click="handleItemClick(item)" @mouseenter="(e) => onItemMouseEnter(index, e)" @mouseleave="onItemMouseLeave">
            <span class="flex size-4 shrink-0 items-center justify-center">
              <component :is="item.icon" v-if="item.icon" :class="['size-4', item.iconClass]" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
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
      v-if="show && activeSubIndex !== null && items[activeSubIndex]?.children?.length"
      ref="subRef"
      :style="{ position: 'fixed', left: subX + 'px', top: subY + 'px', zIndex: 10000 }"
      class="bg-popover text-popover-foreground min-w-40 rounded-[6px] p-1 overflow-x-hidden overflow-y-auto ring-1 ring-foreground/10 shadow-lg"
      @mouseenter="onSubMouseEnter"
      @mouseleave="onSubMouseLeave"
    >
      <template v-for="(child, ci) in items[activeSubIndex]!.children!" :key="ci">
        <template v-if="child.visible !== false">
          <div v-if="child.separator" class="-mx-1 my-1 flex items-center px-1">
            <div class="h-px flex-1 bg-border/70" />
          </div>
          <button v-else :disabled="child.disabled" :class="itemButtonClass(child.variant)" @click="handleSubItemClick(child)">
            <span class="flex size-4 shrink-0 items-center justify-center">
              <component :is="child.icon" v-if="child.icon" :class="['size-4', child.iconClass]" />
            </span>
            <span class="min-w-0 flex-1 truncate">{{ child.label }}</span>
            <span v-if="child.shortcut" class="ml-8 inline-flex shrink-0 items-center gap-1 text-muted-foreground">
              <kbd v-for="key in shortcutKeys(child.shortcut)" :key="key" class="min-w-4 rounded border border-border/70 bg-muted/60 px-1 py-0.5 text-center font-mono text-[10px] leading-none text-muted-foreground shadow-xs">{{ key }}</kbd>
            </span>
          </button>
        </template>
      </template>
    </div>
  </Teleport>
</template>

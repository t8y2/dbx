<script setup lang="ts">
import type { Component, HTMLAttributes } from "vue";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronDown } from "@lucide/vue";
import { cn } from "@/lib/common/utils";

export interface LightDropdownMenuItem {
  label: string;
  value: string;
  title?: string;
  icon?: Component;
  iconClass?: HTMLAttributes["class"];
  leadingText?: string;
  shortcut?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
  destructive?: boolean;
  checked?: boolean;
  closeOnSelect?: boolean;
  onSelect?: () => void;
}

const props = withDefaults(
  defineProps<{
    items: LightDropdownMenuItem[];
    ariaLabel?: string;
    label?: string;
    triggerLabel?: string;
    triggerTitle?: string;
    triggerIcon?: Component;
    showTriggerLabel?: boolean;
    showChevron?: boolean;
    disabled?: boolean;
    open?: boolean;
    selectedValue?: string;
    selectedValues?: string[];
    checkPosition?: "left" | "right" | "none";
    align?: "start" | "end";
    side?: "top" | "bottom";
    sideOffset?: number;
    matchTriggerWidth?: boolean;
    closeOnSelect?: boolean;
    triggerClass?: HTMLAttributes["class"];
    triggerIconClass?: HTMLAttributes["class"];
    contentClass?: HTMLAttributes["class"];
    labelClass?: HTMLAttributes["class"];
    itemClass?: HTMLAttributes["class"];
    itemIconClass?: HTMLAttributes["class"];
    selectedItemClass?: HTMLAttributes["class"];
    selectedCheckClass?: HTMLAttributes["class"];
  }>(),
  {
    ariaLabel: undefined,
    label: undefined,
    triggerLabel: undefined,
    triggerTitle: undefined,
    triggerIcon: undefined,
    showTriggerLabel: true,
    showChevron: true,
    disabled: false,
    open: undefined,
    selectedValue: undefined,
    selectedValues: undefined,
    checkPosition: "left",
    align: "start",
    side: "bottom",
    sideOffset: 4,
    matchTriggerWidth: true,
    closeOnSelect: true,
    triggerClass: "flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-expanded:bg-muted aria-expanded:text-foreground",
    triggerIconClass: "h-3 w-3",
    contentClass: "",
    labelClass: "",
    itemClass: "",
    itemIconClass: "h-3.5 w-3.5",
    selectedItemClass: "bg-accent",
    selectedCheckClass: "",
  },
);

const emit = defineEmits<{
  select: [value: string, item: LightDropdownMenuItem];
  "update:open": [open: boolean];
}>();

const triggerRef = ref<HTMLElement>();
const menuRef = ref<HTMLElement>();
const internalOpen = ref(false);
const x = ref(0);
const y = ref(0);
const minWidth = ref(0);
let listenersAttached = false;

const isOpen = computed(() => props.open ?? internalOpen.value);

const menuStyle = computed(() => ({
  left: `${x.value}px`,
  top: `${y.value}px`,
  minWidth: props.matchTriggerWidth ? `${minWidth.value}px` : undefined,
  "--reka-dropdown-menu-trigger-width": `${minWidth.value}px`,
  "--reka-dropdown-menu-content-available-height": "calc(100vh - 16px)",
}));

function setOpen(value: boolean) {
  if (props.open === undefined) {
    internalOpen.value = value;
  }
  emit("update:open", value);
}

function removeMenuListeners() {
  if (!listenersAttached) return;
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("scroll", close, true);
  window.removeEventListener("resize", close);
  listenersAttached = false;
}

function close() {
  setOpen(false);
  removeMenuListeners();
}

function updatePosition() {
  const trigger = triggerRef.value;
  if (!trigger) return;

  const rect = trigger.getBoundingClientRect();
  x.value = Math.min(Math.max(8, rect.left), window.innerWidth - 8);
  y.value = props.side === "top" ? rect.top - props.sideOffset : rect.bottom + props.sideOffset;
  minWidth.value = rect.width;
}

function fitPositionToViewport() {
  const trigger = triggerRef.value;
  const menu = menuRef.value;
  if (!trigger || !menu) return;

  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const margin = 8;
  const preferredX = props.align === "end" ? triggerRect.right - menuRect.width : triggerRect.left;
  const belowY = triggerRect.bottom + props.sideOffset;
  const aboveY = triggerRect.top - menuRect.height - props.sideOffset;
  const fitsBelow = belowY + menuRect.height <= window.innerHeight - margin;
  const fitsAbove = aboveY >= margin;

  x.value = Math.min(Math.max(margin, preferredX), Math.max(margin, window.innerWidth - menuRect.width - margin));
  y.value = props.side === "top" && fitsAbove ? aboveY : props.side === "bottom" && fitsBelow ? belowY : fitsBelow ? belowY : Math.max(margin, aboveY);
}

function openMenu() {
  if (props.disabled) return;
  updatePosition();
  setOpen(true);
  nextTick(fitPositionToViewport);
  removeMenuListeners();
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  listenersAttached = true;
}

function toggle() {
  if (isOpen.value) {
    close();
  } else {
    openMenu();
  }
}

function onOutsidePointerDown(event: PointerEvent) {
  const target = event.target as Node;
  if (triggerRef.value?.contains(target) || menuRef.value?.contains(target)) return;
  close();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    focusMenuItem(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Home") {
    event.preventDefault();
    focusFirstMenuItem();
  } else if (event.key === "End") {
    event.preventDefault();
    focusLastMenuItem();
  }
}

function menuItems() {
  return Array.from(menuRef.value?.querySelectorAll<HTMLButtonElement>("[role='menuitem']:not(:disabled)") ?? []);
}

function focusMenuItem(direction: 1 | -1) {
  const items = menuItems();
  if (items.length === 0) return;

  const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
  const nextIndex = currentIndex === -1 ? (direction === 1 ? 0 : items.length - 1) : (currentIndex + direction + items.length) % items.length;
  items[nextIndex]?.focus();
}

function focusFirstMenuItem() {
  menuItems()[0]?.focus();
}

function focusLastMenuItem() {
  const items = menuItems();
  items[items.length - 1]?.focus();
}

function itemIsSelected(item: LightDropdownMenuItem) {
  if (item.checked !== undefined) return item.checked;
  if (props.selectedValues) return props.selectedValues.includes(item.value);
  return props.selectedValue === item.value;
}

function selectItem(item: LightDropdownMenuItem) {
  if (item.disabled) return;

  emit("select", item.value, item);
  item.onSelect?.();

  if (item.closeOnSelect ?? props.closeOnSelect) {
    close();
  }
}

onBeforeUnmount(() => {
  removeMenuListeners();
});

watch(
  () => props.open,
  (value) => {
    if (value === false) {
      removeMenuListeners();
    }
  },
);
</script>

<template>
  <span ref="triggerRef" class="inline-flex min-w-0" @click="toggle">
    <slot name="trigger" :open="isOpen" :toggle="toggle" :disabled="disabled">
      <button type="button" :class="triggerClass" :title="triggerTitle" :aria-label="ariaLabel" :aria-expanded="isOpen" :disabled="disabled">
        <component :is="triggerIcon" v-if="triggerIcon" :class="triggerIconClass" />
        <span v-if="showTriggerLabel && triggerLabel" class="truncate">{{ triggerLabel }}</span>
        <ChevronDown v-if="showChevron" class="h-3 w-3 shrink-0 opacity-50" />
      </button>
    </slot>
  </span>
  <Teleport to="body">
    <div
      v-if="isOpen"
      ref="menuRef"
      class="ring-foreground/10 fixed z-50 max-h-(--reka-dropdown-menu-content-available-height) min-w-32 overflow-x-hidden overflow-y-auto rounded-md p-1 ring-1 cn-menu-translucent text-popover-foreground"
      :class="cn(matchTriggerWidth ? 'w-(--reka-dropdown-menu-trigger-width)' : '', contentClass)"
      :style="menuStyle"
      role="menu"
    >
      <div v-if="label" :class="cn('text-muted-foreground px-1.5 py-1 text-xs font-medium', labelClass)">{{ label }}</div>
      <div v-if="label" class="bg-border -mx-1 my-1 h-px" />
      <slot name="before-items" />
      <template v-for="item in items" :key="item.value">
        <div v-if="item.separatorBefore" class="bg-border -mx-1 my-1 h-px" />
        <slot name="item" :item="item" :selected="itemIsSelected(item)" :select="selectItem">
          <button
            type="button"
            class="group/dropdown-menu-item relative flex w-full cursor-default select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4"
            :class="
              cn(item.destructive ? 'text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive dark:hover:bg-destructive/20 dark:focus:bg-destructive/20 [&_svg]:text-destructive' : '', itemIsSelected(item) ? selectedItemClass : '', itemClass)
            "
            :disabled="item.disabled"
            :title="item.title"
            role="menuitem"
            @click="selectItem(item)"
          >
            <Check v-if="checkPosition === 'left'" class="h-3 w-3 shrink-0" :class="itemIsSelected(item) ? selectedCheckClass : 'opacity-0'" />
            <span v-if="item.leadingText" class="inline-flex h-5 w-6 shrink-0 items-center justify-center text-sm font-medium leading-none">
              {{ item.leadingText }}
            </span>
            <component :is="item.icon" v-if="item.icon" :class="cn('shrink-0 text-muted-foreground', itemIconClass, item.iconClass)" />
            <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
            <span v-if="item.shortcut" class="ml-4 shrink-0 text-xs text-muted-foreground">{{ item.shortcut }}</span>
            <Check v-if="checkPosition === 'right' && itemIsSelected(item)" class="ml-auto h-4 w-4 shrink-0" :class="selectedCheckClass" />
          </button>
        </slot>
      </template>
      <slot />
    </div>
  </Teleport>
</template>

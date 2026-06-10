<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, type Component } from "vue";
import { Check, ChevronDown } from "@lucide/vue";

export interface LightDropdownItem {
  label: string;
  value: string;
  title?: string;
  icon?: Component;
  iconClass?: string;
  leadingText?: string;
  disabled?: boolean;
  separatorBefore?: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: string;
    items: LightDropdownItem[];
    ariaLabel?: string;
    contentClass?: string;
    triggerClass?: string;
    triggerTitle?: string;
    triggerIcon?: Component;
    triggerLabel?: string;
    showTriggerLabel?: boolean;
    showChevron?: boolean;
    checkPosition?: "left" | "right" | "none";
    align?: "start" | "end";
    triggerIconClass?: string;
    itemIconClass?: string;
    itemClass?: string;
    labelClass?: string;
    selectedValues?: string[];
    highlightSelected?: boolean;
    selectedItemClass?: string;
    selectedCheckClass?: string;
    closeOnSelect?: boolean;
    label?: string;
    matchTriggerWidth?: boolean;
  }>(),
  {
    ariaLabel: undefined,
    contentClass: "",
    triggerClass: "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground",
    triggerTitle: undefined,
    triggerIcon: undefined,
    triggerLabel: undefined,
    showTriggerLabel: true,
    showChevron: true,
    checkPosition: "left",
    align: "start",
    triggerIconClass: "h-3 w-3",
    itemIconClass: "h-3 w-3",
    itemClass: "",
    labelClass: "text-muted-foreground px-1.5 py-1 text-xs font-medium",
    selectedValues: undefined,
    highlightSelected: true,
    selectedItemClass: "bg-accent",
    selectedCheckClass: "",
    closeOnSelect: true,
    label: undefined,
    matchTriggerWidth: true,
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const triggerRef = ref<HTMLButtonElement>();
const menuRef = ref<HTMLElement>();
const open = ref(false);
const x = ref(0);
const y = ref(0);
const minWidth = ref(0);

const selectedItem = computed(() => props.items.find((item) => item.value === props.modelValue));
const triggerIcon = computed(() => props.triggerIcon ?? selectedItem.value?.icon);
const menuStyle = computed(() => ({
  left: `${x.value}px`,
  top: `${y.value}px`,
  minWidth: props.matchTriggerWidth ? `${minWidth.value}px` : undefined,
}));

function close() {
  open.value = false;
  document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  document.removeEventListener("keydown", onKeydown);
  window.removeEventListener("scroll", close, true);
  window.removeEventListener("resize", close);
}

function updatePosition() {
  const trigger = triggerRef.value;
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  x.value = Math.min(Math.max(8, rect.left), window.innerWidth - 8);
  y.value = rect.bottom + 4;
  minWidth.value = rect.width;
}

function fitPositionToViewport() {
  const trigger = triggerRef.value;
  const menu = menuRef.value;
  if (!trigger || !menu) return;
  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const gap = 4;
  const margin = 8;
  const openBelow = triggerRect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const preferredX = props.align === "end" ? triggerRect.right - menuRect.width : triggerRect.left;
  x.value = Math.min(Math.max(margin, preferredX), Math.max(margin, window.innerWidth - menuRect.width - margin));
  y.value = openBelow ? triggerRect.bottom + gap : Math.max(margin, triggerRect.top - menuRect.height - gap);
}

function openMenu() {
  updatePosition();
  open.value = true;
  nextTick(fitPositionToViewport);
  document.addEventListener("pointerdown", onOutsidePointerDown, true);
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
}

function toggle() {
  if (open.value) {
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
  }
}

function isItemSelected(item: LightDropdownItem) {
  if (props.selectedValues) return props.selectedValues.includes(item.value);
  return item.value === props.modelValue;
}

function selectItem(item: LightDropdownItem) {
  if (item.disabled) return;
  emit("update:modelValue", item.value);
  if (props.closeOnSelect) close();
}

onBeforeUnmount(close);
</script>

<template>
  <button ref="triggerRef" type="button" :class="triggerClass" :title="triggerTitle ?? selectedItem?.title" :aria-label="ariaLabel" :aria-expanded="open" @click="toggle">
    <component :is="triggerIcon" v-if="triggerIcon" :class="triggerIconClass" />
    <span v-if="showTriggerLabel">{{ triggerLabel ?? selectedItem?.label }}</span>
    <ChevronDown v-if="showChevron" class="h-3 w-3 opacity-50" />
  </button>
  <Teleport to="body">
    <div v-if="open" ref="menuRef" class="fixed z-50 min-w-32 rounded-lg p-1 cn-menu-translucent text-popover-foreground" :class="contentClass" :style="menuStyle" role="menu">
      <div v-if="label" :class="labelClass">{{ label }}</div>
      <div v-if="label" class="bg-border -mx-1 my-1 h-px" />
      <template v-for="item in items" :key="item.value">
        <div v-if="item.separatorBefore" class="bg-border -mx-1 my-1 h-px" />
        <button
          type="button"
          class="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm outline-hidden hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
          :class="[itemClass, highlightSelected && isItemSelected(item) ? selectedItemClass : '']"
          :disabled="item.disabled"
          :title="item.title"
          role="menuitem"
          @click="selectItem(item)"
        >
          <Check v-if="checkPosition === 'left'" class="h-3 w-3 shrink-0" :class="[isItemSelected(item) ? selectedCheckClass : 'opacity-0']" />
          <span v-if="item.leadingText" class="inline-flex h-5 w-6 shrink-0 items-center justify-center text-sm font-medium leading-none">
            {{ item.leadingText }}
          </span>
          <component :is="item.icon" v-if="item.icon" :class="[itemIconClass, 'shrink-0 text-muted-foreground', item.iconClass]" />
          <span class="truncate">{{ item.label }}</span>
          <Check v-if="checkPosition === 'right' && isItemSelected(item)" class="ml-auto h-4 w-4 shrink-0" :class="selectedCheckClass" />
        </button>
      </template>
      <slot />
    </div>
  </Teleport>
</template>

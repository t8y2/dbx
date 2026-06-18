<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    text: string;
    disabled?: boolean | (() => boolean);
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
    delay?: number;
    closeDelay?: number;
    openOnFocus?: boolean;
  }>(),
  {
    disabled: false,
    side: "top",
    sideOffset: 8,
    delay: 300,
    closeDelay: 100,
    openOnFocus: true,
  },
);

const triggerRef = ref<HTMLElement>();
const tooltipRef = ref<HTMLElement>();
const show = ref(false);
const x = ref(0);
const y = ref(0);
let timer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let suppressOpenUntil = 0;
let openSource: "hover" | "focus" | null = null;

function clearCloseTimer() {
  if (!closeTimer) return;
  clearTimeout(closeTimer);
  closeTimer = null;
}

function triggerElement(): HTMLElement | undefined {
  const root = triggerRef.value;
  const child = root?.firstElementChild;
  return child instanceof HTMLElement ? child : root;
}

const tooltipTransformClass = computed(() => {
  switch (props.side) {
    case "right":
      return "-translate-y-1/2";
    case "left":
      return "-translate-x-full -translate-y-1/2";
    case "bottom":
      return "-translate-x-1/2";
    case "top":
    default:
      return "-translate-x-1/2 -translate-y-full";
  }
});

const arrowClass = computed(() => {
  switch (props.side) {
    case "right":
      return "absolute -left-1 top-1/2 -translate-y-1/2";
    case "left":
      return "absolute -right-1 top-1/2 -translate-y-1/2";
    case "bottom":
      return "absolute -top-1 left-1/2 -translate-x-1/2";
    case "top":
    default:
      return "absolute -bottom-1 left-1/2 -translate-x-1/2";
  }
});

function clearTimer() {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

function isPointerActive(): boolean {
  const el = triggerElement();
  if (!el || !el.isConnected) return false;
  return el.matches(":hover") || tooltipRef.value?.matches(":hover") || false;
}

function isFocusActive(): boolean {
  const el = triggerElement();
  const active = document.activeElement;
  return !!el && active instanceof Node && el.contains(active);
}

function hasFocusVisible(): boolean {
  const el = triggerElement();
  const root = triggerRef.value;
  if (!el || !root) return false;
  try {
    return el.matches(":focus-visible") || !!root.querySelector(":focus-visible");
  } catch {
    return false;
  }
}

function isOpenSourceActive(): boolean {
  return openSource === "focus" ? isFocusActive() : isPointerActive();
}

function isDisabled(): boolean {
  return typeof props.disabled === "function" ? props.disabled() : props.disabled;
}

function updatePosition() {
  const el = triggerElement();
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const offset = props.sideOffset;
  switch (props.side) {
    case "right":
      x.value = Math.min(window.innerWidth - 8, rect.right + offset);
      y.value = Math.min(Math.max(8, rect.top + rect.height / 2), window.innerHeight - 8);
      break;
    case "left":
      x.value = Math.max(8, rect.left - offset);
      y.value = Math.min(Math.max(8, rect.top + rect.height / 2), window.innerHeight - 8);
      break;
    case "bottom":
      x.value = Math.min(Math.max(8, rect.left + rect.width / 2), window.innerWidth - 8);
      y.value = Math.min(window.innerHeight - 8, rect.bottom + offset);
      break;
    case "top":
    default:
      x.value = Math.min(Math.max(8, rect.left + rect.width / 2), window.innerWidth - 8);
      y.value = Math.max(8, rect.top - offset);
      break;
  }
}

function close() {
  clearTimer();
  clearCloseTimer();
  show.value = false;
  openSource = null;
  removeGlobalListeners();
}

function suppressForContextMenu() {
  suppressOpenUntil = Date.now() + 250;
  close();
}

function closeIfTriggerInactive() {
  if (isOpenSourceActive()) {
    clearCloseTimer();
  } else {
    scheduleClose();
  }
}

function scheduleClose() {
  if (props.closeDelay <= 0) {
    if (!isOpenSourceActive()) close();
    return;
  }
  if (closeTimer) return;
  closeTimer = setTimeout(() => {
    closeTimer = null;
    if (!isOpenSourceActive()) close();
  }, props.closeDelay);
}

function onPointerDown(e: PointerEvent) {
  if (tooltipRef.value?.contains(e.target as Node)) return;
  close();
}

function addGlobalListeners() {
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  document.addEventListener("visibilitychange", close);
  document.addEventListener("pointermove", closeIfTriggerInactive, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("contextmenu", close, true);
}

function removeGlobalListeners() {
  window.removeEventListener("scroll", close, true);
  window.removeEventListener("resize", close);
  window.removeEventListener("blur", close);
  document.removeEventListener("visibilitychange", close);
  document.removeEventListener("pointermove", closeIfTriggerInactive, true);
  document.removeEventListener("pointerdown", onPointerDown, true);
  document.removeEventListener("contextmenu", close, true);
}

const slots = defineSlots<{ default(): any; content?(): any }>();
const hasContent = computed(() => !!props.text || !!slots.content);

function open(source: "hover" | "focus") {
  if (Date.now() < suppressOpenUntil) return;
  if (isDisabled() || !hasContent.value) return;
  if (source === "focus" ? !hasFocusVisible() : !isPointerActive()) return;
  updatePosition();
  openSource = source;
  show.value = true;
  addGlobalListeners();
}

function scheduleOpen(source: "hover" | "focus" = "hover") {
  if (Date.now() < suppressOpenUntil) return;
  if (isDisabled() || !hasContent.value) return;
  clearTimer();
  timer = setTimeout(() => open(source), props.delay);
}

function scheduleFocusOpen() {
  if (!props.openOnFocus) return;
  if (!hasFocusVisible()) return;
  scheduleOpen("focus");
}

onBeforeUnmount(() => {
  close();
});

watch(
  () => [props.disabled, props.text] as const,
  () => {
    if (isDisabled() || !props.text) close();
    else if (show.value) updatePosition();
  },
);
</script>

<template>
  <span ref="triggerRef" class="contents" @mouseenter="() => scheduleOpen('hover')" @mouseleave="scheduleClose" @focusin="scheduleFocusOpen" @focusout="close" @contextmenu.capture="suppressForContextMenu">
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="show"
      ref="tooltipRef"
      class="fixed z-50 rounded-md bg-foreground text-xs text-background"
      :class="[slots.content ? '' : 'inline-flex w-fit max-w-xs items-center gap-1.5 px-3 py-1.5', tooltipTransformClass]"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="tooltip"
      @mouseenter="clearCloseTimer"
      @mouseleave="scheduleClose"
    >
      <slot name="content">{{ text }}</slot>
      <span :class="[arrowClass, 'size-2.5 rotate-45 rounded-[2px] bg-foreground']" aria-hidden="true" />
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    text: string;
    disabled?: boolean | (() => boolean);
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
    delay?: number;
  }>(),
  {
    disabled: false,
    side: "top",
    sideOffset: 8,
    delay: 300,
  },
);

const triggerRef = ref<HTMLElement>();
const show = ref(false);
const x = ref(0);
const y = ref(0);
let timer: ReturnType<typeof setTimeout> | null = null;

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

function isTriggerActive(): boolean {
  const el = triggerElement();
  if (!el || !el.isConnected) return false;
  const active = document.activeElement;
  return el.matches(":hover") || (active instanceof Node && el.contains(active));
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
  show.value = false;
  removeGlobalListeners();
}

function closeIfTriggerInactive() {
  if (!isTriggerActive()) close();
}

function addGlobalListeners() {
  window.addEventListener("scroll", close, true);
  window.addEventListener("resize", close);
  window.addEventListener("blur", close);
  document.addEventListener("visibilitychange", close);
  document.addEventListener("pointermove", closeIfTriggerInactive, true);
  document.addEventListener("pointerdown", close, true);
  document.addEventListener("contextmenu", close, true);
}

function removeGlobalListeners() {
  window.removeEventListener("scroll", close, true);
  window.removeEventListener("resize", close);
  window.removeEventListener("blur", close);
  document.removeEventListener("visibilitychange", close);
  document.removeEventListener("pointermove", closeIfTriggerInactive, true);
  document.removeEventListener("pointerdown", close, true);
  document.removeEventListener("contextmenu", close, true);
}

const slots = defineSlots<{ default(): any; content?(): any }>();
const hasContent = computed(() => !!props.text || !!slots.content);

function open() {
  if (isDisabled() || !hasContent.value) return;
  if (!isTriggerActive()) return;
  updatePosition();
  show.value = true;
  addGlobalListeners();
}

function scheduleOpen() {
  if (isDisabled() || !hasContent.value) return;
  clearTimer();
  timer = setTimeout(open, props.delay);
}

onBeforeUnmount(close);

watch(
  () => [props.disabled, props.text] as const,
  () => {
    if (isDisabled() || !props.text) close();
    else if (show.value) updatePosition();
  },
);
</script>

<template>
  <span
    ref="triggerRef"
    class="contents"
    @mouseenter="scheduleOpen"
    @mouseleave="close"
    @focusin="scheduleOpen"
    @focusout="close"
  >
    <slot />
  </span>
  <Teleport to="body">
    <div
      v-if="show"
      class="pointer-events-none fixed z-50 rounded-md bg-foreground text-xs text-background"
      :class="[
        slots.content ? '' : 'inline-flex w-fit max-w-xs items-center gap-1.5 px-3 py-1.5',
        tooltipTransformClass,
      ]"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="tooltip"
    >
      <slot name="content">{{ text }}</slot>
      <span :class="[arrowClass, 'size-2.5 rotate-45 rounded-[2px] bg-foreground']" aria-hidden="true" />
    </div>
  </Teleport>
</template>

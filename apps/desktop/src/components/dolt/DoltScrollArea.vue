<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from "vue";

const props = defineProps<{
  scrollerClass?: string;
}>();

const emit = defineEmits<{
  scroll: [element: HTMLElement];
  resize: [element: HTMLElement];
}>();

const scroller = ref<HTMLElement | null>(null);
const horizontalThumb = ref<HTMLElement | null>(null);
const verticalThumb = ref<HTMLElement | null>(null);
const hasHorizontalOverflow = ref(false);
const hasVerticalOverflow = ref(false);
let horizontalThumbLeft = 0;
let horizontalThumbWidth = 100;
let verticalThumbTop = 0;
let verticalThumbHeight = 100;
let resizeObserver: ResizeObserver | undefined;
let mutationObserver: MutationObserver | undefined;
let refreshFrame = 0;
let dragFrame = 0;
let pendingDragPosition = 0;
let dragState:
  | {
      axis: "horizontal" | "vertical";
      track: HTMLElement;
      trackRect: DOMRect;
      thumbOffset: number;
      maxScroll: number;
    }
  | undefined;

function applyThumbStyles() {
  if (horizontalThumb.value) {
    horizontalThumb.value.style.left = `${horizontalThumbLeft}%`;
    horizontalThumb.value.style.width = `${horizontalThumbWidth}%`;
  }
  if (verticalThumb.value) {
    verticalThumb.value.style.top = `${verticalThumbTop}%`;
    verticalThumb.value.style.height = `${verticalThumbHeight}%`;
  }
}

function updateMetrics(emitResize = false) {
  const element = scroller.value;
  if (!element) return;
  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  const maxScrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
  hasHorizontalOverflow.value = maxScrollLeft > 1;
  hasVerticalOverflow.value = maxScrollTop > 1;

  const rawHorizontalWidth = element.scrollWidth > 0 ? (element.clientWidth / element.scrollWidth) * 100 : 100;
  horizontalThumbWidth = Math.min(100, Math.max(6, rawHorizontalWidth));
  horizontalThumbLeft = maxScrollLeft > 0 ? (element.scrollLeft / maxScrollLeft) * Math.max(0, 100 - horizontalThumbWidth) : 0;
  const rawVerticalHeight = element.scrollHeight > 0 ? (element.clientHeight / element.scrollHeight) * 100 : 100;
  verticalThumbHeight = Math.min(100, Math.max(6, rawVerticalHeight));
  verticalThumbTop = maxScrollTop > 0 ? (element.scrollTop / maxScrollTop) * Math.max(0, 100 - verticalThumbHeight) : 0;
  nextTick(applyThumbStyles);
  if (emitResize) emit("resize", element);
}

function scheduleMetricsRefresh(emitResize = false) {
  if (refreshFrame) cancelAnimationFrame(refreshFrame);
  refreshFrame = requestAnimationFrame(() => {
    refreshFrame = 0;
    updateMetrics(emitResize);
  });
}

function onScroll() {
  const element = scroller.value;
  if (!element) return;
  updateMetrics();
  emit("scroll", element);
}

function applyDrag() {
  dragFrame = 0;
  const state = dragState;
  const element = scroller.value;
  if (!state || !element) return;
  const trackLength = state.axis === "horizontal" ? state.trackRect.width : state.trackRect.height;
  const thumbPercent = state.axis === "horizontal" ? horizontalThumbWidth : verticalThumbHeight;
  const thumbLength = trackLength * (thumbPercent / 100);
  const maximumThumbPosition = Math.max(1, trackLength - thumbLength);
  const pointerPosition = pendingDragPosition - (state.axis === "horizontal" ? state.trackRect.left : state.trackRect.top);
  const thumbPosition = Math.min(maximumThumbPosition, Math.max(0, pointerPosition - state.thumbOffset));
  const scrollPosition = (thumbPosition / maximumThumbPosition) * state.maxScroll;
  if (state.axis === "horizontal") element.scrollLeft = scrollPosition;
  else element.scrollTop = scrollPosition;
  onScroll();
}

function onDragMove(event: PointerEvent) {
  if (!dragState) return;
  event.preventDefault();
  pendingDragPosition = dragState.axis === "horizontal" ? event.clientX : event.clientY;
  if (!dragFrame) dragFrame = requestAnimationFrame(applyDrag);
}

function stopDrag() {
  if (!dragState) return;
  if (dragFrame) {
    cancelAnimationFrame(dragFrame);
    applyDrag();
  }
  dragState.track.classList.remove("dolt-scrollbar-dragging");
  dragState = undefined;
  document.body.style.userSelect = "";
  window.removeEventListener("pointermove", onDragMove, true);
  window.removeEventListener("pointerup", stopDrag, true);
  window.removeEventListener("pointercancel", stopDrag, true);
}

function startDrag(axis: "horizontal" | "vertical", event: PointerEvent) {
  const element = scroller.value;
  const track = event.currentTarget as HTMLElement;
  if (!element) return;
  const maxScroll = axis === "horizontal" ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
  if (maxScroll <= 1) return;
  const trackRect = track.getBoundingClientRect();
  const trackLength = axis === "horizontal" ? trackRect.width : trackRect.height;
  const thumbPercent = axis === "horizontal" ? horizontalThumbWidth : verticalThumbHeight;
  const thumbStartPercent = axis === "horizontal" ? horizontalThumbLeft : verticalThumbTop;
  const thumbLength = trackLength * (thumbPercent / 100);
  const thumbStart = trackLength * (thumbStartPercent / 100);
  const pointerPosition = axis === "horizontal" ? event.clientX - trackRect.left : event.clientY - trackRect.top;
  const pointerInsideThumb = pointerPosition >= thumbStart && pointerPosition <= thumbStart + thumbLength;
  dragState = {
    axis,
    track,
    trackRect,
    thumbOffset: pointerInsideThumb ? pointerPosition - thumbStart : thumbLength / 2,
    maxScroll,
  };
  pendingDragPosition = axis === "horizontal" ? event.clientX : event.clientY;
  track.classList.add("dolt-scrollbar-dragging");
  document.body.style.userSelect = "none";
  window.addEventListener("pointermove", onDragMove, true);
  window.addEventListener("pointerup", stopDrag, true);
  window.addEventListener("pointercancel", stopDrag, true);
  event.preventDefault();
  applyDrag();
}

function scrollerElement(): HTMLElement | null {
  return scroller.value;
}

defineExpose({ scrollerElement, refresh: scheduleMetricsRefresh });

onMounted(() => {
  updateMetrics(true);
  resizeObserver = new ResizeObserver(() => scheduleMetricsRefresh(true));
  if (scroller.value) resizeObserver.observe(scroller.value);
  mutationObserver = new MutationObserver(() => scheduleMetricsRefresh(true));
  if (scroller.value) mutationObserver.observe(scroller.value, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style"] });
});

onUnmounted(() => {
  stopDrag();
  resizeObserver?.disconnect();
  mutationObserver?.disconnect();
  if (refreshFrame) cancelAnimationFrame(refreshFrame);
});
</script>

<template>
  <div class="dolt-scroll-area">
    <div ref="scroller" class="dolt-scroll-area-scroller" :class="props.scrollerClass" @scroll.passive="onScroll">
      <slot />
    </div>
    <div v-if="hasHorizontalOverflow" class="dolt-horizontal-scrollbar" @pointerdown="startDrag('horizontal', $event)">
      <div ref="horizontalThumb" class="dolt-horizontal-scrollbar-thumb" />
    </div>
    <div v-if="hasVerticalOverflow" class="dolt-vertical-scrollbar" :class="{ 'dolt-vertical-scrollbar-with-horizontal': hasHorizontalOverflow }" @pointerdown="startDrag('vertical', $event)">
      <div ref="verticalThumb" class="dolt-vertical-scrollbar-thumb" />
    </div>
  </div>
</template>

<style scoped>
.dolt-scroll-area {
  position: relative;
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
}

.dolt-scroll-area-scroller {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  overscroll-behavior: none;
  scrollbar-width: none;
}

.dolt-scroll-area-scroller::-webkit-scrollbar {
  display: none;
}

.dolt-horizontal-scrollbar {
  position: relative;
  height: 10px;
  flex: 0 0 10px;
  cursor: pointer;
  touch-action: none;
  background: var(--background);
}

.dolt-horizontal-scrollbar-thumb {
  position: absolute;
  top: 3px;
  height: 4px;
  min-width: 24px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  transition:
    top 120ms ease,
    height 120ms ease,
    background-color 120ms ease;
}

.dolt-horizontal-scrollbar:hover .dolt-horizontal-scrollbar-thumb,
.dolt-horizontal-scrollbar.dolt-scrollbar-dragging .dolt-horizontal-scrollbar-thumb {
  top: 2px;
  height: 6px;
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
}

.dolt-vertical-scrollbar {
  position: absolute;
  top: 2px;
  right: 0;
  bottom: 2px;
  z-index: 5;
  width: 10px;
  cursor: pointer;
  touch-action: none;
}

.dolt-vertical-scrollbar-with-horizontal {
  bottom: 12px;
}

.dolt-vertical-scrollbar-thumb {
  position: absolute;
  right: 3px;
  width: 4px;
  min-height: 24px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--foreground) 30%, transparent);
  transition:
    right 120ms ease,
    width 120ms ease,
    background-color 120ms ease;
}

.dolt-vertical-scrollbar:hover .dolt-vertical-scrollbar-thumb,
.dolt-vertical-scrollbar.dolt-scrollbar-dragging .dolt-vertical-scrollbar-thumb {
  right: 2px;
  width: 6px;
  background: color-mix(in oklab, var(--foreground) 48%, transparent);
}
</style>

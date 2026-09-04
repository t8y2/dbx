<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref } from "vue";

const HIDE_DELAY = 800;

const scrollRef = ref<HTMLElement>();
const trackRef = ref<HTMLElement>();
const thumbRef = ref<HTMLElement>();
const hasOverflow = ref(false);
const isScrolling = ref(false);
const isDragging = ref(false);
const thumbStyle = ref({ insetInlineStart: "0%", width: "100%" });

let hideTimer: ReturnType<typeof setTimeout> | null = null;
let resizeObserver: ResizeObserver | null = null;
let dragState: {
  pointerOffset: number;
  trackLeft: number;
  trackWidth: number;
  thumbWidth: number;
  maxScrollLeft: number;
} | null = null;

function clearHideTimer() {
  if (!hideTimer) return;
  clearTimeout(hideTimer);
  hideTimer = null;
}

function scheduleHide() {
  clearHideTimer();
  hideTimer = setTimeout(() => {
    isScrolling.value = false;
    hideTimer = null;
  }, HIDE_DELAY);
}

function updateMetrics() {
  const element = scrollRef.value;
  if (!element) return;

  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  hasOverflow.value = maxScrollLeft > 1;
  if (!hasOverflow.value) {
    thumbStyle.value = { insetInlineStart: "0%", width: "100%" };
    return;
  }

  const thumbWidth = Math.min(100, Math.max(10, (element.clientWidth / element.scrollWidth) * 100));
  const thumbTravel = Math.max(0, 100 - thumbWidth);
  thumbStyle.value = {
    insetInlineStart: `${(element.scrollLeft / maxScrollLeft) * thumbTravel}%`,
    width: `${thumbWidth}%`,
  };
}

function onScroll() {
  updateMetrics();
  isScrolling.value = true;
  scheduleHide();
}

function onTrackPointerDown(event: PointerEvent) {
  const element = scrollRef.value;
  const track = trackRef.value;
  const thumb = thumbRef.value;
  if (!element || !track || !thumb || !hasOverflow.value) return;

  event.preventDefault();
  const trackRect = track.getBoundingClientRect();
  const thumbRect = thumb.getBoundingClientRect();
  const pointerOnThumb = event.target === thumb || thumb.contains(event.target as Node);
  dragState = {
    pointerOffset: pointerOnThumb ? event.clientX - thumbRect.left : thumbRect.width / 2,
    trackLeft: trackRect.left,
    trackWidth: trackRect.width,
    thumbWidth: thumbRect.width,
    maxScrollLeft: element.scrollWidth - element.clientWidth,
  };
  isDragging.value = true;
  isScrolling.value = true;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", stopDragging);
  window.addEventListener("pointercancel", stopDragging);
}

function onPointerMove(event: PointerEvent) {
  if (!dragState || !scrollRef.value) return;
  const travel = Math.max(1, dragState.trackWidth - dragState.thumbWidth);
  const thumbLeft = Math.min(Math.max(event.clientX - dragState.trackLeft - dragState.pointerOffset, 0), travel);
  scrollRef.value.scrollLeft = (thumbLeft / travel) * dragState.maxScrollLeft;
  updateMetrics();
}

function stopDragging() {
  dragState = null;
  isDragging.value = false;
  scheduleHide();
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", stopDragging);
  window.removeEventListener("pointercancel", stopDragging);
}

onMounted(() => {
  resizeObserver = new ResizeObserver(updateMetrics);
  if (scrollRef.value) resizeObserver.observe(scrollRef.value);
  void nextTick(updateMetrics);
});

onBeforeUnmount(() => {
  stopDragging();
  clearHideTimer();
  resizeObserver?.disconnect();
});
</script>

<template>
  <div class="redis-horizontal-scroll-host" :class="{ 'is-scrolling': isScrolling, 'is-dragging': isDragging }">
    <div ref="scrollRef" class="redis-format-tabs-scroll flex max-w-full overflow-x-auto rounded-md border bg-muted/20 p-0.5" @scroll="onScroll">
      <slot />
    </div>
    <div v-if="hasOverflow" ref="trackRef" class="redis-format-tabs-scrollbar" @pointerdown="onTrackPointerDown">
      <div class="redis-format-tabs-scrollbar__thumb" :style="thumbStyle" ref="thumbRef" />
    </div>
  </div>
</template>

<style scoped>
.redis-horizontal-scroll-host {
  position: relative;
  min-width: 0;
  max-width: 100%;
  flex: 1 1 auto;
}

.redis-format-tabs-scroll {
  scrollbar-width: none;
  scrollbar-gutter: auto;
  overflow-y: hidden;
}

.redis-format-tabs-scroll::-webkit-scrollbar {
  display: none;
}

.redis-format-tabs-scrollbar {
  position: absolute;
  inset-inline: 0;
  bottom: 1px;
  z-index: 2;
  height: 7px;
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  touch-action: none;
  transition: opacity 140ms ease;
}

.redis-horizontal-scroll-host:hover .redis-format-tabs-scrollbar,
.redis-horizontal-scroll-host.is-scrolling .redis-format-tabs-scrollbar,
.redis-horizontal-scroll-host.is-dragging .redis-format-tabs-scrollbar {
  opacity: 1;
  pointer-events: auto;
}

.redis-format-tabs-scrollbar::before,
.redis-format-tabs-scrollbar__thumb {
  position: absolute;
  top: 1px;
  height: 5px;
  border-radius: 999px;
}

.redis-format-tabs-scrollbar::before {
  content: "";
  inset-inline: 0;
  background: color-mix(in oklch, var(--foreground) 10%, transparent);
}

.redis-format-tabs-scrollbar__thumb {
  min-width: 20px;
  background: color-mix(in oklch, var(--foreground) 38%, transparent);
}
</style>

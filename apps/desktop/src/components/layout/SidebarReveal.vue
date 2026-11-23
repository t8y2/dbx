<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { SIDEBAR_HOVER_DELAY_DEFAULT, normalizeSidebarHoverDelay } from "@/lib/sidebar/sidebarHoverSettings";
import { isPanelResizing } from "@/lib/app/panelResizeState";

const props = withDefaults(defineProps<{ pinned: boolean; enabled: boolean; classicLayout: boolean; hoverEnabled?: boolean; hoverDelay?: number }>(), { hoverEnabled: true, hoverDelay: SIDEBAR_HOVER_DELAY_DEFAULT });
const panel = ref<HTMLElement | null>(null);
const revealed = ref(false);
const visible = computed(() => props.enabled && (props.pinned || revealed.value));
let inside = false;
let pressed = false;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

function clearTimers() {
  clearTimeout(openTimer);
  clearTimeout(closeTimer);
}

function dismiss() {
  clearTimers();
  revealed.value = false;
  inside = false;
  pressed = false;
}

// These surfaces are teleported to body, outside the sidebar's pointer region.
// Hold the preview while an interaction is open, including nested menus/dialogs.
function hasOpenSurface() {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-dbx-context-menu], [role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')).some((surface) => {
    for (let node: HTMLElement | null = surface; node; node = node.parentElement) {
      if (node.hidden || node.getAttribute("data-state") === "closed" || node.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  });
}

function scheduleClose(delay = 300) {
  clearTimeout(closeTimer);
  if (!revealed.value || props.pinned || inside) return;
  closeTimer = setTimeout(() => {
    if (inside) return;
    if (pressed || isPanelResizing.value || hasOpenSurface()) {
      scheduleClose(100);
      return;
    }
    if (panel.value?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur();
    dismiss();
  }, delay);
}

function enterEdge(event: PointerEvent) {
  if (event.pointerType === "touch" || event.buttons || !props.enabled || !props.hoverEnabled || props.pinned) return;
  inside = true;
  clearTimers();
  if (revealed.value) return;
  openTimer = setTimeout(() => {
    revealed.value = true;
  }, normalizeSidebarHoverDelay(props.hoverDelay));
}

function enterPanel() {
  inside = true;
  clearTimers();
}

function leave() {
  inside = false;
  clearTimeout(openTimer);
  scheduleClose();
}

function pointerDown() {
  pressed = true;
}

function pointerUp() {
  pressed = false;
  scheduleClose();
}

watch(() => [props.pinned, props.enabled, props.hoverEnabled, props.hoverDelay], dismiss, { flush: "sync" });
watch(isPanelResizing, (resizing) => {
  if (!resizing) scheduleClose();
});
watch(revealed, (open, _previous, onCleanup) => {
  if (!open) return;
  document.addEventListener("pointerdown", pointerDown, true);
  document.addEventListener("pointerup", pointerUp, true);
  document.addEventListener("pointercancel", pointerUp, true);
  window.addEventListener("blur", dismiss);
  onCleanup(() => {
    document.removeEventListener("pointerdown", pointerDown, true);
    document.removeEventListener("pointerup", pointerUp, true);
    document.removeEventListener("pointercancel", pointerUp, true);
    window.removeEventListener("blur", dismiss);
  });
});
onUnmounted(clearTimers);
defineExpose({ dismiss });
</script>

<template>
  <div v-if="enabled && hoverEnabled && !pinned" data-sidebar-reveal-edge aria-hidden="true" class="sidebar-reveal-edge" @pointerenter="enterEdge" @pointerleave="leave" />
  <Transition :name="pinned ? '' : 'sidebar-reveal'">
    <div
      v-show="visible"
      ref="panel"
      data-sidebar-reveal-panel
      :data-sidebar-preview="!pinned && revealed ? '' : undefined"
      :class="pinned ? 'h-full shrink-0' : ['sidebar-reveal-overlay bg-background-solid', { 'sidebar-reveal-inset': !classicLayout }]"
      @pointerenter="enterPanel"
      @pointerleave="leave"
    >
      <slot />
    </div>
  </Transition>
</template>

<style scoped>
.sidebar-reveal-edge {
  position: absolute;
  inset: 0 auto 0 0;
  width: 6px;
  z-index: 31;
}
.sidebar-reveal-overlay {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 30;
  box-shadow: 6px 0 20px rgb(0 0 0 / 18%);
}
.sidebar-reveal-inset {
  top: 4px;
  bottom: 4px;
  left: 4px;
  border-radius: var(--radius);
}
.sidebar-reveal-enter-active,
.sidebar-reveal-leave-active {
  transition:
    transform 180ms ease,
    opacity 180ms ease;
}
.sidebar-reveal-enter-from,
.sidebar-reveal-leave-to {
  transform: translateX(-100%);
  opacity: 0;
}
.sidebar-reveal-leave-active {
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .sidebar-reveal-enter-active,
  .sidebar-reveal-leave-active {
    transition: none;
  }
}
</style>

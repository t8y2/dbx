<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useTheme } from "@/composables/useTheme";
import { TAB_DRAG_PREVIEW_CONTENT_EVENT, TAB_DRAG_PREVIEW_READY_EVENT, type TabDragPreviewContentPayload } from "@/lib/tabs/tabWindowPreviewHost";
import { TAB_DRAG_PREVIEW_HOST_PADDING } from "@/lib/tabs/tabWindowPreview";
import TabDragPreviewChip from "./TabDragPreviewChip.vue";

const appearance = shallowRef<TabDragPreviewContentPayload | null>(null);
const pixelRatio = ref(window.devicePixelRatio || 1);
const updatePixelRatio = () => {
  pixelRatio.value = window.devicePixelRatio || 1;
};
const { applyTheme } = useTheme();
let unlisten: (() => void) | null = null;
let disposed = false;

onMounted(() => {
  applyTheme();
  window.addEventListener("resize", updatePixelRatio);
  const current = getCurrentWebviewWindow();
  void current
    .listen<TabDragPreviewContentPayload>(TAB_DRAG_PREVIEW_CONTENT_EVENT, async (event) => {
      if (disposed) return;
      appearance.value = event.payload;
      updatePixelRatio();
      await nextTick();
      if (!disposed) await current.show().catch(() => {});
    })
    .then(async (dispose) => {
      if (disposed) dispose();
      else {
        unlisten = dispose;
        const source = new URLSearchParams(window.location.search).get("source");
        if (source) await emitTo({ kind: "WebviewWindow", label: source }, TAB_DRAG_PREVIEW_READY_EVENT, { label: current.label });
      }
    })
    .catch((error) => console.warn("[DBX][tab-preview:init]", error));
});

onUnmounted(() => {
  disposed = true;
  window.removeEventListener("resize", updatePixelRatio);
  unlisten?.();
});
</script>

<template>
  <div v-if="appearance" class="inline-flex origin-top-left bg-transparent" :style="{ padding: `${TAB_DRAG_PREVIEW_HOST_PADDING}px`, transform: `scale(${appearance.pixelRatio / pixelRatio})` }">
    <TabDragPreviewChip :appearance="appearance" />
  </div>
</template>

<style>
html,
body,
#root {
  background: transparent !important;
}
</style>

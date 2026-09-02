<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { listen } from "@tauri-apps/api/event";
import { useTheme } from "@/composables/useTheme";
import { TAB_DRAG_PREVIEW_CONTENT_EVENT, type TabDragPreviewContentPayload } from "@/lib/tabs/tabWindowTransfer";
import TabDragPreviewChip from "./TabDragPreviewChip.vue";

const title = ref(new URLSearchParams(window.location.search).get("title") ?? "");
const { applyTheme } = useTheme();
let unlisten: (() => void) | null = null;

onMounted(() => {
  applyTheme();
  void listen<TabDragPreviewContentPayload>(TAB_DRAG_PREVIEW_CONTENT_EVENT, (event) => {
    title.value = event.payload.title;
  }).then((dispose) => {
    unlisten = dispose;
  });
});

onUnmounted(() => unlisten?.());
</script>

<template>
  <div class="flex h-screen w-screen bg-transparent">
    <TabDragPreviewChip :title="title" class="h-full w-full" />
  </div>
</template>

<style>
html,
body,
#root {
  background: transparent !important;
}
</style>

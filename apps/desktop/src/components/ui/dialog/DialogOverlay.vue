<script setup lang="ts">
import type { DialogOverlayProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { DialogOverlay } from "reka-ui";
import { cn } from "@/lib/utils";
import { isTauriRuntime } from "@/lib/tauriRuntime";

const props = defineProps<DialogOverlayProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = reactiveOmit(props, "class");
const isDesktop = isTauriRuntime();

async function startWindowDrag(event: PointerEvent) {
  if (!isDesktop || event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const currentWindow = getCurrentWindow();
  if (event.detail >= 2) {
    await currentWindow.toggleMaximize().catch(() => {});
    return;
  }
  await currentWindow.startDragging().catch(() => {});
}
</script>

<template>
  <DialogOverlay data-slot="dialog-overlay" v-bind="delegatedProps" :class="cn('data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-open:supports-backdrop-filter:backdrop-blur-xs bg-black/10 duration-100 fixed inset-0 isolate z-50', props.class)">
    <div v-if="isDesktop" aria-hidden="true" class="fixed inset-x-0 top-0 h-10 pointer-events-auto" data-tauri-drag-region @pointerdown="startWindowDrag" />
    <slot />
  </DialogOverlay>
</template>

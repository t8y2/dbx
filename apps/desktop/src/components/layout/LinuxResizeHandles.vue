<script setup lang="ts">
// The transparent margin around the Linux floating frame (see .dbx-linux-floating)
// is covered by the webview, which owns the cursor there, so tao's own edge
// hit-testing never shows a resize cursor. These handles live in that margin.
type ResizeDirection = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const handles: { direction: ResizeDirection; cursor: string; class: string }[] = [
  { direction: "North", cursor: "n-resize", class: "top-0 inset-x-5 h-2" },
  { direction: "South", cursor: "s-resize", class: "bottom-0 inset-x-5 h-2" },
  { direction: "West", cursor: "w-resize", class: "left-0 inset-y-5 w-2" },
  { direction: "East", cursor: "e-resize", class: "right-0 inset-y-5 w-2" },
  { direction: "NorthWest", cursor: "nw-resize", class: "top-0 left-0 size-5" },
  { direction: "NorthEast", cursor: "ne-resize", class: "top-0 right-0 size-5" },
  { direction: "SouthWest", cursor: "sw-resize", class: "bottom-0 left-0 size-5" },
  { direction: "SouthEast", cursor: "se-resize", class: "bottom-0 right-0 size-5" },
];

async function startResize(direction: ResizeDirection, event: MouseEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startResizeDragging(direction);
}
</script>

<template>
  <Teleport to="body">
    <div v-for="handle in handles" :key="handle.direction" class="fixed z-[100000]" :class="handle.class" :style="{ cursor: handle.cursor }" @mousedown="startResize(handle.direction, $event)" />
  </Teleport>
</template>

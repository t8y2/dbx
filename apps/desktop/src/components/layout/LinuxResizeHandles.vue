<script setup lang="ts">
// The transparent margin around the Linux floating frame (see .dbx-linux-floating)
// is covered by the webview, which owns the cursor there, so tao's own edge
// hit-testing never shows a resize cursor. These handles live in that margin.
import type { Window } from "@tauri-apps/api/window";

type ResizeDirection = Parameters<Window["startResizeDragging"]>[0];

// Geometry matches `.dbx-app-root` padding (MARGIN). Only the GRAB px just outside the
// visible edge are grabbable, so the rest of the transparent margin (the shadow) is inert.
const MARGIN = 20;
const GRAB = 6;
const CORNER = 14;
const OUTER = MARGIN - GRAB;
const EDGE_INSET = OUTER + CORNER;

const handles: { direction: ResizeDirection; cursor: string; style: Record<string, string> }[] = [
  { direction: "North", cursor: "n-resize", style: { top: `${OUTER}px`, left: `${EDGE_INSET}px`, right: `${EDGE_INSET}px`, height: `${GRAB}px` } },
  { direction: "South", cursor: "s-resize", style: { bottom: `${OUTER}px`, left: `${EDGE_INSET}px`, right: `${EDGE_INSET}px`, height: `${GRAB}px` } },
  { direction: "West", cursor: "w-resize", style: { left: `${OUTER}px`, top: `${EDGE_INSET}px`, bottom: `${EDGE_INSET}px`, width: `${GRAB}px` } },
  { direction: "East", cursor: "e-resize", style: { right: `${OUTER}px`, top: `${EDGE_INSET}px`, bottom: `${EDGE_INSET}px`, width: `${GRAB}px` } },
  { direction: "NorthWest", cursor: "nw-resize", style: { top: `${OUTER}px`, left: `${OUTER}px`, width: `${CORNER}px`, height: `${CORNER}px` } },
  { direction: "NorthEast", cursor: "ne-resize", style: { top: `${OUTER}px`, right: `${OUTER}px`, width: `${CORNER}px`, height: `${CORNER}px` } },
  { direction: "SouthWest", cursor: "sw-resize", style: { bottom: `${OUTER}px`, left: `${OUTER}px`, width: `${CORNER}px`, height: `${CORNER}px` } },
  { direction: "SouthEast", cursor: "se-resize", style: { bottom: `${OUTER}px`, right: `${OUTER}px`, width: `${CORNER}px`, height: `${CORNER}px` } },
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
    <div v-for="handle in handles" :key="handle.direction" class="fixed z-[100000]" :style="{ ...handle.style, cursor: handle.cursor }" @mousedown="startResize(handle.direction, $event)" />
  </Teleport>
</template>

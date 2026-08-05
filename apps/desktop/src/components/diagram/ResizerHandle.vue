<script setup lang="ts">
import { ref } from "vue";

const emit = defineEmits<{
  (e: "resize", delta: number): void;
}>();

const isResizing = ref(false);
const startX = ref(0);

function onMouseDown(e: MouseEvent) {
  isResizing.value = true;
  startX.value = e.clientX;
  document.body.style.userSelect = "none";
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function onMouseMove(e: MouseEvent) {
  if (!isResizing.value) return;
  const delta = e.clientX - startX.value;
  startX.value = e.clientX;
  emit("resize", delta);
}

function onMouseUp() {
  isResizing.value = false;
  document.body.style.userSelect = "";
  document.removeEventListener("mousemove", onMouseMove);
  document.removeEventListener("mouseup", onMouseUp);
}
</script>

<template>
  <div class="w-1 cursor-col-resize flex items-center justify-center hover:bg-muted/50 transition-colors group" :class="{ 'bg-muted': isResizing }" @mousedown="onMouseDown">
    <div class="w-0.5 h-8 bg-border group-hover:bg-muted-foreground/50 transition-colors" />
  </div>
</template>

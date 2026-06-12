<script setup lang="ts">
import { computed } from "vue";
import type { DiffHunk } from "@/components/diff/DiffHunkBuilder";

const props = defineProps<{
  hunks: DiffHunk[];
  containerWidth: number;
  containerHeight: number;
}>();

const connectionPaths = computed(() => {
  const paths: { d: string; stroke: string; id: string }[] = [];
  const midX = props.containerWidth / 2;
  const halfLine = 10;

  for (const hunk of props.hunks) {
    // Only draw short connectors for modify hunks
    if (hunk.type !== "modify") continue;
    if (hunk.leftBottom <= hunk.leftTop || hunk.rightBottom <= hunk.rightTop) continue;
    if (hunk.leftBottom < 0 || hunk.rightBottom < 0) continue;
    if (hunk.leftTop > props.containerHeight || hunk.rightTop > props.containerHeight) continue;

    const leftY = (hunk.leftTop + hunk.leftBottom) / 2;
    const rightY = (hunk.rightTop + hunk.rightBottom) / 2;

    paths.push({
      id: hunk.id,
      d: `M ${midX - halfLine},${leftY} L ${midX + halfLine},${rightY}`,
      stroke: "rgba(234, 179, 8, 0.6)",
    });
  }
  return paths;
});
</script>

<template>
  <svg class="absolute inset-0 pointer-events-none z-10" :width="containerWidth" :height="containerHeight" xmlns="http://www.w3.org/2000/svg">
    <path v-for="path in connectionPaths" :key="path.id" :d="path.d" :stroke="path.stroke" fill="none" stroke-width="2" />
  </svg>
</template>

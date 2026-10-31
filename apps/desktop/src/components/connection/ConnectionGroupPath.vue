<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { connectionGroupPathLabel } from "@/lib/connection/connectionGroupPathLabel";

const props = defineProps<{ segments: string[]; connectionName: string }>();
const fullPath = computed(() => props.segments.join("/"));
const label = ref(fullPath.value);
const root = ref<HTMLElement>();
const measurement = ref<HTMLElement>();
let observer: ResizeObserver | undefined;
let disposed = false;

function updateLabel() {
  const element = root.value;
  const probe = measurement.value;
  if (!element || !probe || element.clientWidth <= 0) {
    label.value = fullPath.value;
    return;
  }
  const measure = (text: string) => {
    probe.textContent = text;
    return probe.getBoundingClientRect().width;
  };
  // The complete path and name establish a stable flex width. Only the visible
  // path shrinks; its released space goes to the adjacent connection name.
  const availableWidth = element.clientWidth - measure("/") - Math.min(measure(props.connectionName), element.clientWidth / 2);
  label.value = connectionGroupPathLabel(props.segments, (text) => measure(text) <= availableWidth);
}

watch(() => [props.segments, props.connectionName], updateLabel, { deep: true, flush: "post" });
onMounted(() => {
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(updateLabel);
    observer.observe(root.value!);
  }
  updateLabel();
  // Font loading can change the label width without changing the capped root.
  void document.fonts?.ready.then(() => {
    if (!disposed) updateLabel();
  });
});
onBeforeUnmount(() => {
  disposed = true;
  observer?.disconnect();
});
</script>

<template>
  <span ref="root" class="relative min-w-0 overflow-hidden whitespace-nowrap" :aria-label="`${fullPath}/${connectionName}`">
    <span aria-hidden="true" class="invisible">{{ fullPath }}/{{ connectionName }}</span>
    <span aria-hidden="true" class="absolute inset-0 flex items-center overflow-hidden">
      <span data-connection-group-path class="shrink-0 text-muted-foreground">{{ label }}</span>
      <span class="shrink-0 text-muted-foreground">/</span>
      <span class="min-w-0 flex-1 truncate">{{ connectionName }}</span>
    </span>
    <span ref="measurement" aria-hidden="true" class="invisible pointer-events-none absolute left-0 top-0 w-max" />
  </span>
</template>

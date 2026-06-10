<script setup lang="ts">
import { ref } from "vue";
import type { HTMLAttributes } from "vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    text: string;
    class?: HTMLAttributes["class"];
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
    delay?: number;
    openOnFocus?: boolean;
  }>(),
  {
    side: "top",
    sideOffset: 8,
    delay: 0,
    openOnFocus: true,
  },
);

const textRef = ref<HTMLElement>();

function isTooltipDisabled(): boolean {
  const el = textRef.value;
  if (!el) return true;
  return el.scrollWidth - el.clientWidth <= 2;
}
</script>

<template>
  <LightTooltip :text="text" :delay="delay" :disabled="isTooltipDisabled" :side="side" :side-offset="sideOffset" :open-on-focus="openOnFocus">
    <span ref="textRef" :class="cn('truncate', props.class)">
      <slot>{{ text }}</slot>
    </span>
  </LightTooltip>
</template>

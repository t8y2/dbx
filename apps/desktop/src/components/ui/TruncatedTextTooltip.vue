<script setup lang="ts">
import { ref } from "vue";
import type { HTMLAttributes } from "vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { cn } from "@/lib/common/utils";

const props = withDefaults(
  defineProps<{
    text: string;
    class?: HTMLAttributes["class"];
    tooltipClass?: HTMLAttributes["class"];
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
    <template v-if="tooltipClass" #content>
      <span :class="cn('block max-w-xs px-3 py-1.5', tooltipClass)">{{ text }}</span>
    </template>
  </LightTooltip>
</template>

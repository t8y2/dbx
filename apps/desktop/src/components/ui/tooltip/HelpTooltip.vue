<script setup lang="ts">
import { CircleHelp } from "@lucide/vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";

withDefaults(
  defineProps<{
    label: string;
    side?: "top" | "right" | "bottom" | "left";
    sideOffset?: number;
    delay?: number;
    closeDelay?: number;
    openOnFocus?: boolean;
    triggerClass?: string;
    contentClass?: string;
  }>(),
  {
    side: "top",
    sideOffset: 8,
    delay: 0,
    closeDelay: 100,
    openOnFocus: true,
    triggerClass: "",
    contentClass: "max-w-[320px]",
  },
);
</script>

<template>
  <LightTooltip :text="label" :side="side" :side-offset="sideOffset" :delay="delay" :close-delay="closeDelay" :open-on-focus="openOnFocus">
    <button type="button" class="inline-flex shrink-0 cursor-help items-center justify-center border-0 bg-transparent p-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" :class="triggerClass" :aria-label="label">
      <CircleHelp class="h-3.5 w-3.5" aria-hidden="true" />
    </button>
    <template #content>
      <div class="px-3 py-1.5 text-xs leading-relaxed" :class="contentClass">
        <slot />
      </div>
    </template>
  </LightTooltip>
</template>

<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
}>();
</script>

<template>
  <div data-slot="popover-title" :class="cn('font-medium cn-font-heading', props.class)">
    <slot />
  </div>
</template>

<script setup lang="ts">
import type { DialogOverlayProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { DialogOverlay } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<DialogOverlayProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
  <DialogOverlay data-slot="sheet-overlay" :class="cn('bg-black/20 fixed inset-0 z-50 data-open:animate-in data-open:fade-in-0 data-open:duration-200', props.class)" v-bind="delegatedProps">
    <slot />
  </DialogOverlay>
</template>

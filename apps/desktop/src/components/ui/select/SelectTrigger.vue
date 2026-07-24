<script setup lang="ts">
import type { SelectTriggerProps } from "reka-ui";

import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { ChevronDownIcon } from "@lucide/vue";
import { SelectIcon, SelectTrigger, useForwardProps } from "reka-ui";
import { cn } from "@/lib/common/utils";

const props = withDefaults(defineProps<SelectTriggerProps & { class?: HTMLAttributes["class"]; size?: "sm" | "default" }>(), { size: "default" });

const delegatedProps = reactiveOmit(props, "class", "size");
const forwardedProps = useForwardProps(delegatedProps);
</script>

<template>
  <SelectTrigger
    data-slot="select-trigger"
    :data-size="size"
    v-bind="forwardedProps"
    :class="
      cn(
        'dbx-select-trigger border-input data-placeholder:text-muted-foreground dark:bg-input/30 dark:hover:bg-input/50 focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 gap-1.5 rounded-md border bg-transparent py-2 pr-2 pl-2.5 text-sm transition-colors select-none focus-visible:ring-3 aria-invalid:ring-3 data-[size=default]:h-8 data-[size=sm]:h-7 *:data-[slot=select-value]:gap-1.5 [&_svg:not([class*=size-])]:size-4 flex w-fit items-center justify-between whitespace-nowrap outline-none disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center [&_svg]:pointer-events-none [&_svg]:shrink-0',
        props.class,
      )
    "
  >
    <slot />
    <SelectIcon as-child>
      <ChevronDownIcon class="text-muted-foreground size-4 pointer-events-none" />
    </SelectIcon>
  </SelectTrigger>
</template>

<style>
.dbx-select-trigger:not(.border-0):not(.border-transparent) {
  border: 1px solid rgb(229, 229, 229) !important;
  background-color: rgb(255, 255, 255) !important;
  box-shadow: none !important;
}

.dbx-select-trigger:not(.border-0):not(.border-transparent):hover {
  background-color: rgb(250, 250, 250) !important;
}

.dbx-select-trigger:not(.border-0):not(.border-transparent)[data-state="open"],
.dbx-select-trigger:not(.border-0):not(.border-transparent):focus-visible {
  border-color: rgb(96, 165, 250) !important;
  box-shadow: 0 0 0 2px rgba(96, 165, 250, 0.22) !important;
}

.dark .dbx-select-trigger:not(.border-0):not(.border-transparent) {
  border-color: rgba(255, 255, 255, 0.14) !important;
  background-color: rgba(255, 255, 255, 0.08) !important;
}

.dark .dbx-select-trigger:not(.border-0):not(.border-transparent):hover {
  background-color: rgba(255, 255, 255, 0.12) !important;
}

.dark .dbx-select-trigger:not(.border-0):not(.border-transparent)[data-state="open"],
.dark .dbx-select-trigger:not(.border-0):not(.border-transparent):focus-visible {
  border-color: rgb(147, 197, 253) !important;
  box-shadow: 0 0 0 2px rgba(147, 197, 253, 0.24) !important;
}
</style>

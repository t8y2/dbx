<script setup lang="ts">
import type { ContextMenuLabelProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { ContextMenuLabel } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<ContextMenuLabelProps & { class?: HTMLAttributes["class"]; inset?: boolean }>();

const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
  <ContextMenuLabel
    data-slot="context-menu-label"
    :data-inset="inset ? '' : undefined"
    v-bind="delegatedProps"
    :class="cn('text-muted-foreground px-1.5 py-1 text-xs font-medium data-inset:pl-7', props.class)"
  >
    <slot />
  </ContextMenuLabel>
</template>

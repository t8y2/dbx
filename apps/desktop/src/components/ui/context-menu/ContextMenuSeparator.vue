<script setup lang="ts">
import type { ContextMenuSeparatorProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { ContextMenuSeparator } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<ContextMenuSeparatorProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = reactiveOmit(props, "class");
</script>

<template>
  <ContextMenuSeparator
    data-slot="context-menu-separator"
    v-bind="delegatedProps"
    :class="cn('bg-foreground/6 -mx-1 my-0.5 h-px', props.class)"
  />
</template>

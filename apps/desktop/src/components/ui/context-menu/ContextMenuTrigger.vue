<script setup lang="ts">
import type { ContextMenuTriggerProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { ContextMenuTrigger, useForwardProps } from "reka-ui";
import { cn } from "@/lib/utils";

const props = defineProps<ContextMenuTriggerProps & { class?: HTMLAttributes["class"] }>();

const delegatedProps = reactiveOmit(props, "class");
const forwardedProps = useForwardProps(delegatedProps);
</script>

<template>
  <ContextMenuTrigger data-slot="context-menu-trigger" v-bind="forwardedProps" :class="cn('select-none', props.class)">
    <slot />
  </ContextMenuTrigger>
</template>

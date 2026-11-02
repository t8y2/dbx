<script setup lang="ts">
import type { TooltipContentEmits, TooltipContentProps } from "reka-ui";
import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { TooltipArrow, TooltipContent, TooltipPortal, useForwardPropsEmits } from "reka-ui";
import { cn } from "@/lib/common/utils";
import { useFloatingLayerOrder } from "@/components/ui/dialog/useDialogLayerOrder";

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(defineProps<TooltipContentProps & { class?: HTMLAttributes["class"]; surface?: "foreground" | "popover" }>(), {
  sideOffset: 0,
  surface: "foreground",
});

const emits = defineEmits<TooltipContentEmits>();

const delegatedProps = reactiveOmit(props, "class", "surface");
const forwarded = useForwardPropsEmits(delegatedProps, emits);
const { forwardRef } = useFloatingLayerOrder();
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      :ref="forwardRef"
      data-slot="tooltip-content"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="
        cn(
          'data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs has-data-[slot=kbd]:pr-1.5 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm z-(--dbx-floating-layer-z-index) w-fit max-w-xs origin-(--reka-tooltip-content-transform-origin)',
          props.surface === 'popover' ? 'border border-border bg-popover text-popover-foreground shadow-lg' : 'bg-foreground text-background-solid',
          props.class,
        )
      "
    >
      <slot />

      <TooltipArrow class="size-2.5 rotate-45 rounded-[2px] z-50 translate-y-[calc(-50%_-_2px)]" :class="props.surface === 'popover' ? 'border-b border-r border-border bg-popover fill-popover' : 'bg-foreground fill-foreground'" />
    </TooltipContent>
  </TooltipPortal>
</template>

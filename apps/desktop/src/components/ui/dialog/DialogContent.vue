<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui";

import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { XIcon } from "@lucide/vue";
import { DialogClose, DialogContent, DialogDescription, DialogPortal, VisuallyHidden, useForwardPropsEmits } from "reka-ui";
import { cn } from "@/lib/common/utils";
import { Button } from "@/components/ui/button";
import DialogOverlay from "./DialogOverlay.vue";

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(
  defineProps<
    DialogContentProps & {
      class?: HTMLAttributes["class"];
      overlayClass?: HTMLAttributes["class"];
      portalClass?: HTMLAttributes["class"];
      showCloseButton?: boolean;
    }
  >(),
  {
    showCloseButton: true,
  },
);
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class", "overlayClass", "portalClass");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <DialogPortal>
    <DialogOverlay :class="props.overlayClass" />
    <div :class="cn('fixed inset-0 z-50 grid place-items-center p-4 pointer-events-none', props.portalClass)">
      <DialogContent
        data-slot="dialog-content"
        v-bind="{ ...$attrs, ...forwarded }"
        :class="
          cn(
            'bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 relative grid max-h-[calc(var(--dbx-viewport-height)-2rem)] w-full max-w-sm gap-4 overflow-hidden rounded-xl border border-border p-4 text-sm shadow-lg duration-100 outline-none pointer-events-auto',
            props.class,
          )
        "
      >
        <VisuallyHidden as-child>
          <DialogDescription />
        </VisuallyHidden>

        <slot />

        <DialogClose v-if="showCloseButton" data-slot="dialog-close" as-child>
          <Button variant="ghost" class="absolute top-2 right-2" size="icon-sm">
            <XIcon />
            <span class="sr-only">Close</span>
          </Button>
        </DialogClose>
      </DialogContent>
    </div>
  </DialogPortal>
</template>

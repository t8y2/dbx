<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui";

import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { XIcon } from "@lucide/vue";
import { DialogClose, DialogContent, DialogDescription, DialogPortal, VisuallyHidden, useForwardPropsEmits } from "reka-ui";
import DialogOverlay from "./DialogOverlay.vue";
import { cn } from "@/lib/common/utils";

defineOptions({
  inheritAttrs: false,
});

const props = withDefaults(defineProps<DialogContentProps & { class?: HTMLAttributes["class"]; showOverlay?: boolean; showCloseButton?: boolean }>(), {
  showOverlay: true,
  showCloseButton: true,
});
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = reactiveOmit(props, "class", "showOverlay", "showCloseButton");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <DialogPortal>
    <DialogOverlay v-if="props.showOverlay" />
    <div data-slot="dialog-positioner" class="fixed inset-0 z-50 grid place-items-center p-4 pointer-events-none">
      <DialogContent
        data-slot="dialog-content"
        :class="cn('relative z-50 grid max-h-[calc(var(--dbx-viewport-height)-6rem)] w-full max-w-lg my-8 gap-4 rounded-lg border border-border bg-popover text-popover-foreground p-4 shadow-lg duration-200 md:w-full pointer-events-auto', props.class)"
        v-bind="{ ...$attrs, ...forwarded }"
        @pointer-down-outside="
          (event) => {
            const originalEvent = event.detail.originalEvent;
            const target = originalEvent.target as HTMLElement;
            if (target.closest('[role=menu], [role=listbox], [data-slot=select-content]')) {
              event.preventDefault();
              return;
            }
            if (originalEvent.offsetX > target.clientWidth || originalEvent.offsetY > target.clientHeight) {
              event.preventDefault();
            }
          }
        "
      >
        <VisuallyHidden as-child>
          <DialogDescription />
        </VisuallyHidden>

        <slot />

        <DialogClose v-if="props.showCloseButton" class="absolute top-4 right-4 rounded-md p-0.5 transition-colors hover:bg-secondary">
          <XIcon class="w-4 h-4" />
          <span class="sr-only">Close</span>
        </DialogClose>
      </DialogContent>
    </div>
  </DialogPortal>
</template>

<script setup lang="ts">
import type { ContextMenuCheckboxItemEmits, ContextMenuCheckboxItemProps } from "reka-ui";

import type { HTMLAttributes } from "vue";
import { reactiveOmit } from "@vueuse/core";
import { CheckIcon } from "@lucide/vue";
import { ContextMenuCheckboxItem, ContextMenuItemIndicator, useForwardPropsEmits } from "reka-ui";
import { shouldSuppressRepeatedActivation, suppressEvent, type ActionActivationGuard } from "@/lib/connection/actionActivation";
import { cn } from "@/lib/common/utils";

const props = defineProps<ContextMenuCheckboxItemProps & { class?: HTMLAttributes["class"] }>();
const emits = defineEmits<ContextMenuCheckboxItemEmits>();

const delegatedProps = reactiveOmit(props, "class");

const forwarded = useForwardPropsEmits(delegatedProps, emits);
const activationGuard: ActionActivationGuard = {};

function guardRepeatedClick(event: MouseEvent) {
  if (props.disabled) return;
  if (shouldSuppressRepeatedActivation(activationGuard)) {
    suppressEvent(event);
  }
}
</script>

<template>
  <ContextMenuCheckboxItem
    data-slot="context-menu-checkbox-item"
    v-bind="forwarded"
    @click.capture="guardRepeatedClick"
    :class="
      cn(
        'focus:bg-accent focus:text-accent-foreground gap-1.5 rounded-md py-1 pr-8 pl-1.5 text-sm data-inset:pl-7 [&_svg:not([class*=size-])]:size-4 relative flex cursor-default items-center outline-hidden select-none data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
        props.class,
      )
    "
  >
    <span class="absolute right-2 pointer-events-none">
      <ContextMenuItemIndicator>
        <slot name="indicator-icon">
          <CheckIcon />
        </slot>
      </ContextMenuItemIndicator>
    </span>
    <slot />
  </ContextMenuCheckboxItem>
</template>

<script setup lang="ts">
import { MoreHorizontal } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

/**
 * Shared "⋯" overflow trigger for measured-condensation toolbars
 * (useToolbarOverflow consumers). The trigger is a single-layer
 * DropdownMenuTrigger — deliberately NOT wrapped in a Tooltip, which breaks
 * the pointer event chain in WKWebView (see EditorToolbar's overflow menu).
 */
withDefaults(
  defineProps<{
    /** Accessible name / title for the trigger (already localized). */
    label: string;
    align?: "start" | "center" | "end";
    /** Extra classes for the trigger button, e.g. a different height. */
    buttonClass?: string;
    contentClass?: string;
  }>(),
  {
    align: "end",
    buttonClass: "",
    contentClass: "w-56",
  },
);
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground" :class="buttonClass" :aria-label="label" :title="label">
        <MoreHorizontal class="h-3.5 w-3.5" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent :align="align" :class="contentClass">
      <slot />
    </DropdownMenuContent>
  </DropdownMenu>
</template>

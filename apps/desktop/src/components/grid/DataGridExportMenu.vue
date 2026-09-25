<script setup lang="ts">
import { Upload } from "@lucide/vue";
import LightDropdown, { type LightDropdownItem } from "@/components/ui/LightDropdown.vue";

defineProps<{
  items: LightDropdownItem[];
  label: string;
  onSelect: (value: string) => void;
}>();
</script>

<template>
  <LightDropdown
    model-value=""
    :items="items"
    :aria-label="label"
    :trigger-icon="Upload"
    :trigger-label="label"
    trigger-class="inline-flex h-6 shrink-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-2 text-foreground/80 hover:bg-accent hover:text-accent-foreground"
    trigger-icon-class="h-3.5 w-3.5"
    :show-trigger-label="true"
    :show-chevron="true"
    :highlight-selected="false"
    check-position="none"
    align="end"
    @update:model-value="onSelect"
  />
</template>

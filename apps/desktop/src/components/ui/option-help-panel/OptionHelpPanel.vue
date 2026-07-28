<script setup lang="ts">
import { ref } from "vue";
import { OPTION_HELP_PANEL_CLASS } from "./optionHelpPanel";

const props = withDefaults(
  defineProps<{
    content: string;
    offsetTop?: number;
  }>(),
  { offsetTop: 0 },
);

const element = ref<HTMLElement>();
defineExpose({ element });
</script>

<template>
  <aside ref="element" data-slot="option-help-panel" role="note" :class="OPTION_HELP_PANEL_CLASS" :style="{ '--option-help-offset': `${offsetTop}px` }">
    {{ content }}
  </aside>
</template>

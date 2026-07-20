<script setup lang="ts">
defineProps<{
  title: string;
}>();
</script>

<template>
  <div class="mq-panel-toolbar">
    <div class="mq-toolbar-left">
      <h3>{{ title }}</h3>
      <slot name="left-extra" />
    </div>
    <div v-if="$slots.actions" class="mq-toolbar-actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<style scoped>
@import "./mqPanel.css";
</style>

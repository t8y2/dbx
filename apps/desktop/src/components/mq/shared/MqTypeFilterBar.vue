<script setup lang="ts">
defineProps<{
  label: string;
}>();
</script>

<template>
  <div class="mq-type-filter-bar">
    <span class="mq-type-filter-bar-label">{{ label }}</span>
    <slot />
  </div>
</template>

<style scoped>
.mq-type-filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border-light, var(--color-border));
  background: var(--color-background-secondary);
}

.mq-type-filter-bar-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, #6b7280);
  margin-right: 4px;
}
</style>

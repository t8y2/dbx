<script setup lang="ts">
defineProps<{
  modelValue: string;
  placeholder?: string;
  disabled?: boolean;
}>();

defineEmits<{
  "update:modelValue": [value: string];
}>();
</script>

<template>
  <input type="search" class="mq-search-input" :value="modelValue" :placeholder="placeholder" :disabled="disabled" @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)" />
</template>

<style scoped>
@import "./mqPanel.css";
</style>

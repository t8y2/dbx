<script setup lang="ts">
defineProps<{ name: string; comment?: string }>();
</script>

<template>
  <span class="max-w-[min(16rem,40vw)] truncate" :title="name">{{ name }}</span>
  <span v-if="comment?.trim()" class="max-w-[min(14rem,40vw)] truncate text-xs text-muted-foreground" :title="comment">{{ comment }}</span>
</template>

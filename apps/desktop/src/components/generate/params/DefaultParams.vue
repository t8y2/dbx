<script setup lang="ts">
defineProps<{ params: any; config: any }>();
</script>

<template>
  <div class="text-xs text-muted-foreground px-1 py-2">
    {{ config.generatorLabel || config.generatorKey }}
  </div>
</template>

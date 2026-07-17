<script setup lang="ts">
import { Loader2 } from "@lucide/vue";
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/20" aria-busy="true">
    <div class="rounded-md border border-border bg-background p-4 shadow-lg">
      <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { AlertTriangle } from "@lucide/vue";

defineProps<{ error?: unknown }>();
</script>

<template>
  <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/20">
    <div class="flex max-w-md items-start gap-2 rounded-md border border-destructive/40 bg-background p-4 text-sm text-destructive shadow-lg">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
      <span class="break-all">{{ error instanceof Error ? error.message : String(error || "Dialog failed to load") }}</span>
    </div>
  </div>
</template>

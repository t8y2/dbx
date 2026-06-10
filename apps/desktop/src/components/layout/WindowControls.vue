<script setup lang="ts">
import { Minus, Square, Copy, X } from "@lucide/vue";

defineProps<{
  isMaximized: boolean;
}>();

const emit = defineEmits<{
  minimize: [];
  "toggle-maximize": [];
  close: [];
}>();
</script>

<template>
  <div class="flex items-stretch -mr-2 ml-1">
    <button class="inline-flex items-center justify-center w-11.5 h-10 hover:bg-foreground/10 transition-colors" @click="emit('minimize')">
      <Minus class="h-4 w-4" />
    </button>
    <button class="inline-flex items-center justify-center w-11.5 h-10 hover:bg-foreground/10 transition-colors" @click="emit('toggle-maximize')">
      <Copy v-if="isMaximized" class="h-3.5 w-3.5" />
      <Square v-else class="h-3.5 w-3.5" />
    </button>
    <button class="inline-flex items-center justify-center w-11.5 h-10 hover:bg-red-500 hover:text-white transition-colors" @click="emit('close')">
      <X class="h-4 w-4" />
    </button>
  </div>
</template>

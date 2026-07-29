<script setup lang="ts">
import { ref } from "vue";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

const errorMessage = ref("");
const closing = ref(false);

function showError(error: unknown) {
  errorMessage.value = error instanceof Error ? error.message : String(error);
}

async function closeWindow() {
  if (closing.value) return;
  closing.value = true;
  try {
    await getCurrentWebviewWindow().destroy();
  } catch (error) {
    closing.value = false;
    showError(error);
  }
}

defineExpose({ showError });
</script>

<template>
  <div class="fixed inset-0 flex h-screen w-screen min-w-0 flex-col overflow-hidden bg-background text-foreground">
    <header class="flex h-10 shrink-0 items-center gap-2 border-b bg-muted/50 px-3" data-tauri-drag-region>
      <span class="min-w-0 flex-1 truncate text-sm font-medium" data-tauri-drag-region>DBX</span>
      <button type="button" class="flex h-7 w-7 items-center justify-center rounded text-lg leading-none text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50" aria-label="Close" :disabled="closing" @click="closeWindow">×</button>
    </header>

    <main class="flex min-h-0 flex-1 items-center justify-center p-6">
      <div v-if="errorMessage" class="max-w-lg rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
        <div class="mb-1 font-medium">Failed to open detached window</div>
        <div class="break-words text-xs opacity-80">{{ errorMessage }}</div>
      </div>
      <div v-else class="flex items-center gap-3 text-sm text-muted-foreground" role="status" aria-label="Loading detached tab">
        <span class="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/25 border-t-primary" />
        <span>Loading tab…</span>
      </div>
    </main>
  </div>
</template>

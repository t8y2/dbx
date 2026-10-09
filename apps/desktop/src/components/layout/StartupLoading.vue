<script setup lang="ts">
import { useI18n } from "vue-i18n";

const props = defineProps<{ label?: string; error?: unknown; retry?: () => void }>();
const { t } = useI18n();

function retry() {
  if (props.retry) props.retry();
  else window.location.reload();
}
</script>

<template>
  <div data-startup-loading class="fixed inset-0 z-[1100] flex flex-col items-center justify-center gap-4 bg-background text-foreground" :role="error ? 'alert' : 'status'" aria-live="polite" :aria-busy="!error">
    <span class="text-xl font-semibold tracking-tight" aria-hidden="true">DBX</span>
    <span v-if="!error" class="startup-spinner" aria-hidden="true" />
    <p class="text-sm text-muted-foreground">{{ label || t(error ? "startup.loadFailed" : "startup.loading") }}</p>
    <button v-if="error" class="rounded border border-border px-4 py-2 text-sm hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring" @click="retry">{{ t("common.retry") }}</button>
  </div>
</template>

<style scoped>
.startup-spinner {
  width: 22px;
  height: 22px;
  border: 2px solid var(--muted);
  border-top-color: var(--muted-foreground);
  border-radius: 50%;
  animation: startup-spin 0.8s linear infinite;
}

@keyframes startup-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .startup-spinner {
    animation: none;
  }
}
</style>

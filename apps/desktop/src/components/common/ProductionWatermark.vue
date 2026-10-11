<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const { locale } = useI18n();
const watermarkText = computed(() => (locale.value.startsWith("zh") ? "生产环境" : "PROD"));
</script>

<template>
  <div class="production-watermark pointer-events-none absolute inset-0 z-10 grid select-none" aria-hidden="true">
    <span v-for="index in 4" :key="index" class="production-watermark__label whitespace-nowrap font-mono text-6xl font-extrabold text-red-700/[0.12] dark:text-red-200/[0.1]">{{ watermarkText }}</span>
  </div>
</template>

<style scoped>
.production-watermark {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: 3rem;
  overflow: hidden;
  padding: 3rem 2.5rem;
}

.production-watermark__label {
  align-self: center;
  justify-self: center;
  transform: rotate(-22deg);
}

@media (max-width: 700px) {
  .production-watermark {
    grid-template-columns: 1fr;
    gap: 1.5rem;
    padding-inline: 1rem;
  }
}
</style>

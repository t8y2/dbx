<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ text?: string; fontSize?: number; color?: string }>();
const { locale } = useI18n();
const watermarkText = computed(() => props.text ?? (locale.value.startsWith("zh") ? "生产环境" : "PROD"));
</script>

<template>
  <div class="connection-watermark pointer-events-none absolute inset-0 z-10 select-none" aria-hidden="true">
    <div class="connection-watermark__grid">
      <span
        v-for="index in 4"
        :key="index"
        class="connection-watermark__label whitespace-nowrap font-mono font-extrabold"
        :class="{ 'connection-watermark__label--custom': fontSize !== undefined, 'text-red-700/[0.12] dark:text-red-200/[0.1]': !color }"
        :style="{ color, '--connection-watermark-font-size': fontSize === undefined ? undefined : fontSize + 'px' }"
        >{{ watermarkText }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.connection-watermark {
  container-type: size;
  overflow: hidden;
}

.connection-watermark__grid {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-template-rows: repeat(2, minmax(0, 1fr));
  gap: clamp(1rem, 4cqh, 3rem);
  overflow: hidden;
  padding: clamp(1rem, 6cqh, 3rem) clamp(1rem, 4cqw, 2.5rem);
}

.connection-watermark__label {
  align-self: center;
  justify-self: center;
  font-size: clamp(2rem, min(6cqh, 5cqw), 3.75rem);
  line-height: 1;
  transform: rotate(-22deg);
}

/* A short result pane cannot fit two rotated watermark rows safely. Use one
   row with fewer labels so the watermark stays legible without colliding. */
@container (max-height: 440px) {
  .connection-watermark__grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-template-rows: 1fr;
    gap: 1rem;
    padding: 1rem 1.5rem;
  }

  .connection-watermark__label {
    font-size: clamp(1.5rem, 10cqh, 2.75rem);
  }

  .connection-watermark__label:nth-child(n + 3) {
    display: none;
  }
}

@container (max-height: 280px) {
  .connection-watermark__grid {
    grid-template-columns: 1fr;
    padding: 0.5rem 1rem;
  }

  .connection-watermark__label {
    font-size: clamp(1.25rem, 12cqh, 2rem);
  }

  .connection-watermark__label:nth-child(n + 2) {
    display: none;
  }
}

@media (max-width: 700px) {
  .connection-watermark__grid {
    grid-template-columns: 1fr;
    gap: 1.5rem;
    padding-inline: 1rem;
  }
}

.connection-watermark__label--custom {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: min(var(--connection-watermark-font-size), 45cqh);
  opacity: 0.16;
}
</style>

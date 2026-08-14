<script setup lang="ts">
import { useI18n } from "vue-i18n";

defineProps<{
  subject: string;
  durationMs: number;
  maxMessages: number;
  busy?: boolean;
  liveActive?: boolean;
}>();

const emit = defineEmits<{
  "update:subject": [value: string];
  "update:durationMs": [value: number];
  "update:maxMessages": [value: number];
  capture: [];
  subscribe: [];
  stop: [];
}>();

const { t } = useI18n();
</script>

<template>
  <section class="nats-panel">
    <div class="section-title">{{ t("nats.subjectWorkbench.title") }}</div>
    <p class="form-hint">{{ t("nats.subjectWorkbench.hint") }}</p>
    <div class="toolbar-row">
      <div class="field grow">
        <label for="nats-subject">{{ t("nats.subjectWorkbench.subjectFilter") }}</label>
        <input id="nats-subject" type="text" :value="subject" :placeholder="t('nats.subjectWorkbench.subjectPlaceholder')" :disabled="liveActive" :aria-label="t('nats.subjectWorkbench.subjectFilter')" @input="emit('update:subject', ($event.target as HTMLInputElement).value)" />
      </div>
      <div class="field narrow">
        <label for="nats-duration">{{ t("nats.subjectWorkbench.captureMs") }}</label>
        <input id="nats-duration" type="number" min="1" max="60000" :value="durationMs" :aria-label="t('nats.subjectWorkbench.captureMs')" @input="emit('update:durationMs', Number(($event.target as HTMLInputElement).value))" />
      </div>
      <div class="field narrow">
        <label for="nats-max">{{ t("nats.subjectWorkbench.maxMessages") }}</label>
        <input id="nats-max" type="number" min="1" max="1000" :value="maxMessages" :aria-label="t('nats.subjectWorkbench.maxMessages')" @input="emit('update:maxMessages', Number(($event.target as HTMLInputElement).value))" />
      </div>
      <div class="field actions">
        <label class="invisible">{{ t("nats.subjectWorkbench.capture") }}</label>
        <div class="action-row">
          <button type="button" class="btn-primary" :disabled="busy || liveActive || !subject.trim()" @click="emit('capture')">
            {{ t("nats.subjectWorkbench.capture") }}
          </button>
          <button v-if="!liveActive" type="button" class="btn-secondary" :disabled="busy || !subject.trim()" @click="emit('subscribe')">
            {{ t("nats.subjectWorkbench.subscribe") }}
          </button>
          <button v-else type="button" class="btn-secondary" :disabled="busy" @click="emit('stop')">
            {{ t("nats.subjectWorkbench.stop") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

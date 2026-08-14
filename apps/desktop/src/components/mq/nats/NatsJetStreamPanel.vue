<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { presentNatsMessage } from "@/lib/nats/messagePresentation";
import type { NatsConsumerInfo, NatsConsumerList, NatsHistoryResult, NatsJetStreamInfo, NatsStreamInfo, NatsStreamList } from "@/types/nats";

defineProps<{
  jetstream?: NatsJetStreamInfo;
  streamList?: NatsStreamList;
  selectedStream?: NatsStreamInfo;
  consumerList?: NatsConsumerList;
  selectedConsumer?: NatsConsumerInfo;
  history?: NatsHistoryResult;
  historyStartSequence?: number;
  historyMaxMessages: number;
  busy?: boolean;
}>();

const emit = defineEmits<{
  load: [];
  selectStream: [name: string];
  selectConsumer: [name: string];
  fetchHistory: [];
  "update:historyStartSequence": [value: number | undefined];
  "update:historyMaxMessages": [value: number];
}>();

const { t } = useI18n();

function onStartSequenceInput(event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  emit("update:historyStartSequence", raw === "" ? undefined : Number(raw));
}
</script>

<template>
  <section class="nats-panel">
    <div class="jetstream-header">
      <div class="section-title">{{ t("nats.jetstream.title") }}</div>
      <span v-if="jetstream" class="status-text">
        {{ t("nats.jetstream.summary", { streams: jetstream.streams, consumers: jetstream.consumers, bytes: jetstream.storageBytes }) }}
      </span>
      <button type="button" class="btn-sm" :disabled="busy" @click="emit('load')">{{ t("nats.jetstream.loadStreams") }}</button>
    </div>
    <p class="form-hint">{{ t("nats.jetstream.hint") }}</p>
    <div v-if="streamList" class="jetstream-layout">
      <div class="stream-list">
        <button v-for="stream in streamList.streams" :key="stream.name" type="button" class="stream-item" :class="{ active: selectedStream?.name === stream.name }" :disabled="busy" @click="emit('selectStream', stream.name)">
          <div class="stream-name">{{ stream.name }}</div>
          <div class="status-text">{{ t("nats.jetstream.streamStats", { messages: stream.messages, consumers: stream.consumers }) }}</div>
        </button>
        <div v-if="!streamList.streams.length" class="panel-placeholder compact">{{ t("nats.jetstream.noStreams") }}</div>
        <div v-if="streamList.truncated" class="field-warning">{{ t("nats.jetstream.streamsTruncated") }}</div>
      </div>
      <div v-if="selectedStream" class="stream-detail">
        <div class="detail-box">
          <div class="stream-name">{{ selectedStream.name }} · {{ selectedStream.storage }} · {{ selectedStream.retention }}</div>
          <div class="status-text break-all">{{ selectedStream.subjects.join(", ") || t("nats.jetstream.noSubjects") }}</div>
          <div class="status-text">
            {{
              t("nats.jetstream.sequences", {
                first: selectedStream.firstSequence,
                last: selectedStream.lastSequence,
                bytes: selectedStream.bytes,
              })
            }}
          </div>
        </div>
        <div class="toolbar-row">
          <div class="field narrow">
            <label for="nats-history-start">{{ t("nats.jetstream.startSequence") }}</label>
            <input id="nats-history-start" type="number" min="1" :value="historyStartSequence" :aria-label="t('nats.jetstream.startSequence')" @input="onStartSequenceInput" />
          </div>
          <div class="field narrow">
            <label for="nats-history-max">{{ t("nats.jetstream.maxMessages") }}</label>
            <input id="nats-history-max" type="number" min="1" max="1000" :value="historyMaxMessages" :aria-label="t('nats.jetstream.maxMessages')" @input="emit('update:historyMaxMessages', Number(($event.target as HTMLInputElement).value))" />
          </div>
          <div class="field actions">
            <label class="invisible">{{ t("nats.jetstream.fetchHistory") }}</label>
            <div class="action-row">
              <button type="button" class="btn-secondary" :disabled="busy" @click="emit('fetchHistory')">{{ t("nats.jetstream.fetchHistory") }}</button>
              <span v-if="history" class="status-text">
                {{ t("nats.jetstream.historySummary", { count: history.receivedCount, mode: history.ackMode }) }}
              </span>
            </div>
          </div>
        </div>
        <div v-if="history" class="message-list history-list">
          <div v-for="(message, index) in history.messages" :key="`${message.receivedAtMs}-${index}`" class="message-item">
            <div class="message-meta">{{ message.subject }} · {{ presentNatsMessage(message).sizeLabel }}</div>
            <pre class="message-payload">{{ presentNatsMessage(message).payload }}</pre>
          </div>
          <div v-if="!history.messages.length" class="panel-placeholder compact">{{ t("nats.jetstream.noHistory") }}</div>
          <div v-if="history.truncated" class="field-warning">{{ t("nats.jetstream.historyTruncated", { next: history.nextSequence }) }}</div>
        </div>
        <div v-if="consumerList" class="consumer-list">
          <div class="messages-summary">
            {{ t("nats.jetstream.consumers") }}
            <span v-if="consumerList.truncated">{{ t("nats.jetstream.consumersTruncated") }}</span>
          </div>
          <button v-for="consumer in consumerList.consumers" :key="consumer.name" type="button" class="consumer-item" :disabled="busy" @click="emit('selectConsumer', consumer.name)">
            {{ t("nats.jetstream.consumerRow", { name: consumer.name, ackPolicy: consumer.ackPolicy, pending: consumer.pending }) }}
          </button>
          <div v-if="!consumerList.consumers.length" class="panel-placeholder compact">{{ t("nats.jetstream.noConsumers") }}</div>
        </div>
        <div v-if="selectedConsumer" class="detail-box">
          {{
            t("nats.jetstream.consumerDetail", {
              name: selectedConsumer.name,
              delivered: selectedConsumer.deliveredStreamSequence,
              ackFloor: selectedConsumer.ackFloorStreamSequence,
              ackPending: selectedConsumer.ackPending,
              redelivered: selectedConsumer.redelivered,
            })
          }}
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

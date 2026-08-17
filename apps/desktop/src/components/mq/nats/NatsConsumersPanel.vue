<script setup lang="ts">
/**
 * JetStream consumers list + detail stats — embedded under JetStream detail.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import type { NatsConsumerInfo, NatsConsumerList, NatsStreamInfo } from "@/types/nats";

const props = withDefaults(
  defineProps<{
    connectionId: string;
    readOnly?: boolean;
    stream?: NatsStreamInfo;
    embedded?: boolean;
  }>(),
  { embedded: false },
);

const { t } = useI18n();

const consumerList = ref<NatsConsumerList>();
const selectedConsumer = ref<NatsConsumerInfo>();
const busy = ref(false);
const error = ref("");
let requestGeneration = 0;

const streamName = computed(() => props.stream?.name);
const consumers = computed(() => consumerList.value?.consumers ?? []);

async function loadConsumers() {
  const generation = ++requestGeneration;
  const connectionId = props.connectionId;
  const name = streamName.value;
  const previous = selectedConsumer.value?.name;
  consumerList.value = undefined;
  selectedConsumer.value = undefined;
  if (!name) {
    busy.value = false;
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const result = await api.natsListConsumers(connectionId, name);
    if (generation !== requestGeneration || connectionId !== props.connectionId || name !== streamName.value) return;
    consumerList.value = result;
    const list = consumerList.value.consumers;
    const keep = previous && list.some((item) => item.name === previous) ? previous : list[0]?.name;
    if (keep) await selectConsumer(keep);
  } catch (e) {
    if (generation !== requestGeneration) return;
    error.value = formatError(e);
  } finally {
    if (generation === requestGeneration) busy.value = false;
  }
}

async function selectConsumer(name: string) {
  const generation = ++requestGeneration;
  const connectionId = props.connectionId;
  const stream = streamName.value;
  if (!stream) return;
  busy.value = true;
  error.value = "";
  try {
    const consumer = await api.natsGetConsumer(connectionId, stream, name);
    if (generation !== requestGeneration || connectionId !== props.connectionId || stream !== streamName.value) return;
    selectedConsumer.value = consumer;
  } catch (e) {
    if (generation !== requestGeneration) return;
    error.value = formatError(e);
  } finally {
    if (generation === requestGeneration) busy.value = false;
  }
}

// Parent JetStream header refresh only reloads stream meta; re-fetch when stream object identity changes.
watch(
  () => [props.connectionId, streamName.value, props.stream?.consumers, props.stream?.messages] as const,
  () => void loadConsumers(),
  { immediate: true },
);

onBeforeUnmount(() => {
  requestGeneration += 1;
});

defineExpose({ loadConsumers });
</script>

<template>
  <div class="nats-consumers-embed" data-testid="nats-consumers-panel">
    <div v-if="error" class="panel-error">{{ error }}</div>
    <div v-else-if="!stream" class="panel-placeholder">{{ t("nats.jetstream.selectStreamFirst") }}</div>

    <template v-else>
      <div v-if="busy && !consumers.length" class="panel-placeholder compact">{{ t("common.loading") }}</div>
      <div v-else-if="!consumers.length" class="panel-placeholder compact">{{ t("nats.jetstream.noConsumers") }}</div>

      <template v-else>
        <div class="nats-consumers-layout">
          <div class="nats-consumers-list">
            <div class="nats-section-label">
              {{ t("nats.jetstream.subConsumers") }}
              <span class="nats-section-count">{{ consumers.length }}</span>
            </div>
            <div class="nats-table-wrap nats-table-wrap-compact">
              <table class="nats-table">
                <thead>
                  <tr>
                    <th>{{ t("nats.jetstream.columns.name") }}</th>
                    <th>{{ t("nats.jetstream.columns.ackPolicy") }}</th>
                    <th class="num">{{ t("nats.jetstream.columns.pending") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="consumer in consumers" :key="consumer.name" :class="{ selected: selectedConsumer?.name === consumer.name }" data-testid="nats-consumer-row" @click="selectConsumer(consumer.name)">
                    <td class="cell-name">{{ consumer.name }}</td>
                    <td>
                      <span class="status-chip">{{ consumer.ackPolicy }}</span>
                    </td>
                    <td class="num">{{ consumer.pending }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="consumerList?.truncated" class="field-warning">{{ t("nats.jetstream.consumersTruncated") }}</div>
          </div>

          <section v-if="selectedConsumer" class="consumer-detail" data-testid="nats-consumer-detail">
            <div class="consumer-detail-head">
              <h4 class="consumer-detail-name">{{ selectedConsumer.name }}</h4>
              <span class="status-chip">{{ selectedConsumer.ackPolicy }}</span>
            </div>
            <div class="consumer-stat-grid">
              <div class="consumer-stat">
                <span class="consumer-stat-label">{{ t("nats.jetstream.statDelivered") }}</span>
                <span class="consumer-stat-value">{{ selectedConsumer.deliveredStreamSequence }}</span>
              </div>
              <div class="consumer-stat">
                <span class="consumer-stat-label">{{ t("nats.jetstream.statAckFloor") }}</span>
                <span class="consumer-stat-value">{{ selectedConsumer.ackFloorStreamSequence }}</span>
              </div>
              <div class="consumer-stat">
                <span class="consumer-stat-label">{{ t("nats.jetstream.statAckPending") }}</span>
                <span class="consumer-stat-value">{{ selectedConsumer.ackPending }}</span>
              </div>
              <div class="consumer-stat">
                <span class="consumer-stat-label">{{ t("nats.jetstream.statRedelivered") }}</span>
                <span class="consumer-stat-value">{{ selectedConsumer.redelivered }}</span>
              </div>
              <div class="consumer-stat">
                <span class="consumer-stat-label">{{ t("nats.jetstream.columns.pending") }}</span>
                <span class="consumer-stat-value">{{ selectedConsumer.pending }}</span>
              </div>
            </div>
          </section>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

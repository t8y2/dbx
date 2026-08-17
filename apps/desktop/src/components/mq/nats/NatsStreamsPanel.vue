<script setup lang="ts">
/**
 * JetStream Streams tab — resource table with nats-page shell.
 * Selecting a stream scopes Stored-messages / Consumers tabs.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import type { NatsJetStreamInfo, NatsStreamInfo, NatsStreamList } from "@/types/nats";

const props = defineProps<{
  connectionId: string;
  readOnly?: boolean;
  selectedStream?: NatsStreamInfo;
}>();

const emit = defineEmits<{
  "stream-selected": [stream: NatsStreamInfo | undefined];
  "navigate-tab": [payload: { tab: "streammessages" }];
}>();

const { t } = useI18n();

const info = ref<NatsJetStreamInfo>();
const streamList = ref<NatsStreamList>();
const search = ref("");
const busy = ref(false);
const error = ref("");
let requestGeneration = 0;

const filtered = computed(() => {
  const list = streamList.value?.streams ?? [];
  const query = search.value.trim().toLowerCase();
  if (!query) return list;
  return list.filter((s) => s.name.toLowerCase().includes(query) || s.subjects.some((sub) => sub.toLowerCase().includes(query)));
});

async function loadStreams() {
  const generation = ++requestGeneration;
  const connectionId = props.connectionId;
  busy.value = true;
  error.value = "";
  try {
    const [js, streams] = await Promise.all([api.natsJetstreamInfo(connectionId), api.natsListStreams(connectionId)]);
    if (generation !== requestGeneration || connectionId !== props.connectionId) return;
    info.value = js;
    streamList.value = streams;
  } catch (e) {
    if (generation !== requestGeneration) return;
    error.value = formatError(e);
  } finally {
    if (generation === requestGeneration) busy.value = false;
  }
}

async function selectStream(name: string) {
  const generation = ++requestGeneration;
  const connectionId = props.connectionId;
  busy.value = true;
  error.value = "";
  try {
    const stream = await api.natsGetStream(connectionId, name);
    if (generation !== requestGeneration || connectionId !== props.connectionId) return;
    emit("stream-selected", stream);
    emit("navigate-tab", { tab: "streammessages" });
  } catch (e) {
    if (generation !== requestGeneration) return;
    error.value = formatError(e);
  } finally {
    if (generation === requestGeneration) busy.value = false;
  }
}

onMounted(loadStreams);

watch(
  () => props.connectionId,
  () => {
    requestGeneration += 1;
    info.value = undefined;
    streamList.value = undefined;
    search.value = "";
    emit("stream-selected", undefined);
    void loadStreams();
  },
);

onBeforeUnmount(() => {
  requestGeneration += 1;
});
</script>

<template>
  <div class="nats-page nats-streams-page">
    <header class="nats-page-header">
      <h3 class="nats-page-title">{{ t("mqAdmin.tabStreams") }}</h3>
      <input class="nats-header-subject nats-stream-search" type="text" :value="search" :placeholder="t('nats.jetstream.searchStreams')" :aria-label="t('nats.jetstream.searchStreams')" @input="search = ($event.target as HTMLInputElement).value" />
      <span class="mq-result-count">{{ filtered.length }} / {{ streamList?.streams.length ?? 0 }}</span>
      <div class="nats-sub-header-actions">
        <button type="button" class="mq-btn-sm" :disabled="busy" @click="loadStreams">
          {{ t("nats.refresh") }}
        </button>
      </div>
    </header>

    <div class="nats-page-body">
      <div v-if="error" class="panel-error">{{ error }}</div>
      <div v-else-if="busy && !streamList" class="panel-placeholder">{{ t("common.loading") }}</div>
      <div v-else-if="!streamList" class="panel-placeholder">{{ t("nats.jetstream.noStreams") }}</div>
      <div v-else-if="!filtered.length" class="panel-placeholder">{{ t("nats.jetstream.noStreams") }}</div>
      <div v-else class="nats-table-wrap grow">
        <table class="nats-table">
          <thead>
            <tr>
              <th>{{ t("nats.jetstream.columns.name") }}</th>
              <th>{{ t("nats.jetstream.columns.subjects") }}</th>
              <th class="num">{{ t("nats.jetstream.columns.messages") }}</th>
              <th class="num">{{ t("nats.jetstream.columns.bytes") }}</th>
              <th class="num">{{ t("nats.jetstream.consumerCount") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filtered" :key="item.name" :class="{ selected: selectedStream?.name === item.name }" @click="selectStream(item.name)">
              <td class="cell-name">{{ item.name }}</td>
              <td class="cell-ellipsis">{{ item.subjects.join(", ") || t("nats.jetstream.noSubjects") }}</td>
              <td class="num">{{ item.messages }}</td>
              <td class="num">{{ item.bytes }}</td>
              <td class="num">{{ item.consumers }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="streamList?.truncated" class="field-warning">{{ t("nats.jetstream.streamsTruncated") }}</div>
      <p v-if="info" class="form-hint">
        {{
          t("nats.jetstream.summary", {
            streams: info.streams,
            consumers: info.consumers,
            bytes: info.storageBytes + info.memoryBytes,
          })
        }}
      </p>
    </div>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

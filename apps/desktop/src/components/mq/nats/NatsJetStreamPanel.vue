<script setup lang="ts">
/**
 * JetStream workspace (NUI-style): stream list → stream detail with
 * overview / messages / consumers subviews. Not three top-level tabs.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import type { NatsJetStreamInfo, NatsStreamInfo, NatsStreamList } from "@/types/nats";
import NatsStreamMessagesPanel from "./NatsStreamMessagesPanel.vue";
import NatsConsumersPanel from "./NatsConsumersPanel.vue";

type DetailTab = "overview" | "messages" | "consumers";

const props = defineProps<{
  connectionId: string;
  readOnly?: boolean;
}>();

const { t } = useI18n();

const info = ref<NatsJetStreamInfo>();
const streamList = ref<NatsStreamList>();
const search = ref("");
const busy = ref(false);
const error = ref("");
const selectedStream = ref<NatsStreamInfo>();
const detailTab = ref<DetailTab>("messages");

const filtered = computed(() => {
  const list = streamList.value?.streams ?? [];
  const query = search.value.trim().toLowerCase();
  if (!query) return list;
  return list.filter((s) => s.name.toLowerCase().includes(query) || s.subjects.some((sub) => sub.toLowerCase().includes(query)));
});

const inDetail = computed(() => !!selectedStream.value);

async function loadStreams() {
  busy.value = true;
  error.value = "";
  try {
    const [js, streams] = await Promise.all([api.natsJetstreamInfo(props.connectionId), api.natsListStreams(props.connectionId)]);
    info.value = js;
    streamList.value = streams;
    // Refresh selected stream stats if still present.
    const name = selectedStream.value?.name;
    if (name && streams.streams.some((s) => s.name === name)) {
      selectedStream.value = await api.natsGetStream(props.connectionId, name);
    } else if (name) {
      selectedStream.value = undefined;
    }
  } catch (e) {
    error.value = formatError(e);
  } finally {
    busy.value = false;
  }
}

async function openStream(name: string) {
  busy.value = true;
  error.value = "";
  try {
    selectedStream.value = await api.natsGetStream(props.connectionId, name);
    detailTab.value = "messages";
  } catch (e) {
    error.value = formatError(e);
  } finally {
    busy.value = false;
  }
}

function backToList() {
  selectedStream.value = undefined;
  detailTab.value = "messages";
}

function setDetailTab(tab: DetailTab) {
  detailTab.value = tab;
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

onMounted(loadStreams);

watch(
  () => props.connectionId,
  () => {
    info.value = undefined;
    streamList.value = undefined;
    search.value = "";
    selectedStream.value = undefined;
    detailTab.value = "messages";
    void loadStreams();
  },
);
</script>

<template>
  <div class="nats-page nats-js-page" data-testid="nats-jetstream-panel">
    <!-- ---- Stream list ---- -->
    <template v-if="!inDetail">
      <header class="nats-page-header">
        <h3 class="nats-page-title">{{ t("mqAdmin.tabJetStream") }}</h3>
        <input class="nats-header-subject nats-stream-search" type="text" :value="search" :placeholder="t('nats.jetstream.searchStreams')" :aria-label="t('nats.jetstream.searchStreams')" @input="search = ($event.target as HTMLInputElement).value" />
        <span class="mq-result-count">{{ filtered.length }} / {{ streamList?.streams.length ?? 0 }}</span>
        <div class="nats-sub-header-actions">
          <button type="button" class="mq-btn-sm" :disabled="busy" @click="loadStreams">{{ t("nats.refresh") }}</button>
        </div>
      </header>

      <div class="nats-page-body">
        <div v-if="error" class="panel-error">{{ error }}</div>
        <div v-else-if="busy && !streamList" class="panel-placeholder">{{ t("common.loading") }}</div>
        <div v-else-if="!streamList || !filtered.length" class="panel-placeholder">{{ t("nats.jetstream.noStreams") }}</div>
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
              <tr v-for="item in filtered" :key="item.name" data-testid="nats-stream-row" @click="openStream(item.name)">
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
              bytes: formatBytes(info.storageBytes + info.memoryBytes),
            })
          }}
        </p>
      </div>
    </template>

    <!-- ---- Stream detail (overview | messages | consumers) ---- -->
    <template v-else>
      <header class="nats-page-header nats-js-detail-header">
        <button type="button" class="mq-btn-sm nats-back-btn" data-testid="nats-js-back" @click="backToList">← {{ t("nats.jetstream.backToStreams") }}</button>
        <span class="nats-stream-badge" :title="selectedStream?.name">{{ selectedStream?.name }}</span>

        <nav class="nats-js-subnav" role="tablist" :aria-label="t('mqAdmin.tabJetStream')">
          <button type="button" role="tab" class="nats-js-subnav-btn" :class="{ active: detailTab === 'overview' }" :aria-selected="detailTab === 'overview'" data-testid="nats-js-tab-overview" @click="setDetailTab('overview')">
            {{ t("nats.jetstream.subOverview") }}
          </button>
          <button type="button" role="tab" class="nats-js-subnav-btn" :class="{ active: detailTab === 'messages' }" :aria-selected="detailTab === 'messages'" data-testid="nats-js-tab-messages" @click="setDetailTab('messages')">
            {{ t("nats.jetstream.subMessages") }}
          </button>
          <button type="button" role="tab" class="nats-js-subnav-btn" :class="{ active: detailTab === 'consumers' }" :aria-selected="detailTab === 'consumers'" data-testid="nats-js-tab-consumers" @click="setDetailTab('consumers')">
            {{ t("nats.jetstream.subConsumers") }}
          </button>
        </nav>

        <div class="nats-sub-header-actions">
          <button type="button" class="mq-btn-sm" :disabled="busy" @click="loadStreams">{{ t("nats.refresh") }}</button>
        </div>
      </header>

      <div class="nats-page-body nats-js-detail-body">
        <div v-if="error" class="panel-error">{{ error }}</div>

        <section v-else-if="detailTab === 'overview' && selectedStream" class="js-overview" data-testid="nats-js-overview">
          <div class="consumer-stat-grid">
            <div class="consumer-stat">
              <span class="consumer-stat-label">{{ t("nats.jetstream.columns.messages") }}</span>
              <span class="consumer-stat-value">{{ selectedStream.messages.toLocaleString() }}</span>
            </div>
            <div class="consumer-stat">
              <span class="consumer-stat-label">{{ t("nats.jetstream.columns.bytes") }}</span>
              <span class="consumer-stat-value">{{ formatBytes(selectedStream.bytes) }}</span>
            </div>
            <div class="consumer-stat">
              <span class="consumer-stat-label">{{ t("nats.jetstream.consumerCount") }}</span>
              <span class="consumer-stat-value">{{ selectedStream.consumers }}</span>
            </div>
            <div class="consumer-stat">
              <span class="consumer-stat-label">{{ t("nats.jetstream.storage") }}</span>
              <span class="consumer-stat-value consumer-stat-value-sm">{{ selectedStream.storage || "—" }}</span>
            </div>
            <div class="consumer-stat">
              <span class="consumer-stat-label">{{ t("nats.jetstream.retention") }}</span>
              <span class="consumer-stat-value consumer-stat-value-sm">{{ selectedStream.retention || "—" }}</span>
            </div>
            <div class="consumer-stat">
              <span class="consumer-stat-label">{{ t("nats.jetstream.sequenceRange") }}</span>
              <span class="consumer-stat-value consumer-stat-value-sm"> {{ selectedStream.firstSequence }} – {{ selectedStream.lastSequence }} </span>
            </div>
          </div>
        </section>

        <NatsStreamMessagesPanel v-else-if="detailTab === 'messages'" embedded :connection-id="connectionId" :read-only="readOnly" :stream="selectedStream" />
        <NatsConsumersPanel v-else-if="detailTab === 'consumers'" embedded :connection-id="connectionId" :read-only="readOnly" :stream="selectedStream" />
      </div>
    </template>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

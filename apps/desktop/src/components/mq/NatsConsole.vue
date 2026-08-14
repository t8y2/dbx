<script setup lang="ts">
/**
 * NATS admin console shell — same interaction model as MqAdminConsole:
 * toolbar (cluster/status) → tabs → one domain panel in content.
 */
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import type { NatsServerInfo } from "@/types/nats";
import NatsMessagesPanel from "./nats/NatsMessagesPanel.vue";
import NatsJetStreamPanel from "./nats/NatsJetStreamPanel.vue";
import type { NatsConsumerInfo, NatsConsumerList, NatsHistoryResult, NatsJetStreamInfo, NatsStreamInfo, NatsStreamList } from "@/types/nats";

export type NatsConsoleTab = "messages" | "jetstream";

const props = defineProps<{ connectionId: string; readOnly?: boolean }>();
const { t } = useI18n();
const connectionStore = useConnectionStore();

const server = ref<NatsServerInfo>();
const loading = ref(false);
const error = ref<string>();
const activeTab = ref<NatsConsoleTab>("messages");

const jetstream = ref<NatsJetStreamInfo>();
const streamList = ref<NatsStreamList>();
const selectedStream = ref<NatsStreamInfo>();
const consumerList = ref<NatsConsumerList>();
const selectedConsumer = ref<NatsConsumerInfo>();
const history = ref<NatsHistoryResult>();
const historyMaxMessages = ref(50);
const historyStartSequence = ref<number>();
const jetstreamBusy = ref(false);
const jetstreamError = ref("");

const isProductionConnection = computed(() => !!connectionStore.getConfig(props.connectionId)?.is_production);
const isReadOnly = computed(() => !!props.readOnly || !!connectionStore.getConfig(props.connectionId)?.read_only);
const jetstreamEnabled = computed(() => !!server.value?.jetstreamEnabled);

const availableTabs = computed<NatsConsoleTab[]>(() => {
  const tabs: NatsConsoleTab[] = ["messages"];
  if (jetstreamEnabled.value) tabs.push("jetstream");
  return tabs;
});

const clusterLabel = computed(() => {
  if (!server.value) return t("nats.title");
  const name = server.value.serverName || t("nats.title");
  const version = server.value.serverVersion ? ` ${server.value.serverVersion}` : "";
  return `${name}${version}`;
});

const statusMeta = computed(() => (server.value ? t("nats.rtt", { ms: server.value.roundTripMs }) : ""));

function tabLabel(tab: NatsConsoleTab): string {
  if (tab === "messages") return t("mqAdmin.tabMessages");
  return t("nats.tabJetStream");
}

function setActiveTab(tab: NatsConsoleTab) {
  if (!availableTabs.value.includes(tab)) return;
  activeTab.value = tab;
  if (tab === "jetstream" && !streamList.value) void loadJetStream();
}

async function loadConnectionInfo() {
  loading.value = true;
  error.value = undefined;
  try {
    server.value = await api.natsTestConnection(props.connectionId);
    if (!server.value.jetstreamEnabled && activeTab.value === "jetstream") {
      activeTab.value = "messages";
    }
  } catch (e) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function loadJetStream() {
  if (!jetstreamEnabled.value) return;
  jetstreamBusy.value = true;
  jetstreamError.value = "";
  try {
    const [info, streams] = await Promise.all([api.natsJetstreamInfo(props.connectionId), api.natsListStreams(props.connectionId)]);
    jetstream.value = info;
    streamList.value = streams;
  } catch (e) {
    jetstreamError.value = formatError(e);
  } finally {
    jetstreamBusy.value = false;
  }
}

async function selectJetStream(streamName: string) {
  jetstreamBusy.value = true;
  jetstreamError.value = "";
  try {
    const [stream, consumers, messages] = await Promise.all([api.natsGetStream(props.connectionId, streamName), api.natsListConsumers(props.connectionId, streamName), api.natsFetchHistory(props.connectionId, { stream: streamName, maxMessages: historyMaxMessages.value })]);
    selectedStream.value = stream;
    consumerList.value = consumers;
    selectedConsumer.value = undefined;
    history.value = messages;
    historyStartSequence.value = messages.nextSequence;
  } catch (e) {
    jetstreamError.value = formatError(e);
  } finally {
    jetstreamBusy.value = false;
  }
}

async function loadHistory() {
  const stream = selectedStream.value?.name;
  if (!stream) return;
  jetstreamBusy.value = true;
  jetstreamError.value = "";
  try {
    const messages = await api.natsFetchHistory(props.connectionId, {
      stream,
      startSequence: historyStartSequence.value || undefined,
      maxMessages: historyMaxMessages.value,
    });
    history.value = messages;
    historyStartSequence.value = messages.nextSequence;
  } catch (e) {
    jetstreamError.value = formatError(e);
  } finally {
    jetstreamBusy.value = false;
  }
}

async function selectConsumer(consumerName: string) {
  const stream = selectedStream.value?.name;
  if (!stream) return;
  jetstreamBusy.value = true;
  jetstreamError.value = "";
  try {
    selectedConsumer.value = await api.natsGetConsumer(props.connectionId, stream, consumerName);
  } catch (e) {
    jetstreamError.value = formatError(e);
  } finally {
    jetstreamBusy.value = false;
  }
}

watch(
  () => props.connectionId,
  async () => {
    activeTab.value = "messages";
    jetstream.value = undefined;
    streamList.value = undefined;
    selectedStream.value = undefined;
    consumerList.value = undefined;
    selectedConsumer.value = undefined;
    history.value = undefined;
    await loadConnectionInfo();
  },
);

onMounted(async () => {
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  await loadConnectionInfo();
});
</script>

<template>
  <div class="mq-admin-console">
    <div class="mq-toolbar">
      <div class="mq-breadcrumb">
        <span class="cluster-info">{{ clusterLabel }}</span>
        <span v-if="server" class="breadcrumb-item">{{ statusMeta }}</span>
        <span v-if="jetstreamEnabled" class="breadcrumb-separator">·</span>
        <span v-if="jetstreamEnabled" class="breadcrumb-item">{{ t("nats.jetstreamBadge") }}</span>
      </div>
      <div class="toolbar-status">
        <span v-if="isProductionConnection" class="prod-badge">PROD</span>
        <span v-if="isReadOnly" class="readonly-badge">{{ t("mqAdmin.readOnly") }}</span>
        <span v-if="error" class="toolbar-error">{{ error }}</span>
        <button type="button" class="btn-sm" :disabled="loading" @click="loadConnectionInfo">{{ t("nats.refresh") }}</button>
      </div>
    </div>

    <div class="mq-tabs">
      <div class="mq-tabs-list">
        <button v-for="tab in availableTabs" :key="tab" type="button" :class="{ active: activeTab === tab }" @click="setActiveTab(tab)">
          {{ tabLabel(tab) }}
        </button>
      </div>
    </div>

    <div class="mq-content">
      <NatsMessagesPanel v-if="activeTab === 'messages'" :connection-id="connectionId" :read-only="isReadOnly" />
      <div v-else-if="activeTab === 'jetstream'" class="mq-content-scroll">
        <div v-if="jetstreamError" class="panel-error">{{ jetstreamError }}</div>
        <NatsJetStreamPanel
          v-model:history-start-sequence="historyStartSequence"
          v-model:history-max-messages="historyMaxMessages"
          :jetstream="jetstream"
          :stream-list="streamList"
          :selected-stream="selectedStream"
          :consumer-list="consumerList"
          :selected-consumer="selectedConsumer"
          :history="history"
          :busy="jetstreamBusy"
          @load="loadJetStream"
          @select-stream="selectJetStream"
          @select-consumer="selectConsumer"
          @fetch-history="loadHistory"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
@import "./shared/mqPanel.css";
@import "./shared/mqConsoleShell.css";
@import "./nats/natsPanel.css";
</style>

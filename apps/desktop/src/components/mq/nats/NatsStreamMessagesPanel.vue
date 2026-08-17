<script setup lang="ts">
/**
 * JetStream stored messages — used embedded inside NatsJetStreamPanel detail.
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import * as api from "@/lib/backend/api";
import { formatError } from "@/lib/backend/errorUtils";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { NatsHistoryResult, NatsStreamInfo } from "@/types/nats";
import NatsMessageList from "./NatsMessageList.vue";

const props = withDefaults(
  defineProps<{
    connectionId: string;
    readOnly?: boolean;
    stream?: NatsStreamInfo;
    /** Hide outer page chrome when nested under JetStream detail. */
    embedded?: boolean;
  }>(),
  { embedded: false },
);

const { t } = useI18n();

const history = ref<NatsHistoryResult>();
const startSequence = ref<string>();
const maxMessages = ref(50);
const subjectFilter = ref("__all__");
const busy = ref(false);
const error = ref("");
let requestGeneration = 0;

const streamName = computed(() => props.stream?.name);
const subjectOptions = computed(() => props.stream?.subjects ?? []);

const rows = computed(() => {
  const subject = subjectFilter.value;
  if (subject === "__all__") return history.value?.messages ?? [];
  return (history.value?.messages ?? []).filter((message) => message.subject === subject);
});

async function fetchHistory(reset = false) {
  const name = streamName.value;
  if (!name) {
    busy.value = false;
    return;
  }
  const generation = ++requestGeneration;
  const connectionId = props.connectionId;
  busy.value = true;
  error.value = "";
  try {
    const res = await api.natsFetchHistory(connectionId, {
      stream: name,
      startSequence: reset ? undefined : startSequence.value || undefined,
      maxMessages: maxMessages.value,
    });
    if (generation !== requestGeneration || connectionId !== props.connectionId || name !== streamName.value) return;
    history.value = res;
    // Keep the requested sequence when the page has no continuation cursor.
    if (res.nextSequence !== undefined) startSequence.value = res.nextSequence;
  } catch (e) {
    if (generation !== requestGeneration) return;
    error.value = formatError(e);
  } finally {
    if (generation === requestGeneration) busy.value = false;
  }
}

function onStartSequenceInput(event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  startSequence.value = raw === "" ? undefined : raw;
}

watch(
  [() => props.connectionId, streamName],
  () => {
    requestGeneration += 1;
    history.value = undefined;
    startSequence.value = undefined;
    subjectFilter.value = "__all__";
    if (streamName.value) void fetchHistory(true);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  requestGeneration += 1;
});
</script>

<template>
  <div class="nats-history-embed" :class="{ 'nats-page': !embedded }">
    <div class="nats-embed-toolbar" data-testid="nats-history-toolbar">
      <div class="nats-sub-composer nats-history-filters">
        <label class="nats-inline-field">
          <span>{{ t("nats.jetstream.startSequence") }}</span>
          <input class="nats-header-num" type="text" inputmode="numeric" pattern="[0-9]*" :value="startSequence" @input="onStartSequenceInput" />
        </label>
        <label class="nats-inline-field">
          <span>{{ t("nats.jetstream.maxMessages") }}</span>
          <input class="nats-header-num" type="number" min="1" max="1000" :value="maxMessages" @input="maxMessages = Number(($event.target as HTMLInputElement).value)" />
        </label>
        <Select v-if="subjectOptions.length > 1" :model-value="subjectFilter" @update:model-value="subjectFilter = String($event)">
          <SelectTrigger class="nats-header-mode nats-subject-select" :aria-label="t('nats.jetstream.columns.subjects')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="__all__">{{ t("nats.jetstream.allSubjects") }}</SelectItem>
            <SelectItem v-for="s in subjectOptions" :key="s" :value="s">{{ s }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="nats-sub-header-actions">
        <span v-if="history" class="msg-summary status-text">
          {{ t("nats.jetstream.historySummary", { count: rows.length, mode: history.ackMode ?? "none" }) }}
        </span>
        <button type="button" class="mq-btn-primary" data-testid="nats-history-fetch" :disabled="busy || !stream" @click="fetchHistory()">
          {{ t("nats.jetstream.fetchHistory") }}
        </button>
      </div>
    </div>

    <div v-if="error" class="panel-error">{{ error }}</div>
    <div v-else-if="!stream" class="panel-placeholder">{{ t("nats.jetstream.selectStreamFirst") }}</div>
    <template v-else>
      <NatsMessageList :messages="rows" :empty-text="busy ? t('common.loading') : t('nats.jetstream.noHistory')" />
      <div v-if="history?.truncated" class="field-warning">{{ t("nats.jetstream.historyTruncated", { next: history.nextSequence }) }}</div>
    </template>
  </div>
</template>

<style scoped>
@import "../shared/mqPanel.css";
@import "./natsPanel.css";
</style>

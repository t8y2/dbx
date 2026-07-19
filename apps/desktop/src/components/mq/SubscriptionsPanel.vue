<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { TopicRef, TopicInfo, SubscriptionInfo, ResetPosition, SkipCount, PeekedMessage, MqSystemKind } from "@/types/mq";
import { mqListSubscriptions, mqCreateSubscription, mqDeleteSubscription, mqResetCursor, mqSkipMessages, mqClearBacklog, mqPeekMessages, mqExpireMessages } from "@/lib/backend/api";
import RocketMqConsumerGroupDialogs, { type RocketMqConsumerGroupDialogKind } from "./rocketmq/RocketMqConsumerGroupDialogs.vue";
import MqTypeFilterBar from "./shared/MqTypeFilterBar.vue";
import { DEFAULT_ROCKETMQ_CONSUMER_GROUP_TYPE_FILTERS, matchesRocketMqConsumerGroupTypeFilters, resolveRocketMqConsumerGroupMessageModel, resolveRocketMqConsumerGroupType, ROCKETMQ_CONSUMER_GROUP_TYPES, type RocketMqConsumerGroupType } from "@/lib/mq/rocketmqConsumerGroupTypes";

interface Props {
  connectionId: string;
  topic?: TopicInfo;
  tenant?: string;
  namespace?: string;
  readOnly?: boolean;
  supportsCreateSubscription?: boolean;
  supportsResetCursor?: boolean;
  supportsSkipMessages?: boolean;
  supportsClearBacklog?: boolean;
  supportsPeekMessages?: boolean;
  supportsExpireMessages?: boolean;
  mqSystemKind?: MqSystemKind;
  isFlatMqCluster?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  subscriptionSelected: [subscription: string];
}>();

const { t } = useI18n();

const subscriptions = ref<SubscriptionInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const showCreateDialog = ref(false);
const showResetDialog = ref(false);
const showSkipDialog = ref(false);
const showPeekDialog = ref(false);
const showExpireDialog = ref(false);
const selectedSub = ref<SubscriptionInfo>();
const peekedMessages = ref<PeekedMessage[]>([]);
const peekLoading = ref(false);
const peekCount = ref(5);

const formData = ref({
  subName: "",
  startFrom: "latest" as "earliest" | "latest",
});

const resetFormData = ref({
  position: "latest" as "earliest" | "latest" | "timestamp",
  timestampMs: Date.now(),
});

const skipFormData = ref({
  mode: "count" as "count" | "all",
  count: 100,
});

const expireSeconds = ref(3600);
const searchKeyword = ref("");
const activeRocketMqDialog = ref<RocketMqConsumerGroupDialogKind | null>(null);
const consumerGroupTypeFilters = ref<Record<RocketMqConsumerGroupType, boolean>>({
  ...DEFAULT_ROCKETMQ_CONSUMER_GROUP_TYPE_FILTERS,
});

const isRocketMqCluster = computed(() => props.mqSystemKind === "rocketmq");
// RocketMQ consumer tab always lists cluster-wide groups (Dashboard groupList.query), regardless of breadcrumb topic.
const isClusterWideMode = computed(() => isRocketMqCluster.value && !!props.tenant && !!props.namespace);
const canShowPanel = computed(() => isClusterWideMode.value || !!props.topic);
const rocketMqConsumerGroupTypeOptions = ROCKETMQ_CONSUMER_GROUP_TYPES;
const panelTitle = computed(() => (isRocketMqCluster.value ? t("mqRocketmq.consumerGroupTitle") : t("mqSubscriptions.title")));
const searchPlaceholder = computed(() => (isRocketMqCluster.value ? t("mqRocketmq.searchConsumerGroup") : t("mqSubscriptions.searchPlaceholder")));
const filteredSubscriptions = computed(() => {
  let rows = subscriptions.value;
  if (isRocketMqCluster.value) {
    rows = rows.filter((sub) => matchesRocketMqConsumerGroupTypeFilters(sub, consumerGroupTypeFilters.value));
  }
  const keyword = searchKeyword.value.trim().toLowerCase();
  if (!keyword) return rows;
  return rows.filter((sub) => sub.name.toLowerCase().includes(keyword));
});

function consumerGroupTypeLabel(sub: SubscriptionInfo): string {
  const type = resolveRocketMqConsumerGroupType(sub);
  return t(`mqSubscriptions.rocketmqGroupType.${type.toLowerCase()}`);
}

function consumerGroupTypeBadgeClass(sub: SubscriptionInfo): string {
  const type = resolveRocketMqConsumerGroupType(sub);
  if (type === "FIFO") return "badge badge-info";
  if (type === "SYSTEM") return "badge badge-muted";
  return "badge";
}

function consumerGroupModeLabel(sub: SubscriptionInfo): string {
  const mode = resolveRocketMqConsumerGroupMessageModel(sub);
  return t(`mqSubscriptions.rocketmqGroupMode.${mode.toLowerCase()}`);
}

function guardWritable() {
  if (props.readOnly) {
    error.value = t("mqSubscriptions.readOnly");
    return false;
  }
  return true;
}

function getListTopicRef(): TopicRef | null {
  if (!props.tenant || !props.namespace) return null;
  if (isClusterWideMode.value) {
    return {
      tenant: props.tenant,
      namespace: props.namespace,
      topic: "",
      persistent: true,
      partitioned: false,
    };
  }
  if (!props.topic) return null;
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic: props.topic.shortName,
    persistent: props.topic.persistent,
    partitioned: props.topic.partitioned,
  };
}

function getPulsarTopicRef(): TopicRef | null {
  if (!props.tenant || !props.namespace || !props.topic) return null;
  return {
    tenant: props.tenant,
    namespace: props.namespace,
    topic: props.topic.shortName,
    persistent: props.topic.persistent,
    partitioned: props.topic.partitioned,
  };
}

async function loadSubscriptions() {
  const topicRef = getListTopicRef();
  if (!topicRef) {
    subscriptions.value = [];
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    subscriptions.value = await mqListSubscriptions(props.connectionId, topicRef);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function openCreateDialog() {
  if (!guardWritable()) return;
  formData.value = {
    subName: "",
    startFrom: "latest",
  };
  showCreateDialog.value = true;
}

function openRocketMqDetail(sub: SubscriptionInfo) {
  selectedSub.value = sub;
  activeRocketMqDialog.value = "detail";
}

function openRocketMqConfig(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  selectedSub.value = sub;
  activeRocketMqDialog.value = "config";
}

function closeRocketMqDialog() {
  activeRocketMqDialog.value = null;
}

function openResetDialog(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  selectedSub.value = sub;
  resetFormData.value = {
    position: "latest",
    timestampMs: Date.now(),
  };
  showResetDialog.value = true;
}

function openSkipDialog(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  selectedSub.value = sub;
  skipFormData.value = {
    mode: "count",
    count: 100,
  };
  showSkipDialog.value = true;
}

function openPeekDialog(sub: SubscriptionInfo) {
  selectedSub.value = sub;
  peekCount.value = 5;
  peekedMessages.value = [];
  showPeekDialog.value = true;
  void handlePeekMessages();
}

function openExpireDialog(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  selectedSub.value = sub;
  expireSeconds.value = 3600;
  showExpireDialog.value = true;
}

function selectSubscription(sub: SubscriptionInfo) {
  if (isRocketMqCluster.value) {
    openRocketMqDetail(sub);
    return;
  }
  selectedSub.value = sub;
  emit("subscriptionSelected", sub.name);
}

async function handleCreate() {
  if (!guardWritable()) return;
  const topicRef = getPulsarTopicRef();
  if (!formData.value.subName.trim() || !topicRef) {
    error.value = t("mqSubscriptions.subscriptionNameRequired");
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const pos: ResetPosition = { kind: formData.value.startFrom };
    await mqCreateSubscription(props.connectionId, topicRef, formData.value.subName, pos);
    showCreateDialog.value = false;
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleDelete(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  if (!confirm(t("mqSubscriptions.confirmDelete", { name: sub.name }))) return;
  const topicRef = getListTopicRef();
  if (!topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    await mqDeleteSubscription(props.connectionId, topicRef, sub.name, false);
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleResetCursor() {
  if (!guardWritable()) return;
  const topicRef = getPulsarTopicRef();
  if (!selectedSub.value || !topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    let pos: ResetPosition;
    if (resetFormData.value.position === "timestamp") {
      pos = { kind: "timestamp", timestampMs: resetFormData.value.timestampMs };
    } else {
      pos = { kind: resetFormData.value.position };
    }
    await mqResetCursor(props.connectionId, topicRef, selectedSub.value.name, pos);
    showResetDialog.value = false;
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleSkipMessages() {
  if (!guardWritable()) return;
  const topicRef = getPulsarTopicRef();
  if (!selectedSub.value || !topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    const count: SkipCount = skipFormData.value.mode === "all" ? { kind: "all" } : { kind: "count", count: skipFormData.value.count };
    await mqSkipMessages(props.connectionId, topicRef, selectedSub.value.name, count);
    showSkipDialog.value = false;
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handleClearBacklog(sub: SubscriptionInfo) {
  if (!guardWritable()) return;
  if (!confirm(t("mqSubscriptions.confirmClearBacklog", { name: sub.name }))) return;
  const topicRef = getPulsarTopicRef();
  if (!topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    await mqClearBacklog(props.connectionId, topicRef, sub.name);
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function handlePeekMessages() {
  const topicRef = getPulsarTopicRef();
  if (!selectedSub.value || !topicRef) return;
  const count = Math.max(1, Math.min(100, Number(peekCount.value) || 1));
  peekCount.value = count;
  peekLoading.value = true;
  error.value = undefined;
  try {
    peekedMessages.value = await mqPeekMessages(props.connectionId, topicRef, selectedSub.value.name, count);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    peekLoading.value = false;
  }
}

async function handleExpireMessages() {
  if (!guardWritable()) return;
  const topicRef = getPulsarTopicRef();
  if (!selectedSub.value || !topicRef) return;
  loading.value = true;
  error.value = undefined;
  try {
    await mqExpireMessages(props.connectionId, topicRef, selectedSub.value.name, expireSeconds.value);
    showExpireDialog.value = false;
    await loadSubscriptions();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

watch(
  () => [props.topic, props.tenant, props.namespace, props.mqSystemKind],
  () => {
    selectedSub.value = undefined;
    loadSubscriptions();
  },
  { immediate: true },
);
</script>

<template>
  <div class="subscriptions-panel">
    <div class="panel-toolbar">
      <div class="toolbar-left">
        <h3>{{ panelTitle }}</h3>
        <input v-if="isClusterWideMode" v-model="searchKeyword" type="search" class="topic-search" :placeholder="searchPlaceholder" />
        <span v-if="isClusterWideMode && subscriptions.length" class="topic-count"> {{ filteredSubscriptions.length }} / {{ subscriptions.length }} </span>
      </div>
      <div class="toolbar-actions">
        <button v-if="isClusterWideMode" class="btn-secondary" :disabled="loading" @click="loadSubscriptions">
          {{ loading ? t("mqSubscriptions.refreshing") : t("mqSubscriptions.refresh") }}
        </button>
        <button v-if="supportsCreateSubscription !== false && !isRocketMqCluster" @click="openCreateDialog" :disabled="loading || readOnly || !topic" class="btn-primary">+ {{ t("mqSubscriptions.createSubscription") }}</button>
      </div>
    </div>

    <MqTypeFilterBar v-if="isRocketMqCluster && tenant && namespace" :label="t('mqSubscriptions.typeFilter')">
      <label v-for="type in rocketMqConsumerGroupTypeOptions" :key="type" class="checkbox-label compact">
        <input v-model="consumerGroupTypeFilters[type]" type="checkbox" />
        {{ t(`mqSubscriptions.rocketmqGroupType.${type.toLowerCase()}`) }}
      </label>
    </MqTypeFilterBar>

    <div v-if="!canShowPanel" class="panel-placeholder">{{ t("mqSubscriptions.selectTopicFirst") }}</div>

    <template v-else>
      <div v-if="error" class="panel-error">{{ error }}</div>

      <div v-else-if="loading && !subscriptions.length" class="panel-loading">{{ t("mqSubscriptions.loading") }}</div>

      <div v-else-if="!filteredSubscriptions.length" class="panel-placeholder">
        {{ isClusterWideMode ? t("mqSubscriptions.noConsumerGroups") : t("mqSubscriptions.noSubscriptions") }}
      </div>

      <div v-else class="subscriptions-table">
        <table>
          <thead>
            <tr>
              <th>{{ t("mqSubscriptions.subscriptionName") }}</th>
              <th>{{ t("mqSubscriptions.type") }}</th>
              <th v-if="isRocketMqCluster">{{ t("mqSubscriptions.mode") }}</th>
              <th v-if="isClusterWideMode">{{ t("mqSubscriptions.subscribedTopics") }}</th>
              <th v-if="!isClusterWideMode">{{ t("mqSubscriptions.backlog") }}</th>
              <th v-if="!isClusterWideMode">{{ t("mqSubscriptions.consumeRate") }}</th>
              <th>{{ t("mqSubscriptions.consumers") }}</th>
              <th>{{ t("mqSubscriptions.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="sub in filteredSubscriptions" :key="sub.name" :class="{ selected: selectedSub?.name === sub.name }" @click="selectSubscription(sub)">
              <td class="sub-name">{{ sub.name }}</td>
              <td>
                <span v-if="isRocketMqCluster" :class="consumerGroupTypeBadgeClass(sub)">{{ consumerGroupTypeLabel(sub) }}</span>
                <span v-else class="badge">{{ sub.subType }}</span>
              </td>
              <td v-if="isRocketMqCluster">
                <span class="badge badge-outline">{{ consumerGroupModeLabel(sub) }}</span>
              </td>
              <td v-if="isClusterWideMode" class="topics-cell">
                <span v-if="sub.topics?.length">{{ sub.topics.join(", ") }}</span>
                <span v-else class="text-muted">-</span>
              </td>
              <td v-if="!isClusterWideMode">
                <span :class="{ 'text-warning': sub.msgBacklog > 1000 }">
                  {{ sub.msgBacklog.toLocaleString() }}
                </span>
              </td>
              <td v-if="!isClusterWideMode">{{ t("mqSubscriptions.msgRate", { rate: sub.msgRateOut.toFixed(2) }) }}</td>
              <td>{{ isClusterWideMode ? (sub.onlineMembers ?? 0) : t("mqSubscriptions.consumerCount", { count: sub.consumers.length }) }}</td>
              <td class="actions">
                <template v-if="isRocketMqCluster">
                  <button @click.stop="openRocketMqDetail(sub)" class="btn-sm">{{ t("mqSubscriptions.viewDetail") }}</button>
                  <button @click.stop="openRocketMqConfig(sub)" :disabled="readOnly" class="btn-sm">{{ t("mqSubscriptions.editConfig") }}</button>
                  <button @click.stop="handleDelete(sub)" :disabled="readOnly" class="btn-sm btn-danger">{{ t("mqSubscriptions.delete") }}</button>
                </template>
                <template v-else>
                  <button v-if="supportsResetCursor !== false" @click.stop="openResetDialog(sub)" :disabled="readOnly || !topic" class="btn-sm">{{ t("mqSubscriptions.resetCursor") }}</button>
                  <button v-if="supportsSkipMessages !== false" @click.stop="openSkipDialog(sub)" :disabled="readOnly" class="btn-sm">{{ t("mqSubscriptions.skipMessages") }}</button>
                  <button v-if="supportsClearBacklog !== false" @click.stop="handleClearBacklog(sub)" :disabled="readOnly || !topic" class="btn-sm">{{ t("mqSubscriptions.clearBacklog") }}</button>
                  <button v-if="supportsPeekMessages" @click.stop="openPeekDialog(sub)" :disabled="!topic" class="btn-sm">{{ t("mqSubscriptions.peek") }}</button>
                  <button v-if="supportsExpireMessages !== false" @click.stop="openExpireDialog(sub)" :disabled="readOnly" class="btn-sm">{{ t("mqSubscriptions.expireMessages") }}</button>
                  <button @click.stop="handleDelete(sub)" :disabled="readOnly" class="btn-sm btn-danger">{{ t("mqSubscriptions.delete") }}</button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <RocketMqConsumerGroupDialogs v-if="isRocketMqCluster" :connection-id="connectionId" :tenant="tenant" :namespace="namespace" :group="selectedSub" :dialog="activeRocketMqDialog" :read-only="readOnly" @close="closeRocketMqDialog" @refreshed="loadSubscriptions" />

    <!-- Create Dialog -->
    <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqSubscriptions.createDialogTitle") }}</h3>
          <button @click="showCreateDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqSubscriptions.topic") }}</label>
            <input type="text" :value="topic?.shortName" disabled />
          </div>
          <div class="form-group">
            <label>{{ t("mqSubscriptions.subscriptionNameLabel") }}</label>
            <input v-model="formData.subName" type="text" :placeholder="t('mqSubscriptions.subscriptionNamePlaceholder')" :disabled="readOnly" />
          </div>
          <div class="form-group">
            <label>{{ t("mqSubscriptions.startPosition") }}</label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" v-model="formData.startFrom" value="earliest" :disabled="readOnly" />
                {{ t("mqSubscriptions.startFromEarliest") }}
              </label>
              <label class="radio-label">
                <input type="radio" v-model="formData.startFrom" value="latest" :disabled="readOnly" />
                {{ t("mqSubscriptions.startFromLatest") }}
              </label>
            </div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showCreateDialog = false" class="btn-secondary">{{ t("mqSubscriptions.cancel") }}</button>
          <button @click="handleCreate" :disabled="loading || readOnly" class="btn-primary">{{ t("mqSubscriptions.create") }}</button>
        </div>
      </div>
    </div>

    <!-- Reset Cursor Dialog -->
    <div v-if="!isRocketMqCluster && showResetDialog" class="dialog-overlay" @click="showResetDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqSubscriptions.resetDialogTitle", { name: selectedSub?.name }) }}</h3>
          <button @click="showResetDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqSubscriptions.resetTo") }}</label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" v-model="resetFormData.position" value="earliest" :disabled="readOnly" />
                {{ t("mqSubscriptions.earliest") }}
              </label>
              <label class="radio-label">
                <input type="radio" v-model="resetFormData.position" value="latest" :disabled="readOnly" />
                {{ t("mqSubscriptions.latest") }}
              </label>
              <label class="radio-label">
                <input type="radio" v-model="resetFormData.position" value="timestamp" :disabled="readOnly" />
                {{ t("mqSubscriptions.timestamp") }}
              </label>
            </div>
          </div>
          <div v-if="resetFormData.position === 'timestamp'" class="form-group">
            <label>{{ t("mqSubscriptions.timestampMs") }}</label>
            <input v-model.number="resetFormData.timestampMs" type="number" :disabled="readOnly" />
            <div class="form-hint">{{ t("mqSubscriptions.currentTime", { time: new Date(resetFormData.timestampMs).toLocaleString() }) }}</div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showResetDialog = false" class="btn-secondary">{{ t("mqSubscriptions.cancel") }}</button>
          <button @click="handleResetCursor" :disabled="loading || readOnly" class="btn-primary">{{ t("mqSubscriptions.reset") }}</button>
        </div>
      </div>
    </div>

    <!-- Skip Messages Dialog -->
    <div v-if="!isRocketMqCluster && showSkipDialog" class="dialog-overlay" @click="showSkipDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqSubscriptions.skipDialogTitle", { name: selectedSub?.name }) }}</h3>
          <button @click="showSkipDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqSubscriptions.skipMode") }}</label>
            <div class="radio-group">
              <label class="radio-label">
                <input type="radio" v-model="skipFormData.mode" value="count" :disabled="readOnly" />
                {{ t("mqSubscriptions.skipCount") }}
              </label>
              <label class="radio-label">
                <input type="radio" v-model="skipFormData.mode" value="all" :disabled="readOnly" />
                {{ t("mqSubscriptions.skipAll") }}
              </label>
            </div>
          </div>
          <div v-if="skipFormData.mode === 'count'" class="form-group">
            <label>{{ t("mqSubscriptions.skipCountLabel") }}</label>
            <input v-model.number="skipFormData.count" type="number" min="1" :disabled="readOnly" />
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showSkipDialog = false" class="btn-secondary">{{ t("mqSubscriptions.cancel") }}</button>
          <button @click="handleSkipMessages" :disabled="loading || readOnly" class="btn-primary">{{ t("mqSubscriptions.skip") }}</button>
        </div>
      </div>
    </div>

    <!-- Peek Messages Dialog -->
    <div v-if="!isRocketMqCluster && showPeekDialog" class="dialog-overlay" @click="showPeekDialog = false">
      <div class="dialog dialog-wide" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqSubscriptions.peekDialogTitle", { name: selectedSub?.name }) }}</h3>
          <button @click="showPeekDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="peek-toolbar">
            <label>
              {{ t("mqSubscriptions.count") }}
              <input v-model.number="peekCount" type="number" min="1" max="100" />
            </label>
            <button @click="handlePeekMessages" :disabled="peekLoading" class="btn-sm">
              {{ peekLoading ? t("mqSubscriptions.loading") : t("mqSubscriptions.refresh") }}
            </button>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
          <div v-else-if="peekLoading && !peekedMessages.length" class="panel-loading">{{ t("mqSubscriptions.loading") }}</div>
          <div v-else-if="!peekedMessages.length" class="panel-placeholder">{{ t("mqSubscriptions.noPeekMessages") }}</div>
          <div v-else class="peek-results">
            <div v-for="message in peekedMessages" :key="message.position" class="peek-message">
              <div class="peek-message-header">
                <span>#{{ message.position }}</span>
                <span v-if="message.messageId">{{ message.messageId }}</span>
                <span v-if="message.key">{{ t("mqSubscriptions.peekMessageKey", { key: message.key }) }}</span>
              </div>
              <div v-if="Object.keys(message.properties).length" class="peek-properties">
                <span v-for="(value, key) in message.properties" :key="key">{{ key }}={{ value }}</span>
              </div>
              <pre class="peek-payload">{{ message.payloadText ?? message.payloadBase64 }}</pre>
            </div>
          </div>
        </div>
        <div class="dialog-footer">
          <button @click="showPeekDialog = false" class="btn-secondary">{{ t("mqSubscriptions.close") }}</button>
        </div>
      </div>
    </div>

    <!-- Expire Messages Dialog -->
    <div v-if="!isRocketMqCluster && showExpireDialog" class="dialog-overlay" @click="showExpireDialog = false">
      <div class="dialog" @click.stop>
        <div class="dialog-header">
          <h3>{{ t("mqSubscriptions.expireDialogTitle", { name: selectedSub?.name }) }}</h3>
          <button @click="showExpireDialog = false" class="btn-close">×</button>
        </div>
        <div class="dialog-body">
          <div class="form-group">
            <label>{{ t("mqSubscriptions.expireSeconds") }}</label>
            <input v-model.number="expireSeconds" type="number" min="1" :disabled="readOnly" />
            <div class="form-hint">{{ t("mqSubscriptions.expireHint", { seconds: expireSeconds }) }}</div>
          </div>
          <div v-if="error" class="form-error">{{ error }}</div>
        </div>
        <div class="dialog-footer">
          <button @click="showExpireDialog = false" class="btn-secondary">{{ t("mqSubscriptions.cancel") }}</button>
          <button @click="handleExpireMessages" :disabled="loading || readOnly" class="btn-primary">{{ t("mqSubscriptions.expire") }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subscriptions-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.toolbar-left h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  flex: 0 0 auto;
}

.topic-search {
  width: min(320px, 32vw);
  min-width: 180px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 13px;
}

.topic-search:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 2px var(--color-primary-alpha);
}

.topic-count {
  flex: 0 0 auto;
  color: var(--color-text-tertiary);
  font-size: 12px;
}

.btn-secondary {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-hover);
}

.subscription-type-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border-light, var(--color-border));
  background: var(--color-background-secondary);
}

.subscription-type-filters-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, #6b7280);
  margin-right: 4px;
}

.checkbox-label.compact {
  font-size: 12px;
  gap: 6px;
}

.badge-outline {
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
}

.badge-info {
  background: color-mix(in srgb, #3b82f6 18%, transparent);
  color: #2563eb;
}

.badge-muted {
  background: color-mix(in srgb, var(--color-text-secondary) 12%, transparent);
  color: var(--color-text-secondary);
}

.topics-cell {
  max-width: 280px;
  word-break: break-all;
}

.panel-toolbar h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}

.search-input {
  min-width: 220px;
  padding: 6px 10px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 13px;
  background: var(--color-background);
}

.topics-cell {
  max-width: 280px;
  word-break: break-word;
}

.panel-placeholder,
.panel-error,
.panel-loading {
  padding: 24px;
  text-align: center;
  color: var(--color-text-secondary);
}

.panel-error {
  color: var(--color-error);
}

.subscriptions-table {
  flex: 1;
  overflow: auto;
}

table {
  width: 100%;
  border-collapse: collapse;
}

thead {
  position: sticky;
  top: 0;
  background: var(--color-background-secondary);
  z-index: 1;
}

th {
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-secondary);
  border-bottom: 1px solid var(--color-border);
}

tbody tr {
  cursor: pointer;
  transition: background 0.2s;
}

tbody tr:hover {
  background: var(--color-hover);
}

tbody tr.selected {
  background: var(--color-primary-alpha);
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border-light);
}

.sub-name {
  font-weight: 500;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.text-warning {
  color: var(--color-warning);
  font-weight: 500;
}

.actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.btn-primary,
.btn-secondary,
.btn-sm,
.btn-danger {
  padding: 6px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;
  white-space: nowrap;
}

.btn-primary {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-danger {
  color: var(--color-error);
  border-color: var(--color-error);
}

.btn-danger:hover:not(:disabled) {
  background: var(--color-error);
  color: white;
}

.btn-sm {
  padding: 4px 8px;
  font-size: 12px;
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Dialog styles */
.dialog-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.dialog {
  background: var(--color-background);
  border-radius: 8px;
  width: 90%;
  max-width: 500px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.dialog-wide {
  max-width: 760px;
}

.dialog-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-border);
}

.dialog-header h3 {
  margin: 0;
  font-size: 18px;
}

.btn-close {
  border: none;
  background: none;
  font-size: 24px;
  cursor: pointer;
  color: var(--color-text-secondary);
  padding: 0;
  line-height: 1;
}

.dialog-body {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  font-size: 13px;
}

.form-group input[type="text"],
.form-group input[type="number"],
.form-group select.topic-select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 14px;
  box-sizing: border-box;
  background: var(--color-background);
  color: var(--color-text);
}

.form-group input:disabled {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.radio-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 8px;
  border-radius: 4px;
  transition: background 0.2s;
}

.radio-label:hover {
  background: var(--color-hover);
}

.radio-label input[type="radio"] {
  cursor: pointer;
}

.form-hint {
  margin-top: 4px;
  font-size: 12px;
  color: var(--color-text-tertiary);
}

.form-error {
  margin-top: 12px;
  padding: 8px 12px;
  background: var(--color-error-bg);
  color: var(--color-error);
  border-radius: 4px;
  font-size: 13px;
}

.peek-toolbar {
  display: flex;
  align-items: end;
  gap: 12px;
  margin-bottom: 12px;
}

.peek-toolbar label {
  display: grid;
  gap: 6px;
  font-size: 13px;
}

.peek-toolbar input {
  width: 96px;
  padding: 6px 8px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  background: var(--color-background);
  color: var(--color-text);
}

.peek-results {
  display: grid;
  gap: 12px;
}

.peek-message {
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-background-secondary);
  overflow: hidden;
}

.peek-message-header,
.peek-properties {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--color-text-secondary);
}

.peek-message-header {
  border-bottom: 1px solid var(--color-border-light);
  font-weight: 600;
}

.peek-properties {
  border-bottom: 1px solid var(--color-border-light);
}

.peek-payload {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  padding: 10px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.5;
  color: var(--color-text);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
}
</style>

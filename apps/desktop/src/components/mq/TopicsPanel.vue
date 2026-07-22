<script setup lang="ts">
import { ref, watch, computed } from "vue";
import { useI18n } from "vue-i18n";
import type { NamespaceRef, TopicRef, TopicInfo, ListTopicsOpts, MqSystemKind, RocketMqTopicMessageType } from "@/types/mq";
import { mqListTopics, mqCreateTopic, mqDeleteTopic, mqUpdatePartitions, mqGetClusterInfo } from "@/lib/backend/api";
import type { ClusterInfo } from "@/types/mq";
import RocketMqTopicDialogs, { type RocketMqTopicDialogKind } from "./rocketmq/RocketMqTopicDialogs.vue";
import SendMessagePanel from "./SendMessagePanel.vue";
import ExchangesPanel from "./ExchangesPanel.vue";
import MqTypeFilterBar from "./shared/MqTypeFilterBar.vue";
import type { MqTab } from "@/lib/mq/mqConsoleDefaults";
import { isAllVhostsNamespace, resolveMqRowNamespace } from "@/lib/mq/mqConsoleDefaults";
import { formatError } from "@/lib/backend/errorUtils";
import { DEFAULT_ROCKETMQ_TOPIC_TYPE_FILTERS, isProtectedRocketMqTopic, isRocketMqBusinessMessageType, matchesRocketMqTypeFilters, resolveRocketMqMessageType, ROCKETMQ_CREATABLE_TOPIC_MESSAGE_TYPES, ROCKETMQ_TOPIC_MESSAGE_TYPES } from "@/lib/mq/rocketmqTopicTypes";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";

interface Props {
  connectionId: string;
  tenant?: string;
  namespace?: string;
  readOnly?: boolean;
  supportsPartitionedTopics?: boolean;
  isFlatMqCluster?: boolean;
  mqSystemKind?: MqSystemKind;
  supportsExchanges?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  topicSelected: [topic: TopicInfo];
  navigateTab: [payload: { tab: MqTab; topic?: TopicInfo; subscription?: string; preferDlqTopic?: boolean }];
}>();

const { t } = useI18n();

const topics = ref<TopicInfo[]>([]);
const loading = ref(false);
const error = ref<string>();
const dialogError = ref<string>();
const showCreateDialog = ref(false);
const showPartitionsDialog = ref(false);
const selectedTopic = ref<TopicInfo>();
const editingTopic = ref<TopicInfo>();
const topicSearch = ref("");
const deleteTarget = ref<TopicInfo>();
const showDeleteDialog = ref(false);
const deleting = ref(false);

const clusterInfo = ref<ClusterInfo>();
const activeRocketMqDialog = ref<RocketMqTopicDialogKind | null>(null);
const rocketMqDialogTopic = ref<TopicInfo>();
const showSendDialog = ref(false);
const sendDialogTopic = ref<TopicInfo>();

const ROCKETMQ_PERM_OPTIONS = [
  { value: 6, labelKey: "mqTopics.permReadWrite" },
  { value: 4, labelKey: "mqTopics.permRead" },
  { value: 2, labelKey: "mqTopics.permWrite" },
] as const;

const formData = ref({
  topicName: "",
  persistent: true,
  partitioned: false,
  partitions: 4,
  messageType: "NORMAL" as RocketMqTopicMessageType,
  brokerName: "",
  readQueueNums: 8,
  writeQueueNums: 8,
  perm: 6,
});

const newPartitions = ref(4);

const includeNonPersistent = ref(false);
const includeSystemTopics = ref(false);
const messageTypeFilters = ref<Record<RocketMqTopicMessageType, boolean>>({
  ...DEFAULT_ROCKETMQ_TOPIC_TYPE_FILTERS,
});

const isRocketMqCluster = computed(() => props.mqSystemKind === "rocketmq");
const isKafkaCluster = computed(() => props.mqSystemKind === "kafka");
const isRabbitMqCluster = computed(() => props.mqSystemKind === "rabbitmq");
// RabbitMQ "all vhosts" mode: rows carry their own vhost in `namespace`.
const showNamespaceColumn = computed(() => isRabbitMqCluster.value && isAllVhostsNamespace(props.namespace));
// RabbitMQ splits the topics tab into Queues (topics table) and Exchanges views.
const showRabbitMqSubTabs = computed(() => isRabbitMqCluster.value && props.supportsExchanges === true);
const rabbitMqSubTab = ref<"queues" | "exchanges">("queues");
const rocketMqTopicTypeOptions = ROCKETMQ_TOPIC_MESSAGE_TYPES;
const rocketMqCreatableTopicTypes = ROCKETMQ_CREATABLE_TOPIC_MESSAGE_TYPES;
const rocketMqClusterName = computed(() => clusterInfo.value?.clusterId ?? "-");
const rocketMqBrokerOptions = computed(() => clusterInfo.value?.brokers ?? []);
const rocketMqMasterBrokers = computed(() => rocketMqBrokerOptions.value.filter((broker) => !broker.role || broker.role === "MASTER"));

const typeFilteredTopics = computed(() => {
  let rows = topics.value;
  if (isRocketMqCluster.value) {
    rows = rows.filter((topic) => matchesRocketMqTypeFilters(topic, messageTypeFilters.value));
  } else if (props.isFlatMqCluster && !includeSystemTopics.value) {
    rows = rows.filter((topic) => !topic.internal);
  }
  return rows;
});

const filteredTopics = computed(() => {
  const query = topicSearch.value.trim().toLowerCase();
  if (!query) return typeFilteredTopics.value;
  return typeFilteredTopics.value.filter((topic) => {
    return topic.name.toLowerCase().includes(query) || topic.shortName.toLowerCase().includes(query);
  });
});

const userTopicCount = computed(() => {
  if (isRocketMqCluster.value) {
    return topics.value.filter((topic) => isRocketMqBusinessMessageType(resolveRocketMqMessageType(topic))).length;
  }
  return topics.value.filter((topic) => !topic.internal).length;
});

function topicTypeLabel(topic: TopicInfo): string {
  if (isRocketMqCluster.value) {
    const type = resolveRocketMqMessageType(topic);
    return t(`mqTopics.rocketmqType.${type.toLowerCase()}`);
  }
  if (topic.internal) return t("mqTopics.systemTopic");
  if (topic.partitioned) return t("mqTopics.partitionedTopic");
  return t("mqTopics.normalTopic");
}

function topicTypeBadgeClass(topic: TopicInfo): string {
  if (isRocketMqCluster.value) {
    const type = resolveRocketMqMessageType(topic);
    if (type === "SYSTEM" || type === "RETRY" || type === "DLQ") return "badge-warning";
    if (type === "DELAY" || type === "FIFO" || type === "TRANSACTION") return "badge-info";
    return "badge-default";
  }
  if (topic.internal) return "badge-warning";
  if (topic.partitioned) return "badge-info";
  return "badge-default";
}

function isTopicProtected(topic: TopicInfo): boolean {
  return isRocketMqCluster.value ? isProtectedRocketMqTopic(topic) : !!topic.internal;
}
const editingCurrentPartitions = computed(() => editingTopic.value?.partitions ?? 0);
const canSubmitPartitionUpdate = computed(() => {
  const current = editingCurrentPartitions.value;
  return !props.readOnly && current > 0 && Number.isFinite(newPartitions.value) && newPartitions.value > current;
});

function guardWritable() {
  if (props.readOnly) {
    error.value = t("mqTopics.readOnly");
    return false;
  }
  return true;
}

async function loadTopics() {
  if (!props.tenant || !props.namespace) {
    topics.value = [];
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const ns: NamespaceRef = {
      tenant: props.tenant,
      namespace: props.namespace,
    };
    const opts: ListTopicsOpts = {
      includeNonPersistent: includeNonPersistent.value,
    };
    topics.value = await mqListTopics(props.connectionId, ns, opts);
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

async function loadClusterInfo() {
  if (!isRocketMqCluster.value) return;
  try {
    clusterInfo.value = await mqGetClusterInfo(props.connectionId);
  } catch (e: unknown) {
    console.warn("[DBX] Failed to load RocketMQ cluster info:", e);
  }
}

function openCreateDialog() {
  if (!guardWritable()) return;
  dialogError.value = undefined;
  const defaultBroker = rocketMqMasterBrokers.value[0]?.brokerName ?? rocketMqBrokerOptions.value[0]?.brokerName ?? "";
  formData.value = {
    topicName: "",
    persistent: true,
    partitioned: props.isFlatMqCluster ?? false,
    partitions: 4,
    messageType: "NORMAL",
    brokerName: defaultBroker,
    readQueueNums: 8,
    writeQueueNums: 8,
    perm: 6,
  };
  showCreateDialog.value = true;
}

function openRocketMqDialog(kind: RocketMqTopicDialogKind, topic: TopicInfo) {
  rocketMqDialogTopic.value = topic;
  activeRocketMqDialog.value = kind;
}

function closeRocketMqDialog() {
  activeRocketMqDialog.value = null;
  rocketMqDialogTopic.value = undefined;
}

function handleRocketMqNavigate(payload: { tab: "subscriptions" | "messages"; subscription?: string }) {
  if (!rocketMqDialogTopic.value) return;
  if (payload.tab === "messages") {
    openSendDialog(rocketMqDialogTopic.value);
    closeRocketMqDialog();
    return;
  }
  emit("navigateTab", {
    tab: payload.tab,
    topic: rocketMqDialogTopic.value,
    subscription: payload.subscription,
  });
  closeRocketMqDialog();
}

function openSendDialog(topic: TopicInfo) {
  sendDialogTopic.value = topic;
  showSendDialog.value = true;
}

function closeSendDialog() {
  showSendDialog.value = false;
  sendDialogTopic.value = undefined;
}

function navigateToMessages(topic: TopicInfo) {
  if (isRocketMqCluster.value) {
    openSendDialog(topic);
    return;
  }
  emit("navigateTab", { tab: "messages", topic });
}

function navigateToMessageQuery(topic: TopicInfo, preferDlqTopic = false) {
  emit("navigateTab", {
    tab: "messages",
    topic,
    preferDlqTopic,
  });
}

function isDlqTopic(topic: TopicInfo): boolean {
  return resolveRocketMqMessageType(topic) === "DLQ";
}

function openPartitionsDialog(topic: TopicInfo) {
  if (!guardWritable()) return;
  dialogError.value = undefined;
  if (!topic.partitions || topic.partitions < 1) {
    error.value = t("mqTopics.currentPartitionsUnknown");
    return;
  }
  editingTopic.value = topic;
  newPartitions.value = topic.partitions + 1;
  showPartitionsDialog.value = true;
}

async function handleCreate() {
  if (!guardWritable()) return;
  if (!formData.value.topicName.trim() || !props.tenant || !props.namespace) {
    dialogError.value = t("mqTopics.topicNameRequired");
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const topicRef: TopicRef = {
      tenant: props.tenant,
      namespace: props.namespace,
      topic: formData.value.topicName,
      persistent: formData.value.persistent,
    };
    if (isRocketMqCluster.value) {
      topicRef.messageType = formData.value.messageType;
      topicRef.brokerName = formData.value.brokerName || undefined;
      topicRef.readQueueNums = formData.value.readQueueNums;
      topicRef.writeQueueNums = formData.value.writeQueueNums;
      topicRef.perm = formData.value.perm;
    }
    const partitions = props.supportsPartitionedTopics !== false && formData.value.partitioned ? formData.value.partitions : undefined;
    await mqCreateTopic(props.connectionId, topicRef, partitions);
    showCreateDialog.value = false;
    dialogError.value = undefined;
    await loadTopics();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function handleDelete(topic: TopicInfo) {
  if (!guardWritable()) return;
  deleteTarget.value = topic;
  showDeleteDialog.value = true;
}

async function confirmDelete() {
  const topic = deleteTarget.value;
  if (!topic || !props.tenant || !props.namespace) return;
  const namespace = resolveMqRowNamespace(topic, props.namespace);
  if (!namespace) {
    error.value = t("mqAdmin.selectNamespaceToWrite");
    showDeleteDialog.value = false;
    return;
  }
  deleting.value = true;
  error.value = undefined;
  try {
    const topicRef: TopicRef = {
      tenant: props.tenant,
      namespace,
      topic: topic.shortName,
      persistent: topic.persistent,
    };
    await mqDeleteTopic(props.connectionId, topicRef, false);
    if (selectedTopic.value?.name === topic.name && selectedTopic.value?.namespace === topic.namespace) {
      selectedTopic.value = undefined;
    }
    showDeleteDialog.value = false;
    await loadTopics();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    deleting.value = false;
  }
}

async function handleUpdatePartitions() {
  if (!guardWritable()) return;
  if (!editingTopic.value || !props.tenant || !props.namespace) return;
  const currentPartitions = editingTopic.value.partitions;
  if (!currentPartitions || currentPartitions < 1) {
    dialogError.value = t("mqTopics.currentPartitionsUnknown");
    return;
  }
  if (newPartitions.value <= currentPartitions) {
    dialogError.value = t("mqTopics.partitionMustIncrease");
    return;
  }
  loading.value = true;
  error.value = undefined;
  try {
    const topicRef: TopicRef = {
      tenant: props.tenant,
      namespace: props.namespace,
      topic: editingTopic.value.shortName,
      persistent: editingTopic.value.persistent,
    };
    await mqUpdatePartitions(props.connectionId, topicRef, newPartitions.value);
    showPartitionsDialog.value = false;
    dialogError.value = undefined;
    await loadTopics();
  } catch (e: unknown) {
    dialogError.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function selectTopic(topic: TopicInfo) {
  selectedTopic.value = topic;
  emit("topicSelected", topic);
}

function normalizePartitionInput() {
  const min = editingCurrentPartitions.value + 1;
  if (!showPartitionsDialog.value || min <= 1) return;
  if (!Number.isFinite(Number(newPartitions.value)) || Number(newPartitions.value) < min) {
    newPartitions.value = min;
  }
}

watch(
  () => [props.tenant, props.namespace],
  () => {
    selectedTopic.value = undefined;
    loadTopics();
    if (isRocketMqCluster.value) void loadClusterInfo();
  },
  { immediate: true },
);

watch(
  () => props.mqSystemKind,
  () => {
    if (isRocketMqCluster.value) void loadClusterInfo();
  },
  { immediate: true },
);

watch(includeNonPersistent, () => {
  loadTopics();
});

watch(newPartitions, () => {
  if (dialogError.value === t("mqTopics.partitionMustIncrease") && canSubmitPartitionUpdate.value) {
    dialogError.value = undefined;
  }
});
</script>

<template>
  <div class="topics-panel">
    <div v-if="showRabbitMqSubTabs" class="rabbitmq-subtabs">
      <button :class="{ active: rabbitMqSubTab === 'queues' }" @click="rabbitMqSubTab = 'queues'">{{ t("mqTopics.tabQueues") }}</button>
      <button :class="{ active: rabbitMqSubTab === 'exchanges' }" @click="rabbitMqSubTab = 'exchanges'">{{ t("mqTopics.tabExchanges") }}</button>
    </div>

    <ExchangesPanel v-if="showRabbitMqSubTabs && rabbitMqSubTab === 'exchanges'" :connection-id="connectionId" :tenant="tenant" :namespace="namespace" :read-only="readOnly" />

    <template v-else>
      <div class="panel-toolbar">
        <div class="toolbar-left">
          <h3>{{ t("mqTopics.title") }}</h3>
          <input v-model="topicSearch" type="search" class="topic-search" :placeholder="t('mqTopics.searchPlaceholder')" :disabled="loading && !topics.length" />
          <span v-if="topics.length" class="topic-count"> {{ filteredTopics.length }} / {{ typeFilteredTopics.length }} </span>
          <label v-if="isKafkaCluster" class="checkbox-label">
            <input v-model="includeSystemTopics" type="checkbox" />
            {{ t("mqTopics.includeSystemTopics") }}
          </label>
          <label v-else-if="!isRocketMqCluster" class="checkbox-label">
            <input v-model="includeNonPersistent" type="checkbox" />
            {{ t("mqTopics.includeNonPersistent") }}
          </label>
        </div>
        <div class="toolbar-actions">
          <button @click="loadTopics" :disabled="loading || !tenant || !namespace" class="btn-secondary">
            {{ loading ? t("mqTopics.refreshing") : t("mqTopics.refresh") }}
          </button>
          <button @click="openCreateDialog" :disabled="loading || readOnly || !tenant || !namespace || showNamespaceColumn" :title="showNamespaceColumn ? t('mqAdmin.selectNamespaceToCreate') : undefined" class="btn-primary">+ {{ t("mqTopics.createTopic") }}</button>
        </div>
      </div>

      <MqTypeFilterBar v-if="isRocketMqCluster && tenant && namespace" :label="t('mqTopics.typeFilter')">
        <label v-for="type in rocketMqTopicTypeOptions" :key="type" class="checkbox-label compact">
          <input v-model="messageTypeFilters[type]" type="checkbox" />
          {{ t(`mqTopics.rocketmqType.${type.toLowerCase()}`) }}
        </label>
      </MqTypeFilterBar>

      <div v-if="!tenant || !namespace" class="panel-placeholder">{{ t("mqTopics.selectTenantNamespace") }}</div>

      <div v-else-if="error" class="panel-error">{{ error }}</div>

      <div v-else-if="loading && !topics.length" class="panel-loading">{{ t("mqTopics.loading") }}</div>

      <div v-else-if="!topics.length" class="panel-placeholder">{{ t("mqTopics.noTopics") }}</div>

      <div v-else-if="!filteredTopics.length" class="panel-placeholder">
        {{ isRocketMqCluster && userTopicCount === 0 ? t("mqTopics.noUserTopics") : isKafkaCluster && !includeSystemTopics && userTopicCount === 0 ? t("mqTopics.noUserTopics") : t("mqTopics.noMatches") }}
      </div>

      <div v-else class="topics-table">
        <table>
          <thead>
            <tr>
              <th>{{ t("mqTopics.name") }}</th>
              <th v-if="showNamespaceColumn">{{ t("mqAdmin.namespace") }}</th>
              <th>{{ t("mqTopics.type") }}</th>
              <th v-if="!isRocketMqCluster">{{ t("mqTopics.partitions") }}</th>
              <th>{{ t("mqTopics.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="topic in filteredTopics" :key="showNamespaceColumn ? `${topic.namespace ?? ''}:${topic.name}` : topic.name" :class="{ selected: selectedTopic?.name === topic.name && selectedTopic?.namespace === topic.namespace }" @click="selectTopic(topic)">
              <td class="topic-name">
                <div class="topic-name-cell">
                  <span>{{ topic.shortName }}</span>
                  <span v-if="!topic.persistent" class="badge badge-warning">{{ t("mqTopics.nonPersistent") }}</span>
                </div>
              </td>
              <td v-if="showNamespaceColumn">{{ topic.namespace || "-" }}</td>
              <td>
                <span class="badge" :class="topicTypeBadgeClass(topic)">
                  {{ topicTypeLabel(topic) }}
                </span>
              </td>
              <td v-if="!isRocketMqCluster">
                <span v-if="topic.partitioned">{{ topic.partitions ? t("mqTopics.partitionCount", { count: topic.partitions }) : t("mqTopics.partitionsUnknown") }}</span>
                <span v-else class="text-muted">-</span>
              </td>
              <td class="actions" @click.stop>
                <template v-if="isRocketMqCluster">
                  <button class="btn-sm" @click="openRocketMqDialog('status', topic)">{{ t("mqTopics.actionStatus") }}</button>
                  <button class="btn-sm" @click="openRocketMqDialog('route', topic)">{{ t("mqTopics.actionRoute") }}</button>
                  <button class="btn-sm" @click="openRocketMqDialog('consumers', topic)">{{ t("mqTopics.actionConsumers") }}</button>
                  <button v-if="isDlqTopic(topic)" class="btn-sm" @click="navigateToMessageQuery(topic, true)">{{ t("mqRocketmq.viewDlqMessages") }}</button>
                  <template v-else>
                    <button class="btn-sm" @click="navigateToMessageQuery(topic)">{{ t("mqRocketmq.actionMessageQuery") }}</button>
                    <button class="btn-sm" :disabled="readOnly" @click="navigateToMessages(topic)">{{ t("mqRocketmq.actionSendMessage") }}</button>
                  </template>
                  <button class="btn-sm" @click="openRocketMqDialog('config', topic)">{{ t("mqTopics.actionConfig") }}</button>
                  <button class="btn-sm" :disabled="readOnly || isTopicProtected(topic)" @click="openRocketMqDialog('reset', topic)">{{ t("mqTopics.actionReset") }}</button>
                  <button class="btn-sm" :disabled="readOnly || isTopicProtected(topic)" @click="openRocketMqDialog('skip', topic)">{{ t("mqTopics.actionSkip") }}</button>
                  <button class="btn-sm btn-danger" :disabled="readOnly || isTopicProtected(topic)" @click="handleDelete(topic)">{{ t("mqTopics.delete") }}</button>
                </template>
                <template v-else>
                  <button v-if="topic.partitioned && supportsPartitionedTopics !== false && !isTopicProtected(topic)" @click="openPartitionsDialog(topic)" :disabled="readOnly || !topic.partitions" class="btn-sm">
                    {{ t("mqTopics.adjustPartitions") }}
                  </button>
                  <button @click="handleDelete(topic)" :disabled="readOnly || isTopicProtected(topic) || (showNamespaceColumn && !topic.namespace)" :title="showNamespaceColumn && !topic.namespace ? t('mqAdmin.selectNamespaceToWrite') : undefined" class="btn-sm btn-danger">
                    {{ t("mqTopics.delete") }}
                  </button>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Create Dialog -->
      <div v-if="showCreateDialog" class="dialog-overlay" @click="showCreateDialog = false">
        <div class="dialog" @click.stop>
          <div class="dialog-header">
            <h3>{{ t("mqTopics.createTopic") }}</h3>
            <button @click="showCreateDialog = false" class="btn-close">×</button>
          </div>
          <div class="dialog-body">
            <div v-if="!isRocketMqCluster && !isFlatMqCluster" class="form-group">
              <label>{{ t("mqTopics.tenantNamespace") }}</label>
              <input type="text" :value="`${tenant} / ${namespace}`" disabled />
            </div>
            <div v-if="isRocketMqCluster" class="form-group">
              <label>{{ t("mqTopics.clusterName") }}</label>
              <input type="text" :value="rocketMqClusterName" disabled />
            </div>
            <div v-if="isRocketMqCluster" class="form-group">
              <label>{{ t("mqTopics.brokerName") }}*</label>
              <select v-model="formData.brokerName" :disabled="readOnly">
                <option value="">{{ t("mqTopics.allBrokers") }}</option>
                <option v-for="broker in rocketMqMasterBrokers.length ? rocketMqMasterBrokers : rocketMqBrokerOptions" :key="broker.brokerName || broker.id" :value="broker.brokerName || ''">
                  {{ broker.brokerName || `${broker.host}:${broker.port}` }}
                </option>
              </select>
            </div>
            <div class="form-group">
              <label>{{ t("mqTopics.topicName") }}*</label>
              <input v-model="formData.topicName" type="text" :placeholder="t('mqTopics.topicNamePlaceholder')" :disabled="readOnly" />
            </div>
            <div v-if="isRocketMqCluster" class="form-group">
              <label>{{ t("mqTopics.messageType") }}*</label>
              <select v-model="formData.messageType" :disabled="readOnly">
                <option v-for="type in rocketMqCreatableTopicTypes" :key="type" :value="type">
                  {{ t(`mqTopics.rocketmqType.${type.toLowerCase()}`) }}
                </option>
              </select>
              <div class="form-hint">{{ t("mqTopics.messageTypeHint") }}</div>
            </div>
            <div v-if="isRocketMqCluster" class="form-row-inline">
              <div class="form-group">
                <label>{{ t("mqTopics.readQueues") }}*</label>
                <input v-model.number="formData.readQueueNums" type="number" min="1" max="256" :disabled="readOnly" />
              </div>
              <div class="form-group">
                <label>{{ t("mqTopics.writeQueues") }}*</label>
                <input v-model.number="formData.writeQueueNums" type="number" min="1" max="256" :disabled="readOnly" />
              </div>
              <div class="form-group">
                <label>{{ t("mqTopics.perm") }}*</label>
                <select v-model.number="formData.perm" :disabled="readOnly">
                  <option v-for="opt in ROCKETMQ_PERM_OPTIONS" :key="opt.value" :value="opt.value">{{ t(opt.labelKey) }}</option>
                </select>
              </div>
            </div>
            <div v-if="!isRocketMqCluster" class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" v-model="formData.persistent" :disabled="readOnly" />
                {{ t("mqTopics.persistentRecommended") }}
              </label>
              <div class="form-hint">{{ t("mqTopics.persistentHint") }}</div>
            </div>
            <div v-if="!isRocketMqCluster && supportsPartitionedTopics !== false" class="form-group">
              <label class="checkbox-label">
                <input type="checkbox" v-model="formData.partitioned" :disabled="readOnly" />
                {{ t("mqTopics.enablePartitions") }}
              </label>
              <div v-if="formData.partitioned" class="form-subgroup">
                <label>{{ t("mqTopics.partitionQuantity") }}*</label>
                <input v-model.number="formData.partitions" type="number" min="1" max="256" :disabled="readOnly" />
                <div class="form-hint">{{ t("mqTopics.partitionHint") }}</div>
              </div>
            </div>
            <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
          </div>
          <div class="dialog-footer">
            <button @click="showCreateDialog = false" class="btn-secondary">{{ t("mqTopics.cancel") }}</button>
            <button @click="handleCreate" :disabled="loading || readOnly" class="btn-primary">{{ t("mqTopics.create") }}</button>
          </div>
        </div>
      </div>

      <!-- Update Partitions Dialog -->
      <div v-if="showPartitionsDialog" class="dialog-overlay" @click="showPartitionsDialog = false">
        <div class="dialog" @click.stop>
          <div class="dialog-header">
            <h3>{{ t("mqTopics.updatePartitionsTitle", { name: editingTopic?.shortName }) }}</h3>
            <button @click="showPartitionsDialog = false" class="btn-close">×</button>
          </div>
          <div class="dialog-body">
            <div class="form-group">
              <label>{{ t("mqTopics.currentPartitions") }}</label>
              <input type="number" :value="editingTopic?.partitions" disabled />
            </div>
            <div class="form-group">
              <label>{{ t("mqTopics.newPartitions") }}*</label>
              <input v-model.number="newPartitions" type="number" :min="editingCurrentPartitions + 1" max="256" :disabled="readOnly" @change="normalizePartitionInput" @blur="normalizePartitionInput" />
              <div class="form-hint">{{ t("mqTopics.partitionMinHint", { min: editingCurrentPartitions + 1 }) }}</div>
            </div>
            <div v-if="dialogError" class="form-error">{{ dialogError }}</div>
          </div>
          <div class="dialog-footer">
            <button @click="showPartitionsDialog = false" class="btn-secondary">{{ t("mqTopics.cancel") }}</button>
            <button @click="handleUpdatePartitions" :disabled="loading || !canSubmitPartitionUpdate" class="btn-primary">{{ t("mqTopics.update") }}</button>
          </div>
        </div>
      </div>

      <!-- Delete Confirm Dialog -->
      <DangerConfirmDialog v-model:open="showDeleteDialog" :title="t('mqTopics.delete')" :message="t('mqTopics.confirmDelete', { name: deleteTarget?.shortName ?? '' })" :confirm-label="t('mqTopics.delete')" :loading="deleting" :close-on-confirm="false" @confirm="confirmDelete" />

      <RocketMqTopicDialogs
        v-if="isRocketMqCluster"
        :connection-id="connectionId"
        :tenant="tenant"
        :namespace="namespace"
        :topic="rocketMqDialogTopic"
        :dialog="activeRocketMqDialog"
        :read-only="readOnly"
        :broker-options="rocketMqBrokerOptions"
        @close="closeRocketMqDialog"
        @navigate="handleRocketMqNavigate"
        @refreshed="loadTopics"
      />

      <div v-if="showSendDialog && sendDialogTopic" class="dialog-overlay" @click="closeSendDialog">
        <div class="dialog send-dialog" @click.stop>
          <div class="dialog-header">
            <h3>{{ t("mqMessages.title") }}</h3>
            <button type="button" class="btn-close" @click="closeSendDialog">×</button>
          </div>
          <div class="dialog-body send-dialog-body">
            <SendMessagePanel embedded :connection-id="connectionId" :tenant="tenant" :namespace="namespace" :topic="sendDialogTopic" :read-only="readOnly" mq-system-kind="rocketmq" :is-flat-mq-cluster="true" :supports-peek-messages="false" />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.topics-panel {
  --topics-surface: var(--card, var(--color-background, #ffffff));
  --topics-header-bg: color-mix(in srgb, var(--secondary, #f5f5f5) 86%, var(--card, #ffffff));
  --topics-border: var(--border, var(--color-border, #e5e7eb));
  --topics-border-light: color-mix(in srgb, var(--topics-border) 68%, transparent);
  height: 100%;
  display: flex;
  flex-direction: column;
}

.rabbitmq-subtabs {
  display: flex;
  gap: 4px;
  padding: 8px 16px 0;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-background-secondary);
}

.rabbitmq-subtabs button {
  padding: 8px 16px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-secondary);
  border-bottom: 2px solid transparent;
  font-size: 13px;
  font-weight: 500;
  transition: all 0.2s;
}

.rabbitmq-subtabs button:hover {
  color: var(--color-text);
  background: var(--color-hover);
}

.rabbitmq-subtabs button.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  background: var(--color-background);
}

.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
}

.topic-type-filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px 14px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--topics-border-light);
  background: color-mix(in srgb, var(--topics-header-bg) 72%, transparent);
}

.topic-type-filters-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-secondary, #6b7280);
  margin-right: 4px;
}

.checkbox-label.compact {
  font-size: 12px;
  gap: 6px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.toolbar-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  cursor: pointer;
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

.topics-table {
  position: relative;
  flex: 1;
  overflow: auto;
  background: var(--topics-surface);
}

.topics-table::before {
  content: "";
  position: sticky;
  top: 0;
  display: block;
  height: 38px;
  margin-bottom: -38px;
  background: var(--topics-header-bg);
  z-index: 9;
  box-shadow:
    0 1px 0 var(--topics-border),
    0 2px 8px rgba(0, 0, 0, 0.05);
  pointer-events: none;
}

table {
  position: relative;
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}

thead {
  position: sticky;
  top: 0;
  background: var(--topics-header-bg);
  z-index: 10;
}

th {
  position: sticky;
  top: 0;
  z-index: 11;
  padding: 10px 12px;
  text-align: left;
  font-weight: 600;
  font-size: 13px;
  color: var(--color-text-secondary);
  background: var(--topics-header-bg);
  border-bottom: 1px solid var(--topics-border);
  background-clip: padding-box;
  box-shadow:
    0 1px 0 var(--topics-border),
    0 2px 6px rgba(0, 0, 0, 0.04);
}

tbody tr {
  cursor: pointer;
  transition: background 0.2s;
}

tbody tr:hover {
  background: var(--color-hover);
}

tbody tr:hover td {
  background: var(--color-hover);
}

tbody tr.selected {
  background: var(--color-primary-alpha);
}

tbody tr.selected td {
  background: var(--color-primary-alpha);
}

td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--topics-border-light);
  background: var(--topics-surface);
}

.topic-name-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.topic-name {
  font-weight: 500;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 500;
}

.badge-default {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.badge-info {
  background: var(--color-info-alpha);
  color: var(--color-info);
}

.badge-warning {
  background: var(--color-warning-alpha);
  color: var(--color-warning);
}

.text-muted {
  color: var(--color-text-tertiary);
  font-style: italic;
}

.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
  min-width: 420px;
}

.form-row-inline {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.form-group select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 14px;
  box-sizing: border-box;
  background: var(--color-background);
  color: var(--color-text);
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
.form-group input[type="number"] {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 14px;
  box-sizing: border-box;
}

.form-group input:disabled {
  background: var(--color-background-secondary);
  color: var(--color-text-secondary);
}

.form-subgroup {
  margin-top: 12px;
  padding-left: 24px;
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

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--color-border);
}

.send-dialog {
  width: min(760px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
}

.send-dialog-body {
  padding: 0;
  max-height: calc(100vh - 140px);
  overflow: auto;
}
</style>

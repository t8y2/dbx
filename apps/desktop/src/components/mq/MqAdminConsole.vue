<script setup lang="ts">
import { formatError } from "@/lib/errorUtils";
import { ref, computed, onMounted, watch } from "vue";
import type { MqClusterInfo, TopicInfo } from "@/types/mq";
import { mqTestConnection } from "@/lib/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { mqClusterOptionsFromExtra } from "@/lib/mqTenantForm";
import TenantsPanel from "./TenantsPanel.vue";
import NamespacesPanel from "./NamespacesPanel.vue";
import TopicsPanel from "./TopicsPanel.vue";
import SubscriptionsPanel from "./SubscriptionsPanel.vue";
import MonitoringPanel from "./MonitoringPanel.vue";
import ProducerConsumerPanel from "./ProducerConsumerPanel.vue";
import PoliciesPanel from "./PoliciesPanel.vue";
import PermissionsPanel from "./PermissionsPanel.vue";
import RawApiPanel from "./RawApiPanel.vue";
import SendMessagePanel from "./SendMessagePanel.vue";
import BrokerPanel from "./BrokerPanel.vue";

type MqTab = "tenants" | "namespaces" | "topics" | "subscriptions" | "monitoring" | "clients" | "policies" | "permissions" | "messages" | "raw" | "broker";

interface Props {
  connectionId: string;
  initialTenant?: string;
  initialTab?: MqTab;
  readOnly?: boolean;
}

const props = defineProps<Props>();
const connectionStore = useConnectionStore();

// State
const activeTab = ref<MqTab>(props.initialTab || (props.initialTenant ? "namespaces" : "tenants"));
const selectedTenant = ref<string | undefined>(props.initialTenant);
const selectedNamespace = ref<string>();
const selectedTopic = ref<TopicInfo>();
const selectedSubscriptionName = ref<string>();
const capabilities = ref<MqClusterInfo["capabilities"]>();
const clusterInfo = ref<MqClusterInfo>();
const loading = ref(false);
const error = ref<string>();
const KAFKA_CONTEXT = "_kafka";

// Computed
const isKafkaCluster = computed(() => clusterInfo.value?.systemKind === "kafka");
const effectiveTenant = computed(() => (isKafkaCluster.value ? selectedTenant.value || KAFKA_CONTEXT : selectedTenant.value));
const effectiveNamespace = computed(() => (isKafkaCluster.value ? selectedNamespace.value || KAFKA_CONTEXT : selectedNamespace.value));
const canManageTenants = computed(() => capabilities.value?.supportsTenants ?? true);
const canManageNamespaces = computed(() => capabilities.value?.supportsNamespaces ?? true);
const canManagePartitionedTopics = computed(() => capabilities.value?.supportsPartitionedTopics ?? true);
const canManageSubscriptions = computed(() => capabilities.value?.supportsSubscriptions ?? true);
const canCreateSubscription = computed(() => capabilities.value?.supportsCreateSubscription ?? true);
const canResetCursor = computed(() => capabilities.value?.supportsResetCursor ?? true);
const canSkipMessages = computed(() => capabilities.value?.supportsSkipMessages ?? true);
const canClearBacklog = computed(() => capabilities.value?.supportsClearBacklog ?? true);
const canPeekMessages = computed(() => capabilities.value?.supportsPeekMessages ?? false);
const canExpireMessages = computed(() => capabilities.value?.supportsExpireMessages ?? true);
const canManageRateLimits = computed(() => capabilities.value?.supportsRateLimits ?? true);
const canManageBacklogQuota = computed(() => capabilities.value?.supportsBacklogQuota ?? true);
const canManageRetention = computed(() => capabilities.value?.supportsRetention ?? true);
const canManagePolicies = computed(() => {
  return canManageRateLimits.value || canManageBacklogQuota.value || canManageRetention.value;
});
const canManagePermissions = computed(() => capabilities.value?.supportsPermissions ?? true);
const canSendMessage = computed(() => capabilities.value?.supportsSendMessage ?? false);
const canUseRawApi = computed(() => capabilities.value?.supportsRawAdminApi ?? true);
const clusterOptions = computed(() => mqClusterOptionsFromExtra(clusterInfo.value?.extra));
const availableTabs = computed<MqTab[]>(() => {
  const tabs: MqTab[] = [];
  if (canManageTenants.value) tabs.push("tenants");
  if (canManageNamespaces.value) tabs.push("namespaces");
  tabs.push("topics");
  if (canManageSubscriptions.value) tabs.push("subscriptions");
  tabs.push("monitoring");
  tabs.push("clients");
  if (canSendMessage.value) tabs.push("messages");
  tabs.push("broker");
  if (canManagePolicies.value) tabs.push("policies");
  if (canManagePermissions.value) tabs.push("permissions");
  if (canUseRawApi.value) tabs.push("raw");
  return tabs;
});

// Methods
async function loadClusterInfo() {
  loading.value = true;
  error.value = undefined;
  try {
    clusterInfo.value = await mqTestConnection(props.connectionId);
    capabilities.value = clusterInfo.value.capabilities;
    reconcileActiveTab();
  } catch (e: unknown) {
    error.value = formatError(e);
  } finally {
    loading.value = false;
  }
}

function selectTenant(tenant: string) {
  selectedTenant.value = tenant;
  selectedNamespace.value = undefined;
  selectedTopic.value = undefined;
  selectedSubscriptionName.value = undefined;
  if (canManageNamespaces.value) {
    activeTab.value = "namespaces";
  } else {
    activeTab.value = "topics";
  }
}

function handleTenantSelected(tenant: string) {
  selectTenant(tenant);
}

function handleNamespaceSelected(namespace: string) {
  selectedNamespace.value = namespace;
  selectedTopic.value = undefined;
  selectedSubscriptionName.value = undefined;
  activeTab.value = "topics";
}

function handleNamespaceRolesSelected(namespace: string) {
  selectedNamespace.value = namespace;
  selectedTopic.value = undefined;
  selectedSubscriptionName.value = undefined;
  activeTab.value = canManagePermissions.value ? "permissions" : "namespaces";
}

function handleTopicSelected(topic: TopicInfo) {
  selectedTopic.value = topic;
  selectedSubscriptionName.value = undefined;
  activeTab.value = canManageSubscriptions.value ? "subscriptions" : "monitoring";
}

function handleSubscriptionSelected(subscription: string) {
  selectedSubscriptionName.value = subscription;
  activeTab.value = "clients";
}

function goToTenantLevel() {
  selectedNamespace.value = undefined;
  selectedTopic.value = undefined;
  selectedSubscriptionName.value = undefined;
  activeTab.value = canManageTenants.value ? "tenants" : firstAvailableTab();
}

function goToNamespaceLevel() {
  selectedTopic.value = undefined;
  selectedSubscriptionName.value = undefined;
  activeTab.value = canManageNamespaces.value ? "namespaces" : "topics";
}

function goToTopicLevel() {
  selectedSubscriptionName.value = undefined;
  activeTab.value = "topics";
}

function setActiveTab(tab: MqTab) {
  activeTab.value = availableTabs.value.includes(tab) ? tab : firstAvailableTab();
}

function firstAvailableTab(): MqTab {
  return availableTabs.value[0] ?? "topics";
}

function reconcileActiveTab() {
  if (!availableTabs.value.includes(activeTab.value)) {
    activeTab.value = firstAvailableTab();
  }
}

watch(availableTabs, reconcileActiveTab);
watch(
  () => props.initialTenant,
  (tenant) => {
    if (tenant && tenant !== selectedTenant.value) {
      selectTenant(tenant);
    }
  },
);
watch(
  () => props.initialTab,
  (tab) => {
    if (tab) setActiveTab(tab);
  },
);

// Lifecycle
onMounted(async () => {
  try {
    await connectionStore.ensureConnected(props.connectionId);
  } catch (e) {
    console.warn("[DBX] ensureConnected failed for", props.connectionId, e);
  }
  loadClusterInfo();
});
</script>

<template>
  <div class="mq-admin-console">
    <!-- Top Toolbar -->
    <div class="mq-toolbar">
      <div class="mq-breadcrumb">
        <span v-if="clusterInfo" class="cluster-info"> {{ clusterInfo.systemKind.toUpperCase() }} {{ clusterInfo.serverVersion || "" }} </span>
        <span v-if="selectedTenant" class="breadcrumb-separator">›</span>
        <button v-if="selectedTenant" class="breadcrumb-button" @click="goToTenantLevel" title="查看租户">{{ selectedTenant }}</button>
        <span v-if="selectedNamespace" class="breadcrumb-separator">›</span>
        <button v-if="selectedNamespace" class="breadcrumb-button" @click="goToNamespaceLevel" title="查看命名空间">{{ selectedNamespace }}</button>
        <span v-if="selectedTopic" class="breadcrumb-separator">›</span>
        <button v-if="selectedTopic" class="breadcrumb-button" @click="goToTopicLevel" title="查看主题">{{ selectedTopic.shortName }}</button>
      </div>
      <div class="toolbar-status">
        <span v-if="readOnly" class="readonly-badge">只读</span>
        <span v-if="error" class="toolbar-error">{{ error }}</span>
      </div>
    </div>

    <!-- Tab Bar -->
    <div class="mq-tabs">
      <button v-if="canManageTenants" :class="{ active: activeTab === 'tenants' }" @click="setActiveTab('tenants')">租户</button>
      <button v-if="canManageNamespaces" :class="{ active: activeTab === 'namespaces' }" @click="setActiveTab('namespaces')">命名空间</button>
      <button :class="{ active: activeTab === 'topics' }" @click="setActiveTab('topics')">主题</button>
      <button v-if="canManageSubscriptions" :class="{ active: activeTab === 'subscriptions' }" @click="setActiveTab('subscriptions')">订阅</button>
      <button :class="{ active: activeTab === 'monitoring' }" @click="setActiveTab('monitoring')">监控</button>
      <button :class="{ active: activeTab === 'clients' }" @click="setActiveTab('clients')">客户端</button>
      <button v-if="canSendMessage" :class="{ active: activeTab === 'messages' }" @click="setActiveTab('messages')">消息</button>
      <button :class="{ active: activeTab === 'broker' }" @click="setActiveTab('broker')">Broker</button>
      <button v-if="canManagePolicies" :class="{ active: activeTab === 'policies' }" @click="setActiveTab('policies')">策略</button>
      <button v-if="canManagePermissions" :class="{ active: activeTab === 'permissions' }" @click="setActiveTab('permissions')">权限</button>
      <button v-if="canUseRawApi" :class="{ active: activeTab === 'raw' }" @click="setActiveTab('raw')">Raw API</button>
    </div>

    <!-- Main Content Area -->
    <div class="mq-content">
      <TenantsPanel v-if="activeTab === 'tenants'" :connection-id="connectionId" :supports-tenants="canManageTenants" :read-only="readOnly" :cluster-options="clusterOptions" @tenant-selected="handleTenantSelected" />
      <NamespacesPanel v-else-if="activeTab === 'namespaces'" :connection-id="connectionId" :tenant="selectedTenant" :supports-namespaces="canManageNamespaces" :read-only="readOnly" @namespace-selected="handleNamespaceSelected" @namespace-roles-selected="handleNamespaceRolesSelected" />
      <TopicsPanel v-else-if="activeTab === 'topics'" :connection-id="connectionId" :tenant="effectiveTenant" :namespace="effectiveNamespace" :read-only="readOnly" :supports-partitioned-topics="canManagePartitionedTopics" :is-kafka-cluster="isKafkaCluster" @topic-selected="handleTopicSelected" />
      <SubscriptionsPanel
        v-else-if="activeTab === 'subscriptions' && canManageSubscriptions"
        :connection-id="connectionId"
        :topic="selectedTopic"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :read-only="readOnly"
        :supports-create-subscription="canCreateSubscription"
        :supports-reset-cursor="canResetCursor"
        :supports-skip-messages="canSkipMessages"
        :supports-clear-backlog="canClearBacklog"
        :supports-peek-messages="canPeekMessages"
        :supports-expire-messages="canExpireMessages"
        @subscription-selected="handleSubscriptionSelected"
      />
      <MonitoringPanel v-else-if="activeTab === 'monitoring'" :connection-id="connectionId" :topic="selectedTopic" :tenant="effectiveTenant" :namespace="effectiveNamespace" />
      <ProducerConsumerPanel v-else-if="activeTab === 'clients'" :connection-id="connectionId" :topic="selectedTopic" :tenant="effectiveTenant" :namespace="effectiveNamespace" :read-only="readOnly" :selected-subscription="selectedSubscriptionName" :is-kafka-cluster="isKafkaCluster" />
      <SendMessagePanel v-else-if="activeTab === 'messages' && canSendMessage" :connection-id="connectionId" :tenant="effectiveTenant" :namespace="effectiveNamespace" :topic="selectedTopic" :read-only="readOnly" :is-kafka-cluster="isKafkaCluster" :supports-peek-messages="canPeekMessages" />
      <BrokerPanel v-else-if="activeTab === 'broker'" :connection-id="connectionId" :read-only="readOnly" />
      <PoliciesPanel
        v-else-if="activeTab === 'policies' && canManagePolicies"
        :connection-id="connectionId"
        :topic="selectedTopic"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :read-only="readOnly"
        :is-kafka-cluster="isKafkaCluster"
        :supports-rate-limits="canManageRateLimits"
        :supports-backlog-quota="canManageBacklogQuota"
        :supports-retention="canManageRetention"
      />
      <PermissionsPanel v-else-if="activeTab === 'permissions' && canManagePermissions" :connection-id="connectionId" :topic="selectedTopic" :tenant="effectiveTenant" :namespace="effectiveNamespace" :read-only="readOnly" />
      <RawApiPanel v-else-if="activeTab === 'raw' && canUseRawApi" :connection-id="connectionId" :tenant="selectedTenant" :namespace="selectedNamespace" :topic="selectedTopic" :read-only="readOnly" />
    </div>
  </div>
</template>

<style scoped>
.mq-admin-console {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-background);
}

.mq-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-background-secondary);
}

.mq-breadcrumb {
  display: flex;
  align-items: center;
  font-size: 14px;
  color: var(--color-text-secondary);
}

.cluster-info {
  font-weight: 600;
  color: var(--color-primary);
  margin-right: 8px;
}

.breadcrumb-separator {
  margin: 0 8px;
  color: var(--color-text-tertiary);
}

.breadcrumb-item {
  color: var(--color-text);
  font-weight: 500;
}

.breadcrumb-button {
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--color-text);
  cursor: pointer;
  font: inherit;
  font-weight: 500;
  padding: 2px 4px;
}

.breadcrumb-button:hover {
  background: var(--color-hover);
  color: var(--color-primary);
}

.toolbar-error {
  color: var(--color-error);
  font-size: 13px;
}

.toolbar-status {
  display: flex;
  align-items: center;
  gap: 12px;
}

.readonly-badge {
  padding: 2px 8px;
  border: 1px solid var(--color-warning);
  border-radius: 4px;
  color: var(--color-warning);
  font-size: 12px;
  font-weight: 500;
}

.mq-tabs {
  display: flex;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-background-secondary);
  overflow-x: auto;
}

.mq-tabs button {
  padding: 10px 20px;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--color-text-secondary);
  border-bottom: 2px solid transparent;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s;
}

.mq-tabs button:hover {
  color: var(--color-text);
  background: var(--color-hover);
}

.mq-tabs button.active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
  background: var(--color-background);
}

.mq-content {
  flex: 1;
  overflow: hidden;
}

.mq-content :deep(table) {
  border-collapse: collapse;
}

.mq-content :deep(thead th) {
  border-bottom: 1px solid var(--color-border);
}

.mq-content :deep(tbody td) {
  border-bottom: 1px solid var(--color-border);
}

.mq-content :deep(tbody tr:last-child td) {
  border-bottom: 1px solid var(--color-border);
}
</style>

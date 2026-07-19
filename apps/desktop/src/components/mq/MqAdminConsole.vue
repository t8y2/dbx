<script setup lang="ts">
import { formatError } from "@/lib/backend/errorUtils";
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { MqAdminConfig, MqClusterInfo, MqSystemKind, TopicInfo } from "@/types/mq";
import { mqTestConnection } from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { mqClusterOptionsFromExtra } from "@/lib/mq/mqTenantForm";
import { defaultMqCapabilitiesForSystemKind, isFlatMqSystemKind, normalizeMqTabForSystemKind, resolveAvailableMqTabs, resolveInitialMqTab, resolveMqSystemKindFromConnection, type MqTab } from "@/lib/mq/mqConsoleDefaults";
import TenantsPanel from "./TenantsPanel.vue";
import NamespacesPanel from "./NamespacesPanel.vue";
import TopicsPanel from "./TopicsPanel.vue";
import SubscriptionsPanel from "./SubscriptionsPanel.vue";
import MonitoringPanel from "./MonitoringPanel.vue";
import ProducerConsumerPanel from "./ProducerConsumerPanel.vue";
import PoliciesPanel from "./PoliciesPanel.vue";
import PermissionsPanel from "./PermissionsPanel.vue";
import RawApiPanel from "./RawApiPanel.vue";
import MessageTracePanel from "./MessageTracePanel.vue";
import RocketMqMessagesPanel from "./RocketMqMessagesPanel.vue";
import SendMessagePanel from "./SendMessagePanel.vue";
import MessageQueryPanel from "./MessageQueryPanel.vue";
import BrokerPanel from "./BrokerPanel.vue";

interface Props {
  connectionId: string;
  initialTenant?: string;
  initialTab?: MqTab;
  readOnly?: boolean;
}

const props = defineProps<Props>();
const { t } = useI18n();
const connectionStore = useConnectionStore();
const configuredSystemKind = computed(() => resolveMqSystemKindFromConnection(connectionStore.getConfig(props.connectionId)));
const FLAT_MQ_CONTEXT = "_flat_mq";

function normalizeFlatMqTenant(tenant?: string): string | undefined {
  if (tenant === "_kafka" || tenant === FLAT_MQ_CONTEXT) return FLAT_MQ_CONTEXT;
  return tenant;
}

// State
const activeTab = ref<MqTab>(
  resolveInitialMqTab({
    initialTab: props.initialTab,
    initialTenant: props.initialTenant,
    systemKind: configuredSystemKind.value,
  }),
);
const selectedTenant = ref<string | undefined>(normalizeFlatMqTenant(props.initialTenant));
const selectedNamespace = ref<string | undefined>(isFlatMqSystemKind(configuredSystemKind.value) ? FLAT_MQ_CONTEXT : undefined);
const selectedTopic = ref<TopicInfo>();
const selectedSubscriptionName = ref<string>();
const capabilities = ref<MqClusterInfo["capabilities"]>();
const clusterInfo = ref<MqClusterInfo>();
const loading = ref(false);
const error = ref<string>();
const preferDlqTopic = ref(props.initialTab === "dlq");

// Computed
const mqSystemKind = computed<MqSystemKind | undefined>(() => clusterInfo.value?.systemKind ?? configuredSystemKind.value);
const isFlatMqCluster = computed(() => isFlatMqSystemKind(mqSystemKind.value));
const isRocketMqCluster = computed(() => mqSystemKind.value === "rocketmq");
const rocketmqClusterLabel = computed(() => {
  if (!isRocketMqCluster.value) return undefined;
  const fromOptions = clusterOptions.value[0];
  if (fromOptions) return fromOptions;
  const config = connectionStore.getConfig(props.connectionId);
  const external = config?.external_config as Partial<MqAdminConfig> | undefined;
  const extra = external?.extra as Record<string, unknown> | undefined;
  const clusterName = extra?.clusterName ?? extra?.cluster_name;
  return typeof clusterName === "string" && clusterName.trim() ? clusterName.trim() : undefined;
});
const effectiveTenant = computed(() => (isFlatMqCluster.value ? normalizeFlatMqTenant(selectedTenant.value) || FLAT_MQ_CONTEXT : selectedTenant.value));
const effectiveNamespace = computed(() => (isFlatMqCluster.value ? selectedNamespace.value || FLAT_MQ_CONTEXT : selectedNamespace.value));
const breadcrumbTenant = computed(() => (isFlatMqCluster.value ? undefined : selectedTenant.value));
const breadcrumbNamespace = computed(() => (isFlatMqCluster.value ? undefined : selectedNamespace.value));
const effectiveCapabilities = computed(() => capabilities.value ?? defaultMqCapabilitiesForSystemKind(configuredSystemKind.value));
const canManageTenants = computed(() => effectiveCapabilities.value.supportsTenants);
const canManageNamespaces = computed(() => effectiveCapabilities.value.supportsNamespaces);
const canManagePartitionedTopics = computed(() => effectiveCapabilities.value.supportsPartitionedTopics);
const canManageSubscriptions = computed(() => effectiveCapabilities.value.supportsSubscriptions);
const canCreateSubscription = computed(() => effectiveCapabilities.value.supportsCreateSubscription);
const canResetCursor = computed(() => effectiveCapabilities.value.supportsResetCursor);
const canSkipMessages = computed(() => effectiveCapabilities.value.supportsSkipMessages);
const canClearBacklog = computed(() => effectiveCapabilities.value.supportsClearBacklog);
const canPeekMessages = computed(() => effectiveCapabilities.value.supportsPeekMessages);
const canExpireMessages = computed(() => effectiveCapabilities.value.supportsExpireMessages);
const canManageRateLimits = computed(() => effectiveCapabilities.value.supportsRateLimits);
const canManageBacklogQuota = computed(() => effectiveCapabilities.value.supportsBacklogQuota);
const canManageRetention = computed(() => effectiveCapabilities.value.supportsRetention);
const canManagePolicies = computed(() => {
  return canManageRateLimits.value || canManageBacklogQuota.value || canManageRetention.value;
});
const canManagePermissions = computed(() => effectiveCapabilities.value.supportsPermissions);
const canSendMessage = computed(() => effectiveCapabilities.value.supportsSendMessage ?? false);
const canMessageQuery = computed(() => effectiveCapabilities.value.supportsMessageQuery ?? false);
const canMessageTrace = computed(() => effectiveCapabilities.value.supportsMessageTrace ?? false);
const canUseRawApi = computed(() => effectiveCapabilities.value.supportsRawAdminApi);
const clusterOptions = computed(() => mqClusterOptionsFromExtra(clusterInfo.value?.extra));
const availableTabs = computed<MqTab[]>(() =>
  resolveAvailableMqTabs({
    systemKind: mqSystemKind.value,
    capabilities: effectiveCapabilities.value,
  }),
);

function tabLabelKey(tab: MqTab): string {
  if (isRocketMqCluster.value) {
    if (tab === "broker") return "mqAdmin.tabCluster";
    if (tab === "subscriptions") return "mqAdmin.tabConsumers";
    if (tab === "permissions") return "mqAdmin.tabAcl";
  }
  const defaults: Record<MqTab, string> = {
    tenants: "mqAdmin.tabTenants",
    namespaces: "mqAdmin.tabNamespaces",
    topics: "mqAdmin.tabTopics",
    subscriptions: "mqAdmin.tabSubscriptions",
    monitoring: "mqAdmin.tabMonitoring",
    clients: "mqAdmin.tabClients",
    producers: "mqAdmin.tabProducers",
    policies: "mqAdmin.tabPolicies",
    permissions: "mqAdmin.tabPermissions",
    messages: "mqAdmin.tabMessages",
    raw: "mqAdmin.tabRawApi",
    broker: "mqAdmin.tabBroker",
    dlq: "mqAdmin.tabDlq",
    trace: "mqAdmin.tabTrace",
  };
  return defaults[tab];
}

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
  selectedNamespace.value = isFlatMqCluster.value ? FLAT_MQ_CONTEXT : undefined;
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
  if (isRocketMqCluster.value) {
    activeTab.value = canManageSubscriptions.value ? "subscriptions" : "topics";
  } else {
    activeTab.value = isFlatMqCluster.value ? "monitoring" : canManageSubscriptions.value ? "subscriptions" : "monitoring";
  }
}

function handleNavigateTab(payload: { tab: MqTab; topic?: TopicInfo; subscription?: string; preferDlqTopic?: boolean }) {
  if (payload.topic) {
    selectedTopic.value = payload.topic;
  }
  if (payload.subscription) {
    selectedSubscriptionName.value = payload.subscription;
  } else if (payload.topic) {
    selectedSubscriptionName.value = undefined;
  }
  if (payload.preferDlqTopic !== undefined) {
    preferDlqTopic.value = payload.preferDlqTopic;
  }
  setActiveTab(payload.tab);
}

function handleSubscriptionSelected(subscription: string) {
  selectedSubscriptionName.value = subscription;
  activeTab.value = isRocketMqCluster.value ? "producers" : "clients";
}

function handleProducerTopicSelected(topic: TopicInfo | undefined) {
  selectedTopic.value = topic;
  selectedSubscriptionName.value = undefined;
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
  const normalized = normalizeMqTabForSystemKind(tab, mqSystemKind.value);
  activeTab.value = availableTabs.value.includes(normalized) ? normalized : firstAvailableTab();
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
    const normalized = normalizeFlatMqTenant(tenant);
    if (normalized && normalized !== selectedTenant.value) {
      selectTenant(normalized);
    }
  },
);
watch(
  () => props.initialTab,
  (tab) => {
    if (tab) {
      if (tab === "dlq") preferDlqTopic.value = true;
      setActiveTab(tab);
    }
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
        <span v-if="mqSystemKind" class="cluster-info">
          {{ isRocketMqCluster && rocketmqClusterLabel ? rocketmqClusterLabel : mqSystemKind.toUpperCase() }}
          {{ clusterInfo?.serverVersion ? ` ${clusterInfo.serverVersion}` : "" }}
        </span>
        <span v-if="breadcrumbTenant" class="breadcrumb-separator">›</span>
        <button v-if="breadcrumbTenant" class="breadcrumb-button" @click="goToTenantLevel" :title="t('mqAdmin.viewTenant')">{{ breadcrumbTenant }}</button>
        <span v-if="breadcrumbNamespace" class="breadcrumb-separator">›</span>
        <button v-if="breadcrumbNamespace" class="breadcrumb-button" @click="goToNamespaceLevel" :title="t('mqAdmin.viewNamespace')">{{ breadcrumbNamespace }}</button>
        <span v-if="selectedTopic" class="breadcrumb-separator">›</span>
        <button v-if="selectedTopic" class="breadcrumb-button" @click="goToTopicLevel" :title="t('mqAdmin.viewTopic')">{{ selectedTopic.shortName }}</button>
      </div>
      <div class="toolbar-status">
        <span v-if="readOnly" class="readonly-badge">{{ t("mqAdmin.readOnly") }}</span>
        <span v-if="error" class="toolbar-error">{{ error }}</span>
      </div>
    </div>

    <!-- Tab Bar -->
    <div class="mq-tabs">
      <button v-for="tab in availableTabs" :key="tab" :class="{ active: activeTab === tab }" @click="setActiveTab(tab)">
        {{ t(tabLabelKey(tab)) }}
      </button>
    </div>

    <!-- Main Content Area -->
    <div class="mq-content">
      <TenantsPanel v-if="activeTab === 'tenants'" :connection-id="connectionId" :supports-tenants="canManageTenants" :read-only="readOnly" :cluster-options="clusterOptions" @tenant-selected="handleTenantSelected" />
      <NamespacesPanel v-else-if="activeTab === 'namespaces'" :connection-id="connectionId" :tenant="selectedTenant" :supports-namespaces="canManageNamespaces" :read-only="readOnly" @namespace-selected="handleNamespaceSelected" @namespace-roles-selected="handleNamespaceRolesSelected" />
      <TopicsPanel
        v-else-if="activeTab === 'topics'"
        :connection-id="connectionId"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :read-only="readOnly"
        :supports-partitioned-topics="canManagePartitionedTopics"
        :is-flat-mq-cluster="isFlatMqCluster"
        :mq-system-kind="mqSystemKind"
        @topic-selected="handleTopicSelected"
        @navigate-tab="handleNavigateTab"
      />
      <SubscriptionsPanel
        v-else-if="activeTab === 'subscriptions' && canManageSubscriptions"
        :connection-id="connectionId"
        :topic="selectedTopic"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :read-only="readOnly"
        :mq-system-kind="mqSystemKind"
        :is-flat-mq-cluster="isFlatMqCluster"
        :supports-create-subscription="canCreateSubscription"
        :supports-reset-cursor="canResetCursor"
        :supports-skip-messages="canSkipMessages"
        :supports-clear-backlog="canClearBacklog"
        :supports-peek-messages="canPeekMessages"
        :supports-expire-messages="canExpireMessages"
        @subscription-selected="handleSubscriptionSelected"
      />
      <MonitoringPanel v-else-if="activeTab === 'monitoring'" :connection-id="connectionId" :topic="selectedTopic" :tenant="effectiveTenant" :namespace="effectiveNamespace" :mq-system-kind="mqSystemKind" />
      <ProducerConsumerPanel
        v-else-if="activeTab === 'clients'"
        :connection-id="connectionId"
        :topic="selectedTopic"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :read-only="readOnly"
        :selected-subscription="selectedSubscriptionName"
        :is-flat-mq-cluster="isFlatMqCluster"
        :mq-system-kind="mqSystemKind"
      />
      <ProducerConsumerPanel
        v-else-if="activeTab === 'producers'"
        view-mode="producers"
        :connection-id="connectionId"
        :topic="selectedTopic"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :read-only="readOnly"
        :selected-subscription="selectedSubscriptionName"
        :is-flat-mq-cluster="isFlatMqCluster"
        :mq-system-kind="mqSystemKind"
        @topic-selected="handleProducerTopicSelected"
      />
      <RocketMqMessagesPanel
        v-else-if="activeTab === 'messages' && isRocketMqCluster && (canMessageQuery || canSendMessage)"
        :connection-id="connectionId"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :topic="selectedTopic"
        :read-only="readOnly"
        :mq-system-kind="mqSystemKind"
        :prefer-dlq-topic="preferDlqTopic"
      />
      <MessageTracePanel v-else-if="activeTab === 'trace' && isRocketMqCluster && canMessageTrace" :connection-id="connectionId" :tenant="effectiveTenant" :namespace="effectiveNamespace" :topic="selectedTopic" :read-only="readOnly" :mq-system-kind="mqSystemKind" />
      <MessageQueryPanel v-else-if="activeTab === 'messages' && canMessageQuery && !isRocketMqCluster" :connection-id="connectionId" :tenant="effectiveTenant" :namespace="effectiveNamespace" :topic="selectedTopic" :read-only="readOnly" :mq-system-kind="mqSystemKind" />
      <SendMessagePanel
        v-else-if="activeTab === 'messages' && canSendMessage && !isRocketMqCluster && !canMessageQuery"
        :connection-id="connectionId"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :topic="selectedTopic"
        :read-only="readOnly"
        :mq-system-kind="mqSystemKind"
        :is-flat-mq-cluster="isFlatMqCluster"
        :supports-peek-messages="canPeekMessages"
      />
      <BrokerPanel v-else-if="activeTab === 'broker'" :connection-id="connectionId" :read-only="readOnly" :mq-system-kind="mqSystemKind" />
      <PoliciesPanel
        v-else-if="activeTab === 'policies' && canManagePolicies"
        :connection-id="connectionId"
        :topic="selectedTopic"
        :tenant="effectiveTenant"
        :namespace="effectiveNamespace"
        :read-only="readOnly"
        :is-flat-mq-cluster="isFlatMqCluster"
        :supports-rate-limits="canManageRateLimits"
        :supports-backlog-quota="canManageBacklogQuota"
        :supports-retention="canManageRetention"
      />
      <PermissionsPanel v-else-if="activeTab === 'permissions' && canManagePermissions" :connection-id="connectionId" :topic="selectedTopic" :tenant="effectiveTenant" :namespace="effectiveNamespace" :read-only="readOnly" :mq-system-kind="mqSystemKind" />
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

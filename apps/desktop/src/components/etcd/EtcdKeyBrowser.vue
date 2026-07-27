<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import KvKeyBrowser from "@/components/kv/KvKeyBrowser.vue";
import * as api from "@/lib/backend/api";

const props = defineProps<{ connectionId: string }>();

const { t } = useI18n();
const browserRef = ref<InstanceType<typeof KvKeyBrowser> | null>(null);
const supportsTtl = ref(false);
const ttlCapabilityKnown = ref(false);
const ttlCapabilityRefreshIntervalMs = 5000;
let ttlCapabilityRequest = 0;
let ttlCapabilityInFlightConnection: string | null = null;
let ttlCapabilityRefreshTimer: ReturnType<typeof setInterval> | null = null;

const etcdApi = {
  listPrefix: api.etcdListPrefix,
  get: api.etcdGet,
  getMetadata: (connectionId: string, key: string) => api.etcdGet(connectionId, key, { metadataOnly: true }),
  put: (connectionId: string, key: string, value: api.KvValue, options?: api.KvPutOptions | null) => api.etcdPut(connectionId, key, value, options),
  deleteKey: api.etcdDelete,
};

const labels = computed(() => ({
  prefixPlaceholder: t("etcd.prefixPlaceholder"),
  newKey: t("etcd.newKey"),
  loadingKeys: t("etcd.loadingKeys"),
  empty: t("etcd.empty"),
  loadMore: t("etcd.loadMore"),
  selectKey: t("etcd.selectKey"),
  loadingValue: t("etcd.loadingValue"),
  notFound: t("etcd.notFound"),
  edit: t("etcd.edit"),
  editKey: t("etcd.editKey"),
  delete: t("etcd.delete"),
  deleteTitle: t("etcd.deleteTitle"),
  keyPlaceholder: t("etcd.keyPlaceholder"),
  keyRequired: t("etcd.keyRequired"),
  ttl: t("etcd.ttl"),
  ttlPlaceholder: t("etcd.ttlPlaceholder"),
  ttlInvalid: t("etcd.ttlInvalid"),
  ttlUnavailable: t("etcd.ttlUnavailable"),
  saved: t("etcd.saved"),
  deleted: t("etcd.deleted"),
  base64Readonly: t("etcd.base64Readonly"),
}));

async function refreshTtlCapability() {
  const connectionId = props.connectionId;
  if (ttlCapabilityInFlightConnection === connectionId) return;

  const request = ++ttlCapabilityRequest;
  ttlCapabilityInFlightConnection = connectionId;
  try {
    const supported = await api.etcdSupportsTtl(connectionId);
    if (request !== ttlCapabilityRequest || props.connectionId !== connectionId) return;
    supportsTtl.value = supported;
    ttlCapabilityKnown.value = true;
  } catch {
    // A transient connection failure is not evidence that the installed Agent lacks TTL support.
    // Keep the last confirmed capability and let the interval or an explicit refresh retry.
  } finally {
    if (request === ttlCapabilityRequest) ttlCapabilityInFlightConnection = null;
  }
}

function stopTtlCapabilityRefresh() {
  ttlCapabilityRequest++;
  ttlCapabilityInFlightConnection = null;
  if (ttlCapabilityRefreshTimer !== null) {
    clearInterval(ttlCapabilityRefreshTimer);
    ttlCapabilityRefreshTimer = null;
  }
}

function startTtlCapabilityRefresh() {
  stopTtlCapabilityRefresh();
  void refreshTtlCapability();
  ttlCapabilityRefreshTimer = setInterval(() => {
    void refreshTtlCapability();
  }, ttlCapabilityRefreshIntervalMs);
}

watch(
  () => props.connectionId,
  () => {
    supportsTtl.value = false;
    ttlCapabilityKnown.value = false;
    startTtlCapabilityRefresh();
  },
  { immediate: true },
);

onBeforeUnmount(stopTtlCapabilityRefresh);

function focusSearch(): boolean {
  return browserRef.value?.focusSearch() ?? false;
}

function refresh(): boolean {
  return browserRef.value?.refresh() ?? false;
}

defineExpose({ focusSearch, refresh });
</script>

<template>
  <KvKeyBrowser ref="browserRef" :connection-id="props.connectionId" :api="etcdApi" :labels="labels" :supports-ttl="supportsTtl" :ttl-capability-known="ttlCapabilityKnown" @refresh-requested="refreshTtlCapability" />
</template>

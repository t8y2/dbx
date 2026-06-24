<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import KvKeyBrowser from "@/components/kv/KvKeyBrowser.vue";
import * as api from "@/lib/api";
import type { KvCreateMode } from "@/lib/api";

const props = defineProps<{ connectionId: string }>();

const { t } = useI18n();
const browserRef = ref<InstanceType<typeof KvKeyBrowser> | null>(null);

const zookeeperApi = {
  listPrefix: api.zookeeperListPrefix,
  get: api.zookeeperGet,
  put: api.zookeeperPut,
  deleteKey: api.zookeeperDelete,
};

const createModeOptions = computed<{ value: KvCreateMode; label: string }[]>(() => [
  { value: "persistent", label: t("zookeeper.createModePersistent") },
  { value: "ephemeral", label: t("zookeeper.createModeEphemeral") },
  { value: "persistent_sequential", label: t("zookeeper.createModePersistentSequential") },
  { value: "ephemeral_sequential", label: t("zookeeper.createModeEphemeralSequential") },
]);

const labels = computed(() => ({
  prefixPlaceholder: t("zookeeper.prefixPlaceholder"),
  newKey: t("zookeeper.newKey"),
  loadingKeys: t("zookeeper.loadingKeys"),
  empty: t("zookeeper.empty"),
  loadMore: t("zookeeper.loadMore"),
  selectKey: t("zookeeper.selectKey"),
  loadingValue: t("zookeeper.loadingValue"),
  notFound: t("zookeeper.notFound"),
  edit: t("zookeeper.edit"),
  editKey: t("zookeeper.editKey"),
  delete: t("zookeeper.delete"),
  deleteTitle: t("zookeeper.deleteTitle"),
  keyPlaceholder: t("zookeeper.keyPlaceholder"),
  keyRequired: t("zookeeper.keyRequired"),
  saved: t("zookeeper.saved"),
  deleted: t("zookeeper.deleted"),
  base64Readonly: t("zookeeper.base64Readonly"),
  createMode: t("zookeeper.createMode"),
  add: t("zookeeper.add"),
  value: t("zookeeper.value"),
  metadata: t("zookeeper.metadata"),
  prettyJson: t("zookeeper.prettyJson"),
  invalidJson: t("zookeeper.invalidJson"),
  summaryRevision: t("zookeeper.summaryRevision"),
  summaryVersion: t("zookeeper.summaryVersion"),
  summaryLease: t("zookeeper.summaryLease"),
  summarySize: t("zookeeper.summarySize"),
}));

function focusSearch(): boolean {
  return browserRef.value?.focusSearch() ?? false;
}

function refresh(): boolean {
  return browserRef.value?.refresh() ?? false;
}

defineExpose({ focusSearch, refresh });
</script>

<template>
  <KvKeyBrowser ref="browserRef" :connection-id="props.connectionId" :api="zookeeperApi" :labels="labels" supports-create-modes enable-node-actions metadata-style="zookeeper" :create-mode-options="createModeOptions" />
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import KvKeyBrowser from "@/components/kv/KvKeyBrowser.vue";
import * as api from "@/lib/api";

const props = defineProps<{ connectionId: string }>();

const { t } = useI18n();
const browserRef = ref<InstanceType<typeof KvKeyBrowser> | null>(null);

const etcdApi = {
  listPrefix: api.etcdListPrefix,
  get: api.etcdGet,
  put: (connectionId: string, key: string, value: api.KvValue) => api.etcdPut(connectionId, key, value),
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
  saved: t("etcd.saved"),
  deleted: t("etcd.deleted"),
  base64Readonly: t("etcd.base64Readonly"),
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
  <KvKeyBrowser ref="browserRef" :connection-id="props.connectionId" :api="etcdApi" :labels="labels" />
</template>

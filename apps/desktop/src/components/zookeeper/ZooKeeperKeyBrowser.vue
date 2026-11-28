<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RefreshCw } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import KvKeyBrowser from "@/components/kv/KvKeyBrowser.vue";
import { Button } from "@/components/ui/button";
import { useTabUiState } from "@/lib/tabs/tabUiState";
import * as api from "@/lib/backend/api";
import type { KvCreateMode } from "@/lib/backend/api";

const props = defineProps<{ connectionId: string }>();

const { t } = useI18n();
const browserRef = ref<InstanceType<typeof KvKeyBrowser> | null>(null);
const { initialState, track } = useTabUiState<{ autoRefresh: boolean }>({ autoRefresh: false }, "ZooKeeperKeyBrowser");
const autoRefresh = ref(initialState.autoRefresh);
track(() => ({ autoRefresh: autoRefresh.value }));

const AUTO_REFRESH_INTERVAL_MS = 5_000;
watch(
  [autoRefresh, () => props.connectionId],
  ([enabled], _, onCleanup) => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer = setTimeout(tick, AUTO_REFRESH_INTERVAL_MS);
    onCleanup(() => {
      controller.abort();
      clearTimeout(timer);
    });

    async function tick() {
      try {
        await browserRef.value?.refreshVisibleLazyTree(controller.signal);
      } catch {
        // Leave the displayed tree in place after a transient read failure.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(tick, AUTO_REFRESH_INTERVAL_MS);
      }
    }
  },
  { immediate: true },
);

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
  rootReadonly: t("zookeeper.rootReadonly"),
  saved: t("zookeeper.saved"),
  deleted: t("zookeeper.deleted"),
  base64Readonly: t("zookeeper.base64Readonly"),
  clone: t("zookeeper.clone"),
  copyKey: t("zookeeper.copyKey"),
  export: t("zookeeper.export"),
  utf8PreviewLossy: t("zookeeper.utf8PreviewLossy"),
  utf8PreviewUnavailable: t("zookeeper.utf8PreviewUnavailable"),
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
  <KvKeyBrowser ref="browserRef" :connection-id="props.connectionId" :api="zookeeperApi" :labels="labels" supports-create-modes enable-node-actions enable-base64-utf8-preview metadata-style="zookeeper" lazy-hierarchy :create-mode-options="createModeOptions">
    <template #toolbar-trailing>
      <Button size="sm" :variant="autoRefresh ? 'default' : 'outline'" class="h-8 gap-1.5" :aria-pressed="autoRefresh" @click="autoRefresh = !autoRefresh">
        <RefreshCw class="h-3.5 w-3.5" />
        {{ t("processList.autoRefresh") }}
      </Button>
    </template>
  </KvKeyBrowser>
</template>

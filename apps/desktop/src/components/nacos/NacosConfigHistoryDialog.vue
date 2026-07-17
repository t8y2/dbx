<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Clock3, Eye, FileText, GitCompare, Loader2, RefreshCw, RotateCcw, X } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { NacosConfigHistoryItem, NacosConfigItem } from "@/types/nacos";

const open = defineModel<boolean>("open", { default: false });

const props = withDefaults(
  defineProps<{
    config: NacosConfigItem | null;
    items: NacosConfigHistoryItem[];
    loading?: boolean;
    error?: string;
    pageNo: number;
    pageSize: number;
    totalCount: number;
    readOnly?: boolean;
    viewingItem?: NacosConfigHistoryItem | null;
    viewingContent?: string;
    viewingLoading?: boolean;
  }>(),
  {
    items: () => [],
    loading: false,
    error: "",
    readOnly: false,
    viewingItem: null,
    viewingContent: "",
    viewingLoading: false,
  },
);

const emit = defineEmits<{
  load: [pageNo: number];
  view: [item: NacosConfigHistoryItem];
  "close-detail": [];
  compare: [item: NacosConfigHistoryItem];
  rollback: [item: NacosConfigHistoryItem];
}>();

const { t } = useI18n();
const detailOpen = ref(false);
const totalPages = computed(() => Math.max(1, Math.ceil(props.totalCount / Math.max(1, props.pageSize))));
const historyTitle = computed(() => {
  if (!props.config) return t("nacos.configHistory");
  return `${props.config.dataId} / ${props.config.group || "DEFAULT_GROUP"}`;
});
const namespaceLabel = computed(() => props.config?.namespace || "public");
const dataIdLabel = computed(() => props.config?.dataId || "-");
const groupLabel = computed(() => props.config?.group || "DEFAULT_GROUP");

watch(
  () => props.viewingItem,
  (item) => {
    if (item) detailOpen.value = true;
  },
);

watch(detailOpen, (value) => {
  if (!value) emit("close-detail");
});

function display(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed || "-";
}

function operationLabel(value?: string) {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return "-";
  if (["i", "insert", "create", "add"].includes(normalized)) return t("nacos.historyCreate");
  if (["u", "update", "modify", "publish"].includes(normalized)) return t("nacos.historyUpdate");
  if (["d", "delete", "remove"].includes(normalized)) return t("nacos.historyDelete");
  if (["rollback", "recover"].includes(normalized)) return t("nacos.historyRollback");
  return value || "-";
}

function loadPage(pageNo: number) {
  if (props.loading || pageNo < 1 || pageNo > totalPages.value) return;
  emit("load", pageNo);
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent :show-close-button="false" class="nacos-config-history-dialog flex h-[min(82vh,760px)] flex-col gap-0 overflow-hidden rounded-lg p-0 shadow-2xl">
      <DialogHeader class="shrink-0 border-b bg-muted/20 px-5 py-4">
        <div class="flex items-center justify-between gap-4">
          <div class="flex min-w-0 items-start gap-3">
            <div class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background text-primary">
              <Clock3 class="h-4 w-4" />
            </div>
            <div class="min-w-0">
              <DialogTitle class="truncate text-lg font-semibold">{{ t("nacos.configHistory") }}</DialogTitle>
              <div class="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
                <Badge variant="outline" class="max-w-64 truncate font-mono">namespace={{ namespaceLabel }}</Badge>
                <Badge variant="secondary" class="max-w-72 truncate font-mono">dataId={{ dataIdLabel }}</Badge>
                <Badge variant="outline" class="max-w-48 truncate font-mono">group={{ groupLabel }}</Badge>
              </div>
              <div class="sr-only">{{ historyTitle }}</div>
            </div>
          </div>
          <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0" @click="open = false">
            <X class="h-4 w-4" />
          </Button>
        </div>
      </DialogHeader>

      <div v-if="error" class="shrink-0 border-b px-5 py-2 text-xs text-destructive">{{ error }}</div>
      <div class="min-h-0 flex-1 overflow-auto">
        <table class="w-full text-left text-sm">
          <thead class="sticky top-0 z-10 bg-muted/85 text-xs text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">Data ID</th>
              <th class="px-4 py-2 font-medium">Group</th>
              <th class="px-4 py-2 font-medium">{{ t("nacos.updatedAt") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("nacos.application") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("nacos.operationType") }}</th>
              <th class="px-4 py-2 font-medium">{{ t("nacos.operator") }}</th>
              <th class="px-4 py-2 text-right font-medium">{{ t("nacos.actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in items" :key="`${item.historyId}:${item.nid ?? ''}`" class="border-b">
              <td class="max-w-72 truncate px-4 py-2 font-medium" :title="item.dataId">{{ item.dataId }}</td>
              <td class="max-w-44 truncate px-4 py-2 text-xs text-muted-foreground" :title="item.group">{{ item.group || "DEFAULT_GROUP" }}</td>
              <td class="whitespace-nowrap px-4 py-2 text-xs text-muted-foreground">{{ display(item.lastModifiedTime) }}</td>
              <td class="max-w-40 truncate px-4 py-2 text-xs text-muted-foreground" :title="item.appName || ''">{{ display(item.appName) }}</td>
              <td class="px-4 py-2">
                <Badge variant="outline">{{ operationLabel(item.operation) }}</Badge>
              </td>
              <td class="max-w-40 truncate px-4 py-2 text-xs text-muted-foreground" :title="item.operator || ''">{{ display(item.operator) }}</td>
              <td class="px-4 py-2 text-right">
                <div class="inline-flex items-center gap-1.5">
                  <Button size="sm" variant="ghost" class="h-7 gap-1 px-2" :disabled="loading" @click="emit('view', item)">
                    <Eye class="h-3.5 w-3.5" />
                    {{ t("nacos.view") }}
                  </Button>
                  <Button size="sm" variant="ghost" class="h-7 gap-1 px-2" :disabled="loading" @click="emit('compare', item)">
                    <GitCompare class="h-3.5 w-3.5" />
                    {{ t("nacos.compare") }}
                  </Button>
                  <Button size="sm" variant="ghost" class="h-7 gap-1 px-2 text-destructive hover:text-destructive" :disabled="readOnly || loading" @click="emit('rollback', item)">
                    <RotateCcw class="h-3.5 w-3.5" />
                    {{ t("nacos.rollback") }}
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="loading" class="flex h-44 items-center justify-center text-sm text-muted-foreground">
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {{ t("nacos.loadingHistory") }}
        </div>
        <div v-else-if="items.length === 0" class="flex h-52 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
          <div class="flex h-10 w-10 items-center justify-center rounded-md border bg-muted/30">
            <FileText class="h-4 w-4" />
          </div>
          <div class="font-medium text-foreground">{{ t("nacos.noHistory") }}</div>
          <div class="text-xs">{{ t("nacos.noHistoryHint") }}</div>
        </div>
      </div>

      <DialogFooter class="shrink-0 items-center justify-between gap-3 border-t bg-muted/20 px-5 pb-5 pt-4">
        <Button variant="outline" size="sm" class="h-8 gap-1.5" :disabled="loading" @click="loadPage(pageNo)">
          <RefreshCw class="h-3.5 w-3.5" />
          {{ t("nacos.refresh") }}
        </Button>
        <div class="flex items-center gap-2 rounded-md border bg-background px-2 py-1 text-xs text-muted-foreground">
          <span>{{ t("nacos.total", { count: totalCount }) }}</span>
          <Button size="sm" variant="outline" class="h-7" :disabled="pageNo <= 1 || loading" @click="loadPage(pageNo - 1)">{{ t("nacos.prev") }}</Button>
          <span>{{ pageNo }} / {{ totalPages }}</span>
          <Button size="sm" variant="outline" class="h-7" :disabled="pageNo >= totalPages || loading" @click="loadPage(pageNo + 1)">{{ t("nacos.next") }}</Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="detailOpen">
    <DialogContent class="nacos-config-history-detail-dialog flex h-[min(88vh,900px)] flex-col gap-0 overflow-hidden p-0">
      <DialogHeader class="shrink-0 border-b px-5 py-4">
        <DialogTitle class="truncate text-base font-semibold">{{ t("nacos.historyDetail") }}</DialogTitle>
        <div v-if="viewingItem" class="mt-2 grid gap-1.5 text-xs text-muted-foreground sm:grid-cols-2">
          <div class="min-w-0 truncate font-mono" :title="viewingItem.namespace || 'public'">namespace={{ viewingItem.namespace || "public" }}</div>
          <div class="min-w-0 truncate font-mono" :title="viewingItem.dataId">dataId={{ viewingItem.dataId }}</div>
          <div class="min-w-0 truncate font-mono" :title="viewingItem.group || 'DEFAULT_GROUP'">group={{ viewingItem.group || "DEFAULT_GROUP" }}</div>
          <div class="min-w-0 truncate" :title="display(viewingItem.lastModifiedTime)">{{ t("nacos.updatedAt") }}={{ display(viewingItem.lastModifiedTime) }}</div>
        </div>
      </DialogHeader>
      <div class="min-h-0 flex-1 overflow-auto bg-muted/20 p-4">
        <div v-if="viewingLoading" class="flex h-full items-center justify-center text-sm text-muted-foreground">
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {{ t("nacos.loadingHistory") }}
        </div>
        <pre v-else class="min-h-full rounded-md border bg-background p-3 font-mono text-xs leading-5">{{ viewingContent || "" }}</pre>
      </div>
      <DialogFooter class="m-0 shrink-0 rounded-none border-t bg-background px-5 py-5 sm:py-4">
        <Button variant="outline" @click="detailOpen = false">{{ t("dangerDialog.cancel") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style>
.nacos-config-history-dialog {
  width: min(96vw, 1280px) !important;
  max-width: min(96vw, 1280px) !important;
}

.nacos-config-history-detail-dialog {
  width: min(92vw, 1180px) !important;
  max-width: min(92vw, 1180px) !important;
}

.nacos-config-history-detail-dialog pre {
  min-width: max-content;
  white-space: pre;
}
</style>

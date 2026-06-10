<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, ChevronRight, FolderClosed, FolderOpen, KeyRound, Loader2, Plus, RefreshCw, Search, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import * as api from "@/lib/api";
import type { KvGetResponse, KvKeySummary, KvValue } from "@/lib/api";
import { buildEtcdKeyTree, collectEtcdGroupIds, flattenVisibleEtcdKeyTree, type EtcdKeyTreeNode } from "@/lib/etcdKeyTree";
import { useToast } from "@/composables/useToast";

const props = defineProps<{ connectionId: string }>();

const { t } = useI18n();
const { toast } = useToast();
const searchInputRef = ref<HTMLInputElement>();
const prefix = ref("");
const keys = ref<KvKeySummary[]>([]);
const continuation = ref<string | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const expandedGroupIds = ref<Set<string>>(new Set());
const selectedKey = ref<string | null>(null);
const selectedValue = ref<KvGetResponse | null>(null);
const detailLoading = ref(false);
const detailError = ref("");
const showEditDialog = ref(false);
const editKey = ref("");
const editValue = ref("");
const editError = ref("");
const saving = ref(false);
const showDeleteConfirm = ref(false);
const deleting = ref(false);
const pageSize = 200;

const tree = computed(() => buildEtcdKeyTree(keys.value));
const visibleRows = computed(() => flattenVisibleEtcdKeyTree(tree.value, expandedGroupIds.value));
const selectedMetadata = computed(() => selectedValue.value?.metadata ?? keys.value.find((key) => key.key === selectedKey.value));
const selectedTextValue = computed(() => {
  const value = selectedValue.value?.value;
  if (!value) return "";
  return value.encoding === "utf8" ? value.data : value.data;
});
const selectedValueIsBase64 = computed(() => selectedValue.value?.value?.encoding === "base64");

function preserveExpandedGroups(expandAll = false) {
  const available = collectEtcdGroupIds(tree.value);
  const next = new Set<string>();
  for (const id of expandAll ? available : expandedGroupIds.value) {
    if (available.has(id)) next.add(id);
  }
  expandedGroupIds.value = next;
}

async function loadKeys(reset = true) {
  if (reset) {
    loading.value = true;
    continuation.value = null;
    keys.value = [];
    selectedKey.value = null;
    selectedValue.value = null;
  } else {
    loadingMore.value = true;
  }
  try {
    const result = await api.etcdListPrefix(props.connectionId, prefix.value.trim(), pageSize, reset ? null : continuation.value);
    const existing = new Set(keys.value.map((key) => key.key));
    const merged = reset ? result.keys : [...keys.value, ...result.keys.filter((key) => !existing.has(key.key))];
    keys.value = merged;
    continuation.value = result.continuation || null;
    preserveExpandedGroups(!!prefix.value.trim());
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function loadSelectedKey(key: string) {
  selectedKey.value = key;
  detailLoading.value = true;
  detailError.value = "";
  try {
    selectedValue.value = await api.etcdGet(props.connectionId, key);
  } catch (error) {
    detailError.value = error instanceof Error ? error.message : String(error);
  } finally {
    detailLoading.value = false;
  }
}

function toggleGroup(node: EtcdKeyTreeNode) {
  if (node.kind !== "group") return;
  const next = new Set(expandedGroupIds.value);
  if (next.has(node.id)) next.delete(node.id);
  else next.add(node.id);
  expandedGroupIds.value = next;
}

function onRowClick(node: EtcdKeyTreeNode) {
  if (node.kind === "group") {
    toggleGroup(node);
  } else {
    void loadSelectedKey(node.key);
  }
}

function openCreateDialog() {
  editKey.value = prefix.value.trim();
  editValue.value = "";
  editError.value = "";
  showEditDialog.value = true;
}

function openEditDialog() {
  if (!selectedKey.value) return;
  editKey.value = selectedKey.value;
  editValue.value = selectedTextValue.value;
  editError.value = selectedValueIsBase64.value ? t("etcd.base64Readonly") : "";
  showEditDialog.value = true;
}

async function saveKey() {
  const key = editKey.value.trim();
  if (!key) {
    editError.value = t("etcd.keyRequired");
    return;
  }
  saving.value = true;
  editError.value = "";
  try {
    const value: KvValue = { encoding: "utf8", data: editValue.value };
    await api.etcdPut(props.connectionId, key, value);
    showEditDialog.value = false;
    await loadKeys(true);
    await loadSelectedKey(key);
    toast(t("etcd.saved"), 2500);
  } catch (error) {
    editError.value = error instanceof Error ? error.message : String(error);
  } finally {
    saving.value = false;
  }
}

async function deleteSelectedKey() {
  if (!selectedKey.value) return;
  deleting.value = true;
  try {
    await api.etcdDelete(props.connectionId, selectedKey.value);
    showDeleteConfirm.value = false;
    selectedKey.value = null;
    selectedValue.value = null;
    await loadKeys(true);
    toast(t("etcd.deleted"), 2500);
  } finally {
    deleting.value = false;
  }
}

function metadataLabel(value: number | null | undefined): string {
  return value == null ? "-" : String(value);
}

function focusSearch(): boolean {
  searchInputRef.value?.focus();
  return true;
}

watch(
  () => props.connectionId,
  () => void loadKeys(true),
);
onMounted(() => void loadKeys(true));
defineExpose({ focusSearch });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <div class="relative min-w-0 flex-1">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input ref="searchInputRef" v-model="prefix" class="h-8 pl-8" :placeholder="t('etcd.prefixPlaceholder')" @keyup.enter="loadKeys(true)" />
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loading" @click="loadKeys(true)">
        <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCw v-else class="h-3.5 w-3.5" />
        {{ t("grid.refresh") }}
      </Button>
      <Button size="sm" class="h-8 gap-1.5" @click="openCreateDialog">
        <Plus class="h-3.5 w-3.5" />
        {{ t("etcd.newKey") }}
      </Button>
    </div>

    <div class="grid min-h-0 flex-1 grid-cols-[minmax(260px,38%)_1fr]">
      <div class="min-h-0 border-r">
        <div v-if="loading" class="flex h-full items-center justify-center text-sm text-muted-foreground">
          <Loader2 class="mr-2 h-4 w-4 animate-spin" />
          {{ t("etcd.loadingKeys") }}
        </div>
        <div v-else-if="visibleRows.length === 0" class="flex h-full items-center justify-center text-sm text-muted-foreground">
          {{ t("etcd.empty") }}
        </div>
        <div v-else class="h-full overflow-auto py-1 text-sm">
          <button
            v-for="row in visibleRows"
            :key="row.node.id"
            type="button"
            class="flex h-8 w-full items-center gap-1.5 px-2 text-left hover:bg-accent"
            :class="{ 'bg-accent/70': row.node.kind === 'leaf' && row.node.key === selectedKey }"
            :style="{ paddingLeft: `${8 + row.depth * 18}px` }"
            @click="onRowClick(row.node)"
          >
            <template v-if="row.node.kind === 'group'">
              <ChevronDown v-if="expandedGroupIds.has(row.node.id)" class="h-3.5 w-3.5 shrink-0" />
              <ChevronRight v-else class="h-3.5 w-3.5 shrink-0" />
              <FolderOpen v-if="expandedGroupIds.has(row.node.id)" class="h-4 w-4 shrink-0 text-sky-500" />
              <FolderClosed v-else class="h-4 w-4 shrink-0 text-sky-500" />
            </template>
            <template v-else>
              <span class="w-3.5 shrink-0" />
              <KeyRound class="h-4 w-4 shrink-0 text-sky-500" />
            </template>
            <span class="truncate">{{ row.node.label }}</span>
          </button>
          <div v-if="continuation" class="border-t p-2">
            <Button size="sm" variant="outline" class="h-8 w-full gap-1.5" :disabled="loadingMore" @click="loadKeys(false)">
              <Loader2 v-if="loadingMore" class="h-3.5 w-3.5 animate-spin" />
              {{ t("etcd.loadMore") }}
            </Button>
          </div>
        </div>
      </div>

      <div class="min-h-0 overflow-auto">
        <div v-if="!selectedKey" class="flex h-full items-center justify-center text-sm text-muted-foreground">
          {{ t("etcd.selectKey") }}
        </div>
        <div v-else class="flex min-h-full flex-col">
          <div class="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
            <div class="min-w-0">
              <div class="truncate font-medium">{{ selectedKey }}</div>
              <div class="mt-1 flex flex-wrap gap-1.5 text-xs text-muted-foreground">
                <Badge variant="secondary">rev {{ metadataLabel(selectedMetadata?.modRevision) }}</Badge>
                <Badge variant="outline">ver {{ metadataLabel(selectedMetadata?.version) }}</Badge>
                <Badge variant="outline">lease {{ metadataLabel(selectedMetadata?.lease) }}</Badge>
                <Badge variant="outline">{{ metadataLabel(selectedMetadata?.valueSize) }} B</Badge>
              </div>
            </div>
            <div class="flex shrink-0 gap-2">
              <Button size="sm" variant="outline" class="h-8" :disabled="selectedValueIsBase64" @click="openEditDialog">
                {{ t("etcd.edit") }}
              </Button>
              <Button size="sm" variant="destructive" class="h-8 gap-1.5" @click="showDeleteConfirm = true">
                <Trash2 class="h-3.5 w-3.5" />
                {{ t("etcd.delete") }}
              </Button>
            </div>
          </div>
          <div v-if="detailLoading" class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            <Loader2 class="mr-2 h-4 w-4 animate-spin" />
            {{ t("etcd.loadingValue") }}
          </div>
          <div v-else-if="detailError" class="p-4 text-sm text-destructive">{{ detailError }}</div>
          <div v-else-if="selectedValue && !selectedValue.found" class="p-4 text-sm text-muted-foreground">
            {{ t("etcd.notFound") }}
          </div>
          <pre v-else class="dbx-editor-font-family m-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-sm">{{ selectedTextValue }}</pre>
        </div>
      </div>
    </div>

    <Dialog v-model:open="showEditDialog">
      <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editKey ? t("etcd.editKey") : t("etcd.newKey") }}</DialogTitle>
        </DialogHeader>
        <div class="grid gap-3 py-2">
          <Input v-model="editKey" :placeholder="t('etcd.keyPlaceholder')" />
          <textarea v-model="editValue" class="min-h-52 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" spellcheck="false" />
          <div v-if="editError" class="text-sm text-destructive">{{ editError }}</div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showEditDialog = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="saving || (!!editError && selectedValueIsBase64)" @click="saveKey">
            <Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />
            {{ t("common.save") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <DangerConfirmDialog v-model:open="showDeleteConfirm" :title="t('etcd.deleteTitle')" :details="selectedKey || ''" :confirm-label="t('etcd.delete')" @confirm="deleteSelectedKey" />
  </div>
</template>

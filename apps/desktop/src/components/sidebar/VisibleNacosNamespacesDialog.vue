<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CheckSquare, Loader2, Search, Square } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import * as api from "@/lib/backend/api";
import { normalizeNacosNamespaceSelection, normalizeNacosNamespacesForDisplay } from "@/lib/nacos/nacosNamespaceVisibility";
import type { NacosNamespaceInfo } from "@/types/nacos";

const props = defineProps<{
  open: boolean;
  connectionId: string;
  connectionName: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const namespaces = ref<NacosNamespaceInfo[]>([]);
const selectedNamespaces = ref<Set<string>>(new Set());
const searchText = ref("");
const isLoading = ref(false);
const loadError = ref("");

const connection = computed(() => connectionStore.getConfig(props.connectionId));
const filteredNamespaces = computed(() => {
  const query = searchText.value.trim().toLowerCase();
  if (!query) return namespaces.value;
  return namespaces.value.filter((namespace) => {
    const label = nacosNamespaceLabel(namespace).toLowerCase();
    return label.includes(query) || namespace.namespace.toLowerCase().includes(query);
  });
});
const selectedCount = computed(() => selectedNamespaces.value.size);
const canSave = computed(() => selectedNamespaces.value.size > 0);
const showAllDisabled = computed(() => !Array.isArray(connection.value?.visible_databases));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void loadNamespaces();
  },
  { immediate: true },
);

function nacosNamespaceValue(namespace: NacosNamespaceInfo): string {
  return namespace.namespace || "";
}

function nacosNamespaceLabel(namespace: NacosNamespaceInfo): string {
  return namespace.namespaceShowName || namespace.namespace || "public";
}

async function loadNamespaces() {
  if (isLoading.value) return;
  isLoading.value = true;
  loadError.value = "";
  searchText.value = "";
  try {
    await connectionStore.ensureConnected(props.connectionId);
    const fetched = normalizeNacosNamespacesForDisplay(await api.nacosListNamespaces(props.connectionId));
    namespaces.value = [...fetched].sort((left, right) => nacosNamespaceLabel(left).localeCompare(nacosNamespaceLabel(right)));
    connectionStore.recordPrimaryVisibleObjectNames(props.connectionId, namespaces.value.map(nacosNamespaceValue));
    const configured = connection.value?.visible_databases;
    const initialSelection = Array.isArray(configured) ? normalizeNacosNamespaceSelection(configured, namespaces.value) : namespaces.value.map(nacosNamespaceValue);
    selectedNamespaces.value = new Set(initialSelection);
  } catch (error: any) {
    namespaces.value = [];
    selectedNamespaces.value = new Set();
    loadError.value = String(error?.message || error);
  } finally {
    isLoading.value = false;
  }
}

function toggleNamespace(namespace: string) {
  const next = new Set(selectedNamespaces.value);
  if (next.has(namespace)) next.delete(namespace);
  else next.add(namespace);
  selectedNamespaces.value = next;
}

function selectAll() {
  selectedNamespaces.value = new Set(namespaces.value.map(nacosNamespaceValue));
}

function clearSelection() {
  selectedNamespaces.value = new Set();
}

async function showAll() {
  await connectionStore.clearVisibleDatabases(props.connectionId);
  emit("update:open", false);
}

async function saveSelection() {
  if (!canSave.value) return;
  const selected = normalizeNacosNamespaceSelection(selectedNamespaces.value, namespaces.value);
  await connectionStore.setVisibleDatabases(props.connectionId, selected);
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("nacos.nacosVisibleNamespacesTitle") }}</DialogTitle>
        <p class="text-sm text-muted-foreground">{{ t("nacos.nacosVisibleNamespacesDescription", { name: connectionName }) }}</p>
      </DialogHeader>

      <div class="flex items-center gap-2 rounded-md border bg-background px-2">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input v-model="searchText" :placeholder="t('nacos.nacosSearchNamespaces')" class="h-8 border-0 px-0 shadow-none focus-visible:ring-0" :disabled="isLoading || !!loadError" />
      </div>

      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>{{ t("nacos.nacosSelectedNamespaces", { selected: selectedCount, total: namespaces.length }) }}</span>
        <div class="flex items-center gap-2">
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoading" @click="selectAll">{{ t("nacos.nacosSelectAll") }}</button>
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoading" @click="clearSelection">{{ t("nacos.nacosClearSelection") }}</button>
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoading || showAllDisabled" @click="showAll">{{ t("nacos.nacosShowAll") }}</button>
        </div>
      </div>
      <p v-if="!isLoading && !loadError && !canSave" class="text-xs text-destructive">{{ t("nacos.nacosNamespaceSelectionRequired") }}</p>

      <div class="h-72 overflow-y-auto rounded-md border bg-background/50 p-1">
        <div v-if="isLoading" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-else-if="loadError" class="p-3 text-sm text-destructive">{{ t("nacos.nacosLoadNamespacesFailed", { message: loadError }) }}</div>
        <div v-else-if="!filteredNamespaces.length" class="p-3 text-sm text-muted-foreground">{{ t("grid.noSearchResults") }}</div>
        <template v-else>
          <button
            v-for="namespace in filteredNamespaces"
            :key="nacosNamespaceValue(namespace) || '__public__'"
            type="button"
            class="flex min-h-9 w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
            @click="toggleNamespace(nacosNamespaceValue(namespace))"
          >
            <CheckSquare v-if="selectedNamespaces.has(nacosNamespaceValue(namespace))" class="h-4 w-4 shrink-0 text-primary" />
            <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1 truncate">{{ nacosNamespaceLabel(namespace) }}</span>
            <span v-if="namespace.namespace && namespace.namespace !== nacosNamespaceLabel(namespace)" class="shrink-0 truncate text-xs text-muted-foreground">{{ namespace.namespace }}</span>
          </button>
        </template>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="isLoading || !!loadError || !canSave" @click="saveSelection">{{ t("nacos.save") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

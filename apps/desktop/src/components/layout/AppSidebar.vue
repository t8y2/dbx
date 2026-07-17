<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { translateBackendError } from "@/i18n/backend-errors";
import { Upload, Download, FolderPlus, RefreshCw, ChevronsLeft, ChevronsUp, Trash2, FolderInput, Check, Minus, Square, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import LightDropdown from "@/components/ui/LightDropdown.vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import ConnectionTree from "@/components/sidebar/ConnectionTree.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";

defineProps<{
  sidebarWidth: number;
  classicLayout?: boolean;
}>();

const emit = defineEmits<{
  import: [source: "dbx" | "navicat" | "dbeaver" | "datagrip"];
  export: [];
  startResize: [event: MouseEvent];
  collapse: [];
}>();

type ImportSource = "dbx" | "navicat" | "dbeaver" | "datagrip";

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { toast } = useToast();
const connectionTreeRef = ref<InstanceType<typeof ConnectionTree>>();
const showDeleteSelectedConfirm = ref(false);
const showCreateSelectedGroupDialog = ref(false);
const selectedGroupName = ref("");
const UNGROUPED_GROUP_VALUE = "__ungrouped";
const importSourceItems = computed(() => [
  { value: "dbx", label: t("sidebar.importDbx") },
  { value: "navicat", label: t("sidebar.importNavicat") },
  { value: "dbeaver", label: t("sidebar.importDbeaver") },
  { value: "datagrip", label: t("sidebar.importDatagrip") },
]);
const connectionIdSet = computed(() => new Set(connectionStore.connections.map((connection) => connection.id)));
const allConnectionIds = computed(() => connectionStore.connections.map((connection) => connection.id));
const selectedConnectionIds = computed(() => (connectionStore.connectionMultiSelectActive ? connectionStore.selectedTreeNodeIds.filter((id) => connectionIdSet.value.has(id)) : []));
const selectedConnectionCount = computed(() => selectedConnectionIds.value.length);
const showConnectionMultiSelectToolbar = computed(() => connectionStore.connectionMultiSelectActive && selectedConnectionCount.value > 0);
const allConnectionsSelected = computed(() => allConnectionIds.value.length > 0 && selectedConnectionCount.value === allConnectionIds.value.length);
const selectAllIcon = computed(() => (allConnectionsSelected.value ? Check : selectedConnectionCount.value > 0 ? Minus : Square));
const selectAllLabel = computed(() => (allConnectionsSelected.value ? t("connectionGroup.deselectAllConnections") : t("connectionGroup.selectAllConnections")));
const moveGroupItems = computed(() => [
  ...connectionStore.sidebarLayout.groups.map((group) => ({
    value: group.id,
    label: group.name,
  })),
  {
    value: UNGROUPED_GROUP_VALUE,
    label: t("connectionGroup.ungrouped"),
    separatorBefore: connectionStore.sidebarLayout.groups.length > 0,
  },
]);

async function refreshTree() {
  try {
    await connectionStore.refreshAllTree();
  } catch (e: any) {
    toast(t("connection.connectFailed", { message: translateBackendError(t, e?.message || String(e)) }), 5000);
  }
}

function createNewGroup() {
  void connectionTreeRef.value?.createNewGroup();
}

function selectImportSource(source: string) {
  emit("import", source as ImportSource);
}

function collapseAllTreeNodes() {
  connectionTreeRef.value?.collapseAllTreeNodes();
}

function focusSearch(): boolean {
  return connectionTreeRef.value?.focusSearch() ?? false;
}

function clearConnectionMultiSelection() {
  connectionStore.connectionMultiSelectActive = false;
  connectionStore.selectedTreeNodeIds = [];
  connectionStore.selectedTreeNodeId = null;
  connectionStore.treeSelectionAnchorId = null;
}

function toggleAllConnectionsSelected() {
  if (allConnectionsSelected.value) {
    clearConnectionMultiSelection();
    return;
  }

  const ids = allConnectionIds.value;
  connectionStore.connectionMultiSelectActive = ids.length > 0;
  connectionStore.selectedTreeNodeIds = ids;
  connectionStore.selectedTreeNodeId = ids[0] ?? null;
  connectionStore.treeSelectionAnchorId = ids[0] ?? null;
}

async function confirmDeleteSelectedConnections() {
  const ids = selectedConnectionIds.value;
  if (ids.length === 0) return;
  try {
    await connectionStore.removeConnections(ids);
    for (const connectionId of ids) {
      connectionStore.disconnect(connectionId).catch((error) => {
        console.warn("[DBX][connection:delete:disconnect-failed]", { connectionId, error });
      });
    }
    clearConnectionMultiSelection();
    showDeleteSelectedConfirm.value = false;
    toast(t("connection.deletedSelected", { count: ids.length }), 2000);
  } catch (e: any) {
    toast(t("connection.saveFailed", { message: e?.message || String(e) }), 5000);
  }
}

function moveSelectedConnectionsToGroup(value: string) {
  const groupId = value === UNGROUPED_GROUP_VALUE ? null : value;
  for (const connectionId of selectedConnectionIds.value) {
    connectionStore.moveConnectionToGroup(connectionId, groupId);
  }
}

function openCreateSelectedGroupDialog() {
  selectedGroupName.value = "";
  showCreateSelectedGroupDialog.value = true;
}

function confirmCreateSelectedGroup() {
  const name = selectedGroupName.value.trim();
  if (!name || selectedConnectionIds.value.length === 0) return;
  const groupId = connectionStore.createConnectionGroup(name);
  for (const connectionId of selectedConnectionIds.value) {
    connectionStore.moveConnectionToGroup(connectionId, groupId);
  }
  showCreateSelectedGroupDialog.value = false;
}

defineExpose({ focusSearch });
</script>

<template>
  <div class="app-sidebar-panel h-full shrink-0 relative select-none" :class="classicLayout ? '' : 'rounded-md border border-border/80 bg-background'" :style="{ width: sidebarWidth + 'px' }">
    <div class="h-full flex flex-col overflow-hidden">
      <div class="app-sidebar-toolbar flex items-center gap-px px-3 text-xs font-medium text-muted-foreground border-b bg-muted/20" :class="classicLayout ? 'h-9' : 'h-10'">
        <span class="flex self-stretch items-center truncate" data-tauri-drag-region>{{ t("sidebar.connections") }}</span>
        <span class="flex-1 self-stretch" data-tauri-drag-region />
        <template v-if="showConnectionMultiSelectToolbar">
          <span class="mr-1 text-[11px] font-medium text-muted-foreground">{{ selectedConnectionCount }}</span>
          <LightTooltip :text="t('connectionGroup.createGroup')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="openCreateSelectedGroupDialog">
              <FolderPlus class="h-3 w-3" />
            </Button>
          </LightTooltip>
          <LightTooltip :text="t('connectionGroup.moveToGroup')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <span class="inline-flex">
              <LightDropdown
                model-value=""
                :items="moveGroupItems"
                :aria-label="t('connectionGroup.moveToGroup')"
                :trigger-icon="FolderInput"
                trigger-class="inline-flex h-5 w-5 items-center justify-center rounded-md outline-none hover:bg-muted hover:text-foreground focus-visible:ring-0"
                trigger-icon-class="h-3.5 w-3.5"
                content-class="w-44"
                :show-trigger-label="false"
                :show-chevron="false"
                :highlight-selected="false"
                check-position="none"
                align="end"
                @update:model-value="moveSelectedConnectionsToGroup"
              />
            </span>
          </LightTooltip>
          <LightTooltip :text="t('contextMenu.deleteSelectedConnections', { count: selectedConnectionCount })" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-5 w-5 text-destructive hover:text-destructive" @click="showDeleteSelectedConfirm = true">
              <Trash2 class="h-3 w-3" />
            </Button>
          </LightTooltip>
          <LightTooltip :text="selectAllLabel" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="toggleAllConnectionsSelected">
              <component :is="selectAllIcon" class="h-3 w-3" />
            </Button>
          </LightTooltip>
          <LightTooltip :text="t('connectionGroup.exitMultiSelect')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="clearConnectionMultiSelection">
              <X class="h-3 w-3" />
            </Button>
          </LightTooltip>
        </template>
        <template v-else>
          <LightTooltip :text="t('sidebar.import')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <span class="inline-flex">
              <LightDropdown
                model-value=""
                :items="importSourceItems"
                :aria-label="t('sidebar.import')"
                :trigger-icon="Download"
                trigger-class="inline-flex h-6 w-5 items-center justify-center rounded-md outline-none hover:bg-muted hover:text-foreground focus-visible:ring-0"
                trigger-icon-class="h-4 w-4"
                content-class="w-44"
                :show-trigger-label="false"
                :show-chevron="false"
                :highlight-selected="false"
                check-position="none"
                align="end"
                @update:model-value="selectImportSource"
              />
            </span>
          </LightTooltip>
          <LightTooltip :text="t('sidebar.export')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="emit('export')">
              <Upload class="h-3 w-3" />
            </Button>
          </LightTooltip>
          <LightTooltip :text="t('sidebar.collapseAll')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="collapseAllTreeNodes">
              <ChevronsUp class="h-3 w-3" />
            </Button>
          </LightTooltip>
          <LightTooltip :text="t('connectionGroup.createGroup')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="createNewGroup">
              <FolderPlus class="h-3 w-3" />
            </Button>
          </LightTooltip>
          <LightTooltip :text="t('contextMenu.refreshChildren')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-5 w-5" @click="refreshTree">
              <RefreshCw class="h-3 w-3" />
            </Button>
          </LightTooltip>
          <LightTooltip :text="t('sidebar.collapse')" side="bottom" :delay="0" :close-delay="0" nowrap>
            <Button variant="ghost" size="icon" class="h-6 w-6" @click="emit('collapse')">
              <ChevronsLeft class="h-3.5 w-3.5" />
            </Button>
          </LightTooltip>
        </template>
      </div>
      <div class="flex-1 min-h-0">
        <ConnectionTree ref="connectionTreeRef" />
      </div>
    </div>
    <div class="panel-resize-handle panel-resize-handle--right" @mousedown="emit('startResize', $event)" />
    <Dialog v-model:open="showDeleteSelectedConfirm">
      <DialogContent class="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>{{ t("contextMenu.confirmDeleteTitle") }}</DialogTitle>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">
          {{ t("contextMenu.confirmDeleteSelectedMessage", { count: selectedConnectionCount }) }}
        </p>
        <DialogFooter>
          <Button variant="outline" @click="showDeleteSelectedConfirm = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" @click="confirmDeleteSelectedConnections">{{ t("contextMenu.deleteSelectedConnections", { count: selectedConnectionCount }) }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog v-model:open="showCreateSelectedGroupDialog">
      <DialogContent class="sm:max-w-[360px]">
        <DialogHeader>
          <DialogTitle>{{ t("connectionGroup.createGroup") }}</DialogTitle>
        </DialogHeader>
        <Input v-model="selectedGroupName" :placeholder="t('connectionGroup.groupNamePlaceholder')" @keydown.enter.prevent="confirmCreateSelectedGroup" />
        <DialogFooter>
          <Button variant="outline" @click="showCreateSelectedGroupDialog = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="!selectedGroupName.trim()" @click="confirmCreateSelectedGroup">{{ t("connectionGroup.createGroup") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

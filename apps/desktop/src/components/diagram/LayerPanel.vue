<script setup lang="ts">
import { ref, reactive, computed, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, Trash2, Eye, EyeOff, ChevronDown, ChevronRight, Edit3, Check, X, CheckSquare, Square, Lock, Unlock } from "@lucide/vue";
import { useLayerStore } from "@/lib/diagram/layer-store";
import type { DiagramTable } from "@/lib/diagram/erDiagram";
import { filterAssignableDiagramTables } from "@/lib/diagram/erDiagram";
import type { LayerLayoutMode } from "@/types/diagram";
import { useToast } from "@/composables/useToast";

const props = defineProps<{
  tables: DiagramTable[];
  recordHistory?: () => void;
}>();

const emit = defineEmits<{
  (e: "layer-changed"): void;
  (e: "add-layer"): void;
  (e: "layout-mode-changed", payload: { layerId: string; layoutMode: LayerLayoutMode }): void;
  (e: "focus-layer", layerId: string): void;
  (e: "create-draft-table", payload: { name: string; layerId: string | null; withDefaultId: boolean }): void;
  (e: "delete-table", tableName: string): void;
}>();

const store = useLayerStore();
const { toast } = useToast();
const { t } = useI18n();

function beforeMutate() {
  props.recordHistory?.();
}

type AddTableTab = "existing" | "create";

const editingLayerId = ref<string | null>(null);
const editingName = ref("");
const renameInputRef = ref<HTMLInputElement | null>(null);
const selectedTableNames = ref<Map<string, Set<string>>>(new Map());
const addTableFilter = ref("");
/** Layer ids whose "tables in other layers" section is expanded (default: collapsed). */
const otherLayersExpandedByLayer = ref<Set<string>>(new Set());
const addTableTabByLayerId = reactive<Record<string, AddTableTab>>({});
const createNameByLayerId = reactive<Record<string, string>>({});
const createWithIdByLayerId = reactive<Record<string, boolean>>({});
const createErrorByLayerId = reactive<Record<string, string>>({});

function getAddTableTab(layerId: string): AddTableTab {
  return addTableTabByLayerId[layerId] || "existing";
}

function ensureCreateFormDefaults(layerId: string) {
  if (createNameByLayerId[layerId] === undefined) createNameByLayerId[layerId] = "";
  if (createWithIdByLayerId[layerId] === undefined) createWithIdByLayerId[layerId] = true;
}

function setAddTableTab(layerId: string, tab: AddTableTab) {
  addTableTabByLayerId[layerId] = tab;
  if (tab === "create") ensureCreateFormDefaults(layerId);
}

function submitCreateDraft(layerId: string) {
  const trimmed = (createNameByLayerId[layerId] || "").trim();
  if (!trimmed) {
    createErrorByLayerId[layerId] = t("diagram.tableNameRequired");
    return;
  }
  if (props.tables.some((tbl) => tbl.name.toLowerCase() === trimmed.toLowerCase())) {
    createErrorByLayerId[layerId] = t("diagram.tableNameExists");
    return;
  }
  delete createErrorByLayerId[layerId];
  createNameByLayerId[layerId] = "";
  emit("create-draft-table", {
    name: trimmed,
    layerId,
    withDefaultId: createWithIdByLayerId[layerId] ?? true,
  });
}
function getSelectedTables(layerId: string): Set<string> {
  return selectedTableNames.value.get(layerId) || new Set();
}

function toggleSelectedTable(layerId: string, tableName: string) {
  const selected = selectedTableNames.value.get(layerId) || new Set();
  if (selected.has(tableName)) {
    selected.delete(tableName);
  } else {
    selected.add(tableName);
  }
  selectedTableNames.value.set(layerId, selected);
}

function isTableSelected(layerId: string, tableName: string): boolean {
  return getSelectedTables(layerId).has(tableName);
}

const assignableTables = computed(() => filterAssignableDiagramTables(props.tables));

const availableTables = computed(() => {
  return assignableTables.value.filter((table) => !store.getLayerByTable(table.name));
});

function matchesAddTableFilter(name: string): boolean {
  const q = addTableFilter.value.trim().toLowerCase();
  if (!q) return true;
  return name.toLowerCase().includes(q);
}

const filteredAvailableTables = computed(() => {
  return availableTables.value.filter((table) => matchesAddTableFilter(table.name));
});

function getOtherLayerTables(excludeLayerId: string): DiagramTable[] {
  return assignableTables.value.filter((table) => getOtherLayerForTable(table.name, excludeLayerId));
}

function getFilteredOtherLayerTables(excludeLayerId: string): DiagramTable[] {
  return getOtherLayerTables(excludeLayerId).filter((table) => matchesAddTableFilter(table.name));
}

function isOtherLayersExpanded(layerId: string): boolean {
  return otherLayersExpandedByLayer.value.has(layerId);
}

function toggleOtherLayersExpanded(layerId: string) {
  const next = new Set(otherLayersExpandedByLayer.value);
  if (next.has(layerId)) {
    next.delete(layerId);
  } else {
    next.add(layerId);
  }
  otherLayersExpandedByLayer.value = next;
}

function getOtherLayerForTable(tableName: string, excludeLayerId: string): string | null {
  const layer = store.layers.find((l) => l.id !== excludeLayerId && l.tableNames.includes(tableName));
  return layer?.name || null;
}

function handleAddSelectedTables(layerId: string) {
  const selected = getSelectedTables(layerId);
  if (selected.size === 0) return;

  beforeMutate();
  selected.forEach((tableName) => {
    const currentLayer = store.getLayerByTable(tableName);
    if (currentLayer) {
      store.removeTableFromLayer(currentLayer.id, tableName);
    }
    store.addTableToLayer(layerId, tableName);
  });

  selectedTableNames.value.delete(layerId);
  const next = new Set(otherLayersExpandedByLayer.value);
  next.delete(layerId);
  otherLayersExpandedByLayer.value = next;
  addTableFilter.value = "";
  emit("layer-changed");
}

function selectAllAvailableTables(layerId: string) {
  const all = new Set(filteredAvailableTables.value.map((t) => t.name));
  selectedTableNames.value.set(layerId, all);
}

function selectAllTablesFromOtherLayers(layerId: string) {
  const selected = getSelectedTables(layerId);
  getFilteredOtherLayerTables(layerId).forEach((table) => {
    selected.add(table.name);
  });
  selectedTableNames.value.set(layerId, selected);
}

function clearSelection(layerId: string) {
  selectedTableNames.value.set(layerId, new Set());
}

function handleAddLayer() {
  emit("add-layer");
}

function handleRemoveLayer(layerId: string) {
  beforeMutate();
  store.removeLayer(layerId);
  selectedTableNames.value.delete(layerId);
  delete addTableTabByLayerId[layerId];
  delete createNameByLayerId[layerId];
  delete createWithIdByLayerId[layerId];
  delete createErrorByLayerId[layerId];
  const next = new Set(otherLayersExpandedByLayer.value);
  next.delete(layerId);
  otherLayersExpandedByLayer.value = next;
  emit("layer-changed");
}

function handleRenameLayer(layerId: string) {
  const layer = store.layers.find((l) => l.id === layerId);
  if (!layer) return;

  const newName = editingName.value.trim();
  if (!newName) {
    cancelRename();
    return;
  }

  if (newName.length > 50) {
    toast(t("diagram.layerNameTooLong"), 3000);
    return;
  }

  // Unicode letters/digits (incl. Chinese); allow space, _, -, . in the middle
  const nameRegex = /^[\p{L}\p{N}][\p{L}\p{N}_\-.\s]*$/u;
  if (!nameRegex.test(newName)) {
    toast(t("diagram.layerNameInvalid"), 3000);
    return;
  }

  const existingLayer = store.layers.find((l) => l.id !== layerId && l.name === newName);
  if (existingLayer) {
    toast(t("diagram.layerNameExists"), 3000);
    return;
  }

  if (newName === layer.name) {
    cancelRename();
    return;
  }

  beforeMutate();
  store.renameLayer(layerId, newName);
  editingLayerId.value = null;
  editingName.value = "";
  emit("layer-changed");
}

function cancelRename() {
  editingLayerId.value = null;
  editingName.value = "";
}

async function startRename(layerId: string) {
  const layer = store.layers.find((l) => l.id === layerId);
  if (!layer) return;
  editingLayerId.value = layerId;
  editingName.value = layer.name;
  await nextTick();
  const focusRenameInput = () => {
    renameInputRef.value?.focus();
    renameInputRef.value?.select();
  };
  focusRenameInput();
  // dblclick 前的 click 会触发 focus-layer → fitView，延后一帧避免被抢走焦点
  requestAnimationFrame(focusRenameInput);
}

function handleRemoveTable(layerId: string, tableName: string) {
  beforeMutate();
  store.removeTableFromLayer(layerId, tableName);
  emit("layer-changed");
}

function handleDeleteTable(tableName: string) {
  emit("delete-table", tableName);
}

function handleToggleVisibility(layerId: string) {
  beforeMutate();
  store.toggleLayerVisibility(layerId);
  emit("layer-changed");
}

function isLayerLocked(layer: { layoutMode?: LayerLayoutMode }): boolean {
  return (layer.layoutMode ?? "auto") === "free";
}

function handleToggleLayoutLock(layerId: string) {
  const layer = store.layers.find((l) => l.id === layerId);
  if (!layer) return;
  const nextMode: LayerLayoutMode = isLayerLocked(layer) ? "auto" : "free";
  emit("layout-mode-changed", { layerId, layoutMode: nextMode });
}

function handleToggleCollapse(layerId: string) {
  store.toggleLayerCollapse(layerId);
}

function handleSetActiveLayer(layerId: string) {
  store.setActiveLayer(layerId);
  emit("focus-layer", layerId);
}

function getLayerTables(layerId: string): DiagramTable[] {
  const layer = store.layers.find((l) => l.id === layerId);
  if (!layer) return [];
  return assignableTables.value.filter((table) => layer.tableNames.includes(table.name));
}

function getLayerColor(layerId: string): string {
  const layer = store.layers.find((l) => l.id === layerId);
  return layer?.color || "#ccc";
}
</script>

<template>
  <div class="flex flex-col h-full max-h-full min-h-0 bg-background border-r border-border">
    <div class="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
      <h3 class="text-sm font-semibold text-foreground">Layers</h3>
      <button type="button" class="p-1.5 rounded-md hover:bg-muted transition-colors" title="Add Layer" @click="handleAddLayer">
        <Plus class="h-4 w-4 text-foreground" />
      </button>
    </div>

    <div class="flex-1 overflow-y-auto p-2 space-y-1">
      <div v-if="store.layers.length === 0" class="text-xs text-muted-foreground text-center py-4">No layers yet. Click + to create one.</div>

      <div v-for="layer in store.layers" :key="layer.id" class="rounded-md border transition-all" :class="store.activeLayerId === layer.id ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/50'">
        <div class="flex items-center gap-1 px-2 py-1.5 cursor-pointer" @click="handleSetActiveLayer(layer.id)">
          <button type="button" class="p-0.5 rounded hover:bg-muted transition-colors" @click.stop="handleToggleCollapse(layer.id)">
            <ChevronDown v-if="!layer.collapsed" class="h-3.5 w-3.5 text-muted-foreground" />
            <ChevronRight v-else class="h-3.5 w-3.5 text-muted-foreground" />
          </button>

          <div class="w-3 h-3 rounded-full shrink-0" :style="{ backgroundColor: layer.color }" />

          <template v-if="editingLayerId === layer.id">
            <input ref="renameInputRef" v-model="editingName" class="flex-1 min-w-0 text-xs bg-background border border-border rounded px-1.5 py-0.5 outline-none focus:border-primary" @mousedown.stop @click.stop @keydown.enter="handleRenameLayer(layer.id)" @keydown.escape="cancelRename" />
            <button type="button" class="p-0.5 rounded hover:bg-muted transition-colors" @click.stop="handleRenameLayer(layer.id)">
              <Check class="h-3 w-3 text-green-500" />
            </button>
            <button type="button" class="p-0.5 rounded hover:bg-muted transition-colors" @click.stop="cancelRename">
              <X class="h-3 w-3 text-red-500" />
            </button>
          </template>

          <template v-else>
            <span class="flex-1 min-w-0 text-xs font-medium truncate cursor-pointer hover:bg-muted/50 rounded px-1" @dblclick.stop="startRename(layer.id)">{{ layer.name }}</span>
            <button type="button" class="p-0.5 rounded hover:bg-muted transition-colors opacity-0 hover:opacity-100" @click.stop="startRename(layer.id)">
              <Edit3 class="h-3 w-3 text-muted-foreground" />
            </button>
            <button type="button" class="p-0.5 rounded hover:bg-muted transition-colors" @click.stop="handleToggleLayoutLock(layer.id)" :title="isLayerLocked(layer) ? t('diagram.layerUnlock') : t('diagram.layerLock')">
              <Lock v-if="isLayerLocked(layer)" class="h-3 w-3 text-muted-foreground" />
              <Unlock v-else class="h-3 w-3 text-muted-foreground" />
            </button>
            <button type="button" class="p-0.5 rounded hover:bg-muted transition-colors" @click.stop="handleToggleVisibility(layer.id)" :title="layer.visible ? t('diagram.hideLayer') : t('diagram.showLayer')">
              <Eye v-if="layer.visible" class="h-3 w-3 text-muted-foreground" />
              <EyeOff v-else class="h-3 w-3 text-muted-foreground/50" />
            </button>
            <button type="button" class="p-0.5 rounded hover:bg-muted transition-colors" @click.stop="handleRemoveLayer(layer.id)" :title="t('diagram.deleteLayer')">
              <Trash2 class="h-3 w-3 text-red-500" />
            </button>
          </template>
        </div>

        <div v-if="!layer.collapsed" class="px-2 pb-2">
          <div class="space-y-0.5">
            <div v-for="table in getLayerTables(layer.id)" :key="table.name" class="flex items-center gap-1 px-2 py-1 rounded text-xs bg-muted/50">
              <span class="flex-1 min-w-0 truncate">{{ table.name }}</span>
              <button type="button" class="p-0.5 rounded hover:bg-background transition-colors" @click.stop="handleRemoveTable(layer.id, table.name)" :title="t('diagram.removeFromLayer')">
                <X class="h-3 w-3 text-muted-foreground" />
              </button>
              <button type="button" class="p-0.5 rounded hover:bg-background transition-colors" @click.stop="handleDeleteTable(table.name)" :title="t('diagram.deleteLiveTable')">
                <Trash2 class="h-3 w-3 text-red-500" />
              </button>
            </div>
          </div>

          <div class="mt-2 space-y-1.5">
            <div class="flex border-b border-border">
              <button type="button" class="flex-1 px-1 py-1 text-[10px] transition-colors" :class="getAddTableTab(layer.id) === 'existing' ? 'border-b-2 border-primary text-primary font-medium' : 'text-muted-foreground hover:text-foreground'" @click.stop="setAddTableTab(layer.id, 'existing')">
                {{ t("diagram.tabSelectExisting") }}
              </button>
              <button type="button" class="flex-1 px-1 py-1 text-[10px] transition-colors" :class="getAddTableTab(layer.id) === 'create' ? 'border-b-2 border-primary text-primary font-medium' : 'text-muted-foreground hover:text-foreground'" @click.stop="setAddTableTab(layer.id, 'create')">
                {{ t("diagram.tabCreateTable") }}
              </button>
            </div>

            <div v-if="getAddTableTab(layer.id) === 'existing'" class="space-y-1">
              <div class="flex gap-1">
                <button type="button" class="flex-1 text-[9px] bg-muted hover:bg-muted/80 py-0.5 rounded transition-colors" @click.stop="selectAllAvailableTables(layer.id)">
                  {{ t("diagram.selectAll") }}
                </button>
                <button type="button" class="flex-1 text-[9px] bg-muted hover:bg-muted/80 py-0.5 rounded transition-colors" @click.stop="clearSelection(layer.id)">
                  {{ t("diagram.clearSelection") }}
                </button>
              </div>

              <input v-model="addTableFilter" type="search" class="w-full h-7 text-[11px] bg-background border border-border rounded px-2 outline-none focus:border-primary" :placeholder="t('diagram.filterTables')" @click.stop />

              <div class="space-y-0.5 max-h-48 overflow-y-auto border border-border rounded">
                <div v-for="table in filteredAvailableTables" :key="table.name" class="flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-muted/50 cursor-pointer" @click.stop="toggleSelectedTable(layer.id, table.name)">
                  <CheckSquare v-if="isTableSelected(layer.id, table.name)" class="h-3 w-3 text-primary shrink-0" />
                  <Square v-else class="h-3 w-3 text-muted-foreground shrink-0" />
                  <span class="flex-1 min-w-0 truncate">{{ table.name }}</span>
                </div>
                <div v-if="filteredAvailableTables.length === 0" class="px-2 py-2 text-[10px] text-muted-foreground text-center">
                  {{ t("diagram.noMatchingTables") }}
                </div>
              </div>

              <div v-if="store.layers.length > 1" class="mt-1">
                <div class="flex items-center justify-between mb-1 gap-1">
                  <button type="button" class="flex items-center gap-0.5 min-w-0 text-[9px] text-muted-foreground hover:text-foreground" @click.stop="toggleOtherLayersExpanded(layer.id)">
                    <ChevronDown v-if="isOtherLayersExpanded(layer.id)" class="h-3 w-3 shrink-0" />
                    <ChevronRight v-else class="h-3 w-3 shrink-0" />
                    <span class="truncate">{{ t("diagram.tablesInOtherLayers") }}</span>
                  </button>
                  <button type="button" class="text-[9px] text-primary/70 hover:text-primary shrink-0" @click.stop="selectAllTablesFromOtherLayers(layer.id)">
                    {{ t("diagram.selectAll") }}
                  </button>
                </div>
                <div v-if="isOtherLayersExpanded(layer.id)" class="space-y-0.5 max-h-32 overflow-y-auto border border-border rounded bg-muted/20">
                  <div v-for="table in getFilteredOtherLayerTables(layer.id)" :key="table.name" class="flex items-center gap-1.5 px-2 py-1 text-xs hover:bg-muted/50 cursor-pointer" @click.stop="toggleSelectedTable(layer.id, table.name)">
                    <div class="relative shrink-0">
                      <CheckSquare v-if="isTableSelected(layer.id, table.name)" class="h-3 w-3 text-primary" />
                      <Square v-else class="h-3 w-3 text-muted-foreground" />
                      <div class="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full border border-background" :style="{ backgroundColor: getLayerColor(store.layers.find((l) => l.id !== layer.id && l.tableNames.includes(table.name))?.id || '') }" />
                    </div>
                    <span class="flex-1 min-w-0 truncate opacity-70">{{ table.name }}</span>
                    <span class="text-[9px] px-1 py-0.5 rounded bg-muted-foreground/10 text-muted-foreground shrink-0">
                      {{ getOtherLayerForTable(table.name, layer.id) }}
                    </span>
                  </div>
                  <div v-if="getFilteredOtherLayerTables(layer.id).length === 0" class="px-2 py-2 text-[10px] text-muted-foreground text-center">
                    {{ t("diagram.noMatchingTables") }}
                  </div>
                </div>
              </div>

              <button type="button" class="w-full mt-1 text-xs bg-primary text-primary-foreground py-1 rounded hover:bg-primary/90 transition-colors" :disabled="getSelectedTables(layer.id).size === 0" @click.stop="handleAddSelectedTables(layer.id)">
                {{ t("diagram.addSelectedCount", { count: getSelectedTables(layer.id).size }) }}
              </button>
            </div>

            <div v-else class="space-y-1.5" @click.stop>
              <input v-model="createNameByLayerId[layer.id]" class="w-full h-7 text-[11px] bg-background border border-border rounded px-2 outline-none focus:border-primary" :placeholder="t('diagram.tableName')" @keydown.enter="submitCreateDraft(layer.id)" />
              <label class="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <input v-model="createWithIdByLayerId[layer.id]" type="checkbox" />
                {{ t("diagram.withDefaultIdPk") }}
              </label>
              <p v-if="createErrorByLayerId[layer.id]" class="text-[10px] text-destructive">{{ createErrorByLayerId[layer.id] }}</p>
              <button type="button" class="w-full text-xs bg-primary text-primary-foreground py-1 rounded hover:bg-primary/90 transition-colors" @click.stop="submitCreateDraft(layer.id)">
                {{ t("diagram.create") }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

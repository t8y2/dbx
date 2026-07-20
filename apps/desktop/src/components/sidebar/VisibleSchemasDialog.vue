<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CheckSquare, Loader2, Search, Square } from "@lucide/vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import { normalizeVisibleSchemaSelection } from "@/lib/database/visibleDatabases";
import * as api from "@/lib/backend/api";
import { addVisibleSchemas, initialVisibleSchemaSelection, resolveVisibleSchemaSaveAction, selectVisibleSchemas } from "./visibleSchemasDialogState";

const props = defineProps<{
  open: boolean;
  connectionId: string;
  connectionName: string;
  database: string;
  /** Draft mode: parent provides schemas/loading/error externally. Component emits events instead of calling store. */
  draftMode?: boolean;
  draftSchemaNames?: string[];
  draftInitialSelection?: string[];
  draftLoading?: boolean;
  draftError?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "draft:save": [selectedNames: string[]];
  "draft:showAll": [];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();

const schemaNames = shallowRef<string[]>([]);
const selectedNames = shallowRef<Set<string>>(new Set());
const searchText = ref("");
const isLoading = ref(false);
const isSaving = ref(false);
const errorMessage = ref("");

const isDraftMode = computed(() => props.draftMode);
const isLoadingState = computed(() => (isDraftMode.value ? props.draftLoading : isLoading.value));
const errorMessageState = computed(() => (isDraftMode.value ? props.draftError || "" : errorMessage.value));

const filteredSchemaNames = computed(() => {
  const query = searchText.value.trim().toLowerCase();
  const names = isDraftMode.value ? props.draftSchemaNames || [] : schemaNames.value;
  if (!query) return names;
  return names.filter((name) => name.toLowerCase().includes(query));
});
const filteredSchemaItems = computed(() => filteredSchemaNames.value.map((name) => ({ name })));
const selectedCount = computed(() => selectedNames.value.size);
const totalCount = computed(() => {
  const names = isDraftMode.value ? props.draftSchemaNames || [] : schemaNames.value;
  return names.length;
});
const canSaveSelection = computed(() => selectedNames.value.size > 0);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    if (isDraftMode.value) {
      initDraftMode();
    } else {
      loadSchemas().catch(() => {});
    }
  },
  // Tree-level async hosts mount the dialog with `open` already true.
  { immediate: true },
);

function initDraftMode() {
  searchText.value = "";
  const names = props.draftSchemaNames || [];
  // Draft callers historically use an empty array for both absent and all-selected state.
  selectedNames.value = initialVisibleSchemaSelection(names, props.draftInitialSelection, true);
}

async function loadSchemas() {
  isLoading.value = true;
  errorMessage.value = "";
  searchText.value = "";
  try {
    const config = connectionStore.getConfig(props.connectionId);
    const database = props.database || config?.database || "";
    await connectionStore.ensureConnected(props.connectionId);
    const names = await api.listSchemas(props.connectionId, database);
    schemaNames.value = names;
    const configured = config?.visible_schemas?.[database || ""];
    selectedNames.value = initialVisibleSchemaSelection(names, configured);
  } catch (e: any) {
    schemaNames.value = [];
    selectedNames.value = new Set();
    errorMessage.value = String(e?.message || e);
  } finally {
    isLoading.value = false;
  }
}

function toggleSchema(schema: string) {
  const next = new Set(selectedNames.value);
  if (next.has(schema)) next.delete(schema);
  else next.add(schema);
  selectedNames.value = next;
}

const isSearching = computed(() => searchText.value.trim().length > 0);

function selectAll() {
  const names = isDraftMode.value ? props.draftSchemaNames || [] : schemaNames.value;
  selectedNames.value = selectVisibleSchemas(names);
}

function selectFiltered() {
  selectedNames.value = addVisibleSchemas(selectedNames.value, filteredSchemaNames.value);
}

function clearSelection() {
  selectedNames.value = new Set();
}

async function showAllSchemas() {
  if (isSaving.value) return;
  isSaving.value = true;
  if (isDraftMode.value) {
    selectedNames.value = selectVisibleSchemas(props.draftSchemaNames || []);
    emit("draft:showAll");
    emit("update:open", false);
    isSaving.value = false;
    return;
  }
  const config = connectionStore.getConfig(props.connectionId);
  const database = props.database || config?.database || "";
  selectedNames.value = selectVisibleSchemas(schemaNames.value);
  emit("update:open", false);
  try {
    if (config?.visible_schemas?.[database || ""]) {
      // Match DBeaver's filter dialog: close first, then refresh the navigator asynchronously.
      await connectionStore.clearVisibleSchemas(props.connectionId, database);
    }
  } finally {
    isSaving.value = false;
  }
}

async function saveSelection() {
  if (!canSaveSelection.value || isSaving.value) return;
  const names = isDraftMode.value ? props.draftSchemaNames || [] : schemaNames.value;
  const normalized = normalizeVisibleSchemaSelection([...selectedNames.value], names);
  if (isDraftMode.value) {
    emit("draft:save", normalized);
    emit("update:open", false);
    return;
  }
  const config = connectionStore.getConfig(props.connectionId);
  const database = props.database || config?.database || "";
  const action = resolveVisibleSchemaSaveAction(selectedNames.value, names, config?.visible_schemas?.[database || ""]);
  emit("update:open", false);
  if (action.type === "none") return;

  isSaving.value = true;
  try {
    // Persist only real filter changes; the store refreshes the tree after this dialog closes.
    if (action.type === "clear") {
      await connectionStore.clearVisibleSchemas(props.connectionId, database);
    } else {
      await connectionStore.setVisibleSchemas(props.connectionId, database, action.schemaNames);
    }
  } finally {
    isSaving.value = false;
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("visibleSchemas.title") }}</DialogTitle>
        <p class="text-sm text-muted-foreground">
          {{ t("visibleSchemas.description", { connection: connectionName }) }}
        </p>
      </DialogHeader>

      <div class="flex items-center gap-2 rounded-md border bg-background px-2">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input v-model="searchText" :placeholder="t('visibleSchemas.searchPlaceholder')" class="h-8 border-0 px-0 shadow-none focus-visible:ring-0" :disabled="isLoadingState || !!errorMessageState" />
      </div>

      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>{{ t("visibleSchemas.selectedCount", { selected: selectedCount, total: totalCount }) }}</span>
        <div class="flex items-center gap-2">
          <button type="button" class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingState || isSaving" @click="selectAll">
            {{ t("visibleSchemas.selectAll") }}
          </button>
          <button v-if="isSearching" type="button" class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingState || isSaving" @click="selectFiltered">
            {{ t("visibleSchemas.selectFiltered") }}
          </button>
          <button type="button" class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingState || isSaving" @click="clearSelection">
            {{ t("visibleSchemas.clear") }}
          </button>
          <button type="button" class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingState || isSaving" @click="showAllSchemas">
            {{ t("visibleSchemas.showAll") }}
          </button>
        </div>
      </div>
      <p v-if="!isLoadingState && !errorMessageState && !canSaveSelection" class="text-xs text-destructive">
        {{ t("visibleSchemas.emptySelection") }}
      </p>

      <div v-if="isLoadingState || errorMessageState || !filteredSchemaItems.length" class="h-72 overflow-y-auto rounded-md border bg-background/50 p-1">
        <div v-if="isLoadingState" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-else-if="errorMessageState" class="p-3 text-sm text-destructive">
          {{ t("visibleSchemas.loadFailed", { message: errorMessageState }) }}
        </div>
        <div v-else-if="!filteredSchemaNames.length" class="p-3 text-sm text-muted-foreground">
          {{ t("grid.noSearchResults") }}
        </div>
      </div>
      <RecycleScroller v-else v-slot="{ item }" class="h-72 rounded-md border bg-background/50 p-1" :items="filteredSchemaItems" :item-size="32" key-field="name" :buffer="160">
        <button type="button" class="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none" @click="toggleSchema(item.name)">
          <CheckSquare v-if="selectedNames.has(item.name)" class="h-4 w-4 shrink-0 text-primary" />
          <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ item.name }}</span>
        </button>
      </RecycleScroller>

      <DialogFooter>
        <Button type="button" variant="outline" :disabled="isSaving" @click="emit('update:open', false)">{{ t("dangerDialog.cancel") }}</Button>
        <Button type="button" :disabled="isLoadingState || isSaving || !!errorMessageState || !canSaveSelection" @click="saveSelection">
          {{ t("visibleSchemas.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

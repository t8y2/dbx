<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CheckSquare, Loader2, Search, Square } from "@lucide/vue";
import { RecycleScroller } from "vue-virtual-scroller";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { filterSchemaNamesForVisiblePicker, normalizeVisibleSchemaSelection } from "@/lib/database/visibleDatabases";
import type { DatabaseType } from "@/types/database";
import { addVisibleSchemas, initialVisibleSchemaSelection, selectVisibleSchemas } from "./visibleSchemasDialogState";

const props = defineProps<{
  open: boolean;
  connectionName: string;
  databaseType?: DatabaseType;
  username?: string;
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
const selectedNames = shallowRef<Set<string>>(new Set());
const searchText = ref("");
const showSystemSchemas = ref(false);

const isLoadingState = computed(() => props.draftLoading);
const errorMessageState = computed(() => props.draftError || "");
const connection = computed(() => ({ db_type: props.databaseType, username: props.username || "" }));
const allSchemaNames = computed(() => props.draftSchemaNames || []);
const listedSchemaNames = computed(() => (showSystemSchemas.value ? allSchemaNames.value : filterSchemaNamesForVisiblePicker(allSchemaNames.value, connection.value)));
const hasSystemSchemas = computed(() => filterSchemaNamesForVisiblePicker(allSchemaNames.value, connection.value).length < allSchemaNames.value.length);

const filteredSchemaNames = computed(() => {
  const query = searchText.value.trim().toLowerCase();
  const names = listedSchemaNames.value;
  if (!query) return names;
  return names.filter((name) => name.toLowerCase().includes(query));
});
const filteredSchemaItems = computed(() => filteredSchemaNames.value.map((name) => ({ name })));
const selectedCount = computed(() => selectedNames.value.size);
const totalCount = computed(() => {
  return listedSchemaNames.value.length;
});
const canSaveSelection = computed(() => selectedNames.value.size > 0);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    initDraftMode();
  },
  { immediate: true },
);

function initDraftMode() {
  searchText.value = "";
  const names = props.draftSchemaNames || [];
  initializeSelection(names, props.draftInitialSelection);
}

function initializeSelection(names: string[], configured: string[] | undefined) {
  showSystemSchemas.value = false;
  const hasExplicitSelection = !!configured?.length;
  const initial = hasExplicitSelection ? initialVisibleSchemaSelection(names, configured) : selectVisibleSchemas(filterSchemaNamesForVisiblePicker(names, connection.value));
  const defaultVisible = new Set(filterSchemaNamesForVisiblePicker(names, connection.value));
  selectedNames.value = initial;
  showSystemSchemas.value = hasExplicitSelection && [...initial].some((name) => !defaultVisible.has(name));
}

watch(showSystemSchemas, (show) => {
  if (show) return;
  const visible = new Set(listedSchemaNames.value);
  selectedNames.value = new Set([...selectedNames.value].filter((name) => visible.has(name)));
});

function toggleSchema(schema: string) {
  const next = new Set(selectedNames.value);
  if (next.has(schema)) next.delete(schema);
  else next.add(schema);
  selectedNames.value = next;
}

const isSearching = computed(() => searchText.value.trim().length > 0);

function selectAll() {
  selectedNames.value = selectVisibleSchemas(listedSchemaNames.value);
}

function selectFiltered() {
  selectedNames.value = addVisibleSchemas(selectedNames.value, filteredSchemaNames.value);
}

function clearSelection() {
  selectedNames.value = new Set();
}

function showAllSchemas() {
  selectedNames.value = selectVisibleSchemas(props.draftSchemaNames || []);
  emit("draft:showAll");
  emit("update:open", false);
}

function saveSelection() {
  if (!canSaveSelection.value) return;
  const names = listedSchemaNames.value;
  const normalized = normalizeVisibleSchemaSelection([...selectedNames.value], names);
  emit("draft:save", normalized);
  emit("update:open", false);
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
          <button type="button" class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingState" @click="selectAll">
            {{ t("visibleSchemas.selectAll") }}
          </button>
          <button v-if="isSearching" type="button" class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingState" @click="selectFiltered">
            {{ t("visibleSchemas.selectFiltered") }}
          </button>
          <button type="button" class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingState" @click="clearSelection">
            {{ t("visibleSchemas.clear") }}
          </button>
          <button type="button" class="hover:text-foreground disabled:opacity-50" :disabled="isLoadingState" @click="showAllSchemas">
            {{ t("visibleSchemas.showAll") }}
          </button>
        </div>
      </div>
      <p v-if="!isLoadingState && !errorMessageState && !canSaveSelection" class="text-xs text-destructive">
        {{ t("visibleSchemas.emptySelection") }}
      </p>

      <label v-if="hasSystemSchemas" class="flex h-8 items-center gap-2 rounded-md px-1 text-xs text-muted-foreground">
        <input v-model="showSystemSchemas" type="checkbox" class="h-3.5 w-3.5 accent-primary" :disabled="isLoadingState || !!errorMessageState" />
        <span>{{ t("visibleSchemas.showSystemSchemas") }}</span>
      </label>

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
        <Button type="button" variant="outline" @click="emit('update:open', false)">{{ t("dangerDialog.cancel") }}</Button>
        <Button type="button" :disabled="isLoadingState || !!errorMessageState || !canSaveSelection" @click="saveSelection">
          {{ t("visibleSchemas.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isSystemSchemaName } from "@/lib/database/visibleDatabases";
import type { DatabaseType } from "@/types/database";
import { addVisibleSchemas, initialVisibleSchemaSelection, selectVisibleSchemas } from "./visibleSchemasDialogState";
import SchemaSelectionList from "./SchemaSelectionList.vue";

const props = defineProps<{
  open: boolean;
  connectionName: string;
  databaseType?: DatabaseType;
  username?: string;
  draftSchemaNames?: string[];
  draftInitialSelection?: string[];
  systemSchemaNames?: ReadonlySet<string>;
  draftLoading?: boolean;
  draftError?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  "draft:save": [selectedNames: string[]];
}>();

const { t } = useI18n();
const selectedNames = shallowRef<Set<string>>(new Set());
const searchText = ref("");

const isLoadingState = computed(() => props.draftLoading);
const errorMessageState = computed(() => props.draftError || "");
const allSchemaNames = computed(() => props.draftSchemaNames || []);
const listedSchemaNames = allSchemaNames;

const filteredSchemaNames = computed(() => {
  const query = searchText.value.trim().toLowerCase();
  const names = listedSchemaNames.value;
  if (!query) return names;
  return names.filter((name) => name.toLowerCase().includes(query));
});
const selectedCount = computed(() => selectedNames.value.size);
const totalCount = computed(() => {
  return listedSchemaNames.value.length;
});
const canSaveSelection = computed(() => !isLoadingState.value && !errorMessageState.value);

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
  const hasExplicitSelection = Array.isArray(configured);
  const initial = hasExplicitSelection ? initialVisibleSchemaSelection(names, configured) : selectVisibleSchemas(names.filter((name) => !(props.systemSchemaNames?.has(name) ?? isSystemSchemaName(props.databaseType, name))));
  selectedNames.value = initial;
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

function saveSelection() {
  if (!canSaveSelection.value) return;
  const normalized = [...selectedNames.value];
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
        </div>
      </div>
      <div v-if="isLoadingState || errorMessageState" class="h-72 overflow-y-auto rounded-md border bg-background/50 p-1">
        <div v-if="isLoadingState" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-else-if="errorMessageState" class="p-3 text-sm text-destructive">
          {{ t("visibleSchemas.loadFailed", { message: errorMessageState }) }}
        </div>
      </div>
      <SchemaSelectionList v-else v-model="selectedNames" :names="allSchemaNames" :database-type="databaseType" :system-names="systemSchemaNames" :search="searchText" />

      <DialogFooter>
        <Button type="button" variant="outline" @click="emit('update:open', false)">{{ t("dangerDialog.cancel") }}</Button>
        <Button type="button" :disabled="isLoadingState || !!errorMessageState || !canSaveSelection" @click="saveSelection">
          {{ t("visibleSchemas.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

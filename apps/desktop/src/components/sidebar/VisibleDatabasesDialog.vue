<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CheckSquare, Loader2, Search, Square } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import { canSaveVisibleDatabaseSelection, filterDatabaseNamesForConnection, isSystemDatabaseName, normalizeVisibleDatabaseSelection } from "@/lib/visibleDatabases";
import * as api from "@/lib/api";

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

const databaseNames = ref<string[]>([]);
const selectedNames = ref<Set<string>>(new Set());
const searchText = ref("");
const showSystemDatabases = ref(false);
const isLoading = ref(false);
const errorMessage = ref("");

const connection = computed(() => connectionStore.getConfig(props.connectionId));
const listedDatabaseNames = computed(() => {
  if (showSystemDatabases.value) return databaseNames.value;
  return filterDatabaseNamesForConnection(databaseNames.value, connection.value);
});
const filteredDatabaseNames = computed(() => {
  const query = searchText.value.trim().toLowerCase();
  if (!query) return listedDatabaseNames.value;
  return listedDatabaseNames.value.filter((name) => name.toLowerCase().includes(query));
});
const selectedCount = computed(() => selectedNames.value.size);
const totalCount = computed(() => listedDatabaseNames.value.length);
const canSaveSelection = computed(() => canSaveVisibleDatabaseSelection([...selectedNames.value]));
const hasSystemDatabases = computed(() => databaseNames.value.some((database) => isSystemDatabaseName(connection.value?.db_type, database)));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    loadDatabases().catch(() => {});
  },
);

watch(showSystemDatabases, (show) => {
  if (show) return;
  selectedNames.value = new Set([...selectedNames.value].filter((database) => !isSystemDatabaseName(connection.value?.db_type, database)));
});

async function loadDatabases() {
  isLoading.value = true;
  errorMessage.value = "";
  searchText.value = "";
  try {
    const names = await loadDatabaseNames();
    databaseNames.value = names;
    const configured = connection.value?.visible_databases;
    const initialSelection = Array.isArray(configured) ? normalizeVisibleDatabaseSelection(configured, names) : filterDatabaseNamesForConnection(names, connection.value);
    selectedNames.value = new Set(initialSelection);
    showSystemDatabases.value = initialSelection.some((database) => isSystemDatabaseName(connection.value?.db_type, database));
  } catch (e: any) {
    databaseNames.value = [];
    selectedNames.value = new Set();
    showSystemDatabases.value = false;
    errorMessage.value = String(e?.message || e);
  } finally {
    isLoading.value = false;
  }
}

async function loadDatabaseNames(): Promise<string[]> {
  const config = connection.value;
  if (config?.db_type === "oracle" || config?.db_type === "dameng") {
    await connectionStore.ensureConnected(props.connectionId);
    return api.listSchemas(props.connectionId, config.database || "");
  }
  await connectionStore.ensureConnected(props.connectionId);
  if (config?.db_type === "redis") {
    return (await api.redisListDatabases(props.connectionId)).map((database) => String(database.db));
  }
  if (config?.db_type === "mongodb") {
    return api.mongoListDatabases(props.connectionId);
  }
  return (await api.listDatabases(props.connectionId)).map((database) => database.name);
}

function toggleDatabase(database: string) {
  const next = new Set(selectedNames.value);
  if (next.has(database)) next.delete(database);
  else next.add(database);
  selectedNames.value = next;
}

const isSearching = computed(() => searchText.value.trim().length > 0);

function selectAll() {
  selectedNames.value = new Set(listedDatabaseNames.value);
}

function selectFiltered() {
  selectedNames.value = new Set(filteredDatabaseNames.value);
}

function clearSelection() {
  selectedNames.value = new Set();
}

async function showAllDatabases() {
  await connectionStore.clearVisibleDatabases(props.connectionId);
  emit("update:open", false);
}

async function saveSelection() {
  if (!canSaveSelection.value) return;
  await connectionStore.setVisibleDatabases(props.connectionId, [...selectedNames.value]);
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="sm:max-w-[460px]">
      <DialogHeader>
        <DialogTitle>{{ t("visibleDatabases.title") }}</DialogTitle>
        <p class="text-sm text-muted-foreground">
          {{ t("visibleDatabases.description", { connection: connectionName }) }}
        </p>
      </DialogHeader>

      <div class="flex items-center gap-2 rounded-md border bg-background px-2">
        <Search class="h-4 w-4 shrink-0 text-muted-foreground" />
        <Input v-model="searchText" :placeholder="t('visibleDatabases.searchPlaceholder')" class="h-8 border-0 px-0 shadow-none focus-visible:ring-0" :disabled="isLoading || !!errorMessage" />
      </div>

      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>{{ t("visibleDatabases.selectedCount", { selected: selectedCount, total: totalCount }) }}</span>
        <div class="flex items-center gap-2">
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoading" @click="selectAll">
            {{ t("visibleDatabases.selectAll") }}
          </button>
          <button v-if="isSearching" class="hover:text-foreground disabled:opacity-50" :disabled="isLoading" @click="selectFiltered">
            {{ t("visibleDatabases.selectFiltered") }}
          </button>
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoading" @click="clearSelection">
            {{ t("visibleDatabases.clear") }}
          </button>
          <button class="hover:text-foreground disabled:opacity-50" :disabled="isLoading || !Array.isArray(connection?.visible_databases)" @click="showAllDatabases">
            {{ t("visibleDatabases.showAll") }}
          </button>
        </div>
      </div>
      <p v-if="!isLoading && !errorMessage && !canSaveSelection" class="text-xs text-destructive">
        {{ t("visibleDatabases.emptySelection") }}
      </p>

      <label v-if="hasSystemDatabases" class="flex h-8 items-center gap-2 rounded-md px-1 text-xs text-muted-foreground">
        <input v-model="showSystemDatabases" type="checkbox" class="h-3.5 w-3.5 accent-primary" :disabled="isLoading || !!errorMessage" />
        <span>{{ t("visibleDatabases.showSystemDatabases") }}</span>
      </label>

      <div class="h-72 overflow-y-auto rounded-md border bg-background/50 p-1">
        <div v-if="isLoading" class="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t("common.loading") }}
        </div>
        <div v-else-if="errorMessage" class="p-3 text-sm text-destructive">
          {{ t("visibleDatabases.loadFailed", { message: errorMessage }) }}
        </div>
        <div v-else-if="!filteredDatabaseNames.length" class="p-3 text-sm text-muted-foreground">
          {{ t("grid.noSearchResults") }}
        </div>
        <template v-else>
          <button
            v-for="database in filteredDatabaseNames"
            :key="database"
            type="button"
            class="flex h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none"
            @click="toggleDatabase(database)"
          >
            <CheckSquare v-if="selectedNames.has(database)" class="h-4 w-4 shrink-0 text-primary" />
            <Square v-else class="h-4 w-4 shrink-0 text-muted-foreground" />
            <span class="truncate">{{ database }}</span>
          </button>
        </template>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="emit('update:open', false)">{{ t("dangerDialog.cancel") }}</Button>
        <Button :disabled="isLoading || !!errorMessage || !canSaveSelection" @click="saveSelection">
          {{ t("visibleDatabases.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

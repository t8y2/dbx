<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/utils";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SearchableSelect from "@/components/ui/searchable-select/SearchableSelect.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/api";
import type { TransferMode, TransferTableNameCase } from "@/lib/api";
import type { DatabaseType } from "@/types/database";
import { isSchemaAware, supportsTransfer } from "@/lib/databaseCapabilities";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import { useExportTracker } from "@/composables/useExportTracker";
import { ArrowRightLeft, ArrowLeftRight, Loader2, Square, CheckSquare } from "@lucide/vue";

const { t } = useI18n();
const { startDataTransferTask } = useExportTracker();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
}>();

const store = useConnectionStore();

const sqlConnections = computed(() => store.connections.filter((c) => supportsTransfer(c.db_type)));

// Source state
const sourceConnectionId = ref("");
const sourceDatabase = ref("");
const sourceDatabases = ref<string[]>([]);
const sourceSchemas = ref<string[]>([]);
const sourceSchema = ref("");
const sourceTables = ref<string[]>([]);
const selectedTables = ref<Set<string>>(new Set());
const tableSearch = ref("");
const loadingTables = ref(false);

// Target state
const targetConnectionId = ref("");
const targetDatabase = ref("");
const targetDatabases = ref<string[]>([]);
const targetSchemas = ref<string[]>([]);
const targetSchema = ref("");

// Options
const createTable = ref(true);
const transferMode = ref<TransferMode>("append");
const targetTableNameCase = ref<TransferTableNameCase>("preserve");
const batchSize = ref(1000);
const isSubmitting = ref(false);

const filteredTables = computed(() => {
  const q = tableSearch.value.toLowerCase();
  return q ? sourceTables.value.filter((t) => t.toLowerCase().includes(q)) : sourceTables.value;
});

const allSelected = computed(() => filteredTables.value.length > 0 && filteredTables.value.every((t) => selectedTables.value.has(t)));

function connectionType(id: string): DatabaseType | undefined {
  return store.connections.find((c) => c.id === id)?.db_type;
}

function isMongoConnection(id: string): boolean {
  return connectionType(id) === "mongodb";
}

const canStart = computed(() => sourceConnectionId.value && sourceDatabase.value && targetConnectionId.value && targetDatabase.value && selectedTables.value.size > 0 && sourceConnectionId.value + sourceDatabase.value !== targetConnectionId.value + targetDatabase.value);

function toggleSelectAll() {
  if (allSelected.value) {
    filteredTables.value.forEach((t) => selectedTables.value.delete(t));
  } else {
    filteredTables.value.forEach((t) => selectedTables.value.add(t));
  }
}

function toggleTable(table: string) {
  if (selectedTables.value.has(table)) {
    selectedTables.value.delete(table);
  } else {
    selectedTables.value.add(table);
  }
}

async function loadDatabases(connectionId: string, target: "source" | "target") {
  if (!connectionId) return;
  try {
    await store.ensureConnected(connectionId);
    const rawNames = isMongoConnection(connectionId) ? await api.mongoListDatabases(connectionId) : (await api.listDatabases(connectionId)).map((d) => d.name);
    const names = databaseOptionsForConnection(rawNames, store.getConfig(connectionId));
    if (target === "source") {
      sourceDatabases.value = names;
      sourceDatabase.value = names.length === 1 ? names[0] : "";
    } else {
      targetDatabases.value = names;
      targetDatabase.value = names.length === 1 ? names[0] : "";
    }
  } catch {
    if (target === "source") sourceDatabases.value = [];
    else targetDatabases.value = [];
  }
}

async function loadSchemas(connectionId: string, database: string, side: "source" | "target", preferredSchema = "") {
  if (!connectionId || !database) return;
  if (isMongoConnection(connectionId)) {
    if (side === "source") {
      sourceSchemas.value = [];
      sourceSchema.value = database;
    } else {
      targetSchemas.value = [];
      targetSchema.value = database;
    }
    return;
  }
  try {
    const schemas = await api.listSchemas(connectionId, database);
    const selected = preferredSchema && schemas.includes(preferredSchema) ? preferredSchema : schemas.includes("public") ? "public" : (schemas[0] ?? "");
    if (side === "source") {
      sourceSchemas.value = schemas;
      sourceSchema.value = selected;
    } else {
      targetSchemas.value = schemas;
      targetSchema.value = selected;
    }
  } catch {
    if (side === "source") {
      sourceSchemas.value = [];
      sourceSchema.value = "";
    } else {
      targetSchemas.value = [];
      targetSchema.value = "";
    }
  }
}

async function loadTables() {
  if (!sourceConnectionId.value || !sourceDatabase.value) {
    sourceTables.value = [];
    return;
  }
  loadingTables.value = true;
  try {
    if (isMongoConnection(sourceConnectionId.value)) {
      sourceTables.value = (await api.mongoListCollections(sourceConnectionId.value, sourceDatabase.value)).map((c) => c.name);
      selectedTables.value = new Set(sourceTables.value);
      return;
    }
    const config = store.getConfig(sourceConnectionId.value);
    const needsSchema = isSchemaAware(config?.db_type);
    const schema = needsSchema && sourceSchema.value ? sourceSchema.value : sourceDatabase.value;
    const tables = await api.listTables(sourceConnectionId.value, sourceDatabase.value, schema);
    sourceTables.value = tables.filter((t) => t.table_type === "TABLE" || t.table_type === "BASE TABLE").map((t) => t.name);
    selectedTables.value = new Set(sourceTables.value);
  } catch {
    sourceTables.value = [];
  } finally {
    loadingTables.value = false;
  }
}

const skipSourceWatch = ref(false);

watch(sourceConnectionId, (id) => {
  if (skipSourceWatch.value) {
    skipSourceWatch.value = false;
    return;
  }
  sourceDatabase.value = "";
  sourceTables.value = [];
  selectedTables.value.clear();
  loadDatabases(id, "source");
});

watch(sourceDatabase, async (db) => {
  if (db) {
    const config = store.getConfig(sourceConnectionId.value);
    if (isSchemaAware(config?.db_type)) {
      await loadSchemas(sourceConnectionId.value, db, "source");
    } else {
      sourceSchema.value = db;
    }
  }
});

watch(sourceSchema, () => loadTables());

watch(targetConnectionId, (id) => {
  targetDatabase.value = "";
  targetSchemas.value = [];
  targetSchema.value = "";
  loadDatabases(id, "target");
});

watch(targetDatabase, async (db) => {
  if (db) {
    const config = store.getConfig(targetConnectionId.value);
    if (isSchemaAware(config?.db_type)) {
      await loadSchemas(targetConnectionId.value, db, "target");
    } else {
      targetSchema.value = db;
    }
  }
});

watch(
  open,
  async (val) => {
    if (val) {
      resetState();
      if (props.prefillConnectionId) {
        skipSourceWatch.value = true;
        sourceConnectionId.value = props.prefillConnectionId;
        await loadDatabases(props.prefillConnectionId, "source");
        if (props.prefillDatabase) {
          sourceDatabase.value = props.prefillDatabase;
        }
      }
    }
  },
  { immediate: true },
);

function resetState() {
  sourceConnectionId.value = "";
  sourceDatabase.value = "";
  sourceDatabases.value = [];
  sourceSchemas.value = [];
  sourceSchema.value = "";
  sourceTables.value = [];
  selectedTables.value.clear();
  tableSearch.value = "";
  targetConnectionId.value = "";
  targetDatabase.value = "";
  targetDatabases.value = [];
  targetSchemas.value = [];
  targetSchema.value = "";
  createTable.value = true;
  transferMode.value = "append";
  targetTableNameCase.value = "preserve";
  batchSize.value = 1000;
  isSubmitting.value = false;
}

async function startTransfer() {
  if (!canStart.value || isSubmitting.value) return;
  isSubmitting.value = true;

  const effectiveSourceSchema = sourceSchema.value || sourceDatabase.value;
  const effectiveTargetSchema = targetSchema.value || targetDatabase.value;
  const sourceDatabaseName = sourceDatabase.value;
  const targetConnection = targetConnectionId.value;
  const targetDatabaseName = targetDatabase.value;
  const shouldRefreshTargetTree = createTable.value;

  const request: api.TransferRequest = {
    transferId: uuid(),
    sourceConnectionId: sourceConnectionId.value,
    sourceDatabase: sourceDatabaseName,
    sourceSchema: effectiveSourceSchema,
    targetConnectionId: targetConnection,
    targetDatabase: targetDatabaseName,
    targetSchema: effectiveTargetSchema,
    tables: [...selectedTables.value],
    createTable: createTable.value,
    mode: transferMode.value,
    targetTableNameCase: targetTableNameCase.value,
    batchSize: batchSize.value,
  };

  startDataTransferTask(request, `${sourceDatabaseName} → ${targetDatabaseName}`, {
    formatOverlapError: (tables) => t("transfer.targetTableBusy", { tables: tables.join(", ") }),
    onDone: async () => {
      if (shouldRefreshTargetTree) {
        await store.refreshObjectListTreeNode(targetConnection, targetDatabaseName, effectiveTargetSchema);
      }
    },
  });
  open.value = false;
  resetState();
}

function getConnectionName(id: string) {
  return store.connections.find((c) => c.id === id)?.name ?? id;
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[780px] max-h-[80vh] flex flex-col overflow-hidden" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <ArrowRightLeft class="w-4 h-4" />
          {{ t("transfer.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-auto">
        <div class="grid gap-4 py-3">
          <!-- Source / Target Side by Side -->
          <div class="grid grid-cols-[1fr_auto_1fr] gap-4 items-start">
            <!-- Source Section -->
            <div class="space-y-3">
              <div class="text-sm font-medium text-blue-500">
                {{ t("transfer.source") }}
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.sourceConnection") }}</Label>
                <SearchableSelect
                  v-model="sourceConnectionId"
                  :options="sqlConnections.map((c) => c.id)"
                  :placeholder="t('transfer.selectConnection')"
                  :search-placeholder="t('transfer.searchConnection')"
                  :empty-text="t('common.noResults')"
                  :display-name="getConnectionName"
                  trigger-variant="outline"
                  trigger-class="h-8 w-full justify-between text-xs"
                  content-class="w-[var(--reka-popover-trigger-width)]"
                >
                  <template #option-label="{ option, label }">
                    <div class="flex items-center gap-1.5">
                      <DatabaseIcon :db-type="sqlConnections.find((c) => c.id === option)?.db_type ?? 'mysql'" class="w-3.5 h-3.5" />
                      {{ label }}
                    </div>
                  </template>
                </SearchableSelect>
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.sourceDatabase") }}</Label>
                <SearchableSelect
                  v-model="sourceDatabase"
                  :options="sourceDatabases"
                  :placeholder="t('transfer.selectDatabase')"
                  :search-placeholder="t('transfer.searchDatabase')"
                  :empty-text="t('common.noResults')"
                  :disabled="!sourceDatabases.length"
                  trigger-variant="outline"
                  trigger-class="h-8 w-full justify-between text-xs"
                  content-class="w-[var(--reka-popover-trigger-width)]"
                />
              </div>

              <div v-if="sourceSchemas.length" class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.sourceSchema") }}</Label>
                <SearchableSelect
                  v-model="sourceSchema"
                  :options="sourceSchemas"
                  :placeholder="t('transfer.selectSchema')"
                  :search-placeholder="t('transfer.searchSchema')"
                  :empty-text="t('common.noResults')"
                  trigger-variant="outline"
                  trigger-class="h-8 w-full justify-between text-xs"
                  content-class="w-[var(--reka-popover-trigger-width)]"
                />
              </div>
            </div>

            <!-- Arrow -->
            <div class="flex items-center pt-8">
              <ArrowLeftRight class="w-5 h-5 text-muted-foreground" />
            </div>

            <!-- Target Section -->
            <div class="space-y-3">
              <div class="text-sm font-medium text-green-500">
                {{ t("transfer.target") }}
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.targetConnection") }}</Label>
                <SearchableSelect
                  v-model="targetConnectionId"
                  :options="sqlConnections.map((c) => c.id)"
                  :placeholder="t('transfer.selectConnection')"
                  :search-placeholder="t('transfer.searchConnection')"
                  :empty-text="t('common.noResults')"
                  :display-name="getConnectionName"
                  trigger-variant="outline"
                  trigger-class="h-8 w-full justify-between text-xs"
                  content-class="w-[var(--reka-popover-trigger-width)]"
                >
                  <template #option-label="{ option, label }">
                    <div class="flex items-center gap-1.5">
                      <DatabaseIcon :db-type="sqlConnections.find((c) => c.id === option)?.db_type ?? 'mysql'" class="w-3.5 h-3.5" />
                      {{ label }}
                    </div>
                  </template>
                </SearchableSelect>
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.targetDatabase") }}</Label>
                <SearchableSelect
                  v-model="targetDatabase"
                  :options="targetDatabases"
                  :placeholder="t('transfer.selectDatabase')"
                  :search-placeholder="t('transfer.searchDatabase')"
                  :empty-text="t('common.noResults')"
                  :disabled="!targetDatabases.length"
                  trigger-variant="outline"
                  trigger-class="h-8 w-full justify-between text-xs"
                  content-class="w-[var(--reka-popover-trigger-width)]"
                />
              </div>

              <div v-if="targetSchemas.length" class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.targetSchema") }}</Label>
                <SearchableSelect
                  v-model="targetSchema"
                  :options="targetSchemas"
                  :placeholder="t('transfer.selectSchema')"
                  :search-placeholder="t('transfer.searchSchema')"
                  :empty-text="t('common.noResults')"
                  trigger-variant="outline"
                  trigger-class="h-8 w-full justify-between text-xs"
                  content-class="w-[var(--reka-popover-trigger-width)]"
                />
              </div>
            </div>
          </div>

          <!-- Tables Section -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {{ t("transfer.tables") }}
                <span v-if="sourceTables.length" class="text-muted-foreground/60">({{ selectedTables.size }}/{{ sourceTables.length }})</span>
              </div>
              <Button v-if="sourceTables.length" variant="ghost" size="sm" class="h-6 text-xs px-2" @click="toggleSelectAll">
                {{ allSelected ? t("transfer.deselectAll") : t("transfer.selectAll") }}
              </Button>
            </div>

            <Input v-if="sourceTables.length > 5" v-model="tableSearch" :placeholder="t('transfer.searchTables')" class="h-7 text-xs" />

            <div v-if="loadingTables" class="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <Loader2 class="w-3.5 h-3.5 animate-spin" />
              {{ t("common.loading") }}
            </div>
            <div v-else-if="!sourceConnectionId || !sourceDatabase" class="text-xs text-muted-foreground py-4 text-center">
              {{ t("transfer.selectSourceFirst") }}
            </div>
            <div v-else-if="sourceTables.length === 0" class="text-xs text-muted-foreground py-4 text-center">
              {{ t("transfer.noTables") }}
            </div>
            <div v-else class="border rounded-md max-h-[200px] overflow-y-auto">
              <div v-for="table in filteredTables" :key="table" class="flex items-center gap-2 px-2.5 py-1.5 hover:bg-muted/50 cursor-pointer text-xs" @click="toggleTable(table)">
                <CheckSquare v-if="selectedTables.has(table)" class="w-3.5 h-3.5 text-primary shrink-0" />
                <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                <span class="truncate">{{ table }}</span>
              </div>
            </div>
          </div>

          <!-- Options -->
          <div class="space-y-2.5">
            <div class="flex items-center gap-2 cursor-pointer text-xs" @click="createTable = !createTable">
              <CheckSquare v-if="createTable" class="w-3.5 h-3.5 text-primary shrink-0" />
              <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
              {{ t("transfer.createTable") }}
            </div>
            <div class="flex items-center gap-3">
              <Label class="text-xs shrink-0">{{ t("transfer.transferMode") }}</Label>
              <Select v-model="transferMode">
                <SelectTrigger class="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="append">{{ t("transfer.modeAppend") }}</SelectItem>
                  <SelectItem value="overwrite">{{ t("transfer.modeOverwrite") }}</SelectItem>
                  <SelectItem value="upsert">{{ t("transfer.modeUpsert") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex items-center gap-3">
              <Label class="text-xs shrink-0">{{ t("transfer.targetTableNameCase") }}</Label>
              <Select v-model="targetTableNameCase">
                <SelectTrigger class="h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="preserve">{{ t("transfer.tableNameCasePreserve") }}</SelectItem>
                  <SelectItem value="lower">{{ t("transfer.tableNameCaseLower") }}</SelectItem>
                  <SelectItem value="upper">{{ t("transfer.tableNameCaseUpper") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex items-center gap-3">
              <Label class="text-xs shrink-0">{{ t("transfer.batchSize") }}</Label>
              <Input v-model.number="batchSize" type="number" min="100" max="10000" step="100" class="h-7 text-xs w-24" />
            </div>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="open = false">
          {{ t("transfer.cancel") }}
        </Button>
        <Button size="sm" :disabled="!canStart || isSubmitting" @click="startTransfer">
          <Loader2 v-if="isSubmitting" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
          <ArrowRightLeft v-else class="w-3.5 h-3.5 mr-1.5" />
          {{ t("transfer.start") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

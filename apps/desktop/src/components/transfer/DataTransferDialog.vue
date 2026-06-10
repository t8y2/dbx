<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/utils";
import { useI18n } from "vue-i18n";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/api";
import type { TransferProgress, TransferMode } from "@/lib/api";
import type { DatabaseType } from "@/types/database";
import { isSchemaAware, supportsTransfer } from "@/lib/databaseCapabilities";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import { nextTransferTerminalState } from "@/lib/transferProgressState";
import { ArrowRightLeft, Check, X, Loader2, Square, CheckSquare } from "@lucide/vue";

const { t } = useI18n();
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
const batchSize = ref(1000);

// Transfer state
const isTransferring = ref(false);
const transferProgress = ref<Map<string, TransferProgress>>(new Map());
const currentTable = ref("");
const overallDone = ref(false);
const overallError = ref(false);
const overallCancelled = ref(false);
const transferId = ref("");

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
      sourceTables.value = await api.mongoListCollections(sourceConnectionId.value, sourceDatabase.value);
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
  batchSize.value = 1000;
  isTransferring.value = false;
  transferProgress.value.clear();
  currentTable.value = "";
  overallDone.value = false;
  overallError.value = false;
  overallCancelled.value = false;
}

async function startTransfer() {
  isTransferring.value = true;
  overallDone.value = false;
  overallError.value = false;
  overallCancelled.value = false;
  transferProgress.value.clear();

  transferId.value = uuid();

  const effectiveSourceSchema = sourceSchema.value || sourceDatabase.value;
  const effectiveTargetSchema = targetSchema.value || targetDatabase.value;

  const request: api.TransferRequest = {
    transferId: transferId.value,
    sourceConnectionId: sourceConnectionId.value,
    sourceDatabase: sourceDatabase.value,
    sourceSchema: effectiveSourceSchema,
    targetConnectionId: targetConnectionId.value,
    targetDatabase: targetDatabase.value,
    targetSchema: effectiveTargetSchema,
    tables: [...selectedTables.value],
    createTable: createTable.value,
    mode: transferMode.value,
    batchSize: batchSize.value,
  };

  try {
    await api.startTransfer(request, (progress) => {
      if (progress.table) {
        transferProgress.value.set(progress.table, progress);
        transferProgress.value = new Map(transferProgress.value);
        currentTable.value = progress.table;
      }

      const nextState = nextTransferTerminalState(
        {
          done: overallDone.value,
          cancelled: overallCancelled.value,
          error: overallError.value,
        },
        progress,
      );
      overallDone.value = nextState.done;
      overallCancelled.value = nextState.cancelled;
      overallError.value = nextState.error;
    });
    if (createTable.value && !overallError.value && !overallCancelled.value) {
      await store.refreshObjectListTreeNode(targetConnectionId.value, targetDatabase.value, targetSchema.value);
    }
  } catch (e: any) {
    overallError.value = true;
  }
}

async function cancelTransfer() {
  if (transferId.value) {
    await api.cancelTransfer(transferId.value);
  }
}

function getConnectionName(id: string) {
  return store.connections.find((c) => c.id === id)?.name ?? id;
}

function getConnectionType(id: string): DatabaseType {
  return store.connections.find((c) => c.id === id)?.db_type ?? "mysql";
}

const processedStatuses = new Set<TransferProgress["status"]>(["tableDone", "done", "error", "cancelled"]);

function formatRowCount(count: number) {
  return count.toLocaleString();
}

function formatTableRows(progress: TransferProgress) {
  if (typeof progress.totalRows === "number") {
    return `${formatRowCount(progress.rowsTransferred)} / ${formatRowCount(progress.totalRows)}`;
  }
  return formatRowCount(progress.rowsTransferred);
}

const completedTables = computed(() => [...transferProgress.value.values()].filter((p) => processedStatuses.has(p.status)).length);

const failedTables = computed(() => [...transferProgress.value.values()].filter((p) => p.status === "error").length);

const totalTransferred = computed(() => [...transferProgress.value.values()].reduce((sum, p) => sum + p.rowsTransferred, 0));

const knownTotalRows = computed(() => [...transferProgress.value.values()].reduce((sum, p) => sum + (typeof p.totalRows === "number" ? p.totalRows : 0), 0));

const overallRowsLabel = computed(() => (knownTotalRows.value > 0 ? `${formatRowCount(totalTransferred.value)} / ${formatRowCount(knownTotalRows.value)}` : formatRowCount(totalTransferred.value)));
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[560px] max-h-[80vh] flex flex-col overflow-hidden" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <ArrowRightLeft class="w-4 h-4" />
          {{ t("transfer.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-auto">
        <!-- Config View -->
        <div v-if="!isTransferring" class="grid gap-4 py-3">
          <!-- Source Section -->
          <div class="space-y-3">
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {{ t("transfer.source") }}
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.sourceConnection") }}</Label>
                <Select v-model="sourceConnectionId">
                  <SelectTrigger class="h-8 text-xs">
                    <div v-if="sourceConnectionId" class="flex items-center gap-1.5">
                      <DatabaseIcon :db-type="getConnectionType(sourceConnectionId)" class="w-3.5 h-3.5" />
                      <span class="truncate">{{ getConnectionName(sourceConnectionId) }}</span>
                    </div>
                    <SelectValue v-else />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="c in sqlConnections" :key="c.id" :value="c.id">
                      <div class="flex items-center gap-1.5">
                        <DatabaseIcon :db-type="c.db_type" class="w-3.5 h-3.5" />
                        {{ c.name }}
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.sourceDatabase") }}</Label>
                <Select v-model="sourceDatabase" :disabled="!sourceDatabases.length">
                  <SelectTrigger class="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="db in sourceDatabases" :key="db" :value="db">{{ db }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div v-if="sourceSchemas.length" class="space-y-1.5">
              <Label class="text-xs">{{ t("transfer.sourceSchema") }}</Label>
              <Select v-model="sourceSchema">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="schema in sourceSchemas" :key="schema" :value="schema">{{ schema }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <!-- Target Section -->
          <div class="space-y-3">
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {{ t("transfer.target") }}
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.targetConnection") }}</Label>
                <Select v-model="targetConnectionId">
                  <SelectTrigger class="h-8 text-xs">
                    <div v-if="targetConnectionId" class="flex items-center gap-1.5">
                      <DatabaseIcon :db-type="getConnectionType(targetConnectionId)" class="w-3.5 h-3.5" />
                      <span class="truncate">{{ getConnectionName(targetConnectionId) }}</span>
                    </div>
                    <SelectValue v-else />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="c in sqlConnections" :key="c.id" :value="c.id">
                      <div class="flex items-center gap-1.5">
                        <DatabaseIcon :db-type="c.db_type" class="w-3.5 h-3.5" />
                        {{ c.name }}
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div class="space-y-1.5">
                <Label class="text-xs">{{ t("transfer.targetDatabase") }}</Label>
                <Select v-model="targetDatabase" :disabled="!targetDatabases.length">
                  <SelectTrigger class="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="db in targetDatabases" :key="db" :value="db">{{ db }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div v-if="targetSchemas.length" class="space-y-1.5">
              <Label class="text-xs">{{ t("transfer.targetSchema") }}</Label>
              <Select v-model="targetSchema">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="schema in targetSchemas" :key="schema" :value="schema">{{ schema }}</SelectItem>
                </SelectContent>
              </Select>
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
              <Label class="text-xs shrink-0">{{ t("transfer.batchSize") }}</Label>
              <Input v-model.number="batchSize" type="number" min="100" max="10000" step="100" class="h-7 text-xs w-24" />
            </div>
          </div>
        </div>

        <!-- Progress View -->
        <div v-else class="py-3 space-y-3">
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {{ t("transfer.overallProgress") }}: {{ completedTables }} / {{ selectedTables.size }} {{ t("transfer.tables").toLowerCase() }} · {{ overallRowsLabel }}
              {{ t("grid.rows", { count: "" }).trim() }}
            </span>
            <span v-if="overallDone && !failedTables" class="text-green-600 font-medium">{{ t("transfer.completed") }}</span>
            <span v-else-if="overallDone && failedTables" class="text-amber-600 font-medium">
              {{ t("transfer.completedWithErrors", { count: failedTables }) }}
            </span>
            <span v-else-if="overallCancelled" class="text-yellow-600 font-medium">{{ t("transfer.cancelled") }}</span>
            <span v-else-if="overallError" class="text-destructive font-medium">{{ t("transfer.failed") }}</span>
          </div>

          <div class="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div
              class="h-full rounded-full transition-[width] duration-300"
              :class="overallError ? 'bg-destructive' : overallCancelled ? 'bg-yellow-500' : overallDone && failedTables ? 'bg-amber-500' : 'bg-primary'"
              :style="{
                width: `${selectedTables.size ? (completedTables / selectedTables.size) * 100 : 0}%`,
              }"
            />
          </div>

          <div class="border rounded-md max-h-[280px] overflow-y-auto">
            <div v-for="table in [...selectedTables]" :key="table" class="flex items-center justify-between px-2.5 py-1.5 text-xs border-b last:border-b-0">
              <span class="truncate">{{ table }}</span>
              <div class="flex items-center gap-1.5 shrink-0 text-muted-foreground">
                <template v-if="transferProgress.get(table)">
                  <template v-if="transferProgress.get(table)!.status === 'running'">
                    <Loader2 class="w-3 h-3 animate-spin text-primary" />
                    <span>{{ formatTableRows(transferProgress.get(table)!) }}</span>
                  </template>
                  <template v-else-if="transferProgress.get(table)!.status === 'tableDone' || transferProgress.get(table)!.status === 'done'">
                    <Check class="w-3 h-3 text-green-500" />
                    <span>{{ formatTableRows(transferProgress.get(table)!) }}</span>
                  </template>
                  <template v-else-if="transferProgress.get(table)!.status === 'error'">
                    <X class="w-3 h-3 text-destructive" />
                    <span>{{ formatTableRows(transferProgress.get(table)!) }}</span>
                    <span class="max-w-[520px] whitespace-normal break-words text-destructive" :title="transferProgress.get(table)!.error ?? ''">
                      {{ transferProgress.get(table)!.error }}
                    </span>
                  </template>
                  <template v-else-if="transferProgress.get(table)!.status === 'cancelled'">
                    <X class="w-3 h-3 text-yellow-500" />
                    <span>{{ t("transfer.cancelled") }}</span>
                  </template>
                </template>
                <span v-else class="text-muted-foreground/40">—</span>
              </div>
            </div>
          </div>

          <!-- Status message -->
        </div>
      </div>

      <DialogFooter>
        <template v-if="!isTransferring">
          <Button variant="outline" size="sm" @click="open = false">
            {{ t("transfer.cancel") }}
          </Button>
          <Button size="sm" :disabled="!canStart" @click="startTransfer">
            <ArrowRightLeft class="w-3.5 h-3.5 mr-1.5" />
            {{ t("transfer.start") }}
          </Button>
        </template>
        <template v-else-if="overallDone || overallCancelled || overallError">
          <Button size="sm" @click="open = false">
            {{ t("common.close") }}
          </Button>
        </template>
        <template v-else>
          <Button variant="destructive" size="sm" @click="cancelTransfer">
            {{ t("transfer.cancel") }}
          </Button>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

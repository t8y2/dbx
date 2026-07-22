<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Dialog, DialogHeader, DialogTitle, DialogFooter, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionGroupBadge from "@/components/connection/ConnectionGroupBadge.vue";
import * as api from "@/lib/backend/api";
import type { ExportProgress } from "@/lib/backend/api";
import { isSchemaAware } from "@/lib/database/databaseFeatureSupport";
import { databaseOptionsForConnection } from "@/composables/useDatabaseOptions";
import { buildAllDatabaseExportPlan, generateDatabaseExportId, runDatabaseExportUntilTerminal, type AllDatabaseExportPlanItem } from "@/lib/export/databaseExport";
import { buildSelectedTablesPayload } from "@/lib/export/databaseExportSelection";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { useToast } from "@/composables/useToast";
import { Input } from "@/components/ui/input";
import { Download, Square, CheckSquare, Search, X } from "@lucide/vue";
import { useExportTracker } from "@/composables/useExportTracker";

const { t } = useI18n();
const { toast } = useToast();
const { addDatabaseExportTask, updateDatabaseExportTask } = useExportTracker();
const open = defineModel<boolean>("open", { default: false });
const store = useConnectionStore();

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
  prefillTables?: string[];
  prefillAllDatabases?: boolean;
}>();

// Connection / Database / Schema selectors
const connectionId = ref("");
const database = ref("");
const databases = ref<string[]>([]);
const selectedDatabases = ref<string[]>([]);
const databaseFilter = ref("");
const schema = ref("");
const schemas = ref<string[]>([]);
const loadingMeta = ref(false);
const tables = ref<string[]>([]);
const selectedTables = ref<string[]>([]);
const loadingTables = ref(false);
const tableFilter = ref("");
const filteredTables = computed(() => {
  const q = tableFilter.value.trim().toLowerCase();
  if (!q) return tables.value;
  return tables.value.filter((name) => name.toLowerCase().includes(q));
});
const tableError = ref<string | null>(null);

// Options
const includeStructure = ref(true);
const includeData = ref(true);
const includeObjects = ref(true);
const dropTableIfExists = ref(false);
const omitAutoIncrement = ref(false);
// `AUTO_INCREMENT` stripping is a MySQL-only DDL transform (backend gates on
// db_type == mysql, which also covers MariaDB / TiDB / OceanBase-MySQL-mode).
const isMysqlFamily = computed(() => store.getConfig(connectionId.value)?.db_type === "mysql");

// Export state
const isExporting = ref(false);
const exportProgress = ref<ExportProgress | null>(null);
const exportId = ref("");
const exportDone = ref(false);
const exportError = ref<string | null>(null);
const exportCancelled = ref(false);
const pendingPrefillTable = ref("");
const pendingPrefillTables = ref<string[]>([]);
const exportAllDatabases = ref(false);
const batchDatabaseIndex = ref(0);
const batchDatabaseTotal = ref(0);
const activeDatabaseExportId = ref("");

const sqlConnections = computed(() => store.connections.filter((c) => !["redis", "mongodb", "elasticsearch", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "mq", "nacos"].includes(c.db_type)));

const canExport = computed(() => {
  const hasContent = includeStructure.value || includeData.value || includeObjects.value;
  if (!connectionId.value || !hasContent || isExporting.value) return false;
  if (exportAllDatabases.value) return selectedDatabases.value.length > 0 && !loadingMeta.value;
  return database.value && schema.value && !loadingTables.value && !tableError.value && (tables.value.length === 0 || selectedTables.value.length > 0);
});

const selectedTableSet = computed(() => new Set(selectedTables.value));
const selectedDatabaseSet = computed(() => new Set(selectedDatabases.value));
const filteredDatabases = computed(() => {
  const q = databaseFilter.value.trim().toLowerCase();
  if (!q) return databases.value;
  return databases.value.filter((name) => name.toLowerCase().includes(q));
});

function connectionIconType(connId: string) {
  const config = store.getConfig(connId);
  return config?.driver_profile || config?.db_type || "mysql";
}

function sanitizeFileName(value: string): string {
  return (value || "database").replace(/[\\/:*?"<>|]+/g, "_").trim() || "database";
}

function joinExportPath(directory: string, fileName: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

function currentRowsExported(): number {
  const progress: ExportProgress | null = exportProgress.value;
  return progress?.rowsExported ?? 0;
}

async function loadDatabases(connId: string) {
  if (!connId) return;
  loadingMeta.value = true;
  try {
    await store.ensureConnected(connId);
    const dbs = await api.listDatabases(connId);
    const names = databaseOptionsForConnection(
      dbs.map((d) => d.name),
      store.getConfig(connId),
    );
    databases.value = names;
    database.value = names.length === 1 ? names[0] : "";
    selectedDatabases.value = exportAllDatabases.value ? [...names] : [];
    schemas.value = [];
    schema.value = "";
    tables.value = [];
    selectedTables.value = [];
  } catch {
    databases.value = [];
  } finally {
    loadingMeta.value = false;
  }
}

async function loadSchemas(preferredSchema = "") {
  if (!connectionId.value || !database.value) return;
  const config = store.getConfig(connectionId.value);
  if (!isSchemaAware(config?.db_type)) {
    schemas.value = [];
    schema.value = database.value;
    return;
  }

  const schemaList = await api.listSchemas(connectionId.value, database.value);
  const selected = preferredSchema && schemaList.includes(preferredSchema) ? preferredSchema : schemaList.includes("public") ? "public" : (schemaList[0] ?? "");
  schemas.value = schemaList;
  schema.value = selected;
}

async function loadTables(preferredTable = "", preferredTables: string[] = []) {
  if (!connectionId.value || !database.value || !schema.value) return;
  loadingTables.value = true;
  tableError.value = null;
  tables.value = [];
  selectedTables.value = [];
  try {
    const tableInfos = await api.listTables(connectionId.value, database.value, schema.value);
    const names = tableInfos.map((table) => table.name);
    tables.value = names;
    const preferredSet = new Set(preferredTables.filter((name) => names.includes(name)));
    selectedTables.value = preferredSet.size > 0 ? names.filter((name) => preferredSet.has(name)) : preferredTable && names.includes(preferredTable) ? [preferredTable] : [...names];
  } catch (e: any) {
    tableError.value = e?.message || String(e);
  } finally {
    loadingTables.value = false;
  }
}

function toggleTable(table: string) {
  const selected = new Set(selectedTables.value);
  if (selected.has(table)) {
    selected.delete(table);
  } else {
    selected.add(table);
  }
  selectedTables.value = tables.value.filter((name) => selected.has(name));
}

function selectAllTables() {
  const selected = new Set(selectedTables.value);
  for (const name of filteredTables.value) selected.add(name);
  selectedTables.value = tables.value.filter((name) => selected.has(name));
}

function clearSelectedTables() {
  const removing = new Set(filteredTables.value);
  selectedTables.value = selectedTables.value.filter((name) => !removing.has(name));
}

function toggleDatabase(db: string) {
  const selected = new Set(selectedDatabases.value);
  if (selected.has(db)) {
    selected.delete(db);
  } else {
    selected.add(db);
  }
  selectedDatabases.value = databases.value.filter((name) => selected.has(name));
}

function selectAllDatabases() {
  const selected = new Set(selectedDatabases.value);
  for (const name of filteredDatabases.value) selected.add(name);
  selectedDatabases.value = databases.value.filter((name) => selected.has(name));
}

function clearSelectedDatabases() {
  const removing = new Set(filteredDatabases.value);
  selectedDatabases.value = selectedDatabases.value.filter((name) => !removing.has(name));
}

async function buildExportPlanForDatabases(dbs: string[]): Promise<AllDatabaseExportPlanItem[]> {
  const config = store.getConfig(connectionId.value);
  const schemaAware = isSchemaAware(config?.db_type);
  const schemasByDatabase: Record<string, string[]> = {};
  if (schemaAware) {
    for (const db of dbs) {
      schemasByDatabase[db] = await api.listSchemas(connectionId.value, db);
    }
  }
  return buildAllDatabaseExportPlan({ databases: dbs, schemaAware, schemasByDatabase });
}

async function startExport() {
  if (!canExport.value) return;
  if (exportAllDatabases.value) {
    await startAllDatabasesExport();
    return;
  }
  isExporting.value = true;
  exportDone.value = false;
  exportError.value = null;
  exportCancelled.value = false;
  exportProgress.value = null;

  exportId.value = generateDatabaseExportId();

  let filePath = "";

  if (isTauriRuntime()) {
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const safeName = sanitizeFileName(database.value || "database");
      const path = await save({
        defaultPath: `${safeName}.sql`,
        filters: [{ name: "SQL", extensions: ["sql"] }],
      });
      if (!path) {
        isExporting.value = false;
        return;
      }
      filePath = path;
    } catch (e: any) {
      isExporting.value = false;
      toast(e?.message || String(e), 5000);
      return;
    }
  } else {
    // Web mode: use a temp path; the server will handle the file
    filePath = `__web_export_${exportId.value}.sql`;
  }

  const request: api.DatabaseExportRequest = {
    exportId: exportId.value,
    connectionId: connectionId.value,
    database: database.value,
    schema: schema.value,
    filePath,
    selectedTables: buildSelectedTablesPayload(tables.value, selectedTables.value),
    includeStructure: includeStructure.value,
    includeData: includeData.value,
    includeObjects: includeObjects.value,
    dropTableIfExists: dropTableIfExists.value,
    omitAutoIncrement: omitAutoIncrement.value,
    batchSize: 1000,
  };

  addDatabaseExportTask(exportId.value, database.value || "database", filePath);

  try {
    await api.exportDatabaseSql(request, (progress) => {
      exportProgress.value = { ...progress };
      updateDatabaseExportTask(progress.exportId, progress);
      if (progress.status === "Done") {
        exportDone.value = true;
        isExporting.value = false;
        toast(t("databaseExport.exportSuccess"), 3000);
      } else if (progress.status === "Error") {
        exportError.value = progress.error;
        isExporting.value = false;
      } else if (progress.status === "Cancelled") {
        exportCancelled.value = true;
        isExporting.value = false;
      }
    });
  } catch (e: any) {
    exportError.value = e?.message || String(e);
    const lastProgress = exportProgress.value as api.ExportProgress | null;
    const fallbackProgress: api.ExportProgress = {
      exportId: exportId.value,
      currentObject: database.value || "database",
      objectIndex: lastProgress?.objectIndex ?? 0,
      totalObjects: lastProgress?.totalObjects ?? 0,
      rowsExported: lastProgress?.rowsExported ?? 0,
      totalRows: lastProgress?.totalRows ?? null,
      status: "Error",
      error: exportError.value,
    };
    updateDatabaseExportTask(exportId.value, fallbackProgress);
    isExporting.value = false;
  }
}

async function startAllDatabasesExport() {
  if (!canExport.value) return;

  let directoryPath = "";
  if (isTauriRuntime()) {
    try {
      const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
      const path = await openDialog({
        directory: true,
        multiple: false,
        title: t("databaseExport.selectExportDirectory"),
      });
      if (!path || Array.isArray(path)) return;
      directoryPath = path;
    } catch (e: any) {
      toast(e?.message || String(e), 5000);
      return;
    }
  }

  isExporting.value = true;
  exportDone.value = false;
  exportError.value = null;
  exportCancelled.value = false;
  exportProgress.value = null;
  batchDatabaseIndex.value = 0;

  const dbs = [...selectedDatabases.value];
  const batchId = generateDatabaseExportId();
  exportId.value = batchId;
  addDatabaseExportTask(batchId, t("databaseExport.allDatabasesTask", { count: dbs.length }), directoryPath);
  let exportPlan: AllDatabaseExportPlanItem[] = [];

  try {
    exportPlan = await buildExportPlanForDatabases(dbs);
    batchDatabaseTotal.value = exportPlan.length;

    for (let index = 0; index < exportPlan.length; index += 1) {
      if (exportCancelled.value) break;
      const item = exportPlan[index]!;
      batchDatabaseIndex.value = index + 1;
      const currentExportId = `${batchId}-${index + 1}`;
      activeDatabaseExportId.value = currentExportId;
      const filePath = isTauriRuntime() ? joinExportPath(directoryPath, `${sanitizeFileName(item.fileStem)}.sql`) : `__web_export_${currentExportId}.sql`;
      const request: api.DatabaseExportRequest = {
        exportId: currentExportId,
        connectionId: connectionId.value,
        database: item.database,
        schema: item.schema,
        filePath,
        includeStructure: includeStructure.value,
        includeData: includeData.value,
        includeObjects: includeObjects.value,
        dropTableIfExists: dropTableIfExists.value,
        omitAutoIncrement: omitAutoIncrement.value,
        batchSize: 1000,
      };

      await runDatabaseExportUntilTerminal(request, (progress) => {
        exportProgress.value = { ...progress, exportId: batchId, currentObject: `${item.displayName}: ${progress.currentObject || item.displayName}` };
        updateDatabaseExportTask(batchId, {
          ...progress,
          exportId: batchId,
          currentObject: item.displayName,
          objectIndex: index,
          totalObjects: exportPlan.length,
        });
        if (progress.status === "Error") {
          exportError.value = progress.error;
          isExporting.value = false;
        } else if (progress.status === "Cancelled") {
          exportCancelled.value = true;
          isExporting.value = false;
        }
      });

      if (exportError.value || exportCancelled.value) break;
      activeDatabaseExportId.value = "";
    }

    if (!exportError.value && !exportCancelled.value) {
      exportDone.value = true;
      isExporting.value = false;
      updateDatabaseExportTask(batchId, {
        exportId: batchId,
        currentObject: t("databaseExport.allDatabasesTask", { count: dbs.length }),
        objectIndex: exportPlan.length,
        totalObjects: exportPlan.length,
        rowsExported: currentRowsExported(),
        totalRows: null,
        status: "Done",
        error: null,
      });
      toast(t("databaseExport.exportAllSuccess", { count: dbs.length }), 3000);
    }
  } catch (e: any) {
    exportError.value = e?.message || String(e);
    updateDatabaseExportTask(batchId, {
      exportId: batchId,
      currentObject: t("databaseExport.allDatabasesTask", { count: dbs.length }),
      objectIndex: Math.max(0, batchDatabaseIndex.value - 1),
      totalObjects: batchDatabaseTotal.value || dbs.length,
      rowsExported: currentRowsExported(),
      totalRows: null,
      status: "Error",
      error: exportError.value,
    });
    isExporting.value = false;
  }
}

async function cancelExport() {
  if (exportId.value) {
    if (exportAllDatabases.value) {
      exportCancelled.value = true;
      isExporting.value = false;
      if (activeDatabaseExportId.value) {
        await api.cancelDatabaseExport(activeDatabaseExportId.value);
      }
    } else {
      await api.cancelDatabaseExport(exportId.value);
    }
  }
}

function resetState() {
  connectionId.value = "";
  database.value = "";
  databases.value = [];
  schema.value = "";
  schemas.value = [];
  tables.value = [];
  selectedTables.value = [];
  tableError.value = null;
  pendingPrefillTable.value = "";
  pendingPrefillTables.value = [];
  exportAllDatabases.value = false;
  selectedDatabases.value = [];
  databaseFilter.value = "";
  includeStructure.value = true;
  includeData.value = true;
  includeObjects.value = true;
  dropTableIfExists.value = false;
  omitAutoIncrement.value = false;
  isExporting.value = false;
  exportProgress.value = null;
  exportDone.value = false;
  exportError.value = null;
  exportCancelled.value = false;
  exportId.value = "";
  batchDatabaseIndex.value = 0;
  batchDatabaseTotal.value = 0;
  activeDatabaseExportId.value = "";
}

const progressPercent = computed(() => {
  const p = exportProgress.value;
  if (!p || p.totalObjects === 0) return 0;
  return Math.round((p.objectIndex / p.totalObjects) * 100);
});

const skipConnectionWatch = ref(false);

watch(connectionId, (id) => {
  if (skipConnectionWatch.value) {
    skipConnectionWatch.value = false;
    return;
  }
  database.value = "";
  databases.value = [];
  selectedDatabases.value = [];
  schemas.value = [];
  schema.value = "";
  tables.value = [];
  selectedTables.value = [];
  tableError.value = null;
  loadDatabases(id);
});

watch(database, (db) => {
  if (exportAllDatabases.value) return;
  schema.value = "";
  schemas.value = [];
  tables.value = [];
  selectedTables.value = [];
  tableError.value = null;
  if (db) loadSchemas(props.prefillSchema).catch((e) => toast(String(e), 5000));
});

watch(schema, (value) => {
  if (exportAllDatabases.value) return;
  tables.value = [];
  selectedTables.value = [];
  tableError.value = null;
  const preferredTable = pendingPrefillTable.value;
  const preferredTables = pendingPrefillTables.value;
  pendingPrefillTable.value = "";
  pendingPrefillTables.value = [];
  if (value) loadTables(preferredTable, preferredTables).catch((e) => toast(String(e), 5000));
});

watch(
  open,
  async (val) => {
    if (val) {
      resetState();
      exportAllDatabases.value = props.prefillAllDatabases ?? false;
      pendingPrefillTable.value = props.prefillTable ?? "";
      pendingPrefillTables.value = props.prefillTables ?? [];
      if (props.prefillConnectionId) {
        skipConnectionWatch.value = true;
        connectionId.value = props.prefillConnectionId;
        await loadDatabases(props.prefillConnectionId);
        if (props.prefillDatabase) {
          database.value = props.prefillDatabase;
          await loadSchemas(props.prefillSchema);
        }
      }
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[480px] max-h-[80vh] flex flex-col overflow-hidden" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Download class="w-4 h-4" />
          {{ t("databaseExport.title") }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-auto space-y-4 py-2">
        <!-- Connection / Database / Schema Selection -->
        <div v-if="!isExporting && !exportDone && !exportError && !exportCancelled" class="space-y-3">
          <div class="space-y-1.5">
            <Label class="text-xs">{{ t("transfer.sourceConnection") }}</Label>
            <Select :model-value="connectionId" @update:model-value="(v: any) => (connectionId = String(v))">
              <SelectTrigger class="h-8 text-xs">
                <div class="flex items-center gap-2">
                  <DatabaseIcon v-if="connectionId" :db-type="connectionIconType(connectionId)" class="w-3.5 h-3.5" />
                  <SelectValue :placeholder="t('diff.selectConnection')" />
                </div>
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem v-for="c in sqlConnections" :key="c.id" :value="c.id">
                  <div class="flex min-w-0 items-center gap-2">
                    <DatabaseIcon :db-type="c.driver_profile || c.db_type" class="w-3.5 h-3.5 shrink-0" />
                    <ConnectionGroupBadge :connection-id="c.id" />
                    <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-if="exportAllDatabases && databases.length" class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("databaseExport.databaseSelection") }}</Label>
              <div class="text-[11px] text-muted-foreground">
                {{ t("databaseExport.selectedDatabases", { selected: selectedDatabases.length, total: databases.length }) }}
              </div>
            </div>
            <div class="space-y-2 rounded border border-border/60 p-2">
              <div class="relative">
                <Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="databaseFilter" class="h-7 pl-7 text-xs" :placeholder="t('databaseExport.filterDatabases')" />
              </div>
              <div class="flex items-center gap-2">
                <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="selectAllDatabases">
                  {{ t("databaseExport.selectAllDatabases") }}
                </Button>
                <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="clearSelectedDatabases">
                  {{ t("databaseExport.clearDatabases") }}
                </Button>
              </div>
              <div class="max-h-44 overflow-auto space-y-1 pr-1">
                <button v-for="db in filteredDatabases" :key="db" type="button" class="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted" @click="toggleDatabase(db)">
                  <CheckSquare v-if="selectedDatabaseSet.has(db)" class="w-3.5 h-3.5 text-primary shrink-0" />
                  <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                  <span class="truncate">{{ db }}</span>
                </button>
              </div>
            </div>
          </div>

          <div v-else-if="databases.length" class="space-y-1.5">
            <Label class="text-xs">{{ t("transfer.sourceDatabase") }}</Label>
            <Select :model-value="database" @update:model-value="(v: any) => (database = String(v))">
              <SelectTrigger class="h-8 text-xs">
                <SelectValue :placeholder="t('diff.selectDatabase')" />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem v-for="db in databases" :key="db" :value="db">{{ db }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-if="!exportAllDatabases && schemas.length" class="space-y-1.5">
            <Label class="text-xs">{{ t("diff.selectSchema") }}</Label>
            <Select :model-value="schema" @update:model-value="(v: any) => (schema = String(v))">
              <SelectTrigger class="h-8 text-xs">
                <SelectValue :placeholder="t('diff.selectSchema')" />
              </SelectTrigger>
              <SelectContent position="popper" align="start">
                <SelectItem v-for="s in schemas" :key="s" :value="s">{{ s }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div v-if="!exportAllDatabases && schema" class="space-y-2">
            <div class="flex items-center justify-between gap-2">
              <Label class="text-xs">{{ t("databaseExport.tableSelection") }}</Label>
              <div v-if="tables.length" class="text-[11px] text-muted-foreground">
                {{ t("databaseExport.selectedTables", { selected: selectedTables.length, total: tables.length }) }}
              </div>
            </div>

            <div v-if="loadingTables" class="text-xs text-muted-foreground">
              {{ t("databaseExport.loadingTables") }}
            </div>
            <div v-else-if="tableError" class="text-xs text-destructive">
              {{ t("databaseExport.tableLoadError", { error: tableError }) }}
            </div>
            <div v-else-if="tables.length" class="space-y-2 rounded border border-border/60 p-2">
              <div class="relative">
                <Search class="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="tableFilter" class="h-7 pl-7 text-xs" :placeholder="t('databaseExport.filterTables')" />
              </div>
              <div class="flex items-center gap-2">
                <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="selectAllTables">
                  {{ t("databaseExport.selectAllTables") }}
                </Button>
                <Button variant="outline" size="sm" class="h-7 px-2 text-xs" @click="clearSelectedTables">
                  {{ t("databaseExport.clearTables") }}
                </Button>
              </div>
              <div class="max-h-40 overflow-auto space-y-1 pr-1">
                <button v-for="table in filteredTables" :key="table" type="button" class="flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-muted" @click="toggleTable(table)">
                  <CheckSquare v-if="selectedTableSet.has(table)" class="w-3.5 h-3.5 text-primary shrink-0" />
                  <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
                  <span class="truncate">{{ table }}</span>
                </button>
              </div>
            </div>
            <div v-else class="text-xs text-muted-foreground">
              {{ t("databaseExport.noTables") }}
            </div>
          </div>

          <!-- Options -->
          <div class="space-y-2.5 pt-1">
            <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {{ t("databaseExport.options") }}
            </div>
            <div class="flex items-center gap-2 cursor-pointer text-xs" @click="includeStructure = !includeStructure">
              <CheckSquare v-if="includeStructure" class="w-3.5 h-3.5 text-primary shrink-0" />
              <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
              {{ t("databaseExport.includeStructure") }}
            </div>
            <div class="flex items-center gap-2 text-xs" :class="includeStructure ? 'cursor-pointer' : 'cursor-not-allowed text-muted-foreground/50'" @click="includeStructure && (dropTableIfExists = !dropTableIfExists)">
              <CheckSquare v-if="dropTableIfExists && includeStructure" class="w-3.5 h-3.5 text-primary shrink-0" />
              <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
              {{ t("databaseExport.dropTableIfExists") }}
            </div>
            <div v-if="includeStructure && isMysqlFamily" class="flex items-center gap-2 cursor-pointer text-xs" @click="omitAutoIncrement = !omitAutoIncrement">
              <CheckSquare v-if="omitAutoIncrement" class="w-3.5 h-3.5 text-primary shrink-0" />
              <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
              {{ t("databaseExport.omitAutoIncrement") }}
            </div>
            <div class="flex items-center gap-2 cursor-pointer text-xs" @click="includeData = !includeData">
              <CheckSquare v-if="includeData" class="w-3.5 h-3.5 text-primary shrink-0" />
              <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
              {{ t("databaseExport.includeData") }}
            </div>
            <div class="flex items-center gap-2 cursor-pointer text-xs" @click="includeObjects = !includeObjects">
              <CheckSquare v-if="includeObjects" class="w-3.5 h-3.5 text-primary shrink-0" />
              <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
              {{ t("databaseExport.includeObjects") }}
            </div>
          </div>
        </div>

        <!-- Progress View -->
        <div v-if="isExporting || exportDone || exportError || exportCancelled" class="py-3 space-y-3">
          <div v-if="exportAllDatabases && batchDatabaseTotal" class="text-xs text-muted-foreground">
            {{ t("databaseExport.currentDatabase", { current: batchDatabaseIndex, total: batchDatabaseTotal }) }}
          </div>
          <div v-if="exportProgress" class="space-y-2">
            <div class="text-xs text-muted-foreground">
              {{
                t("databaseExport.currentTable", {
                  table: exportProgress.currentObject,
                  current: exportProgress.objectIndex,
                  total: exportProgress.totalObjects,
                })
              }}
            </div>

            <div class="w-full bg-muted rounded-full h-2 overflow-hidden">
              <div class="h-full rounded-full transition-[width] duration-300" :class="exportError ? 'bg-destructive' : exportCancelled ? 'bg-yellow-500' : 'bg-primary'" :style="{ width: `${progressPercent}%` }" />
            </div>

            <div class="text-xs text-muted-foreground">
              {{ t("databaseExport.rowsExported", { count: exportProgress.rowsExported.toLocaleString() }) }}
            </div>
          </div>

          <!-- Status messages -->
          <div v-if="exportDone" class="text-xs text-green-600 font-medium">
            {{ t("databaseExport.exportSuccess") }}
          </div>
          <div v-else-if="exportError" class="text-xs text-destructive font-medium">
            {{ t("databaseExport.exportError", { error: exportError }) }}
          </div>
          <div v-else-if="exportCancelled" class="text-xs text-yellow-600 font-medium">
            {{ t("databaseExport.exportCancelled") }}
          </div>
        </div>
      </div>

      <DialogFooter>
        <template v-if="!isExporting && !exportDone && !exportError && !exportCancelled">
          <Button variant="outline" size="sm" @click="open = false">
            {{ t("transfer.cancel") }}
          </Button>
          <Button size="sm" :disabled="!canExport" @click="startExport">
            <Download class="w-3.5 h-3.5 mr-1.5" />
            {{ exportAllDatabases ? t("databaseExport.exportAllDatabases") : t("databaseExport.export") }}
          </Button>
        </template>
        <template v-else-if="isExporting">
          <Button variant="outline" size="sm" @click="open = false">
            {{ t("databaseExport.runInBackground") }}
          </Button>
          <Button variant="destructive" size="sm" @click="cancelExport">
            <X class="w-3.5 h-3.5 mr-1.5" />
            {{ t("transfer.cancel") }}
          </Button>
        </template>
        <template v-else>
          <Button size="sm" @click="open = false">
            {{ t("common.close") }}
          </Button>
        </template>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

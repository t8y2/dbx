<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Dialog, DialogHeader, DialogTitle,
  DialogFooter, DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import * as api from "@/lib/api";
import {
  diffColumns, diffIndexes, diffTables, generateSyncSql,
  type TableDiff,
} from "@/lib/schemaDiff";
import { useToast } from "@/composables/useToast";
import { Loader2, Copy, Play, GitCompareArrows } from "lucide-vue-next";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });
const store = useConnectionStore();

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
}>();

const sourceConnectionId = ref("");
const sourceDatabase = ref("");
const sourceDatabases = ref<string[]>([]);
const sourceSchema = ref("");

const targetConnectionId = ref("");
const targetDatabase = ref("");
const targetDatabases = ref<string[]>([]);
const targetSchema = ref("");

const step = ref<"select" | "comparing" | "result">("select");
const diffs = ref<TableDiff[]>([]);
const syncSql = ref("");
const executing = ref(false);

const sqlConnections = computed(() =>
  store.connections.filter((c) =>
    !["redis", "mongodb", "elasticsearch"].includes(c.db_type),
  ),
);

const canCompare = computed(() =>
  sourceConnectionId.value && sourceDatabase.value &&
  targetConnectionId.value && targetDatabase.value,
);

function connectionIconType(connectionId: string) {
  const config = store.getConfig(connectionId);
  return config?.driver_profile || config?.db_type || "mysql";
}

async function loadDatabases(connectionId: string, side: "source" | "target") {
  if (!connectionId) return;
  try {
    await store.ensureConnected(connectionId);
    const dbs = await api.listDatabases(connectionId);
    const names = dbs.map((d) => d.name);
    if (side === "source") {
      sourceDatabases.value = names;
      sourceDatabase.value = names.length === 1 ? names[0] : "";
    } else {
      targetDatabases.value = names;
      targetDatabase.value = names.length === 1 ? names[0] : "";
    }
  } catch {
    if (side === "source") sourceDatabases.value = [];
    else targetDatabases.value = [];
  }
}

async function resolveSchema(connectionId: string, database: string): Promise<string> {
  const config = store.getConfig(connectionId);
  const needsSchema = config?.db_type === "postgres" || config?.db_type === "sqlserver" || config?.db_type === "oracle" || config?.db_type === "redshift";
  if (needsSchema) {
    const schemas = await api.listSchemas(connectionId, database);
    return schemas.includes("public") ? "public" : (schemas[0] ?? "");
  }
  return database;
}

async function startCompare() {
  if (!canCompare.value) return;
  step.value = "comparing";
  diffs.value = [];
  syncSql.value = "";

  try {
    await store.ensureConnected(sourceConnectionId.value);
    await store.ensureConnected(targetConnectionId.value);

    const srcSchema = await resolveSchema(sourceConnectionId.value, sourceDatabase.value);
    const tgtSchema = await resolveSchema(targetConnectionId.value, targetDatabase.value);
    sourceSchema.value = srcSchema;
    targetSchema.value = tgtSchema;

    const [srcTables, tgtTables] = await Promise.all([
      api.listTables(sourceConnectionId.value, sourceDatabase.value, srcSchema),
      api.listTables(targetConnectionId.value, targetDatabase.value, tgtSchema),
    ]);

    const srcNames = srcTables.filter((t) => t.table_type !== "VIEW").map((t) => t.name);
    const tgtNames = tgtTables.filter((t) => t.table_type !== "VIEW").map((t) => t.name);
    const { added, removed, common } = diffTables(srcNames, tgtNames);

    const result: TableDiff[] = [];

    for (const name of added) {
      const ddl = await api.getTableDdl(sourceConnectionId.value, sourceDatabase.value, srcSchema, name);
      result.push({ type: "added", name, ddl });
    }

    for (const name of removed) {
      result.push({ type: "removed", name });
    }

    for (const name of common) {
      const [srcCols, tgtCols, srcIdx, tgtIdx] = await Promise.all([
        api.getColumns(sourceConnectionId.value, sourceDatabase.value, srcSchema, name),
        api.getColumns(targetConnectionId.value, targetDatabase.value, tgtSchema, name),
        api.listIndexes(sourceConnectionId.value, sourceDatabase.value, srcSchema, name),
        api.listIndexes(targetConnectionId.value, targetDatabase.value, tgtSchema, name),
      ]);

      const colDiffs = diffColumns(srcCols, tgtCols);
      const idxDiffs = diffIndexes(srcIdx, tgtIdx);

      if (colDiffs.length > 0 || idxDiffs.length > 0) {
        result.push({
          type: "modified",
          name,
          columns: colDiffs.length > 0 ? colDiffs : undefined,
          indexes: idxDiffs.length > 0 ? idxDiffs : undefined,
        });
      }
    }

    diffs.value = result;
    const srcConfig = store.getConfig(targetConnectionId.value);
    syncSql.value = generateSyncSql(result, srcConfig?.db_type || "mysql");
    step.value = "result";
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
    step.value = "select";
  }
}

async function executeSql() {
  if (!syncSql.value.trim() || executing.value) return;
  executing.value = true;
  try {
    await store.ensureConnected(targetConnectionId.value);
    await api.executeScript(targetConnectionId.value, targetDatabase.value, syncSql.value);
    toast(t("diff.syncSuccess"), 2000);
    open.value = false;
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    executing.value = false;
  }
}

function copySql() {
  navigator.clipboard.writeText(syncSql.value);
  toast(t("grid.copied"));
}

function diffBadgeVariant(type: string) {
  if (type === "added") return "default";
  if (type === "removed") return "destructive";
  return "secondary";
}

function diffLabel(type: string) {
  if (type === "added") return t("diff.added");
  if (type === "removed") return t("diff.removed");
  return t("diff.modified");
}

function resetResult() {
  step.value = "select";
  diffs.value = [];
  syncSql.value = "";
}

watch(sourceConnectionId, (id) => {
  sourceDatabase.value = "";
  loadDatabases(id, "source");
  resetResult();
});

watch(targetConnectionId, (id) => {
  targetDatabase.value = "";
  loadDatabases(id, "target");
  resetResult();
});

watch(sourceDatabase, () => resetResult());
watch(targetDatabase, () => resetResult());

watch(open, async (val) => {
  if (val) {
    step.value = "select";
    diffs.value = [];
    syncSql.value = "";
    if (props.prefillConnectionId) {
      sourceConnectionId.value = props.prefillConnectionId;
      await loadDatabases(props.prefillConnectionId, "source");
      if (props.prefillDatabase) {
        sourceDatabase.value = props.prefillDatabase;
      }
    }
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <GitCompareArrows class="w-4 h-4" />
          {{ t('diff.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="flex-1 min-h-0 overflow-auto space-y-4 py-2">
        <!-- Source / Target Selection -->
        <div class="grid grid-cols-2 gap-4">
          <div class="space-y-2">
            <Label class="text-xs font-medium">{{ t('diff.source') }}</Label>
            <Select :model-value="sourceConnectionId" @update:model-value="(v: any) => sourceConnectionId = String(v)">
              <SelectTrigger class="h-8 text-xs">
                <div class="flex items-center gap-2">
                  <DatabaseIcon v-if="sourceConnectionId" :db-type="connectionIconType(sourceConnectionId)" class="w-3.5 h-3.5" />
                  <SelectValue :placeholder="t('diff.selectConnection')" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in sqlConnections" :key="c.id" :value="c.id">
                  <div class="flex items-center gap-2">
                    <DatabaseIcon :db-type="c.driver_profile || c.db_type" class="w-3.5 h-3.5" />
                    {{ c.name }}
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <Select v-if="sourceDatabases.length" :model-value="sourceDatabase" @update:model-value="(v: any) => sourceDatabase = String(v)">
              <SelectTrigger class="h-8 text-xs">
                <SelectValue :placeholder="t('diff.selectDatabase')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="db in sourceDatabases" :key="db" :value="db">{{ db }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="space-y-2">
            <Label class="text-xs font-medium">{{ t('diff.target') }}</Label>
            <Select :model-value="targetConnectionId" @update:model-value="(v: any) => targetConnectionId = String(v)">
              <SelectTrigger class="h-8 text-xs">
                <div class="flex items-center gap-2">
                  <DatabaseIcon v-if="targetConnectionId" :db-type="connectionIconType(targetConnectionId)" class="w-3.5 h-3.5" />
                  <SelectValue :placeholder="t('diff.selectConnection')" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in sqlConnections" :key="c.id" :value="c.id">
                  <div class="flex items-center gap-2">
                    <DatabaseIcon :db-type="c.driver_profile || c.db_type" class="w-3.5 h-3.5" />
                    {{ c.name }}
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <Select v-if="targetDatabases.length" :model-value="targetDatabase" @update:model-value="(v: any) => targetDatabase = String(v)">
              <SelectTrigger class="h-8 text-xs">
                <SelectValue :placeholder="t('diff.selectDatabase')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="db in targetDatabases" :key="db" :value="db">{{ db }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <Button v-if="step === 'select'" size="sm" :disabled="!canCompare" @click="startCompare">
          <GitCompareArrows class="w-3.5 h-3.5 mr-1" />
          {{ t('diff.compare') }}
        </Button>

        <!-- Comparing -->
        <div v-if="step === 'comparing'" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
          <Loader2 class="w-4 h-4 animate-spin mr-2" />
          {{ t('diff.comparing') }}
        </div>

        <!-- Results -->
        <template v-if="step === 'result'">
          <div v-if="diffs.length === 0" class="py-6 text-center text-sm text-muted-foreground">
            {{ t('diff.noDifferences') }}
          </div>

          <template v-else>
            <!-- Diff Table -->
            <div class="border rounded-lg overflow-hidden">
              <div class="max-h-60 overflow-auto">
                <table class="w-full text-xs table-fixed">
                  <thead class="bg-muted sticky top-0 z-10">
                    <tr>
                      <th class="text-left px-3 py-2 font-medium w-1/4">{{ t('diff.table') }}</th>
                      <th class="text-left px-3 py-2 font-medium w-16">{{ t('diff.status') }}</th>
                      <th class="text-left px-3 py-2 font-medium">{{ t('diff.details') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="d in diffs" :key="d.name" class="border-t border-border/50 hover:bg-accent/30">
                      <td class="px-3 py-1.5 font-mono truncate">{{ d.name }}</td>
                      <td class="px-3 py-1.5">
                        <Badge :variant="diffBadgeVariant(d.type)" class="text-[10px] h-4 px-1.5">
                          {{ diffLabel(d.type) }}
                        </Badge>
                      </td>
                      <td class="px-3 py-1.5 text-muted-foreground">
                        <template v-if="d.type === 'modified' && d.columns">
                          <span v-for="(col, ci) in d.columns" :key="ci">
                            <span :class="{
                              'text-green-500': col.type === 'added',
                              'text-red-500': col.type === 'removed',
                              'text-yellow-500': col.type === 'modified',
                            }">{{ col.type === 'added' ? '+' : col.type === 'removed' ? '-' : '~' }}{{ col.name }}</span>
                            <span v-if="ci < d.columns!.length - 1">, </span>
                          </span>
                        </template>
                        <span v-else-if="d.type === 'added'" class="text-green-500">{{ t('diff.newTable') }}</span>
                        <span v-else-if="d.type === 'removed'" class="text-red-500">{{ t('diff.dropTable') }}</span>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <!-- SQL Preview -->
            <div class="space-y-1">
              <Label class="text-xs font-medium">{{ t('diff.generatedSql') }}</Label>
              <textarea
                v-model="syncSql"
                class="w-full h-48 rounded-lg border bg-muted/20 p-3 font-mono text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
          </template>
        </template>
      </div>

      <DialogFooter v-if="step === 'result' && diffs.length > 0" class="flex items-center gap-2">
        <Button variant="outline" size="sm" @click="copySql">
          <Copy class="w-3 h-3 mr-1" /> {{ t('diff.copySql') }}
        </Button>
        <Button size="sm" :disabled="!syncSql.trim() || executing" @click="executeSql">
          <Loader2 v-if="executing" class="w-3 h-3 animate-spin mr-1" />
          <Play v-else class="w-3 h-3 mr-1" />
          {{ t('diff.executeSync') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

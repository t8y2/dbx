<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tabs, TabsContent, TabsList, TabsTrigger,
} from "@/components/ui/tabs";
import {
  AlertTriangle, Check, ChevronDown, Database, KeyRound, Loader2, Plus, RefreshCw, Save, TableProperties, Trash2, X,
} from "lucide-vue-next";
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { buildTableStructureChangeSql, type EditableStructureColumn, type EditableStructureIndex } from "@/lib/tableStructureEditorSql";
import { createColumnDrafts, createIndexDrafts, toColumnNames } from "@/lib/tableStructureEditorState";
import type { ForeignKeyInfo, TriggerInfo } from "@/types/database";
import * as api from "@/lib/tauri";

const { t } = useI18n();
const store = useConnectionStore();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillSchema?: string;
  prefillTable?: string;
}>();

const emit = defineEmits<{
  saved: [];
}>();

const activeTab = ref("columns");
const loading = ref(false);
const saving = ref(false);
const errorMessage = ref("");
const columns = ref<EditableStructureColumn[]>([]);
const indexes = ref<EditableStructureIndex[]>([]);
const foreignKeys = ref<ForeignKeyInfo[]>([]);
const triggers = ref<TriggerInfo[]>([]);

const indexColWidths = ref([160, 240, 80, 112, 160, 192, 160, 96]);
const resizing = ref<{ col: number; startX: number; startW: number } | null>(null);

function onIndexColResize(e: MouseEvent, col: number) {
  e.preventDefault();
  resizing.value = { col, startX: e.clientX, startW: indexColWidths.value[col] };
  const onMove = (ev: MouseEvent) => {
    if (!resizing.value) return;
    const delta = ev.clientX - resizing.value.startX;
    indexColWidths.value[col] = Math.max(60, resizing.value.startW + delta);
  };
  const onUp = () => {
    resizing.value = null;
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

const connection = computed(() =>
  props.prefillConnectionId ? store.getConfig(props.prefillConnectionId) : undefined
);
const databaseType = computed(() => connection.value?.db_type);

const indexTypesByDb: Record<string, string[]> = {
  postgres: ["BTREE", "HASH", "GIST", "SPGIST", "GIN", "BRIN"],
  mysql: ["BTREE", "HASH", "FULLTEXT", "SPATIAL", "RTREE"],
  sqlserver: ["CLUSTERED", "NONCLUSTERED", "COLUMNSTORE", "NONCLUSTERED COLUMNSTORE", "XML", "SPATIAL"],
  oracle: ["NORMAL", "BITMAP", "FUNCTION-BASED NORMAL", "FUNCTION-BASED DOMAIN", "DOMAIN", "CLUSTER"],
  sqlite: ["BTREE"],
};
const indexTypeOptions = computed(() => indexTypesByDb[databaseType.value ?? ""] ?? []);

const indexColLabels = computed(() => [
  t('structureEditor.indexName'),
  t('structureEditor.indexColumns'),
  t('structureEditor.unique'),
  t('structureEditor.indexType'),
  t('structureEditor.includedColumns'),
  t('structureEditor.filter'),
  t('structureEditor.comment'),
  t('structureEditor.actions'),
]);
const targetSchema = computed(() => props.prefillSchema || props.prefillDatabase || "");
const targetLabel = computed(() => [
  connection.value?.name,
  props.prefillDatabase,
  props.prefillSchema,
  props.prefillTable,
].filter(Boolean).join(" / "));

const changeSql = computed(() => buildTableStructureChangeSql({
  databaseType: databaseType.value,
  schema: props.prefillSchema,
  tableName: props.prefillTable || "",
  columns: columns.value,
  indexes: indexes.value,
}));
const pendingStatements = computed(() => changeSql.value.statements);
const warnings = computed(() => changeSql.value.warnings);
const canApply = computed(() =>
  !loading.value &&
  !saving.value &&
  pendingStatements.value.length > 0 &&
  warnings.value.length === 0 &&
  !!props.prefillConnectionId &&
  !!props.prefillTable
);

function resetState() {
  activeTab.value = "columns";
  loading.value = false;
  saving.value = false;
  errorMessage.value = "";
  columns.value = [];
  indexes.value = [];
  foreignKeys.value = [];
  triggers.value = [];
}

async function loadStructure() {
  if (!props.prefillConnectionId || !props.prefillDatabase || !props.prefillTable) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    await store.ensureConnected(props.prefillConnectionId);
    const [nextColumns, nextIndexes, nextForeignKeys, nextTriggers] = await Promise.all([
      api.getColumns(props.prefillConnectionId, props.prefillDatabase, targetSchema.value, props.prefillTable),
      api.listIndexes(props.prefillConnectionId, props.prefillDatabase, targetSchema.value, props.prefillTable),
      api.listForeignKeys(props.prefillConnectionId, props.prefillDatabase, targetSchema.value, props.prefillTable),
      api.listTriggers(props.prefillConnectionId, props.prefillDatabase, targetSchema.value, props.prefillTable),
    ]);
    columns.value = createColumnDrafts(nextColumns);
    indexes.value = createIndexDrafts(nextIndexes);
    foreignKeys.value = nextForeignKeys;
    triggers.value = nextTriggers;
  } catch (e: any) {
    errorMessage.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function addColumn() {
  columns.value.push({
    id: `new:${crypto.randomUUID()}`,
    name: "",
    dataType: "varchar(255)",
    isNullable: true,
    defaultValue: "",
    comment: "",
    isPrimaryKey: false,
    markedForDrop: false,
  });
}

function removeNewColumn(column: EditableStructureColumn) {
  columns.value = columns.value.filter((item) => item.id !== column.id);
}

function toggleDropColumn(column: EditableStructureColumn) {
  if (!column.original || column.isPrimaryKey) return;
  column.markedForDrop = !column.markedForDrop;
}

function addIndex() {
  indexes.value.push({
    id: `new:${crypto.randomUUID()}`,
    name: "",
    columns: [],
    isUnique: false,
    isPrimary: false,
    filter: "",
    indexType: "",
    includedColumns: [],
    comment: "",
    markedForDrop: false,
  });
}

const availableColumnNames = computed(() =>
  columns.value.filter((c) => !c.markedForDrop).map((c) => c.name).filter(Boolean)
);

const colSearch = ref("");
const filteredColumnNames = computed(() => {
  const q = colSearch.value.toLowerCase().trim();
  if (!q) return availableColumnNames.value;
  return availableColumnNames.value.filter((c) => c.toLowerCase().includes(q));
});

function toggleIndexColumn(index: EditableStructureIndex, col: string) {
  const i = index.columns.indexOf(col);
  if (i >= 0) index.columns.splice(i, 1);
  else index.columns.push(col);
}

function toggleIncludedColumn(index: EditableStructureIndex, col: string) {
  const i = index.includedColumns.indexOf(col);
  if (i >= 0) index.includedColumns.splice(i, 1);
  else index.includedColumns.push(col);
}

function removeNewIndex(index: EditableStructureIndex) {
  indexes.value = indexes.value.filter((item) => item.id !== index.id);
}

function toggleDropIndex(index: EditableStructureIndex) {
  if (!index.original || index.isPrimary) return;
  index.markedForDrop = !index.markedForDrop;
}

async function applyChanges() {
  if (!canApply.value || !props.prefillConnectionId || !props.prefillDatabase) return;
  saving.value = true;
  errorMessage.value = "";
  try {
    await api.executeBatch(props.prefillConnectionId, props.prefillDatabase, pendingStatements.value);
    toast(t("structureEditor.saved"), 2500);
    emit("saved");
    await loadStructure();
  } catch (e: any) {
    errorMessage.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}

watch(open, (value) => {
  if (value) {
    resetState();
    void loadStructure();
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogScrollContent class="sm:max-w-[1180px]" :trap-focus="false" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <TableProperties class="h-4 w-4" />
          {{ t('structureEditor.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="space-y-3 py-2">
        <div class="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
          <Database class="h-3.5 w-3.5 text-muted-foreground" />
          <span class="min-w-0 flex-1 truncate font-medium">{{ targetLabel || t('editor.noDatabase') }}</span>
          <Badge variant="outline">{{ connection?.driver_label || databaseType }}</Badge>
          <Button variant="ghost" size="sm" class="h-7 gap-1" :disabled="loading || saving" @click="loadStructure">
            <RefreshCw class="h-3.5 w-3.5" />
            {{ t('structureEditor.refresh') }}
          </Button>
        </div>

        <div v-if="loading" class="flex h-[420px] items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          {{ t('common.loading') }}
        </div>

        <div v-else class="grid min-h-[520px] grid-cols-[minmax(0,1fr)_360px] gap-3">
          <div class="min-w-0 rounded-md border">
            <Tabs v-model="activeTab" class="flex h-full flex-col">
              <div class="flex items-center justify-between border-b px-3 py-2">
                <TabsList>
                  <TabsTrigger value="columns">{{ t('structureEditor.columns') }}</TabsTrigger>
                  <TabsTrigger value="indexes">{{ t('structureEditor.indexes') }}</TabsTrigger>
                  <TabsTrigger value="foreignKeys">{{ t('structureEditor.foreignKeys') }}</TabsTrigger>
                  <TabsTrigger value="triggers">{{ t('structureEditor.triggers') }}</TabsTrigger>
                </TabsList>
                <Button v-if="activeTab === 'columns'" size="sm" class="h-7 gap-1" @click="addColumn">
                  <Plus class="h-3.5 w-3.5" />
                  {{ t('structureEditor.addColumn') }}
                </Button>
                <Button v-if="activeTab === 'indexes'" size="sm" class="h-7 gap-1" @click="addIndex">
                  <Plus class="h-3.5 w-3.5" />
                  {{ t('structureEditor.addIndex') }}
                </Button>
              </div>

              <TabsContent value="columns" class="m-0 min-h-0 flex-1 overflow-auto p-0">
                <table class="min-w-full border-separate border-spacing-0 text-xs">
                  <thead class="sticky top-0 z-10 bg-background">
                    <tr>
                      <th class="w-8 border-b border-r px-2 py-2 text-left">#</th>
                      <th class="min-w-36 border-b border-r px-2 py-2 text-left">{{ t('structureEditor.columnName') }}</th>
                      <th class="min-w-40 border-b border-r px-2 py-2 text-left">{{ t('structureEditor.dataType') }}</th>
                      <th class="w-20 border-b border-r px-2 py-2 text-left">{{ t('structureEditor.nullable') }}</th>
                      <th class="min-w-32 border-b border-r px-2 py-2 text-left">{{ t('structureEditor.defaultValue') }}</th>
                      <th class="min-w-36 border-b border-r px-2 py-2 text-left">{{ t('structureEditor.comment') }}</th>
                      <th class="w-24 border-b px-2 py-2 text-left">{{ t('structureEditor.actions') }}</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr
                      v-for="(column, index) in columns"
                      :key="column.id"
                      :class="column.markedForDrop ? 'bg-destructive/5 opacity-60' : ''"
                    >
                      <td class="border-b border-r px-2 py-1.5 text-muted-foreground">
                        <div class="flex items-center gap-1">
                          <span>{{ index + 1 }}</span>
                          <KeyRound v-if="column.isPrimaryKey" class="h-3 w-3 text-amber-500" />
                        </div>
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <Input v-model="column.name" class="h-7 min-w-32 text-xs" :disabled="column.markedForDrop" />
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <Input v-model="column.dataType" class="h-7 min-w-36 font-mono text-xs" :disabled="column.markedForDrop" />
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <label class="flex items-center gap-1.5">
                          <input v-model="column.isNullable" type="checkbox" class="h-3.5 w-3.5" :disabled="column.markedForDrop || column.isPrimaryKey" />
                          <span>{{ column.isNullable ? t('structureEditor.yes') : t('structureEditor.no') }}</span>
                        </label>
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <Input v-model="column.defaultValue" class="h-7 min-w-28 font-mono text-xs" :disabled="column.markedForDrop" />
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <Input v-model="column.comment" class="h-7 min-w-32 text-xs" :disabled="column.markedForDrop" />
                      </td>
                      <td class="border-b px-2 py-1.5">
                        <Button
                          v-if="column.original"
                          variant="ghost"
                          size="sm"
                          class="h-7 gap-1"
                          :disabled="column.isPrimaryKey"
                          @click="toggleDropColumn(column)"
                        >
                          <Trash2 class="h-3.5 w-3.5" />
                          {{ column.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop') }}
                        </Button>
                        <Button v-else variant="ghost" size="sm" class="h-7 gap-1" @click="removeNewColumn(column)">
                          <X class="h-3.5 w-3.5" />
                          {{ t('structureEditor.remove') }}
                        </Button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </TabsContent>

              <TabsContent value="indexes" class="m-0 min-h-0 flex-1 overflow-auto p-0">
                <table class="min-w-full border-separate border-spacing-0 text-xs">
                  <thead class="sticky top-0 z-10 bg-background">
                    <tr>
                      <th
                        v-for="(label, i) in indexColLabels"
                        :key="i"
                        class="relative border-b border-r px-2 py-2 text-left"
                        :style="{ width: indexColWidths[i] + 'px', minWidth: indexColWidths[i] + 'px' }"
                      >
                        {{ label }}
                        <div
                          v-if="i < indexColLabels.length - 1"
                          class="absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize hover:bg-primary/30"
                          :class="resizing?.col === i ? 'bg-primary/30' : ''"
                          @mousedown="onIndexColResize($event, i)"
                        />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="index in indexes" :key="index.id" :class="index.markedForDrop ? 'bg-destructive/5 opacity-60' : ''">
                      <td class="border-b border-r px-2 py-1.5">
                        <Input v-model="index.name" class="h-7 text-xs" :disabled="!!index.original || index.markedForDrop" />
                      </td>
                      <td class="overflow-hidden border-b border-r px-2 py-1.5">
                        <DropdownMenu v-if="!index.original && !index.markedForDrop">
                          <DropdownMenuTrigger as-child>
                            <Button variant="outline" class="h-7 w-full justify-between font-mono text-xs">
                              <span class="truncate">{{ toColumnNames(index.columns) || t('structureEditor.indexColumnsPlaceholder') }}</span>
                              <ChevronDown class="ml-1 h-3 w-3 shrink-0 opacity-50" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent class="max-h-60 min-w-48 overflow-y-auto" side="bottom" :side-offset="2" :avoid-collisions="false" @interactOutside="colSearch = ''">
                            <div class="px-1.5 pb-1 pt-0.5">
                              <Input v-model="colSearch" class="h-6 text-xs" :placeholder="t('grid.search')" @click.stop />
                            </div>
                            <DropdownMenuCheckboxItem
                              v-for="col in filteredColumnNames"
                              :key="col"
                              :checked="index.columns.includes(col)"
                              :class="index.columns.includes(col) ? 'bg-primary/10' : ''"
                              @select.prevent
                              @click="toggleIndexColumn(index, col)"
                            >
                              {{ col }}
                            </DropdownMenuCheckboxItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <span v-else class="font-mono text-xs text-muted-foreground">{{ toColumnNames(index.columns) }}</span>
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <label class="flex items-center gap-1.5">
                          <input v-model="index.isUnique" type="checkbox" class="h-3.5 w-3.5" :disabled="!!index.original || index.markedForDrop" />
                          <span>{{ index.isUnique ? t('structureEditor.yes') : t('structureEditor.no') }}</span>
                        </label>
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <span v-if="index.original" class="text-muted-foreground">{{ index.indexType || 'BTREE' }}</span>
                        <Select
                          v-else-if="indexTypeOptions.length > 0"
                          :model-value="index.indexType || 'BTREE'"
                          :disabled="index.markedForDrop"
                          @update:model-value="(v: any) => index.indexType = String(v ?? '')"
                        >
                          <SelectTrigger class="h-7 font-mono text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem v-for="opt in indexTypeOptions" :key="opt" :value="opt">{{ opt }}</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          v-else
                          v-model="index.indexType"
                          class="h-7 font-mono text-xs"
                          placeholder="BTREE"
                          :disabled="index.markedForDrop"
                        />
                      </td>
                      <td class="overflow-hidden border-b border-r px-2 py-1.5">
                        <DropdownMenu v-if="!index.original && !index.markedForDrop">
                          <DropdownMenuTrigger as-child>
                            <Button variant="outline" class="h-7 w-full justify-between font-mono text-xs">
                              <span class="truncate">{{ index.includedColumns.join(', ') || t('structureEditor.includedColumnsPlaceholder') }}</span>
                              <ChevronDown class="ml-1 h-3 w-3 shrink-0 opacity-50" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent class="max-h-60 min-w-48 overflow-y-auto" side="bottom" :side-offset="2" :avoid-collisions="false" @interactOutside="colSearch = ''">
                            <div class="px-1.5 pb-1 pt-0.5">
                              <Input v-model="colSearch" class="h-6 text-xs" :placeholder="t('grid.search')" @click.stop />
                            </div>
                            <DropdownMenuCheckboxItem
                              v-for="col in filteredColumnNames"
                              :key="col"
                              :checked="index.includedColumns.includes(col)"
                              :class="index.includedColumns.includes(col) ? 'bg-primary/10' : ''"
                              @select.prevent
                              @click="toggleIncludedColumn(index, col)"
                            >
                              {{ col }}
                            </DropdownMenuCheckboxItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <span v-else class="text-muted-foreground text-xs">{{ index.includedColumns.join(', ') }}</span>
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <Input
                          v-model="index.filter"
                          class="h-7 font-mono text-xs"
                          :placeholder="index.original?.filter || ''"
                          :disabled="!!index.original || index.markedForDrop"
                        />
                      </td>
                      <td class="border-b border-r px-2 py-1.5">
                        <span v-if="index.original" class="text-muted-foreground text-xs">{{ index.comment }}</span>
                        <Input
                          v-else
                          v-model="index.comment"
                          class="h-7 text-xs"
                          :disabled="index.markedForDrop"
                        />
                      </td>
                      <td class="border-b px-2 py-1.5">
                        <Badge v-if="index.isPrimary" variant="outline">{{ t('structureEditor.primary') }}</Badge>
                        <Button
                          v-else-if="index.original"
                          variant="ghost"
                          size="sm"
                          class="h-7 gap-1"
                          @click="toggleDropIndex(index)"
                        >
                          <Trash2 class="h-3.5 w-3.5" />
                          {{ index.markedForDrop ? t('structureEditor.restore') : t('structureEditor.drop') }}
                        </Button>
                        <Button v-else variant="ghost" size="sm" class="h-7 gap-1" @click="removeNewIndex(index)">
                          <X class="h-3.5 w-3.5" />
                          {{ t('structureEditor.remove') }}
                        </Button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </TabsContent>

              <TabsContent value="foreignKeys" class="m-0 min-h-0 flex-1 overflow-auto p-3">
                <div v-if="foreignKeys.length === 0" class="py-10 text-center text-sm text-muted-foreground">{{ t('structureEditor.emptyReadonly') }}</div>
                <div v-else class="space-y-2">
                  <div v-for="fk in foreignKeys" :key="fk.name" class="rounded-md border px-3 py-2 text-xs">
                    <div class="font-medium">{{ fk.name }}</div>
                    <div class="mt-1 font-mono text-muted-foreground">{{ fk.column }} -> {{ fk.ref_table }}.{{ fk.ref_column }}</div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="triggers" class="m-0 min-h-0 flex-1 overflow-auto p-3">
                <div v-if="triggers.length === 0" class="py-10 text-center text-sm text-muted-foreground">{{ t('structureEditor.emptyReadonly') }}</div>
                <div v-else class="space-y-2">
                  <div v-for="trigger in triggers" :key="trigger.name" class="rounded-md border px-3 py-2 text-xs">
                    <div class="font-medium">{{ trigger.name }}</div>
                    <div class="mt-1 font-mono text-muted-foreground">{{ trigger.timing }} {{ trigger.event }}</div>
                  </div>
                </div>
              </TabsContent>
            </Tabs>
          </div>

          <div class="flex min-w-0 flex-col rounded-md border">
            <div class="flex items-center justify-between border-b px-3 py-2 text-xs font-medium">
              <span>{{ t('structureEditor.sqlPreview') }}</span>
              <Badge variant="secondary">{{ pendingStatements.length }}</Badge>
            </div>
            <div class="min-h-0 flex-1 overflow-auto p-3">
              <div v-if="warnings.length" class="mb-3 space-y-1">
                <div v-for="warning in warnings" :key="warning" class="flex gap-2 rounded-md border border-yellow-300/40 bg-yellow-500/10 px-2 py-1.5 text-xs text-yellow-700 dark:text-yellow-300">
                  <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{{ warning }}</span>
                </div>
              </div>
              <pre v-if="pendingStatements.length" class="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-5">{{ pendingStatements.join('\n') }}</pre>
              <div v-else class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t('structureEditor.noChanges') }}</div>
            </div>
          </div>
        </div>

        <div v-if="errorMessage" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {{ errorMessage }}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="saving" @click="open = false">
          <X class="mr-1.5 h-3.5 w-3.5" />
          {{ t('dangerDialog.cancel') }}
        </Button>
        <Button :disabled="!canApply" @click="applyChanges">
          <Loader2 v-if="saving" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
          <Save v-else class="mr-1.5 h-3.5 w-3.5" />
          {{ t('structureEditor.apply') }}
        </Button>
        <Badge v-if="!saving && pendingStatements.length && warnings.length === 0" variant="outline" class="h-8">
          <Check class="h-3.5 w-3.5" />
          {{ t('structureEditor.ready') }}
        </Badge>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>

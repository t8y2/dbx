<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeftRight, ArrowRight, Copy, Link2, Plus, Trash2, Upload } from "@lucide/vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import * as api from "@/lib/backend/api";
import {
  exportPortableVirtualForeignKeyBundle,
  formatVirtualForeignKeyEndpoint,
  parsePortableVirtualForeignKeyBundle,
  virtualForeignKeyEndpointsEqual,
  virtualForeignKeysTouchingTable,
  type PortableVirtualForeignKeyRule,
  type VirtualForeignKeyEndpoint,
  type VirtualForeignKeyRule,
} from "@/lib/dataGrid/virtualForeignKeys";

const props = defineProps<{
  open: boolean;
  connectionId: string;
  database?: string;
  schema?: string;
  catalog?: string;
  tableName: string;
  columns: string[];
  initialColumn?: string;
  databaseTreeHierarchy: boolean;
  rules: VirtualForeignKeyRule[];
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  save: [rule: Omit<VirtualForeignKeyRule, "id">];
  remove: [id: string];
  "import-rules": [rules: PortableVirtualForeignKeyRule[]];
  copy: [text: string];
}>();

const { t } = useI18n();

const sourceColumn = ref("");
const targetScope = ref("");
const targetTable = ref("");
const targetColumn = ref("");
const bidirectional = ref(true);
const note = ref("");

const scopeOptions = ref<string[]>([]);
const tableOptions = ref<string[]>([]);
const columnOptions = ref<string[]>([]);
const scopesLoading = ref(false);
const tablesLoading = ref(false);
const columnsLoading = ref(false);
const metadataError = ref("");

const ruleFilter = ref<"table" | "connection">("table");
const importPanelOpen = ref(false);
const importJsonText = ref("");
const importError = ref("");

let scopeRequestId = 0;
let tableRequestId = 0;
let columnRequestId = 0;

const defaultScope = computed(() => {
  if (props.databaseTreeHierarchy) return props.database || props.schema || "";
  return props.schema || props.database || "";
});

const sourceEndpoint = computed<VirtualForeignKeyEndpoint | null>(() => {
  const col = sourceColumn.value.trim();
  if (!props.tableName || !col) return null;
  return {
    ...(props.database ? { database: props.database } : {}),
    ...(!props.databaseTreeHierarchy && props.schema ? { schema: props.schema } : {}),
    table: props.tableName,
    column: col,
  };
});

const targetEndpoint = computed<VirtualForeignKeyEndpoint | null>(() => {
  const table = targetTable.value.trim();
  const column = targetColumn.value.trim();
  if (!table || !column) return null;
  const scope = targetScope.value.trim();
  if (props.databaseTreeHierarchy) {
    return {
      ...(scope ? { database: scope } : props.database ? { database: props.database } : {}),
      table,
      column,
    };
  }
  return {
    ...(props.database ? { database: props.database } : {}),
    ...(scope ? { schema: scope } : {}),
    table,
    column,
  };
});

const isSelfReference = computed(() => !!sourceEndpoint.value && !!targetEndpoint.value && virtualForeignKeyEndpointsEqual(sourceEndpoint.value, targetEndpoint.value));

const canSave = computed(() => !!props.connectionId && !!sourceEndpoint.value && !!targetEndpoint.value && !isSelfReference.value);

const tableScopedRules = computed(() =>
  virtualForeignKeysTouchingTable(props.rules, {
    connectionId: props.connectionId,
    database: props.database,
    schema: props.schema,
    tableName: props.tableName,
    databaseTreeHierarchy: props.databaseTreeHierarchy,
  }),
);

const displayedRules = computed(() => (ruleFilter.value === "table" ? tableScopedRules.value : props.rules));

async function loadScopes() {
  const reqId = ++scopeRequestId;
  scopesLoading.value = true;
  metadataError.value = "";
  const fallback = defaultScope.value;
  try {
    let names: string[] = [];
    if (props.connectionId) {
      if (props.databaseTreeHierarchy) {
        const databases = await api.listDatabases(props.connectionId);
        names = databases.map((db) => db.name);
      } else {
        names = await api.listSchemas(props.connectionId, props.database || "");
      }
    }
    if (reqId !== scopeRequestId || !props.open) return;
    const unique = [...new Set([fallback, ...names].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    scopeOptions.value = unique;
    if (!targetScope.value) targetScope.value = fallback || unique[0] || "";
  } catch (error: any) {
    if (reqId !== scopeRequestId) return;
    scopeOptions.value = fallback ? [fallback] : [];
    if (!targetScope.value) targetScope.value = fallback;
    metadataError.value = String(error?.message || error);
  } finally {
    if (reqId === scopeRequestId) scopesLoading.value = false;
  }
  if (reqId === scopeRequestId && props.open) {
    await loadTables();
  }
}

async function loadTables() {
  const reqId = ++tableRequestId;
  tableOptions.value = [];
  tablesLoading.value = true;
  metadataError.value = "";
  try {
    if (!props.connectionId) return;
    const targetDb = props.databaseTreeHierarchy ? targetScope.value || props.database || "" : props.database || "";
    const targetSch = props.databaseTreeHierarchy ? "" : targetScope.value || props.schema || "";
    const tables = await api.listTables(props.connectionId, targetDb, targetSch, undefined, undefined, undefined, undefined, props.catalog);
    if (reqId !== tableRequestId || !props.open) return;
    const names = [...new Set(tables.map((item) => item.name))].sort((a, b) => a.localeCompare(b));
    if (targetTable.value && !names.includes(targetTable.value)) names.unshift(targetTable.value);
    tableOptions.value = names;
  } catch (error: any) {
    if (reqId !== tableRequestId) return;
    metadataError.value = String(error?.message || error);
  } finally {
    if (reqId === tableRequestId) tablesLoading.value = false;
  }
}

async function loadTargetColumns() {
  const reqId = ++columnRequestId;
  columnOptions.value = [];
  if (!props.connectionId || !targetTable.value.trim()) return;
  columnsLoading.value = true;
  metadataError.value = "";
  try {
    const targetDb = props.databaseTreeHierarchy ? targetScope.value || props.database || "" : props.database || "";
    const targetSch = props.databaseTreeHierarchy ? targetScope.value || props.database || "" : targetScope.value || props.schema || "";
    const columns = await api.getColumns(props.connectionId, targetDb, targetSch, targetTable.value, props.catalog);
    if (reqId !== columnRequestId || !props.open) return;
    const names = columns.map((col) => col.name);
    if (targetColumn.value && !names.includes(targetColumn.value)) names.unshift(targetColumn.value);
    columnOptions.value = names;
    if (!targetColumn.value) {
      const pk = columns.find((col) => col.is_primary_key)?.name;
      targetColumn.value = pk ?? names[0] ?? "";
    }
  } catch (error: any) {
    if (reqId !== columnRequestId) return;
    metadataError.value = String(error?.message || error);
  } finally {
    if (reqId === columnRequestId) columnsLoading.value = false;
  }
}

function onSelectScope(value: unknown) {
  targetScope.value = String(value ?? "");
  targetTable.value = "";
  targetColumn.value = "";
  columnOptions.value = [];
  void loadTables();
}

function onSelectTargetTable(value: unknown) {
  targetTable.value = String(value ?? "");
  targetColumn.value = "";
  void loadTargetColumns();
}

function submitRule() {
  if (!canSave.value || !sourceEndpoint.value || !targetEndpoint.value) return;
  emit("save", {
    connectionId: props.connectionId,
    source: sourceEndpoint.value,
    target: targetEndpoint.value,
    bidirectional: bidirectional.value,
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
  });
  targetTable.value = "";
  targetColumn.value = "";
  columnOptions.value = [];
  note.value = "";
}

function copyExportJson() {
  emit("copy", exportPortableVirtualForeignKeyBundle(props.rules));
}

function applyImportJson() {
  importError.value = "";
  const parsed = parsePortableVirtualForeignKeyBundle(importJsonText.value);
  if (parsed.error) {
    importError.value = parsed.error;
    return;
  }
  if (parsed.rules.length === 0) {
    importError.value = t("grid.virtualForeignKeyImportEmpty");
    return;
  }
  emit("import-rules", parsed.rules);
  importJsonText.value = "";
  importPanelOpen.value = false;
}

watch(
  () => props.open,
  (isOpen) => {
    if (!isOpen) {
      scopeRequestId += 1;
      tableRequestId += 1;
      columnRequestId += 1;
      return;
    }
    sourceColumn.value = props.initialColumn || props.columns[0] || "";
    targetScope.value = defaultScope.value;
    targetTable.value = "";
    targetColumn.value = "";
    bidirectional.value = true;
    note.value = "";
    importPanelOpen.value = false;
    importJsonText.value = "";
    importError.value = "";
    metadataError.value = "";
    ruleFilter.value = "table";
    void loadScopes();
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent data-virtual-fk-dialog class="sm:max-w-[580px] max-h-[85vh] flex flex-col">
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <Link2 class="h-4 w-4 text-primary" />
          {{ t("grid.virtualForeignKeyDialogTitle") }}
        </DialogTitle>
        <DialogDescription>
          {{ t("grid.virtualForeignKeyDialogDescription") }}
        </DialogDescription>
      </DialogHeader>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto py-1 pr-0.5">
        <!-- Create relation section -->
        <div class="space-y-3 rounded-md border bg-muted/20 p-3">
          <div class="grid grid-cols-2 gap-3">
            <div class="min-w-0 space-y-1.5">
              <Label class="text-xs text-muted-foreground">{{ t("grid.virtualForeignKeySourceTable") }}</Label>
              <div class="flex h-8 items-center truncate rounded border bg-muted/40 px-2.5 font-mono text-xs" :title="tableName">
                {{ tableName }}
              </div>
            </div>
            <div class="min-w-0 space-y-1.5">
              <Label class="text-xs text-muted-foreground">{{ t("grid.virtualForeignKeySourceColumn") }}</Label>
              <SearchableSelect
                :model-value="sourceColumn"
                :options="columns"
                :placeholder="t('grid.virtualForeignKeySelectColumn')"
                :search-placeholder="t('grid.searchColumn')"
                :empty-text="t('grid.noColumnsFound')"
                :trigger-class="['border border-input h-8 pl-2.5 text-xs']"
                item-class="h-auto min-h-8 px-2 py-1.5 text-xs"
                @update:model-value="(value: unknown) => (sourceColumn = String(value ?? ''))"
              />
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2">
            <div class="min-w-0 space-y-1.5">
              <Label class="text-xs text-muted-foreground">
                {{ databaseTreeHierarchy ? t("grid.virtualForeignKeyTargetDatabase") : t("grid.formatterForeignKeySchema") }}
              </Label>
              <SearchableSelect
                :model-value="targetScope"
                :options="scopeOptions"
                :placeholder="scopesLoading ? t('common.loading') : t('grid.formatterForeignKeySchemaPlaceholder')"
                :search-placeholder="t('grid.formatterForeignKeySearchSchema')"
                :empty-text="t('grid.formatterForeignKeyNoSchemas')"
                :loading-text="t('common.loading')"
                :loading="scopesLoading"
                :trigger-class="['border border-input h-8 pl-2.5 text-xs']"
                item-class="h-auto min-h-8 px-2 py-1.5 text-xs"
                @update:model-value="onSelectScope"
              />
            </div>
            <div class="min-w-0 space-y-1.5">
              <Label class="text-xs text-muted-foreground">{{ t("grid.formatterForeignKeyTable") }}</Label>
              <SearchableSelect
                :model-value="targetTable"
                :options="tableOptions"
                :placeholder="tablesLoading ? t('common.loading') : t('grid.formatterForeignKeyTablePlaceholder')"
                :search-placeholder="t('grid.formatterForeignKeySearchTable')"
                :empty-text="t('grid.formatterForeignKeyNoTables')"
                :loading-text="t('common.loading')"
                :loading="tablesLoading"
                :trigger-class="['border border-input h-8 pl-2.5 text-xs']"
                item-class="h-auto min-h-8 px-2 py-1.5 text-xs"
                @update:model-value="onSelectTargetTable"
              />
            </div>
            <div class="min-w-0 space-y-1.5">
              <Label class="text-xs text-muted-foreground">{{ t("grid.formatterForeignKeyReferenceColumn") }}</Label>
              <SearchableSelect
                :model-value="targetColumn"
                :options="columnOptions"
                :placeholder="columnsLoading ? t('common.loading') : t('grid.virtualForeignKeySelectColumn')"
                :search-placeholder="t('grid.searchColumn')"
                :empty-text="t('grid.noColumnsFound')"
                :loading-text="t('common.loading')"
                :loading="columnsLoading"
                :trigger-class="['border border-input h-8 pl-2.5 text-xs']"
                item-class="h-auto min-h-8 px-2 py-1.5 text-xs"
                @update:model-value="(value: unknown) => (targetColumn = String(value ?? ''))"
              />
            </div>
          </div>

          <div class="flex flex-wrap items-center justify-between gap-3 pt-1">
            <label class="flex cursor-pointer items-center gap-2 text-xs">
              <Switch v-model="bidirectional" size="sm" />
              <span>{{ t("grid.virtualForeignKeyBidirectional") }}</span>
            </label>
            <div class="flex min-w-[200px] flex-1 items-center gap-2">
              <Input v-model="note" maxlength="200" class="h-7 text-xs" :placeholder="t('grid.virtualForeignKeyNotePlaceholder')" />
              <Button data-virtual-fk-add size="sm" class="h-7 shrink-0 gap-1 px-2.5 text-xs" :disabled="!canSave" @click="submitRule">
                <Plus class="h-3.5 w-3.5" />
                {{ t("grid.virtualForeignKeyAdd") }}
              </Button>
            </div>
          </div>

          <div v-if="isSelfReference" class="text-[11px] text-destructive">
            {{ t("grid.virtualForeignKeySelfReferenceError") }}
          </div>
          <div v-if="metadataError" class="rounded border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
            {{ metadataError }}
          </div>
        </div>

        <!-- Saved rules list -->
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-1 rounded-md border bg-muted/30 p-0.5 text-xs">
              <button type="button" class="rounded px-2 py-0.5 transition-colors" :class="ruleFilter === 'table' ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'" @click="ruleFilter = 'table'">
                {{ t("grid.virtualForeignKeyCurrentTable", { count: tableScopedRules.length }) }}
              </button>
              <button type="button" class="rounded px-2 py-0.5 transition-colors" :class="ruleFilter === 'connection' ? 'bg-background font-medium text-foreground shadow-xs' : 'text-muted-foreground hover:text-foreground'" @click="ruleFilter = 'connection'">
                {{ t("grid.virtualForeignKeyAllConnection", { count: rules.length }) }}
              </button>
            </div>
            <div class="flex items-center gap-1.5">
              <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-xs" :disabled="rules.length === 0" @click="copyExportJson">
                <Copy class="h-3 w-3" />
                {{ t("grid.virtualForeignKeyExportJson") }}
              </Button>
              <Button variant="outline" size="sm" class="h-7 gap-1 px-2 text-xs" @click="importPanelOpen = !importPanelOpen">
                <Upload class="h-3 w-3" />
                {{ t("grid.virtualForeignKeyImportJson") }}
              </Button>
            </div>
          </div>

          <div v-if="importPanelOpen" class="space-y-2 rounded-md border bg-muted/20 p-2.5">
            <textarea v-model="importJsonText" data-virtual-fk-import-input rows="5" spellcheck="false" class="w-full rounded border bg-background p-2 font-mono text-xs outline-none focus:border-primary" :placeholder="t('grid.virtualForeignKeyImportPlaceholder')" />
            <div v-if="importError" class="text-[11px] text-destructive">{{ importError }}</div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="sm" class="h-7 text-xs" @click="importPanelOpen = false">
                {{ t("dangerDialog.cancel") }}
              </Button>
              <Button data-virtual-fk-import-submit size="sm" class="h-7 text-xs" :disabled="!importJsonText.trim()" @click="applyImportJson">
                {{ t("grid.virtualForeignKeyImportApply") }}
              </Button>
            </div>
          </div>

          <div v-if="displayedRules.length === 0" class="rounded-md border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">
            {{ t("grid.virtualForeignKeyEmpty") }}
          </div>
          <div v-else class="max-h-56 space-y-1.5 overflow-y-auto">
            <div v-for="rule in displayedRules" :key="rule.id" data-virtual-fk-rule-row class="flex items-center justify-between gap-2 rounded-md border bg-background px-2.5 py-2 text-xs">
              <div class="min-w-0 flex-1 space-y-0.5">
                <div class="flex items-center gap-1.5 font-mono">
                  <span class="truncate" :title="formatVirtualForeignKeyEndpoint(rule.source)">{{ formatVirtualForeignKeyEndpoint(rule.source) }}</span>
                  <ArrowLeftRight v-if="rule.bidirectional" class="h-3 w-3 shrink-0 text-primary" />
                  <ArrowRight v-else class="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span class="truncate" :title="formatVirtualForeignKeyEndpoint(rule.target)">{{ formatVirtualForeignKeyEndpoint(rule.target) }}</span>
                </div>
                <div v-if="rule.note" class="truncate text-[11px] text-muted-foreground">{{ rule.note }}</div>
              </div>
              <Button variant="ghost" size="icon" class="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive" :title="t('grid.virtualForeignKeyRemove')" @click="emit('remove', rule.id)">
                <Trash2 class="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" size="sm" @click="emit('update:open', false)">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

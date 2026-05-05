<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import {
  Dialog, DialogHeader, DialogTitle, DialogFooter, DialogScrollContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Check, FileUp, Loader2, Square, Upload, X,
} from "lucide-vue-next";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { autoMapImportColumns } from "@/lib/tableImport";
import type { ColumnInfo } from "@/types/database";
import * as api from "@/lib/api";

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

const SKIP_VALUE = "__skip__";
const targetColumns = ref<ColumnInfo[]>([]);
const preview = ref<api.TableImportPreview | null>(null);
const columnMapping = ref<Record<string, string>>({});
const loadingTarget = ref(false);
const loadingPreview = ref(false);
const importMode = ref<api.TableImportMode>("append");
const batchSize = ref(500);
const running = ref(false);
const cancelling = ref(false);
const importId = ref("");
const progress = ref<api.TableImportProgress | null>(null);
const errorMessage = ref("");

const selectedConnection = computed(() =>
  props.prefillConnectionId ? store.getConfig(props.prefillConnectionId) : undefined
);
const targetColumnNames = computed(() => targetColumns.value.map((column) => column.name));
const mappedColumns = computed<api.TableImportColumnMapping[]>(() => {
  const currentPreview = preview.value;
  if (!currentPreview) return [];
  return currentPreview.columns
    .map((sourceColumn) => ({
      sourceColumn,
      targetColumn: columnMapping.value[sourceColumn] ?? "",
    }))
    .filter((mapping) => mapping.targetColumn);
});
const mappedCount = computed(() => mappedColumns.value.length);
const canImport = computed(() =>
  !!preview.value &&
  !!props.prefillConnectionId &&
  !!props.prefillTable &&
  mappedColumns.value.length > 0 &&
  !running.value
);
const progressPercent = computed(() => {
  const p = progress.value;
  if (!p || p.totalRows <= 0) return 0;
  return Math.min(100, Math.round((p.rowsImported / p.totalRows) * 100));
});
const targetLabel = computed(() => {
  const pieces = [selectedConnection.value?.name, props.prefillDatabase, props.prefillSchema, props.prefillTable]
    .filter(Boolean);
  return pieces.join(" / ");
});

function resetState() {
  targetColumns.value = [];
  preview.value = null;
  columnMapping.value = {};
  importMode.value = "append";
  batchSize.value = 500;
  running.value = false;
  cancelling.value = false;
  importId.value = "";
  progress.value = null;
  errorMessage.value = "";
}

function applyAutoMapping() {
  const currentPreview = preview.value;
  if (!currentPreview) return;
  columnMapping.value = autoMapImportColumns(currentPreview.columns, targetColumnNames.value);
}

async function loadTargetColumns() {
  if (!props.prefillConnectionId || !props.prefillDatabase || !props.prefillTable) return;
  loadingTarget.value = true;
  errorMessage.value = "";
  try {
    await store.ensureConnected(props.prefillConnectionId);
    targetColumns.value = await api.getColumns(
      props.prefillConnectionId,
      props.prefillDatabase,
      props.prefillSchema || props.prefillDatabase,
      props.prefillTable,
    );
    applyAutoMapping();
  } catch (e: any) {
    errorMessage.value = String(e?.message || e);
  } finally {
    loadingTarget.value = false;
  }
}

async function selectFile() {
  if (!isTauriRuntime()) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Data files", extensions: ["csv", "tsv", "json", "xlsx", "xlsm", "xls"] },
      { name: "CSV", extensions: ["csv", "tsv"] },
      { name: "JSON", extensions: ["json"] },
      { name: "Excel", extensions: ["xlsx", "xlsm", "xls"] },
    ],
  });
  if (!selected || Array.isArray(selected)) return;

  loadingPreview.value = true;
  errorMessage.value = "";
  try {
    preview.value = await api.previewTableImportFile(selected);
    applyAutoMapping();
  } catch (e: any) {
    preview.value = null;
    columnMapping.value = {};
    errorMessage.value = String(e?.message || e);
  } finally {
    loadingPreview.value = false;
  }
}

function updateMapping(sourceColumn: string, value: any) {
  const target = String(value);
  columnMapping.value = {
    ...columnMapping.value,
    [sourceColumn]: target === SKIP_VALUE ? "" : target,
  };
}

function formatCell(value: unknown) {
  if (value === null) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

async function startImport() {
  const currentPreview = preview.value;
  if (!canImport.value || !currentPreview || !props.prefillConnectionId || !props.prefillTable) return;
  running.value = true;
  cancelling.value = false;
  errorMessage.value = "";
  importId.value = crypto.randomUUID();
  progress.value = {
    importId: importId.value,
    status: "running",
    rowsImported: 0,
    totalRows: currentPreview.totalRows,
  };

  try {
    const summary = await api.importTableFile({
      importId: importId.value,
      connectionId: props.prefillConnectionId,
      database: props.prefillDatabase || "",
      schema: props.prefillSchema || "",
      table: props.prefillTable,
      filePath: currentPreview.filePath,
      mappings: mappedColumns.value,
      mode: importMode.value,
      batchSize: Math.max(1, Number(batchSize.value) || 500),
    }, (nextProgress) => {
      progress.value = nextProgress;
    });
    toast(t("tableImport.success", { count: summary.rowsImported }), 2500);
    open.value = false;
  } catch (e: any) {
    errorMessage.value = String(e?.message || e);
  } finally {
    running.value = false;
    cancelling.value = false;
  }
}

async function cancelImport() {
  if (!importId.value) return;
  cancelling.value = true;
  await api.cancelTableImport(importId.value);
}

watch(open, (value) => {
  if (value) {
    resetState();
    void loadTargetColumns();
  }
});
</script>

<template>
  <Dialog v-model:open="open">
    <DialogScrollContent class="sm:max-w-[760px]" :trap-focus="false" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <FileUp class="h-4 w-4" />
          {{ t('tableImport.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="space-y-4 py-2">
        <div class="grid grid-cols-[1fr_auto] gap-2">
          <div class="min-w-0 rounded-md border bg-muted/20 px-3 py-2">
            <div class="truncate text-xs text-muted-foreground">{{ t('tableImport.target') }}</div>
            <div class="truncate text-sm font-medium">{{ targetLabel || t('editor.noDatabase') }}</div>
          </div>
          <Button variant="outline" size="sm" :disabled="running || loadingPreview" @click="selectFile">
            <Loader2 v-if="loadingPreview" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            <Upload v-else class="mr-1.5 h-3.5 w-3.5" />
            {{ t('tableImport.selectFile') }}
          </Button>
        </div>

        <div v-if="preview" class="grid grid-cols-3 gap-2 text-xs">
          <div class="rounded-md border px-3 py-2">
            <div class="text-muted-foreground">{{ t('tableImport.file') }}</div>
            <div class="truncate font-medium">{{ preview.fileName }}</div>
          </div>
          <div class="rounded-md border px-3 py-2">
            <div class="text-muted-foreground">{{ t('tableImport.rows') }}</div>
            <div class="font-medium">{{ preview.totalRows.toLocaleString() }}</div>
          </div>
          <div class="rounded-md border px-3 py-2">
            <div class="text-muted-foreground">{{ t('tableImport.mapped') }}</div>
            <div class="font-medium">{{ mappedCount }} / {{ preview.columns.length }}</div>
          </div>
        </div>

        <div v-if="preview" class="grid grid-cols-[minmax(220px,280px)_1fr] gap-3">
          <div class="rounded-md border">
            <div class="border-b px-3 py-2 text-xs font-medium">{{ t('tableImport.mapping') }}</div>
            <div class="max-h-[280px] overflow-auto p-2">
              <div
                v-for="sourceColumn in preview.columns"
                :key="sourceColumn"
                class="grid grid-cols-[1fr_1fr] items-center gap-2 py-1"
              >
                <div class="truncate font-mono text-xs" :title="sourceColumn">{{ sourceColumn }}</div>
                <Select
                  :model-value="columnMapping[sourceColumn] || SKIP_VALUE"
                  @update:model-value="(value: any) => updateMapping(sourceColumn, value)"
                >
                  <SelectTrigger class="h-7 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem :value="SKIP_VALUE">{{ t('tableImport.skipColumn') }}</SelectItem>
                    <SelectItem v-for="column in targetColumns" :key="column.name" :value="column.name">
                      {{ column.name }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div class="min-w-0 rounded-md border">
            <div class="border-b px-3 py-2 text-xs font-medium">{{ t('tableImport.preview') }}</div>
            <div class="max-h-[280px] overflow-auto">
              <table class="min-w-full border-separate border-spacing-0 text-xs">
                <thead class="sticky top-0 bg-background">
                  <tr>
                    <th
                      v-for="column in preview.columns"
                      :key="column"
                      class="border-b border-r px-2 py-1.5 text-left font-medium"
                    >
                      <span class="block max-w-[140px] truncate">{{ column }}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, rowIndex) in preview.rows" :key="rowIndex">
                    <td
                      v-for="(cell, colIndex) in row"
                      :key="colIndex"
                      class="max-w-[180px] border-b border-r px-2 py-1.5 font-mono"
                      :class="{ 'text-muted-foreground': cell === null }"
                    >
                      <span class="block truncate">{{ formatCell(cell) }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div v-if="preview" class="grid grid-cols-3 gap-3">
          <div class="space-y-1.5">
            <Label class="text-xs">{{ t('tableImport.mode') }}</Label>
            <Select :model-value="importMode" @update:model-value="(value: any) => importMode = value">
              <SelectTrigger class="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="append">{{ t('tableImport.append') }}</SelectItem>
                <SelectItem value="truncate">{{ t('tableImport.truncate') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">{{ t('transfer.batchSize') }}</Label>
            <Input v-model.number="batchSize" type="number" min="1" class="h-8 text-xs" />
          </div>
          <div v-if="running || progress" class="space-y-1.5">
            <Label class="text-xs">{{ t('tableImport.progress') }}</Label>
            <div class="h-8 rounded-md border px-2 text-xs flex items-center gap-2">
              <Loader2 v-if="running && !cancelling" class="h-3.5 w-3.5 animate-spin text-primary" />
              <Square v-else-if="cancelling" class="h-3.5 w-3.5 fill-current text-destructive" />
              <Check v-else class="h-3.5 w-3.5 text-emerald-600" />
              <span class="truncate">
                {{ progress?.rowsImported ?? 0 }} / {{ progress?.totalRows ?? preview.totalRows }} · {{ progressPercent }}%
              </span>
            </div>
          </div>
        </div>

        <div v-if="loadingTarget" class="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 class="h-3.5 w-3.5 animate-spin" />
          {{ t('common.loading') }}
        </div>
        <div v-if="errorMessage" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {{ errorMessage }}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" :disabled="running" @click="open = false">
          <X class="mr-1.5 h-3.5 w-3.5" />
          {{ t('dangerDialog.cancel') }}
        </Button>
        <Button v-if="running" variant="destructive" :disabled="cancelling" @click="cancelImport">
          <Loader2 v-if="cancelling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
          <Square v-else class="mr-1.5 h-3.5 w-3.5 fill-current" />
          {{ t('sqlFile.cancel') }}
        </Button>
        <Button v-else :disabled="!canImport" @click="startImport">
          <Upload class="mr-1.5 h-3.5 w-3.5" />
          {{ t('tableImport.start') }}
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>

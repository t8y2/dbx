<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertTriangle, ArrowLeft, ArrowRight, FileUp, Loader2, Square, Upload, X } from "@lucide/vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { TABLE_IMPORT_ENCODING_OPTIONS } from "@/lib/table/tableImport";
import { importPreviewInput, importSourceDisplayName, importTextDelimiterForName, uploadedImportSourceFromPreview, type UploadedImportSource } from "@/lib/import/importSource";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";

const { t } = useI18n();
const store = useConnectionStore();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  connectionId: string;
  database: string;
  collection: string;
}>();

const emit = defineEmits<{ completed: [] }>();

type WizardStep = "source" | "confirm" | "execution";

const fileInput = ref<HTMLInputElement | null>(null);
const selectedSource = ref<string | File | null>(null);
const sourceName = ref("");
const format = ref<api.MongoImportFormat>("csv");
const encoding = ref<api.TableImportTextEncoding>("auto");
const delimiter = ref(",");
const hasHeader = ref(true);
const trim = ref(false);
const emptyAsNull = ref(true);
const typeMode = ref<api.MongoImportTypeMode>("auto");
const recognizeObjectIdHex = ref(false);
const skipErrorRows = ref(false);
const batchSize = ref(500);
const previewLimit = ref(50);
const preview = ref<api.MongoImportPreview | null>(null);
const loadingPreview = ref(false);
const previewError = ref("");
const wizardStep = ref<WizardStep>("source");
const running = ref(false);
const cancelling = ref(false);
const closeBlocked = ref(false);
const importId = ref("");
const progress = ref<api.MongoImportProgress | null>(null);
const errorMessage = ref("");
let previewRequestId = 0;
let previewReloadTimer: ReturnType<typeof setTimeout> | null = null;
let uploadedSource: UploadedImportSource | null = null;

const connection = computed(() => store.getConfig(props.connectionId));
const effectivelyReadOnly = computed(() => connectionIsEffectivelyReadOnly(connection.value));
const fileLabel = computed(() => sourceName.value || t("tableImport.noFileSelected"));
const encodingOptions = TABLE_IMPORT_ENCODING_OPTIONS;
const targetLabel = computed(() => `${props.database}.${props.collection}`);

const parseOptions = computed(
  (): api.MongoImportParseOptions => ({
    encoding: encoding.value,
    delimiter: delimiter.value,
    hasHeader: hasHeader.value,
    trim: trim.value,
    emptyAsNull: emptyAsNull.value,
    typeMode: typeMode.value,
    recognizeObjectIdHex: recognizeObjectIdHex.value,
    skipErrorRows: skipErrorRows.value,
  }),
);

function formatFromName(name: string): api.MongoImportFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith(".ndjson") || lower.endsWith(".jsonl")) return "ndjson";
  if (lower.endsWith(".json")) return "json";
  return "csv";
}

function releasePreviewSource() {
  const sourceRef = uploadedSource?.sourceRef;
  uploadedSource = null;
  preview.value = null;
  if (sourceRef) void api.releaseMongodbImportSource(sourceRef);
}

function assignSource(source: string | File) {
  releasePreviewSource();
  selectedSource.value = source;
  sourceName.value = importSourceDisplayName(source);
  format.value = formatFromName(sourceName.value);
  typeMode.value = format.value === "csv" ? "auto" : "extendedJson";
  delimiter.value = importTextDelimiterForName(sourceName.value);
  wizardStep.value = "source";
  queuePreview();
}

async function selectFile() {
  if (!isTauriRuntime()) {
    fileInput.value?.click();
    return;
  }
  const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
  const selected = await openDialog({
    multiple: false,
    filters: [{ name: t("mongo.import.fileFilter"), extensions: ["csv", "json", "ndjson", "jsonl", "tsv"] }],
  });
  if (!selected || Array.isArray(selected)) return;
  assignSource(selected);
}

function handleFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (file) assignSource(file);
}

function queuePreview() {
  if (!selectedSource.value) return;
  if (previewReloadTimer) clearTimeout(previewReloadTimer);
  previewReloadTimer = setTimeout(() => {
    void loadPreview();
  }, 200);
}

async function loadPreview() {
  const source = selectedSource.value;
  if (!source) return;
  const requestId = ++previewRequestId;
  loadingPreview.value = true;
  previewError.value = "";
  try {
    const input = importPreviewInput(uploadedSource, source);
    const next = await api.previewMongodbImportFile(input.fileOrPath, {
      format: format.value,
      parseOptions: parseOptions.value,
      previewLimit: previewLimit.value,
      sourceRef: input.sourceRef,
    });
    if (requestId !== previewRequestId) return;
    preview.value = next;
    uploadedSource = uploadedImportSourceFromPreview(next) ?? uploadedSource;
  } catch (error) {
    if (requestId !== previewRequestId) return;
    previewError.value = error instanceof Error ? error.message : String(error);
    if (!uploadedSource) preview.value = null;
  } finally {
    if (requestId === previewRequestId) loadingPreview.value = false;
  }
}

watch([format, encoding, delimiter, hasHeader, trim, emptyAsNull, typeMode, recognizeObjectIdHex, previewLimit], () => {
  if (selectedSource.value) queuePreview();
});

watch(open, (value) => {
  if (value) return;
  if (running.value) {
    closeBlocked.value = true;
    open.value = true;
    return;
  }
  reset();
});

function reset() {
  releasePreviewSource();
  selectedSource.value = null;
  sourceName.value = "";
  previewError.value = "";
  wizardStep.value = "source";
  running.value = false;
  cancelling.value = false;
  closeBlocked.value = false;
  progress.value = null;
  errorMessage.value = "";
  importId.value = "";
}

function canConfirm() {
  return !!preview.value && !loadingPreview.value && !previewError.value && !effectivelyReadOnly.value && (!preview.value.errors.length || skipErrorRows.value);
}

async function startImport() {
  const source = selectedSource.value;
  const currentPreview = preview.value;
  if (!source || !currentPreview) return;
  const reviewText = `db.${props.collection}.insertMany(/* ${currentPreview.estimatedRows ?? "?"} documents from ${sourceName.value} */)`;
  const started = await executeWithProductionContextGuard({
    connection: connection.value,
    database: props.database,
    reviewText,
    source: t("readOnlyUnlock.sourceMongoImport"),
    execute: async () => true,
  });
  if (!started) return;
  running.value = true;
  wizardStep.value = "execution";
  errorMessage.value = "";
  importId.value = uuid();
  try {
    const filePath = typeof source === "string" ? source : currentPreview.filePath;
    const size = Math.min(5000, Math.max(100, Math.trunc(Number(batchSize.value)) || 500));
    batchSize.value = size;
    await api.importMongodbFile(
      {
        importId: importId.value,
        connectionId: props.connectionId,
        database: props.database,
        collection: props.collection,
        filePath,
        sourceRef: currentPreview.sourceRef,
        format: format.value,
        parseOptions: parseOptions.value,
        batchSize: size,
      },
      (next) => {
        progress.value = next;
      },
    );
    if (currentPreview.sourceRef) {
      await api.releaseMongodbImportSource(currentPreview.sourceRef);
      if (uploadedSource?.sourceRef === currentPreview.sourceRef) uploadedSource = null;
      if (preview.value?.sourceRef === currentPreview.sourceRef) preview.value = { ...preview.value, sourceRef: null };
    }
    toast(t("mongo.import.success", { count: progress.value?.rowsInserted ?? 0 }));
    store.mongoImportCompleted = {
      connectionId: props.connectionId,
      database: props.database,
      collection: props.collection,
      at: Date.now(),
    };
    emit("completed");
    running.value = false;
    open.value = false;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : String(error);
    running.value = false;
  } finally {
    cancelling.value = false;
  }
}

async function cancelImport() {
  if (!importId.value) return;
  cancelling.value = true;
  await api.cancelMongodbImport(importId.value);
}

function formatPreviewCell(value: unknown) {
  if (value == null) return "null";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function setFormat(value: unknown) {
  if (value === "csv" || value === "json" || value === "ndjson") format.value = value;
}

function setEncoding(value: unknown) {
  if (value === "auto" || value === "utf8" || value === "gbk" || value === "utf16Le" || value === "utf16Be") encoding.value = value;
}

function setTypeMode(value: unknown) {
  if (value === "string" || value === "auto" || value === "extendedJson") typeMode.value = value;
}

function requestClose() {
  if (running.value) {
    closeBlocked.value = true;
    return;
  }
  open.value = false;
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!value) requestClose();
        else open = true;
      }
    "
  >
    <DialogScrollContent class="flex max-h-[calc(var(--dbx-viewport-height)-6rem)] min-h-0 flex-col overflow-hidden sm:max-w-[980px]" aria-labelledby="mongo-import-title">
      <DialogHeader class="shrink-0 pr-8">
        <DialogTitle id="mongo-import-title" class="flex items-center gap-2 text-base">
          <FileUp class="h-4 w-4" />
          {{ t("mongo.import.title") }}
        </DialogTitle>
      </DialogHeader>
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto py-2 pr-1 text-sm">
        <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
          <input ref="fileInput" type="file" class="hidden" accept=".csv,.json,.ndjson,.jsonl,.tsv" @change="handleFileInputChange" />
          <div class="flex h-10 min-w-0 items-center gap-2 rounded-md border bg-muted/20 px-3">
            <span class="shrink-0 text-xs text-muted-foreground">{{ t("mongo.import.target") }}</span>
            <span class="min-w-0 truncate text-sm font-medium">{{ targetLabel }}</span>
          </div>
          <Button variant="outline" class="h-10 px-3" :disabled="running || loadingPreview || wizardStep === 'execution'" @click="selectFile">
            <Loader2 v-if="loadingPreview" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            <Upload v-else class="mr-1.5 h-3.5 w-3.5" />
            {{ selectedSource ? t("tableImport.changeFile") : t("tableImport.selectFile") }}
          </Button>
        </div>
        <div v-if="effectivelyReadOnly" class="text-xs text-amber-600">{{ t("mongo.import.readonly") }}</div>

        <div v-if="wizardStep === 'source'" class="space-y-3">
          <div class="grid grid-cols-3 gap-3 rounded-md border p-3">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.sourceFormat") }}</Label>
              <Select :model-value="format" @update:model-value="setFormat">
                <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="json">JSON</SelectItem>
                  <SelectItem value="ndjson">NDJSON</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.encoding") }}</Label>
              <Select :model-value="encoding" @update:model-value="setEncoding">
                <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="option in encodingOptions" :key="option.value" :value="option.value">{{ t(option.labelKey) }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div v-if="format === 'csv'" class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.delimiter") }}</Label>
              <Input v-model="delimiter" class="h-8 text-xs font-mono" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("mongo.import.typeMode") }}</Label>
              <Select :model-value="typeMode" @update:model-value="setTypeMode">
                <SelectTrigger class="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="string">{{ t("mongo.import.typeString") }}</SelectItem>
                  <SelectItem value="auto">{{ t("mongo.import.typeAuto") }}</SelectItem>
                  <SelectItem value="extendedJson">{{ t("mongo.import.typeExtendedJson") }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("mongo.import.batchSize") }}</Label>
              <Input v-model.number="batchSize" type="number" min="100" max="5000" class="h-8 text-xs" />
            </div>
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("tableImport.sourceFile") }}</Label>
              <div class="flex h-8 items-center rounded-md border px-2 text-xs">
                <span class="truncate">{{ fileLabel }}</span>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-x-4 gap-y-2 rounded-md border p-3">
            <label class="flex items-center gap-2 text-xs"><input v-model="hasHeader" type="checkbox" class="h-3.5 w-3.5 accent-primary" /> {{ t("tableImport.hasHeader") }}</label>
            <label class="flex items-center gap-2 text-xs"><input v-model="trim" type="checkbox" class="h-3.5 w-3.5 accent-primary" /> {{ t("tableImport.trimValues") }}</label>
            <label class="flex items-center gap-2 text-xs"><input v-model="emptyAsNull" type="checkbox" class="h-3.5 w-3.5 accent-primary" /> {{ t("mongo.import.emptyAsNull") }}</label>
            <label class="flex items-center gap-2 text-xs"><input v-model="recognizeObjectIdHex" type="checkbox" class="h-3.5 w-3.5 accent-primary" /> {{ t("mongo.import.recognizeObjectIdHex") }}</label>
            <label class="flex items-center gap-2 text-xs"><input v-model="skipErrorRows" type="checkbox" class="h-3.5 w-3.5 accent-primary" /> {{ t("mongo.import.skipErrorRows") }}</label>
          </div>

          <div v-if="loadingPreview" class="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 class="h-3.5 w-3.5 animate-spin" />
            {{ t("mongo.import.previewing") }}
          </div>
          <div v-else-if="previewError" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ previewError }}</div>
          <div v-else-if="preview" class="space-y-2">
            <div class="text-xs text-muted-foreground">{{ t("mongo.import.estimatedRows", { count: preview.estimatedRows ?? 0 }) }}</div>
            <div class="max-h-56 overflow-auto rounded-md border">
              <table class="w-full text-xs">
                <thead>
                  <tr>
                    <th class="border-b px-2 py-1 text-left">#</th>
                    <th v-for="column in preview.columns" :key="column.name" class="border-b px-2 py-1 text-left">
                      {{ column.name }}
                      <span class="text-muted-foreground">({{ column.inferredType }})</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(row, index) in preview.rows" :key="index">
                    <td class="border-b px-2 py-1">{{ preview.rowNumbers?.[index] ?? index + 1 }}</td>
                    <td v-for="column in preview.columns" :key="column.name" class="border-b px-2 py-1 font-mono">
                      {{ formatPreviewCell(row[column.name]) }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div v-if="preview.errors.length" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <div v-for="(issue, index) in preview.errors" :key="index">{{ issue.message }}</div>
            </div>
          </div>
        </div>

        <div v-else-if="wizardStep === 'confirm'" class="space-y-2 text-sm">
          <div>{{ t("mongo.import.confirmAppend") }}</div>
          <div>{{ t("mongo.import.batchSize") }}: {{ batchSize }}</div>
          <div>{{ t("mongo.import.duplicateIdPolicy") }}</div>
        </div>

        <div v-else-if="wizardStep === 'execution'" class="space-y-2 text-sm">
          <div>{{ t("mongo.import.phase." + (progress?.phase ?? "preparing")) }}</div>
          <div>{{ t("mongo.import.rowsRead") }}: {{ progress?.rowsRead ?? 0 }}</div>
          <div>{{ t("mongo.import.rowsInserted") }}: {{ progress?.rowsInserted ?? 0 }}</div>
          <div>{{ t("mongo.import.rowsFailed") }}: {{ progress?.rowsFailed ?? 0 }}</div>
          <div>{{ t("mongo.import.batchesCommitted") }}: {{ progress?.batchesCommitted ?? 0 }}</div>
          <div v-if="errorMessage" class="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ errorMessage }}</div>
          <div v-if="closeBlocked" class="flex items-center gap-2 text-amber-600">
            <AlertTriangle class="h-4 w-4" />
            {{ t("mongo.import.stillRunning") }}
          </div>
        </div>
      </div>
      <DialogFooter class="shrink-0">
        <Button v-if="wizardStep === 'execution' && running" variant="destructive" :disabled="cancelling" @click="cancelImport">
          <Loader2 v-if="cancelling" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
          <Square v-else class="mr-1.5 h-3.5 w-3.5 fill-current" />
          {{ t("sqlFile.cancel") }}
        </Button>
        <Button v-else variant="outline" @click="requestClose">
          <X class="mr-1.5 h-3.5 w-3.5" />
          {{ t("common.close") }}
        </Button>
        <Button v-if="wizardStep === 'confirm'" variant="outline" @click="wizardStep = 'source'">
          <ArrowLeft class="mr-1.5 h-3.5 w-3.5" />
          {{ t("tableImport.back") }}
        </Button>
        <Button v-if="wizardStep === 'source'" :disabled="!canConfirm()" @click="wizardStep = 'confirm'">
          <ArrowRight class="mr-1.5 h-3.5 w-3.5" />
          {{ t("tableImport.next") }}
        </Button>
        <Button v-if="wizardStep === 'confirm'" :disabled="effectivelyReadOnly" @click="startImport">
          <Upload class="mr-1.5 h-3.5 w-3.5" />
          {{ t("tableImport.start") }}
        </Button>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>

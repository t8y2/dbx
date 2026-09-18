<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, ArrowRight, DatabaseBackup, FolderOpen, Loader2, Play, Square, X } from "@lucide/vue";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";

const props = defineProps<{ connectionId: string; database: string; mode: "dump" | "restore" }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const store = useConnectionStore();
const desktop = isTauriRuntime();
const restoring = computed(() => props.mode === "restore");
const connection = computed(() => store.getConfig(props.connectionId));
const readonly = computed(() => restoring.value && connectionIsEffectivelyReadOnly(connection.value));
const format = ref<api.MongoDumpFormat>("archive");
const gzip = ref(false);
const catalog = ref<api.MongoDumpCatalog | null>(null);
const sourceRef = ref<string | null>(null);
const source = ref<api.MongoDumpSourceInput | null>(null);
const sourceName = ref("");
const sourceDatabase = ref("");
const targetDatabase = ref(props.database);
const outputPath = ref(desktop ? "" : `${props.database}.archive`);
const selected = ref<string[]>([]);
const dropExisting = ref(false);
const restoreOptions = ref(true);
const restoreIndexes = ref(true);
const stopOnError = ref(true);
const objcheck = ref(false);
const batchSize = ref(500);
const loading = ref(false);
const confirming = ref(false);
const running = ref(false);
const cancelling = ref(false);
const error = ref("");
const step = ref<"configure" | "confirm" | "result">("configure");
const progress = ref<api.MongoDatabaseDumpProgress | null>(null);
const taskId = ref("");
const fileInput = ref<HTMLInputElement | null>(null);
let generation = 0;
let readController: AbortController | null = null;
let uploadController: AbortController | null = null;
const readUpload = ref<{ loaded: number; total: number } | null>(null);
function gib(value: number) {
  return (value / 1024 ** 3).toFixed(2);
}

const entries = computed(() => catalog.value?.collections.filter((entry) => !restoring.value || entry.database === sourceDatabase.value) ?? []);
const allSelected = computed(() => entries.value.length > 0 && selected.value.length === entries.value.length);
const canReview = computed(
  () =>
    !!catalog.value &&
    !loading.value &&
    !confirming.value &&
    !running.value &&
    !readonly.value &&
    (entries.value.length === 0 || selected.value.length > 0) &&
    (restoring.value ? !!sourceRef.value && !!targetDatabase.value.trim() && (!catalog.value.databases.length || catalog.value.databases.includes(sourceDatabase.value)) : !!outputPath.value.trim()),
);

function releaseSource() {
  const reference = sourceRef.value;
  sourceRef.value = null;
  if (reference) void api.releaseMongodbRestoreSource(reference);
}
function invalidate() {
  generation += 1;
  releaseSource();
  catalog.value = null;
  selected.value = [];
  error.value = "";
  step.value = "configure";
}
function cleanup() {
  generation += 1;
  readController?.abort();
  if (!running.value) releaseSource();
}
onBeforeUnmount(cleanup);
watch(
  open,
  async (value) => {
    if (!value) {
      cleanup();
      return;
    }
    if (restoring.value) return;
    const current = ++generation;
    loading.value = true;
    try {
      await store.ensureConnected(props.connectionId);
      const result = await api.inspectMongodbDatabaseDump(props.connectionId, props.database);
      if (current !== generation) return;
      catalog.value = result;
      selected.value = result.collections.map((entry) => entry.name);
    } catch (cause) {
      if (current === generation) error.value = String(cause instanceof Error ? cause.message : cause);
    } finally {
      if (current === generation) loading.value = false;
    }
  },
  { immediate: true },
);
watch([format, gzip], () => {
  if (restoring.value) invalidate();
  else outputPath.value = desktop ? "" : `${props.database}.archive${gzip.value ? ".gz" : ""}`;
});
watch(format, () => {
  if (restoring.value) {
    source.value = null;
    sourceName.value = "";
  }
});

function setFormat(value: unknown) {
  if (value === "directory" || value === "archive") format.value = value;
}
function setSourceDatabase(value: unknown) {
  if (typeof value !== "string") return;
  sourceDatabase.value = value;
  selected.value = entries.value.map((entry) => entry.name);
}
function selectAll(event: Event) {
  selected.value = (event.target as HTMLInputElement).checked ? entries.value.map((entry) => entry.name) : [];
}
function selectCollection(name: string, event: Event) {
  selected.value = (event.target as HTMLInputElement).checked ? [...selected.value, name] : selected.value.filter((value) => value !== name);
}

async function chooseSource() {
  if (!desktop) {
    fileInput.value?.click();
    return;
  }
  const { open: choose } = await import("@tauri-apps/plugin-dialog");
  const path = await choose({ directory: format.value === "directory", multiple: false });
  if (typeof path === "string") {
    invalidate();
    source.value = path;
    sourceName.value = path;
  }
}
function chooseFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (!files.length) return;
  invalidate();
  source.value = format.value === "directory" ? files : files[0]!;
  sourceName.value = format.value === "directory" ? `${(files[0]!.webkitRelativePath || files[0]!.name).split("/")[0]} (${files.length})` : files[0]!.name;
}
async function readSource() {
  if (!source.value) return;
  releaseSource();
  const current = ++generation;
  loading.value = true;
  error.value = "";
  catalog.value = null;
  readUpload.value = null;
  readController = new AbortController();
  try {
    const result = await api.prepareMongodbRestoreSource(source.value, format.value, gzip.value, {
      signal: readController.signal,
      onUploadProgress: (loaded, total) => {
        readUpload.value = { loaded, total };
      },
    });
    if (current !== generation) {
      void api.releaseMongodbRestoreSource(result.sourceRef);
      return;
    }
    sourceRef.value = result.sourceRef;
    catalog.value = result;
    setSourceDatabase(result.databases.length === 1 ? result.databases[0] : "");
  } catch (cause) {
    if (current === generation) error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    if (current === generation) loading.value = false;
    readController = null;
  }
}
async function chooseDestination() {
  const { open: choose, save } = await import("@tauri-apps/plugin-dialog");
  if (format.value === "directory") {
    const parent = await choose({ directory: true, multiple: false });
    if (typeof parent === "string") outputPath.value = `${parent.replace(/[\\/]$/, "")}/${props.database}-dump`;
  } else {
    const path = await save({ defaultPath: `${props.database}.archive${gzip.value ? ".gz" : ""}`, filters: [{ name: "MongoDB archive", extensions: [gzip.value ? "gz" : "archive"] }] });
    if (path) outputPath.value = path;
  }
}

async function refreshDatabase() {
  await store.loadMongoDatabases(props.connectionId);
  await store.loadMongoCollections(props.connectionId, targetDatabase.value);
  for (const collection of selected.value) {
    store.mongoImportCompleted = { connectionId: props.connectionId, database: targetDatabase.value, collection, at: Date.now() };
    await nextTick();
  }
}
async function execute() {
  if (!canReview.value) return;
  confirming.value = true;
  const current = generation;
  try {
    targetDatabase.value = targetDatabase.value.trim();
    if (restoring.value) {
      const allowed = await executeWithProductionContextGuard({
        connection: connection.value,
        database: targetDatabase.value.trim(),
        source: t("mongoDump.restoreTitle"),
        reviewText: `${dropExisting.value ? "DROP selected collections; " : ""}RESTORE ${JSON.stringify(sourceDatabase.value)} INTO ${JSON.stringify(targetDatabase.value.trim())}: ${selected.value.map((name) => JSON.stringify(name)).join(", ")}`,
        execute: async () => true,
      });
      if (!allowed) return;
    }
    if (current !== generation || !open.value) return;
    running.value = true;
    confirming.value = false;
    step.value = "result";
    error.value = "";
    progress.value = null;
    taskId.value = uuid();
    const onProgress = (value: api.MongoDatabaseDumpProgress) => {
      progress.value = value;
    };
    await store.ensureConnected(props.connectionId);
    if (restoring.value) {
      uploadController = new AbortController();
      const selectedPaths = new Set(entries.value.filter((entry) => selected.value.includes(entry.name)).flatMap((entry) => entry.sourceFiles ?? []));
      const upload = !desktop && format.value === "directory" && Array.isArray(source.value) ? { files: source.value.filter((file) => selectedPaths.has(file.webkitRelativePath || file.name)), gzip: gzip.value, signal: uploadController.signal } : undefined;
      progress.value = await api.restoreMongodbDatabase(
        {
          taskId: taskId.value,
          connectionId: props.connectionId,
          database: targetDatabase.value.trim(),
          sourceDatabase: sourceDatabase.value,
          sourceRef: sourceRef.value!,
          collections: [...selected.value],
          dropExisting: dropExisting.value,
          restoreOptions: restoreOptions.value,
          restoreIndexes: restoreIndexes.value,
          stopOnError: stopOnError.value,
          objcheck: objcheck.value,
          batchSize: Math.max(100, Math.min(5000, Math.trunc(Number(batchSize.value)) || 500)),
        },
        onProgress,
        upload,
      );
      void refreshDatabase().catch((cause) => console.error("Refresh after MongoDB restore failed", cause));
    } else {
      progress.value = await api.dumpMongodbDatabase({ taskId: taskId.value, connectionId: props.connectionId, database: props.database, filePath: outputPath.value.trim(), format: format.value, gzip: gzip.value, collections: [...selected.value] }, onProgress);
    }
  } catch (cause) {
    error.value = String(cause instanceof Error ? cause.message : cause);
    if (cause instanceof DOMException && cause.name === "AbortError") {
      progress.value = { taskId: taskId.value, status: "cancelled", phase: "done", collection: null, collectionsDone: 0, collectionsTotal: selected.value.length, documentsRead: 0, documentsWritten: 0, documentsFailed: 0, indexesCreated: 0, elapsedMs: 0, errorMessage: null, filePath: null };
      error.value = "";
    }
  } finally {
    confirming.value = false;
    running.value = false;
    cancelling.value = false;
    uploadController = null;
  }
}
async function cancel() {
  cancelling.value = true;
  uploadController?.abort();
  try {
    await api.cancelMongodbDatabaseDump(taskId.value);
  } catch (cause) {
    cancelling.value = false;
    error.value = String(cause instanceof Error ? cause.message : cause);
  }
}
function close() {
  if (!running.value && !confirming.value) open.value = false;
}
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!value) close();
      }
    "
  >
    <DialogScrollContent class="flex max-h-[calc(var(--dbx-viewport-height)-4rem)] min-h-0 flex-col overflow-hidden sm:max-w-[860px]">
      <DialogHeader class="shrink-0 pr-8"
        ><DialogTitle class="flex items-center gap-2 text-base"><DatabaseBackup class="h-4 w-4" />{{ t(restoring ? "mongoDump.restoreTitle" : "mongoDump.dumpTitle") }}</DialogTitle></DialogHeader
      >
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto py-3 text-sm">
        <div class="border-b pb-2 font-medium break-all">{{ connection?.name }} / {{ props.database }}</div>
        <div v-if="readonly" class="text-xs text-amber-600">{{ t("mongoDump.readonly") }}</div>
        <template v-if="step === 'configure'">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <Label>{{ t("mongoDump.format") }}</Label
              ><Select :model-value="format" :disabled="loading" @update:model-value="setFormat"
                ><SelectTrigger class="h-8"><SelectValue /></SelectTrigger
                ><SelectContent
                  ><SelectItem value="archive">{{ t("mongoDump.archive") }}</SelectItem
                  ><SelectItem v-if="desktop || restoring" value="directory">{{ t("mongoDump.directory") }}</SelectItem></SelectContent
                ></Select
              >
            </div>
            <label class="flex min-h-8 items-center gap-2 self-end"><input v-model="gzip" type="checkbox" :disabled="loading" />{{ t("mongoDump.gzip") }}</label>
          </div>
          <div v-if="restoring" class="space-y-2">
            <Label>{{ t("mongoDump.source") }}</Label>
            <input ref="fileInput" type="file" class="hidden" :multiple="format === 'directory'" :webkitdirectory="format === 'directory' ? '' : undefined" @change="chooseFiles" />
            <div class="flex flex-wrap items-center gap-2">
              <div class="min-w-0 flex-1 basis-full break-all text-xs sm:basis-0">{{ sourceName || t("tableImport.noFileSelected") }}</div>
              <Button variant="outline" size="sm" :disabled="loading" @click="chooseSource"><FolderOpen class="mr-1.5 h-4 w-4" />{{ t("tableImport.selectFile") }}</Button
              ><Button size="sm" :disabled="!source || loading" @click="readSource"><Loader2 v-if="loading" class="mr-1.5 h-4 w-4 animate-spin" /><Play v-else class="mr-1.5 h-4 w-4" />{{ t("mongoDump.readSource") }}</Button>
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="space-y-1">
                <Label>{{ t("mongoDump.sourceDatabase") }}</Label
                ><Select :model-value="sourceDatabase" :disabled="!catalog || loading" @update:model-value="setSourceDatabase"
                  ><SelectTrigger class="h-8 w-full min-w-0 [&>span]:min-w-0 [&>span]:truncate"><SelectValue /></SelectTrigger
                  ><SelectContent
                    ><SelectItem v-for="db in catalog?.databases ?? []" :key="db" :value="db">{{ db }}</SelectItem></SelectContent
                  ></Select
                >
              </div>
              <div class="space-y-1">
                <Label>{{ t("mongoDump.targetDatabase") }}</Label
                ><Input v-model="targetDatabase" class="h-8" :disabled="loading" />
              </div>
            </div>
          </div>
          <div v-else class="space-y-1">
            <Label>{{ t("mongoDump.destination") }}</Label>
            <div class="flex gap-2">
              <Input v-model="outputPath" class="h-8 min-w-0" :readonly="desktop" /><Button v-if="desktop" variant="outline" size="icon" class="h-8 w-8 shrink-0" :title="t('mongoDump.chooseDestination')" :aria-label="t('mongoDump.chooseDestination')" @click="chooseDestination"
                ><FolderOpen class="h-4 w-4"
              /></Button>
            </div>
          </div>
          <div v-if="loading" class="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t(restoring ? "mongoDump.preparing" : "mongoDump.loading") }}</div>
          <div v-if="loading && readUpload" class="text-xs tabular-nums">{{ t("mongoDump.uploadBytes", { done: gib(readUpload.loaded), total: gib(readUpload.total) }) }}</div>
          <div v-if="catalog" class="space-y-2">
            <div class="text-xs text-muted-foreground">{{ t("mongoDump.selected", { count: selected.length }) }}</div>
            <div class="max-h-64 overflow-auto border-y">
              <table class="w-full min-w-[480px] table-fixed text-xs">
                <thead class="sticky top-0 bg-background">
                  <tr>
                    <th class="w-8 p-2"><input type="checkbox" :checked="allSelected" :aria-label="t('mongoDump.selectAll')" @change="selectAll" /></th>
                    <th class="w-2/5 p-2 text-left">{{ t("mongoDump.collection") }}</th>
                    <th class="p-2 text-left">{{ t("mongoDump.kind") }}</th>
                    <th class="p-2 text-right">{{ t("mongoDump.documents") }}</th>
                    <th class="p-2 text-right">{{ t("mongoDump.indexes") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="entry in entries" :key="entry.name" class="border-t">
                    <td class="p-2"><input type="checkbox" :checked="selected.includes(entry.name)" :aria-label="entry.name" @change="selectCollection(entry.name, $event)" /></td>
                    <td class="p-2 break-all">{{ entry.name }}</td>
                    <td class="p-2 break-all">{{ entry.kind }}</td>
                    <td class="p-2 text-right">{{ entry.documents ?? "-" }}</td>
                    <td class="p-2 text-right">{{ entry.indexes }}</td>
                  </tr>
                  <tr v-if="!entries.length">
                    <td colspan="5" class="p-4 text-center text-muted-foreground">{{ t("mongoDump.empty") }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div v-if="restoring" class="space-y-3 border-t pt-3">
            <label class="flex items-center gap-2"><input v-model="dropExisting" type="checkbox" />{{ t("mongoDump.dropExisting") }}</label>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label class="flex items-center gap-2"><input v-model="restoreOptions" type="checkbox" />{{ t("mongoDump.restoreOptions") }}</label
              ><label class="flex items-center gap-2"><input v-model="restoreIndexes" type="checkbox" />{{ t("mongoDump.restoreIndexes") }}</label
              ><label class="flex items-center gap-2"><input v-model="stopOnError" type="checkbox" />{{ t("mongoDump.stopOnError") }}</label>
              <label class="flex items-center gap-2"><input v-model="objcheck" type="checkbox" />{{ t("mongoDump.objcheck") }}</label>
              <div class="flex items-center gap-2">
                <Label class="shrink-0">{{ t("mongoDump.batchSize") }}</Label
                ><Input v-model.number="batchSize" type="number" min="100" max="5000" class="h-8 w-24" />
              </div>
            </div>
          </div>
        </template>
        <template v-else-if="step === 'confirm'"
          ><p>{{ t(restoring ? "mongoDump.confirmRestore" : "mongoDump.confirmDump", { count: selected.length, database: restoring ? targetDatabase : props.database }) }}</p>
          <p v-if="restoring" :class="dropExisting ? 'text-destructive' : 'text-muted-foreground'">{{ t(dropExisting ? "mongoDump.confirmDrop" : "mongoDump.confirmAppend") }}</p>
          <div class="max-h-56 overflow-auto border-y py-2 text-xs">
            <div v-for="name in selected" :key="name" class="py-1 break-all">{{ name }}</div>
          </div>
          <div v-if="!restoring" class="break-all text-xs text-muted-foreground">{{ outputPath }}</div></template
        >
        <template v-else
          ><div class="flex items-center gap-2 font-medium">
            <Loader2 v-if="running" class="h-4 w-4 animate-spin" />{{ running ? t(`mongoDump.phase.${progress?.phase ?? "preparing"}`) : t(progress?.status === "done" ? "mongoDump.done" : progress?.status === "cancelled" ? "mongoDump.cancelled" : "mongoDump.failed") }}
          </div>
          <div class="break-all text-xs">{{ progress?.collection }}</div>
          <div v-if="progress?.phase === 'uploading'" class="text-xs tabular-nums">{{ t("mongoDump.uploadBytes", { done: gib(progress.bytesProcessed ?? 0), total: gib(progress.bytesTotal ?? 0) }) }}</div>
          <div v-if="restoring && progress?.phase === 'data'" class="text-xs tabular-nums">{{ t("mongoDump.readBytes", { size: gib(progress.bytesProcessed ?? 0) }) }}</div>
          <div v-if="progress?.phase === 'validating'" class="text-xs tabular-nums">{{ t("mongoDump.validationBytes", { size: gib(progress.bytesProcessed ?? 0), count: progress.documentsValidated ?? 0 }) }}</div>
          <progress class="h-2 w-full" :value="progress?.collectionsDone ?? 0" :max="Math.max(1, progress?.collectionsTotal ?? selected.length)" />
          <div class="text-xs">{{ t("mongoDump.progress", { done: progress?.collectionsDone ?? 0, total: progress?.collectionsTotal ?? selected.length }) }}</div>
          <dl class="grid grid-cols-2 gap-3 border-y py-3 text-xs">
            <dt>{{ t("mongoDump.read") }}</dt>
            <dd class="text-right tabular-nums">{{ progress?.documentsRead ?? 0 }}</dd>
            <dt v-if="restoring">{{ t("mongoDump.written") }}</dt>
            <dd v-if="restoring" class="text-right tabular-nums">{{ progress?.documentsWritten ?? 0 }}</dd>
            <dt>{{ t("mongoDump.rejected") }}</dt>
            <dd class="text-right tabular-nums">{{ progress?.documentsFailed ?? 0 }}</dd>
            <dt v-if="restoring">{{ t("mongoDump.createdIndexes") }}</dt>
            <dd v-if="restoring" class="text-right tabular-nums">{{ progress?.indexesCreated ?? 0 }}</dd>
          </dl></template
        >
        <div v-if="error" class="break-words border-l-2 border-destructive pl-3 text-xs text-destructive" role="alert">{{ error }}</div>
      </div>
      <DialogFooter class="shrink-0"
        ><Button v-if="running" variant="destructive" :disabled="cancelling" @click="cancel"><Square class="mr-1.5 h-4 w-4" />{{ t("mongoDump.cancel") }}</Button
        ><Button v-else variant="outline" :disabled="confirming" @click="close"><X class="mr-1.5 h-4 w-4" />{{ t("mongoDump.close") }}</Button
        ><Button v-if="step !== 'configure' && !running" variant="outline" :disabled="confirming" @click="step = 'configure'"><ArrowLeft class="mr-1.5 h-4 w-4" />{{ t("mongoDump.back") }}</Button
        ><Button v-if="step === 'configure'" :disabled="!canReview" @click="step = 'confirm'"><ArrowRight class="mr-1.5 h-4 w-4" />{{ t("mongoDump.review") }}</Button
        ><Button v-if="step === 'confirm'" :disabled="!canReview" @click="execute"><Loader2 v-if="confirming" class="mr-1.5 h-4 w-4 animate-spin" /><Play v-else class="mr-1.5 h-4 w-4" />{{ t(restoring ? "mongoDump.restore" : "mongoDump.dump") }}</Button></DialogFooter
      >
    </DialogScrollContent>
  </Dialog>
</template>

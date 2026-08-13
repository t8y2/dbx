<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { uuid } from "@/lib/common/utils";
import { useI18n } from "vue-i18n";
import { useSqlHighlighter } from "@/composables/useSqlHighlighter";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import ConnectionGroupBadge from "@/components/connection/ConnectionGroupBadge.vue";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { productionContextForDatabase } from "@/lib/database/productionSafety";
import { fetchSqlFileTargetOptions } from "@/composables/useDatabaseOptions";
import { requiresSqlFileTargetDatabaseSelection } from "@/lib/connection/connectionLevelDatabaseBootstrap";
import { cancelSqlFileExecution, executeSqlFiles, listenSqlFileProgress, previewSqlFile, type SqlFilePreview, type SqlFileProgress, type SqlFileStatus } from "@/lib/backend/api";
import { buildDisplayFileNames, tooltipText as computeTooltipText } from "./sqlFilePreviewLabel";
import { useExportTracker } from "@/composables/useExportTracker";
import { Check, CheckSquare, FileCode, FolderOpen, Loader2, Play, Square, X } from "@lucide/vue";

const { t } = useI18n();
const { toast } = useToast();
const { highlight } = useSqlHighlighter();
const { addSqlFileTask, updateSqlFileTask } = useExportTracker();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
  prefillFilePath?: string;
}>();

const store = useConnectionStore();
const productionSafetyStore = useProductionSafetyStore();
// Tauri = real filesystem paths; Web = browser File.name (no path) + server temp paths.
const isDesktopRuntime = isTauriRuntime();

const fileInput = ref<HTMLInputElement | null>(null);
const previews = ref<SqlFilePreview[]>([]);
const activePreviewPath = ref("");
// Only the active file's preview body is mounted (reka-ui unmounts inactive
// TabsContent), so switching files keeps the DOM small even with many files.
watch(previews, (list) => {
  if (list.length === 0) {
    activePreviewPath.value = "";
  } else if (!list.some((item) => item.filePath === activePreviewPath.value)) {
    activePreviewPath.value = list[0]!.filePath;
  }
});

const activePreview = computed<SqlFilePreview | null>(() => {
  return previews.value.find((item) => item.filePath === activePreviewPath.value) ?? previews.value[0] ?? null;
});

// Disambiguate files that share the same fileName.
// Desktop: prepend parent directory segments until unique (e.g. migration/create.sql).
// Web: browser File.name has no path, so use a stable 1-based index suffix.
const displayFileNames = computed(() => buildDisplayFileNames(previews.value, isDesktopRuntime));

// Display-only text for the file-path input. In Web mode this shows user-facing
// labels instead of server temp paths (which contain meaningless UUIDs).
// Execution always uses previews[].filePath directly.
const filePathDisplay = computed(() => {
  if (previews.value.length === 0) return "";
  if (isDesktopRuntime) return previews.value.map((item) => item.filePath).join("; ");
  return previews.value.map((item) => displayFileNames.value.get(item.filePath) ?? item.fileName).join("; ");
});

// Desktop tooltip shows the real file path; Web tooltip shows the user-facing
// label only — never the server temp path (which contains a meaningless UUID).
function tooltipText(item: SqlFilePreview): string {
  return computeTooltipText(item, displayFileNames.value, isDesktopRuntime);
}
const selectingFile = ref(false);
const loadingPreview = ref(false);
const connectionId = ref("");
const database = ref("");
const databaseOptions = ref<string[]>([]);
const loadingDatabases = ref(false);
const continueOnError = ref(false);

const running = ref(false);
const cancelling = ref(false);
const cancelRequested = ref(false);
const executionStarted = ref(false);
const executionId = ref("");
const progress = ref<SqlFileProgress | null>(null);
const terminalStatus = ref<SqlFileStatus | "idle">("idle");
const terminalError = ref("");
const refreshedTarget = ref(false);
const MAX_WEB_SQL_FILE_BYTES = 200 * 1024 * 1024;

// Per-file results accumulated from backend file-boundary events during
// multi-file execution.  Populated only when previews.length > 1.
interface PerFileSummary {
  fileName: string;
  statementIndex: number;
  successCount: number;
  failureCount: number;
  affectedRows: number;
}
const perFileResults = ref<PerFileSummary[]>([]);
const currentFileIndex = ref(-1);
const currentFileName = ref("");
function resetPerFileState() {
  perFileResults.value = [];
  currentFileIndex.value = -1;
  currentFileName.value = "";
}

const sqlConnections = computed(() => store.connections.filter((c) => !["redis", "mongodb", "elasticsearch", "easysearch", "meilisearch", "qdrant", "milvus", "weaviate", "chromadb", "etcd", "zookeeper", "consul", "mq", "nacos"].includes(c.db_type)));

const selectedConnection = computed(() => sqlConnections.value.find((c) => c.id === connectionId.value));

const canStart = computed(() => {
  const connection = selectedConnection.value;
  if (previews.value.length === 0 || !connection || running.value || loadingPreview.value || loadingDatabases.value) return false;
  let hasDatabaseContext = false;
  const canExecuteWithoutSelectedDatabase = previews.value.every((item) => {
    if (!hasDatabaseContext && !item.canExecuteWithoutSelectedDatabase) return false;
    hasDatabaseContext ||= item.establishesDatabaseContext === true;
    return true;
  });
  return !!database.value.trim() || !requiresSqlFileTargetDatabaseSelection(connection, canExecuteWithoutSelectedDatabase);
});

const statusTone = computed(() => {
  if (terminalStatus.value === "done") return "text-green-600";
  if (terminalStatus.value === "error") return "text-destructive";
  if (terminalStatus.value === "cancelled") return "text-yellow-600";
  if (running.value) return "text-primary";
  return "text-muted-foreground";
});

const statusIcon = computed(() => {
  if (running.value) return Loader2;
  if (terminalStatus.value === "done") return Check;
  if (terminalStatus.value === "error" || terminalStatus.value === "cancelled") return X;
  return FileCode;
});

const progressPercent = computed(() => {
  if (!progress.value) return 0;
  if (terminalStatus.value === "done") return 100;
  const attempted = progress.value.successCount + progress.value.failureCount;
  const current = Math.max(progress.value.statementIndex, attempted);
  if (current <= 0) return running.value ? 8 : 0;
  return Math.min(95, Math.max(8, Math.round((attempted / current) * 100)));
});
function previewLineCount(item: SqlFilePreview) {
  return item.preview.split(/\r\n|\r|\n/).length;
}
function previewIsTruncated(item: SqlFilePreview) {
  return item.sizeBytes > item.preview.length;
}
function previewLineSummary(item: SqlFilePreview) {
  const count = previewLineCount(item);
  return previewIsTruncated(item) ? t("sqlFile.previewingFirstLines", { count }) : t("sqlFile.previewingLines", { count });
}

function connectionIconType(id: string) {
  const config = store.getConfig(id);
  return config?.driver_profile || config?.db_type || "mysql";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

function formatElapsed(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function statusLabel(status: SqlFileStatus | "idle") {
  return t(`sqlFile.status.${status}`);
}

function resolveInitialConnectionId() {
  if (props.prefillConnectionId && sqlConnections.value.some((c) => c.id === props.prefillConnectionId)) {
    return props.prefillConnectionId;
  }
  if (props.prefillFilePath) return "";
  return sqlConnections.value[0]?.id ?? "";
}

function chooseDatabase(names: string[], id: string) {
  const configDatabase = store.getConfig(id)?.database ?? "";
  if (names.length > 0) {
    if (props.prefillDatabase && names.includes(props.prefillDatabase)) return props.prefillDatabase;
    if (configDatabase && names.includes(configDatabase)) return configDatabase;
    return names.length === 1 ? names[0] : "";
  }
  return props.prefillDatabase ?? configDatabase;
}

function resetExecution() {
  running.value = false;
  cancelling.value = false;
  cancelRequested.value = false;
  executionStarted.value = false;
  executionId.value = "";
  progress.value = null;
  terminalStatus.value = "idle";
  terminalError.value = "";
  refreshedTarget.value = false;
  resetPerFileState();
}

function resetState() {
  previews.value = [];
  selectingFile.value = false;
  loadingPreview.value = false;
  connectionId.value = resolveInitialConnectionId();
  database.value = "";
  databaseOptions.value = [];
  loadingDatabases.value = false;
  continueOnError.value = false;
  resetExecution();
}

let databaseLoadToken = 0;

async function loadDatabasesForConnection(id: string) {
  const token = databaseLoadToken + 1;
  databaseLoadToken = token;
  databaseOptions.value = [];

  if (!sqlConnections.value.some((c) => c.id === id)) {
    database.value = "";
    return;
  }

  loadingDatabases.value = true;
  try {
    await store.ensureConnected(id);
    const connection = store.getConfig(id);
    if (!connection) return;
    const names = await fetchSqlFileTargetOptions(id, connection);
    if (token !== databaseLoadToken) return;
    databaseOptions.value = names;
    database.value = chooseDatabase(names, id);
  } catch {
    if (token !== databaseLoadToken) return;
    databaseOptions.value = [];
    database.value = chooseDatabase([], id);
  } finally {
    if (token === databaseLoadToken) {
      loadingDatabases.value = false;
    }
  }
}

async function previewSelectedSqlFile(fileOrPath: string | File) {
  if (isTauriRuntime()) {
    return previewSqlFile(fileOrPath as string);
  }
  const file = fileOrPath as File;
  if (file.size > MAX_WEB_SQL_FILE_BYTES) {
    throw new Error(`File too large: ${file.size} bytes (max ${MAX_WEB_SQL_FILE_BYTES} bytes)`);
  }
  const { previewSqlFile: previewWebSqlFile } = await import("@/lib/backend/http");
  return previewWebSqlFile(file);
}

async function loadPreviews(filesOrPaths: Array<string | File>) {
  loadingPreview.value = true;
  previews.value = [];
  resetExecution();
  try {
    const nextPreviews: SqlFilePreview[] = [];
    for (const fileOrPath of filesOrPaths) {
      nextPreviews.push(await previewSelectedSqlFile(fileOrPath));
    }
    previews.value = nextPreviews;
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    loadingPreview.value = false;
  }
}

async function selectFile() {
  if (running.value) return;
  if (!isTauriRuntime()) {
    fileInput.value?.click();
    return;
  }
  selectingFile.value = true;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (paths.length > 0) {
      await loadPreviews(paths);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    selectingFile.value = false;
  }
}

async function handleFileInputChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length === 0 || running.value) return;
  selectingFile.value = true;
  try {
    await loadPreviews(files);
  } finally {
    selectingFile.value = false;
  }
}

async function listenProgress(id: string, handler: (next: SqlFileProgress) => void, onError?: (error: Error) => void): Promise<() => void> {
  if (isTauriRuntime()) {
    return listenSqlFileProgress(handler);
  }
  const { listenSqlFileProgressById } = await import("@/lib/sql/httpSqlFileProgress");
  return listenSqlFileProgressById(id, handler, onError);
}

function isTerminalProgress(status: SqlFileStatus): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

async function refreshTargetAfterImport() {
  if (refreshedTarget.value) return;
  refreshedTarget.value = true;
  try {
    await store.refreshDatabaseTreeNode(connectionId.value, database.value.trim());
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  }
}

async function startExecution() {
  if (!canStart.value || previews.value.length === 0) return;
  const productionContext = productionContextForDatabase(selectedConnection.value, database.value);
  if (productionContext.active) {
    // File previews are truncated, so production file execution is always reviewed instead of inferring safety from a partial preview.
    const confirmed = await productionSafetyStore.requestConfirmation({
      sql: previews.value
        .map((item) => item.preview)
        .join("\n\n")
        .slice(0, 20_000),
      connectionName: selectedConnection.value?.name,
      database: database.value,
      productionDatabases: productionContext.databases,
      source: t("production.sourceSqlFile"),
    });
    if (!confirmed) return;
  }

  resetPerFileState();
  refreshedTarget.value = false;
  const batchId = uuid();
  executionId.value = batchId;
  running.value = true;
  cancelling.value = false;
  cancelRequested.value = false;
  executionStarted.value = false;
  terminalStatus.value = "running";
  terminalError.value = "";
  progress.value = null;
  const taskLabel = previews.value.length === 1 ? previews.value[0]!.fileName : `${previews.value[0]!.fileName} (+${previews.value.length - 1})`;
  addSqlFileTask(batchId, taskLabel, filePathDisplay.value);

  try {
    await store.ensureConnected(connectionId.value);
    if (cancelRequested.value) {
      terminalStatus.value = "cancelled";
      return;
    }

    let resolveTerminalProgress: (progress: SqlFileProgress) => void = () => {};
    let rejectTerminalProgress: (error: Error) => void = () => {};
    const terminalProgress = new Promise<SqlFileProgress>((resolve, reject) => {
      resolveTerminalProgress = resolve;
      rejectTerminalProgress = reject;
    });
    let completedSuccessfully = false;
    const unlisten = await listenProgress(
      batchId,
      (next) => {
        if (next.executionId !== batchId) return;
        progress.value = next;
        terminalStatus.value = next.status;
        terminalError.value = next.error ?? terminalError.value;
        updateSqlFileTask(batchId, next);

        // Detect per-file boundary events from the backend (populated only
        // during multi-file execution).  The backend emits a file-start
        // event (status=Running, fileIndex set) and a file-done event
        // (status=StatementDone, fileIndex set, counters are diff-based).
        // Resolve user-visible names via displayFileNames (by fileIndex →
        // previews) so Web mode never shows server temp UUID paths.
        if (previews.value.length > 1) {
          const fi = next.fileIndex;
          if (fi != null) {
            const preview = previews.value[fi];
            const displayName = preview ? (displayFileNames.value.get(preview.filePath) ?? next.fileName ?? "") : (next.fileName ?? "");
            if (next.status === "running") {
              currentFileIndex.value = fi;
              currentFileName.value = displayName;
            } else if (next.status === "statementDone") {
              perFileResults.value[fi] = {
                fileName: displayName,
                statementIndex: next.statementIndex,
                successCount: next.successCount,
                failureCount: next.failureCount,
                affectedRows: next.affectedRows,
              };
              currentFileIndex.value = fi;
              currentFileName.value = displayName;
            }
          }
        }

        if (isTerminalProgress(next.status)) {
          resolveTerminalProgress(next);
        }
      },
      rejectTerminalProgress,
    );

    try {
      executionStarted.value = true;
      await executeSqlFiles(
        {
          executionId: batchId,
          connectionId: connectionId.value,
          database: database.value.trim(),
          filePath: previews.value[0]!.filePath,
          continueOnError: continueOnError.value,
        },
        previews.value.map((item) => item.filePath),
      );
      const terminal = await terminalProgress;
      if (terminal.status === "error") {
        throw new Error(terminal.error || "SQL file execution failed");
      }
      if (terminal.status === "cancelled") {
        cancelRequested.value = true;
      }
      completedSuccessfully = terminal.status === "done";
    } finally {
      executionStarted.value = false;
      unlisten();
    }

    if (completedSuccessfully) await refreshTargetAfterImport();
  } catch (e: any) {
    terminalStatus.value = cancelRequested.value ? "cancelled" : "error";
    terminalError.value = e?.message || String(e);
    const lastProgress = progress.value as SqlFileProgress | null;
    updateSqlFileTask(batchId, {
      executionId: batchId,
      status: terminalStatus.value,
      statementIndex: lastProgress?.statementIndex ?? 0,
      successCount: lastProgress?.successCount ?? 0,
      failureCount: lastProgress?.failureCount ?? 0,
      affectedRows: lastProgress?.affectedRows ?? 0,
      elapsedMs: lastProgress?.elapsedMs ?? 0,
      statementSummary: lastProgress?.statementSummary ?? "",
      error: terminalError.value,
    });
    if (!cancelRequested.value) {
      toast(terminalError.value, 5000);
    }
  } finally {
    running.value = false;
    cancelling.value = false;
    executionStarted.value = false;
  }
}

async function cancelExecution() {
  if (!executionId.value || !running.value || cancelling.value) return;
  cancelRequested.value = true;
  cancelling.value = true;
  if (!executionStarted.value) return;
  try {
    const cancelled = await cancelSqlFileExecution(executionId.value);
    if (!cancelled) {
      throw new Error("Cancel request was not accepted");
    }
  } catch (e: any) {
    cancelRequested.value = false;
    cancelling.value = false;
    toast(e?.message || String(e), 5000);
  }
}

function handleOpenChange(nextOpen: boolean) {
  open.value = nextOpen;
}

watch(connectionId, (id) => {
  loadDatabasesForConnection(id);
});

watch(sqlConnections, () => {
  if (!open.value || running.value || selectedConnection.value) return;
  connectionId.value = resolveInitialConnectionId();
});

watch(
  open,
  (value) => {
    if (!value) return;
    if (running.value) return;
    resetState();
    if (connectionId.value) {
      loadDatabasesForConnection(connectionId.value);
    }
    // When opened from the SQL Files panel with a pre-selected file, load its
    // preview automatically so the user can review statements before running.
    if (props.prefillFilePath) {
      void loadPreviews([props.prefillFilePath]);
    }
  },
  { immediate: true },
);
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogScrollContent class="flex max-h-[calc(var(--dbx-viewport-height)-6rem)] min-h-0 min-w-0 flex-col overflow-hidden sm:max-w-[860px]" :trap-focus="false" @interact-outside.prevent>
      <DialogHeader class="shrink-0">
        <DialogTitle class="flex items-center gap-2">
          <FileCode class="w-4 h-4" />
          {{ t("sqlFile.title") }}
        </DialogTitle>
      </DialogHeader>

      <!-- Keep terminal actions reachable while long previews and errors scroll inside the viewport. -->
      <div class="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto py-3">
        <div class="min-w-0 space-y-3">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t("sqlFile.file") }}
          </div>

          <div class="flex items-center gap-2">
            <input ref="fileInput" type="file" accept=".sql,text/sql" multiple class="hidden" @change="handleFileInputChange" />
            <Input :model-value="filePathDisplay" readonly class="h-8 text-xs font-mono" :placeholder="t('sqlFile.selectSqlFile')" />
            <Button variant="outline" size="sm" class="h-8 shrink-0" :disabled="running || selectingFile" @click="selectFile">
              <Loader2 v-if="selectingFile || loadingPreview" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
              <FolderOpen v-else class="w-3.5 h-3.5 mr-1.5" />
              {{ t("sqlFile.browse") }}
            </Button>
          </div>

          <div v-if="previews.length" class="flex min-w-0 gap-3">
            <div v-if="previews.length > 1" class="flex w-48 shrink-0 flex-col rounded-md border bg-muted/20">
              <div class="flex shrink-0 items-center gap-2 rounded-t-md border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                <FileCode class="w-3.5 h-3.5 shrink-0" />
                <span class="font-medium">{{ previews.length }}</span>
              </div>
              <!-- Keep this max-height in sync with the preview viewer so the list
                   matches the preview pane height and scrolls internally. -->
              <div class="max-h-[min(46vh,420px)] min-h-0 overflow-y-auto p-1">
                <Tooltip v-for="item in previews" :key="item.filePath">
                  <TooltipTrigger as-child>
                    <button type="button" class="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs" :class="item.filePath === activePreviewPath ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted'" @click="activePreviewPath = item.filePath">
                      <FileCode class="w-3.5 h-3.5 shrink-0" />
                      <span class="min-w-0 flex-1 truncate">{{ displayFileNames.get(item.filePath) ?? item.fileName }}</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" class="max-w-[360px] break-all">{{ tooltipText(item) }}</TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div v-if="activePreview" class="min-w-0 flex-1 flex flex-col">
              <div class="flex items-center justify-between gap-3 rounded-t-md border border-b-0 px-3 py-2 text-xs bg-muted/40">
                <div class="min-w-0 flex items-center gap-2">
                  <FileCode class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                  <span class="font-medium truncate">{{ displayFileNames.get(activePreview.filePath) ?? activePreview.fileName }}</span>
                </div>
                <div class="flex shrink-0 items-center gap-2 text-muted-foreground">
                  <span>{{ previewLineSummary(activePreview) }}</span>
                  <span class="h-3 w-px bg-border" />
                  <span>{{ formatBytes(activePreview.sizeBytes) }}</span>
                </div>
              </div>
              <div class="sql-file-preview-viewer flex max-w-full overflow-auto bg-muted/15 text-xs rounded-b-md border border-t-0" :class="previews.length === 1 ? 'min-h-56 max-h-[min(46vh,420px)]' : 'min-h-0 max-h-[min(46vh,420px)]'">
                <div class="sticky left-0 z-10 select-none border-r bg-background/95 px-2 py-3 text-right font-mono leading-5 text-muted-foreground/70">
                  <div v-for="n in previewLineCount(activePreview)" :key="n">{{ n }}</div>
                </div>
                <pre class="min-w-max flex-1 p-3 font-mono leading-5 whitespace-pre" v-html="highlight(activePreview.preview)"></pre>
              </div>
            </div>
          </div>
        </div>

        <div class="min-w-0 space-y-3">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t("sqlFile.target") }}
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("sqlFile.connection") }}</Label>
              <Select v-model="connectionId" :disabled="running">
                <SelectTrigger class="h-8 text-xs">
                  <div v-if="connectionId" class="flex items-center gap-1.5 min-w-0">
                    <DatabaseIcon :db-type="connectionIconType(connectionId)" class="w-3.5 h-3.5 shrink-0" />
                    <span class="truncate">{{ selectedConnection?.name ?? connectionId }}</span>
                  </div>
                  <SelectValue v-else :placeholder="t('sqlFile.selectConnection')" />
                </SelectTrigger>
                <SelectContent position="popper">
                  <SelectItem v-for="c in sqlConnections" :key="c.id" :value="c.id">
                    <div class="flex min-w-0 items-center gap-1.5">
                      <DatabaseIcon :db-type="c.driver_profile || c.db_type" class="w-3.5 h-3.5 shrink-0" />
                      <ConnectionGroupBadge :connection-id="c.id" />
                      <span class="min-w-0 flex-1 truncate">{{ c.name }}</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs">{{ t("sqlFile.database") }}</Label>
              <Select v-if="databaseOptions.length" v-model="database" :disabled="running || loadingDatabases">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue :placeholder="t('sqlFile.selectDatabase')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="db in databaseOptions" :key="db" :value="db">{{ db }}</SelectItem>
                </SelectContent>
              </Select>
              <div v-else class="relative">
                <Input v-model="database" class="h-8 text-xs" :disabled="running || loadingDatabases" :placeholder="t('sqlFile.databasePlaceholder')" />
                <Loader2 v-if="loadingDatabases" class="absolute right-2 top-2 w-3.5 h-3.5 animate-spin text-muted-foreground" />
              </div>
            </div>
          </div>
        </div>

        <div class="min-w-0 space-y-2.5">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t("sqlFile.options") }}
          </div>

          <button type="button" class="flex items-center gap-2 text-xs text-left" :disabled="running" @click="continueOnError = !continueOnError">
            <CheckSquare v-if="continueOnError" class="w-3.5 h-3.5 text-primary shrink-0" />
            <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
            {{ t("sqlFile.continueOnError") }}
          </button>
        </div>

        <div v-if="running || terminalStatus !== 'idle' || progress" class="min-w-0 space-y-3">
          <div class="flex items-center justify-between gap-3 text-xs">
            <div class="flex items-center gap-1.5 min-w-0" :class="statusTone">
              <component :is="statusIcon" class="w-3.5 h-3.5 shrink-0" :class="{ 'animate-spin': running }" />
              <span class="font-medium truncate">
                {{ cancelling ? t("sqlFile.cancelling") : statusLabel(terminalStatus) }}
              </span>
            </div>
            <span v-if="progress" class="text-muted-foreground shrink-0">
              {{ formatElapsed(progress.elapsedMs) }}
            </span>
          </div>

          <div class="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div class="h-full rounded-full transition-[width] duration-300" :class="terminalStatus === 'error' ? 'bg-destructive' : terminalStatus === 'cancelled' ? 'bg-yellow-500' : 'bg-primary'" :style="{ width: `${progressPercent}%` }" />
          </div>

          <div v-if="running && previews.length > 1 && currentFileIndex >= 0" class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <FileCode class="w-3.5 h-3.5 shrink-0" />
            <span class="truncate">{{ t("sqlFile.fileProgress", { current: currentFileIndex + 1, total: previews.length }) }} — {{ currentFileName }}</span>
          </div>

          <template v-if="!running && previews.length > 1 && perFileResults.length > 0">
            <div class="max-h-[min(22vh,200px)] min-w-0 overflow-y-auto rounded-md border text-xs">
              <!-- Keep aggregate columns readable when a file name is long. -->
              <table class="w-full table-fixed">
                <colgroup>
                  <col />
                  <col class="w-[4.5rem]" />
                  <col class="w-[4.5rem]" />
                  <col class="w-[4.5rem]" />
                  <col class="w-[5.5rem]" />
                </colgroup>
                <thead class="sticky top-0 z-10 border-b border-border bg-muted text-foreground shadow-[0_1px_4px_rgb(0_0_0_/_0.06)]">
                  <tr>
                    <th class="px-2.5 py-2 text-left font-semibold">{{ t("sqlFile.fileColumn") }}</th>
                    <th class="px-2 py-2 text-right font-semibold whitespace-nowrap">{{ t("sqlFile.statement") }}</th>
                    <th class="px-2 py-2 text-right font-semibold whitespace-nowrap">{{ t("sqlFile.succeeded") }}</th>
                    <th class="px-2 py-2 text-right font-semibold whitespace-nowrap">{{ t("sqlFile.failed") }}</th>
                    <th class="px-2.5 py-2 text-right font-semibold whitespace-nowrap">{{ t("sqlFile.affectedRows") }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(item, index) in perFileResults" :key="index" class="border-t">
                    <td class="px-2.5 py-1.5 truncate" :title="item.fileName">{{ item.fileName }}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums">{{ item.statementIndex }}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums text-green-600">{{ item.successCount }}</td>
                    <td class="px-2 py-1.5 text-right tabular-nums" :class="{ 'text-destructive': item.failureCount > 0 }">{{ item.failureCount }}</td>
                    <td class="px-2.5 py-1.5 text-right tabular-nums">{{ item.affectedRows.toLocaleString() }}</td>
                  </tr>
                </tbody>
                <tfoot class="sticky bottom-0 z-10 border-t-2 border-primary/35 bg-muted font-semibold text-foreground shadow-[0_-2px_6px_rgb(0_0_0_/_0.08)]">
                  <tr>
                    <th scope="row" class="px-2.5 py-2 text-left">{{ t("sqlFile.totalFiles", { count: perFileResults.length }) }}</th>
                    <td class="px-2 py-2 text-right tabular-nums font-bold">{{ progress?.statementIndex ?? 0 }}</td>
                    <td class="px-2 py-2 text-right tabular-nums font-bold text-green-600">{{ progress?.successCount ?? 0 }}</td>
                    <td class="px-2 py-2 text-right tabular-nums font-bold" :class="{ 'text-destructive': (progress?.failureCount ?? 0) > 0 }">{{ progress?.failureCount ?? 0 }}</td>
                    <td class="px-2.5 py-2 text-right tabular-nums font-bold">{{ (progress?.affectedRows ?? 0).toLocaleString() }}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </template>

          <template v-else>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
              <div class="border rounded-md px-2 py-1.5 min-w-0">
                <div class="text-muted-foreground truncate">{{ t("sqlFile.statement") }}</div>
                <div class="font-medium truncate">{{ progress?.statementIndex ?? 0 }}</div>
              </div>
              <div class="border rounded-md px-2 py-1.5 min-w-0">
                <div class="text-muted-foreground truncate">{{ t("sqlFile.succeeded") }}</div>
                <div class="font-medium text-green-600 truncate">
                  {{ progress?.successCount ?? 0 }}
                </div>
              </div>
              <div class="border rounded-md px-2 py-1.5 min-w-0">
                <div class="text-muted-foreground truncate">{{ t("sqlFile.failed") }}</div>
                <div class="font-medium text-destructive truncate">
                  {{ progress?.failureCount ?? 0 }}
                </div>
              </div>
              <div class="border rounded-md px-2 py-1.5 min-w-0">
                <div class="text-muted-foreground truncate">{{ t("sqlFile.affectedRows") }}</div>
                <div class="font-medium truncate">
                  {{ (progress?.affectedRows ?? 0).toLocaleString() }}
                </div>
              </div>
            </div>
          </template>

          <div v-if="progress?.statementSummary" class="space-y-1">
            <Label class="text-xs">{{ t("sqlFile.currentStatement") }}</Label>
            <div class="max-h-20 max-w-full overflow-auto rounded-md border bg-muted/15 p-2 text-xs font-mono whitespace-pre">
              {{ progress.statementSummary }}
            </div>
          </div>

          <div v-if="progress?.error || terminalError" class="max-w-full overflow-auto rounded-md border bg-destructive/5 p-2 text-xs text-destructive whitespace-pre-wrap">
            {{ progress?.error || terminalError }}
          </div>
        </div>
      </div>

      <DialogFooter class="shrink-0">
        <template v-if="running">
          <Button variant="outline" size="sm" @click="open = false">
            {{ t("sqlFile.runInBackground") }}
          </Button>
          <Button variant="destructive" size="sm" :disabled="cancelling" @click="cancelExecution">
            <Loader2 v-if="cancelling" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
            <X v-else class="w-3.5 h-3.5 mr-1.5" />
            {{ cancelling ? t("sqlFile.cancelling") : t("sqlFile.cancel") }}
          </Button>
        </template>
        <template v-else>
          <Button variant="outline" size="sm" @click="open = false">
            {{ t("common.close") }}
          </Button>
          <Button size="sm" :disabled="!canStart" @click="startExecution">
            <Play class="w-3.5 h-3.5 mr-1.5" />
            {{ t("sqlFile.execute") }}
          </Button>
        </template>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>

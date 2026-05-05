<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import {
  Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import {
  cancelSqlFileExecution,
  executeSqlFile,
  listenSqlFileProgress,
  listDatabases,
  previewSqlFile,
  type SqlFilePreview,
  type SqlFileProgress,
  type SqlFileStatus,
} from "@/lib/api";
import { Check, CheckSquare, FileCode, FolderOpen, Loader2, Play, Square, X } from "lucide-vue-next";

const { t } = useI18n();
const { toast } = useToast();
const open = defineModel<boolean>("open", { default: false });

const props = defineProps<{
  prefillConnectionId?: string;
  prefillDatabase?: string;
}>();

const store = useConnectionStore();

const filePath = ref("");
const preview = ref<SqlFilePreview | null>(null);
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

const sqlConnections = computed(() =>
  store.connections.filter((c) =>
    !["redis", "mongodb", "elasticsearch"].includes(c.db_type),
  ),
);

const selectedConnection = computed(() =>
  sqlConnections.value.find((c) => c.id === connectionId.value),
);

const canStart = computed(() =>
  Boolean(preview.value && selectedConnection.value && database.value.trim() && !running.value && !loadingPreview.value && !loadingDatabases.value),
);

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

function isTerminalStatus(status: SqlFileStatus | "idle") {
  return status === "done" || status === "error" || status === "cancelled";
}

function resolveInitialConnectionId() {
  if (props.prefillConnectionId && sqlConnections.value.some((c) => c.id === props.prefillConnectionId)) {
    return props.prefillConnectionId;
  }
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
}

function resetState() {
  filePath.value = "";
  preview.value = null;
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
    const names = (await listDatabases(id)).map((db) => db.name);
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

async function loadPreview(path: string) {
  loadingPreview.value = true;
  preview.value = null;
  try {
    preview.value = await previewSqlFile(path);
    filePath.value = preview.value.filePath;
    resetExecution();
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    loadingPreview.value = false;
  }
}

async function selectFile() {
  if (running.value) return;
  if (!isTauriRuntime()) return;
  selectingFile.value = true;
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });
    if (typeof selected === "string") {
      await loadPreview(selected);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  } finally {
    selectingFile.value = false;
  }
}

async function startExecution() {
  if (!canStart.value || !preview.value) return;

  const id = crypto.randomUUID();
  executionId.value = id;
  running.value = true;
  cancelling.value = false;
  cancelRequested.value = false;
  executionStarted.value = false;
  terminalStatus.value = "running";
  terminalError.value = "";
  progress.value = null;

  let unlisten: (() => void) | undefined;
  try {
    await store.ensureConnected(connectionId.value);
    if (cancelRequested.value) {
      terminalStatus.value = "cancelled";
      return;
    }

    unlisten = await listenSqlFileProgress((next) => {
      if (next.executionId !== id) return;
      progress.value = next;
      terminalStatus.value = next.status;
      terminalError.value = next.error ?? terminalError.value;
      if (isTerminalStatus(next.status)) {
        running.value = false;
        cancelling.value = false;
      }
    });

    if (cancelRequested.value) {
      terminalStatus.value = "cancelled";
      return;
    }

    executionStarted.value = true;
    await executeSqlFile({
      executionId: id,
      connectionId: connectionId.value,
      database: database.value.trim(),
      filePath: preview.value.filePath,
      continueOnError: continueOnError.value,
    });
    if (!isTerminalStatus(terminalStatus.value)) {
      terminalStatus.value = cancelRequested.value ? "cancelled" : "done";
    }
  } catch (e: any) {
    terminalStatus.value = cancelRequested.value ? "cancelled" : "error";
    terminalError.value = e?.message || String(e);
    if (!cancelRequested.value) {
      toast(terminalError.value, 5000);
    }
  } finally {
    unlisten?.();
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
  if (!nextOpen && running.value) return;
  open.value = nextOpen;
}

watch(connectionId, (id) => {
  loadDatabasesForConnection(id);
});

watch(sqlConnections, () => {
  if (!open.value || running.value || selectedConnection.value) return;
  connectionId.value = resolveInitialConnectionId();
});

watch(open, (value) => {
  if (!value) return;
  resetState();
  if (connectionId.value) {
    loadDatabasesForConnection(connectionId.value);
  }
});
</script>

<template>
  <Dialog :open="open" @update:open="handleOpenChange">
    <DialogScrollContent class="sm:max-w-[620px]" :trap-focus="false" @interact-outside.prevent>
      <DialogHeader>
        <DialogTitle class="flex items-center gap-2">
          <FileCode class="w-4 h-4" />
          {{ t('sqlFile.title') }}
        </DialogTitle>
      </DialogHeader>

      <div class="grid gap-4 py-3">
        <div class="space-y-3">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t('sqlFile.file') }}
          </div>

          <div class="flex items-center gap-2">
            <Input
              :model-value="filePath"
              readonly
              class="h-8 text-xs font-mono"
              :placeholder="t('sqlFile.selectSqlFile')"
            />
            <Button variant="outline" size="sm" class="h-8 shrink-0" :disabled="running || selectingFile" @click="selectFile">
              <Loader2 v-if="selectingFile || loadingPreview" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
              <FolderOpen v-else class="w-3.5 h-3.5 mr-1.5" />
              {{ t('sqlFile.browse') }}
            </Button>
          </div>

          <div v-if="preview" class="border rounded-md overflow-hidden">
            <div class="flex items-center justify-between gap-3 px-3 py-2 text-xs border-b bg-muted/40">
              <div class="min-w-0 flex items-center gap-2">
                <FileCode class="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                <span class="font-medium truncate">{{ preview.fileName }}</span>
              </div>
              <span class="text-muted-foreground shrink-0">{{ formatBytes(preview.sizeBytes) }}</span>
            </div>
            <pre class="max-h-40 overflow-auto p-3 text-xs font-mono whitespace-pre-wrap bg-muted/15">{{ preview.preview }}</pre>
          </div>
        </div>

        <div class="space-y-3">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t('sqlFile.target') }}
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label class="text-xs">{{ t('sqlFile.connection') }}</Label>
              <Select v-model="connectionId" :disabled="running">
                <SelectTrigger class="h-8 text-xs">
                  <div v-if="connectionId" class="flex items-center gap-1.5 min-w-0">
                    <DatabaseIcon :db-type="connectionIconType(connectionId)" class="w-3.5 h-3.5 shrink-0" />
                    <span class="truncate">{{ selectedConnection?.name ?? connectionId }}</span>
                  </div>
                  <SelectValue v-else :placeholder="t('sqlFile.selectConnection')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="c in sqlConnections" :key="c.id" :value="c.id">
                    <div class="flex items-center gap-1.5">
                      <DatabaseIcon :db-type="c.driver_profile || c.db_type" class="w-3.5 h-3.5" />
                      {{ c.name }}
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-1.5">
              <Label class="text-xs">{{ t('sqlFile.database') }}</Label>
              <Select v-if="databaseOptions.length" v-model="database" :disabled="running || loadingDatabases">
                <SelectTrigger class="h-8 text-xs">
                  <SelectValue :placeholder="t('sqlFile.selectDatabase')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="db in databaseOptions" :key="db" :value="db">{{ db }}</SelectItem>
                </SelectContent>
              </Select>
              <div v-else class="relative">
                <Input
                  v-model="database"
                  class="h-8 text-xs"
                  :disabled="running || loadingDatabases"
                  :placeholder="t('sqlFile.databasePlaceholder')"
                />
                <Loader2
                  v-if="loadingDatabases"
                  class="absolute right-2 top-2 w-3.5 h-3.5 animate-spin text-muted-foreground"
                />
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-2.5">
          <div class="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {{ t('sqlFile.options') }}
          </div>

          <button
            type="button"
            class="flex items-center gap-2 text-xs text-left"
            :disabled="running"
            @click="continueOnError = !continueOnError"
          >
            <CheckSquare v-if="continueOnError" class="w-3.5 h-3.5 text-primary shrink-0" />
            <Square v-else class="w-3.5 h-3.5 text-muted-foreground/40 shrink-0" />
            {{ t('sqlFile.continueOnError') }}
          </button>
        </div>

        <div v-if="running || terminalStatus !== 'idle' || progress" class="space-y-3">
          <div class="flex items-center justify-between gap-3 text-xs">
            <div class="flex items-center gap-1.5 min-w-0" :class="statusTone">
              <component :is="statusIcon" class="w-3.5 h-3.5 shrink-0" :class="{ 'animate-spin': running }" />
              <span class="font-medium truncate">
                {{ cancelling ? t('sqlFile.cancelling') : statusLabel(terminalStatus) }}
              </span>
            </div>
            <span v-if="progress" class="text-muted-foreground shrink-0">
              {{ formatElapsed(progress.elapsedMs) }}
            </span>
          </div>

          <div class="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div
              class="h-full rounded-full transition-all duration-300"
              :class="terminalStatus === 'error' ? 'bg-destructive' : terminalStatus === 'cancelled' ? 'bg-yellow-500' : 'bg-primary'"
              :style="{ width: `${progressPercent}%` }"
            />
          </div>

          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div class="border rounded-md px-2 py-1.5 min-w-0">
              <div class="text-muted-foreground truncate">{{ t('sqlFile.statement') }}</div>
              <div class="font-medium truncate">{{ progress?.statementIndex ?? 0 }}</div>
            </div>
            <div class="border rounded-md px-2 py-1.5 min-w-0">
              <div class="text-muted-foreground truncate">{{ t('sqlFile.succeeded') }}</div>
              <div class="font-medium text-green-600 truncate">{{ progress?.successCount ?? 0 }}</div>
            </div>
            <div class="border rounded-md px-2 py-1.5 min-w-0">
              <div class="text-muted-foreground truncate">{{ t('sqlFile.failed') }}</div>
              <div class="font-medium text-destructive truncate">{{ progress?.failureCount ?? 0 }}</div>
            </div>
            <div class="border rounded-md px-2 py-1.5 min-w-0">
              <div class="text-muted-foreground truncate">{{ t('sqlFile.affectedRows') }}</div>
              <div class="font-medium truncate">{{ (progress?.affectedRows ?? 0).toLocaleString() }}</div>
            </div>
          </div>

          <div v-if="progress?.statementSummary" class="space-y-1">
            <Label class="text-xs">{{ t('sqlFile.currentStatement') }}</Label>
            <div class="border rounded-md p-2 text-xs font-mono bg-muted/15 max-h-20 overflow-auto whitespace-pre-wrap">
              {{ progress.statementSummary }}
            </div>
          </div>

          <div v-if="progress?.error || terminalError" class="border rounded-md p-2 text-xs text-destructive bg-destructive/5">
            {{ progress?.error || terminalError }}
          </div>
        </div>
      </div>

      <DialogFooter>
        <template v-if="running">
          <Button variant="destructive" size="sm" :disabled="cancelling" @click="cancelExecution">
            <Loader2 v-if="cancelling" class="w-3.5 h-3.5 mr-1.5 animate-spin" />
            <X v-else class="w-3.5 h-3.5 mr-1.5" />
            {{ cancelling ? t('sqlFile.cancelling') : t('sqlFile.cancel') }}
          </Button>
        </template>
        <template v-else>
          <Button variant="outline" size="sm" @click="open = false">
            {{ t('common.close') }}
          </Button>
          <Button size="sm" :disabled="!canStart" @click="startExecution">
            <Play class="w-3.5 h-3.5 mr-1.5" />
            {{ t('sqlFile.execute') }}
          </Button>
        </template>
      </DialogFooter>
    </DialogScrollContent>
  </Dialog>
</template>

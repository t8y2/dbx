<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, DatabaseBackup, FolderOpen, Loader2, Play, ShieldAlert, Square, X } from "@lucide/vue";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";

const props = defineProps<{ connectionId: string; database: string; mode: "export" | "import" }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const desktop = isTauriRuntime();
const exporting = computed(() => props.mode === "export");
const connection = computed(() => connectionStore.getConfig(props.connectionId));
const readonly = computed(() => !exporting.value && connectionIsEffectivelyReadOnly(connection.value));

const binDir = computed(() => settingsStore.editorSettings.damengClientBinDir.trim());
const toolMissing = computed(() => !binDir.value);

const filePath = ref("");
const schemas = ref(props.database);
const tables = ref("");
const remapFrom = ref("");
const remapTo = ref("");
const tableExistsAction = ref("SKIP");

const running = ref(false);
const cancelling = ref(false);
const confirming = ref(false);
const error = ref("");
const step = ref<"configure" | "result">("configure");
const progress = ref<api.DamengDumpProgress | null>(null);
const taskId = ref("");
let generation = 0;

const tableExistsActionOptions = ["SKIP", "REPLACE", "TRUNCATE", "APPEND"] as const;

const canStart = computed(
  () =>
    desktop &&
    !toolMissing.value &&
    !running.value &&
    !confirming.value &&
    !readonly.value &&
    !!filePath.value.trim() &&
    // Import remap is optional, but a target without a source is a mistake.
    (!exporting.value ? !remapTo.value.trim() || !!remapFrom.value.trim() : true),
);

function resetConfigure() {
  generation += 1;
  filePath.value = "";
  schemas.value = props.database;
  tables.value = "";
  remapFrom.value = "";
  remapTo.value = "";
  tableExistsAction.value = "SKIP";
  error.value = "";
  progress.value = null;
  step.value = "configure";
}
function cleanup() {
  generation += 1;
}
onBeforeUnmount(cleanup);
watch(open, (value) => {
  if (value) resetConfigure();
  else cleanup();
});

async function chooseFile() {
  const dialog = await import("@tauri-apps/plugin-dialog");
  if (exporting.value) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    const path = await dialog.save({
      defaultPath: filePath.value.trim() || `${props.database}-${stamp}.dmp`,
      filters: [{ name: "Dameng dump", extensions: ["dmp"] }],
    });
    if (path) filePath.value = path;
  } else {
    const path = await dialog.open({ multiple: false, filters: [{ name: "Dameng dump", extensions: ["dmp"] }] });
    if (typeof path === "string") filePath.value = path;
  }
}

function parseList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function start() {
  if (!canStart.value) return;
  confirming.value = true;
  const current = ++generation;
  error.value = "";
  progress.value = null;
  try {
    if (!exporting.value) {
      const allowed = await executeWithProductionContextGuard({
        connection: connection.value,
        database: remapTo.value.trim() || schemas.value.trim() || props.database,
        source: t("damengDump.importTitle"),
        reviewText: `IMPORT ${filePath.value.trim()}${remapFrom.value.trim() ? ` REMAP_SCHEMA=${remapFrom.value.trim()}:${remapTo.value.trim() || remapFrom.value.trim()}` : ""} TABLE_EXISTS_ACTION=${tableExistsAction.value}`,
        execute: async () => true,
      });
      if (!allowed || current !== generation || !open.value) return;
    }
    if (current !== generation || !open.value) return;
    running.value = true;
    confirming.value = false;
    step.value = "result";
    taskId.value = uuid();
    await connectionStore.ensureConnected(props.connectionId);
    if (current !== generation) return;
    const toolPath = await api.resolveDamengDumpTool(binDir.value, props.mode);
    if (current !== generation) return;
    const remapSchema: [string, string] | null = !exporting.value && remapFrom.value.trim() ? [remapFrom.value.trim(), remapTo.value.trim() || remapFrom.value.trim()] : null;
    progress.value = await api.startDamengDump(
      {
        taskId: taskId.value,
        connectionId: props.connectionId,
        kind: props.mode,
        toolPath,
        filePath: filePath.value.trim(),
        schemas: parseList(schemas.value),
        tables: exporting.value ? parseList(tables.value) : [],
        remapSchema,
        tableExistsAction: exporting.value ? null : tableExistsAction.value,
      },
      (value) => {
        if (current === generation) progress.value = value;
      },
    );
  } catch (cause) {
    if (current === generation) error.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    confirming.value = false;
    if (current === generation) {
      running.value = false;
      cancelling.value = false;
    }
  }
}
async function cancel() {
  cancelling.value = true;
  try {
    await api.cancelDamengDump(taskId.value);
  } catch (cause) {
    cancelling.value = false;
    error.value = String(cause instanceof Error ? cause.message : cause);
  }
}
function close() {
  if (!running.value) open.value = false;
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
    <DialogScrollContent class="flex max-h-[calc(var(--dbx-viewport-height)-4rem)] min-h-0 flex-col overflow-hidden sm:max-w-[640px]">
      <DialogHeader class="shrink-0 pr-8"
        ><DialogTitle class="flex items-center gap-2 text-base"><DatabaseBackup class="h-4 w-4" />{{ t(exporting ? "damengDump.exportTitle" : "damengDump.importTitle") }}</DialogTitle></DialogHeader
      >
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto py-3 text-sm">
        <div class="border-b pb-2 font-medium break-all">{{ connection?.name }} / {{ props.database }}</div>
        <div v-if="!desktop" class="text-xs text-amber-600">{{ t("damengDump.desktopOnly") }}</div>
        <div v-if="readonly" class="text-xs text-amber-600">{{ t("damengDump.readonly") }}</div>
        <div v-if="toolMissing" class="text-xs text-amber-600">
          {{ t("damengDump.binDirMissing") }}
          <span class="block text-muted-foreground">{{ t("damengDump.binDirSettingHint") }}</span>
        </div>
        <div class="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{{ t("damengDump.passwordOnArgv") }}</span>
        </div>
        <template v-if="step === 'configure'">
          <div class="space-y-1">
            <Label>{{ t(exporting ? "damengDump.outputFile" : "damengDump.inputFile") }}</Label>
            <div class="flex gap-2">
              <Input v-model="filePath" class="h-8 min-w-0" :placeholder="t('damengDump.filePlaceholder')" :disabled="running" />
              <Button variant="outline" size="icon" class="h-8 w-8 shrink-0" :title="t('damengDump.chooseFile')" :aria-label="t('damengDump.chooseFile')" :disabled="running || !desktop" @click="chooseFile">
                <FolderOpen class="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div class="space-y-1">
            <Label>{{ t("damengDump.schemas") }}</Label>
            <Input v-model="schemas" class="h-8" :placeholder="props.database" :disabled="running" />
            <p class="text-xs text-muted-foreground">{{ t("damengDump.schemasHint") }}</p>
          </div>
          <div v-if="exporting" class="space-y-1">
            <Label>{{ t("damengDump.tables") }}</Label>
            <Input v-model="tables" class="h-8" :placeholder="t('damengDump.tablesPlaceholder')" :disabled="running" />
            <p class="text-xs text-muted-foreground">{{ t("damengDump.tablesHint") }}</p>
          </div>
          <div v-if="!exporting" class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <Label>{{ t("damengDump.remapFrom") }}</Label>
              <Input v-model="remapFrom" class="h-8" :placeholder="t('damengDump.remapFromPlaceholder')" :disabled="running" />
            </div>
            <div class="space-y-1">
              <Label>{{ t("damengDump.remapTo") }}</Label>
              <Input v-model="remapTo" class="h-8" :placeholder="t('damengDump.remapToPlaceholder')" :disabled="running" />
            </div>
          </div>
          <div v-if="!exporting" class="space-y-1">
            <Label>{{ t("damengDump.tableExistsAction") }}</Label>
            <Select v-model="tableExistsAction" :disabled="running">
              <SelectTrigger class="h-8 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="action in tableExistsActionOptions" :key="action" :value="action">{{ t(`damengDump.tableExists.${action}`) }}</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">{{ t("damengDump.tableExistsHint") }}</p>
          </div>
        </template>
        <template v-else>
          <div class="flex items-center gap-2 font-medium">
            <Loader2 v-if="running || !progress" class="h-4 w-4 animate-spin" />{{ running ? t("damengDump.running") : progress?.status === "done" ? t("damengDump.done") : progress?.status === "cancelled" ? t("damengDump.cancelled") : t("damengDump.failed") }}
          </div>
          <div class="break-all text-xs text-muted-foreground">{{ filePath }}</div>
          <dl v-if="progress" class="grid grid-cols-2 gap-3 border-y py-3 text-xs">
            <dt>{{ t("damengDump.elapsed") }}</dt>
            <dd class="text-right tabular-nums">{{ progress.elapsedSeconds ?? "-" }}</dd>
            <dt>{{ t("damengDump.warnings") }}</dt>
            <dd class="text-right">{{ progress.warnings ? t("damengDump.warningsPresent") : t("damengDump.warningsNone") }}</dd>
          </dl>
          <div v-if="progress?.error" class="break-words border-l-2 border-destructive pl-3 text-xs text-destructive" role="alert">{{ progress.error }}</div>
        </template>
        <div v-if="error" class="break-words border-l-2 border-destructive pl-3 text-xs text-destructive" role="alert">{{ error }}</div>
      </div>
      <DialogFooter class="shrink-0"
        ><Button v-if="running" variant="destructive" :disabled="cancelling" @click="cancel"><Square class="mr-1.5 h-4 w-4" />{{ t("damengDump.cancel") }}</Button
        ><Button v-else variant="outline" :disabled="cancelling || confirming" @click="close"><X class="mr-1.5 h-4 w-4" />{{ t("damengDump.close") }}</Button
        ><Button v-if="step !== 'configure' && !running" variant="outline" :disabled="confirming" @click="step = 'configure'"><ArrowLeft class="mr-1.5 h-4 w-4" />{{ t("damengDump.back") }}</Button
        ><Button v-if="step === 'configure'" :disabled="!canStart" @click="start"><Play class="mr-1.5 h-4 w-4" />{{ t(exporting ? "damengDump.startExport" : "damengDump.startImport") }}</Button></DialogFooter
      >
    </DialogScrollContent>
  </Dialog>
</template>

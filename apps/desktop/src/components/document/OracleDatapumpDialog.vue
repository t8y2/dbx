<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, DatabaseBackup, FolderCog, Loader2, ChevronDown, ChevronUp, Minimize2, Play, Plus, Server, Square, Trash2, X } from "@lucide/vue";
import { Dialog, DialogFooter, DialogHeader, DialogScrollContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useConnectionStore } from "@/stores/connectionStore";
import { useOracleDatapumpTask } from "@/composables/useOracleDatapumpTask";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";

const props = defineProps<{ connectionId: string; database: string; mode: "export" | "import" }>();
const open = defineModel<boolean>("open", { default: false });
const { t } = useI18n();
const connectionStore = useConnectionStore();
const desktop = isTauriRuntime();
const exporting = computed(() => props.mode === "export");
const connection = computed(() => connectionStore.getConfig(props.connectionId));
const readonly = computed(() => !exporting.value && connectionIsEffectivelyReadOnly(connection.value));

const directories = ref<api.OracleDatapumpDirectory[]>([]);
const directoriesFailed = ref(false);
const directoriesError = ref("");
// 管理面板：管理的是数据库里的 DIRECTORY 别名对象，绝不触碰服务器文件系统。
const manageOpen = ref(false);
const newName = ref("");
const newPath = ref("");
const creatingDir = ref(false);
const droppingName = ref("");
// 管理面板顶部的错误反馈行；成功提示走全局 toast（长 ORA 详情不适合放在会自动消失的 toast 里）。
const manageSuccess = ref<string | null>(null);
const manageError = ref<string | null>(null);
const manageErrorExpanded = ref(false);
let manageSuccessTimer = 0;
const directory = ref("");
const dumpfile = ref("");
const logfile = ref("");
const jobMode = ref<"schema" | "table">("schema");
const schemas = ref(props.database);
const tables = ref("");
const remapTo = ref("");
const tableExistsAction = ref("SKIP");
const compression = ref("NONE");

const dpTask = useOracleDatapumpTask();
// 多任务：对话框绑定 activeTask（药丸点击设置）；anyRunning 控制 X 按钮隐藏。
const activeTask = computed(() => dpTask.tasks.value.find((t) => t.taskId === dpTask.activeTaskId.value) ?? null);
const anyRunning = computed(() => dpTask.tasks.value.some((t) => t.running));
const running = computed(() => activeTask.value?.running ?? false);
const progress = computed(() => activeTask.value?.progress ?? null);
const localError = ref("");
const error = computed(() => activeTask.value?.error || localError.value);
const step = computed(() => dpTask.viewMode.value);
const cancelling = ref(false);
const confirming = ref(false);
// 最小化状态放在 composable：常驻药丸组件需要读它。
const minimized = dpTask.dialogMinimized;
let generation = 0;

const tableExistsActionOptions = ["SKIP", "REPLACE", "TRUNCATE", "APPEND"] as const;
const selectedDirectoryPath = computed(() => directories.value.find((item) => item.name === directory.value)?.path);

const canStart = computed(
  () =>
    desktop &&
    !running.value &&
    !confirming.value &&
    !readonly.value &&
    !!directory.value.trim() &&
    !!dumpfile.value.trim() &&
    (jobMode.value === "schema" ? !!schemas.value.trim() : !!tables.value.trim()) &&
    // 导入时目标模式必填：空值会导致数据静默落入 dump 原模式名（不是你右键的那个）。
    (exporting.value || !!remapTo.value.trim()),
);

function defaultDumpfile() {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `${props.database}-${stamp}.dmp`;
}

function resetConfigure() {
  generation += 1;
  minimized.value = false;
  // 从最小化恢复：还原保存的表单（不清空），让用户继续配置。
  if (dpTask.formMinimized.value && dpTask.savedForm.value) {
    const saved = dpTask.savedForm.value;
    dpTask.formMinimized.value = false;
    directory.value = saved.directory || "";
    dumpfile.value = saved.dumpfile || defaultDumpfile();
    logfile.value = saved.logfile || "";
    jobMode.value = (saved.jobMode as "schema" | "table") || "schema";
    schemas.value = saved.schemas ?? (exporting.value ? props.database : "");
    tables.value = saved.tables || "";
    remapTo.value = saved.remapTo ?? (exporting.value ? "" : props.database);
    tableExistsAction.value = saved.tableExistsAction || "SKIP";
    compression.value = saved.compression || "NONE";
    dpTask.openConfigure();
    void loadDirectories();
    return;
  }
  directories.value = [];
  directoriesFailed.value = false;
  directoriesError.value = "";
  manageOpen.value = false;
  newName.value = "";
  newPath.value = "";
  clearManageFeedback();
  directory.value = "";
  dumpfile.value = defaultDumpfile();
  logfile.value = "";
  jobMode.value = "schema";
  // 导出：源模式 = 你右键的模式（导出它自己）
  // 导入：源模式 = 空手填（必须匹配 dump 里的名字），目标 = 你右键的模式（你要放到哪）
  if (exporting.value) {
    schemas.value = props.database;
  } else {
    schemas.value = "";
    remapTo.value = props.database;
  }
  tables.value = "";
  tableExistsAction.value = "SKIP";
  compression.value = "NONE";
  localError.value = "";
  // 菜单打开永远进 configure（新表单）。pill 恢复靠 indicator 的 nextTick
  // focusTask 覆盖——不需要在这里判断 activeTaskId（begin() 启动任务时也会
  // 设 activeTaskId，会导致菜单再开时误入旧任务的结果页）。
  dpTask.openConfigure();
  void loadDirectories();
}
function cleanup() {
  generation += 1;
  dpTask.dialogOpen.value = false;
  dpTask.dialogMinimized.value = false;
}
onBeforeUnmount(cleanup);
watch(
  open,
  (value) => {
    dpTask.dialogOpen.value = value;
    if (value) resetConfigure();
    else cleanup();
  },
  // immediate 覆盖"挂载时对话框已打开"的场景（AppDialogs 的 v-if
  // 挂载总是伴随 open=true，测试也是直接以 open=true 挂载）。
  { immediate: true },
);

async function loadDirectories() {
  const current = generation;
  directoriesFailed.value = false;
  try {
    await connectionStore.ensureConnected(props.connectionId);
    if (current !== generation) return;
    directories.value = await api.listOracleDatapumpDirectories(props.connectionId, props.database);
    if (current !== generation) return;
    if (!directories.value.some((item) => item.name === directory.value)) {
      // 服务器上有惯用默认目录（DATA_PUMP_DIR）时优先选它。
      directory.value = directories.value.find((item) => item.name === "DATA_PUMP_DIR")?.name ?? directories.value[0]?.name ?? "";
    }
  } catch (cause) {
    if (current === generation) {
      directoriesFailed.value = true;
      // Show the tagged backend reason so "list failed" is diagnosable
      // (e.g. agent without datapump_v1) instead of a bare hint.
      directoriesError.value = String(cause instanceof Error ? cause.message : cause);
    }
  }
}

const manageErrorFirstLine = computed(() => manageError.value?.split("\n")[0] ?? "");
const manageErrorRemaining = computed(() => (manageError.value?.split("\n") ?? []).slice(1).join("\n"));
const manageErrorHasDetails = computed(() => (manageError.value?.split("\n").length ?? 0) > 1);

function showManageSuccess(text: string) {
  window.clearTimeout(manageSuccessTimer);
  manageSuccess.value = text;
  manageError.value = null;
  manageSuccessTimer = window.setTimeout(() => {
    manageSuccess.value = null;
  }, 4000);
}

function showManageError(text: string) {
  window.clearTimeout(manageSuccessTimer);
  manageError.value = text;
  manageSuccess.value = null;
  manageErrorExpanded.value = false;
}

function clearManageFeedback() {
  window.clearTimeout(manageSuccessTimer);
  manageSuccess.value = null;
  manageError.value = null;
  manageErrorExpanded.value = false;
}

async function createDirectory() {
  if (!newName.value.trim() || !newPath.value.trim() || creatingDir.value) return;
  creatingDir.value = true;
  clearManageFeedback();
  try {
    await api.createOracleDatapumpDirectory(props.connectionId, props.database, newName.value.trim(), newPath.value.trim());
    showManageSuccess(t("oracleDatapump.directoryCreated", { name: newName.value.trim().toUpperCase() }));
    newName.value = "";
    newPath.value = "";
    await loadDirectories();
  } catch (cause) {
    showManageError(String(cause instanceof Error ? cause.message : cause));
  } finally {
    creatingDir.value = false;
  }
}

async function removeDirectory(name: string) {
  if (droppingName.value || running.value) return;
  if (!window.confirm(t("oracleDatapump.confirmDelete", { name }))) return;
  droppingName.value = name;
  clearManageFeedback();
  try {
    // 删除属于破坏性操作：走生产上下文保护复核。
    const allowed = await executeWithProductionContextGuard({
      connection: connection.value,
      database: props.database,
      source: t("oracleDatapump.importTitle"),
      reviewText: `DROP DIRECTORY ${name}`,
      execute: async () => true,
    });
    if (!allowed) return;
    await api.dropOracleDatapumpDirectory(props.connectionId, props.database, name);
    showManageSuccess(t("oracleDatapump.directoryDropped", { name }));
    if (directory.value === name) directory.value = "";
    await loadDirectories();
  } catch (cause) {
    showManageError(String(cause instanceof Error ? cause.message : cause));
  } finally {
    droppingName.value = "";
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
  localError.value = "";
  try {
    if (!exporting.value) {
      const allowed = await executeWithProductionContextGuard({
        connection: connection.value,
        database: remapTo.value.trim() || schemas.value.trim() || props.database,
        source: t("oracleDatapump.importTitle"),
        reviewText: `IMPORT ${directory.value.trim()}:${dumpfile.value.trim()}${remapTo.value.trim() ? ` REMAP_SCHEMA=${parseList(schemas.value)[0]}:${remapTo.value.trim()}` : ""} TABLE_EXISTS_ACTION=${tableExistsAction.value}`,
        execute: async () => true,
      });
      if (!allowed || current !== generation || !open.value) return;
    }
    if (current !== generation || !open.value) return;
    dpTask.openResult();
    confirming.value = false;
    await connectionStore.ensureConnected(props.connectionId);
    if (current !== generation) return;
    dpTask.begin({
      connectionId: props.connectionId,
      database: props.database,
      kind: props.mode,
      mode: jobMode.value,
      directory: directory.value.trim(),
      dumpfile: dumpfile.value.trim(),
      logfile: logfile.value.trim() || null,
      schemas: jobMode.value === "schema" ? parseList(schemas.value) : [],
      tables: jobMode.value === "table" ? parseList(tables.value) : [],
      // 源 = 目标时不发 REMAP（同名映射无意义，Oracle 会警告）。
      remapSchemaFrom: !exporting.value && remapTo.value.trim() && remapTo.value.trim() !== (parseList(schemas.value)[0] || parseList(tables.value)[0]?.split(".")[0] || props.database) ? parseList(schemas.value)[0] || parseList(tables.value)[0]?.split(".")[0] || props.database : null,
      remapSchemaTo: !exporting.value && remapTo.value.trim() && remapTo.value.trim() !== (parseList(schemas.value)[0] || parseList(tables.value)[0]?.split(".")[0] || props.database) ? remapTo.value.trim() : null,
      tableExistsAction: exporting.value ? null : tableExistsAction.value,
      compression: exporting.value && compression.value === "ALL",
    });
  } catch (cause) {
    if (current === generation) localError.value = String(cause instanceof Error ? cause.message : cause);
  } finally {
    confirming.value = false;
  }
}
async function cancel() {
  cancelling.value = true;
  try {
    if (activeTask.value) await dpTask.cancel(activeTask.value.taskId);
  } catch (cause) {
    cancelling.value = false;
    localError.value = String(cause instanceof Error ? cause.message : cause);
  }
}
// 最小化：无论是否在运行都收到右下角药丸（对齐 TableImportDialog；
// 空闲最小化时药丸显示警示图标 + 可直接关闭）。
// 关闭（X/Esc/页脚）：运行中保护为最小化，任务不丢失。
// 最小化 = 直接关闭弹窗（药丸独立于弹窗，永远在右下角）。
// 点药丸的恢复按钮会重新打开弹窗并显示对应任务的结果页。
// 最小化 = 保存表单 → 关弹窗。有任务：药丸显示进度；没任务：药丸显示"继续配置"。
function minimize() {
  dpTask.savedForm.value = {
    directory: directory.value,
    dumpfile: dumpfile.value,
    logfile: logfile.value,
    jobMode: jobMode.value,
    schemas: schemas.value,
    tables: tables.value,
    remapTo: remapTo.value,
    tableExistsAction: tableExistsAction.value,
    compression: compression.value,
  };
  dpTask.formMinimized.value = true;
  open.value = false;
}
// 关闭（X）= 关弹窗 + 清任务药丸 + 丢弃保存的表单（用户不要了）。
function close() {
  if (activeTask.value && !activeTask.value.running) {
    dpTask.dismiss(activeTask.value.taskId);
  }
  dpTask.formMinimized.value = false;
  dpTask.savedForm.value = null;
  open.value = false;
}
// 阶段标签：Oracle 的 phase 数字 → 用户可读文本；
// 100% + 仍在运行 = 后处理（数据传完了，Oracle 还在重建索引/编译对象）。
const phaseLabel = computed(() => {
  if (!running.value) return "";
  if ((progress.value?.percent ?? 0) >= 100) return t("oracleDatapump.phasePostProcessing");
  const phase = progress.value?.phaseCode;
  if (phase == null) return "";
  const labels: Record<number, string> = {
    1: t("oracleDatapump.phaseDefining"),
    2: t("oracleDatapump.phaseExecuting"),
    3: t("oracleDatapump.phaseFinalizing"),
  };
  return labels[phase] ?? "";
});

const elapsedSeconds = computed(() => (progress.value?.elapsedMs != null ? `${(progress.value.elapsedMs / 1000).toFixed(1)}s` : null));
</script>

<template>
  <Dialog
    :open="open"
    @update:open="
      (value) => {
        if (!value) open = false;
      }
    "
  >
    <DialogScrollContent :show-close-button="false" class="flex max-h-[calc(var(--dbx-viewport-height)-4rem)] min-h-0 flex-col overflow-hidden sm:max-w-[640px]">
      <DialogHeader class="flex shrink-0 flex-row items-center pr-2 pt-1"
        ><DialogTitle class="flex min-w-0 flex-1 items-center gap-2 text-base"><DatabaseBackup class="h-4 w-4" />{{ t(exporting ? "oracleDatapump.exportTitle" : "oracleDatapump.importTitle") }}</DialogTitle>
        <Button variant="ghost" size="icon-sm" :aria-label="t('oracleDatapump.minimize')" :title="t('oracleDatapump.minimize')" @click="minimize">
          <Minimize2 class="h-4 w-4" />
        </Button>
        <Button v-if="!anyRunning" variant="ghost" size="icon-sm" :aria-label="t('common.close')" :title="t('common.close')" @click="close"> <X class="h-4 w-4" /> </Button
      ></DialogHeader>
      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto py-3 text-sm">
        <div class="border-b pb-2 font-medium break-all">{{ connection?.name }} / {{ props.database }}</div>
        <div v-if="!desktop" class="text-xs text-amber-600">{{ t("oracleDatapump.desktopOnly") }}</div>
        <div v-if="readonly" class="text-xs text-amber-600">{{ t("oracleDatapump.readonly") }}</div>
        <div class="flex items-start gap-2 text-xs text-muted-foreground">
          <Server class="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{{ t("oracleDatapump.serverSideHint") }}</span>
        </div>
        <template v-if="step === 'configure'">
          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <Label>{{ t("oracleDatapump.directory") }}</Label>
              <Button variant="ghost" size="sm" :disabled="running" @click="manageOpen = !manageOpen"> <FolderCog />{{ t("oracleDatapump.manage") }} </Button>
            </div>
            <Select v-if="directories.length" v-model="directory" :disabled="running">
              <SelectTrigger class="h-8 w-full"><SelectValue :placeholder="t('oracleDatapump.directoryPlaceholder')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="item in directories" :key="item.name" :value="item.name">
                  <div class="flex flex-col items-start">
                    <span>{{ item.name }}</span>
                    <span v-if="item.path" class="text-xs text-muted-foreground">{{ item.path }}</span>
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            <Input v-else v-model="directory" class="h-8" :placeholder="t('oracleDatapump.directoryPlaceholder')" :disabled="running" />
            <p v-if="selectedDirectoryPath" class="break-all text-xs text-muted-foreground">{{ selectedDirectoryPath }}</p>
            <p v-if="directoriesFailed" class="text-xs text-amber-600">
              {{ t("oracleDatapump.directoryListFailed") }}
              <span v-if="directoriesError" class="block break-all text-muted-foreground">{{ directoriesError }}</span>
            </p>
            <p class="text-xs text-muted-foreground">{{ t("oracleDatapump.directoryHint") }}</p>
            <div v-if="manageOpen" class="space-y-2 rounded-md border p-2">
              <p v-if="manageSuccess" class="text-xs text-emerald-600 dark:text-emerald-400">{{ manageSuccess }}</p>
              <div v-if="manageError" class="text-xs">
                <div class="flex items-center gap-1">
                  <span class="min-w-0 flex-1 truncate text-red-500" :title="manageErrorFirstLine">{{ manageErrorFirstLine }}</span>
                  <Button v-if="manageErrorHasDetails" variant="ghost" size="icon-sm" class="h-5 w-5 shrink-0" @click="manageErrorExpanded = !manageErrorExpanded">
                    <ChevronDown v-if="!manageErrorExpanded" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                  </Button>
                </div>
                <div v-if="manageErrorExpanded" class="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-red-500/50 pl-2 text-muted-foreground">{{ manageErrorRemaining }}</div>
              </div>
              <p class="text-xs text-muted-foreground">{{ t("oracleDatapump.manageHint") }}</p>
              <div class="max-h-40 space-y-1 overflow-y-auto">
                <div v-for="item in directories" :key="item.name" class="flex items-center gap-2 text-xs">
                  <span class="min-w-0 flex-1 truncate font-medium">{{ item.name }}</span>
                  <span class="min-w-0 flex-1 truncate text-muted-foreground" :title="item.path">{{ item.path }}</span>
                  <Button variant="ghost" size="icon" class="shrink-0" :title="t('oracleDatapump.deleteButton')" :aria-label="t('oracleDatapump.deleteButton')" :disabled="running || !!droppingName" @click="removeDirectory(item.name)">
                    <Trash2 />
                  </Button>
                </div>
                <p v-if="!directories.length" class="text-xs text-muted-foreground">-</p>
              </div>
              <div class="flex gap-2">
                <Input v-model="newName" class="min-w-0 flex-1" :placeholder="t('oracleDatapump.newNamePlaceholder')" :disabled="creatingDir" />
                <Input v-model="newPath" class="min-w-0 flex-1" :placeholder="t('oracleDatapump.newPathPlaceholder')" :disabled="creatingDir" />
                <Button variant="outline" size="sm" class="shrink-0" :disabled="creatingDir || !newName.trim() || !newPath.trim()" @click="createDirectory"> <Plus />{{ t("oracleDatapump.createButton") }} </Button>
              </div>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <Label>{{ t(exporting ? "oracleDatapump.outputFile" : "oracleDatapump.inputFile") }}</Label>
              <Input v-model="dumpfile" class="h-8" :placeholder="defaultDumpfile()" :disabled="running" />
            </div>
            <div class="space-y-1">
              <Label>{{ t("oracleDatapump.logFile") }}</Label>
              <Input v-model="logfile" class="h-8" :placeholder="t('oracleDatapump.logFilePlaceholder')" :disabled="running" />
            </div>
          </div>
          <div class="space-y-1">
            <Label>{{ t("oracleDatapump.jobMode") }}</Label>
            <Select v-model="jobMode" :disabled="running">
              <SelectTrigger class="h-8 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="schema">{{ t("oracleDatapump.jobModes.schema") }}</SelectItem>
                <SelectItem value="table">{{ t("oracleDatapump.jobModes.table") }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div v-if="jobMode === 'schema'" class="space-y-1">
            <Label>{{ t("oracleDatapump.schemas") }}</Label>
            <Input v-model="schemas" class="h-8" :placeholder="exporting ? props.database : t('oracleDatapump.importSourcePlaceholder')" :disabled="running" />
            <p class="text-xs text-muted-foreground">{{ t("oracleDatapump.schemasHint") }}</p>
          </div>
          <div v-else class="space-y-1">
            <Label>{{ t("oracleDatapump.tables") }}</Label>
            <Input v-model="tables" class="h-8" :placeholder="t('oracleDatapump.tablesPlaceholder')" :disabled="running" />
            <p class="text-xs text-muted-foreground">{{ t("oracleDatapump.tablesHint") }}</p>
          </div>
          <div v-if="!exporting" class="space-y-1">
            <Label>{{ t("oracleDatapump.remapTo") }}</Label>
            <Input v-model="remapTo" class="h-8" :placeholder="t('oracleDatapump.remapToPlaceholder')" :disabled="running" />
            <p class="text-xs text-muted-foreground">{{ t("oracleDatapump.remapToHint") }}</p>
          </div>
          <div v-if="!exporting" class="space-y-1">
            <Label>{{ t("oracleDatapump.tableExistsAction") }}</Label>
            <Select v-model="tableExistsAction" :disabled="running">
              <SelectTrigger class="h-8 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="action in tableExistsActionOptions" :key="action" :value="action">{{ t(`oracleDatapump.tableExists.${action}`) }}</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">{{ t("oracleDatapump.tableExistsHint") }}</p>
          </div>
          <div v-if="exporting" class="space-y-1">
            <Label>{{ t("oracleDatapump.compression") }}</Label>
            <Select v-model="compression" :disabled="running">
              <SelectTrigger class="h-8 w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="NONE">{{ t("oracleDatapump.compressionNone") }}</SelectItem>
                <SelectItem value="ALL">{{ t("oracleDatapump.compressionAll") }}</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">{{ t("oracleDatapump.compressionHint") }}</p>
          </div>
        </template>
        <template v-else>
          <div class="flex items-center gap-2 font-medium">
            <Loader2 v-if="running || !progress" class="h-4 w-4 animate-spin" />{{ running ? t("oracleDatapump.running") : progress?.status === "Done" ? t("oracleDatapump.done") : progress?.status === "Cancelled" ? t("oracleDatapump.cancelled") : t("oracleDatapump.failed") }}
          </div>
          <div class="break-all text-xs text-muted-foreground">{{ directory }} / {{ dumpfile }}</div>
          <dl v-if="progress" class="grid grid-cols-2 gap-3 border-y py-3 text-xs">
            <dt>{{ t("oracleDatapump.progress") }}</dt>
            <dd class="text-right tabular-nums">{{ progress.percent != null ? `${Math.round(progress.percent)}%` : "-" }}</dd>
            <template v-if="phaseLabel">
              <dt>{{ t("oracleDatapump.phase") }}</dt>
              <dd class="text-right">{{ phaseLabel }}</dd>
            </template>
            <dt>{{ t("oracleDatapump.jobState") }}</dt>
            <dd class="text-right">{{ progress.jobState || progress.state || "-" }}</dd>
            <dt>{{ t("oracleDatapump.elapsed") }}</dt>
            <dd class="text-right tabular-nums">{{ elapsedSeconds ?? "-" }}</dd>
            <dt>{{ t("oracleDatapump.errors") }}</dt>
            <dd class="text-right tabular-nums">{{ progress.errorCount ?? 0 }}</dd>
          </dl>
          <div v-if="progress?.errorText" class="max-h-40 overflow-y-auto whitespace-pre-wrap break-words border-l-2 border-amber-500 pl-3 text-xs" role="note">{{ progress.errorText }}</div>
        </template>
        <div v-if="error" class="break-words border-l-2 border-destructive pl-3 text-xs text-destructive" role="alert">{{ error }}</div>
      </div>
      <DialogFooter class="shrink-0"
        ><Button v-if="running" variant="destructive" :disabled="cancelling" @click="cancel"><Square class="mr-1.5 h-4 w-4" />{{ t("oracleDatapump.cancel") }}</Button
        ><Button v-else variant="outline" :disabled="cancelling || confirming" @click="close"><X class="mr-1.5 h-4 w-4" />{{ t("oracleDatapump.close") }}</Button
        ><Button v-if="step !== 'configure' && !running" variant="outline" :disabled="confirming" @click="dpTask.openConfigure()"><ArrowLeft class="mr-1.5 h-4 w-4" />{{ t("oracleDatapump.back") }}</Button
        ><Button v-if="step === 'configure'" :disabled="!canStart" @click="start"><Play class="mr-1.5 h-4 w-4" />{{ t(exporting ? "oracleDatapump.startExport" : "oracleDatapump.startImport") }}</Button></DialogFooter
      >
    </DialogScrollContent>
  </Dialog>
</template>

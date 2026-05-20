<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { useI18n } from "vue-i18n";
import { FolderOpen, Trash2, Download, RotateCcw, Loader2, RefreshCw, Check, Clock3, FileUp } from "lucide-vue-next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DriverInstallProgressCircle from "@/components/config/DriverInstallProgressCircle.vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { countAvailableDriverUpdates } from "@/lib/agentDriverUpdateBadge";
import type { JdbcDriverInfo, JdbcPluginStatus } from "@/types/database";
import * as api from "@/lib/api";
import type { AgentDriverInfo, JavaRuntimeConfig } from "@/lib/api";
import {
  addDriverInstallQueue,
  driverInstallProgressPercent,
  isDriverInstallProgressTarget,
  removeDriverInstallQueue,
  takeNextDriverInstallQueue,
  type DriverInstallProgress,
} from "@/lib/driverInstallProgressUi";

const { t } = useI18n();
const { toast } = useToast();
const isWeb = !isTauriRuntime();

const emit = defineEmits<{
  "update-count-change": [count: number];
}>();

// ──────────── Agent drivers ────────────

const drivers = ref<AgentDriverInfo[]>([]);
const installing = ref<string | null>(null);
const upgradingAll = ref(false);
const upgradingCurrent = ref("");
const upgradingIndex = ref(0);
const upgradingTotal = ref(0);
const queuedDriverInstalls = ref<string[]>([]);
const reinstallingJre = ref<string | null>(null);
const refreshing = ref(false);
const progress = ref<DriverInstallProgress | null>(null);
const javaRuntimeConfig = ref<JavaRuntimeConfig>({ mode: "managed", custom_java_path: null });
const customJavaPath = ref("");
const savingJavaRuntime = ref(false);

let unlisten: (() => void) | null = null;

const installedJres = computed(() => {
  const jreMap = new Map<string, boolean>();
  for (const d of drivers.value) {
    if (!jreMap.has(d.jre)) {
      jreMap.set(d.jre, d.jre_installed);
    }
  }
  return [...jreMap.entries()]
    .map(([key, installed]) => ({ key, installed }))
    .sort((a, b) => b.key.localeCompare(a.key));
});

const progressText = computed(() => {
  const p = progress.value;
  if (!p) return "";
  if (p.step === "jre-extract") return "解压 JRE...";
  const label = p.step === "jre" ? "下载 JRE" : "下载驱动";
  if (!p.total) return `${label}...`;
  const pct = Math.round(((p.downloaded ?? 0) / p.total) * 100);
  const dl = formatSize(p.downloaded ?? 0);
  const total = formatSize(p.total);
  const prefix =
    upgradingAll.value && upgradingCurrent.value
      ? `[${upgradingIndex.value}/${upgradingTotal.value}] ${upgradingCurrent.value} — `
      : "";
  return `${prefix}${label}  ${dl} / ${total}  (${pct}%)`;
});

const progressNumber = computed(() => driverInstallProgressPercent(progress.value));

const updatableCount = computed(() => drivers.value.filter((d) => d.update_available).length);

function updateAgentDrivers(nextDrivers: AgentDriverInfo[]) {
  drivers.value = nextDrivers;
  emitDriverUpdateCount();
}

function emitDriverUpdateCount() {
  emit("update-count-change", countAvailableDriverUpdates(drivers.value, jdbcPluginStatus.value));
}

function isDriverProgressActive(dbType: string): boolean {
  return isDriverInstallProgressTarget(dbType, {
    installing: installing.value,
    upgradingAll: upgradingAll.value,
    progress: progress.value,
  });
}

function progressTitle(fallback: string): string {
  return progressText.value || fallback;
}

function isDriverQueued(dbType: string): boolean {
  return queuedDriverInstalls.value.includes(dbType);
}

function canInstallOrUpdateDriver(dbType: string): boolean {
  const driver = drivers.value.find((d) => d.db_type === dbType);
  return Boolean(driver && (!driver.installed || driver.update_available));
}

function queueDriverInstall(dbType: string) {
  queuedDriverInstalls.value = addDriverInstallQueue(queuedDriverInstalls.value, dbType, installing.value);
}

function removeQueuedDriverInstall(dbType: string) {
  queuedDriverInstalls.value = removeDriverInstallQueue(queuedDriverInstalls.value, dbType);
}

async function refreshAgents() {
  updateAgentDrivers(await api.listInstalledAgents());
}

async function forceRefresh() {
  refreshing.value = true;
  try {
    await api.invalidateAgentRegistryCache();
    await refreshAgents();
  } finally {
    refreshing.value = false;
  }
}

async function loadJavaRuntimeConfig() {
  const config = await api.getAgentJavaRuntimeConfig();
  javaRuntimeConfig.value = config;
  customJavaPath.value = config.custom_java_path ?? "";
}

function setJavaRuntimeMode(value: any) {
  if (value === "managed" || value === "system" || value === "custom") {
    javaRuntimeConfig.value.mode = value;
  }
}

async function saveJavaRuntimeConfig() {
  savingJavaRuntime.value = true;
  try {
    const config = await api.setAgentJavaRuntimeConfig({
      mode: javaRuntimeConfig.value.mode,
      custom_java_path: javaRuntimeConfig.value.mode === "custom" ? customJavaPath.value.trim() || null : null,
    });
    javaRuntimeConfig.value = config;
    customJavaPath.value = config.custom_java_path ?? "";
    toast("Java 运行时设置已保存");
  } catch (e: any) {
    toast(`Java 运行时设置失败: ${e}`);
  } finally {
    savingJavaRuntime.value = false;
  }
}

async function chooseCustomJavaPath() {
  if (isWeb) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "选择 Java 可执行文件",
    multiple: false,
  });
  if (typeof selected === "string") {
    customJavaPath.value = selected;
  }
}

async function installDriver(dbType: string) {
  if (installing.value !== null || upgradingAll.value) {
    queueDriverInstall(dbType);
    return;
  }
  await runDriverInstall(dbType);
  await runQueuedDriverInstalls();
}

async function runDriverInstall(dbType: string) {
  const label = drivers.value.find((d) => d.db_type === dbType)?.label ?? dbType;
  installing.value = dbType;
  progress.value = null;
  try {
    await api.installAgent(dbType);
    await refreshAgents();
    toast(`${label} 驱动安装成功`);
  } catch (e: any) {
    toast(`${label} 驱动安装失败: ${e}`);
  } finally {
    installing.value = null;
    progress.value = null;
  }
}

async function runQueuedDriverInstalls() {
  if (installing.value !== null || upgradingAll.value) return;

  const result = takeNextDriverInstallQueue(queuedDriverInstalls.value, canInstallOrUpdateDriver);
  queuedDriverInstalls.value = result.queue;
  if (!result.next) return;

  await runDriverInstall(result.next);
  await runQueuedDriverInstalls();
}

async function upgradeAll() {
  upgradingAll.value = true;
  queuedDriverInstalls.value = [];
  progress.value = null;
  try {
    const count = await api.upgradeAllAgents();
    await refreshAgents();
    toast(`${count} 个驱动升级完成`);
  } catch (e: any) {
    toast(`批量升级失败: ${e}`);
  } finally {
    upgradingAll.value = false;
    upgradingCurrent.value = "";
    upgradingIndex.value = 0;
    upgradingTotal.value = 0;
    progress.value = null;
  }
}

async function uninstallDriver(dbType: string) {
  const label = drivers.value.find((d) => d.db_type === dbType)?.label ?? dbType;
  try {
    await api.uninstallAgent(dbType);
    await refreshAgents();
    toast(`${label} 驱动已卸载`);
  } catch (e: any) {
    toast(`${label} 驱动卸载失败: ${e}`);
  }
}

const importingZip = ref(false);

async function importOfflineZip() {
  if (isWeb || importingZip.value) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "选择离线驱动包",
    multiple: false,
    filters: [{ name: "ZIP", extensions: ["zip"] }],
  });
  if (typeof selected !== "string") return;
  importingZip.value = true;
  progress.value = null;
  try {
    const count = await api.importAgentsFromZip(selected);
    await refreshAgents();
    toast(`离线导入完成，已安装 ${count} 个驱动`);
  } catch (e: any) {
    toast(`离线导入失败: ${e}`);
  } finally {
    importingZip.value = false;
    progress.value = null;
  }
}

async function importDriverJar(dbType: string) {
  if (isWeb) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "选择驱动 JAR 文件",
    multiple: false,
    filters: [{ name: "JAR", extensions: ["jar"] }],
  });
  if (typeof selected !== "string") return;
  const label = drivers.value.find((d) => d.db_type === dbType)?.label ?? dbType;
  try {
    await api.importAgentJar(dbType, selected);
    await refreshAgents();
    toast(`${label} 驱动导入成功`);
  } catch (e: any) {
    toast(`${label} 驱动导入失败: ${e}`);
  }
}

async function reinstallJre(jreKey: string) {
  reinstallingJre.value = jreKey;
  progress.value = null;
  try {
    await api.reinstallJre(jreKey);
    await refreshAgents();
    toast(`JRE ${jreKey} 重新安装成功`);
  } catch (e: any) {
    toast(`JRE ${jreKey} 重新安装失败: ${e}`);
  } finally {
    reinstallingJre.value = null;
    progress.value = null;
  }
}

async function uninstallJre(jreKey: string) {
  try {
    await api.uninstallJre(jreKey);
    await refreshAgents();
    toast(`JRE ${jreKey} 已卸载`);
  } catch (e: any) {
    toast(String(e));
  }
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ──────────── JDBC drivers ────────────

const jdbcDrivers = ref<JdbcDriverInfo[]>([]);
const isLoadingJdbcDrivers = ref(false);
const jdbcPluginStatus = ref<JdbcPluginStatus | null>(null);
const isInstallingJdbcPlugin = ref(false);
const isUninstallingJdbcPlugin = ref(false);
const jdbcDriverPathInput = ref("");

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadJdbcDrivers() {
  if (isWeb) return;
  isLoadingJdbcDrivers.value = true;
  try {
    jdbcDrivers.value = await api.listJdbcDrivers();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  } finally {
    isLoadingJdbcDrivers.value = false;
  }
}

async function loadJdbcPluginStatus() {
  if (isWeb) return;
  try {
    jdbcPluginStatus.value = await api.jdbcPluginStatus();
    emitDriverUpdateCount();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  }
}

async function installJdbcPlugin() {
  if (isWeb || isInstallingJdbcPlugin.value) return;
  isInstallingJdbcPlugin.value = true;
  try {
    jdbcPluginStatus.value = await api.installJdbcPlugin();
    emitDriverUpdateCount();
    toast(t("settings.jdbcPluginInstallSuccess"));
    await loadJdbcDrivers();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  } finally {
    isInstallingJdbcPlugin.value = false;
  }
}

async function installJdbcPluginLocal() {
  if (isWeb || isInstallingJdbcPlugin.value) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "选择 JDBC 插件 zip 文件",
    multiple: false,
    filters: [{ name: "ZIP", extensions: ["zip"] }],
  });
  if (typeof selected !== "string") return;
  isInstallingJdbcPlugin.value = true;
  try {
    jdbcPluginStatus.value = await api.installJdbcPluginLocal(selected);
    emitDriverUpdateCount();
    toast(t("settings.jdbcPluginInstallSuccess"));
    await loadJdbcDrivers();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  } finally {
    isInstallingJdbcPlugin.value = false;
  }
}

async function uninstallJdbcPlugin() {
  if (isWeb || isUninstallingJdbcPlugin.value) return;
  isUninstallingJdbcPlugin.value = true;
  try {
    jdbcPluginStatus.value = await api.uninstallJdbcPlugin();
    emitDriverUpdateCount();
    toast(t("settings.jdbcPluginUninstallSuccess"));
    await loadJdbcDrivers();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  } finally {
    isUninstallingJdbcPlugin.value = false;
  }
}

async function importJdbcDriverPaths(paths: string[]) {
  if (!paths.length) return;
  try {
    jdbcDrivers.value = await api.importJdbcDrivers(paths);
    jdbcDriverPathInput.value = "";
    toast(t("settings.jdbcImportSuccess", { count: paths.length }));
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  }
}

async function importJdbcDrivers() {
  if (isWeb) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: t("settings.jdbcImport"),
    multiple: true,
    filters: [{ name: "JDBC Driver", extensions: ["jar"] }],
  });
  if (!selected) return;

  const paths = (Array.isArray(selected) ? selected : [selected]).filter(
    (path): path is string => typeof path === "string",
  );
  await importJdbcDriverPaths(paths);
}

async function importJdbcDriverPathInput() {
  const paths = jdbcDriverPathInput.value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  await importJdbcDriverPaths(paths);
}

async function deleteJdbcDriver(path: string) {
  try {
    jdbcDrivers.value = await api.deleteJdbcDriver(path);
    toast(t("settings.jdbcDeleteSuccess"));
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  }
}

// ──────────── Lifecycle ────────────

onMounted(async () => {
  updateAgentDrivers(await api.listInstalledAgentsLocal());
  void loadJavaRuntimeConfig();

  api.listInstalledAgents().then((result) => {
    updateAgentDrivers(result);
  });

  unlisten = await api.listenAgentInstallProgress((payload) => {
    if (payload.step === "done" || payload.step === "all-done") {
      progress.value = null;
    } else {
      progress.value = payload as DriverInstallProgress;
    }
    if (payload.db_type && payload.total_drivers) {
      upgradingCurrent.value = drivers.value.find((d) => d.db_type === payload.db_type)?.label ?? payload.db_type;
      upgradingIndex.value = payload.current ?? 0;
      upgradingTotal.value = payload.total_drivers ?? 0;
    }
  });
  void loadJdbcDrivers();
  void loadJdbcPluginStatus();
});

onUnmounted(() => {
  unlisten?.();
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="max-w-4xl mx-auto px-6 py-6">
        <Tabs default-value="agent">
          <div class="flex items-center justify-between">
            <TabsList class="w-fit">
              <TabsTrigger value="agent">内置驱动</TabsTrigger>
              <TabsTrigger value="jdbc">JDBC 驱动</TabsTrigger>
            </TabsList>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 rounded-full text-xs gap-1 text-muted-foreground"
              :disabled="importingZip"
              @click="importOfflineZip"
            >
              <FileUp class="h-3.5 w-3.5" />
              {{ importingZip ? "导入中..." : "导入离线包" }}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="h-7 rounded-full text-xs gap-1 text-muted-foreground"
              :disabled="refreshing"
              @click="forceRefresh"
            >
              <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': refreshing }" />
              刷新
            </Button>
          </div>

          <!-- Agent Tab -->
          <TabsContent value="agent" class="mt-5 space-y-5">
            <!-- Java Runtime Mode -->
            <div class="rounded-xl border bg-muted/20 p-4 space-y-3">
              <div class="flex flex-wrap items-end gap-3">
                <div class="min-w-[220px] flex-1 space-y-1.5">
                  <Label>Java 运行时</Label>
                  <Select :model-value="javaRuntimeConfig.mode" @update:model-value="setJavaRuntimeMode">
                    <SelectTrigger class="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="managed">DBX 托管 JRE</SelectItem>
                      <SelectItem value="system">系统 java</SelectItem>
                      <SelectItem value="custom">自定义路径</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  class="h-8 shrink-0 rounded-full text-xs"
                  :disabled="savingJavaRuntime || (javaRuntimeConfig.mode === 'custom' && !customJavaPath.trim())"
                  @click="saveJavaRuntimeConfig"
                >
                  {{ savingJavaRuntime ? "保存中..." : "保存" }}
                </Button>
              </div>
              <div v-if="javaRuntimeConfig.mode === 'custom'" class="flex items-center gap-2">
                <Input
                  v-model="customJavaPath"
                  class="h-8 flex-1 text-xs"
                  placeholder="/path/to/java 或 /path/to/jdk"
                  @keydown.enter.prevent="saveJavaRuntimeConfig"
                />
                <Button variant="outline" class="h-8 shrink-0 rounded-full text-xs" @click="chooseCustomJavaPath">
                  <FolderOpen class="h-3.5 w-3.5" />
                  选择
                </Button>
              </div>
              <p v-else-if="javaRuntimeConfig.mode === 'system'" class="text-xs text-muted-foreground">
                使用当前环境 PATH 中的 java。
              </p>
            </div>

            <!-- JRE Runtime -->
            <div v-if="installedJres.length > 0" class="rounded-xl border bg-muted/20 p-4 space-y-2.5">
              <div v-for="jre in installedJres" :key="jre.key" class="flex items-center justify-between gap-3">
                <div class="min-w-0">
                  <div class="text-sm font-medium">JRE {{ jre.key }} 运行时</div>
                </div>
                <div class="flex shrink-0 items-center gap-3">
                  <Check v-if="jre.installed" class="h-4 w-4 text-green-600" />
                  <span v-else class="text-xs text-muted-foreground">未安装</span>
                  <DriverInstallProgressCircle
                    v-if="reinstallingJre === jre.key"
                    :percent="progressNumber"
                    :title="progressTitle(jre.installed ? '重装中' : '安装中')"
                  />
                  <Button
                    v-else-if="!jre.installed"
                    type="button"
                    variant="default"
                    size="sm"
                    class="h-8 rounded-full text-xs"
                    :disabled="reinstallingJre !== null || installing !== null"
                    @click="reinstallJre(jre.key)"
                  >
                    <Download class="h-3.5 w-3.5 mr-1" />
                    安装
                  </Button>
                  <Button
                    v-else-if="jre.installed"
                    type="button"
                    variant="outline"
                    size="sm"
                    class="h-8 rounded-full text-xs"
                    :disabled="reinstallingJre !== null || installing !== null"
                    @click="reinstallJre(jre.key)"
                  >
                    <RotateCcw class="h-3.5 w-3.5 mr-1" />
                    重新安装
                  </Button>
                  <Button
                    v-if="jre.installed"
                    type="button"
                    variant="ghost"
                    size="sm"
                    class="h-8 rounded-full text-xs text-muted-foreground hover:text-destructive"
                    :disabled="reinstallingJre !== null || installing !== null"
                    @click="uninstallJre(jre.key)"
                  >
                    卸载
                  </Button>
                </div>
              </div>
            </div>
            <div v-else class="rounded-xl border bg-muted/20 p-4">
              <div class="text-sm font-medium">JRE 运行时</div>
              <p class="text-xs text-muted-foreground mt-0.5">首次安装驱动时自动下载</p>
            </div>

            <!-- Driver List -->
            <div v-if="drivers.length === 0" class="py-12 text-center text-sm text-muted-foreground">加载中...</div>
            <div v-else class="rounded-md border divide-y">
              <div v-if="updatableCount > 0" class="flex items-center justify-between px-4 py-2 bg-muted/30">
                <span class="text-xs text-muted-foreground">{{ updatableCount }} 个驱动可更新</span>
                <Button
                  size="sm"
                  class="h-7 rounded-full text-xs"
                  :disabled="installing !== null || upgradingAll"
                  @click="upgradeAll"
                >
                  <Loader2 v-if="upgradingAll" class="h-3 w-3 animate-spin mr-1" />
                  <Download v-else class="h-3 w-3 mr-1" />
                  {{ upgradingAll ? `升级中 (${upgradingIndex}/${upgradingTotal})` : "全部升级" }}
                </Button>
              </div>
              <div
                v-for="driver in drivers"
                :key="driver.db_type"
                class="flex items-center gap-3 px-4 py-2.5 transition hover:bg-muted/30"
              >
                <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-muted/60 shrink-0">
                  <DatabaseIcon :db-type="driver.db_type" class="h-5 w-5" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium">{{ driver.label }}</div>
                </div>
                <div class="flex shrink-0 items-center gap-1.5">
                  <span
                    v-if="driver.jre"
                    class="rounded-full px-2 py-0.5 text-[11px]"
                    :class="driver.jre !== '17' ? 'bg-blue-500/10 text-blue-600' : 'bg-muted text-muted-foreground'"
                    >JRE {{ driver.jre }}</span
                  >
                  <template v-if="driver.installed">
                    <span class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                      >v{{ driver.installed_version }}</span
                    >
                    <span
                      v-if="driver.update_available"
                      class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600"
                      >→ v{{ driver.version }}</span
                    >
                  </template>
                  <template v-else>
                    <span
                      v-if="driver.version"
                      class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                      >v{{ driver.version }}</span
                    >
                  </template>
                  <span
                    v-if="formatSize(driver.size)"
                    class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground"
                    >{{ formatSize(driver.size) }}</span
                  >
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Button
                    v-if="!driver.installed && isDriverQueued(driver.db_type)"
                    size="sm"
                    variant="outline"
                    class="h-7 rounded-full border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                    :disabled="upgradingAll"
                    @click="removeQueuedDriverInstall(driver.db_type)"
                  >
                    <Clock3 class="h-3 w-3 mr-1" />
                    排队中
                  </Button>
                  <DriverInstallProgressCircle
                    v-else-if="!driver.installed && isDriverProgressActive(driver.db_type)"
                    :percent="progressNumber"
                    :title="progressTitle('安装中')"
                  />
                  <Button
                    v-else-if="!driver.installed"
                    size="sm"
                    class="h-7 rounded-full text-xs"
                    :disabled="upgradingAll"
                    @click="installDriver(driver.db_type)"
                  >
                    <Download class="h-3 w-3 mr-1" />
                    安装
                  </Button>
                  <Button
                    v-if="
                      !driver.installed && !isDriverProgressActive(driver.db_type) && !isDriverQueued(driver.db_type)
                    "
                    size="sm"
                    variant="ghost"
                    class="h-7 w-7 rounded-full text-xs text-muted-foreground"
                    title="导入本地 JAR"
                    :disabled="upgradingAll || installing !== null"
                    @click="importDriverJar(driver.db_type)"
                  >
                    <FileUp class="h-3.5 w-3.5" />
                  </Button>
                  <template v-else>
                    <Check class="h-4 w-4 text-green-600" />
                    <Button
                      v-if="driver.update_available && isDriverQueued(driver.db_type)"
                      size="sm"
                      variant="outline"
                      class="h-7 rounded-full border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                      :disabled="upgradingAll"
                      @click="removeQueuedDriverInstall(driver.db_type)"
                    >
                      <Clock3 class="h-3 w-3 mr-1" />
                      排队中
                    </Button>
                    <DriverInstallProgressCircle
                      v-else-if="driver.update_available && isDriverProgressActive(driver.db_type)"
                      :percent="progressNumber"
                      :title="progressTitle('更新中')"
                    />
                    <Button
                      v-else-if="driver.update_available"
                      size="sm"
                      variant="outline"
                      class="h-7 rounded-full text-xs"
                      :disabled="upgradingAll"
                      @click="installDriver(driver.db_type)"
                    >
                      更新
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-7 rounded-full text-xs text-muted-foreground hover:text-destructive"
                      :disabled="installing !== null || upgradingAll || isDriverQueued(driver.db_type)"
                      @click="uninstallDriver(driver.db_type)"
                    >
                      卸载
                    </Button>
                  </template>
                </div>
              </div>
            </div>
          </TabsContent>

          <!-- JDBC Tab -->
          <TabsContent value="jdbc" class="mt-5 space-y-5">
            <!-- JDBC Plugin -->
            <div class="rounded-xl border bg-muted/20 p-4">
              <div class="flex min-h-12 items-center justify-between gap-3">
                <div class="min-w-0 space-y-1">
                  <Label>{{ t("settings.jdbcPlugin") }}</Label>
                  <p v-if="!jdbcPluginStatus?.installed" class="text-xs text-muted-foreground">
                    {{ t("settings.jdbcPluginNotInstalled") }}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-3">
                  <span
                    v-if="jdbcPluginStatus?.installed"
                    class="text-xs"
                    :class="jdbcPluginStatus.compatible ? 'text-green-600' : 'text-destructive'"
                  >
                    {{
                      jdbcPluginStatus.compatible
                        ? t("settings.jdbcPluginInstalled", {
                            version: jdbcPluginStatus.version || "-",
                          })
                        : t("settings.jdbcPluginIncompatible")
                    }}
                  </span>
                  <span
                    v-if="jdbcPluginStatus?.installed && jdbcPluginStatus.update_available"
                    class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600"
                    >→ v{{ jdbcPluginStatus.latest_version }}</span
                  >
                  <Button
                    v-if="jdbcPluginStatus?.installed && jdbcPluginStatus.update_available"
                    type="button"
                    variant="outline"
                    class="rounded-full"
                    :disabled="isInstallingJdbcPlugin"
                    @click="installJdbcPlugin"
                  >
                    {{ isInstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginUpdate") }}
                  </Button>
                  <Button
                    v-if="jdbcPluginStatus?.installed"
                    type="button"
                    variant="outline"
                    class="rounded-full"
                    :disabled="isUninstallingJdbcPlugin"
                    @click="uninstallJdbcPlugin"
                  >
                    {{ isUninstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginUninstall") }}
                  </Button>
                  <Button
                    v-else
                    type="button"
                    variant="default"
                    class="rounded-full"
                    :disabled="isInstallingJdbcPlugin"
                    @click="installJdbcPlugin"
                  >
                    {{ isInstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginInstall") }}
                  </Button>
                  <Button
                    v-if="!jdbcPluginStatus?.installed"
                    type="button"
                    variant="outline"
                    class="rounded-full"
                    :disabled="isInstallingJdbcPlugin"
                    @click="installJdbcPluginLocal"
                  >
                    <FolderOpen class="h-3.5 w-3.5 mr-1" />
                    本地安装
                  </Button>
                </div>
              </div>
            </div>

            <!-- JDBC Drivers -->
            <div class="space-y-3">
              <div class="space-y-1">
                <Label>{{ t("settings.jdbcDrivers") }}</Label>
              </div>
              <div class="flex items-center gap-2">
                <Input
                  v-model="jdbcDriverPathInput"
                  class="flex-1"
                  :placeholder="t('settings.jdbcDriverPathPlaceholder')"
                  @keydown.enter.prevent="importJdbcDriverPathInput"
                />
                <Button
                  variant="outline"
                  class="rounded-full"
                  :disabled="!jdbcDriverPathInput.trim()"
                  @click="importJdbcDriverPathInput"
                >
                  {{ t("settings.jdbcImportPath") }}
                </Button>
                <Button class="shrink-0 rounded-full" @click="importJdbcDrivers">
                  <FolderOpen class="h-4 w-4" />
                  {{ t("settings.jdbcImport") }}
                </Button>
              </div>
            </div>

            <div class="rounded-md border">
              <div v-if="isLoadingJdbcDrivers" class="p-4 text-sm text-muted-foreground">
                {{ t("common.loading") }}
              </div>
              <div v-else-if="jdbcDrivers.length === 0" class="p-4 text-sm text-muted-foreground">
                {{ t("settings.jdbcNoDrivers") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="driver in jdbcDrivers" :key="driver.path" class="flex items-center gap-3 p-3">
                  <div class="min-w-0 flex-1">
                    <div class="truncate text-sm font-medium">{{ driver.name }}</div>
                    <div class="truncate text-xs text-muted-foreground">{{ driver.path }}</div>
                  </div>
                  <div class="shrink-0 text-xs text-muted-foreground">{{ formatBytes(driver.size) }}</div>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="h-8 w-8 shrink-0 rounded-full"
                    @click="deleteJdbcDriver(driver.path)"
                  >
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  </div>
</template>

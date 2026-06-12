<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, ExternalLink, Cpu, FolderOpen, MemoryStick, Search, Square, Trash2, Download, RotateCcw, Loader2, RefreshCw, Check, Clock3, FileUp } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DriverInstallProgressCircle from "@/components/config/DriverInstallProgressCircle.vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { countAvailableDriverUpdates } from "@/lib/agentDriverUpdateBadge";
import type { JdbcDriverInfo, JdbcMavenBundleInfo, JdbcPluginStatus } from "@/types/database";
import * as api from "@/lib/api";
import type { AgentDriverInfo, DriverRuntimeInfo, DriverRuntimeSummary, DriverStoreUsage, JavaRuntimeConfig } from "@/lib/api";
import { formatRuntimeBytes, formatRuntimeCpu, formatRuntimeUptime, runtimeHealthClass, runtimeStatusClass, runtimeStatusDotClass } from "@/lib/driverRuntimePresentation";
import { addDriverInstallQueue, driverInstallProgressPercent, isDriverInstallProgressTarget, removeDriverInstallQueue, takeNextDriverInstallQueue, type DriverInstallProgress } from "@/lib/driverInstallProgressUi";

const { t } = useI18n();
const { toast } = useToast();
const isWeb = !isTauriRuntime();

const props = withDefaults(
  defineProps<{
    updateNotificationsEnabled?: boolean;
  }>(),
  {
    updateNotificationsEnabled: true,
  },
);

const emit = defineEmits<{
  "update-count-change": [count: number];
}>();

const driverStoreTab = ref("agent");

// ──────────── Agent drivers ────────────

const drivers = ref<AgentDriverInfo[]>([]);
const agentDriverSearch = ref("");
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
const driverStoreUsage = ref<DriverStoreUsage | null>(null);
const runtimeSummary = ref<DriverRuntimeSummary | null>(null);
const runtimeLoading = ref(false);
const runtimeError = ref("");
const runtimeBusy = ref<string | null>(null);
let runtimeTimer: ReturnType<typeof setInterval> | null = null;
const DRIVER_RUNTIME_POLL_MS = 5000;
const OFFLINE_DRIVER_DOWNLOAD_URL = "https://dbxio.com/cn/drivers";

let unlisten: (() => void) | null = null;
const lastProgressPercent = ref<number | null>(null);

const installedJres = computed(() => {
  const jreMap = new Map<string, boolean>();
  for (const d of drivers.value) {
    if (!jreMap.has(d.jre)) {
      jreMap.set(d.jre, d.jre_installed);
    }
  }
  return [...jreMap.entries()].map(([key, installed]) => ({ key, installed })).sort((a, b) => b.key.localeCompare(a.key));
});

const progressText = computed(() => {
  const p = progress.value;
  if (!p) return "";
  if (p.step === "jre-extract") return t("driverStore.progressJreExtract");
  if (p.step === "jdbc-plugin-extract") return t("driverStore.progressJdbcPluginExtract");
  const label = p.step === "jre" ? t("driverStore.progressDownloadJre") : p.step === "jdbc-plugin" ? t("driverStore.progressDownloadJdbcPlugin") : t("driverStore.progressDownloadDriver");
  if (!p.total) return `${label}...`;
  const pct = Math.round(((p.downloaded ?? 0) / p.total) * 100);
  const dl = formatSize(p.downloaded ?? 0);
  const total = formatSize(p.total);
  const prefix = upgradingAll.value && upgradingCurrent.value ? `[${upgradingIndex.value}/${upgradingTotal.value}] ${upgradingCurrent.value} - ` : "";
  return `${prefix}${label}  ${dl} / ${total}  (${pct}%)`;
});

const progressNumber = computed(() => {
  const next = driverInstallProgressPercent(progress.value);
  if (next !== null) {
    lastProgressPercent.value = next;
  }
  return next ?? lastProgressPercent.value;
});

function resetInstallProgress() {
  progress.value = null;
  lastProgressPercent.value = null;
}

const updatableCount = computed(() => (props.updateNotificationsEnabled ? drivers.value.filter((d) => d.update_available).length : 0));
const usageSummary = computed(() => {
  const usage = driverStoreUsage.value;
  if (!usage) return [];
  return [
    { key: "total", label: t("driverStore.usageTotalLabel"), bytes: usage.total_bytes },
    { key: "jre", label: t("driverStore.usageManagedJre"), bytes: usage.jre_bytes },
    { key: "agent", label: t("driverStore.usageAgentDrivers"), bytes: usage.agent_driver_bytes },
    { key: "jdbc-plugin", label: t("driverStore.usageJdbcPlugin"), bytes: usage.jdbc_plugin_bytes },
    { key: "jdbc-driver", label: t("driverStore.usageJdbcDriverJars"), bytes: usage.jdbc_driver_bytes },
  ];
});
const jreUsageByKey = computed(() => {
  const map = new Map<string, number>();
  for (const item of driverStoreUsage.value?.jres || []) {
    map.set(String(item.id), Number(item.bytes || 0));
  }
  return map;
});

function updateAgentDrivers(nextDrivers: AgentDriverInfo[]) {
  drivers.value = nextDrivers;
  emitDriverUpdateCount();
}

const agentTabUpdateCount = computed(() => (props.updateNotificationsEnabled ? drivers.value.filter((d) => d.update_available).length : 0));
const jdbcTabUpdateCount = computed(() => (props.updateNotificationsEnabled && jdbcPluginStatus.value?.update_available ? 1 : 0));

function emitDriverUpdateCount() {
  if (!props.updateNotificationsEnabled) {
    emit("update-count-change", 0);
    return;
  }
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

async function openOfflineDriverDownload() {
  if (isWeb) {
    window.open(OFFLINE_DRIVER_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
    return;
  }
  const { open } = await import("@tauri-apps/plugin-shell");
  await open(OFFLINE_DRIVER_DOWNLOAD_URL);
}

function queueDriverInstall(dbType: string) {
  queuedDriverInstalls.value = addDriverInstallQueue(queuedDriverInstalls.value, dbType, installing.value);
}

function removeQueuedDriverInstall(dbType: string) {
  queuedDriverInstalls.value = removeDriverInstallQueue(queuedDriverInstalls.value, dbType);
}

async function refreshAgents() {
  updateAgentDrivers(await api.listInstalledAgents());
  void loadDriverStoreUsage();
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
    toast(t("driverStore.javaRuntimeSaved"));
  } catch (e: any) {
    toast(t("driverStore.javaRuntimeSaveFailed", { error: e }));
  } finally {
    savingJavaRuntime.value = false;
  }
}

async function chooseCustomJavaPath() {
  if (isWeb) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: t("driverStore.chooseJavaExecutable"),
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
  resetInstallProgress();
  try {
    const blockers = await api.checkAgentUpdateBlockers([dbType]);
    if (blockers.length > 0) {
      toast(t("driverStore.driverUpdateBlocked", { labels: blockers.map((blocker) => blocker.label).join(", ") }));
      return;
    }
    await api.installAgent(dbType);
    await refreshAgents();
    toast(t("driverStore.driverInstallSuccess", { label }));
  } catch (e: any) {
    toast(t("driverStore.driverInstallFailed", { label, error: e }));
  } finally {
    installing.value = null;
    resetInstallProgress();
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
  resetInstallProgress();
  try {
    const updatableDbTypes = drivers.value.filter((driver) => driver.update_available).map((driver) => driver.db_type);
    const blockers = await api.checkAgentUpdateBlockers(updatableDbTypes);
    if (blockers.length > 0) {
      toast(t("driverStore.driverUpdateBlocked", { labels: blockers.map((blocker) => blocker.label).join(", ") }));
      return;
    }
    const result = await api.upgradeAllAgents();
    await refreshAgents();
    if (result.failed.length > 0) {
      const failedLabels = result.failed.map((item) => drivers.value.find((driver) => driver.db_type === item.db_type)?.label ?? item.db_type).join(", ");
      toast(t("driverStore.upgradeAllPartial", { count: result.upgraded, failed: failedLabels }));
    } else {
      toast(t("driverStore.upgradeAllSuccess", { count: result.upgraded }));
    }
  } catch (e: any) {
    toast(t("driverStore.upgradeAllFailed", { error: e }));
  } finally {
    upgradingAll.value = false;
    upgradingCurrent.value = "";
    upgradingIndex.value = 0;
    upgradingTotal.value = 0;
    resetInstallProgress();
  }
}

async function uninstallDriver(dbType: string) {
  const label = drivers.value.find((d) => d.db_type === dbType)?.label ?? dbType;
  try {
    await api.uninstallAgent(dbType);
    await refreshAgents();
    toast(t("driverStore.driverUninstallSuccess", { label }));
  } catch (e: any) {
    toast(t("driverStore.driverUninstallFailed", { label, error: e }));
  }
}

const importingZip = ref(false);

function chooseWebOfflineZip(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function chooseWebFiles(accept: string, multiple: boolean): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = () => {
      const files = input.files;
      if (!files || files.length === 0) {
        resolve(null);
        return;
      }
      resolve(Array.from(files));
    };
    input.click();
  });
}

function chooseWebFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

async function importOfflineZip() {
  if (importingZip.value) return;
  let selected: string | File | null = null;
  if (isWeb) {
    selected = await chooseWebOfflineZip();
  } else {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      title: t("driverStore.chooseOfflineDriverPackage"),
      multiple: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    selected = typeof path === "string" ? path : null;
  }
  if (!selected) return;
  importingZip.value = true;
  resetInstallProgress();
  try {
    const count = await api.importAgentsFromZip(selected);
    await refreshAgents();
    toast(t("driverStore.offlineImportSuccess", { count }));
  } catch (e: any) {
    toast(t("driverStore.offlineImportFailed", { error: e }));
  } finally {
    importingZip.value = false;
    resetInstallProgress();
  }
}

async function importDriverJar(dbType: string) {
  const label = drivers.value.find((d) => d.db_type === dbType)?.label ?? dbType;
  if (isWeb) {
    const file = await chooseWebFile(".jar");
    if (!file) return;
    try {
      await api.importAgentJar(dbType, file);
      await refreshAgents();
      toast(t("driverStore.driverImportSuccess", { label }));
    } catch (e: any) {
      toast(t("driverStore.driverImportFailed", { label, error: e }));
    }
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: t("driverStore.chooseDriverJar"),
    multiple: false,
    filters: [{ name: "JAR", extensions: ["jar"] }],
  });
  if (typeof selected !== "string") return;
  try {
    await api.importAgentJar(dbType, selected);
    await refreshAgents();
    toast(t("driverStore.driverImportSuccess", { label }));
  } catch (e: any) {
    toast(t("driverStore.driverImportFailed", { label, error: e }));
  }
}

async function reinstallJre(jreKey: string) {
  reinstallingJre.value = jreKey;
  resetInstallProgress();
  try {
    await api.reinstallJre(jreKey);
    await refreshAgents();
    toast(t("driverStore.jreReinstallSuccess", { jre: jreKey }));
  } catch (e: any) {
    toast(t("driverStore.jreReinstallFailed", { jre: jreKey, error: e }));
  } finally {
    reinstallingJre.value = null;
    resetInstallProgress();
  }
}

async function uninstallJre(jreKey: string) {
  try {
    await api.uninstallJre(jreKey);
    await refreshAgents();
    toast(t("driverStore.jreUninstallSuccess", { jre: jreKey }));
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
const jdbcMavenBundles = ref<JdbcMavenBundleInfo[]>([]);
const jdbcDriverSearch = ref("");
const isLoadingJdbcDrivers = ref(false);
const jdbcPluginStatus = ref<JdbcPluginStatus | null>(null);
const isInstallingJdbcPlugin = ref(false);
const isUninstallingJdbcPlugin = ref(false);
const jdbcDriverPathInput = ref("");
const jdbcMavenCoordinateInput = ref("");
const jdbcMavenRepository = ref("https://repo.maven.apache.org/maven2/");
const customJdbcMavenRepository = ref("");
const isInstallingJdbcMavenDriver = ref(false);

const jdbcMavenRepositoryOptions = [
  { label: "Maven Central", value: "https://repo.maven.apache.org/maven2/" },
  { label: "Aliyun", value: "https://maven.aliyun.com/repository/public" },
  { label: "Huawei Cloud", value: "https://repo.huaweicloud.com/repository/maven" },
  { label: "Tencent Cloud", value: "https://mirrors.cloud.tencent.com/nexus/repository/maven-public" },
  { label: "Custom", value: "custom" },
];

type JdbcDriverListItem =
  | {
      kind: "manual";
      id: string;
      title: string;
      subtitle: string;
      source: string;
      size: number;
      driver: JdbcDriverInfo;
    }
  | {
      kind: "maven";
      id: string;
      title: string;
      subtitle: string;
      source: string;
      size: number;
      bundle: JdbcMavenBundleInfo;
    };

const filteredAgentDrivers = computed(() => {
  const query = agentDriverSearch.value.trim().toLowerCase();
  if (!query) return drivers.value;
  return drivers.value.filter((driver) => [driver.label, driver.db_type, driver.version, driver.installed_version, driver.jre].filter(Boolean).join(" ").toLowerCase().includes(query));
});

const jdbcDriverListItems = computed<JdbcDriverListItem[]>(() => {
  const bundleItems = jdbcMavenBundles.value.map((bundle) => ({
    kind: "maven" as const,
    id: `maven:${bundle.id}`,
    title: bundle.coordinate,
    subtitle: `${bundle.artifacts.length} JARs - ${bundle.repositories.join(", ")}`,
    source: t("driverStore.jdbcSourceMaven"),
    size: bundle.artifacts.reduce((total, artifact) => total + Number(artifact.size || 0), 0),
    bundle,
  }));
  const manualItems = jdbcDrivers.value
    .filter((driver) => !driver.bundle_id)
    .map((driver) => ({
      kind: "manual" as const,
      id: `manual:${driver.path}`,
      title: driver.name,
      subtitle: driver.path,
      source: t("driverStore.jdbcSourceManual"),
      size: driver.size,
      driver,
    }));
  return [...bundleItems, ...manualItems].sort((a, b) => a.title.localeCompare(b.title));
});

const filteredJdbcDrivers = computed(() => {
  const query = jdbcDriverSearch.value.trim().toLowerCase();
  if (!query) return jdbcDriverListItems.value;
  return jdbcDriverListItems.value.filter((item) => [item.title, item.subtitle, String(item.size)].join(" ").toLowerCase().includes(query));
});

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const runtimeOverview = computed(() => {
  const summary = runtimeSummary.value;
  return [
    {
      key: "running",
      label: t("driverStore.runtimeRunning"),
      value: String(summary?.running_count ?? 0),
    },
    {
      key: "memory",
      label: t("driverStore.runtimeMemory"),
      value: formatRuntimeBytes(summary?.total_memory_bytes),
    },
    {
      key: "health",
      label: t("driverStore.runtimeHealth"),
      value: t(`driverStore.runtimeHealth_${summary?.health ?? "healthy"}`),
      class: runtimeHealthClass(summary?.health ?? "healthy"),
    },
  ];
});

function runtimeKindLabel(runtime: DriverRuntimeInfo) {
  return runtime.kind === "plugin" ? t("driverStore.runtimeKindPlugin") : t("driverStore.runtimeKindAgent");
}

function runtimeSourceLabel(runtime: DriverRuntimeInfo) {
  return runtime.source === "connection" ? t("driverStore.runtimeSourceConnection") : t("driverStore.runtimeSourceDaemon");
}

function runtimeStatusLabel(status: DriverRuntimeInfo["status"]) {
  return t(`driverStore.runtimeStatus_${status}`);
}

function runtimeControlUnavailableReasonLabel(reason: string | null) {
  if (reason === "connection-owned") return t("driverStore.runtimeControlConnectionOwned");
  return reason || "-";
}

async function loadDriverRuntimeSummary(showLoading = false) {
  if (showLoading) runtimeLoading.value = true;
  try {
    runtimeSummary.value = await api.getDriverRuntimeSummary();
    runtimeError.value = "";
  } catch (e: any) {
    runtimeError.value = String(e?.message || e);
  } finally {
    runtimeLoading.value = false;
  }
}

function startDriverRuntimePolling() {
  if (runtimeTimer) return;
  void loadDriverRuntimeSummary(true);
  runtimeTimer = setInterval(() => {
    if (driverStoreTab.value !== "runtime") {
      stopDriverRuntimePolling();
      return;
    }
    void loadDriverRuntimeSummary(false);
  }, DRIVER_RUNTIME_POLL_MS);
}

function stopDriverRuntimePolling() {
  if (runtimeTimer) {
    clearInterval(runtimeTimer);
    runtimeTimer = null;
  }
}

async function refreshDriverRuntime() {
  if (driverStoreTab.value !== "runtime") return;
  await loadDriverRuntimeSummary(true);
}

async function stopRuntime(runtime: DriverRuntimeInfo) {
  runtimeBusy.value = runtime.id;
  try {
    await api.stopDriverRuntime(runtime.id);
    await loadDriverRuntimeSummary(false);
    toast(t("driverStore.runtimeStopSuccess", { label: runtime.label }));
  } catch (e: any) {
    toast(t("driverStore.runtimeStopFailed", { label: runtime.label, error: e }));
  } finally {
    runtimeBusy.value = null;
  }
}

async function restartRuntime(runtime: DriverRuntimeInfo) {
  runtimeBusy.value = runtime.id;
  try {
    await api.restartDriverRuntime(runtime.id);
    await loadDriverRuntimeSummary(false);
    toast(t("driverStore.runtimeRestartSuccess", { label: runtime.label }));
  } catch (e: any) {
    toast(t("driverStore.runtimeRestartFailed", { label: runtime.label, error: e }));
  } finally {
    runtimeBusy.value = null;
  }
}

function jreUsageLabel(key: string) {
  const bytes = jreUsageByKey.value.get(String(key)) || 0;
  return bytes > 0 ? formatBytes(bytes) : "";
}

async function loadJdbcDrivers() {
  isLoadingJdbcDrivers.value = true;
  try {
    const [drivers, bundles] = await Promise.all([api.listJdbcDrivers(), api.listJdbcMavenBundles()]);
    jdbcDrivers.value = drivers;
    jdbcMavenBundles.value = bundles;
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  } finally {
    isLoadingJdbcDrivers.value = false;
    void loadDriverStoreUsage();
  }
}

async function loadDriverStoreUsage() {
  try {
    driverStoreUsage.value = await api.getDriverStoreUsage();
  } catch {
    driverStoreUsage.value = null;
  }
}

async function loadJdbcPluginStatus() {
  try {
    jdbcPluginStatus.value = await api.jdbcPluginStatus();
    emitDriverUpdateCount();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  }
}

async function installJdbcPlugin() {
  if (isInstallingJdbcPlugin.value) return;
  isInstallingJdbcPlugin.value = true;
  resetInstallProgress();
  try {
    jdbcPluginStatus.value = await api.installJdbcPlugin();
    emitDriverUpdateCount();
    toast(t("settings.jdbcPluginInstallSuccess"));
    await loadJdbcDrivers();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  } finally {
    isInstallingJdbcPlugin.value = false;
    resetInstallProgress();
  }
}

async function installJdbcPluginLocal() {
  if (isInstallingJdbcPlugin.value) return;
  let selected: string | File | null = null;
  if (isWeb) {
    selected = await chooseWebFile(".zip");
  } else {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({
      title: t("driverStore.chooseJdbcPluginZip"),
      multiple: false,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    selected = typeof result === "string" ? result : null;
  }
  if (!selected) return;
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
  if (isUninstallingJdbcPlugin.value) return;
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
    void loadDriverStoreUsage();
    toast(t("settings.jdbcImportSuccess", { count: paths.length }));
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  }
}

async function importJdbcDrivers() {
  if (isWeb) {
    const files = await chooseWebFiles(".jar", true);
    if (!files || !files.length) return;
    try {
      jdbcDrivers.value = await api.importJdbcDrivers(files);
      void loadDriverStoreUsage();
      toast(t("settings.jdbcImportSuccess", { count: files.length }));
    } catch (e: any) {
      toast(String(e?.message || e), 5000);
    }
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: t("settings.jdbcImport"),
    multiple: true,
    filters: [{ name: "JDBC Driver", extensions: ["jar"] }],
  });
  if (!selected) return;

  const paths = (Array.isArray(selected) ? selected : [selected]).filter((path): path is string => typeof path === "string");
  await importJdbcDriverPaths(paths);
}

async function importJdbcDriverPathInput() {
  const paths = jdbcDriverPathInput.value
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
  await importJdbcDriverPaths(paths);
}

async function installJdbcMavenDriver() {
  const coordinate = jdbcMavenCoordinateInput.value.trim();
  const repository = jdbcMavenRepository.value === "custom" ? customJdbcMavenRepository.value.trim() : jdbcMavenRepository.value;
  if (!coordinate || !repository || isInstallingJdbcMavenDriver.value) return;
  isInstallingJdbcMavenDriver.value = true;
  try {
    jdbcDrivers.value = await api.installJdbcDriverFromMaven(coordinate, [repository]);
    jdbcMavenBundles.value = await api.listJdbcMavenBundles();
    jdbcMavenCoordinateInput.value = "";
    void loadDriverStoreUsage();
    toast(t("driverStore.jdbcMavenInstallSuccess"));
  } catch (e: any) {
    toast(String(e?.message || e), 8000);
  } finally {
    isInstallingJdbcMavenDriver.value = false;
  }
}

async function deleteJdbcDriver(path: string) {
  try {
    jdbcDrivers.value = await api.deleteJdbcDriver(path);
    void loadDriverStoreUsage();
    toast(t("settings.jdbcDeleteSuccess"));
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  }
}

async function deleteJdbcMavenBundle(bundleId: string) {
  try {
    jdbcDrivers.value = await api.deleteJdbcMavenBundle(bundleId);
    jdbcMavenBundles.value = await api.listJdbcMavenBundles();
    void loadDriverStoreUsage();
    toast(t("settings.jdbcDeleteSuccess"));
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  }
}

// ──────────── Lifecycle ────────────

onMounted(async () => {
  updateAgentDrivers(await api.listInstalledAgentsLocal());
  void loadJavaRuntimeConfig();
  void loadDriverStoreUsage();

  if (props.updateNotificationsEnabled) {
    api.listInstalledAgents().then((result) => {
      updateAgentDrivers(result);
    });
  }

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
  if (props.updateNotificationsEnabled) void loadJdbcPluginStatus();
});

onUnmounted(() => {
  unlisten?.();
  stopDriverRuntimePolling();
});

watch(driverStoreTab, (tab) => {
  if (tab === "runtime") {
    startDriverRuntimePolling();
  } else {
    stopDriverRuntimePolling();
  }
});
</script>

<template>
  <div class="h-full flex flex-col">
    <div class="flex-1 min-h-0 overflow-y-auto">
      <div class="max-w-4xl mx-auto px-6 py-6">
        <Tabs v-model="driverStoreTab" default-value="agent">
          <div class="mb-5 rounded-xl border bg-muted/20 p-4">
            <div class="flex items-center justify-between gap-3">
              <div class="text-sm font-medium">{{ t("driverStore.usageTitle") }}</div>
              <div class="text-xs text-muted-foreground">
                {{ usageSummary.length ? t("driverStore.usageTotal", { size: formatBytes(usageSummary[0].bytes) }) : t("driverStore.calculating") }}
              </div>
            </div>
            <div v-if="usageSummary.length" class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
              <div v-for="item in usageSummary" :key="item.key" class="rounded-lg border bg-background/50 px-2.5 py-2 text-center">
                <div class="text-[11px] text-muted-foreground">{{ item.label }}</div>
                <div class="mt-0.5 text-xs font-medium">{{ formatBytes(item.bytes) }}</div>
              </div>
            </div>
            <div class="mt-3 rounded-lg border bg-background/50 px-2.5 py-2">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0 truncate text-xs text-muted-foreground">
                  {{ t("driverStore.offlineDownloadHint") }}
                </div>
                <Button variant="outline" size="sm" class="h-7 shrink-0 rounded-full text-xs gap-1 whitespace-nowrap" @click="openOfflineDriverDownload">
                  <ExternalLink class="h-3.5 w-3.5" />
                  {{ t("driverStore.offlineDownloadLink") }}
                </Button>
              </div>
            </div>
          </div>

          <div class="flex items-center justify-between">
            <TabsList class="w-fit">
              <TabsTrigger value="agent" class="gap-1.5 relative">
                {{ t("driverStore.agentDrivers") }}
                <span v-if="agentTabUpdateCount > 0" class="inline-block h-2 w-2 rounded-full bg-red-500" />
              </TabsTrigger>
              <TabsTrigger value="jdbc" class="gap-1.5 relative">
                {{ t("driverStore.jdbcDrivers") }}
                <span v-if="jdbcTabUpdateCount > 0" class="inline-block h-2 w-2 rounded-full bg-red-500" />
              </TabsTrigger>
              <TabsTrigger value="runtime" class="gap-1.5 relative">
                {{ t("driverStore.runtimeDrivers") }}
              </TabsTrigger>
            </TabsList>
            <div v-if="driverStoreTab !== 'runtime'" class="flex items-center gap-2">
              <Button variant="ghost" size="sm" class="h-7 rounded-full text-xs gap-1 text-muted-foreground" :disabled="importingZip" @click="importOfflineZip">
                <FileUp class="h-3.5 w-3.5" />
                {{ importingZip ? t("driverStore.importing") : t("driverStore.importOfflinePackage") }}
              </Button>
              <Button variant="ghost" size="sm" class="h-7 rounded-full text-xs gap-1 text-muted-foreground" :disabled="refreshing" @click="forceRefresh">
                <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': refreshing }" />
                {{ t("driverStore.refresh") }}
              </Button>
            </div>
          </div>

          <!-- Agent Tab -->
          <TabsContent value="agent" class="mt-5 space-y-5">
            <!-- Java Runtime -->
            <div class="rounded-xl border bg-muted/20 p-4 space-y-3">
              <div class="flex flex-wrap items-center gap-2">
                <Label class="shrink-0">{{ t("driverStore.javaRuntime") }}</Label>
                <Select :model-value="javaRuntimeConfig.mode" @update:model-value="setJavaRuntimeMode">
                  <SelectTrigger class="h-8 min-w-[112px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="managed">{{ t("driverStore.javaRuntimeManaged") }}</SelectItem>
                    <SelectItem value="system">{{ t("driverStore.javaRuntimeSystem") }}</SelectItem>
                    <SelectItem value="custom">{{ t("driverStore.javaRuntimeCustom") }}</SelectItem>
                  </SelectContent>
                </Select>
                <Input v-if="javaRuntimeConfig.mode === 'custom'" v-model="customJavaPath" class="h-8 min-w-[180px] flex-1 text-xs" :placeholder="t('driverStore.customJavaPathPlaceholder')" @keydown.enter.prevent="saveJavaRuntimeConfig" />
                <span v-else class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {{ javaRuntimeConfig.mode === "system" ? t("driverStore.systemJavaHint") : t("driverStore.jreRuntimeAutoDownloadHint") }}
                </span>
                <Button v-if="javaRuntimeConfig.mode === 'custom'" variant="outline" class="h-8 shrink-0 rounded-full text-xs" @click="chooseCustomJavaPath">
                  <FolderOpen class="h-3.5 w-3.5" />
                  {{ t("driverStore.choose") }}
                </Button>
                <Button class="h-8 shrink-0 rounded-full text-xs" :disabled="savingJavaRuntime || (javaRuntimeConfig.mode === 'custom' && !customJavaPath.trim())" @click="saveJavaRuntimeConfig">
                  {{ savingJavaRuntime ? t("driverStore.saving") : t("settings.save") }}
                </Button>
              </div>

              <div v-if="installedJres.length > 0" class="divide-y rounded-lg border bg-background/50">
                <div v-for="jre in installedJres" :key="jre.key" class="flex items-center justify-between gap-3 px-3 py-2.5">
                  <div class="min-w-0">
                    <div class="text-sm font-medium">{{ t("driverStore.jreRuntimeTitle", { jre: jre.key }) }}</div>
                  </div>
                  <div class="flex shrink-0 items-center gap-3">
                    <span v-if="jreUsageLabel(jre.key)" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {{ jreUsageLabel(jre.key) }}
                    </span>
                    <Check v-if="jre.installed" class="h-4 w-4 text-green-600" />
                    <span v-else class="text-xs text-muted-foreground">{{ t("driverStore.notInstalled") }}</span>
                    <DriverInstallProgressCircle v-if="reinstallingJre === jre.key" :percent="progressNumber" :title="progressTitle(jre.installed ? t('driverStore.reinstalling') : t('driverStore.installing'))" />
                    <Button v-else-if="!jre.installed" type="button" variant="default" size="sm" class="h-8 rounded-full text-xs" :disabled="reinstallingJre !== null || installing !== null" @click="reinstallJre(jre.key)">
                      <Download class="h-3.5 w-3.5 mr-1" />
                      {{ t("driverStore.install") }}
                    </Button>
                    <Button v-else-if="jre.installed" type="button" variant="outline" size="sm" class="h-8 rounded-full text-xs" :disabled="reinstallingJre !== null || installing !== null" @click="reinstallJre(jre.key)">
                      <RotateCcw class="h-3.5 w-3.5 mr-1" />
                      {{ t("driverStore.reinstall") }}
                    </Button>
                    <Button v-if="jre.installed" type="button" variant="ghost" size="sm" class="h-8 rounded-full text-xs text-muted-foreground hover:text-destructive" :disabled="reinstallingJre !== null || installing !== null" @click="uninstallJre(jre.key)">
                      {{ t("driverStore.uninstall") }}
                    </Button>
                  </div>
                </div>
              </div>
            </div>

            <!-- Driver List -->
            <div class="relative">
              <Search class="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input v-model="agentDriverSearch" class="h-8 pl-8 text-xs" :placeholder="t('driverStore.searchDrivers')" />
            </div>
            <div v-if="drivers.length === 0" class="py-12 text-center text-sm text-muted-foreground">
              {{ t("common.loading") }}
            </div>
            <div v-else-if="filteredAgentDrivers.length === 0" class="py-12 text-center text-sm text-muted-foreground">
              {{ t("driverStore.noMatchingDrivers") }}
            </div>
            <div v-else class="rounded-md border divide-y">
              <div v-if="updatableCount > 0" class="flex items-center justify-between px-4 py-2 bg-muted/30">
                <span class="text-xs text-muted-foreground">{{ t("driverStore.driversUpdatable", { count: updatableCount }) }}</span>
                <Button size="sm" class="h-7 rounded-full text-xs" :disabled="installing !== null || upgradingAll" @click="upgradeAll">
                  <Loader2 v-if="upgradingAll" class="h-3 w-3 animate-spin mr-1" />
                  <Download v-else class="h-3 w-3 mr-1" />
                  {{ upgradingAll ? t("driverStore.upgradingProgress", { current: upgradingIndex, total: upgradingTotal }) : t("driverStore.upgradeAll") }}
                </Button>
              </div>
              <div v-for="driver in filteredAgentDrivers" :key="driver.db_type" class="flex items-center gap-3 px-4 py-2.5 transition hover:bg-muted/30">
                <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-muted/60 shrink-0">
                  <DatabaseIcon :db-type="driver.db_type" class="h-5 w-5" />
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium">{{ driver.label }}</div>
                </div>
                <div class="flex shrink-0 items-center gap-1.5">
                  <span v-if="driver.jre" class="rounded-full px-2 py-0.5 text-[11px]" :class="driver.jre !== '21' ? 'bg-blue-500/10 text-blue-600' : 'bg-muted text-muted-foreground'">JRE {{ driver.jre }}</span>
                  <template v-if="driver.installed">
                    <span class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.installed_version }}</span>
                    <span v-if="driver.update_available" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">→ v{{ driver.version }}</span>
                  </template>
                  <template v-else>
                    <span v-if="driver.version" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.version }}</span>
                  </template>
                  <span v-if="formatSize(driver.size)" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{{ formatSize(driver.size) }}</span>
                </div>
                <div class="flex shrink-0 items-center gap-2">
                  <Button v-if="!driver.installed && isDriverQueued(driver.db_type)" size="sm" variant="outline" class="h-7 rounded-full border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15" :disabled="upgradingAll" @click="removeQueuedDriverInstall(driver.db_type)">
                    <Clock3 class="h-3 w-3 mr-1" />
                    {{ t("driverStore.queued") }}
                  </Button>
                  <DriverInstallProgressCircle v-else-if="!driver.installed && isDriverProgressActive(driver.db_type)" :percent="progressNumber" :title="progressTitle(t('driverStore.installing'))" />
                  <Button v-else-if="!driver.installed" size="sm" class="h-7 rounded-full text-xs" :disabled="upgradingAll" @click="installDriver(driver.db_type)">
                    <Download class="h-3 w-3 mr-1" />
                    {{ t("driverStore.install") }}
                  </Button>
                  <Button
                    v-if="!driver.installed && !isDriverProgressActive(driver.db_type) && !isDriverQueued(driver.db_type)"
                    size="sm"
                    variant="ghost"
                    class="h-7 w-7 rounded-full text-xs text-muted-foreground"
                    :title="t('driverStore.importLocalJar')"
                    :disabled="upgradingAll || installing !== null"
                    @click="importDriverJar(driver.db_type)"
                  >
                    <FileUp class="h-3.5 w-3.5" />
                  </Button>
                  <template v-else>
                    <Check v-if="!(driver.update_available && isDriverProgressActive(driver.db_type))" class="h-4 w-4 text-green-600" />
                    <Button
                      v-if="driver.update_available && isDriverQueued(driver.db_type)"
                      size="sm"
                      variant="outline"
                      class="h-7 rounded-full border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                      :disabled="upgradingAll"
                      @click="removeQueuedDriverInstall(driver.db_type)"
                    >
                      <Clock3 class="h-3 w-3 mr-1" />
                      {{ t("driverStore.queued") }}
                    </Button>
                    <DriverInstallProgressCircle v-else-if="driver.update_available && isDriverProgressActive(driver.db_type)" :percent="progressNumber" :title="progressTitle(t('driverStore.updating'))" />
                    <Button v-else-if="driver.update_available" size="sm" variant="outline" class="h-7 rounded-full text-xs" :disabled="upgradingAll" @click="installDriver(driver.db_type)">
                      {{ t("driverStore.update") }}
                    </Button>
                    <Button variant="ghost" size="sm" class="h-7 rounded-full text-xs text-muted-foreground hover:text-destructive" :disabled="installing !== null || upgradingAll || isDriverQueued(driver.db_type)" @click="uninstallDriver(driver.db_type)">
                      {{ t("driverStore.uninstall") }}
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
                  <DriverInstallProgressCircle v-if="isInstallingJdbcPlugin" :percent="progressNumber" :title="progressTitle(t('driverStore.progressDownloadJdbcPlugin'))" />
                  <span v-if="jdbcPluginStatus?.installed" class="text-xs" :class="jdbcPluginStatus.compatible ? 'text-green-600' : 'text-destructive'">
                    {{
                      jdbcPluginStatus.compatible
                        ? t("settings.jdbcPluginInstalled", {
                            version: jdbcPluginStatus.version || "-",
                          })
                        : t("settings.jdbcPluginIncompatible")
                    }}
                  </span>
                  <span v-if="jdbcPluginStatus?.installed && jdbcPluginStatus.update_available" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">→ v{{ jdbcPluginStatus.latest_version }}</span>
                  <Button v-if="jdbcPluginStatus?.installed && jdbcPluginStatus.update_available" type="button" variant="outline" class="rounded-full" :disabled="isInstallingJdbcPlugin" @click="installJdbcPlugin">
                    {{ isInstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginUpdate") }}
                  </Button>
                  <Button v-if="jdbcPluginStatus?.installed" type="button" variant="outline" class="rounded-full" :disabled="isUninstallingJdbcPlugin" @click="uninstallJdbcPlugin">
                    {{ isUninstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginUninstall") }}
                  </Button>
                  <Button v-else type="button" variant="default" class="rounded-full" :disabled="isInstallingJdbcPlugin" @click="installJdbcPlugin">
                    {{ isInstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginInstall") }}
                  </Button>
                  <Button v-if="!jdbcPluginStatus?.installed" type="button" variant="outline" class="rounded-full" :disabled="isInstallingJdbcPlugin" @click="installJdbcPluginLocal">
                    <FolderOpen class="h-3.5 w-3.5 mr-1" />
                    {{ t("driverStore.localInstall") }}
                  </Button>
                </div>
              </div>
            </div>

            <!-- JDBC Drivers -->
            <div class="space-y-3">
              <div class="space-y-1">
                <Label>{{ t("settings.jdbcDrivers") }}</Label>
              </div>
              <div class="relative">
                <Search class="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="jdbcDriverSearch" class="h-8 pl-8 text-xs" :placeholder="t('driverStore.searchJdbcDrivers')" />
              </div>
              <div class="flex items-center gap-2">
                <Input v-model="jdbcDriverPathInput" class="flex-1" :placeholder="t('settings.jdbcDriverPathPlaceholder')" @keydown.enter.prevent="importJdbcDriverPathInput" />
                <Button variant="outline" class="rounded-full" :disabled="!jdbcDriverPathInput.trim()" @click="importJdbcDriverPathInput">
                  {{ t("settings.jdbcImportPath") }}
                </Button>
                <Button class="shrink-0 rounded-full" @click="importJdbcDrivers">
                  <FolderOpen class="h-4 w-4" />
                  {{ t("settings.jdbcImport") }}
                </Button>
              </div>
              <div class="grid gap-2 md:grid-cols-[minmax(0,1fr)_180px_auto]">
                <Input v-model="jdbcMavenCoordinateInput" class="h-8 text-xs" :placeholder="t('driverStore.jdbcMavenCoordinatePlaceholder')" @keydown.enter.prevent="installJdbcMavenDriver" />
                <Select v-model="jdbcMavenRepository">
                  <SelectTrigger class="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="repo in jdbcMavenRepositoryOptions" :key="repo.value" :value="repo.value">
                      {{ repo.label }}
                    </SelectItem>
                  </SelectContent>
                </Select>
                <Button class="h-8 shrink-0 rounded-full" :disabled="!jdbcMavenCoordinateInput.trim() || isInstallingJdbcMavenDriver || (jdbcMavenRepository === 'custom' && !customJdbcMavenRepository.trim())" @click="installJdbcMavenDriver">
                  <Loader2 v-if="isInstallingJdbcMavenDriver" class="h-4 w-4 animate-spin" />
                  <Download v-else class="h-4 w-4" />
                  {{ t("driverStore.jdbcMavenInstall") }}
                </Button>
              </div>
              <Input v-if="jdbcMavenRepository === 'custom'" v-model="customJdbcMavenRepository" class="h-8 text-xs" placeholder="https://repo.example.com/repository/maven-public" @keydown.enter.prevent="installJdbcMavenDriver" />
            </div>

            <div class="rounded-md border">
              <div v-if="isLoadingJdbcDrivers" class="p-4 text-sm text-muted-foreground">
                {{ t("common.loading") }}
              </div>
              <div v-else-if="jdbcDriverListItems.length === 0" class="p-4 text-sm text-muted-foreground">
                {{ t("settings.jdbcNoDrivers") }}
              </div>
              <div v-else-if="filteredJdbcDrivers.length === 0" class="p-4 text-sm text-muted-foreground">
                {{ t("driverStore.noMatchingDrivers") }}
              </div>
              <div v-else class="divide-y">
                <div v-for="item in filteredJdbcDrivers" :key="item.id" class="flex items-center gap-3 p-3">
                  <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-2">
                      <div class="truncate text-sm font-medium">{{ item.title }}</div>
                      <Badge variant="outline" class="h-5 shrink-0 rounded-full px-2 text-[10px] font-medium">
                        {{ item.source }}
                      </Badge>
                    </div>
                    <div class="truncate text-xs text-muted-foreground">{{ item.subtitle }}</div>
                  </div>
                  <div class="shrink-0 text-xs text-muted-foreground">{{ formatBytes(item.size) }}</div>
                  <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 rounded-full" @click="item.kind === 'maven' ? deleteJdbcMavenBundle(item.bundle.id) : deleteJdbcDriver(item.driver.path)">
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          <!-- Runtime Tab -->
          <TabsContent value="runtime" class="mt-5">
            <div class="overflow-hidden rounded-md border bg-background">
              <div class="flex flex-col gap-3 border-b px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
                <div class="flex min-w-0 items-center gap-2.5">
                  <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                    <Activity class="h-4 w-4 text-muted-foreground" />
                  </span>
                  <div class="min-w-0">
                    <div class="text-sm font-medium">{{ t("driverStore.runtimeTitle") }}</div>
                    <div class="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <span v-for="item in runtimeOverview" :key="item.key" class="inline-flex items-center gap-1.5">
                        <span>{{ item.label }}</span>
                        <span class="font-medium text-foreground" :class="item.class">{{ item.value }}</span>
                      </span>
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 rounded-full text-muted-foreground" :title="t('driverStore.refresh')" :disabled="runtimeLoading" @click="refreshDriverRuntime">
                  <RefreshCw class="h-4 w-4" :class="{ 'animate-spin': runtimeLoading }" />
                </Button>
              </div>

              <div v-if="runtimeSummary?.last_error" class="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2.5">
                <div class="text-xs font-medium text-amber-700 dark:text-amber-300">
                  {{ t("driverStore.runtimeLastError") }}
                </div>
                <pre class="mt-1 max-h-20 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{{ runtimeSummary.last_error }}</pre>
              </div>

              <div v-if="runtimeLoading && !runtimeSummary" class="p-6 text-center text-sm text-muted-foreground">
                {{ t("common.loading") }}
              </div>
              <div v-else-if="runtimeError" class="p-6 text-sm text-destructive">
                {{ runtimeError }}
              </div>
              <div v-else-if="!runtimeSummary?.runtimes.length" class="p-6 text-center text-sm text-muted-foreground">
                {{ t("driverStore.runtimeEmpty") }}
              </div>
              <div v-else>
                <div class="hidden grid-cols-[minmax(0,1.6fr)_72px_56px_76px_58px_76px_72px] gap-2 border-b bg-muted/30 px-4 py-2 text-[11px] font-medium text-muted-foreground lg:grid">
                  <div>{{ t("driverStore.runtimeDrivers") }}</div>
                  <div>{{ t("driverStore.runtimeHealth") }}</div>
                  <div>{{ t("driverStore.runtimePid") }}</div>
                  <div>{{ t("driverStore.runtimeMemory") }}</div>
                  <div>CPU</div>
                  <div>{{ t("driverStore.runtimeUptime") }}</div>
                  <div class="text-right">{{ t("driverStore.runtimeActions") }}</div>
                </div>
                <div class="divide-y">
                  <div v-for="runtime in runtimeSummary.runtimes" :key="runtime.id" class="grid gap-2 px-4 py-3 transition hover:bg-muted/25 lg:grid-cols-[minmax(0,1.6fr)_72px_56px_76px_58px_76px_72px] lg:items-center">
                    <div class="min-w-0">
                      <div class="flex min-w-0 items-center gap-2">
                        <span class="h-2 w-2 shrink-0 rounded-full" :class="runtimeStatusDotClass(runtime.status)" />
                        <span class="truncate text-sm font-medium">{{ runtime.label }}</span>
                        <span v-if="runtime.version" class="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"> v{{ runtime.version }} </span>
                      </div>
                      <div class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                        <span>{{ runtimeKindLabel(runtime) }}</span>
                        <span class="text-muted-foreground/50">/</span>
                        <span>{{ runtimeSourceLabel(runtime) }}</span>
                      </div>
                    </div>

                    <div class="flex items-center gap-2 lg:block">
                      <span class="lg:hidden text-[11px] text-muted-foreground">{{ t("driverStore.runtimeHealth") }}</span>
                      <span class="rounded-full px-2 py-0.5 text-[11px]" :class="runtimeStatusClass(runtime.status)">
                        {{ runtimeStatusLabel(runtime.status) }}
                      </span>
                    </div>
                    <div class="text-xs text-muted-foreground">
                      <span class="lg:hidden">{{ t("driverStore.runtimePid") }}: </span>{{ runtime.pid ?? "-" }}
                    </div>
                    <div class="flex items-center gap-1 text-xs text-muted-foreground">
                      <MemoryStick class="h-3.5 w-3.5 lg:hidden" />
                      {{ formatRuntimeBytes(runtime.memory_bytes) }}
                    </div>
                    <div class="flex items-center gap-1 text-xs text-muted-foreground">
                      <Cpu class="h-3.5 w-3.5 lg:hidden" />
                      {{ formatRuntimeCpu(runtime.cpu_percent) }}
                    </div>
                    <div class="text-xs text-muted-foreground">
                      <span class="lg:hidden">{{ t("driverStore.runtimeUptime") }}: </span>
                      {{ formatRuntimeUptime(runtime.uptime_seconds) }}
                    </div>
                    <div class="flex min-w-0 items-center gap-1.5 lg:justify-end">
                      <Button v-if="runtime.can_stop" variant="ghost" size="icon" class="h-7 w-7 rounded-full text-muted-foreground hover:text-destructive" :title="t('driverStore.runtimeStop')" :disabled="runtimeBusy === runtime.id" @click="stopRuntime(runtime)">
                        <Square class="h-3.5 w-3.5" />
                      </Button>
                      <Button v-if="runtime.can_restart" variant="ghost" size="icon" class="h-7 w-7 rounded-full text-muted-foreground" :title="t('driverStore.runtimeRestart')" :disabled="runtimeBusy === runtime.id" @click="restartRuntime(runtime)">
                        <RotateCcw class="h-3.5 w-3.5" :class="{ 'animate-spin': runtimeBusy === runtime.id }" />
                      </Button>
                      <span v-if="!runtime.can_stop && !runtime.can_restart" class="min-w-0 truncate text-[11px] text-muted-foreground lg:text-right" :title="runtimeControlUnavailableReasonLabel(runtime.control_unavailable_reason)">
                        {{ runtimeControlUnavailableReasonLabel(runtime.control_unavailable_reason) }}
                      </span>
                    </div>

                    <div v-if="runtime.last_error" class="rounded-md bg-muted/60 p-2 lg:col-span-7">
                      <pre class="max-h-16 overflow-auto whitespace-pre-wrap text-[11px] text-muted-foreground">{{ runtime.last_error }}</pre>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  </div>
</template>

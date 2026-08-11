<script setup lang="ts">
import { ref, reactive, onMounted, onUnmounted, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, ExternalLink, Cpu, FolderOpen, FolderSync, MemoryStick, Search, Square, Trash2, Download, RotateCcw, Loader2, RefreshCw, Check, Clock3, FileUp } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DriverInstallProgressCircle from "@/components/config/DriverInstallProgressCircle.vue";
import DatabaseIcon from "@/components/icons/DatabaseIcon.vue";
import { useToast } from "@/composables/useToast";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { uuid } from "@/lib/common/utils";
import { countAvailableDriverUpdates } from "@/lib/connection/agentDriverUpdateBadge";
import type { JdbcDriverInfo, JdbcLocalBundleInfo, JdbcMavenBundleInfo, JdbcPluginStatus } from "@/types/database";
import * as api from "@/lib/backend/api";
import type { AgentDriverInfo, DriverRuntimeInfo, DriverRuntimeSummary, DriverStoreUsage, JavaRuntimeConfig } from "@/lib/backend/api";
import { formatRuntimeBytes, formatRuntimeCpu, formatRuntimeUptime, runtimeHealthClass, runtimeStatusClass, runtimeStatusDotClass } from "@/lib/connection/driverRuntimePresentation";
import {
  addDriverInstallQueue,
  driverInstallProgressChannel,
  driverInstallProgressPercent,
  isDriverInstallProgressForOperation,
  isDriverInstallProgressTarget,
  removeDriverInstallQueue,
  takeNextDriverInstallQueue,
  updatePerDriverProgress,
  type DriverInstallProgress,
} from "@/lib/connection/driverInstallProgressUi";
import { installRegisteredManagedJdbcDriver, isManagedJdbcDriver, managedJdbcDriverRows, uninstallRegisteredManagedJdbcDriver } from "@/lib/database/managedJdbcDrivers";
import type { DriverStoreFocus } from "@/lib/connection/agentDriverInstallHint";
import { isOfflineDriverPackage, webDriverImportAccept } from "@/lib/driverStore/driverImportSelection";
import { translateBackendError } from "@/i18n/backend-errors";
import { DRIVER_CATEGORIES, getCategoryForAgentDriver, assertAgentDriverCategoriesComplete } from "@/lib/connection/driver-category-definitions";
import { selectUpdatableDrivers, selectStableDrivers, hasAnyUpdatableDriverMatching } from "@/lib/connection/driverListFilter";

const { t } = useI18n();
const { toast } = useToast();
const isWeb = !isTauriRuntime();

// Backend errors arrive as plain strings, so translate them before they are
// interpolated into an already-localized wrapper message.
function backendError(e: unknown): string {
  const message = e instanceof Error ? e.message : ((e as { message?: string } | null)?.message ?? String(e));
  return translateBackendError(t, message);
}

const props = withDefaults(
  defineProps<{
    updateNotificationsEnabled?: boolean;
    activeTab?: "agent" | "jdbc" | "storage" | "runtime";
    focusTarget?: DriverStoreFocus | null;
  }>(),
  {
    updateNotificationsEnabled: true,
    activeTab: "agent",
    focusTarget: null,
  },
);

const emit = defineEmits<{
  "update-count-change": [count: number];
  "update:activeTab": [tab: "agent" | "jdbc" | "storage" | "runtime"];
}>();

const driverStoreTab = computed({
  get: () => props.activeTab,
  set: (tab: "agent" | "jdbc" | "storage" | "runtime") => emit("update:activeTab", tab),
});

// ──────────── Driver store path ────────────

import { useSettingsStore } from "@/stores/settingsStore";
import type { DriverStorePathInfo } from "@/lib/backend/api";
import { driverRuntimeProtocolLabel } from "./driverRuntimeDisplay";
const settingsStore = useSettingsStore();

type DriverStoreDirKind = "plugin" | "agent";

const legacyDriverStoreDir = computed(() => settingsStore.desktopSettings.driver_store_dir ?? null);
const pluginStoreDir = computed(() => settingsStore.desktopSettings.plugin_store_dir ?? null);
const agentStoreDir = computed(() => settingsStore.desktopSettings.agent_store_dir ?? null);
const driverStoreDirMigrating = ref<DriverStoreDirKind | null>(null);
const currentDriverStorePath = ref<DriverStorePathInfo | null>(null);

async function loadDriverStorePath() {
  if (isWeb) return;
  try {
    currentDriverStorePath.value = await api.getDriverStorePath();
  } catch {
    currentDriverStorePath.value = null;
  }
}

function configuredDriverStoreDir(kind: DriverStoreDirKind): string | null {
  if (kind === "plugin") {
    return pluginStoreDir.value ?? (legacyDriverStoreDir.value ? `${legacyDriverStoreDir.value}/plugins` : null);
  }
  return agentStoreDir.value ?? (legacyDriverStoreDir.value ? `${legacyDriverStoreDir.value}/agents` : null);
}

function actualDriverStoreDir(kind: DriverStoreDirKind): string | null {
  if (!currentDriverStorePath.value) return null;
  return kind === "plugin" ? currentDriverStorePath.value.plugins_dir : currentDriverStorePath.value.agents_dir;
}

function driverStoreDirDisplay(kind: DriverStoreDirKind): string {
  return actualDriverStoreDir(kind) ?? configuredDriverStoreDir(kind) ?? t("driverStore.driverStoreDirDefault");
}

function driverStoreTargetLabel(kind: DriverStoreDirKind): string {
  return kind === "plugin" ? t("driverStore.pluginStoreDir") : t("driverStore.agentStoreDir");
}

const driverStorePathRows = computed(() => [
  {
    kind: "plugin" as const,
    label: t("driverStore.pluginStoreDir"),
    description: t("driverStore.pluginStoreDirDescription"),
    display: driverStoreDirDisplay("plugin"),
    custom: Boolean(pluginStoreDir.value || legacyDriverStoreDir.value),
  },
  {
    kind: "agent" as const,
    label: t("driverStore.agentStoreDir"),
    description: t("driverStore.agentStoreDirDescription"),
    display: driverStoreDirDisplay("agent"),
    custom: Boolean(agentStoreDir.value || legacyDriverStoreDir.value),
  },
]);

async function chooseDriverStoreDir(kind: DriverStoreDirKind) {
  if (isWeb || driverStoreDirMigrating.value) return;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: t("driverStore.driverStoreDirDialogTitle", { target: driverStoreTargetLabel(kind) }),
    directory: true,
    multiple: false,
  });
  if (typeof selected === "string") {
    await applyDriverStoreDir(kind, selected);
  }
}

async function resetDriverStoreDir(kind: DriverStoreDirKind) {
  if (driverStoreDirMigrating.value) return;
  await applyDriverStoreDir(kind, null);
}

async function applyDriverStoreDir(kind: DriverStoreDirKind, newDir: string | null) {
  if (driverStoreDirMigrating.value) return;

  const target = driverStoreTargetLabel(kind);
  const confirmed = window.confirm(t("driverStore.driverStoreDirConfirm", { target }));
  if (!confirmed) return;

  driverStoreDirMigrating.value = kind;
  try {
    const result = kind === "plugin" ? await api.setPluginStoreDir(newDir) : await api.setAgentStoreDir(newDir);
    settingsStore.desktopSettings.driver_store_dir = result.driver_store_dir;
    settingsStore.desktopSettings.plugin_store_dir = result.plugin_store_dir;
    settingsStore.desktopSettings.agent_store_dir = result.agent_store_dir;
    currentDriverStorePath.value = {
      driver_store_dir: result.driver_store_dir,
      plugin_store_dir: result.plugin_store_dir,
      agent_store_dir: result.agent_store_dir,
      plugins_dir: result.plugins_dir,
      agents_dir: result.agents_dir,
    };
    toast(t("driverStore.driverStoreDirSuccess", { target }));
    // Restart the app to use the new paths
    const { relaunch } = await import("@tauri-apps/plugin-process");
    relaunch();
  } catch (e: any) {
    toast(t("driverStore.driverStoreDirMigrationFailed", { error: backendError(e) }), 5000);
  } finally {
    driverStoreDirMigrating.value = null;
  }
}

// ──────────── Agent drivers ────────────

const drivers = ref<AgentDriverInfo[]>([]);
const agentDriverSearch = ref("");
const selectedDriverCategory = ref<string>("all");
const installing = ref<string | null>(null);
const upgradingAll = ref(false);
const upgradingCompletedCount = ref(0);
const upgradingTotal = ref(0);
const queuedDriverInstalls = ref<string[]>([]);
const reinstallingJre = ref<string | null>(null);
const activeAgentOperationId = ref<string | null>(null);
const refreshing = ref(false);
const agentProgressByDbType = reactive<Record<string, DriverInstallProgress | null | undefined>>({});
const jdbcPluginProgress = ref<DriverInstallProgress | null>(null);
const javaRuntimeConfig = ref<JavaRuntimeConfig>({ mode: "managed", custom_java_path: null });
const customJavaPath = ref("");
const savingJavaRuntime = ref(false);
const driverStoreUsage = ref<DriverStoreUsage | null>(null);
const clearingDownloadCache = ref(false);
const runtimeSummary = ref<DriverRuntimeSummary | null>(null);
const runtimeLoading = ref(false);
const runtimeError = ref("");
const runtimeBusy = ref<string | null>(null);
let runtimeTimer: ReturnType<typeof setInterval> | null = null;
const DRIVER_RUNTIME_POLL_MS = 5000;
const OFFLINE_DRIVER_DOWNLOAD_URL = "https://dbxio.com/cn/drivers";

let unlisten: (() => void) | null = null;
const lastAgentProgressPercent: Record<string, number> = {};
const lastJdbcPluginProgressPercent = ref<number | null>(null);

const installedJres = computed(() => {
  const jreMap = new Map<string, boolean>();
  for (const d of drivers.value) {
    if (driverRequiresJavaRuntime(d) && d.jre && !jreMap.has(d.jre)) {
      jreMap.set(d.jre, d.jre_installed);
    }
  }
  return [...jreMap.entries()].map(([key, installed]) => ({ key, installed })).sort((a, b) => b.key.localeCompare(a.key));
});

function formatProgressText(p: DriverInstallProgress | null | undefined): string {
  if (!p) return "";
  if (p.step === "jre-extract") return t("driverStore.progressJreExtract");
  if (p.step === "jdbc-plugin-extract") return t("driverStore.progressJdbcPluginExtract");
  const label = p.step === "jre" ? t("driverStore.progressDownloadJre") : p.step === "jdbc-plugin" ? t("driverStore.progressDownloadJdbcPlugin") : t("driverStore.progressDownloadDriver");
  if (!p.total) return `${label}...`;
  const pct = Math.round(((p.downloaded ?? 0) / p.total) * 100);
  const dl = formatSize(p.downloaded ?? 0);
  const total = formatSize(p.total);
  return `${label}  ${dl} / ${total}  (${pct}%)`;
}

function getAgentProgressText(dbType: string): string {
  return formatProgressText(agentProgressByDbType[dbType]);
}

function getJdbcPluginProgressTitle(fallback: string): string {
  return jdbcPluginProgressText.value || fallback;
}

function getAgentProgressTitle(dbType: string, fallback: string): string {
  return getAgentProgressText(dbType) || formatProgressText(agentProgressByDbType[dbType]) || fallback;
}

const jdbcPluginProgressText = computed(() => formatProgressText(jdbcPluginProgress.value));

function getAgentProgressPercent(dbType: string): number | null {
  const progress = agentProgressByDbType[dbType];
  const next = driverInstallProgressPercent(progress);
  if (next !== null) {
    lastAgentProgressPercent[dbType] = next;
  }
  return next ?? lastAgentProgressPercent[dbType] ?? null;
}

const jdbcPluginProgressNumber = computed(() => {
  const next = driverInstallProgressPercent(jdbcPluginProgress.value);
  if (next !== null) {
    lastJdbcPluginProgressPercent.value = next;
  }
  return next ?? lastJdbcPluginProgressPercent.value;
});

function resetAgentInstallProgress() {
  for (const key of Object.keys(agentProgressByDbType)) {
    delete agentProgressByDbType[key];
  }
  for (const key of Object.keys(lastAgentProgressPercent)) {
    delete lastAgentProgressPercent[key];
  }
  jreReinstallProgress.value = null;
  lastJreReinstallPercent.value = null;
}

function resetJdbcPluginInstallProgress() {
  jdbcPluginProgress.value = null;
  lastJdbcPluginProgressPercent.value = null;
}

const downloadCacheBytes = computed(() => Number(driverStoreUsage.value?.download_cache_bytes || 0));
const usageSummary = computed(() => {
  const usage = driverStoreUsage.value;
  if (!usage) return [];
  return [
    { key: "total", label: t("driverStore.usageTotalLabel"), bytes: usage.total_bytes },
    { key: "jre", label: t("driverStore.usageManagedJre"), bytes: usage.jre_bytes },
    { key: "agent", label: t("driverStore.usageAgentDrivers"), bytes: usage.agent_driver_bytes },
    { key: "download-cache", label: t("driverStore.usageDownloadCache"), bytes: usage.download_cache_bytes || 0 },
    { key: "jdbc-plugin", label: t("driverStore.usageJdbcPlugin"), bytes: usage.jdbc_plugin_bytes },
    { key: "jdbc-driver", label: t("driverStore.usageJdbcDriverJars"), bytes: usage.jdbc_driver_bytes },
  ];
});
const canClearDownloadCache = computed(() => !clearingDownloadCache.value && installing.value === null && !upgradingAll.value && reinstallingJre.value === null && downloadCacheBytes.value > 0);
const downloadSourceBusy = computed(() => refreshing.value || installing.value !== null || upgradingAll.value || queuedDriverInstalls.value.length > 0 || reinstallingJre.value !== null);
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

const agentTabUpdateCount = computed(() => drivers.value.filter((d) => d.update_available).length);
const jdbcTabUpdateCount = computed(() => (jdbcPluginStatus.value?.update_available ? 1 : 0));

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
    progressMap: agentProgressByDbType,
  });
}

function driverRequiresJavaRuntime(driver: AgentDriverInfo): boolean {
  return driver.requires_java_runtime ?? Boolean(driver.jre);
}

// JRE reinstall is single-threaded, so a simpler model suffices.
const jreReinstallProgress = ref<DriverInstallProgress | null>(null);
const lastJreReinstallPercent = ref<number | null>(null);

function getJreReinstallPercent(): number | null {
  const next = driverInstallProgressPercent(jreReinstallProgress.value);
  if (next !== null) lastJreReinstallPercent.value = next;
  return next ?? lastJreReinstallPercent.value;
}

function getJreReinstallTitle(fallback: string): string {
  return formatProgressText(jreReinstallProgress.value) || fallback;
}

function isManagedJdbcBuiltinDriver(dbType: string): boolean {
  return isManagedJdbcDriver(dbType);
}

const builtinDriverRows = computed<AgentDriverInfo[]>(() => [...drivers.value, ...managedJdbcDriverRows(jdbcMavenBundles.value, jdbcPluginStatus.value)]);

function driverLabel(dbType: string): string {
  return builtinDriverRows.value.find((d) => d.db_type === dbType)?.label ?? dbType;
}

function isDriverQueued(dbType: string): boolean {
  return queuedDriverInstalls.value.includes(dbType);
}

function canInstallOrUpdateDriver(dbType: string): boolean {
  const driver = builtinDriverRows.value.find((d) => d.db_type === dbType);
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
  // DEV: validate category coverage
  if (import.meta.env.DEV) {
    try {
      assertAgentDriverCategoriesComplete(drivers.value.map((d) => d.db_type));
    } catch (e) {
      console.warn("[DriverStore] Agent driver category mapping incomplete:", e);
    }
  }
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

function setUpdateDownloadSource(value: unknown) {
  if (value !== "official" && value !== "cnb") return;
  if (value === settingsStore.editorSettings.updateDownloadSource) return;
  settingsStore.updateEditorSettings({ updateDownloadSource: value });
  void forceRefresh().catch(() => undefined);
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
    toast(t("driverStore.javaRuntimeSaveFailed", { error: backendError(e) }));
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
  const label = driverLabel(dbType);
  installing.value = dbType;
  activeAgentOperationId.value = uuid();
  resetAgentInstallProgress();
  try {
    const managedResult = await installRegisteredManagedJdbcDriver(dbType, jdbcMavenBundles.value, jdbcPluginStatus.value, api);
    if (managedResult) {
      if (managedResult.pluginStatus) {
        jdbcPluginStatus.value = managedResult.pluginStatus;
        emitDriverUpdateCount();
      }
      if (managedResult.drivers) jdbcDrivers.value = managedResult.drivers;
      jdbcMavenBundles.value = managedResult.bundles;
      void loadDriverStoreUsage();
      toast(t("driverStore.driverInstallSuccess", { label }));
      return;
    }
    const blockers = await api.checkAgentUpdateBlockers([dbType]);
    if (blockers.length > 0) {
      toast(t("driverStore.driverUpdateBlocked", { labels: blockers.map((blocker) => blocker.label).join(", ") }));
      return;
    }
    await api.installAgent(dbType, activeAgentOperationId.value);
    await refreshAgents();
    toast(t("driverStore.driverInstallSuccess", { label }));
  } catch (e: any) {
    toast(t("driverStore.driverInstallFailed", { label, error: backendError(e) }));
  } finally {
    installing.value = null;
    activeAgentOperationId.value = null;
    resetAgentInstallProgress();
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
  activeAgentOperationId.value = uuid();
  upgradingCompletedCount.value = 0;
  queuedDriverInstalls.value = [];
  resetAgentInstallProgress();
  try {
    const updatableDbTypes = drivers.value.filter((driver) => driver.update_available).map((driver) => driver.db_type);
    upgradingTotal.value = updatableDbTypes.length;
    const blockers = await api.checkAgentUpdateBlockers(updatableDbTypes);
    if (blockers.length > 0) {
      toast(t("driverStore.driverUpdateBlocked", { labels: blockers.map((blocker) => blocker.label).join(", ") }));
      return;
    }
    const result = await api.upgradeAllAgents(activeAgentOperationId.value);
    await refreshAgents();
    if (result.failed.length > 0) {
      const failedLabels = result.failed.map((item) => drivers.value.find((driver) => driver.db_type === item.db_type)?.label ?? item.db_type).join(", ");
      toast(t("driverStore.upgradeAllPartial", { count: result.upgraded, failed: failedLabels }));
    } else {
      toast(t("driverStore.upgradeAllSuccess", { count: result.upgraded }));
    }
  } catch (e: any) {
    toast(t("driverStore.upgradeAllFailed", { error: backendError(e) }));
  } finally {
    upgradingAll.value = false;
    activeAgentOperationId.value = null;
    upgradingCompletedCount.value = 0;
    upgradingTotal.value = 0;
    resetAgentInstallProgress();
  }
}

async function uninstallDriver(dbType: string) {
  const label = driverLabel(dbType);
  try {
    const managedResult = await uninstallRegisteredManagedJdbcDriver(dbType, jdbcMavenBundles.value, api);
    if (managedResult) {
      if (managedResult.drivers) jdbcDrivers.value = managedResult.drivers;
      jdbcMavenBundles.value = managedResult.bundles;
      void loadDriverStoreUsage();
      toast(t("driverStore.driverUninstallSuccess", { label }));
      return;
    }
    const blockers = await api.checkAgentUpdateBlockers([dbType]);
    if (blockers.length > 0) {
      toast(t("driverStore.driverUpdateBlocked", { labels: blockers.map((blocker) => blocker.label).join(", ") }));
      return;
    }
    await api.uninstallAgent(dbType);
    await refreshAgents();
    toast(t("driverStore.driverUninstallSuccess", { label }));
  } catch (e: any) {
    toast(t("driverStore.driverUninstallFailed", { label, error: backendError(e) }));
  }
}

const importingZip = ref(false);
const importingDriver = ref<string | null>(null);
const agentImportBusy = computed(() => importingZip.value || importingDriver.value !== null);

function chooseWebOfflineZip(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".zip,.tar.zst";
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
  if (agentImportBusy.value) return;
  let selected: string | File | null = null;
  if (isWeb) {
    selected = await chooseWebOfflineZip();
  } else {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const path = await open({
      title: t("driverStore.chooseOfflineDriverPackage"),
      multiple: false,
      filters: [{ name: "Driver package", extensions: ["zip", "zst"] }],
    });
    selected = typeof path === "string" ? path : null;
  }
  if (!selected) return;
  importingZip.value = true;
  activeAgentOperationId.value = uuid();
  resetAgentInstallProgress();
  try {
    const count = await api.importAgentsFromZip(selected, activeAgentOperationId.value);
    await refreshAgents();
    toast(t("driverStore.offlineImportSuccess", { count }));
  } catch (e: any) {
    toast(t("driverStore.offlineImportFailed", { error: backendError(e) }));
  } finally {
    importingZip.value = false;
    activeAgentOperationId.value = null;
    resetAgentInstallProgress();
  }
}

async function importDriverFile(driver: AgentDriverInfo) {
  if (agentImportBusy.value) return;
  const dbType = driver.db_type;
  if (isManagedJdbcBuiltinDriver(dbType)) {
    await importJdbcDrivers();
    return;
  }
  const blockers = await api.checkAgentUpdateBlockers([dbType]);
  if (blockers.length > 0) {
    toast(t("driverStore.driverUpdateBlocked", { labels: blockers.map((blocker) => blocker.label).join(", ") }));
    return;
  }
  const label = driverLabel(dbType);
  const requiresJavaRuntime = driverRequiresJavaRuntime(driver);
  const isWindows = navigator.userAgent.toLowerCase().includes("windows");
  const installSelectedFile = async (selected: string | File) => {
    if (isOfflineDriverPackage(selected)) {
      activeAgentOperationId.value = uuid();
      resetAgentInstallProgress();
      try {
        const count = await api.importAgentsFromZip(selected, activeAgentOperationId.value);
        await refreshAgents();
        toast(t("driverStore.offlineImportSuccess", { count }));
      } finally {
        activeAgentOperationId.value = null;
        resetAgentInstallProgress();
      }
    } else {
      await api.importAgentDriver(dbType, selected);
      await refreshAgents();
      toast(t("driverStore.driverImportSuccess", { label }));
    }
  };
  const runSelectedFileImport = async (selected: string | File) => {
    importingDriver.value = dbType;
    try {
      await installSelectedFile(selected);
    } catch (e: any) {
      toast(t("driverStore.driverImportFailed", { label, error: backendError(e) }));
    } finally {
      importingDriver.value = null;
    }
  };
  if (isWeb) {
    // Native release assets have no extension on macOS/Linux, so do not apply
    // a browser accept filter that would make the correct file unselectable.
    const file = await chooseWebFile(webDriverImportAccept(requiresJavaRuntime, isWindows));
    if (!file) return;
    await runSelectedFileImport(file);
    return;
  }
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: t("driverStore.chooseDriverJar"),
    multiple: false,
    filters: requiresJavaRuntime ? [{ name: "Driver package or JAR", extensions: ["zip", "zst", "jar"] }] : isWindows ? [{ name: "Driver package or executable", extensions: ["zip", "zst", "exe"] }] : undefined,
  });
  if (typeof selected !== "string") return;
  await runSelectedFileImport(selected);
}

async function reinstallJre(jreKey: string) {
  reinstallingJre.value = jreKey;
  activeAgentOperationId.value = uuid();
  resetAgentInstallProgress();
  try {
    await api.reinstallJre(jreKey, activeAgentOperationId.value);
    await refreshAgents();
    toast(t("driverStore.jreReinstallSuccess", { jre: jreKey }));
  } catch (e: any) {
    toast(t("driverStore.jreReinstallFailed", { jre: jreKey, error: backendError(e) }));
  } finally {
    reinstallingJre.value = null;
    activeAgentOperationId.value = null;
    resetAgentInstallProgress();
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
const jdbcLocalBundles = ref<JdbcLocalBundleInfo[]>([]);
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
      kind: "local";
      id: string;
      title: string;
      subtitle: string;
      source: string;
      size: number;
      bundle: JdbcLocalBundleInfo;
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

// Resolved category list with i18n
const driverCategories = computed(() =>
  DRIVER_CATEGORIES.map((cat) => ({
    key: cat.key,
    title: t(cat.titleKey),
  })),
);

const driverSearchQuery = computed(() => agentDriverSearch.value.trim().toLowerCase());
const isDriverSearchActive = computed(() => !!driverSearchQuery.value);

// Category label helper (for search results badges) — defined before searchedDrivers
function driverCategoryLabel(dbType: string): string {
  const catKey = getCategoryForAgentDriver(dbType);
  if (catKey === "all") return t("driverStore.driverCategoryAll");
  const catDef = DRIVER_CATEGORIES.find((c) => c.key === catKey);
  return catDef ? t(catDef.titleKey) : t("driverStore.driverCategoryAll");
}

// Search only stable drivers — updatable drivers already appear in the global update section.
const stableBuiltinDrivers = computed(() => selectStableDrivers(builtinDriverRows.value));

// Filter stable drivers through search (or pass all through if no search)
const searchedDrivers = computed(() => {
  const query = driverSearchQuery.value;
  if (!query) return stableBuiltinDrivers.value;
  return stableBuiltinDrivers.value.filter((driver) => [driver.label, driver.db_type, driver.version, driver.installed_version, driverRequiresJavaRuntime(driver) ? driver.jre : "", driverCategoryLabel(driver.db_type)].filter(Boolean).join(" ").toLowerCase().includes(query));
});

// When search is active: group by category
const searchedDriversByCategory = computed(() => {
  if (!isDriverSearchActive.value) return [];
  const grouped = new Map<string, AgentDriverInfo[]>();
  for (const driver of searchedDrivers.value) {
    const cat = getCategoryForAgentDriver(driver.db_type);
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(driver);
  }
  return [...grouped.entries()].map(([catKey, drivers]) => {
    const catDef = DRIVER_CATEGORIES.find((c) => c.key === catKey);
    return {
      key: catKey,
      title: catKey === "all" ? t("driverStore.driverCategoryAll") : catDef ? t(catDef.titleKey) : t("driverStore.driverCategoryAll"),
      drivers,
    };
  });
});

// When search is NOT active: filter by selected category
const categoryFilteredDrivers = computed(() => {
  if (isDriverSearchActive.value || selectedDriverCategory.value === "all") return searchedDrivers.value;
  return searchedDrivers.value.filter((driver) => getCategoryForAgentDriver(driver.db_type) === selectedDriverCategory.value);
});

// Global updatable drivers — always shown above category navigation, regardless of filter.
const globalUpdatableDrivers = computed(() => selectUpdatableDrivers(builtinDriverRows.value));

// Whether any global updatable driver matches the current search query or
// selected category.  Used to decide whether the empty‑state message should be
// suppressed: the global update section always renders *all* updatable drivers
// (unfiltered), so the empty‑state must only be hidden when at least one of
// those drivers is actually relevant to the user's current view.
const hasMatchingUpdatableDrivers = computed(() =>
  hasAnyUpdatableDriverMatching(globalUpdatableDrivers.value, {
    searchQuery: driverSearchQuery.value,
    selectedCategory: selectedDriverCategory.value,
    driverMatchesSearch: (driver, query) => [driver.label, driver.db_type, driver.version, driver.installed_version, driverRequiresJavaRuntime(driver) ? driver.jre : "", driverCategoryLabel(driver.db_type)].filter(Boolean).join(" ").toLowerCase().includes(query),
    driverCategory: (driver) => getCategoryForAgentDriver(driver.db_type),
  }),
);

// Category-filtered drivers, excluding those already shown in the global update banner.
const categoryStableDrivers = computed(() => selectStableDrivers(categoryFilteredDrivers.value));

// Category selection handler
function selectDriverCategory(key: string) {
  selectedDriverCategory.value = key;
  // Clear search when switching categories
  agentDriverSearch.value = "";
}

const highlightedFocusKey = ref<string | null>(null);
let focusHighlightTimer: ReturnType<typeof setTimeout> | undefined;

function focusElementKey(focus: DriverStoreFocus): string {
  return focus.target === "driver" ? `driver:${focus.driver ?? ""}` : "jre";
}

watch(
  [() => props.focusTarget, builtinDriverRows],
  async ([focus]) => {
    if (!focus || focus.target === "tab") return;
    driverStoreTab.value = "agent";
    if (focus.target === "driver") {
      // Wait until the requested driver row is loaded before scrolling to it.
      if (!focus.driver || !builtinDriverRows.value.some((driver) => driver.db_type === focus.driver)) return;
      agentDriverSearch.value = "";
      selectedDriverCategory.value = "all";
    }
    const key = focusElementKey(focus);
    highlightedFocusKey.value = key;
    await nextTick();
    document.querySelector(`[data-driver-store-focus="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    clearTimeout(focusHighlightTimer);
    focusHighlightTimer = setTimeout(() => {
      if (highlightedFocusKey.value === key) highlightedFocusKey.value = null;
    }, 6000);
  },
  { immediate: true },
);

const jdbcDriverListItems = computed<JdbcDriverListItem[]>(() => {
  const localBundleItems = jdbcLocalBundles.value.map((bundle) => ({
    kind: "local" as const,
    id: `local:${bundle.id}`,
    title: bundle.name,
    subtitle: `${bundle.artifacts.length} JARs - ${bundle.artifacts.map((artifact) => artifact.file_name).join(", ")}`,
    source: t("driverStore.jdbcSourceManual"),
    size: bundle.artifacts.reduce((total, artifact) => total + Number(artifact.size || 0), 0),
    bundle,
  }));
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
  return [...localBundleItems, ...bundleItems, ...manualItems].sort((a, b) => a.title.localeCompare(b.title));
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
    if (driverStoreTab.value !== "storage") {
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
    toast(t("driverStore.runtimeStopFailed", { label: runtime.label, error: backendError(e) }));
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
    toast(t("driverStore.runtimeRestartFailed", { label: runtime.label, error: backendError(e) }));
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
    const [drivers, bundles, localBundles] = await Promise.all([api.listJdbcDrivers(), api.listJdbcMavenBundles(), api.listJdbcLocalBundles()]);
    jdbcDrivers.value = drivers;
    jdbcMavenBundles.value = bundles;
    jdbcLocalBundles.value = localBundles;
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

async function clearDownloadCache() {
  if (!canClearDownloadCache.value) return;
  clearingDownloadCache.value = true;
  try {
    await api.clearDriverDownloadCache();
    await loadDriverStoreUsage();
    toast(t("driverStore.downloadCacheClearSuccess"));
  } catch (e: any) {
    toast(t("driverStore.downloadCacheClearFailed", { error: backendError(e) }), 5000);
  } finally {
    clearingDownloadCache.value = false;
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
  resetJdbcPluginInstallProgress();
  try {
    jdbcPluginStatus.value = await api.installJdbcPlugin();
    emitDriverUpdateCount();
    toast(t("settings.jdbcPluginInstallSuccess"));
    await loadJdbcDrivers();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  } finally {
    isInstallingJdbcPlugin.value = false;
    resetJdbcPluginInstallProgress();
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
  resetJdbcPluginInstallProgress();
  try {
    jdbcPluginStatus.value = await api.installJdbcPluginLocal(selected);
    emitDriverUpdateCount();
    toast(t("settings.jdbcPluginInstallSuccess"));
    await loadJdbcDrivers();
  } catch (e: any) {
    toast(String(e?.message || e), 5000);
  } finally {
    isInstallingJdbcPlugin.value = false;
    resetJdbcPluginInstallProgress();
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
    jdbcLocalBundles.value = await api.listJdbcLocalBundles();
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
      jdbcLocalBundles.value = await api.listJdbcLocalBundles();
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

async function deleteJdbcLocalBundle(bundleId: string) {
  try {
    jdbcDrivers.value = await api.deleteJdbcLocalBundle(bundleId);
    jdbcLocalBundles.value = await api.listJdbcLocalBundles();
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
  void loadDriverStorePath();

  void forceRefresh().catch(() => undefined);

  unlisten = await api.listenAgentInstallProgress((payload) => {
    const incoming = payload as DriverInstallProgress;
    if (!isDriverInstallProgressForOperation(incoming, activeAgentOperationId.value)) return;
    const channel = driverInstallProgressChannel(incoming);
    const jdbcProgressBuiltinDriver = channel === "jdbc-plugin" && installing.value && isManagedJdbcBuiltinDriver(installing.value) && !isInstallingJdbcPlugin.value ? installing.value : null;
    if (jdbcProgressBuiltinDriver) {
      // Built-in JDBC profiles are shown alongside Agent drivers but install
      // through the JDBC plugin pipeline. Route plugin events into their row.
      updatePerDriverProgress(agentProgressByDbType, { ...incoming, db_type: jdbcProgressBuiltinDriver });
    } else if (channel === "agent") {
      if (incoming.db_type) {
        updatePerDriverProgress(agentProgressByDbType, incoming);
        // Track completions for the batch counter.
        if (incoming.step === "done" && upgradingAll.value) {
          upgradingCompletedCount.value++;
        }
      } else {
        // No db_type — single operation (e.g. JRE reinstall).
        jreReinstallProgress.value = incoming.step === "done" ? null : incoming;
      }
      jdbcPluginProgress.value = null; // clear any stale jdbc-only progress
    } else if (channel === "jdbc-plugin") {
      jdbcPluginProgress.value = incoming.step === "done" ? null : incoming;
    }
    if (payload.total_drivers && !upgradingTotal.value) {
      upgradingTotal.value = payload.total_drivers;
    }
    // During a batch upgrade, refresh the list as soon as each driver finishes
    // (step="done") so its "Update" button disappears immediately instead of
    // staying disabled until the whole batch completes (step="all-done").
    // Single-driver installs (upgradingAll=false) are refreshed by runDriverInstall.
    if (upgradingAll.value && payload.step === "done" && channel === "agent" && payload.db_type) {
      void refreshAgents();
    }
  });
  void loadJdbcDrivers();
  void loadJdbcPluginStatus();
});

onUnmounted(() => {
  unlisten?.();
  stopDriverRuntimePolling();
});

watch(driverStoreTab, (tab) => {
  if (tab === "storage") {
    startDriverRuntimePolling();
  } else {
    stopDriverRuntimePolling();
  }
});
</script>

<template>
  <div class="driver-store-view h-full flex flex-col">
    <div class="driver-store-scroll flex-1 min-h-0 overflow-y-auto">
      <div class="driver-store-container max-w-4xl mx-auto px-6 py-6">
        <Tabs v-model="driverStoreTab" default-value="agent" class="driver-store-tabs-root">
          <div class="driver-store-header flex items-center justify-between">
            <TabsList class="driver-store-tabs grid w-[360px] grid-cols-3">
              <TabsTrigger value="agent" class="gap-1.5 relative">
                {{ t("driverStore.agentDrivers") }}
                <span v-if="agentTabUpdateCount > 0" class="inline-block h-2 w-2 rounded-full bg-red-500" />
              </TabsTrigger>
              <TabsTrigger value="jdbc" class="gap-1.5 relative">
                {{ t("driverStore.jdbcDrivers") }}
                <span v-if="jdbcTabUpdateCount > 0" class="inline-block h-2 w-2 rounded-full bg-red-500" />
              </TabsTrigger>
              <TabsTrigger value="storage" class="gap-1.5">
                {{ t("driverStore.storageTab") }}
              </TabsTrigger>
            </TabsList>
            <div v-if="driverStoreTab !== 'storage'" class="flex flex-wrap items-center gap-2">
              <div v-if="driverStoreTab === 'agent' && !isWeb" class="flex items-center gap-1.5">
                <span class="text-xs text-muted-foreground">{{ t("settings.updateDownloadSource") }}</span>
                <Select :model-value="settingsStore.editorSettings.updateDownloadSource" :disabled="downloadSourceBusy" @update:model-value="setUpdateDownloadSource">
                  <SelectTrigger class="h-7 w-[160px] rounded-md text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="official">{{ t("settings.updateDownloadSourceOfficial") }}</SelectItem>
                    <SelectItem value="cnb">{{ t("settings.updateDownloadSourceCnb") }}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button v-if="driverStoreTab === 'agent'" variant="ghost" size="sm" class="h-7 rounded-md text-xs gap-1 text-muted-foreground" :disabled="agentImportBusy || installing !== null || upgradingAll || reinstallingJre !== null || queuedDriverInstalls.length > 0" @click="importOfflineZip">
                <Loader2 v-if="agentImportBusy" class="h-3.5 w-3.5 animate-spin" />
                <FileUp v-else class="h-3.5 w-3.5" />
                {{ agentImportBusy ? t("driverStore.importing") : t("driverStore.importOfflinePackage") }}
              </Button>
              <Button variant="ghost" size="sm" class="h-7 rounded-md text-xs gap-1 text-muted-foreground" :disabled="refreshing" @click="forceRefresh">
                <RefreshCw class="h-3.5 w-3.5" :class="{ 'animate-spin': refreshing }" />
                {{ t("driverStore.refresh") }}
              </Button>
            </div>
          </div>

          <!-- Agent Tab -->
          <TabsContent value="agent" class="driver-store-tab driver-store-agent-tab mt-5 space-y-5">
            <!-- Java Runtime -->
            <div class="rounded-lg border bg-muted/20 p-4 space-y-3" data-driver-store-focus="jre" :class="{ 'driver-store-focus-highlight': highlightedFocusKey === 'jre' }">
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
                <Button v-if="javaRuntimeConfig.mode === 'custom'" variant="outline" class="h-8 shrink-0 rounded-md text-xs" @click="chooseCustomJavaPath">
                  <FolderOpen class="h-3.5 w-3.5" />
                  {{ t("driverStore.choose") }}
                </Button>
                <Button class="h-8 shrink-0 rounded-md text-xs" :disabled="savingJavaRuntime || (javaRuntimeConfig.mode === 'custom' && !customJavaPath.trim())" @click="saveJavaRuntimeConfig">
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
                    <DriverInstallProgressCircle v-if="reinstallingJre === jre.key" :percent="getJreReinstallPercent()" :title="getJreReinstallTitle(jre.installed ? t('driverStore.reinstalling') : t('driverStore.installing'))" />
                    <Button v-else-if="!jre.installed" type="button" variant="default" size="sm" class="h-8 rounded-md text-xs" :disabled="reinstallingJre !== null || installing !== null || agentImportBusy" @click="reinstallJre(jre.key)">
                      <Download class="h-3.5 w-3.5 mr-1" />
                      {{ t("driverStore.install") }}
                    </Button>
                    <Button v-else-if="jre.installed" type="button" variant="outline" size="sm" class="h-8 rounded-md text-xs" :disabled="reinstallingJre !== null || installing !== null || agentImportBusy" @click="reinstallJre(jre.key)">
                      <RotateCcw class="h-3.5 w-3.5 mr-1" />
                      {{ t("driverStore.reinstall") }}
                    </Button>
                    <Button v-if="jre.installed" type="button" variant="ghost" size="sm" class="h-8 rounded-md text-xs text-muted-foreground hover:text-destructive" :disabled="reinstallingJre !== null || installing !== null || agentImportBusy" @click="uninstallJre(jre.key)">
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
            <!-- Global update section — always above category navigation -->
            <div v-if="globalUpdatableDrivers.length > 0" class="rounded-lg border divide-y">
              <div class="flex items-center justify-between bg-amber-500/10 px-4 py-2.5">
                <div class="min-w-0">
                  <div class="text-sm font-semibold">{{ t("driverStore.updatesAvailableTitle") }} ({{ globalUpdatableDrivers.length }})</div>
                  <p class="text-xs text-muted-foreground">{{ t("driverStore.updatesAvailableDescription") }}</p>
                </div>
                <Button size="sm" class="h-7 rounded-md text-xs shrink-0 ml-3" :disabled="installing !== null || upgradingAll || agentImportBusy" @click="upgradeAll">
                  <Loader2 v-if="upgradingAll" class="h-3 w-3 animate-spin mr-1" />
                  <Download v-else class="h-3 w-3 mr-1" />
                  {{ upgradingAll ? t("driverStore.upgradingProgress", { current: upgradingCompletedCount, total: upgradingTotal }) : t("driverStore.upgradeAll") }}
                </Button>
              </div>
              <div
                v-for="driver in globalUpdatableDrivers"
                :key="driver.db_type"
                :data-driver-store-focus="`driver:${driver.db_type}`"
                class="driver-store-agent-row flex items-center gap-3 px-4 py-2 transition hover:bg-muted/30"
                :class="{ 'driver-store-focus-highlight': highlightedFocusKey === `driver:${driver.db_type}` }"
              >
                <span class="flex h-8 w-8 items-center justify-center rounded-md bg-muted/60 shrink-0">
                  <DatabaseIcon :db-type="driver.db_type" class="h-4 w-4" />
                </span>
                <div class="driver-store-agent-name min-w-0 flex-1">
                  <div class="text-sm font-medium">{{ driver.label }}</div>
                </div>
                <div class="driver-store-agent-meta flex shrink-0 items-center gap-1.5">
                  <span v-if="driverRequiresJavaRuntime(driver) && driver.jre" class="rounded-full px-2 py-0.5 text-[11px]" :class="driver.jre !== '21' ? 'bg-blue-500/10 text-blue-600' : 'bg-muted text-muted-foreground'">JRE {{ driver.jre }}</span>
                  <span v-if="driver.installed" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.installed_version }}</span>
                  <span v-if="driver.installed && driver.update_available" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">→ v{{ driver.version }}</span>
                  <span v-if="!driver.installed && driver.version" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.version }}</span>
                  <span v-if="formatSize(driver.size)" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{{ formatSize(driver.size) }}</span>
                </div>
                <div class="driver-store-agent-actions flex shrink-0 items-center gap-2">
                  <Button
                    v-if="!driver.installed && isDriverQueued(driver.db_type)"
                    size="sm"
                    variant="outline"
                    class="h-7 rounded-md border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                    :disabled="upgradingAll || agentImportBusy"
                    @click="removeQueuedDriverInstall(driver.db_type)"
                  >
                    <Clock3 class="h-3 w-3 mr-1" />
                    {{ t("driverStore.queued") }}
                  </Button>
                  <DriverInstallProgressCircle v-else-if="!driver.installed && isDriverProgressActive(driver.db_type)" :percent="getAgentProgressPercent(driver.db_type)" :title="getAgentProgressTitle(driver.db_type, t('driverStore.installing'))" />
                  <Button v-else-if="!driver.installed" size="sm" class="h-7 rounded-md text-xs" :disabled="upgradingAll || agentImportBusy" @click="installDriver(driver.db_type)">
                    <Download class="h-3 w-3 mr-1" />
                    {{ t("driverStore.install") }}
                  </Button>
                  <Button
                    v-if="!driver.installed && !isManagedJdbcBuiltinDriver(driver.db_type) && !isDriverProgressActive(driver.db_type) && !isDriverQueued(driver.db_type)"
                    size="sm"
                    variant="ghost"
                    class="driver-store-local-import-button h-7 w-7 rounded-md text-xs text-muted-foreground"
                    :title="importingDriver === driver.db_type ? t('driverStore.importing') : t('driverStore.importLocalJar')"
                    :disabled="upgradingAll || installing !== null || agentImportBusy"
                    @click="importDriverFile(driver)"
                  >
                    <Loader2 v-if="importingDriver === driver.db_type" class="h-3.5 w-3.5 animate-spin" />
                    <FileUp v-else class="h-3.5 w-3.5" />
                  </Button>
                  <Check v-if="driver.installed && !(driver.update_available && isDriverProgressActive(driver.db_type))" class="h-4 w-4 text-green-600" />
                  <Button
                    v-if="driver.installed && driver.update_available && isDriverQueued(driver.db_type)"
                    size="sm"
                    variant="outline"
                    class="h-7 rounded-md border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                    :disabled="upgradingAll || agentImportBusy"
                    @click="removeQueuedDriverInstall(driver.db_type)"
                  >
                    <Clock3 class="h-3 w-3 mr-1" />
                    {{ t("driverStore.queued") }}
                  </Button>
                  <DriverInstallProgressCircle v-else-if="driver.installed && driver.update_available && isDriverProgressActive(driver.db_type)" :percent="getAgentProgressPercent(driver.db_type)" :title="getAgentProgressTitle(driver.db_type, t('driverStore.updating'))" />
                  <Button v-else-if="driver.installed && driver.update_available" size="sm" variant="outline" class="h-7 rounded-md text-xs" :disabled="upgradingAll || agentImportBusy" @click="installDriver(driver.db_type)">
                    {{ t("driverStore.update") }}
                  </Button>
                  <Button v-if="driver.installed" variant="ghost" size="sm" class="h-7 rounded-md text-xs text-muted-foreground hover:text-destructive" :disabled="installing !== null || upgradingAll || agentImportBusy || isDriverQueued(driver.db_type)" @click="uninstallDriver(driver.db_type)">
                    {{ t("driverStore.uninstall") }}
                  </Button>
                </div>
              </div>
            </div>
            <!-- Category nav + driver list container -->
            <div class="min-h-0 flex flex-1 flex-col gap-3 overflow-hidden sm:flex-row sm:gap-0">
              <!-- Category navigation sidebar -->
              <nav v-if="!isDriverSearchActive" data-driver-category-nav class="flex shrink-0 gap-1 overflow-x-auto border-b px-0.5 pt-0.5 pb-2 sm:w-40 sm:flex-col sm:overflow-y-auto sm:border-b-0 sm:border-r sm:py-0.5 sm:pr-3.5" :aria-label="t('driverStore.driverCategoryLabel')">
                <button
                  type="button"
                  class="shrink-0 whitespace-nowrap rounded-[4px] px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-full"
                  :class="selectedDriverCategory === 'all' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted/70'"
                  :aria-current="selectedDriverCategory === 'all' ? 'page' : undefined"
                  @click="selectDriverCategory('all')"
                >
                  {{ t("driverStore.driverCategoryAll") }}
                </button>
                <button
                  v-for="cat in driverCategories"
                  :key="cat.key"
                  type="button"
                  class="shrink-0 whitespace-nowrap rounded-[4px] px-3 py-2 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:w-full"
                  :class="selectedDriverCategory === cat.key ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-muted/70'"
                  :aria-current="selectedDriverCategory === cat.key ? 'page' : undefined"
                  @click="selectDriverCategory(cat.key)"
                >
                  {{ cat.title }}
                </button>
              </nav>

              <!-- Driver list area -->
              <div class="driver-store-agent-results min-w-0 flex-1 overflow-y-auto sm:pl-4">
                <!-- Empty: still loading -->
                <div v-if="drivers.length === 0" class="py-12 text-center text-sm text-muted-foreground">
                  {{ t("common.loading") }}
                </div>
                <!-- Empty: no search results (suppressed when updatable drivers match the search) -->
                <div v-else-if="isDriverSearchActive && searchedDrivers.length === 0 && !hasMatchingUpdatableDrivers" class="py-12 text-center text-sm text-muted-foreground">
                  {{ t("driverStore.noMatchingDrivers") }}
                </div>
                <!-- Empty: no drivers in selected category (suppressed when updatable drivers match the category) -->
                <div v-else-if="!isDriverSearchActive && categoryFilteredDrivers.length === 0 && !hasMatchingUpdatableDrivers" class="py-12 text-center text-sm text-muted-foreground">
                  {{ t("driverStore.noMatchingDrivers") }}
                </div>

                <!-- Search results: cross-category view -->
                <div v-else-if="isDriverSearchActive && searchedDriversByCategory.length > 0" class="space-y-4">
                  <div v-for="group in searchedDriversByCategory" :key="group.key" class="space-y-2">
                    <h3 class="px-4 text-sm font-medium text-muted-foreground">{{ group.title }}</h3>
                    <div class="rounded-lg border divide-y">
                      <div
                        v-for="driver in group.drivers"
                        :key="driver.db_type"
                        :data-driver-store-focus="`driver:${driver.db_type}`"
                        class="driver-store-agent-row flex items-center gap-3 px-4 py-2 transition hover:bg-muted/30"
                        :class="{ 'driver-store-focus-highlight': highlightedFocusKey === `driver:${driver.db_type}` }"
                      >
                        <span class="flex h-8 w-8 items-center justify-center rounded-md bg-muted/60 shrink-0">
                          <DatabaseIcon :db-type="driver.db_type" class="h-4 w-4" />
                        </span>
                        <div class="driver-store-agent-name min-w-0 flex-1">
                          <div class="text-sm font-medium">{{ driver.label }}</div>
                        </div>
                        <span class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{{ driverCategoryLabel(driver.db_type) }}</span>
                        <div class="driver-store-agent-meta flex shrink-0 items-center gap-1.5">
                          <span v-if="driverRequiresJavaRuntime(driver) && driver.jre" class="rounded-full px-2 py-0.5 text-[11px]" :class="driver.jre !== '21' ? 'bg-blue-500/10 text-blue-600' : 'bg-muted text-muted-foreground'">JRE {{ driver.jre }}</span>
                          <span v-if="driver.installed" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.installed_version }}</span>
                          <span v-if="driver.installed && driver.update_available" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">→ v{{ driver.version }}</span>
                          <span v-if="!driver.installed && driver.version" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.version }}</span>
                          <span v-if="formatSize(driver.size)" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{{ formatSize(driver.size) }}</span>
                        </div>
                        <div class="driver-store-agent-actions flex shrink-0 items-center gap-2">
                          <Button
                            v-if="!driver.installed && isDriverQueued(driver.db_type)"
                            size="sm"
                            variant="outline"
                            class="h-7 rounded-md border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                            :disabled="upgradingAll || agentImportBusy"
                            @click="removeQueuedDriverInstall(driver.db_type)"
                          >
                            <Clock3 class="h-3 w-3 mr-1" />
                            {{ t("driverStore.queued") }}
                          </Button>
                          <DriverInstallProgressCircle v-else-if="!driver.installed && isDriverProgressActive(driver.db_type)" :percent="getAgentProgressPercent(driver.db_type)" :title="getAgentProgressTitle(driver.db_type, t('driverStore.installing'))" />
                          <Button v-else-if="!driver.installed" size="sm" class="h-7 rounded-md text-xs" :disabled="upgradingAll || agentImportBusy" @click="installDriver(driver.db_type)">
                            <Download class="h-3 w-3 mr-1" />
                            {{ t("driverStore.install") }}
                          </Button>
                          <Button
                            v-if="!driver.installed && !isManagedJdbcBuiltinDriver(driver.db_type) && !isDriverProgressActive(driver.db_type) && !isDriverQueued(driver.db_type)"
                            size="sm"
                            variant="ghost"
                            class="driver-store-local-import-button h-7 w-7 rounded-md text-xs text-muted-foreground"
                            :title="importingDriver === driver.db_type ? t('driverStore.importing') : t('driverStore.importLocalJar')"
                            :disabled="upgradingAll || installing !== null || agentImportBusy"
                            @click="importDriverFile(driver)"
                          >
                            <Loader2 v-if="importingDriver === driver.db_type" class="h-3.5 w-3.5 animate-spin" />
                            <FileUp v-else class="h-3.5 w-3.5" />
                          </Button>
                          <Check v-if="driver.installed && !(driver.update_available && isDriverProgressActive(driver.db_type))" class="h-4 w-4 text-green-600" />
                          <Button
                            v-if="driver.installed && driver.update_available && isDriverQueued(driver.db_type)"
                            size="sm"
                            variant="outline"
                            class="h-7 rounded-md border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                            :disabled="upgradingAll || agentImportBusy"
                            @click="removeQueuedDriverInstall(driver.db_type)"
                          >
                            <Clock3 class="h-3 w-3 mr-1" />
                            {{ t("driverStore.queued") }}
                          </Button>
                          <DriverInstallProgressCircle v-else-if="driver.installed && driver.update_available && isDriverProgressActive(driver.db_type)" :percent="getAgentProgressPercent(driver.db_type)" :title="getAgentProgressTitle(driver.db_type, t('driverStore.updating'))" />
                          <Button v-else-if="driver.installed && driver.update_available" size="sm" variant="outline" class="h-7 rounded-md text-xs" :disabled="upgradingAll || agentImportBusy" @click="installDriver(driver.db_type)">
                            {{ t("driverStore.update") }}
                          </Button>
                          <Button
                            v-if="driver.installed"
                            variant="ghost"
                            size="sm"
                            class="h-7 rounded-md text-xs text-muted-foreground hover:text-destructive"
                            :disabled="installing !== null || upgradingAll || agentImportBusy || isDriverQueued(driver.db_type)"
                            @click="uninstallDriver(driver.db_type)"
                          >
                            {{ t("driverStore.uninstall") }}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- Normal view: category-filtered stable drivers (updatable drivers are in the global banner above) -->
                <div v-else class="driver-store-agent-list rounded-lg border divide-y">
                  <!-- Stable driver rows -->
                  <div
                    v-for="driver in categoryStableDrivers"
                    :key="driver.db_type"
                    :data-driver-store-focus="`driver:${driver.db_type}`"
                    class="driver-store-agent-row flex items-center gap-3 px-4 py-2 transition hover:bg-muted/30"
                    :class="{ 'driver-store-focus-highlight': highlightedFocusKey === `driver:${driver.db_type}` }"
                  >
                    <span class="flex h-8 w-8 items-center justify-center rounded-md bg-muted/60 shrink-0">
                      <DatabaseIcon :db-type="driver.db_type" class="h-4 w-4" />
                    </span>
                    <div class="driver-store-agent-name min-w-0 flex-1">
                      <div class="text-sm font-medium">{{ driver.label }}</div>
                    </div>
                    <div class="driver-store-agent-meta flex shrink-0 items-center gap-1.5">
                      <span v-if="driverRequiresJavaRuntime(driver) && driver.jre" class="rounded-full px-2 py-0.5 text-[11px]" :class="driver.jre !== '21' ? 'bg-blue-500/10 text-blue-600' : 'bg-muted text-muted-foreground'">JRE {{ driver.jre }}</span>
                      <span v-if="driver.installed" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.installed_version }}</span>
                      <span v-if="driver.installed && driver.update_available" class="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] text-amber-600">→ v{{ driver.version }}</span>
                      <span v-if="!driver.installed && driver.version" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">v{{ driver.version }}</span>
                      <span v-if="formatSize(driver.size)" class="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">{{ formatSize(driver.size) }}</span>
                    </div>
                    <div class="driver-store-agent-actions flex shrink-0 items-center gap-2">
                      <Button
                        v-if="!driver.installed && isDriverQueued(driver.db_type)"
                        size="sm"
                        variant="outline"
                        class="h-7 rounded-md border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                        :disabled="upgradingAll || agentImportBusy"
                        @click="removeQueuedDriverInstall(driver.db_type)"
                      >
                        <Clock3 class="h-3 w-3 mr-1" />
                        {{ t("driverStore.queued") }}
                      </Button>
                      <DriverInstallProgressCircle v-else-if="!driver.installed && isDriverProgressActive(driver.db_type)" :percent="getAgentProgressPercent(driver.db_type)" :title="getAgentProgressTitle(driver.db_type, t('driverStore.installing'))" />
                      <Button v-else-if="!driver.installed" size="sm" class="h-7 rounded-md text-xs" :disabled="upgradingAll || agentImportBusy" @click="installDriver(driver.db_type)">
                        <Download class="h-3 w-3 mr-1" />
                        {{ t("driverStore.install") }}
                      </Button>
                      <Button
                        v-if="!driver.installed && !isManagedJdbcBuiltinDriver(driver.db_type) && !isDriverProgressActive(driver.db_type) && !isDriverQueued(driver.db_type)"
                        size="sm"
                        variant="ghost"
                        class="driver-store-local-import-button h-7 w-7 rounded-md text-xs text-muted-foreground"
                        :title="importingDriver === driver.db_type ? t('driverStore.importing') : t('driverStore.importLocalJar')"
                        :disabled="upgradingAll || installing !== null || agentImportBusy"
                        @click="importDriverFile(driver)"
                      >
                        <Loader2 v-if="importingDriver === driver.db_type" class="h-3.5 w-3.5 animate-spin" />
                        <FileUp v-else class="h-3.5 w-3.5" />
                      </Button>
                      <Check v-if="driver.installed && !(driver.update_available && isDriverProgressActive(driver.db_type))" class="h-4 w-4 text-green-600" />
                      <Button
                        v-if="driver.installed && driver.update_available && isDriverQueued(driver.db_type)"
                        size="sm"
                        variant="outline"
                        class="h-7 rounded-md border-green-500/30 bg-green-500/10 text-xs text-green-700 hover:bg-green-500/15"
                        :disabled="upgradingAll || agentImportBusy"
                        @click="removeQueuedDriverInstall(driver.db_type)"
                      >
                        <Clock3 class="h-3 w-3 mr-1" />
                        {{ t("driverStore.queued") }}
                      </Button>
                      <DriverInstallProgressCircle v-else-if="driver.installed && driver.update_available && isDriverProgressActive(driver.db_type)" :percent="getAgentProgressPercent(driver.db_type)" :title="getAgentProgressTitle(driver.db_type, t('driverStore.updating'))" />
                      <Button v-else-if="driver.installed && driver.update_available" size="sm" variant="outline" class="h-7 rounded-md text-xs" :disabled="upgradingAll || agentImportBusy" @click="installDriver(driver.db_type)">
                        {{ t("driverStore.update") }}
                      </Button>
                      <Button v-if="driver.installed" variant="ghost" size="sm" class="h-7 rounded-md text-xs text-muted-foreground hover:text-destructive" :disabled="installing !== null || upgradingAll || agentImportBusy || isDriverQueued(driver.db_type)" @click="uninstallDriver(driver.db_type)">
                        {{ t("driverStore.uninstall") }}
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          <!-- JDBC Tab -->
          <TabsContent value="jdbc" class="driver-store-tab driver-store-jdbc-tab mt-5 space-y-5">
            <!-- JDBC Plugin -->
            <div class="rounded-lg border bg-muted/20 p-4">
              <div class="flex min-h-12 items-center justify-between gap-3">
                <div class="min-w-0 space-y-1">
                  <Label>{{ t("settings.jdbcPlugin") }}</Label>
                  <p v-if="!jdbcPluginStatus?.installed" class="text-xs text-muted-foreground">
                    {{ t("settings.jdbcPluginNotInstalled") }}
                  </p>
                </div>
                <div class="flex shrink-0 items-center gap-3">
                  <DriverInstallProgressCircle v-if="isInstallingJdbcPlugin" :percent="jdbcPluginProgressNumber" :title="getJdbcPluginProgressTitle(t('driverStore.progressDownloadJdbcPlugin'))" />
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
                  <Button v-if="jdbcPluginStatus?.installed && jdbcPluginStatus.update_available" type="button" variant="outline" class="rounded-md" :disabled="isInstallingJdbcPlugin" @click="installJdbcPlugin">
                    {{ isInstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginUpdate") }}
                  </Button>
                  <Button v-if="jdbcPluginStatus?.installed" type="button" variant="outline" class="rounded-md" :disabled="isUninstallingJdbcPlugin" @click="uninstallJdbcPlugin">
                    {{ isUninstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginUninstall") }}
                  </Button>
                  <Button v-else type="button" variant="default" class="rounded-md" :disabled="isInstallingJdbcPlugin" @click="installJdbcPlugin">
                    {{ isInstallingJdbcPlugin ? t("common.loading") : t("settings.jdbcPluginInstall") }}
                  </Button>
                  <Button type="button" variant="outline" class="rounded-md" :disabled="isInstallingJdbcPlugin || isUninstallingJdbcPlugin" @click="installJdbcPluginLocal">
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
                <Button variant="outline" class="rounded-md" :disabled="!jdbcDriverPathInput.trim()" @click="importJdbcDriverPathInput">
                  {{ t("settings.jdbcImportPath") }}
                </Button>
                <Button class="shrink-0 rounded-md" @click="importJdbcDrivers">
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
                <Button class="h-8 shrink-0 rounded-md" :disabled="!jdbcMavenCoordinateInput.trim() || isInstallingJdbcMavenDriver || (jdbcMavenRepository === 'custom' && !customJdbcMavenRepository.trim())" @click="installJdbcMavenDriver">
                  <Loader2 v-if="isInstallingJdbcMavenDriver" class="h-4 w-4 animate-spin" />
                  <Download v-else class="h-4 w-4" />
                  {{ t("driverStore.jdbcMavenInstall") }}
                </Button>
              </div>
              <Input v-if="jdbcMavenRepository === 'custom'" v-model="customJdbcMavenRepository" class="h-8 text-xs" placeholder="https://repo.example.com/repository/maven-public" @keydown.enter.prevent="installJdbcMavenDriver" />
            </div>

            <div class="driver-store-jdbc-list rounded-lg border">
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
                <div v-for="item in filteredJdbcDrivers" :key="item.id" class="driver-store-jdbc-row flex items-center gap-3 p-3">
                  <div class="driver-store-jdbc-name min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-2">
                      <div class="truncate text-sm font-medium">{{ item.title }}</div>
                      <Badge variant="outline" class="h-5 shrink-0 rounded-full px-2 text-[10px] font-medium">
                        {{ item.source }}
                      </Badge>
                    </div>
                    <div class="truncate text-xs text-muted-foreground">{{ item.subtitle }}</div>
                  </div>
                  <div class="shrink-0 text-xs text-muted-foreground">{{ formatBytes(item.size) }}</div>
                  <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 rounded-md" @click="item.kind === 'maven' ? deleteJdbcMavenBundle(item.bundle.id) : item.kind === 'local' ? deleteJdbcLocalBundle(item.bundle.id) : deleteJdbcDriver(item.driver.path)">
                    <Trash2 class="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </div>
          </TabsContent>

          <!-- Runtime Tab -->
          <TabsContent value="storage" class="driver-store-tab driver-store-storage-tab mt-5 space-y-5">
            <!-- Storage Usage -->
            <div class="rounded-lg border bg-muted/20 p-4 space-y-3">
              <div class="flex items-center justify-between gap-3">
                <div class="text-sm font-medium">{{ t("driverStore.usageTitle") }}</div>
                <div class="flex shrink-0 items-center gap-2">
                  <div class="text-xs text-muted-foreground">
                    {{ usageSummary.length ? t("driverStore.usageTotal", { size: formatBytes(usageSummary[0].bytes) }) : t("driverStore.calculating") }}
                  </div>
                  <Button variant="outline" size="sm" class="h-7 gap-1.5 rounded-md text-xs" :disabled="!canClearDownloadCache" @click="clearDownloadCache">
                    <Loader2 v-if="clearingDownloadCache" class="h-3.5 w-3.5 animate-spin" />
                    <Trash2 v-else class="h-3.5 w-3.5" />
                    {{ clearingDownloadCache ? t("common.loading") : t("driverStore.clearDownloadCache") }}
                  </Button>
                </div>
              </div>
              <div v-if="usageSummary.length" class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <div v-for="item in usageSummary" :key="item.key" class="rounded-lg border bg-background/50 px-2.5 py-2 text-center">
                  <div class="text-[11px] text-muted-foreground">{{ item.label }}</div>
                  <div class="mt-0.5 text-xs font-medium">{{ formatBytes(item.bytes) }}</div>
                </div>
              </div>
            </div>

            <!-- Driver Store Path -->
            <div v-if="!isWeb" class="rounded-lg border bg-muted/20 p-4 space-y-3">
              <div class="text-sm font-medium">{{ t("driverStore.driverStoreDir") }}</div>
              <p class="text-xs text-muted-foreground">{{ t("driverStore.driverStoreDirDescription") }}</p>
              <div class="space-y-2.5">
                <div v-for="row in driverStorePathRows" :key="row.kind" class="rounded-lg border bg-background/50 p-3">
                  <div class="mb-2 flex items-start justify-between gap-3">
                    <div class="min-w-0 text-xs leading-5">
                      <span class="font-medium">{{ row.label }}</span>
                      <span class="ml-2 text-[11px] text-muted-foreground">{{ row.description }}</span>
                    </div>
                    <Loader2 v-if="driverStoreDirMigrating === row.kind" class="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                  </div>
                  <div class="flex items-center gap-2">
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <div class="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-xs font-mono truncate">
                          {{ row.display }}
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" class="max-w-100 break-all text-xs">
                        {{ row.display }}
                      </TooltipContent>
                    </Tooltip>
                    <Button variant="outline" size="sm" class="shrink-0 gap-1" :disabled="Boolean(driverStoreDirMigrating)" @click="chooseDriverStoreDir(row.kind)">
                      <FolderSync class="h-3.5 w-3.5" />
                      {{ t("driverStore.driverStoreDirChange") }}
                    </Button>
                    <Button v-if="row.custom" variant="ghost" size="sm" class="shrink-0 gap-1 text-muted-foreground" :disabled="Boolean(driverStoreDirMigrating)" @click="resetDriverStoreDir(row.kind)">
                      {{ t("driverStore.driverStoreDirReset") }}
                    </Button>
                  </div>
                </div>
              </div>
              <p v-if="driverStoreDirMigrating" class="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 class="h-3 w-3 animate-spin" />
                {{ t("driverStore.driverStoreDirMigrating", { target: driverStoreTargetLabel(driverStoreDirMigrating) }) }}
              </p>
            </div>

            <!-- Offline Download -->
            <div class="rounded-lg border bg-muted/20 p-4">
              <div class="flex items-center justify-between gap-3">
                <div class="min-w-0 text-xs text-muted-foreground">
                  {{ t("driverStore.offlineDownloadHint") }}
                </div>
                <Button variant="outline" size="sm" class="shrink-0 gap-1" @click="openOfflineDriverDownload">
                  <ExternalLink class="h-3.5 w-3.5" />
                  {{ t("driverStore.offlineDownloadLink") }}
                </Button>
              </div>
            </div>

            <!-- Runtime Info -->
            <div class="overflow-hidden rounded-lg border bg-background">
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
                <Button variant="ghost" size="icon" class="h-8 w-8 shrink-0 rounded-md text-muted-foreground" :title="t('driverStore.refresh')" :disabled="runtimeLoading" @click="refreshDriverRuntime">
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
                        <template v-if="runtime.protocol_mode">
                          <span class="text-muted-foreground/50">/</span>
                          <span>{{ driverRuntimeProtocolLabel(runtime) }}</span>
                        </template>
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
                      <Button v-if="runtime.can_stop" variant="ghost" size="icon" class="h-7 w-7 rounded-md text-muted-foreground hover:text-destructive" :title="t('driverStore.runtimeStop')" :disabled="runtimeBusy === runtime.id" @click="stopRuntime(runtime)">
                        <Square class="h-3.5 w-3.5" />
                      </Button>
                      <Button v-if="runtime.can_restart" variant="ghost" size="icon" class="h-7 w-7 rounded-md text-muted-foreground" :title="t('driverStore.runtimeRestart')" :disabled="runtimeBusy === runtime.id" @click="restartRuntime(runtime)">
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

<style>
.driver-store-focus-highlight {
  background-color: color-mix(in srgb, var(--primary) 8%, transparent);
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--primary) 45%, transparent);
  border-radius: var(--dbx-radius-fixed-6);
}

.driver-store-view,
.driver-store-scroll {
  overflow-x: hidden;
}

.driver-store-view {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.driver-store-scroll {
  height: 100%;
  min-height: 0;
  overflow-y: auto !important;
}

.driver-store-container {
  box-sizing: border-box;
  width: 100%;
  max-width: none !important;
  margin-left: 0 !important;
  margin-right: 0 !important;
  padding: 1.25rem 1.5rem 1.5rem !important;
}

.driver-store-tabs {
  display: grid !important;
  width: 360px !important;
  grid-template-columns: repeat(3, minmax(0, 1fr)) !important;
}

.driver-store-tabs-root {
  display: flex !important;
  width: 100%;
  min-width: 0;
  flex-direction: column !important;
}

.driver-store-tabs-root > [data-slot="tabs-content"] {
  width: 100%;
  min-width: 0;
}

.driver-store-header {
  flex-shrink: 0;
}

.driver-store-tab {
  min-height: 0;
  overflow: visible;
}

.driver-store-tabs-root > [data-slot="tabs-content"][hidden] {
  display: none !important;
}

.driver-store-agent-tab,
.driver-store-jdbc-tab {
  flex-direction: column;
  gap: 1rem;
}

.driver-store-agent-tab:not([hidden]),
.driver-store-jdbc-tab:not([hidden]) {
  display: flex !important;
}

.driver-store-agent-tab > :not([hidden]) ~ :not([hidden]),
.driver-store-jdbc-tab > :not([hidden]) ~ :not([hidden]) {
  margin-top: 0 !important;
}

.driver-store-agent-tab > *,
.driver-store-jdbc-tab > * {
  flex-shrink: 0;
}

.driver-store-agent-row {
  display: flex !important;
  align-items: center !important;
  min-width: 0;
  width: 100%;
}

.driver-store-agent-list,
.driver-store-jdbc-list {
  width: 100%;
  flex: 0 0 auto !important;
  min-height: 0;
  overflow-y: visible;
  overflow-x: hidden;
}

.driver-store-agent-name,
.driver-store-jdbc-name {
  flex: 1 1 auto !important;
  min-width: 0 !important;
}

.driver-store-agent-meta,
.driver-store-agent-actions,
.driver-store-jdbc-row > .shrink-0,
.driver-store-jdbc-row > button {
  flex-shrink: 0 !important;
}

.driver-store-jdbc-row {
  display: flex !important;
  align-items: center !important;
  min-width: 0;
  width: 100%;
}

.driver-store-jdbc-row > button {
  width: 2rem !important;
  height: 2rem !important;
}

html.dbx-legacy-webview .driver-store-tab {
  margin-top: 1.25rem !important;
}

html.dbx-legacy-webview .driver-store-agent-tab:not([hidden]),
html.dbx-legacy-webview .driver-store-jdbc-tab:not([hidden]),
html.dbx-legacy-webview .driver-store-storage-tab:not([hidden]) {
  display: flex !important;
  flex-direction: column !important;
  gap: 1.25rem !important;
}

html.dbx-legacy-webview .driver-store-agent-tab > :not([hidden]) ~ :not([hidden]),
html.dbx-legacy-webview .driver-store-jdbc-tab > :not([hidden]) ~ :not([hidden]),
html.dbx-legacy-webview .driver-store-storage-tab > :not([hidden]) ~ :not([hidden]) {
  margin-top: 0 !important;
}

html.dbx-legacy-webview .driver-store-local-import-button {
  width: 2rem !important;
  height: 2rem !important;
  padding: 0 !important;
}

html.dbx-legacy-webview .driver-store-local-import-button svg {
  width: 1rem !important;
  height: 1rem !important;
}

@media (min-width: 640px) {
  html.dbx-legacy-webview [data-driver-category-nav] {
    width: 10rem !important;
    flex-direction: column !important;
    overflow-x: hidden !important;
    overflow-y: auto !important;
    border-right-width: 1px !important;
    border-bottom-width: 0 !important;
    padding-top: 0.125rem !important;
    padding-right: 0.875rem !important;
    padding-bottom: 0.125rem !important;
  }

  html.dbx-legacy-webview [data-driver-category-nav] > button {
    width: 100% !important;
    align-self: stretch !important;
  }

  html.dbx-legacy-webview [data-driver-category-nav] > button[aria-current="page"] {
    background-color: rgba(23, 23, 23, 0.08) !important;
    color: rgb(23, 23, 23) !important;
  }

  html.dbx-legacy-webview.dark [data-driver-category-nav] > button[aria-current="page"] {
    background-color: rgba(255, 255, 255, 0.1) !important;
    color: rgb(244, 244, 245) !important;
  }

  html.dbx-legacy-webview .driver-store-agent-results {
    width: 0 !important;
    min-width: 0 !important;
    flex: 1 1 0% !important;
    padding-left: 1rem !important;
  }
}

@media (max-width: 900px) {
  .driver-store-header {
    align-items: flex-start !important;
    flex-direction: column !important;
    gap: 0.75rem;
  }

  .driver-store-tabs {
    width: 100% !important;
  }

  .driver-store-agent-row {
    align-items: flex-start !important;
    flex-wrap: wrap;
  }

  .driver-store-jdbc-row {
    align-items: flex-start !important;
    flex-wrap: wrap;
  }

  .driver-store-agent-meta,
  .driver-store-agent-actions {
    margin-left: 2.75rem;
  }

  .driver-store-jdbc-row > .shrink-0,
  .driver-store-jdbc-row > button {
    margin-left: 2.75rem;
  }
}
</style>

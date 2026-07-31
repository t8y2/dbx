<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, ArrowUpDown, Box, ChevronDown, ChevronRight, Copy, Download, File, FileDown, FileUp, Folder, ListChecks, Pause, Pencil, Play, Plus, RefreshCw, RotateCw, Search, Square, Trash2, Upload, LoaderCircle, CircleHelp, Settings, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Switch } from "@/components/ui/switch";
import MetricLineChart from "@/components/chart/MetricLineChart.vue";
import JsonTree from "@/components/common/JsonTree.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import LightTooltip from "@/components/ui/LightTooltip.vue";
import { useToast } from "@/composables/useToast";
import { hexToRgba } from "@/lib/common/color";
import { copyToClipboard } from "@/lib/common/clipboard";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import * as api from "@/lib/backend/api";
import { createDockerProgressParseState, parseDockerProgressEvent, type DockerProgressParseState } from "@/components/docker/dockerTransferProgress";
import { createPendingDockerPullTask } from "@/components/docker/dockerPullTask";
import type { ConnectionConfig } from "@/types/database";
import type {
  DockerConnectionInfo,
  DockerEngineDetails,
  DockerContainer,
  DockerContainerAction,
  DockerContainerStats,
  DockerComposeApplyRequest,
  DockerCreateContainerRequest,
  DockerCreateNetworkRequest,
  DockerCreateVolumeRequest,
  DockerFileEntry,
  DockerFilePreview,
  DockerImage,
  DockerNetwork,
  DockerRegistryAuth,
  DockerStreamHandle,
  DockerTransferProgress,
  DockerVolume,
} from "@/types/docker";

const props = defineProps<{ connection: ConnectionConfig }>();
const { t } = useI18n();
const { toast } = useToast();

type ResourceKind = "containers" | "images" | "volumes" | "networks";
type ContainerFilter = "all" | "running" | "stopped";
type DetailTab = "overview" | "logs" | "monitoring" | "files";
type TrendPoint = DockerContainerStats;
type SortDirection = "asc" | "desc";

const resource = ref<ResourceKind>("containers");
const filter = ref<ContainerFilter>("all");
const loading = ref(false);
const error = ref("");
const query = ref("");
const engineInfo = ref<DockerConnectionInfo>();
const engineDetails = ref<DockerEngineDetails>();
const engineDetailsLoading = ref(false);
const engineJsonOpen = ref(false);
const engineSummaryOpen = ref(false);
const engineJsonSearch = ref("");
const containers = ref<DockerContainer[]>([]);
const images = ref<DockerImage[]>([]);
const volumes = ref<DockerVolume[]>([]);
const networks = ref<DockerNetwork[]>([]);
const listStats = ref<Record<string, DockerContainerStats>>({});
const expandedProjects = ref(new Set<string>());
const selectedContainerId = ref("");
const detailTab = ref<DetailTab>("overview");
const inspect = ref<Record<string, any>>({});
const trend = ref<TrendPoint[]>([]);
const actionInFlight = ref<Record<string, string | undefined>>({});
const imageActionInFlight = ref<Record<string, string | undefined>>({});
type TransferTask = DockerTransferProgress & { startedAt: number; handle?: DockerStreamHandle };
const transfers = ref<TransferTask[]>([]);
const cancelledTransferIds = new Set<string>();
const transferParseStates = new Map<string, DockerProgressParseState>();
const transferOpen = ref(false);
const pushImageOpen = ref(false);
const pushDraft = ref({ sourceImageId: "", targetReference: "", serverAddress: "", username: "", password: "" });
const autoRefresh = ref(true);
const refreshCountdown = ref(10);
const lastRefreshAt = ref<Date>();
const refreshInFlight = ref(false);
const columnWidths = ref<Record<ResourceKind, number[]>>({
  containers: [230, 110, 190, 150, 80, 160, 95, 260],
  images: [280, 140, 110, 180, 260],
  volumes: [220, 140, 140, 380],
  networks: [220, 150, 120, 120, 100, 100],
});
const sortState = ref<{ key: string; direction: SortDirection }>({ key: "name", direction: "asc" });
const dangerOpen = ref(false);
const dangerMessage = ref("");
let dangerResolve: ((confirmed: boolean) => void) | undefined;

const createContainerOpen = ref(false);
const createMode = ref<"form" | "compose">("form");
const composeEditingProject = ref("");
const composeDraft = ref({
  projectName: "",
  content: `services:
  app:
    image: nginx:latest
    ports:
      - "8080:80"
`,
});
const pullImageOpen = ref(false);
const createVolumeOpen = ref(false);
const createNetworkOpen = ref(false);
const submitting = ref(false);
const pulling = ref(false);
const pullProgress = ref("");
const createContainerDraft = ref({
  name: "",
  image: "",
  command: "",
  environment: "",
  ports: "",
  mounts: "",
  network: "",
  restartPolicy: "no",
  start: true,
});
const pullDraft = ref({ image: "", serverAddress: "", username: "", password: "" });
const volumeDraft = ref({ name: "", driver: "local", labels: "", driverOptions: "" });
const networkDraft = ref({ name: "", driver: "bridge", internal: false, attachable: false, subnet: "", gateway: "" });

const logText = ref("");
const pendingLogText = ref("");
const logPaused = ref(false);
const logSearch = ref("");
const logStream = ref<DockerStreamHandle>();
const pullStream = ref<DockerStreamHandle>();
const logError = ref("");
const logAutoFollow = ref(true);
const logOutput = ref<HTMLPreElement>();
const filePath = ref("/");
const fileEntries = ref<DockerFileEntry[]>([]);
const filePreview = ref<DockerFilePreview>();
const fileLoading = ref(false);
const fileError = ref("");
let listStatsTimer: number | undefined;
let detailStatsTimer: number | undefined;
let resourceRefreshTimer: number | undefined;

const selectedContainer = computed(() => containers.value.find((container) => container.id === selectedContainerId.value));
const normalizedQuery = computed(() => query.value.trim().toLowerCase());
const isReadOnly = computed(() => !!props.connection.read_only);
const workbenchStyle = computed(() => {
  if (!props.connection.color) return undefined;
  return {
    "--docker-accent": props.connection.color,
    "--docker-accent-soft": hexToRgba(props.connection.color, 0.18),
    "--docker-accent-faint": hexToRgba(props.connection.color, 0.08),
  };
});

function containerName(container: DockerContainer): string {
  return container.labels["com.docker.compose.container-number"] && container.labels["com.docker.compose.service"] ? container.labels["com.docker.compose.service"] : container.names[0]?.replace(/^\//, "") || container.id.slice(0, 12);
}

function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

function isRunning(container: DockerContainer): boolean {
  return container.state.toLowerCase() === "running";
}

function isPaused(container: DockerContainer): boolean {
  return container.state.toLowerCase() === "paused";
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatPorts(container: DockerContainer): string {
  return container.ports.map((port) => `${port.ip || ""}${port.publicPort ? `:${port.publicPort}→` : ""}${port.privatePort}/${port.portType}`).join(", ") || "—";
}

function formatDate(timestamp: number): string {
  return timestamp > 0 ? new Date(timestamp * 1000).toLocaleString() : "—";
}

function toggleSort(key: string) {
  sortState.value = sortState.value.key === key ? { key, direction: sortState.value.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" };
}

function sortedBy<T>(values: T[], getter: (value: T, key: string) => string | number | boolean): T[] {
  const { key, direction } = sortState.value;
  const factor = direction === "asc" ? 1 : -1;
  return [...values].sort((left, right) => {
    const a = getter(left, key);
    const b = getter(right, key);
    if (typeof a === "number" && typeof b === "number") return (a - b) * factor;
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }) * factor;
  });
}

function containerSortValue(container: DockerContainer, key: string): string | number {
  if (key === "name") return containerName(container);
  if (key === "id") return container.id;
  if (key === "image") return container.image;
  if (key === "status") return isRunning(container) ? 2 : isPaused(container) ? 1 : 0;
  if (key === "ports") return formatPorts(container);
  if (key === "cpu") return listStats.value[container.id]?.cpuPercent ?? -1;
  if (key === "memory") return listStats.value[container.id]?.memoryUsage ?? -1;
  return "";
}

async function copyValue(value: string) {
  await copyToClipboard(value);
  toast(t("docker.copied"), 1400);
}

function containerStatusLabel(container: DockerContainer): string {
  if (isRunning(container)) return t("docker.running");
  if (isPaused(container)) return t("docker.paused");
  return t("docker.stopped");
}

const matchingContainers = computed(() =>
  sortedBy(
    containers.value.filter((container) => {
      if (filter.value === "running" && !isRunning(container) && !isPaused(container)) return false;
      if (filter.value === "stopped" && (isRunning(container) || isPaused(container))) return false;
      if (!normalizedQuery.value) return true;
      return [container.id, container.image, container.state, container.status, ...container.names, ...Object.values(container.labels)].join(" ").toLowerCase().includes(normalizedQuery.value);
    }),
    containerSortValue,
  ),
);

const composeGroups = computed(() => {
  const groups = new Map<string, DockerContainer[]>();
  for (const container of matchingContainers.value) {
    const project = container.labels["com.docker.compose.project"];
    if (!project) continue;
    const values = groups.get(project) ?? [];
    values.push(container);
    groups.set(project, values);
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
});

const standaloneContainers = computed(() => matchingContainers.value.filter((container) => !container.labels["com.docker.compose.project"]));

const filteredImages = computed(() =>
  sortedBy(
    images.value.filter((item) => (!normalizedQuery.value ? true : [item.id, ...item.repoTags, ...item.repoDigests].join(" ").toLowerCase().includes(normalizedQuery.value))),
    (item, key) => {
      if (key === "name") return item.repoTags.join(",");
      if (key === "id") return item.id;
      if (key === "size") return item.size;
      if (key === "created") return item.created;
      return "";
    },
  ),
);
const filteredVolumes = computed(() =>
  sortedBy(
    volumes.value.filter((item) => !normalizedQuery.value || [item.name, item.driver, item.mountpoint].join(" ").toLowerCase().includes(normalizedQuery.value)),
    (item, key) => String((item as any)[key] ?? ""),
  ),
);
const filteredNetworks = computed(() =>
  sortedBy(
    networks.value.filter((item) => !normalizedQuery.value || [item.id, item.name, item.driver].join(" ").toLowerCase().includes(normalizedQuery.value)),
    (item, key) => String((item as any)[key] ?? ""),
  ),
);
const visibleLogs = computed(() => {
  if (!logSearch.value.trim()) return logText.value;
  const needle = logSearch.value.toLowerCase();
  return logText.value
    .split("\n")
    .filter((line) => line.toLowerCase().includes(needle))
    .join("\n");
});
const trendLabels = computed(() => trend.value.map((point) => new Date(point.readAt || Date.now()).toLocaleTimeString()));
const cpuSeries = computed(() => [{ name: "CPU", data: trend.value.map((point) => point.cpuPercent), color: "#3b82f6" }]);
const memorySeries = computed(() => [{ name: t("docker.memory"), data: trend.value.map((point) => point.memoryPercent), color: "#8b5cf6" }]);
const engineJson = computed(() => ({ version: engineDetails.value?.version ?? {}, info: engineDetails.value?.info ?? {} }));
const filteredEngineJson = computed(() => {
  const text = JSON.stringify(engineJson.value, null, 2);
  const needle = engineJsonSearch.value.trim().toLowerCase();
  return needle
    ? text
        .split("\n")
        .filter((line) => line.toLowerCase().includes(needle))
        .join("\n")
    : text;
});
const runningTransfers = computed(() => transfers.value.filter((task) => task.status === "running").length);

function tableStyle(kind: ResourceKind) {
  return { minWidth: `${columnWidths.value[kind].reduce((sum, width) => sum + width, 0)}px` };
}

function handleHeaderPointer(event: PointerEvent, kind: ResourceKind) {
  if (event.button !== 0) return;
  const header = (event.target as HTMLElement).closest("th");
  if (!(header instanceof HTMLTableCellElement)) return;
  const bounds = header.getBoundingClientRect();
  if (bounds.right - event.clientX > 8) return;
  const index = header.cellIndex;
  const initialWidth = columnWidths.value[kind][index];
  if (initialWidth == null) return;
  const initialX = event.clientX;
  event.preventDefault();
  event.stopPropagation();
  const move = (moveEvent: PointerEvent) => {
    const next = [...columnWidths.value[kind]];
    next[index] = Math.max(64, initialWidth + moveEvent.clientX - initialX);
    columnWidths.value = { ...columnWidths.value, [kind]: next };
  };
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
}

function upsertTransfer(progress: DockerTransferProgress, handle?: DockerStreamHandle) {
  const index = transfers.value.findIndex((task) => task.sessionId === progress.sessionId);
  if (index >= 0) {
    const next = [...transfers.value];
    next[index] = { ...next[index], ...progress, handle: handle ?? next[index].handle };
    transfers.value = next;
  } else {
    transfers.value = [{ ...progress, startedAt: Date.now(), handle }, ...transfers.value].slice(0, 50);
  }
}

function transferPercent(task: TransferTask): number | undefined {
  if (task.bytesTotal && task.bytesTotal > 0) return Math.min(100, (task.bytesCompleted / task.bytesTotal) * 100);
  if (task.layersTotal && task.layersTotal > 0 && task.layersCompleted != null) {
    return Math.min(100, (task.layersCompleted / task.layersTotal) * 100);
  }
  return undefined;
}

function dockerProgressFromChunk(sessionId: string, kind: "pull" | "push", image: string, chunk: string, done: boolean, error?: string | null): DockerTransferProgress {
  const current = transfers.value.find((task) => task.sessionId === sessionId);
  const state = transferParseStates.get(sessionId) ?? createDockerProgressParseState();
  transferParseStates.set(sessionId, state);
  const result = parseDockerProgressEvent(state, {
    sessionId,
    kind,
    image,
    chunk,
    done,
    error,
    cancelled: cancelledTransferIds.has(sessionId),
    current,
  });
  if (result.status !== "running") {
    transferParseStates.delete(sessionId);
  }
  return result;
}

async function loadEngineInfo() {
  try {
    engineInfo.value = await api.dockerTestConnection(props.connection.id);
  } catch (cause: any) {
    error.value = cause?.message || String(cause);
  }
}

async function loadEngineDetails(target: "json" | "summary") {
  if (target === "json") engineJsonOpen.value = true;
  else engineSummaryOpen.value = true;
  if (engineDetails.value || engineDetailsLoading.value) return;
  engineDetailsLoading.value = true;
  try {
    engineDetails.value = await api.dockerGetEngineDetails(props.connection.id);
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    engineDetailsLoading.value = false;
  }
}

async function loadContainers() {
  containers.value = await api.dockerListContainers(props.connection.id, true);
  for (const [project] of composeGroups.value) expandedProjects.value.add(project);
}

async function loadResource(kind = resource.value) {
  if (refreshInFlight.value) return;
  refreshInFlight.value = true;
  loading.value = true;
  error.value = "";
  try {
    if (kind === "containers") await loadContainers();
    if (kind === "images") images.value = await api.dockerListImages(props.connection.id);
    if (kind === "volumes") volumes.value = await api.dockerListVolumes(props.connection.id);
    if (kind === "networks") networks.value = await api.dockerListNetworks(props.connection.id);
    if (kind === "containers") {
      lastRefreshAt.value = new Date();
      refreshCountdown.value = 10;
    }
  } catch (cause: any) {
    error.value = cause?.message || String(cause);
  } finally {
    loading.value = false;
    refreshInFlight.value = false;
  }
}

async function selectResource(kind: ResourceKind) {
  await closeDetail();
  resource.value = kind;
  query.value = "";
  sortState.value = { key: "name", direction: "asc" };
  await loadResource(kind);
}

function toggleProject(project: string) {
  const next = new Set(expandedProjects.value);
  if (next.has(project)) next.delete(project);
  else next.add(project);
  expandedProjects.value = next;
}

async function openDetail(container: DockerContainer) {
  selectedContainerId.value = container.id;
  detailTab.value = "overview";
  inspect.value = (await api.dockerInspectContainer(props.connection.id, container.id)) as Record<string, any>;
  trend.value = [];
  restartDetailSampling();
}

async function closeDetail() {
  stopDetailSampling();
  await stopLogs();
  selectedContainerId.value = "";
  inspect.value = {};
  fileEntries.value = [];
  filePreview.value = undefined;
}

function requestConfirmation(message: string): Promise<boolean> {
  dangerMessage.value = message;
  dangerOpen.value = true;
  return new Promise((resolve) => {
    dangerResolve = resolve;
  });
}

function settleConfirmation(confirmed: boolean) {
  const resolve = dangerResolve;
  dangerResolve = undefined;
  dangerOpen.value = false;
  resolve?.(confirmed);
}

async function confirmAction(container: DockerContainer, action: DockerContainerAction | "remove"): Promise<boolean> {
  const dangerous = props.connection.is_production || ["stop", "restart", "remove"].includes(action);
  if (!dangerous) return true;
  return requestConfirmation(t("docker.confirmAction", { action: t(`docker.action.${action}`), name: containerName(container) }));
}

async function confirmProductionMutation(action: string): Promise<boolean> {
  return !props.connection.is_production || requestConfirmation(t("docker.confirmProductionMutation", { action }));
}

async function runAction(container: DockerContainer, action: DockerContainerAction) {
  if (isReadOnly.value || actionInFlight.value[container.id]) {
    if (isReadOnly.value) toast(t("docker.readOnly"), 2400);
    return;
  }
  if (!(await confirmAction(container, action))) return;
  actionInFlight.value = { ...actionInFlight.value, [container.id]: action };
  try {
    await api.dockerContainerAction(props.connection.id, container.id, action);
    toast(t("docker.actionSucceeded", { action: t(`docker.action.${action}`), name: containerName(container) }), 2400);
    await loadContainers();
    lastRefreshAt.value = new Date();
    if (selectedContainerId.value === container.id) {
      inspect.value = (await api.dockerInspectContainer(props.connection.id, container.id)) as Record<string, any>;
    }
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    actionInFlight.value = { ...actionInFlight.value, [container.id]: undefined };
  }
}

async function removeContainer(container: DockerContainer) {
  if (isReadOnly.value || actionInFlight.value[container.id]) return;
  if (!(await confirmAction(container, "remove"))) return;
  actionInFlight.value = { ...actionInFlight.value, [container.id]: "remove" };
  try {
    await api.dockerRemoveContainer(props.connection.id, container.id);
    toast(t("docker.containerRemoved", { name: containerName(container) }), 2400);
    await loadContainers();
    lastRefreshAt.value = new Date();
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    actionInFlight.value = { ...actionInFlight.value, [container.id]: undefined };
  }
}

function parseKeyValues(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index < 0 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      }),
  );
}

function createContainerRequest(): DockerCreateContainerRequest {
  const ports = createContainerDraft.value.ports
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [mapping, protocol = "tcp"] = line.split("/");
      const parts = mapping.split(":");
      const containerPort = Number(parts.pop());
      const hostPortText = parts.pop();
      const hostIp = parts.join(":");
      return {
        containerPort,
        protocol: protocol.toLowerCase() === "udp" ? ("udp" as const) : ("tcp" as const),
        hostIp,
        hostPort: hostPortText ? Number(hostPortText) : undefined,
      };
    });
  const mounts = createContainerDraft.value.mounts
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(":");
      const readOnly = parts[parts.length - 1] === "ro";
      if (readOnly) parts.pop();
      const source = parts.shift() || "";
      const target = parts.join(":");
      return { type: source.startsWith("/") || /^[A-Za-z]:[\\/]/.test(source) ? ("bind" as const) : ("volume" as const), source, target, readOnly };
    });
  return {
    name: createContainerDraft.value.name.trim(),
    image: createContainerDraft.value.image.trim(),
    command: createContainerDraft.value.command
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    environment: createContainerDraft.value.environment
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
    ports,
    mounts,
    labels: {},
    network: createContainerDraft.value.network || undefined,
    restartPolicy: createContainerDraft.value.restartPolicy as DockerCreateContainerRequest["restartPolicy"],
    start: createContainerDraft.value.start,
  };
}

async function createContainer() {
  if (!(await confirmProductionMutation(t("docker.createContainer")))) return;
  submitting.value = true;
  try {
    await api.dockerCreateContainer(props.connection.id, createContainerRequest());
    createContainerOpen.value = false;
    toast(t("docker.containerCreated"), 2400);
    await loadContainers();
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    submitting.value = false;
  }
}

async function openCreateContainer() {
  if (!networks.value.length) {
    try {
      networks.value = await api.dockerListNetworks(props.connection.id);
    } catch {
      // The form remains usable with Docker's default network.
    }
  }
  createMode.value = "form";
  composeEditingProject.value = "";
  createContainerOpen.value = true;
}

function composePortLines(value: any): string[] {
  const bindings = value?.HostConfig?.PortBindings ?? {};
  return Object.entries(bindings).flatMap(([containerPort, entries]: [string, any]) => {
    const [port, protocol = "tcp"] = containerPort.split("/");
    if (!Array.isArray(entries) || !entries.length) return [`${port}/${protocol}`];
    return entries.map((entry) => {
      const host = [entry.HostIp, entry.HostPort].filter(Boolean).join(":");
      return `${host ? `${host}:` : ""}${port}/${protocol}`;
    });
  });
}

async function openComposeEditor(project = "") {
  createMode.value = "compose";
  composeEditingProject.value = project;
  composeDraft.value.projectName = project;
  if (project) {
    const projectContainers = containers.value.filter((container) => container.labels["com.docker.compose.project"] === project);
    const services: Record<string, any> = {};
    for (const container of projectContainers) {
      const value: any = await api.dockerInspectContainer(props.connection.id, container.id);
      const service = container.labels["com.docker.compose.service"] || containerName(container);
      const mounts = (value.Mounts ?? []).map((mount: any) => `${mount.Name || mount.Source}:${mount.Destination}${mount.RW === false ? ":ro" : ""}`);
      const networkNames = Object.keys(value.NetworkSettings?.Networks ?? {}).map((name) => (name.startsWith(`${project}_`) ? name.slice(project.length + 1) : name));
      services[service] = {
        image: value.Config?.Image || container.image,
        container_name: value.Name?.replace(/^\//, "") || containerName(container),
        ...(value.Config?.Cmd?.length ? { command: value.Config.Cmd } : {}),
        ...(value.Config?.Env?.length ? { environment: value.Config.Env } : {}),
        ...(composePortLines(value).length ? { ports: composePortLines(value) } : {}),
        ...(mounts.length ? { volumes: mounts } : {}),
        ...(networkNames.length ? { networks: networkNames } : {}),
        ...(value.HostConfig?.RestartPolicy?.Name && value.HostConfig.RestartPolicy.Name !== "no" ? { restart: value.HostConfig.RestartPolicy.Name } : {}),
      };
    }
    composeDraft.value.content = JSON.stringify({ services }, null, 2);
  } else {
    composeDraft.value = {
      projectName: "",
      content: `services:
  app:
    image: nginx:latest
    ports:
      - "8080:80"
`,
    };
  }
  createContainerOpen.value = true;
}

async function applyCompose() {
  const editing = !!composeEditingProject.value;
  if (!(await confirmProductionMutation(editing ? t("docker.editCompose") : t("docker.createCompose")))) return;
  if (editing && !(await requestConfirmation(t("docker.confirmComposeReplace", { project: composeEditingProject.value })))) return;
  submitting.value = true;
  try {
    const request: DockerComposeApplyRequest = {
      projectName: composeDraft.value.projectName.trim(),
      content: composeDraft.value.content,
      replaceExisting: editing,
    };
    const result = await api.dockerApplyCompose(props.connection.id, request);
    createContainerOpen.value = false;
    toast(t(editing ? "docker.composeUpdated" : "docker.composeCreated", { count: result.containerIds.length }), 3000);
    if (result.warnings.length) toast(result.warnings.join("\n"), 5000);
    await loadContainers();
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    submitting.value = false;
  }
}

async function pullImage() {
  if (pulling.value) return;
  if (!(await confirmProductionMutation(t("docker.pullImage")))) return;
  if (pulling.value) return;
  const imageReference = pullDraft.value.image.trim();
  if (!imageReference) return;
  const auth: DockerRegistryAuth | undefined =
    pullDraft.value.serverAddress || pullDraft.value.username || pullDraft.value.password
      ? {
          serverAddress: pullDraft.value.serverAddress,
          username: pullDraft.value.username,
          password: pullDraft.value.password,
        }
      : undefined;
  const pending = createPendingDockerPullTask(imageReference);
  pulling.value = true;
  pullProgress.value = "";
  transferOpen.value = true;
  pullImageOpen.value = false;
  pullStream.value = pending.handle;
  upsertTransfer(pending.progress, pending.handle);
  pullDraft.value.password = "";
  try {
    let startedStream: DockerStreamHandle | undefined = pending.handle;
    const stream = await api.dockerPullImage(
      props.connection.id,
      imageReference,
      auth,
      (event) => {
        if (event.chunk) pullProgress.value = `${pullProgress.value}${event.chunk}`.slice(-20_000);
        const previous = transfers.value.find((task) => task.sessionId === event.sessionId);
        const progress = dockerProgressFromChunk(event.sessionId, "pull", imageReference, event.chunk, event.done, event.error);
        upsertTransfer(progress, startedStream);
        if (progress.status === "error") {
          if (previous?.status !== "error") toast(progress.error || t("docker.transferFailed"), 5000);
          pulling.value = false;
          pullStream.value = undefined;
          resetPullDraft();
        }
        if (event.done && progress.status === "done") {
          pulling.value = false;
          pullStream.value = undefined;
          if (cancelledTransferIds.has(event.sessionId)) return;
          toast(t("docker.imagePulled"), 2400);
          resetPullDraft();
          void loadResource("images");
        }
      },
      pending.options,
    );
    startedStream = stream;
    if (pulling.value) {
      pullStream.value = stream;
      const current = transfers.value.find((task) => task.sessionId === stream.sessionId);
      if (current) upsertTransfer(current, stream);
    } else await stream.stop().catch(() => undefined);
  } catch (cause: any) {
    pulling.value = false;
    pullStream.value = undefined;
    if (cancelledTransferIds.has(pending.progress.sessionId)) return;
    const message = cause?.message || String(cause);
    upsertTransfer({ ...pending.progress, status: "error", error: message }, pending.handle);
    resetPullDraft();
    toast(message, 5000);
  }
}

function resetPullDraft() {
  pullDraft.value = { image: "", serverAddress: "", username: "", password: "" };
  pullProgress.value = "";
}

async function stopImagePull() {
  const stream = pullStream.value;
  pullStream.value = undefined;
  pulling.value = false;
  if (stream) await stream.stop().catch(() => undefined);
}

function downloadBytes(bytes: Uint8Array | string, fileName: string, type = "application/octet-stream") {
  const blob = new Blob([typeof bytes === "string" ? bytes : bytes.slice().buffer], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function exportImage(item: DockerImage) {
  if (imageActionInFlight.value[item.id]) return;
  imageActionInFlight.value = { ...imageActionInFlight.value, [item.id]: "export" };
  transferOpen.value = true;
  try {
    const taggedReference = item.repoTags.find((tag) => tag && tag !== "<none>:<none>");
    const exportReference = taggedReference || item.id;
    const baseName = (taggedReference || shortId(item.id)).replace(/[\\/:*?"<>|]+/g, "_");
    const fileName = `${baseName}.tar`;
    let destination: string | undefined;
    if (isTauriRuntime()) {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const selectedDestination = await save({
        defaultPath: fileName,
        filters: [{ name: "Docker image", extensions: ["tar"] }],
      });
      if (!selectedDestination) {
        imageActionInFlight.value = { ...imageActionInFlight.value, [item.id]: undefined };
        return;
      }
      destination = selectedDestination;
    }
    let startedStream: DockerStreamHandle | undefined;
    const stream = await api.dockerStartImageExport(props.connection.id, exportReference, fileName, destination, (progress) => {
      upsertTransfer(progress, startedStream);
      if (progress.status === "done") {
        imageActionInFlight.value = { ...imageActionInFlight.value, [item.id]: undefined };
        toast(t("docker.imageExported"), 2400);
      }
      if (progress.status === "error" || progress.status === "cancelled") {
        imageActionInFlight.value = { ...imageActionInFlight.value, [item.id]: undefined };
        if (progress.status === "error") toast(progress.error || t("docker.transferFailed"), 5000);
      }
    });
    startedStream = stream;
    const task = transfers.value.find((value) => value.sessionId === stream.sessionId);
    if (task) upsertTransfer(task, stream);
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
    imageActionInFlight.value = { ...imageActionInFlight.value, [item.id]: undefined };
  }
}

function openPushImage(item: DockerImage) {
  pushDraft.value = {
    sourceImageId: item.id,
    targetReference: item.repoTags[0] && item.repoTags[0] !== "<none>:<none>" ? item.repoTags[0] : "",
    serverAddress: "",
    username: "",
    password: "",
  };
  pushImageOpen.value = true;
}

async function pushImage() {
  if (!(await confirmProductionMutation(t("docker.pushImage")))) return;
  const targetReference = pushDraft.value.targetReference.trim();
  if (!targetReference) return;
  transferOpen.value = true;
  pushImageOpen.value = false;
  const auth: DockerRegistryAuth | undefined =
    pushDraft.value.serverAddress || pushDraft.value.username || pushDraft.value.password
      ? {
          serverAddress: pushDraft.value.serverAddress,
          username: pushDraft.value.username,
          password: pushDraft.value.password,
        }
      : undefined;
  pushDraft.value.password = "";
  try {
    let startedStream: DockerStreamHandle | undefined;
    const stream = await api.dockerPushImage(props.connection.id, pushDraft.value.sourceImageId, targetReference, auth, (progress) => {
      upsertTransfer(progress, startedStream);
      if (progress.status === "done") {
        toast(t("docker.imagePushed"), 2400);
        void loadResource("images");
      } else if (progress.status === "error") {
        toast(progress.error || t("docker.transferFailed"), 5000);
      }
    });
    startedStream = stream;
    const task = transfers.value.find((value) => value.sessionId === stream.sessionId);
    if (task) upsertTransfer(task, stream);
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  }
}

async function cancelTransfer(task: TransferTask) {
  cancelledTransferIds.add(task.sessionId);
  await task.handle?.stop().catch(() => undefined);
  upsertTransfer({ ...task, status: "cancelled" });
  if (task.kind === "pull") {
    pulling.value = false;
    pullStream.value = undefined;
  }
}

async function cancelActiveTransfers() {
  await Promise.all(transfers.value.filter((task) => task.status === "running").map(cancelTransfer));
}

async function removeImage(item: DockerImage) {
  if (imageActionInFlight.value[item.id]) return;
  if (!(await requestConfirmation(t("docker.confirmImageRemove", { name: item.repoTags[0] || shortId(item.id) })))) return;
  imageActionInFlight.value = { ...imageActionInFlight.value, [item.id]: "remove" };
  try {
    await api.dockerRemoveImage(props.connection.id, item.id);
    toast(t("docker.imageRemoved"), 2400);
    await loadResource("images");
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    imageActionInFlight.value = { ...imageActionInFlight.value, [item.id]: undefined };
  }
}

async function createVolume() {
  if (!(await confirmProductionMutation(t("docker.createVolume")))) return;
  submitting.value = true;
  try {
    const request: DockerCreateVolumeRequest = {
      name: volumeDraft.value.name,
      driver: volumeDraft.value.driver || "local",
      labels: parseKeyValues(volumeDraft.value.labels),
      driverOptions: parseKeyValues(volumeDraft.value.driverOptions),
    };
    await api.dockerCreateVolume(props.connection.id, request);
    createVolumeOpen.value = false;
    toast(t("docker.volumeCreated"), 2400);
    await loadResource("volumes");
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    submitting.value = false;
  }
}

async function createNetwork() {
  if (!(await confirmProductionMutation(t("docker.createNetwork")))) return;
  submitting.value = true;
  try {
    const request: DockerCreateNetworkRequest = {
      name: networkDraft.value.name,
      driver: networkDraft.value.driver || "bridge",
      internal: networkDraft.value.internal,
      attachable: networkDraft.value.attachable,
      subnet: networkDraft.value.subnet || undefined,
      gateway: networkDraft.value.gateway || undefined,
    };
    await api.dockerCreateNetwork(props.connection.id, request);
    createNetworkOpen.value = false;
    toast(t("docker.networkCreated"), 2400);
    await loadResource("networks");
  } catch (cause: any) {
    toast(cause?.message || String(cause), 5000);
  } finally {
    submitting.value = false;
  }
}

function appendLogs(chunk: string) {
  if (logPaused.value) {
    pendingLogText.value += chunk;
    if (pendingLogText.value.length > 5 * 1024 * 1024) pendingLogText.value = pendingLogText.value.slice(-5 * 1024 * 1024);
    return;
  }
  logText.value += chunk;
  const lines = logText.value.split("\n");
  if (lines.length > 10_000) logText.value = lines.slice(-10_000).join("\n");
  if (logText.value.length > 5 * 1024 * 1024) logText.value = logText.value.slice(-5 * 1024 * 1024);
  if (logAutoFollow.value) void nextTick(scrollLogsToBottom);
}

function scrollLogsToBottom() {
  const output = logOutput.value;
  if (output) output.scrollTop = output.scrollHeight;
}

function handleLogScroll() {
  const output = logOutput.value;
  if (!output) return;
  logAutoFollow.value = output.scrollHeight - output.scrollTop - output.clientHeight < 24;
}

async function startLogs() {
  if (!selectedContainer.value || logStream.value) return;
  logError.value = "";
  logAutoFollow.value = true;
  try {
    logStream.value = await api.dockerStartLogs(props.connection.id, selectedContainer.value.id, { tail: 500, timestamps: false }, (event) => {
      if (event.chunk) appendLogs(event.chunk);
      if (event.error) logError.value = event.error;
      if (event.done) logStream.value = undefined;
    });
  } catch (cause: any) {
    logError.value = cause?.message || String(cause);
  }
}

async function stopLogs() {
  const stream = logStream.value;
  logStream.value = undefined;
  if (stream) await stream.stop().catch(() => undefined);
}

function toggleLogPause() {
  logPaused.value = !logPaused.value;
  if (!logPaused.value && pendingLogText.value) {
    const pending = pendingLogText.value;
    pendingLogText.value = "";
    appendLogs(pending);
  }
}

function clearLogs() {
  logText.value = "";
  pendingLogText.value = "";
  if (logAutoFollow.value) void nextTick(scrollLogsToBottom);
}

async function loadFiles(path = filePath.value) {
  if (!selectedContainer.value) return;
  fileLoading.value = true;
  fileError.value = "";
  filePreview.value = undefined;
  try {
    filePath.value = path;
    fileEntries.value = await api.dockerListContainerFiles(props.connection.id, selectedContainer.value.id, path);
  } catch (cause: any) {
    fileError.value = cause?.message || String(cause);
  } finally {
    fileLoading.value = false;
  }
}

function parentPath(path: string): string {
  if (path === "/") return "/";
  const result = path.replace(/\/+$/, "").replace(/\/[^/]+$/, "");
  return result || "/";
}

async function openFile(entry: DockerFileEntry) {
  if (!selectedContainer.value) return;
  if (entry.kind === "directory") {
    await loadFiles(entry.path);
    return;
  }
  fileLoading.value = true;
  try {
    filePreview.value = await api.dockerPreviewContainerFile(props.connection.id, selectedContainer.value.id, entry.path);
  } catch (cause: any) {
    fileError.value = cause?.message || String(cause);
  } finally {
    fileLoading.value = false;
  }
}

async function sampleVisibleContainers() {
  if (document.hidden || resource.value !== "containers" || selectedContainer.value) return;
  const ids = matchingContainers.value.filter(isRunning).map((container) => container.id);
  if (!ids.length) {
    listStats.value = {};
    return;
  }
  try {
    const stats = await api.dockerContainerStats(props.connection.id, ids);
    listStats.value = Object.fromEntries(stats.map((value) => [value.containerId, value]));
  } catch {
    // The resource refresh continues to provide state if metrics are unavailable.
  }
}

async function sampleSelectedContainer() {
  const container = selectedContainer.value;
  if (!container || !isRunning(container) || document.hidden || detailTab.value !== "monitoring") return;
  try {
    const [point] = await api.dockerContainerStats(props.connection.id, [container.id]);
    if (!point) return;
    const cutoff = Date.now() - 15 * 60 * 1000;
    trend.value = [...trend.value, point].filter((value) => new Date(value.readAt || Date.now()).getTime() >= cutoff);
  } catch {
    // Keep the last successful samples visible.
  }
}

function restartListSampling() {
  if (listStatsTimer) window.clearInterval(listStatsTimer);
  listStatsTimer = window.setInterval(() => void sampleVisibleContainers(), 5000);
  void sampleVisibleContainers();
}

function restartResourceRefresh() {
  if (resourceRefreshTimer) window.clearInterval(resourceRefreshTimer);
  resourceRefreshTimer = undefined;
  refreshCountdown.value = 10;
  if (!autoRefresh.value) return;
  resourceRefreshTimer = window.setInterval(() => {
    const active = autoRefresh.value && !document.hidden && resource.value === "containers" && !selectedContainer.value;
    if (!active) {
      refreshCountdown.value = 10;
      return;
    }
    if (refreshInFlight.value) return;
    refreshCountdown.value -= 1;
    if (refreshCountdown.value <= 0) {
      refreshCountdown.value = 10;
      void loadResource("containers");
    }
  }, 1000);
}

function handleVisibilityChange() {
  restartDetailSampling();
  restartResourceRefresh();
}

function stopDetailSampling() {
  if (detailStatsTimer) window.clearInterval(detailStatsTimer);
  detailStatsTimer = undefined;
}

function restartDetailSampling() {
  stopDetailSampling();
  detailStatsTimer = window.setInterval(() => void sampleSelectedContainer(), 2000);
  void sampleSelectedContainer();
}

watch(detailTab, async (tab) => {
  if (tab === "logs") await startLogs();
  else await stopLogs();
  if (tab === "files" && !fileEntries.value.length) await loadFiles("/");
  restartDetailSampling();
});

watch(resource, () => {
  restartListSampling();
  restartResourceRefresh();
});
watch(autoRefresh, restartResourceRefresh);
watch(selectedContainerId, restartResourceRefresh);
watch(pullImageOpen, (open) => {
  if (!open) pullProgress.value = "";
});
watch(dangerOpen, (open) => {
  if (!open && dangerResolve) settleConfirmation(false);
});

onMounted(async () => {
  document.addEventListener("visibilitychange", handleVisibilityChange);
  await Promise.all([loadEngineInfo(), loadResource("containers")]);
  restartListSampling();
  restartResourceRefresh();
});

onUnmounted(() => {
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  if (listStatsTimer) window.clearInterval(listStatsTimer);
  if (resourceRefreshTimer) window.clearInterval(resourceRefreshTimer);
  stopDetailSampling();
  void stopLogs();
  void stopImagePull();
  void cancelActiveTransfers();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background text-foreground" :style="workbenchStyle">
    <header class="docker-header">
      <nav class="flex h-full items-end gap-0.5">
        <button v-for="kind in ['containers', 'images', 'volumes', 'networks'] as ResourceKind[]" :key="kind" class="docker-main-tab" :class="{ active: resource === kind }" @click="selectResource(kind)">
          {{ t(`docker.${kind}`) }}
        </button>
      </nav>
      <div class="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger as-child
            ><Button variant="ghost" size="icon" class="h-6 w-6 text-cyan-600 hover:bg-cyan-500/10 hover:text-cyan-700 dark:text-cyan-300 dark:hover:text-cyan-200" @click="loadEngineDetails('json')"><Settings class="h-3.5 w-3.5" /></Button
          ></TooltipTrigger>
          <TooltipContent>{{ t("docker.engineJson") }}</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger as-child
            ><Button variant="ghost" size="icon" class="h-6 w-6 text-amber-600 hover:bg-amber-500/10 hover:text-amber-700 dark:text-amber-300 dark:hover:text-amber-200" @click="loadEngineDetails('summary')"><CircleHelp class="h-3.5 w-3.5" /></Button
          ></TooltipTrigger>
          <TooltipContent>{{ t("docker.engineInformation") }}</TooltipContent>
        </Tooltip>
        <Popover v-model:open="transferOpen">
          <LightTooltip :text="t('docker.transfers')">
            <PopoverTrigger as-child>
              <Button variant="ghost" size="icon" class="relative h-6 w-6 text-blue-600 hover:bg-blue-500/10 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-200">
                <ListChecks class="h-3.5 w-3.5" />
                <span v-if="runningTransfers" class="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-primary" />
              </Button>
            </PopoverTrigger>
          </LightTooltip>
          <PopoverContent align="end" class="w-80 p-2">
            <div class="mb-2 px-1 text-xs font-semibold">{{ t("docker.transfers") }}</div>
            <div v-if="!transfers.length" class="px-2 py-8 text-center text-xs text-muted-foreground">{{ t("docker.noTransfers") }}</div>
            <div v-else class="max-h-72 space-y-1 overflow-auto">
              <div v-for="task in transfers" :key="task.sessionId" class="rounded border p-2">
                <div class="flex items-center gap-2">
                  <FileUp v-if="task.direction === 'upload'" class="h-3.5 w-3.5 shrink-0 text-teal-600 dark:text-teal-300" />
                  <FileDown v-else class="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-300" />
                  <span class="min-w-0 flex-1 truncate text-xs">{{ task.image }}</span>
                  <span class="rounded bg-muted px-1.5 py-0.5 text-[9px] text-muted-foreground">{{ task.direction === "upload" ? t("docker.upload") : t("docker.download") }}</span>
                  <span class="text-[10px] text-muted-foreground">{{ transferPercent(task) == null ? "—" : `${Math.round(transferPercent(task)!)}%` }}</span>
                  <Button v-if="task.status === 'running'" size="icon-xs" variant="ghost" @click="cancelTransfer(task)"><X class="h-3 w-3" /></Button>
                </div>
                <div class="mt-1.5 h-1 overflow-hidden rounded bg-muted">
                  <div v-if="transferPercent(task) != null" class="h-full bg-primary transition-[width]" :style="{ width: `${transferPercent(task)}%` }" />
                  <div v-else-if="task.status === 'running'" class="docker-indeterminate h-full w-1/3 bg-primary" />
                </div>
                <div class="mt-1 grid grid-cols-[minmax(64px,1fr)_auto] items-center gap-2 text-[10px] text-muted-foreground">
                  <span class="truncate">{{ t(`docker.transferStatus.${task.status}`) }}</span>
                  <span class="whitespace-nowrap text-right tabular-nums"
                    >{{ formatBytes(task.bytesCompleted) }}<template v-if="task.bytesTotal"> / {{ formatBytes(task.bytesTotal) }}</template></span
                  >
                </div>
                <div v-if="task.error" class="mt-1 break-words text-[10px] text-destructive">{{ task.error }}</div>
              </div>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    </header>

    <div v-if="error" class="m-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{{ error }}</div>

    <main v-else class="flex min-h-0 flex-1 flex-col">
      <template v-if="selectedContainer">
        <div class="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          <Button size="sm" variant="ghost" @click="closeDetail"><ArrowLeft />{{ t("docker.backToContainers") }}</Button>
          <span class="h-5 w-px bg-border" />
          <div class="min-w-0">
            <div class="truncate text-sm font-semibold">{{ containerName(selectedContainer) }}</div>
            <div class="font-mono text-[10px] text-muted-foreground">{{ shortId(selectedContainer.id) }}</div>
          </div>
        </div>
        <div class="flex shrink-0 border-b px-4">
          <button v-for="tab in ['overview', 'logs', 'monitoring', 'files'] as DetailTab[]" :key="tab" class="docker-detail-tab" :class="{ active: detailTab === tab }" @click="detailTab = tab">
            {{ t(`docker.detail.${tab}`) }}
          </button>
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-4">
          <div v-if="detailTab === 'overview'" class="space-y-4">
            <section class="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div class="docker-card">
                <span>{{ t("docker.fullId") }}</span
                ><strong class="break-all font-mono text-xs">{{ selectedContainer.id }}</strong>
              </div>
              <div class="docker-card">
                <span>{{ t("docker.image") }}</span
                ><strong>{{ selectedContainer.image }}</strong
                ><small class="break-all font-mono">{{ selectedContainer.imageId }}</small>
              </div>
              <div class="docker-card">
                <span>{{ t("docker.status") }}</span
                ><strong>{{ selectedContainer.state }}</strong
                ><small>{{ selectedContainer.status }}</small>
              </div>
              <div class="docker-card">
                <span>{{ t("docker.health") }}</span
                ><strong>{{ inspect.State?.Health?.Status || "—" }}</strong>
              </div>
              <div class="docker-card">
                <span>{{ t("docker.command") }}</span
                ><strong class="font-mono text-xs">{{ [inspect.Path, ...(inspect.Args || [])].filter(Boolean).join(" ") || selectedContainer.command }}</strong>
              </div>
              <div class="docker-card">
                <span>{{ t("docker.created") }}</span
                ><strong>{{ formatDate(selectedContainer.created) }}</strong>
              </div>
            </section>
            <section>
              <h3 class="mb-2 text-sm font-semibold">{{ t("docker.environment") }}</h3>
              <pre class="docker-code">{{ (inspect.Config?.Env || []).join("\n") || "—" }}</pre>
            </section>
            <section>
              <h3 class="mb-2 text-sm font-semibold">{{ t("docker.mounts") }}</h3>
              <div class="space-y-1">
                <div v-for="mount in inspect.Mounts || []" :key="`${mount.Source}-${mount.Destination}`" class="docker-row-value">
                  {{ mount.Source }} → {{ mount.Destination }} <span class="text-muted-foreground">({{ mount.Mode || mount.Type }})</span>
                </div>
                <div v-if="!inspect.Mounts?.length" class="docker-row-value">—</div>
              </div>
            </section>
            <section>
              <h3 class="mb-2 text-sm font-semibold">{{ t("docker.networks") }}</h3>
              <div class="space-y-1">
                <div v-for="(network, name) in inspect.NetworkSettings?.Networks || {}" :key="String(name)" class="docker-row-value">{{ name }} · {{ network.IPAddress || "—" }}</div>
              </div>
            </section>
          </div>

          <div v-else-if="detailTab === 'logs'" class="flex h-full min-h-[28rem] flex-col">
            <div class="mb-2 flex items-center gap-2">
              <div class="relative w-72">
                <Search class="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input v-model="logSearch" class="pl-8" :placeholder="t('docker.searchLogs')" />
              </div>
              <Button size="sm" variant="outline" @click="toggleLogPause"><Play v-if="logPaused" /><Pause v-else />{{ logPaused ? t("docker.resume") : t("docker.pause") }}</Button>
              <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="logAutoFollow" type="checkbox" @change="logAutoFollow && scrollLogsToBottom()" />{{ t("docker.autoFollowLogs") }}</label>
              <Button size="sm" variant="outline" @click="clearLogs">{{ t("docker.clear") }}</Button>
              <Button size="sm" variant="outline" @click="downloadBytes(logText, `${containerName(selectedContainer)}.log`, 'text/plain;charset=utf-8')"><Download />{{ t("docker.download") }}</Button>
              <span v-if="pendingLogText" class="text-xs text-amber-600">{{ t("docker.bufferedLogs") }}</span>
            </div>
            <div v-if="logError" class="mb-2 text-sm text-destructive">{{ logError }}</div>
            <pre ref="logOutput" class="min-h-0 flex-1 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-5 text-zinc-100" @scroll.passive="handleLogScroll">{{ visibleLogs || t("docker.waitingForLogs") }}</pre>
          </div>

          <div v-else-if="detailTab === 'monitoring'" class="grid gap-3 xl:grid-cols-2">
            <MetricLineChart title="CPU %" :labels="trendLabels" :series="cpuSeries" :height="240" :value-formatter="(value) => `${value.toFixed(1)}%`" />
            <MetricLineChart :title="`${t('docker.memory')} %`" :labels="trendLabels" :series="memorySeries" :height="240" :value-formatter="(value) => `${value.toFixed(1)}%`" />
          </div>

          <div v-else class="grid h-full min-h-[28rem] grid-cols-[minmax(20rem,36%)_1fr] overflow-hidden rounded-md border">
            <div class="flex min-h-0 flex-col border-r">
              <div class="flex items-center gap-2 border-b p-2">
                <Button size="sm" variant="ghost" :disabled="filePath === '/'" @click="loadFiles(parentPath(filePath))"><ArrowLeft /></Button>
                <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ filePath }}</span>
                <Button size="sm" variant="ghost" :disabled="fileLoading" @click="loadFiles()"><RefreshCw :class="{ 'animate-spin': fileLoading }" /></Button>
              </div>
              <div v-if="fileError" class="p-3 text-sm text-destructive">{{ fileError }}</div>
              <div v-else class="min-h-0 flex-1 overflow-auto">
                <button v-for="entry in fileEntries" :key="entry.path" class="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted/50" @dblclick="openFile(entry)">
                  <Folder v-if="entry.kind === 'directory'" class="h-4 w-4 text-amber-500" />
                  <File v-else class="h-4 w-4 text-sky-500" />
                  <span class="min-w-0 flex-1 truncate">{{ entry.name }}</span>
                  <span class="text-xs tabular-nums text-muted-foreground">{{ entry.kind === "directory" ? "" : formatBytes(entry.size) }}</span>
                </button>
              </div>
            </div>
            <div class="min-h-0 overflow-auto bg-muted/10 p-3">
              <div v-if="filePreview?.binary" class="text-sm text-muted-foreground">{{ t("docker.binaryPreviewUnsupported") }}</div>
              <pre v-else-if="filePreview" class="whitespace-pre-wrap break-all font-mono text-xs">{{ filePreview.content }}<template v-if="filePreview.truncated">…</template></pre>
              <div v-else class="flex h-full items-center justify-center text-sm text-muted-foreground">{{ t("docker.selectFile") }}</div>
            </div>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="flex h-14 shrink-0 items-center gap-2 border-b px-4">
          <div class="relative w-72">
            <Search class="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="query" class="pl-8" :placeholder="t('docker.search')" />
          </div>
          <template v-if="resource === 'containers'">
            <Button :disabled="isReadOnly" @click="openCreateContainer"><Plus />{{ t("docker.createContainer") }}</Button>
            <div class="ml-2 flex rounded-md border bg-muted/20 p-0.5">
              <button v-for="value in ['all', 'running', 'stopped'] as ContainerFilter[]" :key="value" class="rounded px-3 py-1.5 text-xs" :class="filter === value ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'" @click="filter = value">
                {{ t(`docker.filter.${value}`) }}
              </button>
            </div>
          </template>
          <template v-else-if="resource === 'images'">
            <Button :disabled="isReadOnly" @click="pullImageOpen = true"><Download />{{ t("docker.pullImage") }}</Button>
          </template>
          <Button v-else-if="resource === 'volumes'" :disabled="isReadOnly" @click="createVolumeOpen = true"><Plus />{{ t("docker.createVolume") }}</Button>
          <Button v-else :disabled="isReadOnly" @click="createNetworkOpen = true"><Plus />{{ t("docker.createNetwork") }}</Button>
          <template v-if="resource === 'containers'">
            <span class="ml-auto text-[11px] text-muted-foreground">{{ t("docker.lastRefreshed") }}: {{ lastRefreshAt?.toLocaleTimeString() || "—" }}</span>
            <label class="flex items-center gap-2 text-xs text-muted-foreground"><Switch v-model="autoRefresh" />{{ t("docker.autoRefresh", { seconds: refreshCountdown }) }}</label>
          </template>
          <Button :class="{ 'ml-auto': resource !== 'containers' }" variant="ghost" :disabled="loading" @click="loadResource()"><RefreshCw :class="{ 'animate-spin': loading }" />{{ t("docker.refresh") }}</Button>
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <table v-if="resource === 'containers'" class="docker-table" :style="tableStyle('containers')">
            <colgroup>
              <col v-for="(width, index) in columnWidths.containers" :key="index" :style="{ width: `${width}px` }" />
            </colgroup>
            <thead @pointerdown="handleHeaderPointer($event, 'containers')">
              <tr>
                <th>
                  <button class="docker-sort" @click="toggleSort('name')">{{ t("docker.name") }}<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('id')">ID<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('image')">{{ t("docker.image") }}<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('ports')">{{ t("docker.ports") }}<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('cpu')">CPU<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('memory')">{{ t("docker.memory") }}<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('status')">{{ t("docker.status") }}<ArrowUpDown /></button>
                </th>
                <th class="text-right">{{ t("docker.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="[project, values] in composeGroups" :key="project">
                <tr class="bg-muted/25 font-medium">
                  <td colspan="7">
                    <button class="flex items-center gap-2" @click="toggleProject(project)">
                      <ChevronDown v-if="expandedProjects.has(project)" class="h-4 w-4" /><ChevronRight v-else class="h-4 w-4" /> <Box class="h-4 w-4 text-sky-500" />{{ project }}<span class="rounded bg-muted px-1.5 text-xs text-muted-foreground">{{ values.length }}</span>
                    </button>
                  </td>
                  <td>
                    <div class="flex justify-end">
                      <Button size="sm" variant="ghost" :disabled="isReadOnly" @click="openComposeEditor(project)"><Pencil />{{ t("docker.editCompose") }}</Button>
                    </div>
                  </td>
                </tr>
                <tr v-for="container in expandedProjects.has(project) ? values : []" :key="container.id">
                  <td>
                    <div class="docker-copy-cell pl-6">
                      <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="isRunning(container) ? 'bg-emerald-500' : isPaused(container) ? 'bg-amber-500' : 'bg-zinc-400'" /><button class="truncate font-medium hover:underline" @click="openDetail(container)">{{ containerName(container) }}</button
                      ><button class="docker-copy-button" :title="t('docker.copy')" @click="copyValue(containerName(container))"><Copy /></button>
                    </div>
                  </td>
                  <td>
                    <div class="docker-copy-cell font-mono text-xs">
                      <span>{{ shortId(container.id) }}</span
                      ><button class="docker-copy-button" :title="t('docker.copy')" @click="copyValue(container.id)"><Copy /></button>
                    </div>
                  </td>
                  <td>
                    <Tooltip
                      ><TooltipTrigger as-child
                        ><div class="docker-copy-cell docker-truncated-cell">
                          <span class="truncate">{{ container.image }}</span
                          ><button class="docker-copy-button" :title="t('docker.copy')" @click="copyValue(container.image)"><Copy /></button></div></TooltipTrigger
                      ><TooltipContent class="max-w-96 break-all">{{ container.image }}</TooltipContent></Tooltip
                    >
                  </td>
                  <td>
                    <Tooltip
                      ><TooltipTrigger as-child
                        ><div class="docker-truncated-cell font-mono text-xs">{{ formatPorts(container) }}</div></TooltipTrigger
                      ><TooltipContent class="max-w-96 break-all">{{ formatPorts(container) }}</TooltipContent></Tooltip
                    >
                  </td>
                  <td>{{ listStats[container.id] ? `${listStats[container.id].cpuPercent.toFixed(1)}%` : "—" }}</td>
                  <td>{{ listStats[container.id] ? `${formatBytes(listStats[container.id].memoryUsage)} / ${formatBytes(listStats[container.id].memoryLimit)}` : "—" }}</td>
                  <td>
                    <span class="docker-status" :class="isRunning(container) ? 'running' : isPaused(container) ? 'paused' : 'stopped'">{{ containerStatusLabel(container) }}</span>
                  </td>
                  <td>
                    <div class="flex justify-end gap-1">
                      <Button v-if="isRunning(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.pause')" @click="runAction(container, 'pause')"
                        ><LoaderCircle v-if="actionInFlight[container.id] === 'pause'" class="animate-spin" /><Pause v-else /></Button
                      ><Button v-if="isPaused(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.resume')" @click="runAction(container, 'unpause')"
                        ><LoaderCircle v-if="actionInFlight[container.id] === 'unpause'" class="animate-spin" /><Play v-else /></Button
                      ><Button v-if="isRunning(container) || isPaused(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.restart')" @click="runAction(container, 'restart')"
                        ><LoaderCircle v-if="actionInFlight[container.id] === 'restart'" class="animate-spin" /><RotateCw v-else /></Button
                      ><Button v-if="isRunning(container) || isPaused(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.stop')" @click="runAction(container, 'stop')"
                        ><LoaderCircle v-if="actionInFlight[container.id] === 'stop'" class="animate-spin" /><Square v-else /></Button
                      ><Button v-if="!isRunning(container) && !isPaused(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.start')" @click="runAction(container, 'start')"
                        ><LoaderCircle v-if="actionInFlight[container.id] === 'start'" class="animate-spin" /><Play v-else /></Button
                      ><Button v-if="!isRunning(container) && !isPaused(container) && !isReadOnly" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.remove')" @click="removeContainer(container)"
                        ><LoaderCircle v-if="actionInFlight[container.id] === 'remove'" class="animate-spin" /><Trash2 v-else /></Button
                      ><Button size="sm" variant="ghost" @click="openDetail(container)">{{ t("docker.details") }}</Button>
                    </div>
                  </td>
                </tr>
              </template>
              <tr v-for="container in standaloneContainers" :key="container.id">
                <td>
                  <div class="docker-copy-cell">
                    <span class="h-2.5 w-2.5 shrink-0 rounded-full" :class="isRunning(container) ? 'bg-emerald-500' : isPaused(container) ? 'bg-amber-500' : 'bg-zinc-400'" /><button class="truncate font-medium hover:underline" @click="openDetail(container)">{{ containerName(container) }}</button
                    ><button class="docker-copy-button" :title="t('docker.copy')" @click="copyValue(containerName(container))"><Copy /></button>
                  </div>
                </td>
                <td>
                  <div class="docker-copy-cell font-mono text-xs">
                    <span>{{ shortId(container.id) }}</span
                    ><button class="docker-copy-button" :title="t('docker.copy')" @click="copyValue(container.id)"><Copy /></button>
                  </div>
                </td>
                <td>
                  <Tooltip
                    ><TooltipTrigger as-child
                      ><div class="docker-copy-cell docker-truncated-cell">
                        <span class="truncate">{{ container.image }}</span
                        ><button class="docker-copy-button" :title="t('docker.copy')" @click="copyValue(container.image)"><Copy /></button></div></TooltipTrigger
                    ><TooltipContent class="max-w-96 break-all">{{ container.image }}</TooltipContent></Tooltip
                  >
                </td>
                <td>
                  <Tooltip
                    ><TooltipTrigger as-child
                      ><div class="docker-truncated-cell font-mono text-xs">{{ formatPorts(container) }}</div></TooltipTrigger
                    ><TooltipContent class="max-w-96 break-all">{{ formatPorts(container) }}</TooltipContent></Tooltip
                  >
                </td>
                <td>{{ listStats[container.id] ? `${listStats[container.id].cpuPercent.toFixed(1)}%` : "—" }}</td>
                <td>{{ listStats[container.id] ? `${formatBytes(listStats[container.id].memoryUsage)} / ${formatBytes(listStats[container.id].memoryLimit)}` : "—" }}</td>
                <td>
                  <span class="docker-status" :class="isRunning(container) ? 'running' : isPaused(container) ? 'paused' : 'stopped'">{{ containerStatusLabel(container) }}</span>
                </td>
                <td>
                  <div class="flex justify-end gap-1">
                    <Button v-if="isRunning(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.pause')" @click="runAction(container, 'pause')"
                      ><LoaderCircle v-if="actionInFlight[container.id] === 'pause'" class="animate-spin" /><Pause v-else /></Button
                    ><Button v-if="isPaused(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.resume')" @click="runAction(container, 'unpause')"
                      ><LoaderCircle v-if="actionInFlight[container.id] === 'unpause'" class="animate-spin" /><Play v-else /></Button
                    ><Button v-if="isRunning(container) || isPaused(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.restart')" @click="runAction(container, 'restart')"
                      ><LoaderCircle v-if="actionInFlight[container.id] === 'restart'" class="animate-spin" /><RotateCw v-else /></Button
                    ><Button v-if="isRunning(container) || isPaused(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.stop')" @click="runAction(container, 'stop')"
                      ><LoaderCircle v-if="actionInFlight[container.id] === 'stop'" class="animate-spin" /><Square v-else /></Button
                    ><Button v-if="!isRunning(container) && !isPaused(container)" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.start')" @click="runAction(container, 'start')"
                      ><LoaderCircle v-if="actionInFlight[container.id] === 'start'" class="animate-spin" /><Play v-else /></Button
                    ><Button v-if="!isRunning(container) && !isPaused(container) && !isReadOnly" size="icon-sm" variant="ghost" :disabled="!!actionInFlight[container.id]" :title="t('docker.remove')" @click="removeContainer(container)"
                      ><LoaderCircle v-if="actionInFlight[container.id] === 'remove'" class="animate-spin" /><Trash2 v-else /></Button
                    ><Button size="sm" variant="ghost" @click="openDetail(container)">{{ t("docker.details") }}</Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>

          <table v-else-if="resource === 'images'" class="docker-table" :style="tableStyle('images')">
            <colgroup>
              <col v-for="(width, index) in columnWidths.images" :key="index" :style="{ width: `${width}px` }" />
            </colgroup>
            <thead @pointerdown="handleHeaderPointer($event, 'images')">
              <tr>
                <th class="docker-image-name-column">
                  <div class="docker-resizable-column">
                    <button class="docker-sort" @click="toggleSort('name')">{{ t("docker.repositoryTag") }}<ArrowUpDown /></button>
                  </div>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('id')">ID<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('size')">{{ t("docker.size") }}<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('created')">{{ t("docker.created") }}<ArrowUpDown /></button>
                </th>
                <th class="text-right">{{ t("docker.actions") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in filteredImages" :key="item.id">
                <td class="docker-image-name-column">
                  <Tooltip
                    ><TooltipTrigger as-child
                      ><div class="docker-copy-cell docker-resizable-column">
                        <span class="truncate">{{ item.repoTags.join(", ") || "&lt;none&gt;" }}</span
                        ><button class="docker-copy-button" :title="t('docker.copy')" @click="copyValue(item.repoTags.join(', ') || item.id)"><Copy /></button></div></TooltipTrigger
                    ><TooltipContent class="max-w-96 break-all">{{ item.repoTags.join(", ") || "&lt;none&gt;" }}</TooltipContent></Tooltip
                  >
                </td>
                <td class="font-mono text-xs">
                  <div class="docker-copy-cell">
                    <span>{{ shortId(item.id) }}</span
                    ><button class="docker-copy-button" :title="t('docker.copy')" @click="copyValue(item.id)"><Copy /></button>
                  </div>
                </td>
                <td>{{ formatBytes(item.size) }}</td>
                <td>{{ formatDate(item.created) }}</td>
                <td>
                  <div class="flex justify-end gap-1">
                    <Button size="sm" variant="ghost" :disabled="isReadOnly || !!imageActionInFlight[item.id]" @click="openPushImage(item)"><Upload />{{ t("docker.push") }}</Button
                    ><Button size="sm" variant="ghost" :disabled="!!imageActionInFlight[item.id]" @click="exportImage(item)"><LoaderCircle v-if="imageActionInFlight[item.id] === 'export'" class="animate-spin" /><Download v-else />{{ t("docker.export") }}</Button
                    ><Button size="icon-sm" variant="ghost" :disabled="isReadOnly || !!imageActionInFlight[item.id]" @click="removeImage(item)"><LoaderCircle v-if="imageActionInFlight[item.id] === 'remove'" class="animate-spin" /><Trash2 v-else /></Button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <table v-else-if="resource === 'volumes'" class="docker-table" :style="tableStyle('volumes')">
            <colgroup>
              <col v-for="(width, index) in columnWidths.volumes" :key="index" :style="{ width: `${width}px` }" />
            </colgroup>
            <thead @pointerdown="handleHeaderPointer($event, 'volumes')">
              <tr>
                <th>
                  <button class="docker-sort" @click="toggleSort('name')">{{ t("docker.name") }}<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('driver')">Driver<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('scope')">Scope<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('mountpoint')">{{ t("docker.mountpoint") }}<ArrowUpDown /></button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in filteredVolumes" :key="item.name">
                <td class="font-medium">
                  <LightTooltip :text="item.name">
                    <div class="docker-truncated-cell">{{ item.name }}</div>
                  </LightTooltip>
                </td>
                <td>
                  <div class="docker-truncated-cell">{{ item.driver }}</div>
                </td>
                <td>
                  <div class="docker-truncated-cell">{{ item.scope }}</div>
                </td>
                <td class="font-mono text-xs">
                  <LightTooltip :text="item.mountpoint">
                    <div class="docker-truncated-cell">{{ item.mountpoint }}</div>
                  </LightTooltip>
                </td>
              </tr>
            </tbody>
          </table>
          <table v-else class="docker-table" :style="tableStyle('networks')">
            <colgroup>
              <col v-for="(width, index) in columnWidths.networks" :key="index" :style="{ width: `${width}px` }" />
            </colgroup>
            <thead @pointerdown="handleHeaderPointer($event, 'networks')">
              <tr>
                <th>
                  <button class="docker-sort" @click="toggleSort('name')">{{ t("docker.name") }}<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('id')">ID<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('driver')">Driver<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('scope')">Scope<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('internal')">Internal<ArrowUpDown /></button>
                </th>
                <th>
                  <button class="docker-sort" @click="toggleSort('attachable')">Attachable<ArrowUpDown /></button>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in filteredNetworks" :key="item.id">
                <td class="font-medium">{{ item.name }}</td>
                <td class="font-mono text-xs">{{ shortId(item.id) }}</td>
                <td>{{ item.driver }}</td>
                <td>{{ item.scope }}</td>
                <td>{{ item.internal ? "✓" : "—" }}</td>
                <td>{{ item.attachable ? "✓" : "—" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </main>

    <Dialog v-model:open="createContainerOpen">
      <DialogContent class="max-h-[88vh] max-w-3xl overflow-auto">
        <DialogHeader
          ><DialogTitle>{{ t("docker.createContainer") }}</DialogTitle
          ><DialogDescription>{{ t("docker.createContainerDescription") }}</DialogDescription></DialogHeader
        >
        <div class="flex w-fit rounded-md border bg-muted/20 p-0.5">
          <button class="rounded px-3 py-1.5 text-xs" :class="createMode === 'form' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'" @click="createMode = 'form'">{{ t("docker.formMode") }}</button>
          <button class="rounded px-3 py-1.5 text-xs" :class="createMode === 'compose' ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground'" @click="openComposeEditor(composeEditingProject)">{{ t("docker.composeMode") }}</button>
        </div>
        <div v-if="createMode === 'form'" class="grid gap-4 py-2 md:grid-cols-2">
          <label class="docker-field"
            ><span>{{ t("docker.name") }}</span
            ><Input v-model="createContainerDraft.name"
          /></label>
          <label class="docker-field"
            ><span>{{ t("docker.image") }}</span
            ><Input v-model="createContainerDraft.image" placeholder="nginx:latest"
          /></label>
          <label class="docker-field"
            ><span>{{ t("docker.commandLines") }}</span
            ><textarea v-model="createContainerDraft.command" rows="4" class="docker-textarea" />
          </label>
          <label class="docker-field"
            ><span>{{ t("docker.environmentLines") }}</span
            ><textarea v-model="createContainerDraft.environment" rows="4" class="docker-textarea" placeholder="KEY=value" />
          </label>
          <label class="docker-field"
            ><span>{{ t("docker.portLines") }}</span
            ><textarea v-model="createContainerDraft.ports" rows="4" class="docker-textarea" placeholder="127.0.0.1:8080:80/tcp" />
          </label>
          <label class="docker-field"
            ><span>{{ t("docker.mountLines") }}</span
            ><textarea v-model="createContainerDraft.mounts" rows="4" class="docker-textarea" placeholder="volume-name:/data:ro" />
          </label>
          <label class="docker-field"
            ><span>{{ t("docker.network") }}</span
            ><select v-model="createContainerDraft.network" class="docker-select">
              <option value="">{{ t("docker.defaultNetwork") }}</option>
              <option v-for="item in networks" :key="item.id" :value="item.name">{{ item.name }}</option>
            </select></label
          >
          <label class="docker-field"
            ><span>{{ t("docker.restartPolicy") }}</span
            ><select v-model="createContainerDraft.restartPolicy" class="docker-select">
              <option value="no">no</option>
              <option value="always">always</option>
              <option value="unless-stopped">unless-stopped</option>
              <option value="on-failure">on-failure</option>
            </select></label
          >
          <label class="flex items-center gap-2 text-sm"><input v-model="createContainerDraft.start" type="checkbox" />{{ t("docker.startAfterCreate") }}</label>
        </div>
        <div v-else class="space-y-3 py-2">
          <label class="docker-field"
            ><span>{{ t("docker.composeProject") }}</span
            ><Input v-model="composeDraft.projectName" :disabled="!!composeEditingProject" placeholder="my-project"
          /></label>
          <label class="docker-field"><span>compose.yaml</span><textarea v-model="composeDraft.content" rows="20" class="docker-textarea min-h-80" spellcheck="false" /></label>
          <p class="m-0 text-xs text-muted-foreground">{{ t("docker.composeSubsetHint") }}</p>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="createContainerOpen = false">{{ t("common.cancel") }}</Button
          ><Button v-if="createMode === 'form'" :disabled="submitting || !createContainerDraft.name.trim() || !createContainerDraft.image.trim()" @click="createContainer"><LoaderCircle v-if="submitting" class="animate-spin" />{{ t("docker.create") }}</Button
          ><Button v-else :disabled="submitting || !composeDraft.projectName.trim() || !composeDraft.content.trim()" @click="applyCompose"><LoaderCircle v-if="submitting" class="animate-spin" />{{ composeEditingProject ? t("docker.saveCompose") : t("docker.create") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="pullImageOpen">
      <DialogContent>
        <DialogHeader
          ><DialogTitle>{{ t("docker.pullImage") }}</DialogTitle
          ><DialogDescription>{{ t("docker.registryCredentialsTemporary") }}</DialogDescription></DialogHeader
        >
        <div class="space-y-3 py-2">
          <label class="docker-field"
            ><span>{{ t("docker.image") }}</span
            ><Input v-model="pullDraft.image" placeholder="nginx:latest" /></label
          ><label class="docker-field"><span>Registry</span><Input v-model="pullDraft.serverAddress" placeholder="registry.example.com" /></label>
          <div class="grid grid-cols-2 gap-3">
            <label class="docker-field"
              ><span>{{ t("connection.username") }}</span
              ><Input v-model="pullDraft.username" /></label
            ><label class="docker-field"
              ><span>{{ t("connection.password") }}</span
              ><Input v-model="pullDraft.password" type="password"
            /></label>
          </div>
          <pre v-if="pullProgress" class="max-h-36 overflow-auto rounded bg-muted p-2 text-xs">{{ pullProgress }}</pre>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="pullImageOpen = false">{{ t("common.cancel") }}</Button
          ><Button :disabled="pulling || !pullDraft.image.trim()" @click="pullImage">{{ t("docker.pull") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="pushImageOpen">
      <DialogContent>
        <DialogHeader
          ><DialogTitle>{{ t("docker.pushImage") }}</DialogTitle
          ><DialogDescription>{{ t("docker.registryCredentialsTemporaryPush") }}</DialogDescription></DialogHeader
        >
        <div class="space-y-3 py-2">
          <label class="docker-field"
            ><span>{{ t("docker.targetReference") }}</span
            ><Input v-model="pushDraft.targetReference" placeholder="registry.example.com/team/image:tag"
          /></label>
          <label class="docker-field"><span>Registry</span><Input v-model="pushDraft.serverAddress" placeholder="registry.example.com" /></label>
          <div class="grid grid-cols-2 gap-3">
            <label class="docker-field"
              ><span>{{ t("connection.username") }}</span
              ><Input v-model="pushDraft.username" /></label
            ><label class="docker-field"
              ><span>{{ t("connection.password") }}</span
              ><Input v-model="pushDraft.password" type="password"
            /></label>
          </div>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="pushImageOpen = false">{{ t("common.cancel") }}</Button
          ><Button :disabled="!pushDraft.targetReference.trim()" @click="pushImage"><Upload />{{ t("docker.push") }}</Button></DialogFooter
        >
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="engineJsonOpen">
      <DialogContent class="max-h-[88vh] max-w-4xl overflow-hidden">
        <DialogHeader
          ><DialogTitle>{{ t("docker.engineJson") }}</DialogTitle
          ><DialogDescription>{{ t("docker.engineJsonReadonlyHint") }}</DialogDescription></DialogHeader
        >
        <div class="flex items-center gap-2">
          <div class="relative flex-1"><Search class="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input v-model="engineJsonSearch" class="pl-8" :placeholder="t('docker.searchEngineJson')" /></div>
          <Button size="sm" variant="outline" @click="copyValue(JSON.stringify(engineJson, null, 2))"><Copy />{{ t("docker.copy") }}</Button>
        </div>
        <div class="max-h-[62vh] overflow-auto rounded-md border bg-muted/10 p-3">
          <div v-if="engineDetailsLoading" class="flex justify-center p-8"><LoaderCircle class="animate-spin" /></div>
          <pre v-else-if="engineJsonSearch" class="whitespace-pre-wrap break-all font-mono text-xs">{{ filteredEngineJson }}</pre>
          <JsonTree v-else :value="engineJson" :initial-expanded-depth="2" />
        </div>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="engineSummaryOpen">
      <DialogContent class="max-h-[88vh] max-w-2xl overflow-auto">
        <DialogHeader
          ><DialogTitle>{{ t("docker.engineInformation") }}</DialogTitle></DialogHeader
        >
        <div v-if="engineDetailsLoading" class="flex justify-center p-8"><LoaderCircle class="animate-spin" /></div>
        <div v-else-if="engineDetails" class="grid grid-cols-2 gap-3 text-sm">
          <div
            v-for="[label, value] in [
              ['Engine', engineDetails.summary.engineVersion],
              ['API', engineDetails.summary.apiVersion],
              [t('docker.minimumApiVersion'), engineDetails.summary.minimumApiVersion],
              [t('docker.operatingSystem'), engineDetails.summary.operatingSystem],
              [t('docker.architecture'), engineDetails.summary.architecture],
              [t('docker.kernelVersion'), engineDetails.summary.kernelVersion],
              [t('docker.storageDriver'), engineDetails.summary.storageDriver],
              [t('docker.containers'), engineDetails.summary.containers],
              [t('docker.running'), engineDetails.summary.containersRunning],
              [t('docker.paused'), engineDetails.summary.containersPaused],
              [t('docker.stopped'), engineDetails.summary.containersStopped],
              [t('docker.images'), engineDetails.summary.images],
              ['Docker Root Dir', engineDetails.summary.dockerRootDir],
            ]"
            :key="String(label)"
            class="docker-card"
          >
            <span>{{ label }}</span
            ><strong>{{ value ?? "—" }}</strong>
          </div>
          <div class="docker-card col-span-2">
            <span>{{ t("docker.securityOptions") }}</span
            ><strong class="whitespace-pre-wrap text-xs">{{ engineDetails.summary.securityOptions.join("\n") || "—" }}</strong>
          </div>
          <div v-if="engineDetails.summary.warnings.length" class="col-span-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">{{ engineDetails.summary.warnings.join("\n") }}</div>
        </div>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="createVolumeOpen">
      <DialogContent
        ><DialogHeader
          ><DialogTitle>{{ t("docker.createVolume") }}</DialogTitle></DialogHeader
        >
        <div class="space-y-3 py-2">
          <label class="docker-field"
            ><span>{{ t("docker.name") }}</span
            ><Input v-model="volumeDraft.name" /></label
          ><label class="docker-field"><span>Driver</span><Input v-model="volumeDraft.driver" /></label><label class="docker-field"><span>Labels</span><textarea v-model="volumeDraft.labels" rows="3" class="docker-textarea" placeholder="key=value" /></label
          ><label class="docker-field"><span>Driver options</span><textarea v-model="volumeDraft.driverOptions" rows="3" class="docker-textarea" placeholder="key=value" /></label>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="createVolumeOpen = false">{{ t("common.cancel") }}</Button
          ><Button :disabled="submitting || !volumeDraft.name.trim()" @click="createVolume">{{ t("docker.create") }}</Button></DialogFooter
        ></DialogContent
      >
    </Dialog>

    <Dialog v-model:open="createNetworkOpen">
      <DialogContent
        ><DialogHeader
          ><DialogTitle>{{ t("docker.createNetwork") }}</DialogTitle></DialogHeader
        >
        <div class="grid grid-cols-2 gap-3 py-2">
          <label class="docker-field"
            ><span>{{ t("docker.name") }}</span
            ><Input v-model="networkDraft.name" /></label
          ><label class="docker-field"><span>Driver</span><Input v-model="networkDraft.driver" /></label><label class="docker-field"><span>Subnet</span><Input v-model="networkDraft.subnet" placeholder="172.28.0.0/16" /></label
          ><label class="docker-field"><span>Gateway</span><Input v-model="networkDraft.gateway" placeholder="172.28.0.1" /></label><label class="flex items-center gap-2 text-sm"><input v-model="networkDraft.internal" type="checkbox" />Internal</label
          ><label class="flex items-center gap-2 text-sm"><input v-model="networkDraft.attachable" type="checkbox" />Attachable</label>
        </div>
        <DialogFooter
          ><Button variant="outline" @click="createNetworkOpen = false">{{ t("common.cancel") }}</Button
          ><Button :disabled="submitting || !networkDraft.name.trim()" @click="createNetwork">{{ t("docker.create") }}</Button></DialogFooter
        ></DialogContent
      >
    </Dialog>
    <DangerConfirmDialog v-model:open="dangerOpen" :message="dangerMessage" :confirm-label="t('common.confirm')" @confirm="settleConfirmation(true)" />
  </div>
</template>

<style scoped>
.docker-header {
  display: flex;
  height: 36px;
  flex: 0 0 36px;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border-bottom: 1px solid var(--border);
  padding: 0 8px;
  background: linear-gradient(90deg, var(--docker-accent-soft, color-mix(in srgb, var(--muted) 24%, transparent)), var(--docker-accent-faint, transparent));
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--docker-accent, var(--border)) 35%, var(--border));
}
.docker-main-tab {
  height: 30px;
  border-bottom: 2px solid transparent;
  padding: 0 0.7rem;
  font-size: 0.75rem;
  color: var(--muted-foreground);
}
.docker-main-tab:hover {
  color: var(--foreground);
}
.docker-main-tab.active {
  border-color: var(--docker-accent, var(--primary));
  color: var(--foreground);
  font-weight: 600;
}
.docker-detail-tab {
  border-bottom: 2px solid transparent;
  padding: 0.65rem 1rem;
  font-size: 0.8rem;
  color: var(--muted-foreground);
}
.docker-detail-tab.active {
  border-color: var(--docker-accent, var(--primary));
  color: var(--foreground);
  font-weight: 600;
}
.docker-table {
  width: 100%;
  min-width: 58rem;
  table-layout: fixed;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.875rem;
}
.docker-table th {
  position: sticky;
  top: 0;
  z-index: 5;
  border-bottom: 1px solid var(--border);
  background: var(--background);
  padding: 0.65rem 1rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
}
.docker-table th::after {
  position: absolute;
  top: 0;
  right: 0;
  width: 7px;
  height: 100%;
  content: "";
  cursor: col-resize;
}
.docker-table td {
  border-bottom: 1px solid var(--border);
  padding: 0.55rem 1rem;
  vertical-align: middle;
}
.docker-table tbody tr:hover {
  background: color-mix(in srgb, var(--muted) 42%, transparent);
}
.docker-sort {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  white-space: nowrap;
}
.docker-sort svg {
  width: 0.75rem;
  height: 0.75rem;
  opacity: 0.55;
}
.docker-copy-cell {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 0.4rem;
}
.docker-copy-button {
  display: inline-flex;
  width: 1.25rem;
  height: 1.25rem;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: 0.25rem;
  opacity: 0;
  color: var(--muted-foreground);
  transition:
    opacity 120ms ease,
    background-color 120ms ease;
}
.docker-copy-cell:hover .docker-copy-button,
.docker-copy-button:focus-visible {
  opacity: 1;
}
.docker-copy-button:hover {
  background: var(--muted);
  color: var(--foreground);
}
.docker-copy-button svg {
  width: 0.75rem;
  height: 0.75rem;
}
.docker-status {
  display: inline-flex;
  border-radius: 999px;
  padding: 0.15rem 0.5rem;
  font-size: 0.7rem;
  font-weight: 600;
}
.docker-status.running {
  background: color-mix(in srgb, #10b981 16%, transparent);
  color: #059669;
}
.docker-status.paused {
  background: color-mix(in srgb, #f59e0b 16%, transparent);
  color: #d97706;
}
.docker-status.stopped {
  background: color-mix(in srgb, var(--muted-foreground) 14%, transparent);
  color: var(--muted-foreground);
}
.docker-truncated-cell {
  width: 100%;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.docker-image-name-column {
  overflow: hidden;
}
.docker-resizable-column {
  width: 100%;
  max-width: 100%;
  overflow: hidden;
}
.docker-indeterminate {
  animation: docker-progress 1.2s ease-in-out infinite;
}
@keyframes docker-progress {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}
.docker-card {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 0.2rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--muted) 20%, transparent);
  padding: 0.8rem;
}
.docker-card span,
.docker-card small {
  font-size: 0.72rem;
  color: var(--muted-foreground);
}
.docker-card strong {
  overflow-wrap: anywhere;
  font-size: 0.875rem;
}
.docker-row-value,
.docker-code {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--muted) 18%, transparent);
  padding: 0.55rem 0.75rem;
  font-family: var(--dbx-editor-font-family, ui-monospace);
  font-size: 0.75rem;
}
.docker-code {
  max-height: 16rem;
  overflow: auto;
  white-space: pre-wrap;
}
.docker-field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.8rem;
}
.docker-field > span {
  color: var(--muted-foreground);
}
.docker-textarea,
.docker-select {
  width: 100%;
  border: 1px solid var(--input);
  border-radius: var(--radius-md);
  background: var(--background);
  padding: 0.5rem 0.65rem;
  font-size: 0.8rem;
  outline: none;
}
.docker-textarea {
  resize: vertical;
  font-family: var(--dbx-editor-font-family, ui-monospace);
}
.docker-textarea:focus,
.docker-select:focus {
  border-color: var(--ring);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ring) 22%, transparent);
}
</style>

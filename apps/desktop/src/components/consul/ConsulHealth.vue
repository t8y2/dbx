<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { CircleCheck, CircleX, Loader2, Pause, Plus, Radio, RefreshCcw, Search, Trash2, TriangleAlert, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import ConsulListPagination from "@/components/consul/ConsulListPagination.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useConsulStore } from "@/stores/consulStore";
import { nextWatchIndex } from "@/lib/consul/watchState";
import { consulAgentWriteTargetSafe } from "@/lib/consul/agentTarget";
import { clampConsulPage, CONSUL_LIST_PAGE_SIZE, paginateConsulItems } from "@/lib/consul/pagination";
import { useI18n } from "vue-i18n";
import type { ConsulAgentCheckDefinition, ConsulAgentCheckRegistration, ConsulAgentIdentity, ConsulCheckStatus, ConsulDomainWatchResponse, ConsulHealthCheck, ConsulScope, ConsulServiceInstance } from "@/types/consul";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const store = useConnectionStore();
const consulStore = useConsulStore();
const state = ref("any");
const browseMode = ref<"state" | "node" | "service">("state");
const browseName = ref("");
const browseNameDraft = ref("");
const keywordFilter = ref("");
const statusFilter = ref("any");
const typeFilter = ref("any");
const checks = ref<ConsulHealthCheck[]>([]);
const selectedCheck = ref<ConsulHealthCheck | null>(null);
const serviceInstances = ref<ConsulServiceInstance[]>([]);
const localChecks = ref<Record<string, ConsulHealthCheck>>({});
const identity = ref<ConsulAgentIdentity | null>(null);
const checkPage = ref(1);
const localCheckPage = ref(1);
const serviceInstancePage = ref(1);
const agentTarget = computed(() => {
  const external = store.getConfig(props.connectionId)?.external_config;
  const config = external && typeof external === "object" && !Array.isArray(external) ? (external as Record<string, unknown>) : {};
  const raw = config.agentTarget || config.agent_target;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const target = raw as Record<string, unknown>;
  const node = String(target.node || "").trim();
  const address = String(target.address || "").trim();
  return node && address ? { node, address } : null;
});
const canAgentWrite = computed(() => consulAgentWriteTargetSafe(store.getConfig(props.connectionId), identity.value?.node));
const errors = ref<Record<string, string>>({});
const loading = ref(false);
const editorOpen = ref(false);
const saving = ref(false);
const form = ref({ id: "", name: "", serviceId: "", type: "ttl", endpoint: "", interval: "10s", timeout: "2s", ttl: "30s", args: "" });
let sequence = 0;
const watchEnabled = ref(false);
const watchPaused = ref(false);
const watchIndex = ref<string | null>(null);
let watchConnectionId = "";
let watchScope: ConsulScope = { datacenter: "", namespace: "", partition: "" };
let watchGeneration = 0;
let watchOperationId = "";

function normalizedCheckStatus(check: ConsulHealthCheck): string {
  return check.Maintenance ? "maintenance" : String(check.Status || "unknown").toLocaleLowerCase();
}

function checkType(check: ConsulHealthCheck): string {
  if (check.Maintenance) return "maintenance";
  if (check.Definition?.TTL) return "ttl";
  if (check.Definition?.HTTP) return "http";
  if (check.Definition?.TCP) return "tcp";
  if (check.Definition?.GRPC) return "grpc";
  const raw = String(check.Type || "")
    .trim()
    .toLocaleLowerCase();
  if (raw) return raw;
  return check.ServiceID ? "service" : "node";
}

function matchesHealthFilters(check: ConsulHealthCheck): boolean {
  if (statusFilter.value !== "any" && normalizedCheckStatus(check) !== statusFilter.value) return false;
  if (typeFilter.value !== "any" && checkType(check) !== typeFilter.value) return false;
  const query = keywordFilter.value.trim().toLocaleLowerCase();
  if (!query) return true;
  return [check.Name, check.CheckID, check.Node, check.ServiceName, check.ServiceID, check.Output, check.Notes, check.Type, check.ServiceTags.join(" "), JSON.stringify(check.Definition)].join(" ").toLocaleLowerCase().includes(query);
}

const localCheckItems = computed(() => Object.values(localChecks.value).sort((left, right) => left.Name.localeCompare(right.Name) || left.CheckID.localeCompare(right.CheckID)));
const filteredChecks = computed(() => checks.value.filter(matchesHealthFilters));
const filteredLocalChecks = computed(() => localCheckItems.value.filter(matchesHealthFilters));
const pagedChecks = computed(() => paginateConsulItems(filteredChecks.value, checkPage.value));
const pagedLocalChecks = computed(() => paginateConsulItems(filteredLocalChecks.value, localCheckPage.value));
const pagedServiceInstances = computed(() => paginateConsulItems(serviceInstances.value, serviceInstancePage.value));
const availableCheckTypes = computed(() => [...new Set([...checks.value, ...localCheckItems.value].map(checkType))].sort());
const healthSummary = computed(() => {
  const summary = { passing: 0, warning: 0, critical: 0, maintenance: 0 };
  for (const check of checks.value) {
    const status = normalizedCheckStatus(check);
    if (status in summary) summary[status as keyof typeof summary]++;
  }
  return summary;
});
const hasActiveHealthFilters = computed(() => Boolean(keywordFilter.value.trim() || statusFilter.value !== "any" || typeFilter.value !== "any"));

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function selectCheck(check: ConsulHealthCheck) {
  selectedCheck.value = selectedCheck.value?.CheckID === check.CheckID && selectedCheck.value?.Node === check.Node ? null : check;
}
function currentScope(): ConsulScope {
  const external = store.getConfig(props.connectionId)?.external_config;
  const config = external && typeof external === "object" && !Array.isArray(external) ? (external as Record<string, unknown>) : {};
  return {
    datacenter: String(config.datacenter || config.consulDatacenter || config.consul_datacenter || ""),
    namespace: String(config.namespace || config.consulNamespace || config.consul_namespace || ""),
    partition: String(config.partition || config.consulPartition || config.consul_partition || ""),
  };
}
function newWatchId() {
  return globalThis.crypto?.randomUUID?.() || `consul-health-${Date.now()}-${Math.random()}`;
}
function watchActive(operationId: string) {
  return watchEnabled.value && !watchPaused.value && watchOperationId === operationId && watchConnectionId === props.connectionId && watchGeneration === consulStore.generation;
}
async function stopWatch() {
  const operationId = watchOperationId;
  watchOperationId = "";
  if (!operationId) return;
  consulStore.completeOperation(operationId);
  await api.consulCancelBlocking(watchConnectionId, watchScope, watchGeneration, operationId).catch(() => false);
}
function watchTarget(name: string) {
  if (browseMode.value === "node") return { kind: "healthNode" as const, node: name };
  if (browseMode.value === "service") return { kind: "healthServiceInstances" as const, service: name, passing: null };
  return { kind: "healthState" as const, state: name };
}

async function runWatch(operationId: string, name: string, mode: typeof browseMode.value) {
  let index: string | null = null;
  while (watchActive(operationId) && browseMode.value === mode && (mode === "state" ? state.value : browseName.value) === name) {
    try {
      const result = (await api.consulDomainWatch(watchConnectionId, {
        operationId,
        generation: watchGeneration,
        target: watchTarget(name),
        index,
        waitSeconds: 300,
      })) as ConsulDomainWatchResponse<ConsulHealthCheck[] | ConsulServiceInstance[]>;
      index = nextWatchIndex(index, result.metadata.index).index;
      watchIndex.value = index;
      if (result.changed || result.indexReset) {
        if (mode === "service") {
          serviceInstances.value = result.items as ConsulServiceInstance[];
          checks.value = serviceInstances.value.flatMap((instance) => instance.Checks);
        } else checks.value = result.items as ConsulHealthCheck[];
        selectedCheck.value = checks.value.find((check) => check.CheckID === selectedCheck.value?.CheckID && check.Node === selectedCheck.value?.Node) || null;
      }
    } catch (error) {
      if (watchActive(operationId) && !String(error).includes("CANCELLED")) errors.value = { ...errors.value, [t("consul.ui.watch")]: errorMessage(error) };
      break;
    }
  }
  consulStore.completeOperation(operationId);
}
async function startWatch() {
  if (watchOperationId && watchEnabled.value && !watchPaused.value) return;
  watchEnabled.value = true;
  watchPaused.value = false;
  watchConnectionId = props.connectionId;
  watchScope = currentScope();
  consulStore.bindConnection(watchConnectionId, watchScope);
  watchGeneration = consulStore.generation;
  watchOperationId = newWatchId();
  consulStore.registerOperation(watchOperationId);
  const name = browseMode.value === "state" ? state.value : browseName.value;
  if (!name.trim()) {
    watchEnabled.value = false;
    consulStore.completeOperation(watchOperationId);
    watchOperationId = "";
    return;
  }
  void runWatch(watchOperationId, name, browseMode.value);
}
async function pauseWatch() {
  watchPaused.value = true;
  await stopWatch();
}
async function independent(name: string, action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    errors.value = { ...errors.value, [name]: errorMessage(error) };
  }
}

async function reloadHealthQuery() {
  const resume = watchEnabled.value && !watchPaused.value;
  await stopWatch();
  await load();
  if (resume && (browseMode.value === "state" || browseName.value.trim())) await startWatch();
}

async function switchHealthBrowseMode(mode: typeof browseMode.value) {
  if (browseMode.value === mode) return;
  browseMode.value = mode;
  browseName.value = "";
  browseNameDraft.value = "";
  selectedCheck.value = null;
  await reloadHealthQuery();
}

async function applyBrowseTarget() {
  const target = browseNameDraft.value.trim();
  if (!target) return;
  browseName.value = target;
  selectedCheck.value = null;
  await reloadHealthQuery();
}

function clearHealthFilters() {
  keywordFilter.value = "";
  statusFilter.value = "any";
  typeFilter.value = "any";
  selectedCheck.value = null;
}

function applyStatusFilter(status: string) {
  statusFilter.value = statusFilter.value === status ? "any" : status;
}

function checkTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    ttl: t("consul.ui.ttl"),
    http: t("consul.ui.http"),
    tcp: t("consul.ui.tcp"),
    grpc: t("consul.ui.grpc"),
    docker: t("consul.ui.docker"),
    script: t("consul.ui.script"),
    maintenance: t("consul.ui.maintenance"),
    service: t("consul.ui.service"),
    node: t("consul.ui.node"),
  };
  return labels[type] || type;
}

async function load() {
  const current = ++sequence;
  loading.value = true;
  errors.value = {};
  await Promise.all([
    independent(t("consul.ui.healthChecks"), async () => {
      if (browseMode.value === "state") {
        const value = await api.consulHealthState(props.connectionId, state.value);
        if (current === sequence) {
          checks.value = value.items;
          serviceInstances.value = [];
        }
      } else if (browseMode.value === "node") {
        if (!browseName.value.trim()) {
          checks.value = [];
          return;
        }
        const value = await api.consulHealthNode(props.connectionId, browseName.value);
        if (current === sequence) {
          checks.value = value.items;
          serviceInstances.value = [];
        }
      } else {
        if (!browseName.value.trim()) {
          checks.value = [];
          serviceInstances.value = [];
          return;
        }
        const value = await api.consulHealthService(props.connectionId, browseName.value);
        if (current === sequence) {
          serviceInstances.value = value.items;
          checks.value = value.items.flatMap((instance) => instance.Checks);
        }
      }
    }),
    independent(t("consul.ui.agent"), async () => {
      const value = await api.consulAgentSelf(props.connectionId);
      if (current === sequence) identity.value = value;
    }),
    independent(t("consul.ui.localAgentChecks"), async () => {
      const value = await api.consulAgentChecks(props.connectionId);
      if (current === sequence) localChecks.value = value;
    }),
  ]);
  if (current === sequence) {
    selectedCheck.value = checks.value.find((check) => check.CheckID === selectedCheck.value?.CheckID && check.Node === selectedCheck.value?.Node) || null;
    loading.value = false;
  }
}

function definition(): ConsulAgentCheckDefinition {
  const common = { interval: form.value.interval, timeout: form.value.timeout };
  if (form.value.type === "http") return { type: "http", url: form.value.endpoint, method: "GET", ...common, tlsSkipVerify: false };
  if (form.value.type === "tcp") return { type: "tcp", address: form.value.endpoint, ...common };
  if (form.value.type === "grpc") return { type: "grpc", address: form.value.endpoint, ...common, tls: false };
  if (form.value.type === "docker") return { type: "docker", containerId: form.value.endpoint, shell: "", args: form.value.args.split(/\s+/).filter(Boolean), ...common };
  if (form.value.type === "script") return { type: "script", args: form.value.args.split(/\s+/).filter(Boolean), ...common };
  return { type: "ttl", ttl: form.value.ttl };
}

async function registerCheck() {
  if (!canAgentWrite.value || !form.value.name.trim()) return;
  saving.value = true;
  try {
    const registration: ConsulAgentCheckRegistration = { id: form.value.id.trim(), name: form.value.name.trim(), notes: "", serviceId: form.value.serviceId.trim(), status: "critical", definition: definition() };
    await api.consulAgentRegisterCheck(props.connectionId, registration);
    editorOpen.value = false;
    await load();
  } catch (error) {
    errors.value = { ...errors.value, [t("consul.ui.writeOperation")]: errorMessage(error) };
  } finally {
    saving.value = false;
  }
}

async function updateTtl(id: string, status: ConsulCheckStatus) {
  if (canAgentWrite.value)
    await independent(t("consul.ui.writeOperation"), async () => {
      await api.consulAgentUpdateTtl(props.connectionId, id, status);
      await load();
    });
}
async function deregister(id: string) {
  if (canAgentWrite.value && window.confirm(t("consul.ui.deregisterCheck", { id, node: agentTarget.value?.node || t("consul.ui.targetAgent") })))
    await independent(t("consul.ui.writeOperation"), async () => {
      await api.consulAgentDeregisterCheck(props.connectionId, id);
      await load();
    });
}
function statusClass(check: ConsulHealthCheck) {
  if (check.Maintenance) return "text-blue-700 dark:text-blue-300";
  if (check.Status === "passing") return "text-emerald-700 dark:text-emerald-300";
  if (check.Status === "warning") return "text-amber-700 dark:text-amber-300";
  return "text-destructive";
}
function statusLabel(check: ConsulHealthCheck) {
  if (check.Maintenance) return t("consul.ui.maintenance");
  if (check.Status === "passing") return t("consul.ui.passing");
  if (check.Status === "warning") return t("consul.ui.warning");
  if (check.Status === "critical") return t("consul.ui.critical");
  return t("consul.ui.unknown");
}

watch(
  () => props.connectionId,
  async () => {
    await stopWatch();
    watchEnabled.value = false;
    watchPaused.value = false;
    watchIndex.value = null;
    await load();
  },
);
watch(state, async () => {
  if (browseMode.value === "state") await reloadHealthQuery();
});
watch([keywordFilter, statusFilter, typeFilter], () => {
  checkPage.value = 1;
  localCheckPage.value = 1;
  selectedCheck.value = null;
});
watch(filteredChecks, (items) => {
  checkPage.value = clampConsulPage(checkPage.value, items.length);
});
watch(filteredLocalChecks, (items) => {
  localCheckPage.value = clampConsulPage(localCheckPage.value, items.length);
});
watch(serviceInstances, (items) => {
  serviceInstancePage.value = clampConsulPage(serviceInstancePage.value, items.length);
});
onMounted(load);
onDeactivated(() => {
  watchPaused.value = true;
  void stopWatch();
});
onBeforeUnmount(() => {
  void stopWatch();
});
defineExpose({ refresh: () => (void load(), true) });
</script>

<template>
  <div class="h-full overflow-auto p-4">
    <header class="mb-4 flex flex-wrap items-start justify-between gap-3 border-b pb-3">
      <div class="min-w-0">
        <h2 class="text-lg font-semibold">{{ t("consul.ui.healthChecks") }}</h2>
        <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge :variant="canAgentWrite ? 'secondary' : 'outline'" :class="canAgentWrite ? 'text-emerald-700 dark:text-emerald-300' : 'border-amber-500/40 text-amber-700 dark:text-amber-300'">{{
            t("consul.ui.agentTarget", { target: canAgentWrite && agentTarget ? `${agentTarget.node} (${agentTarget.address})` : t("consul.ui.unknownWritesDisabled") })
          }}</Badge>
          <span v-if="watchEnabled">{{ watchPaused ? t("consul.ui.watchPaused") : t("consul.ui.watchingIndex", { index: watchIndex || "1" }) }}</span>
        </div>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" class="h-8 gap-1.5" :title="watchEnabled && !watchPaused ? t('consul.ui.pauseWatch') : t('consul.ui.startWatch')" :disabled="browseMode !== 'state' && !browseName.trim()" @click="watchEnabled && !watchPaused ? pauseWatch() : startWatch()"
          ><Pause v-if="watchEnabled && !watchPaused" class="h-3.5 w-3.5" /><Radio v-else class="h-3.5 w-3.5" />{{ watchEnabled && !watchPaused ? t("consul.ui.pauseWatch") : t("consul.ui.startWatch") }}</Button
        >
        <Button size="icon" variant="outline" class="h-8 w-8" :disabled="loading" :title="t('consul.ui.refresh')" @click="load"><RefreshCcw class="h-3.5 w-3.5" /></Button>
        <Button size="sm" class="h-8 gap-1.5" :disabled="!canAgentWrite" @click="editorOpen = !editorOpen"><Plus class="h-3.5 w-3.5" />{{ t("consul.ui.register") }}</Button>
      </div>
    </header>

    <section class="mb-4 rounded-lg border bg-muted/10 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="grid shrink-0 grid-cols-3 text-xs">
          <Button size="sm" class="h-8 rounded-r-none" :variant="browseMode === 'state' ? 'default' : 'outline'" @click="switchHealthBrowseMode('state')">{{ t("consul.ui.state") }}</Button>
          <Button size="sm" class="h-8 rounded-none" :variant="browseMode === 'node' ? 'default' : 'outline'" @click="switchHealthBrowseMode('node')">{{ t("consul.ui.node") }}</Button>
          <Button size="sm" class="h-8 rounded-l-none" :variant="browseMode === 'service' ? 'default' : 'outline'" @click="switchHealthBrowseMode('service')">{{ t("consul.ui.service") }}</Button>
        </div>
        <select v-if="browseMode === 'state'" v-model="state" class="h-8 rounded-md border bg-background px-2 text-xs">
          <option value="any">{{ t("consul.ui.allStates") }}</option>
          <option value="passing">{{ t("consul.ui.passing") }}</option>
          <option value="warning">{{ t("consul.ui.warning") }}</option>
          <option value="critical">{{ t("consul.ui.critical") }}</option>
        </select>
        <div v-else class="flex min-w-56 flex-1 sm:max-w-sm">
          <Input v-model="browseNameDraft" class="h-8 rounded-r-none text-xs" :placeholder="browseMode === 'node' ? t('consul.ui.nodeName') : t('consul.ui.serviceName')" @keydown.enter="applyBrowseTarget" />
          <Button size="sm" class="h-8 rounded-l-none px-3" :disabled="!browseNameDraft.trim()" @click="applyBrowseTarget">{{ t("consul.ui.query") }}</Button>
        </div>
        <div class="hidden h-6 w-px bg-border lg:block" />
        <div class="relative min-w-64 flex-1">
          <Search class="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input v-model="keywordFilter" class="h-8 pl-8 text-xs" :placeholder="t('consul.ui.searchHealthChecks')" />
        </div>
        <select v-model="statusFilter" class="h-8 rounded-md border bg-background px-2 text-xs">
          <option value="any">{{ t("consul.ui.allStates") }}</option>
          <option value="passing">{{ t("consul.ui.passing") }}</option>
          <option value="warning">{{ t("consul.ui.warning") }}</option>
          <option value="critical">{{ t("consul.ui.critical") }}</option>
          <option value="maintenance">{{ t("consul.ui.maintenance") }}</option>
        </select>
        <select v-model="typeFilter" class="h-8 rounded-md border bg-background px-2 text-xs">
          <option value="any">{{ t("consul.ui.allCheckTypes") }}</option>
          <option v-for="type in availableCheckTypes" :key="type" :value="type">{{ checkTypeLabel(type) }}</option>
        </select>
        <Button v-if="hasActiveHealthFilters" size="sm" variant="ghost" class="h-8 gap-1 px-2 text-xs" @click="clearHealthFilters"><X class="h-3.5 w-3.5" />{{ t("consul.ui.clearFilters") }}</Button>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
        <span class="mr-1 text-muted-foreground">{{ t("consul.ui.healthResultCount", { filtered: filteredChecks.length, total: checks.length }) }}</span>
        <button type="button" @click="applyStatusFilter('passing')">
          <Badge variant="outline" :class="statusFilter === 'passing' ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'text-emerald-700 dark:text-emerald-300'">{{ t("consul.ui.passing") }} {{ healthSummary.passing }}</Badge>
        </button>
        <button type="button" @click="applyStatusFilter('warning')">
          <Badge variant="outline" :class="statusFilter === 'warning' ? 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'text-amber-700 dark:text-amber-300'">{{ t("consul.ui.warning") }} {{ healthSummary.warning }}</Badge>
        </button>
        <button type="button" @click="applyStatusFilter('critical')">
          <Badge variant="outline" :class="statusFilter === 'critical' ? 'border-destructive/50 bg-destructive/10 text-destructive' : 'text-destructive'">{{ t("consul.ui.critical") }} {{ healthSummary.critical }}</Badge>
        </button>
        <button type="button" @click="applyStatusFilter('maintenance')">
          <Badge variant="outline" :class="statusFilter === 'maintenance' ? 'border-blue-500/50 bg-blue-500/10 text-blue-700 dark:text-blue-300' : ''">{{ t("consul.ui.maintenance") }} {{ healthSummary.maintenance }}</Badge>
        </button>
      </div>
    </section>
    <div v-if="Object.keys(errors).length" class="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
      <div v-for="(error, name) in errors" :key="name">
        <strong>{{ name }}:</strong> {{ error }}
      </div>
    </div>
    <section v-if="editorOpen" class="mb-4 overflow-hidden rounded-lg border">
      <div class="border-b bg-muted/30 px-4 py-3">
        <h3 class="text-sm font-medium">{{ t("consul.ui.register") }}</h3>
        <p class="mt-1 text-xs text-amber-700 dark:text-amber-300">{{ t("consul.ui.checkRegistrationHint", { node: agentTarget?.node || t("consul.ui.targetAgent") }) }}</p>
      </div>
      <div class="grid gap-x-5 gap-y-4 p-4 md:grid-cols-3">
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.name") }}</Label
          ><Input v-model="form.name" class="h-9" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.id") }}</Label
          ><Input v-model="form.id" class="h-9" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.serviceId") }}</Label
          ><Input v-model="form.serviceId" class="h-9" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.type") }}</Label
          ><select v-model="form.type" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
            <option value="ttl">{{ t("consul.ui.ttl") }}</option>
            <option value="http">{{ t("consul.ui.http") }}</option>
            <option value="tcp">{{ t("consul.ui.tcp") }}</option>
            <option value="grpc">{{ t("consul.ui.grpc") }}</option>
            <option value="docker">{{ t("consul.ui.docker") }}</option>
            <option value="script">{{ t("consul.ui.script") }}</option>
          </select>
        </div>
        <div v-if="form.type === 'ttl'" class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.ttl") }}</Label
          ><Input v-model="form.ttl" class="h-9" />
        </div>
        <div v-else-if="form.type === 'script'" class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.arguments") }}</Label
          ><Input v-model="form.args" class="h-9" />
        </div>
        <div v-else class="space-y-1.5">
          <Label class="text-xs">{{ form.type === "docker" ? t("consul.ui.containerId") : t("consul.ui.endpoint") }}</Label
          ><Input v-model="form.endpoint" class="h-9" />
        </div>
        <template v-if="form.type !== 'ttl'">
          <div class="space-y-1.5">
            <Label class="text-xs">{{ t("consul.ui.interval") }}</Label
            ><Input v-model="form.interval" class="h-9" />
          </div>
          <div class="space-y-1.5">
            <Label class="text-xs">{{ t("consul.ui.timeout") }}</Label
            ><Input v-model="form.timeout" class="h-9" />
          </div>
          <div v-if="form.type === 'docker'" class="space-y-1.5">
            <Label class="text-xs">{{ t("consul.ui.commandArguments") }}</Label
            ><Input v-model="form.args" class="h-9" />
          </div>
        </template>
      </div>
      <div class="flex justify-end gap-2 border-t bg-muted/10 px-4 py-3">
        <Button size="sm" variant="outline" @click="editorOpen = false">{{ t("consul.ui.cancel") }}</Button
        ><Button size="sm" :disabled="saving || !canAgentWrite || !form.name.trim()" @click="registerCheck"><Loader2 v-if="saving" class="mr-1 h-3.5 w-3.5 animate-spin" />{{ t("consul.ui.registerOn", { node: agentTarget?.node || t("consul.ui.targetAgent") }) }}</Button>
      </div>
    </section>
    <section class="mb-4 overflow-hidden rounded-lg border">
      <div class="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2.5">
        <div class="flex items-center gap-2 text-sm font-medium">
          <span>{{ browseMode === "state" ? t("consul.ui.clusterHealth") : browseMode === "node" ? t("consul.ui.nodeHealth", { node: browseName || "-" }) : t("consul.ui.serviceHealth", { service: browseName || "-" }) }}</span
          ><Badge variant="secondary">{{ filteredChecks.length }}</Badge>
        </div>
        <ConsulListPagination
          :total="filteredChecks.length"
          :page="checkPage"
          :page-size="CONSUL_LIST_PAGE_SIZE"
          @update:page="
            checkPage = $event;
            selectedCheck = null;
          "
        />
      </div>
      <button
        v-for="check in pagedChecks"
        :key="`${check.Node}-${check.CheckID}`"
        type="button"
        class="grid min-h-16 w-full grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 border-b px-4 py-3 text-left text-xs last:border-0 hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none"
        :class="selectedCheck?.CheckID === check.CheckID && selectedCheck?.Node === check.Node && 'bg-muted/40'"
        :aria-expanded="selectedCheck?.CheckID === check.CheckID && selectedCheck?.Node === check.Node"
        @click="selectCheck(check)"
      >
        <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted/60"
          ><CircleCheck v-if="check.Status === 'passing' && !check.Maintenance" class="h-4 w-4 text-emerald-600" /><TriangleAlert v-else-if="check.Status === 'warning' || check.Maintenance" class="h-4 w-4 text-amber-600" /><CircleX v-else class="h-4 w-4 text-destructive"
        /></span>
        <span class="grid min-w-0 gap-x-8 gap-y-2 md:grid-cols-[minmax(12rem,1.1fr)_minmax(10rem,.75fr)] xl:grid-cols-[minmax(14rem,1fr)_minmax(10rem,.65fr)_minmax(14rem,1.15fr)]">
          <span class="min-w-0">
            <span class="flex min-w-0 flex-wrap items-center gap-2"
              ><span class="truncate font-medium">{{ check.Name }}</span
              ><Badge variant="outline" class="h-5 px-1.5 text-[10px]" :class="statusClass(check)">{{ statusLabel(check) }}</Badge
              ><Badge variant="secondary" class="h-5 px-1.5 text-[10px]">{{ checkTypeLabel(checkType(check)) }}</Badge></span
            >
            <span class="mt-1 block truncate font-mono text-[11px] text-muted-foreground" :title="check.CheckID">{{ check.CheckID }}</span>
          </span>
          <span class="min-w-0">
            <span class="block text-[10px] uppercase tracking-wide text-muted-foreground">{{ check.ServiceID ? t("consul.ui.service") : t("consul.ui.node") }}</span>
            <span class="mt-1 block truncate font-medium" :title="check.ServiceName || check.Node">{{ check.ServiceName || check.Node }}</span>
            <span v-if="check.ServiceID" class="mt-0.5 block truncate text-muted-foreground" :title="check.Node">{{ check.Node }}</span>
          </span>
          <span class="min-w-0 md:col-span-2 xl:col-span-1">
            <span class="block text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("consul.ui.output") }}</span>
            <span class="mt-1 block truncate text-muted-foreground" :title="check.Output || check.Notes">{{ check.Output || check.Notes || "-" }}</span>
          </span>
        </span>
      </button>
      <div v-if="!filteredChecks.length && !loading" class="px-3 py-8 text-center text-xs text-muted-foreground">{{ t("consul.ui.noMatchingHealthChecks") }}</div>
      <div v-if="loading" class="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.ui.loading") }}</div>
    </section>
    <section v-if="selectedCheck" class="mb-4 overflow-hidden rounded-lg border">
      <div class="flex items-center justify-between border-b bg-muted/30 px-3 py-2.5 text-sm font-medium">
        <span>{{ t("consul.ui.checkDetails", { check: selectedCheck.Name }) }}</span
        ><Button size="icon" variant="ghost" class="h-7 w-7" :title="t('consul.ui.close')" @click="selectedCheck = null"><CircleX class="h-3.5 w-3.5" /></Button>
      </div>
      <dl class="grid text-xs md:grid-cols-2">
        <div class="border-b px-3 py-3 md:border-r">
          <dt class="text-muted-foreground">{{ t("consul.ui.checkId") }}</dt>
          <dd class="mt-1 break-all font-mono">{{ selectedCheck.CheckID }}</dd>
        </div>
        <div class="border-b px-3 py-3">
          <dt class="text-muted-foreground">{{ t("consul.ui.serviceId") }}</dt>
          <dd class="mt-1 break-all font-mono">{{ selectedCheck.ServiceID || "-" }}</dd>
        </div>
        <div class="border-b px-3 py-3 md:border-r">
          <dt class="text-muted-foreground">{{ t("consul.ui.notes") }}</dt>
          <dd class="mt-1 whitespace-pre-wrap break-words">{{ selectedCheck.Notes || "-" }}</dd>
        </div>
        <div class="border-b px-3 py-3">
          <dt class="text-muted-foreground">{{ t("consul.ui.output") }}</dt>
          <dd class="mt-1 whitespace-pre-wrap break-words">{{ selectedCheck.Output || "-" }}</dd>
        </div>
        <div class="border-b px-3 py-3 md:border-r">
          <dt class="text-muted-foreground">{{ t("consul.ui.definition") }}</dt>
          <dd class="mt-1 break-all font-mono">{{ JSON.stringify(selectedCheck.Definition) }}</dd>
        </div>
        <div class="border-b px-3 py-3">
          <dt class="text-muted-foreground">{{ t("consul.ui.indexes") }}</dt>
          <dd class="mt-1 font-mono">{{ selectedCheck.CreateIndex }} / {{ selectedCheck.ModifyIndex }}</dd>
        </div>
      </dl>
    </section>
    <section v-if="browseMode === 'service' && serviceInstances.length" class="mb-4 overflow-hidden rounded-lg border">
      <div class="flex items-center justify-between border-b bg-muted/30 px-3 py-2.5">
        <div class="flex items-center gap-2 text-sm font-medium">
          <span>{{ t("consul.ui.serviceInstances") }}</span
          ><Badge variant="secondary">{{ serviceInstances.length }}</Badge>
        </div>
        <ConsulListPagination :total="serviceInstances.length" :page="serviceInstancePage" :page-size="CONSUL_LIST_PAGE_SIZE" @update:page="serviceInstancePage = $event" />
      </div>
      <div v-for="instance in pagedServiceInstances" :key="`${instance.Node.Node}-${instance.Service.ID}`" class="border-b px-3 py-2.5 text-xs last:border-0">
        <span class="font-medium">{{ instance.Node.Node }}</span
        ><span class="ml-2 text-muted-foreground">{{ instance.Service.Address || instance.Node.Address }}:{{ instance.Service.Port }} · {{ instance.Service.ID }}</span>
      </div>
    </section>
    <section class="overflow-hidden rounded-lg border">
      <div class="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2.5">
        <div class="flex items-center gap-2 text-sm font-medium">
          <span>{{ t("consul.ui.localAgentChecks") }}</span
          ><Badge variant="secondary"
            >{{ filteredLocalChecks.length }}<span v-if="hasActiveHealthFilters"> / {{ localCheckItems.length }}</span></Badge
          >
        </div>
        <ConsulListPagination :total="filteredLocalChecks.length" :page="localCheckPage" :page-size="CONSUL_LIST_PAGE_SIZE" @update:page="localCheckPage = $event" />
      </div>
      <div v-for="check in pagedLocalChecks" :key="check.CheckID" class="grid min-h-16 gap-3 border-b px-4 py-3 text-xs last:border-0 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div class="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 sm:grid-cols-[2rem_minmax(12rem,1fr)_minmax(10rem,.7fr)] xl:grid-cols-[2rem_minmax(13rem,.9fr)_minmax(10rem,.65fr)_minmax(13rem,1fr)]">
          <span class="flex h-8 w-8 items-center justify-center rounded-full bg-muted/60"
            ><CircleCheck v-if="check.Status === 'passing' && !check.Maintenance" class="h-4 w-4 text-emerald-600" /><TriangleAlert v-else-if="check.Status === 'warning' || check.Maintenance" class="h-4 w-4 text-amber-600" /><CircleX v-else class="h-4 w-4 text-destructive"
          /></span>
          <div class="min-w-0">
            <div class="flex min-w-0 flex-wrap items-center gap-2">
              <span class="truncate font-medium">{{ check.Name }}</span
              ><Badge variant="outline" class="h-5 px-1.5 text-[10px]" :class="statusClass(check)">{{ statusLabel(check) }}</Badge
              ><Badge variant="secondary" class="h-5 px-1.5 text-[10px]">{{ checkTypeLabel(checkType(check)) }}</Badge>
            </div>
            <div class="mt-1 truncate font-mono text-[11px] text-muted-foreground" :title="check.CheckID">{{ check.CheckID }}</div>
          </div>
          <div class="col-start-2 min-w-0 sm:col-start-auto">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ check.ServiceID ? t("consul.ui.service") : t("consul.ui.node") }}</div>
            <div class="mt-1 truncate font-medium" :title="check.ServiceName || check.Node">{{ check.ServiceName || check.Node }}</div>
            <div v-if="check.ServiceID" class="mt-0.5 truncate text-muted-foreground" :title="check.Node">{{ check.Node }}</div>
          </div>
          <div class="col-start-2 min-w-0 sm:col-span-2 xl:col-span-1 xl:col-start-auto">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground">{{ t("consul.ui.output") }}</div>
            <div class="mt-1 truncate text-muted-foreground" :title="check.Output || check.Notes">{{ check.Output || check.Notes || "-" }}</div>
          </div>
        </div>
        <div class="flex shrink-0 items-center justify-end gap-0.5 border-t pt-2 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
          <template v-if="check.Definition?.TTL"
            ><Button size="icon" variant="ghost" class="h-7 w-7 text-emerald-600" :disabled="!canAgentWrite" :title="t('consul.ui.ttlPass')" @click="updateTtl(check.CheckID, 'passing')"><CircleCheck class="h-3.5 w-3.5" /></Button
            ><Button size="icon" variant="ghost" class="h-7 w-7 text-amber-600" :disabled="!canAgentWrite" :title="t('consul.ui.ttlWarn')" @click="updateTtl(check.CheckID, 'warning')"><TriangleAlert class="h-3.5 w-3.5" /></Button
            ><Button size="icon" variant="ghost" class="h-7 w-7 text-destructive" :disabled="!canAgentWrite" :title="t('consul.ui.ttlFail')" @click="updateTtl(check.CheckID, 'critical')"><CircleX class="h-3.5 w-3.5" /></Button
          ></template>
          <Button size="icon" variant="ghost" class="h-7 w-7 text-destructive" :disabled="!canAgentWrite" :title="t('consul.ui.deregister')" @click="deregister(check.CheckID)"><Trash2 class="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      <div v-if="!filteredLocalChecks.length && !loading" class="px-3 py-8 text-center text-xs text-muted-foreground">{{ t("consul.ui.noMatchingHealthChecks") }}</div>
    </section>
  </div>
</template>

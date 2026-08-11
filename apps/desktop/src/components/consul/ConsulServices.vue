<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { CircleCheck, Loader2, LockKeyhole, Pause, Plus, Radio, RefreshCcw, Search, ServerCog, Trash2, Wrench } from "@lucide/vue";
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
import type { ConsulAgentIdentity, ConsulAgentService, ConsulAgentServiceRegistration, ConsulCatalogNode, ConsulCatalogServiceNode, ConsulDomainWatchResponse, ConsulHealthCheck, ConsulNodeServices, ConsulScope } from "@/types/consul";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const store = useConnectionStore();
const consulStore = useConsulStore();
const services = ref<Record<string, string[]>>({});
const nodes = ref<ConsulCatalogNode[]>([]);
const localServices = ref<Record<string, ConsulAgentService>>({});
const localChecks = ref<Record<string, ConsulHealthCheck>>({});
const selectedLocalService = ref<ConsulAgentService | null>(null);
const identity = ref<ConsulAgentIdentity | null>(null);
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
const agentTargetStatus = computed<"verifying" | "writable" | "readonly">(() => {
  if (agentLoading.value && !identity.value) return "verifying";
  return canAgentWrite.value ? "writable" : "readonly";
});
const selected = ref("");
const selectedNode = ref("");
const browseMode = ref<"service" | "node">("service");
const browseFilter = ref("");
const localServiceFilter = ref("");
const instances = ref<ConsulCatalogServiceNode[]>([]);
const selectedCatalogInstanceKey = ref("");
const nodeServices = ref<ConsulNodeServices | null>(null);
const selectedNodeServiceId = ref("");
const browsePage = ref(1);
const catalogInstancePage = ref(1);
const nodeServicePage = ref(1);
const localServicePage = ref(1);
const errors = ref<Record<string, string>>({});
const loading = ref(false);
const agentLoading = ref(true);
const saving = ref(false);
const editorOpen = ref(false);
const maintenancePendingId = ref("");
const form = ref({ id: "", name: "", tags: "", address: "", port: 0 });
let sequence = 0;
const watchEnabled = ref(false);
const watchPaused = ref(false);
const watchIndex = ref<string | null>(null);
let watchConnectionId = "";
let watchScope: ConsulScope = { datacenter: "", namespace: "", partition: "" };
let watchGeneration = 0;
let servicesWatchId = "";
let instancesWatchId = "";
let nodesWatchId = "";
let nodeServicesWatchId = "";

const serviceNames = computed(() => Object.keys(services.value).sort());
const nodeNames = computed(() =>
  nodes.value
    .map((node) => node.Node)
    .filter(Boolean)
    .sort(),
);
const normalizedBrowseFilter = computed(() => browseFilter.value.trim().toLocaleLowerCase());
const filteredServiceNames = computed(() =>
  serviceNames.value.filter((name) => {
    const query = normalizedBrowseFilter.value;
    return !query || `${name} ${services.value[name]?.join(" ") || ""}`.toLocaleLowerCase().includes(query);
  }),
);
const filteredNodeNames = computed(() => nodeNames.value.filter((name) => !normalizedBrowseFilter.value || name.toLocaleLowerCase().includes(normalizedBrowseFilter.value)));
const localServiceItems = computed(() => Object.values(localServices.value).sort((left, right) => left.Service.localeCompare(right.Service) || left.ID.localeCompare(right.ID)));
const normalizedLocalServiceFilter = computed(() => localServiceFilter.value.trim().toLocaleLowerCase());
const filteredLocalServiceItems = computed(() =>
  localServiceItems.value.filter((service) => {
    const query = normalizedLocalServiceFilter.value;
    if (!query) return true;
    const metadata = Object.entries(service.Meta || {})
      .map(([key, value]) => `${key} ${value}`)
      .join(" ");
    return `${service.Service} ${service.ID} ${service.Address} ${service.Port} ${service.Tags.join(" ")} ${metadata}`.toLocaleLowerCase().includes(query);
  }),
);
const nodeServiceItems = computed(() => Object.values(nodeServices.value?.Services || {}).sort((left, right) => left.Service.localeCompare(right.Service) || left.ID.localeCompare(right.ID)));
const pagedServiceNames = computed(() => paginateConsulItems(filteredServiceNames.value, browsePage.value));
const pagedNodeNames = computed(() => paginateConsulItems(filteredNodeNames.value, browsePage.value));
const pagedCatalogInstances = computed(() => paginateConsulItems(instances.value, catalogInstancePage.value));
const pagedNodeServices = computed(() => paginateConsulItems(nodeServiceItems.value, nodeServicePage.value));
const pagedLocalServices = computed(() => paginateConsulItems(filteredLocalServiceItems.value, localServicePage.value));
const maintenanceServiceIds = computed(
  () =>
    new Set(
      Object.values(localChecks.value)
        .filter((check) => check.Type === "maintenance" || check.CheckID.startsWith("_service_maintenance:"))
        .map((check) => check.ServiceID || check.CheckID.slice("_service_maintenance:".length)),
    ),
);
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeCatalogServices(value: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(value).map(([name, tags]) => [name, [...tags].sort((left, right) => left.localeCompare(right))]));
}

function isServiceInMaintenance(id: string) {
  return maintenanceServiceIds.value.has(id);
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function watchId(kind: string) {
  return globalThis.crypto?.randomUUID?.() || `${kind}-${Date.now()}-${Math.random()}`;
}
function watchActive(operationId: string) {
  return watchEnabled.value && !watchPaused.value && watchConnectionId === props.connectionId && watchGeneration === consulStore.generation && operationId !== "";
}

async function stopWatches() {
  const operations = [servicesWatchId, instancesWatchId, nodesWatchId, nodeServicesWatchId].filter(Boolean);
  servicesWatchId = "";
  instancesWatchId = "";
  nodesWatchId = "";
  nodeServicesWatchId = "";
  await Promise.all(
    operations.map(async (operationId) => {
      consulStore.completeOperation(operationId);
      await api.consulCancelBlocking(watchConnectionId, watchScope, watchGeneration, operationId).catch(() => false);
    }),
  );
}

async function runServicesWatch(operationId: string) {
  let index: string | null = null;
  while (watchActive(operationId) && servicesWatchId === operationId) {
    try {
      const result = (await api.consulDomainWatch(watchConnectionId, {
        operationId,
        generation: watchGeneration,
        target: { kind: "catalogServices" },
        index,
        waitSeconds: 300,
      })) as ConsulDomainWatchResponse<Record<string, string[]>>;
      index = nextWatchIndex(index, result.metadata.index).index;
      watchIndex.value = index;
      if (result.changed || result.indexReset) {
        services.value = normalizeCatalogServices(result.items);
        if (!selected.value || !services.value[selected.value]) {
          selected.value = serviceNames.value[0] || "";
          await loadInstances();
          await startInstanceWatch();
        }
      }
    } catch (error) {
      if (watchActive(operationId) && !String(error).includes("CANCELLED")) errors.value = { ...errors.value, [t("consul.ui.watch")]: errorMessage(error) };
      break;
    }
  }
  consulStore.completeOperation(operationId);
}

async function runInstancesWatch(operationId: string, service: string) {
  let index: string | null = null;
  while (watchActive(operationId) && instancesWatchId === operationId && selected.value === service) {
    try {
      const result = (await api.consulDomainWatch(watchConnectionId, {
        operationId,
        generation: watchGeneration,
        target: { kind: "catalogServiceNodes", service },
        index,
        waitSeconds: 300,
      })) as ConsulDomainWatchResponse<ConsulCatalogServiceNode[]>;
      index = nextWatchIndex(index, result.metadata.index).index;
      watchIndex.value = index;
      if (result.changed || result.indexReset) instances.value = result.items;
    } catch (error) {
      if (watchActive(operationId) && !String(error).includes("CANCELLED")) errors.value = { ...errors.value, [t("consul.ui.watch")]: errorMessage(error) };
      break;
    }
  }
  consulStore.completeOperation(operationId);
}

async function runNodesWatch(operationId: string) {
  let index: string | null = null;
  while (watchActive(operationId) && nodesWatchId === operationId && browseMode.value === "node") {
    try {
      const result = (await api.consulDomainWatch(watchConnectionId, {
        operationId,
        generation: watchGeneration,
        target: { kind: "catalogNodes" },
        index,
        waitSeconds: 300,
      })) as ConsulDomainWatchResponse<ConsulCatalogNode[]>;
      index = nextWatchIndex(index, result.metadata.index).index;
      watchIndex.value = index;
      if (result.changed || result.indexReset) {
        nodes.value = result.items;
        if (!selectedNode.value || !nodeNames.value.includes(selectedNode.value)) {
          selectedNode.value = nodeNames.value[0] || "";
          await loadNodeServices();
          await startNodeServicesWatch();
        }
      }
    } catch (error) {
      if (watchActive(operationId) && !String(error).includes("CANCELLED")) errors.value = { ...errors.value, [t("consul.ui.watch")]: errorMessage(error) };
      break;
    }
  }
  consulStore.completeOperation(operationId);
}

async function runNodeServicesWatch(operationId: string, node: string) {
  let index: string | null = null;
  while (watchActive(operationId) && nodeServicesWatchId === operationId && browseMode.value === "node" && selectedNode.value === node) {
    try {
      const result = (await api.consulDomainWatch(watchConnectionId, {
        operationId,
        generation: watchGeneration,
        target: { kind: "catalogNodeServices", node },
        index,
        waitSeconds: 300,
      })) as ConsulDomainWatchResponse<ConsulNodeServices>;
      index = nextWatchIndex(index, result.metadata.index).index;
      watchIndex.value = index;
      if (result.changed || result.indexReset) nodeServices.value = result.items;
    } catch (error) {
      if (watchActive(operationId) && !String(error).includes("CANCELLED")) errors.value = { ...errors.value, [t("consul.ui.watch")]: errorMessage(error) };
      break;
    }
  }
  consulStore.completeOperation(operationId);
}

async function startInstanceWatch() {
  if (!watchEnabled.value || watchPaused.value || !selected.value) return;
  if (instancesWatchId) await stopInstanceWatch();
  const operationId = watchId("consul-catalog-instances");
  instancesWatchId = operationId;
  consulStore.registerOperation(operationId);
  void runInstancesWatch(operationId, selected.value);
}

async function stopInstanceWatch() {
  const operationId = instancesWatchId;
  instancesWatchId = "";
  if (!operationId) return;
  consulStore.completeOperation(operationId);
  await api.consulCancelBlocking(watchConnectionId, watchScope, watchGeneration, operationId).catch(() => false);
}

async function startNodeServicesWatch() {
  if (!watchEnabled.value || watchPaused.value || !selectedNode.value || browseMode.value !== "node") return;
  if (nodeServicesWatchId) {
    const previousOperationId = nodeServicesWatchId;
    nodeServicesWatchId = "";
    consulStore.completeOperation(previousOperationId);
    await api.consulCancelBlocking(watchConnectionId, watchScope, watchGeneration, previousOperationId).catch(() => false);
  }
  const operationId = watchId("consul-catalog-node-services");
  nodeServicesWatchId = operationId;
  consulStore.registerOperation(operationId);
  void runNodeServicesWatch(operationId, selectedNode.value);
}

async function startWatches() {
  if ((servicesWatchId || nodesWatchId) && watchEnabled.value && !watchPaused.value) return;
  watchEnabled.value = true;
  watchPaused.value = false;
  watchConnectionId = props.connectionId;
  watchScope = currentScope();
  consulStore.bindConnection(watchConnectionId, watchScope);
  watchGeneration = consulStore.generation;
  if (browseMode.value === "service") {
    servicesWatchId = watchId("consul-catalog-services");
    consulStore.registerOperation(servicesWatchId);
    void runServicesWatch(servicesWatchId);
    await startInstanceWatch();
  } else {
    nodesWatchId = watchId("consul-catalog-nodes");
    consulStore.registerOperation(nodesWatchId);
    void runNodesWatch(nodesWatchId);
    await startNodeServicesWatch();
  }
}

async function pauseWatches() {
  watchPaused.value = true;
  await stopWatches();
}

async function independent(name: string, action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    errors.value = { ...errors.value, [name]: errorMessage(error) };
  }
}

async function load() {
  const current = ++sequence;
  loading.value = true;
  agentLoading.value = true;
  errors.value = {};
  // Catalog browsing must remain responsive even when an Agent endpoint is slow or unavailable.
  // The local-Agent section is supplementary, while Catalog is the primary navigation surface.
  await Promise.all([
    independent(t("consul.ui.catalogServices"), async () => {
      const result = await api.consulCatalogServices(props.connectionId);
      if (current === sequence) services.value = normalizeCatalogServices(result.items);
    }),
    independent(t("consul.ui.catalogNodes"), async () => {
      const result = await api.consulCatalogNodes(props.connectionId);
      if (current === sequence) nodes.value = result.items;
    }),
  ]);
  if (current === sequence) {
    if (!selected.value || !services.value[selected.value]) selected.value = serviceNames.value[0] || "";
    if (!selectedNode.value || !nodeNames.value.includes(selectedNode.value)) selectedNode.value = nodeNames.value[0] || "";
    loading.value = false;
    if (browseMode.value === "service") await loadInstances();
    else await loadNodeServices();
  }
  void loadAgentData(current);
}

async function loadAgentData(current = sequence) {
  agentLoading.value = true;
  await Promise.all([
    independent(t("consul.ui.agent"), async () => {
      const result = await withTimeout(api.consulAgentSelf(props.connectionId), 8_000, t("consul.ui.agentIdentityRequestTimedOut"));
      if (current === sequence) identity.value = result;
    }),
    independent(t("consul.ui.localAgentServices"), async () => {
      const result = await withTimeout(api.consulAgentServices(props.connectionId), 8_000, t("consul.ui.localServicesRequestTimedOut"));
      if (current === sequence) localServices.value = result;
    }),
    independent(t("consul.ui.localAgentChecks"), async () => {
      const result = await withTimeout(api.consulAgentChecks(props.connectionId), 8_000, t("consul.ui.localChecksRequestTimedOut"));
      if (current === sequence) localChecks.value = result;
    }),
  ]);
  if (current === sequence) agentLoading.value = false;
}

async function selectService(service: string) {
  selected.value = service;
  await loadInstances();
  await startInstanceWatch();
}

async function selectNode(node: string) {
  selectedNode.value = node;
  await loadNodeServices();
  await startNodeServicesWatch();
}

async function loadInstances() {
  instances.value = [];
  catalogInstancePage.value = 1;
  selectedCatalogInstanceKey.value = "";
  const service = selected.value;
  if (!service) return;
  await independent(t("consul.ui.serviceInstances"), async () => {
    const result = await api.consulCatalogServiceNodes(props.connectionId, service);
    if (selected.value === service) instances.value = result.items;
  });
}

function catalogInstanceKey(item: ConsulCatalogServiceNode) {
  return `${item.Node}\u0000${item.ServiceID}`;
}

function toggleCatalogInstance(item: ConsulCatalogServiceNode) {
  const key = catalogInstanceKey(item);
  selectedCatalogInstanceKey.value = selectedCatalogInstanceKey.value === key ? "" : key;
}

async function loadNodeServices() {
  nodeServices.value = null;
  nodeServicePage.value = 1;
  selectedNodeServiceId.value = "";
  const node = selectedNode.value;
  if (!node) return;
  await independent(t("consul.ui.nodeServices"), async () => {
    const result = await api.consulCatalogNodeServices(props.connectionId, node);
    if (selectedNode.value === node) nodeServices.value = result.items;
  });
}

function toggleNodeService(id: string) {
  selectedNodeServiceId.value = selectedNodeServiceId.value === id ? "" : id;
}

function updateCatalogInstancePage(page: number) {
  catalogInstancePage.value = page;
  selectedCatalogInstanceKey.value = "";
}

function updateNodeServicePage(page: number) {
  nodeServicePage.value = page;
  selectedNodeServiceId.value = "";
}

function updateLocalServicePage(page: number) {
  localServicePage.value = page;
  selectedLocalService.value = null;
}

async function switchBrowseMode(mode: "service" | "node") {
  if (browseMode.value === mode) return;
  const resume = watchEnabled.value && !watchPaused.value;
  await stopWatches();
  browseMode.value = mode;
  if (mode === "service") await loadInstances();
  else await loadNodeServices();
  if (resume) await startWatches();
}

async function openLocalService(id: string) {
  if (selectedLocalService.value?.ID === id) {
    selectedLocalService.value = null;
    return;
  }
  await independent(t("consul.ui.localServiceDetails"), async () => {
    selectedLocalService.value = await api.consulAgentService(props.connectionId, id);
  });
}

async function registerService() {
  if (!canAgentWrite.value || !form.value.name.trim()) return;
  saving.value = true;
  try {
    const registration: ConsulAgentServiceRegistration = {
      id: form.value.id.trim(),
      name: form.value.name.trim(),
      tags: form.value.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      address: form.value.address.trim(),
      port: Number(form.value.port) || 0,
      meta: {},
      weights: { Passing: 1, Warning: 1 },
      kind: "",
      enableTagOverride: false,
      proxy: null,
      checks: [],
    };
    await api.consulAgentRegisterService(props.connectionId, registration);
    editorOpen.value = false;
    await load();
  } catch (error) {
    errors.value = { ...errors.value, [t("consul.ui.writeOperation")]: errorMessage(error) };
  } finally {
    saving.value = false;
  }
}

async function deregister(id: string) {
  if (!canAgentWrite.value || !window.confirm(t("consul.ui.deregisterService", { id, node: agentTarget.value?.node || t("consul.ui.targetAgent") }))) return;
  await independent(t("consul.ui.writeOperation"), async () => {
    await api.consulAgentDeregisterService(props.connectionId, id);
    await load();
  });
}

async function maintenance(id: string, enable: boolean) {
  if (!canAgentWrite.value) return;
  maintenancePendingId.value = id;
  try {
    await independent(t("consul.ui.writeOperation"), async () => {
      await api.consulAgentServiceMaintenance(props.connectionId, id, enable, t("consul.ui.maintenanceReason"));
      await loadAgentData();
    });
  } finally {
    maintenancePendingId.value = "";
  }
}

watch([browseFilter, browseMode], () => {
  browsePage.value = 1;
});
watch(localServiceFilter, () => {
  localServicePage.value = 1;
  selectedLocalService.value = null;
});
watch(filteredServiceNames, (items) => {
  if (browseMode.value === "service") browsePage.value = clampConsulPage(browsePage.value, items.length);
});
watch(filteredNodeNames, (items) => {
  if (browseMode.value === "node") browsePage.value = clampConsulPage(browsePage.value, items.length);
});
watch(instances, (items) => {
  catalogInstancePage.value = clampConsulPage(catalogInstancePage.value, items.length);
});
watch(nodeServiceItems, (items) => {
  nodeServicePage.value = clampConsulPage(nodeServicePage.value, items.length);
});
watch(filteredLocalServiceItems, (items) => {
  localServicePage.value = clampConsulPage(localServicePage.value, items.length);
});
watch(
  () => props.connectionId,
  async () => {
    await stopWatches();
    watchEnabled.value = false;
    watchPaused.value = false;
    watchIndex.value = null;
    identity.value = null;
    agentLoading.value = true;
    browsePage.value = 1;
    catalogInstancePage.value = 1;
    nodeServicePage.value = 1;
    localServicePage.value = 1;
    await load();
  },
);
onMounted(load);
onDeactivated(() => {
  watchPaused.value = true;
  void stopWatches();
});
onBeforeUnmount(() => {
  void stopWatches();
});
defineExpose({ refresh: () => (void load(), true) });
</script>

<template>
  <div class="flex h-full min-h-0">
    <aside class="flex w-64 shrink-0 flex-col border-r bg-muted/10">
      <div class="shrink-0 border-b bg-background">
        <div class="flex h-11 items-center justify-between px-3">
          <div class="text-sm font-medium">{{ browseMode === "service" ? t("consul.ui.catalogServices") : t("consul.ui.catalogNodes") }}</div>
          <Button size="icon" variant="ghost" class="h-7 w-7" :disabled="loading" :title="t('consul.ui.refresh')" @click="load"><RefreshCcw class="h-3.5 w-3.5" /></Button>
        </div>
        <div class="grid grid-cols-2 px-3 pb-2 text-xs">
          <Button size="sm" class="h-7 rounded-r-none" :variant="browseMode === 'service' ? 'default' : 'outline'" @click="switchBrowseMode('service')">{{ t("consul.ui.service") }}</Button>
          <Button size="sm" class="h-7 rounded-l-none" :variant="browseMode === 'node' ? 'default' : 'outline'" @click="switchBrowseMode('node')">{{ t("consul.ui.node") }}</Button>
        </div>
        <div class="relative px-3 pb-3">
          <Search class="pointer-events-none absolute left-5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input v-model="browseFilter" class="h-8 pl-7 text-xs" :placeholder="browseMode === 'service' ? t('consul.ui.searchAllServices') : t('consul.ui.searchAllNodes')" />
        </div>
      </div>
      <div class="min-h-0 flex-1 overflow-auto py-1">
        <template v-if="browseMode === 'service'">
          <Button v-for="name in pagedServiceNames" :key="name" type="button" size="sm" :variant="selected === name ? 'secondary' : 'ghost'" class="h-auto min-h-11 w-full justify-start rounded-none px-3 py-2 text-left text-xs" @click="selectService(name)">
            <span class="min-w-0 flex-1 truncate font-medium" :title="name">{{ name }}</span>
          </Button>
          <div v-if="!filteredServiceNames.length && !loading" class="p-3 text-xs text-muted-foreground">{{ serviceNames.length ? t("consul.ui.noMatchingServices") : t("consul.ui.noVisibleServices") }}</div>
        </template>
        <template v-else>
          <Button v-for="name in pagedNodeNames" :key="name" type="button" size="sm" :variant="selectedNode === name ? 'secondary' : 'ghost'" class="h-auto min-h-11 w-full justify-start rounded-none px-3 py-2 text-left text-xs" @click="selectNode(name)"
            ><span class="truncate font-medium">{{ name }}</span></Button
          >
          <div v-if="!filteredNodeNames.length && !loading" class="p-3 text-xs text-muted-foreground">{{ nodeNames.length ? t("consul.ui.noMatchingNodes") : t("consul.ui.noVisibleNodes") }}</div>
        </template>
      </div>
      <div v-if="(browseMode === 'service' ? filteredServiceNames.length : filteredNodeNames.length) > CONSUL_LIST_PAGE_SIZE" class="shrink-0 border-t bg-background px-2 py-1">
        <ConsulListPagination compact :total="browseMode === 'service' ? filteredServiceNames.length : filteredNodeNames.length" :page="browsePage" :page-size="CONSUL_LIST_PAGE_SIZE" @update:page="browsePage = $event" />
      </div>
    </aside>

    <main class="min-w-0 flex-1 overflow-auto p-4">
      <header class="mb-4 flex flex-col gap-3 border-b pb-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="min-w-0">
          <div class="text-xs font-medium text-muted-foreground">{{ browseMode === "service" ? t("consul.ui.catalogServices") : t("consul.ui.catalogNodes") }}</div>
          <h2 class="mt-0.5 truncate text-lg font-semibold">{{ browseMode === "service" ? selected || t("consul.ui.services") : selectedNode || t("consul.ui.nodes") }}</h2>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge :variant="agentTargetStatus === 'writable' ? 'secondary' : 'outline'" :class="agentTargetStatus === 'writable' ? 'text-emerald-700 dark:text-emerald-300' : agentTargetStatus === 'readonly' ? 'border-amber-500/40 text-amber-700 dark:text-amber-300' : 'text-muted-foreground'">
              <Loader2 v-if="agentTargetStatus === 'verifying'" class="mr-1 h-3 w-3 animate-spin" /><ServerCog v-else class="mr-1 h-3 w-3" />{{
                agentTargetStatus === "verifying" ? t("consul.ui.agentTargetVerifying") : t("consul.ui.agentTarget", { target: canAgentWrite && agentTarget ? `${agentTarget.node} (${agentTarget.address})` : t("consul.ui.unknownWritesDisabled") })
              }}
            </Badge>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <span v-if="watchEnabled" class="hidden text-xs text-muted-foreground lg:inline">{{ watchPaused ? t("consul.ui.watchPaused") : t("consul.ui.watchingIndex", { index: watchIndex || "1" }) }}</span>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" :title="watchEnabled && !watchPaused ? t('consul.ui.pauseWatch') : t('consul.ui.startWatch')" @click="watchEnabled && !watchPaused ? pauseWatches() : startWatches()"
            ><Pause v-if="watchEnabled && !watchPaused" class="h-3.5 w-3.5" /><Radio v-else class="h-3.5 w-3.5" />{{ watchEnabled && !watchPaused ? t("consul.ui.pauseWatch") : t("consul.ui.startWatch") }}</Button
          >
          <Button size="sm" class="h-8 gap-1.5" :disabled="!canAgentWrite" :title="canAgentWrite ? undefined : t('consul.ui.unknownWritesDisabled')" @click="editorOpen = !editorOpen"><Plus class="h-3.5 w-3.5" />{{ t("consul.ui.register") }}</Button>
        </div>
      </header>

      <div v-if="Object.keys(errors).length" class="mb-3 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
        <div v-for="(error, name) in errors" :key="name">
          <strong>{{ name }}:</strong> {{ error }}
        </div>
      </div>

      <section v-if="editorOpen" class="mb-4 rounded-lg border bg-muted/10 p-4 sm:p-5">
        <p class="mb-4 text-xs leading-5 text-amber-700 dark:text-amber-300">{{ t("consul.ui.registrationHint") }}</p>
        <div class="grid gap-x-5 gap-y-4 md:grid-cols-2">
          <div class="space-y-1.5">
            <Label class="block text-xs font-medium">{{ t("consul.ui.name") }}</Label
            ><Input v-model="form.name" class="h-9" />
          </div>
          <div class="space-y-1.5">
            <Label class="block text-xs font-medium">{{ t("consul.ui.id") }}</Label
            ><Input v-model="form.id" class="h-9" />
          </div>
          <div class="space-y-1.5">
            <Label class="block text-xs font-medium">{{ t("consul.ui.address") }}</Label
            ><Input v-model="form.address" class="h-9" />
          </div>
          <div class="space-y-1.5">
            <Label class="block text-xs font-medium">{{ t("consul.ui.port") }}</Label
            ><Input v-model.number="form.port" class="h-9" type="number" min="0" max="65535" />
          </div>
          <div class="space-y-1.5 md:col-span-2">
            <Label class="block text-xs font-medium">{{ t("consul.ui.tags") }}</Label
            ><Input v-model="form.tags" class="h-9" />
          </div>
        </div>
        <div class="mt-5 flex justify-end gap-2 border-t pt-4">
          <Button variant="outline" size="sm" @click="editorOpen = false">{{ t("consul.ui.cancel") }}</Button
          ><Button size="sm" :disabled="saving || !canAgentWrite || !form.name.trim()" @click="registerService"><Loader2 v-if="saving" class="mr-1 h-3.5 w-3.5 animate-spin" />{{ t("consul.ui.registerOn", { node: agentTarget?.node || t("consul.ui.targetAgent") }) }}</Button>
        </div>
      </section>

      <section class="mb-4 overflow-hidden rounded-lg border">
        <div class="flex items-center justify-between gap-3 border-b bg-muted/30 px-3 py-2.5">
          <div class="flex items-center gap-2 text-sm font-medium">
            <span>{{ browseMode === "service" ? t("consul.ui.catalogInstances") : t("consul.ui.nodeServices") }}</span
            ><Badge variant="secondary">{{ browseMode === "service" ? instances.length : nodeServiceItems.length }}</Badge>
          </div>
          <ConsulListPagination v-if="browseMode === 'service'" :total="instances.length" :page="catalogInstancePage" :page-size="CONSUL_LIST_PAGE_SIZE" @update:page="updateCatalogInstancePage" />
          <ConsulListPagination v-else :total="nodeServiceItems.length" :page="nodeServicePage" :page-size="CONSUL_LIST_PAGE_SIZE" @update:page="updateNodeServicePage" />
        </div>
        <div v-if="browseMode === 'service'" class="overflow-x-auto">
          <table class="w-full table-fixed text-xs">
            <thead>
              <tr class="border-b bg-muted/10 text-left text-muted-foreground">
                <th class="w-[24%] px-3 py-2.5 font-medium">{{ t("consul.ui.node") }}</th>
                <th class="w-[17%] px-3 py-2.5 font-medium">{{ t("consul.ui.serviceId") }}</th>
                <th class="w-[18%] px-3 py-2.5 font-medium">{{ t("consul.ui.address") }}</th>
                <th class="w-[18%] px-3 py-2.5 font-medium">{{ t("consul.ui.tags") }}</th>
                <th class="w-[23%] px-3 py-2.5 font-medium">{{ t("consul.ui.metadata") }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="item in pagedCatalogInstances" :key="catalogInstanceKey(item)">
                <tr
                  role="button"
                  tabindex="0"
                  class="cursor-pointer border-b outline-none hover:bg-muted/20 focus-visible:bg-muted/30"
                  :class="selectedCatalogInstanceKey === catalogInstanceKey(item) && 'bg-muted/20'"
                  :aria-expanded="selectedCatalogInstanceKey === catalogInstanceKey(item)"
                  @click="toggleCatalogInstance(item)"
                  @keydown.enter.prevent="toggleCatalogInstance(item)"
                  @keydown.space.prevent="toggleCatalogInstance(item)"
                >
                  <td class="px-3 py-3">
                    <div class="truncate font-medium">{{ item.Node }}</div>
                    <div
                      class="mt-0.5 truncate text-muted-foreground"
                      :title="
                        Object.entries(item.NodeMeta)
                          .map(([key, value]) => `${key}=${value}`)
                          .join(', ')
                      "
                    >
                      {{ item.Datacenter }} · {{ Object.keys(item.NodeMeta).length }} {{ t("consul.ui.metadata") }}
                    </div>
                  </td>
                  <td class="px-3 py-3 font-mono text-muted-foreground">
                    <span class="block truncate" :title="item.ServiceID">{{ item.ServiceID || "-" }}</span>
                  </td>
                  <td class="px-3 py-3 font-mono">
                    <span class="block truncate">{{ item.ServiceAddress || item.Address }}:{{ item.ServicePort }}</span>
                  </td>
                  <td class="px-3 py-3">
                    <div v-if="item.ServiceTags.length" class="flex flex-wrap gap-1">
                      <Badge v-for="tag in item.ServiceTags" :key="tag" variant="outline" class="h-5 px-1.5 text-[10px]">{{ tag }}</Badge>
                    </div>
                    <span v-else class="text-muted-foreground">-</span>
                  </td>
                  <td class="px-3 py-3">
                    <span
                      class="block truncate text-muted-foreground"
                      :title="
                        Object.entries(item.ServiceMeta)
                          .map(([key, value]) => `${key}=${value}`)
                          .join(', ')
                      "
                      >{{
                        Object.entries(item.ServiceMeta)
                          .map(([key, value]) => `${key}=${value}`)
                          .join(", ") || "-"
                      }}</span
                    >
                  </td>
                </tr>
                <tr v-if="selectedCatalogInstanceKey === catalogInstanceKey(item)" class="border-b bg-muted/10">
                  <td colspan="5" class="px-3 py-3">
                    <div class="grid overflow-hidden rounded-md border bg-background sm:grid-cols-4">
                      <div class="border-b px-3 py-2 sm:border-r">
                        <div class="text-muted-foreground">{{ t("consul.ui.serviceKind") }}</div>
                        <div class="mt-1 font-medium">{{ item.ServiceKind || t("consul.ui.standard") }}</div>
                      </div>
                      <div class="border-b px-3 py-2 sm:border-r">
                        <div class="text-muted-foreground">{{ t("consul.ui.indexes") }}</div>
                        <div class="mt-1 font-mono">{{ item.CreateIndex }} / {{ item.ModifyIndex }}</div>
                      </div>
                      <div class="border-b px-3 py-2 sm:border-r">
                        <div class="text-muted-foreground">{{ t("consul.ui.serviceWeights") }}</div>
                        <div class="mt-1 font-mono">{{ item.ServiceWeights.Passing }} / {{ item.ServiceWeights.Warning }}</div>
                      </div>
                      <div class="border-b px-3 py-2">
                        <div class="text-muted-foreground">{{ t("consul.ui.nodeId") }}</div>
                        <div class="mt-1 truncate font-mono" :title="item.ID">{{ item.ID || "-" }}</div>
                      </div>
                      <div class="border-b px-3 py-2 sm:col-span-4">
                        <div class="text-muted-foreground">{{ t("consul.ui.nodeMeta") }}</div>
                        <div class="mt-1 flex flex-wrap gap-1.5">
                          <code v-for="[key, value] in Object.entries(item.NodeMeta)" :key="key" class="rounded bg-muted px-1.5 py-0.5">{{ key }}={{ value }}</code
                          ><span v-if="!Object.keys(item.NodeMeta).length">-</span>
                        </div>
                      </div>
                      <div class="px-3 py-2 sm:col-span-4">
                        <div class="text-muted-foreground">{{ t("consul.ui.serviceMeta") }}</div>
                        <div class="mt-1 flex flex-wrap gap-1.5">
                          <code v-for="[key, value] in Object.entries(item.ServiceMeta)" :key="key" class="rounded bg-muted px-1.5 py-0.5">{{ key }}={{ value }}</code
                          ><span v-if="!Object.keys(item.ServiceMeta).length">-</span>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              </template>
              <tr v-if="!instances.length && !loading">
                <td colspan="5" class="px-3 py-8 text-center text-muted-foreground">{{ t("consul.ui.noVisibleServices") }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="p-3 text-xs">
          <div class="mb-3 flex flex-wrap gap-2 text-muted-foreground">
            <Badge variant="outline">{{ nodeServices?.Node.Address || "-" }}</Badge
            ><Badge variant="outline">{{ nodeServices?.Node.Datacenter || "-" }}</Badge>
          </div>
          <div
            class="mb-3 rounded-md bg-muted/30 px-2.5 py-2 text-muted-foreground"
            :title="
              Object.entries(nodeServices?.Node.NodeMeta || {})
                .map(([key, value]) => `${key}=${value}`)
                .join(', ')
            "
          >
            {{ t("consul.ui.nodeMeta") }} ·
            {{
              Object.entries(nodeServices?.Node.NodeMeta || {})
                .map(([key, value]) => `${key}=${value}`)
                .join(", ") || "-"
            }}
          </div>
          <div v-for="service in pagedNodeServices" :key="service.ID" class="border-t first:border-t-0">
            <button type="button" class="w-full px-1 py-2.5 text-left outline-none hover:bg-muted/20 focus-visible:bg-muted/30" :class="selectedNodeServiceId === service.ID && 'bg-muted/20'" :aria-expanded="selectedNodeServiceId === service.ID" @click="toggleNodeService(service.ID)">
              <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
                ><span class="font-medium">{{ service.Service }}</span
                ><code class="text-muted-foreground">{{ service.ID }}</code
                ><span class="font-mono text-muted-foreground">{{ service.Address || nodeServices?.Node.Address }}:{{ service.Port }}</span></span
              >
              <span
                class="mt-1 block truncate text-muted-foreground"
                :title="
                  Object.entries(service.Meta)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(', ')
                "
                >{{ t("consul.ui.serviceMeta") }} ·
                {{
                  Object.entries(service.Meta)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(", ") || "-"
                }}</span
              >
            </button>
            <div v-if="selectedNodeServiceId === service.ID" class="pb-3">
              <div class="grid overflow-hidden rounded-md border bg-background sm:grid-cols-2">
                <div class="border-b px-3 py-2 sm:border-r">
                  <div class="text-muted-foreground">{{ t("consul.ui.serviceWeights") }}</div>
                  <div class="mt-1 font-mono">{{ service.Weights.Passing }} / {{ service.Weights.Warning }}</div>
                </div>
                <div class="border-b px-3 py-2">
                  <div class="text-muted-foreground">{{ t("consul.ui.tags") }}</div>
                  <div class="mt-1 flex flex-wrap gap-1">
                    <Badge v-for="tag in service.Tags" :key="tag" variant="outline" class="h-5 px-1.5 text-[10px]">{{ tag }}</Badge
                    ><span v-if="!service.Tags.length">-</span>
                  </div>
                </div>
                <div class="border-b px-3 py-2 sm:col-span-2">
                  <div class="text-muted-foreground">{{ t("consul.ui.serviceMeta") }}</div>
                  <div class="mt-1 flex flex-wrap gap-1.5">
                    <code v-for="[key, value] in Object.entries(service.Meta)" :key="key" class="rounded bg-muted px-1.5 py-0.5">{{ key }}={{ value }}</code
                    ><span v-if="!Object.keys(service.Meta).length">-</span>
                  </div>
                </div>
                <div class="px-3 py-2 sm:col-span-2">
                  <div class="text-muted-foreground">{{ t("consul.ui.taggedAddresses") }}</div>
                  <div class="mt-1 flex flex-wrap gap-1.5">
                    <code v-for="[key, value] in Object.entries(service.TaggedAddresses)" :key="key" class="rounded bg-muted px-1.5 py-0.5">{{ key }}={{ value.Address }}:{{ value.Port }}</code
                    ><span v-if="!Object.keys(service.TaggedAddresses).length">-</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="!Object.keys(nodeServices?.Services || {}).length && !loading" class="py-6 text-center text-muted-foreground">{{ t("consul.ui.noVisibleServices") }}</div>
        </div>
      </section>

      <section class="overflow-hidden rounded-lg border">
        <div class="flex flex-wrap items-center gap-3 border-b bg-muted/30 px-3 py-2.5">
          <div class="flex shrink-0 items-center gap-2 text-sm font-medium">
            <span>{{ t("consul.ui.localAgentServices") }}</span
            ><Badge variant="secondary">{{ localServiceFilter.trim() ? `${filteredLocalServiceItems.length} / ${localServiceItems.length}` : localServiceItems.length }}</Badge>
          </div>
          <div class="relative min-w-52 flex-1 sm:max-w-md">
            <Search class="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
            <Input v-model="localServiceFilter" class="h-7 pl-8 text-xs" :placeholder="t('consul.ui.searchLocalServices')" />
          </div>
          <div class="ml-auto flex shrink-0 items-center gap-3">
            <ConsulListPagination :total="filteredLocalServiceItems.length" :page="localServicePage" :page-size="CONSUL_LIST_PAGE_SIZE" @update:page="updateLocalServicePage" />
            <Badge :variant="agentTargetStatus === 'writable' ? 'secondary' : 'outline'" :class="agentTargetStatus === 'writable' ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'"
              ><Loader2 v-if="agentTargetStatus === 'verifying'" class="mr-1 h-3 w-3 animate-spin" /><CircleCheck v-else-if="agentTargetStatus === 'writable'" class="mr-1 h-3 w-3" /><LockKeyhole v-else class="mr-1 h-3 w-3" />{{
                agentTargetStatus === "verifying" ? t("consul.ui.agentTargetVerifying") : agentTargetStatus === "writable" ? t("consul.ui.agentWriteReady") : t("consul.ui.agentReadOnly")
              }}</Badge
            >
          </div>
        </div>
        <div v-if="!canAgentWrite && (identity || !agentLoading)" class="flex items-start gap-2 border-b border-amber-300/70 bg-amber-50/70 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/20 dark:text-amber-200">
          <LockKeyhole class="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>{{ t("consul.ui.agentWriteDisabledHint", { target: identity ? `${identity.node} (${identity.address})` : t("consul.ui.unknownWritesDisabled") }) }}</span>
        </div>
        <div v-for="service in pagedLocalServices" :key="service.ID" class="border-b last:border-0" :class="selectedLocalService?.ID === service.ID && 'bg-muted/20'">
          <div class="grid gap-3 px-3 py-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <button type="button" class="flex min-w-0 items-start gap-3 text-left" :aria-expanded="selectedLocalService?.ID === service.ID" @click="openLocalService(service.ID)">
              <span class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted"><ServerCog class="h-4 w-4 text-muted-foreground" /></span
              ><span class="min-w-0 flex-1"
                ><span class="flex min-w-0 flex-wrap items-center gap-2"
                  ><span class="truncate font-medium">{{ service.Service }}</span
                  ><code class="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{{ service.ID }}</code
                  ><Badge v-if="isServiceInMaintenance(service.ID)" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300"><Wrench class="mr-1 h-3 w-3" />{{ t("consul.ui.maintenance") }}</Badge></span
                ><span class="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                  ><span class="font-mono">{{ service.Address || identity?.address }}:{{ service.Port }}</span
                  ><Badge v-for="tag in service.Tags" :key="tag" variant="outline" class="h-5 px-1.5 text-[10px]">{{ tag }}</Badge></span
                ></span
              >
            </button>
            <div v-if="canAgentWrite" class="flex shrink-0 items-center gap-1 lg:border-l lg:pl-3">
              <Button v-if="!isServiceInMaintenance(service.ID)" size="sm" variant="ghost" class="h-7 gap-1 px-2 text-xs" :disabled="maintenancePendingId === service.ID" :title="t('consul.ui.enableMaintenance')" @click.stop="maintenance(service.ID, true)"
                ><Loader2 v-if="maintenancePendingId === service.ID" class="h-3.5 w-3.5 animate-spin" /><Wrench v-else class="h-3.5 w-3.5" />{{ t("consul.ui.enableMaintenance") }}</Button
              ><Button v-else size="sm" variant="ghost" class="h-7 gap-1 px-2 text-xs text-amber-700 hover:text-amber-700 dark:text-amber-300" :disabled="maintenancePendingId === service.ID" :title="t('consul.ui.disableMaintenance')" @click.stop="maintenance(service.ID, false)"
                ><Loader2 v-if="maintenancePendingId === service.ID" class="h-3.5 w-3.5 animate-spin" /><CircleCheck v-else class="h-3.5 w-3.5" />{{ t("consul.ui.disableMaintenance") }}</Button
              ><Button size="sm" variant="ghost" class="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive" :title="t('consul.ui.deregister')" @click.stop="deregister(service.ID)"><Trash2 class="h-3.5 w-3.5" />{{ t("consul.ui.deregister") }}</Button>
            </div>
          </div>
          <div v-if="selectedLocalService?.ID === service.ID" class="border-t bg-background px-4 py-3 text-xs">
            <dl class="grid overflow-hidden rounded-md border sm:grid-cols-4">
              <div class="border-b px-3 py-2 sm:border-r">
                <dt class="text-muted-foreground">{{ t("consul.ui.kind") }}</dt>
                <dd class="mt-1 font-medium">{{ selectedLocalService.Kind || t("consul.ui.standard") }}</dd>
              </div>
              <div class="border-b px-3 py-2 sm:border-r">
                <dt class="text-muted-foreground">{{ t("consul.ui.datacenter") }}</dt>
                <dd class="mt-1 font-medium">{{ selectedLocalService.Datacenter || "-" }}</dd>
              </div>
              <div class="border-b px-3 py-2 sm:border-r">
                <dt class="text-muted-foreground">{{ t("consul.ui.enableTagOverride") }}</dt>
                <dd class="mt-1 font-mono">{{ selectedLocalService.EnableTagOverride }}</dd>
              </div>
              <div class="border-b px-3 py-2">
                <dt class="text-muted-foreground">{{ t("consul.ui.serviceWeights") }}</dt>
                <dd class="mt-1 font-mono">{{ selectedLocalService.Weights.Passing }} / {{ selectedLocalService.Weights.Warning }}</dd>
              </div>
              <div class="px-3 py-2 sm:col-span-4">
                <dt class="text-muted-foreground">{{ t("consul.ui.metadata") }}</dt>
                <dd class="mt-1 break-words font-mono">
                  {{
                    Object.entries(selectedLocalService.Meta)
                      .map(([key, value]) => `${key}=${value}`)
                      .join(", ") || "-"
                  }}
                </dd>
              </div>
            </dl>
          </div>
        </div>
        <div v-if="!localServiceItems.length && agentLoading" class="px-3 py-8 text-center text-xs text-muted-foreground">{{ t("consul.ui.loading") }}</div>
        <div v-else-if="!localServiceItems.length" class="flex flex-col items-center gap-2 px-3 py-8 text-center text-xs text-muted-foreground">
          <span>{{ t("consul.ui.noResources") }}</span
          ><Button size="sm" variant="outline" class="h-7" @click="loadAgentData()"><RefreshCcw class="mr-1 h-3.5 w-3.5" />{{ t("consul.ui.refresh") }}</Button>
        </div>
        <div v-else-if="!filteredLocalServiceItems.length" class="px-3 py-8 text-center text-xs text-muted-foreground">{{ t("consul.ui.noMatchingServices") }}</div>
      </section>
    </main>
  </div>
</template>

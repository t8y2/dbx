<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Activity, Boxes, KeyRound, Layers3, Network, RefreshCcw, ShieldCheck, Timer, Wrench, Gauge } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as api from "@/lib/backend/api";
import type { ConsulCapabilities } from "@/types/consul";
import { useConnectionStore } from "@/stores/connectionStore";
import { useConsulStore } from "@/stores/consulStore";
import { consulMeshWorkspaceVisible } from "@/lib/consul/meshVisibility";
import { useI18n } from "vue-i18n";

const ConsulKeyBrowser = defineAsyncComponent(() => import("@/components/consul/ConsulKeyBrowser.vue"));
const ConsulServices = defineAsyncComponent(() => import("@/components/consul/ConsulServices.vue"));
const ConsulHealth = defineAsyncComponent(() => import("@/components/consul/ConsulHealth.vue"));
const ConsulSessions = defineAsyncComponent(() => import("@/components/consul/ConsulSessions.vue"));
const ConsulAcl = defineAsyncComponent(() => import("@/components/consul/ConsulAcl.vue"));
const ConsulScope = defineAsyncComponent(() => import("@/components/consul/ConsulScope.vue"));
const ConsulMesh = defineAsyncComponent(() => import("@/components/consul/ConsulMesh.vue"));
const ConsulTools = defineAsyncComponent(() => import("@/components/consul/ConsulTools.vue"));
const ConsulOperator = defineAsyncComponent(() => import("@/components/consul/ConsulOperator.vue"));

type WorkspaceTab = "kv" | "services" | "health" | "sessions" | "acl" | "scope" | "mesh" | "tools" | "operator";
type Refreshable = { refresh?: () => boolean | Promise<unknown>; focusSearch?: () => boolean };
const props = defineProps<{ connectionId: string }>();
const connectionStore = useConnectionStore();
const consulStore = useConsulStore();
const { t } = useI18n();
const activeTab = ref<WorkspaceTab>("kv");
const keyRef = ref<Refreshable>();
const servicesRef = ref<Refreshable>();
const healthRef = ref<Refreshable>();
const sessionsRef = ref<Refreshable>();
const aclRef = ref<Refreshable>();
const scopeRef = ref<Refreshable>();
const meshRef = ref<Refreshable>();
const toolsRef = ref<Refreshable>();
const operatorRef = ref<Refreshable>();
const capabilities = ref<ConsulCapabilities | null>(null);
const discoveredDatacenters = ref<string[]>([]);
const scopeRevision = ref(0);
const scopeOpen = ref(false);
const scopeSaving = ref(false);
const scopeError = ref("");
const scopeDraft = ref({ datacenter: "", partition: "", namespace: "" });
const pendingSearchFocus = ref(false);
let contextSequence = 0;
const activeScope = computed(() => {
  const external = connectionStore.getConfig(props.connectionId)?.external_config;
  const config = external && typeof external === "object" && !Array.isArray(external) ? (external as Record<string, unknown>) : {};
  return {
    datacenter: String(config.datacenter || config.consulDatacenter || config.consul_datacenter || ""),
    partition: String(config.partition || config.consulPartition || config.consul_partition || ""),
    namespace: String(config.namespace || config.consulNamespace || config.consul_namespace || ""),
  };
});
const datacenterOptions = computed(() => [...new Set([activeScope.value.datacenter, capabilities.value?.datacenter || "", ...discoveredDatacenters.value].map((value) => value.trim()).filter(Boolean))]);
const resolvedDatacenter = computed(() => activeScope.value.datacenter || capabilities.value?.datacenter || datacenterOptions.value[0] || "-");
const enterpriseScopeAvailable = computed(() => capabilities.value?.namespaces === "supported" || capabilities.value?.partitions === "supported");
const aclVisible = computed(() => capabilities.value?.acl !== "disabled");
const scopeTabVisible = computed(() => enterpriseScopeAvailable.value);
const meshVisible = computed(() => consulMeshWorkspaceVisible(connectionStore.getConfig(props.connectionId)?.external_config));
const canChangeScope = computed(() => enterpriseScopeAvailable.value || datacenterOptions.value.length > 1);
const scopeLabel = computed(() => (enterpriseScopeAvailable.value ? `${resolvedDatacenter.value} / ${activeScope.value.partition || t("consul.ui.default")} / ${activeScope.value.namespace || t("consul.ui.default")}` : resolvedDatacenter.value));
const operatorVisible = computed(() => {
  const external = connectionStore.getConfig(props.connectionId)?.external_config;
  const config = external && typeof external === "object" && !Array.isArray(external) ? (external as Record<string, unknown>) : {};
  const capability = capabilities.value;
  const available = capability && [capability.operatorAutopilot, capability.operatorRaft, capability.operatorKeyring, capability.operatorUsage, capability.operatorLicense, capability.audit].some((status) => status === "supported");
  return Boolean(config.consulOperatorVisible) && Boolean(available);
});
function activeHandle() {
  return { kv: keyRef.value, services: servicesRef.value, health: healthRef.value, sessions: sessionsRef.value, acl: aclRef.value, scope: scopeRef.value, mesh: meshRef.value, tools: toolsRef.value, operator: operatorRef.value }[activeTab.value];
}
async function loadWorkspaceContext() {
  const sequence = ++contextSequence;
  const connectionId = props.connectionId;
  const [capabilityResult, datacenterResult] = await Promise.allSettled([api.consulCapabilities(connectionId), api.consulCatalogDatacenters(connectionId)]);
  if (sequence !== contextSequence || connectionId !== props.connectionId) return;
  capabilities.value = capabilityResult.status === "fulfilled" ? capabilityResult.value : null;
  discoveredDatacenters.value = datacenterResult.status === "fulfilled" ? [...new Set(datacenterResult.value.map((value) => value.trim()).filter(Boolean))] : [];
}
function openScopeSwitcher() {
  scopeDraft.value = {
    datacenter: resolvedDatacenter.value === "-" ? "" : resolvedDatacenter.value,
    partition: activeScope.value.partition,
    namespace: activeScope.value.namespace,
  };
  scopeError.value = "";
  scopeOpen.value = true;
}
async function applyScope() {
  const config = connectionStore.getConfig(props.connectionId);
  if (!config) return;
  scopeSaving.value = true;
  scopeError.value = "";
  const nextScope = {
    datacenter: scopeDraft.value.datacenter.trim(),
    partition: scopeDraft.value.partition.trim(),
    namespace: scopeDraft.value.namespace.trim(),
  };
  try {
    consulStore.bindConnection(props.connectionId, activeScope.value);
    consulStore.switchScope(nextScope);
    const currentExternal = config.external_config;
    const external = currentExternal && typeof currentExternal === "object" && !Array.isArray(currentExternal) ? ({ ...currentExternal } as Record<string, unknown>) : {};
    external.datacenter = nextScope.datacenter || undefined;
    external.partition = nextScope.partition || undefined;
    external.namespace = nextScope.namespace || undefined;
    await connectionStore.updateConnection({ ...config, external_config: external });
    scopeRevision.value += 1;
    scopeOpen.value = false;
    await loadWorkspaceContext();
  } catch (error) {
    scopeError.value = error instanceof Error ? error.message : String(error);
  } finally {
    scopeSaving.value = false;
  }
}
function focusSearch() {
  activeTab.value = "kv";
  pendingSearchFocus.value = true;
  void nextTick(() => {
    pendingSearchFocus.value = false;
    keyRef.value?.focusSearch?.();
  });
  return true;
}
function refresh() {
  const handle = activeHandle();
  if (!handle?.refresh) return false;
  void handle.refresh();
  return true;
}
watch(keyRef, (value) => {
  if (value && pendingSearchFocus.value)
    void nextTick(() => {
      pendingSearchFocus.value = false;
      value.focusSearch?.();
    });
});
watch([aclVisible, scopeTabVisible, meshVisible], () => {
  if (activeTab.value === "acl" && !aclVisible.value) activeTab.value = "kv";
  if (activeTab.value === "scope" && !scopeTabVisible.value) activeTab.value = "kv";
  if (activeTab.value === "mesh" && !meshVisible.value) activeTab.value = "kv";
});
watch(
  () => props.connectionId,
  () => {
    consulStore.bindConnection(props.connectionId, activeScope.value);
    void loadWorkspaceContext();
  },
);
onMounted(() => {
  consulStore.bindConnection(props.connectionId, activeScope.value);
  void loadWorkspaceContext();
});
onBeforeUnmount(() => {
  contextSequence += 1;
});
defineExpose({ focusSearch, refresh });
</script>

<template>
  <Tabs v-model="activeTab" class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <div class="min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        <TabsList class="h-8 w-max min-w-max justify-start bg-muted/60 p-0.5">
          <TabsTrigger value="kv" class="h-7 flex-none gap-1.5 px-3 text-xs"><KeyRound class="h-3.5 w-3.5" />{{ t("consul.workspace.kv") }}</TabsTrigger>
          <TabsTrigger value="services" class="h-7 flex-none gap-1.5 px-3 text-xs"><Boxes class="h-3.5 w-3.5" />{{ t("consul.workspace.services") }}</TabsTrigger>
          <TabsTrigger value="health" class="h-7 flex-none gap-1.5 px-3 text-xs"><Activity class="h-3.5 w-3.5" />{{ t("consul.workspace.health") }}</TabsTrigger>
          <TabsTrigger value="sessions" class="h-7 flex-none gap-1.5 px-3 text-xs"><Timer class="h-3.5 w-3.5" />{{ t("consul.workspace.sessions") }}</TabsTrigger>
          <TabsTrigger v-if="aclVisible" value="acl" class="h-7 flex-none gap-1.5 px-3 text-xs"><ShieldCheck class="h-3.5 w-3.5" />{{ t("consul.workspace.acl") }}</TabsTrigger>
          <TabsTrigger v-if="scopeTabVisible" value="scope" class="h-7 flex-none gap-1.5 px-3 text-xs"><Layers3 class="h-3.5 w-3.5" />{{ t("consul.workspace.scope") }}</TabsTrigger>
          <TabsTrigger v-if="meshVisible" value="mesh" class="h-7 flex-none gap-1.5 px-3 text-xs"><Network class="h-3.5 w-3.5" />{{ t("consul.workspace.mesh") }}</TabsTrigger>
          <TabsTrigger value="tools" class="h-7 flex-none gap-1.5 px-3 text-xs"><Wrench class="h-3.5 w-3.5" />{{ t("consul.workspace.tools") }}</TabsTrigger>
          <TabsTrigger v-if="operatorVisible" value="operator" class="h-7 flex-none gap-1.5 px-3 text-xs"><Gauge class="h-3.5 w-3.5" />{{ t("consul.workspace.operator") }}</TabsTrigger>
        </TabsList>
      </div>
      <div class="flex shrink-0 items-center gap-1">
        <Button v-if="canChangeScope" variant="ghost" size="sm" class="h-7 max-w-64 truncate px-2 font-mono text-[11px]" :title="t('consul.ui.scope')" @click="openScopeSwitcher">{{ scopeLabel }}</Button>
        <span v-else class="max-w-64 truncate px-2 font-mono text-[11px]" :title="t('consul.ui.datacenter')">{{ scopeLabel }}</span>
        <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('consul.ui.refresh')" @click="refresh"><RefreshCcw class="h-3.5 w-3.5" /></Button>
      </div>
    </div>
    <div :key="`${props.connectionId}:${scopeRevision}`" class="contents">
      <TabsContent value="kv" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulKeyBrowser ref="keyRef" :connection-id="props.connectionId" /></TabsContent>
      <TabsContent value="services" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulServices ref="servicesRef" :connection-id="props.connectionId" /></TabsContent>
      <TabsContent value="health" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulHealth ref="healthRef" :connection-id="props.connectionId" /></TabsContent>
      <TabsContent value="sessions" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulSessions ref="sessionsRef" :connection-id="props.connectionId" /></TabsContent>
      <TabsContent v-if="aclVisible" value="acl" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulAcl ref="aclRef" :connection-id="props.connectionId" :capabilities="capabilities" /></TabsContent>
      <TabsContent v-if="scopeTabVisible" value="scope" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulScope ref="scopeRef" :connection-id="props.connectionId" :capabilities="capabilities" /></TabsContent>
      <TabsContent v-if="meshVisible" value="mesh" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulMesh ref="meshRef" :connection-id="props.connectionId" :capabilities="capabilities" /></TabsContent>
      <TabsContent value="tools" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulTools ref="toolsRef" :connection-id="props.connectionId" :capabilities="capabilities" /></TabsContent>
      <TabsContent v-if="operatorVisible" value="operator" class="m-0 min-h-0 flex-1 overflow-hidden"><ConsulOperator ref="operatorRef" :connection-id="props.connectionId" :capabilities="capabilities" /></TabsContent>
    </div>
  </Tabs>
  <Dialog v-model:open="scopeOpen">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader
        ><DialogTitle>{{ t("consul.ui.scope") }}</DialogTitle></DialogHeader
      >
      <div class="grid gap-3 py-2">
        <div class="grid gap-1.5">
          <Label>{{ t("consul.ui.datacenter") }}</Label>
          <Select v-if="datacenterOptions.length > 1" v-model="scopeDraft.datacenter"
            ><SelectTrigger><SelectValue /></SelectTrigger
            ><SelectContent
              ><SelectItem v-for="datacenter in datacenterOptions" :key="datacenter" :value="datacenter">{{ datacenter }}</SelectItem></SelectContent
            ></Select
          >
          <Input v-else v-model="scopeDraft.datacenter" readonly />
        </div>
        <template v-if="enterpriseScopeAvailable">
          <div class="grid gap-1.5">
            <Label>{{ t("consul.ui.adminPartition") }}</Label
            ><Input v-model="scopeDraft.partition" :placeholder="t('consul.ui.default')" />
          </div>
          <div class="grid gap-1.5">
            <Label>{{ t("consul.ui.namespace") }}</Label
            ><Input v-model="scopeDraft.namespace" :placeholder="t('consul.ui.default')" />
          </div>
        </template>
        <p v-if="scopeError" class="text-sm text-destructive">{{ scopeError }}</p>
      </div>
      <DialogFooter
        ><Button variant="outline" :disabled="scopeSaving" @click="scopeOpen = false">{{ t("consul.ui.cancel") }}</Button
        ><Button :disabled="scopeSaving" @click="applyScope">{{ t("consul.ui.applyScope") }}</Button></DialogFooter
      >
    </DialogContent>
  </Dialog>
</template>

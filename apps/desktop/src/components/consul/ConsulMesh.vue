<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { Clipboard, Eye, EyeOff, Loader2, Plus, RefreshCcw, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import PasswordInput from "@/components/ui/PasswordInput.vue";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import NacosConfigDiffDialog from "@/components/nacos/NacosConfigDiffDialog.vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import type { ConsulCapabilities, ConsulConfigEntry, ConsulDiscoveryChain, ConsulExportedService, ConsulIntention, ConsulPeering } from "@/types/consul";
import { useI18n } from "vue-i18n";

type MeshTab = "config" | "intentions" | "discovery" | "peering" | "exported";
const props = defineProps<{ connectionId: string; capabilities: ConsulCapabilities | null }>();
const store = useConnectionStore();
const readOnly = computed(() => Boolean(store.getConfig(props.connectionId)?.read_only));
const { t } = useI18n();
function capabilityLabel(value?: string) {
  if (value === "supported") return t("consul.ui.capabilitySupported");
  if (value === "unsupported") return t("consul.ui.capabilityUnsupported");
  if (value === "disabled") return t("consul.ui.capabilityDisabled");
  if (value === "forbidden") return t("consul.ui.capabilityForbidden");
  return t("consul.ui.capabilityUnknown");
}
const active = ref<MeshTab>("config");
const loading = ref(false);
const error = ref("");
const configKind = ref("service-defaults");
const configs = ref<ConsulConfigEntry[]>([]);
const intentions = ref<ConsulIntention[]>([]);
const peerings = ref<ConsulPeering[]>([]);
const exported = ref<ConsulExportedService[]>([]);
const discoveryService = ref("");
const chain = ref<ConsulDiscoveryChain | null>(null);
const editorOpen = ref(false);
const editorMode = ref<"config" | "intention" | "exported">("config");
const editorJson = ref("{}");
const editingConfig = ref<ConsulConfigEntry | null>(null);
const peeringName = ref("");
const peeringToken = ref("");
const tokenOnce = ref("");
const editingExported = ref<ConsulConfigEntry | null>(null);
const tokenRevealed = ref(false);
const editorOriginalJson = ref("");
const savePreviewOpen = ref(false);
const pendingEditorRaw = ref<Record<string, unknown> | null>(null);
const intentionSource = ref("");
const intentionDestination = ref("");
const intentionCheckResult = ref<boolean | null>(null);
const intentionMatches = ref<ConsulIntention[]>([]);
let loadSequence = 0;
const capability = computed(() =>
  active.value === "config" ? props.capabilities?.configEntries : active.value === "intentions" ? props.capabilities?.intentions : active.value === "peering" ? props.capabilities?.peering : active.value === "exported" ? props.capabilities?.exportedServices : "supported",
);
const canWrite = computed(() => !readOnly.value && capability.value === "supported");
const chainRows = computed(() => {
  if (!chain.value?.Nodes) return [];
  const nodes = chain.value.Nodes;
  const rows: Array<{ id: string; depth: number; type: string; next: string[] }> = [];
  const seen = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: chain.value.StartNode || Object.keys(nodes)[0] || "", depth: 0 }];
  while (queue.length) {
    const current = queue.shift()!;
    if (!current.id || seen.has(current.id)) continue;
    seen.add(current.id);
    const value = nodes[current.id];
    const next = collectNextNodes(value);
    rows.push({ id: current.id, depth: current.depth, type: nodeType(value), next });
    for (const id of next) if (nodes[id] && !seen.has(id)) queue.push({ id, depth: current.depth + 1 });
  }
  for (const id of Object.keys(nodes)) if (!seen.has(id)) rows.push({ id, depth: 0, type: nodeType(nodes[id]), next: collectNextNodes(nodes[id]) });
  return rows;
});
function nodeType(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "node";
  return String((value as Record<string, unknown>).Type || (value as Record<string, unknown>).type || "node");
}
function collectNextNodes(value: unknown): string[] {
  const found = new Set<string>();
  function visit(item: unknown) {
    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
      if (key.toLowerCase() === "nextnode" && typeof child === "string" && child) found.add(child);
      else visit(child);
    }
  }
  visit(value);
  return [...found];
}
async function load() {
  const sequence = ++loadSequence;
  const connectionId = props.connectionId;
  const tab = active.value;
  const kind = configKind.value;
  loading.value = true;
  error.value = "";
  try {
    if (tab === "config") {
      const value = await api.consulMeshConfigList(connectionId, kind);
      if (sequence === loadSequence && connectionId === props.connectionId && tab === active.value) configs.value = value;
    } else if (tab === "intentions") {
      const value = await api.consulMeshIntentionsList(connectionId);
      if (sequence === loadSequence && connectionId === props.connectionId && tab === active.value) intentions.value = value;
    } else if (tab === "peering") {
      const value = await api.consulMeshPeeringList(connectionId);
      if (sequence === loadSequence && connectionId === props.connectionId && tab === active.value) peerings.value = value;
    } else if (tab === "exported") {
      const value = await api.consulMeshExportedServicesList(connectionId);
      if (sequence === loadSequence && connectionId === props.connectionId && tab === active.value) exported.value = value;
    }
  } catch (cause) {
    if (sequence === loadSequence && connectionId === props.connectionId && tab === active.value) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (sequence === loadSequence && connectionId === props.connectionId && tab === active.value) loading.value = false;
  }
}
function openConfig(item?: ConsulConfigEntry) {
  editorMode.value = "config";
  editingConfig.value = item || null;
  editorOriginalJson.value = item ? JSON.stringify(item.raw, null, 2) : "";
  editorJson.value = JSON.stringify(item?.raw || { Kind: configKind.value, Name: "" }, null, 2);
  editorOpen.value = true;
}
async function openIntention(item?: ConsulIntention) {
  let value = item;
  if (item && !item.ID && item.SourceName && item.DestinationName) value = await api.consulMeshIntentionGetExact(props.connectionId, { source: item.SourceName, destination: item.DestinationName });
  editorMode.value = "intention";
  editorOriginalJson.value = value ? JSON.stringify(value, null, 2) : "";
  editorJson.value = JSON.stringify(value || { SourceName: "", DestinationName: "", Action: "allow", Permissions: [] }, null, 2);
  editorOpen.value = true;
}
async function openExported() {
  error.value = "";
  try {
    const entries = await api.consulMeshConfigList(props.connectionId, "exported-services");
    editingExported.value = entries[0] || null;
    const raw = editingExported.value?.raw || { Kind: "exported-services", Name: "default", Services: [] };
    editorMode.value = "exported";
    editorOriginalJson.value = editingExported.value ? JSON.stringify(raw, null, 2) : "";
    editorJson.value = JSON.stringify(raw, null, 2);
    editorOpen.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function save() {
  try {
    pendingEditorRaw.value = JSON.parse(editorJson.value) as Record<string, unknown>;
    savePreviewOpen.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function confirmSave() {
  const raw = pendingEditorRaw.value;
  if (!raw) return;
  try {
    if (editorMode.value === "config") {
      const kind = String(raw.Kind || configKind.value),
        name = String(raw.Name || "");
      await api.consulMeshConfigApply(props.connectionId, { kind, name, expectedModifyIndex: editingConfig.value?.modifyIndex || 0, raw });
    } else if (editorMode.value === "intention") await api.consulMeshIntentionUpsert(props.connectionId, raw as ConsulIntention);
    else await api.consulMeshExportedServicesApply(props.connectionId, String(raw.Name || "default"), editingExported.value?.modifyIndex || 0, raw);
    savePreviewOpen.value = false;
    editorOpen.value = false;
    pendingEditorRaw.value = null;
    editingExported.value = null;
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function removeConfig(item: ConsulConfigEntry) {
  if (!confirm(t("consul.ui.deleteConfig", { kind: item.kind, name: item.name }))) return;
  await api.consulMeshConfigDelete(props.connectionId, item.kind, item.name, item.modifyIndex);
  await load();
}
async function removeIntention(item: ConsulIntention) {
  if (item.ID) {
    if (!confirm(t("consul.ui.deleteIntention", { id: item.ID }))) return;
    await api.consulMeshIntentionDelete(props.connectionId, item.ID);
  } else if (item.SourceName && item.DestinationName) {
    if (!confirm(t("consul.ui.deleteIntentionExact", { source: item.SourceName, destination: item.DestinationName }))) return;
    await api.consulMeshIntentionDeleteExact(props.connectionId, { source: item.SourceName, destination: item.DestinationName });
  } else return;
  await load();
}
function permissionsSummary(item: ConsulIntention) {
  return item.Permissions?.length ? t("consul.ui.permissions", { count: item.Permissions.length }) : t("consul.ui.actionRule");
}
function intentionActionLabel(action?: string) {
  return action === "allow" ? t("consul.ui.allowed") : action === "deny" ? t("consul.ui.denied") : action || t("consul.ui.unknown");
}
function peeringStateLabel(state?: string) {
  const value = String(state || "").toLowerCase();
  if (value === "pending") return t("consul.ui.peeringPending");
  if (value === "establishing") return t("consul.ui.peeringEstablishing");
  if (value === "active") return t("consul.ui.peeringActive");
  if (value === "failing") return t("consul.ui.peeringFailing");
  if (value === "deleting") return t("consul.ui.peeringDeleting");
  if (value === "terminated") return t("consul.ui.peeringTerminated");
  return state || t("consul.ui.unknown");
}
async function checkIntention() {
  if (!intentionSource.value.trim() || !intentionDestination.value.trim()) return;
  try {
    const result = await api.consulMeshIntentionCheck(props.connectionId, { source: intentionSource.value.trim(), destination: intentionDestination.value.trim() });
    intentionCheckResult.value = result.Allowed;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function matchIntentions(by: "source" | "destination") {
  const name = (by === "source" ? intentionSource.value : intentionDestination.value).trim();
  if (!name) return;
  try {
    intentionMatches.value = await api.consulMeshIntentionMatch(props.connectionId, { by, name });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function loadChain() {
  loading.value = true;
  error.value = "";
  try {
    chain.value = await api.consulMeshDiscoveryChain(props.connectionId, discoveryService.value);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    loading.value = false;
  }
}
function clearToken() {
  tokenOnce.value = "";
  tokenRevealed.value = false;
}
async function generateToken() {
  try {
    const result = await api.consulMeshPeeringGenerateToken(props.connectionId, { PeerName: peeringName.value });
    tokenOnce.value = result.PeeringToken;
    tokenRevealed.value = false;
    peeringName.value = "";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function establishPeering() {
  try {
    await api.consulMeshPeeringEstablish(props.connectionId, { PeerName: peeringName.value, PeeringToken: peeringToken.value });
    peeringToken.value = "";
    peeringName.value = "";
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function copyToken() {
  await navigator.clipboard.writeText(tokenOnce.value);
  clearToken();
}
async function removePeering(name: string) {
  if (!confirm(t("consul.ui.deletePeering", { name }))) return;
  await api.consulMeshPeeringDelete(props.connectionId, name);
  await load();
}
watch([active, () => props.connectionId], () => {
  clearToken();
  void load();
});
onMounted(() => void load());
onDeactivated(clearToken);
onBeforeUnmount(() => {
  loadSequence += 1;
  clearToken();
});
defineExpose({
  refresh: () => {
    void load();
    return true;
  },
});
</script>
<template>
  <Tabs v-model="active" class="flex h-full min-h-0 flex-col">
    <div class="flex h-11 items-center justify-between border-b px-3">
      <TabsList class="h-8 p-0.5"
        ><TabsTrigger value="config" class="h-7 px-2 text-xs">{{ t("consul.ui.configEntries") }}</TabsTrigger
        ><TabsTrigger value="intentions" class="h-7 px-2 text-xs">{{ t("consul.ui.intentions") }}</TabsTrigger
        ><TabsTrigger value="discovery" class="h-7 px-2 text-xs">{{ t("consul.ui.discoveryChain") }}</TabsTrigger
        ><TabsTrigger value="peering" class="h-7 px-2 text-xs">{{ t("consul.ui.peering") }}</TabsTrigger
        ><TabsTrigger value="exported" class="h-7 px-2 text-xs">{{ t("consul.ui.exportedServices") }}</TabsTrigger></TabsList
      ><Button variant="ghost" size="icon" class="h-7 w-7" :title="t('consul.ui.refresh')" @click="load"><RefreshCcw class="h-3.5 w-3.5" /></Button>
    </div>
    <div v-if="capability !== 'supported'" class="m-4 border p-3 text-sm text-muted-foreground">{{ t("consul.ui.capability", { status: capabilityLabel(capability) }) }}</div>
    <div v-else-if="error" class="m-4 border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{{ error }}</div>
    <div v-if="loading" class="flex h-24 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.ui.loading") }}</div>
    <TabsContent value="config" class="m-0 min-h-0 flex-1 overflow-auto p-4"
      ><div class="mb-3 flex gap-2">
        <Input v-model="configKind" class="max-w-xs" :placeholder="t('consul.ui.configEntryKind')" /><Button variant="outline" size="sm" @click="load">{{ t("consul.ui.loadKind") }}</Button
        ><Button v-if="canWrite" size="sm" class="gap-1" @click="openConfig()"><Plus class="h-3.5 w-3.5" />{{ t("consul.ui.newJson") }}</Button>
      </div>
      <div class="divide-y border">
        <div v-for="item in configs" :key="`${item.kind}/${item.name}`" class="flex min-h-12 items-center gap-3 px-3 py-2">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ item.name }}</div>
            <div class="text-xs text-muted-foreground">{{ item.kind }} · {{ t("consul.ui.modifyIndex", { index: item.modifyIndex }) }}</div>
          </div>
          <Button variant="outline" size="sm" @click="openConfig(item)">{{ t("consul.ui.rawJson") }}</Button
          ><Button v-if="canWrite" variant="ghost" size="icon" class="h-7 w-7 text-destructive" @click="removeConfig(item)"><Trash2 class="h-3.5 w-3.5" /></Button>
        </div></div
    ></TabsContent>
    <TabsContent value="intentions" class="m-0 min-h-0 flex-1 overflow-auto p-4">
      <div class="mb-3 flex flex-wrap items-center gap-2">
        <Button v-if="canWrite" size="sm" class="gap-1" @click="openIntention()"><Plus class="h-3.5 w-3.5" />{{ t("consul.ui.newIntention") }}</Button>
        <Input v-model="intentionSource" class="max-w-48" :placeholder="t('consul.ui.sourceService')" />
        <Input v-model="intentionDestination" class="max-w-48" :placeholder="t('consul.ui.destinationService')" />
        <Button variant="outline" size="sm" @click="checkIntention">{{ t("consul.ui.check") }}</Button>
        <Button variant="ghost" size="sm" @click="matchIntentions('source')">{{ t("consul.ui.matchSource") }}</Button>
        <Button variant="ghost" size="sm" @click="matchIntentions('destination')">{{ t("consul.ui.matchDestination") }}</Button>
        <span v-if="intentionCheckResult !== null" class="text-xs font-medium" :class="intentionCheckResult ? 'text-emerald-600' : 'text-destructive'">{{ intentionCheckResult ? t("consul.ui.allowed") : t("consul.ui.denied") }}</span>
      </div>
      <div v-if="intentionMatches.length" class="mb-3 border bg-muted/20 p-2 text-xs">{{ t("consul.ui.matchedIntentions", { count: intentionMatches.length }) }}</div>
      <div class="divide-y border">
        <div v-for="item in intentionMatches.length ? intentionMatches : intentions" :key="item.ID || `${item.SourceName}:${item.DestinationName}`" class="flex min-h-12 items-center gap-3 px-3 py-2">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium">{{ item.SourceName }} → {{ item.DestinationName }}</div>
            <div class="text-xs text-muted-foreground">
              {{ intentionActionLabel(item.Action) }} · {{ permissionsSummary(item) }} · {{ item.SourcePartition || t("consul.ui.default") }}/{{ item.SourceNamespace || t("consul.ui.default") }} → {{ item.DestinationPartition || t("consul.ui.default") }}/{{
                item.DestinationNamespace || t("consul.ui.default")
              }}
            </div>
          </div>
          <Button variant="outline" size="sm" @click="openIntention(item)">{{ t("consul.ui.details") }}</Button
          ><Button v-if="canWrite" variant="ghost" size="icon" class="h-7 w-7 text-destructive" @click="removeIntention(item)"><Trash2 class="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </TabsContent>
    <TabsContent value="discovery" class="m-0 min-h-0 flex-1 overflow-auto p-4">
      <div class="flex max-w-xl gap-2">
        <Input v-model="discoveryService" :placeholder="t('consul.ui.serviceName')" @keyup.enter="loadChain" /><Button @click="loadChain">{{ t("consul.ui.compile") }}</Button>
      </div>
      <div v-if="chain" class="mt-4 space-y-3">
        <div class="border bg-muted/20 px-3 py-2 text-xs">{{ chain.ServiceName }} · {{ chain.Protocol || t("consul.ui.defaultProtocol") }} · {{ chain.Datacenter || t("consul.ui.configuredDatacenter") }}</div>
        <div class="divide-y border">
          <div v-for="row in chainRows" :key="row.id" class="grid min-h-12 grid-cols-[minmax(0,1fr)_8rem_minmax(0,1fr)] items-center gap-3 px-3 py-2 text-xs" :style="{ paddingLeft: `${12 + row.depth * 20}px` }">
            <div class="min-w-0 truncate font-mono">
              <span v-if="row.id === chain.StartNode" class="mr-1 text-emerald-600">{{ t("consul.ui.start") }}</span
              >{{ row.id }}
            </div>
            <Badge variant="outline" class="w-fit">{{ row.type }}</Badge>
            <div class="truncate text-muted-foreground">{{ row.next.length ? t("consul.ui.next", { nodes: row.next.join(", ") }) : t("consul.ui.terminalTarget") }}</div>
          </div>
        </div>
        <details v-if="chain.Targets && Object.keys(chain.Targets).length" class="border">
          <summary class="cursor-pointer px-3 py-2 text-xs font-medium">{{ t("consul.ui.upstreamTargets", { count: Object.keys(chain.Targets).length }) }}</summary>
          <pre class="max-h-64 overflow-auto border-t bg-muted/20 p-3 text-xs">{{ JSON.stringify(chain.Targets, null, 2) }}</pre>
        </details>
      </div>
    </TabsContent>
    <TabsContent value="peering" class="m-0 min-h-0 flex-1 overflow-auto p-4"
      ><div v-if="canWrite" class="mb-3 grid max-w-2xl grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_auto_auto] gap-2">
        <Input v-model="peeringName" :placeholder="t('consul.ui.peerName')" /><PasswordInput v-model="peeringToken" :placeholder="t('consul.ui.peeringToken')" /><Button :disabled="!peeringName" variant="outline" @click="generateToken">{{ t("consul.ui.generateToken") }}</Button
        ><Button :disabled="!peeringName || !peeringToken" @click="establishPeering">{{ t("consul.ui.establish") }}</Button>
      </div>
      <div v-if="tokenOnce" class="mb-3 flex items-center gap-2 border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
        <span class="min-w-0 flex-1 truncate font-mono">{{ tokenRevealed ? tokenOnce : "****************" }}</span
        ><Button variant="ghost" size="icon" class="h-7 w-7" :title="tokenRevealed ? t('consul.ui.hide') : t('consul.ui.reveal')" @click="tokenRevealed = !tokenRevealed"><EyeOff v-if="tokenRevealed" class="h-3.5 w-3.5" /><Eye v-else class="h-3.5 w-3.5" /></Button
        ><Button size="sm" class="gap-1" @click="copyToken"><Clipboard class="h-3.5 w-3.5" />{{ t("consul.ui.copyOnce") }}</Button
        ><Button variant="ghost" size="sm" @click="clearToken">{{ t("consul.ui.hide") }}</Button>
      </div>
      <div class="divide-y border">
        <div v-for="item in peerings" :key="item.Name" class="flex min-h-12 items-center gap-3 px-3 py-2">
          <div class="flex-1">
            <div class="text-sm font-medium">{{ item.Name }}</div>
            <div class="text-xs text-muted-foreground">{{ peeringStateLabel(item.State) }} · {{ item.Partition || t("consul.ui.default") }}</div>
          </div>
          <Button v-if="canWrite" variant="ghost" size="icon" class="h-7 w-7 text-destructive" @click="removePeering(String(item.Name))"><Trash2 class="h-3.5 w-3.5" /></Button>
        </div></div
    ></TabsContent>
    <TabsContent value="exported" class="m-0 min-h-0 flex-1 overflow-auto p-4"
      ><Button v-if="canWrite" size="sm" class="mb-3 gap-1" @click="openExported"><Plus class="h-3.5 w-3.5" />{{ t("consul.ui.editExportedServices") }}</Button>
      <pre class="max-h-[60vh] overflow-auto border bg-muted/20 p-3 text-xs">{{ JSON.stringify(exported, null, 2) }}</pre>
    </TabsContent>
  </Tabs>
  <Dialog v-model:open="editorOpen"
    ><DialogContent class="max-w-3xl"
      ><DialogHeader
        ><DialogTitle>{{ editorMode === "config" ? t("consul.ui.serviceMeshConfigEntry") : editorMode === "intention" ? t("consul.ui.intentions") : t("consul.ui.exportedServices") }}</DialogTitle></DialogHeader
      ><textarea v-model="editorJson" class="h-96 w-full resize-none rounded-md border bg-background p-3 font-mono text-xs outline-none" spellcheck="false" /><DialogFooter
        ><Button variant="outline" @click="editorOpen = false">{{ t("consul.ui.cancel") }}</Button
        ><Button v-if="canWrite" @click="save">{{ t("consul.ui.applyWithCas") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
  <NacosConfigDiffDialog v-model:open="savePreviewOpen" :title="t('consul.ui.reviewMeshChanges')" :before="editorOriginalJson" :after="editorJson" :confirm-label="t('consul.ui.apply')" @confirm="confirmSave" />
</template>

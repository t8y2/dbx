<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Loader2, Pencil, Plus, RefreshCcw, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { useI18n } from "vue-i18n";
import type { ConsulCapabilities, ConsulEnterpriseKind, ConsulEnterpriseWrite, ConsulScopeImpact } from "@/types/consul";

const props = defineProps<{ connectionId: string; capabilities: ConsulCapabilities | null }>();
const { t } = useI18n();
const store = useConnectionStore();
const readOnly = computed(() => Boolean(store.getConfig(props.connectionId)?.read_only));
const active = ref<ConsulEnterpriseKind>("namespace");
const items = ref<Record<string, unknown>[]>([]);
const loading = ref(false);
const error = ref("");
const editorOpen = ref(false);
const editorName = ref<string | null>(null);
const editorJson = ref("{}");
const pendingDelete = ref<string | null>(null);
const impact = ref<ConsulScopeImpact | null>(null);
const impactLoading = ref(false);
let impactSequence = 0;
let loadSequence = 0;
const status = computed(() => (active.value === "namespace" ? props.capabilities?.namespaces : props.capabilities?.partitions));
const canWrite = computed(() => status.value === "supported" && !readOnly.value);
const activeLabel = computed(() => (active.value === "namespace" ? t("consul.ui.namespace") : t("consul.ui.adminPartition")));
function capabilityLabel(value?: string) {
  if (value === "supported") return t("consul.ui.capabilitySupported");
  if (value === "unsupported") return t("consul.ui.capabilityUnsupported");
  if (value === "disabled") return t("consul.ui.capabilityDisabled");
  if (value === "forbidden") return t("consul.ui.capabilityForbidden");
  return t("consul.ui.capabilityUnknown");
}
const connectionScope = computed(() => {
  const config = store.getConfig(props.connectionId);
  const external = (config?.external_config || {}) as Record<string, unknown>;
  return { dc: String(external.datacenter || external.consulDatacenter || "default"), partition: String(external.partition || external.consulPartition || "default"), namespace: String(external.namespace || external.consulNamespace || "default") };
});
async function load() {
  const sequence = ++loadSequence;
  const connectionId = props.connectionId;
  const kind = active.value;
  loading.value = true;
  error.value = "";
  items.value = [];
  try {
    const result = await api.consulEnterpriseList(connectionId, kind);
    if (sequence !== loadSequence || connectionId !== props.connectionId || kind !== active.value) return;
    items.value = result.items as Record<string, unknown>[];
  } catch (cause) {
    if (sequence === loadSequence && connectionId === props.connectionId && kind === active.value) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (sequence === loadSequence && connectionId === props.connectionId && kind === active.value) loading.value = false;
  }
}
function nameOf(item: Record<string, unknown>) {
  return String(item.Name || "");
}
function openCreate() {
  editorName.value = null;
  editorJson.value = JSON.stringify({ Name: "", ...(active.value === "namespace" ? { Partition: connectionScope.value.partition } : {}), Description: "", Meta: {} }, null, 2);
  editorOpen.value = true;
}
function openEdit(item: Record<string, unknown>) {
  editorName.value = nameOf(item);
  editorJson.value = JSON.stringify(item, null, 2);
  editorOpen.value = true;
}
async function save() {
  try {
    const item = JSON.parse(editorJson.value) as Record<string, unknown>;
    const value = { kind: active.value, item } as ConsulEnterpriseWrite;
    await api.consulEnterpriseApply(props.connectionId, editorName.value, value);
    editorOpen.value = false;
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function inspectDelete(name: string) {
  const current = ++impactSequence;
  pendingDelete.value = name;
  impact.value = null;
  impactLoading.value = true;
  try {
    const value = await api.consulEnterpriseImpact(props.connectionId, active.value, name);
    if (current === impactSequence && pendingDelete.value === name) impact.value = value;
  } catch (cause) {
    if (current === impactSequence) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      pendingDelete.value = null;
    }
  } finally {
    if (current === impactSequence) impactLoading.value = false;
  }
}
async function remove() {
  if (!pendingDelete.value || !impact.value?.complete) return;
  try {
    await api.consulEnterpriseDelete(props.connectionId, active.value, pendingDelete.value);
    pendingDelete.value = null;
    impact.value = null;
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
function closeDelete() {
  impactSequence += 1;
  pendingDelete.value = null;
  impact.value = null;
  impactLoading.value = false;
}
function impactRows(value: ConsulScopeImpact) {
  return [
    ["services", value.services],
    ["nodes", value.nodes],
    ["kvKeys", value.kvKeys],
    ["healthChecks", value.healthChecks],
    ["sessions", value.sessions],
    ["configEntries", value.configEntries],
    ["intentions", value.intentions],
    ["peerings", value.peerings],
    ["namespaces", value.namespaces],
    ["aclTokens", value.aclTokens],
    ["aclPolicies", value.aclPolicies],
    ["aclRoles", value.aclRoles],
    ["aclAuthMethods", value.aclAuthMethods],
    ["aclBindingRules", value.aclBindingRules],
  ] as const;
}
watch([active, () => props.connectionId], () => void load());
onMounted(() => void load());
onBeforeUnmount(() => {
  loadSequence += 1;
  impactSequence += 1;
});
defineExpose({
  refresh: () => {
    void load();
    return true;
  },
});
</script>
<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="border-b px-4 py-2 text-xs text-muted-foreground">
      {{ t("consul.ui.datacenter") }}: <b>{{ connectionScope.dc }}</b> · {{ t("consul.ui.adminPartition") }}: <b>{{ connectionScope.partition }}</b> · {{ t("consul.ui.namespace") }}: <b>{{ connectionScope.namespace }}</b>
    </div>
    <Tabs v-model="active" class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-11 items-center justify-between border-b px-3">
        <TabsList class="h-8 p-0.5"
          ><TabsTrigger value="namespace" class="h-7 px-3 text-xs">{{ t("consul.ui.namespaces") }}</TabsTrigger
          ><TabsTrigger value="partition" class="h-7 px-3 text-xs">{{ t("consul.workspace.partitions") }}</TabsTrigger></TabsList
        >
        <div class="flex gap-1">
          <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('consul.ui.refresh')" @click="load"><RefreshCcw class="h-3.5 w-3.5" /></Button><Button v-if="canWrite" size="sm" class="h-7 gap-1 text-xs" @click="openCreate"><Plus class="h-3.5 w-3.5" />{{ t("consul.ui.create") }}</Button>
        </div>
      </div>
      <TabsContent v-for="kind in ['namespace', 'partition']" :key="kind" :value="kind" class="m-0 min-h-0 flex-1 overflow-auto p-4">
        <div v-if="status !== 'supported'" class="border px-3 py-2 text-sm text-muted-foreground">{{ t("consul.ui.enterpriseCapability", { status: capabilityLabel(status) }) }}</div>
        <div v-else-if="loading" class="flex h-28 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.ui.loading") }}</div>
        <div v-else-if="error" class="border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{{ error }}</div>
        <div v-else class="divide-y border">
          <div v-for="item in items" :key="nameOf(item)" class="flex min-h-12 items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium">{{ nameOf(item) }}</div>
              <div class="truncate text-xs text-muted-foreground">{{ item.Description || "-" }}</div>
            </div>
            <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('consul.ui.edit')" @click="openEdit(item)"><Pencil class="h-3.5 w-3.5" /></Button
            ><Button v-if="canWrite" variant="ghost" size="icon" class="h-7 w-7 text-destructive" :title="t('consul.ui.inspectImpactAndDelete')" @click="inspectDelete(nameOf(item))"><Trash2 class="h-3.5 w-3.5" /></Button>
          </div>
          <div v-if="!items.length" class="p-8 text-center text-sm text-muted-foreground">{{ t("consul.ui.noResources") }}</div>
        </div>
      </TabsContent>
    </Tabs>
  </div>
  <Dialog v-model:open="editorOpen"
    ><DialogContent class="max-w-2xl"
      ><DialogHeader
        ><DialogTitle>{{ editorName ? t("consul.ui.editResource", { kind: activeLabel }) : t("consul.ui.createResource", { kind: activeLabel }) }}</DialogTitle></DialogHeader
      ><textarea v-model="editorJson" class="h-72 w-full resize-none rounded-md border bg-background p-3 font-mono text-xs outline-none" spellcheck="false" /><DialogFooter
        ><Button variant="outline" @click="editorOpen = false">{{ t("consul.ui.cancel") }}</Button
        ><Button v-if="canWrite" @click="save">{{ t("consul.ui.save") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
  <Dialog
    :open="Boolean(pendingDelete)"
    @update:open="
      (value) => {
        if (!value) closeDelete();
      }
    "
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>{{ t("consul.ui.deleteResource", { label: pendingDelete }) }}</DialogTitle></DialogHeader
      >
      <div v-if="impactLoading" class="flex min-h-24 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.ui.loading") }}</div>
      <div v-else-if="impact" class="text-sm">
        <dl class="grid grid-cols-2 border-l border-t text-xs">
          <div v-for="[resource, count] in impactRows(impact)" :key="resource" class="flex items-center justify-between gap-3 border-b border-r px-3 py-2">
            <dt class="truncate text-muted-foreground">{{ t(`consul.ui.impactResource.${resource}`) }}</dt>
            <dd class="font-mono font-medium">{{ count }}</dd>
          </div>
        </dl>
        <p v-if="impact.filteredByAcls" class="mt-2 text-destructive">{{ t("consul.ui.impactAclFiltered") }}</p>
        <p v-if="impact.unavailableResources.length" class="mt-2 break-words text-destructive">{{ t("consul.ui.impactUnavailable", { resources: impact.unavailableResources.join(", ") }) }}</p>
        <p v-if="!impact.complete" class="mt-2 text-destructive">{{ t("consul.ui.impactBlocked") }}</p>
      </div>
      <DialogFooter
        ><Button variant="outline" @click="closeDelete">{{ t("consul.ui.cancel") }}</Button
        ><Button variant="destructive" :disabled="impactLoading || !impact?.complete" @click="remove">{{ t("consul.ui.delete") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
</template>

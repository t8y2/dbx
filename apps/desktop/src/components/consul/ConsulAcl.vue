<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { Clipboard, Eye, EyeOff, Loader2, Pencil, Plus, RefreshCcw, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import NacosConfigDiffDialog from "@/components/nacos/NacosConfigDiffDialog.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import * as api from "@/lib/backend/api";
import type { ConsulAclItem, ConsulAclKind, ConsulAclReferences, ConsulAclWrite, ConsulCapabilities } from "@/types/consul";
import { useI18n } from "vue-i18n";

const props = defineProps<{ connectionId: string; capabilities: ConsulCapabilities | null }>();
const { t } = useI18n();
const store = useConnectionStore();
const readOnly = computed(() => connectionIsEffectivelyReadOnly(store.getConfig(props.connectionId)));
const active = ref<ConsulAclKind>("token");
const items = ref<Record<string, unknown>[]>([]);
const loading = ref(false);
const error = ref("");
const editorOpen = ref(false);
const editorId = ref<string | null>(null);
const editorJson = ref("{}");
const editorOriginalJson = ref("");
const savePreviewOpen = ref(false);
const references = ref<ConsulAclReferences | null>(null);
const editReferences = ref<ConsulAclReferences | null>(null);
const pendingDelete = ref<{ id: string; label: string; kind: ConsulAclKind } | null>(null);
const secretOnce = ref("");
const secretRevealed = ref(false);
const operationBusy = ref(false);
let loadSequence = 0;

const tabs = computed<{ value: ConsulAclKind; label: string }[]>(() => [
  { value: "token", label: t("consul.ui.tokens") },
  { value: "policy", label: t("consul.ui.policies") },
  { value: "role", label: t("consul.ui.roles") },
  { value: "authMethod", label: t("consul.ui.authMethods") },
  { value: "bindingRule", label: t("consul.ui.bindingRules") },
  { value: "templatedPolicy", label: t("consul.ui.templatedPolicies") },
]);
const activeLabel = computed(() => tabs.value.find((tab) => tab.value === active.value)?.label || active.value);
function capabilityLabel(status?: string) {
  if (status === "supported") return t("consul.ui.capabilitySupported");
  if (status === "unsupported") return t("consul.ui.capabilityUnsupported");
  if (status === "disabled") return t("consul.ui.capabilityDisabled");
  if (status === "forbidden") return t("consul.ui.capabilityForbidden");
  return t("consul.ui.capabilityUnknown");
}
const capability = computed(() => (active.value === "authMethod" ? props.capabilities?.authMethods : active.value === "bindingRule" ? props.capabilities?.bindingRules : active.value === "templatedPolicy" ? props.capabilities?.templatedPolicies : props.capabilities?.acl));
const canWrite = computed(() => !readOnly.value && capability.value === "supported" && active.value !== "templatedPolicy");

function itemId(item: Record<string, unknown>): string {
  return String(item.AccessorID || item.ID || item.Name || item.TemplateName || "");
}
function itemLabel(item: Record<string, unknown>): string {
  return String(item.Name || item.Description || item.AccessorID || item.ID || item.TemplateName || "-");
}
function clearSecret() {
  secretOnce.value = "";
  secretRevealed.value = false;
}
function scrubSecret(item: Record<string, unknown>) {
  if (typeof item.SecretID === "string" && item.SecretID) {
    secretOnce.value = item.SecretID;
    secretRevealed.value = false;
    delete item.SecretID;
  }
}
async function load() {
  const sequence = ++loadSequence;
  const connectionId = props.connectionId;
  const kind = active.value;
  loading.value = true;
  error.value = "";
  items.value = [];
  try {
    const result = await api.consulAclList(connectionId, kind);
    if (sequence !== loadSequence || connectionId !== props.connectionId || kind !== active.value) return;
    items.value = (result.items as Record<string, unknown>[]).map((item) => {
      const safe = { ...item };
      delete safe.SecretID;
      return safe;
    });
  } catch (cause) {
    if (sequence === loadSequence && connectionId === props.connectionId && kind === active.value) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (sequence === loadSequence && connectionId === props.connectionId && kind === active.value) loading.value = false;
  }
}
function openCreate() {
  editorId.value = null;
  editorOriginalJson.value = "";
  editorJson.value = JSON.stringify(defaultItem(active.value), null, 2);
  editorOpen.value = true;
}
async function openEdit(item: Record<string, unknown>) {
  const id = itemId(item);
  editorId.value = id;
  if (active.value === "templatedPolicy") {
    editorJson.value = JSON.stringify(item, null, 2);
    editorOriginalJson.value = editorJson.value;
    editReferences.value = null;
    editorOpen.value = true;
    return;
  }
  try {
    const [result, impact]: [ConsulAclItem, ConsulAclReferences | null] = await Promise.all([
      api.consulAclGet(props.connectionId, active.value, id),
      active.value === "policy" || active.value === "role" || active.value === "authMethod" ? api.consulAclReferences(props.connectionId, active.value, id) : Promise.resolve(null),
    ]);
    editReferences.value = impact;
    const value = { ...(result.item as Record<string, unknown>) };
    delete value.SecretID;
    editorJson.value = JSON.stringify(value, null, 2);
    editorOriginalJson.value = editorJson.value;
    editorOpen.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function save() {
  error.value = "";
  try {
    JSON.parse(editorJson.value);
    savePreviewOpen.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function confirmSave() {
  error.value = "";
  try {
    const item = JSON.parse(editorJson.value) as Record<string, unknown>;
    delete item.SecretID;
    const value = { kind: active.value, item } as ConsulAclWrite;
    const result = await api.consulAclApply(props.connectionId, editorId.value, value);
    scrubSecret(result.item as Record<string, unknown>);
    savePreviewOpen.value = false;
    editorOpen.value = false;
    await load();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  }
}
async function runOperation(action: () => Promise<void>) {
  if (operationBusy.value) return;
  operationBusy.value = true;
  error.value = "";
  try {
    await action();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    operationBusy.value = false;
  }
}
async function inspectDelete(item: Record<string, unknown>) {
  const id = itemId(item);
  const label = itemLabel(item);
  const kind = active.value;
  const connectionId = props.connectionId;
  await runOperation(async () => {
    references.value = await api.consulAclReferences(connectionId, kind, id);
    pendingDelete.value = { id, label, kind };
  });
}
async function cloneToken(item: Record<string, unknown>) {
  const description = window.prompt(t("consul.ui.cloneTokenDescription"), String(item.Description || ""));
  if (description === null) return;
  await runOperation(async () => {
    const result = await api.consulAclTokenClone(props.connectionId, itemId(item), description);
    scrubSecret(result as Record<string, unknown>);
    await load();
  });
}
async function remove() {
  const pending = pendingDelete.value;
  if (!pending || !references.value?.complete) return;
  await runOperation(async () => {
    await api.consulAclDelete(props.connectionId, pending.kind, pending.id);
    pendingDelete.value = null;
    references.value = null;
    await load();
  });
}
async function copySecret() {
  if (!secretOnce.value) return;
  await runOperation(async () => {
    await navigator.clipboard.writeText(secretOnce.value);
    clearSecret();
  });
}
function closeDelete() {
  pendingDelete.value = null;
  references.value = null;
}
function defaultItem(kind: ConsulAclKind): Record<string, unknown> {
  if (kind === "token") return { Description: "", Local: false, Policies: [], Roles: [] };
  if (kind === "policy") return { Name: "", Description: "", Rules: "", Datacenters: [] };
  if (kind === "role") return { Name: "", Description: "", Policies: [] };
  if (kind === "authMethod") return { Name: "", Type: "jwt", DisplayName: "", Description: "", Config: {} };
  return { Description: "", AuthMethod: "", Selector: "", BindType: "service", BindName: "" };
}
watch([active, () => props.connectionId], () => {
  clearSecret();
  void load();
});
onMounted(() => void load());
onDeactivated(clearSecret);
onBeforeUnmount(() => {
  loadSequence += 1;
  clearSecret();
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
    <Tabs v-model="active" class="flex min-h-0 flex-1 flex-col">
      <div class="flex h-11 items-center justify-between border-b px-3">
        <TabsList class="h-8 p-0.5"
          ><TabsTrigger v-for="tab in tabs" :key="tab.value" :value="tab.value" class="h-7 px-2 text-xs">{{ tab.label }}</TabsTrigger></TabsList
        >
        <div class="flex gap-1">
          <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="loading || operationBusy" :title="t('consul.ui.refresh')" @click="load"><RefreshCcw class="h-3.5 w-3.5" /></Button
          ><Button v-if="canWrite" size="sm" class="h-7 gap-1 text-xs" :disabled="operationBusy" @click="openCreate"><Plus class="h-3.5 w-3.5" />{{ t("consul.ui.create") }}</Button>
        </div>
      </div>
      <TabsContent v-for="tab in tabs" :key="tab.value" :value="tab.value" class="m-0 min-h-0 flex-1 overflow-auto p-4">
        <div v-if="capability !== 'supported'" class="border px-3 py-2 text-sm text-muted-foreground">{{ t("consul.ui.capability", { status: capabilityLabel(capability) }) }}</div>
        <div v-else-if="loading" class="flex h-28 items-center justify-center text-sm text-muted-foreground"><Loader2 class="mr-2 h-4 w-4 animate-spin" />{{ t("consul.ui.loading") }}</div>
        <div v-else-if="error" class="border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">{{ error }}</div>
        <div v-else class="divide-y border">
          <div v-for="item in items" :key="itemId(item)" class="flex min-h-12 items-center gap-3 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="truncate text-sm font-medium">{{ itemLabel(item) }}</div>
              <div class="truncate text-xs text-muted-foreground">{{ itemId(item) }}</div>
            </div>
            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="operationBusy" :title="t('consul.ui.viewOrEdit')" @click="openEdit(item)"><component :is="canWrite ? Pencil : Eye" class="h-3.5 w-3.5" /></Button
            ><Button v-if="canWrite && active === 'token'" variant="ghost" size="icon" class="h-7 w-7" :disabled="operationBusy" :title="t('consul.ui.cloneToken')" @click="cloneToken(item)"><Clipboard class="h-3.5 w-3.5" /></Button
            ><Button v-if="canWrite" variant="ghost" size="icon" class="h-7 w-7 text-destructive" :disabled="operationBusy" :title="t('consul.ui.deleteAndInspectReferences')" @click="inspectDelete(item)"><Trash2 class="h-3.5 w-3.5" /></Button>
          </div>
          <div v-if="!items.length" class="p-8 text-center text-sm text-muted-foreground">{{ t("consul.ui.noResources") }}</div>
        </div>
      </TabsContent>
    </Tabs>
    <div v-if="secretOnce" class="m-3 flex items-center gap-2 border border-amber-300 bg-amber-50 p-3 text-sm dark:bg-amber-950/30">
      <span class="min-w-0 flex-1 truncate font-mono">{{ secretRevealed ? secretOnce : "****************" }}</span
      ><Button variant="ghost" size="icon" class="h-7 w-7" :title="secretRevealed ? t('consul.ui.hide') : t('consul.ui.reveal')" @click="secretRevealed = !secretRevealed"><EyeOff v-if="secretRevealed" class="h-3.5 w-3.5" /><Eye v-else class="h-3.5 w-3.5" /></Button
      ><Button size="sm" class="h-7 gap-1" :disabled="operationBusy" @click="copySecret"><Clipboard class="h-3.5 w-3.5" />{{ t("consul.ui.copyOnce") }}</Button
      ><Button variant="ghost" size="sm" @click="clearSecret">{{ t("consul.ui.hide") }}</Button>
    </div>
  </div>
  <Dialog v-model:open="editorOpen"
    ><DialogContent class="max-w-2xl"
      ><DialogHeader
        ><DialogTitle>{{ editorId ? t("consul.ui.editResource", { kind: activeLabel }) : t("consul.ui.createResource", { kind: activeLabel }) }}</DialogTitle></DialogHeader
      >
      <div v-if="editReferences" class="border bg-muted/20 px-3 py-2 text-xs">
        {{ t("consul.ui.knownImpact", { tokens: editReferences.tokenAccessorIds.length, roles: editReferences.roleIds.length, bindingRules: editReferences.bindingRuleIds.length }) }}<span v-if="!editReferences.complete" class="ml-2 text-destructive">{{ t("consul.ui.incomplete") }}</span>
      </div>
      <textarea v-model="editorJson" class="h-80 w-full resize-none rounded-md border bg-background p-3 font-mono text-xs outline-none" spellcheck="false" :readonly="active === 'templatedPolicy'" /><DialogFooter
        ><Button variant="outline" @click="editorOpen = false">{{ t("consul.ui.cancel") }}</Button
        ><Button v-if="canWrite" @click="save">{{ t("consul.ui.save") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
  <NacosConfigDiffDialog v-model:open="savePreviewOpen" :title="t('consul.ui.reviewAclChanges')" :before="editorOriginalJson" :after="editorJson" :confirm-label="t('consul.ui.apply')" @confirm="confirmSave" />
  <Dialog
    :open="Boolean(pendingDelete)"
    @update:open="
      (value) => {
        if (!value) closeDelete();
      }
    "
    ><DialogContent
      ><DialogHeader
        ><DialogTitle>{{ t("consul.ui.deleteResource", { label: pendingDelete?.label }) }}</DialogTitle></DialogHeader
      >
      <div v-if="references" class="space-y-2 text-sm">
        <p>{{ t("consul.ui.tokenReferences", { tokens: references.tokenAccessorIds.length, roles: references.roleIds.length, bindingRules: references.bindingRuleIds.length }) }}</p>
        <p v-if="!references.complete" class="text-destructive">{{ t("consul.ui.impactBlocked") }}</p>
      </div>
      <DialogFooter
        ><Button variant="outline" :disabled="operationBusy" @click="closeDelete">{{ t("consul.ui.cancel") }}</Button
        ><Button variant="destructive" :disabled="operationBusy || !references?.complete" @click="remove">{{ t("consul.ui.delete") }}</Button></DialogFooter
      ></DialogContent
    ></Dialog
  >
</template>

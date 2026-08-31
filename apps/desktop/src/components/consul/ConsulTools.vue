<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { FileSearch, Pencil, Play, Plus, RefreshCcw, Trash2, X } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import * as api from "@/lib/backend/api";
import type { ConsulCapabilities, ConsulCoordinate, ConsulEvent, ConsulPreparedQuery, ConsulPreparedQueryExecuteResponse, ConsulPreparedQueryNode } from "@/types/consul";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { useI18n } from "vue-i18n";

type ToolTab = "queries" | "events" | "coordinates";

const props = defineProps<{ connectionId: string; capabilities?: ConsulCapabilities | null }>();
const { t } = useI18n();
function capabilityLabel(value?: string) {
  if (value === "supported") return t("consul.ui.capabilitySupported");
  if (value === "unsupported") return t("consul.ui.capabilityUnsupported");
  if (value === "disabled") return t("consul.ui.capabilityDisabled");
  if (value === "forbidden") return t("consul.ui.capabilityForbidden");
  return t("consul.ui.capabilityUnknown");
}
const connectionStore = useConnectionStore();
const readOnly = computed(() => connectionIsEffectivelyReadOnly(connectionStore.getConfig(props.connectionId)));
const canWriteQueries = computed(() => !readOnly.value && props.capabilities?.preparedQueries === "supported");
const canFireEvents = computed(() => !readOnly.value && props.capabilities?.events === "supported");
const queryAvailable = computed(() => !["unsupported", "disabled", "forbidden"].includes(props.capabilities?.preparedQueries || ""));
const eventAvailable = computed(() => !["unsupported", "disabled", "forbidden"].includes(props.capabilities?.events || ""));
const coordinateAvailable = computed(() => !["unsupported", "disabled", "forbidden"].includes(props.capabilities?.coordinates || ""));

const activeTab = ref<ToolTab>("queries");
const queries = ref<ConsulPreparedQuery[]>([]);
const events = ref<ConsulEvent[]>([]);
const coordinates = ref<ConsulCoordinate[]>([]);
const queryLoading = ref(false);
const eventLoading = ref(false);
const coordinateLoading = ref(false);
const queryBusy = ref(false);
const eventBusy = ref(false);
const queryError = ref("");
const eventError = ref("");
const coordinateError = ref("");
const activeLoading = computed(() => (activeTab.value === "queries" ? queryLoading.value : activeTab.value === "events" ? eventLoading.value : coordinateLoading.value));

const queryName = ref("");
const queryService = ref("");
const queryResult = ref<ConsulPreparedQueryExecuteResponse | null>(null);
const queryDetails = ref<unknown | null>(null);
const editingQueryId = ref("");

const eventName = ref("");
const eventPayload = ref("");
const eventNodeFilter = ref("");
const eventServiceFilter = ref("");
const eventTagFilter = ref("");
const eventPayloadBytes = computed(() => new TextEncoder().encode(eventPayload.value).length);
const eventValid = computed(() => {
  const name = eventName.value.trim();
  return Boolean(name && !name.startsWith("_") && new TextEncoder().encode(name).length <= 256 && eventPayloadBytes.value <= 100);
});

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function loadQueries() {
  if (!queryAvailable.value) return;
  queryLoading.value = true;
  queryError.value = "";
  try {
    queries.value = await api.consulPreparedQueryList(props.connectionId);
  } catch (error) {
    queryError.value = errorMessage(error);
  } finally {
    queryLoading.value = false;
  }
}

async function loadEvents() {
  if (!eventAvailable.value) return;
  eventLoading.value = true;
  eventError.value = "";
  try {
    events.value = await api.consulEventList(props.connectionId);
  } catch (error) {
    eventError.value = errorMessage(error);
  } finally {
    eventLoading.value = false;
  }
}

async function loadCoordinates() {
  if (!coordinateAvailable.value) return;
  coordinateLoading.value = true;
  coordinateError.value = "";
  try {
    coordinates.value = await api.consulCoordinateNodes(props.connectionId);
  } catch (error) {
    coordinateError.value = errorMessage(error);
  } finally {
    coordinateLoading.value = false;
  }
}

async function refresh() {
  if (activeTab.value === "queries") await loadQueries();
  else if (activeTab.value === "events") await loadEvents();
  else await loadCoordinates();
}

async function createQuery() {
  if (!canWriteQueries.value || !queryName.value.trim() || !queryService.value.trim()) return;
  queryBusy.value = true;
  queryError.value = "";
  try {
    const input = {
      name: queryName.value.trim(),
      session: "",
      service: { Service: queryService.value.trim(), Near: "", OnlyPassing: false, Tags: [] },
    };
    if (editingQueryId.value) await api.consulPreparedQueryUpdate(props.connectionId, editingQueryId.value, input);
    else await api.consulPreparedQueryCreate(props.connectionId, input);
    cancelQueryEdit();
    await loadQueries();
  } catch (error) {
    queryError.value = errorMessage(error);
  } finally {
    queryBusy.value = false;
  }
}

function cancelQueryEdit() {
  editingQueryId.value = "";
  queryName.value = "";
  queryService.value = "";
}

async function editQuery(query: ConsulPreparedQuery) {
  queryBusy.value = true;
  queryError.value = "";
  try {
    const current = await api.consulPreparedQueryRead(props.connectionId, query.ID);
    queryDetails.value = current;
    editingQueryId.value = current.ID;
    queryName.value = current.Name;
    queryService.value = current.Service.Service;
  } catch (error) {
    queryError.value = errorMessage(error);
  } finally {
    queryBusy.value = false;
  }
}

async function explainQuery(query: ConsulPreparedQuery) {
  queryBusy.value = true;
  queryError.value = "";
  try {
    queryDetails.value = await api.consulPreparedQueryExplain(props.connectionId, query.ID);
  } catch (error) {
    queryError.value = errorMessage(error);
  } finally {
    queryBusy.value = false;
  }
}

async function deleteQuery(id: string) {
  if (!canWriteQueries.value || !confirm(t("consul.ui.deletePreparedQuery", { id }))) return;
  queryBusy.value = true;
  queryError.value = "";
  try {
    await api.consulPreparedQueryDelete(props.connectionId, id);
    if (editingQueryId.value === id) cancelQueryEdit();
    await loadQueries();
  } catch (error) {
    queryError.value = errorMessage(error);
  } finally {
    queryBusy.value = false;
  }
}

async function executeQuery(query: ConsulPreparedQuery) {
  queryBusy.value = true;
  queryError.value = "";
  queryDetails.value = null;
  try {
    queryResult.value = await api.consulPreparedQueryExecute(props.connectionId, { query: query.ID, limit: 100, connect: false });
  } catch (error) {
    queryError.value = errorMessage(error);
  } finally {
    queryBusy.value = false;
  }
}

function queryEndpoint(item: ConsulPreparedQueryNode) {
  const address = item.Service.Address || item.Node.Address || "-";
  return item.Service.Port ? `${address}:${item.Service.Port}` : address;
}

async function fireEvent() {
  if (!canFireEvents.value || !eventValid.value) return;
  eventBusy.value = true;
  eventError.value = "";
  try {
    const bytes = new TextEncoder().encode(eventPayload.value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    await api.consulEventFire(props.connectionId, {
      name: eventName.value.trim(),
      payloadBase64: btoa(binary),
      nodeFilter: eventNodeFilter.value.trim(),
      serviceFilter: eventServiceFilter.value.trim(),
      tagFilter: eventTagFilter.value.trim(),
    });
    eventPayload.value = "";
    await loadEvents();
  } catch (error) {
    eventError.value = errorMessage(error);
  } finally {
    eventBusy.value = false;
  }
}

function decodeEventPayload(payload: string | null) {
  if (!payload) return "";
  try {
    const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return payload;
  }
}

watch(activeTab, () => {
  void refresh();
});
watch(
  () => props.connectionId,
  () => {
    queries.value = [];
    events.value = [];
    coordinates.value = [];
    queryResult.value = null;
    queryDetails.value = null;
    cancelQueryEdit();
    void refresh();
  },
);
onMounted(() => {
  void refresh();
});
defineExpose({ refresh });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-10 shrink-0 items-center justify-between border-b px-3">
      <span class="text-sm font-medium">{{ t("consul.ui.tools") }}</span>
      <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="activeLoading" :title="t('consul.ui.refresh')" @click="refresh">
        <RefreshCcw class="h-3.5 w-3.5" :class="activeLoading ? 'animate-spin' : ''" />
      </Button>
    </div>
    <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col">
      <TabsList class="mx-3 mt-3 h-8 w-fit">
        <TabsTrigger value="queries">{{ t("consul.ui.preparedQueries") }}</TabsTrigger>
        <TabsTrigger value="events">{{ t("consul.ui.events") }}</TabsTrigger>
        <TabsTrigger value="coordinates">{{ t("consul.ui.coordinates") }}</TabsTrigger>
      </TabsList>

      <TabsContent value="queries" class="m-0 min-h-0 flex-1 overflow-auto p-3">
        <p class="mb-3 text-sm text-muted-foreground">{{ t("consul.ui.preparedQueriesDescription") }}</p>
        <div v-if="capabilities && capabilities.preparedQueries !== 'supported'" class="mb-3 rounded-md border p-3 text-sm text-muted-foreground">{{ t("consul.ui.capability", { status: capabilityLabel(capabilities.preparedQueries) }) }}</div>
        <div v-if="queryError" class="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{{ queryError }}</div>
        <div v-if="canWriteQueries" class="mb-3 grid grid-cols-[minmax(12rem,1fr)_minmax(12rem,1fr)_auto_auto] gap-2">
          <Input v-model="queryName" :placeholder="t('consul.ui.queryName')" />
          <Input v-model="queryService" :placeholder="t('consul.ui.targetService')" />
          <Button size="sm" :disabled="queryBusy || !queryName.trim() || !queryService.trim()" @click="createQuery"> <Pencil v-if="editingQueryId" class="mr-1 h-3.5 w-3.5" /><Plus v-else class="mr-1 h-3.5 w-3.5" />{{ editingQueryId ? t("consul.ui.update") : t("consul.ui.create") }} </Button>
          <Button v-if="editingQueryId" variant="ghost" size="icon" class="h-8 w-8" :title="t('consul.ui.cancelEdit')" @click="cancelQueryEdit"><X class="h-3.5 w-3.5" /></Button>
        </div>
        <div class="overflow-hidden rounded-md border">
          <div v-for="query in queries" :key="query.ID" class="flex min-h-12 items-center gap-2 border-b px-3 py-2 text-sm last:border-b-0">
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ query.Name || query.ID }}</div>
              <div class="truncate text-xs text-muted-foreground">{{ t("consul.ui.targetServiceValue", { service: query.Service.Service }) }} · {{ t("consul.ui.id") }} {{ query.ID }}</div>
            </div>
            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="queryBusy" :title="t('consul.ui.execute')" @click="executeQuery(query)"><Play class="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" class="h-7 w-7" :disabled="queryBusy" :title="t('consul.ui.explain')" @click="explainQuery(query)"><FileSearch class="h-3.5 w-3.5" /></Button>
            <Button v-if="canWriteQueries" variant="ghost" size="icon" class="h-7 w-7" :disabled="queryBusy" :title="t('consul.ui.edit')" @click="editQuery(query)"><Pencil class="h-3.5 w-3.5" /></Button>
            <Button v-if="canWriteQueries" variant="ghost" size="icon" class="h-7 w-7 text-destructive" :disabled="queryBusy" :title="t('consul.ui.delete')" @click="deleteQuery(query.ID)"><Trash2 class="h-3.5 w-3.5" /></Button>
          </div>
          <div v-if="!queryLoading && queryAvailable && queries.length === 0" class="px-3 py-8 text-center text-sm text-muted-foreground">{{ t("consul.ui.noPreparedQueries") }}</div>
          <div v-if="queryLoading" class="px-3 py-8 text-center text-sm text-muted-foreground">{{ t("consul.ui.loading") }}</div>
        </div>
        <div v-if="queryResult" class="mt-3 overflow-hidden rounded-md border">
          <div class="border-b bg-muted/20 px-3 py-2 text-sm font-medium">
            {{ t("consul.ui.queryExecutionResult", { count: queryResult.Nodes.length, datacenter: queryResult.Datacenter || "-" }) }}<span v-if="queryResult.DNS?.TTL" class="ml-2 text-xs font-normal text-muted-foreground">DNS TTL {{ queryResult.DNS.TTL }}</span>
          </div>
          <div v-for="item in queryResult.Nodes" :key="`${item.Node.Node}:${item.Service.ID}`" class="grid grid-cols-[minmax(8rem,1fr)_minmax(8rem,1fr)_minmax(8rem,1fr)] gap-3 border-b px-3 py-2 text-sm last:border-b-0">
            <span class="truncate">{{ item.Node.Node }}</span
            ><span class="truncate font-mono text-xs">{{ item.Service.ID }}</span
            ><span class="truncate font-mono text-xs">{{ queryEndpoint(item) }}</span>
          </div>
          <div v-if="queryResult.Nodes.length === 0" class="px-3 py-6 text-center text-sm text-muted-foreground">{{ t("consul.ui.noQueryNodes") }}</div>
        </div>
        <div v-if="queryDetails" class="mt-3">
          <div class="mb-1 text-xs font-medium text-muted-foreground">{{ t("consul.ui.queryExplanation") }}</div>
          <pre class="max-h-64 overflow-auto rounded-md border bg-muted/20 p-3 text-xs">{{ JSON.stringify(queryDetails, null, 2) }}</pre>
        </div>
      </TabsContent>

      <TabsContent value="events" class="m-0 min-h-0 flex-1 overflow-auto p-3">
        <p class="mb-3 text-sm text-muted-foreground">{{ t("consul.ui.eventsDescription") }}</p>
        <div v-if="capabilities && capabilities.events !== 'supported'" class="mb-3 rounded-md border p-3 text-sm text-muted-foreground">{{ t("consul.ui.capability", { status: capabilityLabel(capabilities.events) }) }}</div>
        <div v-if="eventError" class="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{{ eventError }}</div>
        <div v-if="canFireEvents" class="mb-3 rounded-md border p-3">
          <div class="grid grid-cols-[minmax(10rem,1fr)_minmax(12rem,2fr)_auto] gap-2">
            <Input v-model="eventName" :placeholder="t('consul.ui.eventName')" />
            <Input v-model="eventPayload" :placeholder="t('consul.ui.payload')" />
            <Button size="sm" :disabled="eventBusy || !eventValid" @click="fireEvent"><Play class="mr-1 h-3.5 w-3.5" />{{ t("consul.ui.fire") }}</Button>
          </div>
          <div class="mt-2 grid grid-cols-3 gap-2">
            <Input v-model="eventNodeFilter" :placeholder="t('consul.ui.eventNodeFilter')" />
            <Input v-model="eventServiceFilter" :placeholder="t('consul.ui.eventServiceFilter')" />
            <Input v-model="eventTagFilter" :placeholder="t('consul.ui.eventTagFilter')" />
          </div>
          <div class="mt-2 text-xs" :class="eventPayloadBytes > 100 ? 'text-destructive' : 'text-muted-foreground'">{{ t("consul.ui.eventPayloadBytes", { count: eventPayloadBytes }) }}</div>
        </div>
        <div class="overflow-hidden rounded-md border">
          <div v-for="event in events" :key="event.ID" class="border-b px-3 py-2 last:border-b-0">
            <div class="flex items-center gap-2">
              <span class="text-sm font-medium">{{ event.Name }}</span
              ><span class="text-xs text-muted-foreground">LTime {{ event.LTime }}</span>
            </div>
            <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <span v-if="event.NodeFilter">{{ t("consul.ui.node") }}: {{ event.NodeFilter }}</span
              ><span v-if="event.ServiceFilter">{{ t("consul.ui.service") }}: {{ event.ServiceFilter }}</span
              ><span v-if="event.TagFilter">{{ t("consul.ui.tags") }}: {{ event.TagFilter }}</span>
            </div>
            <div v-if="event.Payload" class="mt-1 break-all rounded bg-muted/30 px-2 py-1 font-mono text-xs">{{ decodeEventPayload(event.Payload) }}</div>
          </div>
          <div v-if="!eventLoading && eventAvailable && events.length === 0" class="px-3 py-8 text-center text-sm text-muted-foreground">{{ t("consul.ui.noEvents") }}</div>
          <div v-if="eventLoading" class="px-3 py-8 text-center text-sm text-muted-foreground">{{ t("consul.ui.loading") }}</div>
        </div>
      </TabsContent>

      <TabsContent value="coordinates" class="m-0 min-h-0 flex-1 overflow-auto p-3">
        <p class="mb-3 text-sm text-muted-foreground">{{ t("consul.ui.coordinatesDescription") }}</p>
        <div v-if="capabilities && capabilities.coordinates !== 'supported'" class="mb-3 rounded-md border p-3 text-sm text-muted-foreground">{{ t("consul.ui.capability", { status: capabilityLabel(capabilities.coordinates) }) }}</div>
        <div v-if="coordinateError" class="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{{ coordinateError }}</div>
        <div class="overflow-hidden rounded-md border">
          <div v-if="coordinates.length" class="grid grid-cols-[minmax(10rem,1.5fr)_minmax(7rem,1fr)_repeat(3,minmax(6rem,1fr))] gap-3 border-b bg-muted/20 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>{{ t("consul.ui.node") }}</span
            ><span>{{ t("consul.ui.segment") }}</span
            ><span>{{ t("consul.ui.error") }}</span
            ><span>{{ t("consul.ui.adjustment") }}</span
            ><span>{{ t("consul.ui.height") }}</span>
          </div>
          <div v-for="item in coordinates" :key="`${item.Node}:${item.Segment}`" class="grid grid-cols-[minmax(10rem,1.5fr)_minmax(7rem,1fr)_repeat(3,minmax(6rem,1fr))] gap-3 border-b px-3 py-2 text-sm last:border-b-0">
            <span class="truncate font-medium">{{ item.Node }}</span
            ><span class="truncate text-muted-foreground">{{ item.Segment || t("consul.ui.default") }}</span
            ><span class="font-mono text-xs">{{ item.Coord.Error }}</span
            ><span class="font-mono text-xs">{{ item.Coord.Adjustment }}</span
            ><span class="font-mono text-xs">{{ item.Coord.Height }}</span>
          </div>
          <div v-if="!coordinateLoading && coordinateAvailable && coordinates.length === 0" class="px-3 py-8 text-center text-sm text-muted-foreground">{{ t("consul.ui.noCoordinates") }}</div>
          <div v-if="coordinateLoading" class="px-3 py-8 text-center text-sm text-muted-foreground">{{ t("consul.ui.loading") }}</div>
        </div>
      </TabsContent>
    </Tabs>
  </div>
</template>

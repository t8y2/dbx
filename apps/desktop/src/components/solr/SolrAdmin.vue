<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, AlertTriangle, Boxes, Database, FileText, Gauge, Layers, Loader2, Network, Play, Plus, RefreshCcw, ScrollText, Search, Settings2, Shuffle, Trash2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import JsonTree from "@/components/common/JsonTree.vue";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import {
  parseAnalysisResponse,
  parseCoreStatus,
  parseSolrSchema,
  solrAdminErrorMessage,
  solrAdminGet,
  solrAdminPath,
  solrAdminViewById,
  solrAnalysisPath,
  solrCoreAdminRequest,
  SOLR_ADMIN_CORE_VIEWS,
  SOLR_ADMIN_SERVER_VIEWS,
  type SolrAdminResponse,
  type SolrAdminViewDef,
  type SolrAdminViewId,
  type SolrAnalysisResult,
  type SolrCoreStatus,
} from "@/lib/solr/solrAdmin";

const props = defineProps<{
  connectionId: string;
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();

const VIEW_ICONS: Record<SolrAdminViewId, typeof Gauge> = {
  dashboard: Gauge,
  logging: ScrollText,
  javaProps: Settings2,
  threads: Activity,
  coreAdmin: Boxes,
  metrics: Gauge,
  overview: Layers,
  analysis: Search,
  documents: FileText,
  paramsets: Settings2,
  files: FileText,
  ping: Activity,
  plugins: Boxes,
  query: Play,
  replication: Network,
  schema: Database,
  segments: Layers,
};

const activeViewId = ref<SolrAdminViewId>("dashboard");
const activeView = computed<SolrAdminViewDef>(() => solrAdminViewById(activeViewId.value) ?? SOLR_ADMIN_SERVER_VIEWS[0]);

const cores = ref<SolrCoreStatus[]>([]);
const selectedCore = ref("");
const loading = ref(false);
const error = ref("");
const response = ref<SolrAdminResponse | null>(null);

const connectionName = computed(() => connectionStore.getConfig(props.connectionId)?.name ?? "");
const coreNames = computed(() => cores.value.map((core) => core.name));

const responseBody = computed(() => response.value?.body ?? null);
const dashboardEntries = computed(() => {
  const body = responseBody.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const root = body as Record<string, unknown>;
  const jvm = (root.jvm ?? {}) as Record<string, unknown>;
  const lucene = (root.lucene ?? {}) as Record<string, unknown>;
  const memory = (jvm.memory ?? {}) as Record<string, unknown>;
  const pick = (key: string, value: unknown) => (value == null || value === "" ? [] : [{ key, value: String(value) }]);
  return [
    ...pick("mode", root.mode),
    ...pick("solr_home", root.solr_home),
    ...pick("core_root", root.core_root),
    ...pick("lucene_spec", lucene["solr-spec-version"]),
    ...pick("lucene_impl", lucene["solr-impl-version"]),
    ...pick("jvm_name", jvm.name),
    ...pick("jvm_version", jvm.version),
    ...pick("jvm_vendor", jvm.vendor),
    ...pick("processors", jvm.processors),
    ...pick("memory_free", memory.free),
    ...pick("memory_total", memory.total),
    ...pick("memory_max", memory.max),
    ...pick("memory_used", memory.used),
  ];
});

const propertyEntries = computed(() => {
  const body = responseBody.value;
  const props_ = (body as Record<string, unknown> | null)?.["system.properties"];
  if (!props_ || typeof props_ !== "object" || Array.isArray(props_)) return [];
  return Object.entries(props_ as Record<string, unknown>)
    .map(([key, value]) => ({ key, value: String(value) }))
    .sort((a, b) => a.key.localeCompare(b.key));
});

const loggingLevels = computed(() => {
  const body = responseBody.value;
  const levels = (body as Record<string, unknown> | null)?.loggers;
  if (!Array.isArray(levels)) return [];
  return levels
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry) => ({ name: String(entry.name ?? ""), level: String(entry.level ?? ""), set: entry.set === true }))
    .sort((a, b) => a.name.localeCompare(b.name));
});

const lukeIndexEntries = computed(() => {
  const body = responseBody.value;
  const index = (body as Record<string, unknown> | null)?.index;
  if (!index || typeof index !== "object" || Array.isArray(index)) return [];
  return Object.entries(index as Record<string, unknown>)
    .filter(([, value]) => value != null && typeof value !== "object")
    .map(([key, value]) => ({ key, value: String(value) }));
});

const schemaInfo = computed(() => parseSolrSchema(responseBody.value));
const segmentEntries = computed(() => {
  const body = responseBody.value;
  const segments = (body as Record<string, unknown> | null)?.segments;
  if (!segments || typeof segments !== "object" || Array.isArray(segments)) return [];
  return Object.entries(segments as Record<string, Record<string, unknown>>)
    .map(([name, info]) => ({
      name,
      numDocs: info?.numDocs,
      delDocs: info?.delDocs ?? info?.deletedDocs,
      sizeInBytes: info?.sizeInBytes ?? info?.size,
      age: info?.age,
      source: info?.source,
    }))
    .sort((a, b) => b.name.localeCompare(a.name));
});

const pingResult = computed(() => {
  const body = responseBody.value;
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const root = body as Record<string, unknown>;
  const header = (root.responseHeader ?? {}) as Record<string, unknown>;
  return { status: String(root.status ?? ""), qtime: typeof header.QTime === "number" ? header.QTime : undefined };
});

async function loadCores() {
  try {
    const res = await solrAdminGet(props.connectionId, "/admin/cores?action=STATUS");
    cores.value = parseCoreStatus(res.body);
    if (!selectedCore.value && cores.value.length) selectedCore.value = cores.value[0].name;
  } catch {
    // core 列表失败不阻塞 server 视图；selector 为空时 core 视图提示选择
  }
}

async function load() {
  const view = activeView.value;
  if (view.view === "action") return;
  if (view.scope === "core" && !selectedCore.value) {
    response.value = null;
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    response.value = await solrAdminGet(props.connectionId, solrAdminPath(view, selectedCore.value));
  } catch (e: any) {
    error.value = String(e?.message ?? e);
    response.value = null;
  } finally {
    loading.value = false;
  }
}

function selectView(id: SolrAdminViewId) {
  if (id === "documents") {
    openDocuments();
    return;
  }
  if (id === "query") {
    openQuery();
    return;
  }
  activeViewId.value = id;
  load();
}

function openDocuments() {
  if (!selectedCore.value) return;
  const tab = queryStore.createTab(props.connectionId, "default", selectedCore.value, "mongo");
  queryStore.updateSql(tab, selectedCore.value);
}

function openQuery() {
  const core = selectedCore.value;
  const initial = core ? `GET /${core}/select?q=*:*&rows=20` : "GET /admin/cores?action=STATUS";
  queryStore.createTab(props.connectionId, "default", core ? `${core} - query` : "solr query", "query", undefined, initial);
}

/* ---------- Analysis ---------- */

const analysisField = ref("");
const analysisText = ref("");
const analysisQuery = ref("");
const analysisLoading = ref(false);
const analysisError = ref("");
const analysisResult = ref<SolrAnalysisResult | null>(null);

async function runAnalysis() {
  if (!selectedCore.value || !analysisField.value.trim() || !analysisText.value) return;
  analysisLoading.value = true;
  analysisError.value = "";
  try {
    const res = await solrAdminGet(props.connectionId, solrAnalysisPath(selectedCore.value, analysisField.value.trim(), analysisText.value, analysisQuery.value || undefined));
    analysisResult.value = parseAnalysisResponse(res.body, analysisField.value.trim());
  } catch (e: any) {
    analysisError.value = String(e?.message ?? e);
    analysisResult.value = null;
  } finally {
    analysisLoading.value = false;
  }
}

/* ---------- Core Admin actions ---------- */

const actionPending = ref(false);
const confirmAction = ref<{ action: "RELOAD" | "UNLOAD" | "RENAME" | "SWAP"; core: string; label: string } | null>(null);
const renameTarget = ref("");
const swapTarget = ref("");
const createOpen = ref(false);
const createName = ref("");
const createConfigSet = ref("_default");
const createInstanceDir = ref("");

function askCoreAction(action: "RELOAD" | "UNLOAD" | "RENAME" | "SWAP", core: string) {
  renameTarget.value = "";
  swapTarget.value = "";
  confirmAction.value = { action, core, label: t(`solrAdmin.actions.${action.toLowerCase()}`) };
}

async function runCoreAction() {
  const pending = confirmAction.value;
  if (!pending) return;
  actionPending.value = true;
  try {
    const params: Record<string, string> = { action: pending.action };
    if (pending.action === "SWAP") {
      params.core = pending.core;
      params.other = swapTarget.value;
    } else if (pending.action === "RENAME") {
      params.core = pending.core;
      params.other = renameTarget.value;
    } else {
      params.core = pending.core;
    }
    const res = await solrCoreAdminRequest(props.connectionId, params);
    const failed = solrAdminErrorMessage(res);
    if (failed) throw new Error(failed);
    toast(t("solrAdmin.actions.success", { action: pending.label, core: pending.core }), 3000);
    confirmAction.value = null;
    await loadCores();
    if (activeViewId.value === "coreAdmin") await load();
  } catch (e: any) {
    toast(t("solrAdmin.actions.failed", { message: String(e?.message ?? e) }), 5000);
  } finally {
    actionPending.value = false;
  }
}

async function runCreateCore() {
  const name = createName.value.trim();
  if (!name) return;
  actionPending.value = true;
  try {
    const params: Record<string, string> = { action: "CREATE", name, configSet: createConfigSet.value.trim() || "_default" };
    if (createInstanceDir.value.trim()) params.instanceDir = createInstanceDir.value.trim();
    const res = await solrCoreAdminRequest(props.connectionId, params);
    const failed = solrAdminErrorMessage(res);
    if (failed) throw new Error(failed);
    toast(t("solrAdmin.actions.success", { action: t("solrAdmin.actions.create"), core: name }), 3000);
    createOpen.value = false;
    createName.value = "";
    createInstanceDir.value = "";
    await loadCores();
    if (activeViewId.value === "coreAdmin") await load();
  } catch (e: any) {
    toast(t("solrAdmin.actions.failed", { message: String(e?.message ?? e) }), 5000);
  } finally {
    actionPending.value = false;
  }
}

function formatBytes(value: unknown): string {
  const bytes = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatUptime(ms: unknown): string {
  const total = typeof ms === "number" ? ms : Number(ms);
  if (!Number.isFinite(total) || total < 0) return "-";
  const seconds = Math.floor(total / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

onMounted(async () => {
  await loadCores();
  await load();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex items-center gap-3 border-b px-4 py-2">
      <Gauge class="h-4 w-4 text-muted-foreground" />
      <span class="text-sm font-medium">Solr Admin</span>
      <span v-if="connectionName" class="text-xs text-muted-foreground">{{ connectionName }}</span>
      <div class="ml-auto flex items-center gap-2">
        <Badge v-if="response" variant="outline" class="font-mono text-xs">HTTP {{ response.status }}</Badge>
        <span v-if="response" class="text-xs text-muted-foreground">{{ response.elapsedMs }} ms</span>
        <Button size="sm" variant="outline" :disabled="loading" @click="load">
          <RefreshCcw class="mr-1.5 h-3.5 w-3.5" :class="{ 'animate-spin': loading }" />
          {{ t("solrAdmin.refresh") }}
        </Button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1">
      <div class="w-44 shrink-0 overflow-y-auto border-r py-2">
        <div class="px-3 pb-1 text-xs font-medium uppercase text-muted-foreground">{{ t("solrAdmin.sections.server") }}</div>
        <button v-for="view in SOLR_ADMIN_SERVER_VIEWS" :key="view.id" class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent" :class="{ 'bg-accent font-medium': activeViewId === view.id }" @click="selectView(view.id)">
          <component :is="VIEW_ICONS[view.id]" class="h-3.5 w-3.5 text-muted-foreground" />
          {{ t(`solrAdmin.views.${view.id}`) }}
        </button>

        <div class="mt-3 px-3 pb-1 text-xs font-medium uppercase text-muted-foreground">{{ t("solrAdmin.sections.core") }}</div>
        <div class="px-3 pb-2">
          <Select v-model="selectedCore" @update:model-value="activeView.scope === 'core' && load()">
            <SelectTrigger class="h-7 w-full text-xs">
              <SelectValue :placeholder="t('solrAdmin.selectCore')" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="name in coreNames" :key="name" :value="name">{{ name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <button v-for="view in SOLR_ADMIN_CORE_VIEWS" :key="view.id" class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-50" :class="{ 'bg-accent font-medium': activeViewId === view.id }" :disabled="!selectedCore" @click="selectView(view.id)">
          <component :is="VIEW_ICONS[view.id]" class="h-3.5 w-3.5 text-muted-foreground" />
          {{ t(`solrAdmin.views.${view.id}`) }}
        </button>
      </div>

      <div class="flex min-w-0 flex-1 flex-col">
        <div class="border-b px-4 py-2 text-sm font-medium">{{ t(`solrAdmin.views.${activeView.id}`) }}</div>

        <div v-if="activeView.scope === 'core' && !selectedCore" class="p-6 text-sm text-muted-foreground">
          {{ t("solrAdmin.noCore") }}
        </div>
        <div v-else-if="error" class="flex items-start gap-2 p-4 text-sm text-destructive">
          <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
          <pre class="whitespace-pre-wrap font-mono text-xs">{{ error }}</pre>
        </div>
        <div v-else-if="loading && !response" class="flex flex-1 items-center justify-center">
          <Loader2 class="h-5 w-5 animate-spin text-muted-foreground" />
        </div>

        <div v-else class="min-h-0 flex-1 overflow-y-auto p-4">
          <!-- Dashboard -->
          <template v-if="activeView.view === 'dashboard'">
            <div class="grid grid-cols-2 gap-2 md:grid-cols-3">
              <div v-for="entry in dashboardEntries" :key="entry.key" class="rounded border p-2">
                <div class="text-xs text-muted-foreground">{{ t(`solrAdmin.dashboard.${entry.key}`) }}</div>
                <div class="truncate font-mono text-sm" :title="entry.value">{{ entry.value }}</div>
              </div>
            </div>
            <div class="mt-4">
              <JsonTree v-if="responseBody" :value="responseBody" :initial-expanded-depth="1" virtualized />
            </div>
          </template>

          <!-- Java Properties -->
          <table v-else-if="activeView.view === 'properties'" class="w-full text-sm">
            <tbody>
              <tr v-for="entry in propertyEntries" :key="entry.key" class="border-b last:border-0">
                <td class="w-1/3 py-1 pr-4 font-mono text-xs">{{ entry.key }}</td>
                <td class="break-all py-1 font-mono text-xs text-muted-foreground">{{ entry.value }}</td>
              </tr>
            </tbody>
          </table>

          <!-- Logging -->
          <table v-else-if="activeView.view === 'logging'" class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-xs text-muted-foreground">
                <th class="py-1 pr-4 font-medium">{{ t("solrAdmin.logging.name") }}</th>
                <th class="w-24 py-1 pr-4 font-medium">{{ t("solrAdmin.logging.level") }}</th>
                <th class="w-24 py-1 font-medium">{{ t("solrAdmin.logging.set") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="entry in loggingLevels" :key="entry.name" class="border-b last:border-0">
                <td class="py-1 pr-4 font-mono text-xs">{{ entry.name }}</td>
                <td class="py-1 pr-4">
                  <Badge variant="outline" class="text-xs">{{ entry.level || "-" }}</Badge>
                </td>
                <td class="py-1 text-xs text-muted-foreground">{{ entry.set ? "✓" : "" }}</td>
              </tr>
            </tbody>
          </table>

          <!-- Core Admin -->
          <template v-else-if="activeView.view === 'coreAdmin'">
            <div class="mb-3 flex justify-end">
              <Button size="sm" @click="createOpen = true">
                <Plus class="mr-1.5 h-3.5 w-3.5" />
                {{ t("solrAdmin.actions.create") }}
              </Button>
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-left text-xs text-muted-foreground">
                  <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.core.name") }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.core.docs") }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.core.size") }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.core.segments") }}</th>
                  <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.core.uptime") }}</th>
                  <th class="py-1 font-medium">{{ t("solrAdmin.core.ops") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="core in cores" :key="core.name" class="border-b last:border-0">
                  <td class="py-1.5 pr-3 font-mono text-xs font-medium">{{ core.name }}</td>
                  <td class="py-1.5 pr-3 font-mono text-xs">
                    {{ core.numDocs ?? "-" }}<span v-if="core.deletedDocs" class="text-muted-foreground"> (-{{ core.deletedDocs }})</span>
                  </td>
                  <td class="py-1.5 pr-3 font-mono text-xs">{{ formatBytes(core.sizeInBytes) }}</td>
                  <td class="py-1.5 pr-3 font-mono text-xs">{{ core.segmentCount ?? "-" }}</td>
                  <td class="py-1.5 pr-3 font-mono text-xs">{{ formatUptime(core.uptime) }}</td>
                  <td class="py-1.5">
                    <div class="flex gap-1">
                      <Button size="sm" variant="outline" class="h-6 px-2 text-xs" @click="askCoreAction('RELOAD', core.name)">
                        <RefreshCcw class="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="outline" class="h-6 px-2 text-xs" @click="askCoreAction('RENAME', core.name)">
                        <FileText class="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="outline" class="h-6 px-2 text-xs" @click="askCoreAction('SWAP', core.name)">
                        <Shuffle class="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="outline" class="h-6 px-2 text-xs text-destructive" @click="askCoreAction('UNLOAD', core.name)">
                        <Trash2 class="h-3 w-3" />
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
            <div class="mt-4">
              <JsonTree v-if="responseBody" :value="responseBody" :initial-expanded-depth="1" virtualized />
            </div>
          </template>

          <!-- Core Overview (luke) -->
          <template v-else-if="activeView.view === 'overview'">
            <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
              <div v-for="entry in lukeIndexEntries" :key="entry.key" class="rounded border p-2">
                <div class="text-xs text-muted-foreground">{{ entry.key }}</div>
                <div class="truncate font-mono text-sm" :title="entry.value">{{ entry.value }}</div>
              </div>
            </div>
            <div class="mt-4">
              <JsonTree v-if="responseBody" :value="responseBody" :initial-expanded-depth="1" virtualized />
            </div>
          </template>

          <!-- Ping -->
          <template v-else-if="activeView.view === 'ping'">
            <div class="flex items-center gap-3">
              <Badge :variant="pingResult?.status === 'OK' ? 'default' : 'destructive'" class="text-sm">{{ pingResult?.status || "-" }}</Badge>
              <span v-if="pingResult?.qtime != null" class="text-sm text-muted-foreground">{{ pingResult.qtime }} ms</span>
            </div>
            <div class="mt-4">
              <JsonTree v-if="responseBody" :value="responseBody" :initial-expanded-depth="2" />
            </div>
          </template>

          <!-- Schema -->
          <template v-else-if="activeView.view === 'schema'">
            <div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge v-if="schemaInfo.uniqueKey" variant="outline">uniqueKey: {{ schemaInfo.uniqueKey }}</Badge>
              <Badge variant="outline">{{ schemaInfo.fields.length }} {{ t("solrAdmin.schema.fields") }}</Badge>
              <Badge variant="outline">{{ schemaInfo.dynamicFields.length }} {{ t("solrAdmin.schema.dynamicFields") }}</Badge>
              <Badge variant="outline">{{ schemaInfo.fieldTypeCount }} {{ t("solrAdmin.schema.fieldTypes") }}</Badge>
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b text-left text-xs text-muted-foreground">
                  <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.schema.name") }}</th>
                  <th class="w-32 py-1 pr-3 font-medium">{{ t("solrAdmin.schema.type") }}</th>
                  <th class="w-20 py-1 font-medium">{{ t("solrAdmin.schema.flags") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="field in schemaInfo.fields" :key="field.name" class="border-b last:border-0">
                  <td class="py-1 pr-3 font-mono text-xs">
                    {{ field.name }}
                    <Badge v-if="field.name === schemaInfo.uniqueKey" variant="default" class="ml-1 px-1 text-[10px]">PK</Badge>
                  </td>
                  <td class="py-1 pr-3 font-mono text-xs">{{ field.type }}</td>
                  <td class="py-1 font-mono text-[10px] text-muted-foreground">
                    {{ [field.indexed ? "I" : "", field.stored ? "S" : "", field.required ? "R" : "", field.multiValued ? "M" : "", field.docValues ? "D" : ""].filter(Boolean).join(" ") }}
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-if="schemaInfo.copyFields.length" class="mt-4">
              <div class="mb-1 text-xs font-medium text-muted-foreground">copyFields</div>
              <div v-for="cf in schemaInfo.copyFields" :key="`${cf.source}->${cf.dest}`" class="font-mono text-xs">{{ cf.source }} → {{ cf.dest }}</div>
            </div>
            <div class="mt-4">
              <JsonTree v-if="responseBody" :value="responseBody" :initial-expanded-depth="1" virtualized />
            </div>
          </template>

          <!-- Analysis -->
          <template v-else-if="activeView.view === 'analysis'">
            <div class="mb-3 grid grid-cols-[140px_1fr_1fr_auto] items-end gap-2">
              <div>
                <Label class="text-xs">{{ t("solrAdmin.analysis.field") }}</Label>
                <Input v-model="analysisField" class="h-8 font-mono text-xs" placeholder="code" @keyup.enter="runAnalysis" />
              </div>
              <div>
                <Label class="text-xs">{{ t("solrAdmin.analysis.indexValue") }}</Label>
                <Input v-model="analysisText" class="h-8 font-mono text-xs" :placeholder="t('solrAdmin.analysis.indexPlaceholder')" @keyup.enter="runAnalysis" />
              </div>
              <div>
                <Label class="text-xs">{{ t("solrAdmin.analysis.queryValue") }}</Label>
                <Input v-model="analysisQuery" class="h-8 font-mono text-xs" :placeholder="t('solrAdmin.analysis.queryPlaceholder')" @keyup.enter="runAnalysis" />
              </div>
              <Button size="sm" class="h-8" :disabled="analysisLoading || !analysisField.trim() || !analysisText" @click="runAnalysis">
                <Loader2 v-if="analysisLoading" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
                {{ t("solrAdmin.analysis.run") }}
              </Button>
            </div>
            <div v-if="analysisError" class="mb-3 text-sm text-destructive">{{ analysisError }}</div>
            <template v-if="analysisResult">
              <div v-for="section in ['index', 'query'] as const" :key="section">
                <div v-if="analysisResult[section].length" class="mb-3">
                  <div class="mb-1 text-xs font-medium uppercase text-muted-foreground">{{ t(`solrAdmin.analysis.${section}`) }}</div>
                  <div class="space-y-1">
                    <div v-for="(stage, i) in analysisResult[section]" :key="i" class="flex items-start gap-3 rounded border p-2">
                      <div class="w-64 shrink-0 break-all font-mono text-[10px] text-muted-foreground" :title="stage.name">{{ stage.name.split(".").pop() }}</div>
                      <div class="flex flex-wrap gap-1">
                        <Badge v-for="(token, j) in stage.tokens" :key="j" variant="secondary" class="font-mono text-xs">{{ token }}</Badge>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
              <div v-if="!analysisResult.index.length && !analysisResult.query.length" class="text-sm text-muted-foreground">{{ t("solrAdmin.analysis.empty") }}</div>
            </template>
          </template>

          <!-- Segments -->
          <table v-else-if="activeView.view === 'segments' && segmentEntries.length" class="w-full text-sm">
            <thead>
              <tr class="border-b text-left text-xs text-muted-foreground">
                <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.segments.name") }}</th>
                <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.core.docs") }}</th>
                <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.segments.deleted") }}</th>
                <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.core.size") }}</th>
                <th class="py-1 pr-3 font-medium">{{ t("solrAdmin.segments.age") }}</th>
                <th class="py-1 font-medium">{{ t("solrAdmin.segments.source") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="seg in segmentEntries" :key="seg.name" class="border-b last:border-0">
                <td class="py-1 pr-3 font-mono text-xs">{{ seg.name }}</td>
                <td class="py-1 pr-3 font-mono text-xs">{{ seg.numDocs ?? "-" }}</td>
                <td class="py-1 pr-3 font-mono text-xs">{{ seg.delDocs ?? "-" }}</td>
                <td class="py-1 pr-3 font-mono text-xs">{{ formatBytes(seg.sizeInBytes) }}</td>
                <td class="py-1 pr-3 font-mono text-xs">{{ seg.age ?? "-" }}</td>
                <td class="py-1 font-mono text-xs">{{ seg.source ?? "-" }}</td>
              </tr>
            </tbody>
          </table>

          <!-- 通用 JSON 视图（threads / metrics / paramsets / files / plugins / replication 及兜底） -->
          <JsonTree v-else-if="responseBody" :value="responseBody" :initial-expanded-depth="2" virtualized />
          <div v-else-if="response" class="text-sm text-muted-foreground">{{ t("solrAdmin.emptyBody") }}</div>
        </div>
      </div>
    </div>

    <!-- 危险/写操作确认 -->
    <Dialog
      :open="confirmAction !== null"
      @update:open="
        (open) => {
          if (!open && !actionPending) confirmAction = null;
        }
      "
    >
      <DialogContent class="max-w-sm" :show-close-button="!actionPending">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle class="h-4 w-4 text-destructive" />
            {{ confirmAction?.label }}
          </DialogTitle>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">
          {{ t("solrAdmin.actions.confirm", { action: confirmAction?.label, core: confirmAction?.core }) }}
        </p>
        <div v-if="confirmAction?.action === 'RENAME'" class="mt-2">
          <Label class="text-xs">{{ t("solrAdmin.actions.newName") }}</Label>
          <Input v-model="renameTarget" class="mt-1 h-8 font-mono text-xs" :placeholder="confirmAction.core" />
        </div>
        <div v-else-if="confirmAction?.action === 'SWAP'" class="mt-2">
          <Label class="text-xs">{{ t("solrAdmin.actions.swapWith") }}</Label>
          <Select v-model="swapTarget">
            <SelectTrigger class="mt-1 h-8 w-full text-xs"><SelectValue :placeholder="t('solrAdmin.selectCore')" /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="name in coreNames.filter((n) => n !== confirmAction?.core)" :key="name" :value="name">{{ name }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="actionPending" @click="confirmAction = null">{{ t("dangerDialog.cancel") }}</Button>
          <Button :variant="confirmAction?.action === 'UNLOAD' ? 'destructive' : 'default'" :disabled="actionPending || (confirmAction?.action === 'RENAME' && !renameTarget.trim()) || (confirmAction?.action === 'SWAP' && !swapTarget)" @click="runCoreAction">
            <Loader2 v-if="actionPending" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ confirmAction?.label }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- CREATE core -->
    <Dialog
      :open="createOpen"
      @update:open="
        (open) => {
          if (!open && !actionPending) createOpen = false;
        }
      "
    >
      <DialogContent class="max-w-sm" :show-close-button="!actionPending">
        <DialogHeader>
          <DialogTitle>{{ t("solrAdmin.actions.create") }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-3">
          <div>
            <Label class="text-xs">{{ t("solrAdmin.core.name") }}</Label>
            <Input v-model="createName" class="mt-1 h-8 font-mono text-xs" placeholder="new_core" />
          </div>
          <div>
            <Label class="text-xs">configSet</Label>
            <Input v-model="createConfigSet" class="mt-1 h-8 font-mono text-xs" placeholder="_default" />
          </div>
          <div>
            <Label class="text-xs">instanceDir ({{ t("solrAdmin.optional") }})</Label>
            <Input v-model="createInstanceDir" class="mt-1 h-8 font-mono text-xs" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="actionPending" @click="createOpen = false">{{ t("dangerDialog.cancel") }}</Button>
          <Button :disabled="actionPending || !createName.trim()" @click="runCreateCore">
            <Loader2 v-if="actionPending" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("solrAdmin.actions.create") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

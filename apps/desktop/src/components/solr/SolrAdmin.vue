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
import { executeQuery } from "@/lib/backend/api";
import type { QueryResult } from "@/types/database";
import {
  buildSolrQuery,
  defaultSolrQueryForm,
  parseAnalysisResponse,
  parseCoreStatus,
  parseParamsetNames,
  parseSolrNumFound,
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
  type SolrQueryParam,
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
  if (view.view === "queryForm") {
    // core 切换后 paramset 列表过期，结果属于旧 core，一并清掉
    queryResult.value = null;
    await loadParamsets();
    return;
  }
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
  activeViewId.value = id;
  if (id === "query") {
    loadParamsets();
    return;
  }
  load();
}

function openDocuments() {
  if (!selectedCore.value) return;
  const tab = queryStore.createTab(props.connectionId, "default", selectedCore.value, "mongo");
  queryStore.updateSql(tab, selectedCore.value);
}

/* ---------- Query Builder（对标官方 Admin UI Query 表单） ---------- */

const queryForm = ref(defaultSolrQueryForm());
const paramsetNames = ref<string[]>([]);
const queryRunning = ref(false);
const queryError = ref("");
const queryResult = ref<QueryResult | null>(null);
const queryShowRaw = ref(false);

const builtQuery = computed(() => buildSolrQuery(selectedCore.value, queryForm.value));
const queryNumFound = computed(() => parseSolrNumFound(queryResult.value?.elasticsearch_raw_body ?? ""));
const queryRawBody = computed(() => queryResult.value?.elasticsearch_raw_body ?? "");
const queryRawParsed = computed(() => {
  if (!queryRawBody.value) return null;
  try {
    return JSON.parse(queryRawBody.value);
  } catch {
    return queryRawBody.value;
  }
});

async function loadParamsets() {
  if (!selectedCore.value) {
    paramsetNames.value = [];
    return;
  }
  try {
    const res = await solrAdminGet(props.connectionId, `/${encodeURIComponent(selectedCore.value)}/config/params`);
    paramsetNames.value = parseParamsetNames(res.body);
  } catch {
    paramsetNames.value = [];
  }
}

function toggleParamset(name: string) {
  const list = queryForm.value.useParams;
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else list.push(name);
}

function addQueryRow(list: string[] | SolrQueryParam[], empty: string | SolrQueryParam) {
  (list as Array<string | SolrQueryParam>).push(empty);
}

function removeQueryRow(list: unknown[], index: number) {
  list.splice(index, 1);
}

async function runQueryForm() {
  if (!selectedCore.value) return;
  // JSON 模式先本地校验，非法 JSON 直接提示不发请求
  if (builtQuery.value.jsonMode) {
    try {
      JSON.parse(queryForm.value.jsonQuery);
    } catch (e) {
      queryError.value = `Invalid JSON: ${String((e as Error)?.message ?? e)}`;
      return;
    }
  }
  queryRunning.value = true;
  queryError.value = "";
  try {
    queryResult.value = await executeQuery(props.connectionId, "", builtQuery.value.text);
    queryShowRaw.value = false;
  } catch (e: any) {
    queryError.value = String(e?.message ?? e);
    queryResult.value = null;
  } finally {
    queryRunning.value = false;
  }
}

function openQueryInConsole() {
  const core = selectedCore.value;
  queryStore.createTab(props.connectionId, "default", core ? `${core} - query` : "solr query", "query", undefined, builtQuery.value.text);
}

function queryCellText(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
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

          <!-- Query Builder（对标官方 Admin UI Query 表单） -->
          <template v-else-if="activeView.view === 'queryForm'">
            <div class="space-y-3 text-sm">
              <div class="grid grid-cols-2 gap-2">
                <div>
                  <Label class="text-xs">Request-Handler (qt)</Label>
                  <Input v-model="queryForm.handler" class="h-8 font-mono text-xs" placeholder="/select" />
                </div>
                <div>
                  <Label class="text-xs">defType</Label>
                  <Select v-model="queryForm.defType">
                    <SelectTrigger class="h-8 w-full text-xs"><SelectValue :placeholder="t('solrAdmin.queryForm.defaultParser')" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="lucene">lucene</SelectItem>
                      <SelectItem value="dismax">dismax</SelectItem>
                      <SelectItem value="edismax">edismax</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label class="text-xs">q</Label>
                <Input v-model="queryForm.q" class="h-8 font-mono text-xs" placeholder="*:*" />
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div>
                  <Label class="text-xs">q.op</Label>
                  <Select v-model="queryForm.qop">
                    <SelectTrigger class="h-8 w-full text-xs"><SelectValue placeholder="OR / AND" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="OR">OR</SelectItem>
                      <SelectItem value="AND">AND</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label class="text-xs">sort</Label>
                  <Input v-model="queryForm.sort" class="h-8 font-mono text-xs" placeholder="field asc/desc" />
                </div>
              </div>

              <div>
                <Label class="text-xs">fq</Label>
                <div v-for="(_, i) in queryForm.fq" :key="i" class="mb-1 flex items-center gap-1">
                  <Input v-model="queryForm.fq[i]" class="h-8 font-mono text-xs" />
                  <Button size="sm" variant="outline" class="h-8 w-8 shrink-0 px-0" @click="removeQueryRow(queryForm.fq, i)">−</Button>
                </div>
                <Button size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="addQueryRow(queryForm.fq, '')">+ fq</Button>
              </div>

              <div class="grid grid-cols-4 gap-2">
                <div>
                  <Label class="text-xs">start</Label>
                  <Input v-model="queryForm.start" class="h-8 font-mono text-xs" placeholder="0" />
                </div>
                <div>
                  <Label class="text-xs">rows</Label>
                  <Input v-model="queryForm.rows" class="h-8 font-mono text-xs" placeholder="10" />
                </div>
                <div>
                  <Label class="text-xs">fl</Label>
                  <Input v-model="queryForm.fl" class="h-8 font-mono text-xs" />
                </div>
                <div>
                  <Label class="text-xs">df</Label>
                  <Input v-model="queryForm.df" class="h-8 font-mono text-xs" />
                </div>
              </div>

              <div class="grid grid-cols-2 gap-2">
                <div v-if="paramsetNames.length">
                  <Label class="text-xs">{{ t("solrAdmin.queryForm.paramsets") }}</Label>
                  <div class="flex flex-wrap gap-1 pt-1">
                    <Badge v-for="name in paramsetNames" :key="name" :variant="queryForm.useParams.includes(name) ? 'default' : 'outline'" class="cursor-pointer text-xs" @click="toggleParamset(name)">
                      {{ name }}
                    </Badge>
                  </div>
                </div>
                <div>
                  <Label class="text-xs">wt</Label>
                  <Select v-model="queryForm.wt">
                    <SelectTrigger class="h-8 w-full text-xs"><SelectValue placeholder="json" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="json">json</SelectItem>
                      <SelectItem value="xml">xml</SelectItem>
                      <SelectItem value="csv">csv</SelectItem>
                      <SelectItem value="python">python</SelectItem>
                      <SelectItem value="ruby">ruby</SelectItem>
                      <SelectItem value="php">php</SelectItem>
                      <SelectItem value="raw">raw</SelectItem>
                    </SelectContent>
                  </Select>
                  <label class="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.indent" type="checkbox" /> indent on</label>
                  <label class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.debugQuery" type="checkbox" /> debugQuery</label>
                </div>
              </div>

              <!-- hl -->
              <div class="rounded border p-2">
                <label class="flex items-center gap-1.5 text-xs font-medium"><input v-model="queryForm.hl.enabled" type="checkbox" /> hl</label>
                <div v-if="queryForm.hl.enabled" class="mt-2 grid grid-cols-3 gap-2">
                  <div><Label class="text-xs">hl.fl</Label><Input v-model="queryForm.hl.fl" class="h-8 font-mono text-xs" /></div>
                  <div><Label class="text-xs">hl.snippets</Label><Input v-model="queryForm.hl.snippets" class="h-8 font-mono text-xs" /></div>
                  <div><Label class="text-xs">hl.fragsize</Label><Input v-model="queryForm.hl.fragsize" class="h-8 font-mono text-xs" /></div>
                  <div><Label class="text-xs">hl.simple.pre</Label><Input v-model="queryForm.hl.simplePre" class="h-8 font-mono text-xs" placeholder="&lt;em&gt;" /></div>
                  <div><Label class="text-xs">hl.simple.post</Label><Input v-model="queryForm.hl.simplePost" class="h-8 font-mono text-xs" placeholder="&lt;/em&gt;" /></div>
                  <div class="flex items-end gap-3 pb-1.5">
                    <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.hl.requireFieldMatch" type="checkbox" /> hl.requireFieldMatch</label>
                    <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.hl.mergeContiguous" type="checkbox" /> hl.mergeContiguous</label>
                  </div>
                </div>
              </div>

              <!-- facet -->
              <div class="rounded border p-2">
                <label class="flex items-center gap-1.5 text-xs font-medium"><input v-model="queryForm.facet.enabled" type="checkbox" /> facet</label>
                <div v-if="queryForm.facet.enabled" class="mt-2 space-y-2">
                  <div class="grid grid-cols-2 gap-2">
                    <div>
                      <Label class="text-xs">facet.field</Label>
                      <div v-for="(_, i) in queryForm.facet.fields" :key="i" class="mb-1 flex items-center gap-1">
                        <Input v-model="queryForm.facet.fields[i]" class="h-8 font-mono text-xs" />
                        <Button size="sm" variant="outline" class="h-8 w-8 shrink-0 px-0" @click="removeQueryRow(queryForm.facet.fields, i)">−</Button>
                      </div>
                      <Button size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="addQueryRow(queryForm.facet.fields, '')">+ facet.field</Button>
                    </div>
                    <div>
                      <Label class="text-xs">facet.query</Label>
                      <div v-for="(_, i) in queryForm.facet.queries" :key="i" class="mb-1 flex items-center gap-1">
                        <Input v-model="queryForm.facet.queries[i]" class="h-8 font-mono text-xs" />
                        <Button size="sm" variant="outline" class="h-8 w-8 shrink-0 px-0" @click="removeQueryRow(queryForm.facet.queries, i)">−</Button>
                      </div>
                      <Button size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="addQueryRow(queryForm.facet.queries, '')">+ facet.query</Button>
                    </div>
                  </div>
                  <div class="grid grid-cols-4 gap-2">
                    <div><Label class="text-xs">facet.prefix</Label><Input v-model="queryForm.facet.prefix" class="h-8 font-mono text-xs" /></div>
                    <div><Label class="text-xs">facet.sort</Label><Input v-model="queryForm.facet.sort" class="h-8 font-mono text-xs" placeholder="count/index" /></div>
                    <div><Label class="text-xs">facet.limit</Label><Input v-model="queryForm.facet.limit" class="h-8 font-mono text-xs" /></div>
                    <div><Label class="text-xs">facet.offset</Label><Input v-model="queryForm.facet.offset" class="h-8 font-mono text-xs" /></div>
                    <div><Label class="text-xs">facet.mincount</Label><Input v-model="queryForm.facet.mincount" class="h-8 font-mono text-xs" /></div>
                    <div class="flex items-end pb-1.5">
                      <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.facet.missing" type="checkbox" /> facet.missing</label>
                    </div>
                  </div>
                </div>
              </div>

              <!-- spatial -->
              <div class="rounded border p-2">
                <label class="flex items-center gap-1.5 text-xs font-medium"><input v-model="queryForm.spatial.enabled" type="checkbox" /> spatial</label>
                <div v-if="queryForm.spatial.enabled" class="mt-2 grid grid-cols-4 gap-2">
                  <div><Label class="text-xs">pt</Label><Input v-model="queryForm.spatial.pt" class="h-8 font-mono text-xs" placeholder="lat,lng" /></div>
                  <div><Label class="text-xs">sfield</Label><Input v-model="queryForm.spatial.sfield" class="h-8 font-mono text-xs" /></div>
                  <div><Label class="text-xs">d</Label><Input v-model="queryForm.spatial.d" class="h-8 font-mono text-xs" placeholder="km" /></div>
                  <div class="flex items-end gap-3 pb-1.5">
                    <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.spatial.geofilt" type="checkbox" /> geofilt</label>
                    <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.spatial.bbox" type="checkbox" /> bbox</label>
                  </div>
                </div>
              </div>

              <!-- spellcheck -->
              <div class="rounded border p-2">
                <label class="flex items-center gap-1.5 text-xs font-medium"><input v-model="queryForm.spellcheck.enabled" type="checkbox" /> spellcheck</label>
                <div v-if="queryForm.spellcheck.enabled" class="mt-2 grid grid-cols-4 gap-2">
                  <div><Label class="text-xs">spellcheck.q</Label><Input v-model="queryForm.spellcheck.q" class="h-8 font-mono text-xs" /></div>
                  <div><Label class="text-xs">spellcheck.count</Label><Input v-model="queryForm.spellcheck.count" class="h-8 font-mono text-xs" /></div>
                  <div><Label class="text-xs">spellcheck.dictionary</Label><Input v-model="queryForm.spellcheck.dictionary" class="h-8 font-mono text-xs" /></div>
                  <div class="flex items-end gap-3 pb-1.5">
                    <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.spellcheck.build" type="checkbox" /> build</label>
                    <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.spellcheck.collate" type="checkbox" /> collate</label>
                    <label class="flex items-center gap-1.5 text-xs text-muted-foreground"><input v-model="queryForm.spellcheck.onlyMorePopular" type="checkbox" /> onlyMorePopular</label>
                  </div>
                </div>
              </div>

              <!-- Raw Query Parameters -->
              <div>
                <Label class="text-xs">Raw Query Parameters</Label>
                <div v-for="(rp, i) in queryForm.rawParams" :key="i" class="mb-1 flex items-center gap-1">
                  <Input v-model="rp.key" class="h-8 w-48 font-mono text-xs" placeholder="key" />
                  <Input v-model="rp.value" class="h-8 font-mono text-xs" placeholder="value" />
                  <Button size="sm" variant="outline" class="h-8 w-8 shrink-0 px-0" @click="removeQueryRow(queryForm.rawParams, i)">−</Button>
                </div>
                <Button size="sm" variant="ghost" class="h-7 px-2 text-xs" @click="addQueryRow(queryForm.rawParams, { key: '', value: '' })">+ param</Button>
              </div>

              <!-- JSON Query -->
              <div>
                <Label class="text-xs"
                  >JSON Query <span class="text-muted-foreground">({{ t("solrAdmin.queryForm.jsonHint") }})</span></Label
                >
                <textarea v-model="queryForm.jsonQuery" rows="4" class="w-full rounded border bg-background p-2 font-mono text-xs focus:outline-none focus:ring-1 focus:ring-ring" placeholder='{"query":"code:BLOMUS*","limit":20}'></textarea>
              </div>

              <!-- 预览 + 执行 -->
              <div class="rounded border bg-muted/40 p-2 font-mono text-[11px] break-all">{{ builtQuery.text }}</div>
              <div class="flex items-center gap-2">
                <Button size="sm" class="h-8" :disabled="queryRunning || !selectedCore" @click="runQueryForm">
                  <Loader2 v-if="queryRunning" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {{ t("solrAdmin.queryForm.execute") }}
                </Button>
                <Button size="sm" variant="outline" class="h-8" @click="openQueryInConsole">{{ t("solrAdmin.queryForm.openInConsole") }}</Button>
              </div>
              <div v-if="queryError" class="flex items-start gap-2 text-sm text-destructive">
                <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
                <pre class="whitespace-pre-wrap font-mono text-xs">{{ queryError }}</pre>
              </div>

              <!-- 结果 -->
              <div v-if="queryResult" class="space-y-2 border-t pt-2">
                <div class="flex flex-wrap items-center gap-2 text-xs">
                  <Badge v-if="queryNumFound != null" variant="secondary">numFound: {{ queryNumFound }}</Badge>
                  <Badge variant="outline">{{ queryResult.rows?.length ?? 0 }} {{ t("solrAdmin.queryForm.rowsReturned") }}</Badge>
                  <span class="text-muted-foreground">{{ queryResult.execution_time_ms }} ms</span>
                  <Button v-if="queryRawBody" size="sm" variant="ghost" class="h-6 px-2 text-xs" @click="queryShowRaw = !queryShowRaw">
                    {{ queryShowRaw ? t("solrAdmin.queryForm.tableView") : t("solrAdmin.queryForm.rawJson") }}
                  </Button>
                </div>
                <div v-if="queryResult.execution_error" class="text-sm text-destructive">{{ queryResult.error?.messageKey }}</div>
                <JsonTree v-else-if="queryShowRaw && queryRawParsed" :value="queryRawParsed" :initial-expanded-depth="2" virtualized />
                <div v-else-if="queryResult.columns?.length" class="overflow-x-auto rounded border">
                  <table class="w-full text-sm">
                    <thead>
                      <tr class="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                        <th v-for="col in queryResult.columns" :key="col" class="whitespace-nowrap px-2 py-1 font-medium">{{ col }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(row, ri) in queryResult.rows" :key="ri" class="border-b last:border-0">
                        <td v-for="(cell, ci) in row" :key="ci" class="max-w-80 truncate px-2 py-1 font-mono text-xs" :title="queryCellText(cell)">{{ queryCellText(cell) }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <JsonTree v-else-if="queryRawParsed" :value="queryRawParsed" :initial-expanded-depth="2" virtualized />
                <div v-else class="text-sm text-muted-foreground">{{ t("solrAdmin.emptyBody") }}</div>
              </div>
            </div>
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

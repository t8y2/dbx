<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, AlertTriangle, Download, Eraser, Loader2, Pause, Play, Search, Square, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import { translateBackendError } from "@/i18n/backend-errors";
import * as api from "@/lib/backend/api";
import { compactLocalTimestamp, sanitizeExportBaseName, saveTextFile } from "@/lib/export/saveTextFile";
import type { ConnectionConfig } from "@/types/database";
import {
  SQLSERVER_TRACE_DEFAULT_DURATION_MINUTES,
  SQLSERVER_TRACE_DEFAULT_MAX_EVENTS,
  buildCreateSqlServerTraceSessionSql,
  buildCleanupSqlServerTraceSessionsSql,
  buildDropSqlServerTraceSessionSql,
  buildListSqlServerTraceSessionsSql,
  buildReadSqlServerTraceEventsSql,
  buildSqlServerTraceCapabilitiesSql,
  buildSqlServerTraceSessionName,
  buildStopSqlServerTraceSessionSql,
  normalizeSqlServerTraceDurationMinutes,
  normalizeSqlServerTraceMaxEvents,
  mergeSqlServerTraceEventSnapshot,
  parseSqlServerTraceCapabilities,
  parseSqlServerTraceEvents,
  sqlServerTraceCapabilityProblem,
  sqlServerTraceEventsToCsv,
  staleSqlServerTraceSessionNames,
  type SqlServerTraceEvent,
} from "@/lib/sqlserver/sqlServerActivityTrace";

const props = defineProps<{
  connection: ConnectionConfig;
  tabId: string;
}>();

type TraceStatus = "idle" | "starting" | "running" | "paused" | "stopping" | "stopped" | "error";

const { t } = useI18n();
const connectionStore = useConnectionStore();
const queryStore = useQueryStore();
const { toast } = useToast();
const status = ref<TraceStatus>("idle");
const databases = ref<string[]>([]);
const selectedDatabase = ref(props.connection.database || "");
const loadingDatabases = ref(false);
const includeStatements = ref(false);
const maxEvents = ref(SQLSERVER_TRACE_DEFAULT_MAX_EVENTS);
const durationMinutes = ref(SQLSERVER_TRACE_DEFAULT_DURATION_MINUTES);
const events = ref<SqlServerTraceEvent[]>([]);
let knownEventCounts = new Map<string, number>();
const selectedEvent = ref<SqlServerTraceEvent | null>(null);
const sqlFilter = ref("");
const loginFilter = ref("");
const clientFilter = ref("");
const sessionFilter = ref("");
const error = ref("");
const sessionName = ref("");
const startedAt = ref<number | null>(null);
const elapsedSeconds = ref(0);
const polling = ref(false);
const tableScroller = ref<HTMLDivElement>();
const tableElement = ref<HTMLTableElement>();
const horizontalScrollbarTrack = ref<HTMLDivElement>();
const horizontalScrollbarThumb = ref<HTMLDivElement>();
const hasHorizontalOverflow = ref(false);
let pollTimer: ReturnType<typeof setInterval> | undefined;
let elapsedTimer: ReturnType<typeof setInterval> | undefined;
let tableResizeObserver: ResizeObserver | undefined;
let horizontalScrollbarDrag:
  | {
      trackRect: DOMRect;
      thumbOffset: number;
    }
  | undefined;
let disposed = false;

const traceActive = computed(() => status.value === "running" || status.value === "paused");
const traceSessionOpen = computed(() => !!sessionName.value || status.value === "starting" || traceActive.value || status.value === "stopping");
const busy = computed(() => status.value === "starting" || status.value === "stopping");
const canStart = computed(() => !!selectedDatabase.value && !traceActive.value && !busy.value);
const statusLabel = computed(() => t(`sqlServerTrace.statuses.${status.value}`));
const filteredEvents = computed(() => {
  const sql = sqlFilter.value.trim().toLowerCase();
  const login = loginFilter.value.trim().toLowerCase();
  const client = clientFilter.value.trim().toLowerCase();
  const session = sessionFilter.value.trim();
  return events.value.filter((event) => {
    if (sql && !event.sqlText.toLowerCase().includes(sql)) return false;
    if (login && !event.loginName.toLowerCase().includes(login)) return false;
    if (client && !`${event.clientApp} ${event.hostName}`.toLowerCase().includes(client)) return false;
    if (session && String(event.sessionId ?? "") !== session) return false;
    return true;
  });
});

function formatMetric(value: number | null, maximumFractionDigits = 2): string {
  if (value == null) return "-";
  return value.toLocaleString(undefined, { maximumFractionDigits });
}

function formatTimestamp(value: string): string {
  if (!value) return "-";
  const normalized = value.includes("T") ? value : value.replace(" ", "T");
  const date = new Date(`${normalized}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { hour12: false });
}

function eventTypeLabel(eventName: string): string {
  const key = `sqlServerTrace.eventTypes.${eventName}`;
  const translated = t(key);
  return translated === key ? eventName : translated;
}

function capabilityErrorKey(problem: ReturnType<typeof sqlServerTraceCapabilityProblem>): string {
  return problem ? `sqlServerTrace.capabilityErrors.${problem}` : "";
}

async function execute(sql: string, database = selectedDatabase.value, maxRows = 5000) {
  return api.executeQuery(props.connection.id, database, sql, undefined, undefined, { maxRows });
}

async function loadDatabases() {
  loadingDatabases.value = true;
  error.value = "";
  try {
    await connectionStore.ensureConnected(props.connection.id);
    const result = await api.listDatabases(props.connection.id);
    databases.value = result.map((database) => database.name).filter(Boolean);
    if (!selectedDatabase.value || !databases.value.includes(selectedDatabase.value)) {
      selectedDatabase.value = databases.value.find((database) => !["master", "model", "msdb", "tempdb"].includes(database.toLowerCase())) || databases.value[0] || "";
    }
  } catch (cause) {
    error.value = translateBackendError(t, cause);
  } finally {
    loadingDatabases.value = false;
  }
}

function stopTimers() {
  if (pollTimer) clearInterval(pollTimer);
  if (elapsedTimer) clearInterval(elapsedTimer);
  pollTimer = undefined;
  elapsedTimer = undefined;
}

function restartPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden || status.value !== "running") return;
    void pollEvents();
  }, 1000);
}

function restartElapsedTimer() {
  if (elapsedTimer) clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    if (!startedAt.value || !traceActive.value) return;
    elapsedSeconds.value = Math.max(0, Math.floor((Date.now() - startedAt.value) / 1000));
    if (elapsedSeconds.value >= normalizeSqlServerTraceDurationMinutes(durationMinutes.value) * 60) {
      void stopTrace("duration");
    }
  }, 1000);
}

function syncHorizontalScrollbar() {
  const scroller = tableScroller.value;
  const track = horizontalScrollbarTrack.value;
  const thumb = horizontalScrollbarThumb.value;
  if (!scroller || !track || !thumb) return;
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  hasHorizontalOverflow.value = maxScrollLeft > 1;
  const widthPercent = scroller.scrollWidth > 0 ? Math.min(100, (scroller.clientWidth / scroller.scrollWidth) * 100) : 100;
  const travelPercent = Math.max(0, 100 - widthPercent);
  const leftPercent = maxScrollLeft > 0 ? (scroller.scrollLeft / maxScrollLeft) * travelPercent : 0;
  thumb.style.width = `${widthPercent}%`;
  thumb.style.left = `${leftPercent}%`;
}

function scrollTableHorizontally(event: WheelEvent) {
  const scroller = tableScroller.value;
  if (!scroller) return;
  const delta = event.shiftKey ? event.deltaY : Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : 0;
  if (!delta) return;
  const previousScrollLeft = scroller.scrollLeft;
  scroller.scrollLeft += delta;
  if (scroller.scrollLeft !== previousScrollLeft) event.preventDefault();
}

function setHorizontalScrollFromPointer(clientX: number) {
  const scroller = tableScroller.value;
  const thumb = horizontalScrollbarThumb.value;
  const drag = horizontalScrollbarDrag;
  if (!scroller || !thumb || !drag) return;
  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const maxThumbLeft = Math.max(0, drag.trackRect.width - thumb.offsetWidth);
  if (maxScrollLeft <= 0 || maxThumbLeft <= 0) return;
  const thumbLeft = Math.min(maxThumbLeft, Math.max(0, clientX - drag.trackRect.left - drag.thumbOffset));
  scroller.scrollLeft = (thumbLeft / maxThumbLeft) * maxScrollLeft;
}

function moveHorizontalScrollbar(event: PointerEvent) {
  if (!horizontalScrollbarDrag) return;
  setHorizontalScrollFromPointer(event.clientX);
}

function stopHorizontalScrollbarDrag() {
  horizontalScrollbarDrag = undefined;
  window.removeEventListener("pointermove", moveHorizontalScrollbar);
  window.removeEventListener("pointerup", stopHorizontalScrollbarDrag);
  window.removeEventListener("pointercancel", stopHorizontalScrollbarDrag);
}

function startHorizontalScrollbarDrag(event: PointerEvent) {
  if (!hasHorizontalOverflow.value || event.button !== 0) return;
  const track = horizontalScrollbarTrack.value;
  const thumb = horizontalScrollbarThumb.value;
  if (!track || !thumb) return;
  event.preventDefault();
  const trackRect = track.getBoundingClientRect();
  const thumbRect = thumb.getBoundingClientRect();
  horizontalScrollbarDrag = {
    trackRect,
    thumbOffset: event.target === thumb ? event.clientX - thumbRect.left : thumbRect.width / 2,
  };
  window.addEventListener("pointermove", moveHorizontalScrollbar);
  window.addEventListener("pointerup", stopHorizontalScrollbarDrag);
  window.addEventListener("pointercancel", stopHorizontalScrollbarDrag);
  setHorizontalScrollFromPointer(event.clientX);
}

function observeTableSize() {
  tableResizeObserver?.disconnect();
  if (typeof ResizeObserver === "undefined") return;
  tableResizeObserver = new ResizeObserver(syncHorizontalScrollbar);
  if (tableScroller.value) tableResizeObserver.observe(tableScroller.value);
  if (tableElement.value) tableResizeObserver.observe(tableElement.value);
  syncHorizontalScrollbar();
}

async function pollEvents(options: { final?: boolean } = {}) {
  if (!sessionName.value || polling.value) return;
  polling.value = true;
  let autoStopReason: "events" | undefined;
  try {
    const result = await execute(buildReadSqlServerTraceEventsSql(sessionName.value), selectedDatabase.value, normalizeSqlServerTraceMaxEvents(maxEvents.value));
    const merged = mergeSqlServerTraceEventSnapshot(knownEventCounts, parseSqlServerTraceEvents(result));
    knownEventCounts = merged.counts;
    const additions = merged.additions;
    if (additions.length > 0) events.value.push(...additions);
    const capturedCount = Array.from(knownEventCounts.values()).reduce((total, count) => total + count, 0);
    if (!options.final && capturedCount >= normalizeSqlServerTraceMaxEvents(maxEvents.value)) autoStopReason = "events";
  } catch (cause) {
    if (!options.final) {
      error.value = translateBackendError(t, cause);
      status.value = "error";
      stopTimers();
      await cleanupSession();
    }
  } finally {
    polling.value = false;
    if (autoStopReason) void stopTrace(autoStopReason);
  }
}

async function waitForCurrentPoll() {
  const deadline = Date.now() + 5000;
  while (polling.value && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function cleanupSession() {
  const name = sessionName.value;
  if (!name) return;
  try {
    await execute(buildStopSqlServerTraceSessionSql(name));
  } catch {
    // A failed start or an already-stopped session is safe to drop directly.
  }
  try {
    await execute(buildDropSqlServerTraceSessionSql(name));
    sessionName.value = "";
  } catch (cause) {
    if (!disposed) error.value = translateBackendError(t, cause);
  }
}

async function startTrace() {
  if (!canStart.value) return;
  error.value = "";
  status.value = "starting";
  maxEvents.value = normalizeSqlServerTraceMaxEvents(maxEvents.value);
  durationMinutes.value = normalizeSqlServerTraceDurationMinutes(durationMinutes.value);
  events.value = [];
  knownEventCounts = new Map();
  selectedEvent.value = null;
  elapsedSeconds.value = 0;
  try {
    await connectionStore.ensureConnected(props.connection.id);
    const capabilities = parseSqlServerTraceCapabilities(await execute(buildSqlServerTraceCapabilitiesSql(selectedDatabase.value), selectedDatabase.value, 1));
    const problem = sqlServerTraceCapabilityProblem(capabilities);
    if (problem) throw new Error(t(capabilityErrorKey(problem), { version: capabilities.productVersion }));
    const staleSessions = staleSqlServerTraceSessionNames(await execute(buildListSqlServerTraceSessionsSql(), selectedDatabase.value, 100));
    if (staleSessions.length > 0) {
      await execute(buildCleanupSqlServerTraceSessionsSql(staleSessions), selectedDatabase.value, 1);
      toast(t("sqlServerTrace.cleanedStaleSessions", { count: staleSessions.length }), 4000);
    }
    const name = buildSqlServerTraceSessionName();
    sessionName.value = name;
    await execute(
      buildCreateSqlServerTraceSessionSql({
        sessionName: name,
        databaseId: capabilities.databaseId,
        maxEvents: maxEvents.value,
        includeStatements: includeStatements.value,
      }),
    );
    startedAt.value = Date.now();
    status.value = "running";
    restartPolling();
    restartElapsedTimer();
    await pollEvents();
  } catch (cause) {
    error.value = translateBackendError(t, cause);
    status.value = "error";
    stopTimers();
    await cleanupSession();
  }
}

function pauseTrace() {
  if (status.value !== "running") return;
  status.value = "paused";
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

async function resumeTrace() {
  if (status.value !== "paused") return;
  status.value = "running";
  restartPolling();
  await pollEvents();
}

async function stopTrace(reason?: "duration" | "events") {
  if (!sessionName.value || status.value === "stopping") return;
  status.value = "stopping";
  stopTimers();
  await waitForCurrentPoll();
  await pollEvents({ final: true });
  await cleanupSession();
  if (disposed) return;
  status.value = sessionName.value ? "error" : "stopped";
  if (reason && !sessionName.value) toast(t(`sqlServerTrace.autoStopped.${reason}`), 4000);
}

function clearEvents() {
  events.value = [];
  selectedEvent.value = null;
}

async function exportCsv() {
  if (filteredEvents.value.length === 0) return;
  const base = sanitizeExportBaseName(`${props.connection.name}-${selectedDatabase.value}-activity-trace`) || "sqlserver-activity-trace";
  await saveTextFile(sqlServerTraceEventsToCsv(filteredEvents.value), `${base}-${compactLocalTimestamp()}.csv`, "CSV", "csv");
}

onMounted(() => {
  void loadDatabases();
  void nextTick(observeTableSize);
});
watch(
  () => queryStore.tabs.some((tab) => tab.id === props.tabId),
  (exists) => {
    if (exists) return;
    stopTimers();
    void cleanupSession();
  },
);
onBeforeUnmount(() => {
  disposed = true;
  stopTimers();
  stopHorizontalScrollbarDrag();
  tableResizeObserver?.disconnect();
  void cleanupSession();
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex min-h-11 shrink-0 flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-1.5">
      <div class="flex min-w-0 items-center gap-2">
        <Activity class="h-4 w-4 text-primary" />
        <span class="truncate text-sm font-semibold">{{ t("sqlServerTrace.title") }}</span>
        <Badge variant="outline" class="h-5 max-w-48 rounded-md px-1.5 text-[11px]"
          ><span class="truncate">{{ connection.name }}</span></Badge
        >
        <Badge :variant="traceActive ? 'default' : 'secondary'" class="h-5 rounded-md px-1.5 text-[11px]">{{ statusLabel }}</Badge>
      </div>
      <div class="ml-auto flex items-center gap-1.5">
        <span v-if="traceActive || status === 'stopped'" class="text-[11px] tabular-nums text-muted-foreground">{{ t("sqlServerTrace.elapsed", { seconds: elapsedSeconds }) }}</span>
        <Button v-if="!traceSessionOpen" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" :disabled="!canStart" @click="startTrace">
          <Loader2 v-if="status === 'starting'" class="h-3.5 w-3.5 animate-spin" />
          <Play v-else class="h-3.5 w-3.5" />
          {{ t("sqlServerTrace.start") }}
        </Button>
        <Button v-else-if="status === 'running'" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="pauseTrace"> <Pause class="h-3.5 w-3.5" />{{ t("sqlServerTrace.pause") }} </Button>
        <Button v-else-if="status === 'paused'" variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" @click="resumeTrace"> <Play class="h-3.5 w-3.5" />{{ t("sqlServerTrace.resume") }} </Button>
        <Button v-else variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" disabled> <Loader2 class="h-3.5 w-3.5 animate-spin" />{{ statusLabel }} </Button>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2.5 text-xs" :disabled="!sessionName || busy" @click="stopTrace()">
          <Loader2 v-if="status === 'stopping'" class="h-3.5 w-3.5 animate-spin" />
          <Square v-else class="h-3.5 w-3.5" />
          {{ t("sqlServerTrace.stop") }}
        </Button>
        <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('sqlServerTrace.clear')" :aria-label="t('sqlServerTrace.clear')" :disabled="events.length === 0" @click="clearEvents">
          <Eraser class="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon" class="h-7 w-7" :title="t('sqlServerTrace.export')" :aria-label="t('sqlServerTrace.export')" :disabled="filteredEvents.length === 0" @click="exportCsv">
          <Download class="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>

    <div class="grid shrink-0 grid-cols-[minmax(150px,1.1fr)_minmax(130px,0.9fr)_minmax(130px,0.9fr)_100px_auto] items-end gap-2 border-b px-3 py-2">
      <label class="grid min-w-0 gap-1 text-[11px] text-muted-foreground">
        <span>{{ t("sqlServerTrace.database") }}</span>
        <Select v-model="selectedDatabase" :disabled="traceActive || busy || loadingDatabases">
          <SelectTrigger class="h-7 min-w-0 text-xs"><SelectValue :placeholder="loadingDatabases ? t('common.loading') : t('sqlServerTrace.selectDatabase')" /></SelectTrigger>
          <SelectContent
            ><SelectItem v-for="database in databases" :key="database" :value="database">{{ database }}</SelectItem></SelectContent
          >
        </Select>
      </label>
      <label class="grid gap-1 text-[11px] text-muted-foreground">
        <span>{{ t("sqlServerTrace.maxEvents") }}</span>
        <Input v-model.number="maxEvents" type="number" min="100" max="5000" step="100" class="h-7 text-xs" :disabled="traceActive || busy" @blur="maxEvents = normalizeSqlServerTraceMaxEvents(maxEvents)" />
      </label>
      <label class="grid gap-1 text-[11px] text-muted-foreground">
        <span>{{ t("sqlServerTrace.duration") }}</span>
        <Input v-model.number="durationMinutes" type="number" min="1" max="60" class="h-7 text-xs" :disabled="traceActive || busy" @blur="durationMinutes = normalizeSqlServerTraceDurationMinutes(durationMinutes)" />
      </label>
      <label class="flex h-7 items-center gap-2 text-xs" :title="t('sqlServerTrace.statementsHint')">
        <Switch v-model="includeStatements" :disabled="traceActive || busy" />
        <span class="whitespace-nowrap">{{ t("sqlServerTrace.statements") }}</span>
      </label>
      <span class="pb-1 text-[11px] text-amber-700 dark:text-amber-300">{{ includeStatements ? t("sqlServerTrace.highCost") : "" }}</span>
    </div>

    <div class="grid shrink-0 grid-cols-[minmax(180px,2fr)_minmax(110px,0.8fr)_minmax(140px,1fr)_minmax(120px,0.75fr)] gap-2 overflow-x-auto border-b bg-muted/10 px-3 py-2">
      <label class="relative min-w-0"><Search class="absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" /><Input v-model="sqlFilter" class="h-7 pl-7 text-xs" :placeholder="t('sqlServerTrace.filterSql')" /></label>
      <Input v-model="loginFilter" class="h-7 min-w-0 text-xs" :placeholder="t('sqlServerTrace.filterLogin')" />
      <Input v-model="clientFilter" class="h-7 min-w-0 text-xs" :placeholder="t('sqlServerTrace.filterClient')" />
      <Input v-model="sessionFilter" inputmode="numeric" class="h-7 min-w-0 text-xs" :placeholder="t('sqlServerTrace.filterSession')" />
    </div>

    <div v-if="error" class="flex shrink-0 items-start gap-2 border-b border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
      <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span data-native-clipboard class="min-w-0 flex-1 select-text whitespace-pre-wrap">{{ error }}</span>
      <button type="button" class="rounded p-0.5 hover:bg-destructive/10" :aria-label="t('common.close')" @click="error = ''"><X class="h-3.5 w-3.5" /></button>
    </div>

    <div class="relative flex min-h-0 flex-1 flex-col">
      <div ref="tableScroller" class="sqlserver-trace-table-scroller min-h-0 flex-1" @scroll="syncHorizontalScrollbar" @wheel="scrollTableHorizontally">
        <table ref="tableElement" class="w-full min-w-[1180px] table-fixed border-collapse text-xs">
          <thead class="sticky top-0 z-10 bg-muted/95 text-left text-[11px] text-muted-foreground backdrop-blur">
            <tr>
              <th class="w-40 border-b px-2 py-1.5 font-medium">{{ t("sqlServerTrace.columns.time") }}</th>
              <th class="w-32 border-b px-2 py-1.5 font-medium">{{ t("sqlServerTrace.columns.event") }}</th>
              <th class="border-b px-2 py-1.5 font-medium">{{ t("sqlServerTrace.columns.sql") }}</th>
              <th class="w-20 border-b px-2 py-1.5 text-right font-medium">{{ t("sqlServerTrace.columns.duration") }}</th>
              <th class="w-20 border-b px-2 py-1.5 text-right font-medium">{{ t("sqlServerTrace.columns.cpu") }}</th>
              <th class="w-20 border-b px-2 py-1.5 text-right font-medium">{{ t("sqlServerTrace.columns.reads") }}</th>
              <th class="w-16 border-b px-2 py-1.5 text-right font-medium">{{ t("sqlServerTrace.columns.writes") }}</th>
              <th class="w-20 border-b px-2 py-1.5 text-right font-medium">{{ t("sqlServerTrace.columns.rows") }}</th>
              <th class="w-20 border-b px-2 py-1.5 text-right font-medium">{{ t("sqlServerTrace.columns.session") }}</th>
              <th class="w-28 border-b px-2 py-1.5 font-medium">{{ t("sqlServerTrace.columns.login") }}</th>
              <th class="w-36 border-b px-2 py-1.5 font-medium">{{ t("sqlServerTrace.columns.client") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="event in filteredEvents" :key="event.key" class="cursor-pointer border-b border-border/60 hover:bg-muted/35" :class="{ 'bg-primary/5': selectedEvent?.key === event.key }" @click="selectedEvent = event">
              <td class="truncate px-2 py-1.5 tabular-nums" :title="event.timestamp">{{ formatTimestamp(event.timestamp) }}</td>
              <td class="truncate px-2 py-1.5" :title="event.eventName">{{ eventTypeLabel(event.eventName) }}</td>
              <td class="truncate px-2 py-1.5 font-mono" :title="event.sqlText">{{ event.sqlText || "-" }}</td>
              <td class="px-2 py-1.5 text-right tabular-nums">{{ formatMetric(event.durationMs) }}</td>
              <td class="px-2 py-1.5 text-right tabular-nums">{{ formatMetric(event.cpuMs) }}</td>
              <td class="px-2 py-1.5 text-right tabular-nums">{{ formatMetric(event.logicalReads, 0) }}</td>
              <td class="px-2 py-1.5 text-right tabular-nums">{{ formatMetric(event.writes, 0) }}</td>
              <td class="px-2 py-1.5 text-right tabular-nums">{{ formatMetric(event.rowCount, 0) }}</td>
              <td class="px-2 py-1.5 text-right tabular-nums">{{ event.sessionId ?? "-" }}</td>
              <td class="truncate px-2 py-1.5" :title="event.loginName">{{ event.loginName || "-" }}</td>
              <td class="truncate px-2 py-1.5" :title="`${event.clientApp} ${event.hostName}`">{{ event.clientApp || event.hostName || "-" }}</td>
            </tr>
            <tr v-if="filteredEvents.length === 0">
              <td colspan="11" class="h-32 text-center text-muted-foreground">
                {{ events.length > 0 ? t("sqlServerTrace.noMatches") : t("sqlServerTrace.noEvents") }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div ref="horizontalScrollbarTrack" class="sqlserver-trace-horizontal-scrollbar" :class="{ 'sqlserver-trace-horizontal-scrollbar--visible': hasHorizontalOverflow, 'sqlserver-trace-horizontal-scrollbar--dragging': horizontalScrollbarDrag }" @pointerdown="startHorizontalScrollbarDrag">
        <div ref="horizontalScrollbarThumb" class="sqlserver-trace-horizontal-scrollbar__thumb" />
      </div>
    </div>

    <div v-if="selectedEvent" class="grid max-h-40 shrink-0 grid-cols-[minmax(0,2fr)_minmax(220px,1fr)] border-t bg-muted/10 text-xs">
      <pre data-native-clipboard class="min-h-20 overflow-auto whitespace-pre-wrap break-words border-r p-3 font-mono select-text">{{ selectedEvent.sqlText || "-" }}</pre>
      <dl class="grid content-start grid-cols-[90px_minmax(0,1fr)] gap-x-2 gap-y-1 overflow-auto p-3">
        <dt class="text-muted-foreground">{{ t("sqlServerTrace.columns.database") }}</dt>
        <dd class="truncate" :title="selectedEvent.database">{{ selectedEvent.database || "-" }}</dd>
        <dt class="text-muted-foreground">{{ t("sqlServerTrace.columns.host") }}</dt>
        <dd class="truncate" :title="selectedEvent.hostName">{{ selectedEvent.hostName || "-" }}</dd>
        <dt class="text-muted-foreground">{{ t("sqlServerTrace.columns.client") }}</dt>
        <dd class="truncate" :title="selectedEvent.clientApp">{{ selectedEvent.clientApp || "-" }}</dd>
        <dt class="text-muted-foreground">{{ t("sqlServerTrace.columns.result") }}</dt>
        <dd class="truncate" :title="selectedEvent.result">{{ selectedEvent.result || "-" }}</dd>
      </dl>
    </div>

    <div class="flex h-7 shrink-0 items-center justify-between border-t px-3 text-[11px] text-muted-foreground">
      <span>{{ t("sqlServerTrace.eventCount", { visible: filteredEvents.length, total: events.length }) }}</span>
      <span>{{ t("sqlServerTrace.permissionHint") }}</span>
    </div>
  </div>
</template>

<style scoped>
.sqlserver-trace-table-scroller {
  overflow-x: hidden;
  overflow-y: auto;
}

.sqlserver-trace-table-scroller::-webkit-scrollbar {
  width: 8px;
}

.sqlserver-trace-horizontal-scrollbar {
  position: relative;
  height: 0;
  flex: 0 0 0;
  cursor: default;
  touch-action: none;
  opacity: 0;
  pointer-events: none;
  background: var(--background);
}

.sqlserver-trace-horizontal-scrollbar--visible {
  height: 10px;
  flex-basis: 10px;
  cursor: pointer;
  opacity: 1;
  pointer-events: auto;
}

.sqlserver-trace-horizontal-scrollbar::before {
  content: "";
  position: absolute;
  inset-inline: 4px;
  top: 4px;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted-foreground) 22%, transparent);
}

.sqlserver-trace-horizontal-scrollbar__thumb {
  position: absolute;
  top: 3px;
  height: 4px;
  min-width: 32px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted-foreground) 55%, transparent);
  transition:
    height 120ms ease,
    top 120ms ease,
    background-color 120ms ease;
}

.sqlserver-trace-horizontal-scrollbar:hover .sqlserver-trace-horizontal-scrollbar__thumb,
.sqlserver-trace-horizontal-scrollbar--dragging .sqlserver-trace-horizontal-scrollbar__thumb {
  top: 2px;
  height: 6px;
  background: color-mix(in srgb, var(--foreground) 65%, transparent);
}
</style>

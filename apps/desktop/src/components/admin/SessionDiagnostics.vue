<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Copy, Loader2, RefreshCcw } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useSessionDiagnostics } from "@/composables/useSessionDiagnostics";
import { useToast } from "@/composables/useToast";
import { copyToClipboard } from "@/lib/common/clipboard";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import type { ProcessRow } from "@/lib/database/processListDrivers";
import type { DiagnosticEngine, DiagnosticSection } from "@/lib/database/sessionDiagnostics";

const ExplainPlanViewer = defineAsyncComponent(() => import("@/components/explain/ExplainPlanViewer.vue"));
const props = defineProps<{ connection: ConnectionConfig; row: ProcessRow; engine: DiagnosticEngine; database: string; versionMajor?: number }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
const { toast } = useToast();
const context = computed(() => ({ connection: props.connection, row: props.row, engine: props.engine, database: props.database, versionMajor: props.versionMajor }));
const { snapshot, busy, error, cleanupFailed, selection, refresh, stop } = useSessionDiagnostics(context);
const activeTab = ref("sql");
const section = computed<DiagnosticSection<unknown>>(() => (activeTab.value === "statistics" ? snapshot.value.metrics : activeTab.value === "longOperations" ? snapshot.value.longOperations : activeTab.value === "plan" ? snapshot.value.plan : snapshot.value.sql));
const tabs = ["sql", "plan", "statistics", "longOperations"];
const tables = computed(() => (activeTab.value === "longOperations" ? [{ key: "longOperations", section: snapshot.value.longOperations }] : [{ key: "waits", section: snapshot.value.waits }]));
const columnLabels: Record<string, string> = {
  SCOPE: "scope",
  WAIT_KIND: "waitKind",
  STATE: "state",
  EVENT: "event",
  WAIT_CLASS: "waitClass",
  SECONDS_IN_WAIT: "secondsInWait",
  BLOCKING_INSTANCE: "blockingInstance",
  BLOCKING_SESSION: "blockingSession",
  SID: "sid",
  SERIAL_NUMBER: "serial",
  INSTANCE_ID: "instance",
  OPNAME: "operation",
  TARGET: "target",
  SOFAR: "sofar",
  TOTALWORK: "totalWork",
  UNITS: "units",
  START_TIME: "startTime",
  LAST_UPDATE_TIME: "lastUpdateTime",
  ELAPSED_SECONDS: "elapsedSeconds",
  TIME_REMAINING: "remainingSeconds",
  MESSAGE: "message",
  SQL_ID: "sqlId",
  SQL_EXEC_ID: "sqlExecId",
  SQL_EXEC_START: "sqlExecStart",
  SVR_IP: "serverIp",
  SVR_PORT: "serverPort",
  TRACE_ID: "traceId",
  PROGRESS_PERCENT: "progress",
};

function formattedTime(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
function formattedMicros(value: string) {
  if (!/^\d+$/.test(value)) return value;
  const millis = Number(BigInt(value) / 1000n);
  return Number.isSafeInteger(millis) ? formattedTime(new Date(millis).toString()) : value;
}
function formatValue(value: unknown, column = "") {
  if (value === null || value === undefined) return "—";
  if ((column === "SCOPE" || column === "WAIT_KIND") && ["cursor_cumulative", "plan_cumulative", "request", "session_sample", "execution", "current_wait", "last_wait", "session_trace", "request_trace"].includes(String(value))) return t(`sessionDiagnostics.scopes.${value}`);
  return String(value);
}
function sectionStatus(value: DiagnosticSection<unknown>, longOperations = false) {
  if (value.state === "loading") return t("common.loading");
  if (value.state === "cancelled" || value.state === "timeout") return "";
  if (value.state === "empty" && longOperations) return t("sessionDiagnostics.longOperationsEmpty");
  if (value.reason) return t(`sessionDiagnostics.reasons.${value.reason}`);
  if (value.state === "failed") return t("sessionDiagnostics.reasons.failed");
  return "";
}
function columnLabel(column: string) {
  return columnLabels[column] ? t(`sessionDiagnostics.columns.${columnLabels[column]}`) : column;
}
async function copySql() {
  const text = snapshot.value.sql.data?.text;
  if (!text) return;
  try {
    await copyToClipboard(text);
    toast(t("processList.copied"), 1500);
  } catch (cause) {
    toast(cause instanceof Error ? cause.message : String(cause), 3000);
  }
}
function chooseRequest(event: Event) {
  void refresh({ requestKey: (event.target as HTMLSelectElement).value || undefined });
}
function choosePlan(event: Event) {
  void refresh({ ...selection.value, planKey: (event.target as HTMLSelectElement).value || undefined });
}
function tableRows(result?: QueryResult) {
  return result?.rows ?? [];
}
</script>

<template>
  <Dialog :open="true" @update:open="(open) => !open && emit('close')">
    <DialogContent class="flex h-[min(82vh,780px)] max-w-6xl flex-col gap-0 p-0" :aria-busy="busy">
      <DialogHeader class="shrink-0 space-y-2 border-b px-5 pb-4 pt-5 pr-12">
        <DialogTitle>{{ t("sessionDiagnostics.title", { id: row.id }) }}</DialogTitle>
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{{ connection.name }}</Badge>
          <span>{{ engine === "oracle" ? "Oracle" : "OceanBase Oracle" }}</span>
          <span v-if="snapshot.identity.sqlId" class="font-mono">SQL_ID {{ snapshot.identity.sqlId }}</span>
        </div>
        <details class="text-xs text-muted-foreground">
          <summary class="w-fit cursor-pointer rounded focus-visible:outline focus-visible:outline-ring">{{ t("sessionDiagnostics.sampleContext") }}</summary>
          <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <template v-for="(value, key) in snapshot.identity" :key="key">
              <template v-if="value"
                ><dt>{{ t(`sessionDiagnostics.identity.${key}`) }}</dt>
                <dd class="break-all font-mono">{{ value }}</dd></template
              >
            </template>
            <dt>{{ t("sessionDiagnostics.sampleWindow") }}</dt>
            <dd>{{ formattedTime(snapshot.startedAt) }} — {{ formattedTime(snapshot.finishedAt) }}</dd>
          </dl>
        </details>
      </DialogHeader>
      <div v-if="snapshot.stale" class="shrink-0 border-b bg-muted/30 px-5 py-2 text-xs text-muted-foreground" role="status">{{ t("sessionDiagnostics.stale") }}</div>
      <p v-if="snapshot.interrupted" class="shrink-0 border-b px-5 py-2 text-xs text-muted-foreground" role="status">{{ t(`sessionDiagnostics.states.${snapshot.interrupted}`) }}</p>
      <p v-if="error" class="shrink-0 border-b bg-destructive/10 px-5 py-2 text-xs text-destructive" role="alert">{{ error }}</p>
      <p v-if="cleanupFailed" class="shrink-0 border-b px-5 py-2 text-xs text-muted-foreground" role="status">{{ t("sessionDiagnostics.cleanupFailed") }}</p>
      <label v-if="snapshot.requestChoices.length > 1" class="flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-3 text-sm">
        {{ t("sessionDiagnostics.chooseRequest") }}
        <select :value="selection.requestKey ?? ''" class="h-8 max-w-full rounded-md border bg-background px-2 text-xs focus-visible:outline focus-visible:outline-ring" :disabled="busy" @change="chooseRequest">
          <option value="" disabled>{{ t("sessionDiagnostics.selectRequest") }}</option>
          <option v-for="choice in snapshot.requestChoices" :key="choice.key" :value="choice.key">{{ t("sessionDiagnostics.requestOption", { ...choice.identity, requestTime: formattedMicros(choice.identity.requestTime) }) }}</option>
        </select>
      </label>
      <Tabs v-model="activeTab" class="flex min-h-0 flex-1 flex-col">
        <TabsList variant="line" class="mx-4 mt-2 shrink-0">
          <TabsTrigger v-for="tab in tabs" :key="tab" :value="tab">{{ t(`sessionDiagnostics.tabs.${tab}`) }}</TabsTrigger>
        </TabsList>
        <div class="shrink-0 space-y-1 border-b px-5 py-2 text-xs text-muted-foreground" aria-live="polite">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span v-if="section.source" class="break-all font-mono">{{ section.source }}</span
            ><span v-if="section.sampledAt">{{ formattedTime(section.sampledAt) }}</span>
          </div>
          <p v-if="sectionStatus(section, activeTab === 'longOperations')" class="flex items-center gap-2"><Loader2 v-if="section.state === 'loading'" class="h-3.5 w-3.5 animate-spin" />{{ sectionStatus(section, activeTab === "longOperations") }}</p>
          <p v-if="section.incomplete">{{ t("sessionDiagnostics.incomplete") }}</p>
          <p v-if="section.error" class="break-words text-destructive" role="alert">{{ section.error }}</p>
          <p v-if="section.data && section.dataSampledAt && section.dataSampledAt !== section.sampledAt">{{ t("sessionDiagnostics.previousSample", { time: formattedTime(section.dataSampledAt) }) }}</p>
        </div>
        <TabsContent value="sql" class="min-h-0 overflow-auto p-5">
          <template v-if="snapshot.sql.data">
            <div class="mb-3 flex items-center justify-between gap-3">
              <Badge variant="outline">{{ t(`sessionDiagnostics.completeness.${snapshot.sql.data.completeness}`) }}</Badge
              ><Button variant="outline" size="sm" class="gap-1.5" :disabled="!snapshot.sql.data.text" @click="copySql"><Copy class="h-3.5 w-3.5" />{{ t(snapshot.sql.data.completeness === "fragment" ? "sessionDiagnostics.copyFragment" : "sessionDiagnostics.copyText") }}</Button>
            </div>
            <pre class="select-text whitespace-pre-wrap break-words rounded-md border bg-muted/20 p-4 font-mono text-xs leading-5" tabindex="0">{{ snapshot.sql.data.text }}</pre>
          </template>
        </TabsContent>
        <TabsContent value="plan" class="flex min-h-0 flex-col overflow-hidden">
          <label v-if="snapshot.planChoices.length > 1 || (snapshot.planChoices.length > 0 && snapshot.plan.reason === 'target_changed')" class="flex shrink-0 flex-wrap items-center gap-2 px-5 py-3 text-sm"
            >{{ t("sessionDiagnostics.choosePlan")
            }}<select :value="selection.planKey ?? ''" class="h-8 max-w-full rounded-md border bg-background px-2 text-xs focus-visible:outline focus-visible:outline-ring" :disabled="busy" @change="choosePlan">
              <option value="" disabled>{{ t("sessionDiagnostics.selectPlan") }}</option>
              <option v-for="choice in snapshot.planChoices" :key="choice.key" :value="choice.key">{{ t("sessionDiagnostics.planOption", choice.identity) }}</option>
            </select></label
          >
          <template v-if="snapshot.plan.data"
            ><p class="shrink-0 px-5 py-2 text-xs text-muted-foreground">{{ t(`sessionDiagnostics.planBindings.${snapshot.plan.data.binding}`) }}</p>
            <div class="min-h-0 flex-1"><ExplainPlanViewer :plan="snapshot.plan.data.plan" :table-result="snapshot.plan.data.table" default-view="table" /></div
          ></template>
        </TabsContent>
        <TabsContent value="statistics" class="min-h-0 overflow-auto p-5">
          <div v-if="snapshot.metrics.data?.length" class="overflow-auto rounded-md border">
            <table class="w-full text-left text-xs">
              <thead class="bg-muted/30">
                <tr>
                  <th v-for="key in ['metric', 'value', 'unit', 'scope', 'source']" :key="key" class="whitespace-nowrap px-3 py-2 font-medium">{{ t(`sessionDiagnostics.columns.${key}`) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="metric in snapshot.metrics.data" :key="metric.source" class="border-t">
                  <td class="px-3 py-2">{{ t(`sessionDiagnostics.metrics.${metric.name}`) }}</td>
                  <td class="whitespace-nowrap px-3 py-2 font-mono">{{ formatValue(metric.value) }}</td>
                  <td class="px-3 py-2">{{ t(`sessionDiagnostics.units.${metric.unit}`) }}</td>
                  <td class="whitespace-nowrap px-3 py-2">{{ t(`sessionDiagnostics.scopes.${metric.scope}`) }}</td>
                  <td class="break-all px-3 py-2 font-mono text-muted-foreground">{{ metric.source }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3 class="mb-2 mt-5 text-sm font-medium">{{ t("sessionDiagnostics.waits") }}</h3>
          <div v-for="table in tables" :key="table.key" class="space-y-2">
            <p class="text-xs text-muted-foreground">{{ table.section.source }} · {{ formattedTime(table.section.sampledAt) }}</p>
            <p v-if="sectionStatus(table.section)" class="text-xs text-muted-foreground">{{ sectionStatus(table.section) }}</p>
            <p v-if="table.section.data && table.section.dataSampledAt && table.section.dataSampledAt !== table.section.sampledAt" class="text-xs text-muted-foreground">{{ t("sessionDiagnostics.previousSample", { time: formattedTime(table.section.dataSampledAt) }) }}</p>
            <p v-if="table.section.incomplete" class="text-xs text-muted-foreground">{{ t("sessionDiagnostics.incomplete") }}</p>
            <p v-if="table.section.error" class="break-words text-xs text-destructive">{{ table.section.error }}</p>
            <div v-if="table.section.data" class="overflow-auto rounded-md border">
              <table class="w-full text-left text-xs">
                <thead class="bg-muted/30">
                  <tr>
                    <th v-for="column in table.section.data.columns" :key="column" class="whitespace-nowrap px-3 py-2 font-medium" :title="column">{{ columnLabel(column) }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(values, index) in tableRows(table.section.data)" :key="index" class="border-t">
                    <td v-for="(value, column) in values" :key="column" class="whitespace-nowrap px-3 py-2 font-mono">{{ formatValue(value, table.section.data.columns[column]) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="longOperations" class="min-h-0 overflow-auto p-5">
          <p v-if="engine === 'oceanbase-oracle'" class="mb-3 text-xs text-muted-foreground">{{ t("sessionDiagnostics.obLongOperations") }}</p>
          <div v-if="snapshot.longOperations.data?.rows.length" class="overflow-auto rounded-md border">
            <table class="w-max min-w-full text-left text-xs">
              <thead class="bg-muted/30">
                <tr>
                  <th v-for="column in snapshot.longOperations.data.columns" :key="column" class="whitespace-nowrap px-3 py-2 font-medium" :title="column">{{ columnLabel(column) }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(values, index) in snapshot.longOperations.data.rows" :key="index" class="border-t">
                  <td
                    v-for="(value, column) in values"
                    :key="column"
                    class="px-3 py-2"
                    :class="snapshot.longOperations.data.columns[column] === 'MESSAGE' ? 'w-80 max-w-80 whitespace-normal break-words font-mono' : snapshot.longOperations.data.columns[column] === 'SCOPE' ? 'whitespace-nowrap' : 'whitespace-nowrap font-mono'"
                  >
                    {{ formatValue(value, snapshot.longOperations.data.columns[column]) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </TabsContent>
      </Tabs>
      <DialogFooter class="shrink-0 items-center border-t px-5 py-3">
        <Button v-if="busy" variant="outline" @click="stop">{{ t("sessionDiagnostics.stop") }}</Button>
        <Button variant="outline" class="gap-1.5" :disabled="busy" @click="refresh()"><RefreshCcw class="h-3.5 w-3.5" />{{ t("grid.refresh") }}</Button>
        <Button variant="secondary" @click="emit('close')">{{ t("common.close") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ConnectionConfig } from "@/types/database";
import { useRuntimeDiagnostics } from "@/composables/useRuntimeDiagnostics";
import type { DiagnosticContext, DiagnosticTarget } from "@/lib/database/runtimeDiagnostics";
import { useConnectionStore } from "@/stores/connectionStore";
import { runtimeDiagnosticMessages } from "@/lib/database/runtimeDiagnosticMessages";

const props = defineProps<{ connection: ConnectionConfig; database: string }>();
const { t } = useI18n({ useScope: "local", fallbackLocale: "en-US", messages: runtimeDiagnosticMessages });
const open = ref(false);
const sqlId = ref("");
const selectedIds = ref<string[]>([]);
const connectionStore = useConnectionStore();
const isOceanBase = computed(() => props.connection.db_type === "oceanbase-oracle");
function localDate(time: number) {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
const fromTime = ref(localDate(Date.now() - 3600000));
const toTime = ref(localDate(Date.now()));
const canFind = computed(() =>
  isOceanBase.value ? /^[A-Za-z0-9_:-]{1,128}$/.test(sqlId.value.trim()) && Number.isFinite(Date.parse(fromTime.value)) && Date.parse(toTime.value) > Date.parse(fromTime.value) && Date.parse(toTime.value) - Date.parse(fromTime.value) <= 86400000 : /^[0-9a-z]{13}$/.test(sqlId.value.trim()),
);
function find() {
  if (!canFind.value) return;
  void diagnostics.find(sqlId.value, isOceanBase.value ? { fromMicros: String(BigInt(Date.parse(fromTime.value)) * 1000n), toMicros: String(BigInt(Date.parse(toTime.value)) * 1000n) } : undefined);
}
function identity(target: DiagnosticTarget) {
  return target.kind === "ob_request"
    ? `${target.traceId} · ${t("tenant")} ${target.tenantId} · ${target.serverIp}:${target.serverPort} · SID ${target.sessionId} · request ${target.requestId} · ${target.requestTimeMicros} µs UTC`
    : `${target.sqlId} / ${target.childNumber} · ${t("instance")} ${target.instanceId} · ${target.firstLoadTime} / ${target.childAddress} · ${target.executions} ${t("executions")}`;
}
watch(
  () => connectionStore.connectedIds.has(props.connection.id),
  (connected) => {
    if (!connected) open.value = false;
  },
);
const context = computed<DiagnosticContext | null>(() =>
  open.value
    ? {
        connectionId: props.connection.id,
        connectionName: props.connection.name,
        database: props.database,
        engine: isOceanBase.value ? "oceanbase-oracle" : "oracle",
      }
    : null,
);
const diagnostics = useRuntimeDiagnostics(context);
const { targets, records, pending, error, unsavedRecord, nextCursor } = diagnostics;
const shown = computed(() => [unsavedRecord.value, ...records.value.filter((record) => selectedIds.value.includes(record.id))].filter((record) => record !== null));
watch(context, (value) => {
  selectedIds.value = [];
  if (value) void diagnostics.load();
});
watch(records, (value) => {
  if (value.length && !selectedIds.value.length) selectedIds.value = [value[0].id];
});
function select(id: string) {
  selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter((value) => value !== id) : [...selectedIds.value.slice(-1), id];
}
</script>

<template>
  <Button variant="ghost" size="icon" class="h-6 w-6" :aria-label="t('title')" :title="t('title')" @click="open = true"><Activity class="h-3.5 w-3.5" /></Button>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-[1000px] max-h-[85vh] flex flex-col overflow-hidden">
      <DialogHeader
        ><DialogTitle>{{ t("title") }}</DialogTitle
        ><DialogDescription>{{ t("description") }}</DialogDescription></DialogHeader
      >
      <div class="space-y-4 overflow-auto text-sm">
        <p>{{ t(isOceanBase ? "obScopeNotice" : "scopeNotice") }}</p>
        <p class="text-muted-foreground">{{ t(isOceanBase ? "obStatisticsNotice" : "statisticsNotice") }}</p>
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="find">
          <label class="flex-1">{{ isOceanBase ? "Trace ID" : "SQL ID" }}<Input v-model="sqlId" :maxlength="isOceanBase ? 128 : 13" :disabled="pending" /></label>
          <template v-if="isOceanBase"
            ><label>{{ t("fromTime") }}<Input v-model="fromTime" type="datetime-local" step="1" :disabled="pending" /></label><label>{{ t("toTime") }}<Input v-model="toTime" type="datetime-local" step="1" :disabled="pending" /></label
          ></template>
          <Button type="submit" :disabled="pending || !canFind">{{ t(isOceanBase ? "findRequest" : "find") }}</Button>
          <Button v-if="pending" type="button" variant="outline" @click="diagnostics.cancel()">{{ t("cancel") }}</Button>
        </form>
        <p v-if="error" role="alert">{{ t(`status.${error}`) }}</p>
        <table v-if="targets.length" class="w-full text-left">
          <thead>
            <tr>
              <th>{{ t("target") }}</th>
              <th>{{ t("action") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="target in targets" :key="identity(target)">
              <td class="break-all">{{ identity(target) }}</td>
              <td>
                <Button variant="outline" size="sm" :disabled="pending" @click="diagnostics.collect(target)">{{ t("collect") }}</Button>
              </td>
            </tr>
          </tbody>
        </table>
        <div class="flex items-center gap-2">
          <h3 class="font-medium">{{ t("records") }}</h3>
          <Button variant="outline" size="sm" :disabled="pending" @click="diagnostics.load()">{{ t("reload") }}</Button
          ><Button v-if="nextCursor" variant="outline" size="sm" :disabled="pending" @click="diagnostics.load(true)">{{ t("more") }}</Button>
        </div>
        <p class="text-muted-foreground">{{ t("retention") }}</p>
        <div class="flex flex-wrap gap-2">
          <Button v-for="record in records" :key="record.id" size="sm" :variant="selectedIds.includes(record.id) ? 'secondary' : 'outline'" @click="select(record.id)">{{ record.collectedAt }} · {{ record.target.sqlId }} · {{ t(`status.${record.status}`) }}</Button>
        </div>
        <div class="grid gap-4" :class="shown.length > 1 ? 'grid-cols-2' : 'grid-cols-1'">
          <section v-for="record in shown" :key="record.id" class="min-w-0 rounded border p-3 space-y-2">
            <h3 class="font-medium">{{ record.context.engine }} {{ record.engineVersion || t("unknownVersion") }} · {{ t(`status.${record.status}`) }}</h3>
            <p>{{ record.collectedAt }} · {{ identity(record.target) }}</p>
            <p>{{ t(record.target.kind === "ob_request" ? "requestScope" : "cumulative") }}</p>
            <table class="w-full text-left">
              <thead>
                <tr>
                  <th>{{ t("metric") }}</th>
                  <th>{{ t("value") }}</th>
                  <th>{{ t("unit") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="metric in record.metrics" :key="metric.name">
                  <td class="break-all">
                    {{ t(`metricNames.${metric.name}`) }}<small class="block text-muted-foreground">{{ metric.source }}</small>
                  </td>
                  <td>{{ metric.value ?? t(`status.${metric.missingReason || "not_collected"}`) }}</td>
                  <td>{{ t(`units.${metric.unit}`) }}</td>
                </tr>
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>

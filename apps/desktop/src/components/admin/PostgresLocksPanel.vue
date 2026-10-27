<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CustomContextMenu, { type ContextMenuItem } from "@/components/ui/CustomContextMenu.vue";
import { usePostgresAdminSession } from "@/composables/usePostgresAdminSession";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { supportsPostgresAdministration } from "@/lib/database/postgresAdministration";
import { blockingIdentity, buildPgLockDetailsSql, buildPgSignalSql, mapPgBlockingRows, PG_ADMIN_CONTEXT_SQL, PG_BLOCKING_SQL, pgSignalResultError, queryRecords, type PgBlockingRow, type PgSessionIdentity } from "@/lib/database/postgresLocks";
import { executeWithProductionContextGuard } from "@/lib/database/productionExecutionGuard";
import type { ConnectionConfig, QueryResult } from "@/types/database";
import PostgresAdminTable from "./PostgresAdminTable.vue";
const props = defineProps<{ connection: ConnectionConfig }>();
const { t } = useI18n();
const { toast } = useToast();
const connections = useConnectionStore();
const queries = useQueryStore();
const { query } = usePostgresAdminSession(() => props.connection);
const rows = ref<PgBlockingRow[]>([]);
const selected = ref<PgBlockingRow | null>(null);
const details = ref<{ wait: QueryResult | null; hold: QueryResult | null }>({ wait: null, hold: null });
const detailError = ref("");
const error = ref("");
const loading = ref(false);
const loadingDetails = ref(false);
const truncated = ref(false);
const ownPid = ref<number | null>(null);
const sampledAt = ref("");
const search = ref("");
const sortKey = ref("wait_pid");
const sortDirection = ref(1);
const autoRefresh = ref(false);
const pending = ref<{ target: PgSessionIdentity; edge: PgBlockingRow; action: "cancel" | "terminate"; label: string; user: string; database: string; generation: number } | null>(null);
const signaling = ref(false);
const columns = ["wait_pid", "wait_user", "wait_database", "wait_app", "wait_state", "hold_pid", "hold_user", "hold_database", "hold_app", "hold_state", "wait_event", "wait_query", "hold_query"];
let generation = 0,
  detailGeneration = 0;
let disposed = false;
let timer: ReturnType<typeof setInterval> | undefined;
const database = computed(() => props.connection.database || "");
const connected = computed(() => connections.connectedIds.has(props.connection.id));
const visibleRows = computed(() =>
  [...rows.value]
    .filter(
      (row) =>
        !search.value ||
        Object.values(row).some((cell) =>
          String(cell ?? "")
            .toLowerCase()
            .includes(search.value.toLowerCase()),
        ),
    )
    .sort((a, b) => String(a[sortKey.value] ?? "").localeCompare(String(b[sortKey.value] ?? ""), undefined, { numeric: true }) * sortDirection.value),
);
function sortBy(key: string) {
  sortDirection.value = sortKey.value === key ? -sortDirection.value : 1;
  sortKey.value = key;
}
function clearSelection() {
  detailGeneration++;
  selected.value = null;
  details.value = { wait: null, hold: null };
  detailError.value = "";
  loadingDetails.value = false;
}
async function load() {
  if (loading.value || pending.value || signaling.value || !connected.value) return;
  const ticket = ++generation;
  loading.value = true;
  rows.value = [];
  clearSelection();
  error.value = "";
  sampledAt.value = "";
  ownPid.value = null;
  truncated.value = false;
  try {
    if (!supportsPostgresAdministration(props.connection)) throw new Error(t("postgresAdmin.unsupported"));
    const context = queryRecords(await query(database.value, PG_ADMIN_CONTEXT_SQL, 1))[0];
    if (disposed || ticket !== generation) return;
    if (!context || Number(context.version) < 90600) throw new Error(t("postgresAdmin.oldVersion"));
    ownPid.value = Number(context.pid);
    const data = await query(database.value, PG_BLOCKING_SQL);
    if (disposed || ticket !== generation) return;
    rows.value = mapPgBlockingRows(data);
    truncated.value = !!(data.truncated || data.has_more);
    sampledAt.value = new Date().toLocaleTimeString();
  } catch (e) {
    if (!disposed && ticket === generation) {
      error.value = String(e);
      rows.value = [];
      autoRefresh.value = false;
    }
  } finally {
    if (ticket === generation) loading.value = false;
  }
}
async function selectRow(row: PgBlockingRow) {
  if (pending.value || signaling.value || loading.value) return;
  selected.value = row;
  details.value = { wait: null, hold: null };
  detailError.value = "";
  const ticket = ++detailGeneration;
  loadingDetails.value = true;
  try {
    const sides = await Promise.all(
      (["wait", "hold"] as const).map(async (side) => {
        const identity = blockingIdentity(row, side);
        return identity ? await query(database.value, buildPgLockDetailsSql(identity), 1000) : null;
      }),
    );
    if (!disposed && ticket === detailGeneration) details.value = { wait: sides[0], hold: sides[1] };
  } catch (e) {
    if (!disposed && ticket === detailGeneration) detailError.value = String(e);
  } finally {
    if (ticket === detailGeneration) loadingDetails.value = false;
  }
}
function canSignal(row: PgBlockingRow, side: "wait" | "hold") {
  const identity = blockingIdentity(row, side);
  return connected.value && !loading.value && !signaling.value && !pending.value && ownPid.value !== null && !!identity && identity.pid !== ownPid.value;
}
function request(row: PgBlockingRow, side: "wait" | "hold", action: "cancel" | "terminate") {
  if (!canSignal(row, side)) return;
  const target = blockingIdentity(row, side)!;
  pending.value = {
    target,
    edge: { ...row },
    action,
    label: t(side === "hold" ? "postgresAdmin.terminateBlocker" : action === "cancel" ? "postgresAdmin.cancel" : "postgresAdmin.terminate"),
    user: String(row[`${side}_user`] ?? t("postgresAdmin.unavailable")),
    database: String(row[`${side}_database`] ?? "—"),
    generation,
  };
}
async function confirm() {
  const operation = pending.value;
  if (!operation || signaling.value || operation.generation !== generation || !connected.value) return;
  signaling.value = true;
  const config = { ...props.connection };
  const db = database.value;
  try {
    const sql = buildPgSignalSql(operation.target, operation.action);
    const result = await executeWithProductionContextGuard({
      connection: config,
      database: db,
      scope: "connection",
      reviewText: sql,
      source: t("production.sourceAdmin"),
      execute: async () => {
        if (disposed || operation.generation !== generation || config.id !== props.connection.id || !connected.value) throw new Error(t("postgresAdmin.targetChanged"));
        // Revalidate the observed edge before signaling; do not act on a resolved wait.
        const fresh = mapPgBlockingRows(await query(db, PG_BLOCKING_SQL));
        if (!fresh.some((row) => row.wait_pid === operation.edge.wait_pid && row.hold_pid === operation.edge.hold_pid && row.wait_backend_start === operation.edge.wait_backend_start && row.hold_backend_start === operation.edge.hold_backend_start)) throw new Error(t("postgresAdmin.targetChanged"));
        if (disposed || operation.generation !== generation) throw new Error(t("postgresAdmin.targetChanged"));
        return await query(db, sql, 1);
      },
    });
    if (disposed || operation.generation !== generation) return;
    if (result) {
      const failure = pgSignalResultError(result, operation.action);
      if (failure) throw new Error(t(failure));
      toast(t("postgresAdmin.done"), 2500);
    }
  } catch (e) {
    if (!disposed && operation.generation === generation) toast(String(e), 5000);
  } finally {
    signaling.value = false;
    pending.value = null;
    if (!disposed) void load();
  }
}
async function copy(value: unknown) {
  try {
    await navigator.clipboard.writeText(typeof value === "string" ? value : JSON.stringify(value, null, 2));
    toast(t("postgresAdmin.copied"), 1500);
  } catch (e) {
    toast(String(e), 3000);
  }
}
function menu(row: PgBlockingRow): ContextMenuItem[] {
  return [
    { label: t("postgresAdmin.copy"), action: () => copy(row) },
    { label: t("postgresAdmin.copyWait"), disabled: !row.wait_query, action: () => copy(row.wait_query) },
    { label: t("postgresAdmin.copyHold"), disabled: !row.hold_query, action: () => copy(row.hold_query) },
    { label: t("postgresAdmin.showSessions"), action: () => queries.openProcessList(props.connection.id) },
    { label: t("postgresAdmin.cancel"), disabled: !canSignal(row, "wait"), action: () => request(row, "wait", "cancel") },
    { label: t("postgresAdmin.terminate"), disabled: !canSignal(row, "wait"), action: () => request(row, "wait", "terminate") },
    { label: t("postgresAdmin.terminateBlocker"), disabled: !canSignal(row, "hold"), action: () => request(row, "hold", "terminate") },
    { label: t("postgresAdmin.refresh"), disabled: loading.value || signaling.value || !!pending.value, action: load },
  ];
}
function openSql() {
  queries.createTab(props.connection.id, database.value, t("postgresAdmin.locks"), "query", undefined, PG_BLOCKING_SQL);
}
watch([() => JSON.stringify(props.connection), connected], () => {
  generation++;
  loading.value = false;
  rows.value = [];
  pending.value = null;
  clearSelection();
  if (connected.value) void load();
});
onMounted(() => {
  void load();
  timer = setInterval(() => {
    if (autoRefresh.value && !document.hidden) void load();
  }, 5000);
});
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  detailGeneration++;
  clearInterval(timer);
});
</script>
<template>
  <section class="flex h-full min-h-0 min-w-0 flex-col gap-3 p-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="text-sm font-semibold">{{ t("postgresAdmin.locks") }}</h2>
      <Button size="sm" variant="outline" :disabled="loading || signaling || !!pending || !connected" @click="load">{{ t("postgresAdmin.refresh") }}</Button>
      <input v-model="search" class="h-7 w-40 rounded border bg-background px-2 text-xs" :aria-label="t('postgresAdmin.filter')" :placeholder="t('postgresAdmin.filter')" />
      <label class="flex items-center gap-2 text-xs"><input v-model="autoRefresh" type="checkbox" />{{ t("postgresAdmin.autoRefresh") }}</label>
      <Button size="sm" variant="ghost" @click="openSql">{{ t("postgresAdmin.showSql") }}</Button>
    </div>
    <p class="text-xs text-muted-foreground">{{ connection.name }} · {{ t("postgresAdmin.visibility") }}</p>
    <p v-if="sampledAt" class="text-xs text-muted-foreground">{{ t("postgresAdmin.sampled", { time: sampledAt }) }}</p>
    <p v-if="error" role="alert" class="text-xs text-destructive">{{ error }}</p>
    <p v-if="truncated" class="text-xs text-amber-600">{{ t("postgresAdmin.partial") }}</p>
    <div class="min-h-24 max-h-[45%] min-w-0 overflow-auto rounded border">
      <table class="w-full text-left text-xs">
        <thead class="sticky top-0 bg-muted">
          <tr>
            <th v-for="column in columns" :key="column" class="whitespace-nowrap px-3 py-2">
              <button :aria-label="t('postgresAdmin.sort', { column: t(`postgresAdmin.${column}`) })" @click="sortBy(column)">{{ t(`postgresAdmin.${column}`) }}</button>
            </th>
          </tr>
        </thead>
        <tbody>
          <CustomContextMenu v-for="row in visibleRows" :key="`${row.wait_pid}:${row.hold_pid}`" v-slot="{ onContextMenu }" :items="() => menu(row)">
            <tr
              tabindex="0"
              class="cursor-pointer border-t hover:bg-accent/40"
              :class="{ 'bg-accent': selected === row }"
              :aria-selected="selected === row"
              @click="selectRow(row)"
              @keydown.enter="selectRow(row)"
              @contextmenu="
                selectRow(row);
                onContextMenu($event);
              "
            >
              <td v-for="column in columns" :key="column" class="max-w-64 truncate px-3 py-2" :title="String(row[column] ?? '')">{{ column === "hold_pid" && row.hold_pid === 0 ? t("postgresAdmin.prepared") : (row[column] ?? "—") }}</td>
            </tr>
          </CustomContextMenu>
        </tbody>
      </table>
      <p v-if="loading" role="status" class="p-4 text-xs">{{ t("common.loading") }}</p>
      <p v-else-if="!visibleRows.length && !error" class="p-4 text-xs text-muted-foreground">{{ t("postgresAdmin.empty") }}</p>
    </div>
    <div v-if="selected" class="flex min-h-0 flex-1 flex-col gap-3">
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" :disabled="!canSignal(selected, 'wait')" @click="request(selected, 'wait', 'cancel')">{{ t("postgresAdmin.cancel") }}</Button>
        <Button size="sm" variant="outline" :disabled="!canSignal(selected, 'wait')" @click="request(selected, 'wait', 'terminate')">{{ t("postgresAdmin.terminate") }}</Button>
        <Button size="sm" variant="outline" :disabled="!canSignal(selected, 'hold')" @click="request(selected, 'hold', 'terminate')">{{ t("postgresAdmin.terminateBlocker") }}</Button>
        <Button size="sm" variant="ghost" @click="copy(selected)">{{ t("postgresAdmin.copy") }}</Button>
      </div>
      <p v-if="detailError" role="alert" class="text-xs text-destructive">{{ detailError }}</p>
      <p v-if="loadingDetails" role="status" class="text-xs">{{ t("common.loading") }}</p>
      <div v-else class="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-auto lg:grid-cols-2">
        <section v-for="side in ['wait', 'hold'] as const" :key="side" class="flex min-h-0 min-w-0 flex-col gap-2">
          <h3 class="text-xs font-semibold">{{ t(side === "wait" ? "postgresAdmin.waiting" : "postgresAdmin.blocking") }} · {{ selected[`${side}_pid`] }}</h3>
          <p class="max-h-28 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 font-mono text-xs">{{ selected[`${side}_query`] ?? t("postgresAdmin.unavailable") }}</p>
          <p v-if="side === 'hold' && selected.hold_pid === 0" class="text-xs">{{ t("postgresAdmin.prepared") }}</p>
          <PostgresAdminTable v-else :result="details[side]" />
        </section>
      </div>
    </div>
    <p v-else class="text-xs text-muted-foreground">{{ t("postgresAdmin.select") }}</p>
    <Dialog
      :open="!!pending"
      @update:open="
        (value) => {
          if (!value && !signaling) pending = null;
        }
      "
      ><DialogContent
        ><DialogHeader
          ><DialogTitle>{{ t("postgresAdmin.confirm") }}</DialogTitle></DialogHeader
        >
        <p v-if="pending" class="text-sm">{{ t("postgresAdmin.confirmMessage", { action: pending.label, pid: pending.target.pid, user: pending.user, database: pending.database }) }}</p>
        <DialogFooter
          ><Button variant="outline" :disabled="signaling" @click="pending = null">{{ t("postgresAdmin.dismiss") }}</Button
          ><Button variant="destructive" :disabled="signaling" @click="confirm">{{ t("postgresAdmin.confirmButton") }}</Button></DialogFooter
        >
      </DialogContent></Dialog
    >
  </section>
</template>

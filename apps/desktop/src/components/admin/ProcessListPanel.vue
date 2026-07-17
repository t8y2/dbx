<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, AlertTriangle, ArrowDown, ArrowUp, Ban, Copy, Loader2, RefreshCcw, Search } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { clampInterval, createProcessListLoadCoordinator, DEFAULT_REFRESH_SECONDS, processListExecutionError, processListSessionCount } from "@/lib/database/mysqlProcessList";
import { resolveProcessListDriverForConnection, type ProcessRow } from "@/lib/database/processListDrivers";

const props = defineProps<{
  connection: ConnectionConfig;
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const { toast } = useToast();

// The panel is only opened for supported engines; guard the driver defensively so
// a missing one degrades to an empty table rather than crashing the render.
const driver = computed(() => resolveProcessListDriverForConnection(props.connection));
const columns = computed(() => driver.value?.columns ?? []);
const numericKeys = computed(() => new Set(columns.value.filter((column) => column.numeric).map((column) => column.key)));

const rows = ref<ProcessRow[]>([]);
const truncated = ref(false);
const ownSessionId = ref<number | null>(null);
const loading = ref(false);
const loadCoordinator = createProcessListLoadCoordinator();
const loadError = ref("");
const search = ref("");
const sortKey = ref<string>(driver.value?.defaultSortKey ?? "time");
const sortDir = ref<"asc" | "desc">("desc");

const autoRefresh = ref(false);
const intervalSeconds = ref(DEFAULT_REFRESH_SECONDS);
let timer: ReturnType<typeof setInterval> | undefined;

const killTarget = ref<ProcessRow | null>(null);
const killing = ref(false);
const fallbackListSql = ref<string | null>(null);

// Full-text preview for long cells (SQL statement / info), opened by clicking them.
const previewText = ref<string | null>(null);

function openPreview(value: string | number | null) {
  if (value === null || value === undefined || String(value).length === 0) return;
  previewText.value = String(value);
}

async function copyPreview() {
  if (previewText.value === null) return;
  try {
    await navigator.clipboard.writeText(previewText.value);
    toast(t("processList.copied"), 1500);
  } catch (error: any) {
    toast(error?.message || String(error), 3000);
  }
}

const filteredRows = computed(() => {
  const query = search.value.trim().toLowerCase();
  const base = query ? rows.value.filter((row) => Object.values(row).some((value) => value !== null && value !== undefined && String(value).toLowerCase().includes(query))) : rows.value.slice();
  const key = sortKey.value;
  const dir = sortDir.value === "asc" ? 1 : -1;
  return base.sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
});

function toggleSort(key: string) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === "asc" ? "desc" : "asc";
  } else {
    sortKey.value = key;
    sortDir.value = numericKeys.value.has(key) ? "desc" : "asc";
  }
}

async function load(options: { silent?: boolean } = {}) {
  const activeDriver = driver.value;
  if (!activeDriver) return;
  if (!loadCoordinator.tryStart()) return;
  if (!options.silent) loading.value = true;
  loadError.value = "";
  try {
    await connectionStore.ensureConnected(props.connection.id);
    if (ownSessionId.value === null) {
      try {
        const idResult = await api.executeQuery(props.connection.id, "", activeDriver.ownSessionSql, undefined, undefined, { maxRows: 1 });
        const raw = idResult?.rows?.[0]?.[0];
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) ownSessionId.value = parsed;
      } catch {
        // Non-fatal: without our own id we simply cannot dim the self row.
      }
    }
    const listSql = fallbackListSql.value ?? activeDriver.listSql;
    let result;
    try {
      result = await api.executeQuery(props.connection.id, "", listSql, undefined, undefined, { maxRows: activeDriver.maxRows });
    } catch (error) {
      if (fallbackListSql.value || !activeDriver.fallbackListSql || !activeDriver.shouldUseFallbackListSql?.(error)) throw error;
      result = await api.executeQuery(props.connection.id, "", activeDriver.fallbackListSql, undefined, undefined, { maxRows: activeDriver.maxRows });
      // Cache the compatible query so old servers do not fail once per refresh.
      fallbackListSql.value = activeDriver.fallbackListSql;
    }
    rows.value = activeDriver.mapRows(result);
    truncated.value = result.truncated === true;
  } catch (error: any) {
    loadError.value = error?.message || String(error);
  } finally {
    loading.value = false;
    loadCoordinator.finish();
  }
}

function isOwnSession(row: ProcessRow): boolean {
  return ownSessionId.value !== null && row.id === ownSessionId.value;
}

function requestKill(row: ProcessRow) {
  if (isOwnSession(row)) return;
  killTarget.value = row;
}

async function confirmKill() {
  const target = killTarget.value;
  const activeDriver = driver.value;
  if (!target || !activeDriver) return;
  killing.value = true;
  try {
    const killSql = activeDriver.buildKillSql(target.id);
    const result = await executeWithProductionSqlGuard({
      connection: props.connection,
      database: "",
      sql: killSql,
      source: t("production.sourceAdmin"),
      execute: () => api.executeMulti(props.connection.id, "", killSql, undefined, undefined, { maxRows: 1 }),
    });
    if (result === undefined) return;
    const executionError = processListExecutionError(result);
    if (executionError) throw new Error(executionError);
    const killResultError = activeDriver.killResultError?.(result);
    if (killResultError) throw new Error(killResultError);
    toast(t("processList.killSuccess", { id: target.id }), 2500);
    killTarget.value = null;
    await load({ silent: true });
  } catch (error: any) {
    toast(t("processList.killFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    killing.value = false;
  }
}

function stopTimer() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

function restartTimer() {
  stopTimer();
  if (!autoRefresh.value) return;
  const seconds = clampInterval(intervalSeconds.value);
  timer = setInterval(() => {
    // Skip polling while the window is hidden to avoid needless server load.
    if (document.hidden) return;
    void load({ silent: true });
  }, seconds * 1000);
}

function onIntervalInput() {
  intervalSeconds.value = clampInterval(Number(intervalSeconds.value));
  if (autoRefresh.value) restartTimer();
}

watch(autoRefresh, restartTimer);

watch(intervalSeconds, () => {
  if (autoRefresh.value) restartTimer();
});

watch(
  () => props.connection.id,
  () => {
    rows.value = [];
    truncated.value = false;
    ownSessionId.value = null;
    search.value = "";
    sortKey.value = driver.value?.defaultSortKey ?? "time";
    sortDir.value = "desc";
    void load();
  },
);

onMounted(() => void load());
onBeforeUnmount(stopTimer);
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-11 shrink-0 items-center gap-2 border-b bg-muted/20 px-3">
      <div class="flex min-w-0 items-center gap-2">
        <Activity class="h-4 w-4 text-primary" />
        <div class="truncate text-sm font-semibold">{{ t("processList.title") }}</div>
        <Badge variant="outline" class="h-5 rounded-md px-1.5 text-[11px]">{{ connection.name }}</Badge>
        <Badge variant="secondary" class="h-5 rounded-md px-1.5 text-[11px]">{{ t("processList.sessionCount", { count: processListSessionCount(truncated ? rows.length : filteredRows.length, truncated) }) }}</Badge>
      </div>
      <div class="ml-auto flex items-center gap-2">
        <div class="flex h-7 items-center gap-1.5 rounded-md border bg-background px-2">
          <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input v-model="search" class="h-full w-40 min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground" :placeholder="t('processList.filter')" />
        </div>
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input v-model="autoRefresh" type="checkbox" class="h-3.5 w-3.5 accent-primary" />
          {{ t("processList.autoRefresh") }}
        </label>
        <div class="flex h-7 items-center gap-1 rounded-md border bg-background px-1.5">
          <Input v-model.number="intervalSeconds" type="number" min="1" max="3600" class="h-6 w-14 border-0 px-1 text-xs shadow-none focus-visible:ring-0" @change="onIntervalInput" />
          <span class="pr-1 text-[11px] text-muted-foreground">{{ t("processList.seconds") }}</span>
        </div>
        <Button variant="outline" size="sm" class="h-7 gap-1.5 px-2 text-xs" :disabled="loading" @click="load()">
          <Loader2 v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          <RefreshCcw v-else class="h-3.5 w-3.5" />
          {{ t("grid.refresh") }}
        </Button>
      </div>
    </div>

    <div v-if="loadError" class="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">{{ loadError }}</div>

    <div class="min-h-0 flex-1 overflow-auto">
      <table class="w-full border-collapse text-xs">
        <thead class="sticky top-0 z-10 bg-muted/40 backdrop-blur">
          <tr>
            <th v-for="column in columns" :key="column.key" class="cursor-pointer select-none whitespace-nowrap border-b px-3 py-2 text-left font-medium hover:bg-accent" @click="toggleSort(column.key)">
              <span class="inline-flex items-center gap-1">
                {{ t(column.labelKey) }}
                <ArrowUp v-if="sortKey === column.key && sortDir === 'asc'" class="h-3 w-3" />
                <ArrowDown v-else-if="sortKey === column.key && sortDir === 'desc'" class="h-3 w-3" />
              </span>
            </th>
            <th class="w-16 whitespace-nowrap border-b px-3 py-2 text-right font-medium">{{ t("processList.colActions") }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in filteredRows" :key="row.id" class="border-b hover:bg-accent/40" :class="{ 'bg-primary/5': isOwnSession(row) }">
            <td
              v-for="column in columns"
              :key="column.key"
              class="px-3 py-1.5"
              :class="[column.mono ? 'font-mono' : '', column.wide ? 'max-w-md cursor-pointer truncate hover:text-foreground hover:underline' : 'whitespace-nowrap', column.wide || column.key === 'db' || column.key === 'state' || column.key === 'wait' ? 'text-muted-foreground' : '']"
              :title="column.wide ? (row[column.key] === null || row[column.key] === undefined ? '' : t('processList.previewTitle')) : undefined"
              @click="column.wide ? openPreview(row[column.key]) : undefined"
            >
              <template v-if="column.key === 'id'">
                {{ row.id }}
                <Badge v-if="isOwnSession(row)" variant="outline" class="ml-1 h-4 rounded px-1 text-[10px]">{{ t("processList.self") }}</Badge>
              </template>
              <template v-else>{{ row[column.key] === null || row[column.key] === undefined ? "—" : row[column.key] }}</template>
            </td>
            <td class="px-3 py-1.5 text-right">
              <Button
                variant="ghost"
                size="sm"
                class="h-6 gap-1 px-1.5 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
                :disabled="isOwnSession(row)"
                :title="isOwnSession(row) ? t('processList.cannotKillSelf') : t('processList.kill')"
                @click="requestKill(row)"
              >
                <Ban class="h-3.5 w-3.5" />
                {{ t("processList.kill") }}
              </Button>
            </td>
          </tr>
          <tr v-if="!loading && filteredRows.length === 0">
            <td :colspan="columns.length + 1" class="px-3 py-10 text-center text-muted-foreground">
              {{ search ? t("grid.noSearchResults") : t("processList.empty") }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Dialog
      :open="killTarget !== null"
      @update:open="
        (open) => {
          if (!open) killTarget = null;
        }
      "
    >
      <DialogContent class="max-w-sm">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <AlertTriangle class="h-4 w-4 text-destructive" />
            {{ t("processList.killTitle") }}
          </DialogTitle>
        </DialogHeader>
        <p v-if="killTarget" class="text-sm text-muted-foreground">
          {{ t("processList.killConfirm", { id: killTarget.id, user: killTarget.user }) }}
        </p>
        <DialogFooter>
          <Button variant="outline" @click="killTarget = null">{{ t("dangerDialog.cancel") }}</Button>
          <Button variant="destructive" :disabled="killing" @click="confirmKill">
            <Loader2 v-if="killing" class="mr-1.5 h-3.5 w-3.5 animate-spin" />
            {{ t("processList.kill") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog
      :open="previewText !== null"
      @update:open="
        (open) => {
          if (!open) previewText = null;
        }
      "
    >
      <DialogContent class="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ t("processList.previewTitle") }}</DialogTitle>
        </DialogHeader>
        <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-3 font-mono text-xs">{{ previewText }}</pre>
        <DialogFooter>
          <Button variant="outline" class="gap-1.5" @click="copyPreview">
            <Copy class="h-3.5 w-3.5" />
            {{ t("processList.copy") }}
          </Button>
          <Button variant="secondary" @click="previewText = null">{{ t("dangerDialog.cancel") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

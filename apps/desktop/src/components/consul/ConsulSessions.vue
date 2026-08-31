<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from "vue";
import { AlertTriangle, ChevronDown, ChevronUp, Clock3, KeyRound, Loader2, Plus, RefreshCcw, RotateCw, Search, ShieldCheck, Trash2 } from "@lucide/vue";
import ConsulListPagination from "@/components/consul/ConsulListPagination.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import * as api from "@/lib/backend/api";
import { clampConsulPage, CONSUL_LIST_PAGE_SIZE, paginateConsulItems } from "@/lib/consul/pagination";
import { consulSessionRenewDelayMs, parseConsulDurationMs } from "@/lib/consul/sessionRenew";
import { normalizeConsulSession } from "@/lib/consul/sessionModel";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { useConsulStore } from "@/stores/consulStore";
import { useI18n } from "vue-i18n";
import type { ConsulResponseMetadata, ConsulSession, ConsulSessionKeysResponse, ConsulSessionServiceCheck } from "@/types/consul";

const props = defineProps<{ connectionId: string }>();
const { t } = useI18n();
const store = useConnectionStore();
const consulStore = useConsulStore();
const readOnly = computed(() => connectionIsEffectivelyReadOnly(store.getConfig(props.connectionId)));
function behaviorLabel(behavior: string) {
  if (behavior === "delete") return t("consul.ui.behaviorDelete");
  if (behavior === "release") return t("consul.ui.behaviorRelease");
  return behavior || t("consul.ui.unknown");
}
const connectionActive = computed(() => store.connectedIds.has(props.connectionId));

const sessions = ref<ConsulSession[]>([]);
const responseMetadata = ref<ConsulResponseMetadata | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const createOpen = ref(false);
const lockOpen = ref(false);
const expandedSessionId = ref("");
const heldKeys = ref<Record<string, ConsulSessionKeysResponse>>({});
const heldKeysLoading = ref("");

const search = ref("");
const ttlFilter = ref<"any" | "ttl" | "persistent">("any");
const behaviorFilter = ref<"any" | "release" | "delete">("any");
const page = ref(1);

const createForm = ref({
  name: "",
  node: "",
  ttl: "30s",
  lockDelay: "15s",
  behavior: "release" as "release" | "delete",
  nodeChecks: "serfHealth",
  serviceChecks: "",
});
const lockForm = ref({ key: "", session: "", value: "" });
const lockInspection = ref<{ inspected: boolean; found: boolean; modifyIndex: string; owner: string; flags: string }>({ inspected: false, found: false, modifyIndex: "0", owner: "", flags: "0" });
const lockInspecting = ref(false);

const autoRenewId = ref("");
let renewTimer: ReturnType<typeof setTimeout> | undefined;
let renewContext = "";
let sequence = 0;

const filteredSessions = computed(() => {
  const keyword = search.value.trim().toLocaleLowerCase();
  return sessions.value.filter((session) => {
    if (ttlFilter.value === "ttl" && !session.TTL.trim()) return false;
    if (ttlFilter.value === "persistent" && session.TTL.trim()) return false;
    if (behaviorFilter.value !== "any" && session.Behavior !== behaviorFilter.value) return false;
    if (!keyword) return true;
    const checks = [...session.NodeChecks, ...session.ServiceChecks.flatMap((check) => [check.ID, check.Namespace])];
    return [session.Name, session.ID, session.Node, session.TTL, session.Behavior, ...checks].join("\n").toLocaleLowerCase().includes(keyword);
  });
});
const pagedSessions = computed(() => paginateConsulItems(filteredSessions.value, page.value));
const hasFilters = computed(() => Boolean(search.value.trim()) || ttlFilter.value !== "any" || behaviorFilter.value !== "any");

function message(value: unknown) {
  return value instanceof Error ? value.message : String(value);
}

async function withUiTimeout<T>(operation: Promise<T>, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t("consul.ui.sessionRequestTimedOut"))), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function currentScopeKey() {
  const external = store.getConfig(props.connectionId)?.external_config;
  const config = external && typeof external === "object" && !Array.isArray(external) ? (external as Record<string, unknown>) : {};
  return [config.datacenter || config.consulDatacenter || config.consul_datacenter, config.namespace || config.consulNamespace || config.consul_namespace, config.partition || config.consulPartition || config.consul_partition].map((value) => String(value || "")).join("\u0000");
}

function currentRenewContext() {
  return `${props.connectionId}\u0000${consulStore.generation}\u0000${currentScopeKey()}`;
}

function isTtlSession(session: ConsulSession) {
  return Boolean(session.TTL.trim());
}

function formatLockDelay(value: number) {
  const seconds = value / 1_000_000_000;
  return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}s`;
}

function sessionChecks(session: ConsulSession) {
  const nodeChecks = session.NodeChecks.map((check) => `${t("consul.ui.nodeCheckShort")}: ${check}`);
  const serviceChecks = session.ServiceChecks.map((check) => `${t("consul.ui.serviceCheckShort")}: ${check.ID}${check.Namespace ? ` @ ${check.Namespace}` : ""}`);
  return [...nodeChecks, ...serviceChecks];
}

function parseServiceChecks(value: string): ConsulSessionServiceCheck[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [id, namespace = ""] = part.split("@", 2).map((item) => item.trim());
      return { ID: id, Namespace: namespace };
    });
}

function validateCreateForm() {
  const ttl = createForm.value.ttl.trim();
  const ttlMs = ttl ? parseConsulDurationMs(ttl) : null;
  if (ttl && (ttlMs === null || ttlMs < 10_000 || ttlMs > 86_400_000)) {
    return t("consul.ui.invalidSessionTtl");
  }
  const delay = createForm.value.lockDelay.trim();
  const delayMs = delay ? parseConsulDurationMs(delay) : null;
  if (delay && (delayMs === null || delayMs < 0 || delayMs > 60_000)) {
    return t("consul.ui.invalidLockDelay");
  }
  return "";
}

async function load() {
  const current = ++sequence;
  loading.value = true;
  error.value = "";
  try {
    const value = await withUiTimeout(api.consulSessions(props.connectionId));
    if (current !== sequence) return;
    sessions.value = value.items.map(normalizeConsulSession);
    responseMetadata.value = value.metadata;
    page.value = clampConsulPage(page.value, filteredSessions.value.length);
    if (autoRenewId.value && !sessions.value.some((session) => session.ID === autoRenewId.value)) stopAutoRenew();
    if (!lockForm.value.session && sessions.value.length) lockForm.value.session = sessions.value[0].ID;
  } catch (value) {
    if (current === sequence) error.value = message(value);
  } finally {
    if (current === sequence) loading.value = false;
  }
}

async function createSession() {
  if (readOnly.value) return;
  const validation = validateCreateForm();
  if (validation) {
    error.value = validation;
    return;
  }
  if (createForm.value.behavior === "delete" && !window.confirm(t("consul.ui.deleteBehaviorWarning"))) return;
  saving.value = true;
  error.value = "";
  try {
    const created = await api.consulCreateSession(props.connectionId, {
      name: createForm.value.name,
      node: createForm.value.node,
      ttl: createForm.value.ttl.trim() || null,
      lockDelay: createForm.value.lockDelay.trim() || null,
      behavior: createForm.value.behavior,
      nodeChecks: createForm.value.nodeChecks
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      serviceChecks: parseServiceChecks(createForm.value.serviceChecks),
    });
    createOpen.value = false;
    await load();
    expandedSessionId.value = created.ID;
  } catch (value) {
    error.value = message(value);
  } finally {
    saving.value = false;
  }
}

async function renew(id: string) {
  const session = sessions.value.find((item) => item.ID === id);
  if (!session || !isTtlSession(session)) {
    error.value = t("consul.ui.noRenewRequired");
    stopAutoRenew();
    return false;
  }
  if (readOnly.value || !connectionActive.value) {
    stopAutoRenew();
    return false;
  }
  try {
    const renewed = await api.consulRenewSession(props.connectionId, id);
    const index = sessions.value.findIndex((item) => item.ID === id);
    if (index >= 0) sessions.value[index] = renewed;
    return true;
  } catch (value) {
    error.value = message(value);
    stopAutoRenew();
    return false;
  }
}

async function destroy(id: string) {
  if (readOnly.value) return;
  try {
    const impact = await api.consulSessionDestroyImpact(props.connectionId, id);
    if (!impact.complete) {
      error.value = t("consul.ui.sessionImpactIncomplete");
      return;
    }
    const keys = impact.heldKeys.map((item) => item.key).join(", ") || t("consul.ui.noHeldKeys");
    if (
      !window.confirm(
        t("consul.ui.destroySessionImpact", {
          id,
          behavior: impact.session.Behavior,
          count: impact.heldKeys.length,
          keys,
        }),
      )
    )
      return;
    await api.consulDestroySession(props.connectionId, {
      id,
      expectedBehavior: impact.session.Behavior,
      expectedHeldKeys: impact.heldKeys,
    });
    if (autoRenewId.value === id) stopAutoRenew();
    delete heldKeys.value[id];
    if (expandedSessionId.value === id) expandedSessionId.value = "";
    await load();
  } catch (value) {
    error.value = message(value);
  }
}

function toggleDetails(id: string) {
  expandedSessionId.value = expandedSessionId.value === id ? "" : id;
}

async function toggleHeldKeys(id: string) {
  if (expandedSessionId.value === id && heldKeys.value[id]) {
    expandedSessionId.value = "";
    return;
  }
  expandedSessionId.value = id;
  heldKeysLoading.value = id;
  try {
    heldKeys.value[id] = await api.consulSessionKeys(props.connectionId, id);
  } catch (value) {
    error.value = message(value);
  } finally {
    if (heldKeysLoading.value === id) heldKeysLoading.value = "";
  }
}

function scheduleAutoRenew(id: string) {
  const session = sessions.value.find((item) => item.ID === id);
  if (!session || !isTtlSession(session) || readOnly.value || !connectionActive.value || renewContext !== currentRenewContext()) {
    stopAutoRenew();
    return;
  }
  renewTimer = setTimeout(async () => {
    renewTimer = undefined;
    if (autoRenewId.value !== id || renewContext !== currentRenewContext()) {
      stopAutoRenew();
      return;
    }
    if (await renew(id)) scheduleAutoRenew(id);
  }, consulSessionRenewDelayMs(session.TTL));
}

function startAutoRenew(id: string) {
  stopAutoRenew();
  const session = sessions.value.find((item) => item.ID === id);
  if (!session || !isTtlSession(session) || !connectionActive.value) return;
  autoRenewId.value = id;
  renewContext = currentRenewContext();
  scheduleAutoRenew(id);
}

function stopAutoRenew() {
  if (renewTimer) clearTimeout(renewTimer);
  renewTimer = undefined;
  renewContext = "";
  autoRenewId.value = "";
}

function resetLockInspection() {
  lockInspection.value = { inspected: false, found: false, modifyIndex: "0", owner: "", flags: "0" };
}

async function inspectLockKey() {
  const key = lockForm.value.key.trim();
  if (!key) {
    resetLockInspection();
    return false;
  }
  lockInspecting.value = true;
  error.value = "";
  try {
    const result = await api.consulGet(props.connectionId, key);
    lockInspection.value = {
      inspected: true,
      found: result.found,
      modifyIndex: String(result.metadata?.modRevision ?? 0),
      owner: String(result.metadata?.session ?? ""),
      flags: String(result.metadata?.flags ?? 0),
    };
    return true;
  } catch (value) {
    error.value = message(value);
    return false;
  } finally {
    lockInspecting.value = false;
  }
}

async function acquire() {
  if (readOnly.value || !lockForm.value.key.trim() || !lockForm.value.session) return;
  saving.value = true;
  try {
    if (!(await inspectLockKey())) return;
    if (lockInspection.value.owner && lockInspection.value.owner !== lockForm.value.session) {
      error.value = t("consul.ui.keyHeldBy", { session: lockInspection.value.owner });
      return;
    }
    await api.consulAcquireLock(props.connectionId, {
      key: lockForm.value.key.trim(),
      session: lockForm.value.session,
      value: { encoding: "utf8", data: lockForm.value.value },
      flags: null,
      expectedModifyIndex: lockInspection.value.modifyIndex,
    });
    await inspectLockKey();
    delete heldKeys.value[lockForm.value.session];
    expandedSessionId.value = "";
    await toggleHeldKeys(lockForm.value.session);
    await load();
  } catch (value) {
    error.value = message(value);
  } finally {
    saving.value = false;
  }
}

async function release() {
  if (readOnly.value || !lockForm.value.key.trim() || !lockForm.value.session) return;
  saving.value = true;
  try {
    if (!(await inspectLockKey())) return;
    if (!lockInspection.value.found) {
      error.value = t("consul.ui.keyNotFound");
      return;
    }
    if (lockInspection.value.owner !== lockForm.value.session) {
      error.value = lockInspection.value.owner ? t("consul.ui.keyHeldBy", { session: lockInspection.value.owner }) : t("consul.ui.keyUnlocked");
      return;
    }
    await api.consulReleaseLock(props.connectionId, lockForm.value.key.trim(), lockForm.value.session);
    await inspectLockKey();
    delete heldKeys.value[lockForm.value.session];
    await load();
  } catch (value) {
    error.value = message(value);
  } finally {
    saving.value = false;
  }
}

function clearFilters() {
  search.value = "";
  ttlFilter.value = "any";
  behaviorFilter.value = "any";
}

watch(
  () => props.connectionId,
  () => {
    stopAutoRenew();
    expandedSessionId.value = "";
    heldKeys.value = {};
    resetLockInspection();
    void load();
  },
);
watch(
  () => [consulStore.generation, currentScopeKey(), connectionActive.value, readOnly.value] as const,
  () => stopAutoRenew(),
);
watch([search, ttlFilter, behaviorFilter], () => {
  page.value = 1;
});
watch(() => lockForm.value.key, resetLockInspection);
onMounted(load);
onDeactivated(stopAutoRenew);
onBeforeUnmount(stopAutoRenew);
defineExpose({ refresh: () => (void load(), true) });
</script>

<template>
  <div class="h-full overflow-auto p-4">
    <header class="mb-4 flex flex-wrap items-start justify-between gap-3 border-b pb-4">
      <div>
        <h2 class="text-base font-semibold">{{ t("consul.ui.sessionsAndLocks") }}</h2>
        <p class="mt-1 max-w-3xl text-xs leading-5 text-muted-foreground">{{ t("consul.ui.sessionDescription") }}</p>
      </div>
      <div class="flex items-center gap-2">
        <Button size="icon" variant="outline" class="h-8 w-8" :disabled="loading" :title="t('consul.ui.refresh')" @click="load">
          <RefreshCcw class="h-3.5 w-3.5" :class="loading && 'animate-spin'" />
        </Button>
        <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="readOnly" @click="lockOpen = !lockOpen"> <KeyRound class="h-3.5 w-3.5" />{{ t("consul.ui.lock") }} </Button>
        <Button size="sm" class="h-8 gap-1.5" :disabled="readOnly" @click="createOpen = !createOpen"> <Plus class="h-3.5 w-3.5" />{{ t("consul.ui.create") }} </Button>
      </div>
    </header>

    <div v-if="error" class="mb-3 rounded-md border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive">{{ error }}</div>

    <section v-if="createOpen" class="mb-4 overflow-hidden rounded-lg border">
      <div class="border-b bg-muted/30 px-4 py-3 text-sm font-medium">{{ t("consul.ui.createSession") }}</div>
      <div class="grid gap-x-4 gap-y-3 p-4 md:grid-cols-2 xl:grid-cols-3">
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.name") }}</Label
          ><Input v-model="createForm.name" class="h-9" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.nodeOptional") }}</Label
          ><Input v-model="createForm.node" class="h-9" />
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.ttlOptional") }}</Label
          ><Input v-model="createForm.ttl" class="h-9" placeholder="30s" />
          <p class="text-[11px] text-muted-foreground">{{ t("consul.ui.ttlRangeHint") }}</p>
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.lockDelay") }}</Label
          ><Input v-model="createForm.lockDelay" class="h-9" placeholder="15s" />
          <p class="text-[11px] text-muted-foreground">{{ t("consul.ui.lockDelayHint") }}</p>
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.behavior") }}</Label
          ><select v-model="createForm.behavior" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
            <option value="release">{{ t("consul.ui.releaseLocks") }}</option>
            <option value="delete">{{ t("consul.ui.deleteKeys") }}</option>
          </select>
          <p class="text-[11px] text-muted-foreground">{{ t("consul.ui.behaviorHint") }}</p>
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.nodeChecks") }}</Label
          ><Input v-model="createForm.nodeChecks" class="h-9" placeholder="serfHealth" />
        </div>
        <div class="space-y-1.5 md:col-span-2 xl:col-span-3">
          <Label class="text-xs">{{ t("consul.ui.serviceChecks") }}</Label
          ><Input v-model="createForm.serviceChecks" class="h-9" :placeholder="t('consul.ui.serviceChecksPlaceholder')" />
          <p class="text-[11px] text-muted-foreground">{{ t("consul.ui.serviceChecksHint") }}</p>
        </div>
      </div>
      <div class="flex justify-end gap-2 border-t bg-muted/20 px-4 py-3">
        <Button size="sm" variant="outline" @click="createOpen = false">{{ t("consul.ui.cancel") }}</Button
        ><Button size="sm" :disabled="saving" @click="createSession"><Loader2 v-if="saving" class="mr-1 h-3.5 w-3.5 animate-spin" />{{ t("consul.ui.create") }}</Button>
      </div>
    </section>

    <section v-if="lockOpen" class="mb-4 overflow-hidden rounded-lg border">
      <div class="flex items-center justify-between border-b bg-muted/30 px-4 py-3">
        <span class="text-sm font-medium">{{ t("consul.ui.lockManagement") }}</span
        ><span class="text-xs text-muted-foreground">{{ t("consul.ui.lockHint") }}</span>
      </div>
      <div class="grid gap-x-4 gap-y-3 p-4 md:grid-cols-2">
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.key") }}</Label>
          <div class="flex gap-2">
            <Input v-model="lockForm.key" class="h-9" @keydown.enter="inspectLockKey" /><Button size="sm" variant="outline" class="h-9 shrink-0" :disabled="lockInspecting || !lockForm.key.trim()" @click="inspectLockKey"
              ><Loader2 v-if="lockInspecting" class="mr-1 h-3.5 w-3.5 animate-spin" />{{ t("consul.ui.inspectKey") }}</Button
            >
          </div>
        </div>
        <div class="space-y-1.5">
          <Label class="text-xs">{{ t("consul.ui.selectSession") }}</Label
          ><select v-model="lockForm.session" class="h-9 w-full rounded-md border bg-background px-2 text-sm">
            <option value="" disabled>{{ t("consul.ui.selectSession") }}</option>
            <option v-for="session in sessions" :key="session.ID" :value="session.ID">{{ session.Name || t("consul.ui.unnamedSession") }} · {{ session.ID }}</option>
          </select>
        </div>
        <div class="space-y-1.5 md:col-span-2">
          <Label class="text-xs">{{ t("consul.ui.value") }}</Label
          ><textarea v-model="lockForm.value" class="min-h-20 w-full resize-y rounded-md border bg-background px-3 py-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div v-if="lockInspection.inspected" class="md:col-span-2 flex flex-wrap items-center gap-2 rounded-md border bg-muted/20 px-3 py-2 text-xs">
          <Badge variant="secondary">{{ lockInspection.found ? t("consul.ui.keyExists") : t("consul.ui.keyNotFound") }}</Badge>
          <span>{{ t("consul.ui.modifyIndexValue", { index: lockInspection.modifyIndex }) }}</span>
          <span v-if="lockInspection.owner" class="text-amber-700 dark:text-amber-300">{{ t("consul.ui.keyHeldBy", { session: lockInspection.owner }) }}</span>
          <span v-else-if="lockInspection.found" class="text-muted-foreground">{{ t("consul.ui.keyUnlocked") }}</span>
        </div>
      </div>
      <div class="flex justify-end gap-2 border-t bg-muted/20 px-4 py-3">
        <Button size="sm" variant="outline" @click="lockOpen = false">{{ t("consul.ui.close") }}</Button
        ><Button size="sm" variant="outline" :disabled="saving || !lockForm.key.trim() || !lockForm.session" @click="release">{{ t("consul.ui.releaseMatchingSession") }}</Button
        ><Button size="sm" :disabled="saving || !lockForm.key.trim() || !lockForm.session" @click="acquire">{{ t("consul.ui.acquire") }}</Button>
      </div>
    </section>

    <section class="mb-4 rounded-lg border bg-muted/10 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative min-w-64 flex-1"><Search class="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input v-model="search" class="h-9 pl-8" :placeholder="t('consul.ui.searchSessions')" /></div>
        <select v-model="ttlFilter" class="h-9 rounded-md border bg-background px-2 text-xs">
          <option value="any">{{ t("consul.ui.allSessionTypes") }}</option>
          <option value="ttl">{{ t("consul.ui.ttlSessions") }}</option>
          <option value="persistent">{{ t("consul.ui.persistentSessions") }}</option>
        </select>
        <select v-model="behaviorFilter" class="h-9 rounded-md border bg-background px-2 text-xs">
          <option value="any">{{ t("consul.ui.allBehaviors") }}</option>
          <option value="release">{{ t("consul.ui.behaviorRelease") }}</option>
          <option value="delete">{{ t("consul.ui.behaviorDelete") }}</option>
        </select>
        <Button v-if="hasFilters" size="sm" variant="ghost" class="h-9" @click="clearFilters">{{ t("consul.ui.clearFilters") }}</Button>
      </div>
      <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{{ t("consul.ui.sessionResultCount", { filtered: filteredSessions.length, total: sessions.length }) }}</span>
        <span v-if="responseMetadata?.filteredByAcls" class="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300"><AlertTriangle class="h-3.5 w-3.5" />{{ t("consul.ui.aclFilteredSessions") }}</span>
      </div>
    </section>

    <section class="overflow-hidden rounded-lg border">
      <div class="flex items-center justify-between border-b bg-muted/30 px-3 py-2.5">
        <div class="flex items-center gap-2 text-sm font-medium">
          <span>{{ t("consul.ui.sessions") }}</span
          ><Badge variant="secondary">{{ filteredSessions.length }}</Badge>
        </div>
        <ConsulListPagination
          :total="filteredSessions.length"
          :page="page"
          :page-size="CONSUL_LIST_PAGE_SIZE"
          @update:page="
            page = $event;
            expandedSessionId = '';
          "
        />
      </div>

      <div v-for="session in pagedSessions" :key="session.ID" class="border-b last:border-0">
        <div class="grid cursor-pointer items-center gap-3 px-3 py-3 text-xs transition-colors hover:bg-muted/20 md:grid-cols-[minmax(0,1.4fr)_minmax(7rem,.7fr)_minmax(9rem,.8fr)_auto]" @click="toggleDetails(session.ID)">
          <div class="flex min-w-0 items-center gap-2.5">
            <Button size="icon" variant="ghost" class="h-7 w-7 shrink-0" tabindex="-1"><ChevronUp v-if="expandedSessionId === session.ID" class="h-3.5 w-3.5" /><ChevronDown v-else class="h-3.5 w-3.5" /></Button>
            <div class="min-w-0">
              <div class="truncate text-sm font-medium">{{ session.Name || t("consul.ui.unnamedSession") }}</div>
              <div class="truncate font-mono text-[11px] text-muted-foreground">{{ session.ID }}</div>
            </div>
          </div>
          <div class="min-w-0">
            <div class="truncate font-medium">{{ session.Node || "—" }}</div>
            <div class="truncate text-muted-foreground">{{ session.Namespace || t("consul.ui.default") }} / {{ session.Partition || t("consul.ui.default") }}</div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            <Badge :variant="isTtlSession(session) ? 'default' : 'secondary'"><Clock3 class="mr-1 h-3 w-3" />{{ isTtlSession(session) ? session.TTL : t("consul.ui.noTtl") }}</Badge
            ><Badge variant="outline">{{ behaviorLabel(session.Behavior) }}</Badge>
          </div>
          <div class="flex items-center justify-end gap-1" @click.stop>
            <Button size="sm" variant="ghost" class="h-7 gap-1" :disabled="heldKeysLoading === session.ID" @click="toggleHeldKeys(session.ID)"
              ><Loader2 v-if="heldKeysLoading === session.ID" class="h-3.5 w-3.5 animate-spin" /><KeyRound v-else class="h-3.5 w-3.5" />{{ t("consul.ui.heldKeys") }}</Button
            >
            <Button v-if="isTtlSession(session)" size="icon" variant="ghost" class="h-7 w-7" :disabled="readOnly || !connectionActive" :title="t('consul.ui.renewNow')" @click="renew(session.ID)"><RefreshCcw class="h-3.5 w-3.5" /></Button>
            <Button v-if="isTtlSession(session)" size="sm" variant="ghost" class="h-7 gap-1" :disabled="readOnly || !connectionActive" :title="t('consul.ui.autoRenewPageHint')" @click="autoRenewId === session.ID ? stopAutoRenew() : startAutoRenew(session.ID)"
              ><RotateCw class="h-3.5 w-3.5" :class="autoRenewId === session.ID && 'animate-spin'" />{{ autoRenewId === session.ID ? t("consul.ui.stop") : t("consul.ui.autoRenew") }}</Button
            >
            <span v-else class="px-2 text-[11px] text-muted-foreground">{{ t("consul.ui.noRenewRequired") }}</span>
            <Button size="icon" variant="ghost" class="h-7 w-7 text-destructive" :disabled="readOnly" :title="t('consul.ui.destroy')" @click="destroy(session.ID)"><Trash2 class="h-3.5 w-3.5" /></Button>
          </div>
        </div>

        <div v-if="expandedSessionId === session.ID" class="border-t bg-muted/10 p-3">
          <dl class="grid overflow-hidden rounded-md border bg-background sm:grid-cols-2 lg:grid-cols-4">
            <div class="border-b p-3 lg:border-r">
              <dt class="text-[11px] text-muted-foreground">{{ t("consul.ui.node") }}</dt>
              <dd class="mt-1 text-xs font-medium">{{ session.Node || "—" }}</dd>
            </div>
            <div class="border-b p-3 lg:border-r">
              <dt class="text-[11px] text-muted-foreground">{{ t("consul.ui.lockDelay") }}</dt>
              <dd class="mt-1 font-mono text-xs">{{ formatLockDelay(session.LockDelay) }}</dd>
            </div>
            <div class="border-b p-3 lg:border-r">
              <dt class="text-[11px] text-muted-foreground">TTL</dt>
              <dd class="mt-1 font-mono text-xs">{{ session.TTL || t("consul.ui.noTtl") }}</dd>
            </div>
            <div class="border-b p-3">
              <dt class="text-[11px] text-muted-foreground">{{ t("consul.ui.behavior") }}</dt>
              <dd class="mt-1 text-xs font-medium">{{ behaviorLabel(session.Behavior) }}</dd>
            </div>
            <div class="border-b p-3 lg:border-r">
              <dt class="text-[11px] text-muted-foreground">{{ t("consul.ui.createIndex") }}</dt>
              <dd class="mt-1 font-mono text-xs">{{ session.CreateIndex }}</dd>
            </div>
            <div class="border-b p-3 lg:border-r">
              <dt class="text-[11px] text-muted-foreground">{{ t("consul.ui.modifyIndexLabel") }}</dt>
              <dd class="mt-1 font-mono text-xs">{{ session.ModifyIndex }}</dd>
            </div>
            <div class="border-b p-3 lg:col-span-2">
              <dt class="text-[11px] text-muted-foreground">{{ t("consul.ui.checks") }}</dt>
              <dd class="mt-1 flex flex-wrap gap-1">
                <Badge v-for="check in sessionChecks(session)" :key="check" variant="outline">{{ check }}</Badge
                ><span v-if="!sessionChecks(session).length" class="text-xs text-muted-foreground">—</span>
              </dd>
            </div>
          </dl>

          <div v-if="heldKeys[session.ID] || heldKeysLoading === session.ID" class="mt-3 overflow-hidden rounded-md border bg-background">
            <div class="flex items-center justify-between border-b bg-muted/20 px-3 py-2">
              <div class="flex items-center gap-2 text-xs font-medium">
                <KeyRound class="h-3.5 w-3.5" />{{ t("consul.ui.heldKeys") }}<Badge v-if="heldKeys[session.ID]" variant="secondary">{{ heldKeys[session.ID].items.length }}</Badge>
              </div>
              <span v-if="heldKeys[session.ID] && !heldKeys[session.ID].complete" class="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-300"><AlertTriangle class="h-3.5 w-3.5" />{{ t("consul.ui.heldKeysIncomplete") }}</span
              ><span v-else-if="heldKeys[session.ID]?.complete" class="inline-flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300"><ShieldCheck class="h-3.5 w-3.5" />{{ t("consul.ui.complete") }}</span>
            </div>
            <div v-if="heldKeysLoading === session.ID" class="flex items-center justify-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("consul.ui.loading") }}</div>
            <template v-else
              ><div v-for="item in heldKeys[session.ID]?.items || []" :key="item.key" class="flex items-center justify-between gap-3 border-b px-3 py-2 font-mono text-xs last:border-0">
                <span class="min-w-0 break-all">{{ item.key }}</span
                ><span class="shrink-0 text-muted-foreground">{{ t("consul.ui.lockIndex", { index: item.lockIndex }) }}</span>
              </div>
              <div v-if="!heldKeys[session.ID]?.items.length" class="p-3 text-xs text-muted-foreground">{{ t("consul.ui.noHeldKeys") }}</div></template
            >
          </div>
        </div>
      </div>

      <div v-if="!pagedSessions.length && !loading" class="p-8 text-center text-xs text-muted-foreground">{{ hasFilters ? t("consul.ui.noMatchingSessions") : t("consul.ui.noVisibleSessions") }}</div>
      <div v-if="loading && !sessions.length" class="flex items-center justify-center gap-2 p-8 text-xs text-muted-foreground"><Loader2 class="h-4 w-4 animate-spin" />{{ t("consul.ui.loading") }}</div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity, HardDrive, History, KeyRound, Loader2, Pencil, Play, Plus, Search, Server, Square, Trash2, Wrench } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import * as api from "@/lib/backend/api";
import { releaseEtcdWatch, releaseEtcdWatchBestEffort, releaseEtcdWatchesBestEffort, replaceEtcdWatch } from "@/lib/etcd/watchLifecycle";

type EtcdAdminSection = "maintenance" | "watch" | "lease";
type WatchEventCategory = "create" | "update" | "delete";

interface WatchEventDisplay {
  revision: string;
  eventType: "put" | "delete";
  category: WatchEventCategory;
  key: string;
  value?: api.KvValue | null;
  previousValue?: api.KvValue | null;
}

interface WatchMonitor {
  id: string;
  key: string;
  keyBytes: api.KvValue | null;
  scope: "key" | "prefix";
  startedRevision: string | null;
  status: "running" | "stopped" | "error";
  events: WatchEventDisplay[];
  error?: string;
}

const props = withDefaults(
  defineProps<{
    connectionId: string;
    status?: api.KvStatusResponse | null;
    sections?: EtcdAdminSection[];
    initialSection?: EtcdAdminSection;
    watchPreset?: { key: string; keyBytes?: api.KvValue | null; scope: "key" | "prefix" } | null;
    watchKeySuggestions?: Array<{ key: string; keyBytes: api.KvValue }>;
  }>(),
  {
    status: null,
    sections: () => ["maintenance", "watch", "lease"],
    initialSection: "maintenance",
    watchPreset: null,
    watchKeySuggestions: () => [],
  },
);
const emit = defineEmits<{
  refresh: [];
  watchCreated: [];
  watchDialogDismissed: [];
}>();
const { t } = useI18n();
const active = ref<EtcdAdminSection>(props.initialSection);
const busy = ref(false);
const error = ref("");
const notice = ref("");
const revision = ref(String(props.status?.revision || ""));
const watchDialogOpen = ref(false);
const watchEditingId = ref<string | null>(null);
const watchFormKey = ref("");
const watchFormKeyBytes = ref<api.KvValue | null>(null);
const watchFormScope = ref<"key" | "prefix">("prefix");
const watchSuggestionOpen = ref(false);
const watchSuggestionIndex = ref(-1);
const watchMonitors = ref<WatchMonitor[]>([]);
const selectedWatchId = ref<string | null>(null);
const watchSearch = ref("");
const watchPolling = ref(false);
const watchEventFilters = ref<Record<WatchEventCategory, boolean>>({ create: true, update: true, delete: true });
const watchEventFilterOptions: Array<{ value: WatchEventCategory; label: string }> = [
  { value: "create", label: t("etcd.admin.create") },
  { value: "update", label: t("etcd.admin.update") },
  { value: "delete", label: t("etcd.admin.delete") },
];
const leaseGrantDialogOpen = ref(false);
const leaseGrantTtl = ref("60");
const leaseGrantId = ref("");
const leaseGrantBusy = ref(false);
const leases = ref<api.EtcdLeaseListResponse | null>(null);
const leaseContinuation = ref<string | null>(null);
const leasePreviousContinuations = ref<Array<string | null>>([]);
const selectedLease = ref<api.EtcdLeaseDetail | null>(null);
const leaseDetailLoading = ref(false);
const autoKeepalive = ref(false);
const leaseTtlSnapshots = ref<Record<string, { ttl: number; observedAt: number }>>({});
const leaseClock = ref(Date.now());
const maintenanceApprovalOpen = ref(false);
const maintenanceApprovalLoading = ref(false);
const maintenanceApprovalTitle = ref("");
const maintenanceApprovalDetails = ref("");
const maintenanceApprovalExpected = ref("");
const maintenanceApprovalText = ref("");
let watchPoller: ReturnType<typeof setInterval> | null = null;
let leaseKeepaliveTimer: ReturnType<typeof setTimeout> | null = null;
let leaseCountdownTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
  leaseClock.value = Date.now();
}, 1000);
let pendingMaintenanceApproval: (() => Promise<void>) | null = null;
let leaseGrantRequest = 0;

watch(
  () => props.initialSection,
  (section) => {
    active.value = section;
  },
);

watch(
  () => props.watchPreset,
  (preset) => {
    if (!preset) return;
    openWatchDialog(preset);
  },
  { immediate: true },
);

watch(active, (section, previousSection) => {
  if (previousSection === "lease" && section !== "lease") stopLeaseKeepalive();
});

watch(autoKeepalive, (enabled) => {
  if (enabled) scheduleLeaseKeepalive();
  else stopLeaseKeepalive();
});

const endpoints = computed(() => {
  const members = props.status?.members.filter((member) => member.reachable) ?? [];
  const leader = props.status?.leaderId;
  return [...members.filter((member) => member.memberId !== leader), ...members.filter((member) => member.memberId === leader)].map((member) => member.endpoint);
});
const currentRevision = computed(() => (props.status?.revision == null ? null : String(props.status.revision)));
const reachableMemberCount = computed(() => props.status?.members.filter((member) => member.reachable).length ?? 0);
const memberCount = computed(() => props.status?.members.length ?? 0);
const leaderEndpoint = computed(() => {
  const leaderId = props.status?.leaderId;
  return props.status?.members.find((member) => member.memberId != null && member.memberId === leaderId)?.endpoint ?? null;
});
const filteredWatchMonitors = computed(() => {
  const query = watchSearch.value.trim().toLocaleLowerCase();
  return query ? watchMonitors.value.filter((monitor) => monitor.key.toLocaleLowerCase().includes(query)) : watchMonitors.value;
});
const selectedWatchMonitor = computed(() => watchMonitors.value.find((monitor) => monitor.id === selectedWatchId.value) ?? null);
const visibleWatchEvents = computed(() => (selectedWatchMonitor.value?.events ?? []).filter((event) => watchEventFilters.value[event.category]));
const runningWatchCount = computed(() => watchMonitors.value.filter((monitor) => monitor.status === "running").length);
const filteredWatchKeySuggestions = computed(() => {
  const query = watchFormKey.value.trim();
  if (!query) return [];
  const seen = new Set<string>();
  const matches: Array<{ key: string; keyBytes: api.KvValue }> = [];
  for (const suggestion of props.watchKeySuggestions) {
    const identity = `${suggestion.keyBytes.encoding}:${suggestion.keyBytes.data}`;
    if (suggestion.key === query || !suggestion.key.startsWith(query) || seen.has(identity)) continue;
    seen.add(identity);
    matches.push(suggestion);
    if (matches.length === 8) break;
  }
  return matches;
});
const showWatchKeySuggestions = computed(() => watchSuggestionOpen.value && filteredWatchKeySuggestions.value.length > 0);

function reset(message = "") {
  error.value = "";
  notice.value = message;
}
async function dangerousApproval(action: string, params: Record<string, unknown>) {
  const preflight = await api.etcdPreflight(props.connectionId, action, params);
  const entered = window.prompt(t("etcd.admin.confirmationPrompt", { confirmationText: preflight.confirmationText }), "");
  if (entered !== preflight.confirmationText) return null;
  return { preflightToken: preflight.token, confirmationText: entered };
}
async function run(action: () => Promise<void>) {
  busy.value = true;
  reset();
  try {
    await action();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    busy.value = false;
  }
}
async function requestMaintenanceApproval(action: "compact" | "defrag", params: Record<string, unknown>, title: string, details: string, execute: (approval: api.EtcdDangerousApproval) => Promise<void>) {
  maintenanceApprovalLoading.value = true;
  reset();
  try {
    const preflight = await api.etcdPreflight(props.connectionId, action, params);
    maintenanceApprovalTitle.value = title;
    maintenanceApprovalDetails.value = details;
    maintenanceApprovalExpected.value = preflight.confirmationText;
    maintenanceApprovalText.value = "";
    pendingMaintenanceApproval = () => execute({ preflightToken: preflight.token, confirmationText: preflight.confirmationText });
    maintenanceApprovalOpen.value = true;
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    maintenanceApprovalLoading.value = false;
  }
}
function closeMaintenanceApproval() {
  if (maintenanceApprovalLoading.value) return;
  maintenanceApprovalOpen.value = false;
  maintenanceApprovalText.value = "";
  pendingMaintenanceApproval = null;
}
async function confirmMaintenanceApproval() {
  if (maintenanceApprovalText.value !== maintenanceApprovalExpected.value || !pendingMaintenanceApproval) return;
  const execute = pendingMaintenanceApproval;
  pendingMaintenanceApproval = null;
  maintenanceApprovalOpen.value = false;
  maintenanceApprovalText.value = "";
  await run(execute);
}
function compact() {
  if (!/^\d+$/.test(revision.value)) {
    error.value = t("etcd.admin.compactRequired");
    return;
  }
  const targetRevision = revision.value;
  void requestMaintenanceApproval("compact", { revision: targetRevision }, t("etcd.admin.compactTitle"), t("etcd.admin.compactDescription"), async (approval) => {
    await api.etcdCompact(props.connectionId, targetRevision, approval);
    emit("refresh");
    reset(t("etcd.admin.compactDone"));
  });
}
function defrag() {
  if (!endpoints.value.length) {
    error.value = t("etcd.admin.noReachableMembers");
    return;
  }
  const targetEndpoints = [...endpoints.value];
  void requestMaintenanceApproval("defrag", { endpoints: targetEndpoints }, t("etcd.admin.defragTitle"), t("etcd.admin.defragDescription"), async (approval) => {
    const result = await api.etcdDefrag(props.connectionId, targetEndpoints, approval);
    emit("refresh");
    const succeeded = result.members.filter((item) => item.status === "succeeded").length;
    const failed = result.members.filter((item) => item.status === "failed").length;
    const notExecuted = result.members.filter((item) => item.status === "not_executed").length;
    reset(failed ? t("etcd.admin.defragStopped", { succeeded, failed, notExecuted }) : t("etcd.admin.defragCompleted", { succeeded, total: result.members.length }));
  });
}
function openWatchDialog(preset?: { key: string; keyBytes?: api.KvValue | null; scope: "key" | "prefix" }) {
  watchEditingId.value = null;
  watchFormKey.value = preset?.key ?? "";
  watchFormKeyBytes.value = preset?.keyBytes ?? null;
  watchFormScope.value = preset?.scope ?? "prefix";
  closeWatchKeySuggestions();
  watchDialogOpen.value = true;
}
function closeWatchDialog() {
  watchDialogOpen.value = false;
  closeWatchKeySuggestions();
  emit("watchDialogDismissed");
}
function updateWatchDialog(open: boolean) {
  if (open) {
    watchDialogOpen.value = true;
    return;
  }
  closeWatchDialog();
}
function editWatchMonitor(monitor: WatchMonitor) {
  watchEditingId.value = monitor.id;
  watchFormKey.value = monitor.key;
  watchFormKeyBytes.value = monitor.keyBytes;
  watchFormScope.value = monitor.scope;
  closeWatchKeySuggestions();
  watchDialogOpen.value = true;
}
function closeWatchKeySuggestions() {
  watchSuggestionOpen.value = false;
  watchSuggestionIndex.value = -1;
}
function onWatchKeyInput(value: string | number) {
  const key = String(value);
  watchFormKeyBytes.value = null;
  watchSuggestionOpen.value = Boolean(key.trim());
  watchSuggestionIndex.value = -1;
}
function acceptWatchKeySuggestion(index: number) {
  const suggestion = filteredWatchKeySuggestions.value[index];
  if (!suggestion) return;
  watchFormKey.value = suggestion.key;
  watchFormKeyBytes.value = suggestion.keyBytes;
  closeWatchKeySuggestions();
}
function moveWatchKeySuggestion(delta: number) {
  if (!filteredWatchKeySuggestions.value.length) return;
  watchSuggestionOpen.value = true;
  watchSuggestionIndex.value = (watchSuggestionIndex.value + delta + filteredWatchKeySuggestions.value.length) % filteredWatchKeySuggestions.value.length;
}
function onWatchKeyKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Escape") {
    closeWatchKeySuggestions();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!filteredWatchKeySuggestions.value.length) return;
    event.preventDefault();
    moveWatchKeySuggestion(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  if (event.key === "Enter" && showWatchKeySuggestions.value && watchSuggestionIndex.value >= 0) {
    event.preventDefault();
    acceptWatchKeySuggestion(watchSuggestionIndex.value);
  }
}
function watchEventCategory(event: { eventType: "put" | "delete"; previousValue?: api.KvValue | null }): WatchEventCategory {
  if (event.eventType === "delete") return "delete";
  return event.previousValue ? "update" : "create";
}
function watchEventCategoryLabel(category: WatchEventCategory): string {
  return category === "create" ? t("etcd.admin.create") : category === "update" ? t("etcd.admin.update") : t("etcd.admin.delete");
}
function startWatchPoller() {
  if (watchPoller || runningWatchCount.value === 0) return;
  watchPoller = setInterval(() => void pollWatchMonitors(), 500);
}
function stopWatchPollerIfIdle() {
  if (!watchPoller || runningWatchCount.value > 0) return;
  clearInterval(watchPoller);
  watchPoller = null;
}
async function startWatchMonitor(monitor: WatchMonitor) {
  const result = await api.etcdWatchStart(props.connectionId, {
    key: monitor.key,
    keyBytes: monitor.keyBytes,
    scope: monitor.scope,
    includePrevKv: true,
  });
  monitor.id = result.watchId;
  monitor.startedRevision = String(result.startedRevision);
  monitor.status = "running";
  monitor.error = undefined;
  monitor.events = [];
  selectedWatchId.value = monitor.id;
  startWatchPoller();
}
async function saveWatchMonitor() {
  if (!watchFormKey.value) return;
  const editing = watchEditingId.value ? (watchMonitors.value.find((monitor) => monitor.id === watchEditingId.value) ?? null) : null;
  await run(async () => {
    if (editing) {
      const shouldRestart = editing.status === "running";
      if (editing.id) await stopWatchMonitor(editing, false);
      editing.key = watchFormKey.value;
      editing.keyBytes = watchFormKeyBytes.value;
      editing.scope = watchFormScope.value;
      editing.events = [];
      editing.error = undefined;
      if (!shouldRestart) editing.status = "stopped";
      if (shouldRestart) await startWatchMonitor(editing);
      selectedWatchId.value = editing.id;
      watchDialogOpen.value = false;
      reset(shouldRestart ? t("etcd.admin.saveWatch") : t("etcd.admin.saveWatch"));
      return;
    }
    if (runningWatchCount.value >= 4) throw new Error(t("etcd.admin.watchSessionHint"));
    const monitor: WatchMonitor = {
      id: "",
      key: watchFormKey.value,
      keyBytes: watchFormKeyBytes.value,
      scope: watchFormScope.value,
      startedRevision: null,
      status: "stopped",
      events: [],
    };
    await startWatchMonitor(monitor);
    watchMonitors.value.unshift(monitor);
    startWatchPoller();
    watchDialogOpen.value = false;
    reset(t("etcd.admin.running"));
    emit("watchCreated");
  });
}
async function pollWatchMonitors() {
  if (watchPolling.value) return;
  const running = watchMonitors.value.filter((monitor) => monitor.status === "running");
  if (!running.length) {
    stopWatchPollerIfIdle();
    return;
  }
  watchPolling.value = true;
  try {
    for (const monitor of running) {
      try {
        const response = await api.etcdWatchPoll(props.connectionId, monitor.id);
        for (const batch of response.batches) {
          for (const event of batch.events) {
            monitor.events.unshift({
              revision: String(event.revision),
              eventType: event.eventType,
              category: watchEventCategory(event),
              key: event.key,
              value: event.value,
              previousValue: event.previousValue,
            });
          }
        }
        monitor.events.splice(500);
        if (response.terminal) {
          // A terminal poll removes the watch from the Agent. This extra stop is
          // only a best-effort compatibility cleanup for older Agents.
          await releaseEtcdWatchBestEffort(props.connectionId, monitor.id, api.etcdWatchStop);
          monitor.status = "error";
          monitor.error = response.terminal.message || `Watch ${response.terminal.reason}`;
        }
      } catch (caught) {
        let message = caught instanceof Error ? caught.message : String(caught);
        try {
          await releaseEtcdWatch(props.connectionId, monitor.id, api.etcdWatchStop);
        } catch (stopError) {
          const stopMessage = stopError instanceof Error ? stopError.message : String(stopError);
          message = `${message}; failed to stop watch: ${stopMessage}`;
        }
        monitor.status = "error";
        monitor.error = message;
      }
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    watchPolling.value = false;
    stopWatchPollerIfIdle();
  }
}
async function stopWatchMonitor(monitor: WatchMonitor, notify = true) {
  await releaseEtcdWatch(props.connectionId, monitor.id, api.etcdWatchStop);
  monitor.status = "stopped";
  monitor.error = undefined;
  stopWatchPollerIfIdle();
  if (notify) reset(t("etcd.admin.stopped"));
}
function requestStopWatchMonitor(monitor: WatchMonitor) {
  void run(() => stopWatchMonitor(monitor));
}
async function resumeWatchMonitor(monitor: WatchMonitor) {
  if (runningWatchCount.value >= 4) {
    error.value = t("etcd.admin.watchSessionHint");
    return;
  }
  await run(async () => {
    await replaceEtcdWatch(props.connectionId, monitor.id, api.etcdWatchStop, () => startWatchMonitor(monitor));
    reset(t("etcd.admin.running"));
  });
}
async function deleteWatchMonitor(monitor: WatchMonitor) {
  await run(async () => {
    await stopWatchMonitor(monitor, false);
    const index = watchMonitors.value.indexOf(monitor);
    if (index >= 0) watchMonitors.value.splice(index, 1);
    if (selectedWatchId.value === monitor.id) selectedWatchId.value = watchMonitors.value[0]?.id ?? null;
    reset(t("etcd.admin.deleteWatch"));
  });
}
async function stopAllWatchMonitors() {
  if (watchPoller) {
    clearInterval(watchPoller);
    watchPoller = null;
  }
  await releaseEtcdWatchesBestEffort(
    props.connectionId,
    watchMonitors.value.map((monitor) => monitor.id),
    api.etcdWatchStop,
  );
}
function rememberLeaseTtl(id: string, ttl: number) {
  leaseTtlSnapshots.value = { ...leaseTtlSnapshots.value, [id]: { ttl, observedAt: Date.now() } };
}
function displayedLeaseTtl(id: string, fallbackTtl: number): number {
  const snapshot = leaseTtlSnapshots.value[id];
  if (!snapshot) return fallbackTtl;
  const elapsedSeconds = Math.floor((leaseClock.value - snapshot.observedAt) / 1000);
  return Math.max(0, snapshot.ttl - elapsedSeconds);
}
function applyLeases(response: api.EtcdLeaseListResponse) {
  leases.value = response;
  for (const lease of response.leases) rememberLeaseTtl(String(lease.id), lease.ttl);
}
async function fetchLeases(continuation = leaseContinuation.value) {
  applyLeases(await api.etcdLeaseList(props.connectionId, 100, continuation));
}
async function loadLeases() {
  await run(fetchLeases);
}
async function nextLeasePage() {
  const next = leases.value?.nextContinuation;
  if (!next) return;
  const previous = leaseContinuation.value;
  await run(async () => {
    const response = await api.etcdLeaseList(props.connectionId, 100, next);
    leasePreviousContinuations.value.push(previous);
    leaseContinuation.value = next;
    applyLeases(response);
  });
}
async function previousLeasePage() {
  if (!leasePreviousContinuations.value.length) return;
  const previous = leasePreviousContinuations.value[leasePreviousContinuations.value.length - 1] ?? null;
  await run(async () => {
    const response = await api.etcdLeaseList(props.connectionId, 100, previous);
    leasePreviousContinuations.value.pop();
    leaseContinuation.value = previous;
    applyLeases(response);
  });
}
async function openLease(id: string) {
  leaseDetailLoading.value = true;
  selectedLease.value = null;
  try {
    selectedLease.value = await api.etcdLeaseCall<api.EtcdLeaseDetail>(props.connectionId, "get", { id, includeKeys: true });
    rememberLeaseTtl(selectedLease.value.id, selectedLease.value.ttl);
    if (autoKeepalive.value) scheduleLeaseKeepalive();
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    leaseDetailLoading.value = false;
  }
}
function stopLeaseKeepalive() {
  if (leaseKeepaliveTimer) {
    clearTimeout(leaseKeepaliveTimer);
    leaseKeepaliveTimer = null;
  }
}
function scheduleLeaseKeepalive() {
  stopLeaseKeepalive();
  if (!autoKeepalive.value || !selectedLease.value || selectedLease.value.ttl <= 0) return;
  leaseKeepaliveTimer = setTimeout(() => void renewLease(selectedLease.value!.id), Math.max(1000, Math.floor((selectedLease.value.ttl * 1000) / 3)));
}
async function renewLease(id: string) {
  await run(async () => {
    const result = await api.etcdLeaseCall<{ id: string; ttl: number }>(props.connectionId, "keepalive", { id });
    if (selectedLease.value?.id === id) {
      selectedLease.value = { ...selectedLease.value, ttl: result.ttl };
      rememberLeaseTtl(id, result.ttl);
      scheduleLeaseKeepalive();
    }
    await loadLeases();
    reset(t("etcd.admin.leaseRenewed", { id }));
  });
}
function openLeaseGrantDialog() {
  leaseGrantTtl.value = "60";
  leaseGrantId.value = "";
  leaseGrantDialogOpen.value = true;
}
function closeLeaseGrantDialog() {
  // The RPC cannot be aborted through Tauri today. Ignore its late response so
  // closing the dialog immediately restores control to the user.
  const wasPending = leaseGrantBusy.value;
  leaseGrantRequest++;
  leaseGrantBusy.value = false;
  leaseGrantDialogOpen.value = false;
  if (wasPending) reset(t("etcd.admin.leaseGrantCancelled"));
}
function updateLeaseGrantDialog(open: boolean) {
  if (open) {
    leaseGrantDialogOpen.value = true;
  } else {
    closeLeaseGrantDialog();
  }
}
async function grantLease() {
  const ttl = leaseGrantTtl.value.trim();
  const id = leaseGrantId.value.trim();
  if (!/^\d+$/.test(ttl) || Number(ttl) <= 0) {
    error.value = t("etcd.admin.ttlHint");
    return;
  }
  if (id && !/^\d+$/.test(id)) {
    error.value = t("etcd.admin.customLeaseHint");
    return;
  }
  const request = ++leaseGrantRequest;
  leaseGrantBusy.value = true;
  reset();
  try {
    const result = await api.etcdLeaseCall<{ id: string; ttl?: number }>(props.connectionId, "grant", { ttl, id: id || undefined });
    if (request !== leaseGrantRequest) return;
    // The grant has succeeded. Close first so list/detail follow-up failures
    // do not leave a modal that appears to be frozen.
    leaseGrantDialogOpen.value = false;
    await fetchLeases();
    if (request !== leaseGrantRequest) return;
    await openLease(result.id);
    if (request !== leaseGrantRequest) return;
    reset(t("etcd.admin.leaseCreated", { id: result.id }));
  } catch (caught) {
    if (request === leaseGrantRequest) error.value = caught instanceof Error ? caught.message : String(caught);
  } finally {
    if (request === leaseGrantRequest) leaseGrantBusy.value = false;
  }
}
async function revokeLease(id: string) {
  await run(async () => {
    const params = { id };
    const approval = await dangerousApproval("lease_revoke", params);
    if (!approval) return;
    await api.etcdLeaseCall(props.connectionId, "revoke", params, approval);
    if (selectedLease.value?.id === id) {
      selectedLease.value = null;
      autoKeepalive.value = false;
      stopLeaseKeepalive();
    }
    await loadLeases();
  });
}
onBeforeUnmount(() => {
  void stopAllWatchMonitors();
  stopLeaseKeepalive();
  if (leaseCountdownTimer) clearInterval(leaseCountdownTimer);
  leaseCountdownTimer = null;
});
</script>

<template>
  <section class="overflow-hidden rounded-lg border">
    <div v-if="sections.length > 1" class="flex flex-wrap items-center gap-1 border-b p-2">
      <Button v-if="sections.includes('maintenance')" size="sm" :variant="active === 'maintenance' ? 'secondary' : 'ghost'" @click="active = 'maintenance'"><Wrench class="mr-1 h-3.5 w-3.5" />{{ t("etcd.admin.maintenance") }}</Button>
      <Button v-if="sections.includes('watch')" size="sm" :variant="active === 'watch' ? 'secondary' : 'ghost'" @click="active = 'watch'"><Activity class="mr-1 h-3.5 w-3.5" />{{ t("etcd.admin.watch") }}</Button>
      <Button
        v-if="sections.includes('lease')"
        size="sm"
        :variant="active === 'lease' ? 'secondary' : 'ghost'"
        @click="
          active = 'lease';
          void loadLeases();
        "
        ><KeyRound class="mr-1 h-3.5 w-3.5" />{{ t("etcd.admin.lease") }}</Button
      >
    </div>
    <div :class="active === 'maintenance' ? 'text-sm' : 'space-y-3 p-4 text-sm'">
      <div v-if="error" :class="active === 'maintenance' ? 'border-b border-destructive/30 bg-destructive/5 px-5 py-3 text-destructive' : 'rounded border border-destructive/30 bg-destructive/5 p-2 text-destructive'">{{ error }}</div>
      <div v-if="notice" :class="active === 'maintenance' ? 'border-b bg-muted/40 px-5 py-3' : active === 'watch' ? 'border-b pb-2 text-xs text-muted-foreground' : 'rounded border bg-muted/40 p-2'">{{ notice }}</div>
      <template v-if="active === 'maintenance'">
        <div class="flex flex-wrap items-start justify-between gap-4 border-b px-5 py-4">
          <div class="min-w-0">
            <h2 class="text-base font-semibold">{{ t("etcd.admin.maintenanceTitle") }}</h2>
            <p class="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">{{ t("etcd.admin.maintenanceDescription") }}</p>
          </div>
          <div class="flex flex-wrap gap-2 text-xs text-muted-foreground">
            <span class="rounded-md border bg-muted/30 px-2.5 py-1.5">{{ t("etcd.admin.currentRevision", { revision: currentRevision ?? "-" }) }}</span>
            <span class="rounded-md border bg-muted/30 px-2.5 py-1.5">{{ t("etcd.admin.reachableMembers", { reachable: reachableMemberCount, total: memberCount }) }}</span>
          </div>
        </div>
        <div class="grid divide-y lg:grid-cols-2 lg:divide-x lg:divide-y-0">
          <section class="space-y-4 px-5 py-5">
            <div class="flex items-start gap-3">
              <History class="mt-0.5 h-5 w-5 shrink-0 text-sky-600" />
              <div>
                <h3 class="font-medium">{{ t("etcd.admin.compactTitle") }}</h3>
                <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("etcd.admin.compactDescription") }}</p>
              </div>
            </div>
            <div class="border-l-2 border-amber-500/70 pl-3 text-xs leading-5 text-muted-foreground">{{ t("etcd.admin.compactDiskHint") }}</div>
            <label class="block space-y-1.5">
              <span class="text-xs font-medium">{{ t("etcd.admin.compactRevision") }}</span>
              <Input v-model="revision" inputmode="numeric" :placeholder="t('etcd.admin.compactPlaceholder', { revision: currentRevision ?? '' })" />
              <span class="block text-xs leading-5 text-muted-foreground">{{ t("etcd.admin.compactInputHint") }}</span>
            </label>
            <Button variant="destructive" :disabled="busy || maintenanceApprovalLoading || !/^\d+$/.test(revision)" @click="compact">{{ t("etcd.admin.compactAction") }}</Button>
          </section>
          <section class="space-y-4 px-5 py-5">
            <div class="flex items-start gap-3">
              <HardDrive class="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              <div>
                <h3 class="font-medium">{{ t("etcd.admin.defragTitle") }}</h3>
                <p class="mt-1 text-xs leading-5 text-muted-foreground">{{ t("etcd.admin.defragDescription") }}</p>
              </div>
            </div>
            <div class="border-l-2 border-amber-500/70 pl-3 text-xs leading-5 text-muted-foreground">{{ t("etcd.admin.defragWarning") }}</div>
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span class="inline-flex items-center gap-1.5 rounded-md border bg-muted/30 px-2.5 py-1.5"><Server class="h-3.5 w-3.5" />{{ t("etcd.admin.defragReachableMembers", { count: endpoints.length }) }}</span>
              <span v-if="leaderEndpoint" class="max-w-full truncate rounded-md border bg-muted/30 px-2.5 py-1.5" :title="leaderEndpoint">{{ t("etcd.admin.leaderLast", { endpoint: leaderEndpoint }) }}</span>
            </div>
            <Button variant="outline" :disabled="busy || maintenanceApprovalLoading || !endpoints.length" @click="defrag">{{ t("etcd.admin.defragAction", { count: endpoints.length }) }}</Button>
          </section>
        </div>
      </template>
      <template v-else-if="active === 'watch'">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="text-base font-semibold">{{ t("etcd.admin.watch") }}</h2>
              <span class="text-xs text-muted-foreground">{{ t("etcd.admin.watchCount", { count: watchMonitors.length }) }}</span
              ><span v-if="runningWatchCount" class="rounded-full border border-emerald-500/50 px-2 py-0.5 text-xs text-emerald-700 dark:text-emerald-300">{{ t("etcd.admin.runningWatchCount", { count: runningWatchCount }) }}</span>
            </div>
            <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.admin.watchSessionHint") }}</p>
          </div>
          <div class="flex w-full items-center gap-2 sm:w-auto">
            <div class="relative min-w-0 flex-1 sm:w-56 sm:flex-none"><Search class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input v-model="watchSearch" class="h-9 pl-8 text-sm" :placeholder="t('etcd.admin.watchSearch')" /></div>
            <Button size="sm" class="h-9 shrink-0 gap-1.5" @click="openWatchDialog()"><Plus class="h-3.5 w-3.5" />{{ t("etcd.admin.newWatch") }}</Button>
          </div>
        </div>
        <div class="grid min-h-[22rem] gap-5 xl:grid-cols-[minmax(22rem,0.9fr)_minmax(0,1.1fr)]">
          <section class="min-w-0 space-y-2">
            <div class="flex items-center justify-between text-xs text-muted-foreground">
              <span>{{ t("etcd.admin.watchList") }}</span
              ><span>{{ t("etcd.admin.itemCount", { count: filteredWatchMonitors.length }) }}</span>
            </div>
            <div class="overflow-hidden rounded-md border">
              <div class="grid grid-cols-[minmax(9rem,1fr)_5rem_6.5rem_auto] gap-2 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span>Key</span><span>{{ t("etcd.admin.scope") }}</span
                ><span>{{ t("etcd.admin.status") }}</span
                ><span class="text-right">{{ t("etcd.admin.actions") }}</span>
              </div>
              <div v-for="monitor in filteredWatchMonitors" :key="monitor.id" class="grid grid-cols-[minmax(9rem,1fr)_5rem_6.5rem_auto] items-center gap-2 border-b px-3 py-2.5 text-sm last:border-b-0" :class="selectedWatchId === monitor.id ? 'bg-accent/60' : ''">
                <button type="button" class="min-w-0 text-left" @click="selectedWatchId = monitor.id">
                  <code class="block truncate" :title="monitor.key">{{ monitor.key }}</code
                  ><span v-if="monitor.error" class="mt-1 block truncate text-xs text-destructive" :title="monitor.error">{{ monitor.error }}</span>
                </button>
                <span class="text-xs text-muted-foreground">{{ monitor.scope === "key" ? t("etcd.admin.exact") : t("etcd.admin.prefix") }}</span>
                <span :class="monitor.status === 'running' ? 'border-emerald-500/50 text-emerald-700 dark:text-emerald-300' : monitor.status === 'error' ? 'border-destructive/50 text-destructive' : 'text-muted-foreground'" class="inline-flex w-fit rounded-full border px-2 py-0.5 text-xs">{{
                  monitor.status === "running" ? t("etcd.admin.running") : monitor.status === "error" ? t("etcd.admin.error") : t("etcd.admin.stopped")
                }}</span>
                <div class="flex justify-end gap-0.5">
                  <Button size="sm" variant="ghost" class="h-7 w-7 p-0" :title="t('etcd.admin.editWatchTitle')" @click="editWatchMonitor(monitor)"><Pencil class="h-3.5 w-3.5" /></Button
                  ><Button v-if="monitor.status === 'running'" size="sm" variant="ghost" class="h-7 w-7 p-0 text-amber-700 hover:text-amber-700 dark:text-amber-300" :title="t('etcd.admin.stopWatch')" @click="requestStopWatchMonitor(monitor)"><Square class="h-3.5 w-3.5" /></Button
                  ><Button v-else size="sm" variant="ghost" class="h-7 w-7 p-0 text-emerald-700 hover:text-emerald-700 dark:text-emerald-300" :title="t('etcd.admin.startWatch')" @click="void resumeWatchMonitor(monitor)"><Play class="h-3.5 w-3.5" /></Button
                  ><Button size="sm" variant="ghost" class="h-7 w-7 p-0 text-destructive hover:text-destructive" :title="t('etcd.admin.deleteWatch')" @click="void deleteWatchMonitor(monitor)"><Trash2 class="h-3.5 w-3.5" /></Button>
                </div>
              </div>
              <div v-if="filteredWatchMonitors.length === 0" class="px-3 py-12 text-center text-sm text-muted-foreground">{{ watchMonitors.length ? t("etcd.admin.noMatchingWatches") : t("etcd.admin.noWatches") }}</div>
            </div>
          </section>
          <section v-if="selectedWatchMonitor" class="min-w-0 space-y-3 border-t pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
            <div class="flex flex-wrap items-center gap-2">
              <div class="min-w-0 flex-1">
                <h3 class="text-sm font-semibold">{{ t("etcd.admin.eventStream") }}</h3>
                <code class="mt-1 block truncate text-xs text-muted-foreground" :title="selectedWatchMonitor.key">{{ selectedWatchMonitor.key }}</code>
              </div>
              <span class="text-xs text-muted-foreground">{{ t("etcd.admin.eventCount", { count: selectedWatchMonitor.events.length }) }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span class="mr-1 text-xs font-medium text-muted-foreground">{{ t("etcd.admin.filter") }}</span
              ><label v-for="item in watchEventFilterOptions" :key="item.value" class="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground"><input v-model="watchEventFilters[item.value]" type="checkbox" class="h-3.5 w-3.5 rounded border-input" />{{ item.label }}</label>
            </div>
            <div class="overflow-hidden rounded-md border">
              <div class="grid grid-cols-[7rem_5.5rem_minmax(0,1fr)] gap-3 border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                <span>Revision</span><span>{{ t("etcd.admin.event") }}</span
                ><span>Key</span>
              </div>
              <div class="max-h-72 overflow-auto">
                <div v-for="event in visibleWatchEvents" :key="`${event.revision}:${event.key}:${event.eventType}`" class="grid grid-cols-[7rem_5.5rem_minmax(0,1fr)] gap-3 border-b px-3 py-2 text-xs last:border-b-0">
                  <span class="font-mono text-muted-foreground">{{ event.revision }}</span
                  ><span :class="event.category === 'delete' ? 'text-destructive' : event.category === 'update' ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-700 dark:text-emerald-300'">{{ watchEventCategoryLabel(event.category) }}</span
                  ><code class="truncate" :title="event.key">{{ event.key }}</code>
                </div>
                <div v-if="!visibleWatchEvents.length" class="p-8 text-center text-xs text-muted-foreground">
                  {{ selectedWatchMonitor.status === "running" ? (selectedWatchMonitor.events.length ? t("etcd.admin.noFilteredEvents") : t("etcd.admin.waitingEvents")) : t("etcd.admin.watchNotRunning") }}
                </div>
              </div>
            </div>
          </section>
          <div v-else class="flex items-center justify-center border-t pt-4 text-sm text-muted-foreground xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">{{ t("etcd.admin.selectWatch") }}</div>
        </div>
      </template>
      <template v-else-if="active === 'lease'">
        <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
          <div>
            <h2 class="text-base font-semibold">{{ t("etcd.admin.lease") }}</h2>
            <p class="mt-1 text-xs text-muted-foreground">{{ t("etcd.admin.leaseDescription") }}</p>
          </div>
          <div class="flex gap-2">
            <Button size="sm" @click="openLeaseGrantDialog">{{ t("etcd.admin.grantLease") }}</Button
            ><Button size="sm" variant="outline" :disabled="busy" @click="loadLeases">{{ t("etcd.admin.refresh") }}</Button>
          </div>
        </div>
        <div class="grid gap-3 lg:grid-cols-[minmax(18rem,0.85fr)_minmax(0,1.15fr)]">
          <div class="space-y-2">
            <div v-for="lease in leases?.leases || []" :key="lease.id" class="flex w-full cursor-pointer items-center gap-3 rounded border px-3 py-2 text-left hover:bg-accent" :class="selectedLease?.id === lease.id ? 'border-primary bg-accent' : ''" @click="openLease(lease.id)">
              <code class="min-w-0 flex-1 truncate">{{ lease.id }}</code
              ><span class="shrink-0 text-xs text-muted-foreground">TTL {{ displayedLeaseTtl(lease.id, lease.ttl) }}s</span><Button size="sm" variant="ghost" class="shrink-0" :disabled="busy" @click.stop="renewLease(lease.id)">{{ t("etcd.admin.renew") }}</Button
              ><Button size="sm" variant="ghost" class="shrink-0 text-destructive hover:text-destructive" :disabled="busy" @click.stop="revokeLease(lease.id)">{{ t("etcd.admin.revoke") }}</Button>
            </div>
            <div v-if="!leases?.leases.length" class="rounded border border-dashed px-3 py-6 text-center text-xs text-muted-foreground">{{ t("etcd.admin.noKnownLeases") }}</div>
            <div v-if="leases && (leasePreviousContinuations.length || leases.nextContinuation)" class="flex items-center justify-between gap-2 pt-1">
              <Button size="sm" variant="outline" :disabled="busy || !leasePreviousContinuations.length" @click="previousLeasePage">{{ t("etcd.admin.previousPage") }}</Button>
              <span class="text-xs text-muted-foreground">{{ t("etcd.admin.leasePageSize", { count: 100 }) }}</span>
              <Button size="sm" variant="outline" :disabled="busy || !leases.nextContinuation" @click="nextLeasePage">{{ t("etcd.admin.nextPage") }}</Button>
            </div>
          </div>
          <div class="rounded border p-3">
            <div v-if="leaseDetailLoading" class="flex h-32 items-center justify-center text-xs text-muted-foreground">{{ t("etcd.admin.loadingLease") }}</div>
            <div v-else-if="selectedLease" class="space-y-3">
              <div class="flex flex-wrap items-center gap-2">
                <code class="mr-auto text-sm">{{ selectedLease.id }}</code
                ><span class="text-xs text-muted-foreground">TTL {{ displayedLeaseTtl(selectedLease.id, selectedLease.ttl) }}s / {{ t("etcd.admin.grantedTtl", { ttl: selectedLease.grantedTtl }) }}</span>
              </div>
              <label class="flex items-center gap-2 rounded border bg-muted/20 px-3 py-2 text-xs"><input v-model="autoKeepalive" type="checkbox" class="h-3.5 w-3.5" />{{ t("etcd.admin.keepalive") }}</label>
              <div>
                <div class="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{{ t("etcd.admin.attachedKeys") }}</span
                  ><span>{{ selectedLease.keys.length }}{{ selectedLease.truncated ? "+" : "" }}</span>
                </div>
                <div class="max-h-44 overflow-auto rounded border">
                  <code v-for="key in selectedLease.keys" :key="`${key.encoding}:${key.data}`" class="block truncate border-b px-2 py-1 text-xs last:border-b-0">{{ key.encoding === "utf8" ? key.data : `base64:${key.data}` }}</code>
                  <div v-if="selectedLease.keys.length === 0" class="px-2 py-4 text-center text-xs text-muted-foreground">{{ t("etcd.admin.noAttachedKeys") }}</div>
                </div>
                <p v-if="selectedLease.truncated" class="mt-2 text-xs text-muted-foreground">{{ t("etcd.admin.attachedKeysTruncated") }}</p>
              </div>
            </div>
            <div v-else class="flex h-32 items-center justify-center text-xs text-muted-foreground">{{ t("etcd.admin.selectLease") }}</div>
          </div>
        </div>
        <div v-if="leases?.partial" class="text-xs text-muted-foreground">{{ t("etcd.admin.leasePartial") }}</div>
      </template>
    </div>
    <Dialog :open="leaseGrantDialogOpen" @update:open="updateLeaseGrantDialog">
      <DialogContent class="sm:max-w-md">
        <DialogHeader
          ><DialogTitle>{{ t("etcd.admin.grantNewLease") }}</DialogTitle></DialogHeader
        >
        <form class="space-y-5" @submit.prevent="grantLease">
          <label class="grid gap-1.5"
            ><span class="text-sm font-medium">{{ t("etcd.admin.ttl") }}</span
            ><Input v-model="leaseGrantTtl" class="h-10" type="number" min="1" step="1" inputmode="numeric" :placeholder="t('etcd.admin.ttlPlaceholder')" /><span class="text-xs text-muted-foreground">{{ t("etcd.admin.ttlHint") }}</span></label
          >
          <label class="grid gap-1.5"
            ><span class="text-sm font-medium"
              >{{ t("etcd.admin.customLeaseId") }} <span class="font-normal text-muted-foreground">({{ t("etcd.access.optional") }})</span></span
            ><Input v-model="leaseGrantId" class="h-10 font-mono" inputmode="numeric" :placeholder="t('etcd.admin.customLeasePlaceholder')" /><span class="text-xs text-muted-foreground">{{ t("etcd.admin.customLeaseHint") }}</span></label
          >
          <DialogFooter class="gap-2 sm:gap-2"
            ><Button type="button" variant="outline" @click="closeLeaseGrantDialog">{{ t("etcd.admin.cancel") }}</Button
            ><Button type="submit" :disabled="leaseGrantBusy || !leaseGrantTtl.trim()"><Loader2 v-if="leaseGrantBusy" class="mr-2 h-4 w-4 animate-spin" />{{ t("etcd.admin.grantLease") }}</Button></DialogFooter
          >
        </form>
      </DialogContent>
    </Dialog>
    <Dialog :open="watchDialogOpen" @update:open="updateWatchDialog">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ watchEditingId ? t("etcd.admin.editWatch") : t("etcd.admin.newWatch") }}</DialogTitle>
        </DialogHeader>
        <form class="space-y-5" @submit.prevent="saveWatchMonitor">
          <label class="grid gap-1.5">
            <span class="text-sm font-medium">{{ t("etcd.keyOrPrefix") }}</span>
            <div class="relative">
              <Input
                v-model="watchFormKey"
                class="h-10 font-mono"
                role="combobox"
                aria-autocomplete="list"
                :aria-expanded="showWatchKeySuggestions"
                aria-controls="etcd-watch-key-suggestions"
                :aria-activedescendant="watchSuggestionIndex >= 0 ? `etcd-watch-key-suggestion-${watchSuggestionIndex}` : undefined"
                :placeholder="t('etcd.admin.watchKeyPlaceholder')"
                autofocus
                @focus="watchSuggestionOpen = Boolean(watchFormKey.trim())"
                @blur="closeWatchKeySuggestions"
                @update:model-value="onWatchKeyInput"
                @keydown="onWatchKeyKeydown"
              />
              <div v-if="showWatchKeySuggestions" id="etcd-watch-key-suggestions" role="listbox" class="absolute z-50 mt-1 max-h-52 w-full overflow-auto rounded-md border bg-popover py-1 text-popover-foreground shadow-lg">
                <button
                  v-for="(suggestion, index) in filteredWatchKeySuggestions"
                  :id="`etcd-watch-key-suggestion-${index}`"
                  :key="`${suggestion.keyBytes.encoding}:${suggestion.keyBytes.data}`"
                  type="button"
                  role="option"
                  :aria-selected="watchSuggestionIndex === index"
                  class="flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-xs"
                  :class="watchSuggestionIndex === index ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/70'"
                  @mouseenter="watchSuggestionIndex = index"
                  @mousedown.prevent="acceptWatchKeySuggestion(index)"
                >
                  <Search class="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span class="truncate">{{ suggestion.key }}</span>
                </button>
              </div>
            </div>
          </label>
          <fieldset class="grid gap-2">
            <legend class="text-sm font-medium">{{ t("etcd.admin.watchScope") }}</legend>
            <div class="flex w-fit rounded-md border p-0.5">
              <Button type="button" size="sm" :variant="watchFormScope === 'key' ? 'secondary' : 'ghost'" class="h-8 px-3" @click="watchFormScope = 'key'">{{ t("etcd.admin.exact") }}</Button>
              <Button type="button" size="sm" :variant="watchFormScope === 'prefix' ? 'secondary' : 'ghost'" class="h-8 px-3" @click="watchFormScope = 'prefix'">{{ t("etcd.admin.prefix") }}</Button>
            </div>
            <p class="text-xs leading-5 text-muted-foreground">{{ watchFormScope === "key" ? t("etcd.admin.watchKeyHint") : t("etcd.admin.watchPrefixHint") }}</p>
          </fieldset>
          <div class="rounded-md border bg-muted/30 px-3 py-2 text-xs leading-5 text-muted-foreground">{{ t("etcd.admin.watchSessionHint") }}</div>
          <DialogFooter class="gap-2 sm:gap-2">
            <Button type="button" variant="outline" @click="closeWatchDialog">{{ t("etcd.admin.cancel") }}</Button>
            <Button type="submit" :disabled="busy || !watchFormKey">{{ watchEditingId ? t("etcd.admin.saveWatch") : t("etcd.admin.createWatch") }}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog :open="maintenanceApprovalOpen" @update:open="(open) => !open && closeMaintenanceApproval()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle class="text-destructive">{{ maintenanceApprovalTitle }}</DialogTitle>
        </DialogHeader>
        <div class="space-y-4 py-2">
          <p class="text-sm text-muted-foreground">{{ t("etcd.admin.confirmationHint") }}</p>
          <div class="whitespace-pre-line border-l-2 border-destructive/70 pl-3 text-sm leading-6 text-foreground">{{ maintenanceApprovalDetails }}</div>
          <div class="space-y-2 border-t pt-4">
            <p class="text-xs leading-5 text-muted-foreground">{{ t("etcd.admin.confirmationCredentialHint") }}</p>
            <code class="block break-all rounded border bg-muted px-3 py-2 text-xs">{{ maintenanceApprovalExpected }}</code>
            <Input v-model="maintenanceApprovalText" :placeholder="t('etcd.admin.confirmationPlaceholder')" autocomplete="off" :disabled="busy" @keyup.enter="confirmMaintenanceApproval" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" :disabled="busy" @click="closeMaintenanceApproval">{{ t("etcd.admin.cancel") }}</Button>
          <Button variant="destructive" :disabled="busy || maintenanceApprovalText !== maintenanceApprovalExpected" @click="confirmMaintenanceApproval">{{ t("etcd.admin.confirmExecute") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>

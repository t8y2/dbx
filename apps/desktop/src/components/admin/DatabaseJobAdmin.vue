<script setup lang="ts">
// Shared workspace; the existing Dameng tab keeps its compatibility entry.
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, CalendarClock, DatabaseZap, Loader2, Pencil, Play, Plus, Power, RefreshCcw, Square, Trash2, XCircle } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { ConnectionConfig } from "@/types/database";
import * as api from "@/lib/backend/api";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { useNativeJobExecution } from "@/composables/useNativeJobExecution";
import { connectionConfigFingerprint } from "@/lib/connection/connectionDatabaseInfo";
import {
  buildNativeJobDamengCreate,
  buildNativeJobDamengEdit,
  rebaseNativeJobDamengCreation,
  rebaseNativeJobDamengDraft,
  nativeJobRefKey,
  type NativeJobContext,
  type NativeJobDamengEditDraft,
  type NativeJobDetails,
  type NativeJobMetadata,
  type NativeJobMutation,
  type NativeJobKind,
  type NativeJobRef,
  type NativeJobRow,
  type NativeJobSummary,
} from "@/lib/database/nativeJobs";
import NativeJobDamengEditor from "@/components/admin/NativeJobDamengEditor.vue";
import NativeJobDefinitionEditor from "@/components/admin/NativeJobDefinitionEditor.vue";
import {
  buildNativeJobDefinitionCreate,
  buildNativeJobDefinitionEdit,
  initializeNativeJobDefinitionEdit,
  rebaseNativeJobDefinitionCreation,
  nativeJobAdminKinds,
  nativeJobAdminEngine,
  nativeJobAdminSupported,
  nativeJobAdminSelection,
  nativeJobAdminSelectionKey,
  newNativeJobDefinitionDraft,
  type NativeJobAdminSelection,
  type NativeJobDefinitionDraft,
} from "@/lib/database/nativeJobAdmin";
import { DAMENG_JOB_ENVIRONMENT_SQL, damengInitJobSystemSql, isDamengJobEnvironmentMissingError, parseDamengJobEnvironmentReady } from "@/lib/database/damengJobAdmin";
import { useTabUiState } from "@/lib/tabs/tabUiState";

const props = defineProps<{
  connection: ConnectionConfig;
  initialSelection?: NativeJobAdminSelection;
}>();

type DetailTab = "definition" | "arguments" | "steps" | "schedules" | "running" | "histories";
interface RetainedJobDraft {
  dameng: NativeJobDamengEditDraft;
  definition: NativeJobDefinitionDraft;
  anchor?: { engine: NativeJobContext["engine"]; sessionUser: string; actualDatabase: string | null; details: NativeJobDetails };
}

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const context = shallowRef<NativeJobContext>();
const isDameng = computed(() => (context.value?.engine ?? nativeJobAdminEngine(props.connection)) === "dameng");
const { initialState: restoredUiState, track: trackUiState } = useTabUiState<{ selectedJobName?: string; selectedJob?: NativeJobAdminSelection; kind?: NativeJobKind; ownerFilter?: string; search?: string; detailTab?: DetailTab; listOffset?: number }>(
  {},
  isDameng.value ? "DamengJobAdmin" : "DatabaseJobAdmin",
);

const jobs = shallowRef<NativeJobSummary[]>([]);
const selectedExtra = shallowRef<NativeJobSummary>();
const details = shallowRef<NativeJobDetails>();
const editDialogOpen = ref(false);
const editDraft = ref<NativeJobDamengEditDraft>({});
const definitionEditDraft = ref({}) as Ref<NativeJobDefinitionDraft>;
const selectedIdentity = shallowRef<NativeJobAdminSelection | undefined>(props.initialSelection ?? restoredUiState.selectedJob);
const kind = ref<NativeJobKind>(selectedIdentity.value?.kind ?? restoredUiState.kind ?? (isDameng.value ? "dameng-native" : "scheduler"));
const ownerFilter = ref(restoredUiState.ownerFilter ?? "");
const retainedDrafts = new Map<string, RetainedJobDraft>();
const detachedDraft = shallowRef<RetainedJobDraft>();
const viewingDetachedDraft = ref(false);
const refreshingContext = ref(false);
let contextRefreshGeneration = 0;
let installingContext = false;
let disposed = false;
const listTruncated = ref(false);
const listOffset = ref(Number.isSafeInteger(restoredUiState.listOffset) && restoredUiState.listOffset! >= 0 ? restoredUiState.listOffset! : 0);
const pageSize = 100;
let jobsRequest = 0;
let detailsRequest = 0;
let selectedRead = Promise.resolve();
let selectionChanges = 0;
let renameSource: { operationId: string; before: NativeJobDetails; handled: boolean } | undefined;
let searchTimer: ReturnType<typeof setTimeout> | undefined;
const selectedJobName = ref(restoredUiState.selectedJobName ?? "");
const search = ref(restoredUiState.search ?? "");
const loadingJobs = ref(false);
const loadingDetails = ref(false);
const applying = ref(false);
const jobEnvironmentReady = ref(true);
const loadError = ref("");
const detailError = ref("");
const detailTab = ref<DetailTab>(["definition", "arguments", "steps", "schedules", "running", "histories"].includes(restoredUiState.detailTab ?? "") ? restoredUiState.detailTab! : isDameng.value ? "steps" : "definition");

const createDialogOpen = ref(false);
const previewDialogOpen = ref(false);
const pendingSql = ref("");
const pendingAfterApply = ref<(() => Promise<void>) | undefined>();
const pendingDanger = ref(false);
const pendingUseTransaction = ref(false);
const pendingNative = ref(false);
const pendingNativeSlot = ref<"main" | "stop">("main");
const pendingConfirmation = shallowRef<{ slot: "main" | "stop"; planId: string; operationId: string }>();

const createName = ref("JOB_TEST");
const createOwner = ref("");
const createKind = ref<NativeJobKind>(kind.value);
// Keep the recursive JSON contract stable instead of expanding Vue's deep-unwrapped type.
const schedulerCreateDraft = ref(newNativeJobDefinitionDraft("scheduler")) as Ref<NativeJobDefinitionDraft>;
const legacyCreateDraft = ref(newNativeJobDefinitionDraft("legacy")) as Ref<NativeJobDefinitionDraft>;
const definitionCreateDraft = computed({
  get: () => (createKind.value === "legacy" ? legacyCreateDraft.value : schedulerCreateDraft.value),
  set: (value: NativeJobDefinitionDraft) => {
    if (createKind.value === "legacy") legacyCreateDraft.value = value;
    else schedulerCreateDraft.value = value;
  },
});
const createDraft = ref<NativeJobDamengEditDraft>({
  attributes: { ENABLE: { kind: "set", value: true } },
  steps: [{ kind: "add", name: "STEP1", attributes: { TYPE: { kind: "set", value: 0 }, COMMAND_INPUT: { kind: "set", value: "SELECT 1;" } } }],
  schedules: [{ kind: "add", name: "SCHEDULE1", attributes: { TYPE: { kind: "set", value: 1 } } }],
});
const creationPending = ref(false);

trackUiState(() => ({ selectedJobName: selectedJobName.value, selectedJob: selectedIdentity.value, kind: kind.value, ownerFilter: ownerFilter.value, search: search.value, detailTab: detailTab.value, listOffset: listOffset.value }));

const supported = computed(() => nativeJobAdminSupported(props.connection));
const executionDatabase = computed(() => "");
const engine = computed(() => context.value?.engine ?? nativeJobAdminEngine(props.connection) ?? "oracle");
const kinds = computed(() => nativeJobAdminKinds(engine.value));
const connectionIdentity = computed(() => connectionConfigFingerprint(props.connection));
const selectedJob = computed(() =>
  selectedIdentity.value
    ? (jobs.value.find((job) => nativeJobAdminSelectionKey(job.ref) === nativeJobAdminSelectionKey(selectedIdentity.value!)) ?? (selectedExtra.value && nativeJobAdminSelectionKey(selectedExtra.value.ref) === nativeJobAdminSelectionKey(selectedIdentity.value) ? selectedExtra.value : undefined))
    : jobs.value.find((job) => job.name === selectedJobName.value),
);
const selectedTarget = computed(() => selectedJob.value?.ref);
const selectedTargetKey = computed(() => (selectedTarget.value ? nativeJobRefKey(selectedTarget.value) : ""));
const damengCatalogSelection = computed(() => engine.value === "dameng" && (selectedTarget.value?.kind === "dameng-native" || selectedTarget.value?.kind === "legacy"));
const detailTabs = computed<DetailTab[]>(() => ["definition", ...(damengCatalogSelection.value ? (["steps", "schedules"] as const) : selectedTarget.value?.kind === "scheduler" ? (["arguments"] as const) : []), "running", "histories"]);
const usableBaseline = computed(() => supported.value && !refreshingContext.value && !!details.value?.snapshot.revision && details.value.snapshot.definition.status === "available" && details.value.consistency.status === "available" && details.value.nativeIdentity.status === "available");
const stopAvailable = computed(() => selectedTarget.value?.kind === "scheduler" || engine.value === "dameng");
const selectedRunning = computed(() => (details.value?.running.status === "available" ? details.value.running.value.length > 0 : details.value?.running.status === "empty" ? false : undefined));
const detailMetadata = computed<NativeJobMetadata<NativeJobRow[]> | undefined>(() => {
  if (!details.value) return undefined;
  if (detailTab.value === "definition") {
    const definition = details.value.snapshot.definition;
    return definition.status === "available" ? { status: "available", value: [definition.value] } : definition.status === "truncated" ? { ...definition, value: [definition.value] } : definition;
  }
  return details.value[detailTab.value === "histories" ? "history" : detailTab.value === "arguments" ? "parameterMetadata" : detailTab.value];
});
const detailRows = computed(() => (detailMetadata.value?.status === "available" || detailMetadata.value?.status === "truncated" ? detailMetadata.value.value : []));
const metadataWarning = computed(() => (detailMetadata.value && !["available", "empty"].includes(detailMetadata.value.status) ? t("nativeJobs.partitionUnavailable", { status: detailMetadata.value.status }) : ""));
const native = useNativeJobExecution({
  connection: () => props.connection,
  database: () => executionDatabase.value,
  scope: () => context.value?.scope,
  selected: () => selectedTarget.value,
  source: () => t("production.sourceAdmin"),
  onTargetObserved: async (status, original) => {
    if (refreshingContext.value || disposed) return;
    const refresh = contextRefreshGeneration;
    const source = renameSource;
    const target = status.target;
    const observed = status.observedIdentity;
    if (!source || source.operationId !== status.operationId || engine.value !== "dameng" || original.kind === "scheduler" || !target || target.kind === "scheduler" || target.kind !== original.kind || target.jobId !== original.jobId || typeof observed?.NAME !== "string" || !observed.NAME) return;
    if (target.kind === "dameng-native" && target.name !== observed.NAME) return;
    const identity = source.before.nativeIdentity;
    if (identity.status !== "available" || ["DBX_JOB_ID", "DBX_CREATED_AT"].some((key) => identity.value[key] !== observed[key])) return;
    const previous = selectedTargetKey.value;
    const next = nativeJobRefKey(target);
    if (previous !== nativeJobRefKey(original) && previous !== next) return;
    const selection = selectionChanges;
    const connection = connectionIdentity.value;
    const retained = { dameng: editDraft.value, definition: definitionEditDraft.value };
    retainedDrafts.set(next, retained);
    selectedExtra.value = { ...(selectedJob.value ?? extraSummary(target)), ref: target, name: observed.NAME };
    if (target.kind === "legacy") jobs.value = jobs.value.map((job) => (nativeJobRefKey(job.ref) === next ? { ...job, name: observed.NAME as string } : job));
    selectedIdentity.value = nativeJobAdminSelection(target);
    selectedJobName.value = observed.NAME;
    if (previous !== next) {
      retainedDrafts.delete(previous);
      await selectedRead;
    } else await loadDetails();
    if (refresh !== contextRefreshGeneration || disposed || source !== renameSource || connection !== connectionIdentity.value || selection !== selectionChanges || next !== selectedTargetKey.value) return;
    await loadJobs(false);
    if (refresh !== contextRefreshGeneration || disposed || source !== renameSource || connection !== connectionIdentity.value || selection !== selectionChanges || next !== selectedTargetKey.value || !details.value) return;
    const current = details.value.nativeIdentity;
    if (current.status !== "available" || ["DBX_JOB_ID", "DBX_CREATED_AT"].some((key) => identity.value[key] !== current.value[key])) {
      details.value = undefined;
      detailError.value = "native_job_identity_mismatch";
      return;
    }
    if (target.kind === "dameng-native") editDraft.value = rebaseNativeJobDamengDraft(source.before, details.value, editDraft.value, status, context.value?.sessionUser ?? "");
    else if (status.outcome !== "unknown" && details.value.snapshot.definition.status === "available") {
      const remaining = buildNativeJobDefinitionEdit(details.value, "dameng", definitionEditDraft.value).attributes;
      definitionEditDraft.value = { ...definitionEditDraft.value, attributes: Object.fromEntries(remaining.map(({ name, change }) => [name, change])) };
    }
    retainedDrafts.set(next, currentDraft(next));
    source.handled = true;
  },
  onFinished: async (status) => {
    if (refreshingContext.value || disposed) return;
    const refresh = contextRefreshGeneration;
    const creating = creationPending.value;
    const selection = selectionChanges;
    if (status.outcome === "verified") {
      editDraft.value = {};
      definitionEditDraft.value = {};
      toast(t("damengJobAdmin.applySuccess"), 2500);
    }
    if (!creating && renameSource?.operationId === status.operationId) {
      if (!renameSource.handled) await loadDetails();
      return;
    }
    if (creating && status.target && selection === selectionChanges) kind.value = status.target.kind;
    await loadJobs();
    if (refresh !== contextRefreshGeneration || disposed) return;
    if (creating && selection === selectionChanges && status.target && status.target.scope.contextId === context.value?.scope.contextId) {
      const previous = selectedTargetKey.value;
      if (!jobs.value.some((job) => nativeJobRefKey(job.ref) === nativeJobRefKey(status.target!))) {
        selectedExtra.value = extraSummary(status.target);
      }
      selectedIdentity.value = nativeJobAdminSelection(status.target);
      selectedJobName.value = status.target.kind === "legacy" ? status.target.jobId : status.target.name;
      if (previous === selectedTargetKey.value) await loadDetails();
      else await selectedRead;
      if (details.value && nativeJobRefKey(details.value.snapshot.ref) === nativeJobRefKey(status.target)) {
        if (status.outcome !== "verified") {
          if (status.target.kind === "dameng-native") editDraft.value = rebaseNativeJobDamengCreation(details.value, createDraft.value, status);
          else definitionEditDraft.value = rebaseNativeJobDefinitionCreation(details.value, definitionCreateDraft.value, status);
        }
        creationPending.value = false;
        createDialogOpen.value = false;
      }
    }
  },
});
const stopping = useNativeJobExecution({
  connection: () => props.connection,
  database: () => executionDatabase.value,
  scope: () => context.value?.scope,
  selected: () => selectedTarget.value,
  source: () => t("production.sourceAdmin"),
  onFinished: async () => {
    if (!refreshingContext.value && !disposed) await loadDetails();
  },
});
const previewExecution = computed(() => (pendingNativeSlot.value === "stop" ? stopping : native));
const nativePreview = computed(() => previewExecution.value.preview.value);
const nativeError = computed(() => {
  const error = previewExecution.value.error.value;
  return error?.includes("native_job_timestamp_precision_microseconds") ? t("nativeJobs.datePrecisionMicroseconds") : error;
});
const legacyRunRestoresScheduling = computed(() => engine.value === "oceanbase-oracle" && nativePreview.value?.target?.kind === "legacy" && nativePreview.value.steps.some((step) => step.id === "run"));
const nativeResult = computed(() => native.execution.value ?? native.previousExecution.value);
const dispatchedRun = computed(() => !native.previousExecution.value && native.execution.value?.status.state === "running" && native.execution.value.status.steps.some((step) => step.id === "run" && step.state === "dispatching"));
const nativeBusy = computed(() => native.busy.value || native.preparing.value || stopping.busy.value || stopping.preparing.value || refreshingContext.value || !supported.value);
const stopBusy = computed(() => stopping.busy.value || stopping.preparing.value || native.preparing.value || refreshingContext.value || !supported.value || (native.busy.value && !dispatchedRun.value));
const confirmationBusy = computed(() => (pendingNativeSlot.value === "stop" ? stopBusy.value : nativeBusy.value));
const nativeResults = computed(() =>
  [native, stopping].flatMap((owner) => {
    const result = owner.execution.value ?? owner.previousExecution.value;
    return result ? [{ owner, result, previous: owner.previousExecution.value?.status.operationId === result.status.operationId, target: result.prepared.plan.target ?? result.status.target }] : [];
  }),
);
watch(
  [() => native.execution.value?.status.operationId, () => stopping.execution.value?.status.operationId],
  () => {
    const confirmation = pendingConfirmation.value;
    if (!confirmation) return;
    const owner = confirmation.slot === "stop" ? stopping : native;
    const execution = owner.execution.value;
    if (execution?.prepared.plan.planId === confirmation.planId && execution.status.operationId === confirmation.operationId) previewDialogOpen.value = false;
  },
  { flush: "sync" },
);
const previewText = computed(() => (pendingNative.value ? (nativePreview.value?.steps.map((step) => step.sql).join("\n\n") ?? "") : pendingSql.value));
const filteredJobs = computed(() => jobs.value);
const detailColumns = computed(() => {
  const set = new Set<string>();
  for (const row of detailRows.value) {
    Object.keys(row).forEach((key) => set.add(key));
  }
  return Array.from(set);
});
const canCreateJob = computed(() => !!context.value && (createKind.value === "legacy" || !!createName.value) && (createKind.value === "dameng-native" || !!createOwner.value) && !nativeBusy.value);

function extraSummary(target: NativeJobRef): NativeJobSummary {
  return { ref: target, name: target.kind === "legacy" ? target.jobId : target.name, owner: target.kind === "scheduler" ? target.owner : null, enabled: null, jobType: null, state: null, nextRun: null, comments: null, aliases: [], logUser: null, privUser: null, schemaUser: null };
}

function draftAnchor(value = details.value): RetainedJobDraft["anchor"] {
  const current = context.value;
  return current && value && value.snapshot.ref.scope.contextId === current.scope.contextId ? { engine: current.engine, sessionUser: current.sessionUser, actualDatabase: current.actualDatabase, details: value } : undefined;
}

function currentDraft(key = selectedTargetKey.value): RetainedJobDraft {
  return { dameng: editDraft.value, definition: definitionEditDraft.value, anchor: retainedDrafts.get(key)?.anchor ?? (details.value && nativeJobRefKey(details.value.snapshot.ref) === key ? draftAnchor() : undefined) };
}

function draftBelongsToCurrentObject(draft: RetainedJobDraft): boolean {
  const old = draft.anchor;
  const current = context.value;
  const value = details.value;
  if (
    !old ||
    !current ||
    !value ||
    old.engine !== current.engine ||
    old.sessionUser !== current.sessionUser ||
    old.actualDatabase !== current.actualDatabase ||
    nativeJobAdminSelectionKey(old.details.snapshot.ref) !== nativeJobAdminSelectionKey(value.snapshot.ref) ||
    old.details.consistency.status !== "available" ||
    value.consistency.status !== "available" ||
    old.details.nativeIdentity.status !== "available" ||
    value.nativeIdentity.status !== "available"
  )
    return false;
  const before = old.details.nativeIdentity.value;
  const after = value.nativeIdentity.value;
  return Object.keys(before).length > 0 && Object.keys(before).length === Object.keys(after).length && Object.keys(before).every((key) => JSON.stringify(before[key]) === JSON.stringify(after[key]));
}

async function refreshContext() {
  if (!supported.value && !context.value) return;
  const key = selectedTargetKey.value;
  const saved = currentDraft(key);
  if (key) retainedDrafts.set(key, saved);
  const selection = selectedIdentity.value ?? (selectedTarget.value ? nativeJobAdminSelection(selectedTarget.value) : undefined);
  const expectedSelection = selection ? nativeJobAdminSelectionKey(selection) : "";
  const identity = connectionIdentity.value;
  const refresh = ++contextRefreshGeneration;
  const request = ++jobsRequest;
  const selected = ++selectionChanges;
  detailsRequest++;
  loadingJobs.value = false;
  loadingDetails.value = false;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = undefined;
  native.invalidateContext();
  stopping.invalidateContext();
  pendingConfirmation.value = undefined;
  previewDialogOpen.value = false;
  editDialogOpen.value = false;
  createDialogOpen.value = false;
  creationPending.value = false;
  renameSource = undefined;
  viewingDetachedDraft.value = false;
  refreshingContext.value = true;
  installingContext = true;
  selectedIdentity.value = selection;
  details.value = undefined;
  context.value = undefined;
  jobs.value = [];
  selectedExtra.value = undefined;
  installingContext = false;
  detailError.value = "";
  loadError.value = "";
  const stillCurrent = () => !disposed && refresh === contextRefreshGeneration && identity === connectionIdentity.value && selected === selectionChanges && (selectedIdentity.value ? nativeJobAdminSelectionKey(selectedIdentity.value) : "") === expectedSelection;
  try {
    await ensureConnection();
    if (!stillCurrent() || request !== jobsRequest) return;
    if (isDameng.value) {
      const environment = await api.executeQuery(props.connection.id, executionDatabase.value, DAMENG_JOB_ENVIRONMENT_SQL, undefined, undefined, { maxRows: 1 });
      if (!stillCurrent() || request !== jobsRequest) return;
      jobEnvironmentReady.value = parseDamengJobEnvironmentReady(environment);
      if (!jobEnvironmentReady.value) return;
    }
    const opened = await api.nativeJobOpenContext(props.connection.id, executionDatabase.value);
    if (!stillCurrent() || request !== jobsRequest) return;
    installingContext = true;
    context.value = opened;
    if (selection) {
      const target = { ...selection, scope: opened.scope } as NativeJobRef;
      nativeJobRefKey(target);
      selectedExtra.value = extraSummary(target);
      selectedIdentity.value = selection;
    }
    installingContext = false;
    await loadJobs(false);
    if (!stillCurrent()) return;
    await loadDetails();
    if (!stillCurrent()) return;
    if (key && draftBelongsToCurrentObject(saved)) {
      editDraft.value = saved.dameng;
      definitionEditDraft.value = saved.definition;
      retainedDrafts.set(selectedTargetKey.value, { ...saved, anchor: draftAnchor() });
      if (key !== selectedTargetKey.value) retainedDrafts.delete(key);
    } else if (key) {
      if (Object.keys(saved.dameng).length || Object.keys(saved.definition).length) detachedDraft.value = saved;
      editDraft.value = {};
      definitionEditDraft.value = {};
      if (selectedTargetKey.value) retainedDrafts.set(selectedTargetKey.value, { dameng: editDraft.value, definition: definitionEditDraft.value, anchor: draftAnchor() });
    }
  } catch (error) {
    if (stillCurrent()) {
      loadError.value = error instanceof Error ? error.message : String(error);
      if (key && (Object.keys(saved.dameng).length || Object.keys(saved.definition).length)) detachedDraft.value = saved;
    }
  } finally {
    installingContext = false;
    if (refresh === contextRefreshGeneration) refreshingContext.value = false;
  }
}

async function ensureConnection() {
  await connectionStore.ensureConnected(props.connection.id, { skipIfClosedByUser: true });
}

async function loadJobs(refreshDetails = true) {
  if (disposed || !supported.value) return;
  const request = ++jobsRequest;
  const identity = connectionIdentity.value;
  loadingJobs.value = true;
  loadError.value = "";
  try {
    await ensureConnection();
    if (isDameng.value) {
      const environment = await api.executeQuery(props.connection.id, executionDatabase.value, DAMENG_JOB_ENVIRONMENT_SQL, undefined, undefined, {
        maxRows: 1,
      });
      if (disposed || request !== jobsRequest || identity !== connectionIdentity.value) return;
      jobEnvironmentReady.value = parseDamengJobEnvironmentReady(environment);
      if (!jobEnvironmentReady.value) {
        jobs.value = [];
        details.value = undefined;
        selectedJobName.value = "";
        return;
      }
    } else jobEnvironmentReady.value = true;
    const currentContext = context.value ?? (await api.nativeJobOpenContext(props.connection.id, executionDatabase.value));
    if (disposed || request !== jobsRequest || identity !== connectionIdentity.value) return;
    context.value = currentContext;
    if (!kinds.value.includes(kind.value)) kind.value = kinds.value[0]!;
    if (!createOwner.value) createOwner.value = currentContext.sessionUser;
    const result = await api.nativeJobList({ scope: currentContext.scope, kind: kind.value, ...(ownerFilter.value ? { schema: ownerFilter.value } : {}), filter: search.value.trim(), offset: listOffset.value, limit: pageSize });
    if (disposed || request !== jobsRequest || identity !== connectionIdentity.value) return;
    if (result.jobs.status !== "available" && result.jobs.status !== "empty" && result.jobs.status !== "truncated") throw new Error(t("nativeJobs.partitionUnavailable", { status: result.jobs.status }));
    const previous = selectedTargetKey.value;
    jobs.value = result.jobs.status === "empty" ? [] : result.jobs.value;
    listTruncated.value = result.jobs.status === "truncated";
    if (!selectedJob.value && selectedIdentity.value && selectedIdentity.value.kind === kind.value) {
      const target = { ...selectedIdentity.value, scope: currentContext.scope } as NativeJobRef;
      try {
        nativeJobRefKey(target);
        selectedExtra.value = extraSummary(target);
      } catch {
        selectedIdentity.value = undefined;
      }
    }
    if (!selectedJob.value) {
      selectedIdentity.value = jobs.value[0] ? nativeJobAdminSelection(jobs.value[0].ref) : undefined;
      selectedJobName.value = jobs.value[0]?.name || "";
    }
    if (refreshDetails && previous === selectedTargetKey.value) await loadDetails();
  } catch (error: any) {
    if (disposed || request !== jobsRequest || identity !== connectionIdentity.value) return;
    const message = error?.message || String(error);
    if (isDameng.value && isDamengJobEnvironmentMissingError(message)) {
      jobEnvironmentReady.value = false;
      loadError.value = "";
    } else {
      loadError.value = message;
    }
    jobs.value = [];
    details.value = undefined;
  } finally {
    if (request === jobsRequest) loadingJobs.value = false;
  }
}

async function loadDetails() {
  const target = selectedTarget.value;
  const request = ++detailsRequest;
  if (!target) {
    details.value = undefined;
    loadingDetails.value = false;
    return;
  }
  loadingDetails.value = true;
  detailError.value = "";
  try {
    const result = await api.nativeJobRead(target);
    if (disposed || request !== detailsRequest || nativeJobRefKey(target) !== selectedTargetKey.value) return;
    if (nativeJobRefKey(result.snapshot.ref) !== nativeJobRefKey(target)) throw new Error("native_job_identity_mismatch");
    details.value = result;
    if (!retainedDrafts.get(selectedTargetKey.value)?.anchor) retainedDrafts.set(selectedTargetKey.value, currentDraft());
    if (selectedExtra.value && nativeJobRefKey(selectedExtra.value.ref) === nativeJobRefKey(target) && result.snapshot.definition.status === "available") {
      const row = result.snapshot.definition.value;
      const enabled = row.ENABLED ?? row.ENABLE;
      selectedExtra.value = {
        ...selectedExtra.value,
        owner: target.kind === "scheduler" ? target.owner : typeof row.USERNAME === "string" ? row.USERNAME : null,
        enabled: enabled == null ? (row.BROKEN === "N" ? true : row.BROKEN === "Y" ? false : null) : enabled === true || enabled === 1 || enabled === "1" || enabled === "TRUE",
        comments: typeof row.COMMENTS === "string" ? row.COMMENTS : typeof row.DESCRIBE === "string" ? row.DESCRIBE : null,
        logUser: typeof row.LOG_USER === "string" ? row.LOG_USER : null,
        privUser: typeof row.PRIV_USER === "string" ? row.PRIV_USER : null,
        schemaUser: typeof row.SCHEMA_USER === "string" ? row.SCHEMA_USER : null,
      };
    }
  } catch (error: any) {
    if (disposed || request !== detailsRequest) return;
    detailError.value = error?.message || String(error);
    details.value = undefined;
  } finally {
    if (request === detailsRequest) loadingDetails.value = false;
  }
}

function selectJob(job: NativeJobSummary) {
  selectionChanges++;
  selectedIdentity.value = nativeJobAdminSelection(job.ref);
  selectedJobName.value = job.name;
}

function changeKind() {
  selectionChanges++;
  jobsRequest++;
  selectedIdentity.value = undefined;
  selectedJobName.value = "";
  selectedExtra.value = undefined;
  jobs.value = [];
  listOffset.value = 0;
  detailTab.value = kind.value === "dameng-native" ? "steps" : "definition";
  void loadJobs();
}

function openCreate() {
  createKind.value = kind.value;
  createDialogOpen.value = true;
}

function previewSql(sql: string, options: { danger?: boolean; afterApply?: () => Promise<void>; useTransaction?: boolean } = {}) {
  pendingNative.value = false;
  pendingConfirmation.value = undefined;
  pendingSql.value = sql;
  pendingDanger.value = !!options.danger;
  pendingUseTransaction.value = !!options.useTransaction;
  pendingAfterApply.value = options.afterApply;
  previewDialogOpen.value = true;
}

async function applyPendingSql() {
  if (pendingNative.value) {
    const refresh = contextRefreshGeneration;
    const confirmation = pendingConfirmation.value;
    if (!confirmation) return;
    const owner = confirmation.slot === "stop" ? stopping : native;
    if (owner.preview.value?.planId !== confirmation.planId || owner.preview.value.operationId !== confirmation.operationId) return;
    const status = await owner.apply();
    if (!disposed && refresh === contextRefreshGeneration && status && pendingConfirmation.value === confirmation && status.operationId === confirmation.operationId) previewDialogOpen.value = false;
    return;
  }
  if (!pendingSql.value.trim()) return;
  applying.value = true;
  try {
    await ensureConnection();
    const result = await executeWithProductionSqlGuard({
      connection: props.connection,
      database: executionDatabase.value,
      sql: pendingSql.value,
      source: t("production.sourceAdmin"),
      execute: () =>
        api.executeMulti(props.connection.id, executionDatabase.value, pendingSql.value, undefined, undefined, {
          maxRows: 1000,
          useTransaction: pendingUseTransaction.value,
        }),
    });
    if (!result) return;
    toast(t("damengJobAdmin.applySuccess"), 2500);
    previewDialogOpen.value = false;
    await (pendingAfterApply.value?.() ?? Promise.resolve());
    await loadJobs();
  } catch (error: any) {
    toast(t("damengJobAdmin.applyFailed", { message: error?.message || String(error) }), 5000);
  } finally {
    applying.value = false;
  }
}

function previewCreateEnvironment() {
  previewSql(damengInitJobSystemSql());
}

async function previewCreateJob() {
  if (!canCreateJob.value || !context.value) return;
  try {
    pendingNative.value = true;
    pendingNativeSlot.value = "main";
    pendingDanger.value = false;
    const request =
      createKind.value === "dameng-native" ? buildNativeJobDamengCreate(context.value.scope, createName.value.trim(), createDraft.value) : buildNativeJobDefinitionCreate(context.value.scope, engine.value, createKind.value, createOwner.value, createName.value, definitionCreateDraft.value);
    const plan = await native.prepare(request);
    if (plan) {
      pendingConfirmation.value = { slot: "main", planId: plan.planId, operationId: plan.operationId };
      creationPending.value = true;
      createDialogOpen.value = false;
      previewDialogOpen.value = true;
    }
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

async function previewNative(change: NativeJobMutation, danger = false) {
  creationPending.value = false;
  pendingNative.value = true;
  const slot = change.action === "stop" ? "stop" : "main";
  pendingNativeSlot.value = slot;
  pendingDanger.value = danger;
  const before = details.value;
  const plan = await (slot === "stop" ? stopping : native).prepare(change);
  if (plan) {
    pendingConfirmation.value = { slot, planId: plan.planId, operationId: plan.operationId };
    renameSource = before && plan.steps.some((step) => step.id === "rename") ? { operationId: plan.operationId, before, handled: false } : undefined;
    previewDialogOpen.value = true;
  }
}

function correctDraft() {
  const status = nativeResult.value?.status;
  if (
    !creationPending.value &&
    status?.target?.kind === "scheduler" &&
    status.steps.some((step) => step.id === "create" && step.state === "applied") &&
    status.steps.some((step) => step.id === "enable" && step.state !== "applied") &&
    status.steps.every((step) => step.id === "enable" || step.state === "applied")
  ) {
    previewControl("enable");
    return;
  }
  if (creationPending.value) createDialogOpen.value = true;
  else editJob();
}

function previewControl(action: "enable" | "disable" | "run" | "stop" | "drop" | "clear-history", force = false) {
  if (!details.value || !selectedTarget.value) return;
  void previewNative({ action, target: selectedTarget.value, baseline: details.value.snapshot.revision, ...(force && (action === "stop" || action === "drop") ? { force: true } : {}) }, action === "drop" || action === "stop" || action === "clear-history");
}

function editJob() {
  if (!details.value) return;
  viewingDetachedDraft.value = false;
  if (selectedTarget.value?.kind === "dameng-native" && !Object.keys(editDraft.value).length) editDraft.value = { attributes: { ENABLE: { kind: "set", value: selectedJob.value?.enabled === true } } };
  initializeNativeJobDefinitionEdit(details.value, definitionEditDraft.value);
  retainedDrafts.set(selectedTargetKey.value, currentDraft());
  editDialogOpen.value = true;
}

async function previewEdit() {
  if (!details.value) return;
  try {
    await previewNative(selectedTarget.value?.kind === "dameng-native" ? buildNativeJobDamengEdit(details.value, editDraft.value) : buildNativeJobDefinitionEdit(details.value, engine.value, definitionEditDraft.value));
    if (nativePreview.value) editDialogOpen.value = false;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), 5000);
  }
}

function cellText(value: unknown): string {
  return value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}

watch(
  selectedTargetKey,
  (_next, previous) => {
    if (installingContext) return;
    if (previous) retainedDrafts.set(previous, currentDraft(previous));
    details.value = undefined;
    const retained = retainedDrafts.get(selectedTargetKey.value);
    editDraft.value = retained?.dameng ?? {};
    definitionEditDraft.value = retained?.definition ?? {};
    editDialogOpen.value = false;
    if (!detailTabs.value.includes(detailTab.value)) detailTab.value = "definition";
    selectedRead = loadDetails();
  },
  { flush: "sync" },
);
watch(connectionIdentity, () => {
  contextRefreshGeneration++;
  refreshingContext.value = false;
  native.invalidateContext();
  stopping.invalidateContext();
  pendingConfirmation.value = undefined;
  selectionChanges++;
  jobsRequest++;
  detailsRequest++;
  context.value = undefined;
  details.value = undefined;
  jobs.value = [];
  selectedExtra.value = undefined;
  selectedIdentity.value = undefined;
  selectedJobName.value = "";
  createOwner.value = "";
  listOffset.value = 0;
  editDraft.value = {};
  definitionEditDraft.value = {};
  retainedDrafts.clear();
  detachedDraft.value = undefined;
  viewingDetachedDraft.value = false;
  renameSource = undefined;
  editDialogOpen.value = false;
  createDialogOpen.value = false;
  creationPending.value = false;
  previewDialogOpen.value = false;
  void loadJobs();
});
watch(
  () => nativeJobAdminEngine(props.connection),
  () => {
    if (context.value) {
      if (!supported.value) {
        native.invalidatePreview();
        stopping.invalidatePreview();
        previewDialogOpen.value = false;
      }
      return;
    }
    if (refreshingContext.value || disposed) return;
    jobsRequest++;
    detailsRequest++;
    details.value = undefined;
    native.invalidatePreview();
    stopping.invalidatePreview();
    void loadJobs();
  },
);
watch(
  () => props.initialSelection,
  (selection) => {
    if (!selection) return;
    kind.value = selection.kind;
    selectedIdentity.value = selection;
    selectedExtra.value = undefined;
    listOffset.value = 0;
    void loadJobs();
  },
);
onMounted(() => void loadJobs());
watch([search, ownerFilter], () => {
  jobsRequest++;
  listOffset.value = 0;
  if (searchTimer) clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    searchTimer = undefined;
    void loadJobs();
  }, 200);
});
onScopeDispose(() => {
  disposed = true;
  contextRefreshGeneration++;
  jobsRequest++;
  detailsRequest++;
  if (searchTimer) clearTimeout(searchTimer);
});
</script>

<template>
  <div class="flex h-full min-h-0 flex-col bg-background">
    <div class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
      <CalendarClock class="h-4 w-4 text-primary" />
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-semibold">{{ t(isDameng ? "damengJobAdmin.title" : "nativeJobs.title") }}</div>
        <div class="truncate text-[11px] text-muted-foreground">{{ connection.name }}</div>
      </div>
      <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="loadingJobs || refreshingContext || applying" @click="refreshContext">
        <Loader2 v-if="loadingJobs || refreshingContext" class="h-3.5 w-3.5 animate-spin" />
        <RefreshCcw v-else class="h-3.5 w-3.5" />
        {{ t("contextMenu.refreshChildren") }}
      </Button>
      <Button v-if="isDameng" size="sm" variant="outline" class="h-8 gap-1.5" :disabled="jobEnvironmentReady || !supported || refreshingContext" :title="jobEnvironmentReady ? t('damengJobAdmin.environmentReady') : t('damengJobAdmin.initEnvironment')" @click="previewCreateEnvironment">
        <DatabaseZap class="h-3.5 w-3.5" />
        {{ jobEnvironmentReady ? t("damengJobAdmin.environmentReady") : t("damengJobAdmin.initEnvironment") }}
      </Button>
      <Button size="sm" class="h-8 gap-1.5" :disabled="nativeBusy || !jobEnvironmentReady || !context" @click="openCreate">
        <Plus class="h-3.5 w-3.5" />
        {{ t("damengJobAdmin.newJob") }}
      </Button>
    </div>

    <div v-if="!supported" class="m-4 rounded border border-dashed p-4 text-sm text-muted-foreground">
      {{ t("nativeJobs.unsupported") }}
    </div>

    <div v-else class="grid min-h-0 flex-1 grid-cols-[300px_minmax(0,1fr)]">
      <aside class="flex min-h-0 flex-col border-r">
        <div class="grid gap-2 border-b p-2">
          <select v-model="kind" :disabled="refreshingContext" :aria-label="t('nativeJobs.kind')" class="h-9 rounded border bg-background px-2 text-sm" @change="changeKind">
            <option v-for="value in kinds" :key="value" :value="value">{{ t(`nativeJobs.kinds.${value}`) }}</option>
          </select>
          <Input v-if="!isDameng" v-model="ownerFilter" :disabled="refreshingContext" class="h-8 text-xs" :aria-label="t('nativeJobs.ownerFilter')" :placeholder="t('nativeJobs.ownerFilter')" />
          <Input v-model="search" :disabled="refreshingContext" class="h-8 text-xs" :placeholder="t('damengJobAdmin.searchJob')" />
        </div>
        <div v-if="loadError" class="m-2 rounded border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">
          <div class="mb-1 flex items-center gap-1 font-medium"><AlertTriangle class="h-3.5 w-3.5" />{{ t("damengJobAdmin.loadFailed") }}</div>
          <div class="break-all">{{ loadError }}</div>
        </div>
        <div v-else-if="!jobEnvironmentReady" class="m-2 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-300">
          <div class="mb-1 flex items-center gap-1 font-medium"><AlertTriangle class="h-3.5 w-3.5" />{{ t("damengJobAdmin.environmentMissingTitle") }}</div>
          <div>{{ t("damengJobAdmin.environmentMissingHint") }}</div>
        </div>
        <div class="min-h-0 flex-1 overflow-auto p-2">
          <button
            v-for="job in filteredJobs"
            :key="nativeJobRefKey(job.ref)"
            type="button"
            class="mb-1 w-full rounded border px-2 py-2 text-left text-xs transition hover:bg-accent"
            :class="selectedTargetKey === nativeJobRefKey(job.ref) ? 'border-primary bg-primary/10' : 'border-transparent'"
            @click="selectJob(job)"
          >
            <div class="flex items-center gap-2">
              <span class="min-w-0 flex-1 truncate font-medium">{{ job.name }}</span>
              <Badge :variant="job.enabled ? 'default' : 'secondary'" class="h-5 px-1.5 text-[10px]">{{ job.enabled === null ? t("nativeJobs.unknown") : job.enabled ? t("damengJobAdmin.enabled") : t("damengJobAdmin.disabled") }}</Badge>
            </div>
            <div class="mt-1 truncate text-[11px] text-muted-foreground">{{ job.owner || "-" }} · {{ job.state || t("nativeJobs.unknown") }}</div>
          </button>
          <div v-if="!loadingJobs && !loadError && jobEnvironmentReady && filteredJobs.length === 0" class="p-6 text-center text-xs text-muted-foreground">
            {{ t(search.trim() ? "nativeJobs.noMatches" : "nativeJobs.emptyJobs") }}
          </div>
        </div>
        <div class="flex shrink-0 items-center justify-between border-t p-2 text-xs">
          <Button
            size="sm"
            variant="ghost"
            :disabled="loadingJobs || listOffset === 0"
            @click="
              listOffset = Math.max(0, listOffset - pageSize);
              loadJobs();
            "
            >{{ t("nativeJobs.previousPage") }}</Button
          >
          <span>{{ jobs.length ? listOffset + 1 : 0 }}–{{ listOffset + jobs.length }}</span>
          <Button
            size="sm"
            variant="ghost"
            :disabled="loadingJobs || !listTruncated"
            @click="
              listOffset += pageSize;
              loadJobs();
            "
            >{{ t("nativeJobs.nextPage") }}</Button
          >
        </div>
      </aside>

      <main class="flex min-h-0 flex-col">
        <div v-if="detachedDraft" class="flex flex-wrap items-center gap-2 border-b border-amber-500/40 p-3 text-sm">
          <span>{{ t("nativeJobs.detachedDraft") }}</span>
          <Button
            size="sm"
            variant="outline"
            @click="
              viewingDetachedDraft = true;
              editDialogOpen = true;
            "
            >{{ t("nativeJobs.viewRetainedDraft") }}</Button
          >
        </div>
        <div v-if="selectedJob" class="flex shrink-0 flex-wrap items-center gap-2 border-b p-3">
          <div class="min-w-0 flex-1">
            <div class="truncate text-sm font-semibold">{{ selectedJob.owner ? `${selectedJob.owner} · ` : "" }}{{ selectedJob.name }}</div>
            <div class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
              <Badge v-if="selectedRunning" variant="outline" class="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-300">{{ t("damengJobAdmin.running") }}</Badge>
              <span class="truncate">{{ selectedJob.comments || t("damengJobAdmin.noDescription") }}</span>
            </div>
          </div>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="!usableBaseline || nativeBusy" @click="editJob"> <Pencil class="h-3.5 w-3.5" />{{ t("nativeJobs.editJob") }} </Button>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="!usableBaseline || nativeBusy" @click="previewControl('run')">
            <Play class="h-3.5 w-3.5" />
            {{ t(selectedTarget?.kind === "legacy" && engine !== "dameng" ? "nativeJobs.runForeground" : "damengJobAdmin.runAsync") }}
          </Button>
          <Button
            v-if="stopAvailable"
            size="sm"
            variant="outline"
            class="h-8 gap-1.5"
            :disabled="!usableBaseline || stopBusy || (selectedRunning === false && !dispatchedRun)"
            :title="selectedRunning === undefined ? t('nativeJobs.runningUnknownHint') : selectedRunning ? t('damengJobAdmin.stopRunning') : t('damengJobAdmin.stopRunningDisabled')"
            @click="previewControl('stop')"
          >
            <Square class="h-3.5 w-3.5" />
            {{ t("damengJobAdmin.stopRunning") }}
          </Button>
          <Button v-if="engine === 'oracle' && selectedTarget?.kind === 'scheduler'" size="sm" variant="outline" class="h-8" :disabled="!usableBaseline || stopBusy || (selectedRunning === false && !dispatchedRun)" @click="previewControl('stop', true)">{{ t("nativeJobs.forceStop") }}</Button>
          <Button size="sm" variant="outline" class="h-8 gap-1.5" :disabled="!usableBaseline || nativeBusy" @click="previewControl(selectedJob.enabled ? 'disable' : 'enable')">
            <Power class="h-3.5 w-3.5" />
            {{ selectedJob.enabled ? t("damengJobAdmin.disable") : t("damengJobAdmin.enable") }}
          </Button>
          <Button v-if="damengCatalogSelection" size="sm" variant="outline" class="h-8 gap-1.5" :disabled="!usableBaseline || nativeBusy" @click="previewControl('clear-history')">
            <XCircle class="h-3.5 w-3.5" />
            {{ t("damengJobAdmin.clearHistories") }}
          </Button>
          <Button size="sm" variant="destructive" class="h-8 gap-1.5" :disabled="!usableBaseline || nativeBusy" @click="previewControl('drop')">
            <Trash2 class="h-3.5 w-3.5" />
            {{ t("damengJobAdmin.dropJob") }}
          </Button>
        </div>
        <p v-if="selectedJob && !stopAvailable" class="border-b px-3 py-2 text-xs text-muted-foreground">{{ t("nativeJobs.legacyNoStop") }}</p>
        <p v-if="selectedJob && details && !usableBaseline" role="status" class="border-b border-amber-500/40 p-3 text-sm">{{ t("nativeJobs.baselineUnavailable") }}</p>

        <div v-if="nativeError" role="alert" class="border-b border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{{ nativeError }}</div>
        <section v-for="{ owner: execution, result: nativeResult, previous: previousContextResult, target: resultTarget } in nativeResults" :key="nativeResult.status.operationId" aria-live="polite" class="grid shrink-0 gap-2 border-b p-3 text-sm">
          <p v-if="execution === stopping" class="font-medium">{{ t("damengJobAdmin.stopRunning") }}</p>
          <p v-if="previousContextResult" class="text-muted-foreground">{{ t("nativeJobs.previousContext") }} · {{ resultTarget?.kind === "scheduler" ? `${resultTarget.owner} · ${resultTarget.name}` : resultTarget?.kind === "legacy" ? resultTarget.jobId : resultTarget?.name }}</p>
          <div class="flex flex-wrap items-center gap-2">
            <Loader2 v-if="nativeResult.status.state !== 'finished'" class="h-4 w-4 animate-spin" />
            <strong>{{
              t(
                nativeResult.status.state === "finished" && nativeResult.status.outcome === "accepted" && nativeResult.status.reason === "native_job_legacy_interval_expression_not_readable"
                  ? "nativeJobs.damengIntervalAccepted"
                  : `nativeJobs.outcomes.${nativeResult.status.state === "finished" ? nativeResult.status.outcome : "running"}`,
              )
            }}</strong>
            <Button v-if="nativeResult.status.state !== 'finished'" size="sm" variant="outline" @click="execution.cancel">{{ t("nativeJobs.cancelFollowing") }}</Button>
            <Button v-if="!previousContextResult && (nativeResult.status.outcome === 'partial' || nativeResult.status.outcome === 'unknown')" size="sm" variant="outline" :disabled="loadingDetails || refreshingContext" @click="loadDetails">{{ t("nativeJobs.readAgain") }}</Button>
            <Button
              v-if="execution === native && !previousContextResult && nativeResult.status.state === 'finished' && (nativeResult.status.outcome === 'partial' || nativeResult.status.outcome === 'unknown')"
              size="sm"
              variant="outline"
              :disabled="refreshingContext || (!creationPending && !details)"
              @click="correctDraft"
              >{{ t("nativeJobs.correctDraft") }}</Button
            >
            <Button v-if="nativeResult.status.state === 'finished' && ['partial', 'unknown'].includes(nativeResult.status.outcome) && nativeResult.status.steps.some((step) => step.id === 'rename')" size="sm" variant="outline" :disabled="execution.observing.value" @click="execution.observe">{{
              t("nativeJobs.checkResult")
            }}</Button>
            <Button v-else-if="nativeResult.error" size="sm" variant="outline" @click="execution.refresh">{{ t("nativeJobs.checkResult") }}</Button>
          </div>
          <p v-if="nativeResult.error" class="text-muted-foreground">{{ t("nativeJobs.operationStatusUnavailable") }}</p>
          <p v-else-if="nativeResult.status.reason === 'native_job_legacy_runtime_update_required'" class="text-muted-foreground">{{ t("nativeJobs.legacyRuntimeUpdateRequired") }}</p>
          <div v-if="nativeResult.status.executionObservation" class="grid gap-2 border-t pt-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <strong>{{ t("nativeJobs.executionObservation") }}</strong>
              <Button size="sm" variant="outline" :disabled="execution.observing.value || nativeResult.status.state !== 'finished'" @click="execution.observe">{{ t("nativeJobs.observeExecution") }}</Button>
            </div>
            <p>{{ t(nativeResult.status.executionObservation.association === "uncertain" ? "nativeJobs.associationUncertain" : "nativeJobs.observationUnavailable") }}</p>
          </div>
          <details v-if="nativeResult.status.executionObservation || nativeResult.error || nativeResult.status.reason || ['partial', 'unknown'].includes(nativeResult.status.outcome)" class="text-xs text-muted-foreground">
            <summary class="cursor-pointer">{{ t("nativeJobs.observationNativeDetails") }}</summary>
            <p v-if="nativeResult.error" class="break-words py-2">{{ nativeResult.error }}</p>
            <p v-if="nativeResult.status.reason" class="break-words py-2">{{ nativeResult.status.reason }}</p>
            <ol v-if="nativeResult.status.outcome === 'partial' || nativeResult.status.outcome === 'unknown'" class="max-h-40 overflow-auto">
              <li v-for="step in nativeResult.status.steps" :key="step.id" class="flex gap-3 py-1">
                <span class="min-w-0 flex-1 break-words">{{ step.id }}</span
                ><span>{{ t(`nativeJobs.stepStates.${step.state}`) }}</span
                ><span v-if="step.reason">{{ step.reason }}</span>
              </li>
            </ol>
            <template v-if="nativeResult.status.executionObservation">
              <p class="py-2">{{ t("nativeJobs.observationReadStatus", { running: nativeResult.status.executionObservation.running.status, history: nativeResult.status.executionObservation.history.status }) }}</p>
              <ul v-if="nativeResult.status.executionObservation.candidates.length" class="grid max-h-40 gap-2 overflow-auto">
                <li v-for="candidate in nativeResult.status.executionObservation.candidates" :key="candidate.nativeKey" class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <code>{{ candidate.nativeKey }}</code>
                  <span>{{ candidate.phase === "not-observed" ? t("nativeJobs.instanceNotObserved") : candidate.phase === "running" ? t("nativeJobs.running") : t("damengJobAdmin.histories") }}</span>
                  <span v-if="candidate.row.STATUS">{{ candidate.row.STATUS }}</span>
                  <span class="text-muted-foreground">{{ t(candidate.evidence === "new-history" ? "nativeJobs.newlyObserved" : "nativeJobs.observedInstance") }}</span>
                </li>
              </ul>
              <p v-else>{{ t("nativeJobs.observationEmpty") }}</p>
              <p class="py-2">{{ t("nativeJobs.observationTimestamp", { time: nativeResult.status.executionObservation.observedAt }) }}</p>
              <pre class="max-h-64 overflow-auto whitespace-pre-wrap break-words">{{ JSON.stringify(nativeResult.status.executionObservation, null, 2) }}</pre>
            </template>
          </details>
        </section>

        <div v-if="selectedJob" class="flex h-10 shrink-0 items-center gap-1 border-b px-3">
          <Button v-for="tab in detailTabs" :key="tab" size="sm" :variant="detailTab === tab ? 'secondary' : 'ghost'" class="h-7 px-2 text-xs" @click="detailTab = tab">{{
            t(tab === "definition" ? "nativeJobs.attributes" : tab === "arguments" || tab === "running" ? `nativeJobs.${tab}` : `damengJobAdmin.${tab}`)
          }}</Button>
          <Loader2 v-if="loadingDetails" class="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
        </div>

        <div class="min-h-0 flex-1 overflow-auto p-3">
          <div v-if="!jobEnvironmentReady" class="flex h-full items-center justify-center">
            <div class="max-w-xl rounded-lg border border-dashed p-5 text-sm">
              <div class="mb-2 flex items-center gap-2 font-semibold"><DatabaseZap class="h-4 w-4 text-primary" />{{ t("damengJobAdmin.environmentMissingTitle") }}</div>
              <p class="mb-4 text-xs leading-5 text-muted-foreground">{{ t("damengJobAdmin.environmentMissingDescription") }}</p>
              <Button size="sm" class="gap-1.5" @click="previewCreateEnvironment">
                <DatabaseZap class="h-3.5 w-3.5" />
                {{ t("damengJobAdmin.initEnvironment") }}
              </Button>
            </div>
          </div>
          <div v-else-if="!selectedJob" class="flex h-full items-center justify-center text-sm text-muted-foreground">
            {{ t("damengJobAdmin.selectJob") }}
          </div>
          <div v-else-if="detailError" class="rounded border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            {{ detailError }}
          </div>
          <div v-if="metadataWarning" role="status" class="mb-3 rounded border border-amber-500/40 p-3 text-sm">{{ metadataWarning }}</div>
          <dl v-if="!detailError && detailTab === 'definition' && detailRows[0]" class="grid gap-x-8 gap-y-4 sm:grid-cols-2">
            <div v-for="column in detailColumns" :key="column" class="min-w-0 border-b pb-3" :class="['JOB_ACTION', 'WHAT', 'COMMAND'].includes(column) ? 'sm:col-span-2' : ''">
              <dt class="mb-1.5 text-xs font-medium text-muted-foreground">{{ column }}</dt>
              <dd class="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-sm">{{ detailRows[0][column] === null ? "NULL" : cellText(detailRows[0][column]) }}</dd>
            </div>
          </dl>
          <table v-else-if="!detailError && detailRows.length" class="w-full min-w-max border-collapse text-xs">
            <thead>
              <tr class="border-b bg-muted/40">
                <th v-for="column in detailColumns" :key="column" class="px-2 py-2 text-left font-medium">{{ column }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in detailRows" :key="index" class="border-b hover:bg-muted/30">
                <td v-for="column in detailColumns" :key="column" class="max-w-[360px] px-2 py-2 align-top">
                  <span class="block truncate" :title="cellText(row[column])">{{ cellText(row[column]) || "-" }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <section v-if="!detailError && detailTab === 'definition' && details?.legacyDefinition" class="mt-5 grid gap-3 border-t pt-4">
            <h3 class="text-sm font-medium">{{ t("nativeJobs.kinds.legacy") }} · DBMS_JOB</h3>
            <dl v-if="details.legacyDefinition.status === 'available'" class="grid gap-x-8 gap-y-4 sm:grid-cols-2">
              <div v-for="(value, column) in details.legacyDefinition.value" :key="column" class="min-w-0 border-b pb-3" :class="column === 'WHAT' ? 'sm:col-span-2' : ''">
                <dt class="mb-1.5 text-xs font-medium text-muted-foreground">{{ column }}</dt>
                <dd class="max-h-72 overflow-auto whitespace-pre-wrap break-words font-mono text-sm">{{ value === null ? "NULL" : cellText(value) }}</dd>
              </div>
            </dl>
            <p v-else role="status" class="text-sm text-muted-foreground">{{ details.legacyDefinition.status === "empty" ? t("damengJobAdmin.emptyDetails") : t("nativeJobs.partitionUnavailable", { status: details.legacyDefinition.status }) }}</p>
          </section>
          <div v-if="selectedJob && !loadingDetails && !detailError && (detailMetadata?.status === 'empty' || (detailMetadata?.status === 'available' && detailRows.length === 0))" class="p-8 text-center text-xs text-muted-foreground">
            {{ t("damengJobAdmin.emptyDetails") }}
          </div>
        </div>
      </main>
    </div>

    <Dialog v-model:open="editDialogOpen">
      <DialogContent class="flex max-h-[90vh] max-w-4xl flex-col">
        <DialogHeader
          ><DialogTitle
            >{{ viewingDetachedDraft ? t("nativeJobs.viewRetainedDraft") : t("nativeJobs.editJob") }} ·
            {{ viewingDetachedDraft ? (detachedDraft?.anchor?.details.snapshot.ref.kind === "legacy" ? detachedDraft.anchor.details.snapshot.ref.jobId : detachedDraft?.anchor?.details.snapshot.ref.name) : selectedJob?.name }}</DialogTitle
          ></DialogHeader
        >
        <div v-if="viewingDetachedDraft && detachedDraft?.anchor" class="min-h-0 overflow-auto p-1">
          <NativeJobDamengEditor v-if="detachedDraft.anchor.details.snapshot.ref.kind === 'dameng-native'" :model-value="detachedDraft.dameng" :details="detachedDraft.anchor.details" disabled />
          <NativeJobDefinitionEditor v-else :model-value="detachedDraft.definition" :engine="detachedDraft.anchor.engine" :kind="detachedDraft.anchor.details.snapshot.ref.kind" :details="detachedDraft.anchor.details" disabled />
        </div>
        <pre v-else-if="viewingDetachedDraft && detachedDraft" class="max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm">{{ JSON.stringify({ attributes: detachedDraft.definition.attributes, arguments: detachedDraft.definition.arguments, dameng: detachedDraft.dameng }, null, 2) }}</pre>
        <div v-else-if="details" class="min-h-0 overflow-auto p-1">
          <NativeJobDamengEditor v-if="selectedTarget?.kind === 'dameng-native'" v-model="editDraft" :details="details" :disabled="nativeBusy" />
          <NativeJobDefinitionEditor v-else-if="selectedTarget" v-model="definitionEditDraft" :engine="engine" :kind="selectedTarget.kind" :details="details" :scope="context?.scope" :disabled="nativeBusy" />
        </div>
        <p v-if="native.error.value" role="alert" class="text-sm text-destructive">{{ nativeError }}</p>
        <DialogFooter>
          <Button variant="outline" @click="editDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button v-if="!viewingDetachedDraft" :disabled="!details || nativeBusy" @click="previewEdit"><Loader2 v-if="native.preparing.value" class="mr-1 h-4 w-4 animate-spin" />{{ t("damengJobAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="createDialogOpen">
      <DialogContent class="flex max-h-[90vh] max-w-4xl flex-col">
        <DialogHeader>
          <DialogTitle>{{ t("damengJobAdmin.newJob") }}{{ createKind === "legacy" ? "" : ` · ${createName}` }}</DialogTitle>
        </DialogHeader>
        <div class="grid min-h-0 gap-4 overflow-auto p-1 text-sm">
          <label class="grid gap-1.5"
            ><span>{{ t("nativeJobs.kind") }}</span
            ><select v-model="createKind" :aria-label="t('nativeJobs.createKind')" class="h-9 rounded border bg-background px-2" :disabled="nativeBusy">
              <option v-for="value in kinds" :key="value" :value="value">{{ t(`nativeJobs.kinds.${value}`) }}</option>
            </select></label
          >
          <label v-if="createKind !== 'dameng-native'" class="grid gap-1.5"
            ><span>{{ createKind === "legacy" ? "SCHEMA_USER" : t("nativeJobs.owner") }}</span
            ><Input v-model="createOwner" :aria-label="createKind === 'legacy' ? 'SCHEMA_USER' : t('nativeJobs.owner')" class="h-9"
          /></label>
          <label v-if="createKind !== 'legacy'" class="grid gap-1.5">
            <span>{{ t("damengJobAdmin.jobName") }}</span>
            <Input v-model="createName" :aria-label="t('damengJobAdmin.jobName')" class="h-9" />
          </label>
          <NativeJobDamengEditor v-if="createKind === 'dameng-native'" v-model="createDraft" :disabled="nativeBusy" />
          <NativeJobDefinitionEditor v-else :key="createKind" v-model="definitionCreateDraft" :engine="engine" :kind="createKind" :scope="context?.scope" :owner="createOwner" :disabled="nativeBusy" />
        </div>
        <p v-if="native.error.value" role="alert" class="text-sm text-destructive">{{ nativeError }}</p>
        <DialogFooter>
          <Button variant="outline" @click="createDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :disabled="!canCreateJob" @click="previewCreateJob">{{ t("damengJobAdmin.previewSql") }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="previewDialogOpen">
      <DialogContent class="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ t("damengJobAdmin.sqlPreview") }}</DialogTitle>
        </DialogHeader>
        <pre class="max-h-[50vh] overflow-auto rounded-md border bg-muted/30 p-3 text-xs"><code>{{ previewText }}</code></pre>
        <p v-if="pendingNative && legacyRunRestoresScheduling" role="note" class="text-sm text-amber-700 dark:text-amber-400">{{ t("nativeJobs.legacyRunRestoresScheduling") }}</p>
        <p v-if="pendingNative && nativePreview?.target?.kind === 'scheduler' && nativePreview.steps.some((step) => step.id === 'pause')" role="note" class="text-sm text-muted-foreground">{{ t("nativeJobs.transitionPreviewHint") }}</p>
        <p v-if="pendingNative && previewExecution.error.value" role="alert" class="text-sm text-destructive">{{ nativeError }}</p>
        <DialogFooter>
          <Button variant="outline" @click="previewDialogOpen = false">{{ t("common.cancel") }}</Button>
          <Button :variant="pendingDanger ? 'destructive' : 'default'" :disabled="applying || confirmationBusy || !previewText" @click="applyPendingSql">
            <Loader2 v-if="applying || confirmationBusy" class="mr-1 h-3.5 w-3.5 animate-spin" />
            {{ t("damengJobAdmin.applySql") }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

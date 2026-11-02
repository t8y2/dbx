<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2 } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import SourceMigrationPreview, { type SourceMigrationEntry } from "@/components/objects/SourceMigrationPreview.vue";
import OracleTypeDataMappingPanel from "@/components/objects/OracleTypeDataMappingPanel.vue";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { executeOracleTypeManagement, OracleTypeManagementFailure, prepareOracleTypeManagement, typeManagementObjectKey, type OracleTypeManagementDraft, type TypeManagementObjectDraft } from "@/lib/table/oracleTypeManagement";
import { finishOracleTypeManagementRequest, oracleTypeManagementRequest, type TypeManagementRequest } from "@/lib/table/oracleTypeManagementRequest";
import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useToast } from "@/composables/useToast";
import * as api from "@/lib/backend/api";

const { t } = useI18n();
const { toast } = useToast();
const queryStore = useQueryStore();
const connectionStore = useConnectionStore();
const plan = ref<OracleTypeManagementDraft | null>(null);
const drafts = ref<Record<string, string>>({});
const tabId = ref("");
const loading = ref(false);
const executing = ref(false);
const dataBusy = ref(false);
const error = ref("");
const notice = ref("");
const errorRef = ref<HTMLElement | null>(null);
let request: TypeManagementRequest | null = null;
let tabSqlAtOpen = "";
let serial = 0;
const stopRequested = ref(false);
const maintenanceConfirmed = ref(false);
const busy = computed(() => loading.value || executing.value || dataBusy.value);
const deleting = computed(() => plan.value?.operation.startsWith("delete") ?? request?.operation.startsWith("delete"));
const statements = computed(() => (plan.value?.requiresReverify ? [] : (plan.value?.steps.filter((step) => step.state !== "confirmed").map((step) => step.sql) ?? [])));
const maintenanceRequired = computed(() => !!plan.value && (plan.value.steps.some((step) => step.kind === "drop-dependent") || (!plan.value.operation.endsWith("body") && plan.value.originalSnapshot.persistentReferences.length > 0)));
const entries = computed<SourceMigrationEntry[]>(
  () =>
    plan.value?.drafts.map((draft) => {
      const key = typeManagementObjectKey(draft);
      const root = draft.owner === plan.value!.target.owner && draft.name === plan.value!.target.name;
      const original = plan.value!.originalSnapshot.objects.find((object) => typeManagementObjectKey(object) === key);
      return {
        key,
        owner: draft.owner,
        name: draft.name,
        objectType: draft.objectType === "TRIGGER" ? `${draft.objectType} · ${original?.triggerEnabled === true ? "ENABLED" : original?.triggerEnabled === false ? "DISABLED" : t("common.unknown")}` : draft.objectType,
        source: original?.source ?? "",
        currentSource: (plan.value!.observedSnapshot ?? plan.value!.lastSnapshot).objects.find((object) => typeManagementObjectKey(object) === key)?.source ?? undefined,
        draft: draft.source,
        generated: plan.value!.requiresReverify
          ? ""
          : plan
              .value!.steps.filter((step) => typeManagementObjectKey(step.object) === key && step.state !== "confirmed")
              .map((step) => step.sql)
              .join("\n\n"),
        rewriteRequired: !(deleting.value && root),
        showOriginal: true,
      };
    }) ?? [],
);
const issues = computed(() => {
  const visible = [...(plan.value?.issues ?? [])];
  for (const step of plan.value?.steps ?? [])
    if (["failed", "unknown"].includes(step.state) && !visible.some((issue) => issue.objectKey === typeManagementObjectKey(step.object))) visible.push({ code: "write-result", objectKey: typeManagementObjectKey(step.object), message: step.message ?? step.state, repairable: true });
  return visible.map((issue) => {
    const object = plan.value?.originalSnapshot.objects.find((object) => typeManagementObjectKey(object) === issue.objectKey);
    return { ...issue, label: object ? `${object.objectType} · ${object.owner}.${object.name}` : undefined };
  });
});

watch(
  () => oracleTypeManagementRequest.value?.id,
  async () => {
    const current = oracleTypeManagementRequest.value;
    if (!current) return;
    request = current;
    const epoch = ++serial;
    loading.value = true;
    plan.value = null;
    drafts.value = {};
    error.value = "";
    notice.value = "";
    tabId.value = "";
    stopRequested.value = false;
    maintenanceConfirmed.value = false;
    try {
      const target = current.target;
      await connectionStore.ensureConnected(target.connectionId);
      if (epoch !== serial) return;
      const existing = current.tabId
        ? queryStore.tabs.find((tab) => tab.id === current.tabId)
        : queryStore.tabs.find((tab) => {
            const pending = tab.typeManagementDraft;
            return pending && pending.state !== "complete" && pending.target.connectionId === target.connectionId && pending.target.database === target.database && pending.target.owner === target.owner && pending.target.name === target.name;
          });
      const previous = existing?.typeManagementDraft?.state !== "complete" ? existing?.typeManagementDraft : undefined;
      const operation = previous?.operation ?? current.operation;
      if (previous) notice.value = t("objects.typeManagementExistingDraft");
      const values = previous?.drafts.map((draft) => ({ ...draft })) ?? [];
      const kind = operation.endsWith("body") ? "TYPE BODY" : "TYPE";
      if (current.source !== undefined && operation === current.operation && !previous?.steps.some((step) => step.state !== "not-sent")) {
        const key = { owner: target.owner, name: target.name, objectType: kind };
        const index = values.findIndex((item) => typeManagementObjectKey(item) === typeManagementObjectKey(key));
        const value = { ...key, source: current.source };
        if (index < 0) values.push(value);
        else values[index] = value;
      }
      const prepared = await prepareOracleTypeManagement(target, operation, values, previous);
      if (current.baseSource !== undefined && operation === current.operation && !operation.startsWith("delete") && !previous?.steps.some((step) => step.state !== "not-sent")) {
        const baseline = await api.buildOracleTypeManagementSql({ databaseType: target.databaseType, operation: kind === "TYPE BODY" ? "save_body" : "save_spec", owner: target.owner, name: target.name, source: current.baseSource });
        const original = prepared.originalSnapshot.objects.find((object) => object.owner === target.owner && object.name === target.name && object.objectType === kind);
        if (!baseline.sourceFingerprint || baseline.sourceFingerprint !== original?.sourceFingerprint) {
          prepared.issues.push({
            code: "loaded-source-changed",
            objectKey: typeManagementObjectKey({ owner: target.owner, name: target.name, objectType: kind }),
            message: "The TYPE source changed since it was loaded. Review the live original definition and your draft, then revalidate.",
            repairable: true,
          });
          prepared.executable = false;
          prepared.state = "draft";
        }
      }
      if (epoch !== serial) return;
      plan.value = prepared;
      drafts.value = Object.fromEntries(prepared.drafts.map((draft) => [typeManagementObjectKey(draft), draft.source]));
      if (existing) tabId.value = existing.id;
      else {
        const selected = prepared.drafts.find((draft) => draft.owner === target.owner && draft.name === target.name && draft.objectType === kind);
        const original = prepared.originalSnapshot.objects.find((object) => object.owner === target.owner && object.name === target.name && object.objectType === kind);
        tabId.value = queryStore.createTab(target.connectionId, target.database, `${kind} · ${target.name}`, "query", target.owner, selected?.source ?? original?.source ?? "", undefined, { forceNew: true, sourceView: true });
        queryStore.setObjectSource(tabId.value, { schema: target.owner, name: target.name, objectType: kind === "TYPE BODY" ? "TYPE_BODY" : "TYPE" });
      }
      tabSqlAtOpen = queryStore.tabs.find((tab) => tab.id === tabId.value)?.sql ?? "";
      await persist(prepared);
    } catch (cause) {
      if (epoch === serial) {
        error.value = cause instanceof Error ? cause.message : String(cause);
        if (plan.value) plan.value.executable = false;
      }
    } finally {
      if (epoch === serial) loading.value = false;
    }
  },
  { immediate: true },
);

function currentDrafts(): TypeManagementObjectDraft[] {
  return plan.value?.drafts.map((draft) => ({ ...draft, source: drafts.value[typeManagementObjectKey(draft)] ?? draft.source })) ?? [];
}

function edit(key: string, source: string) {
  if (!plan.value || busy.value) return;
  drafts.value[key] = source;
  plan.value.drafts = currentDrafts();
  plan.value.executable = false;
  plan.value.requiresReverify = true;
  plan.value.state = "draft";
  plan.value.revision++;
  maintenanceConfirmed.value = false;
  const tab = queryStore.tabs.find((tab) => tab.id === tabId.value);
  if (tab) tab.typeManagementDraft = JSON.parse(JSON.stringify({ ...plan.value, drafts: currentDrafts() }));
}

async function persist(record: OracleTypeManagementDraft) {
  await queryStore.persistTypeManagementDraft(tabId.value, record);
}

function isRequestCurrent() {
  const pending = request;
  return !!pending && oracleTypeManagementRequest.value?.id === pending.id && pending.isCurrent?.() !== false;
}

async function revalidate() {
  if (!plan.value || busy.value) return;
  const previous = plan.value;
  const epoch = serial;
  loading.value = true;
  error.value = "";
  maintenanceConfirmed.value = false;
  try {
    const next = await prepareOracleTypeManagement(previous.target, previous.operation, currentDrafts(), previous);
    if (epoch !== serial) return;
    plan.value = next;
    drafts.value = Object.fromEntries(next.drafts.map((draft) => [typeManagementObjectKey(draft), draft.source]));
    await persist(next);
    if (next.state === "complete" && request) await completePlan(next, request);
  } catch (cause) {
    if (epoch === serial) {
      error.value = cause instanceof Error ? cause.message : String(cause);
      if (plan.value) plan.value.executable = false;
    }
  } finally {
    if (epoch === serial) loading.value = false;
  }
}

async function execute() {
  const approved = plan.value;
  const pending = request;
  if (!approved?.executable || !pending || busy.value || (maintenanceRequired.value && !maintenanceConfirmed.value)) return;
  const approvedDrafts = JSON.stringify(currentDrafts());
  const isCurrent = () => oracleTypeManagementRequest.value?.id === pending.id && pending.isCurrent?.() !== false && JSON.stringify(currentDrafts()) === approvedDrafts;
  executing.value = true;
  error.value = "";
  stopRequested.value = false;
  try {
    const completed = await executeWithProductionSqlGuard({
      connection: connectionStore.getConfig(approved.target.connectionId),
      database: approved.target.database,
      sql: statements.value.join("\n\n"),
      source: t("production.sourceObjectSource"),
      execute: async () => {
        if (!isCurrent()) return false;
        await executeOracleTypeManagement(approved, { persist, isCurrent, shouldStop: () => stopRequested.value });
        return true;
      },
    });
    if (!completed) return;
    await completePlan(approved, pending);
  } catch (cause) {
    if (cause instanceof OracleTypeManagementFailure) plan.value = cause.plan;
    error.value = cause instanceof Error ? cause.message : String(cause);
    await nextTick();
    errorRef.value?.focus();
  } finally {
    executing.value = false;
  }
}

async function completePlan(approved: OracleTypeManagementDraft, pending: TypeManagementRequest) {
  const tab = queryStore.tabs.find((tab) => tab.id === tabId.value);
  if (tab) {
    tab.typeSourceEditing = false;
    const selectedKind = approved.operation.endsWith("body") ? "TYPE BODY" : "TYPE";
    const saved = approved.drafts.find((draft) => draft.owner === approved.target.owner && draft.name === approved.target.name && draft.objectType === selectedKind);
    if (!approved.operation.startsWith("delete") && saved && tab.sql === tabSqlAtOpen) {
      queryStore.updateSql(tab.id, saved.source);
      queryStore.markTabClean(tab);
      queryStore.refreshObjectSourceTab(tab.id);
    }
  }
  try {
    await connectionStore.refreshObjectListTreeNode(approved.target.connectionId, approved.target.database, approved.target.owner);
  } catch (cause) {
    toast(t("objects.typeManagementRefreshFailed", { message: cause instanceof Error ? cause.message : String(cause) }), 6000);
  }
  finishOracleTypeManagementRequest(pending.id, { complete: approved.operation === pending.operation, target: approved.target, operation: approved.operation, snapshot: approved.lastSnapshot });
}

function close() {
  if (executing.value || dataBusy.value || !request) return;
  ++serial;
  finishOracleTypeManagementRequest(request.id, { complete: false, target: request.target, operation: request.operation });
  request = null;
}
onBeforeUnmount(() => {
  stopRequested.value = true;
  ++serial;
});
</script>

<template>
  <Dialog
    :open="!!oracleTypeManagementRequest"
    @update:open="
      (open) => {
        if (!open) close();
      }
    "
  >
    <DialogContent
      class="max-h-[calc(var(--dbx-viewport-height)-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[1000px]"
      @escape-key-down="
        (event) => {
          if (executing || dataBusy) event.preventDefault();
        }
      "
      @pointer-down-outside="
        (event) => {
          if (executing || dataBusy) event.preventDefault();
        }
      "
    >
      <DialogHeader>
        <DialogTitle>{{ t("objects.typeManagementTitle") }} · {{ plan?.target.owner ?? oracleTypeManagementRequest?.target.owner }}.{{ plan?.target.name ?? oracleTypeManagementRequest?.target.name }}</DialogTitle>
      </DialogHeader>
      <div class="min-h-0 space-y-4 overflow-y-auto pr-1">
        <p class="text-sm leading-relaxed text-muted-foreground">{{ t("objects.typeManagementNonAtomic") }}</p>
        <p class="text-sm text-muted-foreground">{{ t("objects.typeManagementScope") }}</p>
        <p v-if="notice" role="status" class="text-sm">{{ notice }}</p>
        <p v-if="deleting" class="rounded border border-destructive/40 bg-destructive/5 p-3 text-sm">{{ t((plan?.operation ?? oracleTypeManagementRequest?.operation) === "delete-body" ? "objects.typeManagementDeleteBody" : "objects.typeManagementDeleteSpec") }}</p>
        <p v-if="error" ref="errorRef" role="alert" tabindex="-1" class="whitespace-pre-wrap break-words rounded border border-destructive/40 p-3 text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{{ error }}</p>
        <SourceMigrationPreview
          :entries="entries"
          :issues="issues"
          :drafts="drafts"
          :statements="statements"
          :loading="loading"
          :validating="false"
          :executing="executing || dataBusy"
          :executable="!!plan?.executable"
          :ready="!!plan"
          :draft-label="t('objects.typeManagementDraftLabel')"
          :validation-pending-message="t('objects.typeManagementValidationPending')"
          @edit="edit"
          @validate="revalidate"
          @reload="revalidate"
        />
        <p v-if="plan?.nativeEvolution" role="status" class="text-sm leading-relaxed text-muted-foreground" data-native-type-evolution>{{ t("objects.typeManagementNativeEvolution") }}</p>
        <OracleTypeDataMappingPanel
          v-if="plan && !plan.nativeEvolution && !plan.operation.endsWith('body') && (plan.originalSnapshot.persistentReferences.length || plan.dataMappings.length)"
          :plan="plan"
          :disabled="loading || executing"
          :persist="persist"
          :is-current="isRequestCurrent"
          @update="plan = $event"
          @busy="dataBusy = $event"
        />
        <label v-if="maintenanceRequired" class="flex items-start gap-2 rounded border border-border p-3 text-sm leading-relaxed">
          <input v-model="maintenanceConfirmed" type="checkbox" :disabled="busy" class="mt-1 h-4 w-4 shrink-0 accent-primary" />
          <span>{{ t("objects.typeManagementMaintenance") }}</span>
        </label>
        <ol v-if="plan?.steps.some((step) => step.state !== 'not-sent')" class="space-y-2 border-t border-border pt-3 text-sm" aria-live="polite" data-type-execution-record>
          <li v-for="step in plan.steps" :key="step.id" class="space-y-1">
            <p>
              <span class="font-medium">{{ t(`objects.typeManagementState.${step.state}`) }}</span> · {{ step.object.objectType }} · {{ step.object.owner }}.{{ step.object.name }}
            </p>
            <p v-if="step.message" class="whitespace-pre-wrap text-muted-foreground">{{ step.message }}</p>
          </li>
        </ol>
        <details v-if="plan?.history.length" class="space-y-2 border-t pt-3 text-sm" data-type-execution-history>
          <summary class="cursor-pointer">{{ t("objects.typeManagementPreviousAttempts") }}</summary>
          <div v-for="(step, index) in plan.history" :key="`${step.id}:${index}`" class="space-y-1 pt-2">
            <p>{{ t(`objects.typeManagementState.${step.state}`) }} · {{ step.object.objectType }} · {{ step.object.owner }}.{{ step.object.name }}</p>
            <p v-if="step.message" class="whitespace-pre-wrap text-muted-foreground">{{ step.message }}</p>
            <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-xs">{{ step.sql }}</pre>
          </div>
        </details>
      </div>
      <DialogFooter>
        <Button variant="outline" :disabled="executing || dataBusy" @click="close">{{ t("objects.typeManagementKeepDraft") }}</Button>
        <Button v-if="executing" variant="outline" :disabled="stopRequested" @click="stopRequested = true">{{ t("objects.typeManagementStop") }}</Button>
        <Button :variant="deleting ? 'destructive' : 'default'" :disabled="busy || !plan?.executable || plan.requiresReverify || (maintenanceRequired && !maintenanceConfirmed)" data-type-management-confirm @click="execute">
          <Loader2 v-if="busy" class="h-4 w-4 animate-spin" />{{ t("objects.typeManagementConfirm") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

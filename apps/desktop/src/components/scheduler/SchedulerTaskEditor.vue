<script setup lang="ts">
// Task editor dialog: fully dynamic (provider → provider action → connection →
// provider config form → trigger → execution policy). Provider and action are
// locked after creation; config fields always come from the manifest, never
// from per-provider branches.
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AlertTriangle, Loader2 } from "@lucide/vue";
import { uuid } from "@/lib/common/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import * as schedulerApi from "@/lib/scheduler/schedulerApi";
import { schedulerErrorCode } from "@/lib/scheduler/schedulerApi";
import { defaultExecutionPolicy, defaultTaskName, defaultTrigger, draftFormValues, modeForTrigger } from "@/lib/scheduler/schedulerDraft";
import { findProvider, findTrigger, triggerId as fullTriggerId, withStoredTriggerId } from "@/lib/scheduler/schedulerProviders";
import { configFromFormValues, validateFormFields, type SchedulerFormValues } from "@/lib/scheduler/schedulerForm";
import type { SchedulerTaskProviderDescriptor, SchedulerTaskTriggerContribution, TaskDefinition } from "@/lib/scheduler/schedulerTypes";
import SchedulerExecutionPolicyFields from "./SchedulerExecutionPolicyFields.vue";
import SchedulerTaskFormRenderer from "./SchedulerTaskFormRenderer.vue";
import SchedulerTriggerFields from "./SchedulerTriggerFields.vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import ConnectionTreeSelect from "@/components/connection/ConnectionTreeSelect.vue";
import type { ConnectionConfig } from "@/types/database";

const props = defineProps<{
  open: boolean;
  /** Null = create. */
  task: TaskDefinition | null;
  providers: readonly SchedulerTaskProviderDescriptor[];
  connections: readonly ConnectionConfig[];
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [task: TaskDefinition];
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();

const draft = ref<TaskDefinition | null>(null);
const formValues = ref<SchedulerFormValues>({});
const saving = ref(false);
const versionConflict = ref(false);
const highRiskAcknowledged = ref(false);

const isCreate = computed(() => !props.task);

const selectedProvider = computed(() => findProvider(props.providers, draft.value?.providerId));
const selectedTrigger = computed(() => findTrigger(selectedProvider.value, storedOrFullTriggerId()));
const configFields = computed(() => selectedTrigger.value?.fields ?? []);

// The create dialog offers plugin providers only: the builtin backup provider
// is created from the backup settings during the migration window (plan
// §41–45). Editing keeps the full list so migrated backup tasks still resolve
// their (locked) provider.
const selectableProviders = computed(() => (isCreate.value ? props.providers.filter((provider) => !provider.builtin) : props.providers));

/**
 * Narrow the connection list to the types the selected provider declares. A
 * plugin's `connection_providers` entries may be plugin connection ids rather
 * than database types; when nothing matches they are not db_types, and the
 * list stays unfiltered instead of hiding every connection.
 */
const providerConnections = computed(() => {
  const declared = selectedProvider.value?.connectionProviders ?? [];
  if (declared.length === 0) return props.connections;
  const matched = props.connections.filter((connection) => connection.db_type && declared.includes(connection.db_type));
  return matched.length > 0 ? matched : props.connections;
});

function storedOrFullTriggerId(): string | undefined {
  const stored = draft.value?.config?.["__triggerId"];
  if (typeof stored === "string" && stored.length > 0) return stored;
  if (selectedProvider.value && selectedProvider.value.triggers.length > 0) {
    return fullTriggerId(selectedProvider.value.providerId, selectedProvider.value.triggers[0]!);
  }
  return undefined;
}

const requiresConnection = computed(() => (selectedProvider.value?.connectionProviders.length ?? 0) > 0);

const risk = computed(() => selectedTrigger.value?.risk ?? "low");

watch(
  () => [props.open, props.task, props.providers] as const,
  ([open]) => {
    if (!open) return;
    versionConflict.value = false;
    highRiskAcknowledged.value = false;
    if (props.task) {
      draft.value = structuredCloneDraft(props.task);
      const provider = findProvider(props.providers, props.task.providerId);
      formValues.value = draftFormValues(draft.value, findTrigger(provider, typeof props.task.config?.["__triggerId"] === "string" ? String(props.task.config["__triggerId"]) : undefined));
    } else {
      // Create mode still needs a draft shell so provider picking can start.
      draft.value = emptyDraft();
      formValues.value = {};
    }
  },
  { immediate: true },
);

function emptyDraft(): TaskDefinition {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    name: "",
    providerType: "plugin",
    providerId: "",
    target: { connectionId: "", pluginId: null, resourceId: null },
    trigger: defaultTrigger("manual"),
    execution: defaultExecutionPolicy("run"),
    configVersion: 1,
    config: {},
    enabled: false,
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    version: 1,
  };
}

function structuredCloneDraft(task: TaskDefinition): TaskDefinition {
  return { ...task, target: { ...task.target }, trigger: { ...task.trigger }, execution: structuredClonePolicy(task.execution), config: { ...task.config } };
}

function structuredClonePolicy(policy: TaskDefinition["execution"]): TaskDefinition["execution"] {
  return { ...policy, retry: { ...policy.retry }, restart: policy.restart ? { ...policy.restart } : null };
}

function selectProvider(providerId: string) {
  if (!draft.value) return;
  const provider = findProvider(props.providers, providerId);
  draft.value.providerId = providerId;
  draft.value.providerType = provider?.builtin ? "builtin" : "plugin";
  const previousConnectionId = draft.value.target?.connectionId ?? "";
  const matchedConnections = (() => {
    const declared = provider?.connectionProviders ?? [];
    if (declared.length === 0) return props.connections;
    const matched = props.connections.filter((connection) => connection.db_type && declared.includes(connection.db_type));
    return matched.length > 0 ? matched : props.connections;
  })();
  // Keep the connection only when the new provider still accepts its type.
  const connectionId = matchedConnections.some((connection) => connection.id === previousConnectionId) ? previousConnectionId : "";
  draft.value.target = { connectionId, pluginId: provider?.builtin ? null : (provider?.pluginId ?? null), resourceId: null };
  const trigger = provider?.triggers[0];
  applyTrigger(trigger);
}

function selectTrigger(triggerFullId: string) {
  if (!draft.value) return;
  const trigger = selectedProvider.value?.triggers.find((candidate) => fullTriggerId(selectedProvider.value!.providerId, candidate) === triggerFullId);
  applyTrigger(trigger);
}

function applyTrigger(trigger: SchedulerTaskTriggerContribution | undefined) {
  if (!draft.value || !selectedProvider.value) return;
  draft.value.execution = defaultExecutionPolicy(modeForTrigger(trigger));
  draft.value.config = withStoredTriggerId({}, selectedProvider.value, trigger);
  formValues.value = {};
  if (trigger && draft.value.name.trim().length === 0) draft.value.name = defaultTaskName({ provider: selectedProvider.value, trigger });
}

function updateFormValues(values: SchedulerFormValues) {
  formValues.value = values;
}

const validationIssues = computed(() => {
  const issues: string[] = [];
  if (!draft.value?.name.trim()) issues.push(t("scheduler.editor.validation.nameRequired"));
  if (!selectedProvider.value) issues.push(t("scheduler.editor.validation.providerRequired"));
  if (!selectedTrigger.value) issues.push(t("scheduler.editor.validation.triggerRequired"));
  if (requiresConnection.value && !draft.value?.target?.connectionId) issues.push(t("scheduler.editor.connectionRequired"));
  const missing = validateFormFields(configFields.value, formValues.value).map((issue) => issue.label);
  if (missing.length > 0) issues.push(t("scheduler.editor.validation.missingFields", { fields: missing.join(", ") }));
  if (risk.value === "high" && !highRiskAcknowledged.value) issues.push(t("scheduler.editor.risk.highConfirm"));
  return issues;
});

const canSave = computed(() => !saving.value && draft.value !== null && validationIssues.value.length === 0);

async function confirmReloadConflict() {
  if (!props.task) return;
  try {
    const fresh = await schedulerApi.getTask(props.task.id);
    draft.value = structuredCloneDraft(fresh);
    const provider = findProvider(props.providers, fresh.providerId);
    formValues.value = draftFormValues(draft.value, findTrigger(provider, typeof fresh.config?.["__triggerId"] === "string" ? String(fresh.config["__triggerId"]) : undefined));
    versionConflict.value = false;
  } catch (error) {
    toast(String(error), 5000);
  }
}

async function save() {
  if (!draft.value || !canSave.value) return;
  saving.value = true;
  versionConflict.value = false;
  try {
    draft.value.config = configFromFormValues(configFields.value, formValues.value, draft.value.config);
    draft.value.config = withStoredTriggerId(draft.value.config, selectedProvider.value, selectedTrigger.value);
    draft.value.updatedAt = new Date().toISOString();
    const saved = isCreate.value ? await schedulerApi.createTask(draft.value) : await schedulerApi.saveTask(draft.value);
    toast(t("scheduler.editor.saved"), 2500);
    emit("saved", saved);
    emit("update:open", false);
  } catch (error) {
    if (schedulerErrorCode(error) === "version_conflict") {
      versionConflict.value = true;
    } else {
      toast(String(error), 5000);
    }
  } finally {
    saving.value = false;
  }
}

function close() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="open" @update:open="(value: boolean) => emit('update:open', value)">
    <DialogContent class="dbx-form-dialog dbx-form-dialog--lg max-h-[min(760px,calc(var(--dbx-viewport-height)-32px))] max-w-[min(760px,calc(100vw-32px))] overflow-x-hidden overflow-y-auto pr-8 [scrollbar-gutter:stable]" data-scheduler-editor>
      <DialogHeader>
        <DialogTitle>{{ isCreate ? t("scheduler.editor.createTitle") : t("scheduler.editor.editTitle") }}</DialogTitle>
      </DialogHeader>

      <div v-if="draft" class="grid gap-5 py-1">
        <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div class="space-y-2">
            <Label>{{ t("scheduler.editor.name") }}</Label>
            <Input v-model="draft.name" data-scheduler-editor-name />
          </div>
          <div class="flex items-center gap-2 pb-1">
            <Switch :model-value="draft.enabled" @update:model-value="(value: boolean) => (draft!.enabled = value)" />
            <Label class="text-xs">{{ t("scheduler.editor.enabled") }}</Label>
          </div>
        </div>

        <div class="grid gap-4 sm:grid-cols-2">
          <div class="space-y-2">
            <Label>{{ t("scheduler.editor.provider") }}</Label>
            <Select :model-value="draft.providerId || undefined" :disabled="!isCreate || selectableProviders.length === 0" @update:model-value="(value: unknown) => typeof value === 'string' && selectProvider(value)">
              <SelectTrigger data-scheduler-editor-provider><SelectValue :placeholder="t('scheduler.editor.provider')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="provider in selectableProviders" :key="provider.providerId" :value="provider.providerId">{{ provider.label }}</SelectItem>
              </SelectContent>
            </Select>
            <p v-if="selectableProviders.length === 0" class="text-xs text-destructive">{{ t("scheduler.editor.noProviders") }}</p>
          </div>
          <div v-if="selectedProvider && selectedProvider.triggers.length > 0" class="space-y-2">
            <Label>{{ t("scheduler.editor.providerTrigger") }}</Label>
            <Select :model-value="selectedTrigger ? fullTriggerId(selectedProvider.providerId, selectedTrigger) : undefined" :disabled="!isCreate || selectedProvider.triggers.length < 2" @update:model-value="(value: unknown) => typeof value === 'string' && selectTrigger(value)">
              <SelectTrigger data-scheduler-editor-trigger><SelectValue :placeholder="t('scheduler.editor.providerTrigger')" /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="trigger in selectedProvider.triggers" :key="trigger.id" :value="fullTriggerId(selectedProvider.providerId, trigger)">
                  <span class="flex items-center gap-2">
                    {{ trigger.label }}
                    <Badge v-if="trigger.mode === 'resident'" variant="outline" class="font-normal">resident</Badge>
                    <Badge v-if="trigger.risk === 'high' || trigger.risk === 'medium'" variant="destructive" class="font-normal">{{ trigger.risk }}</Badge>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            <p v-if="!isCreate" class="text-xs text-muted-foreground">{{ t("scheduler.editor.providerLockedHint") }}</p>
          </div>
        </div>
        <div class="space-y-2" data-scheduler-editor-connection>
          <Label>{{ t("scheduler.editor.connection") }}</Label>
          <ConnectionTreeSelect
            :model-value="draft.target?.connectionId || ''"
            :connections="providerConnections"
            :layout="connectionStore.sidebarLayout"
            :placeholder="t('scheduler.editor.connectionAny')"
            :search-placeholder="t('editor.searchConnection')"
            :empty-text="t('grid.noSearchResults')"
            @update:model-value="(value: string) => (draft!.target = { ...draft!.target, connectionId: value })"
          />
          <p v-if="requiresConnection && !draft.target?.connectionId" class="text-xs text-destructive">{{ t("scheduler.editor.connectionRequired") }}</p>
        </div>
        <div v-if="risk === 'medium'" class="flex items-start gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {{ t("scheduler.editor.risk.medium") }}
        </div>
        <label v-if="risk === 'high'" class="flex cursor-pointer items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" data-scheduler-editor-risk-high>
          <input v-model="highRiskAcknowledged" type="checkbox" class="mt-0.5 h-4 w-4 rounded border-border accent-primary" data-scheduler-editor-risk-ack />
          <span>
            <AlertTriangle class="mr-1 inline h-3.5 w-3.5" />
            {{ t("scheduler.editor.risk.high") }}
            <strong class="ml-1">{{ t("scheduler.editor.risk.highConfirm") }}</strong>
          </span>
        </label>

        <section v-if="configFields.length > 0" class="space-y-3">
          <h4 class="text-sm font-semibold">{{ t("scheduler.editor.sectionConfig") }}</h4>
          <SchedulerTaskFormRenderer :fields="configFields" :model-value="formValues" @update:model-value="updateFormValues" />
        </section>

        <section class="space-y-3">
          <h4 class="text-sm font-semibold">{{ t("scheduler.editor.sectionTrigger") }}</h4>
          <SchedulerTriggerFields v-model="draft.trigger" />
        </section>

        <section class="space-y-3">
          <h4 class="text-sm font-semibold">{{ t("scheduler.editor.sectionExecution") }}</h4>
          <SchedulerExecutionPolicyFields v-model="draft.execution" :mode-editable="false" />
        </section>
      </div>

      <p v-if="validationIssues.length > 0 && draft" class="text-xs text-muted-foreground" data-scheduler-editor-validation>{{ validationIssues[0] }}</p>
      <div v-if="versionConflict" class="flex flex-wrap items-center justify-between gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" data-scheduler-editor-conflict>
        <span>{{ t("scheduler.editor.versionConflict") }}</span>
        <Button variant="outline" size="sm" class="h-7" @click="confirmReloadConflict">{{ t("scheduler.editor.versionConflictReload") }}</Button>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="close">{{ t("scheduler.editor.cancel") }}</Button>
        <Button :disabled="!canSave" data-scheduler-editor-save @click="save">
          <Loader2 v-if="saving" class="mr-2 h-4 w-4 animate-spin" />
          {{ saving ? t("scheduler.editor.saving") : t("scheduler.editor.save") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

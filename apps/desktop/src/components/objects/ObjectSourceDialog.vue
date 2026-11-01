<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Clipboard, Loader2, PencilLine, RefreshCw } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSqlForDisplay, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { buildEditableObjectSource, buildExecutableObjectSourceStatements, prepareObjectSourceSave, objectSourceSaveSuccessMessage, formatObjectSourceSaveError, resolveObjectSourceEditDraft } from "@/lib/table/objectSourceEditor";
import { inspectExactOracleTriggerSource, loadObjectSourceWithRoutineFallback, oracleTriggerErrorEditorOffset } from "@/lib/table/objectSourceLoad";
import { oracleTriggerReadOptions } from "@/lib/database/oracleTriggerIdentity";
import { readOracleTriggerSource, prepareOracleTriggerPlan, type OracleTriggerSnapshot, type OracleTriggerExecutionResult, type OracleTriggerAction, type OracleTriggerTarget } from "@/lib/database/oracleTriggerPlan";
import { confirmOracleTriggerPlan } from "@/lib/database/oracleTriggerActions";
import { buildOracleTriggerCreateDraft, oracleTriggerDefinitionScopes, type OracleTriggerSqlBinding } from "@/lib/database/oracleTriggerSql";
import OracleTriggerStatus from "@/components/objects/OracleTriggerStatus.vue";
import { assertSourceIdentity, beginSourceSave, captureSourceIdentity, renewSourceIdentity, type SourceIdentitySnapshot } from "@/lib/table/objectSourceIdentity";
import { jdbcRoutineMetadata, xuguRoutineMetadataFromDefinition, type RoutineMetadata } from "@/lib/table/routineParameters";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { isOracleFamilyTypeSource } from "@/lib/database/databaseObjectCapabilities";
import { requestOracleTypeManagement } from "@/lib/table/oracleTypeManagementRequest";
import * as api from "@/lib/backend/api";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import RoutineMetadataPanel from "@/components/objects/RoutineMetadataPanel.vue";
import ObjectDependenciesPanel from "@/components/objects/ObjectDependenciesPanel.vue";
import { objectDependencyTarget, type ObjectDependencyTarget, type ObjectDetailsSection } from "@/lib/database/objectDependencyDetails";
import { useQueryStore } from "@/stores/queryStore";
import type { SqlObjectNavigationTarget } from "@/lib/sql/sqlNavigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DatabaseType, ObjectSourceKind, OracleTriggerMetadata } from "@/types/database";
const OracleInvalidObjectsDialog = defineAsyncComponent(() => import("@/components/objects/OracleInvalidObjectsDialog.vue"));

const props = withDefaults(
  defineProps<{
    open: boolean;
    connectionId: string;
    database: string;
    schema?: string;
    catalog?: string;
    executionSchema?: string;
    name: string;
    relationName?: string;
    signature?: string;
    objectType: ObjectSourceKind;
    triggerIdentityMode?: "exact";
    databaseType?: DatabaseType;
    dialect: "mysql" | "postgres" | "sqlserver";
    formatDialect?: SqlFormatDialect;
    initialEditing?: boolean;
    initialSection?: ObjectDetailsSection;
    createTrigger?: OracleTriggerSqlBinding;
  }>(),
  {
    initialEditing: false,
  },
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [];
  "open-object": [context: ObjectDependencyTarget, target: SqlObjectNavigationTarget];
  "trigger-read": [snapshot: OracleTriggerSnapshot];
  "trigger-result": [target: Readonly<OracleTriggerTarget>, result: OracleTriggerExecutionResult];
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();
const queryStore = useQueryStore();
const section = ref<ObjectDetailsSection>(props.initialSection || "source");
const dependencyTarget = computed(() =>
  props.createTrigger && !triggerSnapshot.value?.exists
    ? undefined
    : objectDependencyTarget(
        { connectionId: props.connectionId, database: props.database, schema: triggerOwner.value, catalog: props.catalog, name: triggerName.value, objectType: resolvedObjectType.value, section: section.value },
        props.databaseType,
        createProfile.value ? { name: createProfile.value.name, oracle_metadata: createProfile.value } : undefined,
      ),
);
function viewDependencySql(context: ObjectDependencyTarget, sql: string) {
  queryStore.createTab(context.connectionId, context.database, t("objectDependencies.viewSql"), "query", context.schema, sql, context.catalog, { forceNew: true });
}
function openDependencyObject(context: ObjectDependencyTarget, target: SqlObjectNavigationTarget) {
  const dirty = editing.value && draft.value !== resolveObjectSourceEditDraft(props.databaseType, resolvedObjectType.value, content.value, editableText.value);
  if (dirty && !window.confirm(t("objectDependencies.navigateDiscardConfirm"))) return;
  emit("update:open", false);
  emit("open-object", context, target);
}

const content = ref("");
const editableText = ref("");
const draft = ref("");
const loading = ref(false);
const saving = ref(false);
const editing = ref(false);
const sourceEditable = ref(true);
const error = ref("");
const saveError = ref("");
const routineMetadata = ref<RoutineMetadata | null>(null);
const triggerSnapshot = ref<OracleTriggerSnapshot>();
const triggerResult = ref<OracleTriggerExecutionResult>();
const triggerSourceIssue = ref("");
const triggerDiagnosticOpen = ref(false);
const sourceRevealRequest = ref<{ id: number; line: number; column: number }>();
let sourceRevealSequence = 0;
const triggerDiagnosticContext = shallowRef<{ target: Readonly<OracleTriggerTarget>; expectedObjectId?: string; originRevision: number }>();
const triggerDiagnosticConnection = computed(() => (triggerDiagnosticContext.value ? connectionStore.getConfig(triggerDiagnosticContext.value.target.connectionId) : undefined));
function openTriggerDiagnostics() {
  const snapshot = triggerSnapshot.value;
  if (!snapshot?.exists) return;
  triggerDiagnosticContext.value = { target: snapshot.target, expectedObjectId: snapshot.metadata.objectId ?? undefined, originRevision: loadSerial };
  triggerDiagnosticOpen.value = true;
}
function returnFromTriggerDiagnostics(object: { owner: string; name: string; objectId?: string }, location?: { line: number; position: number }) {
  const snapshot = triggerSnapshot.value;
  if (!snapshot || snapshot.target.owner !== object.owner || snapshot.target.name !== object.name) return;
  triggerDiagnosticOpen.value = false;
  section.value = "source";
  if (!editing.value) editSource();
  if (!location) return;
  const text = editing.value ? draft.value : content.value;
  const offset = object.objectId === snapshot.metadata.objectId ? oracleTriggerErrorEditorOffset(snapshot.raw, text, location) : undefined;
  if (offset === undefined) {
    toast(t("oracleTrigger.errorPositionUnavailable"), 3000);
    return;
  }
  const lines = text.replace(/\r\n?/g, "\n").slice(0, offset).split("\n");
  sourceRevealRequest.value = { id: ++sourceRevealSequence, line: lines.length, column: lines[lines.length - 1].length + 1 };
}
function acceptDiagnosticTriggerResult(target: Readonly<OracleTriggerTarget>, result: OracleTriggerExecutionResult, before: OracleTriggerSnapshot, _originTabId?: string, originRevision?: number) {
  if (originRevision !== undefined && loadSerial !== originRevision) return;
  emit("trigger-result", target, result);
  const baseline = triggerSnapshot.value;
  if (!props.open || !baseline || JSON.stringify(baseline.target) !== JSON.stringify(target)) return;
  triggerResult.value = result;
  if (!result.cancelled && result.steps.every((step) => step.state === "committed") && result.snapshot?.metadata.objectId === baseline.metadata.objectId && baseline.raw.source === before.raw.source) triggerSnapshot.value = result.snapshot;
  else if (result.snapshot) triggerSourceIssue.value = t("oracleTrigger.reloadBaseline");
}
const isOracleTrigger = computed(() => props.objectType === "TRIGGER" && !!oracleTriggerReadOptions(props.databaseType) && (props.triggerIdentityMode === "exact" || !!props.createTrigger));
const createName = ref(props.name);
const createOwner = ref(props.schema || props.database);
const createScope = ref<OracleTriggerSqlBinding["scope"]>(props.createTrigger?.scope || "TABLE");
const createBindingOwner = ref(props.createTrigger?.owner || "");
const createBindingName = ref(props.createTrigger?.name || "");
const createProfile = ref<OracleTriggerMetadata>();
const triggerOwner = computed(() => (props.createTrigger ? createOwner.value : props.schema || props.database));
const triggerName = computed(() => (props.createTrigger ? createName.value : props.name));
const createBinding = computed<OracleTriggerSqlBinding>(() => ({ scope: createScope.value, ...(["TABLE", "VIEW", "SCHEMA"].includes(createScope.value) ? { owner: createBindingOwner.value } : {}), ...(["TABLE", "VIEW"].includes(createScope.value) ? { name: createBindingName.value } : {}) }));
const createScopes = computed(() =>
  createProfile.value ? oracleTriggerDefinitionScopes(createProfile.value) : props.databaseType === "oceanbase-oracle" ? ["TABLE", "VIEW"] : props.databaseType === "dameng" ? ["TABLE", "VIEW", "SCHEMA", "DATABASE", "TIMER"] : ["TABLE", "VIEW", "SCHEMA", "DATABASE"],
);
let loadedSourceKey = "";
/** May differ from props.objectType after PROCEDURE/FUNCTION/PACKAGE fallback resolution. */
const resolvedObjectType = ref<ObjectSourceKind>(props.objectType);
let loadSerial = 0;
let sourceIdentity: SourceIdentitySnapshot | undefined;
onBeforeUnmount(() => {
  ++loadSerial;
});

const canEdit = computed(() => sourceEditable.value && (props.objectType !== "SEQUENCE" || props.databaseType === "oceanbase-oracle"));
const managedType = computed(() => isOracleFamilyTypeSource(props.databaseType, resolvedObjectType.value));
const isViewLike = computed(() => props.objectType === "VIEW" || props.objectType === "MATERIALIZED_VIEW");
const editLabel = computed(() => (isViewLike.value ? t("contextMenu.editView") : t("contextMenu.editObject")));
const title = computed(() => `${props.createTrigger && !triggerSnapshot.value?.exists ? t("contextMenu.createTrigger") : editing.value ? editLabel.value : t("contextMenu.viewSource")} - ${triggerName.value}`);
const hasRoutineMetadata = computed(() => !!routineMetadata.value && (routineMetadata.value.parameters.length > 0 || !!routineMetadata.value.returnType));

watch(
  () => [props.open, props.connectionId, props.database, props.schema, props.catalog, props.executionSchema, props.name, props.relationName, props.signature, props.objectType, props.triggerIdentityMode, props.databaseType, props.initialEditing, props.initialSection] as const,
  () => {
    triggerDiagnosticOpen.value = false;
    sourceRevealRequest.value = undefined;
    if (props.open) {
      section.value = props.initialSection || "source";
      void loadSource();
    } else ++loadSerial;
  },
  { immediate: true, flush: "sync" },
);

async function loadSource(nextEditing = props.initialEditing && canEdit.value, readCreatedTarget = false) {
  const serial = ++loadSerial;
  const target = { ...props, schema: triggerOwner.value, name: triggerName.value };
  const previouslyExisted = triggerSnapshot.value?.exists;
  const sourceKey = JSON.stringify([target.connectionId, target.database, target.catalog, target.schema, target.name, target.objectType, target.triggerIdentityMode]);
  if (sourceKey !== loadedSourceKey) createProfile.value = undefined;
  const keepDraft = isOracleTrigger.value && (sourceKey === loadedSourceKey || !!props.createTrigger) && editing.value;
  resolvedObjectType.value = target.objectType;
  const identity = captureSourceIdentity({ ...target, schema: target.schema || target.database });
  sourceIdentity = undefined;
  saving.value = false;
  if (!keepDraft) {
    content.value = "";
    editableText.value = "";
    draft.value = "";
  }
  error.value = "";
  saveError.value = "";
  routineMetadata.value = null;
  triggerSnapshot.value = undefined;
  triggerSourceIssue.value = "";
  if (!keepDraft) triggerResult.value = undefined;
  sourceEditable.value = true;
  if (!keepDraft) editing.value = false;
  loading.value = true;
  try {
    if (props.createTrigger && !readCreatedTarget && !previouslyExisted) {
      editing.value = true;
      loadedSourceKey = sourceKey;
      return;
    }
    if (!target.databaseType) throw new Error("Connection type is unavailable.");
    // issue #9035：连接建立也纳入弹窗的加载态。调用方不再先 await ensureConnected
    // 才打开弹窗，否则弹窗挂载前会有一段没有任何反馈的等待。
    await connectionStore.ensureConnected(target.connectionId);
    if (serial !== loadSerial) return;
    connectionStore.activeConnectionId = target.connectionId;
    const schema = target.schema || target.database;
    if (isOracleTrigger.value) {
      const loaded = await readOracleTriggerSource({ connectionId: target.connectionId, database: target.database, catalog: target.catalog, owner: schema, name: target.name, executionSchema: target.executionSchema || schema });
      if (serial !== loadSerial) return;
      const inspected = await inspectExactOracleTriggerSource(loaded.raw, schema, target.name);
      if (serial !== loadSerial) return;
      triggerSnapshot.value = loaded.snapshot;
      if (loaded.snapshot) emit("trigger-read", loaded.snapshot);
      triggerSourceIssue.value = loaded.identityError || inspected.triggerSource.error || "";
      sourceIdentity = loaded.snapshot?.identity;
      sourceEditable.value = !!props.createTrigger || loaded.snapshot?.exists === true;
      if (loaded.snapshot) createProfile.value = loaded.snapshot.metadata;
      content.value = loaded.raw.source;
      editableText.value = inspected.editableSource;
      if (!keepDraft) draft.value = nextEditing && canEdit.value ? inspected.editableSource : "";
      editing.value = keepDraft || (nextEditing && canEdit.value);
      loadedSourceKey = sourceKey;
      return;
    }
    const { source: result, objectType: resolvedType } = await loadObjectSourceWithRoutineFallback(api.getObjectSource, target.connectionId, target.database, schema, target.name, target.objectType, target.signature, target.relationName);
    if (serial !== loadSerial) return;
    const editableAllowed = result.editable !== false;
    const editable = await buildEditableObjectSource({
      databaseType: target.databaseType,
      objectType: resolvedType,
      schema,
      name: target.name,
      source: result.source,
    });
    if (serial !== loadSerial) return;
    resolvedObjectType.value = resolvedType;
    const isRoutine = resolvedType === "PROCEDURE" || resolvedType === "FUNCTION";
    routineMetadata.value = !isRoutine ? null : result.routine_parameters !== undefined ? jdbcRoutineMetadata(result.routine_parameters) : target.databaseType === "xugu" ? xuguRoutineMetadataFromDefinition(result.source) : null;
    sourceEditable.value = editableAllowed;
    const displaySource = resolvedType === "SEQUENCE" ? result.source : editable;
    const formatted = await formatSqlForDisplay(displaySource, target.formatDialect ?? target.dialect, settingsStore.editorSettings.sqlFormatter);
    if (serial !== loadSerial) return;
    const renewed = renewSourceIdentity(identity);
    sourceIdentity = resolvedType === target.objectType ? renewed : captureSourceIdentity({ ...identity, objectType: resolvedType });
    assertSourceIdentity(sourceIdentity);
    editableText.value = editable;
    content.value = formatted;
    draft.value = nextEditing && canEdit.value ? resolveObjectSourceEditDraft(props.databaseType, resolvedType, formatted, editable) : "";
    editing.value = nextEditing && canEdit.value;
    if (nextEditing && !canEdit.value) {
      toast(t("objects.sourceReadOnly"), 3000);
    }
  } catch (e: any) {
    if (serial === loadSerial) {
      if (keepDraft) {
        editing.value = true;
        saveError.value = e?.message || String(e);
      } else error.value = e?.message || String(e);
    }
  } finally {
    if (serial === loadSerial) loading.value = false;
  }
}

async function copySource() {
  if (!content.value) return;
  try {
    await copyToClipboard(content.value);
    toast(t("grid.copied"));
  } catch (e: any) {
    toast(t("grid.copyFailed", { message: e?.message || String(e) }), 5000);
  }
}

function editSource() {
  if (!canEdit.value || !editableText.value) {
    if (!canEdit.value) toast(t("objects.sourceReadOnly"), 3000);
    return;
  }
  draft.value = resolveObjectSourceEditDraft(props.databaseType, resolvedObjectType.value, content.value, editableText.value);
  saveError.value = "";
  editing.value = true;
}

function cancelEditSource() {
  editing.value = false;
  draft.value = "";
  saveError.value = "";
}

async function refreshSource() {
  if (loading.value || saving.value) return;
  if (!isOracleTrigger.value && editing.value && !window.confirm(t("objects.refreshDiscardConfirm"))) return;
  await loadSource(editing.value && canEdit.value, !!props.createTrigger);
}

async function saveSource() {
  if (saving.value || loading.value || !props.open) return;
  if (!canEdit.value) {
    toast(t("objects.sourceReadOnly"), 3000);
    return;
  }
  if (!draft.value.trim() || !props.databaseType) return;
  if (isOracleTrigger.value) {
    await runTriggerAction(props.createTrigger && !triggerSnapshot.value?.exists ? "create" : "replace");
    return;
  }
  const databaseType = props.databaseType;
  const connectionId = props.connectionId,
    database = props.database,
    name = props.name;
  const objectType = resolvedObjectType.value,
    serial = loadSerial;
  const schema = props.schema || props.database;
  saving.value = true;
  saveError.value = "";
  let save: Awaited<ReturnType<typeof prepareObjectSourceSave>> | undefined;
  try {
    if (!sourceIdentity) return;
    const identity = sourceIdentity;
    assertSourceIdentity(identity);
    if (isOracleFamilyTypeSource(databaseType, objectType)) {
      const source = draft.value;
      const result = await requestOracleTypeManagement({
        target: { connectionId, database, owner: schema, name, databaseType: databaseType as "oracle" | "oceanbase-oracle" | "dameng" },
        operation: objectType === "TYPE_BODY" ? "save-body" : "save-spec",
        source,
        baseSource: editableText.value,
        isCurrent: () => serial === loadSerial && props.open && draft.value === source,
      });
      if (!result.complete || serial !== loadSerial) return;
      toast(t("objects.sourceSaved"));
      emit("saved");
      await loadSource(false);
      return;
    }
    const statements = await buildExecutableObjectSourceStatements({
      databaseType,
      objectType,
      schema,
      name,
      source: draft.value,
    });
    if (serial !== loadSerial) return;
    save = await prepareObjectSourceSave(connectionId, database, databaseType, statements, schema, { objectType, name });
    const preparedSave = save;
    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");
    const execute = async () => {
      if (serial !== loadSerial || !props.open) return;
      const release = beginSourceSave(identity);
      try {
        return { operation: await preparedSave() };
      } finally {
        release();
      }
    };
    let result;
    if (executableSql.trim()) {
      result = await executeWithProductionSqlGuard({
        connection: connectionStore.getConfig(connectionId),
        database,
        sql: executableSql,
        source: t("production.sourceObjectSource"),
        execute,
      });
    } else {
      result = await execute();
    }
    if (!result || serial !== loadSerial) return;
    toast(objectSourceSaveSuccessMessage(t("objects.sourceSaved"), result.operation), result.operation?.readback?.compilerMessages.length ? 6000 : 2000);
    emit("saved");
    await loadSource(false);
  } catch (e: unknown) {
    if (serial === loadSerial) saveError.value = formatObjectSourceSaveError(e, databaseType, objectType, t("objects.postgresViewColumnChangeHint"));
  } finally {
    await save?.dispose?.();
    if (serial === loadSerial) saving.value = false;
  }
}

async function runTriggerAction(action: OracleTriggerAction) {
  if (saving.value || loading.value || !props.open) return;
  const baseline = triggerSnapshot.value;
  if (!baseline && action !== "create") {
    saveError.value = t("oracleTrigger.reloadBaseline");
    return;
  }
  const serial = loadSerial,
    source = draft.value;
  const target = baseline?.exists ? baseline.target : { connectionId: props.connectionId, database: props.database, catalog: props.catalog, owner: triggerOwner.value, name: triggerName.value, executionSchema: props.executionSchema || props.schema || props.database };
  const selection = action === "create" ? { ...createBinding.value } : undefined;
  const bindingKey = JSON.stringify(createBinding.value);
  const current = () =>
    props.open &&
    triggerName.value === target.name &&
    triggerOwner.value === target.owner &&
    props.connectionId === target.connectionId &&
    props.database === target.database &&
    props.catalog === target.catalog &&
    (props.executionSchema || props.schema || props.database) === target.executionSchema &&
    serial === loadSerial &&
    (!["create", "replace"].includes(action) || draft.value === source) &&
    (action !== "create" || JSON.stringify(createBinding.value) === bindingKey);
  saving.value = true;
  saveError.value = "";
  try {
    const plan = await prepareOracleTriggerPlan({ target, action, expectedObjectId: baseline?.exists ? (baseline.metadata.objectId ?? undefined) : undefined, ...(["create", "replace"].includes(action) ? { baseline, source, selection } : {}) });
    if (!current()) return;
    const result = await confirmOracleTriggerPlan(plan, { isCurrent: current });
    emit("trigger-result", plan.target, result);
    if (serial !== loadSerial) return;
    triggerResult.value = result;
    const committed = !result.cancelled && result.steps.every((step) => step.state === "committed");
    if (committed && result.snapshot && (action === "create" || (result.snapshot.metadata.objectId === baseline?.metadata.objectId && (action === "replace" || baseline?.raw.source === plan.before.raw.source)))) triggerSnapshot.value = result.snapshot;
    else if (result.snapshot) triggerSourceIssue.value = t("oracleTrigger.reloadBaseline");
    if (!result.cancelled && result.steps.every((step) => step.state === "committed") && !result.steps.some((step) => step.verification === "invalid")) {
      emit("saved");
      if (action === "create" || action === "replace") await loadSource(false, !!props.createTrigger);
    }
  } catch (error) {
    if (serial === loadSerial) saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (serial === loadSerial) saving.value = false;
  }
}

async function generateTriggerDefinition() {
  if (saving.value || loading.value || triggerSnapshot.value?.exists) return;
  if (draft.value.trim() && !window.confirm(t("objects.refreshDiscardConfirm"))) return;
  const serial = loadSerial;
  const target = { connectionId: props.connectionId, database: props.database, catalog: props.catalog, owner: triggerOwner.value, name: triggerName.value, executionSchema: props.executionSchema || props.schema || props.database };
  const binding = { ...createBinding.value };
  const previousDraft = draft.value;
  loading.value = true;
  saveError.value = "";
  try {
    await connectionStore.ensureConnected(target.connectionId);
    const loaded = await readOracleTriggerSource(target);
    if (serial !== loadSerial || !props.open || target.owner !== triggerOwner.value || target.name !== triggerName.value || JSON.stringify(binding) !== JSON.stringify(createBinding.value) || draft.value !== previousDraft) return;
    if (!loaded.snapshot) throw new Error(loaded.identityError);
    createProfile.value = loaded.snapshot.metadata;
    if (loaded.snapshot.exists) throw new Error("A visible trigger already exists; change the name or open its existing source");
    draft.value = buildOracleTriggerCreateDraft(loaded.snapshot.metadata, target.owner, target.name, binding);
    editing.value = true;
  } catch (error) {
    if (serial === loadSerial) saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (serial === loadSerial) loading.value = false;
  }
}

function openTriggerParent() {
  const parent = triggerSnapshot.value?.metadata.parent;
  if (!parent) return;
  openDependencyObject(
    { connectionId: props.connectionId, database: props.database, schema: triggerOwner.value, catalog: props.catalog, name: triggerName.value, objectType: "TRIGGER" },
    { name: parent.name, schema: parent.owner, type: parent.objectType === "VIEW" ? "view" : "table", nameQuoted: true, schemaQuoted: true },
  );
}

function closeDialog() {
  emit("update:open", false);
}

defineExpose({ hasUnsavedDraft: () => editing.value && draft.value !== editableText.value });
</script>

<template>
  <OracleInvalidObjectsDialog
    v-if="triggerDiagnosticContext && triggerDiagnosticConnection"
    :open="triggerDiagnosticOpen && props.open && triggerDiagnosticContext.originRevision === loadSerial"
    :connection="triggerDiagnosticConnection"
    :database="triggerDiagnosticContext.target.database"
    :schema="triggerDiagnosticContext.target.owner"
    :trigger-context="triggerDiagnosticContext"
    @update:open="triggerDiagnosticOpen = $event"
    @open-source="returnFromTriggerDiagnostics"
    @trigger-result="acceptDiagnosticTriggerResult"
  />
  <Dialog :open="props.open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="h-[min(760px,calc(var(--dbx-viewport-height)-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[900px]">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
      </DialogHeader>

      <ObjectDependenciesPanel :target="dependencyTarget" v-model:section="section" :open="props.open" @view-sql="viewDependencySql" @open-object="openDependencyObject">
        <div v-if="isOracleTrigger && props.createTrigger" class="shrink-0 space-y-3 border-b pb-3 text-sm" data-trigger-create>
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label class="space-y-1">{{ t("eventTrigger.owner") }}<Input v-model="createOwner" :disabled="saving || !!triggerSnapshot?.exists" data-trigger-create-owner /></label>
            <label class="space-y-1">{{ t("structureEditor.triggerName") }}<Input v-model="createName" :disabled="saving || !!triggerSnapshot?.exists" data-trigger-create-name /></label>
            <label class="space-y-1"
              >{{ t("oracleTrigger.scope")
              }}<select v-model="createScope" class="h-9 w-full rounded-md border bg-background px-3" :disabled="saving || !!triggerSnapshot?.exists" data-trigger-create-scope>
                <option v-for="scope in createScopes" :key="scope" :value="scope">{{ scope }}</option>
              </select></label
            >
            <label v-if="['TABLE', 'VIEW', 'SCHEMA'].includes(createScope)" class="space-y-1"
              >{{ t(createScope === "SCHEMA" ? "oracleTrigger.scopeOwner" : "oracleTrigger.parentOwner") }}<Input v-model="createBindingOwner" :disabled="saving || !!triggerSnapshot?.exists" data-trigger-create-parent-owner
            /></label>
            <label v-if="['TABLE', 'VIEW'].includes(createScope)" class="space-y-1">{{ t("oracleTrigger.parentName") }}<Input v-model="createBindingName" :disabled="saving || !!triggerSnapshot?.exists" data-trigger-create-parent-name /></label>
            <div v-if="!triggerSnapshot?.exists" class="flex items-end">
              <Button variant="outline" :disabled="saving || loading || !createName.length || !createOwner.length" @click="generateTriggerDefinition">{{ t("contextMenu.generateSql") }}</Button>
            </div>
          </div>
          <p v-if="createProfile?.engine === 'oceanbase-oracle'" class="text-muted-foreground">{{ t("oracleTrigger.obSchemaUnsupported") }} {{ t("oracleTrigger.obDatabaseUnknown") }}</p>
        </div>
        <OracleTriggerStatus v-if="isOracleTrigger" :snapshot="triggerSnapshot" :result="triggerResult" :source-issue="triggerSourceIssue" :busy="loading || saving" @action="runTriggerAction" @parent="openTriggerParent" @refresh="refreshSource" @diagnostics="openTriggerDiagnostics" />
        <div v-if="loading && !editing" class="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="h-4 w-4 animate-spin" />
          <span>{{ t("common.loading") }}</span>
        </div>
        <div v-else-if="error" class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-sm">
          <p class="text-destructive">{{ error }}</p>
          <Button variant="outline" size="sm" @click="loadSource()">
            <RefreshCw class="h-4 w-4" />
            {{ t("common.retry") }}
          </Button>
        </div>
        <div v-else-if="editing" class="object-source-dialog-editor flex min-h-0 flex-1 flex-col overflow-hidden rounded border" data-object-source-editor>
          <QueryEditor
            v-model="draft"
            :reveal-request="sourceRevealRequest"
            @editor-reveal-consumed="sourceRevealRequest = undefined"
            class="min-h-0 flex-1"
            :connection-id="props.connectionId"
            :database="props.database"
            :schema="props.schema || props.database"
            :database-type="props.databaseType"
            :dialect="props.dialect"
            :format-dialect="props.formatDialect"
            force-word-wrap
            hide-execution-controls
            @save="section === 'source' && saveSource()"
          />
          <div v-if="saveError" class="shrink-0 whitespace-pre-wrap break-words border-t px-3 py-2 text-xs text-destructive">
            {{ saveError }}
          </div>
        </div>
        <div v-else class="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
          <RoutineMetadataPanel v-if="hasRoutineMetadata && routineMetadata" :parameters="routineMetadata.parameters" :return-type="routineMetadata.returnType" />
          <QueryEditor
            v-if="content || !hasRoutineMetadata"
            :reveal-request="sourceRevealRequest"
            @editor-reveal-consumed="sourceRevealRequest = undefined"
            :key="`${props.connectionId}:${props.database}:${props.schema || ''}:${props.name}:${props.objectType}`"
            :model-value="content"
            class="object-source-dialog-editor min-h-0 flex-1 overflow-hidden rounded border"
            :connection-id="props.connectionId"
            :database="props.database"
            :schema="props.schema || props.database"
            :database-type="props.databaseType"
            :dialect="props.dialect"
            :format-dialect="props.formatDialect"
            force-word-wrap
            read-only
            hide-execution-controls
            data-object-source-preview
          />
        </div>
      </ObjectDependenciesPanel>

      <DialogFooter>
        <Button variant="outline" @click="closeDialog">{{ t("common.close") }}</Button>
        <Button v-show="section === 'source'" variant="outline" :disabled="loading || saving" :title="t('structureEditor.refresh')" @click="refreshSource">
          <RefreshCw class="h-4 w-4" />
          {{ t("structureEditor.refresh") }}
        </Button>
        <Button v-if="!editing && section === 'source'" variant="outline" :disabled="!content" @click="copySource">
          <Clipboard class="h-4 w-4" />
          {{ t("grid.copy") }}
        </Button>
        <Button v-if="!editing && canEdit && section === 'source'" variant="outline" :disabled="!editableText" @click="editSource">
          <PencilLine class="h-4 w-4" />
          {{ editLabel }}
        </Button>
        <Button v-if="editing && section === 'source'" variant="outline" :disabled="saving || loading" @click="cancelEditSource">
          {{ t("objects.cancelEdit") }}
        </Button>
        <Button v-if="editing && section === 'source'" :disabled="saving || loading || !draft.trim()" @click="saveSource">
          <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
          {{ t(managedType ? "objects.typeManagementPreviewSave" : "objects.saveSource") }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.object-source-dialog-editor :deep(.cm-editor),
.object-source-dialog-editor :deep(.cm-scroller) {
  height: 100%;
}

.object-source-dialog-editor :deep(.cm-scroller) {
  overflow: auto !important;
}
</style>

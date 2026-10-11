<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Check, Copy, Loader2, Pencil, RefreshCw, Trash2, X } from "@lucide/vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/ui/searchable-select";
import CustomTypeDefinitionForm from "@/components/objects/custom-type/CustomTypeDefinitionForm.vue";
import CustomTypeDeleteDialog from "@/components/objects/custom-type/CustomTypeDeleteDialog.vue";
import CustomTypeSqlPreview from "@/components/objects/custom-type/CustomTypeSqlPreview.vue";
import { createSidePanelRequestGuard } from "@/lib/table/sidePanelRequestGuard";
import { useRetainTabSurface } from "@/lib/tabs/retainTabSurface";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { translateBackendError } from "@/i18n/backend-errors";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import { connectionIsEffectivelyReadOnly } from "@/lib/database/readOnlyWriteAccess";
import { postgresListRolesSql, usersFromPostgresRolesResult } from "@/lib/database/databaseUserAdmin";
import { customTypeCapabilities } from "@/lib/database/databaseObjectCapabilities";
import { CREATABLE_KINDS, draftFromDetails, draftIsDirty, draftValidationIssues, emptyDraft, kindIsEditable, operationForCreateKind, pruneDraft, supportsOperation } from "@/lib/database/customTypeDraft";
import * as api from "@/lib/backend/api";
import type { ConnectionConfig, CustomTypeChangePreview, CustomTypeChangeRequest, CustomTypeDetails, CustomTypeEditorSession, CustomTypeDraft, CustomTypeDropPreview, CustomTypeIdentity, CustomTypeKind, CustomTypeManagementCapabilities } from "@/types/database";

/**
 * Custom type designer: read-only details, create and edit in one surface.
 *
 * Three things make this safe rather than a form that writes DDL:
 *  1. The draft is an end state, never a statement log; the backend diffs it
 *     against a live catalog snapshot.
 *  2. Save sends the plan revision the user reviewed, and the backend re-derives
 *     the plan before executing, so a stale form cannot overwrite someone else.
 *  3. Deletes go through the same preview/apply pair, which is what makes the
 *     dependency list and CASCADE switch trustworthy.
 */

const props = withDefaults(
  defineProps<{
    connection: ConnectionConfig;
    database: string;
    schema: string;
    name: string;
    catalog?: string;
    /** Mode requested by the entry point; `delete` opens the confirmation once loaded. */
    initialMode?: "view" | "create" | "edit" | "delete";
    /** Monotonic request id so a repeated request on a reused panel re-runs. */
    requestId?: number;
    session?: CustomTypeEditorSession | null;
  }>(),
  { catalog: undefined, initialMode: "view", requestId: 0 },
);

const emit = defineEmits<{
  close: [];
  saved: [payload: { identity: CustomTypeIdentity; created: boolean }];
  deleted: [payload: { identity: CustomTypeIdentity }];
  /** Unsaved-work state, so closing the whole tab can confirm first. */
  dirtyChange: [dirty: boolean];
  sessionChange: [session: CustomTypeEditorSession];
}>();

const { t } = useI18n();
const toast = useToast();
const guard = createSidePanelRequestGuard();
const retainSurface = useRetainTabSurface();

type DesignerMode = "view" | "create" | "edit";

const mode = ref<DesignerMode>("view");
const activeSchema = ref(props.schema);
const activeName = ref(props.name);
const initializing = ref(true);
const restoredSession = props.session;
let firstInitialization = true;
let previewSeq = 0;
let dropPreviewSeq = 0;
let previewTimer: ReturnType<typeof setTimeout> | undefined;

const initialKind = ref<CustomTypeKind>("enum");
const details = ref<CustomTypeDetails | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const tab = ref<"members" | "properties" | "ddl">("members");
const capabilities = ref<CustomTypeManagementCapabilities | null>(null);
const dataTypeOptions = ref<string[]>([]);
const draft = ref<CustomTypeDraft | null>(null);
const originalDraft = ref<CustomTypeDraft | null>(null);
const preview = ref<CustomTypeChangePreview | null>(null);
const previewLoading = ref(false);
const previewError = ref<string | null>(null);
const previewCollapsed = ref(false);
const saving = ref(false);
const saveError = ref<string | null>(null);
const showDelete = ref(false);
const dropCascade = ref(false);
const dropPreview = ref<CustomTypeDropPreview | null>(null);
const dropPreviewLoading = ref(false);
const dropError = ref<string | null>(null);
const dropping = ref(false);
const openDeleteOnLoad = ref(false);
/** Open while the user reviews a destructive change before execution starts. */
const showDestructiveConfirm = ref(false);
/**
 * Roles offered by the owner picker.
 *
 * A free-text owner field was the wrong control: it invites a typo that only the
 * server can reject, and it gives no hint that leaving it empty is a meaningful
 * choice (the server then assigns the current user).
 */
const ownerRoles = ref<string[]>([]);
const ownerRolesLoading = ref(false);
const ownerRolesError = ref("");
let ownerRolesRequestId = 0;

const managementEnabled = computed(() => customTypeCapabilities(props.connection.db_type).management);
const readOnly = computed(() => connectionIsEffectivelyReadOnly(props.connection));
const canManage = computed(() => managementEnabled.value && !readOnly.value);
/**
 * Whether this particular object offers an edit entry.
 *
 * A multirange is excluded: PostgreSQL generates it from its range type, so the
 * backend refuses to rename or move it. Offering the entry would open a form
 * that can never be saved.
 */
const canEditCurrent = computed(() => canManage.value && !!details.value && kindIsEditable(details.value.kind));

const kindLabel = computed(() => (details.value ? t(`customType.kinds.${details.value.kind}`) : ""));
const draftKind = computed<CustomTypeKind>(() => (draft.value?.definition.kind as CustomTypeKind | undefined) ?? initialKind.value);
const hasMemberTab = computed(() => details.value?.kind === "composite" || details.value?.kind === "enum");
const tabs = computed(() => {
  const items: Array<{ id: "members" | "properties" | "ddl"; label: string }> = [];
  if (hasMemberTab.value) items.push({ id: "members", label: t("customType.tabs.members") });
  items.push({ id: "properties", label: t("customType.tabs.properties") });
  items.push({ id: "ddl", label: t("customType.tabs.ddl") });
  return items;
});
const isEditing = computed(() => mode.value === "create" || mode.value === "edit");
const editableKinds = computed(() => {
  // A failed capability probe leaves the list intact on purpose: the preview
  // then explains *why* nothing can run, which is more useful than an empty
  // dropdown that hides the feature without saying anything.
  if (!capabilities.value) return [...CREATABLE_KINDS];
  return CREATABLE_KINDS.filter((kind) => {
    const operation = operationForCreateKind(kind);
    return !!operation && supportsOperation(capabilities.value, operation);
  });
});
const localIssues = computed(() => (draft.value ? draftValidationIssues(draft.value, mode.value === "create") : []));
const canSave = computed(
  () => !initializing.value && isEditing.value && !saving.value && draft.value != null && preview.value != null && !previewLoading.value && previewError.value == null && preview.value.blockedChanges.length === 0 && preview.value.statements.length > 0 && localIssues.value.length === 0,
);
const ownerEditable = computed(() => supportsOperation(capabilities.value, "alter.owner"));

/**
 * Options for the owner picker: the known roles, plus the object's current owner
 * even when it is not a role the connection can enumerate (mirrors the table
 * structure editor, so both owner pickers behave the same way).
 */
const ownerOptions = computed(() => {
  const owner = draft.value?.owner ?? "";
  if (!owner || ownerRoles.value.includes(owner)) return ownerRoles.value;
  return [owner, ...ownerRoles.value];
});

/**
 * What an empty owner field means differs per mode, so the placeholder must too:
 * a new type is created with the current user, while an existing type simply
 * keeps the owner it has (the planner emits no OWNER statement for an empty
 * value on an edit).
 */
const ownerPlaceholder = computed(() => (mode.value === "create" ? t("customType.editor.ownerDefaultPlaceholder") : t("customType.editor.ownerPlaceholder")));
const commentEditable = computed(() => supportsOperation(capabilities.value, "alter.comment"));

const ddlText = computed(() => details.value?.ddl?.sql ?? "");

// Writable views onto the draft so the identity inputs can use `v-model`
// without a non-null assertion in the template.
const draftSchema = computed({
  get: () => draft.value?.schema ?? "",
  set: (value: string) => {
    if (draft.value && !saving.value) draft.value.schema = value;
  },
});
const draftName = computed({
  get: () => draft.value?.name ?? "",
  set: (value: string) => {
    if (draft.value && !saving.value) draft.value.name = value;
  },
});
const draftOwner = computed({
  get: () => draft.value?.owner ?? "",
  set: (value: string) => {
    if (draft.value && !saving.value) draft.value.owner = value || null;
  },
});
const draftComment = computed({
  get: () => draft.value?.comment ?? "",
  set: (value: string) => {
    if (draft.value && !saving.value) draft.value.comment = value || null;
  },
});

const propertyRows = computed<Array<{ label: string; value: string }>>(() => {
  const p = details.value?.properties;
  if (!p) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value != null && value !== "") rows.push({ label, value: String(value) });
  };
  push(t("customType.properties.owner"), details.value?.owner);
  push(t("customType.properties.baseType"), p.baseType);
  if (p.notNull) push(t("customType.properties.notNull"), "true");
  push(t("customType.properties.default"), p.default);
  push(t("customType.properties.collation"), p.collation);
  for (const constraint of p.domainConstraints) {
    rows.push({
      label: constraint.name ? `${t("customType.properties.domainConstraint")} · ${constraint.name}` : t("customType.properties.domainConstraint"),
      value: constraint.validated === false ? `${constraint.definition} (NOT VALID)` : constraint.definition,
    });
  }
  push(t("customType.properties.rangeSubtype"), p.rangeSubtype);
  push(t("customType.properties.rangeMultirange"), p.rangeMultirangeName);
  return rows;
});

function isFieldKind(kind: CustomTypeKind | undefined): boolean {
  return kind === "composite";
}

function isEnumKind(kind: CustomTypeKind | undefined): boolean {
  return kind === "enum";
}

function targetIdentity(): CustomTypeIdentity | null {
  if (!details.value || mode.value === "create") return null;
  return { schema: details.value.schema, name: details.value.name, kind: details.value.kind };
}

function messageOf(cause: unknown): string {
  return translateBackendError(t, cause) || (cause as Error)?.message || String(cause);
}

// --- loading ---------------------------------------------------------------

async function loadCapabilities() {
  if (!managementEnabled.value) {
    capabilities.value = null;
    return;
  }
  try {
    capabilities.value = await api.getCustomTypeManagementCapabilities(props.connection.id, props.database);
  } catch (cause) {
    // A capability probe failure must not break the read-only view; the editor
    // simply offers nothing to change.
    capabilities.value = null;
    void cause;
  }
}

async function loadDataTypeOptions() {
  if (dataTypeOptions.value.length > 0) return;
  try {
    dataTypeOptions.value = await api.listDataTypes(props.connection.id, props.database);
  } catch {
    // Data type suggestions are a convenience; arbitrary type expressions are
    // still accepted by the input.
    dataTypeOptions.value = [];
  }
}

/**
 * Load the assignable roles for the owner picker.
 *
 * Uses the same roles query the table-structure owner field uses, so the two
 * surfaces cannot disagree about what a role is. Failure is not fatal: the picker
 * falls back to accepting a typed name, and the empty-text says so.
 */
async function loadOwnerRoles() {
  if (!ownerEditable.value || ownerRoles.value.length > 0) return;
  const requestId = ++ownerRolesRequestId;
  ownerRolesLoading.value = true;
  ownerRolesError.value = "";
  try {
    const result = await api.executeQuery(props.connection.id, props.database, postgresListRolesSql(), undefined, undefined, {
      maxRows: 5000,
    });
    if (requestId !== ownerRolesRequestId) return;
    ownerRoles.value = [
      ...new Set(
        usersFromPostgresRolesResult(result)
          .map((role) => role.user)
          .filter(Boolean),
      ),
    ];
  } catch (cause) {
    if (requestId !== ownerRolesRequestId) return;
    ownerRoles.value = [];
    ownerRolesError.value = messageOf(cause);
  } finally {
    if (requestId === ownerRolesRequestId) ownerRolesLoading.value = false;
  }
}

async function loadDetails(epoch: number) {
  loading.value = true;
  error.value = null;
  details.value = null;
  try {
    const result = await api.getCustomTypeDetails(props.connection.id, props.database, activeSchema.value, activeName.value);
    if (guard.isStale(epoch)) return;
    details.value = result;
    if (tab.value === "members" && result.kind !== "composite" && result.kind !== "enum") tab.value = "properties";
  } catch (cause) {
    if (guard.isStale(epoch)) return;
    error.value = messageOf(cause);
  } finally {
    if (guard.isFresh(epoch)) loading.value = false;
  }
}

async function initialize(retarget = true) {
  const epoch = guard.start();
  invalidatePreview();
  invalidateDropPreview();
  initializing.value = true;
  const restore = firstInitialization && restoredSession?.schema === props.schema && restoredSession?.name === props.name ? restoredSession : null;
  firstInitialization = false;
  try {
    if (retarget) {
      mode.value = props.initialMode === "delete" ? "view" : props.initialMode;
      activeSchema.value = props.schema;
      activeName.value = props.name;
    }
    showDestructiveConfirm.value = false;
    details.value = null;
    error.value = null;
    draft.value = null;
    originalDraft.value = null;
    preview.value = null;
    previewError.value = null;
    saveError.value = null;
    dropPreview.value = null;
    dropError.value = null;
    dropCascade.value = false;
    showDelete.value = false;
    openDeleteOnLoad.value = retarget && !restore && props.initialMode === "delete";
    tab.value = "members";
    // Claim the loading state up front: resolving capabilities is a round trip,
    // and a blank panel for that long reads as a broken panel.
    loading.value = mode.value !== "create" && !!activeName.value;

    if (!managementEnabled.value) {
      // Read-only engines keep the original browse-only behaviour.
      if (activeName.value) await loadDetails(epoch);
      return;
    }

    await loadCapabilities();
    if (guard.isStale(epoch)) return;

    if (restore) {
      mode.value = restore.mode;
      details.value = restore.details;
      draft.value = restore.draft;
      originalDraft.value = restore.originalDraft;
      loading.value = false;
      if (isEditing.value) {
        await loadDataTypeOptions();
        if (guard.isStale(epoch)) return;
        void loadOwnerRoles();
        void runPreview();
      } else {
        await loadDetails(epoch);
      }
      return;
    }

    if (mode.value === "create") {
      const kind = editableKinds.value[0] ?? "enum";
      initialKind.value = kind;
      draft.value = emptyDraft(kind, activeSchema.value || props.database);
      originalDraft.value = null;
      await loadDataTypeOptions();
      if (guard.isStale(epoch)) return;
      void loadOwnerRoles();
      void runPreview();
      return;
    }

    if (!activeName.value) return;
    await loadDetails(epoch);
    if (guard.isStale(epoch) || !details.value) return;
    if (mode.value === "edit" || openDeleteOnLoad.value) {
      originalDraft.value = draftFromDetails(details.value);
      draft.value = draftFromDetails(details.value);
      await loadDataTypeOptions();
      if (guard.isStale(epoch)) return;
      void loadOwnerRoles();
      if (mode.value === "edit") void runPreview();
    }
    if (openDeleteOnLoad.value) {
      openDeleteOnLoad.value = false;
      await nextTick();
      void openDeleteDialog();
    }
  } finally {
    if (guard.isFresh(epoch)) initializing.value = false;
  }
}

let appliedCustomTypeRequest = -1;
watch(
  () => [props.connection.id, props.database, props.schema, props.name, props.initialMode ?? "view", props.requestId ?? 0] as const,
  (next, previous) => {
    // The parent can re-target this panel (another object, another mode) without
    // asking this component. Every such change goes through the same discard gate
    // as the close button, so an unsaved draft cannot be lost silently.
    const requestId = next[5] as number;
    const isAnotherRequest = !previous || next.some((value, index) => value !== previous[index]);
    if (isAnotherRequest && requestId !== appliedCustomTypeRequest && !confirmDiscard()) return;
    appliedCustomTypeRequest = requestId;
    void initialize();
  },
  { immediate: true },
);

// --- preview ---------------------------------------------------------------

function invalidatePreview() {
  ++previewSeq;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = undefined;
  preview.value = null;
  previewLoading.value = false;
  showDestructiveConfirm.value = false;
}

async function runPreview() {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = undefined;
  const current = draft.value;
  if (!current || !isEditing.value) return;
  const seq = ++previewSeq;
  previewLoading.value = true;
  previewError.value = null;
  try {
    const result = await api.previewCustomTypeChange(props.connection.id, props.database, {
      target: targetIdentity(),
      expectedSnapshotRevision: details.value?.snapshotRevision,
      draft: pruneDraft(current),
    });
    if (seq !== previewSeq) return;
    preview.value = result;
  } catch (cause) {
    if (seq !== previewSeq) return;
    preview.value = null;
    previewError.value = messageOf(cause);
  } finally {
    if (seq === previewSeq) previewLoading.value = false;
  }
}

function schedulePreview() {
  if (!isEditing.value) return;
  invalidatePreview();
  previewTimer = setTimeout(() => void runPreview(), 250);
}

// Any mutation of the draft (including a nested field) re-plans. The 250 ms
// debounce keeps a fast typist from queueing a backend round trip per keystroke.
watch(
  draft,
  () => {
    if (!isEditing.value) return;
    schedulePreview();
  },
  { deep: true, flush: "sync" },
);

// --- save ------------------------------------------------------------------

/// Ask before applying a plan that drops or rewrites something.
///
/// Production confirmation answers a different question ("is this the right
/// database?"); this one is "do you want to lose this attribute/constraint?", and
/// it applies to every database, including local ones.
function requestSave() {
  const plan = preview.value;
  if (!canSave.value || !plan) return;
  if (plan.destructive) {
    // The confirmation opens as a plain, fully interactive gate. An earlier
    // version pre-set a "pending" flag that was merged into the dialog's
    // `loading` prop, and DangerConfirmDialog disables confirmation, cancellation
    // *and* its own close request while loading — so a destructive change could
    // never be approved.
    showDestructiveConfirm.value = true;
    return;
  }
  void save();
}

/// Run the confirmed destructive plan.
///
/// The dialog closes before the batch starts instead of being left open with
/// `loading = true`. Keeping it open would lock the modal (it refuses to close
/// while loading) for the whole duration of the statement, and a
/// `SET NOT NULL` on a large table has no cancel path wired here. This mirrors
/// how the object-browser drop confirmation runs its DDL. The panel owns the
/// in-flight state instead: Save is disabled and shows a spinner.
function confirmDestructiveSave() {
  showDestructiveConfirm.value = false;
  void save();
}

async function save() {
  const current = draft.value;
  const plan = preview.value;
  if (!canSave.value || !current || !plan) return;
  saving.value = true;
  const releaseSurface = retainSurface();
  saveError.value = null;
  const created = mode.value === "create";
  const epoch = guard.start();
  const connection = props.connection;
  const database = props.database;
  const change: CustomTypeChangeRequest = JSON.parse(
    JSON.stringify({
      target: targetIdentity(),
      expectedSnapshotRevision: details.value?.snapshotRevision,
      draft: pruneDraft(current),
    }),
  );
  try {
    const applied = await executeWithProductionSqlGuard({
      connection,
      database,
      sql: plan.statements.join(";\n"),
      source: created ? "custom-type-create" : "custom-type-alter",
      execute: () =>
        api.applyCustomTypeChange(connection.id, database, {
          change,
          expectedPlanRevision: plan.planRevision,
        }),
    });
    if (!applied || guard.isStale(epoch)) return;
    toast.toast(t(created ? "customType.editor.created" : "customType.editor.saved"), 2500);
    // Re-target locally first so the panel shows the saved object even if the
    // parent does not re-request it (create has no row to select yet).
    activeSchema.value = applied.identity.schema;
    activeName.value = applied.identity.name;
    mode.value = "view";
    details.value = null;
    draft.value = null;
    originalDraft.value = null;
    emit("saved", { identity: applied.identity, created });
    await loadDetails(guard.start());
  } catch (cause) {
    if (guard.isStale(epoch)) return;
    saveError.value = messageOf(cause);
    toast.toast(t("customType.editor.saveFailed", { message: saveError.value }), 5000);
  } finally {
    saving.value = false;
    releaseSurface();
  }
}

function startEdit() {
  if (!canEditCurrent.value || !details.value) return;
  originalDraft.value = draftFromDetails(details.value);
  draft.value = draftFromDetails(details.value);
  mode.value = "edit";
  saveError.value = null;
  void loadDataTypeOptions();
  void loadOwnerRoles();
  void runPreview();
}

/// Whether the current edit has unsaved work.
function hasUnsavedWork(): boolean {
  return isEditing.value && draftIsDirty(originalDraft.value, draft.value);
}

function confirmDiscard(): boolean {
  if (saving.value || dropping.value) return false;
  return !hasUnsavedWork() || window.confirm(t("customType.editor.discardConfirm"));
}

function requestRefresh() {
  if (saving.value || dropping.value || !confirmDiscard()) return;
  void initialize(false);
}

/// Close the panel, asking first when there is unsaved work.
function requestClose() {
  if (!confirmDiscard()) return;
  emit("dirtyChange", false);
  emit("close");
}

function cancelEdit() {
  if (!confirmDiscard()) return;
  mode.value = "view";
  draft.value = null;
  originalDraft.value = null;
  preview.value = null;
  previewError.value = null;
  saveError.value = null;
}

function changeKind(kind: CustomTypeKind) {
  if (saving.value || !draft.value || draft.value.definition.kind === kind) return;
  if (draftIsDirty(emptyDraft(draftKind.value, draft.value.schema), draft.value) && !window.confirm(t("customType.editor.changeKindConfirm"))) return;
  initialKind.value = kind;
  const schema = draft.value.schema;
  const name = draft.value.name;
  draft.value = { ...emptyDraft(kind, schema), name };
  void runPreview();
}

// --- delete ----------------------------------------------------------------

async function openDeleteDialog() {
  showDelete.value = true;
  await loadDropPreview();
}

function invalidateDropPreview() {
  ++dropPreviewSeq;
  dropPreview.value = null;
  dropPreviewLoading.value = false;
}

async function loadDropPreview() {
  invalidateDropPreview();
  const seq = dropPreviewSeq;
  const target = targetIdentity();
  if (!target || !showDelete.value) return;
  dropPreviewLoading.value = true;
  dropError.value = null;
  try {
    const result = await api.previewCustomTypeDrop(props.connection.id, props.database, {
      target,
      cascade: dropCascade.value,
    });
    if (seq !== dropPreviewSeq) return;
    dropPreview.value = result;
  } catch (cause) {
    if (seq !== dropPreviewSeq) return;
    dropError.value = messageOf(cause);
  } finally {
    if (seq === dropPreviewSeq) dropPreviewLoading.value = false;
  }
}

watch(
  dropCascade,
  () => {
    if (showDelete.value) void loadDropPreview();
  },
  { flush: "sync" },
);
watch(
  showDelete,
  (open) => {
    if (!open) invalidateDropPreview();
  },
  { flush: "sync" },
);

async function confirmDelete() {
  const target = targetIdentity();
  const plan = dropPreview.value;
  if (dropping.value || dropPreviewLoading.value || dropError.value || !target || !plan || plan.blockedChanges.length > 0) return;
  dropping.value = true;
  const releaseSurface = retainSurface();
  dropError.value = null;
  const request = { target, cascade: dropCascade.value };
  const connection = props.connection;
  const database = props.database;
  const epoch = guard.start();
  try {
    const applied = await executeWithProductionSqlGuard({
      connection,
      database,
      sql: plan.statement,
      source: "custom-type-drop",
      execute: () =>
        api.applyCustomTypeDrop(connection.id, database, {
          request,
          expectedPlanRevision: plan.planRevision,
        }),
    });
    if (!applied || guard.isStale(epoch)) return;
    showDelete.value = false;
    toast.toast(t("customType.delete.deleted", { name: `${target.schema}.${target.name}` }), 3000);
    emit("deleted", { identity: applied.identity });
  } catch (cause) {
    if (guard.isFresh(epoch)) dropError.value = messageOf(cause);
  } finally {
    dropping.value = false;
    releaseSurface();
  }
}

// --- misc ------------------------------------------------------------------

async function copyDdl() {
  if (!ddlText.value) return;
  try {
    await copyToClipboard(ddlText.value);
    toast.toast(t("contextMenu.ddlCopied"));
  } catch (cause) {
    toast.toast(t("grid.copyFailed", { message: translateBackendError(t, cause) }));
  }
}

function selectTab(next: "members" | "properties" | "ddl") {
  tab.value = next;
}

// Publish both the dirty flag and the full session. Unmount may be a cache
// eviction, so it must not discard either the draft or its original snapshot.
watch(
  [hasUnsavedWork, initializing],
  ([dirty, busy]) => {
    if (!busy) emit("dirtyChange", dirty);
  },
  { immediate: true },
);
watch(
  [mode, activeSchema, activeName, details, draft, originalDraft, initializing],
  () => {
    if (initializing.value) return;
    // Copy the serializable DTOs so a discarded component cannot mutate a saved session.
    emit(
      "sessionChange",
      JSON.parse(
        JSON.stringify({
          schema: activeSchema.value,
          name: activeName.value,
          mode: mode.value,
          details: details.value,
          draft: draft.value,
          originalDraft: originalDraft.value,
        }),
      ) as CustomTypeEditorSession,
    );
  },
  { deep: true },
);
onBeforeUnmount(() => {
  guard.bump();
  invalidatePreview();
  invalidateDropPreview();
});

defineExpose({ selectTab, confirmDiscard });
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex h-9 shrink-0 items-center gap-2 border-b bg-muted/20 px-3 py-1.5">
      <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ mode === "create" ? t("customType.editor.newTitle") : activeName }}</span>
      <Badge v-if="mode === 'create'" variant="outline" class="h-4 shrink-0 px-1.5 text-[10px]">{{ t(`customType.kinds.${draftKind}`) }}</Badge>
      <Badge v-else-if="details" variant="outline" class="h-4 shrink-0 px-1.5 text-[10px]">{{ kindLabel }}</Badge>
      <Badge v-if="readOnly" variant="outline" class="h-4 shrink-0 px-1.5 text-[10px] text-muted-foreground">{{ t("customType.editor.readOnlyConnection") }}</Badge>
      <span class="flex-1" />
      <template v-if="isEditing">
        <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="saving" @click="cancelEdit">{{ t("common.cancel") }}</Button>
        <Button variant="ghost" size="sm" class="h-6 px-2 text-xs" :disabled="!canSave" :title="localIssues[0]?.message || previewError || ''" @click="requestSave">
          <Loader2 v-if="saving" class="h-3 w-3 animate-spin" />
          <Check v-else class="h-3 w-3" />
          <span class="table-info-action-label">{{ t("structureEditor.save") }}</span>
        </Button>
      </template>
      <template v-else-if="details">
        <Button v-if="canEditCurrent" variant="ghost" size="icon" class="h-5 w-5" :title="t('customType.editor.edit')" @click="startEdit">
          <Pencil class="h-3 w-3" />
        </Button>
        <Button v-if="canManage" variant="ghost" size="icon" class="h-5 w-5" :title="t('customType.editor.delete')" @click="openDeleteDialog">
          <Trash2 class="h-3 w-3" />
        </Button>
      </template>
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('structureEditor.refresh')" :aria-label="t('structureEditor.refresh')" :disabled="loading || saving || dropping" @click="requestRefresh">
        <RefreshCw class="h-3 w-3" :class="{ 'animate-spin': loading }" />
      </Button>
      <Button variant="ghost" size="icon" class="h-5 w-5" :title="t('common.close')" :disabled="saving || dropping" @click="requestClose">
        <X class="h-3 w-3" />
      </Button>
    </div>

    <!-- create / edit -->
    <template v-if="isEditing">
      <div class="flex shrink-0 flex-col gap-2 border-b px-3 py-2">
        <div class="flex items-center gap-2">
          <Input v-if="mode === 'create'" :disabled="saving" v-model="draftSchema" class="h-7 w-36 font-mono text-xs" :placeholder="t('objects.schema')" :aria-label="t('objects.schema')" />
          <Input :disabled="saving" v-model="draftName" class="h-7 min-w-0 flex-1 font-mono text-xs" :placeholder="t('customType.editor.namePlaceholder')" :aria-label="t('customType.editor.namePlaceholder')" />
          <select :disabled="saving" v-if="mode === 'create'" class="h-7 shrink-0 rounded-md border bg-transparent px-1.5 text-xs" :value="draftKind" :aria-label="t('customType.editor.kind')" @change="changeKind(($event.target as HTMLSelectElement).value as CustomTypeKind)">
            <option v-for="kind in editableKinds" :key="kind" :value="kind">{{ t(`customType.kinds.${kind}`) }}</option>
          </select>
        </div>
        <div class="flex items-center gap-2">
          <SearchableSelect
            v-model="draftOwner"
            :options="ownerOptions"
            :placeholder="ownerPlaceholder"
            :search-placeholder="t('customType.editor.ownerSearchPlaceholder')"
            :empty-text="t('customType.editor.ownerRolesEmpty')"
            :loading-text="t('common.loading')"
            :loading="ownerRolesLoading"
            :allow-custom="true"
            :trim-custom="false"
            :clearable="mode === 'create'"
            :disabled="saving || !ownerEditable"
            trigger-class="h-7 w-36 max-w-36 px-2 text-xs font-mono"
            :aria-label="t('customType.properties.owner')"
          />
          <Input v-model="draftComment" class="h-7 min-w-0 flex-1 text-xs" :disabled="saving || !commentEditable" :placeholder="t('customType.members.comment')" :aria-label="t('customType.members.comment')" />
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-auto p-2">
        <CustomTypeDefinitionForm :disabled="saving" v-if="draft" v-model:definition="draft.definition" :original-definition="originalDraft?.definition" :kind="draftKind" :capabilities="capabilities" :is-create="mode === 'create'" :data-type-options="dataTypeOptions" />
      </div>

      <div v-if="localIssues.length || saveError" class="shrink-0 border-t px-3 py-1.5">
        <div v-for="issue in localIssues" :key="issue.code" class="text-[11px] text-destructive">{{ issue.message }}</div>
        <div v-if="saveError" class="whitespace-pre-wrap break-words text-[11px] text-destructive">{{ saveError }}</div>
      </div>

      <div class="shrink-0 px-2 pb-2">
        <CustomTypeSqlPreview v-model:collapsed="previewCollapsed" :statements="preview?.statements ?? []" :warnings="preview?.warnings ?? []" :blocked-changes="preview?.blockedChanges ?? []" :loading="previewLoading" :error="previewError" />
      </div>
    </template>

    <!-- view -->
    <template v-else>
      <div v-if="loading" class="flex flex-1 items-center justify-center text-xs text-muted-foreground">{{ t("common.loading") }}</div>

      <div v-else-if="error" class="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
        <div class="max-w-full break-words text-xs text-destructive">{{ error }}</div>
        <Button variant="outline" size="sm" class="h-6 text-xs" @click="requestRefresh">
          <RefreshCw class="h-3 w-3" />
          {{ t("common.retry") }}
        </Button>
      </div>

      <template v-else-if="details">
        <div class="flex shrink-0 items-center gap-1 border-b px-2 py-1">
          <button v-for="item in tabs" :key="item.id" type="button" class="rounded px-2 py-1 text-xs" :class="tab === item.id ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="tab = item.id">
            {{ item.label }}
          </button>
          <span class="flex-1" />
          <Button v-if="tab === 'ddl' && ddlText" variant="ghost" size="sm" class="h-6 px-2 text-xs" :title="t('grid.copyDdl')" :aria-label="t('grid.copyDdl')" @click="copyDdl">
            <Copy class="h-3 w-3" />
            <span class="table-info-action-label">{{ t("grid.copyDdl") }}</span>
          </Button>
        </div>

        <div class="min-h-0 flex-1 overflow-auto">
          <div v-if="tab === 'members' && details.members.length === 0" class="flex flex-col items-center justify-center gap-1 px-4 py-8 text-center">
            <span class="text-xs text-muted-foreground">{{ t("customType.members.empty") }}</span>
          </div>

          <table v-else-if="tab === 'members' && isFieldKind(details.kind)" class="w-full text-[11px]">
            <thead class="sticky top-0 bg-muted/40 text-left text-muted-foreground">
              <tr>
                <th class="px-3 py-1.5 font-medium">#</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.name") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.type") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.nullable") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.default") }}</th>
                <th class="px-3 py-1.5 font-medium">{{ t("customType.members.comment") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="member in details.members" :key="member.ordinal" class="border-t border-border/60">
                <td class="px-3 py-1.5 text-muted-foreground">{{ member.ordinal }}</td>
                <td class="px-3 py-1.5 font-mono">{{ member.name }}</td>
                <td class="px-3 py-1.5 font-mono">{{ member.dataType }}</td>
                <td class="px-3 py-1.5">{{ member.nullable == null ? "—" : member.nullable ? "✓" : "✗" }}</td>
                <td class="px-3 py-1.5 font-mono">{{ member.default ?? "—" }}</td>
                <td class="px-3 py-1.5">{{ member.comment ?? "—" }}</td>
              </tr>
            </tbody>
          </table>

          <ul v-else-if="tab === 'members' && isEnumKind(details.kind) && details.members.length > 0" class="divide-y divide-border/60">
            <li v-for="member in details.members" :key="member.ordinal" class="flex items-center gap-3 px-3 py-1.5 text-[11px]">
              <span class="w-6 text-right text-muted-foreground">{{ member.ordinal }}</span>
              <span class="font-mono">{{ member.enumValue }}</span>
            </li>
          </ul>

          <table v-else-if="tab === 'properties'" class="w-full text-[11px]">
            <tbody>
              <tr v-if="details.comment" class="border-b border-border/60">
                <td class="w-44 px-3 py-1.5 text-muted-foreground">{{ t("customType.members.comment") }}</td>
                <td class="px-3 py-1.5">{{ details.comment }}</td>
              </tr>
              <tr v-for="row in propertyRows" :key="row.label" class="border-b border-border/60">
                <td class="w-44 px-3 py-1.5 align-top text-muted-foreground">{{ row.label }}</td>
                <td class="px-3 py-1.5 break-all whitespace-pre-wrap font-mono">{{ row.value }}</td>
              </tr>
              <tr v-if="propertyRows.length === 0 && !details.comment" class="border-b border-border/60">
                <td colspan="2" class="px-3 py-2 text-xs text-muted-foreground">{{ t("customType.properties.empty") }}</td>
              </tr>
            </tbody>
          </table>

          <div v-else class="flex h-full flex-col">
            <div v-if="details.ddl && !details.ddl.complete" class="border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5">
              <div v-for="warning in details.ddl.warnings" :key="warning" class="text-[11px] text-amber-600 dark:text-amber-400">{{ warning }}</div>
            </div>
            <pre class="flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-relaxed">{{ ddlText || t("customType.ddl.empty") }}</pre>
          </div>
        </div>
      </template>
    </template>

    <DangerConfirmDialog v-model:open="showDestructiveConfirm" :title="t('customType.editor.destructiveTitle')" :message="t('customType.editor.destructiveMessage')" :sql="preview?.statements.join('\n') ?? ''" :confirm-label="t('structureEditor.save')" @confirm="confirmDestructiveSave">
      <template #options>
        <ul class="mb-2 list-disc pl-4 text-xs text-muted-foreground">
          <li v-for="issue in preview?.warnings ?? []" :key="`${issue.code}-${issue.message}`">{{ issue.message }}</li>
        </ul>
      </template>
    </DangerConfirmDialog>

    <CustomTypeDeleteDialog v-model:open="showDelete" v-model:cascade="dropCascade" :target="targetIdentity()" :preview="dropPreview" :loading="dropping" :preview-loading="dropPreviewLoading" :error="dropError" @confirm="confirmDelete" />
  </div>
</template>

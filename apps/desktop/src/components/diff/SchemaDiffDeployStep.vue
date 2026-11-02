<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { loadEditorTheme, editorFontTheme } from "@/lib/editor/editorThemes";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { Splitpanes, Pane } from "splitpanes";
import { oracleRoutineActiveStep, oracleRoutineDeploymentEntries, routineIdentityKey, type OracleRoutineDeployment } from "@/lib/schema/oracleRoutineDeploy";
import { oracleRoutineOperationVerified } from "@/lib/table/oracleRoutineWrite";
import { scalarPositionToUtf16Offset } from "@/lib/sql/errorPosition";
import type { OracleRoutineOperation, OracleRoutinePlanDraft } from "@/types/schemaDiff";
import type { DatabaseType } from "@/types/database";
import {
  schemaDiffObjectSelectionState,
  schemaDiffReviewAlert,
  schemaDiffSelectionTargets,
  selectedSchemaDiffObjects,
  summarizeSchemaDiffOperations,
  type SchemaDiffObject,
  type DiffOperationType,
  type DiffObjectKind,
  type CompatibilityWarning,
  type RenameCandidate,
  type MissingRollbackObject,
  type RollbackCompleteness,
} from "@/lib/schema/schemaDiff";
import ImpactReportPanel from "@/components/diff/ImpactReportPanel.vue";
import type { ImpactReport } from "@/types/governance";
import { ArrowLeft, Copy, Download, Play, Loader2, PlusCircle, XCircle, ArrowRightLeft, Table, Eye, FunctionSquare, ListOrdered, ScrollText, UserCog, Columns3, ListTree, Link2, Zap, AlertTriangle, ShieldCheck } from "@lucide/vue";

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const { isDark } = useTheme();

const props = defineProps<{
  deploySql: string;
  selectedObjects: SchemaDiffObject[];
  targetConnectionId: string;
  targetDatabase: string;
  targetSchema: string;
  executing: boolean;
  rollbackSql?: string;
  deploySqlMode?: "forward" | "rollback";
  compatibilityWarnings?: CompatibilityWarning[];
  renameCandidates?: RenameCandidate[];
  impactReport?: ImpactReport | null;
  rollbackCompleteness?: RollbackCompleteness;
  missingRollbackObjects?: MissingRollbackObject[];
  canExecute?: boolean;
  destructiveStatementCount?: number;
  /** Current value of the "ignore foreign key checks" deploy option. */
  ignoreForeignKeyChecks?: boolean;
  /** Whether the target database is MySQL, the only engine that gets the option. */
  showIgnoreForeignKeyChecks?: boolean;
  /** Skip failed statements and keep running the rest of the deploy script. */
  continueOnError?: boolean;
  databaseType?: DatabaseType;
  routineDeployment?: OracleRoutineDeployment | null;
  packageTransfer?: boolean;
}>();

const emit = defineEmits<{
  "update:deploySql": [sql: string];
  "update:deploySqlMode": [mode: "forward" | "rollback"];
  "update:ignoreForeignKeyChecks": [enabled: boolean];
  "update:continueOnError": [enabled: boolean];
  back: [];
  deploy: [];
  "select-routine": [objectId: string];
  "validate-routines": [];
  "refresh-routines": [];
  "observe-routine": [operationId: string];
  "recover-routine": [operationId: string];
  "include-package-companion": [objectId: string, source: "source" | "target"];
  "update-package-options": [objectId: string, options: Pick<OracleRoutinePlanDraft, "packageBodySource" | "packageContract" | "confirmPackagePair">];
  "review-package-target": [objectId: string];
}>();

const editorContainer = ref<HTMLDivElement>();
const editorView = shallowRef<any>(null);
const isEditorReady = ref(false);
const selectedObjectId = ref<string | null>(null);
let editorDisposed = false;
let readOnlyCompartment: any;
const routineDraft = computed(() => props.routineDeployment?.drafts.find((draft) => draft.objectId === props.routineDeployment?.selectedObjectId));
const routineStep = computed(() => (props.routineDeployment ? oracleRoutineActiveStep(props.routineDeployment) : undefined));
const routineEntries = computed(() => (props.routineDeployment ? oracleRoutineDeploymentEntries(props.routineDeployment) : []));
const routineIdentity = computed(() => routineStep.value?.identity ?? routineDraft.value?.identity);
const routineOriginals = computed(() => {
  if (routineStep.value) return { source: routineStep.value.sourceOriginal, target: routineStep.value.targetOriginal };
  const draft = routineDraft.value;
  const source = props.routineDeployment?.source;
  const target = props.routineDeployment?.target;
  return {
    source: source?.objects.find((object) => object.version.identity.owner === source.endpoint.schema && object.version.identity.name === (draft?.sourceName ?? draft?.identity.name) && object.version.identity.kind === draft?.identity.kind)?.source,
    target: target?.objects.find((object) => draft && routineIdentityKey(object.version.identity) === routineIdentityKey(draft.identity))?.source,
  };
});
const packageDraft = computed(() => (!props.routineDeployment?.recoveryPlan && !editorReadOnly.value && (routineDraft.value?.identity.kind === "PACKAGE" || routineDraft.value?.identity.kind === "PACKAGE_BODY") ? routineDraft.value : undefined));
const packagePeer = computed(() =>
  props.routineDeployment?.drafts.find(
    (draft) => draft.included && draft.identity.owner === packageDraft.value?.identity.owner && draft.identity.name === packageDraft.value?.identity.name && draft.identity.kind !== packageDraft.value?.identity.kind && (draft.identity.kind === "PACKAGE" || draft.identity.kind === "PACKAGE_BODY"),
  ),
);
function packageMaterial(source: "source" | "target", kind: "PACKAGE" | "PACKAGE_BODY") {
  const snapshot = props.routineDeployment?.[source];
  const name = source === "source" ? (packageDraft.value?.sourceName ?? packageDraft.value?.identity.name) : packageDraft.value?.identity.name;
  return snapshot?.objects.find((object) => object.version.identity.owner === snapshot.endpoint.schema && object.version.identity.name === name && object.version.identity.kind === kind && object.sourceComplete && object.source);
}
const routineRecord = computed(() => (props.routineDeployment?.recoveryPlan ? routineStep.value?.operation : routineDraft.value?.operation));
const routineCompanion = computed(() => routineRecord.value?.readback?.packageCompanion);
const routineCompanionStatus = computed(() => {
  const companion = routineCompanion.value;
  if (!companion) return "";
  if (companion.exists === false) return t("objects.routineReadbackMissing");
  if (companion.state === "invalid") return t("objects.invalid");
  if (companion.issues.length || (companion.state !== "present" && companion.state !== "verified")) return t("diff.routineUnverified");
  return companion.version?.status ?? t("diff.routineUnverified");
});
const routineHistory = computed(() => {
  const records = props.routineDeployment?.records.filter((record) => routineDraft.value && routineIdentityKey(record.identity) === routineIdentityKey(routineDraft.value.identity)) ?? [];
  return routineRecord.value && !records.some((record) => record.operationId === routineRecord.value?.operationId) ? [...records, routineRecord.value] : records;
});
const editorReadOnly = computed(() => props.executing || (!!props.routineDeployment && (!!props.routineDeployment.recoveryPlan || (!!routineDraft.value?.operation && oracleRoutineOperationVerified(routineDraft.value.operation)))));

function routineStatus(record?: OracleRoutineOperation | null, compact = false): string {
  if (!record) return t("diff.routineNeedsValidation");
  if (props.routineDeployment?.pendingOperationId === record.operationId || record.lifecycle === "running" || record.lifecycle === "unproven") return t("diff.routinePending");
  if (oracleRoutineOperationVerified(record)) return t("diff.routineVerified");
  if (record.lifecycle === "prepared") return t("diff.routinePrepared");
  if (record.readback?.state === "invalid") return t(compact ? "objects.invalid" : "objects.routineReadbackInvalid");
  return t("diff.routineUnverified");
}

async function locateOffset(offset: number) {
  if (!editorView.value) return;
  const { EditorView } = await import("@codemirror/view");
  if (!editorView.value || editorDisposed) return;
  editorView.value.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: "center" }) });
  editorView.value.focus();
}

function locateIssue(line: number, column: number) {
  void locateOffset(scalarPositionToUtf16Offset(effectiveSql.value, line, column));
}

function compilerOffset(line: number, column: number): number | undefined {
  if (line < 1 || column < 1) return;
  if (!routineStep.value || effectiveSql.value !== routineStep.value.sql || routineRecord.value?.readback?.definitionMatches !== true) return;
  const source = routineRecord.value.readback.source;
  if (!source) return;
  // ALL_ERRORS positions start at the stored program unit, not CREATE.
  // Only map the known generated prefix; retain the database coordinates when a
  // more complicated representation cannot be aligned safely.
  const prefix = /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:NON)?EDITIONABLE\s+)?/i.exec(source);
  if (!prefix) return;
  const unit = source.slice(prefix[0].length).trimEnd();
  const terminated = unit.endsWith(";") ? unit : `${unit};`;
  const offset = scalarPositionToUtf16Offset(terminated, line, column);
  // The stored unit can omit the declaration's owner while the approved draft
  // includes it. Map only the unchanged suffix, never guess inside that header.
  let suffix = 0;
  while (suffix < Math.min(terminated.length, effectiveSql.value.length) && terminated[terminated.length - suffix - 1] === effectiveSql.value[effectiveSql.value.length - suffix - 1]) suffix++;
  if (offset < terminated.length - suffix) return;
  return effectiveSql.value.length - terminated.length + offset;
}

// Parse object positions in deploySql
const objectPositions = computed(() => {
  const positions = new Map<string, { from: number; to: number }>();
  const sql = props.deploySql;
  for (const obj of topLevelObjects.value) {
    const patterns = [`-- Create ${obj.objectKind}: ${obj.name}`, `-- Alter ${obj.objectKind}: ${obj.name}`, `-- Modify ${obj.objectKind}: ${obj.name}`, `-- Drop ${obj.objectKind}: ${obj.name}`];
    for (const pattern of patterns) {
      const index = sql.indexOf(pattern);
      if (index !== -1) {
        let endPos = sql.length;
        const remaining = sql.slice(index + pattern.length);
        const nextMatch = remaining.match(/--\s*(Create|Alter|Modify|Drop)\s+\w+:/);
        if (nextMatch && nextMatch.index !== undefined) {
          endPos = index + pattern.length + nextMatch.index;
        }
        positions.set(obj.id, { from: index, to: endPos });
        break;
      }
    }
  }
  return positions;
});

async function handleSelectObject(obj: SchemaDiffObject) {
  if (props.routineDeployment) {
    emit("select-routine", obj.id);
    return;
  }
  selectedObjectId.value = obj.id;
  if (editorView.value) {
    const pos = objectPositions.value.get(obj.id);
    if (pos) {
      const { EditorView } = await import("@codemirror/view");
      editorView.value.dispatch({
        effects: EditorView.scrollIntoView(pos.from, { y: "start" }),
      });
    }
  }
}

// Filter top-level selected objects (exclude children and none)
const topLevelObjects = computed(() => {
  if (props.routineDeployment) return routineEntries.value.map((entry): SchemaDiffObject => ({ id: entry.objectId, name: entry.identity.name, routineType: entry.identity.kind, objectKind: "function", operationType: entry.action === "replace" ? "modify" : entry.action, selected: true }));
  const operationOrder: Record<DiffOperationType, number> = { create: 0, modify: 1, delete: 2, none: 3 };
  return props.selectedObjects
    .filter((o) => {
      const state = schemaDiffObjectSelectionState(o);
      return o.operationType !== "none" && (state.checked || state.indeterminate);
    })
    .sort((a, b) => operationOrder[a.operationType] - operationOrder[b.operationType]);
});

const operationCounts = computed(() => {
  return summarizeSchemaDiffOperations(props.routineDeployment ? topLevelObjects.value : props.selectedObjects);
});

const selectedObjectCount = computed(() => (props.routineDeployment ? topLevelObjects.value.length : selectedSchemaDiffObjects(props.selectedObjects).length));

const compatibilityWarningCount = computed(() => props.compatibilityWarnings?.length ?? 0);
const reviewAlert = computed(() => schemaDiffReviewAlert(props.destructiveStatementCount ?? 0, compatibilityWarningCount.value));

const renameCount = computed(() => props.renameCandidates?.length ?? 0);

const showImpactReport = ref(false);

const effectiveSql = computed(() => {
  if (props.deploySqlMode === "rollback" && props.rollbackSql) {
    return props.rollbackSql;
  }
  return props.deploySql;
});

const operationIcons: Record<DiffOperationType, any> = {
  modify: ArrowRightLeft,
  create: PlusCircle,
  delete: XCircle,
  none: ArrowRightLeft,
};

const operationColors: Record<DiffOperationType, string> = {
  modify: "text-blue-500",
  create: "text-green-500",
  delete: "text-red-500",
  none: "text-muted-foreground",
};

// Initialize CodeMirror editor
let syncingEditorSql = false;
async function initEditor() {
  if (!editorContainer.value) return;

  const [{ EditorView }, { EditorState, Compartment }, langSql, { basicSetup }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror")]);
  if (editorDisposed || !editorContainer.value) return;

  const themeComp = new Compartment();
  const fontComp = new Compartment();
  readOnlyCompartment = new Compartment();

  const editorTheme = settingsStore.editorSettings.theme;
  const appAppearance = isDark.value ? "dark" : "light";
  const fontSize = settingsStore.editorSettings.fontSize;
  const fontFamily = settingsStore.editorSettings.fontFamily;

  const themeExt = await loadEditorTheme(editorTheme, appAppearance);
  if (editorDisposed || !editorContainer.value) return;
  const fontExt = editorFontTheme(EditorView, fontSize, fontFamily, { fixedHeight: true, scrollable: true });

  const dialect = createDbxCodeMirrorSqlDialect(langSql, props.databaseType === "oracle" || props.databaseType === "oceanbase-oracle" ? "oracle" : "postgres");

  const state = EditorState.create({
    doc: effectiveSql.value,
    extensions: [
      basicSetup,
      langSql.sql({ dialect }),
      themeComp.of(themeExt),
      fontComp.of(fontExt),
      readOnlyCompartment.of(EditorState.readOnly.of(editorReadOnly.value)),
      EditorView.updateListener.of((update: any) => {
        if (update.docChanged && !syncingEditorSql) {
          emit("update:deploySql", update.state.doc.toString());
        }
      }),
    ],
  });

  editorView.value = new EditorView({ state, parent: editorContainer.value });
  isEditorReady.value = true;
}

// Watch for external deploySql changes (including mode switch)
watch(
  () => effectiveSql.value,
  (newVal) => {
    if (editorView.value && editorView.value.state.doc.toString() !== newVal) {
      syncingEditorSql = true;
      try {
        editorView.value.dispatch({
          changes: { from: 0, to: editorView.value.state.doc.length, insert: newVal },
        });
      } finally {
        syncingEditorSql = false;
      }
    }
  },
);

watch(editorReadOnly, async (readOnly) => {
  if (!editorView.value || !readOnlyCompartment) return;
  const { EditorState } = await import("@codemirror/state");
  if (!editorView.value || editorDisposed) return;
  editorView.value.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
});

onMounted(() => {
  initEditor();
});

onUnmounted(() => {
  editorDisposed = true;
  editorView.value?.destroy();
  editorView.value = null;
});

function handleCopy() {
  copyToClipboard(props.deploySql);
  toast(t("diff.copied"), 2000);
}

async function handleExport() {
  try {
    const dbName = props.targetDatabase || "deploy";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultName = `${dbName}_deploy_${timestamp}.sql`;

    const { save } = await import("@tauri-apps/plugin-dialog");
    const path = await save({
      defaultPath: defaultName,
      filters: [{ name: "SQL", extensions: ["sql"] }],
    });

    if (path) {
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(path, props.deploySql);
      toast(t("diff.exportSuccess"), 3000);
    }
  } catch (e: any) {
    toast(e?.message || String(e), 5000);
  }
}

function handleDeploy() {
  emit("deploy");
}

function getOperationLabel(type: DiffOperationType): string {
  switch (type) {
    case "create":
      return t("diff.create");
    case "delete":
      return t("diff.delete");
    case "modify":
      return t("diff.modify");
    default:
      return "";
  }
}

function getObjectIcon(kind: DiffObjectKind) {
  switch (kind) {
    case "table":
      return Table;
    case "view":
      return Eye;
    case "function":
      return FunctionSquare;
    case "sequence":
      return ListOrdered;
    case "rule":
      return ScrollText;
    case "owner":
      return UserCog;
    case "column":
      return Columns3;
    case "index":
      return ListTree;
    case "foreignKey":
      return Link2;
    case "trigger":
      return Zap;
    default:
      return Table;
  }
}

function getObjectIconColor(kind: DiffObjectKind): string {
  switch (kind) {
    case "table":
      return "text-amber-500";
    case "view":
      return "text-cyan-500";
    case "function":
      return "text-purple-500";
    case "sequence":
      return "text-orange-500";
    case "rule":
      return "text-pink-500";
    case "owner":
      return "text-indigo-500";
    case "column":
      return "text-sky-500";
    case "index":
      return "text-teal-500";
    case "foreignKey":
      return "text-lime-500";
    case "trigger":
      return "text-rose-500";
    default:
      return "text-muted-foreground";
  }
}
</script>

<template>
  <div class="flex flex-col h-full">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2 border-b shrink-0">
      <div class="flex items-center gap-2">
        <Button v-if="!packageTransfer" variant="ghost" size="sm" class="h-7 px-2 text-xs gap-1" @click="$emit('back')">
          <ArrowLeft class="w-3.5 h-3.5" />
          {{ t("diff.backToResult") }}
        </Button>
        <span class="text-sm font-medium">{{ t("diff.deployReview") }}</span>
        <span class="text-xs text-muted-foreground"> ({{ t("diff.selectedCount", { selected: selectedObjectCount, total: selectedObjectCount }) }}) </span>
        <span v-if="reviewAlert" class="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium" :class="reviewAlert === 'destructive' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'">
          <AlertTriangle class="w-3 h-3" />
          {{ reviewAlert === "destructive" ? t("diff.destructiveSqlDetected", { count: destructiveStatementCount }) : t("diff.compatibilityWarningsDetected", { count: compatibilityWarningCount }) }}
        </span>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <span class="text-green-500">{{ t("diff.create") }}: {{ operationCounts.create }}</span>
        <span class="text-blue-500">{{ t("diff.modify") }}: {{ operationCounts.modify }}</span>
        <span class="text-red-500">{{ t("diff.delete") }}: {{ operationCounts.delete }}</span>
        <span v-if="renameCount > 0" class="text-purple-500">{{ t("diff.renameCount", { count: renameCount }) }}</span>
      </div>
    </div>

    <!-- Impact Report toggle -->
    <div v-if="impactReport" class="border-b shrink-0">
      <button class="flex items-center gap-2 w-full px-3 py-1.5 text-xs hover:bg-accent/50 transition-colors" @click="showImpactReport = !showImpactReport">
        <ShieldCheck class="w-3.5 h-3.5" :class="impactReport.overallRisk === 'safe' ? 'text-green-500' : impactReport.overallRisk === 'caution' ? 'text-yellow-500' : impactReport.overallRisk === 'dangerous' ? 'text-orange-500' : 'text-red-500'" />
        <span class="font-medium">{{ t("impact.title") }}</span>
        <span class="ml-auto text-muted-foreground">{{ showImpactReport ? "▲" : "▼" }}</span>
      </button>
      <div v-if="showImpactReport" class="border-t">
        <ImpactReportPanel :report="impactReport" />
      </div>
    </div>

    <div v-if="rollbackCompleteness === 'incomplete' && deploySqlMode === 'rollback'" class="px-3 py-1.5 border-b bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 shrink-0">
      {{ t("diff.rollbackIncompleteBanner") }}
      <ul v-if="missingRollbackObjects?.length" class="mt-1 list-disc pl-4">
        <li v-for="(m, i) in missingRollbackObjects" :key="i">{{ m.kind }} {{ m.name }}{{ m.table ? ` @ ${m.table}` : "" }} — {{ m.reason }}</li>
      </ul>
    </div>
    <!-- Content -->
    <Splitpanes class="flex-1 min-h-0">
      <Pane size="30" min-size="20">
        <div class="h-full overflow-auto p-2 space-y-0.5">
          <div
            v-for="obj in topLevelObjects"
            :key="obj.id"
            role="button"
            tabindex="0"
            class="flex flex-wrap items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/50 cursor-pointer focus-visible:ring-2 focus-visible:ring-ring"
            :class="{ 'bg-primary/10': (routineDeployment?.selectedObjectId ?? selectedObjectId) === obj.id }"
            @click="handleSelectObject(obj)"
            @keydown.enter.prevent="handleSelectObject(obj)"
            @keydown.space.prevent="handleSelectObject(obj)"
          >
            <component :is="operationIcons[obj.operationType]" class="w-3.5 h-3.5 shrink-0" :class="operationColors[obj.operationType]" />
            <component :is="getObjectIcon(obj.objectKind)" class="w-3.5 h-3.5 shrink-0" :class="getObjectIconColor(obj.objectKind)" />
            <span class="truncate">{{ obj.name }}</span>
            <span v-if="obj.routineType === 'PACKAGE' || obj.routineType === 'PACKAGE_BODY'" class="text-muted-foreground">{{ obj.routineType.replaceAll("_", " ") }}</span>
            <span v-if="obj.children?.length" class="text-[10px] text-muted-foreground shrink-0">{{ schemaDiffSelectionTargets(obj).filter((child) => child.selected).length }}/{{ schemaDiffSelectionTargets(obj).length }}</span>
            <span class="text-[10px] text-muted-foreground shrink-0 ml-auto">
              {{ getOperationLabel(obj.operationType) }}
            </span>
            <span v-if="routineDeployment" class="basis-full pl-5 text-xs text-muted-foreground">{{ routineStatus(routineEntries.find((entry) => entry.objectId === obj.id)?.operation, true) }}</span>
          </div>
          <div v-if="topLevelObjects.length === 0" class="text-xs text-muted-foreground text-center py-4">
            {{ t("diff.noObjectsSelected") }}
          </div>
        </div>
      </Pane>

      <Pane size="70" min-size="40">
        <div class="flex h-full min-w-0 flex-col">
          <div v-if="routineDeployment" class="max-h-[50%] shrink-0 space-y-2 overflow-y-auto border-b px-3 py-2 text-xs">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span v-if="routineIdentity" class="break-all font-mono">{{ routineIdentity.owner }}.{{ routineIdentity.name }} · {{ routineIdentity.kind }}</span>
              <span class="ml-auto" aria-live="polite">{{ routineDeployment.validating ? t("diff.routineChecking") : routineStatus(routineRecord) }}</span>
            </div>
            <p v-if="routineDeployment.recoveryPlan" class="text-amber-700 dark:text-amber-300">{{ t("diff.routineRecoveryNote") }}</p>
            <p v-else-if="editorReadOnly && !executing" class="text-muted-foreground">{{ t("diff.routineReadOnlyCompleted") }}</p>
            <div v-if="packageDraft" class="space-y-2">
              <div v-if="routineDeployment && routineDeployment.source.endpoint.databaseType !== routineDeployment.target.endpoint.databaseType" class="space-y-1 text-amber-700 dark:text-amber-300">
                <p>{{ routineDeployment.source.endpoint.databaseType }} → {{ routineDeployment.target.endpoint.databaseType }} · {{ t("diff.packageCrossProduct") }}</p>
                <Button v-if="!packageDraft.reviewedTargetDraft && packageDraft.sql?.trim()" variant="outline" size="sm" :disabled="executing" @click="emit('review-package-target', packageDraft.objectId)">{{ t("diff.packageReviewTarget") }}</Button>
              </div>
              <div v-if="packageDraft.identity.kind === 'PACKAGE' && packageDraft.action !== 'delete'" class="flex flex-wrap gap-2">
                <Button v-if="packageMaterial('source', 'PACKAGE_BODY') && (!packageTransfer || !packageMaterial('target', 'PACKAGE_BODY'))" variant="outline" size="sm" :disabled="executing" @click="emit('include-package-companion', packageDraft.objectId, 'source')">{{
                  t("diff.packageUseSourceBody")
                }}</Button>
                <Button v-if="!packageTransfer && packageMaterial('target', 'PACKAGE_BODY')" variant="outline" size="sm" :disabled="executing" @click="emit('include-package-companion', packageDraft.objectId, 'target')">{{ t("diff.packageRebuildTargetBody") }}</Button>
              </div>
              <div v-if="packageDraft.identity.kind === 'PACKAGE_BODY'" class="space-y-2">
                <Button
                  v-if="!packagePeer && packageMaterial(packageDraft.action === 'delete' ? 'target' : 'source', 'PACKAGE') && (!packageTransfer || !packageMaterial('target', 'PACKAGE'))"
                  variant="outline"
                  size="sm"
                  :disabled="executing"
                  @click="emit('include-package-companion', packageDraft.objectId, 'source')"
                  >{{ t(packageDraft.action === "delete" ? "diff.packageDeleteWhole" : "diff.packageAddSpecification") }}</Button
                >
                <div v-if="packageDraft.action !== 'delete'" class="flex flex-wrap gap-3" role="radiogroup" :aria-label="t('diff.packageContract')">
                  <label v-for="contract in ['source', 'target'] as const" :key="contract" class="flex items-center gap-1.5">
                    <input type="radio" name="package-contract" :value="contract" :checked="(packageDraft.packageContract ?? 'source') === contract" :disabled="executing" @change="emit('update-package-options', packageDraft.objectId, { packageContract: contract })" />
                    {{ t(contract === "source" ? "diff.packageSourceContract" : "diff.packageTargetContract") }}
                  </label>
                </div>
              </div>
              <label v-if="packageDraft.identity.kind === 'PACKAGE' && (packageDraft.action !== 'create' || packageMaterial('target', 'PACKAGE_BODY') || routineStep?.packageImpact?.bodyPending)" class="flex items-start gap-2 text-amber-700 dark:text-amber-300">
                <input type="checkbox" class="mt-0.5" :checked="packageDraft.confirmPackagePair ?? false" :disabled="executing" @change="emit('update-package-options', packageDraft.objectId, { confirmPackagePair: ($event.target as HTMLInputElement).checked })" />
                {{ t(packageDraft.action === "delete" ? "diff.packageConfirmDrop" : "diff.packageConfirmImpact") }}
              </label>
            </div>
            <p v-if="routineStep?.packageImpact?.bodyPending" class="text-amber-700 dark:text-amber-300">{{ t("diff.packageSpecificationOnly") }}</p>
            <p v-if="routineStep?.packageImpact?.mayInitialize" class="text-muted-foreground">{{ t("diff.packageInitialization") }}</p>
            <details v-if="routineStep?.packageImpact?.grants" class="max-h-32 overflow-auto text-muted-foreground">
              <summary class="cursor-pointer">{{ t("diff.packageGrantBackup") }}</summary>
              <p v-if="!routineStep.packageImpact.grants.complete" class="text-amber-700 dark:text-amber-300">{{ routineStep.packageImpact.grants.issue }}</p>
              <p v-for="(grant, index) in routineStep.packageImpact.grants.grants" :key="index" class="mt-1 break-all font-mono">{{ grant.grantor }} → {{ grant.grantee }} · {{ grant.privilege }} · GRANTABLE={{ grant.grantable }}</p>
            </details>
            <div v-if="routineDeployment.error || routineStep?.issues.length" role="alert" tabindex="-1" class="max-h-40 space-y-1 overflow-auto text-destructive">
              <p v-if="routineDeployment.error" class="whitespace-pre-wrap break-words">{{ routineDeployment.error }}</p>
              <button v-for="(issue, index) in routineStep?.issues ?? []" :key="index" type="button" class="block w-full text-left hover:underline focus-visible:ring-2 focus-visible:ring-ring" @click="locateIssue(issue.line, issue.column)">
                {{ issue.line }}:{{ issue.column }} — {{ issue.message }}
              </button>
            </div>
            <details v-if="routineOriginals.source" class="max-h-40 overflow-auto text-muted-foreground">
              <summary class="cursor-pointer">{{ t("diff.sourceDdl") }}</summary>
              <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyToClipboard(routineOriginals.source)">{{ t("diff.copySourceDdl") }}</Button>
              <pre class="mt-1 whitespace-pre-wrap break-words font-mono">{{ routineOriginals.source }}</pre>
            </details>
            <details v-if="routineOriginals.target" class="max-h-40 overflow-auto text-muted-foreground">
              <summary class="cursor-pointer">{{ t("diff.targetDdl") }}</summary>
              <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyToClipboard(routineOriginals.target)">{{ t("diff.copyTargetDdl") }}</Button>
              <pre class="mt-1 whitespace-pre-wrap break-words font-mono">{{ routineOriginals.target }}</pre>
            </details>
            <details v-if="routineStep?.incomingCallers.length" class="max-h-32 overflow-auto text-muted-foreground">
              <summary class="cursor-pointer">{{ t("diff.routineCallers") }} ({{ routineStep.incomingCallers.length }})</summary>
              <p v-for="(caller, index) in routineStep.incomingCallers" :key="index" class="mt-1 break-all font-mono">{{ caller.owner }}.{{ caller.name }} · {{ caller.kind }}</p>
            </details>
            <div v-if="routineRecord" class="max-h-56 space-y-1 overflow-auto break-words" aria-live="polite">
              <p v-if="routineRecord.dispatched">{{ routineRecord.acknowledged ? t("objects.routineWriteAcknowledged") : t("diff.routineDispatched") }}</p>
              <p v-if="routineRecord.error" class="whitespace-pre-wrap text-destructive">{{ routineRecord.error }}</p>
              <p v-for="(issue, index) in routineRecord.readback?.issues ?? []" :key="index" class="text-destructive">{{ issue.message }}</p>
              <button
                v-for="(message, index) in routineRecord.readback?.compilerMessages ?? []"
                :key="index"
                type="button"
                class="block w-full text-left"
                :class="message.attribute === 'ERROR' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'"
                :disabled="compilerOffset(message.line, message.position) === undefined"
                @click="locateOffset(compilerOffset(message.line, message.position)!)"
              >
                {{ message.attribute }} {{ message.line }}:{{ message.position }} — {{ message.text }}
              </button>
              <details v-if="routineRecord.readback?.source" class="max-h-40 overflow-auto text-muted-foreground">
                <summary class="cursor-pointer">{{ t("diff.targetDdl") }} · {{ routineRecord.identity.kind.replaceAll("_", " ") }}</summary>
                <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyToClipboard(routineRecord.readback.source)">{{ t("diff.copyTargetDdl") }}</Button>
                <pre class="mt-1 whitespace-pre-wrap break-words font-mono">{{ routineRecord.readback.source }}</pre>
              </details>
              <div v-if="routineCompanion" class="space-y-1 border-t pt-2">
                <p class="break-all font-mono">{{ routineCompanion.identity.kind.replaceAll("_", " ") }} {{ routineCompanion.identity.name }} · {{ routineCompanionStatus }}</p>
                <p v-for="(issue, index) in routineCompanion.issues" :key="index" class="text-destructive">{{ issue.message }}</p>
                <p v-for="(message, index) in routineCompanion.compilerMessages" :key="index" :class="message.attribute === 'ERROR' ? 'text-destructive' : 'text-amber-700 dark:text-amber-300'">{{ message.attribute }} {{ message.line }}:{{ message.position }} — {{ message.text }}</p>
                <details v-if="routineCompanion.source" class="max-h-40 overflow-auto text-muted-foreground">
                  <summary class="cursor-pointer">{{ t("diff.targetDdl") }} · {{ routineCompanion.identity.kind.replaceAll("_", " ") }}</summary>
                  <Button variant="ghost" size="sm" class="h-7 text-xs" @click="copyToClipboard(routineCompanion.source)">{{ t("diff.copyTargetDdl") }}</Button>
                  <pre class="mt-1 whitespace-pre-wrap break-words font-mono">{{ routineCompanion.source }}</pre>
                </details>
              </div>
              <Button v-if="routineRecord.lifecycle !== 'prepared'" variant="outline" size="sm" class="h-7 text-xs" :disabled="executing || routineDeployment.validating" @click="emit('observe-routine', routineRecord.operationId)">{{ t("diff.routineObserve") }}</Button>
              <Button v-if="routineRecord.lifecycle === 'terminal' && routineRecord.dispatched" variant="ghost" size="sm" class="h-7 text-xs" :disabled="executing || routineDeployment.validating" @click="emit('recover-routine', routineRecord.operationId)">{{
                t("diff.routineRecoveryPreview")
              }}</Button>
            </div>
            <p v-if="routineDeployment.stopRequested" class="text-muted-foreground">{{ t("diff.routineStopped") }}</p>
            <details v-if="routineHistory.length" class="text-muted-foreground">
              <summary class="cursor-pointer">{{ t("diff.routineHistory", { count: routineHistory.length }) }}</summary>
              <p v-for="record in routineHistory" :key="record.operationId" class="mt-1 break-all font-mono">{{ record.operationId }} — {{ routineStatus(record, true) }}</p>
            </details>
          </div>
          <div ref="editorContainer" class="deploy-sql-editor min-h-0 w-full flex-1" />
        </div>
      </Pane>
    </Splitpanes>

    <!-- Footer -->
    <div class="flex items-center justify-between px-3 py-2 border-t shrink-0 gap-2">
      <div class="flex items-center gap-2">
        <!-- SQL mode toggle -->
        <div v-if="props.rollbackSql" class="flex items-center gap-1 mr-2 border rounded">
          <button :disabled="executing" class="text-xs px-2 py-1 rounded transition-colors" :class="props.deploySqlMode === 'forward' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'" @click="$emit('update:deploySqlMode', 'forward')">{{ t("diff.deployMode") }}</button>
          <button :disabled="executing" class="text-xs px-2 py-1 rounded transition-colors" :class="props.deploySqlMode === 'rollback' ? 'bg-destructive text-destructive-foreground' : 'hover:bg-accent'" @click="$emit('update:deploySqlMode', 'rollback')">{{ t("diff.rollbackMode") }}</button>
        </div>
        <Button variant="outline" size="sm" class="h-7 text-xs gap-1" @click="handleCopy">
          <Copy class="w-3.5 h-3.5" />
          {{ t("diff.copyScript") }}
        </Button>
        <Button variant="outline" size="sm" class="h-7 text-xs gap-1" @click="handleExport">
          <Download class="w-3.5 h-3.5" />
          {{ t("diff.exportSql") }}
        </Button>
        <!-- Offered for MySQL targets only: the toggle is a MySQL session
             variable, and for any other engine the backend returns the script
             without it. -->
        <label v-if="showIgnoreForeignKeyChecks" class="flex items-center gap-1.5 text-xs" :class="executing ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'" :title="t('diff.ignoreForeignKeyChecksHint')">
          <input type="checkbox" class="accent-primary" :checked="ignoreForeignKeyChecks === true" :disabled="executing" @change="emit('update:ignoreForeignKeyChecks', ($event.target as HTMLInputElement).checked)" />
          {{ t("diff.ignoreForeignKeyChecks") }}
        </label>
        <label v-if="!routineDeployment" class="flex items-center gap-1.5 text-xs" :class="executing ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'" :title="t('diff.continueOnErrorHint')">
          <input type="checkbox" class="accent-primary" :checked="continueOnError === true" :disabled="executing" @change="emit('update:continueOnError', ($event.target as HTMLInputElement).checked)" />
          {{ t("diff.continueOnError") }}
        </label>
      </div>
      <div class="flex items-center gap-2">
        <Button v-if="routineDeployment" variant="outline" size="sm" class="h-7 text-xs" :disabled="executing || routineDeployment.validating" @click="emit('refresh-routines')">{{ t("diff.routineRefreshBaseline") }}</Button>
        <Button v-if="routineDeployment" variant="outline" size="sm" class="h-7 text-xs" :disabled="executing || routineDeployment.validating" @click="emit('validate-routines')">{{ t("diff.routineValidate") }}</Button>
        <Button v-if="!packageTransfer" variant="ghost" size="sm" class="h-7 text-xs gap-1" @click="$emit('back')">
          <ArrowLeft class="w-3.5 h-3.5" />
          {{ t("diff.backToResult") }}
        </Button>
        <Button v-if="!packageTransfer" variant="ghost" size="sm" class="h-7 text-xs" @click="$emit('back')">
          {{ t("diff.cancel") }}
        </Button>
        <Button v-if="!packageTransfer" size="sm" class="h-7 text-xs gap-1" :disabled="topLevelObjects.length === 0 || executing || canExecute === false" @click="handleDeploy">
          <Loader2 v-if="executing" class="w-3.5 h-3.5 animate-spin" />
          <Play v-else class="w-3.5 h-3.5" />
          {{ t("diff.deployToServer") }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* CodeMirror's own selection layer isn't styled here, so selecting text in the deploy
   script preview renders with no visible highlight at all in some environments. Match
   the override already used by the other read-only CodeMirror views (DdlViewDialog,
   NacosAdminConsole). */
.deploy-sql-editor :deep(.cm-selectionBackground),
.deploy-sql-editor :deep(.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

.deploy-sql-editor :deep(.cm-content ::selection) {
  background: var(--dbx-editor-selection-background, rgba(59, 130, 246, 0.35)) !important;
}

:deep(.splitpanes--vertical > .splitpanes__splitter) {
  width: 4px;
  background: var(--border);
  cursor: col-resize;
}
:deep(.splitpanes--vertical > .splitpanes__splitter:hover) {
  background: var(--primary);
}
</style>

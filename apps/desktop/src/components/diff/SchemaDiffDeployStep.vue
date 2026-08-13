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
import { schemaDiffReviewAlert, selectedSchemaDiffObjects, summarizeSchemaDiffOperations, type SchemaDiffObject, type DiffOperationType, type DiffObjectKind, type CompatibilityWarning, type RenameCandidate, type MissingRollbackObject, type RollbackCompleteness } from "@/lib/schema/schemaDiff";
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
}>();

const emit = defineEmits<{
  "update:deploySql": [sql: string];
  "update:deploySqlMode": [mode: "forward" | "rollback"];
  back: [];
  deploy: [];
}>();

const editorContainer = ref<HTMLDivElement>();
const editorView = shallowRef<any>(null);
const isEditorReady = ref(false);
const selectedObjectId = ref<string | null>(null);

// Parse object positions in deploySql
const objectPositions = computed(() => {
  const positions = new Map<string, { from: number; to: number }>();
  const sql = props.deploySql;
  for (const obj of topLevelObjects.value) {
    const patterns = [`-- Create ${obj.objectKind}: ${obj.name}`, `-- Modify ${obj.objectKind}: ${obj.name}`, `-- Drop ${obj.objectKind}: ${obj.name}`];
    for (const pattern of patterns) {
      const index = sql.indexOf(pattern);
      if (index !== -1) {
        let endPos = sql.length;
        const remaining = sql.slice(index + pattern.length);
        const nextMatch = remaining.match(/--\s*(Create|Modify|Drop)\s+\w+:/);
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
  const operationOrder: Record<DiffOperationType, number> = { create: 0, modify: 1, delete: 2, none: 3 };
  return props.selectedObjects
    .filter((o) => {
      const isTopLevel = !o.id.startsWith("col-") && !o.id.startsWith("idx-") && !o.id.startsWith("fk-") && !o.id.startsWith("trg-");
      return o.selected && o.operationType !== "none" && isTopLevel;
    })
    .sort((a, b) => operationOrder[a.operationType] - operationOrder[b.operationType]);
});

const operationCounts = computed(() => {
  return summarizeSchemaDiffOperations(props.selectedObjects);
});

const selectedObjectCount = computed(() => selectedSchemaDiffObjects(props.selectedObjects).length);

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
async function initEditor() {
  if (!editorContainer.value) return;

  const [{ EditorView }, { EditorState, Compartment }, langSql, { basicSetup }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror")]);

  const themeComp = new Compartment();
  const fontComp = new Compartment();

  const editorTheme = settingsStore.editorSettings.theme;
  const appAppearance = isDark.value ? "dark" : "light";
  const fontSize = settingsStore.editorSettings.fontSize;
  const fontFamily = settingsStore.editorSettings.fontFamily;

  const themeExt = await loadEditorTheme(editorTheme, appAppearance);
  const fontExt = editorFontTheme(EditorView, fontSize, fontFamily, { fixedHeight: true, scrollable: true });

  const dialect = createDbxCodeMirrorSqlDialect(langSql, "postgres");

  const state = EditorState.create({
    doc: effectiveSql.value,
    extensions: [
      basicSetup,
      langSql.sql({ dialect }),
      themeComp.of(themeExt),
      fontComp.of(fontExt),
      EditorView.updateListener.of((update: any) => {
        if (update.docChanged) {
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
      editorView.value.dispatch({
        changes: { from: 0, to: editorView.value.state.doc.length, insert: newVal },
      });
    }
  },
);

onMounted(() => {
  initEditor();
});

onUnmounted(() => {
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
        <Button variant="ghost" size="sm" class="h-7 px-2 text-xs gap-1" @click="$emit('back')">
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
          <div v-for="obj in topLevelObjects" :key="obj.id" class="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/50 cursor-pointer" :class="{ 'bg-primary/10': selectedObjectId === obj.id }" @click="handleSelectObject(obj)">
            <component :is="operationIcons[obj.operationType]" class="w-3.5 h-3.5 shrink-0" :class="operationColors[obj.operationType]" />
            <component :is="getObjectIcon(obj.objectKind)" class="w-3.5 h-3.5 shrink-0" :class="getObjectIconColor(obj.objectKind)" />
            <span class="truncate">{{ obj.name }}</span>
            <span class="text-[10px] text-muted-foreground shrink-0 ml-auto">
              {{ getOperationLabel(obj.operationType) }}
            </span>
          </div>
          <div v-if="topLevelObjects.length === 0" class="text-xs text-muted-foreground text-center py-4">
            {{ t("diff.noObjectsSelected") }}
          </div>
        </div>
      </Pane>

      <Pane size="70" min-size="40">
        <div ref="editorContainer" class="h-full w-full" />
      </Pane>
    </Splitpanes>

    <!-- Footer -->
    <div class="flex items-center justify-between px-3 py-2 border-t shrink-0 gap-2">
      <div class="flex items-center gap-2">
        <!-- SQL mode toggle -->
        <div v-if="props.rollbackSql" class="flex items-center gap-1 mr-2 border rounded">
          <button class="text-xs px-2 py-1 rounded transition-colors" :class="props.deploySqlMode === 'forward' ? 'bg-primary text-primary-foreground' : 'hover:bg-accent'" @click="$emit('update:deploySqlMode', 'forward')">{{ t("diff.deployMode") }}</button>
          <button class="text-xs px-2 py-1 rounded transition-colors" :class="props.deploySqlMode === 'rollback' ? 'bg-destructive text-destructive-foreground' : 'hover:bg-accent'" @click="$emit('update:deploySqlMode', 'rollback')">{{ t("diff.rollbackMode") }}</button>
        </div>
        <Button variant="outline" size="sm" class="h-7 text-xs gap-1" @click="handleCopy">
          <Copy class="w-3.5 h-3.5" />
          {{ t("diff.copyScript") }}
        </Button>
        <Button variant="outline" size="sm" class="h-7 text-xs gap-1" @click="handleExport">
          <Download class="w-3.5 h-3.5" />
          {{ t("diff.exportSql") }}
        </Button>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="ghost" size="sm" class="h-7 text-xs gap-1" @click="$emit('back')">
          <ArrowLeft class="w-3.5 h-3.5" />
          {{ t("diff.backToResult") }}
        </Button>
        <Button variant="ghost" size="sm" class="h-7 text-xs" @click="$emit('back')">
          {{ t("diff.cancel") }}
        </Button>
        <Button size="sm" class="h-7 text-xs gap-1" :disabled="topLevelObjects.length === 0 || executing || canExecute === false" @click="handleDeploy">
          <Loader2 v-if="executing" class="w-3.5 h-3.5 animate-spin" />
          <Play v-else class="w-3.5 h-3.5" />
          {{ t("diff.deployToServer") }}
        </Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
:deep(.splitpanes--vertical > .splitpanes__splitter) {
  width: 4px;
  background: var(--border);
  cursor: col-resize;
}
:deep(.splitpanes--vertical > .splitpanes__splitter:hover) {
  background: var(--primary);
}
</style>

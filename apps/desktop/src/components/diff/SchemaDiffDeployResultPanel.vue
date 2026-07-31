<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { copyToClipboard } from "@/lib/common/clipboard";
import { useToast } from "@/composables/useToast";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTheme } from "@/composables/useTheme";
import { createReadOnlyCodeTheme, editorFontTheme } from "@/lib/editor/editorThemes";
import { createDbxCodeMirrorSqlDialect } from "@/lib/editor/codemirrorSqlDialect";
import { Splitpanes, Pane } from "splitpanes";
import type { DeployObjectResult, DiffOperationType, DiffObjectKind } from "@/lib/schema/schemaDiff";
import { buildDeploySqlObjects } from "@/lib/schema/schemaDiff";
import { AlertTriangle, CheckCircle2, Copy, XCircle, ArrowRightLeft, PlusCircle, Table, Eye, FunctionSquare, ListOrdered, ScrollText, UserCog, ListTree, Link2, Zap } from "@lucide/vue";
import SchemaDiffDeployErrorDialog from "./SchemaDiffDeployErrorDialog.vue";

const { t } = useI18n();
const { toast } = useToast();
const settingsStore = useSettingsStore();
const { isDark } = useTheme();

const props = defineProps<{
  deploySql: string;
  objectResults: DeployObjectResult[];
  overallStatus: string;
  affectedRows?: number;
  executionTimeMs?: number;
  error?: string;
}>();

const emit = defineEmits<{
  close: [];
}>();

const selectedObjectId = ref<string | null>(null);
const editorContainer = ref<HTMLDivElement>();
const editorView = shallowRef<any>(null);
const isEditorReady = ref(false);
const errorDialogOpen = ref(false);
const errorDialogMessage = ref("");

const selectedResult = computed(() => {
  if (!selectedObjectId.value) return null;
  return props.objectResults.find((r) => r.objectId === selectedObjectId.value) ?? null;
});

const selectedObjectSql = computed(() => {
  if (!selectedResult.value) return props.deploySql || "--";
  const items = buildDeploySqlObjects([selectedResult.value.object]);
  return items[0]?.sql || "--";
});

function handleSelectObject(result: DeployObjectResult) {
  selectedObjectId.value = result.objectId;
}

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

function getStatusIcon(result: DeployObjectResult) {
  if (result.status === "success") return CheckCircle2;
  return XCircle;
}

function getStatusIconClass(result: DeployObjectResult) {
  if (result.status === "success") return "text-green-500";
  if (result.status === "skipped") return "text-amber-500";
  return "text-red-500";
}

function handleCopyObjectSql() {
  if (!selectedResult.value) return;
  copyToClipboard(selectedObjectSql.value);
  toast(t("diff.copied"), 2000);
}

function handleShowError(error: string | undefined) {
  if (!error) return;
  errorDialogMessage.value = error;
  errorDialogOpen.value = true;
}

function getStatementError(result: DeployObjectResult): string | undefined {
  const failed = result.statements.find((s) => s.status === "failed" || s.status === "rolled_back");
  return failed?.error ?? result.error;
}

const selectedObjectError = computed(() => {
  if (!selectedResult.value) return undefined;
  return getStatementError(selectedResult.value) ?? selectedResult.value.error;
});

function handleCopyError() {
  if (!selectedObjectError.value) return;
  copyToClipboard(selectedObjectError.value);
  toast(t("diff.copied"), 2000);
}

const overallStatusClass = computed(() => {
  if (props.overallStatus === "committed") return "text-green-600";
  if (props.overallStatus === "rolled_back") return "text-red-600";
  return "text-amber-600";
});

async function initEditor() {
  if (!editorContainer.value) return;

  const [{ EditorView }, { EditorState }, langSql, { basicSetup }] = await Promise.all([import("@codemirror/view"), import("@codemirror/state"), import("@codemirror/lang-sql"), import("codemirror")]);

  const fontSize = settingsStore.editorSettings.fontSize;
  const fontFamily = settingsStore.editorSettings.fontFamily;

  const themeExt = await createReadOnlyCodeTheme(isDark.value);
  const fontExt = editorFontTheme(EditorView, fontSize, fontFamily, { fixedHeight: true, scrollable: true });

  const dialect = createDbxCodeMirrorSqlDialect(langSql, "postgres");

  const state = EditorState.create({
    doc: selectedObjectSql.value,
    extensions: [basicSetup, langSql.sql({ dialect }), fontExt, themeExt, EditorView.editable.of(false), EditorView.lineWrapping],
  });

  editorView.value = new EditorView({ state, parent: editorContainer.value });
  isEditorReady.value = true;
}

watch(
  () => selectedObjectSql.value,
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
  if (props.objectResults.length > 0 && !selectedObjectId.value) {
    selectedObjectId.value = props.objectResults[0].objectId;
  }
});

onUnmounted(() => {
  editorView.value?.destroy();
  editorView.value = null;
});

watch(
  () => props.objectResults,
  () => {
    if (props.objectResults.length > 0 && !selectedObjectId.value) {
      selectedObjectId.value = props.objectResults[0].objectId;
    }
  },
  { immediate: true },
);

const summary = computed(() => {
  const total = props.objectResults.length;
  const success = props.objectResults.filter((r) => r.status === "success").length;
  const failed = props.objectResults.filter((r) => r.status === "failed").length;
  const skipped = props.objectResults.filter((r) => r.status === "skipped").length;
  return { total, success, failed, skipped };
});

function formatDuration(ms?: number): string {
  if (ms == null || ms === 0) return "0ms";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms}ms`;
}
</script>

<template>
  <div class="flex flex-col h-full bg-background">
    <!-- Header -->
    <div class="flex items-center justify-between px-3 py-2 border-b shrink-0" data-tauri-drag-region>
      <div class="flex items-center gap-2">
        <span class="text-sm font-medium">{{ t("diff.deployResult") }}</span>
        <span
          class="text-xs px-2 py-0.5 rounded font-medium"
          :class="overallStatus === 'committed' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' : overallStatus === 'rolled_back' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'"
        >
          {{ overallStatus }}
        </span>
      </div>
      <div class="flex items-center gap-3 text-xs">
        <span class="text-green-600">{{ t("diff.success") }}: {{ summary.success }}</span>
        <span class="text-red-600">{{ t("diff.failed") }}: {{ summary.failed }}</span>
        <span v-if="summary.skipped > 0" class="text-amber-600">{{ t("diff.skipped") }}: {{ summary.skipped }}</span>
        <span class="text-muted-foreground">{{ t("diff.total") }}: {{ summary.total }}</span>
      </div>
    </div>

    <!-- Content -->
    <Splitpanes class="flex-1 min-h-0">
      <Pane size="25" min-size="15">
        <div class="h-full overflow-auto p-2 space-y-0.5">
          <div v-for="result in objectResults" :key="result.objectId" class="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-accent/50 cursor-pointer" :class="{ 'bg-primary/10': selectedObjectId === result.objectId }" @click="handleSelectObject(result)">
            <component :is="getStatusIcon(result)" class="w-3.5 h-3.5 shrink-0" :class="getStatusIconClass(result)" />
            <component :is="operationIcons[result.object.operationType]" class="w-3.5 h-3.5 shrink-0" :class="operationColors[result.object.operationType]" />
            <component :is="getObjectIcon(result.object.objectKind)" class="w-3.5 h-3.5 shrink-0" :class="getObjectIconColor(result.object.objectKind)" />
            <span class="truncate">{{ result.object.name }}</span>
            <button v-if="result.status === 'failed'" class="ml-auto shrink-0 p-0.5 rounded hover:bg-destructive/10" @click.stop="handleShowError(getStatementError(result))">
              <AlertTriangle class="w-3.5 h-3.5 text-destructive" />
            </button>
            <span class="text-[10px] text-muted-foreground shrink-0 ml-auto" :class="{ 'ml-0': result.status === 'failed' }">
              {{ getOperationLabel(result.object.operationType) }}
            </span>
          </div>
          <div v-if="objectResults.length === 0" class="text-xs text-muted-foreground text-center py-4">
            {{ t("diff.noObjectsSelected") }}
          </div>
        </div>
      </Pane>

      <Pane size="75" min-size="40">
        <Splitpanes horizontal class="h-full">
          <Pane size="70" min-size="30">
            <div class="flex flex-col h-full">
              <div class="flex items-center justify-between px-2 py-1 border-b shrink-0">
                <span class="text-xs text-muted-foreground">{{ selectedResult?.object.name ?? "" }}</span>
                <Button variant="ghost" size="sm" class="h-7 text-xs gap-1" @click="handleCopyObjectSql">
                  <Copy class="w-3.5 h-3.5" />
                  {{ t("diff.copyObjectSql") }}
                </Button>
              </div>
              <div ref="editorContainer" class="flex-1 min-h-0 overflow-auto" />
            </div>
          </Pane>
          <Pane size="30" min-size="15">
            <div class="h-full overflow-auto p-3 space-y-3 text-xs flex flex-col">
              <!-- Execution status bar -->
              <div class="grid grid-cols-3 gap-2">
                <div class="bg-muted p-2 rounded flex items-center justify-between">
                  <span class="text-muted-foreground">{{ t("diff.affectedRows") }}</span>
                  <span class="font-medium">{{ affectedRows ?? 0 }}</span>
                </div>
                <div class="bg-muted p-2 rounded flex items-center justify-between">
                  <span class="text-muted-foreground">{{ t("diff.status") }}</span>
                  <span class="font-medium" :class="overallStatusClass">{{ overallStatus }}</span>
                </div>
                <div class="bg-muted p-2 rounded flex items-center justify-between">
                  <span class="text-muted-foreground">{{ t("diff.executionTime") }}</span>
                  <span class="font-medium">{{ formatDuration(executionTimeMs) }}</span>
                </div>
              </div>

              <template v-if="selectedResult">
                <div class="border-t pt-2">
                  <div class="font-medium mb-1">{{ selectedResult.object.name }}</div>
                  <div v-if="selectedObjectError" class="mt-2">
                    <div class="text-destructive font-medium mb-1">{{ t("diff.error") }}</div>
                    <pre class="bg-destructive/10 text-destructive p-2 rounded overflow-auto max-h-32 whitespace-pre-wrap font-mono">{{ selectedObjectError }}</pre>
                  </div>
                </div>
              </template>
            </div>
          </Pane>
        </Splitpanes>
      </Pane>
    </Splitpanes>

    <!-- Footer -->
    <div class="flex items-center justify-end px-3 py-2 border-t shrink-0 gap-2">
      <Button variant="outline" size="sm" class="h-7 text-xs gap-1" :disabled="!selectedObjectError" @click="handleCopyError">
        <Copy class="w-3.5 h-3.5" />
        {{ t("diff.copyError") }}
      </Button>
      <Button variant="outline" size="sm" class="h-7 text-xs" @click="$emit('close')">
        {{ t("diff.close") }}
      </Button>
    </div>

    <SchemaDiffDeployErrorDialog v-model:open="errorDialogOpen" :message="errorDialogMessage" />
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
:deep(.splitpanes--horizontal > .splitpanes__splitter) {
  height: 4px;
  background: var(--border);
  cursor: row-resize;
}
:deep(.splitpanes--horizontal > .splitpanes__splitter:hover) {
  background: var(--primary);
}
</style>

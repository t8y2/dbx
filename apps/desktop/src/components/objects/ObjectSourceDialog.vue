<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Clipboard, Loader2, PencilLine, RefreshCw } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSqlForDisplay, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { buildEditableObjectSource, buildExecutableObjectSourceStatements, executeObjectSourceSave, formatObjectSourceSaveError, resolveObjectSourceEditDraft } from "@/lib/table/objectSourceEditor";
import { loadObjectSourceWithRoutineFallback } from "@/lib/table/objectSourceLoad";
import { xuguRoutineMetadataFromDefinition, type XuguRoutineMetadata } from "@/lib/table/routineParameters";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import * as api from "@/lib/backend/api";
import QueryEditor from "@/components/editor/QueryEditor.vue";
import RoutineMetadataPanel from "@/components/objects/RoutineMetadataPanel.vue";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DatabaseType, ObjectSourceKind } from "@/types/database";

const props = withDefaults(
  defineProps<{
    open: boolean;
    connectionId: string;
    database: string;
    schema?: string;
    name: string;
    relationName?: string;
    signature?: string;
    objectType: ObjectSourceKind;
    databaseType?: DatabaseType;
    dialect: "mysql" | "postgres" | "sqlserver";
    formatDialect?: SqlFormatDialect;
    initialEditing?: boolean;
  }>(),
  {
    initialEditing: false,
  },
);

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [];
}>();

const { t } = useI18n();
const { toast } = useToast();
const connectionStore = useConnectionStore();
const settingsStore = useSettingsStore();

const content = ref("");
const editableText = ref("");
const draft = ref("");
const loading = ref(false);
const saving = ref(false);
const editing = ref(false);
const sourceEditable = ref(true);
const error = ref("");
const saveError = ref("");
const routineMetadata = ref<XuguRoutineMetadata | null>(null);
/** May differ from props.objectType after PROCEDURE/FUNCTION/PACKAGE fallback resolution. */
const resolvedObjectType = ref<ObjectSourceKind>(props.objectType);
let loadSerial = 0;
onBeforeUnmount(() => {
  ++loadSerial;
});

const canEdit = computed(() => sourceEditable.value && (props.objectType !== "SEQUENCE" || props.databaseType === "oceanbase-oracle"));
const title = computed(() => `${editing.value ? t("contextMenu.editView") : t("contextMenu.viewSource")} - ${props.name}`);
const hasRoutineMetadata = computed(() => !!routineMetadata.value && (routineMetadata.value.parameters.length > 0 || !!routineMetadata.value.returnType));

watch(
  () => [props.open, props.connectionId, props.database, props.schema, props.name, props.relationName, props.signature, props.objectType, props.databaseType, props.initialEditing] as const,
  () => {
    if (props.open) void loadSource();
    else ++loadSerial;
  },
  { immediate: true, flush: "sync" },
);

async function loadSource(nextEditing = props.initialEditing && canEdit.value) {
  const serial = ++loadSerial;
  const target = { ...props };
  saving.value = false;
  content.value = "";
  editableText.value = "";
  draft.value = "";
  error.value = "";
  saveError.value = "";
  routineMetadata.value = null;
  sourceEditable.value = true;
  editing.value = false;
  loading.value = true;
  try {
    if (!target.databaseType) throw new Error("Connection type is unavailable.");
    // issue #9035：连接建立也纳入弹窗的加载态。调用方不再先 await ensureConnected
    // 才打开弹窗，否则弹窗挂载前会有一段没有任何反馈的等待。
    await connectionStore.ensureConnected(target.connectionId);
    if (serial !== loadSerial) return;
    connectionStore.activeConnectionId = target.connectionId;
    const schema = target.schema || target.database;
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
    routineMetadata.value = props.databaseType === "xugu" && (resolvedType === "PROCEDURE" || resolvedType === "FUNCTION") ? xuguRoutineMetadataFromDefinition(result.source) : null;
    sourceEditable.value = editableAllowed;
    const displaySource = resolvedType === "SEQUENCE" ? result.source : editable;
    const formatted = await formatSqlForDisplay(displaySource, target.formatDialect ?? target.dialect, settingsStore.editorSettings.sqlFormatter);
    if (serial !== loadSerial) return;
    editableText.value = editable;
    content.value = formatted;
    draft.value = nextEditing && canEdit.value ? resolveObjectSourceEditDraft(props.databaseType, resolvedType, formatted, editable) : "";
    editing.value = nextEditing && canEdit.value;
    if (nextEditing && !canEdit.value) {
      toast(t("objects.sourceReadOnly"), 3000);
    }
  } catch (e: any) {
    if (serial === loadSerial) error.value = e?.message || String(e);
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
  if (editing.value && !window.confirm(t("objects.refreshDiscardConfirm"))) return;
  await loadSource(editing.value && canEdit.value);
}

async function saveSource() {
  if (saving.value || loading.value || !props.open) return;
  if (!canEdit.value) {
    toast(t("objects.sourceReadOnly"), 3000);
    return;
  }
  if (!draft.value.trim() || !props.databaseType) return;
  const databaseType = props.databaseType;
  const connectionId = props.connectionId,
    database = props.database,
    name = props.name;
  const objectType = resolvedObjectType.value,
    serial = loadSerial;
  const schema = props.schema || props.database;
  saving.value = true;
  saveError.value = "";
  try {
    const statements = await buildExecutableObjectSourceStatements({
      databaseType,
      objectType,
      schema,
      name,
      source: draft.value,
    });
    if (serial !== loadSerial) return;
    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");
    if (executableSql.trim()) {
      const saved = await executeWithProductionSqlGuard({
        connection: connectionStore.getConfig(connectionId),
        database,
        sql: executableSql,
        source: t("production.sourceObjectSource"),
        execute: async () => {
          if (serial !== loadSerial || !props.open) return false;
          await executeObjectSourceSave(connectionId, database, databaseType, statements, schema);
          return true;
        },
      });
      if (!saved) return;
    } else {
      await executeObjectSourceSave(connectionId, database, databaseType, statements, schema);
    }
    if (serial !== loadSerial) return;
    toast(t("objects.sourceSaved"));
    emit("saved");
    await loadSource(false);
  } catch (e: unknown) {
    if (serial === loadSerial) saveError.value = formatObjectSourceSaveError(e, databaseType, objectType, t("objects.postgresViewColumnChangeHint"));
  } finally {
    if (serial === loadSerial) saving.value = false;
  }
}

function closeDialog() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="h-[min(760px,calc(var(--dbx-viewport-height)-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[900px]">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
      </DialogHeader>

      <div v-if="loading" class="flex min-h-0 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="h-4 w-4 animate-spin" />
        <span>{{ t("common.loading") }}</span>
      </div>
      <div v-else-if="error" class="flex min-h-0 flex-col items-center justify-center gap-3 text-sm">
        <p class="text-destructive">{{ error }}</p>
        <Button variant="outline" size="sm" @click="loadSource()">
          <RefreshCw class="h-4 w-4" />
          {{ t("common.retry") }}
        </Button>
      </div>
      <div v-else-if="editing" class="object-source-dialog-editor flex min-h-0 flex-col overflow-hidden rounded border" data-object-source-editor>
        <QueryEditor
          v-model="draft"
          class="min-h-0 flex-1"
          :connection-id="props.connectionId"
          :database="props.database"
          :schema="props.schema || props.database"
          :database-type="props.databaseType"
          :dialect="props.dialect"
          :format-dialect="props.formatDialect"
          force-word-wrap
          hide-execution-controls
          @save="saveSource"
        />
        <div v-if="saveError" class="shrink-0 whitespace-pre-wrap break-words border-t px-3 py-2 text-xs text-destructive">
          {{ saveError }}
        </div>
      </div>
      <div v-else class="flex min-h-0 flex-col gap-3 overflow-hidden">
        <RoutineMetadataPanel v-if="hasRoutineMetadata && routineMetadata" :parameters="routineMetadata.parameters" :return-type="routineMetadata.returnType" />
        <QueryEditor
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

      <DialogFooter>
        <Button variant="outline" @click="closeDialog">{{ t("common.close") }}</Button>
        <Button variant="outline" :disabled="loading || saving" :title="t('structureEditor.refresh')" @click="refreshSource">
          <RefreshCw class="h-4 w-4" />
          {{ t("structureEditor.refresh") }}
        </Button>
        <Button v-if="!editing" variant="outline" :disabled="!content" @click="copySource">
          <Clipboard class="h-4 w-4" />
          {{ t("grid.copy") }}
        </Button>
        <Button v-if="!editing && canEdit" variant="outline" :disabled="!editableText" @click="editSource">
          <PencilLine class="h-4 w-4" />
          {{ t("contextMenu.editView") }}
        </Button>
        <Button v-if="editing" variant="outline" :disabled="saving" @click="cancelEditSource">
          {{ t("objects.cancelEdit") }}
        </Button>
        <Button v-if="editing" :disabled="saving || !draft.trim()" @click="saveSource">
          <Loader2 v-if="saving" class="h-4 w-4 animate-spin" />
          {{ t("objects.saveSource") }}
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

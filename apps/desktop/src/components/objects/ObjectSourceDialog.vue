<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Clipboard, Loader2, PencilLine, RefreshCw } from "@lucide/vue";
import { useToast } from "@/composables/useToast";
import { useConnectionStore } from "@/stores/connectionStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { copyToClipboard } from "@/lib/common/clipboard";
import { formatSqlForDisplay, type SqlFormatDialect } from "@/lib/sql/sqlFormatter";
import { buildEditableObjectSource, buildExecutableObjectSourceStatements, executeObjectSourceSave } from "@/lib/table/objectSourceEditor";
import { executeWithProductionSqlGuard } from "@/lib/database/productionExecutionGuard";
import * as api from "@/lib/backend/api";
import QueryEditor from "@/components/editor/QueryEditor.vue";
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
let loadSerial = 0;

const canEdit = computed(() => sourceEditable.value && props.objectType !== "SEQUENCE");
const title = computed(() => `${editing.value ? t("contextMenu.editView") : t("contextMenu.viewSource")} - ${props.name}`);

watch(
  () => [props.open, props.connectionId, props.database, props.schema, props.name, props.signature, props.objectType, props.initialEditing] as const,
  () => {
    if (props.open) void loadSource();
  },
  { immediate: true },
);

async function loadSource(nextEditing = props.initialEditing && canEdit.value) {
  const serial = ++loadSerial;
  content.value = "";
  editableText.value = "";
  draft.value = "";
  error.value = "";
  saveError.value = "";
  sourceEditable.value = true;
  editing.value = false;
  loading.value = true;
  try {
    if (!props.databaseType) throw new Error("Connection type is unavailable.");
    const schema = props.schema || props.database;
    const result = await api.getObjectSource(props.connectionId, props.database, schema, props.name, props.objectType, props.signature);
    const editableAllowed = result.editable !== false;
    const editable = await buildEditableObjectSource({
      databaseType: props.databaseType,
      objectType: props.objectType,
      schema,
      name: props.name,
      source: result.source,
    });
    if (serial !== loadSerial) return;
    sourceEditable.value = editableAllowed;
    const formatted = await formatSqlForDisplay(editable, props.formatDialect ?? props.dialect, settingsStore.editorSettings.sqlFormatter);
    editableText.value = editable;
    content.value = formatted;
    draft.value = nextEditing && canEdit.value ? editable : "";
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
  draft.value = editableText.value;
  saveError.value = "";
  editing.value = true;
}

function cancelEditSource() {
  editing.value = false;
  draft.value = "";
  saveError.value = "";
}

async function saveSource() {
  if (!canEdit.value) {
    toast(t("objects.sourceReadOnly"), 3000);
    return;
  }
  if (!draft.value.trim() || !props.databaseType) return;
  const databaseType = props.databaseType;
  const schema = props.schema || props.database;
  saving.value = true;
  saveError.value = "";
  try {
    const statements = await buildExecutableObjectSourceStatements({
      databaseType,
      objectType: props.objectType,
      schema,
      name: props.name,
      source: draft.value,
    });
    const executableSql = statements.filter((sql) => sql.trim()).join(";\n");
    if (executableSql.trim()) {
      const saved = await executeWithProductionSqlGuard({
        connection: connectionStore.getConfig(props.connectionId),
        database: props.database,
        sql: executableSql,
        source: t("production.sourceObjectSource"),
        execute: async () => {
          await executeObjectSourceSave(props.connectionId, props.database, databaseType, statements, schema);
          return true;
        },
      });
      if (!saved) return;
    } else {
      await executeObjectSourceSave(props.connectionId, props.database, databaseType, statements, schema);
    }
    toast(t("objects.sourceSaved"));
    emit("saved");
    await loadSource(false);
  } catch (e: any) {
    saveError.value = e?.message || String(e);
  } finally {
    saving.value = false;
  }
}

function closeDialog() {
  emit("update:open", false);
}
</script>

<template>
  <Dialog :open="props.open" @update:open="(value) => emit('update:open', value)">
    <DialogContent class="h-[min(760px,calc(100dvh-2rem))] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-[900px]">
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
        <div v-if="saveError" class="shrink-0 border-t px-3 py-2 text-xs text-destructive">
          {{ saveError }}
        </div>
      </div>
      <QueryEditor
        v-else
        :key="`${props.connectionId}:${props.database}:${props.schema || ''}:${props.name}:${props.objectType}`"
        :model-value="content"
        class="object-source-dialog-editor min-h-0 overflow-hidden rounded border"
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

      <DialogFooter>
        <Button variant="outline" @click="closeDialog">{{ t("common.close") }}</Button>
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

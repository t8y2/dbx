<script setup lang="ts">
import { computed, watch, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import ConnectionDialog from "@/components/connection/ConnectionDialog.vue";
import EditorSettingsDialog from "@/components/editor/EditorSettingsDialog.vue";
import DangerConfirmDialog from "@/components/editor/DangerConfirmDialog.vue";
const DataTransferDialog = defineAsyncComponent(() => import("@/components/transfer/DataTransferDialog.vue"));
const SchemaDiffDialog = defineAsyncComponent(() => import("@/components/diff/SchemaDiffDialog.vue"));
const SqlFileExecutionDialog = defineAsyncComponent(() => import("@/components/sql-file/SqlFileExecutionDialog.vue"));
const SchemaDiagramDialog = defineAsyncComponent(() => import("@/components/diagram/SchemaDiagramDialog.vue"));
const TableImportDialog = defineAsyncComponent(() => import("@/components/import/TableImportDialog.vue"));
const TableStructureEditorDialog = defineAsyncComponent(() => import("@/components/structure/TableStructureEditorDialog.vue"));
const FieldLineageDialog = defineAsyncComponent(() => import("@/components/lineage/FieldLineageDialog.vue"));
const ConfigPassphraseDialog = defineAsyncComponent(() => import("@/components/config/ConfigPassphraseDialog.vue"));
const DatabaseSearchDialog = defineAsyncComponent(() => import("@/components/search/DatabaseSearchDialog.vue"));
import { useConnectionStore } from "@/stores/connectionStore";
import { useDialogSources } from "@/composables/useDialogSources";

const props = defineProps<{
  showConnectionDialog: boolean;
  showSettingsDialog: boolean;
  showDangerDialog: boolean;
  dangerSql: string;
}>();

const emit = defineEmits<{
  "update:showConnectionDialog": [value: boolean];
  "update:showSettingsDialog": [value: boolean];
  "update:showDangerDialog": [value: boolean];
  dangerConfirm: [];
  connectStarted: [name: string];
  connectSucceeded: [name: string];
  connectFailed: [message: string];
  structureEditorSaved: [];
  openLineageTarget: [target: { connectionId: string; database: string; schema?: string; tableName: string; columnName?: string }];
  openDatabaseSearchTarget: [target: { connectionId: string; database: string; schema?: string; tableName: string; whereInput?: string }];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const dialogs = useDialogSources();

const editConfig = computed(() => {
  const id = connectionStore.editingConnectionId;
  if (!id) return undefined;
  return connectionStore.getConfig(id);
});

watch(editConfig, (v) => {
  if (v) emit("update:showConnectionDialog", true);
});

watch(() => props.showConnectionDialog, (v) => {
  if (!v) connectionStore.stopEditing();
});
</script>

<template>
  <ConnectionDialog
    :open="showConnectionDialog"
    :edit-config="editConfig"
    @update:open="emit('update:showConnectionDialog', $event)"
    @connect-started="emit('connectStarted', $event)"
    @connect-succeeded="emit('connectSucceeded', $event)"
    @connect-failed="emit('connectFailed', $event)"
  />
  <EditorSettingsDialog
    :open="showSettingsDialog"
    @update:open="emit('update:showSettingsDialog', $event)"
  />
  <DangerConfirmDialog
    :open="showDangerDialog"
    :sql="dangerSql"
    @update:open="emit('update:showDangerDialog', $event)"
    @confirm="emit('dangerConfirm')"
  />
  <DataTransferDialog
    v-model:open="dialogs.showTransferDialog.value"
    :prefill-connection-id="dialogs.transferPrefillConnectionId.value"
    :prefill-database="dialogs.transferPrefillDatabase.value"
  />
  <SchemaDiffDialog
    v-model:open="dialogs.showSchemaDiffDialog.value"
    :prefill-connection-id="dialogs.schemaDiffPrefillConnectionId.value"
    :prefill-database="dialogs.schemaDiffPrefillDatabase.value"
  />
  <SqlFileExecutionDialog
    v-model:open="dialogs.showSqlFileDialog.value"
    :prefill-connection-id="dialogs.sqlFilePrefillConnectionId.value"
    :prefill-database="dialogs.sqlFilePrefillDatabase.value"
  />
  <SchemaDiagramDialog
    v-model:open="dialogs.showDiagramDialog.value"
    :prefill-connection-id="dialogs.diagramPrefillConnectionId.value"
    :prefill-database="dialogs.diagramPrefillDatabase.value"
    :prefill-schema="dialogs.diagramPrefillSchema.value"
    :focus-table-name="dialogs.diagramFocusTableName.value"
  />
  <TableImportDialog
    v-model:open="dialogs.showTableImportDialog.value"
    :prefill-connection-id="dialogs.tableImportPrefillConnectionId.value"
    :prefill-database="dialogs.tableImportPrefillDatabase.value"
    :prefill-schema="dialogs.tableImportPrefillSchema.value"
    :prefill-table="dialogs.tableImportPrefillTable.value"
  />
  <TableStructureEditorDialog
    v-model:open="dialogs.showStructureEditorDialog.value"
    :prefill-connection-id="dialogs.structurePrefillConnectionId.value"
    :prefill-database="dialogs.structurePrefillDatabase.value"
    :prefill-schema="dialogs.structurePrefillSchema.value"
    :prefill-table="dialogs.structurePrefillTable.value"
    @saved="emit('structureEditorSaved')"
  />
  <FieldLineageDialog
    v-model:open="dialogs.showFieldLineageDialog.value"
    :prefill-connection-id="dialogs.lineagePrefillConnectionId.value"
    :prefill-database="dialogs.lineagePrefillDatabase.value"
    :prefill-schema="dialogs.lineagePrefillSchema.value"
    :prefill-table="dialogs.lineagePrefillTable.value"
    :prefill-column="dialogs.lineagePrefillColumn.value"
    @open-target="emit('openLineageTarget', $event)"
  />
  <DatabaseSearchDialog
    v-model:open="dialogs.showDatabaseSearchDialog.value"
    :prefill-connection-id="dialogs.databaseSearchPrefillConnectionId.value"
    :prefill-database="dialogs.databaseSearchPrefillDatabase.value"
    :prefill-schema="dialogs.databaseSearchPrefillSchema.value"
    @open-target="emit('openDatabaseSearchTarget', $event)"
  />
  <ConfigPassphraseDialog
    v-model:open="dialogs.showConfigPassphraseDialog.value"
    :mode="dialogs.configPassphraseMode.value"
    :external-error="dialogs.configPassphraseError.value"
    @confirm="dialogs.configPassphraseMode.value === 'export' ? dialogs.onExportConfirm($event) : dialogs.onImportConfirm($event)"
  />
  <Dialog v-model:open="dialogs.showImportLayoutConfirm.value">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t('configExport.importLayoutTitle') }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t('configExport.importLayoutConfirm') }}</p>
      <DialogFooter>
        <Button variant="outline" @click="dialogs.showImportLayoutConfirm.value = false">{{ t('dangerDialog.cancel') }}</Button>
        <Button @click="dialogs.showImportLayoutConfirm.value = false; dialogs.pendingImportLayout.value && connectionStore.applySidebarLayout(dialogs.pendingImportLayout.value)">{{ t('configExport.importLayoutApply') }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

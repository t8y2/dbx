<script setup lang="ts">
import { computed, watch, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
const ConnectionDialog = defineAsyncComponent(() => import("@/components/connection/ConnectionDialog.vue"));
const EditorSettingsDialog = defineAsyncComponent(() => import("@/components/editor/EditorSettingsDialog.vue"));
const DangerConfirmDialog = defineAsyncComponent(() => import("@/components/editor/DangerConfirmDialog.vue"));
const DataTransferDialog = defineAsyncComponent(() => import("@/components/transfer/DataTransferDialog.vue"));
const SchemaDiffDialog = defineAsyncComponent(() => import("@/components/diff/SchemaDiffDialog.vue"));
const DataCompareDialog = defineAsyncComponent(() => import("@/components/diff/DataCompareDialog.vue"));
const SqlFileExecutionDialog = defineAsyncComponent(() => import("@/components/sql-file/SqlFileExecutionDialog.vue"));
const SchemaDiagramDialog = defineAsyncComponent(() => import("@/components/diagram/SchemaDiagramDialog.vue"));
const TableImportDialog = defineAsyncComponent(() => import("@/components/import/TableImportDialog.vue"));
const FieldLineageDialog = defineAsyncComponent(() => import("@/components/lineage/FieldLineageDialog.vue"));
const ConfigPassphraseDialog = defineAsyncComponent(() => import("@/components/config/ConfigPassphraseDialog.vue"));
const DatabaseSearchDialog = defineAsyncComponent(() => import("@/components/search/DatabaseSearchDialog.vue"));
const DatabaseExportDialog = defineAsyncComponent(() => import("@/components/export/DatabaseExportDialog.vue"));
const DataGenerateDialog = defineAsyncComponent(() => import("@/components/generate/DataGenerateDialog.vue"));
import { useConnectionStore } from "@/stores/connectionStore";
import { useDialogSources } from "@/composables/useDialogSources";
import type { ConnectionDeepLinkDraft } from "@/lib/connectionDeepLink";

const props = defineProps<{
  showConnectionDialog: boolean;
  connectionPrefill?: ConnectionDeepLinkDraft | null;
  showSettingsDialog: boolean;
  settingsInitialTab?: string;
  appVersion?: string;
  showDangerDialog: boolean;
  dangerSql: string;
  suppressDangerConfirm: boolean;
}>();

const emit = defineEmits<{
  "update:showConnectionDialog": [value: boolean];
  "update:showSettingsDialog": [value: boolean];
  "update:showDangerDialog": [value: boolean];
  "update:suppressDangerConfirm": [value: boolean];
  dangerConfirm: [];
  connectStarted: [name: string];
  connectSucceeded: [name: string];
  connectFailed: [message: string];
  openDriverStore: [];
  openLineageTarget: [
    target: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      columnName?: string;
    },
  ];
  openDatabaseSearchTarget: [
    target: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      whereInput?: string;
    },
  ];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const dialogs = useDialogSources();

const editConfig = computed(() => {
  const id = connectionStore.editingConnectionId;
  if (!id) return undefined;
  return connectionStore.getConfig(id);
});
const shouldShowConnectionDialog = computed(() => props.showConnectionDialog || !!editConfig.value);

watch(editConfig, (v) => {
  if (v) emit("update:showConnectionDialog", true);
});

watch(
  () => connectionStore.newConnectionGroupId,
  (v) => {
    if (v) emit("update:showConnectionDialog", true);
  },
);

watch(
  () => props.showConnectionDialog,
  (v) => {
    if (!v) {
      connectionStore.stopEditing();
      connectionStore.stopCreatingConnectionInGroup();
    }
  },
);
</script>

<template>
  <ConnectionDialog
    v-if="shouldShowConnectionDialog"
    :open="shouldShowConnectionDialog"
    :edit-config="editConfig"
    :prefill-config="connectionPrefill"
    @update:open="emit('update:showConnectionDialog', $event)"
    @connect-started="emit('connectStarted', $event)"
    @connect-succeeded="emit('connectSucceeded', $event)"
    @connect-failed="emit('connectFailed', $event)"
    @open-driver-store="emit('openDriverStore')"
  />
  <EditorSettingsDialog v-if="showSettingsDialog" :open="showSettingsDialog" :initial-tab="settingsInitialTab || 'editor'" :app-version="appVersion" @update:open="emit('update:showSettingsDialog', $event)" />
  <DangerConfirmDialog
    v-if="showDangerDialog"
    :open="showDangerDialog"
    :sql="dangerSql"
    :show-suppress-toggle="true"
    :suppress-future-prompts="suppressDangerConfirm"
    @update:open="emit('update:showDangerDialog', $event)"
    @update:suppress-future-prompts="emit('update:suppressDangerConfirm', $event)"
    @confirm="emit('dangerConfirm')"
  />
  <DataTransferDialog v-if="dialogs.showTransferDialog.value" v-model:open="dialogs.showTransferDialog.value" :prefill-connection-id="dialogs.transferPrefillConnectionId.value" :prefill-database="dialogs.transferPrefillDatabase.value" />
  <SchemaDiffDialog v-if="dialogs.showSchemaDiffDialog.value" v-model:open="dialogs.showSchemaDiffDialog.value" :prefill-connection-id="dialogs.schemaDiffPrefillConnectionId.value" :prefill-database="dialogs.schemaDiffPrefillDatabase.value" :prefill-schema="dialogs.schemaDiffPrefillSchema.value" />
  <DataCompareDialog
    v-if="dialogs.showDataCompareDialog.value"
    v-model:open="dialogs.showDataCompareDialog.value"
    :prefill-connection-id="dialogs.dataComparePrefillConnectionId.value"
    :prefill-database="dialogs.dataComparePrefillDatabase.value"
    :prefill-schema="dialogs.dataComparePrefillSchema.value"
    :prefill-table="dialogs.dataComparePrefillTable.value"
  />
  <SqlFileExecutionDialog v-if="dialogs.showSqlFileDialog.value" v-model:open="dialogs.showSqlFileDialog.value" :prefill-connection-id="dialogs.sqlFilePrefillConnectionId.value" :prefill-database="dialogs.sqlFilePrefillDatabase.value" />
  <SchemaDiagramDialog
    v-if="dialogs.showDiagramDialog.value"
    v-model:open="dialogs.showDiagramDialog.value"
    :prefill-connection-id="dialogs.diagramPrefillConnectionId.value"
    :prefill-database="dialogs.diagramPrefillDatabase.value"
    :prefill-schema="dialogs.diagramPrefillSchema.value"
    :focus-table-name="dialogs.diagramFocusTableName.value"
  />
  <TableImportDialog
    v-if="dialogs.showTableImportDialog.value"
    v-model:open="dialogs.showTableImportDialog.value"
    :prefill-connection-id="dialogs.tableImportPrefillConnectionId.value"
    :prefill-database="dialogs.tableImportPrefillDatabase.value"
    :prefill-schema="dialogs.tableImportPrefillSchema.value"
    :prefill-table="dialogs.tableImportPrefillTable.value"
  />
  <DataGenerateDialog
    v-if="dialogs.showTableDataGenerateDialog.value"
    v-model:open="dialogs.showTableDataGenerateDialog.value"
    :prefill-connection-id="dialogs.tableDataGeneratePrefillConnectionId.value"
    :prefill-database="dialogs.tableDataGeneratePrefillDatabase.value"
    :prefill-schema="dialogs.tableDataGeneratePrefillSchema.value"
    :prefill-table="dialogs.tableDataGeneratePrefillTable.value"
  />
  <FieldLineageDialog
    v-if="dialogs.showFieldLineageDialog.value"
    v-model:open="dialogs.showFieldLineageDialog.value"
    :prefill-connection-id="dialogs.lineagePrefillConnectionId.value"
    :prefill-database="dialogs.lineagePrefillDatabase.value"
    :prefill-schema="dialogs.lineagePrefillSchema.value"
    :prefill-table="dialogs.lineagePrefillTable.value"
    :prefill-column="dialogs.lineagePrefillColumn.value"
    @open-target="emit('openLineageTarget', $event)"
  />
  <DatabaseSearchDialog
    v-if="dialogs.showDatabaseSearchDialog.value"
    v-model:open="dialogs.showDatabaseSearchDialog.value"
    :prefill-connection-id="dialogs.databaseSearchPrefillConnectionId.value"
    :prefill-database="dialogs.databaseSearchPrefillDatabase.value"
    :prefill-schema="dialogs.databaseSearchPrefillSchema.value"
    @open-target="emit('openDatabaseSearchTarget', $event)"
  />
  <DatabaseExportDialog
    v-if="dialogs.showDatabaseExportDialog.value"
    v-model:open="dialogs.showDatabaseExportDialog.value"
    :prefill-connection-id="dialogs.databaseExportPrefillConnectionId.value"
    :prefill-database="dialogs.databaseExportPrefillDatabase.value"
    :prefill-schema="dialogs.databaseExportPrefillSchema.value"
    :prefill-table="dialogs.databaseExportPrefillTable.value"
    :prefill-tables="dialogs.databaseExportPrefillTables.value"
  />
  <ConfigPassphraseDialog
    v-if="dialogs.showConfigPassphraseDialog.value"
    v-model:open="dialogs.showConfigPassphraseDialog.value"
    :mode="dialogs.configPassphraseMode.value"
    :external-error="dialogs.configPassphraseError.value"
    @confirm="dialogs.configPassphraseMode.value === 'export' ? dialogs.onExportConfirm($event) : dialogs.onImportConfirm($event)"
  />
  <Dialog v-model:open="dialogs.showImportLayoutConfirm.value">
    <DialogContent class="sm:max-w-[400px]">
      <DialogHeader>
        <DialogTitle>{{ t("configExport.importLayoutTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t("configExport.importLayoutConfirm") }}</p>
      <DialogFooter>
        <Button variant="outline" @click="dialogs.showImportLayoutConfirm.value = false">{{ t("dangerDialog.cancel") }}</Button>
        <Button
          @click="
            dialogs.showImportLayoutConfirm.value = false;
            dialogs.pendingImportLayout.value && connectionStore.applySidebarLayout(dialogs.pendingImportLayout.value);
          "
          >{{ t("configExport.importLayoutApply") }}</Button
        >
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

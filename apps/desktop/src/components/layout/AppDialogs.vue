<script setup lang="ts">
import { computed, ref, watch, defineAsyncComponent } from "vue";
import { useI18n } from "vue-i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
const ConnectionDialog = defineAsyncComponent(() => import("@/components/connection/ConnectionDialog.vue"));
const DangerConfirmDialog = defineAsyncComponent(() => import("@/components/editor/DangerConfirmDialog.vue"));
const SqlParameterDialog = defineAsyncComponent(() => import("@/components/editor/SqlParameterDialog.vue"));
const DataTransferDialog = defineAsyncComponent(() => import("@/components/transfer/DataTransferDialog.vue"));
const SchemaDiffDialog = defineAsyncComponent(() => import("@/components/diff/SchemaDiffDialog.vue"));
const DataCompareDialog = defineAsyncComponent(() => import("@/components/diff/DataCompareDialog.vue"));
const SqlFileExecutionDialog = defineAsyncComponent(() => import("@/components/sql-file/SqlFileExecutionDialog.vue"));
const SchemaDiagramDialog = defineAsyncComponent(() => import("@/components/diagram/SchemaDiagramDialog.vue"));
const DatabaseDocsDialog = defineAsyncComponent(() => import("@/components/docs/DatabaseDocsDialog.vue"));
const TableImportDialog = defineAsyncComponent(() => import("@/components/import/TableImportDialog.vue"));
const FieldLineageDialog = defineAsyncComponent(() => import("@/components/lineage/FieldLineageDialog.vue"));
const ConfigPassphraseDialog = defineAsyncComponent(() => import("@/components/config/ConfigPassphraseDialog.vue"));
const ConfigConnectionSelectDialog = defineAsyncComponent(() => import("@/components/config/ConfigConnectionSelectDialog.vue"));
const DatabaseSearchDialog = defineAsyncComponent(() => import("@/components/search/DatabaseSearchDialog.vue"));
const SshHostKeyPromptDialog = defineAsyncComponent(() => import("@/components/ssh/SshHostKeyPromptDialog.vue"));
const ConnectionPasswordPromptDialog = defineAsyncComponent(() => import("@/components/connection/ConnectionPasswordPromptDialog.vue"));
const DatabaseExportDialog = defineAsyncComponent(() => import("@/components/export/DatabaseExportDialog.vue"));
const DataGenerateDialog = defineAsyncComponent(() => import("@/components/generate/DataGenerateDialog.vue"));
import { useConnectionStore } from "@/stores/connectionStore";
import { useSqlExecutionDangerStore } from "@/stores/sqlExecutionDangerStore";
import { useProductionSafetyStore } from "@/stores/productionSafetyStore";
import { useReadOnlyUnlockStore, WRITE_UNLOCK_FIVE_MINUTES_SECS, WRITE_UNLOCK_ONE_MINUTE_SECS, type WriteUnlockDurationSecs } from "@/stores/readOnlyUnlockStore";
import { useDialogSources } from "@/composables/useDialogSources";
import type { ConnectionDeepLinkDraft } from "@/lib/connection/connectionDeepLink";
import type { DriverStoreFocus } from "@/lib/connection/agentDriverInstallHint";
import type { SqlParameterDescriptor, SqlParameterSyntax } from "@/lib/sql/sqlParameters";
import type { ConfigTab } from "@/components/connection/ConnectionDialog.vue";
import type { DatabaseType } from "@/types/database";

const props = defineProps<{
  showConnectionDialog: boolean;
  connectionPrefill?: ConnectionDeepLinkDraft | null;
  connectionInitialTab?: ConfigTab;
  showDangerDialog: boolean;
  dangerSql: string;
  suppressDangerConfirm: boolean;
  activeDatabaseType?: DatabaseType;
  showSqlParameterDialog: boolean;
  sqlParameterSourceSql: string;
  sqlParameterNames: SqlParameterDescriptor[];
  sqlParameterDatabaseType?: DatabaseType;
  sqlParameterEnabledSyntaxes?: SqlParameterSyntax[];
}>();

const emit = defineEmits<{
  "update:showConnectionDialog": [value: boolean];
  "update:showDangerDialog": [value: boolean];
  "update:suppressDangerConfirm": [value: boolean];
  "update:showSqlParameterDialog": [value: boolean];
  dangerConfirm: [];
  sqlParametersConfirm: [sql: string];
  connectStarted: [name: string];
  connectSucceeded: [name: string];
  connectFailed: [message: string];
  openDriverStore: [focus?: DriverStoreFocus];
  openTunnelProfileSettings: [];
  openLineageTarget: [
    target: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      tableType?: string;
      columnName?: string;
    },
  ];
  openDatabaseSearchTarget: [
    target: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      tableType?: string;
      whereInput?: string;
    },
  ];
  openDiagramTarget: [
    target: {
      connectionId: string;
      database: string;
      schema?: string;
      tableName: string;
      tableType?: string;
    },
  ];
}>();

const { t } = useI18n();
const connectionStore = useConnectionStore();
const productionSafetyStore = useProductionSafetyStore();
const readOnlyUnlockStore = useReadOnlyUnlockStore();
const unlockDuration = ref<WriteUnlockDurationSecs>(WRITE_UNLOCK_ONE_MINUTE_SECS);
const sqlExecutionDangerStore = useSqlExecutionDangerStore();
const dialogs = useDialogSources();
const productionConfirmationDetails = computed(() => {
  const request = productionSafetyStore.pending;
  if (!request) return "";
  return t("production.confirmDetails", {
    connection: request.connectionName || "-",
    database: request.productionDatabases?.join(", ") || request.database || "-",
    source: request.source || "-",
  });
});
const readOnlyUnlockDetails = computed(() => {
  const request = readOnlyUnlockStore.pending;
  if (!request) return "";
  return t("readOnlyUnlock.confirmDetails", {
    connection: request.connectionName || "-",
    source: request.source || "-",
  });
});
watch(
  () => readOnlyUnlockStore.pending,
  (pending) => {
    if (pending) unlockDuration.value = WRITE_UNLOCK_ONE_MINUTE_SECS;
  },
);
const multiDbDangerDetails = computed(() => {
  const request = sqlExecutionDangerStore.pending;
  if (!request) return "";
  return [request.targetLabel || request.connectionName, request.database].filter(Boolean).join("\n");
});
const multiDbDangerMessage = computed(() => {
  const request = sqlExecutionDangerStore.pending;
  return request?.kind === "redis" ? t("dangerDialog.redisCommandMessage") : t("dangerDialog.message");
});

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
    :initial-tab="connectionInitialTab"
    @update:open="emit('update:showConnectionDialog', $event)"
    @connect-started="emit('connectStarted', $event)"
    @connect-succeeded="emit('connectSucceeded', $event)"
    @connect-failed="emit('connectFailed', $event)"
    @open-driver-store="emit('openDriverStore', $event)"
    @open-tunnel-profile-settings="emit('openTunnelProfileSettings')"
  />
  <DangerConfirmDialog
    v-if="showDangerDialog"
    :open="showDangerDialog"
    :sql="dangerSql"
    :show-suppress-toggle="activeDatabaseType !== 'redis'"
    :suppress-future-prompts="suppressDangerConfirm"
    @update:open="emit('update:showDangerDialog', $event)"
    @update:suppress-future-prompts="emit('update:suppressDangerConfirm', $event)"
    @confirm="emit('dangerConfirm')"
  />
  <DangerConfirmDialog
    v-if="productionSafetyStore.pending"
    :open="true"
    :title="t('production.confirmTitle')"
    :message="t('production.confirmMessage')"
    :details-text="productionConfirmationDetails"
    :sql="productionSafetyStore.pending.sql"
    :confirm-label="t('production.confirmAction')"
    :close-on-confirm="false"
    @update:open="(open) => !open && productionSafetyStore.cancel()"
    @confirm="productionSafetyStore.confirm()"
  />
  <DangerConfirmDialog
    v-if="readOnlyUnlockStore.pending"
    :open="true"
    :title="t('readOnlyUnlock.confirmTitle')"
    :message="t('readOnlyUnlock.confirmMessage')"
    :details-text="readOnlyUnlockDetails"
    :sql="readOnlyUnlockStore.pending.sql"
    :confirm-label="t('readOnlyUnlock.confirmAction')"
    :close-on-confirm="false"
    @update:open="(open) => !open && readOnlyUnlockStore.cancel()"
    @confirm="readOnlyUnlockStore.confirm(unlockDuration)"
  >
    <template #options>
      <fieldset class="mb-3 space-y-2 rounded-md border bg-muted/20 px-3 py-2">
        <legend class="text-xs font-medium text-foreground">{{ t("readOnlyUnlock.durationLabel") }}</legend>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="unlockDuration" type="radio" class="accent-primary" :value="WRITE_UNLOCK_ONE_MINUTE_SECS" />
          {{ t("readOnlyUnlock.durationOneMinute") }}
        </label>
        <label class="flex items-center gap-2 text-sm">
          <input v-model="unlockDuration" type="radio" class="accent-primary" :value="WRITE_UNLOCK_FIVE_MINUTES_SECS" />
          {{ t("readOnlyUnlock.durationFiveMinutes") }}
        </label>
      </fieldset>
    </template>
  </DangerConfirmDialog>
  <DangerConfirmDialog
    v-if="sqlExecutionDangerStore.pending"
    :open="true"
    :title="t('multiDbExecute.dangerTitle')"
    :message="multiDbDangerMessage"
    :details-text="multiDbDangerDetails"
    :sql="sqlExecutionDangerStore.pending.sql"
    :confirm-label="t('multiDbExecute.dangerConfirm')"
    :show-suppress-toggle="false"
    :close-on-confirm="false"
    @update:open="(open) => !open && sqlExecutionDangerStore.cancel()"
    @confirm="sqlExecutionDangerStore.confirm()"
  />
  <SqlParameterDialog
    v-if="showSqlParameterDialog"
    :open="showSqlParameterDialog"
    :sql="sqlParameterSourceSql"
    :parameters="sqlParameterNames"
    :database-type="sqlParameterDatabaseType"
    :enabled-syntaxes="sqlParameterEnabledSyntaxes"
    @update:open="emit('update:showSqlParameterDialog', $event)"
    @execute="emit('sqlParametersConfirm', $event)"
  />
  <DataTransferDialog
    v-model:open="dialogs.showTransferDialog.value"
    :prefill-connection-id="dialogs.transferPrefillConnectionId.value"
    :prefill-database="dialogs.transferPrefillDatabase.value"
    :prefill-catalog="dialogs.transferPrefillCatalog.value"
    :prefill-schema="dialogs.transferPrefillSchema.value"
    :prefill-tables="dialogs.transferPrefillTables.value"
    :prefill-target-connection-id="dialogs.transferPrefillTargetConnectionId.value"
    :prefill-target-database="dialogs.transferPrefillTargetDatabase.value"
    :prefill-target-schema="dialogs.transferPrefillTargetSchema.value"
  />
  <SchemaDiffDialog v-if="dialogs.showSchemaDiffDialog.value" v-model:open="dialogs.showSchemaDiffDialog.value" :prefill-connection-id="dialogs.schemaDiffPrefillConnectionId.value" :prefill-database="dialogs.schemaDiffPrefillDatabase.value" :prefill-schema="dialogs.schemaDiffPrefillSchema.value" />
  <DataCompareDialog
    v-if="dialogs.showDataCompareDialog.value"
    v-model:open="dialogs.showDataCompareDialog.value"
    :prefill-connection-id="dialogs.dataComparePrefillConnectionId.value"
    :prefill-database="dialogs.dataComparePrefillDatabase.value"
    :prefill-schema="dialogs.dataComparePrefillSchema.value"
    :prefill-table="dialogs.dataComparePrefillTable.value"
  />
  <SqlFileExecutionDialog v-model:open="dialogs.showSqlFileDialog.value" :prefill-connection-id="dialogs.sqlFilePrefillConnectionId.value" :prefill-database="dialogs.sqlFilePrefillDatabase.value" :prefill-file-path="dialogs.sqlFilePrefillFilePath.value" />
  <SchemaDiagramDialog
    v-if="dialogs.showDiagramDialog.value"
    v-model:open="dialogs.showDiagramDialog.value"
    :prefill-connection-id="dialogs.diagramPrefillConnectionId.value"
    :prefill-database="dialogs.diagramPrefillDatabase.value"
    :prefill-schema="dialogs.diagramPrefillSchema.value"
    :focus-table-name="dialogs.diagramFocusTableName.value"
    @open-target="emit('openDiagramTarget', $event)"
  />
  <DatabaseDocsDialog v-if="dialogs.showDocsDialog.value" v-model:open="dialogs.showDocsDialog.value" :prefill-connection-id="dialogs.docsPrefillConnectionId.value" :prefill-database="dialogs.docsPrefillDatabase.value" :prefill-schema="dialogs.docsPrefillSchema.value" />
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
    :prefill-all-databases="dialogs.databaseExportAllDatabases.value"
  />
  <ConfigConnectionSelectDialog
    v-if="dialogs.showConfigConnectionSelectDialog.value"
    :open="dialogs.showConfigConnectionSelectDialog.value"
    :mode="dialogs.configConnectionSelectMode.value"
    :busy="dialogs.applyingImportSelection.value"
    :connections="dialogs.configConnectionSelectList.value"
    @update:open="dialogs.onConfigConnectionSelectOpenChange"
    @confirm="dialogs.onConfigConnectionSelectConfirm"
  />
  <ConfigPassphraseDialog
    v-if="dialogs.showConfigPassphraseDialog.value"
    :open="dialogs.showConfigPassphraseDialog.value"
    :mode="dialogs.configPassphraseMode.value"
    :external-error="dialogs.configPassphraseError.value"
    :busy="dialogs.configExportBusy.value"
    @update:open="dialogs.onConfigPassphraseOpenChange"
    @request-unencrypted="dialogs.onRequestUnencryptedExport"
    @confirm="dialogs.configPassphraseMode.value === 'export' ? dialogs.onExportConfirm($event) : dialogs.onImportConfirm($event)"
  />
  <Dialog v-if="dialogs.showConfigUnencryptedExportConfirm.value" :open="dialogs.showConfigUnencryptedExportConfirm.value" @update:open="dialogs.onConfigUnencryptedExportOpenChange">
    <DialogContent class="sm:max-w-[440px]">
      <DialogHeader>
        <DialogTitle>{{ t("configExport.unencryptedWarningTitle") }}</DialogTitle>
      </DialogHeader>
      <p class="text-sm text-muted-foreground">{{ t("configExport.unencryptedWarningDescription") }}</p>
      <DialogFooter>
        <Button type="button" variant="outline" :disabled="dialogs.configExportBusy.value" @click="dialogs.onConfigUnencryptedExportCancel()">{{ t("dangerDialog.cancel") }}</Button>
        <Button type="button" variant="destructive" :disabled="dialogs.configExportBusy.value" @click="dialogs.onConfigUnencryptedExportConfirm()">{{ t("configExport.confirmUnencryptedExport") }}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
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
  <SshHostKeyPromptDialog />
  <ConnectionPasswordPromptDialog />
</template>

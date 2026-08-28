import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { rememberExportPassphrase } from "@/lib/backend/exportPassphraseSession";
import { hasSidebarLayoutEntries } from "@/lib/sidebar/sidebarLayout";
import type { ConnectionConfigBundle } from "@/lib/connection/connectionConfigTransfer";
import type { ConnectionConfig, SidebarLayout } from "@/types/database";

const showTransferDialog = ref(false);
const showSchemaDiffDialog = ref(false);
const showDataCompareDialog = ref(false);
const showSqlFileDialog = ref(false);
const showDiagramDialog = ref(false);
const showDocsDialog = ref(false);
const showTableImportDialog = ref(false);
const showTableDataGenerateDialog = ref(false);
const showFieldLineageDialog = ref(false);
const showDatabaseSearchDialog = ref(false);
const showDatabaseExportDialog = ref(false);
const showImportLayoutConfirm = ref(false);
const pendingImportLayout = ref<SidebarLayout | null>(null);
const showConfigPassphraseDialog = ref(false);
const configPassphraseMode = ref<"export" | "import">("export");
const configPassphraseError = ref("");
const showConfigUnencryptedExportConfirm = ref(false);
const configExportBusy = ref(false);
const pendingImportContent = ref("");
const showConfigConnectionSelectDialog = ref(false);
const configConnectionSelectMode = ref<"export" | "import">("export");
const configConnectionSelectList = ref<ConnectionConfig[]>([]);
const pendingExportConnectionIds = ref<string[]>([]);
const pendingImportPreview = ref<ConnectionConfigBundle | null>(null);
const pendingImportSource = ref<"dbx" | "navicat" | "dbeaver" | "datagrip">("dbx");
const applyingImportSelection = ref(false);

const transferPrefillConnectionId = ref("");
const transferPrefillDatabase = ref("");
const transferPrefillCatalog = ref("");
const transferPrefillSchema = ref("");
const transferPrefillTables = ref<string[]>([]);
const transferPrefillTargetConnectionId = ref("");
const transferPrefillTargetDatabase = ref("");
const transferPrefillTargetSchema = ref("");
const schemaDiffPrefillConnectionId = ref("");
const schemaDiffPrefillDatabase = ref("");
const schemaDiffPrefillSchema = ref("");
const dataComparePrefillConnectionId = ref("");
const dataComparePrefillDatabase = ref("");
const dataComparePrefillSchema = ref("");
const dataComparePrefillTable = ref("");
const sqlFilePrefillConnectionId = ref("");
const sqlFilePrefillDatabase = ref("");
const sqlFilePrefillFilePath = ref("");
const diagramPrefillConnectionId = ref("");
const diagramPrefillDatabase = ref("");
const diagramPrefillSchema = ref("");
const diagramFocusTableName = ref("");
const docsPrefillConnectionId = ref("");
const docsPrefillDatabase = ref("");
const docsPrefillSchema = ref("");
const tableImportPrefillConnectionId = ref("");
const tableImportPrefillDatabase = ref("");
const tableImportPrefillSchema = ref("");
const tableImportPrefillTable = ref("");
const tableDataGeneratePrefillConnectionId = ref("");
const tableDataGeneratePrefillDatabase = ref("");
const tableDataGeneratePrefillSchema = ref("");
const tableDataGeneratePrefillTable = ref("");
const lineagePrefillConnectionId = ref("");
const lineagePrefillDatabase = ref("");
const lineagePrefillSchema = ref("");
const lineagePrefillTable = ref("");
const lineagePrefillColumn = ref("");
const databaseSearchPrefillConnectionId = ref("");
const databaseSearchPrefillDatabase = ref("");
const databaseSearchPrefillSchema = ref("");
const databaseExportPrefillConnectionId = ref("");
const databaseExportPrefillDatabase = ref("");
const databaseExportPrefillSchema = ref("");
const databaseExportPrefillTable = ref("");
const databaseExportPrefillTables = ref<string[]>([]);
const databaseExportAllDatabases = ref(false);

let watchersRegistered = false;

function clearTransferPrefill() {
  transferPrefillConnectionId.value = "";
  transferPrefillDatabase.value = "";
  transferPrefillCatalog.value = "";
  transferPrefillSchema.value = "";
  transferPrefillTables.value = [];
  transferPrefillTargetConnectionId.value = "";
  transferPrefillTargetDatabase.value = "";
  transferPrefillTargetSchema.value = "";
}

export function useDialogSources() {
  const { t } = useI18n();
  const connectionStore = useConnectionStore();
  const { toast } = useToast();

  // Watchers for store source triggers (register only once)
  if (!watchersRegistered) {
    watchersRegistered = true;

    watch(
      () => connectionStore.transferSource,
      (v) => {
        if (v) {
          transferPrefillConnectionId.value = v.connectionId;
          transferPrefillDatabase.value = v.database;
          transferPrefillCatalog.value = v.catalog ?? "";
          transferPrefillSchema.value = v.schema ?? "";
          transferPrefillTables.value = v.tables ?? [];
          transferPrefillTargetConnectionId.value = v.targetConnectionId ?? "";
          transferPrefillTargetDatabase.value = v.targetDatabase ?? "";
          transferPrefillTargetSchema.value = v.targetSchema ?? "";
          showTransferDialog.value = true;
          connectionStore.transferSource = null;
        }
      },
    );

    watch(showTransferDialog, (open) => {
      if (!open) clearTransferPrefill();
    });

    watch(
      () => connectionStore.schemaDiffSource,
      (v) => {
        if (v) {
          schemaDiffPrefillConnectionId.value = v.connectionId;
          schemaDiffPrefillDatabase.value = v.database;
          schemaDiffPrefillSchema.value = v.schema ?? "";
          showSchemaDiffDialog.value = true;
          connectionStore.schemaDiffSource = null;
        }
      },
    );

    watch(
      () => connectionStore.dataCompareSource,
      (v) => {
        if (v) {
          dataComparePrefillConnectionId.value = v.connectionId;
          dataComparePrefillDatabase.value = v.database;
          dataComparePrefillSchema.value = v.schema ?? "";
          dataComparePrefillTable.value = v.tableName ?? "";
          showDataCompareDialog.value = true;
          connectionStore.dataCompareSource = null;
        }
      },
    );

    watch(
      () => connectionStore.sqlFileSource,
      (v) => {
        if (v) {
          sqlFilePrefillConnectionId.value = v.connectionId;
          sqlFilePrefillDatabase.value = v.database;
          sqlFilePrefillFilePath.value = v.filePath ?? "";
          showSqlFileDialog.value = true;
          connectionStore.sqlFileSource = null;
        }
      },
    );

    // Clear the pre-filled file path once the dialog closes so a later open
    // via the toolbar (which doesn't go through sqlFileSource) doesn't re-load
    // the previously previewed file. prefillConnectionId/database are harmless
    // when stale (they only preselect dropdowns), but a stale path triggers an
    // async file read + preview render — a visible side effect.
    watch(showSqlFileDialog, (open) => {
      if (!open) sqlFilePrefillFilePath.value = "";
    });

    watch(
      () => connectionStore.diagramSource,
      (v) => {
        if (v) {
          diagramPrefillConnectionId.value = v.connectionId;
          diagramPrefillDatabase.value = v.database;
          diagramPrefillSchema.value = v.schema ?? "";
          diagramFocusTableName.value = v.tableName ?? "";
          showDiagramDialog.value = true;
          connectionStore.diagramSource = null;
        }
      },
    );

    watch(
      () => connectionStore.docsSource,
      (v) => {
        if (v) {
          docsPrefillConnectionId.value = v.connectionId;
          docsPrefillDatabase.value = v.database;
          docsPrefillSchema.value = v.schema ?? "";
          showDocsDialog.value = true;
          // Clearing the source is what makes the dialog re-openable: setting
          // the same value twice would not re-trigger this watcher.
          connectionStore.docsSource = null;
        }
      },
    );

    watch(
      () => connectionStore.tableImportSource,
      (v) => {
        if (v) {
          tableImportPrefillConnectionId.value = v.connectionId;
          tableImportPrefillDatabase.value = v.database;
          tableImportPrefillSchema.value = v.schema ?? "";
          tableImportPrefillTable.value = v.tableName ?? "";
          showTableImportDialog.value = true;
          connectionStore.tableImportSource = null;
        }
      },
    );

    watch(
      () => connectionStore.tableDataGenerateSource,
      (v) => {
        if (v) {
          tableDataGeneratePrefillConnectionId.value = v.connectionId;
          tableDataGeneratePrefillDatabase.value = v.database;
          tableDataGeneratePrefillSchema.value = v.schema ?? "";
          tableDataGeneratePrefillTable.value = v.tableName;
          showTableDataGenerateDialog.value = true;
          connectionStore.tableDataGenerateSource = null;
        }
      },
    );

    watch(
      () => connectionStore.fieldLineageSource,
      (v) => {
        if (v) {
          lineagePrefillConnectionId.value = v.connectionId;
          lineagePrefillDatabase.value = v.database;
          lineagePrefillSchema.value = v.schema ?? "";
          lineagePrefillTable.value = v.tableName;
          lineagePrefillColumn.value = v.columnName;
          showFieldLineageDialog.value = true;
          connectionStore.fieldLineageSource = null;
        }
      },
    );

    watch(
      () => connectionStore.databaseSearchSource,
      (v) => {
        if (v) {
          databaseSearchPrefillConnectionId.value = v.connectionId;
          databaseSearchPrefillDatabase.value = v.database;
          databaseSearchPrefillSchema.value = v.schema ?? "";
          showDatabaseSearchDialog.value = true;
          connectionStore.databaseSearchSource = null;
        }
      },
    );

    watch(
      () => connectionStore.databaseExportSource,
      (v) => {
        if (v) {
          databaseExportPrefillConnectionId.value = v.connectionId;
          databaseExportPrefillDatabase.value = v.database;
          databaseExportPrefillSchema.value = v.schema ?? "";
          databaseExportPrefillTable.value = v.tableName ?? "";
          databaseExportPrefillTables.value = v.tableNames ?? [];
          databaseExportAllDatabases.value = v.allDatabases ?? false;
          showDatabaseExportDialog.value = true;
          connectionStore.databaseExportSource = null;
        }
      },
    );
  } // end watchersRegistered

  function clearPendingImportState() {
    pendingImportContent.value = "";
    pendingImportPreview.value = null;
    pendingImportSource.value = "dbx";
    configConnectionSelectList.value = [];
    configPassphraseError.value = "";
  }

  function clearPendingExportState() {
    pendingExportConnectionIds.value = [];
    configConnectionSelectList.value = [];
    configPassphraseError.value = "";
  }

  function openConnectionSelect(mode: "export" | "import", connections: ConnectionConfig[]) {
    configConnectionSelectMode.value = mode;
    configConnectionSelectList.value = connections;
    showConfigConnectionSelectDialog.value = true;
  }

  function importSuccessMessage(source: "dbx" | "navicat" | "dbeaver" | "datagrip", count: number, keychainFilled = 0) {
    if (count <= 0) return t("configExport.importNone");
    if (source === "navicat") return t("configExport.importNavicatSuccess", { count });
    if (source === "dbeaver") return t("configExport.importDbeaverSuccess", { count });
    if (source === "datagrip") return t("configExport.importDatagripSuccess", { count, filled: keychainFilled });
    return t("configExport.importSuccess", { count });
  }

  async function finishImport(source: "dbx" | "navicat" | "dbeaver" | "datagrip", count: number, layout?: SidebarLayout) {
    let keychainFilled = 0;
    if (source === "datagrip" && count > 0) {
      keychainFilled = await connectionStore.applyDataGripKeychainPasswords();
    }
    toast(importSuccessMessage(source, count, keychainFilled), source === "dbx" ? 2000 : 4000);
    if (hasSidebarLayoutEntries(layout)) {
      pendingImportLayout.value = layout;
      showImportLayoutConfirm.value = true;
    }
    clearPendingImportState();
  }

  // Config export/import helpers
  function onExportClick() {
    clearPendingExportState();
    openConnectionSelect("export", connectionStore.connections);
  }

  function onExportConnectionsSelected(connectionIds: string[]) {
    pendingExportConnectionIds.value = connectionIds;
    showConfigConnectionSelectDialog.value = false;
    configPassphraseMode.value = "export";
    configPassphraseError.value = "";
    showConfigPassphraseDialog.value = true;
  }

  async function onExportConfirm(passphrase: string) {
    if (configExportBusy.value) return;
    configExportBusy.value = true;
    try {
      const result = await connectionStore.exportConnectionsToFile({ mode: "encrypted", passphrase }, pendingExportConnectionIds.value);
      if (result === "cancelled") return;
      // 仅在文件写入成功后才记住密码短语，供同一会话内下次导出对话框回显（仅内存，不落盘）
      rememberExportPassphrase(passphrase);
      showConfigPassphraseDialog.value = false;
      clearPendingExportState();
      toast(t("configExport.exportSuccess"), 2000);
    } catch (e: any) {
      configPassphraseError.value = e?.message === "crypto_unavailable" ? t("configExport.cryptoUnavailable") : e?.message === "passphrase_required" ? t("configExport.passphraseRequired") : t("configExport.exportFailed");
    } finally {
      configExportBusy.value = false;
    }
  }

  function onRequestUnencryptedExport() {
    if (configExportBusy.value) return;
    showConfigPassphraseDialog.value = false;
    showConfigUnencryptedExportConfirm.value = true;
  }

  async function onConfigUnencryptedExportConfirm() {
    if (configExportBusy.value) return;
    configExportBusy.value = true;
    try {
      const result = await connectionStore.exportConnectionsToFile({ mode: "plaintext" }, pendingExportConnectionIds.value);
      if (result === "cancelled") return;
      showConfigUnencryptedExportConfirm.value = false;
      clearPendingExportState();
      toast(t("configExport.exportSuccess"), 2000);
    } catch {
      showConfigUnencryptedExportConfirm.value = false;
      configPassphraseError.value = t("configExport.exportFailed");
      showConfigPassphraseDialog.value = true;
    } finally {
      configExportBusy.value = false;
    }
  }

  function onConfigUnencryptedExportCancel() {
    if (configExportBusy.value) return;
    showConfigUnencryptedExportConfirm.value = false;
    showConfigPassphraseDialog.value = true;
  }

  function onConfigUnencryptedExportOpenChange(open: boolean) {
    if (configExportBusy.value) return;
    showConfigUnencryptedExportConfirm.value = open;
    if (!open) showConfigPassphraseDialog.value = true;
  }

  async function onImportClick(source: "dbx" | "navicat" | "dbeaver" | "datagrip" = "dbx") {
    try {
      const result = await connectionStore.readImportFile(source);
      if (!result) return;
      clearPendingImportState();
      pendingImportContent.value = result.content;
      pendingImportSource.value = source;
      if (result.encrypted) {
        configPassphraseMode.value = "import";
        configPassphraseError.value = "";
        showConfigPassphraseDialog.value = true;
        return;
      }
      const preview = await connectionStore.parseConnectionsImport(result.content, null);
      pendingImportPreview.value = preview;
      if (source === "dbx") {
        openConnectionSelect("import", preview.connections);
        return;
      }
      const { count, layout } = await connectionStore.applyConnectionsImport(preview);
      await finishImport(source, count, layout);
    } catch (e: any) {
      clearPendingImportState();
      toast(e?.message || String(e), 4000);
    }
  }

  async function onImportConfirm(passphrase: string) {
    try {
      const preview = await connectionStore.parseConnectionsImport(pendingImportContent.value, passphrase);
      pendingImportPreview.value = preview;
      showConfigPassphraseDialog.value = false;
      configPassphraseError.value = "";
      openConnectionSelect("import", preview.connections);
    } catch (e: any) {
      configPassphraseError.value = e?.message === "wrong_passphrase" ? t("configExport.wrongPassphrase") : e?.message === "crypto_unavailable" ? t("configExport.cryptoUnavailable") : e?.message || String(e);
    }
  }

  async function onImportConnectionsSelected(connectionIds: string[]) {
    const preview = pendingImportPreview.value;
    if (!preview) return;
    if (applyingImportSelection.value) return;
    applyingImportSelection.value = true;
    try {
      const { count, layout } = await connectionStore.applyConnectionsImport(preview, connectionIds);
      showConfigConnectionSelectDialog.value = false;
      await finishImport(pendingImportSource.value, count, layout);
    } catch (e: any) {
      toast(e?.message || String(e), 4000);
    } finally {
      applyingImportSelection.value = false;
    }
  }

  function onConfigConnectionSelectConfirm(connectionIds: string[]) {
    if (configConnectionSelectMode.value === "export") {
      onExportConnectionsSelected(connectionIds);
      return;
    }
    void onImportConnectionsSelected(connectionIds);
  }

  function onConfigConnectionSelectOpenChange(open: boolean) {
    if (!open && configConnectionSelectMode.value === "import" && applyingImportSelection.value) return;
    showConfigConnectionSelectDialog.value = open;
    // Export selection closing to open the passphrase dialog must keep the
    // chosen ids. Only import preview is discarded when the user cancels.
    if (!open && configConnectionSelectMode.value === "import") clearPendingImportState();
  }

  function onConfigPassphraseOpenChange(open: boolean) {
    showConfigPassphraseDialog.value = open;
    if (open) return;
    if (configPassphraseMode.value === "export") {
      if (!showConfigUnencryptedExportConfirm.value) clearPendingExportState();
    } else if (!pendingImportPreview.value) clearPendingImportState();
  }

  return {
    showTransferDialog,
    showSchemaDiffDialog,
    showDataCompareDialog,
    showSqlFileDialog,
    showDiagramDialog,
    showDocsDialog,
    showTableImportDialog,
    showTableDataGenerateDialog,
    showFieldLineageDialog,
    showDatabaseSearchDialog,
    showDatabaseExportDialog,
    showImportLayoutConfirm,
    pendingImportLayout,
    showConfigPassphraseDialog,
    configPassphraseMode,
    configPassphraseError,
    showConfigUnencryptedExportConfirm,
    configExportBusy,
    pendingImportContent,
    showConfigConnectionSelectDialog,
    applyingImportSelection,
    configConnectionSelectMode,
    configConnectionSelectList,
    transferPrefillConnectionId,
    transferPrefillDatabase,
    transferPrefillCatalog,
    transferPrefillSchema,
    transferPrefillTables,
    transferPrefillTargetConnectionId,
    transferPrefillTargetDatabase,
    transferPrefillTargetSchema,
    schemaDiffPrefillConnectionId,
    schemaDiffPrefillDatabase,
    schemaDiffPrefillSchema,
    dataComparePrefillConnectionId,
    dataComparePrefillDatabase,
    dataComparePrefillSchema,
    dataComparePrefillTable,
    sqlFilePrefillConnectionId,
    sqlFilePrefillDatabase,
    sqlFilePrefillFilePath,
    diagramPrefillConnectionId,
    diagramPrefillDatabase,
    diagramPrefillSchema,
    diagramFocusTableName,
    docsPrefillConnectionId,
    docsPrefillDatabase,
    docsPrefillSchema,
    tableImportPrefillConnectionId,
    tableImportPrefillDatabase,
    tableImportPrefillSchema,
    tableImportPrefillTable,
    tableDataGeneratePrefillConnectionId,
    tableDataGeneratePrefillDatabase,
    tableDataGeneratePrefillSchema,
    tableDataGeneratePrefillTable,
    lineagePrefillConnectionId,
    lineagePrefillDatabase,
    lineagePrefillSchema,
    lineagePrefillTable,
    lineagePrefillColumn,
    databaseSearchPrefillConnectionId,
    databaseSearchPrefillDatabase,
    databaseSearchPrefillSchema,
    databaseExportPrefillConnectionId,
    databaseExportPrefillDatabase,
    databaseExportPrefillSchema,
    databaseExportPrefillTable,
    databaseExportPrefillTables,
    databaseExportAllDatabases,
    onExportClick,
    onExportConfirm,
    onRequestUnencryptedExport,
    onConfigUnencryptedExportConfirm,
    onConfigUnencryptedExportCancel,
    onConfigUnencryptedExportOpenChange,
    onImportClick,
    onImportConfirm,
    onConfigConnectionSelectConfirm,
    onConfigConnectionSelectOpenChange,
    onConfigPassphraseOpenChange,
  };
}

import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { SidebarLayout } from "@/types/database";

const showTransferDialog = ref(false);
const showSchemaDiffDialog = ref(false);
const showDataCompareDialog = ref(false);
const showSqlFileDialog = ref(false);
const showDiagramDialog = ref(false);
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
const pendingImportContent = ref("");

const transferPrefillConnectionId = ref("");
const transferPrefillDatabase = ref("");
const schemaDiffPrefillConnectionId = ref("");
const schemaDiffPrefillDatabase = ref("");
const schemaDiffPrefillSchema = ref("");
const dataComparePrefillConnectionId = ref("");
const dataComparePrefillDatabase = ref("");
const dataComparePrefillSchema = ref("");
const dataComparePrefillTable = ref("");
const sqlFilePrefillConnectionId = ref("");
const sqlFilePrefillDatabase = ref("");
const diagramPrefillConnectionId = ref("");
const diagramPrefillDatabase = ref("");
const diagramPrefillSchema = ref("");
const diagramFocusTableName = ref("");
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

let watchersRegistered = false;

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
          showTransferDialog.value = true;
          connectionStore.transferSource = null;
        }
      },
    );

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
          showSqlFileDialog.value = true;
          connectionStore.sqlFileSource = null;
        }
      },
    );

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
      () => connectionStore.tableImportSource,
      (v) => {
        if (v) {
          tableImportPrefillConnectionId.value = v.connectionId;
          tableImportPrefillDatabase.value = v.database;
          tableImportPrefillSchema.value = v.schema ?? "";
          tableImportPrefillTable.value = v.tableName;
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
          showDatabaseExportDialog.value = true;
          connectionStore.databaseExportSource = null;
        }
      },
    );
  } // end watchersRegistered

  // Config export/import helpers
  function onExportClick() {
    configPassphraseMode.value = "export";
    configPassphraseError.value = "";
    showConfigPassphraseDialog.value = true;
  }

  async function onExportConfirm(passphrase: string) {
    try {
      await connectionStore.exportConnectionsToFile(passphrase);
      showConfigPassphraseDialog.value = false;
      toast(t("configExport.exportSuccess"), 2000);
    } catch (e: any) {
      configPassphraseError.value = e?.message === "crypto_unavailable" ? t("configExport.cryptoUnavailable") : e?.message || String(e);
    }
  }

  async function onImportClick(source: "dbx" | "navicat" | "dbeaver" | "datagrip" = "dbx") {
    try {
      const result = await connectionStore.readImportFile(source);
      if (!result) return;
      pendingImportContent.value = result.content;
      if (result.encrypted) {
        configPassphraseMode.value = "import";
        configPassphraseError.value = "";
        showConfigPassphraseDialog.value = true;
      } else {
        const { count, layout } = await connectionStore.importConnectionsFromFile(result.content, null);
        // For DataGrip imports, read Keychain passwords
        let keychainFilled = 0;
        if (source === "datagrip" && count > 0) {
          keychainFilled = await connectionStore.applyDataGripKeychainPasswords();
        }
        toast(
          count > 0
            ? source === "navicat"
              ? t("configExport.importNavicatSuccess", { count })
              : source === "dbeaver"
                ? t("configExport.importDbeaverSuccess", { count })
                : source === "datagrip"
                  ? t("configExport.importDatagripSuccess", { count: count, filled: keychainFilled })
                  : t("configExport.importSuccess", { count })
            : t("configExport.importNone"),
          4000,
        );
        if (layout && count > 0) {
          pendingImportLayout.value = layout;
          showImportLayoutConfirm.value = true;
        }
      }
    } catch (e: any) {
      toast(e?.message || String(e), 4000);
    }
  }

  async function onImportConfirm(passphrase: string) {
    try {
      const { count, layout } = await connectionStore.importConnectionsFromFile(pendingImportContent.value, passphrase);
      showConfigPassphraseDialog.value = false;
      toast(count > 0 ? t("configExport.importSuccess", { count }) : t("configExport.importNone"), 2000);
      if (layout && count > 0) {
        pendingImportLayout.value = layout;
        showImportLayoutConfirm.value = true;
      }
    } catch (e: any) {
      configPassphraseError.value = e?.message === "wrong_passphrase" ? t("configExport.wrongPassphrase") : e?.message === "crypto_unavailable" ? t("configExport.cryptoUnavailable") : e?.message || String(e);
    }
  }

  return {
    showTransferDialog,
    showSchemaDiffDialog,
    showDataCompareDialog,
    showSqlFileDialog,
    showDiagramDialog,
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
    pendingImportContent,
    transferPrefillConnectionId,
    transferPrefillDatabase,
    schemaDiffPrefillConnectionId,
    schemaDiffPrefillDatabase,
    schemaDiffPrefillSchema,
    dataComparePrefillConnectionId,
    dataComparePrefillDatabase,
    dataComparePrefillSchema,
    dataComparePrefillTable,
    sqlFilePrefillConnectionId,
    sqlFilePrefillDatabase,
    diagramPrefillConnectionId,
    diagramPrefillDatabase,
    diagramPrefillSchema,
    diagramFocusTableName,
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
    onExportClick,
    onExportConfirm,
    onImportClick,
    onImportConfirm,
  };
}

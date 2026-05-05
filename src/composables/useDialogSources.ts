import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import type { SidebarLayout } from "@/types/database";

const showTransferDialog = ref(false);
const showSchemaDiffDialog = ref(false);
const showSqlFileDialog = ref(false);
const showDiagramDialog = ref(false);
const showTableImportDialog = ref(false);
const showStructureEditorDialog = ref(false);
const showFieldLineageDialog = ref(false);
const showDatabaseSearchDialog = ref(false);
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
const structurePrefillConnectionId = ref("");
const structurePrefillDatabase = ref("");
const structurePrefillSchema = ref("");
const structurePrefillTable = ref("");
const lineagePrefillConnectionId = ref("");
const lineagePrefillDatabase = ref("");
const lineagePrefillSchema = ref("");
const lineagePrefillTable = ref("");
const lineagePrefillColumn = ref("");
const databaseSearchPrefillConnectionId = ref("");
const databaseSearchPrefillDatabase = ref("");
const databaseSearchPrefillSchema = ref("");

let watchersRegistered = false;

export function useDialogSources() {
  const { t } = useI18n();
  const connectionStore = useConnectionStore();
  const { toast } = useToast();

  // Watchers for store source triggers (register only once)
  if (!watchersRegistered) {
    watchersRegistered = true;

  watch(() => connectionStore.transferSource, (v) => {
    if (v) {
      transferPrefillConnectionId.value = v.connectionId;
      transferPrefillDatabase.value = v.database;
      showTransferDialog.value = true;
      connectionStore.transferSource = null;
    }
  });

  watch(() => connectionStore.schemaDiffSource, (v) => {
    if (v) {
      schemaDiffPrefillConnectionId.value = v.connectionId;
      schemaDiffPrefillDatabase.value = v.database;
      showSchemaDiffDialog.value = true;
      connectionStore.schemaDiffSource = null;
    }
  });

  watch(() => connectionStore.sqlFileSource, (v) => {
    if (v) {
      sqlFilePrefillConnectionId.value = v.connectionId;
      sqlFilePrefillDatabase.value = v.database;
      showSqlFileDialog.value = true;
      connectionStore.sqlFileSource = null;
    }
  });

  watch(() => connectionStore.diagramSource, (v) => {
    if (v) {
      diagramPrefillConnectionId.value = v.connectionId;
      diagramPrefillDatabase.value = v.database;
      diagramPrefillSchema.value = v.schema ?? "";
      diagramFocusTableName.value = v.tableName ?? "";
      showDiagramDialog.value = true;
      connectionStore.diagramSource = null;
    }
  });

  watch(() => connectionStore.tableImportSource, (v) => {
    if (v) {
      tableImportPrefillConnectionId.value = v.connectionId;
      tableImportPrefillDatabase.value = v.database;
      tableImportPrefillSchema.value = v.schema ?? "";
      tableImportPrefillTable.value = v.tableName;
      showTableImportDialog.value = true;
      connectionStore.tableImportSource = null;
    }
  });

  watch(() => connectionStore.structureEditorSource, (v) => {
    if (v) {
      structurePrefillConnectionId.value = v.connectionId;
      structurePrefillDatabase.value = v.database;
      structurePrefillSchema.value = v.schema ?? "";
      structurePrefillTable.value = v.tableName;
      showStructureEditorDialog.value = true;
      connectionStore.structureEditorSource = null;
    }
  });

  watch(() => connectionStore.fieldLineageSource, (v) => {
    if (v) {
      lineagePrefillConnectionId.value = v.connectionId;
      lineagePrefillDatabase.value = v.database;
      lineagePrefillSchema.value = v.schema ?? "";
      lineagePrefillTable.value = v.tableName;
      lineagePrefillColumn.value = v.columnName;
      showFieldLineageDialog.value = true;
      connectionStore.fieldLineageSource = null;
    }
  });

  watch(() => connectionStore.databaseSearchSource, (v) => {
    if (v) {
      databaseSearchPrefillConnectionId.value = v.connectionId;
      databaseSearchPrefillDatabase.value = v.database;
      databaseSearchPrefillSchema.value = v.schema ?? "";
      showDatabaseSearchDialog.value = true;
      connectionStore.databaseSearchSource = null;
    }
  });
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
      configPassphraseError.value = e?.message || String(e);
    }
  }

  async function onImportClick() {
    try {
      const result = await connectionStore.readImportFile();
      if (!result) return;
      pendingImportContent.value = result.content;
      if (result.encrypted) {
        configPassphraseMode.value = "import";
        configPassphraseError.value = "";
        showConfigPassphraseDialog.value = true;
      } else {
        const { count, layout } = await connectionStore.importConnectionsFromFile(result.content, null);
        toast(count > 0 ? t("configExport.importSuccess", { count }) : t("configExport.importNone"), 2000);
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
      configPassphraseError.value = e?.message === "wrong_passphrase" ? t("configExport.wrongPassphrase") : (e?.message || String(e));
    }
  }

  return {
    showTransferDialog,
    showSchemaDiffDialog,
    showSqlFileDialog,
    showDiagramDialog,
    showTableImportDialog,
    showStructureEditorDialog,
    showFieldLineageDialog,
    showDatabaseSearchDialog,
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
    structurePrefillConnectionId,
    structurePrefillDatabase,
    structurePrefillSchema,
    structurePrefillTable,
    lineagePrefillConnectionId,
    lineagePrefillDatabase,
    lineagePrefillSchema,
    lineagePrefillTable,
    lineagePrefillColumn,
    databaseSearchPrefillConnectionId,
    databaseSearchPrefillDatabase,
    databaseSearchPrefillSchema,
    onExportClick,
    onExportConfirm,
    onImportClick,
    onImportConfirm,
  };
}

import { ref, watch } from "vue";
import type { SqlFilePreview } from "@/lib/backend/api";
import { useI18n } from "vue-i18n";
import { useConnectionStore } from "@/stores/connectionStore";
import { useToast } from "@/composables/useToast";
import { rememberExportPassphrase } from "@/lib/backend/exportPassphraseSession";
import { hasSidebarLayoutEntries } from "@/lib/sidebar/sidebarLayout";
import type { ConnectionConfigBundle } from "@/lib/connection/connectionConfigTransfer";
import type {
  ConnectionConfig,
  DataCompareTabState,
  DataDictionaryTabState,
  DataGenerateTabState,
  DatabaseDocsTabState,
  DatabaseExportTabState,
  DatabaseType,
  FieldLineageTabState,
  MongoDumpTabState,
  MongoImportTabState,
  SchemaDiagramTabState,
  SchemaDiffTabState,
  SidebarLayout,
  TransferTabState,
} from "@/types/database";

const showTransferDialog = ref(false);
const transferTaskId = ref<string | null>(null);
/** Snapshot injected by a converted data-transfer tab; consumed once the dialog restores it. */
const transferInitialState = ref<TransferTabState>();
/** Whether the data-transfer dialog singleton is busy submitting. */
const transferDialogBusy = ref(false);
const showSchemaDiffDialog = ref(false);
const showDataCompareDialog = ref(false);
const showSqlFileDialog = ref(false);
const showDiagramDialog = ref(false);
const showDocsDialog = ref(false);
const showDataDictionaryDialog = ref(false);
const showTableImportDialog = ref(false);
const showMongoImportDialog = ref(false);
const showMongoDatabaseDumpDialog = ref(false);
const mongoDatabaseDumpPrefillConnectionId = ref("");
const mongoDatabaseDumpPrefillDatabase = ref("");
const mongoDatabaseDumpMode = ref<"dump" | "restore">("dump");
/** Snapshot injected by a converted mongo-dump tab; consumed once the dialog restores it. */
const mongoDumpInitialState = ref<MongoDumpTabState>();
const showDamengDumpDialog = ref(false);
const damengDumpPrefillConnectionId = ref("");
const damengDumpPrefillDatabase = ref("");
const damengDumpMode = ref<"export" | "import">("export");
const showTableDataGenerateDialog = ref(false);
const tableDataGenerateSessionId = ref<string | null>(null);
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
const configConnectionSelectLayout = ref<SidebarLayout | null>(null);
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
const schemaDiffPrefillSelectedRoutines = ref<string[] | undefined>(undefined);
const schemaDiffPrefillResultTab = ref<"tables" | "routines" | "">("");
const schemaDiffSessionId = ref<string | null>(null);
/** Snapshot injected by a converted schema-diff tab; consumed once the dialog restores it. */
const schemaDiffInitialState = ref<SchemaDiffTabState>();
/** Whether the schema-diff dialog singleton is busy (compare loading or deploy executing). */
const schemaDiffDialogBusy = ref(false);
const dataComparePrefillConnectionId = ref("");
const dataComparePrefillDatabase = ref("");
const dataComparePrefillSchema = ref("");
const dataComparePrefillTable = ref("");
const dataCompareSessionId = ref<string | null>(null);
/** Snapshot injected by a converted data-compare tab; consumed once the dialog restores it. */
const dataCompareInitialState = ref<DataCompareTabState>();
/** Whether the data-compare dialog singleton currently holds an active transaction (blocks tab -> dialog conversion). */
const dataCompareDialogTransactionActive = ref(false);
const sqlFilePrefillConnectionId = ref("");
const sqlFilePrefillDatabase = ref("");
const sqlFilePrefillSchema = ref<string>();
const sqlFilePrefillFilePath = ref("");
const sqlFilePrefillPreview = ref<SqlFilePreview>();
const diagramPrefillConnectionId = ref("");
const diagramPrefillDatabase = ref("");
const diagramPrefillSchema = ref("");
const diagramFocusTableName = ref("");
const diagramFocusTableNames = ref<string[]>([]);
/** Snapshot injected by a converted schema-diagram tab; consumed once the dialog restores it. */
const diagramInitialState = ref<SchemaDiagramTabState>();
const docsPrefillConnectionId = ref("");
const docsPrefillDatabase = ref("");
const docsPrefillSchema = ref("");
/** Snapshot injected by a converted database-docs tab; consumed once the dialog restores it. */
const docsInitialState = ref<DatabaseDocsTabState>();
const dataDictionaryPrefillConnectionId = ref("");
const dataDictionaryPrefillDatabase = ref("");
const dataDictionaryPrefillSchema = ref("");
const dataDictionaryPrefillTableNames = ref<string[]>([]);
/** Snapshot injected by a converted data-dictionary tab; consumed once the dialog restores it. */
const dataDictionaryInitialState = ref<DataDictionaryTabState>();
const tableImportPrefillConnectionId = ref("");
const tableImportPrefillDatabase = ref("");
const tableImportPrefillSchema = ref("");
const tableImportPrefillTable = ref("");
const mongoImportPrefillConnectionId = ref("");
const mongoImportPrefillDatabase = ref("");
const mongoImportPrefillCollection = ref("");
/** Snapshot injected by a converted mongo-import tab; consumed once the dialog restores it. */
const mongoImportInitialState = ref<MongoImportTabState>();
const tableDataGeneratePrefillConnectionId = ref("");
const tableDataGeneratePrefillDatabase = ref("");
const tableDataGeneratePrefillSchema = ref("");
const tableDataGeneratePrefillTable = ref("");
/** Snapshot injected by a converted data-generate tab; consumed once the dialog restores it. */
const tableDataGenerateInitialState = ref<DataGenerateTabState>();
const lineagePrefillConnectionId = ref("");
const lineagePrefillDatabaseType = ref<DatabaseType>();
const lineagePrefillDatabase = ref("");
const lineagePrefillSchema = ref("");
const lineagePrefillTable = ref("");
const lineagePrefillColumn = ref("");
/** Snapshot injected by a converted field-lineage tab; consumed once the dialog restores it. */
const lineageInitialState = ref<FieldLineageTabState>();
const databaseSearchPrefillConnectionId = ref("");
const databaseSearchPrefillDatabase = ref("");
const databaseSearchPrefillSchema = ref("");
const databaseExportPrefillConnectionId = ref("");
const databaseExportPrefillDatabase = ref("");
const databaseExportPrefillSchema = ref("");
const databaseExportPrefillTable = ref("");
const databaseExportPrefillTables = ref<string[]>([]);
const databaseExportAllDatabases = ref(false);
/** Snapshot injected by a converted database-export tab; consumed once the dialog restores it. */
const databaseExportInitialState = ref<DatabaseExportTabState>();

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

export function openSchemaDiffSession(sessionId: string): void {
  schemaDiffSessionId.value = sessionId;
  showSchemaDiffDialog.value = true;
}

/** Converts a field-lineage tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openFieldLineageDialogWithState(state: FieldLineageTabState): void {
  lineageInitialState.value = state;
  lineagePrefillConnectionId.value = "";
  lineagePrefillDatabase.value = "";
  lineagePrefillSchema.value = "";
  lineagePrefillTable.value = "";
  lineagePrefillColumn.value = "";
  lineagePrefillDatabaseType.value = undefined;
  showFieldLineageDialog.value = true;
}

export function clearFieldLineageInitialState(): void {
  lineageInitialState.value = undefined;
}

/** Converts a data-dictionary tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openDataDictionaryDialogWithState(state: DataDictionaryTabState): void {
  dataDictionaryInitialState.value = state;
  dataDictionaryPrefillConnectionId.value = "";
  dataDictionaryPrefillDatabase.value = "";
  dataDictionaryPrefillSchema.value = "";
  dataDictionaryPrefillTableNames.value = [];
  showDataDictionaryDialog.value = true;
}

export function clearDataDictionaryInitialState(): void {
  dataDictionaryInitialState.value = undefined;
}

/** Converts a database-docs tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openDatabaseDocsDialogWithState(state: DatabaseDocsTabState): void {
  docsInitialState.value = state;
  docsPrefillConnectionId.value = "";
  docsPrefillDatabase.value = "";
  docsPrefillSchema.value = "";
  showDocsDialog.value = true;
}

export function clearDatabaseDocsInitialState(): void {
  docsInitialState.value = undefined;
}

/** Converts a database-export tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openDatabaseExportDialogWithState(state: DatabaseExportTabState): void {
  databaseExportInitialState.value = state;
  databaseExportPrefillConnectionId.value = "";
  databaseExportPrefillDatabase.value = "";
  databaseExportPrefillSchema.value = "";
  databaseExportPrefillTable.value = "";
  databaseExportPrefillTables.value = [];
  databaseExportAllDatabases.value = false;
  showDatabaseExportDialog.value = true;
}

export function clearDatabaseExportInitialState(): void {
  databaseExportInitialState.value = undefined;
}

/** Converts a data-generate tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openDataGenerateDialogWithState(state: DataGenerateTabState): void {
  tableDataGenerateInitialState.value = state;
  tableDataGenerateSessionId.value = null;
  tableDataGeneratePrefillConnectionId.value = "";
  tableDataGeneratePrefillDatabase.value = "";
  tableDataGeneratePrefillSchema.value = "";
  tableDataGeneratePrefillTable.value = "";
  showTableDataGenerateDialog.value = true;
}

export function clearDataGenerateInitialState(): void {
  tableDataGenerateInitialState.value = undefined;
}

/** Converts a mongo-import tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openMongoImportDialogWithState(state: MongoImportTabState): void {
  mongoImportInitialState.value = state;
  mongoImportPrefillConnectionId.value = "";
  mongoImportPrefillDatabase.value = "";
  mongoImportPrefillCollection.value = "";
  showMongoImportDialog.value = true;
}

export function clearMongoImportInitialState(): void {
  mongoImportInitialState.value = undefined;
}

/** Converts a mongo-dump tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openMongoDumpDialogWithState(state: MongoDumpTabState): void {
  mongoDumpInitialState.value = state;
  mongoDatabaseDumpPrefillConnectionId.value = "";
  mongoDatabaseDumpPrefillDatabase.value = "";
  mongoDatabaseDumpMode.value = state.config.mode;
  showMongoDatabaseDumpDialog.value = true;
}

export function clearMongoDumpInitialState(): void {
  mongoDumpInitialState.value = undefined;
}

/** Converts a schema-diagram tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openSchemaDiagramDialogWithState(state: SchemaDiagramTabState): void {
  diagramInitialState.value = state;
  diagramPrefillConnectionId.value = "";
  diagramPrefillDatabase.value = "";
  diagramPrefillSchema.value = "";
  diagramFocusTableName.value = "";
  diagramFocusTableNames.value = [];
  showDiagramDialog.value = true;
}

export function clearDiagramInitialState(): void {
  diagramInitialState.value = undefined;
}

/** Converts a schema-diff tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openSchemaDiffDialogWithState(state: SchemaDiffTabState): void {
  schemaDiffInitialState.value = state;
  schemaDiffSessionId.value = null;
  schemaDiffPrefillConnectionId.value = "";
  schemaDiffPrefillDatabase.value = "";
  schemaDiffPrefillSchema.value = "";
  schemaDiffPrefillSelectedRoutines.value = undefined;
  schemaDiffPrefillResultTab.value = "";
  showSchemaDiffDialog.value = true;
}

export function clearSchemaDiffInitialState(): void {
  schemaDiffInitialState.value = undefined;
}

export function setSchemaDiffDialogBusy(busy: boolean): void {
  schemaDiffDialogBusy.value = busy;
}

export function openDataCompareSession(sessionId: string): void {
  dataCompareSessionId.value = sessionId;
  showDataCompareDialog.value = true;
}

/** Converts a data-compare tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openDataCompareDialogWithState(state: DataCompareTabState): void {
  dataCompareInitialState.value = state;
  dataCompareSessionId.value = null;
  dataComparePrefillConnectionId.value = "";
  dataComparePrefillDatabase.value = "";
  dataComparePrefillSchema.value = "";
  dataComparePrefillTable.value = "";
  showDataCompareDialog.value = true;
}

export function clearDataCompareInitialState(): void {
  dataCompareInitialState.value = undefined;
}

export function setDataCompareDialogTransactionActive(active: boolean): void {
  dataCompareDialogTransactionActive.value = active;
}

export function openDataTransferTask(taskId: string): void {
  transferTaskId.value = taskId;
  showTransferDialog.value = true;
}

/** Converts a data-transfer tab back into the dialog: injects the snapshot and opens the singleton dialog. */
export function openDataTransferDialogWithState(state: TransferTabState): void {
  transferInitialState.value = state;
  transferTaskId.value = null;
  transferPrefillConnectionId.value = "";
  transferPrefillDatabase.value = "";
  transferPrefillCatalog.value = "";
  transferPrefillSchema.value = "";
  transferPrefillTables.value = [];
  transferPrefillTargetConnectionId.value = "";
  transferPrefillTargetDatabase.value = "";
  transferPrefillTargetSchema.value = "";
  showTransferDialog.value = true;
}

export function clearTransferInitialState(): void {
  transferInitialState.value = undefined;
}

export function setDataTransferDialogBusy(busy: boolean): void {
  transferDialogBusy.value = busy;
}

export function openDataGenerateSession(sessionId: string, target: { connectionId: string; database: string; schema?: string; tableName?: string }): void {
  tableDataGenerateSessionId.value = sessionId;
  tableDataGeneratePrefillConnectionId.value = target.connectionId;
  tableDataGeneratePrefillDatabase.value = target.database;
  tableDataGeneratePrefillSchema.value = target.schema ?? "";
  tableDataGeneratePrefillTable.value = target.tableName ?? "";
  showTableDataGenerateDialog.value = true;
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
          transferTaskId.value = null;
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

    // Cleanup on close: sync flush so session/snapshot state is cleared before
    // any dependent effect of the close (same reasoning as data-compare).
    watch(
      showTransferDialog,
      (open) => {
        if (!open) {
          transferTaskId.value = null;
          transferInitialState.value = undefined;
          clearTransferPrefill();
        }
      },
      { flush: "sync" },
    );

    watch(
      () => connectionStore.schemaDiffSource,
      (v) => {
        if (v) {
          schemaDiffPrefillConnectionId.value = v.connectionId;
          schemaDiffPrefillDatabase.value = v.database;
          schemaDiffPrefillSchema.value = v.schema ?? "";
          schemaDiffPrefillSelectedRoutines.value = v.selectedRoutines;
          schemaDiffPrefillResultTab.value = v.preferredResultTab ?? "";
          schemaDiffSessionId.value = null;
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
          dataCompareSessionId.value = null;
          showDataCompareDialog.value = true;
          connectionStore.dataCompareSource = null;
        }
      },
    );

    // Cleanup on close: sync flush so session/snapshot state is cleared before
    // any dependent effect of the close (same reasoning as data-compare).
    watch(
      showSchemaDiffDialog,
      (open) => {
        if (!open) {
          schemaDiffSessionId.value = null;
          schemaDiffInitialState.value = undefined;
        }
      },
      { flush: "sync" },
    );

    // Cleanup on close: sync flush so session/snapshot state is cleared before
    // any dependent effect of the close (also deterministic under test).
    watch(
      showDataCompareDialog,
      (open) => {
        if (!open) {
          dataCompareSessionId.value = null;
          dataCompareInitialState.value = undefined;
        }
      },
      { flush: "sync" },
    );

    watch(
      () => connectionStore.sqlFileSource,
      (v) => {
        if (v) {
          sqlFilePrefillConnectionId.value = v.connectionId;
          sqlFilePrefillDatabase.value = v.database;
          sqlFilePrefillSchema.value = v.schema;
          sqlFilePrefillFilePath.value = v.filePath ?? "";
          sqlFilePrefillPreview.value = v.preview;
          showSqlFileDialog.value = true;
          connectionStore.sqlFileSource = null;
        }
      },
    );

    // Clear the complete prefill once the dialog closes. A later toolbar open
    // derives its target from the then-active SQL tab, so neither the old path
    // nor its connection context may leak into that session.
    watch(showSqlFileDialog, (open) => {
      if (!open) {
        sqlFilePrefillConnectionId.value = "";
        sqlFilePrefillDatabase.value = "";
        sqlFilePrefillSchema.value = undefined;
        sqlFilePrefillFilePath.value = "";
        sqlFilePrefillPreview.value = undefined;
      }
    });

    watch(
      () => connectionStore.diagramSource,
      (v) => {
        if (v) {
          diagramPrefillConnectionId.value = v.connectionId;
          diagramPrefillDatabase.value = v.database;
          diagramPrefillSchema.value = v.schema ?? "";
          diagramFocusTableName.value = v.tableName ?? "";
          diagramFocusTableNames.value = v.tableNames ?? (v.tableName ? [v.tableName] : []);
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
      () => connectionStore.dataDictionarySource,
      (v) => {
        if (v) {
          dataDictionaryPrefillConnectionId.value = v.connectionId;
          dataDictionaryPrefillDatabase.value = v.database;
          dataDictionaryPrefillSchema.value = v.schema ?? "";
          dataDictionaryPrefillTableNames.value = v.tableNames ?? [];
          showDataDictionaryDialog.value = true;
          connectionStore.dataDictionarySource = null;
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
      () => connectionStore.mongoImportSource,
      (v) => {
        if (v) {
          mongoImportPrefillConnectionId.value = v.connectionId;
          mongoImportPrefillDatabase.value = v.database;
          mongoImportPrefillCollection.value = v.collection;
          showMongoImportDialog.value = true;
          connectionStore.mongoImportSource = null;
        }
      },
    );

    watch(
      () => connectionStore.mongoDatabaseDumpSource,
      (source) => {
        if (!source) return;
        mongoDatabaseDumpPrefillConnectionId.value = source.connectionId;
        mongoDatabaseDumpPrefillDatabase.value = source.database;
        mongoDatabaseDumpMode.value = source.mode;
        showMongoDatabaseDumpDialog.value = true;
        connectionStore.mongoDatabaseDumpSource = null;
      },
    );

    watch(
      () => connectionStore.damengDumpSource,
      (source) => {
        if (!source) return;
        damengDumpPrefillConnectionId.value = source.connectionId;
        damengDumpPrefillDatabase.value = source.database;
        damengDumpMode.value = source.mode;
        showDamengDumpDialog.value = true;
        connectionStore.damengDumpSource = null;
      },
    );

    watch(
      () => connectionStore.tableDataGenerateSource,
      (v) => {
        if (v) {
          tableDataGenerateSessionId.value = null;
          tableDataGeneratePrefillConnectionId.value = v.connectionId;
          tableDataGeneratePrefillDatabase.value = v.database;
          tableDataGeneratePrefillSchema.value = v.schema ?? "";
          tableDataGeneratePrefillTable.value = v.tableName;
          showTableDataGenerateDialog.value = true;
          connectionStore.tableDataGenerateSource = null;
        }
      },
    );

    // Cleanup on close: sync flush so the injected snapshot cannot leak into the next open.
    watch(
      showTableDataGenerateDialog,
      (open) => {
        if (!open) {
          tableDataGenerateSessionId.value = null;
          tableDataGenerateInitialState.value = undefined;
        }
      },
      { flush: "sync" },
    );

    watch(
      showMongoImportDialog,
      (open) => {
        if (!open) mongoImportInitialState.value = undefined;
      },
      { flush: "sync" },
    );

    watch(
      showMongoDatabaseDumpDialog,
      (open) => {
        if (!open) mongoDumpInitialState.value = undefined;
      },
      { flush: "sync" },
    );

    watch(
      showDiagramDialog,
      (open) => {
        if (!open) diagramInitialState.value = undefined;
      },
      { flush: "sync" },
    );

    // Cleanup on close: sync flush so the injected snapshot cannot leak into the next open.
    watch(
      showFieldLineageDialog,
      (open) => {
        if (!open) lineageInitialState.value = undefined;
      },
      { flush: "sync" },
    );

    watch(
      showDataDictionaryDialog,
      (open) => {
        if (!open) dataDictionaryInitialState.value = undefined;
      },
      { flush: "sync" },
    );

    watch(
      showDocsDialog,
      (open) => {
        if (!open) docsInitialState.value = undefined;
      },
      { flush: "sync" },
    );

    watch(
      showDatabaseExportDialog,
      (open) => {
        if (!open) databaseExportInitialState.value = undefined;
      },
      { flush: "sync" },
    );

    watch(
      () => connectionStore.fieldLineageSource,
      (v) => {
        if (v) {
          lineagePrefillConnectionId.value = v.connectionId;
          lineagePrefillDatabaseType.value = v.databaseType;
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
    configConnectionSelectLayout.value = null;
    configPassphraseError.value = "";
  }

  function clearPendingExportState() {
    pendingExportConnectionIds.value = [];
    configConnectionSelectList.value = [];
    configConnectionSelectLayout.value = null;
    configPassphraseError.value = "";
  }

  function openConnectionSelect(mode: "export" | "import", connections: ConnectionConfig[], layout?: SidebarLayout | null) {
    configConnectionSelectMode.value = mode;
    configConnectionSelectList.value = connections;
    configConnectionSelectLayout.value = layout ?? null;
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
    if (source === "datagrip" && (connectionStore.lastDataGripFallbackUsernamesCount ?? 0) > 0) {
      toast(t("configExport.importDatagripUsernamesFallbackWarning"), 5000);
    }
    if (hasSidebarLayoutEntries(layout)) {
      pendingImportLayout.value = layout;
      showImportLayoutConfirm.value = true;
    }
    clearPendingImportState();
  }

  // Config export/import helpers
  function onExportClick() {
    clearPendingExportState();
    openConnectionSelect("export", connectionStore.connections, connectionStore.sidebarLayout);
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
        openConnectionSelect("import", preview.connections, preview.layout);
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
      openConnectionSelect("import", preview.connections, preview.layout);
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
    transferTaskId,
    transferInitialState,
    transferDialogBusy,
    showSchemaDiffDialog,
    showDataCompareDialog,
    showSqlFileDialog,
    showDiagramDialog,
    showDocsDialog,
    showDataDictionaryDialog,
    showTableImportDialog,
    showMongoImportDialog,
    showMongoDatabaseDumpDialog,
    mongoDatabaseDumpPrefillConnectionId,
    mongoDumpInitialState,
    mongoDatabaseDumpPrefillDatabase,
    mongoDatabaseDumpMode,
    showDamengDumpDialog,
    damengDumpPrefillConnectionId,
    damengDumpPrefillDatabase,
    damengDumpMode,
    showTableDataGenerateDialog,
    tableDataGenerateSessionId,
    tableDataGenerateInitialState,
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
    configConnectionSelectLayout,
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
    schemaDiffPrefillSelectedRoutines,
    schemaDiffPrefillResultTab,
    schemaDiffSessionId,
    schemaDiffInitialState,
    schemaDiffDialogBusy,
    dataComparePrefillConnectionId,
    dataComparePrefillDatabase,
    dataComparePrefillSchema,
    dataComparePrefillTable,
    dataCompareSessionId,
    dataCompareInitialState,
    dataCompareDialogTransactionActive,
    sqlFilePrefillConnectionId,
    sqlFilePrefillDatabase,
    sqlFilePrefillSchema,
    sqlFilePrefillFilePath,
    sqlFilePrefillPreview,
    diagramPrefillConnectionId,
    diagramPrefillDatabase,
    diagramPrefillSchema,
    diagramFocusTableName,
    diagramFocusTableNames,
    diagramInitialState,
    docsPrefillConnectionId,
    docsPrefillDatabase,
    docsPrefillSchema,
    dataDictionaryPrefillConnectionId,
    dataDictionaryPrefillDatabase,
    dataDictionaryPrefillSchema,
    dataDictionaryPrefillTableNames,
    dataDictionaryInitialState,
    docsInitialState,
    tableImportPrefillConnectionId,
    tableImportPrefillDatabase,
    tableImportPrefillSchema,
    tableImportPrefillTable,
    mongoImportPrefillConnectionId,
    mongoImportInitialState,
    mongoImportPrefillDatabase,
    mongoImportPrefillCollection,
    tableDataGeneratePrefillConnectionId,
    tableDataGeneratePrefillDatabase,
    tableDataGeneratePrefillSchema,
    tableDataGeneratePrefillTable,
    lineagePrefillConnectionId,
    lineagePrefillDatabaseType,
    lineagePrefillDatabase,
    lineagePrefillSchema,
    lineagePrefillTable,
    lineagePrefillColumn,
    lineageInitialState,
    databaseSearchPrefillConnectionId,
    databaseSearchPrefillDatabase,
    databaseSearchPrefillSchema,
    databaseExportPrefillConnectionId,
    databaseExportPrefillDatabase,
    databaseExportPrefillSchema,
    databaseExportPrefillTable,
    databaseExportPrefillTables,
    databaseExportAllDatabases,
    databaseExportInitialState,
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

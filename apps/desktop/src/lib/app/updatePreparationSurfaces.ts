import type { UpdatePreparationBlockCode } from "./updatePreparation";

/**
 * Every dialog that owns configuration state must be closed before the
 * installer can terminate the process. Naming the dialog in the message is the
 * whole point: "请先完成当前配置编辑" told nobody which window to close, so users
 * with a dialog open in a detached window had no way to find the blocker.
 */
export type UpdateConfigTranslator = (key: string, named?: Record<string, unknown>) => string;

export interface UpdateBlockingConfigState {
  pendingAppClose: boolean;
  connectionDialog: boolean;
  saveSqlDialog: boolean;
  ddlDialog: boolean;
  objectSourceDialog: boolean;
  sqlParameterDialog: boolean;
  dangerDialog: boolean;
  multiDbExecuteDialog: boolean;
  transferDialog: boolean;
  sqlFileDialog: boolean;
  tableImportDialog: boolean;
  mongoImportDialog: boolean;
  dataGenerateDialog: boolean;
  databaseExportDialog: boolean;
  schemaDiffDialog: boolean;
  dataCompareDialog: boolean;
  configPassphraseDialog: boolean;
  configPassphraseExportMode: boolean;
  configConnectionSelectDialog: boolean;
  configConnectionSelectExportMode: boolean;
  configUnencryptedExportConfirm: boolean;
  importLayoutConfirm: boolean;
  configExportBusy: boolean;
  importApplying: boolean;
}

export interface UpdateConfigBlock {
  readonly code: Extract<UpdatePreparationBlockCode, "config" | "config_busy">;
  readonly message: string;
}

export interface UpdateBlockingConfigSurface {
  /** Stable id; also used by tests to prove every surface is covered. */
  readonly id: keyof UpdateBlockingConfigState | "configPassphraseExport" | "configPassphraseImport" | "configConnectionSelectExport" | "configConnectionSelectImport";
  readonly open: (state: UpdateBlockingConfigState) => boolean;
  readonly label: (state: UpdateBlockingConfigState, translate: UpdateConfigTranslator) => string;
}

/** Ordered: the first open surface is the one reported to the user. */
export const UPDATE_BLOCKING_CONFIG_SURFACES: readonly UpdateBlockingConfigSurface[] = [
  { id: "pendingAppClose", open: (state) => state.pendingAppClose, label: (_state, translate) => translate("settings.closeActionPromptTitle") },
  { id: "connectionDialog", open: (state) => state.connectionDialog, label: (_state, translate) => translate("updates.surfaceConnection") },
  { id: "saveSqlDialog", open: (state) => state.saveSqlDialog, label: (_state, translate) => translate("savedSql.saveToLibrary") },
  { id: "ddlDialog", open: (state) => state.ddlDialog, label: (_state, translate) => translate("updates.surfaceDdl") },
  { id: "objectSourceDialog", open: (state) => state.objectSourceDialog, label: (_state, translate) => translate("updates.surfaceObjectSource") },
  { id: "sqlParameterDialog", open: (state) => state.sqlParameterDialog, label: (_state, translate) => translate("sqlParameters.title") },
  { id: "dangerDialog", open: (state) => state.dangerDialog, label: (_state, translate) => translate("dangerDialog.title") },
  { id: "multiDbExecuteDialog", open: (state) => state.multiDbExecuteDialog, label: (_state, translate) => translate("multiDbExecute.title") },
  { id: "transferDialog", open: (state) => state.transferDialog, label: (_state, translate) => translate("transfer.title") },
  { id: "sqlFileDialog", open: (state) => state.sqlFileDialog, label: (_state, translate) => translate("sqlFile.title") },
  { id: "tableImportDialog", open: (state) => state.tableImportDialog, label: (_state, translate) => translate("tableImport.title") },
  { id: "mongoImportDialog", open: (state) => state.mongoImportDialog, label: (_state, translate) => translate("mongo.import.title") },
  { id: "dataGenerateDialog", open: (state) => state.dataGenerateDialog, label: (_state, translate) => translate("dataGenerate.title") },
  { id: "databaseExportDialog", open: (state) => state.databaseExportDialog, label: (_state, translate) => translate("databaseExport.title") },
  { id: "schemaDiffDialog", open: (state) => state.schemaDiffDialog, label: (_state, translate) => translate("diff.title") },
  { id: "dataCompareDialog", open: (state) => state.dataCompareDialog, label: (_state, translate) => translate("dataCompare.title") },
  {
    id: "configPassphraseExport",
    open: (state) => state.configPassphraseDialog && state.configPassphraseExportMode,
    label: (_state, translate) => translate("configExport.passphraseTitle"),
  },
  {
    id: "configPassphraseImport",
    open: (state) => state.configPassphraseDialog && !state.configPassphraseExportMode,
    label: (_state, translate) => translate("configExport.passphraseImportTitle"),
  },
  {
    id: "configConnectionSelectExport",
    open: (state) => state.configConnectionSelectDialog && state.configConnectionSelectExportMode,
    label: (_state, translate) => translate("configExport.selectExportTitle"),
  },
  {
    id: "configConnectionSelectImport",
    open: (state) => state.configConnectionSelectDialog && !state.configConnectionSelectExportMode,
    label: (_state, translate) => translate("configExport.selectImportTitle"),
  },
  { id: "configUnencryptedExportConfirm", open: (state) => state.configUnencryptedExportConfirm, label: (_state, translate) => translate("updates.surfaceConfigUnencryptedExport") },
  { id: "importLayoutConfirm", open: (state) => state.importLayoutConfirm, label: (_state, translate) => translate("configExport.importLayoutTitle") },
];

/** Busy config I/O has no dialog to close, so it needs its own instruction. */
export function describeConfigUpdateBlock(state: UpdateBlockingConfigState, translate: UpdateConfigTranslator): UpdateConfigBlock | null {
  if (state.configExportBusy || state.importApplying) return { code: "config_busy", message: translate("updates.preparationConfigBusy") };
  const surface = UPDATE_BLOCKING_CONFIG_SURFACES.find((item) => item.open(state));
  if (!surface) return null;
  return { code: "config", message: translate("updates.preparationConfigDetail", { surface: surface.label(state, translate) }) };
}

import { createApp } from "vue";
import SqlInsertModeDialog from "@/components/export/SqlInsertModeDialog.vue";
import i18n from "@/i18n";
import type { ManualExportMode } from "@/lib/export/manualExportQueue";

export type SqlInsertMode = "batch" | "single";
export type SqlInsertDialect = "source" | "standard";

export interface SqlExportColumnSelection {
  sourceIndex: number;
  name: string;
  nameOccurrence: number;
}

export interface SqlExportOptions {
  insertMode: SqlInsertMode;
  splitMaxMb?: number;
  selectedColumns?: SqlExportColumnSelection[];
  executionMode?: ManualExportMode;
}

export const DEFAULT_SQL_INSERT_MODE: SqlInsertMode = "batch";
export const DEFAULT_SQL_INSERT_DIALECT: SqlInsertDialect = "source";

export function showSqlInsertModeDialog(options: { allowSplit?: boolean; columns?: SqlExportColumnSelection[]; showExecutionMode?: boolean } = {}): Promise<SqlExportOptions | null> {
  if (typeof document === "undefined") {
    return Promise.resolve({
      insertMode: DEFAULT_SQL_INSERT_MODE,
      ...(options.columns ? { selectedColumns: [...options.columns] } : {}),
    });
  }

  return new Promise((resolve) => {
    const container = document.createElement("div");
    document.body.append(container);
    let settled = false;
    let app: ReturnType<typeof createApp> | null = null;
    const finish = (value: SqlExportOptions | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
      app?.unmount();
      container.remove();
    };
    app = createApp(SqlInsertModeDialog, {
      open: true,
      allowSplit: options.allowSplit === true,
      columns: options.columns,
      showExecutionMode: options.showExecutionMode,
      onConfirm: (options: SqlExportOptions) => finish(options),
      onCancel: () => finish(null),
    });
    app.use(i18n);
    app.mount(container);
  });
}

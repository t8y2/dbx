import type { TableInfoTab } from "@/types/database";

export interface TableStructureRefreshScope {
  columns: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  triggers: boolean;
  tableComment: boolean;
}

export function visibleTableStructureRefreshScope(activeTab: TableInfoTab): TableStructureRefreshScope {
  switch (activeTab) {
    case "columns":
      return { columns: true, indexes: false, foreignKeys: false, triggers: false, tableComment: true };
    case "indexes":
      return { columns: true, indexes: true, foreignKeys: false, triggers: false, tableComment: true };
    case "foreignKeys":
      return { columns: true, indexes: false, foreignKeys: true, triggers: false, tableComment: true };
    case "triggers":
      return { columns: false, indexes: false, foreignKeys: false, triggers: true, tableComment: true };
    case "ddl":
      return { columns: false, indexes: false, foreignKeys: false, triggers: false, tableComment: false };
  }
}

export const TRIGGERS_ONLY_REFRESH_SCOPE: TableStructureRefreshScope = {
  columns: false,
  indexes: false,
  foreignKeys: false,
  triggers: true,
  tableComment: false,
};

export function shouldLoadTableStructureTriggers(options: { activeTab: TableInfoTab; isCreateMode: boolean; supported: boolean; loaded: boolean; loading: boolean; structureLoading: boolean }): boolean {
  return options.activeTab === "triggers" && !options.isCreateMode && options.supported && !options.loaded && !options.loading && !options.structureLoading;
}

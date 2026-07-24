import type { TableInfoTab } from "@/types/database";

export interface TableStructureRefreshScope {
  columns: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  triggers: boolean;
  tableComment: boolean;
}

export function visibleTableStructureRefreshScope(activeTab: TableInfoTab): TableStructureRefreshScope {
  return {
    columns: true,
    indexes: true,
    foreignKeys: true,
    // Trigger definitions can contain large source bodies, so defer them until
    // the trigger editor is actually visible.
    triggers: activeTab === "triggers",
    tableComment: true,
  };
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

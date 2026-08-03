import type { TableInfoTab } from "@/types/database";
import type { ObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";

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

export function unloadedTableStructureRefreshScope(activeTab: TableInfoTab, loadedFacets: ReadonlySet<ObjectMetadataFacet>): TableStructureRefreshScope {
  const visibleScope = visibleTableStructureRefreshScope(activeTab);
  return {
    columns: visibleScope.columns && !loadedFacets.has("columns"),
    indexes: visibleScope.indexes && !loadedFacets.has("indexes"),
    foreignKeys: visibleScope.foreignKeys && !loadedFacets.has("foreign-keys"),
    triggers: visibleScope.triggers && !loadedFacets.has("triggers"),
    tableComment: visibleScope.tableComment && !loadedFacets.has("comment"),
  };
}

export function hasTableStructureRefreshWork(scope: TableStructureRefreshScope): boolean {
  return scope.columns || scope.indexes || scope.foreignKeys || scope.triggers || scope.tableComment;
}

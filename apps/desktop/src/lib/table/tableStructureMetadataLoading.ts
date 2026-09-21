import type { TableInfoTab } from "@/types/database";
import type { ObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";

export interface TableStructureRefreshScope {
  columns: boolean;
  indexes: boolean;
  foreignKeys: boolean;
  constraints: boolean;
  triggers: boolean;
  partitions: boolean;
  tableComment: boolean;
}

export function visibleTableStructureRefreshScope(activeTab: TableInfoTab): TableStructureRefreshScope {
  switch (activeTab) {
    case "columns":
      return { columns: true, indexes: false, foreignKeys: false, constraints: false, triggers: false, partitions: false, tableComment: true };
    case "indexes":
      return { columns: true, indexes: true, foreignKeys: false, constraints: false, triggers: false, partitions: false, tableComment: true };
    case "foreignKeys":
      return { columns: true, indexes: false, foreignKeys: true, constraints: false, triggers: false, partitions: false, tableComment: true };
    case "constraints":
      return { columns: false, indexes: false, foreignKeys: false, constraints: true, triggers: false, partitions: false, tableComment: true };
    case "triggers":
      return { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: true, partitions: false, tableComment: true };
    case "partitions":
      return { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: false, partitions: true, tableComment: false };
    case "ddl":
      return { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: false, partitions: false, tableComment: true };
    default:
      // "info" is a data-grid drawer tab and has no structure-editor scope.
      return { columns: false, indexes: false, foreignKeys: false, constraints: false, triggers: false, partitions: false, tableComment: false };
  }
}

export function unloadedTableStructureRefreshScope(activeTab: TableInfoTab, loadedFacets: ReadonlySet<ObjectMetadataFacet>): TableStructureRefreshScope {
  const visibleScope = visibleTableStructureRefreshScope(activeTab);
  return {
    columns: visibleScope.columns && !loadedFacets.has("columns"),
    indexes: visibleScope.indexes && !loadedFacets.has("indexes"),
    foreignKeys: visibleScope.foreignKeys && !loadedFacets.has("foreign-keys"),
    constraints: visibleScope.constraints && !loadedFacets.has("constraints"),
    triggers: visibleScope.triggers && !loadedFacets.has("triggers"),
    // Partition metadata has no persisted cache facet; "partitions" is only
    // tracked in the loaded-facet set so re-activating the tab does not
    // re-fetch in a loop.
    partitions: visibleScope.partitions && !loadedFacets.has("partitions"),
    tableComment: visibleScope.tableComment && !loadedFacets.has("comment"),
  };
}

export function hasTableStructureRefreshWork(scope: TableStructureRefreshScope): boolean {
  return scope.columns || scope.indexes || scope.foreignKeys || scope.constraints || scope.triggers || scope.partitions || scope.tableComment;
}

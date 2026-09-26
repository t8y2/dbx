import type { ConnectionConfig, QueryTab, TreeNode } from "@/types/database";
import { normalizeSidebarObjectKind } from "@/lib/database/databaseObjectCapabilities";
import { tableFavoriteMenuItems } from "./menu";

export function tableTabFavoriteMenuItems(tab: QueryTab, config: ConnectionConfig | undefined, t: Parameters<typeof tableFavoriteMenuItems>[2]) {
  const meta = tab.tableMeta;
  // A displayed title may be user-defined; only explicit object metadata is safe.
  if (tab.mode !== "data" || !meta?.tableName || !meta.tableType?.trim() || normalizeSidebarObjectKind(meta.tableType) !== "TABLE") return [];
  const node: TreeNode = {
    id: tab.id,
    type: "table",
    label: meta.tableName,
    tableName: meta.tableName,
    connectionId: tab.connectionId,
    database: meta.database ?? tab.database,
    schema: meta.schema ?? tab.schema,
    catalog: meta.catalog ?? tab.catalog,
  };
  return tableFavoriteMenuItems(node, config, t);
}

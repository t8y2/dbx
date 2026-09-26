import { useConnectionStore } from "@/stores/connectionStore";
import { useQueryStore } from "@/stores/queryStore";
import { useSidebarDataOpenRuntime } from "@/composables/useSidebarDataOpenRuntime";
import { favoriteTargetFromNode, favoriteTargetKey } from "@/lib/favorites/target";
import type { TableFavorite } from "@/types/favorites";
import type { TreeNode } from "@/types/database";

export function useFavoriteOpen() {
  const connections = useConnectionStore();
  const queries = useQueryStore();
  const { openData } = useSidebarDataOpenRuntime();
  async function open(item: TableFavorite) {
    const config = connections.getConfig(item.connectionId);
    if (!config) throw new Error("CONNECTION_NOT_FOUND: connection no longer exists");
    const node: TreeNode = { id: `favorite:${item.id}`, label: item.objectName, objectName: item.objectName, tableName: item.objectName, type: "table", connectionId: item.connectionId, database: item.database, schema: item.schema || undefined, catalog: item.catalog || undefined };
    if (!favoriteTargetFromNode(node, config)) throw new Error("FAVORITE_UNSUPPORTED_TARGET: unsupported target");
    await connections.ensureConnected(item.connectionId);
    connections.activeConnectionId = item.connectionId;
    await openData(node);
    // Existing openData reports SQL failures in the data tab instead of throwing.
    // Read its result without changing the old method or interpreting arbitrary text as a missing table.
    const tab = queries.tabs.find((candidate) => candidate.id === queries.activeTabId);
    if (tab?.mode !== "data") return;
    const target = favoriteTargetFromNode({ id: tab.id, type: "table", label: tab.tableMeta?.tableName || tab.title, connectionId: tab.connectionId, database: tab.database, catalog: tab.tableMeta?.catalog || tab.catalog, schema: tab.schema || tab.tableMeta?.schema }, config);
    if (target && favoriteTargetKey(target) === favoriteTargetKey(item) && tab.result?.execution_error) {
      throw tab.result.error || new Error(String(tab.result.rows[0]?.[0] || "Unable to open table"));
    }
  }
  return { open };
}

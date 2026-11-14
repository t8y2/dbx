import { ref } from "vue";
import { useConnectionStore } from "@/stores/connectionStore";
import { getColumns } from "@/lib/backend/api";
import { loadObjectMetadataFacet } from "@/lib/metadata/objectMetadataCache";
import type { ColumnInfo, TreeNode } from "@/types/database";

/**
 * Read-only column preview for a table node.
 *
 * The sidebar only offers the structure editor, which is a write surface, so
 * users who just want to inspect columns either edit or give up. This keeps the
 * metadata load (through the shared object cache) next to the panel state so
 * several sidebar hosts can render the same preview without duplicating the
 * request construction.
 */
export function useTableStructurePeek() {
  const connectionStore = useConnectionStore();
  const target = ref<TreeNode | null>(null);
  const columns = ref<ColumnInfo[]>([]);
  const loading = ref(false);
  const error = ref("");
  let requestId = 0;

  async function open(node: TreeNode) {
    const connectionId = node.connectionId;
    if (!connectionId) return;
    const database = node.database ?? "";
    const schema = node.schema ?? "";
    const tableName = node.objectName || node.label;
    const catalog = node.catalog;
    const currentRequest = ++requestId;

    target.value = node;
    columns.value = [];
    error.value = "";
    loading.value = true;

    try {
      const { value } = await loadObjectMetadataFacet(
        {
          connectionId,
          queryTimeoutSecs: connectionStore.getConfig(connectionId)?.query_timeout_secs,
          database,
          schema,
          tableName,
          catalog,
          // Tables carry no ObjectSourceKind; the cache keys them as TABLE.
        },
        "columns",
        () => getColumns(connectionId, database, schema, tableName, catalog),
      );
      if (currentRequest !== requestId) return;
      columns.value = value;
    } catch (e: any) {
      if (currentRequest !== requestId) return;
      error.value = e?.message || String(e);
    } finally {
      if (currentRequest === requestId) loading.value = false;
    }
  }

  function close() {
    // Invalidate in-flight loads so a late response cannot revive a closed panel.
    requestId += 1;
    target.value = null;
    columns.value = [];
    error.value = "";
    loading.value = false;
  }

  return { target, columns, loading, error, open, close };
}

import { ref, shallowRef, onScopeDispose } from "vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { connectionObjectTreeQuerySchema, effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { modelShapeFromTable, type DatabaseModelShape } from "@/lib/model/modelShape";
import type { TreeNode } from "@/types/database";

export function useModelGenerationRuntime() {
  const store = useConnectionStore();
  const shape = shallowRef<DatabaseModelShape>();
  const loading = ref(false);
  const error = ref<unknown>();
  let request = 0;
  function cancel() {
    request++;
    loading.value = false;
  }
  onScopeDispose(cancel);
  async function load(target: TreeNode) {
    const current = ++request;
    loading.value = true;
    error.value = undefined;
    shape.value = undefined;
    try {
      if (!target.connectionId || target.database == null) throw new Error("Missing table connection");
      await store.ensureConnected(target.connectionId);
      if (current !== request) return;
      const config = store.getConfig(target.connectionId);
      const schema = connectionObjectTreeQuerySchema(config, target.database, target.schema);
      const columns = await api.getColumns(target.connectionId, target.database, schema, target.tableName || target.label, target.catalog);
      if (current === request) shape.value = modelShapeFromTable(target, columns, effectiveDatabaseTypeForConnection(config));
    } catch (reason) {
      if (current === request) error.value = reason;
    } finally {
      if (current === request) loading.value = false;
    }
  }
  return { shape, loading, error, load, cancel };
}

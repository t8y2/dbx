import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";
import * as api from "@/lib/backend/api";
import { useConnectionStore } from "@/stores/connectionStore";
import { uuid } from "@/lib/common/utils";
import { objectDependencyRows, objectDependencySql, type ObjectDependencyRow, type ObjectDependencyTarget } from "@/lib/database/objectDependencyDetails";

export function useObjectDependencies(target: Readonly<Ref<ObjectDependencyTarget | undefined>>, enabled: Readonly<Ref<boolean>>) {
  const connectionStore = useConnectionStore();
  const rows = ref<ObjectDependencyRow[]>([]);
  const loading = ref(false);
  const error = ref("");
  const loaded = ref(false);
  const truncated = ref(false);
  const key = computed(() => (target.value ? JSON.stringify(target.value) : ""));
  let generation = 0;
  let executionId: string | undefined;

  function invalidate() {
    ++generation;
    if (executionId) void api.cancelQuery(executionId).catch(() => false);
    executionId = undefined;
  }

  async function refresh() {
    const identity = target.value;
    if (!identity) return;
    invalidate();
    const serial = generation;
    const requestKey = key.value;
    const id = `object-dependencies-${uuid()}`;
    executionId = id;
    loading.value = true;
    error.value = "";
    try {
      await connectionStore.ensureConnected(identity.connectionId);
      if (serial !== generation || requestKey !== key.value) return;
      const result = await api.executeQuery(identity.connectionId, identity.database, objectDependencySql(identity), identity.schema, id, { catalog: identity.catalog });
      if (serial !== generation || requestKey !== key.value) return;
      rows.value = objectDependencyRows(result);
      truncated.value = !!(result.truncated || result.has_more);
      loaded.value = true;
    } catch (e: unknown) {
      if (serial === generation && requestKey === key.value) error.value = e instanceof Error ? e.message : String(e);
    } finally {
      if (serial === generation) {
        loading.value = false;
        executionId = undefined;
      }
    }
  }

  watch(
    key,
    () => {
      invalidate();
      rows.value = [];
      error.value = "";
      loaded.value = false;
      truncated.value = false;
      loading.value = false;
      if (enabled.value && target.value) void refresh();
    },
    { flush: "sync" },
  );
  watch(
    enabled,
    (value) => {
      if (value && !loaded.value && !loading.value && target.value) void refresh();
    },
    { immediate: true },
  );
  onBeforeUnmount(invalidate);
  return { rows, loading, error, loaded, truncated, refresh };
}

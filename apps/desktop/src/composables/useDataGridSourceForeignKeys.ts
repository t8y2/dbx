import { computed, ref, type ComputedRef, type Ref } from "vue";
import * as api from "@/lib/backend/api";
import { buildColumnForeignKeyMap, foreignKeySourceIdentities, type ForeignKeyAssociation, type ForeignKeySourceIdentity } from "@/lib/dataGrid/dataGridForeignKeyNavigation";
import type { QueryResultSourceColumnRef, QueryTab } from "@/types/database";

/**
 * Per-source foreign-key maps for multi-source (e.g. JOIN) query results.
 *
 * Single-table grids resolve FKs through `useDataGridTableMetadataLoaders`
 * against the one `tableMeta`; JOIN results carry no single table identity, so
 * this composable fetches `listForeignKeys` per physical source table derived
 * from `queryDisplaySourceColumns` (populated even for non-editable JOINs).
 * Association lookup stays strict per ordinal (see
 * `foreignKeyAssociationForRef`) — a column that cannot be resolved back to a
 * source shows no FK affordance instead of a wrong one.
 */
export function useDataGridSourceForeignKeys(options: {
  props: {
    connectionId?: string;
    database?: string;
    queryDisplaySourceColumns?: Array<QueryResultSourceColumnRef | undefined>;
    joinedWriteTargets?: QueryTab["queryWriteTargets"];
  };
}): {
  sourceForeignKeyMaps: ComputedRef<ReadonlyMap<string, ReadonlyMap<string, ForeignKeyAssociation>>>;
  sourceForeignKeysLoading: Ref<boolean>;
  ensureSourceForeignKeys: () => Promise<void>;
} {
  const requestGeneration = ref(0);
  const loading = ref(false);
  // identity -> (lowercase source column -> association); replaced immutably per load
  const entries = ref<ReadonlyMap<string, ReadonlyMap<string, ForeignKeyAssociation>>>(new Map());

  const currentIdentities = () => foreignKeySourceIdentities({ connectionId: options.props.connectionId, refs: options.props.queryDisplaySourceColumns ?? [] });

  // Source refs carry no catalog; recover it from the write targets when the
  // JOIN is editable, else the backend scopes to the default catalog.
  function sourceCatalog(identity: ForeignKeySourceIdentity): string | undefined {
    return options.props.joinedWriteTargets?.find((target) => (target.tableMeta.database ?? "") === (identity.database ?? "") && (target.tableMeta.schema ?? "") === (identity.schema ?? "") && target.tableMeta.tableName === identity.tableName)?.tableMeta.catalog;
  }

  async function ensureSourceForeignKeys() {
    const connectionId = options.props.connectionId;
    if (!connectionId) return;
    const identities = currentIdentities();
    if (identities.length === 0) return;
    const generation = ++requestGeneration.value;
    loading.value = true;
    try {
      await Promise.all(
        identities.map(async (identity) => {
          if (entries.value.has(identity.identity)) return;
          const foreignKeys = await api.listForeignKeys(connectionId, identity.database ?? options.props.database ?? "", identity.schema ?? "", identity.tableName, sourceCatalog(identity));
          // Discard when a newer ensure superseded this round, or the refs no
          // longer mention this source (result replaced mid-flight).
          if (generation !== requestGeneration.value) return;
          if (!currentIdentities().some((current) => current.identity === identity.identity)) return;
          const next = new Map(entries.value);
          next.set(identity.identity, buildColumnForeignKeyMap(foreignKeys));
          entries.value = next;
        }),
      );
    } catch {
      // FK metadata is best-effort: a failing source simply stays without icons.
    } finally {
      if (generation === requestGeneration.value) loading.value = false;
    }
  }

  return {
    sourceForeignKeyMaps: computed(() => entries.value),
    sourceForeignKeysLoading: loading,
    ensureSourceForeignKeys,
  };
}

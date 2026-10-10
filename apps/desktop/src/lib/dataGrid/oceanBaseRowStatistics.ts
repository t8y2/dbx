import * as api from "@/lib/backend/api";
import type { ObjectStatistics } from "@/types/database";
import { formatObjectBrowserCount } from "@/lib/table/objectBrowserRows";

type Snapshot = { statistics: ObjectStatistics[]; status?: ObjectStatistics["rows_status"] };
const cache = new Map<string, { expires: number; request: Promise<Snapshot> }>();

/** A schema snapshot is shared by list pages and table panels. Explicit refresh
 * replaces the promise, so an older response cannot overwrite the new snapshot. */
export function loadOceanBaseRowStatistics(connectionId: string, database: string, schema: string, force = false): Promise<Snapshot> {
  const key = JSON.stringify([connectionId, database, schema]);
  const current = cache.get(key);
  if (!force && current && current.expires > Date.now()) return current.request;
  const request = api.listObjectStatistics(connectionId, database, schema).then(
    (statistics) => ({ statistics }),
    (error): Snapshot => {
      const message = String(error);
      const status = /ORA-01031|insufficient privileges|permission denied/i.test(message) ? "permission_denied" : /ORA-00904|not supported|unsupported/i.test(message) ? "unsupported" : /ORA-00942/i.test(message) ? "unknown" : "error";
      return { statistics: [], status };
    },
  );
  // Keep snapshots bounded across long-lived desktop sessions.
  if (cache.size >= 32 && !cache.has(key)) cache.delete(cache.keys().next().value!);
  cache.set(key, { expires: Date.now() + 30_000, request });
  return request;
}

export function oceanBaseTableStatistics(snapshot: Snapshot, name: string, schema: string): ObjectStatistics {
  // Dictionary names are already resolved identifiers. Quoted names differing
  // only by case must never borrow another table's estimate.
  return (
    snapshot.statistics.find((stat) => stat.name === name && (!schema || stat.schema === schema)) ?? {
      name,
      schema,
      estimated_rows: null,
      rows_status: snapshot.status ?? "unknown",
      space: { status: "unknown", source: "", replica_scope: "leader", data_bytes: null, allocated_bytes: null, components_status: "unknown", components: [] },
    }
  );
}

export function estimatedRowsText(stats: ObjectStatistics | null | undefined, t: (key: string) => string): string {
  if (stats?.rows_status && stats.rows_status !== "available") return t(`objects.rowsStatus_${stats.rows_status}`);
  return formatObjectBrowserCount(stats?.estimated_rows);
}

export function estimatedRowsDetails(stats: ObjectStatistics | null | undefined, t: (key: string) => string) {
  if (!stats?.rows_status) return [];
  return [
    { label: t("objects.rowsSource"), value: stats.rows_source ?? "" },
    { label: t("objects.rowsLastAnalyzed"), value: stats.rows_last_analyzed ?? "" },
    { label: t("objects.rowsFreshness"), value: stats.rows_stale == null ? t("objects.rowsStatus_unknown") : t(stats.rows_stale ? "objects.rowsStale" : "objects.rowsNotStale") },
  ];
}

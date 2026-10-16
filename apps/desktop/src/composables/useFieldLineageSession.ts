import { reactive } from "vue";
import { uuid } from "@/lib/common/utils";
import * as api from "@/lib/backend/api";
import { analyzeFieldLineage, filterFieldLineageHistory, type FieldLineageResult, type FieldLineageTable, type FieldLineageView } from "@/lib/diagram/fieldLineage";
import type { DatabaseType } from "@/types/database";

/** One field-lineage analysis target: the unit of work a session owns. */
export interface FieldLineageSessionConfig {
  connectionId: string;
  database: string;
  schema?: string;
  table: string;
  column: string;
  /** Xugu narrows the scan scope and requires connection-matched history. */
  databaseType?: DatabaseType;
}

export type FieldLineageSessionStatus = "running" | "completed" | "failed" | "cancelled";

export interface FieldLineageSessionCoverage {
  skippedTables: number;
  skippedViews: number;
  omittedTables: number;
  omittedViews: number;
}

export interface FieldLineageSession {
  id: string;
  version: number;
  status: FieldLineageSessionStatus;
  config: FieldLineageSessionConfig;
  progress: { done: number; total: number } | null;
  result: FieldLineageResult | null;
  coverage: FieldLineageSessionCoverage | null;
  error: string | null;
}

export interface FieldLineageSessionDependencies {
  ensureConnected(connectionId: string): Promise<unknown>;
}

const sessions = reactive(new Map<string, FieldLineageSession>());
/** Run control lives outside the reactive session so cancelling never serializes into state. */
const controls = new Map<string, { runId: number; cancelled: boolean }>();

export const FIELD_LINEAGE_MAX_TABLES = 180;
export const FIELD_LINEAGE_MAX_VIEW_DDLS = 60;
const FIELD_LINEAGE_BATCH_SIZE = 6;

function sameConfig(a: FieldLineageSessionConfig, b: FieldLineageSessionConfig): boolean {
  return a.connectionId === b.connectionId && a.database === b.database && (a.schema || "") === (b.schema || "") && a.table === b.table && a.column === b.column;
}

/** Finds the session already owning a config so reopening a field re-attaches instead of re-running. */
export function findFieldLineageSession(config: FieldLineageSessionConfig): FieldLineageSession | undefined {
  for (const session of sessions.values()) {
    if (sameConfig(session.config, config) && session.status !== "cancelled") return session;
  }
  return undefined;
}

export function getFieldLineageSession(id: string | null | undefined): FieldLineageSession | undefined {
  return id ? sessions.get(id) : undefined;
}

export function cancelFieldLineageSession(id: string): void {
  const session = sessions.get(id);
  const control = controls.get(id);
  if (!session || !control) return;
  control.cancelled = true;
  control.runId++;
  if (session.status === "running") {
    session.status = "cancelled";
    session.progress = null;
    session.version++;
  }
}

/** Starts (or restarts) the analysis for a config and returns its session immediately. */
export function startFieldLineageSession(config: FieldLineageSessionConfig, dependencies: FieldLineageSessionDependencies): FieldLineageSession {
  const existing = findFieldLineageSession(config);
  const session: FieldLineageSession =
    existing ??
    ({
      id: uuid(),
      version: 1,
      status: "running",
      config: { ...config },
      progress: null,
      result: null,
      coverage: null,
      error: null,
    } satisfies FieldLineageSession);
  if (existing) {
    session.status = "running";
    session.progress = null;
    session.result = null;
    session.coverage = null;
    session.error = null;
    session.config = { ...config };
    session.version++;
  } else {
    sessions.set(session.id, session);
  }
  const control = { runId: 1, cancelled: false };
  controls.set(session.id, control);
  void runFieldLineageSession(session, control, dependencies);
  return session;
}

async function runFieldLineageSession(session: FieldLineageSession, control: { runId: number; cancelled: boolean }, dependencies: FieldLineageSessionDependencies): Promise<void> {
  const isStale = (runId: number) => control.cancelled || runId !== control.runId || controls.get(session.id) !== control;
  const config = session.config;
  const schema = config.schema || config.database;
  const isXugu = config.databaseType === "xugu";
  const coverage: FieldLineageSessionCoverage = { skippedTables: 0, skippedViews: 0, omittedTables: 0, omittedViews: 0 };
  try {
    await dependencies.ensureConnected(config.connectionId);
    if (isStale(control.runId)) return;

    const listedTables = prioritizeTargetTable(await api.listTables(config.connectionId, config.database, schema), config.table);
    const tableInfos = listedTables.slice(0, FIELD_LINEAGE_MAX_TABLES);
    const listedViews = tableInfos.filter((table) => table.table_type.toUpperCase().includes("VIEW"));
    const viewInfos = listedViews.slice(0, FIELD_LINEAGE_MAX_VIEW_DDLS);
    // Xugu's list_tables result contains both tables and views. A view is
    // scanned below from its definition; sending it through table metadata
    // can execute the view as a SELECT and incorrectly report the same broken
    // view as both a skipped table and a skipped view.
    const tableMetadataInfos = isXugu ? tableInfos.filter((table) => !table.table_type.toUpperCase().includes("VIEW")) : tableInfos;
    if (isXugu) {
      coverage.omittedTables = Math.max(0, listedTables.length - tableInfos.length);
      coverage.omittedViews = Math.max(0, listedViews.length - viewInfos.length);
    }
    session.progress = { done: 0, total: tableMetadataInfos.length + viewInfos.length + 1 };
    session.version++;

    const tables: FieldLineageTable[] = [];
    let skippedTables = 0;
    for (let i = 0; i < tableMetadataInfos.length; i += FIELD_LINEAGE_BATCH_SIZE) {
      if (isStale(control.runId)) return;
      const batch = tableMetadataInfos.slice(i, i + FIELD_LINEAGE_BATCH_SIZE);
      const loaded = await Promise.all(
        batch.map(async (table) => {
          try {
            const columns = await api.getColumns(config.connectionId, config.database, schema, table.name);
            const foreignKeys = await api.listForeignKeys(config.connectionId, config.database, schema, table.name);
            return {
              schema,
              name: table.name,
              columns: columns.map((column) => column.name),
              foreignKeys,
            };
          } catch {
            skippedTables++;
            return { schema, name: table.name, columns: [], foreignKeys: [] };
          }
        }),
      );
      tables.push(...loaded);
      session.progress = { done: (session.progress?.done ?? 0) + batch.length, total: session.progress?.total ?? 0 };
      session.version++;
    }

    const views: FieldLineageView[] = [];
    let skippedViews = 0;
    for (const view of viewInfos) {
      if (isStale(control.runId)) return;
      try {
        const ddl = await api.getTableDdl(config.connectionId, config.database, schema, view.name, isXugu ? "VIEW" : undefined);
        views.push({ schema, name: view.name, ddl });
      } catch {
        skippedViews++;
        // Some drivers may not expose view DDL consistently; keep the rest of the lineage usable.
      } finally {
        session.progress = { done: (session.progress?.done ?? 0) + 1, total: session.progress?.total ?? 0 };
        session.version++;
      }
    }

    const historyEntries = await api.loadHistory(200, 0);
    if (isStale(control.runId)) return;
    const scopedHistory = filterFieldLineageHistory(historyEntries, {
      database: config.database,
      connectionId: config.connectionId,
      requireConnectionMatch: isXugu,
    });
    const histories = scopedHistory.map((entry) => ({ id: entry.id, sql: entry.sql, executed_at: entry.executed_at }));
    if (isXugu) {
      coverage.skippedTables = skippedTables;
      coverage.skippedViews = skippedViews;
    }
    session.progress = { done: (session.progress?.done ?? 0) + 1, total: session.progress?.total ?? 0 };

    session.result = analyzeFieldLineage({
      target: {
        schema,
        table: config.table,
        column: config.column,
      },
      tables,
      views,
      histories,
    });
    session.coverage = isXugu ? { ...coverage } : null;
    session.status = "completed";
    session.progress = null;
    session.version++;
  } catch (error: any) {
    if (isStale(control.runId)) return;
    session.error = error?.message || String(error);
    session.status = "failed";
    session.progress = null;
    session.version++;
  }
}

function prioritizeTargetTable<T extends { name: string }>(tables: T[], targetTable: string): T[] {
  return [...tables].sort((a, b) => Number(a.name !== targetTable) - Number(b.name !== targetTable));
}

import * as api from "@/lib/backend/api";
import { BackendErrorException } from "@/lib/backend/errorUtils";
import type { MysqlRenameDatabaseStatements } from "@/lib/table/objectRenameSql";

/**
 * MySQL/MariaDB database rename.
 *
 * Neither server has `RENAME DATABASE` (MySQL removed it in 5.1.23), and DBeaver refuses the
 * operation outright. The only data-preserving in-place route is: create the target database,
 * move every base table with a single `RENAME TABLE` (atomic, metadata-only, foreign keys —
 * including ones from other databases — follow the table), then drop the emptied source.
 * `RENAME TABLE` cannot move views (ER 1450) or tables that have triggers (ER 1435), and routines
 * and events are not tables, so the rename is only offered when the database holds nothing but
 * tables. Privileges granted on the old database, its tables or columns are not carried over by
 * the server either; they are reported as `grantees` so the caller can warn before renaming.
 */

/** Table types `RENAME TABLE` moves across databases. `SYSTEM VERSIONED` is MariaDB. */
const MOVABLE_TABLE_TYPES = new Set(["BASE TABLE", "SYSTEM VERSIONED"]);
/** Session-scoped (MariaDB lists the current session's temporary tables); never part of the database. */
const IGNORED_TABLE_TYPES = new Set(["TEMPORARY"]);
/** Inventory rows beyond this are refused rather than risking a partial table move. */
const INVENTORY_ROW_LIMIT = 100_000;

export interface MysqlDatabaseRenameBlocker {
  /** Object kind as the server reports it: VIEW, SEQUENCE, TRIGGER, PROCEDURE, FUNCTION, EVENT, ... */
  kind: string;
  count: number;
}

export interface MysqlDatabaseInventory {
  exists: boolean;
  charset?: string;
  collation?: string;
  tables: string[];
  blockers: MysqlDatabaseRenameBlocker[];
  /** Accounts holding database/table/column grants on the source (visible to the current user). */
  grantees: string[];
}

export interface MysqlDatabaseRenameTarget {
  connectionId: string;
  oldName: string;
  newName: string;
}

export interface MysqlDatabaseRenamePlan {
  target: MysqlDatabaseRenameTarget;
  inventory: MysqlDatabaseInventory;
  statements: MysqlRenameDatabaseStatements;
  previewSql: string;
}

/** The source database contains objects `RENAME TABLE` cannot move. */
export class MysqlDatabaseRenameBlockedError extends Error {
  constructor(
    readonly database: string,
    readonly blockers: MysqlDatabaseRenameBlocker[],
  ) {
    super(`Database ${database} contains ${formatMysqlDatabaseRenameBlockers(blockers)}`);
    this.name = "MysqlDatabaseRenameBlockedError";
  }
}

/** Tables were moved, but the source database was not dropped because it is no longer empty. */
export class MysqlDatabaseRenameIncompleteError extends Error {
  constructor(
    readonly oldName: string,
    readonly newName: string,
    readonly remaining: MysqlDatabaseRenameBlocker[],
  ) {
    super(`Database ${oldName} still contains ${formatMysqlDatabaseRenameBlockers(remaining)}`);
    this.name = "MysqlDatabaseRenameIncompleteError";
  }
}

export class MysqlDatabaseNotFoundError extends Error {
  constructor(readonly database: string) {
    super(`Database ${database} does not exist`);
    this.name = "MysqlDatabaseNotFoundError";
  }
}

export function formatMysqlDatabaseRenameBlockers(blockers: readonly MysqlDatabaseRenameBlocker[]): string {
  return blockers.map((blocker) => `${blocker.kind} (${blocker.count})`).join(", ");
}

/** Parses the rows of the MySQL rename preflight (`object_kind`, `object_name`, `object_detail`). */
export function parseMysqlDatabaseInventory(rows: readonly (readonly unknown[])[]): MysqlDatabaseInventory {
  const inventory: MysqlDatabaseInventory = { exists: false, tables: [], blockers: [], grantees: [] };
  const grantees = new Set<string>();
  const blockerCounts = new Map<string, number>();
  const addBlocker = (kind: string) => blockerCounts.set(kind, (blockerCounts.get(kind) ?? 0) + 1);
  for (const row of rows) {
    const kind = String(row[0] ?? "").toUpperCase();
    const name = row[1] == null ? "" : String(row[1]);
    const detail = row[2] == null ? "" : String(row[2]).toUpperCase();
    if (kind === "SCHEMA") {
      inventory.exists = true;
      inventory.charset = name || undefined;
      inventory.collation = row[2] == null ? undefined : String(row[2]) || undefined;
    } else if (kind === "TABLE") {
      if (MOVABLE_TABLE_TYPES.has(detail)) inventory.tables.push(name);
      else if (!IGNORED_TABLE_TYPES.has(detail)) addBlocker(detail || "TABLE");
    } else if (kind === "GRANT") {
      if (name) grantees.add(name);
    } else if (kind === "ROUTINE") {
      addBlocker(detail || "ROUTINE");
    } else if (kind) {
      addBlocker(kind);
    }
  }
  inventory.blockers = [...blockerCounts].map(([kind, count]) => ({ kind, count }));
  inventory.grantees = [...grantees].sort();
  return inventory;
}

async function runStatement(connectionId: string, sql: string, maxRows?: number) {
  const result = await api.executeQuery(connectionId, "", sql, undefined, undefined, maxRows ? { maxRows } : undefined);
  if (result.execution_error) throw new BackendErrorException(result.error || "Statement failed.");
  return result;
}

export async function loadMysqlDatabaseInventory(connectionId: string, database: string): Promise<MysqlDatabaseInventory> {
  const sql = await api.buildRenameDatabasePreflightSql({ databaseType: "mysql", databaseName: database });
  const result = await runStatement(connectionId, sql, INVENTORY_ROW_LIMIT + 1);
  if (result.truncated || result.has_more || result.rows.length > INVENTORY_ROW_LIMIT) {
    throw new Error(`Object list of database ${database} is incomplete; the rename was not started.`);
  }
  return parseMysqlDatabaseInventory(result.rows);
}

/** Inventories the source database and builds the statements; throws when it cannot be renamed. */
export async function prepareMysqlDatabaseRename(target: MysqlDatabaseRenameTarget, inventory?: MysqlDatabaseInventory): Promise<MysqlDatabaseRenamePlan> {
  const resolved = inventory ?? (await loadMysqlDatabaseInventory(target.connectionId, target.oldName));
  if (!resolved.exists) throw new MysqlDatabaseNotFoundError(target.oldName);
  if (resolved.blockers.length > 0) throw new MysqlDatabaseRenameBlockedError(target.oldName, resolved.blockers);
  const statements = await api.buildMysqlRenameDatabaseSql({
    oldName: target.oldName,
    newName: target.newName,
    tableNames: resolved.tables,
    charset: resolved.charset,
    collation: resolved.collation,
  });
  const previewSql = [statements.createDatabase, statements.moveTables, statements.dropOldDatabase].filter(Boolean).join("\n");
  return { target, inventory: resolved, statements, previewSql };
}

/**
 * Runs a prepared plan. The source is dropped only after it is re-inventoried as empty, so
 * anything created in it after the plan was prepared survives (and is reported).
 */
export async function executeMysqlDatabaseRename(plan: MysqlDatabaseRenamePlan): Promise<void> {
  const { connectionId, oldName, newName } = plan.target;
  const run = (sql: string) => runStatement(connectionId, sql);
  await run(plan.statements.createDatabase);
  if (plan.statements.moveTables) {
    try {
      await run(plan.statements.moveTables);
    } catch (error) {
      // RENAME TABLE is atomic, so nothing moved; remove the database created above if it is still empty.
      try {
        const created = await loadMysqlDatabaseInventory(connectionId, newName);
        if (created.exists && created.tables.length === 0 && created.blockers.length === 0) await run(plan.statements.dropNewDatabase);
      } catch {
        // Surface the original failure; an empty leftover database is harmless.
      }
      throw error;
    }
  }
  const remaining = await loadMysqlDatabaseInventory(connectionId, oldName);
  if (remaining.tables.length > 0 || remaining.blockers.length > 0) {
    const leftovers = remaining.tables.length > 0 ? [{ kind: "TABLE", count: remaining.tables.length }, ...remaining.blockers] : remaining.blockers;
    throw new MysqlDatabaseRenameIncompleteError(oldName, newName, leftovers);
  }
  if (remaining.exists) await run(plan.statements.dropOldDatabase);
}

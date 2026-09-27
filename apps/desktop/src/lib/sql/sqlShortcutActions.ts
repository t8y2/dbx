import { canonicalShortcutKey } from "@/lib/editor/shortcutDisplay";
import { formatShortcut, SHORTCUT_DEFINITIONS, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";
import { buildSelectStarWithLimitSql, DEFAULT_SQL_SHORTCUT_SELECT_LIMIT } from "@/lib/sql/sqlDialectSelectLimit";
import type { DatabaseType, SqlShortcutAction, SqlShortcutKind } from "@/types/database";
import { DATABASE_TYPES } from "@/types/generated/databaseTypes";

export const SQL_SHORTCUT_TABLE_TOKEN = "${table}";

export const BUILTIN_SQL_SHORTCUT_SELECT_LIMIT_ID = "builtin-select-limit";
export const BUILTIN_SQL_SHORTCUT_COUNT_ID = "builtin-count";

const DATABASE_TYPE_SET = new Set<string>(DATABASE_TYPES);

/** Built-in quick actions shipped with empty / missing settings. */
export const DEFAULT_SQL_SHORTCUTS: SqlShortcutAction[] = [
  {
    id: BUILTIN_SQL_SHORTCUT_SELECT_LIMIT_ID,
    label: "Select first N rows",
    shortcut: "Mod+Shift+1",
    kind: "select-limit",
    limit: DEFAULT_SQL_SHORTCUT_SELECT_LIMIT,
    sql: buildSelectStarWithLimitSql(SQL_SHORTCUT_TABLE_TOKEN, DEFAULT_SQL_SHORTCUT_SELECT_LIMIT),
    enabled: true,
  },
  {
    id: BUILTIN_SQL_SHORTCUT_COUNT_ID,
    label: "Count rows",
    shortcut: "Mod+Shift+2",
    sql: `SELECT COUNT(*) AS row_count FROM ${SQL_SHORTCUT_TABLE_TOKEN}`,
    enabled: true,
  },
];

export function isBuiltinSqlShortcut(id: string): boolean {
  return id === BUILTIN_SQL_SHORTCUT_SELECT_LIMIT_ID || id === BUILTIN_SQL_SHORTCUT_COUNT_ID;
}

/** Append any missing built-in ids without overwriting user-edited entries. */
export function mergeDefaultSqlShortcuts(actions: readonly SqlShortcutAction[]): SqlShortcutAction[] {
  const ids = new Set(actions.map((action) => action.id));
  const missing = DEFAULT_SQL_SHORTCUTS.filter((action) => !ids.has(action.id)).map((action) => ({ ...action }));
  return missing.length > 0 ? [...actions, ...missing] : [...actions];
}

export function resolveSqlShortcutTemplate(template: string, selectedTable: string): string {
  return template.replace(/\$\{table\}/g, () => selectedTable.trim());
}

export function normalizeSqlShortcutLimit(value: unknown, fallback = DEFAULT_SQL_SHORTCUT_SELECT_LIMIT): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(Math.floor(n), 100_000);
}

export function normalizeSqlShortcutKind(value: unknown): SqlShortcutKind {
  return value === "select-limit" ? "select-limit" : "template";
}

export function normalizeSqlShortcutDatabaseTypes(value: unknown): DatabaseType[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const valid: DatabaseType[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !DATABASE_TYPE_SET.has(item) || seen.has(item)) continue;
    seen.add(item);
    valid.push(item as DatabaseType);
  }
  return valid.length > 0 ? valid : undefined;
}

export function normalizeSqlShortcutSqlByDatabaseType(value: unknown): Partial<Record<DatabaseType, string>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const result: Partial<Record<DatabaseType, string>> = {};
  for (const [key, sql] of Object.entries(value as Record<string, unknown>)) {
    if (!DATABASE_TYPE_SET.has(key) || typeof sql !== "string") continue;
    result[key as DatabaseType] = sql;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** When overrides exist without an explicit scope, treat override keys as the database scope. */
export function deriveSqlShortcutDatabaseTypes(databaseTypes: DatabaseType[] | undefined, sqlByDatabaseType: Partial<Record<DatabaseType, string>> | undefined): DatabaseType[] | undefined {
  if (databaseTypes && databaseTypes.length > 0) return databaseTypes;
  if (!sqlByDatabaseType) return undefined;
  const derived = Object.keys(sqlByDatabaseType).filter((key): key is DatabaseType => DATABASE_TYPE_SET.has(key));
  return derived.length > 0 ? derived : undefined;
}

export function resolveSqlShortcutBody(action: Pick<SqlShortcutAction, "sql" | "sqlByDatabaseType">, databaseType?: DatabaseType): string {
  if (databaseType && action.sqlByDatabaseType?.[databaseType] != null && action.sqlByDatabaseType[databaseType] !== "") {
    return action.sqlByDatabaseType[databaseType]!;
  }
  return action.sql;
}

export function canonicalSqlShortcutSql(action: Pick<SqlShortcutAction, "kind" | "limit" | "sql">): string {
  if (normalizeSqlShortcutKind(action.kind) !== "select-limit") return action.sql;
  const limit = normalizeSqlShortcutLimit(action.limit);
  return buildSelectStarWithLimitSql(SQL_SHORTCUT_TABLE_TOKEN, limit);
}

export function enabledSqlShortcutActions(actions: readonly SqlShortcutAction[]): SqlShortcutAction[] {
  return actions.filter((action) => action.enabled !== false && action.shortcut.trim().length > 0);
}

export function sqlShortcutAppliesToDatabase(action: Pick<SqlShortcutAction, "databaseTypes">, databaseType?: DatabaseType): boolean {
  const types = action.databaseTypes;
  if (!types || types.length === 0) return true;
  if (!databaseType) return false;
  return types.includes(databaseType);
}

export function sqlShortcutDatabaseScopesOverlap(first?: readonly DatabaseType[], second?: readonly DatabaseType[]): boolean {
  const firstAll = !first || first.length === 0;
  const secondAll = !second || second.length === 0;
  if (firstAll || secondAll) return true;
  const secondSet = new Set(second);
  return first.some((dbType) => secondSet.has(dbType));
}

export function shortcutsUseSameKeys(first: string, second: string, platform = globalThis.navigator?.platform || ""): boolean {
  if (!first || !second) return false;
  if (canonicalShortcutKey(first) === canonicalShortcutKey(second)) return true;
  return formatShortcut(first, platform).toLowerCase() === formatShortcut(second, platform).toLowerCase();
}

export function uniqueSqlShortcutBindings(actions: readonly SqlShortcutAction[], platform = globalThis.navigator?.platform || ""): string[] {
  const bindings: string[] = [];
  for (const action of enabledSqlShortcutActions(actions)) {
    const shortcut = action.shortcut.trim();
    if (bindings.some((existing) => shortcutsUseSameKeys(existing, shortcut, platform))) continue;
    bindings.push(shortcut);
  }
  return bindings;
}

/**
 * Prefer a scoped action over an all-databases action when both match the same key.
 */
export function resolveSqlShortcutForDatabase(actions: readonly SqlShortcutAction[], shortcut: string, databaseType?: DatabaseType, platform = globalThis.navigator?.platform || ""): SqlShortcutAction | undefined {
  const matches = enabledSqlShortcutActions(actions).filter((action) => shortcutsUseSameKeys(action.shortcut, shortcut, platform) && sqlShortcutAppliesToDatabase(action, databaseType));
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (b.databaseTypes?.length ?? 0) - (a.databaseTypes?.length ?? 0));
  return matches[0];
}

export function buildSqlShortcutExecutionSql(action: SqlShortcutAction, selectedTable: string, databaseType?: DatabaseType): string {
  const table = selectedTable.trim();
  if (normalizeSqlShortcutKind(action.kind) === "select-limit") {
    return buildSelectStarWithLimitSql(table, normalizeSqlShortcutLimit(action.limit), databaseType);
  }
  return resolveSqlShortcutTemplate(resolveSqlShortcutBody(action, databaseType), table);
}

export function sqlShortcutDisplaySql(action: SqlShortcutAction, databaseType?: DatabaseType): string {
  if (normalizeSqlShortcutKind(action.kind) === "select-limit") {
    return buildSelectStarWithLimitSql(SQL_SHORTCUT_TABLE_TOKEN, normalizeSqlShortcutLimit(action.limit), databaseType);
  }
  return resolveSqlShortcutBody(action, databaseType);
}

export function findSqlShortcutConflicts(actions: readonly SqlShortcutAction[], fixedShortcuts: ShortcutSettings, platform = globalThis.navigator?.platform || ""): string[] {
  const conflicts = new Set<string>();
  const editorFixedShortcuts = SHORTCUT_DEFINITIONS.filter((item) => item.scope === "editor" || item.scope === "global");

  for (const action of actions) {
    if (action.enabled === false || !action.shortcut.trim()) continue;

    const duplicate = actions.find((other) => other.id !== action.id && other.enabled !== false && other.shortcut.trim() && shortcutsUseSameKeys(other.shortcut, action.shortcut, platform) && sqlShortcutDatabaseScopesOverlap(action.databaseTypes, other.databaseTypes));
    if (duplicate) {
      conflicts.add(action.id);
      conflicts.add(duplicate.id);
    }

    const fixedConflict = editorFixedShortcuts.find((item) => fixedShortcuts[item.id] && shortcutsUseSameKeys(fixedShortcuts[item.id], action.shortcut, platform));
    if (fixedConflict) conflicts.add(action.id);
  }

  return [...conflicts];
}

export function hasSqlShortcutConflicts(actions: readonly SqlShortcutAction[], fixedShortcuts: ShortcutSettings, platform = globalThis.navigator?.platform || ""): boolean {
  return findSqlShortcutConflicts(actions, fixedShortcuts, platform).length > 0;
}

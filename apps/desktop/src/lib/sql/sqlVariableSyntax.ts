// Per-database-type configuration for SQL variable/placeholder substitution.
//
// DBX runs two client-side substitution systems before sending SQL to a backend:
// the placeholder parameter dialog (`sqlParameters.ts`, five syntaxes) and the
// `@set name = value;` expansion (`sqlVariables.ts`). This module lets users opt
// out of individual syntaxes per database type and opt into quoted interpolation.
// An empty/absent config reproduces the historical behaviour.
//
// Storage is sparse: only values different from their defaults are persisted,
// keyed by database type.

import type { DatabaseType } from "@/types/database";
import { supportsAnsiQuotesMode, supportsNoBackslashEscapesMode, type SqlParameterSyntax } from "@/lib/sql/sqlParameters";
import { manifestDatabaseTypes } from "@/lib/database/databaseDriverManifest";

export interface SqlVariableSyntaxToggles {
  positional: boolean; // ?
  named: boolean; // :name
  shell: boolean; // ${name}
  mybatis: boolean; // #{name}
  sqlserver: boolean; // @name
  atSet: boolean; // @set name = value;  (expandSqlVariables)
  replaceInsideQuotes: boolean; // '${name}', "${name}", `${name}`, [${name}]
  ansiQuotes: boolean; // MySQL-family ANSI_QUOTES session mode
  noBackslashEscapes: boolean; // MySQL-family NO_BACKSLASH_ESCAPES session mode
}

export const DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES: SqlVariableSyntaxToggles = {
  positional: true,
  named: true,
  shell: true,
  mybatis: true,
  sqlserver: true,
  atSet: true,
  replaceInsideQuotes: false,
  ansiQuotes: false,
  noBackslashEscapes: false,
};

// Fixed order for iterating the toggles in the settings UI.
export const SQL_VARIABLE_SYNTAX_KEYS = ["positional", "named", "shell", "mybatis", "sqlserver", "atSet", "replaceInsideQuotes", "ansiQuotes", "noBackslashEscapes"] as const satisfies readonly (keyof SqlVariableSyntaxToggles)[];

// Display tokens (code symbols, not translated) shown next to each toggle.
export const SQL_VARIABLE_SYNTAX_TOKENS: Record<keyof SqlVariableSyntaxToggles, string> = {
  positional: "?",
  named: ":name",
  shell: "${name}",
  mybatis: "#{name}",
  sqlserver: "@name",
  atSet: "@set …;",
  replaceInsideQuotes: "'${name}'",
  ansiQuotes: "ANSI_QUOTES",
  noBackslashEscapes: "NO_BACKSLASH_ESCAPES",
};

// The first five toggles map one-to-one onto placeholder parameter syntaxes.
const PARAMETER_SYNTAX_KEYS = ["positional", "named", "shell", "mybatis", "sqlserver"] as const satisfies readonly SqlParameterSyntax[];

export type SqlVariableSyntaxOverrides = Partial<Record<DatabaseType, Partial<SqlVariableSyntaxToggles>>>;

// Database types offered in the settings selector — every connectable type.
export const SQL_VARIABLE_SYNTAX_DATABASE_TYPES: DatabaseType[] = manifestDatabaseTypes();

/**
 * Resolve the effective toggles for a database type. Any syntax not explicitly
 * disabled in `overrides` is enabled. A pure function safe to call on every
 * execution.
 */
export function resolveSqlVariableSyntaxToggles(overrides: SqlVariableSyntaxOverrides | undefined, dbType: DatabaseType | undefined): SqlVariableSyntaxToggles {
  const partial = dbType ? overrides?.[dbType] : undefined;
  return {
    positional: partial?.positional ?? true,
    named: partial?.named ?? true,
    shell: partial?.shell ?? true,
    mybatis: partial?.mybatis ?? true,
    sqlserver: partial?.sqlserver ?? true,
    atSet: partial?.atSet ?? true,
    replaceInsideQuotes: partial?.replaceInsideQuotes ?? false,
    ansiQuotes: supportsAnsiQuotesMode(dbType) ? (partial?.ansiQuotes ?? false) : false,
    // Ignore stale or hand-written mode overrides for dialects without this mode.
    noBackslashEscapes: supportsNoBackslashEscapesMode(dbType) ? (partial?.noBackslashEscapes ?? false) : false,
  };
}

export function sqlVariableSyntaxKeysForDatabase(dbType: DatabaseType | undefined): readonly (keyof SqlVariableSyntaxToggles)[] {
  return SQL_VARIABLE_SYNTAX_KEYS.filter((key) => (key !== "ansiQuotes" || supportsAnsiQuotesMode(dbType)) && (key !== "noBackslashEscapes" || supportsNoBackslashEscapesMode(dbType)));
}

/** Derive the enabled placeholder parameter syntaxes (excludes `atSet`). */
export function enabledSqlParameterSyntaxes(toggles: SqlVariableSyntaxToggles): SqlParameterSyntax[] {
  return PARAMETER_SYNTAX_KEYS.filter((key) => toggles[key]);
}

/**
 * Normalize persisted overrides into a sparse structure: drop non-object entries
 * and only keep boolean values that differ from their defaults.
 */
export function normalizeSqlVariableSyntaxOverrides(value: unknown): SqlVariableSyntaxOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: SqlVariableSyntaxOverrides = {};
  for (const [dbType, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const partial: Partial<SqlVariableSyntaxToggles> = {};
    for (const key of SQL_VARIABLE_SYNTAX_KEYS) {
      if (key === "ansiQuotes" && !supportsAnsiQuotesMode(dbType as DatabaseType)) continue;
      if (key === "noBackslashEscapes" && !supportsNoBackslashEscapesMode(dbType as DatabaseType)) continue;
      const rawValue = (raw as Record<string, unknown>)[key];
      if (typeof rawValue === "boolean" && rawValue !== DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES[key]) partial[key] = rawValue;
    }
    if (Object.keys(partial).length > 0) result[dbType as DatabaseType] = partial;
  }
  return result;
}

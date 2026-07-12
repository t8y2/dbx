// Per-database-type configuration for SQL variable/placeholder substitution.
//
// DBX runs two client-side substitution systems before sending SQL to a backend:
// the placeholder parameter dialog (`sqlParameters.ts`, five syntaxes) and the
// `@set name = value;` expansion (`sqlVariables.ts`). This module lets users opt
// out of individual syntaxes per database type. Every toggle defaults to `true`,
// so an empty/absent config reproduces the historical "always substitute" behaviour.
//
// Storage is sparse: only syntaxes explicitly turned off (`false`) are persisted,
// keyed by database type. Anything not stored resolves to enabled.

import type { DatabaseType } from "@/types/database";
import type { SqlParameterSyntax } from "@/lib/sql/sqlParameters";
import { manifestDatabaseTypes } from "@/lib/database/databaseDriverManifest";

export interface SqlVariableSyntaxToggles {
  positional: boolean; // ?
  named: boolean; // :name
  shell: boolean; // ${name}
  mybatis: boolean; // #{name}
  sqlserver: boolean; // @name
  atSet: boolean; // @set name = value;  (expandSqlVariables)
}

export const DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES: SqlVariableSyntaxToggles = {
  positional: true,
  named: true,
  shell: true,
  mybatis: true,
  sqlserver: true,
  atSet: true,
};

// Fixed order for iterating the toggles in the settings UI.
export const SQL_VARIABLE_SYNTAX_KEYS = ["positional", "named", "shell", "mybatis", "sqlserver", "atSet"] as const satisfies readonly (keyof SqlVariableSyntaxToggles)[];

// Display tokens (code symbols, not translated) shown next to each toggle.
export const SQL_VARIABLE_SYNTAX_TOKENS: Record<keyof SqlVariableSyntaxToggles, string> = {
  positional: "?",
  named: ":name",
  shell: "${name}",
  mybatis: "#{name}",
  sqlserver: "@name",
  atSet: "@set …;",
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
  };
}

/** Derive the enabled placeholder parameter syntaxes (excludes `atSet`). */
export function enabledSqlParameterSyntaxes(toggles: SqlVariableSyntaxToggles): SqlParameterSyntax[] {
  return PARAMETER_SYNTAX_KEYS.filter((key) => toggles[key]);
}

/**
 * Normalize persisted overrides into a sparse structure: drop non-object entries
 * and only keep syntaxes explicitly set to `false`. Absence resolves to enabled.
 */
export function normalizeSqlVariableSyntaxOverrides(value: unknown): SqlVariableSyntaxOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: SqlVariableSyntaxOverrides = {};
  for (const [dbType, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const partial: Partial<SqlVariableSyntaxToggles> = {};
    for (const key of SQL_VARIABLE_SYNTAX_KEYS) {
      if ((raw as Record<string, unknown>)[key] === false) partial[key] = false;
    }
    if (Object.keys(partial).length > 0) result[dbType as DatabaseType] = partial;
  }
  return result;
}

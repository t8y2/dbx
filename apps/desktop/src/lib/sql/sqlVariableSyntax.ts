// Per-database-type configuration for SQL variable/placeholder substitution.
//
// DBX runs two client-side substitution systems before sending SQL to a backend:
// the placeholder parameter dialog (`sqlParameters.ts`, seven syntaxes) and the
// `@set name = value;` expansion (`sqlVariables.ts`). This module lets users opt
// out of individual syntaxes per database type. SQL syntaxes default to `true`,
// except Neo4j's `:label` patterns, which are not named parameters, and Oracle
// substitution variables (`&name`, `&&name`), which default to enabled only for
// Oracle and Oracle-compatible dialects/modes.
//
// Storage is sparse: only syntaxes that deviate from the database-specific defaults
// are persisted, keyed by database type. Unset values use the database-specific defaults.

import type { DatabaseType } from "@/types/database";
import type { SqlParameterSyntax } from "@/lib/sql/sqlParameters";
import { manifestDatabaseTypes } from "@/lib/database/databaseDriverManifest";

export interface SqlVariableSyntaxToggles {
  positional: boolean; // ?
  named: boolean; // :name
  shell: boolean; // ${name}
  bracketedShell: boolean; // [${name}]
  mybatis: boolean; // #{name}
  sqlserver: boolean; // @name
  substitution: boolean; // &name, &&name
  atSet: boolean; // @set name = value;  (expandSqlVariables)
}

export const DEFAULT_SQL_VARIABLE_SYNTAX_TOGGLES: SqlVariableSyntaxToggles = {
  positional: true,
  named: true,
  shell: true,
  bracketedShell: true,
  mybatis: true,
  sqlserver: true,
  substitution: false,
  atSet: true,
};

// Fixed order for iterating the toggles in the settings UI.
export const SQL_VARIABLE_SYNTAX_KEYS = ["positional", "named", "shell", "bracketedShell", "mybatis", "sqlserver", "substitution", "atSet"] as const satisfies readonly (keyof SqlVariableSyntaxToggles)[];

// Display tokens (code symbols, not translated) shown next to each toggle.
export const SQL_VARIABLE_SYNTAX_TOKENS: Record<keyof SqlVariableSyntaxToggles, string> = {
  positional: "?",
  named: ":name",
  shell: "${name}",
  bracketedShell: "[${name}]",
  mybatis: "#{name}",
  sqlserver: "@name",
  substitution: "&name",
  atSet: "@set …;",
};

// The first seven toggles map one-to-one onto placeholder parameter syntaxes.
const PARAMETER_SYNTAX_KEYS = ["positional", "named", "shell", "bracketed-shell", "mybatis", "sqlserver", "substitution"] as const satisfies readonly SqlParameterSyntax[];

export type SqlVariableSyntaxOverrides = Partial<Record<DatabaseType, Partial<SqlVariableSyntaxToggles>>>;

// Database types offered in the settings selector — every connectable type.
export const SQL_VARIABLE_SYNTAX_DATABASE_TYPES: DatabaseType[] = manifestDatabaseTypes();

const ORACLE_SUBSTITUTION_DATABASE_TYPES = new Set<DatabaseType>(["oracle", "oceanbase-oracle", "dameng", "yashandb", "oscar"]);
const MODE_DEPENDENT_SUBSTITUTION_DATABASE_TYPES = new Set<DatabaseType>(["opengauss", "gaussdb", "kingbase"]);

export function isModeDependentSubstitutionDatabase(dbType?: DatabaseType): boolean {
  return !dbType ? false : MODE_DEPENDENT_SUBSTITUTION_DATABASE_TYPES.has(dbType);
}

export function isApplicableCompatibilityMode(dbType?: DatabaseType, compatibilityMode?: string): boolean {
  if (!dbType || !compatibilityMode) return false;
  const mode = compatibilityMode.trim().toLowerCase();
  if (dbType === "opengauss" || dbType === "gaussdb") {
    return mode === "a" || mode === "b" || mode === "c" || mode === "d" || mode === "pg";
  }
  if (dbType === "kingbase") {
    return mode === "oracle" || mode === "pg" || mode === "mysql" || mode === "sqlserver";
  }
  return false;
}

export function isOracleSubstitutionDatabase(dbType?: DatabaseType, compatibilityMode?: string): boolean {
  if (!dbType) return false;
  if (ORACLE_SUBSTITUTION_DATABASE_TYPES.has(dbType)) return true;
  if (dbType === "opengauss" || dbType === "gaussdb") return compatibilityMode?.trim().toUpperCase() === "A";
  if (dbType === "kingbase") return compatibilityMode?.trim().toLowerCase() === "oracle";
  return false;
}

export function defaultSqlVariableSyntaxToggles(dbType?: DatabaseType, compatibilityMode?: string): SqlVariableSyntaxToggles {
  return {
    positional: true,
    named: dbType !== "neo4j" && dbType !== "nebula",
    shell: true,
    bracketedShell: true,
    mybatis: true,
    sqlserver: true,
    substitution: isOracleSubstitutionDatabase(dbType, compatibilityMode),
    atSet: true,
  };
}

/**
 * Resolve the effective toggles for a database type. The global gate disables
 * every syntax without modifying the saved overrides. Otherwise, any syntax not
 * explicitly overridden uses database-specific defaults. A pure function safe to call
 * on every execution.
 */
export function resolveSqlVariableSyntaxToggles(overrides: SqlVariableSyntaxOverrides | undefined, dbType: DatabaseType | undefined, enabled = true, compatibilityMode?: string): SqlVariableSyntaxToggles {
  if (!enabled) {
    return {
      positional: false,
      named: false,
      shell: false,
      bracketedShell: false,
      mybatis: false,
      sqlserver: false,
      substitution: false,
      atSet: false,
    };
  }
  const defaults = defaultSqlVariableSyntaxToggles(dbType, compatibilityMode);
  const partial = dbType ? overrides?.[dbType] : undefined;
  return {
    positional: partial?.positional ?? defaults.positional,
    named: dbType === "neo4j" || dbType === "nebula" ? false : (partial?.named ?? defaults.named),
    shell: partial?.shell ?? defaults.shell,
    bracketedShell: partial?.bracketedShell ?? defaults.bracketedShell,
    mybatis: partial?.mybatis ?? defaults.mybatis,
    sqlserver: partial?.sqlserver ?? defaults.sqlserver,
    substitution: partial?.substitution ?? defaults.substitution,
    atSet: partial?.atSet ?? defaults.atSet,
  };
}

/** Derive the enabled placeholder parameter syntaxes (excludes `atSet`). */
export function enabledSqlParameterSyntaxes(toggles: SqlVariableSyntaxToggles): SqlParameterSyntax[] {
  // The toggle property is camelCase (`bracketedShell`) while the syntax id is
  // kebab-case ("bracketed-shell"), so map explicitly instead of indexing by id.
  return PARAMETER_SYNTAX_KEYS.filter((key) => toggles[key === "bracketed-shell" ? "bracketedShell" : key]);
}

/**
 * Update a single variable syntax toggle in the given overrides map, maintaining
 * sparse representation against database defaults.
 *
 * For mode-dependent databases (openGauss, GaussDB, Kingbase), explicit substitution
 * boolean overrides are always preserved (whether true or false) across mode changes
 * and other toggle updates, since the setting is stored globally per database type.
 */
export function updateSqlVariableSyntaxToggle(overrides: SqlVariableSyntaxOverrides, dbType: DatabaseType, key: keyof SqlVariableSyntaxToggles, value: boolean, compatibilityMode?: string): SqlVariableSyntaxOverrides {
  if ((dbType === "neo4j" || dbType === "nebula") && key === "named") return overrides;
  const defaults = defaultSqlVariableSyntaxToggles(dbType, compatibilityMode);
  const current = resolveSqlVariableSyntaxToggles(overrides, dbType, true, compatibilityMode);
  const merged: SqlVariableSyntaxToggles = {
    ...current,
    [key]: value,
  };
  const next: SqlVariableSyntaxOverrides = {
    ...overrides,
  };
  const isModeDependent = isModeDependentSubstitutionDatabase(dbType);
  const partial: Partial<SqlVariableSyntaxToggles> = {};
  for (const toggleKey of SQL_VARIABLE_SYNTAX_KEYS) {
    if ((dbType === "neo4j" || dbType === "nebula") && toggleKey === "named") continue;
    if (toggleKey === "substitution" && isModeDependent) {
      if (toggleKey === key) {
        partial[toggleKey] = value;
      } else if (overrides[dbType]?.substitution !== undefined) {
        partial[toggleKey] = overrides[dbType]!.substitution;
      }
    } else if (merged[toggleKey] !== defaults[toggleKey]) {
      partial[toggleKey] = merged[toggleKey];
    }
  }
  if (Object.keys(partial).length === 0) {
    delete next[dbType];
  } else {
    next[dbType] = partial;
  }
  return next;
}

/**
 * Normalize persisted overrides into a sparse structure: drop non-object entries
 * and only keep syntaxes that differ from database-specific defaults.
 *
 * For databases whose substitution default depends on compatibility mode
 * (openGauss, GaussDB, Kingbase), an explicit boolean override cannot be assumed
 * redundant across all modes unless an applicable compatibilityMode is supplied.
 */
export function normalizeSqlVariableSyntaxOverrides(value: unknown, compatibilityMode?: string): SqlVariableSyntaxOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: SqlVariableSyntaxOverrides = {};
  for (const [dbType, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const isModeDependent = isModeDependentSubstitutionDatabase(dbType as DatabaseType);
    const applicableMode = isApplicableCompatibilityMode(dbType as DatabaseType, compatibilityMode) ? compatibilityMode : undefined;
    const defaults = defaultSqlVariableSyntaxToggles(dbType as DatabaseType, applicableMode);
    const partial: Partial<SqlVariableSyntaxToggles> = {};
    for (const key of SQL_VARIABLE_SYNTAX_KEYS) {
      if ((dbType === "neo4j" || dbType === "nebula") && key === "named") continue;
      const val = (raw as Record<string, unknown>)[key];
      if (typeof val !== "boolean") continue;

      if (key === "substitution" && isModeDependent) {
        // Mode-dependent databases (openGauss, GaussDB, Kingbase) have different substitution
        // defaults depending on compatibility mode (A/Oracle mode is true, B/PG mode is false).
        // Retain any explicit boolean override (true or false) so that the user's intent is
        // preserved across mode changes, settings save/reopen, and runtime execution.
        partial[key] = val;
      } else if (val !== defaults[key]) {
        partial[key] = val;
      }
    }
    if (Object.keys(partial).length > 0) result[dbType as DatabaseType] = partial;
  }
  return result;
}

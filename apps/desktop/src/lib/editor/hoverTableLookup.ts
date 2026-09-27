import { isSchemaAware, isSingleDatabase } from "@/lib/database/databaseFeatureSupport";
import { matchTable, splitQualifiedIdentifier } from "@/lib/sql/sqlNavigation";
import type { DatabaseType } from "@/types/database";

export const TABLE_HOVER_LOOKUP_MODES = ["current", "fallback", "always"] as const;
export type TableHoverLookupMode = (typeof TABLE_HOVER_LOOKUP_MODES)[number];

export function normalizeTableHoverLookupMode(value: unknown, fallback: TableHoverLookupMode = "fallback"): TableHoverLookupMode {
  return value === "current" || value === "fallback" || value === "always" ? value : fallback;
}

export interface ResolveHoverTableLookupTargetInput {
  database: string;
  /** Currently selected schema from the editor toolbar. */
  schema?: string;
  catalog?: string;
  databaseType?: DatabaseType;
  tableName: string;
  /** Identifier segments from the hovered/clicked token (e.g. `["other", "users"]`). */
  identifierParts: string[];
  semanticDatabase?: string;
  semanticSchema?: string;
  mode: TableHoverLookupMode;
}

export interface HoverTableLookupTarget {
  database: string;
  schema?: string;
  catalog?: string;
  tableName: string;
  /** Schema/database came from SQL qualifier or semantic model — do not global-search. */
  schemaFromQualifier: boolean;
  /** After a scoped miss, retry with globalSearch by exact table name. */
  allowGlobalFallback: boolean;
  /** Unqualified + always mode: search across schemas first. */
  preferGlobalFirst: boolean;
}

/**
 * Resolve the metadata scope for table hover / Ctrl+click navigation.
 *
 * Qualified names (`schema.table`, `db.schema.table`, MySQL-style `db.table`)
 * always use the SQL qualifier. Unqualified names follow `mode`:
 * - `current`: only the selected schema
 * - `fallback`: selected schema first, then name-filtered global search
 * - `always`: name-filtered global search first
 *
 * "Global" here means same-database cross-schema, not cross-database.
 */
export function resolveHoverTableLookupTarget(input: ResolveHoverTableLookupTargetInput): HoverTableLookupTarget {
  const tableName = input.tableName;
  let database = input.semanticDatabase ?? input.database;
  let schema = input.semanticSchema;
  let schemaFromQualifier = !!input.semanticSchema;

  if (!schemaFromQualifier && input.identifierParts.length >= 2) {
    const parts = input.identifierParts;
    if (parts.length >= 3) {
      database = parts[parts.length - 3]!;
      schema = parts[parts.length - 2];
      schemaFromQualifier = true;
    } else {
      if (input.databaseType && !isSchemaAware(input.databaseType) && !isSingleDatabase(input.databaseType)) {
        database = parts[0]!;
        schema = undefined;
      } else {
        schema = parts[0];
      }
      schemaFromQualifier = true;
    }
  }

  if (!schemaFromQualifier) {
    schema = input.schema;
  }

  const unqualified = !schemaFromQualifier;
  const preferGlobalFirst = unqualified && input.mode === "always";
  const allowGlobalFallback = unqualified && (input.mode === "fallback" || input.mode === "always");

  return {
    database,
    schema: preferGlobalFirst ? undefined : schema,
    catalog: input.catalog,
    tableName,
    schemaFromQualifier,
    allowGlobalFallback,
    preferGlobalFirst,
  };
}

/** Prefer the selected schema when the same table name exists in multiple schemas. */
export function pickHoverTableMatch<T extends { name: string; schema?: string }>(tableName: string, tables: readonly T[], preferredSchema?: string): T | null {
  const nameLower = tableName.toLowerCase();
  const nameMatches = tables.filter((table) => table.name.toLowerCase() === nameLower);
  if (nameMatches.length === 0) return null;
  if (preferredSchema) {
    const preferred = nameMatches.find((table) => table.schema?.toLowerCase() === preferredSchema.toLowerCase());
    if (preferred) return preferred;
  }
  return nameMatches[0] ?? null;
}

export interface MatchHoverTableCandidatesOptions {
  /** Qualified forms to try first (e.g. `schema.table` from the token or semantic model). */
  lookups?: string[];
  tableName: string;
  preferredSchema?: string;
}

/**
 * Match hover/navigation table candidates.
 *
 * Qualified lookups use {@link matchTable}. Unqualified names go through
 * {@link pickHoverTableMatch} so the toolbar schema wins over arbitrary order.
 */
export function matchHoverTableCandidates<T extends { name: string; schema?: string; database?: string }>(tables: readonly T[], options: MatchHoverTableCandidatesOptions): T | null {
  const seen = new Set<string>();
  for (const lookup of options.lookups ?? []) {
    const trimmed = lookup.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (splitQualifiedIdentifier(trimmed).length < 2) continue;
    const matched = matchTable(trimmed, tables);
    if (matched) return matched;
  }
  return pickHoverTableMatch(options.tableName, tables, options.preferredSchema);
}

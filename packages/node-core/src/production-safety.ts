import type { ConnectionConfig } from "./connections.js";
import { classifySqlRisk, isSqlRiskMutation, splitSqlStatementsForSafety } from "./sql-risk.js";

export interface ProductionSqlAssessment {
  active: boolean;
  isMutation: boolean;
  databases: string[];
}

const USE_RE = /^\s*USE\s+([`"[]?[^\s;`"\]]+[`"\]]?)/i;
const QUALIFIED_IDENTIFIER_RE = /\b(?:FROM|JOIN|UPDATE|INTO|TABLE|REFERENCES)\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+)\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+))/gi;
const DATABASE_TARGET_RE = /\b(?:CREATE|ALTER|DROP)\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?([`"[]?[^\s;`"\]]+[`"\]]?)/gi;
const COPY_TARGET_RE = /^\s*COPY\s+((?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+)\s*\.\s*(?:`[^`]+`|"[^"]+"|\[[^\]]+\]|[\w$-]+))\s+FROM\b/i;

/** Normalizes quoted database names before production scope comparison. */
export function normalizeProductionDatabase(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .replace(/^[`"[]|[`"\]]$/g, "")
    .toLowerCase();
}

export function isProductionDatabase(config: ConnectionConfig | undefined, database?: string): boolean {
  if (!config) return false;
  if (config.is_production) return true;
  const selected = normalizeProductionDatabase(database);
  return !!selected && (config.production_databases ?? []).some((name) => normalizeProductionDatabase(name) === selected);
}

/**
 * Finds writes that target a marked production database, including a MySQL
 * USE switch or a qualified database.table reference in a statement batch.
 */
export function assessProductionSql(sql: string, config: ConnectionConfig | undefined, activeDatabase?: string): ProductionSqlAssessment {
  const statements = splitSqlStatementsForSafety(sql);
  const isMutation = isSqlRiskMutation(classifySqlRisk(sql).risk);
  if (!isMutation || !config) return { active: isProductionDatabase(config, activeDatabase), isMutation, databases: [] };
  if (config.is_production) return { active: true, isMutation, databases: [] };
  if (isProductionDatabase(config, activeDatabase)) return { active: true, isMutation, databases: activeDatabase ? [activeDatabase] : [] };

  const marked = new Set((config.production_databases ?? []).map(normalizeProductionDatabase).filter(Boolean));
  if (!marked.size) return { active: false, isMutation, databases: [] };

  const targets = new Set<string>();
  let useDatabase = "";
  for (const statement of statements) {
    const useMatch = statement.match(USE_RE);
    if (useMatch?.[1]) {
      useDatabase = normalizeProductionDatabase(useMatch[1]);
      continue;
    }
    if (isSqlRiskMutation(classifySqlRisk(statement).risk) && useDatabase) targets.add(useDatabase);

    QUALIFIED_IDENTIFIER_RE.lastIndex = 0;
    for (const match of statement.matchAll(QUALIFIED_IDENTIFIER_RE)) {
      const database = normalizeProductionDatabase(match[1]?.split(".")[0]);
      if (database) targets.add(database);
    }
    for (const match of statement.matchAll(DATABASE_TARGET_RE)) {
      const database = normalizeProductionDatabase(match[1]);
      if (database) targets.add(database);
    }
    const copyTarget = statement.match(COPY_TARGET_RE);
    if (copyTarget?.[1]) {
      const database = normalizeProductionDatabase(copyTarget[1].split(".")[0]);
      if (database) targets.add(database);
    }
  }

  const databases = [...targets].filter((database) => marked.has(database));
  return { active: databases.length > 0, isMutation, databases };
}

/** MCP receives Mongo shell text rather than SQL, so use a conservative write detector. */
export function isLikelyMongoMutation(command: string): boolean {
  return /\.(?:insert(?:One|Many)?|update(?:One|Many)?|replaceOne|delete(?:One|Many)?|findOneAnd(?:Update|Replace|Delete)|drop(?:Index|Indexes)?|renameCollection|createIndex)\s*\(|\bdb\.createCollection\s*\(/i.test(command);
}

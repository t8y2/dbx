/**
 * Unified read-only view over the per-database function metadata that already
 * backs editor completion — ClickHouse's function registry, the SQL dialect
 * signature tables in sqlCompletion.ts, MongoDB's operator tables and Redis's
 * static command table. The function dictionary panel renders this; nothing
 * here fetches or computes at runtime, so opening the panel is O(data) once.
 *
 * Databases without any of these sources return null and the panel shows its
 * empty state.
 */
import type { DatabaseType } from "@/types/database";
import { driverProfileRoutineSignatures } from "@/lib/database/driverProfileExtensions";
import { effectiveDatabaseTypeForConnection } from "@/lib/database/jdbcDialect";
import { CLICKHOUSE_FUNCTION_REGISTRY } from "@/lib/sql/clickhouse/functionRegistry";
import type { ClickHouseFunctionCategory, ClickHouseFunctionDefinition } from "@/lib/sql/clickhouse/functionTypes";
import { getSqlFunctionSignatureEntries } from "@/lib/sql/sqlCompletion";
import { ACCUMULATORS, EXPRESSION_OPERATORS, PIPELINE_STAGES, PUSH_MODIFIERS, QUERY_OPERATORS, UPDATE_OPERATORS, type MongoOperatorSpec } from "@/lib/mongo/mongoCompletionTables";
import { REDIS_COMMAND_TABLE } from "@/lib/redis/redisCommandTable";

export interface FunctionDictionaryEntry {
  name: string;
  /** Parameter names in call order; omitted when the source has no signature data. */
  parameters?: string[];
  /** Pre-rendered call form, e.g. `toInt32(expression)`. */
  signature?: string;
  /** Group id the entry belongs to (matches one of `groups[].id`). */
  group: string;
  /** One-line description; only some sources carry one. */
  detail?: string;
  aliases?: string[];
  /** Number of overloads beyond the rendered signature (ClickHouse only). */
  overloadCount?: number;
  /** Language-neutral argument-count hint, e.g. "2", "1+" (Redis only). */
  argsHint?: string;
}

export interface FunctionDictionaryGroup {
  id: string;
  /** Short untranslated label (a ClickHouse category or Redis group name). */
  label: string;
  entries: FunctionDictionaryEntry[];
}

export interface FunctionDictionary {
  databaseType: DatabaseType;
  groups: FunctionDictionaryGroup[];
  total: number;
}

/** Display order for ClickHouse categories; unlisted categories sort after these, alphabetically. */
const CLICKHOUSE_CATEGORY_ORDER: readonly ClickHouseFunctionCategory[] = ["aggregate", "array", "bitmap", "comparison", "conversion", "date-time", "dictionary", "encoding", "geo", "hash", "ip", "json", "map", "math", "nullable", "random", "string", "table", "tuple", "url", "window", "other"];

function compareEntriesByName(left: FunctionDictionaryEntry, right: FunctionDictionaryEntry): number {
  return left.name.toLowerCase() < right.name.toLowerCase() ? -1 : left.name.toLowerCase() > right.name.toLowerCase() ? 1 : 0;
}

function buildDictionary(databaseType: DatabaseType, groups: FunctionDictionaryGroup[]): FunctionDictionary {
  const ordered = groups.map((group) => ({ ...group, entries: [...group.entries].sort(compareEntriesByName) })).filter((group) => group.entries.length > 0);
  return { databaseType, groups: ordered, total: ordered.reduce((sum, group) => sum + group.entries.length, 0) };
}

/** ClickHouse parameter groups are consecutive paren groups: `toTypeName(x)`, `lagInFrame(x)(n)`. */
function clickHouseSignature(definition: ClickHouseFunctionDefinition): string | undefined {
  const signature = definition.signatures[definition.preferredSignature ?? 0];
  if (!signature) return undefined;
  const renderedGroups = signature.parameterGroups.map((group) => group.map((parameter) => parameter.replace(/\?$/, "")).join(", "));
  return renderedGroups.length > 0 ? `${definition.name}${renderedGroups.map((group) => `(${group})`).join("")}` : `${definition.name}()`;
}

function clickHouseEntry(definition: ClickHouseFunctionDefinition): FunctionDictionaryEntry {
  return {
    name: definition.name,
    signature: clickHouseSignature(definition),
    group: definition.category,
    detail: definition.description,
    aliases: definition.aliases && definition.aliases.length > 0 ? definition.aliases : undefined,
    overloadCount: definition.signatures.length > 1 ? definition.signatures.length : undefined,
  };
}

function fromClickHouse(): FunctionDictionary {
  const byCategory = new Map<string, FunctionDictionaryEntry[]>();
  for (const definition of CLICKHOUSE_FUNCTION_REGISTRY.all()) {
    const entries = byCategory.get(definition.category) ?? [];
    entries.push(clickHouseEntry(definition));
    byCategory.set(definition.category, entries);
  }
  const known = new Set(CLICKHOUSE_CATEGORY_ORDER);
  const groupIds = [...byCategory.keys()].filter((id) => known.has(id as ClickHouseFunctionCategory)).sort((left, right) => CLICKHOUSE_CATEGORY_ORDER.indexOf(left as ClickHouseFunctionCategory) - CLICKHOUSE_CATEGORY_ORDER.indexOf(right as ClickHouseFunctionCategory));
  return buildDictionary(
    "clickhouse",
    groupIds.map((id) => ({ id, label: id, entries: byCategory.get(id) ?? [] })),
  );
}

function fromSqlSignatures(databaseType: DatabaseType, driverProfile?: string): FunctionDictionary | null {
  const entries = getSqlFunctionSignatureEntries(databaseType);
  if (!entries) return null;
  const groups: FunctionDictionaryGroup[] = [
    {
      id: "functions",
      label: databaseType,
      entries: entries.map(({ name, parameters }) => ({
        name,
        parameters,
        signature: parameters.length > 0 ? `${name}(${parameters.join(", ")})` : `${name}()`,
        group: "functions",
      })),
    },
  ];
  const profileSignatures = driverProfileRoutineSignatures(driverProfile);
  if (driverProfile && profileSignatures.size > 0) {
    groups.push({
      id: "driver-profile",
      label: driverProfile,
      entries: Array.from(profileSignatures.entries()).map(([name, parameters]) => ({
        name,
        parameters,
        signature: parameters.length > 0 ? `${name}(${parameters.join(", ")})` : `${name}()`,
        group: "driver-profile",
      })),
    });
  }
  return buildDictionary(databaseType, groups);
}

const MONGO_TABLES: ReadonlyArray<{ id: string; label: string; entries: readonly MongoOperatorSpec[] }> = [
  { id: "query", label: "Query Operators", entries: QUERY_OPERATORS },
  { id: "update", label: "Update Operators", entries: UPDATE_OPERATORS },
  { id: "push", label: "Push Modifiers", entries: PUSH_MODIFIERS },
  { id: "pipeline", label: "Pipeline Stages", entries: PIPELINE_STAGES },
  { id: "accumulator", label: "Accumulators", entries: ACCUMULATORS },
  { id: "expression", label: "Expression Operators", entries: EXPRESSION_OPERATORS },
];

function fromMongo(): FunctionDictionary {
  return buildDictionary(
    "mongodb",
    MONGO_TABLES.map((table) => ({
      id: table.id,
      label: table.label,
      entries: table.entries.map((operator) => ({ name: operator.label, group: table.id, detail: operator.detail })),
    })),
  );
}

/** Redis arity counts the command name itself: >0 exact token count, <0 minimum. */
function redisArgsHint(arity: number): string {
  if (arity > 0) return String(Math.max(0, arity - 1));
  return `${Math.max(0, -arity - 1)}+`;
}

function fromRedis(): FunctionDictionary {
  const byGroup = new Map<string, FunctionDictionaryEntry[]>();
  for (const [name, spec] of Object.entries(REDIS_COMMAND_TABLE)) {
    const entries = byGroup.get(spec.group) ?? [];
    entries.push({ name, group: spec.group, argsHint: redisArgsHint(spec.arity) });
    byGroup.set(spec.group, entries);
  }
  const groupIds = [...byGroup.keys()].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return buildDictionary(
    "redis",
    groupIds.map((id) => ({ id, label: id, entries: byGroup.get(id) ?? [] })),
  );
}

export function getFunctionDictionary(databaseType: DatabaseType | undefined, driverProfile?: string): FunctionDictionary | null {
  if (!databaseType) return null;
  if (databaseType === "clickhouse") return fromClickHouse();
  if (databaseType === "mongodb") return fromMongo();
  if (databaseType === "redis") return fromRedis();
  return fromSqlSignatures(databaseType, driverProfile);
}

/** Resolves driver-profile variants (doris/starrocks/gbase/informix) before looking up the dictionary. */
export function getFunctionDictionaryForConnection(connection?: { db_type?: DatabaseType; driver_profile?: string }): FunctionDictionary | null {
  return getFunctionDictionary(effectiveDatabaseTypeForConnection(connection), connection?.driver_profile);
}

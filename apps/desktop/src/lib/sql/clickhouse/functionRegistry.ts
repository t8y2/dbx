import type { ClickHouseFunctionDefinition, ClickHouseFunctionKind, ClickHouseFunctionRegistry } from "./functionTypes";
import { generateAggregateCombinatorCandidates } from "./aggregateCombinators";
import { CLICKHOUSE_AGGREGATE_FUNCTIONS } from "./aggregateFunctions";
import { CLICKHOUSE_REGULAR_FUNCTIONS } from "./regularFunctions";
import { CLICKHOUSE_TABLE_FUNCTIONS } from "./tableFunctions";

function definitionKeys(definition: ClickHouseFunctionDefinition): string[] {
  return [definition.name, ...(definition.aliases ?? [])].map((name) => name.toLowerCase());
}

function validateDefinition(definition: ClickHouseFunctionDefinition): void {
  if (!definition.name.trim()) throw new Error("ClickHouse function name must not be empty");
  if (definition.signatures.length === 0) throw new Error(`ClickHouse function ${definition.name} must define a signature`);
  if (definition.signatures.some((signature) => signature.parameterGroups.length === 0)) {
    throw new Error(`ClickHouse function ${definition.name} must define a parameter group`);
  }
  const preferred = definition.preferredSignature ?? 0;
  if (preferred < 0 || preferred >= definition.signatures.length) {
    throw new Error(`ClickHouse function ${definition.name} has an invalid preferred signature`);
  }
}

export function createClickHouseFunctionRegistry(definitions: readonly ClickHouseFunctionDefinition[]): ClickHouseFunctionRegistry {
  const byKey = new Map<string, ClickHouseFunctionDefinition>();
  for (const definition of definitions) {
    validateDefinition(definition);
    for (const key of definitionKeys(definition)) {
      if (byKey.has(key)) throw new Error(`Duplicate ClickHouse function or alias: ${key}`);
      byKey.set(key, definition);
    }
  }
  const ordered = [...definitions].sort((left, right) => left.name.localeCompare(right.name));
  return {
    get: (name) => byKey.get(name.toLowerCase()),
    search: (prefix, limit, kind?: ClickHouseFunctionKind) => {
      const normalized = prefix.toLowerCase();
      return ordered.filter((definition) => (!kind || definition.kind === kind) && definitionKeys(definition).some((key) => key.startsWith(normalized))).slice(0, limit);
    },
    all: () => ordered,
  };
}

export const CLICKHOUSE_FUNCTION_REGISTRY = createClickHouseFunctionRegistry([...CLICKHOUSE_REGULAR_FUNCTIONS, ...CLICKHOUSE_AGGREGATE_FUNCTIONS, ...CLICKHOUSE_TABLE_FUNCTIONS]);

export function searchClickHouseFunctions(prefix: string, limit: number, kind?: ClickHouseFunctionKind): ClickHouseFunctionDefinition[] {
  const direct = CLICKHOUSE_FUNCTION_REGISTRY.search(prefix, limit, kind);
  if (direct.length >= limit || (kind && kind !== "aggregate")) return direct;
  const generated = generateAggregateCombinatorCandidates(prefix, limit - direct.length);
  return [...direct, ...generated].slice(0, limit);
}

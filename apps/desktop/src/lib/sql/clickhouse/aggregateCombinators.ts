import { CLICKHOUSE_AGGREGATE_FUNCTIONS } from "./aggregateFunctions";
import type { ClickHouseFunctionDefinition, ClickHouseFunctionSignature } from "./functionTypes";

type CombinatorName = "Array" | "Map" | "ForEach" | "Distinct" | "OrDefault" | "OrNull" | "If" | "Resample" | "SimpleState" | "State" | "Merge" | "MergeState";

const COLLECTION_COMBINATORS = [undefined, "Array", "Map", "ForEach"] as const;
const DEFAULT_COMBINATORS = [undefined, "OrDefault", "OrNull"] as const;
const TERMINAL_COMBINATORS = [undefined, "SimpleState", "State", "Merge", "MergeState"] as const;

function buildCombinatorSequences(): CombinatorName[][] {
  const sequences: CombinatorName[][] = [];
  for (const collection of COLLECTION_COMBINATORS) {
    for (const distinct of [false, true]) {
      for (const fallback of DEFAULT_COMBINATORS) {
        for (const conditional of [false, true]) {
          for (const terminal of TERMINAL_COMBINATORS) {
            const sequence: CombinatorName[] = [];
            if (collection) sequence.push(collection);
            if (distinct) sequence.push("Distinct");
            if (fallback) sequence.push(fallback);
            if (conditional) sequence.push("If");
            if (terminal) sequence.push(terminal);
            if (sequence.length > 0) sequences.push(sequence);
          }
        }
      }
    }
  }

  for (const conditional of [false, true]) {
    for (const terminal of TERMINAL_COMBINATORS) {
      const sequence: CombinatorName[] = ["Resample"];
      if (conditional) sequence.push("If");
      if (terminal) sequence.push(terminal);
      sequences.push(sequence);
    }
  }
  return sequences;
}

const COMBINATOR_SEQUENCES = buildCombinatorSequences();

function cloneSignature(signature: ClickHouseFunctionSignature): ClickHouseFunctionSignature {
  return { ...signature, parameterGroups: signature.parameterGroups.map((group) => [...group]) };
}

function transformLastGroup(signature: ClickHouseFunctionSignature, transform: (group: string[]) => string[]): ClickHouseFunctionSignature {
  const transformed = cloneSignature(signature);
  const last = transformed.parameterGroups.length - 1;
  transformed.parameterGroups[last] = transform(transformed.parameterGroups[last]);
  return transformed;
}

function applyCombinator(signature: ClickHouseFunctionSignature, combinator: CombinatorName): ClickHouseFunctionSignature {
  switch (combinator) {
    case "Array":
    case "ForEach":
      return transformLastGroup(signature, (group) =>
        group.map((parameter, index) => {
          if (parameter.startsWith("...")) return "...arrays";
          return index === 0 ? "array" : `array_${index + 1}`;
        }),
      );
    case "Map":
      return transformLastGroup(signature, () => ["map"]);
    case "If":
      return transformLastGroup(signature, (group) => [...group, "condition"]);
    case "Resample": {
      const transformed = transformLastGroup(signature, (group) => [...group, "resampling_key"]);
      transformed.parameterGroups.splice(Math.max(0, transformed.parameterGroups.length - 1), 0, ["start", "end", "step"]);
      return transformed;
    }
    case "Merge":
    case "MergeState":
      return transformLastGroup(signature, () => ["state"]);
    case "Distinct":
    case "OrDefault":
    case "OrNull":
    case "SimpleState":
    case "State":
      return cloneSignature(signature);
  }
}

function generateDefinition(base: ClickHouseFunctionDefinition, sequence: readonly CombinatorName[]): ClickHouseFunctionDefinition {
  const signatures = base.signatures.map((signature) => sequence.reduce(applyCombinator, signature));
  return {
    ...base,
    name: `${base.name}${sequence.join("")}`,
    signatures,
    aliases: undefined,
    combinators: false,
    generated: true,
  };
}

export function generateAggregateCombinatorCandidates(prefix: string, limit: number): ClickHouseFunctionDefinition[] {
  if (limit <= 0) return [];
  const normalized = prefix.toLowerCase();
  const results: ClickHouseFunctionDefinition[] = [];

  for (const base of CLICKHOUSE_AGGREGATE_FUNCTIONS) {
    if (base.combinators === false) continue;
    const baseName = base.name.toLowerCase();
    if (normalized && !baseName.startsWith(normalized) && !normalized.startsWith(baseName)) continue;

    for (const sequence of COMBINATOR_SEQUENCES) {
      const candidate = generateDefinition(base, sequence);
      if (!candidate.name.toLowerCase().startsWith(normalized)) continue;
      results.push(candidate);
      if (results.length === limit) return results;
    }
  }
  return results;
}

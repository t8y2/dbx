import type { DatabaseType } from "@/types/database";

export type GraphQueryDatabase = Extract<DatabaseType, "neo4j" | "nebula">;

export interface GraphFunctionDefinition {
  name: string;
  parameters: readonly string[];
  overloads?: readonly (readonly string[])[];
  template?: string;
}

export interface GraphQueryProfile {
  databaseType: GraphQueryDatabase;
  language: string;
  lineComment: string;
  keywords: readonly string[];
  reservedWords: readonly string[];
  functions: readonly GraphFunctionDefinition[];
}

export function functionDefinitions(parameters: Record<string, readonly string[]>): GraphFunctionDefinition[] {
  return Object.entries(parameters).map(([name, parameters]) => ({ name, parameters }));
}

export const graphListPredicates: GraphFunctionDefinition[] = ["all", "any", "none", "single"].map((name) => ({
  name,
  parameters: ["variable IN list WHERE predicate"],
  template: "${variable} IN ${list} WHERE ${predicate}",
}));

export const graphReduce: GraphFunctionDefinition = {
  name: "reduce",
  parameters: ["accumulator = initial", "variable IN list | expression"],
  template: "${accumulator} = ${initial}, ${variable} IN ${list} | ${expression}",
};

export function temporalFunctions(names: string[]): GraphFunctionDefinition[] {
  return names.map((name) => ({ name, parameters: [], overloads: [[], ["value"]] }));
}

export const commonGraphFunctions = functionDefinitions({
  abs: ["number"],
  avg: ["expression"],
  ceil: ["number"],
  coalesce: ["value", "...values"],
  collect: ["expression"],
  count: ["expression"],
  floor: ["number"],
  head: ["list"],
  id: ["entity"],
  keys: ["entity"],
  labels: ["node"],
  last: ["list"],
  left: ["string", "length"],
  max: ["expression"],
  min: ["expression"],
  nodes: ["path"],
  range: ["start", "end", "step?"],
  relationships: ["path"],
  replace: ["string", "search", "replacement"],
  reverse: ["value"],
  right: ["string", "length"],
  round: ["number", "precision?", "mode?"],
  sign: ["number"],
  size: ["value"],
  split: ["string", "delimiter"],
  sqrt: ["number"],
  substring: ["string", "start", "length?"],
  sum: ["expression"],
  tail: ["list"],
  trim: ["string"],
  properties: ["entity"],
  type: ["relationship"],
  toBoolean: ["value"],
  toFloat: ["value"],
  toInteger: ["value"],
  toString: ["value"],
  duration: ["value"],
});

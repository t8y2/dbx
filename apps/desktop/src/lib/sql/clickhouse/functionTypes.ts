export type ClickHouseFunctionKind = "regular" | "aggregate" | "window" | "table";
export type ClickHouseFunctionStatus = "stable" | "experimental" | "deprecated";

export type ClickHouseFunctionCategory = "aggregate" | "array" | "bitmap" | "comparison" | "conversion" | "date-time" | "dictionary" | "encoding" | "geo" | "hash" | "ip" | "json" | "map" | "math" | "nullable" | "random" | "string" | "table" | "tuple" | "url" | "window" | "other";

export interface ClickHouseFunctionSignature {
  parameterGroups: string[][];
  returnType?: string;
}

export interface ClickHouseFunctionDefinition {
  name: string;
  kind: ClickHouseFunctionKind;
  category: ClickHouseFunctionCategory;
  signatures: ClickHouseFunctionSignature[];
  description?: string;
  preferredSignature?: number;
  status?: ClickHouseFunctionStatus;
  aliases?: string[];
  combinators?: boolean;
  generated?: boolean;
}

export interface ClickHouseFunctionRegistry {
  get(name: string): ClickHouseFunctionDefinition | undefined;
  search(prefix: string, limit: number, kind?: ClickHouseFunctionKind): ClickHouseFunctionDefinition[];
  all(): readonly ClickHouseFunctionDefinition[];
}

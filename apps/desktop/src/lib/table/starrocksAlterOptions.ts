import { tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { EditableStructureColumn } from "./tableStructureEditorSql";

export interface StarRocksDistributionChange {
  method: "hash" | "random";
  columns: string[];
  buckets?: number;
  defaultOnly?: boolean;
}
export type StarRocksPartitionChange = { kind: "addRange"; name: string; lower: string[]; upper: string[] } | { kind: "addList"; name: string; values: string[][] } | { kind: "drop"; name: string } | { kind: "replicas"; name: string; replicas: number };
export interface StarRocksLayoutChanges {
  distribution?: StarRocksDistributionChange;
  partitions: StarRocksPartitionChange[];
}
export interface StarRocksLayoutDraft {
  method: "hash" | "random";
  columns: string[];
  bucketCount: string;
  defaultOnly: boolean;
  partitions: StarRocksPartitionChange[];
}
export interface StarRocksAlterOptions {
  serverVersion?: string;
  columnNames?: string[];
  reorderColumns?: boolean;
  positionColumnOrder?: boolean;
  sortColumns?: string[];
  sortColumnNames?: string[];
  model?: "primary" | "duplicate" | "unique" | "aggregate";
  keyColumns: string[];
  partitionColumns: string[];
  /** Source columns of partition expressions; these can back hidden generated columns. */
  partitionExpressionColumns?: string[];
  distributionColumns: string[];
  distribution?: StarRocksDistributionChange;
  partitionKind?: "range" | "list" | "expression";
  partitionClause?: string;
  colocated?: boolean;
  automaticBucketScaling?: boolean;
  layout?: StarRocksLayoutChanges;
}

// Read only the table-level clauses of SHOW CREATE TABLE. Quoted strings and
// comments are discarded, so comments cannot masquerade as schema metadata.
export function starRocksAlterOptionsFromDdl(ddl: string, serverVersion?: string): StarRocksAlterOptions {
  const result: StarRocksAlterOptions = { serverVersion, keyColumns: [], partitionColumns: [], distributionColumns: [] };
  const tokens = [...ddl.matchAll(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|`(?:``|[^`])*`|[a-zA-Z_][\w$]*|\d+|[(),=]/g)].map((match) => match[0]).filter((token) => !/^('|"|--|\/\*)/.test(token));
  let start = tokens.indexOf("(");
  if (start < 0) return result;
  let depth = 0;
  for (; start < tokens.length; start++) {
    if (tokens[start] === "(") depth++;
    if (tokens[start] === ")" && --depth === 0) {
      start++;
      break;
    }
  }
  const schemaTokens = tokenizeSqlSemantic(ddl, "mysql", { squareBracketsAsDelimiters: true, mysqlDoubleQuoteIsString: true, mysqlBackslashEscape: true });
  const closing = schemaTokens.findIndex((token) => token.text === ")" && token.depth === 0);
  result.columnNames = [];
  let angleDepth = 0;
  let nextColumn = false;
  for (const token of schemaTokens.slice(0, closing)) {
    if (token.text === "(" && token.depth === 0) {
      nextColumn = true;
      continue;
    }
    if (token.depth !== 1 || token.kind === "comment") continue;
    if (token.text === "<") angleDepth++;
    if (token.text === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (token.text === "," && angleDepth === 0) {
      nextColumn = true;
      continue;
    }
    if (nextColumn) {
      if (["word", "quoted_identifier"].includes(token.kind) && !["index", "key", "primary", "unique", "constraint", "foreign", "check"].includes(token.normalized)) result.columnNames.push(unquoteSqlSemanticIdentifier(token));
      nextColumn = false;
    }
  }
  const tail = tokens.slice(start);
  const upper = tail.map((token) => token.toUpperCase());
  const engine = upper.indexOf("ENGINE");
  if (engine < 0 || upper[engine + 1] !== "=" || upper[engine + 2] !== "OLAP") return result;
  const key = upper.findIndex((token, i) => ["PRIMARY", "DUPLICATE", "UNIQUE", "AGGREGATE"].includes(token) && upper[i + 1] === "KEY");
  if (key < 0) return result;
  result.model = upper[key]!.toLowerCase() as StarRocksAlterOptions["model"];
  const identifier = (token: string) => (token.startsWith("`") ? token.slice(1, -1).replaceAll("``", "`") : token);
  const names = (values: string[]) => values.filter((token) => token.startsWith("`") || /^[a-zA-Z_]/.test(token)).map(identifier);
  const endKey = tail.indexOf(")", key + 2);
  if (tail[key + 2] !== "(" || endKey < 0) {
    result.model = undefined;
    return result;
  }
  result.keyColumns = names(tail.slice(key + 3, endKey));
  const sort = upper.findIndex((token, index) => token === "ORDER" && upper[index + 1] === "BY");
  const sortClose = sort >= 0 ? tail.indexOf(")", sort + 2) : -1;
  result.sortColumns = sort >= 0 && tail[sort + 2] === "(" && sortClose >= 0 ? names(tail.slice(sort + 3, sortClose)) : [...result.keyColumns];
  const partition = upper.indexOf("PARTITION", endKey);
  const distribution = upper.indexOf("DISTRIBUTED", endKey);
  const end = (from: number) => {
    const boundaries = ["DISTRIBUTED", "ORDER", "PROPERTIES"].map((word) => upper.indexOf(word, from + 1)).filter((i) => i >= 0);
    return boundaries.length ? Math.min(...boundaries) : tail.length;
  };
  if (partition >= 0) result.partitionColumns = names(tail.slice(partition + 2, end(partition)));
  if (distribution >= 0) result.distributionColumns = names(tail.slice(distribution + 2, end(distribution)));
  if (distribution >= 0) {
    const method = upper[distribution + 2]?.toLowerCase();
    if (method === "hash" || method === "random") {
      const close = tail.indexOf(")", distribution + 3);
      const columns = method === "hash" && tail[distribution + 3] === "(" && close >= 0 ? names(tail.slice(distribution + 4, close)) : [];
      result.distributionColumns = columns;
      const bucket = upper.indexOf("BUCKETS", distribution);
      const count = bucket >= 0 ? Number(tail[bucket + 1]) : undefined;
      result.distribution = { method, columns, buckets: count && Number.isSafeInteger(count) ? count : undefined };
    }
  }
  if (partition >= 0) {
    result.partitionKind = upper[partition + 2] === "RANGE" ? "range" : upper[partition + 2] === "LIST" ? "list" : "expression";
    const semantic = tokenizeSqlSemantic(ddl, "mysql", { squareBracketsAsDelimiters: true, mysqlDoubleQuoteIsString: true, mysqlBackslashEscape: true });
    const begin = semantic.findIndex((token) => token.kind === "word" && token.depth === 0 && token.normalized === "partition");
    const stop = semantic.find((token, index) => index > begin && token.kind === "word" && token.depth === 0 && ["distributed", "order", "properties"].includes(token.normalized));
    result.partitionClause = begin >= 0 ? ddl.slice(semantic[begin]!.span.start, stop?.span.start).trim() : undefined;
    const bodyEnd = semantic.findIndex((token) => token.text === ")" && token.depth === 0);
    const columnNames = new Set(
      semantic
        .slice(0, bodyEnd)
        .filter((token, index) => token.depth === 1 && ["word", "quoted_identifier"].includes(token.kind) && ((semantic[index - 1]?.text === "(" && semantic[index - 1]?.depth === 0) || (semantic[index - 1]?.text === "," && semantic[index - 1]?.depth === 1)))
        .map((token) => unquoteSqlSemanticIdentifier(token).toLowerCase()),
    );
    const clauseTokens = semantic.filter((token) => begin >= 0 && token.span.start >= semantic[begin]!.span.start && (!stop || token.span.start < stop.span.start));
    // A plain partition key can move, but MODIFY on a function's source column
    // may be rejected because StarRocks uses a hidden generated partition column.
    const expressionColumns = new Set<string>();
    for (let index = 2; index < clauseTokens.length; index++) {
      const token = clauseTokens[index]!;
      const open = clauseTokens[index + 1];
      if (token.kind !== "word" || open?.text !== "(" || ["range", "list", "values"].includes(token.normalized)) continue;
      for (let argument = index + 2; argument < clauseTokens.length; argument++) {
        const reference = clauseTokens[argument]!;
        if (reference.text === ")" && reference.depth === open.depth) break;
        if (!["word", "quoted_identifier"].includes(reference.kind) || clauseTokens[argument + 1]?.text === "(") continue;
        const name = unquoteSqlSemanticIdentifier(reference);
        if (columnNames.has(name.toLowerCase())) expressionColumns.add(name);
      }
    }
    result.partitionExpressionColumns = [...expressionColumns];
    result.partitionColumns = [...new Set(clauseTokens.filter((token) => ["word", "quoted_identifier"].includes(token.kind) && columnNames.has(unquoteSqlSemanticIdentifier(token).toLowerCase())).map((token) => unquoteSqlSemanticIdentifier(token)))];
    if (clauseTokens.some((token) => token.kind === "word" && ["date_trunc", "time_slice", "str2date", "from_unixtime"].includes(token.normalized))) result.partitionKind = "expression";
    if (result.partitionKind !== "expression") {
      const close = tail.indexOf(")", partition + 3);
      result.partitionColumns = names(tail.slice(partition + 4, close));
    }
  }
  const semantic = tokenizeSqlSemantic(ddl, "mysql", { squareBracketsAsDelimiters: true, mysqlDoubleQuoteIsString: true, mysqlBackslashEscape: true });
  const property = semantic.findIndex((token) => ["string", "quoted_identifier"].includes(token.kind) && token.depth === 1 && token.text.slice(1, -1).toLowerCase() === "colocate_with");
  result.colocated = property >= 0 && semantic[property + 1]?.text === "=" && (semantic[property + 2]?.text.length ?? 0) > 2;
  const properties = semantic.findIndex((token) => token.kind === "word" && token.depth === 0 && token.normalized === "properties");
  const bucketSize = semantic.findIndex((token, index) => index > properties && properties >= 0 && ["string", "quoted_identifier"].includes(token.kind) && token.depth === 1 && token.text.slice(1, -1).toLowerCase() === "bucket_size");
  const bucketValue = semantic[bucketSize + 2];
  result.automaticBucketScaling = bucketSize >= 0 && semantic[bucketSize + 1]?.text === "=" && Number(bucketValue?.kind === "number" ? bucketValue.text : bucketValue?.text.slice(1, -1)) > 0;
  return result;
}

export function starRocksLayoutDraft(context: StarRocksAlterOptions): StarRocksLayoutDraft | undefined {
  if (!context.distribution) return undefined;
  return { method: context.distribution.method, columns: [...context.distribution.columns], bucketCount: context.distribution.buckets?.toString() ?? "", defaultOnly: false, partitions: [] };
}

export function starRocksLayoutChanges(draft: StarRocksLayoutDraft | undefined, context?: StarRocksAlterOptions): StarRocksLayoutChanges | undefined {
  if (!draft || !context?.distribution) return undefined;
  const count = draft.bucketCount.trim();
  const distribution: StarRocksDistributionChange = { method: draft.method, columns: draft.method === "hash" ? [...draft.columns] : [], buckets: count ? (Number.isSafeInteger(Number(count)) && Number(count) > 0 && Number(count) <= 2147483647 ? Number(count) : 0) : undefined };
  const original = context.distribution;
  const changed = distribution.method !== original.method || JSON.stringify(distribution.columns) !== JSON.stringify(original.columns) || distribution.buckets !== original.buckets;
  if (!changed && !draft.partitions.length) return undefined;
  return { distribution: changed ? { ...distribution, defaultOnly: draft.defaultOnly } : undefined, partitions: draft.partitions };
}

export function starRocksColumnDefinitionLocked(column: EditableStructureColumn, context?: StarRocksAlterOptions): boolean {
  if (!column.original) return false;
  if (!context || !["primary", "duplicate"].includes(context.model ?? "")) return true;
  const name = column.original.name.toLowerCase();
  return [...context.partitionColumns, ...context.distributionColumns, ...(context.model === "primary" ? context.keyColumns : [])].some((key) => key.toLowerCase() === name) || /auto_increment|generated/i.test(column.original.extra ?? "");
}

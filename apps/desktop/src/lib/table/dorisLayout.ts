import * as api from "@/lib/backend/api";
import { loadObjectDdl } from "@/lib/metadata/objectDdlCache";
import { tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import type { DorisLayoutUnavailableReason, DorisPartitionInfo, DorisPartitionsResult, DorisTableLayout, DorisTableModel } from "@/types/database";

type Token = SqlSemanticToken;

const TOKEN_OPTIONS = { squareBracketsAsDelimiters: true, mysqlDoubleQuoteIsString: true, mysqlBackslashEscape: true } as const;
const CLAUSE_WORDS = new Set(["comment", "distributed", "order", "properties", "rollup"]);

function significantTokens(ddl: string): Token[] {
  return tokenizeSqlSemantic(ddl, "mysql", TOKEN_OPTIONS).filter((token) => token.kind !== "comment");
}

function isWord(token: Token | undefined, word: string): boolean {
  return token?.kind === "word" && token.normalized === word;
}

function isIdentifier(token: Token | undefined): token is Token {
  return token?.kind === "word" || token?.kind === "quoted_identifier";
}

function matchingParen(tokens: Token[], openIndex: number): number {
  const open = tokens[openIndex];
  if (!open || open.text !== "(") return -1;
  for (let index = openIndex + 1; index < tokens.length; index++) {
    if (tokens[index]?.text === ")" && tokens[index]?.depth === open.depth) return index;
  }
  return -1;
}

function findTopLevelWord(tokens: Token[], word: string, from = 0): number {
  for (let index = from; index < tokens.length; index++) {
    const token = tokens[index];
    if (token && token.depth === 0 && isWord(token, word)) return index;
  }
  return -1;
}

function splitParts(tokens: Token[], openIndex: number, closeIndex: number): Token[][] {
  const depth = (tokens[openIndex]?.depth ?? 0) + 1;
  const parts: Token[][] = [];
  let current: Token[] = [];
  for (let index = openIndex + 1; index < closeIndex; index++) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === "," && token.depth === depth) {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  parts.push(current);
  return parts;
}

function simpleIdentifier(part: Token[]): string | null {
  const meaningful = part.filter((token) => token.kind !== "comment");
  if (meaningful.length !== 1 || !isIdentifier(meaningful[0])) return null;
  return unquoteSqlSemanticIdentifier(meaningful[0]!);
}

function identifiersInParts(parts: Token[][]): string[] {
  const names: string[] = [];
  for (const part of parts) {
    const name = simpleIdentifier(part);
    if (name !== null) names.push(name);
  }
  return names;
}

function decodeLiteral(token: Token): string {
  if (token.kind !== "string" && token.kind !== "quoted_identifier") return token.text;
  const quote = token.quote ?? token.text[0] ?? "";
  if (!quote) return token.text;
  const raw = token.text.slice(1, -1);
  // Backslash escapes are enabled for this dialect in TOKEN_OPTIONS; undo the
  // common ones so a property value is displayed as the server sees it.
  return raw.replaceAll(quote + quote, quote).replace(/\\(["'\\])/g, "$1");
}

function parseProperties(tokens: Token[], propertiesIndex: number): Record<string, string> {
  const openIndex = tokens.findIndex((token, index) => index > propertiesIndex && token.text === "(");
  if (openIndex < 0) return {};
  const closeIndex = matchingParen(tokens, openIndex);
  if (closeIndex < 0) return {};
  const depth = (tokens[openIndex]?.depth ?? 0) + 1;
  const properties: Record<string, string> = {};
  for (let index = openIndex + 1; index < closeIndex; index++) {
    const keyToken = tokens[index];
    if (!keyToken || keyToken.depth !== depth || (keyToken.kind !== "string" && keyToken.kind !== "quoted_identifier")) continue;
    const equals = tokens[index + 1];
    const valueToken = tokens[index + 2];
    if (equals?.text !== "=" || !valueToken || valueToken.depth !== depth) continue;
    const key = decodeLiteral(keyToken);
    if (!key) continue;
    properties[key] = decodeLiteral(valueToken);
    index += 2;
  }
  return properties;
}

function propertyValue(properties: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(properties).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

function clauseStartAfter(tokens: Token[], fromIndex: number): number | undefined {
  for (let index = fromIndex + 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token && token.depth === 0 && token.kind === "word" && CLAUSE_WORDS.has(token.normalized)) return token.span.start;
  }
  return undefined;
}

function emptyPartition(): DorisTableLayout["partition"] {
  return { enabled: false, mode: null, auto: false, columns: [], expression: null, clause: null };
}

function emptyDistribution(): DorisTableLayout["distribution"] {
  return { method: null, columns: [], buckets: null, autoBuckets: false };
}

function parseKeyModel(tokens: Token[]): { model: DorisTableModel | null; keyColumns: string[]; warning?: string } {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.depth !== 0 || token.kind !== "word") continue;
    const model = token.normalized;
    if (!["duplicate", "unique", "aggregate", "primary"].includes(model)) continue;
    if (!isWord(tokens[index + 1], "key") || tokens[index + 2]?.text !== "(") continue;
    const openIndex = index + 2;
    const closeIndex = matchingParen(tokens, openIndex);
    if (closeIndex < 0) return { model: null, keyColumns: [], warning: "Doris KEY column list is not closed." };
    const keyColumns = identifiersInParts(splitParts(tokens, openIndex, closeIndex));
    if (model === "primary") {
      return { model: null, keyColumns, warning: "PRIMARY KEY is a StarRocks model and is not valid for Doris." };
    }
    return { model: model as DorisTableModel, keyColumns };
  }
  return { model: null, keyColumns: [] };
}

function parsePartition(tokens: Token[], ddl: string): DorisTableLayout["partition"] {
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.depth !== 0) continue;
    if (!isWord(token, "partition")) continue;
    if (!isWord(tokens[index + 1], "by")) continue;
    const auto = isWord(tokens[index - 1], "auto");
    const startIndex = auto ? index - 1 : index;
    const kindIndex = index + 2;
    const kindToken = tokens[kindIndex];
    const kind = kindToken?.kind === "word" ? kindToken.normalized : "";
    const openIndex = tokens.findIndex((candidate, candidateIndex) => candidateIndex > kindIndex && candidate.text === "(");
    const closeIndex = openIndex >= 0 ? matchingParen(tokens, openIndex) : -1;
    const parts = openIndex >= 0 && closeIndex >= 0 ? splitParts(tokens, openIndex, closeIndex) : [];
    const columns = identifiersInParts(parts);
    const rawInside = openIndex >= 0 && closeIndex >= 0 ? ddl.slice(tokens[openIndex]!.span.end, tokens[closeIndex]!.span.start).trim() : null;
    const expression = rawInside !== null && columns.length !== parts.length ? rawInside : null;
    const end = clauseStartAfter(tokens, index);
    const clause = ddl.slice(tokens[startIndex]!.span.start, end ?? tokens[tokens.length - 1]?.span.end ?? ddl.length).trim();
    return {
      enabled: true,
      mode: kind === "range" || kind === "list" ? kind : null,
      auto,
      columns,
      expression,
      clause,
    };
  }
  return emptyPartition();
}

function parseDistribution(tokens: Token[]): DorisTableLayout["distribution"] {
  const distributed = findTopLevelWord(tokens, "distributed");
  if (distributed < 0 || !isWord(tokens[distributed + 1], "by")) return emptyDistribution();
  const methodToken = tokens[distributed + 2];
  const method = methodToken?.kind === "word" && (methodToken.normalized === "hash" || methodToken.normalized === "random") ? methodToken.normalized : null;
  const columns: string[] = [];
  if (method === "hash" && tokens[distributed + 3]?.text === "(") {
    const closeIndex = matchingParen(tokens, distributed + 3);
    if (closeIndex >= 0) columns.push(...identifiersInParts(splitParts(tokens, distributed + 3, closeIndex)));
  }
  let buckets: number | null = null;
  let autoBuckets = false;
  for (let index = distributed + 3; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.depth !== 0 || !isWord(token, "buckets")) continue;
    const value = tokens[index + 1];
    if (!value) break;
    if (isWord(value, "auto")) autoBuckets = true;
    else if (value.kind === "number") {
      const parsed = Number(value.text);
      buckets = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    break;
  }
  return { method, columns, buckets, autoBuckets };
}

/**
 * Parse the table-level clauses of a Doris `SHOW CREATE TABLE` result.
 *
 * Deliberately conservative: unknown or expression partitions keep their raw
 * clause instead of guessing structured bounds. Actual partition rows always
 * come from `SHOW PARTITIONS`, not from this parser.
 */
export function dorisLayoutFromDdl(ddl: string): Omit<DorisTableLayout, "partitions" | "unavailableReason"> {
  const tokens = significantTokens(ddl);
  const engineIndex = findTopLevelWord(tokens, "engine");
  const engineValue = engineIndex >= 0 ? tokens.slice(engineIndex + 1, engineIndex + 4).find((token) => token.kind === "word")?.normalized : undefined;
  const empty = {
    model: null,
    keyColumns: [] as string[],
    partition: emptyPartition(),
    distribution: emptyDistribution(),
    properties: {} as Record<string, string>,
    colocateWith: null as string | null,
    dynamicPartition: false,
    warnings: [] as string[],
  };
  if (engineValue !== "olap") {
    return { kind: "nonOlap", ...empty };
  }
  const key = parseKeyModel(tokens);
  const partition = parsePartition(tokens, ddl);
  const distribution = parseDistribution(tokens);
  const propertiesIndex = findTopLevelWord(tokens, "properties");
  const properties = propertiesIndex >= 0 ? parseProperties(tokens, propertiesIndex) : {};
  const colocateValue = propertyValue(properties, "colocate_with");
  const dynamicPartition = Object.entries(properties).some(([keyName, value]) => keyName.toLowerCase().startsWith("dynamic_partition.") && value.toLowerCase() === "true");
  const warnings = key.warning ? [key.warning] : [];
  if (partition.enabled && partition.mode === null) warnings.push("Unsupported Doris partition clause; showing the raw definition.");
  return {
    kind: "olap",
    model: key.model,
    keyColumns: key.keyColumns,
    partition,
    distribution,
    properties,
    colocateWith: colocateValue?.trim() ? colocateValue : null,
    dynamicPartition,
    warnings,
  };
}

function mapUnavailableReason(reason: string | null | undefined): DorisLayoutUnavailableReason {
  switch (reason) {
    case "external_catalog":
      return "externalCatalog";
    case "permission_denied":
      return "permissionDenied";
    default:
      return "unsupported";
  }
}

function looksLikePermissionError(message: string): boolean {
  return /(denied|permission|access denied|not authorized)/i.test(message);
}

/** Combine DDL-derived table metadata with the SHOW PARTITIONS result. */
export function buildDorisTableLayout(ddl: string, result: DorisPartitionsResult | null, partitionError?: string): DorisTableLayout {
  const layout = dorisLayoutFromDdl(ddl);
  if (layout.kind === "nonOlap") {
    return { ...layout, partitions: [], unavailableReason: "notOlap" };
  }
  if (result && !result.supported) {
    return { ...layout, partitions: [], unavailableReason: mapUnavailableReason(result.reason), warnings: [...layout.warnings] };
  }
  if (partitionError) {
    return {
      ...layout,
      partitions: [],
      unavailableReason: looksLikePermissionError(partitionError) ? "permissionDenied" : "unsupported",
      warnings: [...layout.warnings, partitionError],
    };
  }
  return { ...layout, partitions: result?.partitions ?? [] };
}

export interface DorisLayoutRequest {
  connectionId: string;
  database: string;
  schema?: string;
  tableName: string;
  catalog?: string;
  queryTimeoutSecs?: number;
  forceDdl?: boolean;
  forcePartitions?: boolean;
}

/**
 * Load DDL and SHOW PARTITIONS in parallel. A partition failure does not hide
 * the table-level layout: it becomes `unavailableReason` plus a warning.
 */
export async function loadDorisTableLayout(request: DorisLayoutRequest): Promise<DorisTableLayout> {
  const schema = request.schema || request.database;
  const [ddlResult, partitionsResult] = await Promise.allSettled([
    loadObjectDdl(
      {
        connectionId: request.connectionId,
        queryTimeoutSecs: request.queryTimeoutSecs,
        database: request.database,
        schema,
        tableName: request.tableName,
        catalog: request.catalog,
      },
      { force: request.forceDdl },
    ),
    api.listDorisPartitions(request.connectionId, request.database, schema, request.tableName, request.catalog),
  ]);
  if (ddlResult.status === "rejected") {
    throw ddlResult.reason instanceof Error ? ddlResult.reason : new Error(String(ddlResult.reason));
  }
  if (partitionsResult.status === "rejected") {
    return buildDorisTableLayout(ddlResult.value.ddl, null, String(partitionsResult.reason));
  }
  return buildDorisTableLayout(ddlResult.value.ddl, partitionsResult.value);
}

/** Display a Doris `SHOW PARTITIONS.Range` value without inventing a SQL interval. */
export function dorisPartitionRangeText(range: string | null | undefined): string {
  return (range ?? "").replace(/\s+/g, " ").trim();
}

export function dorisPartitionSearchText(partition: DorisPartitionInfo): string {
  return [partition.name, partition.range, partition.state, partition.storageMedium].filter(Boolean).join(" ").toLowerCase();
}

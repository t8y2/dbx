import { tokenizeSqlSemantic, unquoteSqlSemanticIdentifier } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import type { EditableStructureColumn } from "./tableStructureEditorSql";

function tokens(sql: string) {
  return tokenizeSqlSemantic(sql, "mysql", { mysqlBackslashEscape: true, mysqlDoubleQuoteIsString: true, squareBracketsAsDelimiters: true });
}
function body(sql: string) {
  const all = tokens(sql);
  if (all.some((token) => token.closed === false)) throw new Error("Unclosed source DDL token.");
  if (all[0]?.normalized !== "create" || all[1]?.normalized !== "table") throw new Error("An internal CREATE TABLE statement is required.");
  const open = all.find((token) => token.text === "(" && token.depth === 0);
  const close = all.find((token) => open && token.span.start > open.span.start && token.text === ")" && token.depth === 0);
  if (!open || !close) throw new Error("Could not read the table column definitions.");
  const semicolon = all.find((token) => token.text === ";" && token.depth === 0);
  if (semicolon && all.some((token) => token.kind !== "comment" && token.span.start > semicolon.span.start)) throw new Error("Only one CREATE TABLE is allowed.");
  return { all, open, close, end: semicolon?.span.start ?? sql.length };
}
interface Clause {
  name: string;
  start: number;
  end: number;
  tokens: SqlSemanticToken[];
}
function clauses(sql: string): Clause[] {
  const info = body(sql);
  const starts = info.all.filter(
    (token, index, all) =>
      token.span.start > info.close.span.start &&
      token.depth === 0 &&
      token.kind === "word" &&
      (["engine", "comment", "properties"].includes(token.normalized) || (["primary", "duplicate", "unique", "aggregate"].includes(token.normalized) && all[index + 1]?.normalized === "key") || (["partition", "distributed", "order"].includes(token.normalized) && all[index + 1]?.normalized === "by")),
  );
  return starts.map((token, index) => ({ name: token.normalized, start: token.span.start, end: starts[index + 1]?.span.start ?? info.end, tokens: info.all.filter((part) => part.span.start >= token.span.start && part.span.start < (starts[index + 1]?.span.start ?? info.end)) }));
}
const quote = (name: string) => "`" + name.replaceAll("`", "``") + "`";
export function starRocksCopyTarget(database: string, name: string): string {
  if (!name.trim() || name.includes("\0")) throw new Error("Enter a valid new table name.");
  return `${quote(database)}.${quote(name.trim())}`;
}

/** Replace only layout clauses; retain column definitions, model, indexes, order and unknown properties verbatim. */
export function buildStarRocksLayoutCopyDdl(source: string, generated: string, database: string, targetName: string, keepPartition: boolean): string {
  const info = body(source);
  const original = clauses(source);
  const proposed = clauses(generated);
  const engine = original.find((clause) => clause.name === "engine");
  if (!engine || engine.tokens[2]?.normalized !== "olap") throw new Error("Only internal OLAP tables can be copied with this workflow.");
  const distribution = proposed.find((clause) => clause.name === "distributed");
  if (!distribution) throw new Error("No distribution clause was generated.");
  const partition = proposed.find((clause) => clause.name === "partition");
  const replacements: Array<{ start: number; end: number; text: string }> = [{ start: 0, end: info.open.span.start, text: `CREATE TABLE ${starRocksCopyTarget(database, targetName)} ` }];
  const originalDistribution = original.find((clause) => clause.name === "distributed");
  if (!originalDistribution) throw new Error("The original distribution metadata is unavailable.");
  replacements.push({ start: originalDistribution.start, end: originalDistribution.end, text: generated.slice(distribution.start, distribution.end).trim() + "\n" });
  if (!keepPartition) {
    const existing = original.find((clause) => clause.name === "partition");
    const text = partition ? generated.slice(partition.start, partition.end).trim() + "\n" : "";
    replacements.push({ start: existing?.start ?? originalDistribution.start, end: existing?.end ?? originalDistribution.start, text });
  }
  const properties = original.find((clause) => clause.name === "properties");
  if (properties) {
    const open = properties.tokens.findIndex((token) => token.text === "(");
    const close = properties.tokens.findIndex((token, index) => index > open && token.text === ")" && token.depth === 0);
    if (open < 0 || close < 0) throw new Error("Could not preserve table properties safely.");
    const parts: SqlSemanticToken[][] = [[]];
    for (const token of properties.tokens.slice(open + 1, close)) {
      if (token.text === "," && token.depth === 1) parts.push([]);
      else parts[parts.length - 1]!.push(token);
    }
    const desired = distribution.tokens;
    const isHash = desired.some((token) => token.kind === "word" && token.normalized === "hash");
    const fixedBuckets = desired.some((token) => token.kind === "word" && token.normalized === "buckets");
    const retained = parts
      .filter((part) => {
        const key = part[0]?.text.slice(1, -1).toLowerCase() ?? "";
        // An old colocation contract or automatic scaling property conflicts with the new layout.
        if (key === "colocate_with") return false;
        if (key === "bucket_size" && (isHash || fixedBuckets)) return false;
        if (!keepPartition && (key.startsWith("dynamic_partition.") || ["partition_live_number", "partition_ttl", "partition_retention_condition"].includes(key))) return false;
        return true;
      })
      .map((part) => (part.length ? source.slice(part[0]!.span.start, part[part.length - 1]!.span.end) : ""));
    replacements.push({ start: properties.start, end: properties.end, text: retained.filter(Boolean).length ? `PROPERTIES (\n${retained.filter(Boolean).join(",\n")}\n)` : "" });
  }
  let result = source;
  // For an inserted partition and replaced distribution at the same offset,
  // replace distribution first, then insert the partition in front of it.
  for (const change of replacements.sort((a, b) => b.start - a.start || b.end - a.end)) {
    result = result.slice(0, change.start) + change.text + result.slice(change.end);
  }
  return result.trim().replace(/;\s*$/, "") + ";";
}

export function starRocksCopyInsertColumns(sourceDdl: string, columns: EditableStructureColumn[]): string[] {
  const info = body(sourceDdl);
  const groups: SqlSemanticToken[][] = [[]];
  for (const token of info.all.filter((token) => token.span.start >= info.open.span.end && token.span.start < info.close.span.start)) {
    if (token.text === "," && token.depth === 1) groups.push([]);
    else groups[groups.length - 1]!.push(token);
  }
  const generated = new Set(groups.filter((group) => group.some((token) => token.kind === "word" && token.depth === 1 && ["generated", "as"].includes(token.normalized))).map((group) => (group[0] ? unquoteSqlSemanticIdentifier(group[0]).toLowerCase() : "")));
  return columns.filter((column) => !generated.has(column.name.toLowerCase()) && !/generated/i.test(column.original?.extra ?? "")).map((column) => column.name);
}

export interface StarRocksCopyPlan {
  createSql: string;
  insertSql?: string;
  targetName: string;
}
export type StarRocksCopyStage = "creating" | "created" | "transferring" | "complete";
/** Sequential execution never replays an INSERT or creates into an existing table. */
export async function executeStarRocksCopyPlan(plan: StarRocksCopyPlan, execute: (sql: string) => Promise<unknown>, stage: (value: StarRocksCopyStage) => void): Promise<void> {
  stage("creating");
  await execute(plan.createSql);
  stage("created");
  if (plan.insertSql) {
    stage("transferring");
    await execute(plan.insertSql);
  }
  stage("complete");
}

// Spark SHOW CREATE TABLE supplies the authoritative column definitions and provider.
export function readPaimonCopySource(sql: string) {
  const info = body(sql);
  const tail = info.all.filter((token) => token.span.start >= info.close.span.end && token.depth === 0);
  const provider = tail.findIndex((token) => token.normalized === "using");
  if (provider < 0 || tail[provider + 1]?.normalized !== "paimon") throw new Error("A Paimon SHOW CREATE TABLE definition is required.");
  const propsIndex = info.all.findIndex((token) => token.depth === 0 && token.normalized === "tblproperties");
  const properties = new Map<string, string>();
  if (propsIndex >= 0) {
    const entries = info.all.slice(propsIndex + 2);
    const decode = (text: string) =>
      text
        .slice(1, -1)
        .replace(/\\(['\\])/g, "$1")
        .replaceAll("''", "'");
    for (let i = 0; i < entries.length && entries[i].text !== ")"; i += 4) {
      const [key, eq, value, separator] = entries.slice(i, i + 4);
      if (key?.kind !== "string" || eq?.text !== "=" || value?.kind !== "string" || ![",", ")"].includes(separator?.text)) throw new Error("Unrecognized Paimon table properties.");
      properties.set(decode(key.text), decode(value.text));
      if (separator.text === ")") break;
    }
  }
  for (const key of properties.keys()) {
    if (/^(path|location)$/i.test(key)) properties.delete(key);
  }
  const partitionIndex = info.all.findIndex((token) => token.span.start > info.close.span.start && token.depth === 0 && token.normalized === "partitioned");
  const partitionNames: string[] = [];
  if (partitionIndex >= 0) {
    const cols = info.all.slice(partitionIndex + 3);
    for (const token of cols) {
      if (token.depth === 0) break;
      if (token.text === ",") continue;
      if (!["quoted_identifier", "word"].includes(token.kind)) throw new Error("Unsupported partition expression.");
      partitionNames.push(unquoteSqlSemanticIdentifier(token));
    }
  }
  const comment = tail.findIndex((token) => token.normalized === "comment");
  return { partitionNames, definitions: sql.slice(info.open.span.end, info.close.span.start), properties, commentSql: comment >= 0 && tail[comment + 1]?.kind === "string" ? " COMMENT " + tail[comment + 1].text : "" };
}

export function paimonCopyDdl(source: ReturnType<typeof readPaimonCopySource>, generated: string, destination: string, derived: boolean, replacedPartition?: string) {
  const info = body(generated);
  const lastComma = derived ? info.all.filter((token) => token.text === "," && token.depth === 1 && token.span.start < info.close.span.start).pop() : undefined;
  if (derived && !lastComma) throw new Error("Missing derived partition column.");
  const extra = lastComma ? generated.slice(lastComma.span.start, info.close.span.start) : "";
  const suffix = generated.slice(info.close.span.end).trim().replace(/;$/, "");
  const props = info.all.find((token) => token.depth === 0 && token.normalized === "tblproperties");
  const layout = props ? generated.slice(info.close.span.end, props.span.start).trim() : suffix;
  const properties = props ? " " + generated.slice(props.span.start, info.end).trim() : "";
  let definitions = source.definitions.trimEnd();
  if (replacedPartition) {
    const parts = tokens(definitions);
    const start = parts.findIndex((part, index) => (index === 0 || (parts[index - 1]?.text === "," && parts[index - 1]?.depth === 0)) && ["word", "quoted_identifier"].includes(part.kind) && unquoteSqlSemanticIdentifier(part) === replacedPartition);
    if (start < 0 || !source.partitionNames.includes(replacedPartition)) throw new Error("Partition definition unavailable.");
    const next = parts.slice(start + 1).find((part) => part.text === "," && part.depth === 0);
    definitions = next ? definitions.slice(0, parts[start]!.span.start) + definitions.slice(next.span.end) : definitions.slice(0, parts[start - 1]?.span.start ?? 0);
  }
  return `CREATE TABLE ${destination} (${definitions}${extra}\n) USING paimon ${layout}${source.commentSql}${properties};`;
}

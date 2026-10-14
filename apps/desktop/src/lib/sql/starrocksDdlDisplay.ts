import { tokenizeSqlSemantic } from "./semantic/tokens";
import type { SqlSemanticToken } from "./semantic/types";

const TYPES = new Set([
  "boolean",
  "tinyint",
  "smallint",
  "int",
  "integer",
  "bigint",
  "largeint",
  "float",
  "double",
  "decimal",
  "decimalv2",
  "decimal32",
  "decimal64",
  "decimal128",
  "date",
  "datetime",
  "char",
  "varchar",
  "string",
  "binary",
  "varbinary",
  "json",
  "array",
  "map",
  "struct",
  "bitmap",
  "hll",
  "percentile",
]);
const ATTRIBUTES = new Set(["null", "not", "default", "comment", "key", "auto_increment", "as", "generated", "sum", "min", "max", "replace", "replace_if_not_null", "hll_union", "bitmap_union", "percentile_union"]);

function inline(tokens: SqlSemanticToken[]): string {
  let text = "";
  let previous: SqlSemanticToken | undefined;
  for (const token of tokens) {
    const tight = !previous || [")", ",", ";", "."].includes(token.text) || ["(", "."].includes(previous.text) || (token.text === "(" && previous.kind === "word" && !["by", "properties"].includes(previous.normalized));
    text += (tight ? "" : " ") + token.text;
    previous = token;
  }
  return text;
}

function split(tokens: SqlSemanticToken[], depth: number): SqlSemanticToken[][] {
  const groups: SqlSemanticToken[][] = [[]];
  for (const token of tokens) {
    if (token.text === "," && token.depth === depth) groups.push([]);
    else groups[groups.length - 1]!.push(token);
  }
  return groups;
}

/** Format only a single CREATE TABLE; unfamiliar/commented SQL stays intact. */
export function formatStarRocksDdlForDisplay(sql: string): string {
  const tokens = tokenizeSqlSemantic(sql, "mysql");
  if (tokens.some((token) => token.kind === "comment" || token.closed === false)) return sql;
  if (tokens[0]?.normalized !== "create" || tokens[1]?.normalized !== "table") return sql;
  if (tokens.filter((token) => token.text === ";" && token.depth === 0).length > 1 || tokens.some((token, index) => token.text === ";" && index < tokens.length - 1)) return sql;
  const opening = tokens.findIndex((token) => token.text === "(" && token.depth === 0);
  if (opening < 0) return sql;
  const closing = tokens.findIndex((token, index) => index > opening && token.text === ")" && token.depth === 0);
  if (closing < 0) return sql;
  const columns = split(tokens.slice(opening + 1, closing), 1).map((column) => {
    let inType = true;
    return (
      "  " +
      inline(
        column.map((token, index) => {
          if (index > 0 && token.depth === 1 && token.kind === "word" && ATTRIBUTES.has(token.normalized)) inType = false;
          return index > 0 && inType && token.kind === "word" && TYPES.has(token.normalized) ? { ...token, text: token.normalized } : token;
        }),
      )
    );
  });
  const tail = tokens.slice(closing + 1).filter((token) => token.text !== ";");
  const clauses: SqlSemanticToken[][] = [];
  for (let index = 0; index < tail.length; index++) {
    const token = tail[index]!;
    const next = tail[index + 1]?.normalized;
    const boundary =
      token.depth === 0 &&
      token.kind === "word" &&
      (["engine", "comment", "properties"].includes(token.normalized) || (["primary", "duplicate", "unique", "aggregate"].includes(token.normalized) && next === "key") || (["partition", "distributed", "order"].includes(token.normalized) && next === "by"));
    if (boundary || !clauses.length) clauses.push([]);
    clauses[clauses.length - 1]!.push(token);
  }
  let result = inline(tokens.slice(0, opening)) + " (\n" + columns.join(",\n") + "\n)";
  for (const clause of clauses) {
    if (clause[0]?.normalized === "properties" && clause[1]?.text === "(" && clause[clause.length - 1]?.text === ")") {
      result += "\nPROPERTIES (\n" + split(clause.slice(2, -1), 1).map(inline).join(",\n") + "\n)";
    } else {
      const text = inline(clause.map((token, index) => (token.kind === "word" && clause[index - 1]?.kind === "number" && clause[index - 2]?.normalized === "interval" && ["year", "month", "day", "hour", "minute", "second"].includes(token.normalized) ? { ...token, text: token.normalized } : token)));
      result += (clause[0]?.normalized === "engine" ? " " : "\n") + (clause[0]?.normalized === "engine" ? text.replace(/\s*=\s*/, "=") : text);
    }
  }
  return result + (tokens[tokens.length - 1]?.text === ";" ? ";" : "");
}

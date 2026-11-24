// Completion for the MongoDB SQL mode (see lib/mongo/mongoSql.ts).
//
// A pure library like lib/soql/soqlCompletion.ts: a context scanner reads the
// statement around the cursor, and a builder turns the collections and sampled
// field paths the shell mode already loads into completion items. Only syntax
// the SQL → shell compiler accepts is offered.

import type { MongoCompletionField, MongoCompletionItem } from "@/lib/mongo/mongoCompletion";

export type MongoSqlCompletionMode = "none" | "statement" | "collection" | "field" | "keyword";

export type MongoSqlClause = "select" | "from" | "join" | "on" | "where" | "groupby" | "having" | "orderby" | "limit" | "set" | "into" | "values" | null;

export interface MongoSqlCollectionRef {
  collection: string;
  alias?: string;
}

export interface MongoSqlCompletionContext {
  mode: MongoSqlCompletionMode;
  /** Identifier text being completed (after any `alias.`). */
  prefix: string;
  /** Document position where the replacement starts. */
  from: number;
  /** Document position where the replacement ends (rest of the word under the cursor). */
  to: number;
  clause: MongoSqlClause;
  /** Collection the unqualified fields belong to (FROM / UPDATE / INSERT INTO / DELETE FROM). */
  baseCollection?: string;
  /** Joined collections, for `alias.field` items. */
  joins: MongoSqlCollectionRef[];
  /** Set when the user typed `alias.`: fields of that collection only. */
  qualifier?: MongoSqlCollectionRef;
  /** The previous word is a complete FROM/JOIN target, so clause keywords come next. */
  afterCollection?: boolean;
}

export interface MongoSqlCompletionInput {
  collections?: string[];
  /** Sampled field paths per collection name. */
  fields?: Map<string, MongoCompletionField[]>;
}

const WORD = /[A-Za-z0-9_$]/;
const IDENT_SEGMENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const CLAUSE_WORDS: Record<string, MongoSqlClause> = {
  select: "select",
  from: "from",
  join: "join",
  on: "on",
  where: "where",
  having: "having",
  limit: "limit",
  offset: "limit",
  set: "set",
  into: "into",
  values: "values",
};

const STATEMENT_KEYWORDS: Array<{ label: string; detail: string; boost: number }> = [
  { label: "SELECT", detail: "find / aggregate", boost: 100 },
  { label: "SELECT DISTINCT", detail: "$group on columns", boost: 92 },
  { label: "INSERT INTO", detail: "insertMany", boost: 80 },
  { label: "UPDATE", detail: "updateMany", boost: 78 },
  { label: "DELETE FROM", detail: "deleteMany", boost: 76 },
];

const FIELD_LIST_STARTERS = new Set(["select", "where", "and", "or", "not", "by", "on", "set", "having", "distinct"]);

const AFTER_COLLECTION_KEYWORDS = ["WHERE", "INNER JOIN", "LEFT JOIN", "GROUP BY", "ORDER BY", "LIMIT", "OFFSET", "SET", "VALUES"];

const CONDITION_KEYWORDS = ["AND", "OR", "NOT", "IN", "NOT IN", "LIKE", "NOT LIKE", "ILIKE", "BETWEEN", "IS NULL", "IS NOT NULL", "TRUE", "FALSE", "NULL"];

const AGGREGATES: Array<{ label: string; apply: string; detail: string }> = [
  { label: "COUNT(*)", apply: "COUNT(*)", detail: "$sum: 1" },
  { label: "COUNT", apply: "COUNT()", detail: "count non-null" },
  { label: "SUM", apply: "SUM()", detail: "$sum" },
  { label: "AVG", apply: "AVG()", detail: "$avg" },
  { label: "MIN", apply: "MIN()", detail: "$min" },
  { label: "MAX", apply: "MAX()", detail: "$max" },
];

const VALUE_CONSTRUCTORS: Array<{ label: string; apply: string; detail: string }> = [
  { label: "ObjectId('')", apply: "ObjectId('')", detail: "ObjectId value" },
  { label: "ISODate('')", apply: "ISODate('')", detail: "Date value" },
];

/** Strings and comments blanked out, so keyword scans never look inside them. Same length as the input. */
function maskSql(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "-" && next === "-") {
      while (index < text.length && text[index] !== "\n") {
        out += " ";
        index++;
      }
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += " ".repeat(stop - index);
      index = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      // Quoted identifiers keep a marker so `FROM "my coll"` still reads as a word.
      const quote = char;
      let stop = index + 1;
      while (stop < text.length && text[stop] !== quote) stop += text[stop] === "\\" ? 2 : 1;
      stop = Math.min(text.length, stop + 1);
      const filler = quote === "'" ? " " : "x";
      out += quote === "'" ? "'" + filler.repeat(Math.max(0, stop - index - 2)) + (stop - index > 1 ? "'" : "") : filler.repeat(stop - index);
      index = stop;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

/** True when the cursor sits inside an unclosed single-quoted string (a value). */
function insideString(text: string, cursor: number): boolean {
  let open = false;
  for (let index = 0; index < cursor; index++) {
    const char = text[index];
    if (char === "\\" && open) {
      index++;
      continue;
    }
    if (char === "'") open = !open;
  }
  return open;
}

function statementBounds(masked: string, cursor: number): { start: number; end: number } {
  const start = masked.lastIndexOf(";", cursor - 1) + 1;
  const endIndex = masked.indexOf(";", cursor);
  return { start, end: endIndex < 0 ? masked.length : endIndex };
}

function unquote(word: string): string {
  return word.replace(/^[`"](.*)[`"]$/, "$1");
}

/** FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM targets of one statement. */
export function mongoSqlStatementCollections(statement: string): { base?: string; baseAlias?: string; joins: MongoSqlCollectionRef[] } {
  const masked = maskSql(statement);
  const original = statement;
  const words: Array<{ text: string; start: number }> = [];
  const pattern = /[`"][^`"]*[`"]|[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)*/g;
  for (const match of masked.matchAll(pattern)) {
    const start = match.index ?? 0;
    words.push({ text: original.slice(start, start + match[0].length), start });
  }
  let base: string | undefined;
  let baseAlias: string | undefined;
  const joins: MongoSqlCollectionRef[] = [];
  const aliasAfter = (index: number) => {
    let next = words[index + 1];
    if (next?.text.toLowerCase() === "as") next = words[index + 2];
    if (!next) return undefined;
    return /^(where|join|inner|left|right|full|cross|on|group|order|limit|offset|set|values|having)$/i.test(next.text) ? undefined : unquote(next.text);
  };
  words.forEach((word, index) => {
    const lower = word.text.toLowerCase();
    const target = words[index + 1];
    if (!target) return;
    const prev = words[index - 1]?.text.toLowerCase();
    const name = unquote(target.text).split(".").pop()!;
    if ((lower === "from" && prev !== "delete") || lower === "update" || (lower === "into" && prev === "insert") || (lower === "from" && prev === "delete")) {
      if (!base) {
        base = name;
        baseAlias = lower === "from" ? aliasAfter(index + 1) : undefined;
      }
    } else if (lower === "join") {
      joins.push({ collection: name, alias: aliasAfter(index + 1) ?? name });
    }
  });
  return { base, baseAlias, joins };
}

export function getMongoSqlCompletionContext(text: string, cursor: number): MongoSqlCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const none: MongoSqlCompletionContext = { mode: "none", prefix: "", from: safeCursor, to: safeCursor, clause: null, joins: [] };
  if (insideString(text, safeCursor)) return none;
  const masked = maskSql(text);
  const { start, end } = statementBounds(masked, safeCursor);

  // Word (possibly dotted) under the cursor.
  let wordStart = safeCursor;
  while (wordStart > start && (WORD.test(masked[wordStart - 1]!) || masked[wordStart - 1] === ".")) wordStart--;
  let wordEnd = safeCursor;
  while (wordEnd < end && WORD.test(masked[wordEnd]!)) wordEnd++;
  const typed = text.slice(wordStart, safeCursor);
  if (/^\d/.test(typed)) return none;

  const statementText = text.slice(start, end);
  const { base, baseAlias, joins } = mongoSqlStatementCollections(statementText);

  // Words before the one being typed, for clause detection.
  const before = masked.slice(start, wordStart);
  const previousWords = [...before.matchAll(/[A-Za-z_][A-Za-z0-9_$]*|[(),=<>*]/g)].map((match) => match[0].toLowerCase());
  const previous = previousWords[previousWords.length - 1];
  const previous2 = previousWords[previousWords.length - 2];

  let clause: MongoSqlClause = null;
  for (let index = previousWords.length - 1; index >= 0; index--) {
    const word = previousWords[index]!;
    if (word === "by" && (previousWords[index - 1] === "group" || previousWords[index - 1] === "order")) {
      clause = previousWords[index - 1] === "group" ? "groupby" : "orderby";
      break;
    }
    if (word === "update") {
      clause = "from";
      break;
    }
    if (CLAUSE_WORDS[word]) {
      clause = CLAUSE_WORDS[word]!;
      break;
    }
  }

  const prefixAll = typed;
  const context = (mode: MongoSqlCompletionMode, extra: Partial<MongoSqlCompletionContext> = {}): MongoSqlCompletionContext => ({
    mode,
    prefix: prefixAll,
    from: wordStart,
    to: wordEnd,
    clause,
    baseCollection: base,
    joins,
    ...extra,
  });

  if (previousWords.length === 0) return context("statement");

  // Collection right after FROM / JOIN / UPDATE / INTO.
  if (previous === "from" || previous === "join" || previous === "update" || (previous === "into" && previous2 === "insert")) {
    return context("collection");
  }

  // `FROM users |` or `FROM users u |`: the next clause keyword.
  if (clause === "from" || clause === "join") {
    if (!prefixAll || !/\./.test(prefixAll)) return context("keyword", { afterCollection: true });
  }

  if (clause === "limit" || clause === "values" || clause === "into") return clause === "into" ? context("field") : none;

  // `alias.` / `collection.` qualifies the field.
  const dot = prefixAll.lastIndexOf(".");
  if (dot > 0) {
    const head = prefixAll.slice(0, prefixAll.indexOf("."));
    const qualifier =
      joins.find((join) => join.alias?.toLowerCase() === head.toLowerCase() || join.collection.toLowerCase() === head.toLowerCase()) ?? (base && (head.toLowerCase() === base.toLowerCase() || head.toLowerCase() === baseAlias?.toLowerCase()) ? { collection: base, alias: head } : undefined);
    if (qualifier) {
      return context("field", { qualifier, prefix: prefixAll.slice(prefixAll.indexOf(".") + 1), from: wordStart + prefixAll.indexOf(".") + 1 });
    }
  }
  return context("field");
}

function quoteFieldPath(path: string): string {
  return path
    .split(".")
    .map((segment) => (IDENT_SEGMENT.test(segment) ? segment : `\`${segment.replace(/`/g, "")}\``))
    .join(".");
}

function keywordItem(label: string, detail: string, boost: number): MongoCompletionItem {
  return { label, type: "keyword", detail, boost, apply: `${label} ` };
}

export function buildMongoSqlCompletionItems(context: MongoSqlCompletionContext, input: MongoSqlCompletionInput = {}): MongoCompletionItem[] {
  if (context.mode === "none") return [];
  const items: MongoCompletionItem[] = [];

  if (context.mode === "statement") {
    for (const keyword of STATEMENT_KEYWORDS) items.push(keywordItem(keyword.label, keyword.detail, keyword.boost));
    return items;
  }

  if (context.mode === "collection") {
    for (const collection of input.collections ?? []) {
      items.push({ label: collection, type: "table", detail: "collection", boost: 90, apply: IDENT_SEGMENT.test(collection) ? collection : `\`${collection}\`` });
    }
    return items;
  }

  if (context.mode === "keyword") {
    AFTER_COLLECTION_KEYWORDS.forEach((label, index) => items.push(keywordItem(label, "clause", 90 - index)));
    return items;
  }

  // Field mode.
  const fieldsOf = (collection: string) => input.fields?.get(collection) ?? [];
  if (context.qualifier) {
    for (const field of fieldsOf(context.qualifier.collection)) {
      items.push({ label: field.name, type: "column", detail: field.type, boost: 95, apply: quoteFieldPath(field.name) });
    }
    return items;
  }
  if (context.baseCollection) {
    for (const field of fieldsOf(context.baseCollection)) {
      items.push({ label: field.name, type: "column", detail: field.type ? `${field.type} · ${context.baseCollection}` : context.baseCollection, boost: 95, apply: quoteFieldPath(field.name) });
    }
  }
  for (const join of context.joins) {
    const alias = join.alias ?? join.collection;
    for (const field of fieldsOf(join.collection)) {
      const label = `${alias}.${field.name}`;
      items.push({ label, type: "column", detail: field.type ? `${field.type} · ${join.collection}` : join.collection, boost: 85, apply: `${quoteFieldPath(alias)}.${quoteFieldPath(field.name)}` });
    }
  }

  const clause = context.clause;
  if (clause === "select" || clause === "having" || clause === "orderby") {
    for (const fn of AGGREGATES) items.push({ label: fn.label, type: "function", detail: fn.detail, boost: 60, apply: fn.apply });
  }
  if (clause === "select") {
    items.push(keywordItem("FROM", "collection", 70), keywordItem("AS", "alias", 55));
    if (!context.baseCollection) items.push({ label: "*", type: "keyword", detail: "all fields", boost: 50, apply: "* " });
  }
  if (clause === "where" || clause === "having" || clause === "on") {
    CONDITION_KEYWORDS.forEach((label, index) => items.push(keywordItem(label, "condition", 50 - index)));
    for (const ctor of VALUE_CONSTRUCTORS) items.push({ label: ctor.label, type: "function", detail: ctor.detail, boost: 45, apply: ctor.apply });
    for (const label of ["GROUP BY", "ORDER BY", "LIMIT"]) items.push(keywordItem(label, "clause", 40));
  }
  if (clause === "groupby") for (const label of ["HAVING", "ORDER BY", "LIMIT"]) items.push(keywordItem(label, "clause", 40));
  if (clause === "orderby") {
    items.push(keywordItem("ASC", "ascending", 58), keywordItem("DESC", "descending", 58), keywordItem("LIMIT", "clause", 40), keywordItem("OFFSET", "clause", 38));
  }
  if (clause === "set") for (const ctor of VALUE_CONSTRUCTORS) items.push({ label: ctor.label, type: "function", detail: ctor.detail, boost: 45, apply: ctor.apply });
  return items;
}

/** Collections whose fields a field-mode context needs. */
export function mongoSqlCompletionCollections(context: MongoSqlCompletionContext): string[] {
  if (context.mode !== "field") return [];
  if (context.qualifier) return [context.qualifier.collection];
  return [...new Set([context.baseCollection, ...context.joins.map((join) => join.collection)].filter((name): name is string => !!name))];
}

/** Open automatically while typing a word, after `.`, and after FROM / JOIN / UPDATE / INTO + space. */
export function shouldAutoOpenMongoSqlCompletion(text: string, cursor: number): boolean {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const previous = text[safeCursor - 1];
  if (!previous) return false;
  if (insideString(text, safeCursor)) return false;
  if (previous === ".") return true;
  if (WORD.test(previous)) return !/^\d+$/.test(text.slice(0, safeCursor).match(/[A-Za-z0-9_$]+$/)?.[0] ?? "");
  if (/\s/.test(previous)) {
    const context = getMongoSqlCompletionContext(text, safeCursor);
    if (context.mode === "collection") return true;
    // Field lists right after the words that start one: `WHERE |`, `AND |`, `ORDER BY |`, `SELECT |`.
    const lastWord = text
      .slice(0, safeCursor)
      .match(/([A-Za-z]+)\s+$/)?.[1]
      ?.toLowerCase();
    return context.mode === "field" && !!lastWord && FIELD_LIST_STARTERS.has(lastWord);
  }
  return false;
}

export function getMongoSqlCompletionResultValidFor(): RegExp {
  return /^[A-Za-z0-9_$.]*$/;
}

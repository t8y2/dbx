// Completion for the MongoDB SQL mode (see lib/mongo/mongoSql.ts).
//
// A pure library like lib/soql/soqlCompletion.ts: a small tokenizer reads the
// statement around the cursor the way the SQL → shell compiler does, and a
// builder turns the collections and sampled field paths the shell mode already
// loads into completion items. Only what the compiler accepts at the cursor's
// position is offered.
//
// Grammar mirrored from mongoSql.ts:
//   SELECT [DISTINCT] items FROM t [ [INNER|LEFT] JOIN t ON a = b ]* [WHERE e]
//          [GROUP BY f, …] [HAVING e] [ORDER BY f [ASC|DESC], …] [LIMIT n] [OFFSET n]
//   INSERT INTO t (cols) VALUES (…), …
//   UPDATE t SET f = v, … [WHERE e]
//   DELETE FROM t [WHERE e]
// where t is `collection`, `database.collection`, or a quoted name (`a.b` in
// backticks / double quotes is one collection name containing a dot).

import type { MongoCompletionField, MongoCompletionItem } from "@/lib/mongo/mongoCompletion";

export type MongoSqlCompletionMode = "none" | "statement" | "collection" | "field" | "keyword";

export type MongoSqlStatementKind = "select" | "insert" | "update" | "delete";

export type MongoSqlClause = "select" | "from" | "join" | "on" | "where" | "groupby" | "having" | "orderby" | "limit" | "set" | "into" | "values" | null;

export interface MongoSqlCollectionRef {
  collection: string;
  /** Database qualifier (`archive.users`); undefined = the tab's database. */
  database?: string;
  alias?: string;
}

export interface MongoSqlCompletionContext {
  mode: MongoSqlCompletionMode;
  /** Identifier text being completed (after any `alias.` / `database.`). */
  prefix: string;
  /** Document position where the replacement starts. */
  from: number;
  /** Document position where the replacement ends (rest of the word under the cursor). */
  to: number;
  statement: MongoSqlStatementKind | null;
  clause: MongoSqlClause;
  /** FROM / UPDATE / INSERT INTO / DELETE FROM target. */
  base?: MongoSqlCollectionRef;
  /** Joined collections, for `alias.field` items. */
  joins: MongoSqlCollectionRef[];
  /** Set when the user typed `alias.`: fields of that collection only. */
  qualifier?: MongoSqlCollectionRef;
  /** Collection mode: list collections of this database (from a typed `database.`). */
  collectionDatabase?: string;
  /** Keyword mode: exactly the keywords the compiler accepts here. */
  keywords?: string[];
  /** SELECT … AS names, usable in HAVING and ORDER BY. */
  selectAliases: string[];
  /** Field mode right after SELECT / SELECT DISTINCT: `*` is allowed here. */
  selectListStart?: boolean;
}

export interface MongoSqlCompletionInput {
  collections?: string[];
  /** Sampled field paths per collection, keyed by mongoSqlCollectionKey(). */
  fields?: Map<string, MongoCompletionField[]>;
}

/** Map key for one collection's fields (database-qualified collections are distinct). */
export function mongoSqlCollectionKey(ref: Pick<MongoSqlCollectionRef, "collection" | "database">): string {
  return `${ref.database ?? ""}\u0000${ref.collection}`;
}

const WORD = /[A-Za-z0-9_$]/;
const IDENT_SEGMENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const STATEMENT_KEYWORDS: Array<{ label: string; detail: string; boost: number }> = [
  { label: "SELECT", detail: "find / aggregate", boost: 100 },
  { label: "SELECT DISTINCT", detail: "$group on columns", boost: 92 },
  { label: "INSERT INTO", detail: "insertMany", boost: 80 },
  { label: "UPDATE", detail: "updateMany", boost: 78 },
  { label: "DELETE FROM", detail: "deleteMany", boost: 76 },
];

const CONDITION_KEYWORDS = ["AND", "OR", "NOT", "IN", "NOT IN", "LIKE", "NOT LIKE", "ILIKE", "BETWEEN", "IS NULL", "IS NOT NULL", "TRUE", "FALSE", "NULL"];

const AGGREGATES: Array<{ label: string; apply: string; detail: string }> = [
  { label: "COUNT(*)", apply: "COUNT(*)", detail: "$sum: 1" },
  { label: "COUNT", apply: "COUNT()", detail: "count non-null" },
  { label: "SUM", apply: "SUM()", detail: "$sum" },
  { label: "AVG", apply: "AVG()", detail: "$avg" },
  { label: "MIN", apply: "MIN()", detail: "$min" },
  { label: "MAX", apply: "MAX()", detail: "$max" },
];
const AGGREGATE_NAMES = new Set(["count", "sum", "avg", "min", "max"]);

const VALUE_CONSTRUCTORS: Array<{ label: string; apply: string; detail: string }> = [
  { label: "ObjectId('')", apply: "ObjectId('')", detail: "ObjectId value" },
  { label: "ISODate('')", apply: "ISODate('')", detail: "Date value" },
];

/** Words that end a table reference instead of being its alias (as in mongoSql.ts). */
const NOT_AN_ALIAS = new Set(["where", "join", "inner", "left", "right", "full", "cross", "on", "group", "order", "limit", "offset", "set", "values", "having", "as"]);

// SELECT clauses in order; after a clause only the later ones may follow.
const SELECT_TAIL_ORDER = ["WHERE", "GROUP BY", "HAVING", "ORDER BY", "LIMIT", "OFFSET"];

interface Token {
  kind: "word" | "quoted" | "number" | "op";
  text: string;
  /** Identifier value (quotes removed) for word / quoted tokens. */
  value: string;
  start: number;
  end: number;
}

/** Comments blanked out (same length), so scans never look inside them. */
function maskComments(text: string): string {
  let out = "";
  let index = 0;
  let quote: string | null = null;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (quote) {
      out += char;
      if (char === "\\" && quote === "'" && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === quote) quote = null;
      index++;
      continue;
    }
    if (char === "'" || char === "`" || char === '"') {
      quote = char;
      out += char;
      index++;
      continue;
    }
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
    out += char;
    index++;
  }
  return out;
}

/** Tokens of `text` (comments already masked); single-quoted strings become one opaque token. */
function tokenize(text: string, offset = 0): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      index++;
      continue;
    }
    const start = index;
    if (char === "'") {
      index++;
      while (index < text.length && text[index] !== "'") index += text[index] === "\\" ? 2 : 1;
      index = Math.min(index + 1, text.length);
      tokens.push({ kind: "op", text: "'", value: "", start: start + offset, end: index + offset });
      continue;
    }
    if (char === "`" || char === '"') {
      index++;
      while (index < text.length && text[index] !== char) index++;
      const value = text.slice(start + 1, index);
      index = Math.min(index + 1, text.length);
      tokens.push({ kind: "quoted", text: text.slice(start, index), value, start: start + offset, end: index + offset });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      while (index < text.length && WORD.test(text[index]!)) index++;
      const word = text.slice(start, index);
      tokens.push({ kind: "word", text: word, value: word, start: start + offset, end: index + offset });
      continue;
    }
    if (/\d/.test(char)) {
      while (index < text.length && /[\d.]/.test(text[index]!)) index++;
      tokens.push({ kind: "number", text: text.slice(start, index), value: "", start: start + offset, end: index + offset });
      continue;
    }
    const two = text.slice(index, index + 2);
    const op = ["<=", ">=", "<>", "!="].includes(two) ? two : char;
    index += op.length;
    tokens.push({ kind: "op", text: op, value: "", start: start + offset, end: index + offset });
  }
  return tokens;
}

const isIdent = (token: Token | undefined): token is Token => !!token && (token.kind === "word" || token.kind === "quoted");
const keywordOf = (token: Token | undefined) => (token?.kind === "word" ? token.text.toLowerCase() : undefined);

interface TableRefSpan {
  ref: MongoSqlCollectionRef;
  /** Index of the token that introduced it (FROM / JOIN / UPDATE / INTO). */
  introducer: number;
  /** Index of its last token (collection or alias). */
  last: number;
  isJoin: boolean;
}

/** A table reference starting at tokens[index], read like Parser.parseTableRef. */
function readTableRef(tokens: Token[], index: number, introducer: number, isJoin: boolean): TableRefSpan | undefined {
  const first = tokens[index];
  if (!isIdent(first)) return undefined;
  let ref: MongoSqlCollectionRef = { collection: first.value };
  let last = index;
  if (tokens[index + 1]?.text === "." && isIdent(tokens[index + 2])) {
    ref = { database: first.value, collection: tokens[index + 2]!.value };
    last = index + 2;
  }
  let aliasIndex = last + 1;
  if (keywordOf(tokens[aliasIndex]) === "as") aliasIndex++;
  const alias = tokens[aliasIndex];
  if (isIdent(alias) && !(alias.kind === "word" && NOT_AN_ALIAS.has(alias.text.toLowerCase()))) {
    ref.alias = alias.value;
    last = aliasIndex;
  }
  return { ref, introducer, last, isJoin };
}

function statementTableRefs(tokens: Token[]): TableRefSpan[] {
  const refs: TableRefSpan[] = [];
  tokens.forEach((token, index) => {
    const keyword = keywordOf(token);
    const previous = keywordOf(tokens[index - 1]);
    let span: TableRefSpan | undefined;
    if (keyword === "from" || keyword === "update" || (keyword === "into" && previous === "insert")) span = readTableRef(tokens, index + 1, index, false);
    else if (keyword === "join") span = readTableRef(tokens, index + 1, index, true);
    if (span) refs.push(span);
  });
  return refs;
}

const joinRefs = (refs: TableRefSpan[]) => refs.filter((span) => span.isJoin).map((span) => ({ ...span.ref, alias: span.ref.alias ?? span.ref.collection }));

/** FROM / JOIN / UPDATE / INSERT INTO / DELETE FROM targets of one statement. */
export function mongoSqlStatementCollections(statement: string): { base?: MongoSqlCollectionRef; joins: MongoSqlCollectionRef[] } {
  const refs = statementTableRefs(tokenize(maskComments(statement)));
  return { base: refs.find((span) => !span.isJoin)?.ref, joins: joinRefs(refs) };
}

/** True when the cursor sits inside an unclosed string, quoted identifier or line comment. */
function insideQuote(text: string, cursor: number): boolean {
  let quote: string | null = null;
  for (let index = 0; index < cursor; index++) {
    const char = text[index]!;
    if (quote) {
      if (char === "\\" && quote === "'") index++;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === "`" || char === '"') quote = char;
    else if (char === "-" && text[index + 1] === "-") {
      const end = text.indexOf("\n", index);
      if (end < 0 || end >= cursor) return true;
      index = end;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end < 0 || end + 2 > cursor) return true;
      index = end + 1;
    }
  }
  return quote !== null;
}

function statementBounds(masked: string, cursor: number): { start: number; end: number } {
  // A `;` inside a string does not end the statement.
  let start = 0;
  let end = masked.length;
  let quote: string | null = null;
  for (let index = 0; index < masked.length; index++) {
    const char = masked[index]!;
    if (quote) {
      if (char === "\\" && quote === "'") index++;
      else if (char === quote) quote = null;
    } else if (char === "'" || char === "`" || char === '"') quote = char;
    else if (char === ";") {
      if (index < cursor) start = index + 1;
      else {
        end = index;
        break;
      }
    }
  }
  return { start, end };
}

/** The clause the cursor is in: the last clause keyword before it. */
function clauseAt(tokens: Token[]): MongoSqlClause {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const keyword = keywordOf(tokens[index]);
    const before = keywordOf(tokens[index - 1]);
    if (keyword === "by" && (before === "group" || before === "order")) return before === "group" ? "groupby" : "orderby";
    switch (keyword) {
      case "select":
        return "select";
      case "from":
      case "update":
        return "from";
      case "join":
        return "join";
      case "on":
        return "on";
      case "where":
        return "where";
      case "having":
        return "having";
      case "limit":
      case "offset":
        return "limit";
      case "set":
        return "set";
      case "into":
        return "into";
      case "values":
        return "values";
    }
  }
  return null;
}

/** SELECT clauses that may still follow the last one present before the cursor. */
function selectTail(before: Token[], all: Token[]): string[] {
  let reached = -1;
  before.forEach((token, index) => {
    const keyword = keywordOf(token);
    const label = keyword === "by" ? `${keywordOf(before[index - 1])?.toUpperCase()} BY` : keyword?.toUpperCase();
    const position = label ? SELECT_TAIL_ORDER.indexOf(label) : -1;
    if (position > reached) reached = position;
  });
  // HAVING needs GROUP BY, DISTINCT or an aggregate in the SELECT list (Parser.finishSelect).
  const grouped = all.some((token, index) => keywordOf(token) === "by" && keywordOf(all[index - 1]) === "group") || keywordOf(all[1]) === "distinct" || all.some((token, index) => AGGREGATE_NAMES.has(keywordOf(token) ?? "") && all[index + 1]?.text === "(");
  return SELECT_TAIL_ORDER.slice(reached + 1).filter((label) => label !== "HAVING" || grouped);
}

function selectAliases(tokens: Token[]): string[] {
  const fromIndex = tokens.findIndex((token) => keywordOf(token) === "from");
  const selectList = fromIndex < 0 ? tokens : tokens.slice(0, fromIndex);
  const aliases: string[] = [];
  selectList.forEach((token, index) => {
    if (keywordOf(token) === "as" && isIdent(selectList[index + 1])) aliases.push(selectList[index + 1]!.value);
  });
  return aliases;
}

export function getMongoSqlCompletionContext(text: string, cursor: number): MongoSqlCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const none: MongoSqlCompletionContext = { mode: "none", prefix: "", from: safeCursor, to: safeCursor, statement: null, clause: null, joins: [], selectAliases: [] };
  if (insideQuote(text, safeCursor)) return none;
  const masked = maskComments(text);
  const { start, end } = statementBounds(masked, safeCursor);

  // Word (possibly dotted) under the cursor.
  let wordStart = safeCursor;
  while (wordStart > start && (WORD.test(masked[wordStart - 1]!) || masked[wordStart - 1] === ".")) wordStart--;
  let wordEnd = safeCursor;
  while (wordEnd < end && WORD.test(masked[wordEnd]!)) wordEnd++;
  const typed = text.slice(wordStart, safeCursor);
  if (/^\d/.test(typed)) return none;

  const allTokens = tokenize(masked.slice(start, end), start);
  const tokens = allTokens.filter((token) => token.end <= wordStart);
  const statement = (["select", "insert", "update", "delete"] as const).find((kind) => kind === keywordOf(allTokens[0])) ?? null;
  // Targets as written in the whole statement, except a word still being typed right after one.
  const statementTokens = allTokens.filter((token) => token.end <= wordStart || token.start >= wordEnd);
  const refs = statementTableRefs(statementTokens);
  const baseRef = refs.find((span) => !span.isJoin)?.ref;
  const joins = joinRefs(refs);
  const clause = clauseAt(tokens);
  const aliases = statement === "select" ? selectAliases(allTokens) : [];
  const context = (mode: MongoSqlCompletionMode, extra: Partial<MongoSqlCompletionContext> = {}): MongoSqlCompletionContext => ({
    mode,
    prefix: typed,
    from: wordStart,
    to: wordEnd,
    statement,
    clause,
    base: baseRef,
    joins,
    selectAliases: aliases,
    ...extra,
  });

  if (tokens.length === 0) return context("statement");
  const previous = tokens[tokens.length - 1]!;
  const previousKeyword = keywordOf(previous);

  // Collection right after FROM / JOIN / UPDATE / INSERT INTO; `database.` lists that database.
  const introducesTable = previousKeyword === "from" || previousKeyword === "join" || previousKeyword === "update" || (previousKeyword === "into" && keywordOf(tokens[tokens.length - 2]) === "insert");
  if (introducesTable) {
    const dot = typed.indexOf(".");
    if (dot > 0) return context("collection", { collectionDatabase: typed.slice(0, dot), prefix: typed.slice(dot + 1), from: wordStart + dot + 1 });
    return context("collection");
  }
  // `FROM \`archive\`.|` — a quoted database name followed by a dot.
  if (previous.text === "." && isIdent(tokens[tokens.length - 2]) && keywordOf(tokens[tokens.length - 3]) && ["from", "join", "update", "into"].includes(keywordOf(tokens[tokens.length - 3])!)) {
    return context("collection", { collectionDatabase: tokens[tokens.length - 2]!.value });
  }

  // Just after a complete table reference: the keywords that may follow it.
  const beforeRefs = statementTableRefs(tokens);
  const finishedRef = beforeRefs.find((span) => tokens.length - 1 === span.last);
  if (finishedRef && !typed.includes(".")) {
    if (finishedRef.isJoin) return context("keyword", { keywords: ["ON"] });
    if (statement === "select") return context("keyword", { keywords: ["INNER JOIN", "LEFT JOIN", ...selectTail(tokens, allTokens)] });
    if (statement === "update") return context("keyword", { keywords: ["SET"] });
    if (statement === "delete") return context("keyword", { keywords: ["WHERE"] });
    return none; // INSERT INTO t needs a column list next
  }
  if (clause === "from" || clause === "join" || clause === "limit" || clause === "values") return none;

  // INSERT INTO t (a, b, |) VALUES … : columns inside the first parentheses, then VALUES.
  if (statement === "insert") {
    const open = tokens.findIndex((token) => token.text === "(");
    const close = tokens.findIndex((token) => token.text === ")");
    if (open >= 0 && close < 0 && (previous.text === "(" || previous.text === ",")) return context("field", { clause: "into" });
    if (close >= 0 && previous.text === ")" && clause === "into") return context("keyword", { keywords: ["VALUES"] });
    return none;
  }

  // ON a.x = b.y — once the equality is complete, more JOINs or the SELECT tail follow.
  if (clause === "on") {
    const onIndex = tokens.map((token) => keywordOf(token)).lastIndexOf("on");
    const onTokens = tokens.slice(onIndex + 1);
    const equals = onTokens.findIndex((token) => token.text === "=");
    if (equals >= 0 && equals < onTokens.length - 1 && isIdent(previous)) {
      return context("keyword", { keywords: ["INNER JOIN", "LEFT JOIN", ...selectTail(tokens, allTokens)] });
    }
  }

  // ORDER BY f |  → ASC / DESC and later clauses; after ASC / DESC only `,` or later clauses.
  if (clause === "orderby" && !typed.includes(".")) {
    if (previousKeyword === "asc" || previousKeyword === "desc") return context("keyword", { keywords: ["LIMIT", "OFFSET"] });
    if (isIdent(previous) && previousKeyword !== "by") return context("keyword", { keywords: ["ASC", "DESC", "LIMIT", "OFFSET"] });
  }

  // GROUP BY f |  → later clauses.
  if (clause === "groupby" && isIdent(previous) && previousKeyword !== "by" && !typed.includes(".")) {
    return context("keyword", { keywords: selectTail(tokens, allTokens) });
  }

  // `alias.` / `collection.` qualifies the field.
  const dot = typed.indexOf(".");
  if (dot > 0) {
    const head = typed.slice(0, dot).toLowerCase();
    const qualifier = joins.find((join) => join.alias?.toLowerCase() === head || join.collection.toLowerCase() === head) ?? (baseRef && (head === baseRef.collection.toLowerCase() || head === baseRef.alias?.toLowerCase()) ? baseRef : undefined);
    if (qualifier) return context("field", { qualifier, prefix: typed.slice(dot + 1), from: wordStart + dot + 1 });
  }
  return context("field", { selectListStart: clause === "select" && previousKeyword === "select" });
}

function quoteFieldPath(path: string): string {
  return path
    .split(".")
    .map((segment) => (IDENT_SEGMENT.test(segment) ? segment : `\`${segment.replace(/`/g, "")}\``))
    .join(".");
}

/** A collection name as the compiler reads it: dotted or odd names must be quoted to stay one name. */
export function quoteMongoSqlCollection(name: string): string {
  return IDENT_SEGMENT.test(name) ? name : `\`${name.replace(/`/g, "")}\``;
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
      items.push({ label: collection, type: "table", detail: context.collectionDatabase ? `collection · ${context.collectionDatabase}` : "collection", boost: 90, apply: quoteMongoSqlCollection(collection) });
    }
    return items;
  }

  if (context.mode === "keyword") {
    (context.keywords ?? []).forEach((label, index) => items.push(keywordItem(label, "clause", 90 - index)));
    return items;
  }

  // Field mode.
  const fieldsOf = (ref: MongoSqlCollectionRef) => input.fields?.get(mongoSqlCollectionKey(ref)) ?? [];
  const describe = (ref: MongoSqlCollectionRef) => (ref.database ? `${ref.database}.${ref.collection}` : ref.collection);
  if (context.qualifier) {
    for (const field of fieldsOf(context.qualifier)) items.push({ label: field.name, type: "column", detail: field.type, boost: 95, apply: quoteFieldPath(field.name) });
    return items;
  }
  const clause = context.clause;
  const singleCollection = clause === "set" || clause === "into" || context.statement !== "select";
  if (context.base) {
    for (const field of fieldsOf(context.base)) {
      items.push({ label: field.name, type: "column", detail: field.type ? `${field.type} · ${describe(context.base)}` : describe(context.base), boost: 95, apply: quoteFieldPath(field.name) });
    }
  }
  if (!singleCollection) {
    for (const join of context.joins) {
      const alias = join.alias ?? join.collection;
      for (const field of fieldsOf(join)) {
        items.push({ label: `${alias}.${field.name}`, type: "column", detail: field.type ? `${field.type} · ${describe(join)}` : describe(join), boost: 85, apply: `${quoteFieldPath(alias)}.${quoteFieldPath(field.name)}` });
      }
    }
  }

  const tail = (labels: string[]) => labels.forEach((label) => items.push(keywordItem(label, "clause", 40)));
  const aggregates = () => AGGREGATES.forEach((fn) => items.push({ label: fn.label, type: "function", detail: fn.detail, boost: 60, apply: fn.apply }));
  const aliases = () => context.selectAliases.forEach((alias) => items.push({ label: alias, type: "column", detail: "alias", boost: 97, apply: alias }));
  const conditions = () => CONDITION_KEYWORDS.forEach((label, index) => items.push(keywordItem(label, "condition", 50 - index)));
  const constructors = () => VALUE_CONSTRUCTORS.forEach((ctor) => items.push({ label: ctor.label, type: "function", detail: ctor.detail, boost: 45, apply: ctor.apply }));

  switch (clause) {
    case "select":
      aggregates();
      items.push(keywordItem("FROM", "collection", 70), keywordItem("AS", "alias", 55));
      if (context.selectListStart) items.push({ label: "*", type: "keyword", detail: "all fields", boost: 50, apply: "* " });
      break;
    case "where":
      conditions();
      constructors();
      if (context.statement === "select") tail(["GROUP BY", "ORDER BY", "LIMIT", "OFFSET"]);
      break;
    case "having":
      aliases();
      aggregates();
      conditions();
      tail(["ORDER BY", "LIMIT", "OFFSET"]);
      break;
    case "orderby":
      // ORDER BY takes a column or SELECT alias — aggregates are rejected by the compiler.
      aliases();
      break;
    case "set":
      constructors();
      items.push(keywordItem("WHERE", "clause", 40));
      break;
    default:
      // ON / GROUP BY / INSERT column list: fields only.
      break;
  }
  return items;
}

/** Collections whose fields a field-mode context needs. */
export function mongoSqlCompletionCollections(context: MongoSqlCompletionContext): MongoSqlCollectionRef[] {
  if (context.mode !== "field") return [];
  if (context.qualifier) return [context.qualifier];
  const singleCollection = context.clause === "set" || context.clause === "into" || context.statement !== "select";
  const refs = [context.base, ...(singleCollection ? [] : context.joins)].filter((ref): ref is MongoSqlCollectionRef => !!ref);
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = mongoSqlCollectionKey(ref);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const FIELD_LIST_STARTERS = new Set(["select", "where", "and", "or", "not", "by", "on", "set", "having", "distinct"]);

/** Open automatically while typing a word, after `.`, and after FROM / JOIN / UPDATE / INTO / WHERE / AND / BY + space. */
export function shouldAutoOpenMongoSqlCompletion(text: string, cursor: number): boolean {
  const safeCursor = Math.max(0, Math.min(cursor, text.length));
  const previous = text[safeCursor - 1];
  if (!previous) return false;
  if (insideQuote(text, safeCursor)) return false;
  if (previous === ".") return true;
  if (WORD.test(previous)) return !/^\d+$/.test(text.slice(0, safeCursor).match(/[A-Za-z0-9_$]+$/)?.[0] ?? "");
  if (/\s/.test(previous)) {
    const context = getMongoSqlCompletionContext(text, safeCursor);
    if (context.mode === "collection") return true;
    const lastWord = text
      .slice(0, safeCursor)
      .match(/([A-Za-z]+)\s+$/)?.[1]
      ?.toLowerCase();
    return context.mode === "field" && !!lastWord && FIELD_LIST_STARTERS.has(lastWord);
  }
  return false;
}

export function getMongoSqlCompletionResultValidFor(): RegExp {
  return /^[A-Za-z0-9_$]*$/;
}

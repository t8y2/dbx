import type { DatabaseType } from "@/types/database";
import { splitMongoCommandRanges } from "@/lib/mongo/mongoShellCommand";
import { splitSqlStatementRanges } from "@/lib/sql/sqlStatementRanges";

/**
 * Opt-in SQL language for a MongoDB query tab.
 * Absent or "shell" keeps the mongo-shell editor.
 */
export type MongoQueryLanguage = "shell" | "sql";

/**
 * SQL → mongo-shell for the subset described in issue #11929.
 *
 * The published `@queryleaf/lib` package is AGPL-3.0, which cannot be linked
 * into this Apache-2.0 app, and `node-sql-parser` unpacks to tens of megabytes.
 * This compiler covers the same shell shapes (find / aggregate / insertMany /
 * updateMany / deleteMany) and rejects everything outside that subset.
 *
 * `!=` becomes `$ne`, which also matches documents where the field is missing.
 * Array-index projections use `$getField` and `$arrayElemAt`, which need MongoDB 4.4 or newer.
 * Negative array indexes are rejected in WHERE, ORDER BY, GROUP BY, and UPDATE.
 * A SELECT projection can still pass a negative index to `$arrayElemAt`.
 */

export class MongoSqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MongoSqlError";
  }
}

export function mongoSqlModeActive(databaseType: string | undefined, language: MongoQueryLanguage | undefined): boolean {
  return databaseType === "mongodb" && language === "sql";
}

/** Statement splitter dialect. SQL mode must not use the mongo-shell splitter. */
export function queryEditorStatementDatabaseType(databaseType: DatabaseType | undefined, language: MongoQueryLanguage | undefined): DatabaseType | undefined {
  if (mongoSqlModeActive(databaseType, language)) return undefined;
  return databaseType;
}

export function prepareMongoQueryText(sql: string, language: MongoQueryLanguage | undefined, databaseType: string | undefined, generatedShell?: string): { sql: string; generatedShell?: string } {
  if (!mongoSqlModeActive(databaseType, language)) return { sql };
  // Pagination and refresh re-run the shell command already produced here.
  // Any other shell text is SQL and must fail, instead of being executed as written.
  if (generatedShell !== undefined && sql === generatedShell && splitMongoCommandRanges(sql).length > 0) return { sql };
  const translated = translateMongoSqlScript(sql);
  return { sql: translated, generatedShell: translated };
}

export function translateMongoSqlScript(sql: string): string {
  const statements = splitSqlStatementRanges(sql)
    .map((range) => range.sql.trim())
    .filter((statement) => statement.length > 0);
  if (statements.length === 0) throw new MongoSqlError("Enter a SQL statement to run against MongoDB.");
  return statements.map(translateMongoSqlStatement).join("\n");
}

class ShellCtor {
  constructor(
    readonly name: "ObjectId" | "ISODate",
    readonly arg: string,
  ) {}
}

type ShellValue = null | boolean | number | string | ShellCtor | ShellValue[] | { [key: string]: ShellValue };

interface FieldPart {
  name: string;
  indexes: number[];
}

interface FieldRef {
  parts: FieldPart[];
}

type Expr =
  | { type: "cmp"; op: "=" | "!=" | ">" | "<" | ">=" | "<="; left: Primary; right: Primary }
  | { type: "and" | "or"; items: Expr[] }
  | { type: "not"; item: Expr }
  | { type: "in"; field: FieldRef; values: ShellValue[]; negated: boolean }
  | { type: "between"; field: FieldRef; low: ShellValue; high: ShellValue; negated: boolean }
  | { type: "null"; field: FieldRef; negated: boolean }
  | { type: "like"; field: FieldRef; pattern: string; insensitive: boolean; negated: boolean };

type Primary = { type: "field"; field: FieldRef } | { type: "value"; value: ShellValue };

interface SelectItem {
  type: "star" | "field" | "agg";
  field?: FieldRef;
  fn?: "count" | "sum" | "avg" | "min" | "max";
  star?: boolean;
  alias?: string;
}

interface TableRef {
  collection: string;
  database?: string;
  alias?: string;
}

interface Join {
  kind: "inner" | "left";
  table: TableRef;
  local: FieldRef;
  foreign: FieldRef;
}

interface OrderKey {
  field: FieldRef;
  direction: 1 | -1;
}

type Tok =
  | { kind: "ident"; text: string }
  | { kind: "string"; text: string }
  | { kind: "number"; value: number }
  | { kind: "op"; text: string }
  | { kind: "eof" };

const RESERVED = new Set(
  "select from where group by order limit offset insert into values update set delete as join inner left right full cross outer on and or not in is null like ilike between union intersect except with distinct having over window true false".split(" "),
);

function translateMongoSqlStatement(sql: string): string {
  const parser = new Parser(sql);
  const keyword = parser.peekKeyword();
  if (keyword === "select") return parser.parseSelect();
  if (keyword === "insert") return parser.parseInsert();
  if (keyword === "update") return parser.parseUpdate();
  if (keyword === "delete") return parser.parseDelete();
  if (keyword === "with") throw new MongoSqlError("WITH queries are not supported in MongoDB SQL mode.");
  throw new MongoSqlError("Only SELECT, INSERT, UPDATE, and DELETE are supported in MongoDB SQL mode.");
}

class Parser {
  private readonly tokens: Tok[];
  private index = 0;

  constructor(sql: string) {
    this.tokens = tokenize(sql);
  }

  parseSelect(): string {
    this.expectKeyword("select");
    if (this.eatKeyword("distinct")) throw new MongoSqlError("DISTINCT is not supported in MongoDB SQL mode.");
    const items = this.parseSelectList();
    this.expectKeyword("from");
    const from = this.parseTableRef();
    const joins: Join[] = [];
    while (this.canStartJoin()) joins.push(this.parseJoin(from));
    const where = this.eatKeyword("where") ? this.parseExpr() : undefined;
    return this.finishSelect(items, from, joins, where);
  }

  private finishSelect(items: SelectItem[], from: TableRef, joins: Join[], where: Expr | undefined): string {
    let groupBy: FieldRef[] | undefined;
    if (this.atKeyword("group")) {
      this.expectKeyword("group");
      this.expectKeyword("by");
      groupBy = this.parseFieldList();
    }
    if (this.eatKeyword("having")) throw new MongoSqlError("HAVING is not supported in MongoDB SQL mode. Filter rows with WHERE before grouping.");
    const orderBy = this.eatKeyword("order") ? (this.expectKeyword("by"), this.parseOrderBy()) : [];
    const limit = this.eatKeyword("limit") ? this.parseInteger("LIMIT") : undefined;
    const offset = this.eatKeyword("offset") ? this.parseInteger("OFFSET") : undefined;
    this.expectEnd();
    return compileSelect(items, from, joins, where, groupBy, orderBy, limit, offset);
  }

  parseInsert(): string {
    this.expectKeyword("insert");
    this.expectKeyword("into");
    const table = this.parseTableRef();
    this.expectOp("(");
    const columns = this.parseIdentList();
    this.expectOp(")");
    this.expectKeyword("values");
    const rows: ShellValue[][] = [];
    do {
      this.expectOp("(");
      const values: ShellValue[] = [];
      do values.push(this.parseLiteral());
      while (this.eatOp(","));
      this.expectOp(")");
      if (values.length !== columns.length) throw new MongoSqlError("INSERT column count does not match the VALUES row.");
      rows.push(values);
    } while (this.eatOp(","));
    this.expectEnd();
    const documents = rows.map((values) => {
      const document: Record<string, ShellValue> = {};
      columns.forEach((column, index) => {
        document[column] = values[index]!;
      });
      return document;
    });
    return mongoCall(table, "insertMany", printShell(documents));
  }

  parseUpdate(): string {
    this.expectKeyword("update");
    const table = this.parseTableRef();
    this.expectKeyword("set");
    const set: Record<string, ShellValue> = {};
    const aliases = aliasMap(table, []);
    do {
      const field = this.parseFieldRef();
      this.expectOp("=");
      rejectNegativeIndex(field, "UPDATE");
      set[qualifiedPath(fieldPath(field, aliases, table))] = this.parseLiteral();
    } while (this.eatOp(","));
    const where = this.eatKeyword("where") ? this.parseExpr() : undefined;
    this.expectEnd();
    const filter = where ? exprToFilter(where, aliasMap(table, [])) : {};
    return mongoCall(table, "updateMany", `${printShell(filter)}, ${printShell({ $set: set })}`);
  }

  parseDelete(): string {
    this.expectKeyword("delete");
    this.expectKeyword("from");
    const table = this.parseTableRef();
    const where = this.eatKeyword("where") ? this.parseExpr() : undefined;
    this.expectEnd();
    const filter = where ? exprToFilter(where, aliasMap(table, [])) : {};
    return mongoCall(table, "deleteMany", printShell(filter));
  }

  private parseSelectList(): SelectItem[] {
    const items: SelectItem[] = [];
    do items.push(this.parseSelectItem());
    while (this.eatOp(","));
    return items;
  }

  private parseSelectItem(): SelectItem {
    if (this.eatOp("*")) return { type: "star" };
    if (this.peek().kind === "ident" && this.lookaheadIsOp("(")) {
      const name = this.nextIdent().toLowerCase();
      this.expectOp("(");
      if (name === "count" && this.eatOp("*")) {
        this.expectOp(")");
        return { type: "agg", fn: "count", star: true, alias: this.parseOptionalAlias() };
      }
      if (name === "count" || name === "sum" || name === "avg" || name === "min" || name === "max") {
        const field = this.parseFieldRef();
        this.expectOp(")");
        return { type: "agg", fn: name, field, alias: this.parseOptionalAlias() };
      }
      this.skipUntilMatchingParen();
      throw new MongoSqlError(`Function ${name.toUpperCase()}() is not supported in MongoDB SQL mode.`);
    }
    const field = this.parseFieldRef();
    return { type: "field", field, alias: this.parseOptionalAlias() };
  }

  private parseOptionalAlias(): string | undefined {
    if (this.eatKeyword("as")) return this.nextIdent();
    if (this.peek().kind === "ident" && !RESERVED.has(this.peekText())) return this.nextIdent();
    return undefined;
  }

  private parseTableRef(): TableRef {
    const first = this.nextIdent();
    if (this.eatOp(".")) {
      const collection = this.nextIdent();
      return { database: first, collection, alias: this.parseOptionalAlias() };
    }
    return { collection: first, alias: this.parseOptionalAlias() };
  }

  private canStartJoin(): boolean {
    const keyword = this.peekKeyword();
    return keyword === "join" || keyword === "inner" || keyword === "left" || keyword === "right" || keyword === "full" || keyword === "cross";
  }

  private parseJoin(base: TableRef): Join {
    let kind: Join["kind"] = "inner";
    if (this.eatKeyword("inner")) this.expectKeyword("join");
    else if (this.eatKeyword("left")) {
      this.eatKeyword("outer");
      this.expectKeyword("join");
      kind = "left";
    } else if (this.eatKeyword("join")) kind = "inner";
    else if (this.atKeyword("right") || this.atKeyword("full") || this.atKeyword("cross")) {
      throw new MongoSqlError("Only INNER JOIN and LEFT JOIN are supported in MongoDB SQL mode.");
    }
    const table = this.parseTableRef();
    if (!table.alias) table.alias = table.collection;
    this.expectKeyword("on");
    const left = this.parseFieldRef();
    this.expectOp("=");
    const right = this.parseFieldRef();
    const baseNames = new Set([base.alias?.toLowerCase(), base.collection.toLowerCase()].filter((name): name is string => !!name));
    const joinNames = new Set([table.alias?.toLowerCase(), table.collection.toLowerCase()].filter((name): name is string => !!name));
    const leftOwner = left.parts[0]?.name.toLowerCase();
    const rightOwner = right.parts[0]?.name.toLowerCase();
    const local = baseNames.has(leftOwner ?? "") ? left : baseNames.has(rightOwner ?? "") ? right : undefined;
    const foreign = joinNames.has(leftOwner ?? "") ? left : joinNames.has(rightOwner ?? "") ? right : undefined;
    if (!local || !foreign || local === foreign) {
      throw new MongoSqlError("JOIN only supports an equality between a base-collection field and a joined-collection field.");
    }
    return { kind, table, local, foreign };
  }

  private parseOrderBy(): OrderKey[] {
    const keys: OrderKey[] = [];
    do {
      const field = this.parseFieldRef();
      let direction: 1 | -1 = 1;
      if (this.eatKeyword("desc")) direction = -1;
      else this.eatKeyword("asc");
      keys.push({ field, direction });
    } while (this.eatOp(","));
    return keys;
  }

  private parseFieldList(): FieldRef[] {
    const fields: FieldRef[] = [];
    do fields.push(this.parseFieldRef());
    while (this.eatOp(","));
    return fields;
  }

  private parseIdentList(): string[] {
    const names: string[] = [];
    do names.push(this.nextIdent());
    while (this.eatOp(","));
    return names;
  }

  private parseExpr(): Expr {
    return this.parseOr();
  }

  private parseOr(): Expr {
    const items = [this.parseAnd()];
    while (this.eatKeyword("or")) items.push(this.parseAnd());
    return items.length === 1 ? items[0]! : { type: "or", items };
  }

  private parseAnd(): Expr {
    const items = [this.parseNot()];
    while (this.eatKeyword("and")) items.push(this.parseNot());
    return items.length === 1 ? items[0]! : { type: "and", items };
  }

  private parseNot(): Expr {
    if (!this.eatKeyword("not")) return this.parsePredicate();
    const item = this.parseNot();
    if (item.type === "in") return { ...item, negated: !item.negated };
    if (item.type === "like") return { ...item, negated: !item.negated };
    if (item.type === "between") return { ...item, negated: !item.negated };
    if (item.type === "null") return { ...item, negated: !item.negated };
    return { type: "not", item };
  }

  private parsePredicate(): Expr {
    if (this.peekKeyword() === "select") throw new MongoSqlError("Subqueries are not supported in MongoDB SQL mode.");
    if (this.eatOp("(")) {
      const inner = this.parseOr();
      this.expectOp(")");
      return inner;
    }
    const left = this.parsePrimary();
    if (this.eatKeyword("is")) {
      const negated = this.eatKeyword("not");
      this.expectKeyword("null");
      if (left.type !== "field") throw new MongoSqlError("IS NULL applies to a field.");
      return { type: "null", field: left.field, negated };
    }
    if (this.eatKeyword("not")) {
      if (this.eatKeyword("in")) return this.finishIn(left, true);
      if (this.eatKeyword("like")) return this.finishLike(left, true);
      if (this.eatKeyword("ilike")) return this.finishLike(left, true, true);
      if (this.eatKeyword("between")) return this.finishBetween(left, true);
      throw new MongoSqlError("NOT must be followed by IN, LIKE, BETWEEN, or a condition.");
    }
    if (this.eatKeyword("in")) return this.finishIn(left, false);
    if (this.eatKeyword("like")) return this.finishLike(left, false);
    if (this.eatKeyword("ilike")) return this.finishLike(left, false, true);
    if (this.eatKeyword("between")) return this.finishBetween(left, false);
    const op = this.peek().kind === "op" ? this.peek().text : undefined;
    if (op === "=" || op === "!=" || op === "<>" || op === ">" || op === "<" || op === ">=" || op === "<=") {
      this.next();
      const right = this.parsePrimary();
      const normalized = op === "<>" ? "!=" : op;
      return { type: "cmp", op: normalized, left, right };
    }
    throw new MongoSqlError("WHERE supports comparisons, AND, OR, NOT, IN, BETWEEN, LIKE, and IS NULL.");
  }

  private finishIn(left: Primary, negated: boolean): Expr {
    if (left.type !== "field") throw new MongoSqlError("IN applies to a field.");
    this.expectOp("(");
    if (this.peekKeyword() === "select") throw new MongoSqlError("Subqueries are not supported in MongoDB SQL mode.");
    const values: ShellValue[] = [];
    if (!this.atOp(")")) {
      do values.push(this.parseLiteral());
      while (this.eatOp(","));
    }
    this.expectOp(")");
    return { type: "in", field: left.field, values, negated };
  }

  private finishLike(left: Primary, negated: boolean, insensitive = false): Expr {
    if (this.peekKeyword() === "ilike") {
      this.next();
      insensitive = true;
    }
    if (left.type !== "field") throw new MongoSqlError("LIKE applies to a field.");
    const pattern = this.parseLiteral();
    if (typeof pattern !== "string") throw new MongoSqlError("LIKE requires a string pattern.");
    return { type: "like", field: left.field, pattern, insensitive, negated };
  }

  private finishBetween(left: Primary, negated: boolean): Expr {
    if (left.type !== "field") throw new MongoSqlError("BETWEEN applies to a field.");
    const low = this.parseLiteral();
    this.expectKeyword("and");
    const high = this.parseLiteral();
    return { type: "between", field: left.field, low, high, negated };
  }

  private parsePrimary(): Primary {
    if (this.peekKeyword() === "select") throw new MongoSqlError("Subqueries are not supported in MongoDB SQL mode.");
    if (this.peek().kind === "ident" && this.lookaheadIsOp("(")) {
      return { type: "value", value: this.parseCtor() };
    }
    if (this.peek().kind === "string" || this.peek().kind === "number" || this.peekKeyword() === "true" || this.peekKeyword() === "false" || this.peekKeyword() === "null") {
      return { type: "value", value: this.parseLiteral() };
    }
    return { type: "field", field: this.parseFieldRef() };
  }

  private parseCtor(): ShellValue {
    const name = this.nextIdent();
    const canonical = name.toLowerCase() === "objectid" ? "ObjectId" : name.toLowerCase() === "isodate" ? "ISODate" : undefined;
    this.expectOp("(");
    const arg = this.parseLiteral();
    this.expectOp(")");
    if (!canonical) throw new MongoSqlError(`Function ${name}() is not supported in MongoDB SQL mode. Use ObjectId('...') or ISODate('...').`);
    if (typeof arg !== "string" || !arg) throw new MongoSqlError(`${canonical}() requires a non-empty string.`);
    if (canonical === "ObjectId" && !/^[a-fA-F0-9]{24}$/.test(arg)) throw new MongoSqlError("ObjectId() requires a 24-character hex string.");
    return new ShellCtor(canonical, arg);
  }

  private parseLiteral(): ShellValue {
    if (this.peek().kind === "ident" && this.lookaheadIsOp("(")) return this.parseCtor();
    const token = this.next();
    if (token.kind === "string") return token.text;
    if (token.kind === "number") return token.value;
    if (token.kind === "ident") {
      const keyword = token.text.toLowerCase();
      if (keyword === "true") return true;
      if (keyword === "false") return false;
      if (keyword === "null") return null;
    }
    throw new MongoSqlError("MongoDB SQL mode only supports literal values here (strings, numbers, true, false, null, ObjectId(), ISODate()).");
  }

  private parseFieldRef(): FieldRef {
    const parts = [this.parseFieldPart()];
    while (this.eatOp(".")) parts.push(this.parseFieldPart());
    return { parts };
  }

  private parseFieldPart(): FieldPart {
    const name = this.nextIdent();
    const indexes: number[] = [];
    while (this.eatOp("[")) {
      indexes.push(this.parseArrayIndex());
      this.expectOp("]");
    }
    return { name, indexes };
  }

  private parseArrayIndex(): number {
    const negative = this.eatOp("-");
    const token = this.next();
    if (token.kind !== "number" || !Number.isInteger(token.value) || token.value < 0) {
      throw new MongoSqlError("Array index requires an integer.");
    }
    return negative ? -token.value : token.value;
  }

  private parseInteger(label: string): number {
    const token = this.next();
    if (token.kind !== "number" || !Number.isInteger(token.value) || token.value < 0) {
      throw new MongoSqlError(`${label} requires a non-negative integer.`);
    }
    return token.value;
  }

  private skipUntilMatchingParen() {
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === "eof") throw new MongoSqlError('Expected ")".');
      if (token.kind === "op" && token.text === "(") depth += 1;
      if (token.kind === "op" && token.text === ")") depth -= 1;
    }
  }

  private expectEnd() {
    if (this.atKeyword("union") || this.atKeyword("intersect") || this.atKeyword("except")) {
      throw new MongoSqlError("UNION, INTERSECT, and EXCEPT are not supported in MongoDB SQL mode.");
    }
    if (this.peek().kind !== "eof") throw new MongoSqlError(`Unexpected ${this.describe(this.peek())} in MongoDB SQL mode.`);
  }

  private peek(): Tok {
    return this.tokens[this.index] ?? { kind: "eof" };
  }

  private next(): Tok {
    const token = this.peek();
    if (token.kind !== "eof") this.index += 1;
    if (token.kind === "op" && token.text === ")" && this.atKeyword("over")) {
      throw new MongoSqlError("Window functions are not supported in MongoDB SQL mode.");
    }
    return token;
  }

  private peekKeyword(): string | undefined {
    const token = this.peek();
    return token.kind === "ident" ? token.text.toLowerCase() : undefined;
  }

  private peekText(): string {
    const token = this.peek();
    return token.kind === "ident" ? token.text.toLowerCase() : "";
  }

  private atKeyword(keyword: string): boolean {
    return this.peekKeyword() === keyword;
  }

  private eatKeyword(keyword: string): boolean {
    if (!this.atKeyword(keyword)) return false;
    this.next();
    return true;
  }

  private expectKeyword(keyword: string) {
    if (!this.eatKeyword(keyword)) throw new MongoSqlError(`Expected ${keyword.toUpperCase()}.`);
  }

  private atOp(op: string): boolean {
    const token = this.peek();
    return token.kind === "op" && token.text === op;
  }

  private eatOp(op: string): boolean {
    if (!this.atOp(op)) return false;
    this.next();
    return true;
  }

  private expectOp(op: string) {
    if (!this.eatOp(op)) throw new MongoSqlError(`Expected "${op}".`);
  }

  private lookaheadIsOp(op: string): boolean {
    const token = this.tokens[this.index + 1];
    return token?.kind === "op" && token.text === op;
  }

  private nextIdent(): string {
    const token = this.next();
    if (token.kind !== "ident") throw new MongoSqlError(`Expected a name, got ${this.describe(token)}.`);
    return token.text;
  }

  private describe(token: Tok): string {
    if (token.kind === "eof") return "end of statement";
    if (token.kind === "ident") return token.text;
    if (token.kind === "string") return JSON.stringify(token.text);
    if (token.kind === "number") return String(token.value);
    return token.text;
  }
}

function tokenize(sql: string): Tok[] {
  const tokens: Tok[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < sql.length && sql[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = Math.min(sql.length, i + 2);
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let text = "";
      while (i < sql.length) {
        if (sql[i] === quote && sql[i + 1] === quote) {
          text += quote;
          i += 2;
          continue;
        }
        if (sql[i] === "\\") {
          text += sql[i + 1] ?? "";
          i += 2;
          continue;
        }
        if (sql[i] === quote) {
          i += 1;
          break;
        }
        text += sql[i];
        i += 1;
      }
      tokens.push(quote === "'" ? { kind: "string", text } : { kind: "ident", text });
      continue;
    }
    if (ch === "`") {
      i += 1;
      let text = "";
      while (i < sql.length && sql[i] !== "`") {
        text += sql[i];
        i += 1;
      }
      i += 1;
      tokens.push({ kind: "ident", text });
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(sql[i + 1] ?? ""))) {
      const start = i;
      i += 1;
      while (i < sql.length && /[0-9]/.test(sql[i]!)) i += 1;
      if (sql[i] === "." && /[0-9]/.test(sql[i + 1] ?? "")) {
        i += 1;
        while (i < sql.length && /[0-9]/.test(sql[i]!)) i += 1;
      }
      const text = sql.slice(start, i);
      const value = Number(text);
      if (!Number.isFinite(value)) throw new MongoSqlError(`Invalid number ${text}.`);
      tokens.push({ kind: "number", value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < sql.length && /[A-Za-z0-9_$]/.test(sql[i]!)) i += 1;
      tokens.push({ kind: "ident", text: sql.slice(start, i) });
      continue;
    }
    const two = sql.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "!=" || two === "<>") {
      tokens.push({ kind: "op", text: two });
      i += 2;
      continue;
    }
    if ("(),.*=>[]".includes(ch) || ch === "<" || ch === "-") {
      tokens.push({ kind: "op", text: ch });
      i += 1;
      continue;
    }
    throw new MongoSqlError(`Unexpected character ${JSON.stringify(ch)} in MongoDB SQL mode.`);
  }
  tokens.push({ kind: "eof" });
  return tokens;
}

function compileSelect(items: SelectItem[], from: TableRef, joins: Join[], where: Expr | undefined, groupBy: FieldRef[] | undefined, orderBy: OrderKey[], limit: number | undefined, offset: number | undefined): string {
  if (items.some((item) => item.type === "star") && items.length > 1) {
    throw new MongoSqlError("SELECT * cannot be combined with other columns in MongoDB SQL mode.");
  }
  if (items.some((item) => item.type === "star") && groupBy) {
    throw new MongoSqlError("SELECT * cannot be combined with GROUP BY in MongoDB SQL mode.");
  }
  const aliases = aliasMap(from, joins);
  const needsAggregate = joins.length > 0 || groupBy !== undefined || items.some((item) => item.type === "agg" || (item.type === "field" && item.alias));
  if (!needsAggregate) {
    const filter = where ? exprToFilter(where, aliases) : {};
    const projection = projectionForFind(items, aliases, from);
    const args = projection ? `${printShell(filter)}, ${printShell(projection)}` : printShell(filter);
    const chain = [orderBy.length ? `.sort(${printShell(orderDocument(orderBy, items, false, aliases, from))})` : "", offset ? `.skip(${offset})` : "", limit !== undefined ? `.limit(${limit})` : ""].join("");
    return `${mongoCall(from, "find", args)}${chain}`;
  }
    if (items.some((item) => item.type === "agg") && !groupBy) {
    const onlyCount = items.length === 1 && items[0]?.fn === "count" && items[0].star && !items[0].alias;
    if (onlyCount && !orderBy.length && limit === undefined && offset === undefined && joins.length === 0) {
      const filter = where ? exprToFilter(where, aliases) : {};
      return mongoCall(from, "countDocuments", printShell(filter));
    }
    groupBy = [];
  }
  const pipeline: ShellValue[] = [];
  const { base, rest } = where ? splitWhere(where, aliases, from, joins) : { base: undefined, rest: new Map<string, Expr>() };
  if (base) pipeline.push({ $match: exprToFilter(base, aliases) });
  for (const join of joins) {
    const alias = join.table.alias ?? join.table.collection;
    pipeline.push({
      $lookup: {
        from: join.table.collection,
        localField: fieldPath(join.local, aliases, from).path,
        foreignField: fieldPath(join.foreign, aliases, from).path,
        as: alias,
      },
    });
    pipeline.push({ $unwind: { path: `$${alias}`, preserveNullAndEmptyArrays: join.kind === "left" } });
    const joined = rest.get((join.table.alias ?? "").toLowerCase()) ?? rest.get(join.table.collection.toLowerCase());
    if (joined) pipeline.push({ $match: exprToFilter(joined, aliases, { qualifyJoin: true }) });
  }
  if ([...rest.keys()].some((alias) => !joins.some((join) => (join.table.alias ?? "").toLowerCase() === alias || join.table.collection.toLowerCase() === alias))) {
    throw new MongoSqlError("A WHERE condition refers to a collection that is not part of this query.");
  }
  if (groupBy) {
    assertGroupedColumns(items, groupBy, aliases, from);
    pipeline.push({ $group: groupStage(items, groupBy, aliases, from) });
    const project = groupProject(items, groupBy, aliases, from);
    if (project) pipeline.push({ $project: project });
    if (orderBy.length) pipeline.push({ $sort: orderDocument(orderBy, items, true, aliases, from, groupBy) });
  } else {
    if (orderBy.length) pipeline.push({ $sort: orderDocument(orderBy, items, false, aliases, from) });
    if (joins.length && items.some((item) => item.type === "star")) {
      const alias = joins[0]!.table.alias ?? joins[0]!.table.collection;
      pipeline.push({ $replaceRoot: { newRoot: { $mergeObjects: ["$$ROOT", `$${alias}`] } } });
      pipeline.push({ $project: { [alias]: 0 } });
    } else if (items.some((item) => item.type !== "star")) {
      pipeline.push({ $project: projectStage(items, aliases, from) });
    }
  }
  if (offset) pipeline.push({ $skip: offset });
  if (limit !== undefined) pipeline.push({ $limit: limit });
  return mongoCall(from, "aggregate", printShell(pipeline));
}

function projectionForFind(items: SelectItem[], aliases: AliasMap, from: TableRef): ShellValue | undefined {
  if (items.some((item) => item.type === "star")) return undefined;
  const projection: Record<string, ShellValue> = {};
  let includesId = false;
  for (const item of items) {
    if (item.type !== "field" || !item.field) continue;
    const resolved = fieldPath(item.field, aliases, from);
    const path = qualifiedPath(resolved);
    projection[path] = fieldHasIndex(item.field) ? arrayValueExpr(item.field, resolved) : 1;
    if (path === "_id") includesId = true;
  }
  if (!includesId) projection._id = 0;
  return projection;
}

function assertGroupedColumns(items: SelectItem[], groupBy: FieldRef[], aliases: AliasMap, from: TableRef) {
  const grouped = new Set(groupBy.map((field) => fieldPath(field, aliases, from).path));
  for (const item of items) {
    if (item.type !== "field" || !item.field) continue;
    const path = fieldPath(item.field, aliases, from).path;
    if (!grouped.has(path)) {
      throw new MongoSqlError(`Column ${expandedNames(item.field).join(".")} must appear in GROUP BY or inside an aggregate function.`);
    }
  }
}

function groupStage(items: SelectItem[], groupBy: FieldRef[], aliases: AliasMap, from: TableRef): ShellValue {
  const id = groupId(groupBy, aliases, from);
  const group: Record<string, ShellValue> = { _id: id };
  const used = new Set<string>();
  for (const item of items) {
    if (item.type !== "agg" || !item.fn) continue;
    const name = aggregateName(item, used);
    if (item.field) rejectNegativeIndex(item.field, "an aggregate");
    const path = item.star || !item.field ? undefined : `$${qualifiedPath(fieldPath(item.field, aliases, from))}`;
    if (item.fn === "count") {
      group[name] = item.star ? { $sum: 1 } : { $sum: { $cond: [{ $ne: [path, null] }, 1, 0] } };
    } else {
      if (!path) throw new MongoSqlError(`${item.fn.toUpperCase()}() requires a field.`);
      group[name] = { [`$${item.fn}`]: path };
    }
  }
  return group;
}

function groupId(groupBy: FieldRef[], aliases: AliasMap, from: TableRef): ShellValue {
  if (groupBy.length === 0) return null;
  for (const field of groupBy) rejectNegativeIndex(field, "GROUP BY");
  if (groupBy.length === 1) return `$${qualifiedPath(fieldPath(groupBy[0]!, aliases, from))}`;
  const id: Record<string, ShellValue> = {};
  for (const field of groupBy) {
    const qualified = qualifiedPath(fieldPath(field, aliases, from));
    assignGroupKey(id, qualified, `$${qualified}`);
  }
  return id;
}

function assignGroupKey(target: Record<string, ShellValue>, path: string, value: ShellValue) {
  const parts = path.split(".");
  let cursor = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const current = cursor[part];
    if (current === undefined) {
      const next: Record<string, ShellValue> = {};
      cursor[part] = next;
      cursor = next;
      continue;
    }
    if (!isDoc(current)) throw new MongoSqlError("GROUP BY keys overlap.");
    cursor = current;
  }
  const leaf = parts[parts.length - 1]!;
  if (leaf in cursor) throw new MongoSqlError("GROUP BY keys overlap.");
  cursor[leaf] = value;
}

function groupProject(items: SelectItem[], groupBy: FieldRef[], aliases: AliasMap, from: TableRef): ShellValue | undefined {
  if (groupBy.length !== 1) return undefined;
  const grouped = fieldPath(groupBy[0]!, aliases, from).path.split(".").pop() ?? "";
  const selected = items.filter((item) => item.type === "field");
  if (selected.length === 0) return undefined;
  const project: Record<string, ShellValue> = {};
  for (const item of selected) {
    const name = item.alias ?? item.field?.parts[item.field.parts.length - 1]?.name;
    if (!name) continue;
    project[name] = "$_id";
  }
  if (!(grouped in project) && selected.some((item) => (item.alias ?? item.field?.parts.at(-1)?.name) === grouped)) {
    project[grouped] = "$_id";
  }
  const used = new Set<string>();
  for (const item of items) {
    if (item.type !== "agg") continue;
    const name = aggregateName(item, used);
    project[name] = 1;
  }
  project._id = 0;
  return project;
}

function projectStage(items: SelectItem[], aliases: AliasMap, from: TableRef): ShellValue {
  const project: Record<string, ShellValue> = {};
  let includesId = false;
  for (const item of items) {
    if (item.type === "field" && item.field) {
      const resolved = fieldPath(item.field, aliases, from);
      const dotted = qualifiedPath(resolved);
      const name = item.alias ?? (fieldHasIndex(item.field) ? dotted : (resolved.path.split(".").pop() ?? resolved.path));
      const source = qualifiedPath(resolved);
      project[name] = fieldHasIndex(item.field) ? arrayValueExpr(item.field, resolved) : item.alias || resolved.owner !== "base" ? `$${source}` : 1;
      if (name === "_id") includesId = true;
    }
  }
  if (!includesId) project._id = 0;
  return project;
}

function aggregateName(item: SelectItem, used: Set<string>): string {
  if (item.alias) {
    used.add(item.alias);
    return item.alias;
  }
  const base = item.fn === "count" && item.star ? "count" : `${item.fn}_${item.field?.parts.at(-1)?.name ?? "value"}`;
  let name = base;
  let n = 2;
  while (used.has(name)) {
    name = `${base}_${n}`;
    n += 1;
  }
  used.add(name);
  return name;
}

function orderDocument(orderBy: OrderKey[], items: SelectItem[], projectsFields: boolean, aliases: AliasMap, from: TableRef, groupBy?: FieldRef[]): ShellValue {
  const sort: Record<string, ShellValue> = {};
  for (const key of orderBy) sort[sortKey(key.field, items, projectsFields, aliases, from, groupBy)] = key.direction;
  return sort;
}

function sortKey(field: FieldRef, items: SelectItem[], projectsFields: boolean, aliases: AliasMap, from: TableRef, groupBy?: FieldRef[]): string {
  rejectNegativeIndex(field, "ORDER BY");
  const resolved = fieldPath(field, aliases, from);
  const full = qualifiedPath(resolved);
  if (!projectsFields) {
    const source = aliasSource(field, items);
    return source ? qualifiedPath(fieldPath(source, aliases, from)) : full;
  }
  for (const item of items) {
    if (item.alias && item.field && sameField(item.field, field)) return item.alias;
  }
  if (field.parts.length === 1 && field.parts[0]!.indexes.length === 0) {
    const alias = items.find((item) => item.alias === field.parts[0]!.name);
    if (alias?.alias) return alias.alias;
  }
  if (groupBy && groupBy.length > 1) return `_id.${full}`;
  if (fieldHasIndex(field)) return full;
  return resolved.path.split(".").pop() ?? full;
}

function aliasSource(field: FieldRef, items: SelectItem[]): FieldRef | undefined {
  if (field.parts.length !== 1 || field.parts[0]!.indexes.length !== 0) return undefined;
  return items.find((item) => item.alias === field.parts[0]!.name && item.field)?.field;
}

function qualifiedPath(resolved: ResolvedField): string {
  return resolved.owner === "base" ? resolved.path : `${resolved.owner}.${resolved.path}`;
}

function rejectNegativeIndex(field: FieldRef, clause: string) {
  if (field.parts.some((part) => part.indexes.some((index) => index < 0))) {
    throw new MongoSqlError(`Negative array indexes are not supported in ${clause}.`);
  }
}

function sameField(left: FieldRef, right: FieldRef): boolean {
  return expandedNames(left).join(".") === expandedNames(right).join(".");
}

interface AliasMap {
  base: TableRef;
  joins: Map<string, TableRef>;
}

function aliasMap(base: TableRef, joins: Join[]): AliasMap {
  const map = new Map<string, TableRef>();
  for (const join of joins) {
    map.set((join.table.alias ?? join.table.collection).toLowerCase(), join.table);
    map.set(join.table.collection.toLowerCase(), join.table);
  }
  return { base, joins: map };
}

interface ResolvedField {
  owner: "base" | string;
  path: string;
}

function expandedNames(field: FieldRef): string[] {
  const names: string[] = [];
  for (const part of field.parts) {
    names.push(part.name);
    for (const index of part.indexes) names.push(String(index));
  }
  return names;
}

function fieldHasIndex(field: FieldRef): boolean {
  return field.parts.some((part) => part.indexes.length > 0);
}

function applyArrayIndexes(expr: ShellValue, indexes: number[]): ShellValue {
  for (const index of indexes) expr = { $arrayElemAt: [expr, index] };
  return expr;
}

/** Positional projection. Inclusion `{ "items.0.name": 1 }` does not select the array element. */
function arrayValueExpr(field: FieldRef, resolved: ResolvedField): ShellValue {
  const parts = stripQualifier(field, resolved);
  const head = parts[0];
  if (!head) throw new MongoSqlError("Array index requires a field.");
  if (resolved.owner !== "base") {
    let expr: ShellValue = `$${resolved.owner}`;
    for (const part of parts) {
      expr = { $getField: { field: part.name, input: expr } };
      expr = applyArrayIndexes(expr, part.indexes);
    }
    return expr;
  }
  let expr: ShellValue = `$${head.name}`;
  expr = applyArrayIndexes(expr, head.indexes);
  for (const part of parts.slice(1)) {
    expr = { $getField: { field: part.name, input: expr } };
    expr = applyArrayIndexes(expr, part.indexes);
  }
  return expr;
}

function stripQualifier(field: FieldRef, resolved: ResolvedField): FieldPart[] {
  if (resolved.owner !== "base") return field.parts.slice(1);
  if (expandedNames(field).join(".") !== resolved.path && field.parts.length > 1) return field.parts.slice(1);
  return field.parts;
}

function fieldPath(field: FieldRef, aliases: AliasMap, from: TableRef): ResolvedField {
  const names = expandedNames(field);
  const baseNames = new Set([from.alias?.toLowerCase(), from.collection.toLowerCase()].filter((name): name is string => !!name));
  if (names.length === 1) return { owner: "base", path: names[0]! };
  const head = names[0]!.toLowerCase();
  const path = names.slice(1).join(".");
  if (baseNames.has(head)) return { owner: "base", path };
  const joined = aliases.joins.get(head);
  if (joined) return { owner: joined.alias ?? joined.collection, path };
  return { owner: "base", path: names.join(".") };
}

function exprToFilter(expr: Expr, aliases: AliasMap, options?: { qualifyJoin?: boolean }): ShellValue {
  if (expr.type === "and") return mergeAnd(expr.items.map((item) => exprToFilter(item, aliases, options)));
  if (expr.type === "or") return { $or: expr.items.map((item) => exprToFilter(item, aliases, options)) };
  if (expr.type === "not") return { $nor: [exprToFilter(expr.item, aliases, options)] };
  if (expr.type === "null") {
    const key = filterKey(expr.field, aliases, options);
    return expr.negated ? { [key]: { $ne: null } } : { [key]: null };
  }
  if (expr.type === "in") {
    const key = filterKey(expr.field, aliases, options);
    return { [key]: { [expr.negated ? "$nin" : "$in"]: expr.values } };
  }
  if (expr.type === "between") {
    const key = filterKey(expr.field, aliases, options);
    const range = { $gte: expr.low, $lte: expr.high };
    return expr.negated ? { [key]: { $not: range } } : { [key]: range };
  }
  if (expr.type === "like") {
    const key = filterKey(expr.field, aliases, options);
    const regex: Record<string, ShellValue> = { $regex: likeToRegex(expr.pattern) };
    if (expr.insensitive) regex.$options = "i";
    return expr.negated ? { [key]: { $not: regex } } : { [key]: regex };
  }
  return comparisonToFilter(expr, aliases, options);
}

function comparisonToFilter(expr: Extract<Expr, { type: "cmp" }>, aliases: AliasMap, options?: { qualifyJoin?: boolean }): ShellValue {
  const mongoOp = expr.op === "=" ? undefined : expr.op === "!=" ? "$ne" : expr.op === ">" ? "$gt" : expr.op === "<" ? "$lt" : expr.op === ">=" ? "$gte" : "$lte";
  const leftField = expr.left.type === "field";
  const rightField = expr.right.type === "field";
  if (leftField && rightField) {
    const left = `$${filterKey(expr.left.field, aliases, options)}`;
    const right = `$${filterKey(expr.right.field, aliases, options)}`;
    const op = mongoOp ?? "$eq";
    return { $expr: { [op]: [left, right] } };
  }
  if (!leftField && !rightField) throw new MongoSqlError("A comparison needs a field.");
  const field = leftField ? expr.left.field : expr.right.field;
  const value = leftField ? (expr.right as Extract<Primary, { type: "value" }>).value : (expr.left as Extract<Primary, { type: "value" }>).value;
  let op = mongoOp;
  if (!leftField && op) {
    op = op === "$gt" ? "$lt" : op === "$lt" ? "$gt" : op === "$gte" ? "$lte" : op === "$lte" ? "$gte" : op;
  }
  const key = filterKey(field, aliases, options);
  if (!op) return { [key]: value };
  return { [key]: { [op]: value } };
}

function filterKey(field: FieldRef, aliases: AliasMap, options?: { qualifyJoin?: boolean }): string {
  rejectNegativeIndex(field, "WHERE");
  const resolved = fieldPath(field, aliases, aliases.base);
  if (options?.qualifyJoin && resolved.owner !== "base") return `${resolved.owner}.${resolved.path}`;
  return resolved.path;
}

function mergeAnd(parts: ShellValue[]): ShellValue {
  const merged: Record<string, ShellValue> = {};
  const extras: ShellValue[] = [];
  for (const part of parts) {
    if (!isDoc(part)) {
      extras.push(part);
      continue;
    }
    for (const [key, value] of Object.entries(part)) {
      if (!(key in merged)) {
        merged[key] = value;
        continue;
      }
      const combined = combineField(merged[key]!, value);
      if (combined) merged[key] = combined;
      else extras.push({ [key]: value });
    }
  }
  if (!extras.length) return merged;
  const clauses = [merged, ...extras].filter((part) => !isDoc(part) || Object.keys(part).length > 0);
  return { $and: clauses };
}

function combineField(existing: ShellValue, incoming: ShellValue): ShellValue | null {
  if (!isDoc(existing) || !isDoc(incoming)) return null;
  const existingKeys = Object.keys(existing);
  const incomingKeys = Object.keys(incoming);
  if (!existingKeys.every((key) => key.startsWith("$")) || !incomingKeys.every((key) => key.startsWith("$"))) return null;
  if (incomingKeys.some((key) => key in existing)) return null;
  return { ...existing, ...incoming };
}

function isDoc(value: ShellValue): value is { [key: string]: ShellValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof ShellCtor);
}

function splitWhere(expr: Expr, aliases: AliasMap, from: TableRef, joins: Join[]): { base?: Expr; rest: Map<string, Expr> } {
  const conjuncts = expr.type === "and" ? expr.items : [expr];
  let base: Expr | undefined;
  const rest = new Map<string, Expr>();
  for (const item of conjuncts) {
    const owners = exprOwners(item, aliases, from);
    if (owners.size > 1) {
      throw new MongoSqlError("MongoDB SQL mode cannot split one condition across collections. AND each comparison separately.");
    }
    const owner = [...owners][0];
    if (!owner || owner === "base") base = base ? { type: "and", items: [base, item] } : item;
    else {
      const key = owner.toLowerCase();
      const current = rest.get(key);
      rest.set(key, current ? { type: "and", items: [current, item] } : item);
    }
  }
  if (joins.length === 0 && rest.size > 0) throw new MongoSqlError("WHERE refers to a collection that is not in FROM.");
  return { base, rest };
}

function exprOwners(expr: Expr, aliases: AliasMap, from: TableRef): Set<string> {
  const owners = new Set<string>();
  const visitField = (field: FieldRef) => {
    const resolved = fieldPath(field, aliases, from);
    owners.add(resolved.owner === "base" ? "base" : resolved.owner);
  };
  const visit = (node: Expr) => {
    if (node.type === "and" || node.type === "or") node.items.forEach(visit);
    else if (node.type === "not") visit(node.item);
    else if (node.type === "cmp") {
      if (node.left.type === "field") visitField(node.left.field);
      if (node.right.type === "field") visitField(node.right.field);
    } else visitField(node.field);
  };
  visit(expr);
  return owners;
}

function likeToRegex(pattern: string): string {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === "%") out += ".*";
    else if (ch === "_") out += ".";
    else if ("\\^$.*+?()[]{}|".includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return `${out}$`;
}

function mongoCall(table: TableRef, method: string, args: string): string {
  const collection = /^[A-Za-z_$][\w$]*$/.test(table.collection) ? `.${table.collection}` : `.getCollection(${JSON.stringify(table.collection)})`;
  const db = table.database ? `db.getSiblingDB(${JSON.stringify(table.database)})` : "db";
  return `${db}${collection}.${method}(${args})`;
}

function printShell(value: ShellValue): string {
  if (value instanceof ShellCtor) return `${value.name}(${JSON.stringify(value.arg)})`;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(printShell).join(", ")}]`;
  const entries = Object.entries(value);
  if (!entries.length) return "{}";
  return `{ ${entries.map(([key, entry]) => `${shellKey(key)}: ${printShell(entry)}`).join(", ")} }`;
}

function shellKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

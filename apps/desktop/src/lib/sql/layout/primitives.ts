import type { AstNode, ClauseNode, KeywordNode, LimitClauseNode, ParenthesisNode, SetOperationNode } from "sql-formatter/dist/esm/parser/ast.js";
import type { SqlLayoutRenderers } from "./internals";

/**
 * The building blocks both layout strategies share: a column-tracking output
 * buffer, the width measurements that decide whether a group fits, and the
 * helpers that recognise the structural nodes of a statement body.
 *
 * The layout rules themselves live in `printer.ts` (queries) and `ddl.ts`
 * (`CREATE TABLE` column alignment).
 */

export interface SqlLayoutOptions {
  /** Hard wrap column; a group wider than this is broken across lines. */
  lineWidth: number;
  /** Maximum number of clause items kept on the keyword's line. */
  keepElementsOnOneLine: number;
  /** One indent step, in columns. */
  indentWidth: number;
  /** Extra indent applied to JOIN keywords, in columns. */
  joinIndentWidth: number;
  /** Keyword casing, matching sql-formatter's `keywordCase`. */
  keywordCase: "preserve" | "upper" | "lower";
  /**
   * Where a wrapped condition puts its `AND`/`OR`, matching DBX's own
   * "logical operator newline" setting.
   *
   * `before` starts the continuation line with the operator, `after` ends the
   * previous line with it, and `none` keeps the whole condition on one line
   * wherever it fits, matching the element alignment rule.
   */
  logicalOperatorNewline: "before" | "after" | "none";
  /** Blank lines left between two statements. */
  linesBetweenQueries: number;
  /** Whether indentation is written with tab characters. */
  useTabs: boolean;
  /**
   * Whether a `FROM` clause's first source stays on the keyword's line.
   *
   * The default keeps it there; DBX exposes the alternative as its
   * "FROM clause" setting.
   */
  fromClauseSourceOnSameLine: boolean;
}

export interface SqlLayoutContext {
  renderers: SqlLayoutRenderers;
  options: SqlLayoutOptions;
  /**
   * Parentheses that must not be glued to the name before them, even though it
   * is an identifier. Set only for an `INSERT` target's column list; see
   * {@link clauseChildContext}.
   */
  nonCallParens?: ReadonlySet<AstNode>;
  /**
   * Whether a condition may be joined onto one line here.
   *
   * Defaults to `logicalOperatorNewline === "none"`: the other two values exist
   * precisely because the caller wants the operators broken out. Collapse
   * measurements override it — see {@link collapsedContext}.
   */
  joinLogicalOperators?: boolean;
}

/**
 * Column-tracking output buffer.
 *
 * Positions are tracked as display columns rather than string offsets, because
 * the layout aligns continuations under a column that depends on the enclosing
 * `(`. With `useTabs` only the leading indentation becomes tabs — the padding
 * used for alignment stays spaces, so a column target that is not a multiple of
 * the tab width still lands where it was measured.
 */
export class Writer {
  private lines: string[] = [""];
  private columns: number[] = [0];
  /**
   * Whether the text written last ends inside a `--` comment.
   *
   * A line comment consumes the rest of its line, so whatever the printer emits
   * next — the separating comma, the closing parenthesis, the statement's `;` —
   * would land inside the comment and disappear from the formatted SQL. The next
   * `write`/`space` therefore continues on a new line first.
   */
  private lineCommentOpen = false;

  constructor(private readonly options: Pick<SqlLayoutOptions, "useTabs" | "indentWidth">) {}

  /** Column the cursor currently sits at, on the last line. */
  get column(): number {
    return this.columns[this.columns.length - 1];
  }

  /** Appends text verbatim. */
  write(text: string): void {
    if (text.length === 0) return;
    this.closeLineComment();
    this.lines[this.lines.length - 1] += text;
    this.columns[this.columns.length - 1] += text.length;
  }

  /** Appends a single separating space, unless one is already there. */
  space(): void {
    if (this.lineCommentOpen) {
      this.closeLineComment();
      return;
    }
    const line = this.lines[this.lines.length - 1];
    if (line.length > 0 && !line.endsWith(" ")) {
      this.lines[this.lines.length - 1] = `${line} `;
      this.columns[this.columns.length - 1] += 1;
    }
  }

  /**
   * Records that the text written last ends inside a `--` comment, so the next
   * `write`/`space` has to start a new line. Callers know this from the AST —
   * see {@link endsWithLineComment} — because only they can tell a comment token
   * apart from the same two dashes inside a string literal.
   */
  markLineComment(): void {
    this.lineCommentOpen = true;
  }

  /** Starts a new line at `indent` columns, dropping trailing blanks first. */
  newline(indent: number): void {
    const last = this.lines.length - 1;
    this.lines[last] = this.lines[last].trimEnd();
    const column = Math.max(0, indent);
    this.lines.push(this.indentation(column));
    this.columns.push(column);
    this.lineCommentOpen = false;
  }

  toString(): string {
    return this.lines
      .map((line) => line.trimEnd())
      .join("\n")
      .trim();
  }

  /**
   * Continues on a new line after a comment, keeping the indentation of the
   * line the comment is on: the next column of a `SELECT` list lines up under
   * the one the comment was written on.
   */
  private closeLineComment(): void {
    if (!this.lineCommentOpen) return;
    this.newline(this.lineIndent());
  }

  /** Display columns taken by the indentation of the current line. */
  private lineIndent(): number {
    const indentWidth = Math.max(1, this.options.indentWidth);
    let columns = 0;
    for (const character of this.lines[this.lines.length - 1]) {
      if (character === "\t") columns += indentWidth;
      else if (character === " ") columns += 1;
      else break;
    }
    return columns;
  }

  /** The whitespace achieving `column` columns of indentation. */
  private indentation(column: number): string {
    if (!this.options.useTabs) return " ".repeat(column);
    const width = Math.max(1, this.options.indentWidth);
    return "\t".repeat(Math.floor(column / width)) + " ".repeat(column % width);
  }
}

export function isParenthesis(node: AstNode): node is ParenthesisNode {
  return node.type === "parenthesis";
}

/** Whether `node` is a `--` comment, which comments out the rest of its line. */
export function isLineComment(node: AstNode | undefined): boolean {
  return node?.type === "line_comment";
}

/**
 * Whether `nodes` end with a `--` comment.
 *
 * The caller that renders such a run has to tell the {@link Writer} about it, so
 * that the next token is not written into the comment.
 */
export function endsWithLineComment(nodes: AstNode[]): boolean {
  return isLineComment(nodes[nodes.length - 1]);
}

/**
 * The keyword a node opens its line with, or `null` for a node that is part of
 * an expression. Clauses, set operations and limit clauses each start a line.
 */
export function bodyKeyword(node: AstNode): string | null {
  if (node.type === "clause" || node.type === "set_operation") {
    return (node as ClauseNode | SetOperationNode).nameKw.text;
  }
  if (node.type === "limit_clause") {
    return (node as LimitClauseNode).limitKw.text;
  }
  return null;
}

export function isBodyNode(node: AstNode): boolean {
  return bodyKeyword(node) !== null;
}

/**
 * The context a collapse measurement renders in.
 *
 * The collapse rule *joins* statements the element placement would otherwise
 * spread over several lines, so a condition inside a
 * statement — or a subquery — being measured for one line joins its operators
 * even when the user asked for `logicalOperatorNewline: "before"`.
 */
export function collapsedContext(ctx: SqlLayoutContext): SqlLayoutContext {
  return ctx.joinLogicalOperators ? ctx : { ...ctx, joinLogicalOperators: true };
}

/**
 * The comma the parser does not materialise for `LIMIT 5, 10`, where the offset
 * and the count are separate expression chains. sql-formatter writes the
 * separator itself while formatting; here the two are joined as ordinary clause
 * items, so the separator has to be an item.
 */
const LIMIT_SEPARATOR = { type: "comma" } as unknown as AstNode;

/** The expressions a `LIMIT` clause renders, in sql-formatter's own order. */
export function limitChildren(node: LimitClauseNode): AstNode[] {
  return node.offset ? [...node.offset, LIMIT_SEPARATOR, ...node.count] : [...node.count];
}

export function keywordText(text: string, ctx: SqlLayoutContext): string {
  switch (ctx.options.keywordCase) {
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    default:
      return text;
  }
}

export function splitByComma(children: AstNode[]): AstNode[][] {
  const groups: AstNode[][] = [];
  let current: AstNode[] = [];
  for (const child of children) {
    if (child.type === "comma") {
      groups.push(current);
      current = [];
    } else {
      current.push(child);
    }
  }
  groups.push(current);
  return groups;
}

/**
 * Keywords that introduce an object name rather than an expression operand, so
 * a parenthesis directly after that name is a definition list, not a call:
 * `INTO t (a, b)`, `REFERENCES t (col)`, `ON t (col)`.
 */
const OBJECT_NAME_KEYWORD = /^(?:INTO|TABLE|VIEW|INDEX|REFERENCES|ON)$/i;

/**
 * Whether `(` at `index` is a function call on the name before it. The default
 * style writes `f(x)`, not `f (x)`; sql-formatter separates an unknown function name
 * from its argument list because it cannot tell a call from a keyword.
 *
 * `INSERT INTO t (a, b)` and `REFERENCES t (col)` have the same shape but are
 * not calls. The keyword in front of the name is what tells the two apart here;
 * a statement head puts its object name in a clause of its own, where that
 * keyword is not a sibling — see {@link clauseChildContext}.
 */
export function isCallParen(nodes: AstNode[], index: number, ctx: SqlLayoutContext): boolean {
  const node = nodes[index];
  if (ctx.nonCallParens?.has(node)) return false;
  const previous = index > 0 ? nodes[index - 1] : undefined;
  if (previous?.type !== "identifier" && previous?.type !== "property_access") return false;

  const before = index > 1 ? nodes[index - 2] : undefined;
  return !(before?.type === "keyword" && OBJECT_NAME_KEYWORD.test(before.text.trim()));
}

/** `CREATE TABLE` plus the modifiers dialects may put around it. */
const CREATE_TABLE_HEAD = "CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:GLOBAL\\s+|LOCAL\\s+)?(?:TEMP(?:ORARY)?\\s+)?(?:UNLOGGED\\s+)?TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?";

/**
 * A `CREATE TABLE` head. Shared with `ddl.ts` so that the column alignment and
 * the definition-list rule below agree on exactly which statements they describe.
 */
export const CREATE_TABLE_KEYWORD = new RegExp(`^${CREATE_TABLE_HEAD}$`, "i");

/**
 * Clause keywords whose object name is followed by a parenthesized *definition
 * list* rather than call arguments: `INSERT INTO t (a, b)` takes column names,
 * `CREATE TABLE t (id int)` takes column definitions.
 */
const DEFINITION_LIST_KEYWORD = new RegExp(`^(?:INSERT\\b[\\s\\S]*\\bINTO|${CREATE_TABLE_HEAD})$`, "i");

/**
 * The context a clause's own children are rendered in.
 *
 * A statement head holds its object name as a clause child (`t` in
 * `INSERT INTO t (a, b)`), so the keyword identifying it is the clause's own and
 * {@link isCallParen}'s lookback cannot see it. Marking the group rather than
 * the whole clause leaves every other parenthesis in the clause — an
 * `ON DUPLICATE KEY UPDATE b = f(c)`, which the parser also puts here — a call.
 */
export function clauseChildContext(ctx: SqlLayoutContext, clause: ClauseNode): SqlLayoutContext {
  if (clause.children.length < 2 || !DEFINITION_LIST_KEYWORD.test(clause.nameKw.text.trim())) return ctx;

  const at = clause.children.findIndex(isParenthesis);
  if (at <= 0) return ctx;
  return { ...ctx, nonCallParens: new Set([...(ctx.nonCallParens ?? []), clause.children[at]]) };
}

/**
 * Renders `nodes` on one line, or `null` when they do not fit in `width`.
 *
 * Two cases go beyond a straight call to `renderers.inline`:
 *
 * - Parenthesized groups are rendered here, by {@link renderParenGroup}. Going
 *   through our own rules at every nesting depth is what keeps `f(x)` free of a
 *   space — inside another call's arguments as much as at the top level.
 * - A run of clauses is collapsible. `renderers.inline` refuses anything whose
 *   layout needs a line break, clauses included, but the default style does put
 *   `SELECT a FROM t` on one line when it fits, and the same rule keeps a small
 *   subquery inline.
 *
 * Logical operators are joined by {@link renderLogicalJoin} when the caller's
 * `logicalOperatorNewline` asks for it, so a condition stays on its clause's line
 * while it fits; the printer splits the operators onto their own lines otherwise.
 */
export function renderInline(ctx: SqlLayoutContext, nodes: AstNode[], width: number): string | null {
  if (nodes.length === 0 || width <= 0) return null;

  const parenAt = nodes.findIndex(isParenthesis);
  if (parenAt >= 0) {
    const group = renderParenGroup(ctx, nodes, parenAt, width);
    if (group) return group;
  }

  const direct = ctx.renderers.inline(nodes, width);
  if (direct) return direct;

  const joinsOperators = ctx.joinLogicalOperators ?? ctx.options.logicalOperatorNewline === "none";
  const joined = joinsOperators && nodes.some(isLogicalOperator) ? renderLogicalJoin(ctx, nodes, width) : null;
  if (joined) return joined;

  if (!nodes.some(isBodyNode)) return null;

  const parts: string[] = [];
  let used = 0;
  for (const node of nodes) {
    const keyword = bodyKeyword(node);
    if (!keyword) return null;
    const childCtx = node.type === "limit_clause" ? ctx : clauseChildContext(ctx, node as ClauseNode);
    const children = node.type === "limit_clause" ? limitChildren(node as LimitClauseNode) : (node as ClauseNode).children;
    const text = renderInline(childCtx, children, width - used - keyword.length - 2);
    if (!text) return null;
    used += (parts.length > 0 ? 1 : 0) + keyword.length + 1 + text.length;
    if (used > width) return null;
    parts.push(`${keywordText(keyword, ctx)} ${text}`);
  }
  return parts.join(" ");
}

/**
 * Renders the parenthesis group at `at` and the rest of `nodes` behind it, or
 * `null` when the line does not fit.
 *
 * The group is measured from the inside out: its contents get the width left
 * after the name before it, and whatever follows gets what the group left. A
 * call — a name directly in front of the group — is written without a
 * separator, everything else with one, which is the only difference between
 * `f(x)` and `IN (x)`.
 */
function renderParenGroup(ctx: SqlLayoutContext, nodes: AstNode[], at: number, width: number): string | null {
  const node = nodes[at] as ParenthesisNode;
  // A group that fits is a collapsed statement in its own right, so its contents
  // join their logical operators whatever the caller's operator placement is.
  const groupCtx = collapsedContext(ctx);
  const head = at === 0 ? "" : renderInline(groupCtx, nodes.slice(0, at), width);
  if (head === null) return null;

  const separator = at === 0 || isCallParen(nodes, at, ctx) ? "" : " ";
  const inner = renderInline(groupCtx, node.children, width - head.length - separator.length - node.openParen.length - node.closeParen.length);
  if (!inner) return null;
  const group = `${head}${separator}${node.openParen}${inner}${node.closeParen}`;

  const rest = nodes.slice(at + 1);
  if (rest.length === 0) return group.length <= width ? group : null;

  const tail = renderInline(groupCtx, rest, width - group.length - 1);
  if (!tail) return null;
  const text = `${group}${separatorBefore(rest[0], ctx)}${tail}`;
  return text.length <= width ? text : null;
}

/** The space that belongs between a rendered group and the node following it. */
function separatorBefore(node: AstNode, ctx: SqlLayoutContext): string {
  if (node.type === "comma") return "";
  if (node.type === "operator" && ctx.renderers.denseOperator(node.text)) return "";
  return " ";
}

/** Whether `node` is an `AND`/`OR`/`XOR` joining two conditions. */
export function isLogicalOperator(node: AstNode): node is KeywordNode {
  return node.type === "keyword" && (node.tokenType === "AND" || node.tokenType === "OR" || node.tokenType === "XOR");
}

/** Whether `node` opens a new join element — the `JOIN` keyword itself. */
export function isJoinKeyword(node: AstNode): node is KeywordNode {
  return node.type === "keyword" && node.tokenType === "RESERVED_JOIN";
}

/**
 * The operands of a condition, each after the first starting with the `AND`/`OR`
 * that introduces it, or `null` when `nodes` is not such a chain.
 *
 * Only the operators at this level count: one nested inside a parenthesis belongs
 * to that group, which is printed — and split — on its own.
 */
export function splitLogicalOperands(nodes: AstNode[]): AstNode[][] | null {
  const operands: AstNode[][] = [];
  let current: AstNode[] = [];
  for (const node of nodes) {
    if (!isLogicalOperator(node)) {
      current.push(node);
      continue;
    }
    if (current.length === 0) return null;
    operands.push(current);
    current = [node];
  }
  if (operands.length === 0 || current.length === 0) return null;
  operands.push(current);
  return operands;
}

/**
 * Joins the operands of a condition onto one line, or returns `null` when the
 * result would not fit.
 *
 * `renderers.inline` raises on a logical operator because sql-formatter always
 * breaks the line there. The default style instead keeps a clause's elements on
 * the clause's line and wraps them only past the hard wrap column, so `WHERE a = 1
 * AND b = 2` is one line while `... AND <a long enough operand>` is not.
 *
 * Splitting here rather than relaxing the renderer keeps the refusal intact for
 * the constructs that must stay multi-line: a JOIN or a CASE is not a split
 * point, so neither is ever folded onto one line by this.
 */
function renderLogicalJoin(ctx: SqlLayoutContext, nodes: AstNode[], width: number): string | null {
  const parts: string[] = [];
  let run: AstNode[] = [];
  let used = 0;

  const flush = (): boolean => {
    if (run.length === 0) return true;
    const text = renderInline(ctx, run, width - used);
    if (!text) return false;
    used += text.length + 1;
    parts.push(text);
    run = [];
    return true;
  };

  for (const node of nodes) {
    if (!isLogicalOperator(node)) {
      run.push(node);
      continue;
    }
    if (!flush()) return null;
    const operator = keywordText(node.text, ctx);
    used += operator.length + 1;
    parts.push(operator);
  }
  if (!flush()) return null;
  return used - 1 <= width ? parts.join(" ") : null;
}

/**
 * Writes possibly multi-line `text`, re-basing each continuation line on the
 * column the block starts at. `text` is rendered relative to column 0, so its
 * own leading whitespace carries the nesting levels and only needs shifting.
 */
export function emitText(writer: Writer, text: string, baseColumn: number, endsWithComment = false): void {
  const lines = text.split("\n");
  writer.write(lines[0].trimEnd());
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.trim() === "") {
      writer.newline(0);
      continue;
    }
    writer.newline(baseColumn + line.length - line.trimStart().length);
    writer.write(line.trimStart());
  }
  if (endsWithComment) writer.markLineComment();
}

import type { AstNode, ClauseNode, LimitClauseNode, ParenthesisNode, StatementNode } from "sql-formatter/dist/esm/parser/ast.js";
import { createTableLayout, isCreateTable } from "./ddl";
import { clauseChildContext, collapsedContext, emitText, endsWithLineComment, isBodyNode, isCallParen, isJoinKeyword, isLineComment, isLogicalOperator, isParenthesis, keywordText, limitChildren, renderInline, splitByComma, splitLogicalOperands, Writer, type SqlLayoutContext } from "./primitives";

export type { SqlLayoutContext, SqlLayoutOptions } from "./primitives";

/**
 * SQL layout — DBX's default formatting style.
 *
 * The rules:
 *
 * - Clause keywords start at the block's left margin, with no padding after
 *   them.
 * - A clause's first item stays on the keyword's line, and its remaining items
 *   align under the first item's column.
 * - Short element lists stay collapsed.
 * - A statement whose clauses all fit the line width is emitted as a single
 *   line.
 * - Join keywords are indented relative to their FROM clause.
 *
 * Alignment is *column-relative*, not indent-level-relative: a subquery's
 * clauses line up under the `(` that opens it, wherever that `(` happens to be.
 * sql-formatter's `Layout`/`Indentation` model cannot express that, which is why
 * this printer walks the AST itself and only delegates the rendering of
 * individual expressions to sql-formatter (see `internals.ts`).
 *
 * Everything here degrades towards "expand": whenever a group cannot be measured
 * or does not fit, it is laid out across multiple lines rather than truncated.
 */

/**
 * Emits one clause: its keyword, then its items — the first kept on the keyword's
 * line and the rest aligned under it — unless the whole list is short enough to
 * stay on one line.
 */
function printClause(writer: Writer, clause: ClauseNode, baseColumn: number, ctx: SqlLayoutContext): void {
  const keyword = keywordText(clause.nameKw.text, ctx);
  const items = splitByComma(clause.children);
  const itemColumn = baseColumn + keyword.length + 1;
  // `FROM` is the one clause DBX lets users push its first source off of, so it
  // skips both the collapse and the "element on the keyword's line" rule.
  const sourceOnOwnLine = clause.nameKw.text.toUpperCase() === "FROM" && !ctx.options.fromClauseSourceOnSameLine;
  const childCtx = clauseChildContext(ctx, clause);

  if (!sourceOnOwnLine && items.length <= ctx.options.keepElementsOnOneLine) {
    const flat = renderInline(childCtx, clause.children, ctx.options.lineWidth - writer.column - keyword.length - 1);
    if (flat) {
      writer.write(`${keyword} ${flat}`);
      return;
    }
  }

  items.forEach((item, index) => {
    if (index === 0) {
      writer.write(keyword);
      if (sourceOnOwnLine) writer.newline(baseColumn + ctx.options.indentWidth);
      else writer.space();
    } else {
      writer.newline(itemColumn);
    }
    printElement(writer, item, baseColumn, childCtx);
    if (index < items.length - 1) writer.write(",");
  });
}

/** Emits a `LIMIT` clause, which sql-formatter renders as keyword + expressions. */
function printLimitClause(writer: Writer, clause: LimitClauseNode, ctx: SqlLayoutContext): void {
  const keyword = keywordText(clause.limitKw.text, ctx);
  const children = limitChildren(clause);
  const flat = renderInline(ctx, children, ctx.options.lineWidth - writer.column - keyword.length - 1);
  if (flat) {
    writer.write(`${keyword} ${flat}`);
    return;
  }
  writer.write(keyword);
  writer.newline(writer.column + ctx.options.indentWidth);
  emitText(writer, ctx.renderers.block(children).trim(), writer.column, endsWithLineComment(children));
}

/** Index just past the nodes that share a line with the group at `from`. */
function joinElementEnd(nodes: AstNode[], from: number): number {
  let end = from;
  while (end < nodes.length && !isJoinKeyword(nodes[end])) end += 1;
  return end;
}

/**
 * Renders the contents of the parenthesis at `index` on one line, or `null` when
 * the group has to expand across lines.
 *
 * The measurement covers the rest of the join element, not just the group: a
 * subquery stays inline only while `(SELECT ...) alias ON ...` fits the line as
 * a whole. The group expands when it does not, rather than keeping a
 * short subquery inline and pushing a long `ON` onto a line of its own.
 */
function measureParen(writer: Writer, nodes: AstNode[], index: number, ctx: SqlLayoutContext): string | null {
  const node = nodes[index] as ParenthesisNode;
  const width = ctx.options.lineWidth;
  const afterOpen = writer.column + node.openParen.length;
  const collapseCtx = collapsedContext(ctx);
  const inner = renderInline(collapseCtx, node.children, width - afterOpen - node.closeParen.length);
  if (!inner) return null;

  const end = joinElementEnd(nodes, index + 1);
  if (end === index + 1) return inner;

  const remaining = width - afterOpen - inner.length - node.closeParen.length;
  return renderInline(collapseCtx, nodes.slice(index + 1, end), remaining) ? inner : null;
}

/**
 * Emits a condition that does not fit on one line, breaking it at its top-level
 * logical operators the way `logicalOperatorNewline` asks: `before` starts each
 * continuation line with the operator, `after` ends the previous line with it.
 *
 * The operands align under the first one, the same rule a clause's other items
 * follow — the style keeps a clause's elements in one column rather than
 * indenting them another step.
 */
function printCondition(writer: Writer, operands: AstNode[][], baseColumn: number, ctx: SqlLayoutContext): void {
  const column = writer.column;
  for (const [head, ...rest] of operands) {
    if (!isLogicalOperator(head)) {
      printElement(writer, [head, ...rest], baseColumn, ctx);
      continue;
    }

    const operator = keywordText(head.text, ctx);
    if (ctx.options.logicalOperatorNewline === "before") {
      writer.newline(column);
      writer.write(operator);
      writer.space();
    } else {
      writer.space();
      writer.write(operator);
      writer.newline(column);
    }
    printElement(writer, rest, baseColumn, ctx);
  }
}

/**
 * Emits one clause item, expanding only those parentheses that do not fit on the
 * current line.
 */
function printElement(writer: Writer, nodes: AstNode[], baseColumn: number, ctx: SqlLayoutContext): void {
  const whole = renderInline(ctx, nodes, ctx.options.lineWidth - writer.column);
  if (whole) {
    writer.write(whole);
    return;
  }

  // A condition is split at its own operators before anything else is tried, so
  // `AND`/`OR` end up on the lines the setting asks for rather than wherever the
  // block fallback happens to place them. `none` asks for no break of its own,
  // and is folded back together after formatting (see the caller's post-pass).
  const operands = ctx.options.logicalOperatorNewline === "none" ? null : splitLogicalOperands(nodes);
  if (operands) {
    printCondition(writer, operands, baseColumn, ctx);
    return;
  }

  let index = 0;
  while (index < nodes.length) {
    const node = nodes[index];

    if (isParenthesis(node)) {
      if (!isCallParen(nodes, index, ctx)) writer.space();
      const inner = measureParen(writer, nodes, index, ctx);
      if (inner) {
        writer.write(`${node.openParen}${inner}${node.closeParen}`);
      } else {
        writer.write(node.openParen);
        printBlock(writer, node.children, writer.column, ctx);
        writer.write(node.closeParen);
      }
      index += 1;
      continue;
    }

    // A JOIN keyword opens a new line one "Join indent" in from the FROM clause.
    if (isJoinKeyword(node)) {
      writer.newline(baseColumn + ctx.options.joinIndentWidth);
      writer.write(keywordText(node.text, ctx));
      index += 1;
      continue;
    }

    // Gather the run of plain nodes up to the next construct needing care, so
    // they are measured together instead of one node at a time.
    let end = index;
    while (end < nodes.length && !isParenthesis(nodes[end]) && !isJoinKeyword(nodes[end])) {
      end += 1;
    }
    const run = nodes.slice(index, end);
    const rendered = renderInline(ctx, run, ctx.options.lineWidth - writer.column);
    writer.space();
    if (rendered) {
      writer.write(rendered);
    } else {
      // A construct too wide to inline (a long CASE, a nested function call):
      // fall back to sql-formatter's own multi-line rendering of it.
      emitText(writer, ctx.renderers.block(run).trim(), writer.column, endsWithLineComment(run));
    }
    index = end;
  }
}

/**
 * Emits a statement body: a subquery's clauses or a statement's own clauses.
 *
 * Called only once the caller has established that the body does not fit on one
 * line, so there is no second collapse attempt here — re-flattening would undo
 * the very expansion the caller asked for.
 */
function printBlock(writer: Writer, nodes: AstNode[], baseColumn: number, ctx: SqlLayoutContext): void {
  if (!nodes.some(isBodyNode)) {
    // A plain expression group (not a subquery) that did not fit: let
    // sql-formatter break it, then re-base the block on this column.
    emitText(writer, ctx.renderers.block(nodes).trim(), baseColumn, endsWithLineComment(nodes));
    return;
  }

  let first = true;
  for (const node of nodes) {
    if (!first) writer.newline(baseColumn);
    writeBodyNode(writer, node, baseColumn, ctx);
    first = false;
  }
}

/** Emits one clause / set operation / limit clause of a statement body. */
function writeBodyNode(writer: Writer, node: AstNode, baseColumn: number, ctx: SqlLayoutContext): void {
  if (node.type === "clause") printClause(writer, node, baseColumn, ctx);
  else if (node.type === "set_operation") writer.write(keywordText(node.nameKw.text, ctx));
  else if (node.type === "limit_clause") printLimitClause(writer, node, ctx);
  else emitText(writer, ctx.renderers.block([node]).trim(), writer.column, isLineComment(node));
}

/** Emits a whole statement, one clause per line unless the statement collapses. */
function printStatement(statement: StatementNode, ctx: SqlLayoutContext): string | null {
  const collapsed = renderInline(collapsedContext(ctx), statement.children, ctx.options.lineWidth);
  if (collapsed) return statement.hasSemicolon ? `${collapsed};` : collapsed;

  if (isCreateTable(statement)) return createTableLayout(statement, ctx);

  // A statement without clauses is a bare expression — a fragment the user
  // selected in the editor — and has no clause layout to apply. Declining hands
  // the whole input to sql-formatter, which formats such a fragment operand by
  // operand; emitting it clause by clause would put every token on its own line.
  if (!statement.children.some(isBodyNode)) return null;

  const writer = new Writer(ctx.options);
  let first = true;
  for (const node of statement.children) {
    if (!first) writer.newline(0);
    writeBodyNode(writer, node, 0, ctx);
    first = false;
  }
  if (statement.hasSemicolon) writer.write(";");
  return writer.toString();
}

/**
 * Formats already-parsed statements using the default style's layout rules.
 *
 * Returns `null` when any statement lies outside the model these rules describe,
 * so the caller can format the input as a whole with sql-formatter instead of
 * mixing two styles inside one script.
 */
export function printSqlLayout(statements: StatementNode[], ctx: SqlLayoutContext): string | null {
  // Same convention as sql-formatter: the setting counts blank lines, so the
  // separator is one newline longer.
  const separator = "\n".repeat(ctx.options.linesBetweenQueries + 1);
  const rendered: string[] = [];
  for (const statement of statements) {
    const text = printStatement(statement, ctx);
    if (text === null) return null;
    rendered.push(text);
  }
  return rendered.join(separator);
}

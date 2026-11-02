import type { AstNode, ClauseNode, LimitClauseNode, ParenthesisNode, SetOperationNode, StatementNode } from "sql-formatter/dist/esm/parser/ast.js";
import { createTableLayout, isCreateTable } from "./ddl";
import { hasRuleLineBreak, ruleCommaPosition, ruleListLayout, ruleLogicalNewline, supportsSqlRules } from "./rules";
import {
  clauseChildContext,
  collapsedContext,
  emitText,
  endsWithLineComment,
  isBodyNode,
  isCallParen,
  isJoinKeyword,
  isLineComment,
  isLogicalOperator,
  isParenthesis,
  isProjectionClauseName,
  keywordText,
  limitChildren,
  renderInline,
  splitByComma,
  splitLogicalOperands,
  Writer,
  type SqlLayoutContext,
} from "./primitives";

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
 * - SELECT fields each get their own line; other short element lists stay
 *   collapsed.
 * - A statement with a single SELECT field whose clauses all fit the line
 *   width is emitted as a single line.
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
 * line and the rest aligned under it. SELECT fields always split; other lists
 * stay on one line when they are short enough.
 */
function printClause(writer: Writer, clause: ClauseNode, baseColumn: number, ctx: SqlLayoutContext): void {
  if (ctx.options.rules) {
    printRuleClause(writer, clause, baseColumn, ctx);
    return;
  }
  const keyword = keywordText(clause.nameKw, ctx);
  const items = splitByComma(clause.children);
  const itemColumn = baseColumn + keyword.length + 1;
  const projection = isProjectionClauseName(clause.nameKw.text);
  // `FROM` is the one clause DBX lets users push its first source off of, so it
  // skips both the collapse and the "element on the keyword's line" rule.
  const sourceOnOwnLine = clause.nameKw.text.toUpperCase() === "FROM" && !ctx.options.fromClauseSourceOnSameLine;
  const childCtx = clauseChildContext(ctx, clause);

  // Align explicit SELECT aliases to the same column, matching the tabular
  // layout used by DBX for CREATE TABLE definitions. Only use this path when
  // every aliased item can be rendered as a single line; otherwise the normal
  // element printer preserves the formatter's existing wrapping behavior.
  const alignedAliases = projection && items.length > 1 ? alignedProjectionItems(items, childCtx, ctx.options.lineWidth - itemColumn) : null;

  if (!sourceOnOwnLine && !(projection && items.length > 1) && items.length <= ctx.options.keepElementsOnOneLine) {
    const flat = renderInline(childCtx, clause.children, ctx.options.lineWidth - writer.column - keyword.length - 1);
    if (flat) {
      writer.write(`${keyword} ${flat}`);
      return;
    }
  }

  items.forEach((item, index) => {
    // A line comment written after the previous field's comma is a trailing
    // annotation for that field, not a separate heading. sql-formatter keeps
    // its original preceding whitespace; only comments that did not start a
    // new source line are moved back onto the preceding output line. Comments
    // that were on their own line keep their own line.
    const leadingComments = index > 0 && ctx.options.commaPosition !== "before" ? leadingTrailingComments(item) : 0;
    let itemNodes = item;
    let leadingText: string | null = null;
    if (leadingComments > 0) {
      // `renderInline` intentionally drops comments; a trailing comment is
      // copied verbatim, and only when it fits the remaining line width.
      const commentText = item
        .slice(0, leadingComments)
        .map((node) => ("text" in node ? node.text : ""))
        .join(" ");
      if (commentText && writer.column + 1 + commentText.length <= ctx.options.lineWidth) {
        leadingText = commentText;
        itemNodes = item.slice(leadingComments);
      }
    }
    if (index === 0) {
      writer.write(keyword);
      if (sourceOnOwnLine) writer.newline(baseColumn + ctx.options.indentWidth);
      else writer.space();
    } else if (leadingText) {
      writer.space();
      writer.write(leadingText);
      if (itemNodes.length === 0) return;
      writer.newline(itemColumn);
    } else {
      if (ctx.options.commaPosition === "before") {
        const leadingIndent = sourceOnOwnLine ? baseColumn + ctx.options.indentWidth : Math.max(baseColumn, itemColumn - 2);
        writer.newline(leadingIndent);
        writer.write(", ");
      } else {
        writer.newline(itemColumn);
      }
    }
    if (alignedAliases && !leadingText) {
      const aligned = alignedAliases[index];
      if (aligned) {
        writer.write(aligned.expression);
        writer.write(" ".repeat(aligned.aliasColumn - aligned.expression.length));
        writer.write(`${aligned.asKeyword} ${aligned.alias}`);
      } else {
        printElement(writer, itemNodes, baseColumn, childCtx);
      }
    } else {
      printElement(writer, itemNodes, baseColumn, childCtx);
    }
    if (ctx.options.commaPosition !== "before" && index < items.length - 1) writer.write(",");
  });
}

function writeRuleKeyword(writer: Writer, keyword: string, ctx: SqlLayoutContext): void {
  const style = ctx.options.rules!.indentStyle;
  const padding = Math.max(0, (ctx.keywordWidth ?? keyword.length) - keyword.length);
  if (style === "tabularRight") writer.write(" ".repeat(padding));
  writer.write(keyword);
  if (style === "tabularLeft") writer.write(" ".repeat(padding));
}

function printRuleClause(writer: Writer, clause: ClauseNode, baseColumn: number, ctx: SqlLayoutContext): void {
  writeRuleKeyword(writer, keywordText(clause.nameKw, ctx), ctx);
  if (clause.children.length === 0) return;
  if (clause.nameKw.text.toUpperCase() === "FROM" && !ctx.options.fromClauseSourceOnSameLine) writer.newline(baseColumn + ctx.options.indentWidth);
  else writer.write(" ");
  const childCtx = clauseChildContext(ctx, clause);
  printRuleList(writer, splitByComma(clause.children), baseColumn, childCtx);
}

function alignedAssignmentItems(items: AstNode[][], ctx: SqlLayoutContext, width: number): Array<AlignedProjectionItem | null> | null {
  const parsed = items.map((item) => {
    const at = item.findIndex((node) => node.type === "operator" && node.text === "=");
    if (at <= 0 || at === item.length - 1) return null;
    const expression = renderInline(ctx, item.slice(0, at), width);
    const alias = renderInline(ctx, item.slice(at + 1), width);
    return expression && alias ? { expression, alias, asKeyword: "=", aliasColumn: 0 } : null;
  });
  if (parsed.some((item) => !item)) return null;
  const aliasColumn = Math.max(...parsed.map((item) => item!.expression.length)) + 1;
  if (parsed.some((item) => aliasColumn + 2 + item!.alias.length > width)) return null;
  return parsed.map((item) => ({ ...item!, aliasColumn }));
}

/** One list writer serves clauses, INSERT tuples, IN lists and function arguments. */
function printRuleList(writer: Writer, items: AstNode[][], baseColumn: number, ctx: SqlLayoutContext): void {
  const mode = ruleListLayout(ctx);
  const comma = ruleCommaPosition(ctx);
  const firstColumn = writer.column;
  const continuation = ctx.options.rules!.listItemAlignment === "indent" ? baseColumn + ctx.options.indentWidth : firstColumn;
  const nodes = items.flatMap((item, index) => (index === 0 ? item : [{ type: "comma" } as AstNode, ...item]));
  // Single-line lists keep their own separators inline, but each item still
  // visits its nested lists with their actual remaining width.
  const flat = mode === "singleLine" || (mode === "vertical" && items.length > 1) ? null : renderInline(ctx, nodes, ctx.options.lineWidth - writer.column);
  if (flat) {
    writer.write(flat);
    return;
  }
  const available = ctx.options.lineWidth - Math.max(firstColumn, continuation);
  const aligned =
    mode !== "singleLine" && items.length > 1 ? (ctx.listKind === "select" && ctx.options.rules!.alignSelectAliases ? alignedProjectionItems(items, ctx, available) : ctx.listKind === "update" && ctx.options.rules!.alignUpdateAssignments ? alignedAssignmentItems(items, ctx, available) : null) : null;

  items.forEach((item, index) => {
    let itemNodes = item;
    if (index > 0) {
      const commentCount = comma === "after" ? leadingTrailingComments(item) : 0;
      if (commentCount > 0) {
        writer.space();
        printRuleElement(writer, item.slice(0, commentCount), baseColumn, ctx);
        itemNodes = item.slice(commentCount);
      }
      const text = renderInline(ctx, itemNodes, Number.MAX_SAFE_INTEGER);
      const separatorWidth = comma === "before" ? 2 : 1;
      const trailingCommaWidth = comma === "after" && index < items.length - 1 ? 1 : 0;
      const sameLine = mode === "singleLine" || (mode === "wrap" && !!text && writer.column + separatorWidth + text.length + trailingCommaWidth <= ctx.options.lineWidth);
      if (sameLine && commentCount === 0) {
        if (comma === "before") writer.write(", ");
        else writer.space();
      } else {
        writer.newline(comma === "before" ? Math.max(baseColumn, continuation - 2) : continuation);
        if (comma === "before") writer.write(", ");
      }
    }
    const alignment = aligned?.[index];
    if (alignment && itemNodes === item) {
      writer.write(alignment.expression);
      writer.write(" ".repeat(alignment.aliasColumn - alignment.expression.length));
      writer.write(`${alignment.asKeyword} ${alignment.alias}`);
    } else {
      // An item's nested blocks and leading comments belong to its actual
      // column, not the enclosing clause's keyword column (#13650).
      printRuleElement(writer, itemNodes, writer.column, ctx);
    }
    if (comma === "after" && index < items.length - 1) writer.write(",");
  });
}

function printRuleComments(writer: Writer, nodes: AstNode[] | undefined, column: number, ctx: SqlLayoutContext): void {
  if (nodes?.length) printRuleElement(writer, nodes, column, ctx);
}

function printRuleJoins(writer: Writer, nodes: AstNode[], baseColumn: number, ctx: SqlLayoutContext): boolean {
  const first = nodes.findIndex(isJoinKeyword);
  if (first < 0) return false;
  if (first > 0) printRuleElement(writer, nodes.slice(0, first), baseColumn, ctx);
  let index = first;
  while (index < nodes.length) {
    const end = joinElementEnd(nodes, index + 1);
    const segment = nodes.slice(index + 1, end);
    const on = segment.findIndex((node) => node.type === "keyword" && node.text.toUpperCase() === "ON");
    const joinColumn = baseColumn + ctx.options.joinIndentWidth;
    writer.newline(joinColumn);
    writer.write(keywordText(nodes[index], ctx));
    writer.space();
    printRuleElement(writer, on < 0 ? segment : segment.slice(0, on), joinColumn, { ...ctx, listKind: "general", logicalContext: "expression" });
    if (on >= 0) {
      if (ctx.options.rules!.newlineBeforeJoinOn) writer.newline(joinColumn + ctx.options.indentWidth);
      else writer.space();
      writer.write(keywordText(segment[on], ctx));
      writer.space();
      printRuleElement(writer, segment.slice(on + 1), joinColumn, { ...ctx, listKind: "general", logicalContext: "on" });
    }
    index = end;
  }
  return true;
}

function printRuleElement(writer: Writer, nodes: AstNode[], baseColumn: number, ctx: SqlLayoutContext): void {
  if (nodes.length === 0) return;
  const whole = renderInline(ctx, nodes, ctx.options.lineWidth - writer.column);
  if (whole) {
    writer.write(whole);
    return;
  }
  if (printRuleJoins(writer, nodes, baseColumn, ctx)) return;
  const operands = ruleLogicalNewline(ctx) === "none" ? null : splitLogicalOperands(nodes);
  if (operands) {
    printCondition(writer, operands, baseColumn, ctx);
    return;
  }
  for (let index = 0; index < nodes.length;) {
    const node = nodes[index];
    if (node.type === "line_comment" || node.type === "block_comment" || node.type === "disable_comment") {
      if (/[\r\n]/.test(node.precedingWhitespace) && writer.column !== baseColumn) writer.newline(baseColumn);
      else writer.space();
      writer.write(node.text);
      if (node.type !== "block_comment") writer.markLineComment();
      index += 1;
    } else if (node.type === "parenthesis") {
      if (!isCallParen(nodes, index, ctx)) writer.space();
      writeParenthesis(writer, nodes, index, isCallParen(nodes, index, ctx) ? { ...ctx, listKind: "general" } : ctx);
      index += 1;
    } else if (node.type === "function_call" || node.type === "parameterized_data_type" || node.type === "array_subscript") {
      writer.space();
      printRuleComments(writer, node.leadingComments, writer.column, ctx);
      const name = node.type === "function_call" ? node.nameKw : node.type === "parameterized_data_type" ? node.dataType : node.array;
      if (node.type === "function_call") {
        const casing = ctx.options.rules!.functionCase;
        writer.write(casing === "preserve" ? node.nameKw.raw : casing === "upper" ? node.nameKw.text.toUpperCase() : node.nameKw.text.toLowerCase());
      } else writer.write(ctx.renderers.block([name]).trim());
      writeParenthesis(writer, [node.parenthesis], 0, { ...ctx, listKind: "general" });
      printRuleComments(writer, node.trailingComments, writer.column, ctx);
      index += 1;
    } else if (node.type === "property_access") {
      printRuleComments(writer, node.leadingComments, writer.column, ctx);
      printRuleElement(writer, [node.object], baseColumn, ctx);
      writer.write(node.operator);
      if (node.property.type === "array_subscript") {
        writer.write(ctx.renderers.block([node.property.array]).trim());
        writeParenthesis(writer, [node.property.parenthesis], 0, { ...ctx, listKind: "general" });
      } else writer.write(ctx.renderers.block([node.property]).trim());
      printRuleComments(writer, node.trailingComments, writer.column, ctx);
      index += 1;
    } else if (node.type === "between_predicate") {
      writer.space();
      printRuleComments(writer, node.leadingComments, writer.column, ctx);
      writer.write(keywordText(node.betweenKw, ctx));
      writer.space();
      printRuleElement(writer, node.expr1, baseColumn, ctx);
      writer.space();
      writer.write(keywordText(node.andKw, ctx));
      writer.space();
      printRuleElement(writer, node.expr2, baseColumn, ctx);
      printRuleComments(writer, node.trailingComments, writer.column, ctx);
      index += 1;
    } else if (node.type === "case_expression") {
      writer.space();
      printRuleComments(writer, node.leadingComments, writer.column, ctx);
      const caseCtx: SqlLayoutContext = { ...ctx, listKind: "general", logicalContext: "expression" };
      const inlineCase = ruleListLayout(ctx) === "singleLine" && !hasRuleLineBreak(ctx, [node]);
      writer.write(keywordText(node.caseKw, ctx));
      if (node.expr.length) {
        writer.space();
        printRuleElement(writer, node.expr, baseColumn, caseCtx);
      }
      for (const branch of node.clauses) {
        if (inlineCase) writer.space();
        else writer.newline(baseColumn + ctx.options.indentWidth);
        printRuleComments(writer, branch.leadingComments, writer.column, ctx);
        if (branch.type === "case_when") {
          writer.write(keywordText(branch.whenKw, ctx));
          writer.space();
          printRuleElement(writer, branch.condition, baseColumn + ctx.options.indentWidth, caseCtx);
          writer.space();
          writer.write(keywordText(branch.thenKw, ctx));
        } else writer.write(keywordText(branch.elseKw, ctx));
        if (inlineCase) writer.space();
        else writer.newline(baseColumn + ctx.options.indentWidth * 2);
        printRuleElement(writer, branch.result, inlineCase ? baseColumn : baseColumn + ctx.options.indentWidth * 2, caseCtx);
        printRuleComments(writer, branch.trailingComments, writer.column, ctx);
      }
      if (inlineCase) writer.space();
      else writer.newline(baseColumn);
      writer.write(keywordText(node.endKw, ctx));
      printRuleComments(writer, node.trailingComments, writer.column, ctx);
      index += 1;
    } else {
      let end = index + 1;
      while (end < nodes.length && !["parenthesis", "function_call", "parameterized_data_type", "array_subscript", "property_access", "between_predicate", "case_expression", "line_comment", "block_comment", "disable_comment"].includes(nodes[end].type)) end += 1;
      const run = nodes.slice(index, end);
      const first = run[0];
      if (!(first.type === "operator" && ctx.renderers.denseOperator(first.text))) writer.space();
      const inline = renderInline(ctx, run, Number.MAX_SAFE_INTEGER);
      if (inline) writer.write(inline);
      else emitText(writer, ctx.renderers.block(run).trim(), writer.column, endsWithLineComment(run));
      index = end;
    }
  }
}

/** Count leading comments that were written on the previous source line. */
function leadingTrailingComments(item: AstNode[]): number {
  let count = 0;
  while (count < item.length) {
    const node = item[count];
    if (!node || (node.type !== "line_comment" && node.type !== "block_comment")) break;
    if (/[\r\n]/.test(node.precedingWhitespace ?? "")) break;
    count += 1;
  }
  return count;
}

interface AlignedProjectionItem {
  expression: string;
  alias: string;
  asKeyword: string;
  aliasColumn: number;
}

function alignedProjectionItems(items: AstNode[][], ctx: SqlLayoutContext, lineWidth: number): Array<AlignedProjectionItem | null> | null {
  const parsed = items.map((item) => {
    const asIndex = item.findIndex((node) => node.type === "keyword" && node.text.toUpperCase() === "AS");
    if (asIndex <= 0 || asIndex >= item.length - 1) return null;
    const asNode = item[asIndex];
    if (asNode?.type !== "keyword") return null;
    const expression = renderInline(ctx, item.slice(0, asIndex), lineWidth);
    const alias = renderInline(ctx, item.slice(asIndex + 1), lineWidth);
    if (!expression || !alias) return null;
    return { expression, alias, asKeyword: keywordText(asNode, ctx), aliasColumn: 0 };
  });

  if (!parsed.some(Boolean)) return null;
  const expressionWidth = Math.max(...parsed.filter((item): item is AlignedProjectionItem => item !== null).map((item) => item.expression.length));
  const aliasColumn = expressionWidth + 1;
  if (parsed.some((item) => item && item.expression.length + (aliasColumn - item.expression.length) + item.asKeyword.length + 1 + item.alias.length > lineWidth)) return null;
  return parsed.map((item) => (item ? { ...item, aliasColumn } : null));
}

/** Emits a `LIMIT` clause, which sql-formatter renders as keyword + expressions. */
function printLimitClause(writer: Writer, clause: LimitClauseNode, ctx: SqlLayoutContext): void {
  const keyword = keywordText(clause.limitKw, ctx);
  const children = limitChildren(clause);
  if (ctx.options.rules) {
    const baseColumn = writer.column;
    writeRuleKeyword(writer, keyword, ctx);
    writer.space();
    printRuleList(writer, splitByComma(children), baseColumn, { ...ctx, listKind: "general", logicalContext: "expression" });
    return;
  }
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
 * Emits a parenthesis group: inline while it fits — together with the rest of
 * the join element it opens — and expanded, re-based on the `(`'s own column,
 * when it does not.
 */
function writeParenthesis(writer: Writer, nodes: AstNode[], index: number, ctx: SqlLayoutContext): void {
  const node = nodes[index] as ParenthesisNode;
  if (ctx.options.rules) {
    printRuleComments(writer, node.leadingComments, writer.column, ctx);
    const inner = measureParen(writer, nodes, index, ctx);
    if (inner) writer.write(`${node.openParen}${inner}${node.closeParen}`);
    else {
      writer.write(node.openParen);
      const column = writer.column;
      if (node.children.some(isBodyNode)) printBlock(writer, node.children, column, ctx);
      else printRuleList(writer, splitByComma(node.children), column - node.openParen.length, ctx);
      writer.write(node.closeParen);
    }
    printRuleComments(writer, node.trailingComments, writer.column, ctx);
    return;
  }
  const inner = measureParen(writer, nodes, index, ctx);
  if (inner) {
    writer.write(`${node.openParen}${inner}${node.closeParen}`);
    return;
  }
  writer.write(node.openParen);
  printBlock(writer, node.children, writer.column, ctx);
  writer.write(node.closeParen);
}

/**
 * Emits one set operation (`UNION ALL`, `INTERSECT`, ...).
 *
 * Bare `SELECT` and `VALUES` operands become sibling clauses. Operands retained
 * in this node's `children`, such as a parenthesized subquery or a `TABLE`
 * reference, must also be printed to avoid dropping a branch (#10472). They go
 * on the next line at the operator's column, just like the sibling-clause form.
 */
function printSetOperation(writer: Writer, node: SetOperationNode, baseColumn: number, ctx: SqlLayoutContext): void {
  if (ctx.options.rules) writeRuleKeyword(writer, keywordText(node.nameKw, ctx), ctx);
  else writer.write(keywordText(node.nameKw, ctx));
  if (node.children.length === 0) return;
  writer.newline(baseColumn);
  printSetOperationOperand(writer, node.children, ctx);
}

/** Emits the operand a set operation carries inside its own node. */
function printSetOperationOperand(writer: Writer, nodes: AstNode[], ctx: SqlLayoutContext): void {
  if (nodes.length === 1 && isParenthesis(nodes[0])) {
    writeParenthesis(writer, nodes, 0, ctx);
    return;
  }
  // Keep other dialect-specific operands, such as TABLE references, at this column.
  emitText(writer, ctx.renderers.block(nodes).trim(), writer.column, endsWithLineComment(nodes));
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

    const operator = keywordText(head, ctx);
    if (ruleLogicalNewline(ctx) === "before") {
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
  if (ctx.options.rules) {
    printRuleElement(writer, nodes, baseColumn, ctx);
    return;
  }
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
      writeParenthesis(writer, nodes, index, ctx);
      index += 1;
      continue;
    }

    // A JOIN keyword opens a new line one "Join indent" in from the FROM clause.
    if (isJoinKeyword(node)) {
      writer.newline(baseColumn + ctx.options.joinIndentWidth);
      writer.write(keywordText(node, ctx));
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
  if (ctx.options.rules) ctx = ruleBlockContext(nodes, ctx);
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

function ruleBlockContext(nodes: AstNode[], ctx: SqlLayoutContext): SqlLayoutContext {
  const lengths = nodes.flatMap((node) => (node.type === "clause" || node.type === "set_operation" ? [keywordText(node.nameKw, ctx).length] : node.type === "limit_clause" ? [keywordText(node.limitKw, ctx).length] : []));
  return { ...ctx, keywordWidth: Math.max(0, ...lengths) };
}

/** Emits one clause / set operation / limit clause of a statement body. */
function writeBodyNode(writer: Writer, node: AstNode, baseColumn: number, ctx: SqlLayoutContext): void {
  if (node.type === "clause") printClause(writer, node, baseColumn, ctx);
  else if (node.type === "set_operation") printSetOperation(writer, node, baseColumn, ctx);
  else if (node.type === "limit_clause") printLimitClause(writer, node, ctx);
  // A parenthesized group that is not a clause (a set operation's branch, a
  // statement wrapped in parentheses) is laid out like any other parenthesis so
  // its contents stay in this style instead of dropping to the generic renderer.
  else if (isParenthesis(node)) writeParenthesis(writer, [node], 0, ctx);
  else emitText(writer, ctx.renderers.block([node]).trim(), writer.column, isLineComment(node));
}

/** Emits a whole statement, one clause per line unless the statement collapses. */
function printStatement(statement: StatementNode, ctx: SqlLayoutContext): string | null {
  if (ctx.options.rules) {
    if (!supportsSqlRules(statement.children)) return null;
    ctx = ruleBlockContext(statement.children, ctx);
    if (statement.children.every((node) => ["line_comment", "block_comment", "disable_comment"].includes(node.type))) {
      const writer = new Writer(ctx.options);
      printRuleElement(writer, statement.children, 0, ctx);
      if (statement.hasSemicolon) writer.write(";");
      return writer.toString();
    }
  }
  const hasMultiItemProjection = statement.children.some((node) => node.type === "clause" && isProjectionClauseName(node.nameKw.text) && splitByComma(node.children).length > 1);
  const mayCollapse = ctx.options.rules ? ctx.options.rules.collapseShortStatements : !hasMultiItemProjection;
  const collapsed = mayCollapse ? renderInline(collapsedContext(ctx), statement.children, ctx.options.lineWidth) : null;
  if (collapsed) {
    if (!statement.hasSemicolon) return collapsed;
    return ctx.options.newlineBeforeSemicolon ? `${collapsed}\n;` : `${collapsed};`;
  }

  if (!ctx.options.rules && isCreateTable(statement)) return createTableLayout(statement, ctx);

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
  if (statement.hasSemicolon) {
    if (ctx.options.newlineBeforeSemicolon) writer.newline(0);
    writer.write(";");
  }
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

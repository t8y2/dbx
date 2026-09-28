import type { AstNode, ClauseNode, ParenthesisNode, StatementNode } from "sql-formatter/dist/esm/parser/ast.js";
import { CREATE_TABLE_KEYWORD, endsWithLineComment, keywordText, renderInline, splitByComma, Writer, type SqlLayoutContext } from "./primitives";

/**
 * Column alignment for `CREATE TABLE`.
 *
 * The definition list is laid out on a character grid so the three parts of
 * every column — name, type, nullability/default — line up, which is what makes
 * a wide table readable:
 *
 *     `id`                varchar(20)  PRIMARY KEY NOT NULL COMMENT '主键',
 *     `delivery_type_ids` varchar(512)    DEFAULT NULL COMMENT '…',
 *     `update_time`       datetime                    NOT NULL COMMENT '…'
 *
 * The definition list goes one column per line under its own `(`, and the table
 * options move below the closing `)`.
 *
 * This is applied only to statements that match the shape exactly (see
 * `isCreateTable`). Anything else — a `CREATE TABLE ... AS SELECT`, a dialect
 * keyword sql-formatter parses differently — keeps the ordinary query layout
 * rather than being aligned on a guess.
 */

/** The pieces of one column definition, already rendered. */
interface ColumnDefinition {
  name: string;
  type: string;
  modifiers: string;
  /** Everything from `COMMENT` onwards. */
  tail: string;
}

type Definition = { kind: "column"; column: ColumnDefinition } | { kind: "other"; nodes: AstNode[] };

function isDataType(node: AstNode | undefined): boolean {
  return node?.type === "data_type" || node?.type === "parameterized_data_type";
}

function isCommentNode(node: AstNode | undefined): boolean {
  return node?.type === "identifier" && node.text.toUpperCase() === "COMMENT";
}

/**
 * Splits one comma-separated definition into its aligned parts, or `null` when
 * the item is not a plain `name type [modifiers] [COMMENT …]` column.
 */
function splitColumn(ctx: SqlLayoutContext, item: AstNode[]): ColumnDefinition | null {
  const [nameNode, typeNode] = item;
  if (nameNode?.type !== "identifier" || !isDataType(typeNode)) return null;

  const commentAt = item.findIndex((node, index) => index >= 2 && isCommentNode(node));
  const modifierNodes = item.slice(2, commentAt === -1 ? item.length : commentAt);
  const tailNodes = commentAt === -1 ? [] : item.slice(commentAt);

  const name = renderInline(ctx, [nameNode], ctx.options.lineWidth);
  const type = renderInline(ctx, [typeNode], ctx.options.lineWidth);
  const modifiers = renderInline(ctx, modifierNodes, ctx.options.lineWidth);
  const tail = renderInline(ctx, tailNodes, ctx.options.lineWidth);

  if (!name || !type || (modifierNodes.length > 0 && !modifiers) || (tailNodes.length > 0 && !tail)) return null;
  return { name, type, modifiers: modifiers ?? "", tail: tail ?? "" };
}

/**
 * Whether `statement` is a `CREATE TABLE` whose body is a list of column
 * definitions this module can align. Everything else keeps the query layout.
 */
export function isCreateTable(statement: StatementNode): boolean {
  return createTableParts(statement) !== null;
}

function createTableParts(statement: StatementNode): { clause: ClauseNode; name: AstNode; paren: ParenthesisNode; rest: AstNode[] } | null {
  if (statement.children.length !== 1) return null;
  const clause = statement.children[0];
  if (clause.type !== "clause") return null;
  if (!CREATE_TABLE_KEYWORD.test(clause.nameKw.text.trim())) return null;

  const [name, paren] = clause.children;
  if (name?.type !== "identifier" || paren?.type !== "parenthesis") return null;
  // A `CREATE TABLE ... AS SELECT` has no column list to align.
  if (paren.children.length === 0) return null;
  return { clause, name, paren, rest: clause.children.slice(2) };
}

/** Emits a `CREATE TABLE`, aligning the definition list. */
export function createTableLayout(statement: StatementNode, ctx: SqlLayoutContext): string {
  const parts = createTableParts(statement);
  if (!parts) throw new Error("createTableLayout called on a statement that is not a CREATE TABLE");
  const { clause, name, paren, rest } = parts;

  const writer = new Writer(ctx.options);
  const indent = ctx.options.indentWidth;
  const nameText = renderInline(ctx, [name], ctx.options.lineWidth - clause.nameKw.text.length - 1);
  if (!nameText) throw new Error("a CREATE TABLE table name must fit on one line");

  writer.write(`${keywordText(clause.nameKw.text, ctx)} ${nameText}`);
  writer.newline(0);
  writer.write("(");

  const definitions: Definition[] = splitByComma(paren.children).map((item) => {
    const column = splitColumn(ctx, item);
    return column ? { kind: "column", column } : { kind: "other", nodes: item };
  });

  // Column widths are shared by every line, so measure before emitting.
  const columns = definitions.flatMap((definition) => (definition.kind === "column" ? [definition.column] : []));
  const nameWidth = Math.max(0, ...columns.map((column) => column.name.length));
  const typeWidth = Math.max(0, ...columns.map((column) => column.type.length));
  const modifierWidth = Math.max(0, ...columns.map((column) => column.modifiers.length));

  definitions.forEach((definition, index) => {
    writer.newline(indent);
    if (definition.kind === "column") {
      const { name: columnName, type, modifiers, tail } = definition.column;
      writer.write(columnName.padEnd(nameWidth));
      if (type) writer.write(` ${type.padEnd(typeWidth)}`);
      if (modifiers) writer.write(` ${modifiers.padStart(modifierWidth)}`);
      if (tail) writer.write(` ${tail}`);
    } else {
      emitDefinition(writer, definition.nodes, indent, ctx);
    }
    if (index < definitions.length - 1) writer.write(",");
  });

  writer.newline(0);
  writer.write(")");
  if (rest.length > 0) {
    const options = renderInline(ctx, rest, ctx.options.lineWidth - 1);
    if (options) {
      writer.write(` ${options}`);
    } else {
      writer.newline(indent);
      writer.write(ctx.renderers.block(rest).trim());
      if (endsWithLineComment(rest)) writer.markLineComment();
    }
  }
  if (statement.hasSemicolon) writer.write(";");
  return writer.toString();
}

/**
 * Emits a definition that is not a plain column — a table constraint. The
 * constraint name gets its own line and its body is indented one step.
 */
function emitDefinition(writer: Writer, nodes: AstNode[], indent: number, ctx: SqlLayoutContext): void {
  const flat = renderInline(ctx, nodes, ctx.options.lineWidth - indent);
  if (flat) {
    writer.write(flat);
    return;
  }

  const [first, second] = nodes;
  if (first?.type === "keyword" && second?.type === "identifier") {
    writer.write(`${keywordText(first.text, ctx)} ${renderInline(ctx, [second], ctx.options.lineWidth) ?? second.text}`);
    writer.newline(indent + ctx.options.indentWidth);
    writer.write(ctx.renderers.block(nodes.slice(2)).trim());
    if (endsWithLineComment(nodes.slice(2))) writer.markLineComment();
    return;
  }

  writer.write(ctx.renderers.block(nodes).trim());
  if (endsWithLineComment(nodes)) writer.markLineComment();
}

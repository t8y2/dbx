import type { AstNode, CommentNode, KeywordNode, StatementNode } from "sql-formatter/dist/esm/parser/ast.js";
import type { DataGripLayoutSettings } from "./types";

const DENSE_OPERATORS = new Set(["::", "->", "->>", "#>", "#>>", "!!"]);
const NO_SPACE_BEFORE = new Set([")", "]", ",", ";", "."]);

export function keywordDataGripText(node: KeywordNode, settings: DataGripLayoutSettings, functionName = false): string {
  const text = functionName ? node.text : node.text;
  const raw = node.raw || node.text;
  const mode = functionName ? settings.functionCase : settings.keywordCase;
  if (mode === "upper") return text.toUpperCase();
  if (mode === "lower") return text.toLowerCase();
  return raw.replace(/\s+/g, " ");
}

export function renderDataGripInline(node: AstNode | StatementNode, settings: DataGripLayoutSettings): string {
  return renderDataGripInlineNodes([node as AstNode], settings);
}

export function renderDataGripInlineNodes(nodes: readonly AstNode[], settings: DataGripLayoutSettings): string {
  let output = "";
  let previous: AstNode | null = null;
  for (const node of nodes) {
    const text = renderInlineNode(node, settings);
    if (!text) continue;
    const separator = previous ? dataGripInlineSeparator(previous, node, settings) : "";
    output += separator + text;
    previous = node;
  }
  return output;
}

function renderInlineNode(node: AstNode | StatementNode, settings: DataGripLayoutSettings): string {
  const leading = renderComments(node.leadingComments, settings, true);
  const trailing = renderComments(node.trailingComments, settings, false);
  const body = renderInlineNodeBody(node, settings);
  return [leading, body, trailing].filter(Boolean).join(commentSeparator(leading, trailing));
}

function commentSeparator(leading: string, trailing: string): string {
  return leading || trailing ? " " : "";
}

function renderComments(comments: readonly CommentNode[] | undefined, settings: DataGripLayoutSettings, leading: boolean): string {
  void settings;
  if (!comments?.length) return "";
  return comments.map((comment) => comment.text).join(leading ? "\n" : " ");
}

function renderInlineNodeBody(node: AstNode | StatementNode, settings: DataGripLayoutSettings): string {
  switch (node.type) {
    case "statement":
      return renderDataGripInlineNodes(node.children, settings) + (node.hasSemicolon ? ";" : "");
    case "clause":
    case "set_operation":
      return joinInline(keywordDataGripText(node.nameKw, settings), renderDataGripInlineNodes(node.children, settings));
    case "limit_clause": {
      const count = renderDataGripInlineNodes(node.count, settings);
      const offset = node.offset ? renderDataGripInlineNodes(node.offset, settings) : "";
      return joinInline(keywordDataGripText(node.limitKw, settings), offset ? `${offset}, ${count}` : count);
    }
    case "function_call":
      return keywordDataGripText(node.nameKw, settings, true) + renderInlineNodeBody(node.parenthesis, settings);
    case "parameterized_data_type":
      return dataTypeText(node.dataType.raw || node.dataType.text, settings) + renderInlineNodeBody(node.parenthesis, settings);
    case "array_subscript":
      return renderInlineNodeBody(node.array, settings) + renderInlineNodeBody(node.parenthesis, settings);
    case "property_access":
      return renderInlineNodeBody(node.object, settings) + node.operator + renderInlineNodeBody(node.property, settings);
    case "parenthesis":
      return node.openParen + renderDataGripInlineNodes(node.children, settings) + node.closeParen;
    case "between_predicate":
      return joinInline(renderDataGripInlineNodes(node.expr1, settings), keywordDataGripText(node.betweenKw, settings), keywordDataGripText(node.andKw, settings), renderDataGripInlineNodes(node.expr2, settings));
    case "case_expression":
      return joinInline(keywordDataGripText(node.caseKw, settings), renderDataGripInlineNodes(node.expr, settings), renderDataGripInlineNodes(node.clauses, settings), keywordDataGripText(node.endKw, settings));
    case "case_when":
      return joinInline(keywordDataGripText(node.whenKw, settings), renderDataGripInlineNodes(node.condition, settings), keywordDataGripText(node.thenKw, settings), renderDataGripInlineNodes(node.result, settings));
    case "case_else":
      return joinInline(keywordDataGripText(node.elseKw, settings), renderDataGripInlineNodes(node.result, settings));
    case "all_columns_asterisk":
      return "*";
    case "literal":
      return literalDataGripText(node.text, settings);
    case "identifier":
      return identifierText(node.text, node.quoted, settings);
    case "data_type":
      return dataTypeText(node.raw || node.text, settings);
    case "keyword":
      return keywordDataGripText(node, settings);
    case "parameter":
      return node.text;
    case "operator":
      return node.text;
    case "comma":
      return ",";
    case "line_comment":
    case "block_comment":
    case "disable_comment":
      return node.text;
  }
  throw new Error(`Unsupported DataGrip AST node: ${(node as AstNode).type}`);
}

function identifierText(text: string, quoted: boolean, settings: DataGripLayoutSettings): string {
  if (quoted) return text;
  if (settings.identifierCase === "upper") return text.toUpperCase();
  if (settings.identifierCase === "lower") return text.toLowerCase();
  return text;
}

function dataTypeText(text: string, settings: DataGripLayoutSettings): string {
  if (settings.dataTypeCase === "upper") return text.toUpperCase();
  if (settings.dataTypeCase === "lower") return text.toLowerCase();
  return text;
}
function literalDataGripText(text: string, settings: DataGripLayoutSettings): string {
  if (settings.dialect !== "postgres") return text;
  const match = /^(\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$)([\s\S]*)\1$/.exec(text);
  if (!match) return text;
  const [, delimiter, body] = match;
  if (!/\bBEGIN\b/i.test(body) || !/\s+END$/i.test(body)) return text;
  return delimiter + body.replace(/\s+END$/i, "\nEND") + delimiter;
}

function joinInline(...parts: string[]): string {
  return parts.filter((part) => part.length > 0).join(" ");
}

export function dataGripInlineSeparator(previous: AstNode, next: AstNode, settings: DataGripLayoutSettings): string {
  if (next.type === "line_comment") return next.precedingWhitespace.includes("\n") ? "\n" : " ";
  if (previous.type === "line_comment") return "\n";
  if (next.type === "comma" || (next.type === "operator" && NO_SPACE_BEFORE.has(next.text))) return "";
  if (previous.type === "comma") return " ";
  if (previous.type === "operator" || next.type === "operator") {
    const operator = previous.type === "operator" ? previous.text : next.type === "operator" ? next.text : "";
    return settings.denseOperators || DENSE_OPERATORS.has(operator) ? "" : " ";
  }
  if (next.type === "parenthesis") return " ";
  return " ";
}

export class DataGripWriter {
  private lines = [""];
  private lineCommentOpen = false;

  constructor(private readonly settings: DataGripLayoutSettings) {}

  get column(): number {
    return this.lines[this.lines.length - 1].length;
  }

  get text(): string {
    return this.lines.join("\n").replace(/^\n+|\n+$/g, "");
  }

  get currentLine(): string {
    return this.lines[this.lines.length - 1];
  }

  write(text: string): void {
    if (!text) return;
    if (this.lineCommentOpen) this.newline(this.column);
    const pieces = text.split(/\r\n|\r|\n/);
    for (let index = 0; index < pieces.length; index++) {
      if (index > 0) this.lines.push("");
      this.lines[this.lines.length - 1] += pieces[index];
    }
    if (/(?:\r\n|\r|\n)$/.test(text)) this.lines.push("");
  }

  space(): void {
    if (this.lineCommentOpen) {
      this.newline(this.column);
      return;
    }
    if (this.currentLine && !this.currentLine.endsWith(" ")) this.lines[this.lines.length - 1] += " ";
  }

  writeWithSpace(text: string): void {
    this.space();
    this.write(text);
  }

  newline(indent = 0): void {
    this.lines[this.lines.length - 1] = this.currentLine.trimEnd();
    this.lines.push(this.indentation(indent));
    this.lineCommentOpen = false;
  }

  blankLine(indent = 0): void {
    this.newline(indent);
    this.newline(indent);
  }

  markLineComment(): void {
    this.lineCommentOpen = true;
  }

  trimSpace(): void {
    this.lines[this.lines.length - 1] = this.currentLine.trimEnd();
  }

  private indentation(column: number): string {
    const width = Math.max(1, this.settings.indentWidth);
    if (!this.settings.useTabs) return " ".repeat(Math.max(0, column));
    return "\t".repeat(Math.floor(column / width)) + " ".repeat(Math.max(0, column % width));
  }
}

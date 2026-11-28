import type { AstNode, StatementNode } from "sql-formatter/dist/esm/parser/ast.js";
import { renderDataGripInline, renderDataGripInlineNodes } from "./render";
import type { DataGripBlock, DataGripBlockRole, DataGripLayoutSettings, DataGripRoot } from "./types";

export function buildDataGripBlockTree(statements: StatementNode[], settings: DataGripLayoutSettings): DataGripRoot {
  let nextId = 1;
  const make = (kind: DataGripBlock["kind"], ast?: AstNode | StatementNode, section?: string): DataGripBlock => ({
    id: nextId++,
    kind,
    role: roleForAst(ast),
    shape: "undecided",
    wrap: "none",
    indent: 0,
    align: null,
    minLength: 0,
    hasUserBreaks: false,
    flatText: ast ? renderDataGripInline(ast, settings) : "",
    ast,
    section,
    children: [],
  });

  const grow = (block: DataGripBlock, nested: boolean): void => {
    const ast = block.ast;
    if (!ast) {
      continueBlock(block, nested);
      return;
    }
    if (ast.type === "statement") {
      for (const child of ast.children) {
        const childBlock = make(child.type === "clause" || child.type === "set_operation" ? "section" : "expression", child, sectionName(child));
        block.children.push(childBlock);
        grow(childBlock, nested);
      }
    } else if (hasChildren(ast)) {
      for (const child of ast.children) {
        const kind = child.type === "parenthesis" ? "list" : child.type === "clause" || child.type === "set_operation" ? "section" : isLeafAst(child) ? "leaf" : "expression";
        const childBlock = make(kind, child, sectionName(child));
        block.children.push(childBlock);
        grow(childBlock, true);
      }
    }
    analyzeBlock(block, nested, settings);
  };

  const root: DataGripRoot = { ...make("root"), kind: "root", statements, children: [] };
  for (const statement of statements) {
    const block = make("statement", statement);
    root.children.push(block);
    grow(block, false);
  }
  root.flatText = statements.map((statement) => renderDataGripInline(statement, settings)).join("\n");
  analyzeBlock(root, false, settings);
  refineBlock(root, settings);
  return root;
}

function continueBlock(_block: DataGripBlock, _nested: boolean): void {
  // Root blocks have no AST; their children are grown by the caller.
}

function hasChildren(ast: AstNode | StatementNode): ast is (AstNode | StatementNode) & { children: AstNode[] } {
  return "children" in ast && Array.isArray(ast.children);
}

function isLeafAst(ast: AstNode): boolean {
  return ["literal", "identifier", "data_type", "keyword", "parameter", "operator", "comma", "line_comment", "block_comment", "disable_comment", "all_columns_asterisk"].includes(ast.type);
}

function sectionName(ast: AstNode): string | undefined {
  if (ast.type === "clause" || ast.type === "set_operation") return ast.nameKw.text.toUpperCase();
  if (ast.type === "limit_clause") return ast.limitKw.text.toUpperCase();
  return undefined;
}

function roleForAst(ast: AstNode | StatementNode | undefined): DataGripBlockRole {
  if (!ast) return "none";
  if (ast.type === "comma") return "delimiter";
  if (["line_comment", "block_comment", "disable_comment"].includes(ast.type)) return "comment";
  if (ast.type === "clause" || ast.type === "set_operation" || ast.type === "limit_clause") return "prefix";
  if (ast.type === "keyword" && ["AND", "OR", "XOR"].includes(ast.text)) return "delimiter";
  if (ast.type === "keyword" && ["ASC", "DESC"].includes(ast.text)) return "amendment";
  return "element";
}

function analyzeBlock(block: DataGripBlock, nested: boolean, settings: DataGripLayoutSettings): void {
  for (const child of block.children) analyzeBlock(child, nested || block.kind === "list" || block.kind === "expression", settings);
  block.hasUserBreaks = /[\r\n]/.test(block.flatText) || block.children.some((child) => child.hasUserBreaks);
  const childLength = block.children.reduce((sum, child) => sum + child.minLength, 0);
  block.minLength = block.flatText.length || childLength + Math.floor(block.children.length / 2);
  const expandedChild = block.children.some((child) => child.shape === "multiRows" || (child.shape === "decideLater" && child.minLength > settings.lineWidth));
  const forcedList = isForcedMultiRowList(block, settings);
  if (block.kind === "root" || (block.kind === "statement" && !nested) || forcedList || (block.hasUserBreaks && block.kind !== "list")) {
    block.shape = "multiRows";
  } else if (expandedChild || block.minLength > settings.lineWidth || isForcedMultiRowList(block, settings)) {
    block.shape = "multiRows";
  } else if (block.minLength <= Math.floor((settings.lineWidth * 3) / 5) || block.kind === "leaf" || (block.kind === "list" && !block.children.some((child) => child.role === "delimiter"))) {
    block.shape = "oneRow";
  } else if (block.children.some((child) => child.role !== "none")) {
    block.shape = "decideLater";
  } else {
    block.shape = "oneRow";
  }
}

function isForcedMultiRowList(block: DataGripBlock, settings: DataGripLayoutSettings): boolean {
  if (block.kind !== "list") return false;
  const ast = block.ast;
  if (!ast || ast.type !== "parenthesis") return false;
  const items = block.children.filter((child) => child.role === "element");
  if (items.length <= 1) return false;
  if (block.children.some((child) => child.role === "comment")) return true;
  const mode = settings.customRulesEnabled ? settings.listLayout : "fit";
  if (mode === "vertical") return true;
  if (mode === "singleLine") return false;
  if (mode === "fit") return block.minLength > settings.lineWidth;
  return false;
}

function refineBlock(block: DataGripBlock, settings: DataGripLayoutSettings): void {
  if (block.kind === "statement" || block.kind === "section") block.wrap = block.shape === "multiRows" ? "always" : "chopIfLong";
  if (block.kind === "list") {
    block.wrap = block.shape === "multiRows" ? "always" : block.shape === "oneRow" ? "none" : "chopIfLong";
    const elements = block.children.filter((child) => child.role === "element");
    if (elements.length > 1 && settings.customRulesEnabled && settings.listItemAlignment === "firstItem") {
      const target = Math.max(...elements.map((child) => child.minLength));
      for (const child of elements) child.align = target;
    }
  }
  for (const child of block.children) {
    if (block.kind === "section" && block.shape === "multiRows") child.wrap = child.role === "delimiter" ? "normal" : "chopIfLong";
    refineBlock(child, settings);
  }
}

export function countDataGripBlocks(root: DataGripBlock): number {
  return 1 + root.children.reduce((sum, child) => sum + countDataGripBlocks(child), 0);
}

export function inlineDataGripChildren(block: DataGripBlock, settings: DataGripLayoutSettings): string {
  return block.children.length > 0
    ? renderDataGripInlineNodes(
        block.children.map((child) => child.ast).filter((ast): ast is AstNode => !!ast && ast.type !== "statement"),
        settings,
      )
    : block.flatText;
}

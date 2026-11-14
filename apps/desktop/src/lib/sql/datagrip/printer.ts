import type { AstNode, ClauseNode, KeywordNode, ParenthesisNode, StatementNode } from "sql-formatter/dist/esm/parser/ast.js";
import { NodeType } from "sql-formatter/dist/esm/parser/ast.js";
import type { DataGripLayoutSettings, DataGripRoot } from "./types";
import { dataGripInlineSeparator, DataGripWriter, keywordDataGripText, renderDataGripInline, renderDataGripInlineNodes } from "./render";

const JOIN_WORDS = new Set(["JOIN", "LEFT JOIN", "RIGHT JOIN", "FULL JOIN", "INNER JOIN", "CROSS JOIN", "LEFT OUTER JOIN", "RIGHT OUTER JOIN", "FULL OUTER JOIN", "NATURAL JOIN", "STRAIGHT_JOIN"]);
const LOGICAL_OPERATORS = new Set(["AND", "OR", "XOR"]);

export function printDataGripBlockTree(root: DataGripRoot, source: string, settings: DataGripLayoutSettings): string {
  const writer = new DataGripWriter(settings);
  root.children.forEach((block, index) => {
    if (index > 0) separateStatements(writer, source, settings);
    if (block.ast?.type === "statement") printStatement(writer, block.ast, settings, 0, false);
  });
  let result = writer.text;
  if (/[\r\n]$/.test(source)) result += "\n";
  return result;
}

function separateStatements(writer: DataGripWriter, source: string, settings: DataGripLayoutSettings): void {
  const sourceHasBlank = /;\s*(?:\r\n|\r|\n)[\t ]*(?:\r\n|\r|\n)/.test(source);
  let blankLines = sourceHasBlank ? Math.max(1, settings.linesBetweenQueries) : settings.linesBetweenQueries > 1 ? settings.linesBetweenQueries : 0;
  if (settings.emptyLineMode === "remove") blankLines = 0;
  if (settings.emptyLineMode === "single") blankLines = Math.min(1, blankLines);
  if (settings.emptyLineMode === "preserve" || settings.preserveEmptyLines) blankLines = sourceHasBlank ? Math.max(1, blankLines) : blankLines;
  writer.newline();
  for (let index = 0; index < blankLines; index++) writer.newline();
}

function printStatement(writer: DataGripWriter, statement: StatementNode, settings: DataGripLayoutSettings, baseIndent: number, nested: boolean): void {
  const flat = renderDataGripInline(statement, settings);
  if (nested && !flat.includes("\n") && writer.column + flat.length <= settings.lineWidth) {
    writer.write(flat);
    return;
  }
  if (!nested && settings.customRulesEnabled && settings.collapseShortStatements && !flat.includes("\n") && writer.column + flat.length <= Math.floor((settings.lineWidth * 3) / 5)) {
    writer.write(flat);
    return;
  }
  const firstNode = statement.children[0];
  if (!nested && settings.dialect === "mysql" && firstNode?.type === "clause" && firstNode.nameKw.text === "REPLACE INTO") {
    writer.write(keywordDataGripText({ ...firstNode.nameKw, text: "REPLACE", raw: firstNode.nameKw.raw.replace(/\s+into$/i, "") }, settings));
    writer.newline(baseIndent);
    const into = { ...firstNode, nameKw: { ...firstNode.nameKw, text: "INTO", raw: firstNode.nameKw.raw.slice(-4) } };
    const text = renderDataGripInlineNodes([into, ...statement.children.slice(1)], settings).replace(/,\s+/g, ",");
    writer.write(text);
    if (statement.hasSemicolon) writer.write(";");
    return;
  }

  for (let index = 0; index < statement.children.length; index++) {
    const node = statement.children[index];
    if (index > 0) {
      if (node.type === "limit_clause") writer.space();
      else writer.newline(baseIndent);
    }
    printStatementNode(writer, node, settings, baseIndent);
  }
  if (statement.hasSemicolon) {
    if (settings.newlineBeforeSemicolon || writer.currentLine.includes("--")) writer.newline(baseIndent);
    writer.write(";");
  }
}

function printStatementNode(writer: DataGripWriter, node: AstNode, settings: DataGripLayoutSettings, baseIndent: number): void {
  if (node.type !== "clause" && node.type !== "set_operation" && node.type !== "limit_clause") {
    writeNodes(writer, [node], settings, baseIndent);
    return;
  }
  const keyword = node.type === "limit_clause" ? node.limitKw : node.nameKw;
  const name = keyword.text.toUpperCase();
  if (node.type === "clause" && name === "DELETE FROM") {
    writer.write(keywordDataGripText({ ...keyword, text: "DELETE", raw: keyword.raw.replace(/\s+from$/i, "") }, settings));
    writer.newline(baseIndent);
    const fromKeyword = { ...keyword, text: "FROM", raw: keyword.raw.slice(-4) };
    printSection(writer, fromKeyword, node.children, "FROM", settings, baseIndent);
    return;
  }
  if (node.type === "clause" && name === "REPLACE INTO") {
    writer.write(keywordDataGripText({ ...keyword, text: "REPLACE", raw: keyword.raw.replace(/\s+into$/i, "") }, settings));
    writer.newline(baseIndent);
    const intoKeyword = { ...keyword, text: "INTO", raw: keyword.raw.slice(-4) };
    printSection(writer, intoKeyword, node.children, "INTO", settings, baseIndent);
    return;
  }
  const children = node.type === "limit_clause" ? [...(node.offset ?? []), ...(node.offset ? [{ type: "comma" } as AstNode] : []), ...node.count] : node.children;
  printSection(writer, keyword, children, name, settings, baseIndent);
}

function printSection(writer: DataGripWriter, keyword: ClauseNode["nameKw"], children: AstNode[], name: string, settings: DataGripLayoutSettings, baseIndent: number): void {
  writeAttachedComments(writer, keyword.leadingComments, settings, baseIndent);
  writer.write(keywordDataGripText(keyword, settings));

  if (name.startsWith("CREATE TABLE")) {
    printCreateTableBody(writer, children, settings, baseIndent);
  } else if (name === "SELECT" || name.startsWith("SELECT ")) {
    printSelectList(writer, children, settings, baseIndent + keyword.text.length + 1);
  } else if (name === "FROM") {
    printFrom(writer, children, settings, baseIndent, keyword.text.length);
  } else if (name === "WHERE" || name === "HAVING" || name === "ON") {
    printConditions(writer, children, settings, baseIndent, name);
  } else if (name === "VALUES") {
    printValues(writer, children, settings, baseIndent + keyword.text.length + 1);
  } else if (name === "SET" || name === "GROUP BY" || name === "ORDER BY" || name === "WITH" || name === "RETURNING") {
    printCommaList(writer, children, settings, baseIndent + keyword.text.length + 1, name);
  } else {
    if (children.length > 0) writer.space();
    writeNodes(writer, children, settings, baseIndent);
  }
  writeAttachedComments(writer, keyword.trailingComments, settings, baseIndent);
}

function printSelectList(writer: DataGripWriter, children: AstNode[], settings: DataGripLayoutSettings, itemColumn: number): void {
  const items = splitRole(children, "comma");
  if (items.length <= 1 || shouldKeepListInline(children, items.length, settings, "select")) {
    writer.space();
    writeNodes(writer, children, settings, itemColumn);
    return;
  }
  const aliases = settings.alignSelectAliases ? alignedSelectItems(items, settings) : null;
  items.forEach((item, index) => {
    if (index === 0) writer.space();
    else {
      writer.newline(settings.commaPosition === "before" ? Math.max(0, itemColumn - 2) : itemColumn);
      if (settings.commaPosition === "before") {
        writer.write(",");
        writer.space();
      }
    }
    if (aliases?.[index]) {
      writer.write(aliases[index].expression);
      writer.write(" ".repeat(aliases[index].padding));
      writer.write(aliases[index].alias);
    } else {
      writeNodes(writer, item, settings, itemColumn);
    }
    if (index < items.length - 1 && settings.commaPosition === "after") writer.write(",");
  });
}

function shouldKeepListInline(children: AstNode[], count: number, settings: DataGripLayoutSettings, kind: "select" | "insert" | "update" | "general"): boolean {
  if (children.some((node) => node.type === "line_comment")) return false;
  const text = renderDataGripInlineNodes(children, settings);
  if (text.includes("\n")) return false;
  const override = kind === "select" ? settings.selectListLayout : kind === "insert" ? settings.insertListLayout : kind === "update" ? settings.updateListLayout : "inherit";
  const mode = settings.customRulesEnabled ? (override === "inherit" ? settings.listLayout : override) : "fit";
  if (mode === "singleLine") return true;
  if (mode === "vertical") return false;
  if (kind === "select" && count > 7 && text.length >= Math.floor((settings.lineWidth * 3) / 5)) return false;
  return text.length <= settings.lineWidth;
}

function alignedSelectItems(items: AstNode[][], settings: DataGripLayoutSettings): Array<{ expression: string; alias: string; padding: number } | null> | null {
  const parsed = items.map((item) => {
    const asIndex = item.findIndex((node) => node.type === "keyword" && node.text === "AS");
    if (asIndex < 0) return null;
    const expression = renderDataGripInlineNodes(item.slice(0, asIndex), settings);
    const alias = renderDataGripInlineNodes(item.slice(asIndex), settings);
    return { expression, alias, padding: 1 };
  });
  if (parsed.some((item) => !item)) return null;
  const width = Math.max(...parsed.map((item) => item!.expression.length));
  return parsed.map((item) => ({ ...item!, padding: width - item!.expression.length + 1 }));
}

function printFrom(writer: DataGripWriter, children: AstNode[], settings: DataGripLayoutSettings, baseIndent: number, keywordLength: number): void {
  const firstJoin = children.findIndex((node) => node.type === "keyword" && JOIN_WORDS.has(node.text));
  const primary = firstJoin < 0 ? children : children.slice(0, firstJoin);
  if (settings.fromClauseLayout === "newLine") writer.newline(baseIndent + settings.indentWidth);
  else writer.space();
  writeNodes(writer, primary, settings, baseIndent);
  if (firstJoin < 0) return;
  let index = firstJoin;
  while (index < children.length) {
    const join = children[index];
    const next = children.findIndex((node, candidate) => candidate > index && node.type === "keyword" && JOIN_WORDS.has(node.text));
    const end = next < 0 ? children.length : next;
    writer.newline(baseIndent + keywordLength + 1 + settings.indentWidth);
    writeNodes(writer, children.slice(index, end), settings, baseIndent + keywordLength + 1 + settings.indentWidth);
    index = end;
    void join;
  }
}

function printConditions(writer: DataGripWriter, children: AstNode[], settings: DataGripLayoutSettings, baseIndent: number, section: string): void {
  const groups = splitLogical(children);
  if (groups.length <= 1 || settings.logicalOperatorNewline === "none") {
    writer.space();
    writeNodes(writer, children, settings, baseIndent);
    return;
  }
  groups.forEach((group, index) => {
    if (index === 0) writer.space();
    else writer.newline(baseIndent + settings.continuationIndentWidth);
    if (index > 0 && settings.logicalOperatorNewline === "before") {
      writer.write(keywordDataGripText(group.operator!, settings));
      writer.space();
    }
    writeNodes(writer, group.nodes, settings, baseIndent + settings.continuationIndentWidth);
    if (index < groups.length - 1 && settings.logicalOperatorNewline === "after") {
      writer.space();
      writer.write(keywordDataGripText(groups[index + 1].operator!, settings));
    }
  });
  void section;
}

function splitLogical(children: AstNode[]): Array<{ nodes: AstNode[]; operator?: KeywordNode }> {
  const groups: Array<{ nodes: AstNode[]; operator?: KeywordNode }> = [];
  let current: AstNode[] = [];
  let pending: KeywordNode | undefined;
  for (const node of children) {
    if (node.type === "keyword" && LOGICAL_OPERATORS.has(node.text)) {
      groups.push({ nodes: current, operator: pending });
      current = [];
      pending = node;
    } else current.push(node);
  }
  groups.push({ nodes: current, operator: pending });
  return groups;
}

function printValues(writer: DataGripWriter, children: AstNode[], settings: DataGripLayoutSettings, itemColumn: number): void {
  const rows = splitRole(children, "comma");
  rows.forEach((row, index) => {
    if (index === 0) writer.space();
    else {
      writer.newline(settings.commaPosition === "before" ? Math.max(0, itemColumn - 2) : itemColumn);
      if (settings.commaPosition === "before") {
        writer.write(",");
        writer.space();
      }
    }
    writeNodes(writer, row, settings, itemColumn);
    if (index < rows.length - 1 && settings.commaPosition === "after") writer.write(",");
  });
}

function printCommaList(writer: DataGripWriter, children: AstNode[], settings: DataGripLayoutSettings, itemColumn: number, section: string): void {
  const items = splitRole(children, "comma");
  if (section !== "SET" && shouldKeepListInline(children, items.length, settings, section === "SET" ? "update" : "general")) {
    writer.space();
    writeNodes(writer, children, settings, itemColumn);
    return;
  }
  items.forEach((item, index) => {
    if (index === 0) writer.space();
    else {
      writer.newline(settings.commaPosition === "before" ? Math.max(0, itemColumn - 2) : itemColumn);
      if (settings.commaPosition === "before") {
        writer.write(",");
        writer.space();
      }
    }
    writeNodes(writer, item, settings, itemColumn, section === "SET");
    if (index < items.length - 1 && settings.commaPosition === "after") writer.write(",");
  });
}

function printCreateTableBody(writer: DataGripWriter, children: AstNode[], settings: DataGripLayoutSettings, baseIndent: number): void {
  const parenthesisIndex = children.findIndex((node): node is ParenthesisNode => node.type === "parenthesis");
  if (parenthesisIndex < 0) {
    writer.space();
    writeNodes(writer, children, settings, baseIndent);
    return;
  }
  const parenthesis = children[parenthesisIndex] as ParenthesisNode;
  writer.space();
  writeNodes(writer, children.slice(0, parenthesisIndex), settings, baseIndent);
  writer.newline(baseIndent);
  writer.write(parenthesis.openParen);
  const rows = splitRole(parenthesis.children, "comma");
  const rendered = renderTableRows(rows, settings);
  rows.forEach((_row, index) => {
    writer.newline(baseIndent + settings.indentWidth);
    writer.write(rendered[index]);
    if (index < rows.length - 1) writer.write(",");
  });
  writer.newline(baseIndent);
  writer.write(parenthesis.closeParen);
  const remainder = children.slice(parenthesisIndex + 1);
  if (remainder.length > 0) {
    writer.space();
    writeNodes(writer, remainder, settings, baseIndent);
  }
}

function renderTableRows(rows: AstNode[][], settings: DataGripLayoutSettings): string[] {
  const parsed = rows.map((row) => {
    const first = row[0];
    if (!first || first.type !== "identifier") return { name: "", body: renderDataGripInlineNodes(row, settings), constraint: true };
    const typeIndex = row.findIndex((node, index) => index > 0 && node.type === "data_type");
    const name = renderDataGripInline(first, settings);
    const body =
      typeIndex >= 0 ? renderDataGripInlineNodes(row.slice(1, typeIndex), settings) + renderDataGripInline(row[typeIndex], settings) + (typeIndex < row.length - 1 ? " " + renderDataGripInlineNodes(row.slice(typeIndex + 1), settings) : "") : renderDataGripInlineNodes(row.slice(1), settings);
    return { name, body, constraint: false };
  });
  const width = Math.max(0, ...parsed.filter((row) => !row.constraint).map((row) => row.name.length));
  return parsed.map((row) => (row.constraint ? row.body : row.name + " ".repeat(Math.max(1, width - row.name.length + 1)) + row.body));
}

function splitRole(children: AstNode[], type: "comma"): AstNode[][] {
  const groups: AstNode[][] = [];
  let current: AstNode[] = [];
  for (const node of children) {
    if (node.type === type) {
      groups.push(current);
      current = [];
    } else current.push(node);
  }
  groups.push(current);
  return groups;
}

function writeNodes(writer: DataGripWriter, nodes: AstNode[], settings: DataGripLayoutSettings, baseIndent: number, assignment = false): void {
  let previous: AstNode | null = null;
  for (const node of nodes) {
    const compactEquals = assignment && ((node.type === "operator" && node.text === "=") || (previous?.type === "operator" && previous.text === "="));
    if (compactEquals) writer.trimSpace();
    else if (previous) {
      const separator = dataGripInlineSeparator(previous, node, settings);
      if (separator.includes("\n")) writer.newline(baseIndent);
      else if (separator) writer.space();
    }
    writeNode(writer, node, settings, baseIndent, assignment);
    previous = node;
  }
}

function writeNode(writer: DataGripWriter, node: AstNode, settings: DataGripLayoutSettings, baseIndent: number, assignment: boolean): void {
  if (node.type === "parenthesis" && containsQuery(node)) {
    const inline = renderDataGripInline(node, settings);
    if (!inline.includes("\n") && writer.column + inline.length <= settings.lineWidth) {
      writer.write(inline);
      return;
    }
    writer.write(node.openParen);
    writer.newline(baseIndent + settings.indentWidth);
    printStatement(writer, { type: NodeType.statement, children: node.children, hasSemicolon: false }, settings, baseIndent + settings.indentWidth, true);
    writer.newline(baseIndent);
    writer.write(node.closeParen);
    return;
  }
  if (node.type === "case_expression") {
    const inline = renderDataGripInline(node, settings);
    if (!inline.includes("\n") && writer.column + inline.length <= settings.lineWidth) {
      writer.write(inline);
      return;
    }
  }
  if (assignment && node.type === "operator" && node.text === "=") {
    // DataGrip's SET assignment block owns a compact equals sign.

    writer.write("=");
    return;
  }
  writer.write(renderDataGripInline(node, settings));
  if (node.type === "line_comment") writer.markLineComment();
}

function containsQuery(node: ParenthesisNode): boolean {
  return node.children.some((child) => child.type === "clause" || child.type === "set_operation");
}

function writeAttachedComments(writer: DataGripWriter, comments: ClauseNode["nameKw"]["leadingComments"], settings: DataGripLayoutSettings, baseIndent: number): void {
  if (!comments?.length) return;
  for (const comment of comments) {
    if (writer.currentLine.length > 0) writer.space();
    writer.write(comment.text);
    if (comment.type === "line_comment") writer.newline(baseIndent);
  }
  void settings;
}

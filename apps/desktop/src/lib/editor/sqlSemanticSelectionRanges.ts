import type { DatabaseType } from "@/types/database";
import { sqlSemanticDialectFor } from "@/lib/sql/semantic/dialect";
import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";
import { createSemanticSelectionRangeIndex, type SemanticSelectionContext, type SemanticSelectionRange, type SemanticSelectionRangeIndex } from "@/lib/editor/semanticSelectionRanges";

export interface SqlSemanticSelectionOptions {
  databaseType?: DatabaseType;
  dialect?: "mysql" | "postgres" | "sqlserver" | "clickhouse";
}

interface SqlSelectionToken {
  kind: SqlSemanticToken["kind"];
  text: string;
  normalized: string;
  from: number;
  to: number;
  depth: number;
  quote?: string;
}

interface StatementWindow {
  start: number;
  end: number;
  tokens: SqlSelectionToken[];
}

interface PreparedStatementWindow extends StatementWindow {
  ranges?: SemanticSelectionRangeIndex;
}

interface QueryBlockRange extends SemanticSelectionRange {
  depth: number;
}

export interface SqlSemanticSelectionAnalysis {
  doc: string;
  statements: readonly PreparedStatementWindow[];
}

const QUERY_CLAUSE_WORDS = new Set(["where", "having", "on", "using", "limit", "offset", "fetch", "returning", "qualify", "window"]);
const SET_OPERATOR_WORDS = new Set(["union", "intersect", "except", "minus"]);
const COMBINED_OPERATORS = new Set(["!=", "<>", "<=", ">=", "||", "::", "->", "->>"]);
const SQL_BINARY_PRECEDENCE: Record<string, number> = {
  or: 10,
  and: 20,
  "=": 30,
  "!=": 30,
  "<>": 30,
  "<": 30,
  "<=": 30,
  ">": 30,
  ">=": 30,
  is: 30,
  in: 30,
  like: 30,
  between: 30,
  "||": 40,
  "+": 50,
  "-": 50,
  "*": 60,
  "/": 60,
  "%": 60,
};

function addRange(ranges: SemanticSelectionRange[], from: number, to: number) {
  if (from < to) ranges.push({ from, to });
}

function addTrimmedRange(input: string, ranges: SemanticSelectionRange[], from: number, to: number) {
  while (from < to && /\s/.test(input[from] ?? "")) from += 1;
  while (to > from && /\s/.test(input[to - 1] ?? "")) to -= 1;
  addRange(ranges, from, to);
}

function significantTokens(tokens: SqlSelectionToken[]): SqlSelectionToken[] {
  return tokens.filter((token) => token.kind !== "comment");
}

function normalizeTokens(input: string, tokens: SqlSemanticToken[]): SqlSelectionToken[] {
  const result: SqlSelectionToken[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const next = tokens[index + 1];
    if (token.kind === "operator" && next?.kind === "operator" && token.span.end === next.span.start) {
      const combined = `${token.text}${next.text}`;
      const nextNext = tokens[index + 2];
      const triple = nextNext?.kind === "operator" && next.span.end === nextNext.span.start ? `${combined}${nextNext.text}` : "";
      if (triple && COMBINED_OPERATORS.has(triple)) {
        result.push({ kind: "operator", text: triple, normalized: triple, from: token.span.start, to: nextNext.span.end, depth: token.depth });
        index += 2;
        continue;
      }
      if (COMBINED_OPERATORS.has(combined)) {
        result.push({ kind: "operator", text: combined, normalized: combined, from: token.span.start, to: next.span.end, depth: token.depth });
        index += 1;
        continue;
      }
    }
    result.push({ kind: token.kind, text: input.slice(token.span.start, token.span.end), normalized: token.normalized, from: token.span.start, to: token.span.end, depth: token.depth, quote: token.quote });
  }
  return result;
}

function validateTokens(input: string, tokens: SqlSelectionToken[]): boolean {
  const stack: SqlSelectionToken[] = [];
  for (const token of tokens) {
    if (token.kind === "string") {
      const quote = token.quote ?? token.text[0] ?? "";
      if (quote.startsWith("$") ? !token.text.endsWith(quote) : !token.text.endsWith(quote)) return false;
    }
    if (token.kind === "comment" && token.text.startsWith("/*") && !token.text.endsWith("*/")) return false;
    if (token.text === "(") stack.push(token);
    if (token.text === ")") {
      if (stack.length === 0) return false;
      stack.pop();
    }
  }
  if (stack.length > 0) return false;
  return input.trim().length > 0;
}

function statementWindows(input: string, tokens: SqlSelectionToken[]): StatementWindow[] {
  const significant = significantTokens(tokens);
  const boundaries = [-1, ...significant.map((token, index) => (token.text === ";" && token.depth === 0 ? index : -1)).filter((index) => index >= 0), significant.length];
  const statements: StatementWindow[] = [];
  for (let boundaryIndex = 0; boundaryIndex < boundaries.length - 1; boundaryIndex += 1) {
    const left = boundaries[boundaryIndex] ?? -1;
    const right = boundaries[boundaryIndex + 1] ?? significant.length;
    const first = significant[left + 1];
    const last = significant[right - 1];
    if (!first) continue;
    const start = first.from;
    const end = last?.text === ";" ? last.from : (last?.to ?? input.length);
    statements.push({ start, end, tokens: significant.slice(left + 1, last?.text === ";" ? right - 1 : right) });
  }
  return statements;
}

function parenthesisMaps(tokens: SqlSelectionToken[]): { opening: Map<number, number>; closing: Map<number, number> } | null {
  const stack: number[] = [];
  const opening = new Map<number, number>();
  const closing = new Map<number, number>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === "(") stack.push(index);
    if (token.text === ")") {
      const open = stack.pop();
      if (open == null) return null;
      opening.set(open, index);
      closing.set(index, open);
    }
  }
  return stack.length === 0 ? { opening, closing } : null;
}

function clauseStart(tokens: SqlSelectionToken[], index: number): number {
  const token = tokens[index];
  if (!token || token.kind !== "word") return 0;
  if ((token.normalized === "group" || token.normalized === "order") && tokens[index + 1]?.normalized === "by") return token.from;
  return token.normalized === "from" || token.normalized === "select" ? token.from : token.from;
}

function isClauseAt(tokens: SqlSelectionToken[], index: number): boolean {
  const token = tokens[index];
  if (!token || token.kind !== "word") return false;
  if ((token.normalized === "group" || token.normalized === "order") && tokens[index + 1]?.normalized === "by") return true;
  return QUERY_CLAUSE_WORDS.has(token.normalized);
}

function rangeEndForDepth(tokens: SqlSelectionToken[], startIndex: number, statementEnd: number): number {
  const depth = tokens[startIndex]?.depth ?? 0;
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.text === ")" && token.depth < depth) return token.from;
  }
  return statementEnd;
}

function queryBlockEnd(tokens: SqlSelectionToken[], startIndex: number, statementEnd: number): number {
  const depth = tokens[startIndex]?.depth ?? 0;
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === ")" && token.depth < depth) return token.from;
    if (token.depth === depth && token.kind === "word" && SET_OPERATOR_WORDS.has(token.normalized)) return token.from;
  }
  return statementEnd;
}

function nextClauseOrSetBoundary(tokens: SqlSelectionToken[], startIndex: number, statementEnd: number): number {
  const depth = tokens[startIndex]?.depth ?? 0;
  for (let index = startIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === ")" && token.depth < depth) return token.from;
    if (token.depth !== depth) continue;
    if (isClauseAt(tokens, index) || (token.kind === "word" && SET_OPERATOR_WORDS.has(token.normalized))) return token.from;
  }
  return rangeEndForDepth(tokens, startIndex, statementEnd);
}

function isExpressionBoundary(token: SqlSelectionToken | undefined): boolean {
  if (!token) return true;
  if (token.text === "," || token.text === ";") return true;
  if (token.kind !== "word") return false;
  return token.normalized === "select" || token.normalized === "from" || token.normalized === "join" || token.normalized === "group" || token.normalized === "order" || token.normalized === "as" || SET_OPERATOR_WORDS.has(token.normalized) || isClauseAt([token], 0);
}

function isBetweenAnd(tokens: SqlSelectionToken[], direct: number[], operatorPosition: number): boolean {
  for (let position = operatorPosition - 1; position >= 0; position -= 1) {
    const token = tokens[direct[position] ?? -1];
    if (!token || isExpressionBoundary(token) || token.normalized === "and" || token.normalized === "or") return false;
    if (token.kind === "word" && token.normalized === "between") return true;
  }
  return false;
}

function rangeForDirectTokens(tokens: SqlSelectionToken[], direct: number[], from: number, to: number, maps: { opening: Map<number, number>; closing: Map<number, number> }): SemanticSelectionRange | null {
  const firstIndex = direct[from];
  const lastIndex = direct[to - 1];
  const first = firstIndex == null ? undefined : tokens[firstIndex];
  const last = lastIndex == null ? undefined : tokens[lastIndex];
  if (!first || !last) return null;
  const closingIndex = last.text === "(" ? maps.opening.get(lastIndex) : undefined;
  return { from: first.from, to: closingIndex == null ? last.to : (tokens[closingIndex]?.to ?? last.to) };
}

function isUnarySign(tokens: SqlSelectionToken[], direct: number[], position: number): boolean {
  const token = tokens[direct[position] ?? -1];
  if (!token || (token.normalized !== "+" && token.normalized !== "-")) return false;
  if (position === 0) return true;
  const previous = tokens[direct[position - 1] ?? -1];
  return previous != null && SQL_BINARY_PRECEDENCE[previous.normalized] != null;
}

function operandEndForOperator(tokens: SqlSelectionToken[], direct: number[], operatorPosition: number): number {
  const operator = tokens[direct[operatorPosition] ?? -1];
  const previous = tokens[direct[operatorPosition - 1] ?? -1];
  return previous?.normalized === "not" && (operator?.normalized === "in" || operator?.normalized === "like" || operator?.normalized === "between") ? operatorPosition - 1 : operatorPosition;
}

function collectExpressionSection(tokens: SqlSelectionToken[], direct: number[], maps: { opening: Map<number, number>; closing: Map<number, number> }, ranges: SemanticSelectionRange[]) {
  const operatorPositions: number[] = [];
  for (let position = 0; position < direct.length; position += 1) {
    const token = tokens[direct[position] ?? -1];
    if (!token || SQL_BINARY_PRECEDENCE[token.normalized] == null || isUnarySign(tokens, direct, position)) continue;
    if (token.normalized !== "and" || !isBetweenAnd(tokens, direct, position)) operatorPositions.push(position);
  }
  if (operatorPositions.length === 0) return;

  const operands: SemanticSelectionRange[] = [];
  let start = 0;
  for (const operatorPosition of operatorPositions) {
    const operand = rangeForDirectTokens(tokens, direct, start, operandEndForOperator(tokens, direct, operatorPosition), maps);
    if (!operand) return;
    operands.push(operand);
    start = operatorPosition + 1;
  }
  const lastOperand = rangeForDirectTokens(tokens, direct, start, direct.length, maps);
  if (!lastOperand || operands.length !== operatorPositions.length) return;
  operands.push(lastOperand);
  for (let index = 0; index < operands.length; index += 1) {
    const previousOperatorPosition = operatorPositions[index - 1];
    const previousOperator = previousOperatorPosition == null ? undefined : tokens[direct[previousOperatorPosition] ?? -1];
    if (previousOperator?.normalized !== "between") {
      const operand = operands[index];
      if (operand) addRange(ranges, operand.from, operand.to);
    }
  }

  const expressionStack: SemanticSelectionRange[] = [operands[0] as SemanticSelectionRange];
  const operatorStack: SqlSelectionToken[] = [];
  const reduce = () => {
    const right = expressionStack.pop();
    const left = expressionStack.pop();
    operatorStack.pop();
    if (!left || !right) return false;
    const combined = { from: left.from, to: right.to };
    expressionStack.push(combined);
    addRange(ranges, combined.from, combined.to);
    return true;
  };

  for (let index = 0; index < operatorPositions.length; index += 1) {
    const operator = tokens[direct[operatorPositions[index] ?? -1] ?? -1];
    const operand = operands[index + 1];
    if (!operator || !operand) return;
    const precedence = SQL_BINARY_PRECEDENCE[operator.normalized] ?? 0;
    while ((SQL_BINARY_PRECEDENCE[operatorStack[operatorStack.length - 1]?.normalized ?? ""] ?? -1) >= precedence) {
      if (!reduce()) return;
    }
    operatorStack.push(operator);
    expressionStack.push(operand);
  }
  while (operatorStack.length > 0) {
    if (!reduce()) return;
  }
}

function collectExpressionRanges(tokens: SqlSelectionToken[], start: number, end: number, maps: { opening: Map<number, number>; closing: Map<number, number> }, ranges: SemanticSelectionRange[]) {
  const direct: number[] = [];
  for (let index = start; index < end; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.text === "(") {
      const close = maps.opening.get(index);
      if (close == null || close >= end) return;
      collectExpressionRanges(tokens, index + 1, close, maps, ranges);
      direct.push(index);
      index = close;
      continue;
    }
    if (token.text === ")") continue;
    direct.push(index);
  }

  let sectionStart = 0;
  for (let position = 0; position <= direct.length; position += 1) {
    const token = position === direct.length ? undefined : tokens[direct[position] ?? -1];
    if (!isExpressionBoundary(token)) continue;
    collectExpressionSection(tokens, direct.slice(sectionStart, position), maps, ranges);
    sectionStart = position + 1;
  }
}

function collectSqlRanges(input: string, statement: StatementWindow, maps: { opening: Map<number, number>; closing: Map<number, number> }): SemanticSelectionRange[] {
  const tokens = statement.tokens;
  const ranges: SemanticSelectionRange[] = [];
  const queryBlocks: QueryBlockRange[] = [];
  const setExpressions: QueryBlockRange[] = [];
  addRange(ranges, statement.start, statement.end);
  for (const token of tokens) {
    if (token.kind === "string") {
      const quote = token.quote ?? token.text[0] ?? "";
      const quoteLength = quote.startsWith("$") ? quote.length : 1;
      addRange(ranges, token.from + quoteLength, token.to - quoteLength);
      addRange(ranges, token.from, token.to);
    }
  }
  for (const [open, close] of maps.opening) {
    const opening = tokens[open];
    const closing = tokens[close];
    if (!opening || !closing) continue;
    addRange(ranges, opening.to, closing.from);
    const functionName = tokens[open - 1];
    if (functionName?.kind !== "word") addRange(ranges, opening.from, closing.to);
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.kind === "word" && token.normalized === "select") {
      const previousLength = ranges.length;
      addTrimmedRange(input, ranges, token.from, queryBlockEnd(tokens, index, statement.end));
      const queryBlock = ranges.length > previousLength ? ranges[ranges.length - 1] : undefined;
      if (queryBlock) queryBlocks.push({ ...queryBlock, depth: token.depth });
    }
    if (isClauseAt(tokens, index)) addTrimmedRange(input, ranges, clauseStart(tokens, index), nextClauseOrSetBoundary(tokens, index, statement.end));
    if (token.kind === "word" && !isExpressionBoundary(token) && maps.opening.has(index + 1)) {
      const close = maps.opening.get(index + 1);
      const closing = close == null ? undefined : tokens[close];
      if (closing) addTrimmedRange(input, ranges, token.from, closing.to);
    }
  }
  collectExpressionRanges(tokens, 0, tokens.length, maps, ranges);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.kind === "word" && SET_OPERATOR_WORDS.has(token.normalized)) {
      const left = [...queryBlocks, ...setExpressions].filter((range) => range.depth === token.depth && range.to <= token.from).sort((a, b) => b.to - a.to || a.from - b.from)[0];
      const right = queryBlocks.filter((range) => range.depth === token.depth && range.from >= token.to).sort((a, b) => a.from - b.from || a.to - b.to)[0];
      if (left && right) {
        const expression = { from: left.from, to: right.to, depth: token.depth };
        addRange(ranges, expression.from, expression.to);
        setExpressions.push(expression);
      }
    }
  }
  return ranges;
}

export function analyzeSqlSemanticSelectionRanges(doc: string, options: SqlSemanticSelectionOptions = {}): SqlSemanticSelectionAnalysis {
  const dialect = sqlSemanticDialectFor(options).id;
  const rawTokens = tokenizeSqlSemantic(doc, dialect);
  const validationTokens = rawTokens.map((token) => ({ kind: token.kind, text: token.text, normalized: token.normalized, from: token.span.start, to: token.span.end, depth: token.depth, quote: token.quote }));
  const tokens = normalizeTokens(doc, rawTokens);
  const statements: PreparedStatementWindow[] = statementWindows(doc, tokens).filter((statement) => {
    const statementValidationTokens = validationTokens.filter((token) => token.from >= statement.start && token.to <= statement.end);
    return validateTokens(doc.slice(statement.start, statement.end), statementValidationTokens);
  });
  return { doc, statements };
}

function findStatement(context: SemanticSelectionContext, analysis: SqlSemanticSelectionAnalysis): PreparedStatementWindow | undefined {
  let low = 0;
  let high = analysis.statements.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if ((analysis.statements[middle]?.start ?? Number.POSITIVE_INFINITY) <= context.cursor) low = middle + 1;
    else high = middle;
  }
  const statement = analysis.statements[low - 1];
  if (!statement || context.cursor < statement.start || context.cursor > statement.end) return undefined;
  if (context.current.from < statement.start || context.current.to > statement.end) return undefined;
  return statement;
}

function statementRangeIndex(doc: string, statement: PreparedStatementWindow): SemanticSelectionRangeIndex | null {
  if (statement.ranges) return statement.ranges;
  const maps = parenthesisMaps(statement.tokens);
  if (!maps) return null;
  statement.ranges = createSemanticSelectionRangeIndex(collectSqlRanges(doc, statement, maps));
  return statement.ranges;
}

export function sqlSemanticSelectionRanges(context: SemanticSelectionContext, options: SqlSemanticSelectionOptions = {}, analysis = analyzeSqlSemanticSelectionRanges(context.doc, options)): SemanticSelectionRange[] {
  if (analysis.doc !== context.doc) analysis = analyzeSqlSemanticSelectionRanges(context.doc, options);
  const statement = findStatement(context, analysis);
  return statement ? (statementRangeIndex(context.doc, statement)?.containing(context.current) ?? []) : [];
}

export function nextSqlSemanticSelectionRange(context: SemanticSelectionContext, options: SqlSemanticSelectionOptions = {}, analysis = analyzeSqlSemanticSelectionRanges(context.doc, options)): SemanticSelectionRange | null {
  if (analysis.doc !== context.doc) analysis = analyzeSqlSemanticSelectionRanges(context.doc, options);
  const statement = findStatement(context, analysis);
  return statement ? (statementRangeIndex(context.doc, statement)?.findNext(context.current, context.cursor) ?? null) : null;
}

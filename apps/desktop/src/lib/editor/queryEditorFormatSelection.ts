import { tokenizeSqlSemantic } from "@/lib/sql/semantic/tokens";
import type { SqlSemanticToken } from "@/lib/sql/semantic/types";

export interface QueryEditorFormatSelection {
  anchor: number;
  head: number;
}

interface StatementSpan {
  from: number;
  to: number;
  tokens: SqlSemanticToken[];
}

interface StatementMapping {
  source: StatementSpan;
  formatted: StatementSpan;
  tokenMatches: Map<number, number>;
}

function clampPosition(position: number, length: number): number {
  return Math.max(0, Math.min(length, position));
}

function tokenKey(value: SqlSemanticToken): string {
  return `${value.kind}\0${value.normalized}`;
}

function tokenizeForFormatting(text: string, dialectId: string): SqlSemanticToken[] {
  const mysqlFamily = dialectId === "mysql" || dialectId === "doris";
  return tokenizeSqlSemantic(text, dialectId, {
    mysqlBackslashEscape: mysqlFamily,
    mysqlDashCommentRequiresWhitespace: mysqlFamily,
  });
}

function statementSpans(text: string, tokens: readonly SqlSemanticToken[]): StatementSpan[] {
  const statements: StatementSpan[] = [];
  let from = 0;
  let tokenFrom = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const current = tokens[index]!;
    if (current.kind !== "punctuation" || current.text !== ";" || current.depth !== 0) continue;
    statements.push({ from, to: current.span.end, tokens: tokens.slice(tokenFrom, index + 1) });
    from = current.span.end;
    tokenFrom = index + 1;
  }

  statements.push({ from, to: text.length, tokens: tokens.slice(tokenFrom) });
  return statements;
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Keeps only a monotonic chain of unique token matches. This is a small
 * patience-diff style fallback: formatting never intentionally reorders SQL
 * tokens, so a crossing match is less trustworthy than leaving that region to
 * the statement-relative fallback.
 */
function monotonicTokenMatches(candidates: ReadonlyArray<readonly [number, number]>): Map<number, number> {
  if (candidates.length === 0) return new Map();

  const tails: number[] = [];
  const tailCandidates: number[] = [];
  const previous = Array.from({ length: candidates.length }, () => -1);

  for (let index = 0; index < candidates.length; index += 1) {
    const formattedIndex = candidates[index]![1];
    const insertion = lowerBound(tails, formattedIndex);
    tails[insertion] = formattedIndex;
    previous[index] = insertion > 0 ? tailCandidates[insertion - 1]! : -1;
    tailCandidates[insertion] = index;
  }

  const matches = new Map<number, number>();
  let candidateIndex = tailCandidates[tails.length - 1] ?? -1;
  while (candidateIndex >= 0) {
    const [sourceIndex, formattedIndex] = candidates[candidateIndex]!;
    matches.set(sourceIndex, formattedIndex);
    candidateIndex = previous[candidateIndex]!;
  }
  return matches;
}

function buildTokenMatches(source: readonly SqlSemanticToken[], formatted: readonly SqlSemanticToken[]): Map<number, number> {
  if (source.length === formatted.length && source.every((value, index) => tokenKey(value) === tokenKey(formatted[index]!))) {
    return new Map(source.map((_, index) => [index, index]));
  }

  // When the streams differ, repeated text is ambiguous. Only unique token
  // values are considered as anchors, then crossing anchors are discarded.
  // Ordinary formatting takes the exact-stream path above, so repeated SQL
  // identifiers still map by their stable token ordinal.
  const sourceIndexes = new Map<string, number[]>();
  const formattedIndexes = new Map<string, number[]>();
  for (let index = 0; index < source.length; index += 1) {
    const key = tokenKey(source[index]!);
    const indexes = sourceIndexes.get(key);
    if (indexes) indexes.push(index);
    else sourceIndexes.set(key, [index]);
  }
  for (let index = 0; index < formatted.length; index += 1) {
    const key = tokenKey(formatted[index]!);
    const indexes = formattedIndexes.get(key);
    if (indexes) indexes.push(index);
    else formattedIndexes.set(key, [index]);
  }

  const candidates: Array<readonly [number, number]> = [];
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const sourceOccurrences = sourceIndexes.get(tokenKey(source[sourceIndex]!));
    const formattedOccurrences = formattedIndexes.get(tokenKey(source[sourceIndex]!));
    if (sourceOccurrences?.length === 1 && formattedOccurrences?.length === 1) {
      candidates.push([sourceIndex, formattedOccurrences[0]!]);
    }
  }
  return monotonicTokenMatches(candidates);
}

function scalePosition(position: number, sourceFrom: number, sourceTo: number, formattedFrom: number, formattedTo: number): number {
  if (sourceTo <= sourceFrom) return formattedFrom;
  const boundedPosition = Math.max(sourceFrom, Math.min(sourceTo, position));
  const ratio = (boundedPosition - sourceFrom) / (sourceTo - sourceFrom);
  return Math.max(formattedFrom, Math.min(formattedTo, Math.round(formattedFrom + ratio * (formattedTo - formattedFrom))));
}

function positionInMappedToken(position: number, source: SqlSemanticToken, formatted: SqlSemanticToken): number {
  return scalePosition(position, source.span.start, source.span.end, formatted.span.start, formatted.span.end);
}

function directTokenAtPosition(tokens: readonly SqlSemanticToken[], position: number): number | undefined {
  const interior = tokens.findIndex((value) => value.span.start < position && position < value.span.end);
  if (interior >= 0) return interior;

  // At an adjacent-token boundary, keep the caret after the preceding token.
  // This matches how a user normally reaches that position by typing.
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (tokens[index]!.span.end === position) return index;
  }
  const starting = tokens.findIndex((value) => value.span.start === position);
  return starting >= 0 ? starting : undefined;
}

function mapWithinStatement(position: number, mapping: StatementMapping): number {
  const directSourceIndex = directTokenAtPosition(mapping.source.tokens, position);
  if (directSourceIndex !== undefined) {
    const formattedIndex = mapping.tokenMatches.get(directSourceIndex);
    if (formattedIndex !== undefined) {
      return positionInMappedToken(position, mapping.source.tokens[directSourceIndex]!, mapping.formatted.tokens[formattedIndex]!);
    }
  }

  let left: { source: number; formatted: number } | undefined;
  let right: { source: number; formatted: number } | undefined;
  for (let sourceIndex = 0; sourceIndex < mapping.source.tokens.length; sourceIndex += 1) {
    const formattedIndex = mapping.tokenMatches.get(sourceIndex);
    if (formattedIndex === undefined) continue;
    const sourceToken = mapping.source.tokens[sourceIndex]!;
    const formattedToken = mapping.formatted.tokens[formattedIndex]!;
    if (sourceToken.span.end <= position) left = { source: sourceToken.span.end, formatted: formattedToken.span.end };
    if (!right && sourceToken.span.start >= position) right = { source: sourceToken.span.start, formatted: formattedToken.span.start };
  }

  const sourceFrom = left?.source ?? mapping.source.from;
  const sourceTo = right?.source ?? mapping.source.to;
  const formattedFrom = left?.formatted ?? mapping.formatted.from;
  const formattedTo = right?.formatted ?? mapping.formatted.to;
  if (sourceFrom <= position && position <= sourceTo && formattedFrom <= formattedTo) {
    return scalePosition(position, sourceFrom, sourceTo, formattedFrom, formattedTo);
  }

  return scalePosition(position, mapping.source.from, mapping.source.to, mapping.formatted.from, mapping.formatted.to);
}

function statementIndexAtPosition(statements: readonly StatementSpan[], position: number): number {
  const index = statements.findIndex((statement) => position <= statement.to);
  return index >= 0 ? index : statements.length - 1;
}

function mapPosition(position: number, source: string, formatted: string, sourceStatements: readonly StatementSpan[], mappings: ReadonlyArray<StatementMapping | undefined>): number {
  const clamped = clampPosition(position, source.length);
  if (clamped === 0) return 0;
  if (clamped === source.length) return formatted.length;

  const statementIndex = statementIndexAtPosition(sourceStatements, clamped);
  const mapping = mappings[statementIndex];
  return mapping ? mapWithinStatement(clamped, mapping) : formatted.length;
}

/**
 * Maps a caret or selection through SQL formatting without diffing every
 * character. Token-equivalent statements map by token ordinal; changed token
 * streams use unique monotonic anchors and finally a relative position inside
 * the same semicolon-delimited statement.
 */
export function mapQueryEditorFormatSelection(source: string, formatted: string, selection: QueryEditorFormatSelection, dialectId = "generic"): QueryEditorFormatSelection {
  if (source === formatted) {
    return {
      anchor: clampPosition(selection.anchor, source.length),
      head: clampPosition(selection.head, source.length),
    };
  }

  const sourceStatements = statementSpans(source, tokenizeForFormatting(source, dialectId));
  const formattedStatements = statementSpans(formatted, tokenizeForFormatting(formatted, dialectId));
  const mappings = sourceStatements.map((sourceStatement, index): StatementMapping | undefined => {
    const formattedStatement = formattedStatements[index];
    if (!formattedStatement) return undefined;
    return {
      source: sourceStatement,
      formatted: formattedStatement,
      tokenMatches: buildTokenMatches(sourceStatement.tokens, formattedStatement.tokens),
    };
  });

  return {
    anchor: mapPosition(selection.anchor, source, formatted, sourceStatements, mappings),
    head: mapPosition(selection.head, source, formatted, sourceStatements, mappings),
  };
}

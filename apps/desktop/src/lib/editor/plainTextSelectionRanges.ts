import { createSemanticSelectionRangeIndex, type SemanticSelectionContext, type SemanticSelectionRange, type SemanticSelectionRangeIndex } from "@/lib/editor/semanticSelectionRanges";

const WORD_CHARACTER = /[\p{L}\p{N}\p{M}_$]/u;
const QUOTE_PAIRS: Readonly<Record<string, string>> = { "'": "'", '"': '"', "`": "`" };
const BRACKET_PAIRS: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}" };
const CLOSING_BRACKETS = new Set(Object.values(BRACKET_PAIRS));

function addRange(ranges: SemanticSelectionRange[], from: number, to: number) {
  if (from < to) ranges.push({ from, to });
}

function isEscaped(text: string, position: number): boolean {
  let backslashes = 0;
  for (let index = position - 1; index >= 0 && text[index] === "\\"; index -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function scanQuotedRanges(doc: string, ranges: SemanticSelectionRange[]) {
  for (let start = 0; start < doc.length; start += 1) {
    const close = QUOTE_PAIRS[doc[start] ?? ""];
    if (!close || (start > 0 && isEscaped(doc, start))) continue;

    for (let index = start + 1; index < doc.length; index += 1) {
      if (isEscaped(doc, index)) continue;
      if (doc[index] !== close) continue;
      if (close === "'" || close === '"' || close === "`") {
        if (doc[index + 1] === close) {
          index += 1;
          continue;
        }
      }
      addRange(ranges, start + 1, index);
      addRange(ranges, start, index + 1);
      start = index;
      break;
    }
  }
}

function scanBracketRanges(doc: string, ranges: SemanticSelectionRange[]) {
  const stack: Array<{ open: string; from: number }> = [];
  let quote: string | null = null;

  for (let index = 0; index < doc.length; index += 1) {
    const character = doc[index] ?? "";
    if (quote) {
      if (character === quote && !isEscaped(doc, index)) {
        if (doc[index + 1] === quote) {
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (QUOTE_PAIRS[character]) {
      quote = character;
      continue;
    }
    if (BRACKET_PAIRS[character]) {
      stack.push({ open: character, from: index });
      continue;
    }
    if (!CLOSING_BRACKETS.has(character)) continue;
    const expectedOpen = Object.entries(BRACKET_PAIRS).find(([, close]) => close === character)?.[0];
    if (stack[stack.length - 1]?.open !== expectedOpen) continue;
    const opening = stack.pop();
    if (!opening) continue;
    addRange(ranges, opening.from + 1, index);
    addRange(ranges, opening.from, index + 1);
  }
}

function scanAllWordRanges(doc: string, ranges: SemanticSelectionRange[]) {
  let index = 0;
  while (index < doc.length) {
    if (!WORD_CHARACTER.test(doc[index] ?? "")) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < doc.length && WORD_CHARACTER.test(doc[index] ?? "")) index += 1;
    addRange(ranges, start, index);
  }
}

function scanAllLineAndParagraphRanges(doc: string, ranges: SemanticSelectionRange[]) {
  let lineStart = 0;
  for (let index = 0; index <= doc.length; index += 1) {
    if (index !== doc.length && doc[index] !== "\n") continue;
    addRange(ranges, lineStart, index);
    lineStart = index + 1;
  }

  let paragraphStart = 0;
  while (paragraphStart <= doc.length) {
    const separator = doc.indexOf("\n\n", paragraphStart);
    const paragraphEnd = separator < 0 ? doc.length : separator;
    addRange(ranges, paragraphStart, paragraphEnd);
    if (separator < 0) break;
    paragraphStart = separator + 2;
  }
}

export interface PlainTextSelectionAnalysis {
  doc: string;
  allRanges: SemanticSelectionRangeIndex;
  delimitedRanges: SemanticSelectionRangeIndex;
  quotedRanges: SemanticSelectionRangeIndex;
}

export function analyzePlainTextSelectionRanges(doc: string): PlainTextSelectionAnalysis {
  const words: SemanticSelectionRange[] = [];
  const quotes: SemanticSelectionRange[] = [];
  const delimited: SemanticSelectionRange[] = [];
  scanAllWordRanges(doc, words);
  scanQuotedRanges(doc, quotes);
  delimited.push(...quotes);
  scanBracketRanges(doc, delimited);
  scanAllLineAndParagraphRanges(doc, delimited);
  addRange(delimited, 0, doc.length);
  return {
    doc,
    allRanges: createSemanticSelectionRangeIndex([...words, ...delimited]),
    delimitedRanges: createSemanticSelectionRangeIndex(delimited),
    quotedRanges: createSemanticSelectionRangeIndex(quotes),
  };
}

function hasContainingQuote(analysis: PlainTextSelectionAnalysis, cursor: number): boolean {
  return analysis.quotedRanges.containing({ from: cursor, to: cursor }).some((range) => range.from < cursor && cursor < range.to);
}

function selectionRangeIndex(context: SemanticSelectionContext, analysis: PlainTextSelectionAnalysis): SemanticSelectionRangeIndex {
  return context.preferDelimitedContent && hasContainingQuote(analysis, context.cursor) ? analysis.delimitedRanges : analysis.allRanges;
}

export function plainTextSelectionRanges(context: SemanticSelectionContext, analysis = analyzePlainTextSelectionRanges(context.doc)): SemanticSelectionRange[] {
  const { doc } = context;
  if (doc.length === 0) return [];
  if (analysis.doc !== doc) analysis = analyzePlainTextSelectionRanges(doc);
  return selectionRangeIndex(context, analysis).containing(context.current);
}

export function nextPlainTextSelectionRange(context: SemanticSelectionContext, analysis = analyzePlainTextSelectionRanges(context.doc)): SemanticSelectionRange | null {
  if (context.doc.length === 0) return null;
  if (analysis.doc !== context.doc) analysis = analyzePlainTextSelectionRanges(context.doc);
  return selectionRangeIndex(context, analysis).findNext(context.current, context.cursor);
}

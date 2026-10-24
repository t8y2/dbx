import { Facet, type EditorState, type Text } from "@codemirror/state";
import type { SqlRegionDialectSpec } from "./sqlRegionDialectPolicy";
import type { FoldRange } from "./codemirrorSqlBlockFolding";

const DEFAULT_DIALECT: SqlRegionDialectSpec = {};

// Share the actual editor dialect with the worker without changing SQL parsing.
export const sqlRegionDialect = Facet.define<SqlRegionDialectSpec, SqlRegionDialectSpec>({
  combine: (values) => values[0] ?? DEFAULT_DIALECT,
});

const REGION_MARKER = /^\s*--[ \t]*(end)?region(?:[ \t]|$)/i;
const rangeCache = new WeakMap<Text, Map<SqlRegionDialectSpec, Map<number, FoldRange>>>();
const DOLLAR_QUOTE_TAG = /\$(?:[\p{ID_Start}_][\p{ID_Continue}_]*)?\$/uy;

function hasStringPrefix(line: string, index: number, prefix: string): boolean {
  const start = index - prefix.length;
  return start >= 0 && line.slice(start, index).toLowerCase() === prefix && (start === 0 || !/[\w$\p{ID_Continue}]/u.test(line[start - 1]));
}

function dollarQuoteAt(line: string, index: number, dialect: SqlRegionDialectSpec): string | undefined {
  const mode = dialect.regionDollarQuotes ?? (dialect.doubleDollarQuotedStrings ? "tagged" : "none");
  if (mode === "none" || (index > 0 && /[\w$\p{ID_Continue}]/u.test(line[index - 1]))) return undefined;
  if (mode === "whitespace-bare" && index > 0 && !/\s/.test(line[index - 1])) return undefined;
  if (mode !== "tagged") return line.startsWith("$$", index) ? "$$" : undefined;
  DOLLAR_QUOTE_TAG.lastIndex = index;
  return DOLLAR_QUOTE_TAG.exec(line)?.[0];
}

/** Editor-only region directives, including the unspaced `--region` spelling. */
export function sqlRegionFoldRanges(state: EditorState): Map<number, FoldRange> {
  const dialect = state.facet(sqlRegionDialect);
  const cachedByDialect = rangeCache.get(state.doc);
  const cached = cachedByDialect?.get(dialect);
  if (cached) return cached;
  const ranges = new Map<number, FoldRange>();
  const cache = cachedByDialect ?? new Map<SqlRegionDialectSpec, Map<number, FoldRange>>();
  cache.set(dialect, ranges);
  rangeCache.set(state.doc, cache);

  // Avoid flattening/tokenizing ordinary SQL, and cache across background tree updates.
  let hasMarker = false;
  for (const line of state.doc.iterLines()) {
    if (REGION_MARKER.test(line)) {
      hasMarker = true;
      break;
    }
  }
  if (!hasMarker) return ranges;

  const stack: Array<{ line: number; from: number }> = [];
  let blockDepth = 0;
  let quote = "";
  let quoteEscapes = false;
  let quoteDoubles = true;
  let literalEnd = "";
  let literalEscapes = false;
  let continuedLineComment = false;
  let offset = 0;
  let lineNumber = 0;

  for (const line of state.doc.iterLines()) {
    lineNumber++;
    const lineEnd = offset + line.length;
    if (continuedLineComment) {
      continuedLineComment = line.endsWith("\\");
      offset = lineEnd + 1;
      continue;
    }
    const marker = !blockDepth && !quote && !literalEnd ? REGION_MARKER.exec(line) : null;
    if (marker) {
      if (!marker[1]) stack.push({ line: lineNumber, from: lineEnd });
      else {
        const opener = stack.pop();
        if (opener) ranges.set(opener.line, { from: opener.from, to: lineEnd });
      }
      // Titles are comment text, even when MySQL would not tokenize unspaced dashes.
      continuedLineComment = !!dialect.regionLineCommentContinuation && line.endsWith("\\");
      offset = lineEnd + 1;
      continue;
    }

    for (let index = 0; index < line.length;) {
      const ch = line[index];
      const next = line[index + 1];
      if (literalEnd) {
        const end = line.indexOf(literalEnd, index);
        if (end < 0) break;
        if (literalEscapes) {
          let slashCount = 0;
          for (let slash = end - 1; slash >= 0 && line[slash] === "\\"; slash--) slashCount++;
          if (slashCount % 2 === 1) {
            // Only the first quote is escaped; the next three may close it.
            index = end + 1;
            continue;
          }
        }
        index = end + literalEnd.length;
        literalEnd = "";
        literalEscapes = false;
      } else if (blockDepth) {
        if (dialect.regionNestedBlockComments && ch === "/" && next === "*") {
          blockDepth++;
          index += 2;
        } else if (ch === "*" && next === "/") {
          blockDepth--;
          index += 2;
        } else index++;
      } else if (quote) {
        if (quoteEscapes && ch === "\\") index += 2;
        else if (ch === quote) {
          if (quoteDoubles && next === quote) index += 2;
          else {
            quote = "";
            index++;
          }
        } else index++;
      } else if (dialect.regionDashComments !== false && ch === "-" && next === "-" && (!dialect.spaceAfterDashes || index + 2 === line.length || /[\s\x00-\x20]/.test(line[index + 2]))) {
        continuedLineComment = !!dialect.regionLineCommentContinuation && line.endsWith("\\");
        break;
      } else if ((ch === "#" && (dialect.hashComments || (dialect.regionClickHouseHashComments && (next === " " || next === "!")))) || (ch === "/" && next === "/" && dialect.slashComments)) {
        break;
      } else if (dialect.regionBlockComments !== false && ch === "/" && next === "*") {
        blockDepth = 1;
        index += 2;
      } else if (dialect.plsqlQuotingMechanism && (hasStringPrefix(line, index + 1, "q") || hasStringPrefix(line, index + 1, "nq")) && next === "'" && line[index + 2]) {
        const opener = line[index + 2];
        literalEnd = (({ "[": "]", "{": "}", "(": ")", "<": ">" } as Record<string, string>)[opener] ?? opener) + "'";
        literalEscapes = false;
        index += 3;
      } else if (ch === "$") {
        // The editor deliberately parses dollar-quoted bodies as SQL for highlighting;
        // region directives still must not escape those literal bodies.
        const tag = dollarQuoteAt(line, index, dialect);
        if (tag) {
          literalEnd = tag;
          literalEscapes = false;
          index += tag.length;
        } else index++;
      } else if (dialect.regionTripleQuotes && (ch === "'" || ch === '"') && line[index + 1] === ch && line[index + 2] === ch) {
        literalEnd = ch.repeat(3);
        // GoogleSQL raw/bytes prefixes change decoding, not quote protection:
        // an odd backslash still prevents a triple delimiter from closing.
        literalEscapes = true;
        index += 3;
      } else if (ch === "'" || (ch === '"' && dialect.doubleQuotedStrings) || (dialect.identifierQuotes ?? '"').includes(ch)) {
        quote = ch === "[" ? "]" : ch;
        quoteDoubles = ch !== "[" || dialect.regionDoubledBracketEscapes !== false;
        const escapedString = !!dialect.regionEscapeStrings && ch === "'" && hasStringPrefix(line, index, "e");
        const isString = ch === "'" || (ch === '"' && dialect.doubleQuotedStrings);
        const rawString = isString && dialect.regionRawStrings && hasStringPrefix(line, index, "r");
        quoteEscapes = !rawString && (isString ? !!dialect.backslashEscapes || escapedString : !!dialect.regionIdentifierEscapes);
        index++;
      } else index++;
    }
    offset = lineEnd + 1;
  }
  return ranges;
}

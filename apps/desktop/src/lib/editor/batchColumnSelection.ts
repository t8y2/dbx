export type BatchColumnSelectionMode = "select" | "insert";

export interface BatchColumnCandidate {
  apply: string;
  comment?: string;
}

export function batchColumnSelectionColumnList(candidates: Array<string | BatchColumnCandidate>, mode: BatchColumnSelectionMode, qualifier?: string, indent = "  ", options?: { trailingComma?: boolean }): string {
  const normalized = candidates.map((candidate) => (typeof candidate === "string" ? { apply: candidate } : candidate));
  const hasComments = mode === "select" && normalized.some((candidate) => !!candidate.comment?.trim());

  if (!hasComments) {
    return normalized.map((candidate, index) => (mode === "select" && qualifier && index > 0 ? `${qualifier}.${candidate.apply}` : candidate.apply)).join(", ");
  }

  return normalized
    .map((candidate, index) => {
      const col = qualifier && index > 0 ? `${qualifier}.${candidate.apply}` : candidate.apply;
      const isLast = index === normalized.length - 1;
      const comment = candidate.comment?.replace(/[\r\n]+/g, " ").trim();
      const linePrefix = index > 0 ? indent : "";
      const shouldHaveComma = !isLast || options?.trailingComma;
      if (comment) {
        return shouldHaveComma ? `${linePrefix}${col}, -- ${comment}` : `${linePrefix}${col} -- ${comment}`;
      }
      return shouldHaveComma ? `${linePrefix}${col},` : `${linePrefix}${col}`;
    })
    .join("\n");
}

export function shouldResolveSqlColumnCompletion(options: { suggestColumns: boolean; hasReferencedTables: boolean; prefix: string; typedActivation: boolean; selectListColumnContext: boolean }): boolean {
  return options.suggestColumns && options.hasReferencedTables && (options.prefix.length > 0 || options.typedActivation || options.selectListColumnContext);
}

export function shouldSwallowSelectStar(from: number, to: number, nextCharacter: string, replaceSelectWildcard = false): boolean {
  return replaceSelectWildcard && from === to && nextCharacter === "*";
}

export function completionReplacementTo(options: { from: number; to: number; nextCharacter: string; replaceClosingQuote?: string; replaceSelectWildcard?: boolean }): number {
  const { from, to, nextCharacter, replaceClosingQuote, replaceSelectWildcard } = options;
  return replaceClosingQuote === nextCharacter || shouldSwallowSelectStar(from, to, nextCharacter, replaceSelectWildcard) ? to + 1 : to;
}

/**
 * The INSERT batch action writes its own closing parenthesis before VALUES.
 * Consume an existing one (normally inserted by CodeMirror's auto-close
 * brackets extension) so the resulting statement has exactly one `)`.
 */
export function batchColumnSelectionReplaceTo(options: { from: number; to: number; mode: BatchColumnSelectionMode; nextCharacter: string; replaceClosingQuote?: string; replaceSelectWildcard?: boolean }): number {
  const { from, to, mode, nextCharacter, replaceClosingQuote, replaceSelectWildcard } = options;
  if (mode === "insert" && nextCharacter === ")") return to + 1;
  return completionReplacementTo({ from, to, nextCharacter, replaceClosingQuote, replaceSelectWildcard });
}

export function batchColumnSelectionInsertReplacement(options: { document: string; to: number; columns: string; valuesKeyword: "values" | "VALUES"; valueCount: number }): { replaceTo: number; insert: string } {
  const suffix = options.document.slice(options.to);
  const closingParenthesis = suffix.match(/^\s*\)/);
  const replaceTo = closingParenthesis ? options.to + closingParenthesis[0].length : options.to;
  const hasExistingValues = /^\s*\)\s*VALUES\b/i.test(suffix);
  if (hasExistingValues) return { replaceTo, insert: `${options.columns})` };

  const values = Array.from({ length: options.valueCount }, (_, index) => `\${${index + 1}:value}`).join(", ");
  return { replaceTo, insert: `${options.columns}) ${options.valuesKeyword} (${values})` };
}

export function isBatchColumnSelectionCompletionActive(status: "active" | "pending" | null): boolean {
  return status === "active";
}

import { diffChars, diffLines, type Change } from "diff";

export type TextDiffKind = "equal" | "added" | "removed" | "modified";

export interface TextDiffSegment {
  text: string;
  changed: boolean;
}

export interface TextDiffRow {
  kind: TextDiffKind;
  beforeLineNumber: number | null;
  afterLineNumber: number | null;
  beforeText: string;
  afterText: string;
  beforeSegments: TextDiffSegment[];
  afterSegments: TextDiffSegment[];
}

export const TEXT_DIFF_MAX_DETAILED_CHARACTERS = 500_000;
export const TEXT_DIFF_MAX_DETAILED_LINES = 20_000;
export const TEXT_DIFF_MAX_CHARACTER_DIFF_CHARACTERS = 20_000;

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function linesFromChange(change: Change): string[] {
  if (!change.value) return [];
  const lines = change.value.split("\n");
  if (change.value.endsWith("\n")) lines.pop();
  return lines;
}

function unchangedSegments(text: string): TextDiffSegment[] {
  return text ? [{ text, changed: false }] : [];
}

function changedSegments(beforeText: string, afterText: string): { before: TextDiffSegment[]; after: TextDiffSegment[] } {
  if (beforeText.length + afterText.length > TEXT_DIFF_MAX_CHARACTER_DIFF_CHARACTERS) {
    return {
      before: beforeText ? [{ text: beforeText, changed: true }] : [],
      after: afterText ? [{ text: afterText, changed: true }] : [],
    };
  }
  const changes = diffChars(beforeText, afterText);
  return {
    before: changes.filter((change) => !change.added).map((change) => ({ text: change.value, changed: !!change.removed })),
    after: changes.filter((change) => !change.removed).map((change) => ({ text: change.value, changed: !!change.added })),
  };
}

function appendEqualRows(rows: TextDiffRow[], lines: string[], beforeLine: { value: number }, afterLine: { value: number }) {
  for (const line of lines) {
    rows.push({
      kind: "equal",
      beforeLineNumber: beforeLine.value++,
      afterLineNumber: afterLine.value++,
      beforeText: line,
      afterText: line,
      beforeSegments: unchangedSegments(line),
      afterSegments: unchangedSegments(line),
    });
  }
}

function appendChangedRows(rows: TextDiffRow[], removed: string[], added: string[], beforeLine: { value: number }, afterLine: { value: number }) {
  const count = Math.max(removed.length, added.length);
  for (let index = 0; index < count; index += 1) {
    const beforeText = removed[index];
    const afterText = added[index];
    if (beforeText !== undefined && afterText !== undefined) {
      const segments = changedSegments(beforeText, afterText);
      rows.push({
        kind: beforeText === afterText ? "equal" : "modified",
        beforeLineNumber: beforeLine.value++,
        afterLineNumber: afterLine.value++,
        beforeText,
        afterText,
        beforeSegments: beforeText === afterText ? unchangedSegments(beforeText) : segments.before,
        afterSegments: beforeText === afterText ? unchangedSegments(afterText) : segments.after,
      });
    } else if (beforeText !== undefined) {
      rows.push({
        kind: "removed",
        beforeLineNumber: beforeLine.value++,
        afterLineNumber: null,
        beforeText,
        afterText: "",
        beforeSegments: unchangedSegments(beforeText),
        afterSegments: [],
      });
    } else if (afterText !== undefined) {
      rows.push({
        kind: "added",
        beforeLineNumber: null,
        afterLineNumber: afterLine.value++,
        beforeText: "",
        afterText,
        beforeSegments: [],
        afterSegments: unchangedSegments(afterText),
      });
    }
  }
}

function buildFallbackRows(before: string, after: string): TextDiffRow[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const rows: TextDiffRow[] = [];
  appendChangedRows(rows, beforeLines, afterLines, { value: 1 }, { value: 1 });
  return rows;
}

function exceedsDetailedLineLimit(before: string, after: string): boolean {
  let lines = 2;
  for (const value of [before, after]) {
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) !== 10) continue;
      lines += 1;
      if (lines > TEXT_DIFF_MAX_DETAILED_LINES) return true;
    }
  }
  return false;
}

export function buildTextDiff(beforeValue: string, afterValue: string): TextDiffRow[] {
  const before = normalizeLineEndings(beforeValue);
  const after = normalizeLineEndings(afterValue);
  if (before.length + after.length > TEXT_DIFF_MAX_DETAILED_CHARACTERS || exceedsDetailedLineLimit(before, after)) return buildFallbackRows(before, after);

  const changes = diffLines(before, after, { newlineIsToken: false });
  const rows: TextDiffRow[] = [];
  const beforeLine = { value: 1 };
  const afterLine = { value: 1 };
  let index = 0;
  while (index < changes.length) {
    const change = changes[index];
    if (!change.added && !change.removed) {
      appendEqualRows(rows, linesFromChange(change), beforeLine, afterLine);
      index += 1;
      continue;
    }

    const removed: string[] = [];
    const added: string[] = [];
    while (index < changes.length && (changes[index].added || changes[index].removed)) {
      const changedLines = linesFromChange(changes[index]);
      if (changes[index].removed) removed.push(...changedLines);
      else added.push(...changedLines);
      index += 1;
    }
    appendChangedRows(rows, removed, added, beforeLine, afterLine);
  }

  if (rows.length === 0) appendEqualRows(rows, [""], beforeLine, afterLine);
  return rows;
}

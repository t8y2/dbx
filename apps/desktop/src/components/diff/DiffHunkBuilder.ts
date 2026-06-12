import { diffLines, type Change } from "diff";

export type HunkType = "equal" | "delete" | "insert" | "modify";

export interface DiffLine {
  type: HunkType;
  content: string;
  lineNumber: number | null;
  isPadding: boolean;
}

export interface DiffHunk {
  id: string;
  type: HunkType;
  leftLines: DiffLine[];
  rightLines: DiffLine[];
  // Measured pixel positions after rendering
  leftTop: number;
  leftBottom: number;
  rightTop: number;
  rightBottom: number;
}

const SIMILARITY_THRESHOLD = 0.3;
const ALIGN_WINDOW = 3;

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function buildLines(lines: string[], type: HunkType, startLineNum: number): DiffLine[] {
  return lines.map((content, idx) => ({
    type,
    content,
    lineNumber: startLineNum + idx,
    isPadding: false,
  }));
}

function buildPaddingLines(count: number): DiffLine[] {
  return Array.from({ length: count }, () => ({
    type: "equal" as HunkType,
    content: "",
    lineNumber: null,
    isPadding: true,
  }));
}

function normalizeDdl(ddl: string): string {
  return ddl
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n");
}

function collectSameKindChanges(changes: Change[], startIdx: number, kind: "added" | "removed"): [string[], number] {
  const parts: string[] = [];
  let i = startIdx;
  while (i < changes.length && changes[i][kind]) {
    parts.push(changes[i].value);
    i++;
  }
  return [parts, i];
}

function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b.charAt(i - 1) === a.charAt(j - 1) ? matrix[i - 1][j - 1] : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  if (longer.length === 0) return 1;
  const distance = levenshteinDistance(a, b);
  return (longer.length - distance) / longer.length;
}

type AlignedItem = { type: "modify"; left: string; right: string } | { type: "delete"; left: string } | { type: "insert"; right: string };

function alignLineByLine(removedLines: string[], addedLines: string[]): AlignedItem[] {
  const result: AlignedItem[] = [];
  let r = 0;
  let a = 0;

  while (r < removedLines.length || a < addedLines.length) {
    if (r < removedLines.length && a < addedLines.length) {
      const directSim = computeSimilarity(removedLines[r], addedLines[a]);
      if (directSim >= SIMILARITY_THRESHOLD) {
        result.push({ type: "modify", left: removedLines[r], right: addedLines[a] });
        r++;
        a++;
        continue;
      }

      // Look ahead for best match within a small window
      let bestR = -1;
      let bestA = -1;
      let bestSim = SIMILARITY_THRESHOLD;

      for (let ri = r; ri < Math.min(r + ALIGN_WINDOW, removedLines.length); ri++) {
        for (let aj = a; aj < Math.min(a + ALIGN_WINDOW, addedLines.length); aj++) {
          const sim = computeSimilarity(removedLines[ri], addedLines[aj]);
          if (sim > bestSim) {
            bestSim = sim;
            bestR = ri;
            bestA = aj;
          }
        }
      }

      if (bestR >= 0 && bestA >= 0) {
        while (r < bestR) {
          result.push({ type: "delete", left: removedLines[r] });
          r++;
        }
        while (a < bestA) {
          result.push({ type: "insert", right: addedLines[a] });
          a++;
        }
        result.push({ type: "modify", left: removedLines[r], right: addedLines[a] });
        r++;
        a++;
      } else {
        result.push({ type: "delete", left: removedLines[r] });
        result.push({ type: "insert", right: addedLines[a] });
        r++;
        a++;
      }
    } else if (r < removedLines.length) {
      result.push({ type: "delete", left: removedLines[r] });
      r++;
    } else {
      result.push({ type: "insert", right: addedLines[a] });
      a++;
    }
  }

  return result;
}

export function buildHunks(sourceDdl: string, targetDdl: string): DiffHunk[] {
  const normalizedSource = normalizeDdl(sourceDdl);
  const normalizedTarget = normalizeDdl(targetDdl);
  const changes = diffLines(normalizedSource, normalizedTarget, { newlineIsToken: false });

  const hunks: DiffHunk[] = [];
  let leftLineNum = 1;
  let rightLineNum = 1;
  let hunkIdCounter = 0;

  function nextId(): string {
    return `hunk-${hunkIdCounter++}`;
  }

  let i = 0;
  while (i < changes.length) {
    const change = changes[i];

    if (!change.added && !change.removed) {
      const lines = splitLines(change.value);
      hunks.push({
        id: nextId(),
        type: "equal",
        leftLines: buildLines(lines, "equal", leftLineNum),
        rightLines: buildLines(lines, "equal", rightLineNum),
        leftTop: 0,
        leftBottom: 0,
        rightTop: 0,
        rightBottom: 0,
      });
      leftLineNum += lines.length;
      rightLineNum += lines.length;
      i++;
      continue;
    }

    if (change.removed) {
      const [removedParts, afterRemoved] = collectSameKindChanges(changes, i, "removed");
      const [addedParts, afterAdded] = collectSameKindChanges(changes, afterRemoved, "added");
      const removedValue = removedParts.join("");
      const removedLines = splitLines(removedValue);

      if (addedParts.length > 0) {
        const addedValue = addedParts.join("");
        const addedLines = splitLines(addedValue);
        const aligned = alignLineByLine(removedLines, addedLines);

        for (const item of aligned) {
          if (item.type === "modify") {
            const maxLines = 1;
            const leftReal = buildLines([item.left], "modify", leftLineNum);
            const rightReal = buildLines([item.right], "modify", rightLineNum);
            leftLineNum++;
            rightLineNum++;
            hunks.push({
              id: nextId(),
              type: "modify",
              leftLines: padLines(leftReal, maxLines, "modify"),
              rightLines: padLines(rightReal, maxLines, "modify"),
              leftTop: 0,
              leftBottom: 0,
              rightTop: 0,
              rightBottom: 0,
            });
          } else if (item.type === "delete") {
            const leftReal = buildLines([item.left], "delete", leftLineNum);
            leftLineNum++;
            hunks.push({
              id: nextId(),
              type: "delete",
              leftLines: leftReal,
              rightLines: buildPaddingLines(1),
              leftTop: 0,
              leftBottom: 0,
              rightTop: 0,
              rightBottom: 0,
            });
          } else if (item.type === "insert") {
            const rightReal = buildLines([item.right], "insert", rightLineNum);
            rightLineNum++;
            hunks.push({
              id: nextId(),
              type: "insert",
              leftLines: buildPaddingLines(1),
              rightLines: rightReal,
              leftTop: 0,
              leftBottom: 0,
              rightTop: 0,
              rightBottom: 0,
            });
          }
        }
      } else {
        const maxLines = removedLines.length;
        const leftReal = buildLines(removedLines, "delete", leftLineNum);
        leftLineNum += removedLines.length;
        hunks.push({
          id: nextId(),
          type: "delete",
          leftLines: leftReal,
          rightLines: buildPaddingLines(maxLines),
          leftTop: 0,
          leftBottom: 0,
          rightTop: 0,
          rightBottom: 0,
        });
      }
      i = afterAdded;
      continue;
    }

    if (change.added) {
      const [addedParts, afterAdded] = collectSameKindChanges(changes, i, "added");
      const addedValue = addedParts.join("");
      const addedLines = splitLines(addedValue);
      const rightReal = buildLines(addedLines, "insert", rightLineNum);
      rightLineNum += addedLines.length;
      hunks.push({
        id: nextId(),
        type: "insert",
        leftLines: buildPaddingLines(addedLines.length),
        rightLines: rightReal,
        leftTop: 0,
        leftBottom: 0,
        rightTop: 0,
        rightBottom: 0,
      });
      i = afterAdded;
      continue;
    }
  }

  return hunks;
}

function padLines(lines: DiffLine[], targetCount: number, type: HunkType): DiffLine[] {
  if (lines.length >= targetCount) return lines;
  const padding = Array.from({ length: targetCount - lines.length }, () => ({
    type,
    content: "",
    lineNumber: null,
    isPadding: true,
  }));
  return [...lines, ...padding];
}

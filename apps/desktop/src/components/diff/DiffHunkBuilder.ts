import { diffLines, type Change } from "diff";

export type HunkType = "equal" | "delete" | "insert" | "modify";

export interface DiffLine {
  type: HunkType;
  content: string;
  lineNumber: number | null;
  isPadding: boolean;
  comparisonContent?: string;
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
const MAX_GLOBAL_ALIGNMENT_CELLS = 10_000;
const ALIGN_DELETE = 1;
const ALIGN_INSERT = 2;
const ALIGN_MODIFY = 3;

const SQL_LINE_KEYWORDS = new Set([
  "add",
  "alter",
  "as",
  "begin",
  "check",
  "cluster",
  "comment",
  "constraint",
  "create",
  "delete",
  "distributed",
  "drop",
  "else",
  "end",
  "engine",
  "foreign",
  "from",
  "group",
  "having",
  "if",
  "index",
  "insert",
  "join",
  "key",
  "on",
  "order",
  "partition",
  "primary",
  "references",
  "return",
  "returns",
  "select",
  "set",
  "settings",
  "tablespace",
  "then",
  "union",
  "unique",
  "update",
  "using",
  "values",
  "when",
  "where",
  "with",
]);

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
  let previous = Array.from({ length: a.length + 1 }, (_, index) => index);

  for (let i = 1; i <= b.length; i++) {
    const current = [i];
    for (let j = 1; j <= a.length; j++) {
      current[j] = b.charAt(i - 1) === a.charAt(j - 1) ? previous[j - 1] : Math.min(previous[j - 1] + 1, current[j - 1] + 1, previous[j] + 1);
    }
    previous = current;
  }

  return previous[a.length];
}

function computeSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  if (longer.length === 0) return 1;
  const distance = levenshteinDistance(a, b);
  return (longer.length - distance) / longer.length;
}

type AlignedItem = { type: "modify"; left: string; right: string } | { type: "delete"; left: string } | { type: "insert"; right: string };

type SqlIdentifier = {
  value: string;
  rest: string;
  quoted: boolean;
};

function readSqlIdentifier(value: string): SqlIdentifier | null {
  const input = value.trimStart();
  const opening = input[0];
  const closing = opening === "[" ? "]" : opening;

  if (opening === "`" || opening === '"' || opening === "[") {
    let identifier = "";
    for (let i = 1; i < input.length; i++) {
      if (input[i] !== closing) {
        identifier += input[i];
        continue;
      }
      if (input[i + 1] === closing) {
        identifier += closing;
        i++;
        continue;
      }
      return { value: identifier, rest: input.slice(i + 1), quoted: true };
    }
    return null;
  }

  const match = input.match(/^([A-Za-z_][A-Za-z0-9_$#@]*)(.*)$/s);
  if (!match) return null;
  return { value: match[1], rest: match[2], quoted: false };
}

function readIdentifierAfterKeyword(line: string, keyword: RegExp): string | null {
  const match = line.trimStart().match(keyword);
  if (!match) return null;
  return readSqlIdentifier(line.trimStart().slice(match[0].length))?.value ?? null;
}

function ddlLineIdentity(line: string): string | null {
  const trimmed = line.trimStart();

  const constraint = readIdentifierAfterKeyword(trimmed, /^CONSTRAINT\s+/i);
  if (constraint !== null) return `constraint:${constraint}`;

  const index = readIdentifierAfterKeyword(trimmed, /^(?:(?:UNIQUE|FULLTEXT|SPATIAL)\s+)?(?:KEY|INDEX)\s+/i);
  if (index !== null) return `index:${index}`;

  const createdIndex = readIdentifierAfterKeyword(trimmed, /^CREATE\s+(?:(?:UNIQUE|FULLTEXT|SPATIAL)\s+)?INDEX\s+/i);
  if (createdIndex !== null) return `index:${createdIndex}`;

  if (/^PRIMARY\s+KEY\b/i.test(trimmed)) return "constraint:primary-key";

  const identifier = readSqlIdentifier(trimmed);
  if (!identifier || !/^\s+/.test(identifier.rest)) return null;
  const normalizedIdentifier = identifier.quoted ? identifier.value : identifier.value.toLowerCase();
  if (!identifier.quoted && SQL_LINE_KEYWORDS.has(normalizedIdentifier)) return `keyword:${normalizedIdentifier}`;
  return `column:${normalizedIdentifier}`;
}

function isNamedDdlIdentity(identity: string | null): identity is string {
  return identity !== null && (identity.startsWith("column:") || identity.startsWith("constraint:") || identity.startsWith("index:"));
}

function comparableDdlLine(line: string): string {
  return line.trim().replace(/,\s*$/, "");
}

function linePairSimilarity(left: string, right: string, leftIdentity = ddlLineIdentity(left), rightIdentity = ddlLineIdentity(right)): number | null {
  if (leftIdentity !== null || rightIdentity !== null) {
    if (leftIdentity === null || rightIdentity === null || leftIdentity !== rightIdentity) return null;
  }

  const similarity = computeSimilarity(left, right);
  return similarity >= SIMILARITY_THRESHOLD ? similarity : null;
}

function alignWithinWindow(removedLines: string[], addedLines: string[]): AlignedItem[] {
  const result: AlignedItem[] = [];
  let r = 0;
  let a = 0;

  while (r < removedLines.length && a < addedLines.length) {
    let bestR = -1;
    let bestA = -1;
    let bestSimilarity = -1;

    for (let ri = r; ri < Math.min(r + ALIGN_WINDOW, removedLines.length); ri++) {
      for (let ai = a; ai < Math.min(a + ALIGN_WINDOW, addedLines.length); ai++) {
        const similarity = linePairSimilarity(removedLines[ri], addedLines[ai]);
        if (similarity !== null && similarity > bestSimilarity) {
          bestSimilarity = similarity;
          bestR = ri;
          bestA = ai;
        }
      }
    }

    if (bestR < 0 || bestA < 0) {
      result.push({ type: "delete", left: removedLines[r++] });
      result.push({ type: "insert", right: addedLines[a++] });
      continue;
    }

    while (r < bestR) result.push({ type: "delete", left: removedLines[r++] });
    while (a < bestA) result.push({ type: "insert", right: addedLines[a++] });
    result.push({ type: "modify", left: removedLines[r++], right: addedLines[a++] });
  }

  while (r < removedLines.length) result.push({ type: "delete", left: removedLines[r++] });
  while (a < addedLines.length) result.push({ type: "insert", right: addedLines[a++] });
  return result;
}

function buildGlobalAlignmentDirections(removedLines: string[], addedLines: string[], removedIdentities: Array<string | null>, addedIdentities: Array<string | null>): Uint8Array {
  const removedCount = removedLines.length;
  const addedCount = addedLines.length;
  const directions = new Uint8Array(removedCount * addedCount);
  let nextCosts = new Float64Array(addedCount + 1);

  for (let a = addedCount - 1; a >= 0; a--) nextCosts[a] = nextCosts[a + 1] + 1;

  for (let r = removedCount - 1; r >= 0; r--) {
    const currentCosts = new Float64Array(addedCount + 1);
    currentCosts[addedCount] = nextCosts[addedCount] + 1;

    for (let a = addedCount - 1; a >= 0; a--) {
      let bestCost = nextCosts[a] + 1;
      let direction = ALIGN_DELETE;

      const insertCost = currentCosts[a + 1] + 1;
      if (insertCost < bestCost) {
        bestCost = insertCost;
        direction = ALIGN_INSERT;
      }

      const similarity = linePairSimilarity(removedLines[r], addedLines[a], removedIdentities[r], addedIdentities[a]);
      if (similarity !== null) {
        const modifyCost = nextCosts[a + 1] + (1 - similarity);
        if (modifyCost <= bestCost) {
          bestCost = modifyCost;
          direction = ALIGN_MODIFY;
        }
      }

      currentCosts[a] = bestCost;
      directions[r * addedCount + a] = direction;
    }

    nextCosts = currentCosts;
  }

  return directions;
}

function alignLineByLine(removedLines: string[], addedLines: string[]): AlignedItem[] {
  const removedCount = removedLines.length;
  const addedCount = addedLines.length;
  if (removedCount * addedCount > MAX_GLOBAL_ALIGNMENT_CELLS) return alignWithinWindow(removedLines, addedLines);

  const removedIdentities = removedLines.map(ddlLineIdentity);
  const addedIdentities = addedLines.map(ddlLineIdentity);
  const directions = buildGlobalAlignmentDirections(removedLines, addedLines, removedIdentities, addedIdentities);

  const result: AlignedItem[] = [];
  let r = 0;
  let a = 0;

  while (r < removedLines.length || a < addedLines.length) {
    if (r >= removedLines.length) {
      result.push({ type: "insert", right: addedLines[a] });
      a++;
    } else if (a >= addedLines.length) {
      result.push({ type: "delete", left: removedLines[r] });
      r++;
    } else {
      const direction = directions[r * addedCount + a];
      if (direction === ALIGN_MODIFY) {
        result.push({ type: "modify", left: removedLines[r], right: addedLines[a] });
        r++;
        a++;
      } else if (direction === ALIGN_INSERT) {
        result.push({ type: "insert", right: addedLines[a] });
        a++;
      } else {
        result.push({ type: "delete", left: removedLines[r] });
        r++;
      }
    }
  }

  return result;
}

type DiffLineReference = {
  line: DiffLine;
  identity: string;
};

function collectChangedLineReferences(hunks: DiffHunk[], side: "leftLines" | "rightLines", hunkType: "delete" | "insert"): DiffLineReference[] {
  const references: DiffLineReference[] = [];

  for (const hunk of hunks) {
    if (hunk.type !== hunkType) continue;
    for (const line of hunk[side]) {
      if (line.isPadding || line.type !== hunkType) continue;
      const identity = ddlLineIdentity(line.content);
      if (isNamedDdlIdentity(identity)) references.push({ line, identity });
    }
  }

  return references;
}

function reconcileMovedDdlLines(hunks: DiffHunk[]): void {
  const deletedLines = collectChangedLineReferences(hunks, "leftLines", "delete");
  const insertedByIdentity = new Map<string, DiffLineReference[]>();

  for (const reference of collectChangedLineReferences(hunks, "rightLines", "insert")) {
    const matches = insertedByIdentity.get(reference.identity) ?? [];
    matches.push(reference);
    insertedByIdentity.set(reference.identity, matches);
  }

  for (const deleted of deletedLines) {
    const matches = insertedByIdentity.get(deleted.identity);
    if (!matches?.length) continue;

    const exactIndex = matches.findIndex((inserted) => comparableDdlLine(inserted.line.content) === comparableDdlLine(deleted.line.content));
    const inserted = matches.splice(exactIndex >= 0 ? exactIndex : 0, 1)[0];

    if (comparableDdlLine(deleted.line.content) === comparableDdlLine(inserted.line.content)) {
      deleted.line.type = "equal";
      inserted.line.type = "equal";
      continue;
    }

    deleted.line.type = "modify";
    inserted.line.type = "modify";
    deleted.line.comparisonContent = inserted.line.content;
    inserted.line.comparisonContent = deleted.line.content;
  }
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

  reconcileMovedDdlLines(hunks);
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

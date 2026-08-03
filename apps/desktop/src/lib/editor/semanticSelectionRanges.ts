export interface SemanticSelectionRange {
  from: number;
  to: number;
}

export type SemanticSelectionNodeKind =
  | "document"
  | "paragraph"
  | "line"
  | "quoted-content"
  | "quoted"
  | "bracket-content"
  | "bracketed"
  | "word"
  | "statement"
  | "set-expression"
  | "query-block"
  | "clause"
  | "logical-expression"
  | "binary-expression"
  | "unary-expression"
  | "function-call"
  | "qualified-identifier"
  | "literal";

export interface SemanticSelectionNode extends SemanticSelectionRange {
  kind: SemanticSelectionNodeKind;
  children: SemanticSelectionNode[];
}

export interface SemanticSelectionContext {
  doc: string;
  cursor: number;
  current: SemanticSelectionRange;
  preferDelimitedContent?: boolean;
}

export interface SemanticSelectionRangeIndex {
  containing(current: SemanticSelectionRange): SemanticSelectionRange[];
  findNext(current: SemanticSelectionRange, cursor: number): SemanticSelectionRange | null;
}

interface SemanticSelectionRangeIndexNode {
  from: number;
  to: number;
  maxRangeTo: number;
  minRangeLength: number;
  left?: SemanticSelectionRangeIndexNode;
  right?: SemanticSelectionRangeIndexNode;
}

function compareSemanticSelectionRanges(left: SemanticSelectionRange, right: SemanticSelectionRange, cursor: number): number {
  const lengthDifference = left.to - left.from - (right.to - right.from);
  if (lengthDifference !== 0) return lengthDifference;
  const leftDistance = Math.abs(cursor - (left.from + left.to) / 2);
  const rightDistance = Math.abs(cursor - (right.from + right.to) / 2);
  return leftDistance - rightDistance || left.from - right.from || left.to - right.to;
}

export function createSemanticSelectionRangeIndex(candidates: readonly SemanticSelectionRange[]): SemanticSelectionRangeIndex {
  const unique = new Map<string, SemanticSelectionRange>();
  for (const range of candidates) {
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) continue;
    if (range.from < 0 || range.from >= range.to) continue;
    unique.set(`${range.from}:${range.to}`, range);
  }
  const ranges = [...unique.values()].sort((left, right) => left.from - right.from || left.to - right.to);

  const buildNode = (from: number, to: number): SemanticSelectionRangeIndexNode | undefined => {
    if (from >= to) return undefined;
    if (to - from === 1) {
      const range = ranges[from];
      if (!range) return undefined;
      return { from, to, maxRangeTo: range.to, minRangeLength: range.to - range.from };
    }
    const middle = from + Math.floor((to - from) / 2);
    const left = buildNode(from, middle);
    const right = buildNode(middle, to);
    return {
      from,
      to,
      maxRangeTo: Math.max(left?.maxRangeTo ?? -1, right?.maxRangeTo ?? -1),
      minRangeLength: Math.min(left?.minRangeLength ?? Number.POSITIVE_INFINITY, right?.minRangeLength ?? Number.POSITIVE_INFINITY),
      left,
      right,
    };
  };
  const root = buildNode(0, ranges.length);

  const upperBound = (position: number): number => {
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const middle = low + Math.floor((high - low) / 2);
      if ((ranges[middle]?.from ?? Number.POSITIVE_INFINITY) <= position) low = middle + 1;
      else high = middle;
    }
    return low;
  };

  const visitContaining = (current: SemanticSelectionRange, visit: (range: SemanticSelectionRange) => void) => {
    const maxIndex = upperBound(current.from);
    const visitNode = (node: SemanticSelectionRangeIndexNode | undefined) => {
      if (!node || node.from >= maxIndex || node.maxRangeTo < current.to) return;
      if (node.to - node.from === 1) {
        const range = ranges[node.from];
        if (range && range.to >= current.to) visit(range);
        return;
      }
      visitNode(node.left);
      visitNode(node.right);
    };
    visitNode(root);
  };

  return {
    containing(current) {
      const result: SemanticSelectionRange[] = [];
      visitContaining(current, (range) => result.push(range));
      return result;
    },
    findNext(current, cursor) {
      const maxIndex = upperBound(current.from);
      let best: SemanticSelectionRange | null = null;
      const visitNode = (node: SemanticSelectionRangeIndexNode | undefined) => {
        if (!node || node.from >= maxIndex || node.maxRangeTo < current.to) return;
        if (best && node.minRangeLength > best.to - best.from) return;
        if (node.to - node.from === 1) {
          const range = ranges[node.from];
          if (!range || range.to < current.to || (range.from === current.from && range.to === current.to)) return;
          if (!best || compareSemanticSelectionRanges(range, best, cursor) < 0) best = range;
          return;
        }
        const first = (node.left?.minRangeLength ?? Number.POSITIVE_INFINITY) <= (node.right?.minRangeLength ?? Number.POSITIVE_INFINITY) ? node.left : node.right;
        const second = first === node.left ? node.right : node.left;
        visitNode(first);
        visitNode(second);
      };
      visitNode(root);
      return best;
    },
  };
}

export function chooseNextSemanticSelectionRange(current: SemanticSelectionRange, cursor: number, candidates: readonly SemanticSelectionRange[]): SemanticSelectionRange | null {
  const unique = new Map<string, SemanticSelectionRange>();
  for (const range of candidates) {
    if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) continue;
    if (range.from < 0 || range.from >= range.to) continue;
    if (range.from > current.from || range.to < current.to) continue;
    if (range.from === current.from && range.to === current.to) continue;
    unique.set(`${range.from}:${range.to}`, range);
  }

  return [...unique.values()].sort((left, right) => compareSemanticSelectionRanges(left, right, cursor))[0] ?? null;
}

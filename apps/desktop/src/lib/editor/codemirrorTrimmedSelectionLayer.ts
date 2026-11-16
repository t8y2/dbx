import { layer, RectangleMarker, type EditorView } from "@codemirror/view";

const FALLBACK_EMPTY_SELECTION_WIDTH = 8;
const END_OF_LINE_PADDING = 3;
const CONTIGUOUS_LINE_GAP = 1.5;
const CORNER_COVERAGE_GAP = 1;

type TrimmedSelectionRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PositionRect = ReturnType<EditorView["coordsAtPos"]>;

export function trimmedSelectionHorizontalBounds(options: {
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  includesLineBreak: boolean;
  startLeft: number;
  startRight: number;
  endLeft: number;
  endRight: number;
  lineStartLeft: number;
  lineEndRight: number;
  emptySelectionWidth?: number;
}): {
  left: number;
  right: number;
} {
  const lineBreakOnlyAtContentEnd = options.from >= options.to && options.includesLineBreak && options.from >= options.lineTo && options.lineTo > options.lineFrom;
  const left = options.from < options.to ? Math.min(options.startLeft, options.endLeft) : lineBreakOnlyAtContentEnd ? options.lineEndRight : options.lineStartLeft;
  const emptySelectionWidth = Math.max(1, options.emptySelectionWidth ?? FALLBACK_EMPTY_SELECTION_WIDTH);
  let right = options.from < options.to ? Math.max(options.startRight, options.endRight) : left + emptySelectionWidth;
  if (options.includesLineBreak && options.to >= options.lineTo) {
    right = Math.max(right, options.lineEndRight + END_OF_LINE_PADDING);
  }
  return { left, right };
}

function visualLineVerticalBounds(view: EditorView, start: NonNullable<PositionRect>, end: NonNullable<PositionRect>): { top: number; bottom: number } {
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  const height = Math.max(bottom - top, view.defaultLineHeight);
  const center = (top + bottom) / 2;
  return {
    top: center - height / 2,
    bottom: center + height / 2,
  };
}

function layerBase(view: EditorView) {
  const rect = view.scrollDOM.getBoundingClientRect();
  return {
    left: rect.left - view.scrollDOM.scrollLeft * view.scaleX,
    top: rect.top - view.scrollDOM.scrollTop * view.scaleY,
  };
}

function markerForLineRange(view: EditorView, from: number, to: number, lineFrom: number, lineTo: number, includesLineBreak: boolean, base: { left: number; top: number }): TrimmedSelectionRect | null {
  const start = view.coordsAtPos(from, 1);
  const end = from < to ? view.coordsAtPos(to, -1) : start;
  const lineStart = view.coordsAtPos(lineFrom, 1) ?? start;
  const lineEnd = view.coordsAtPos(lineTo, -1) ?? end;
  if (!start || !end || !lineStart || !lineEnd) return null;

  const { left, right } = trimmedSelectionHorizontalBounds({
    from,
    to,
    lineFrom,
    lineTo,
    includesLineBreak,
    startLeft: start.left,
    startRight: start.right,
    endLeft: end.left,
    endRight: end.right,
    lineStartLeft: lineStart.left,
    lineEndRight: lineEnd.right,
    emptySelectionWidth: view.defaultCharacterWidth,
  });

  const { top, bottom } = visualLineVerticalBounds(view, start, end);

  return {
    left: left - base.left,
    top: top - base.top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function sameVisualLine(a: NonNullable<PositionRect>, b: NonNullable<PositionRect>): boolean {
  const aMid = (a.top + a.bottom) / 2;
  const bMid = (b.top + b.bottom) / 2;
  return Math.abs(aMid - bMid) <= Math.max(2, Math.min(a.bottom - a.top, b.bottom - b.top) / 2);
}

function lastPositionOnVisualLine(view: EditorView, from: number, to: number, start: NonNullable<PositionRect>): number {
  let low = from + 1;
  let high = to;
  let best = from;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const coords = view.coordsAtPos(mid, -1) ?? view.coordsAtPos(mid, 1);
    if (coords && sameVisualLine(start, coords)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return best > from ? best : Math.min(to, from + 1);
}

function markerRectsForLineRange(view: EditorView, from: number, to: number, lineFrom: number, lineTo: number, includesLineBreak: boolean, base: { left: number; top: number }): TrimmedSelectionRect[] {
  const start = view.coordsAtPos(from, 1);
  const end = from < to ? view.coordsAtPos(to, -1) : start;
  if (!start || !end) return [];
  if (from >= to || sameVisualLine(start, end)) {
    const rect = markerForLineRange(view, from, to, lineFrom, lineTo, includesLineBreak, base);
    return rect ? [rect] : [];
  }

  const rects: TrimmedSelectionRect[] = [];
  let segmentFrom = from;
  while (segmentFrom < to) {
    const segmentStart = view.coordsAtPos(segmentFrom, 1);
    if (!segmentStart) break;
    const segmentTo = lastPositionOnVisualLine(view, segmentFrom, to, segmentStart);
    const rect = markerForLineRange(view, segmentFrom, segmentTo, lineFrom, lineTo, includesLineBreak && segmentTo >= to, base);
    if (rect) rects.push(rect);
    if (segmentTo <= segmentFrom) break;
    segmentFrom = segmentTo;
  }
  return rects;
}

function coversX(rect: TrimmedSelectionRect | undefined, x: number): boolean {
  if (!rect) return false;
  return rect.left <= x + CORNER_COVERAGE_GAP && rect.left + rect.width >= x - CORNER_COVERAGE_GAP;
}

function markerClass(rects: TrimmedSelectionRect[], index: number): string {
  const prev = rects[index - 1];
  const current = rects[index];
  const next = rects[index + 1];
  const touchesPrev = !!prev && Math.abs(prev.top + prev.height - current.top) <= CONTIGUOUS_LINE_GAP;
  const touchesNext = !!next && Math.abs(current.top + current.height - next.top) <= CONTIGUOUS_LINE_GAP;
  const left = current.left;
  const right = current.left + current.width;

  const classes = ["cm-trimmedSelection"];
  if (!touchesPrev || !coversX(prev, left)) classes.push("cm-trimmedSelection-topLeft");
  if (!touchesPrev || !coversX(prev, right)) classes.push("cm-trimmedSelection-topRight");
  if (!touchesNext || !coversX(next, left)) classes.push("cm-trimmedSelection-bottomLeft");
  if (!touchesNext || !coversX(next, right)) classes.push("cm-trimmedSelection-bottomRight");

  return classes.join(" ");
}

/**
 * A whole selected line's rectangles, plus the line block they were measured
 * against. The block is what tells a later frame whether the measurement is
 * still valid: a line's own top and height only move when its layout changes,
 * and comparing the two of them is free next to re-running `coordsAtPos`.
 */
interface CachedLineRects {
  top: number;
  height: number;
  rects: TrimmedSelectionRect[];
}

/**
 * A line block is only allowed to move by less than half a pixel before its
 * cached rectangles are re-measured. The heights CodeMirror reports while it is
 * still refining a viewport are fractional and can wobble by a fraction of a
 * pixel, and re-measuring for that would put the cost straight back.
 */
const CACHED_BLOCK_TOLERANCE = 0.5;

/**
 * Upper bound on the per-line cache. A selection that spans more lines than
 * this keeps the memory bounded and simply re-measures the overflow, which is
 * what the layer did for every line before the cache.
 */
const MAX_CACHED_SELECTION_LINES = 20_000;

export function trimmedSelectionLayer() {
  // Rectangles are produced in layer coordinates, which are measured from the
  // scroll container's content origin, so they do not move while the viewport
  // scrolls — only the layer's own offset does. A line that is wholly selected
  // keeps the same rectangle for as long as it stays selected, so it is
  // measured once instead of on every scroll frame. Without this a select-all
  // re-measured each visible line (four `coordsAtPos` calls plus a visual-line
  // binary search apiece) on every frame of the scroll.
  const wholeLineRects = new Map<number, CachedLineRects>();
  let geometrySignature = "";

  // Line metrics change with a font zoom without any document or selection
  // transaction, so they are part of the cache key rather than only an
  // invalidation on `geometryChanged`.
  const currentGeometrySignature = (view: EditorView) => `${view.scaleX}:${view.scaleY}:${view.defaultCharacterWidth}:${view.defaultLineHeight}`;

  return layer({
    above: false,
    class: "cm-trimmedSelectionLayer",
    markers(view) {
      const signature = currentGeometrySignature(view);
      if (signature !== geometrySignature) {
        geometrySignature = signature;
        wholeLineRects.clear();
      }

      const markers: InstanceType<typeof RectangleMarker>[] = [];
      const base = layerBase(view);

      for (const range of view.state.selection.ranges) {
        if (range.empty) continue;
        const rects: TrimmedSelectionRect[] = [];

        for (const visible of view.visibleRanges) {
          let pos = Math.max(range.from, visible.from, view.viewport.from);
          const endPos = Math.min(range.to, visible.to, view.viewport.to);

          while (pos < endPos) {
            const line = view.state.doc.lineAt(pos);
            const from = Math.max(pos, line.from);
            const to = Math.min(endPos, line.to);
            const includesLineBreak = endPos > line.to && range.to > line.to;
            // Only a line the selection covers in full, line break included,
            // has a rectangle that is independent of where the viewport sits:
            // the trimming only has to reason about the two lines the selection
            // starts and ends on.
            const coversWholeLine = from === line.from && to === line.to && includesLineBreak;
            let measured: TrimmedSelectionRect[] | undefined;
            if (coversWholeLine) {
              const block = view.lineBlockAt(line.from);
              const cached = wholeLineRects.get(line.from);
              if (cached && Math.abs(cached.top - block.top) < CACHED_BLOCK_TOLERANCE && Math.abs(cached.height - block.height) < CACHED_BLOCK_TOLERANCE) {
                measured = cached.rects;
              } else {
                measured = markerRectsForLineRange(view, from, to, line.from, line.to, includesLineBreak, base);
                // An empty measurement means the line was not laid out when it
                // was taken; caching that would leave the line unpainted until
                // something else invalidated it.
                if (measured.length) {
                  if (wholeLineRects.size >= MAX_CACHED_SELECTION_LINES) wholeLineRects.clear();
                  wholeLineRects.set(line.from, { top: block.top, height: block.height, rects: measured });
                }
              }
            } else {
              measured = markerRectsForLineRange(view, from, to, line.from, line.to, includesLineBreak, base);
            }
            rects.push(...measured);

            const next = line.to + 1;
            if (next <= pos) break;
            pos = next;
          }
        }

        rects.sort((a, b) => a.top - b.top || a.left - b.left);
        rects.forEach((rect, index) => {
          markers.push(new RectangleMarker(markerClass(rects, index), rect.left, rect.top, rect.width, rect.height));
        });
      }

      return markers;
    },
    update(update) {
      // A scroll only moves the viewport, and the cached rectangles are
      // measured from the content origin, so they survive it — including the
      // `geometryChanged` an update carries while a scroll is measuring lines
      // for the first time, which is most of the frames of a long scroll and
      // used to throw every cached line away. Anything that can move a line's
      // own rectangle — an edit, a different selection, a re-measure after a
      // font or theme change — is caught either here or by the block and
      // geometry checks in `markers` above.
      if (update.docChanged || update.selectionSet) wholeLineRects.clear();
      return update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged;
    },
  });
}

import type { EditorView, LayerMarker, ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export interface StatementFrameRequest {
  /** Document range covered by the frame; null hides the frame. */
  from: number;
  to: number;
}

export type StatementFrameResolver = (view: EditorView) => StatementFrameRequest | null;

/** Breathing room between the measured text bounds and the frame border (pixels). */
export const FRAME_INSET_PX = 2;

export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Viewish = Pick<EditorView, "coordsAtPos" | "scaleX" | "defaultCharacterWidth" | "defaultLineHeight"> & {
  state: Pick<EditorView["state"], "doc">;
  lineBlockAt: (pos: number) => Pick<ReturnType<EditorView["lineBlockAt"]>, "top" | "bottom" | "height">;
  scrollDOM: Pick<HTMLElement, "scrollLeft" | "scrollTop" | "getBoundingClientRect">;
  contentDOM: Pick<HTMLElement, "getBoundingClientRect">;
};

type PositionRect = NonNullable<ReturnType<EditorView["coordsAtPos"]>>;

function spansVisualRows(start: PositionRect, end: PositionRect): boolean {
  const startMid = (start.top + start.bottom) / 2;
  const endMid = (end.top + end.bottom) / 2;
  const startHeight = start.bottom - start.top;
  const endHeight = end.bottom - end.top;
  return Math.abs(startMid - endMid) > Math.max(2, Math.min(startHeight, endHeight) / 2);
}

/**
 * Statements spanning more logical lines than this render no frame. The
 * horizontal-bounds loop below does a constant number of geometry probes
 * per logical line, so its cost is O(logical lines) — fine for ordinary
 * statements, but a multi-thousand-line PL/SQL package body (Oracle, and
 * other dialects with BEGIN/END routine bodies) is parsed as a single
 * statement spanning the whole file, turning routine scrolling into
 * thousands of `coordsAtPos` calls per frame. See dbx#7226.
 */
export const MAX_FRAME_STATEMENT_LINES = 500;

/**
 * Measure the pixel rectangle of one statement rendered in `view`.
 *
 * The frame is a single continuous rectangle: it starts at the first
 * statement character, spans every statement line (blank and comment lines
 * included), and ends at the widest line.
 *
 * **Vertical bounds**: use `lineBlockAt` (document-level coordinates,
 * always reliable regardless of viewport position).
 *
 * **Horizontal bounds**: use `coordsAtPos` for visible lines (exact on tabs,
 * CJK/fullwidth glyphs and non-monospaced fonts). A soft-wrapped logical line
 * includes the content viewport bounds because intermediate visual rows reach
 * the wrap edge even when the final row is short. For off-viewport lines,
 * estimate using an offset calibrated from the first visible line start.
 * This keeps measurement O(logical lines) with a constant number of geometry
 * probes per line, independent of statement length and visual-row count.
 *
 * All four sides get a symmetric `FRAME_INSET_PX` breathing room.
 */
export function currentStatementFrameRect(view: Viewish, from: number, to: number): FrameRect | null {
  const doc = view.state.doc;
  if (!doc || to < from || from > doc.length || to > doc.length || to === from) return null;

  const startLine = doc.lineAt(from);
  const endLine = doc.lineAt(to);
  if (endLine.number - startLine.number > MAX_FRAME_STATEMENT_LINES) return null;
  const base = view.scrollDOM.getBoundingClientRect();

  // Vertical bounds: convert screen coords to content-layer coords.
  // Primary: coordsAtPos (CodeMirror extrapolates for off-viewport lines).
  // Fallback: lineBlockAt — returns content-layer coords directly (no
  // scrollTop adjustment needed; the layer scrolls with the content).

  const startCoords = view.coordsAtPos(from, 1);
  const top = startCoords ? startCoords.top - base.top + view.scrollDOM.scrollTop : view.lineBlockAt(from).top;

  const endCoords = view.coordsAtPos(to, -1);
  const bottom = endCoords ? endCoords.bottom - base.top + view.scrollDOM.scrollTop : view.lineBlockAt(to).bottom;

  if (bottom - top <= 0) return null;

  // Horizontal bounds: use coordsAtPos for visible lines. For off-viewport
  // lines, estimate using an offset calibrated from the first visible line.
  let left = Infinity;
  let right = -Infinity;
  const charWidth = view.defaultCharacterWidth;
  let calibratedOffset: number | null = null;
  let contentBounds: DOMRect | null = null;

  for (let lineNumber = startLine.number; lineNumber <= endLine.number; lineNumber += 1) {
    const line = doc.line(lineNumber);
    const anchorFrom = lineNumber === startLine.number ? from : line.from;
    const anchorTo = Math.min(line.to, to);
    const lineLeft = view.coordsAtPos(anchorFrom, 1);
    const lineRight = view.coordsAtPos(anchorTo, -1);

    if (lineLeft) {
      left = Math.min(left, lineLeft.left);
      right = Math.max(right, lineRight?.right ?? lineLeft.left);
      if (calibratedOffset === null && charWidth > 0) {
        const lineStart = anchorFrom === line.from ? lineLeft : view.coordsAtPos(line.from, 1);
        calibratedOffset = lineStart?.left ?? lineLeft.left - (anchorFrom - line.from) * charWidth;
      }
    } else if (calibratedOffset !== null && charWidth > 0) {
      const estimatedRight = calibratedOffset + line.length * charWidth;
      right = Math.max(right, estimatedRight);
    }

    const fullLogicalLine = anchorFrom === line.from && anchorTo === line.to;
    const wrappedFromCoordinates = !!lineLeft && !!lineRight && spansVisualRows(lineLeft, lineRight);
    const wrappedFromLineBlock = (!lineLeft || !lineRight) && fullLogicalLine && view.lineBlockAt(anchorFrom).height > view.defaultLineHeight * 1.5;
    if (wrappedFromCoordinates || wrappedFromLineBlock) {
      contentBounds ??= view.contentDOM.getBoundingClientRect();
      left = Math.min(left, contentBounds.left);
      right = Math.max(right, contentBounds.right);
    }
  }

  // If no endpoints were measurable and no wrapped block supplied viewport
  // bounds, skip the frame.
  if (!isFinite(left) || !isFinite(right)) return null;

  const leftOffset = base.left - view.scrollDOM.scrollLeft * view.scaleX;

  return {
    left: left - leftOffset - FRAME_INSET_PX,
    top: top - FRAME_INSET_PX,
    width: right - left + FRAME_INSET_PX * 2,
    height: bottom - top + FRAME_INSET_PX * 2,
  };
}

interface CurrentStatementFrameModule {
  layer: (config: { above: boolean; class?: string; markers(view: EditorView): readonly LayerMarker[]; update(update: ViewUpdate, layer: HTMLElement): boolean }) => Extension;
  RectangleMarker: new (className: string, left: number, top: number, width: number | null, height: number) => LayerMarker;
}

/**
 * Draw one continuous green rectangle around the current executable
 * statement. `resolve` decides visibility and returns the statement range;
 * returning null hides the frame.
 */
export function currentStatementFrameLayer(viewModule: CurrentStatementFrameModule, resolve: StatementFrameResolver): Extension {
  return viewModule.layer({
    // Keep the outline above line decorations so opaque active-line colors
    // from editor themes cannot cover the frame border.
    above: true,
    class: "cm-db-currentStatementFrameLayer",
    markers(view) {
      const request = resolve(view);
      if (!request || request.to < request.from) return [];
      const rect = currentStatementFrameRect(view, request.from, request.to);
      if (!rect) return [];
      return [new viewModule.RectangleMarker("cm-db-currentStatementFrame", rect.left, rect.top, rect.width, rect.height)];
    },
    update(update) {
      return update.docChanged || update.selectionSet || update.viewportChanged || update.geometryChanged || update.transactions.some((transaction) => transaction.reconfigured);
    },
  });
}

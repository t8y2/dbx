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
  /**
   * Lets the layer notice that the editor DOM was rebuilt (document or decoration changes) so it
   * can reuse a measured frame while nothing it depends on moved. Without it every measure
   * cycle re-measures.
   */
  ViewPlugin?: { define(create: (view: EditorView) => { docViewUpdate?(view: EditorView): void }): Extension };
}

type FrameGeometryView = Viewish & { viewport?: { from: number; to: number } };

/**
 * What a measured frame depends on besides the document and the DOM generation: glyph and line
 * metrics, the visible range (off-viewport lines are estimated, not probed), the wrapped height of
 * the statement's first and last lines, and the content width soft-wrapped lines extend to.
 */
function frameGeometrySignature(view: FrameGeometryView, from: number, to: number): string {
  const first = view.lineBlockAt(from);
  const last = view.lineBlockAt(to);
  return [view.scaleX, view.defaultCharacterWidth, view.defaultLineHeight, view.viewport?.from, view.viewport?.to, first.top, first.height, last.top, last.height, view.contentDOM.getBoundingClientRect().width].join("|");
}

interface MeasuredFrame {
  doc: unknown;
  domVersion: number;
  from: number;
  to: number;
  geometry: string;
  markers: readonly LayerMarker[];
}

/**
 * Draw one continuous green rectangle around the current executable
 * statement. `resolve` decides visibility and returns the statement range;
 * returning null hides the frame. `options.shouldRefresh` forces a repaint on
 * updates that change statement boundaries without touching the document
 * (e.g. a debounced boundary rebuild landing after a typing pause).
 */
export function currentStatementFrameLayer(viewModule: CurrentStatementFrameModule, resolve: StatementFrameResolver, options?: { shouldRefresh?: (update: ViewUpdate) => boolean }): Extension {
  let lastRequest: StatementFrameRequest | null | undefined;
  // CodeMirror asks every layer to measure on each geometry change and each DOM update, and one
  // keystroke runs several such cycles. The measurement is a pure function of the document, the
  // DOM generation and the geometry signature, so a repeat with all three unchanged reuses the
  // markers (the layer then sees identical markers and leaves its DOM alone).
  let measured: MeasuredFrame | undefined;
  let domVersion = 0;

  const sameRequest = (left: StatementFrameRequest | null | undefined, right: StatementFrameRequest | null): boolean => left === right || (!!left && !!right && left.from === right.from && left.to === right.to);

  const frameLayer = viewModule.layer({
    // Keep the outline above line decorations so opaque active-line colors
    // from editor themes cannot cover the frame border.
    above: true,
    class: "cm-db-currentStatementFrameLayer",
    markers(view) {
      const request = resolve(view);
      lastRequest = request;
      if (!request || request.to < request.from) return [];
      const geometry = frameGeometrySignature(view, request.from, request.to);
      if (measured && measured.doc === view.state.doc && measured.domVersion === domVersion && measured.from === request.from && measured.to === request.to && measured.geometry === geometry) {
        return measured.markers;
      }
      const rect = currentStatementFrameRect(view, request.from, request.to);
      const markers = rect ? [new viewModule.RectangleMarker("cm-db-currentStatementFrame", rect.left, rect.top, rect.width, rect.height)] : [];
      measured = { doc: view.state.doc, domVersion, from: request.from, to: request.to, geometry, markers };
      return markers;
    },
    update(update) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged || update.transactions.some((transaction) => transaction.reconfigured)) {
        lastRequest = undefined;
        if (update.transactions.some((transaction) => transaction.reconfigured)) measured = undefined;
        return true;
      }
      if (options?.shouldRefresh?.(update)) {
        lastRequest = undefined;
        measured = undefined;
        return true;
      }
      if (!update.selectionSet) return false;

      // Moving inside one statement does not change its frame. Avoid repeating
      // the per-line DOM geometry probes for every auto-repeated key event.
      const request = resolve(update.view);
      if (sameRequest(lastRequest, request)) return false;
      lastRequest = undefined;
      return true;
    },
  });
  const domVersionPlugin = viewModule.ViewPlugin?.define(() => ({
    docViewUpdate() {
      domVersion += 1;
    },
  }));
  return domVersionPlugin ? [frameLayer, domVersionPlugin] : frameLayer;
}

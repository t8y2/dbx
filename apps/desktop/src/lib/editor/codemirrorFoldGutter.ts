import { codeFolding, foldEffect, foldedRanges, foldable, language, unfoldEffect } from "@codemirror/language";
import { RangeSet, RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { GutterMarker, ViewPlugin, gutter, type EditorView, type ViewUpdate } from "@codemirror/view";

export interface FoldRange {
  from: number;
  to: number;
}

export type FoldRangeEndingAtLine = (state: EditorState, lineStart: number, lineEnd: number) => FoldRange | null;

type GutterConfig = Parameters<typeof gutter>[0];

export interface ConsistentFoldGutterOptions {
  foldingChanged?: (update: ViewUpdate) => boolean;
  foldRangeEndingAtLine?: FoldRangeEndingAtLine;
  domEventHandlers?: GutterConfig["domEventHandlers"];
  markerLabels: FoldMarkerLabels;
}

export type FoldMarkerSide = "start" | "end";

export interface FoldMarkerLabels {
  fold: () => string;
  unfold: () => string;
}

export function createFoldMarkerDom(open: boolean, side: FoldMarkerSide, labels: FoldMarkerLabels): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-foldMarker-svg";
  span.setAttribute("role", "button");
  span.setAttribute("aria-label", open ? labels.fold() : labels.unfold());
  const path = open ? (side === "end" ? "M4.5 9.5l3.5-3.5 3.5 3.5" : "M4.5 6.5l3.5 3.5 3.5-3.5") : "M6.5 4.5l3.5 3.5-3.5 3.5";
  span.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="${path}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return span;
}

class FoldMarker extends GutterMarker {
  constructor(
    private readonly open: boolean,
    private readonly side: FoldMarkerSide,
    private readonly labels: FoldMarkerLabels,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof FoldMarker && other.open === this.open && other.side === this.side;
  }

  toDOM(): HTMLElement {
    return createFoldMarkerDom(this.open, this.side, this.labels);
  }
}

function foldedRangeStartingOnLine(state: EditorState, lineStart: number, lineEnd: number): FoldRange | null {
  let range: FoldRange | null = null;
  foldedRanges(state).between(lineStart, lineEnd, (from, to) => {
    if (from >= lineStart && from <= lineEnd) {
      range = { from, to };
      return false;
    }
    return;
  });
  return range;
}

/**
 * Adds the normal start marker and a second marker on the line where a fold
 * ends. The end-line lookup is supplied by the editor's cached SQL analysis.
 */
export function createConsistentFoldGutter(options: ConsistentFoldGutterOptions): Extension {
  const startOpenMarker = new FoldMarker(true, "start", options.markerLabels);
  const endOpenMarker = new FoldMarker(true, "end", options.markerLabels);
  const closedMarker = new FoldMarker(false, "start", options.markerLabels);
  const customHandlers = options.domEventHandlers ?? {};

  const markers = ViewPlugin.fromClass(
    class {
      markers: RangeSet<GutterMarker>;

      constructor(view: EditorView) {
        this.markers = this.buildMarkers(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged || update.startState.facet(language) !== update.state.facet(language) || foldedRanges(update.startState) !== foldedRanges(update.state) || options.foldingChanged?.(update)) {
          this.markers = this.buildMarkers(update.view);
        }
      }

      buildMarkers(view: EditorView): RangeSet<GutterMarker> {
        const builder = new RangeSetBuilder<GutterMarker>();
        for (const line of view.viewportLineBlocks) {
          const folded = foldedRangeStartingOnLine(view.state, line.from, line.to);
          if (folded) {
            builder.add(line.from, line.from, closedMarker);
            continue;
          }

          if (foldable(view.state, line.from, line.to)) {
            builder.add(line.from, line.from, startOpenMarker);
            continue;
          }

          if (options.foldRangeEndingAtLine?.(view.state, line.from, line.to)) {
            builder.add(line.from, line.from, endOpenMarker);
          }
        }
        return builder.finish();
      }
    },
  );

  return [
    markers,
    gutter({
      class: "cm-foldGutter",
      markers: (view) => view.plugin(markers)?.markers ?? RangeSet.empty,
      initialSpacer: () => closedMarker,
      domEventHandlers: {
        ...customHandlers,
        click: (view, line, event) => {
          if (customHandlers.click?.(view, line, event)) return true;

          const folded = foldedRangeStartingOnLine(view.state, line.from, line.to);
          if (folded) {
            view.dispatch({ effects: unfoldEffect.of(folded) });
            return true;
          }

          const start = foldable(view.state, line.from, line.to);
          if (start) {
            view.dispatch({ effects: foldEffect.of(start) });
            return true;
          }

          const end = options.foldRangeEndingAtLine?.(view.state, line.from, line.to);
          if (end) {
            view.dispatch({ effects: foldEffect.of(end) });
            return true;
          }
          return false;
        },
      },
    }),
    codeFolding(),
  ];
}

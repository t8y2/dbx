import type { EditorState, Extension } from "@codemirror/state";
import { highlightSelectionMatches, SearchCursor } from "@codemirror/search";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const MIN_SELECTION_MATCH_LENGTH = 2;
const MAX_SELECTION_MATCH_LENGTH = 200;
const MAX_SCROLLBAR_MATCHES = 1200;
export const SELECTION_MATCH_SCAN_CHUNK_LENGTH = 64 * 1024;
export const SELECTION_MATCH_UPDATE_DELAY_MS = 120;

export interface SelectionMatchMarker {
  from: number;
  to: number;
  lineNumber: number;
  selected: boolean;
}

function selectedMatchQuery(state: EditorState): string | null {
  const selection = state.selection.main;
  if (selection.empty) return null;
  if (selection.to - selection.from > MAX_SELECTION_MATCH_LENGTH) return null;

  const text = state.sliceDoc(selection.from, selection.to);
  if (text.length < MIN_SELECTION_MATCH_LENGTH || !text.trim() || /[\r\n]/.test(text)) return null;
  return text;
}

export class SelectionMatchMarkerScan {
  readonly markers: SelectionMatchMarker[] = [];
  private readonly seenLines = new Set<number>();
  private from = 0;
  private matchesScanned = 0;
  private readonly lookaheadLength: number;

  constructor(
    private readonly state: EditorState,
    private readonly query: string,
  ) {
    const selection = state.selection.main;
    const selectedLine = state.doc.lineAt(selection.from);
    this.seenLines.add(selectedLine.number);
    this.seenLines.add(-selectedLine.number);
    this.markers.push({ from: selection.from, to: selection.to, lineNumber: selectedLine.number, selected: true });

    // SearchCursor compares NFKD text, whose source can use two UTF-16 units per normalized code point.
    const normalizedQuery = typeof query.normalize === "function" ? query.normalize("NFKD") : query;
    this.lookaheadLength = Math.max(query.length, normalizedQuery.length * 2) - 1;
  }

  scanNextChunk(): boolean {
    const doc = this.state.doc;
    if (this.from >= doc.length || this.matchesScanned >= MAX_SCROLLBAR_MATCHES) return true;

    const chunkFrom = this.from;
    const chunkTo = Math.min(doc.length, chunkFrom + SELECTION_MATCH_SCAN_CHUNK_LENGTH);
    // Include enough lookahead to catch normalized matches that start in this chunk and cross its boundary.
    const searchTo = Math.min(doc.length, chunkTo + this.lookaheadLength);
    const selection = this.state.selection.main;
    const cursor = new SearchCursor(doc, this.query, chunkFrom, searchTo);

    for (let match = cursor.next(); !match.done; match = cursor.next()) {
      const { from, to } = match.value;
      if (from >= chunkTo) break;
      if (from === to) continue;

      this.matchesScanned += 1;
      const line = doc.lineAt(from);
      const selected = from === selection.from && to === selection.to;
      const lineKey = selected ? -line.number : line.number;
      if (!this.seenLines.has(lineKey)) {
        this.seenLines.add(lineKey);
        this.markers.push({ from, to, lineNumber: line.number, selected });
      }
      if (this.matchesScanned >= MAX_SCROLLBAR_MATCHES) return true;
    }

    this.from = chunkTo;
    return this.from >= doc.length;
  }
}

export function createSelectionMatchMarkerScan(state: EditorState): SelectionMatchMarkerScan | null {
  const query = selectedMatchQuery(state);
  return query ? new SelectionMatchMarkerScan(state, query) : null;
}

class SelectionMatchScrollbar {
  private readonly layer: HTMLElement;
  private readonly win: Window;
  private signature = "";
  private updateTimer: number | null = null;
  private scanFrame: number | null = null;
  private revision = 0;

  constructor(view: EditorView) {
    this.layer = document.createElement("div");
    this.layer.className = "cm-selectionMatchScrollbarLayer";
    this.win = view.dom.ownerDocument.defaultView ?? window;
    view.dom.appendChild(this.layer);
    this.scheduleRender(view, 0);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet) this.scheduleRender(update.view);
  }

  destroy() {
    this.cancelScheduledRender();
    this.layer.remove();
  }

  private cancelScheduledRender() {
    this.revision += 1;
    if (this.updateTimer !== null) {
      this.win.clearTimeout(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.scanFrame !== null) {
      this.win.cancelAnimationFrame(this.scanFrame);
      this.scanFrame = null;
    }
  }

  private scheduleRender(view: EditorView, delay = SELECTION_MATCH_UPDATE_DELAY_MS) {
    this.cancelScheduledRender();
    const scan = createSelectionMatchMarkerScan(view.state);
    this.renderMarkers([], view.state.doc.lines);
    if (!scan) return;

    const revision = this.revision;
    this.updateTimer = this.win.setTimeout(() => {
      this.updateTimer = null;
      this.scanNextFrame(view, scan, revision);
    }, delay);
  }

  private scanNextFrame(view: EditorView, scan: SelectionMatchMarkerScan, revision: number) {
    if (revision !== this.revision) return;
    if (scan.scanNextChunk()) {
      this.renderMarkers(scan.markers, view.state.doc.lines);
      return;
    }
    // Yield between chunks so a large document never monopolizes pointer and paint work.
    this.scanFrame = this.win.requestAnimationFrame(() => {
      this.scanFrame = null;
      this.scanNextFrame(view, scan, revision);
    });
  }

  private renderMarkers(markers: SelectionMatchMarker[], lineCount: number) {
    const signature = `${lineCount}|${markers.map((marker) => `${marker.lineNumber}:${marker.from}:${marker.to}:${marker.selected}`).join("|")}`;
    if (signature === this.signature) return;
    this.signature = signature;
    this.layer.replaceChildren(
      ...markers.map((marker) => {
        const el = document.createElement("div");
        el.className = marker.selected ? "cm-selectionMatchScrollbarMark cm-selectionMatchScrollbarMark-selected" : "cm-selectionMatchScrollbarMark";
        const ratio = lineCount <= 1 ? 0 : (marker.lineNumber - 1) / (lineCount - 1);
        el.style.top = `${Math.max(0, Math.min(1, ratio)) * 100}%`;
        return el;
      }),
    );
  }
}

const selectionMatchScrollbar = ViewPlugin.fromClass(SelectionMatchScrollbar);

export function selectionMatchOccurrences(): Extension {
  return [
    highlightSelectionMatches({
      minSelectionLength: MIN_SELECTION_MATCH_LENGTH,
      maxMatches: 500,
    }),
    selectionMatchScrollbar,
    EditorView.theme({
      "&": {
        "--dbx-selection-match-background": "rgb(59 130 246 / 0.07)",
        "--dbx-selection-match-border": "rgb(59 130 246 / 0.24)",
        "--dbx-selection-match-main-background": "rgb(59 130 246 / 0.11)",
        "--dbx-selection-match-main-border": "rgb(59 130 246 / 0.36)",
        position: "relative",
      },
      ".dark &": {
        "--dbx-selection-match-background": "rgb(147 197 253 / 0.12)",
        "--dbx-selection-match-border": "rgb(147 197 253 / 0.3)",
        "--dbx-selection-match-main-background": "rgb(147 197 253 / 0.18)",
        "--dbx-selection-match-main-border": "rgb(147 197 253 / 0.42)",
      },
      ".cm-selectionMatch": {
        backgroundColor: "var(--dbx-selection-match-background)",
        borderRadius: "2px",
        boxShadow: "inset 0 0 0 1px var(--dbx-selection-match-border)",
      },
      ".cm-selectionMatch-main": {
        backgroundColor: "var(--dbx-selection-match-main-background)",
        boxShadow: "inset 0 0 0 1px var(--dbx-selection-match-main-border)",
      },
      ".cm-selectionMatchScrollbarLayer": {
        bottom: "2px",
        pointerEvents: "none",
        position: "absolute",
        right: "2px",
        top: "2px",
        width: "5px",
        zIndex: "40",
      },
      ".cm-selectionMatchScrollbarMark": {
        backgroundColor: "color-mix(in oklab, var(--primary) 48%, transparent)",
        borderRadius: "999px",
        height: "2px",
        position: "absolute",
        right: "0",
        transform: "translateY(-50%)",
        width: "3px",
      },
      ".cm-selectionMatchScrollbarMark-selected": {
        backgroundColor: "color-mix(in oklab, var(--primary) 72%, transparent)",
        height: "3px",
        width: "4px",
      },
    }),
  ];
}

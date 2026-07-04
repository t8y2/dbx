import type { EditorState, Extension } from "@codemirror/state";
import { highlightSelectionMatches, SearchCursor } from "@codemirror/search";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

const MIN_SELECTION_MATCH_LENGTH = 2;
const MAX_SELECTION_MATCH_LENGTH = 200;
const MAX_SCROLLBAR_MARKS = 1200;

interface SelectionMatchMarker {
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

function buildSelectionMatchMarkers(state: EditorState): SelectionMatchMarker[] {
  const query = selectedMatchQuery(state);
  if (!query) return [];

  const selection = state.selection.main;
  const markers: SelectionMatchMarker[] = [];
  const seenLines = new Set<number>();
  const cursor = new SearchCursor(state.doc, query);

  for (let match = cursor.next(); !match.done; match = cursor.next()) {
    const { from, to } = match.value;
    if (from === to) continue;

    const line = state.doc.lineAt(from);
    const selected = from === selection.from && to === selection.to;
    const lineKey = selected ? -line.number : line.number;
    if (seenLines.has(lineKey)) continue;
    seenLines.add(lineKey);

    markers.push({ from, to, lineNumber: line.number, selected });
    if (markers.length >= MAX_SCROLLBAR_MARKS) break;
  }

  return markers;
}

class SelectionMatchScrollbar {
  private readonly layer: HTMLElement;
  private signature = "";

  constructor(view: EditorView) {
    this.layer = document.createElement("div");
    this.layer.className = "cm-selectionMatchScrollbarLayer";
    view.dom.appendChild(this.layer);
    this.render(view);
  }

  update(update: ViewUpdate) {
    if (update.docChanged || update.selectionSet || update.geometryChanged) {
      this.render(update.view);
    }
  }

  destroy() {
    this.layer.remove();
  }

  private render(view: EditorView) {
    const markers = buildSelectionMatchMarkers(view.state);
    const lineCount = view.state.doc.lines;
    const signature = markers.map((marker) => `${marker.lineNumber}:${marker.from}:${marker.to}:${marker.selected}`).join("|");
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

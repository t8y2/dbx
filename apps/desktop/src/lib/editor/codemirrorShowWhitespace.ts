import type { Extension } from "@codemirror/state";

type ViewModule = typeof import("@codemirror/view");
type EditorViewType = import("@codemirror/view").EditorView;
type DecorationSet = import("@codemirror/view").DecorationSet;

export const NEWLINE_MARKER = "↵";
export const NEWLINE_MARKER_CLASS = "cm-dbx-newline-marker";

/**
 * Display-only whitespace markers for the SQL editor: spaces as "·", tabs as "→"
 * (CodeMirror's highlightWhitespace) plus a "↵" at every line end that is followed
 * by a line break. The document text itself is never touched.
 */
export function createShowWhitespaceExtension(view: Pick<ViewModule, "highlightWhitespace" | "ViewPlugin" | "Decoration" | "WidgetType" | "EditorView">, enabled: boolean): Extension {
  if (!enabled) return [];
  const { highlightWhitespace, ViewPlugin, Decoration, WidgetType, EditorView } = view;

  class NewlineMarkerWidget extends WidgetType {
    eq(): boolean {
      return true;
    }
    toDOM(): HTMLElement {
      const el = document.createElement("span");
      el.className = NEWLINE_MARKER_CLASS;
      el.setAttribute("aria-hidden", "true");
      el.textContent = NEWLINE_MARKER;
      return el;
    }
    ignoreEvent(): boolean {
      return true;
    }
  }
  const marker = Decoration.widget({ widget: new NewlineMarkerWidget(), side: 1 });

  function buildDecorations(editorView: EditorViewType): DecorationSet {
    const doc = editorView.state.doc;
    const ranges = [];
    let lastLine = -1;
    for (const { from, to } of editorView.visibleRanges) {
      for (let pos = from; pos <= to; ) {
        const line = doc.lineAt(pos);
        if (line.number !== lastLine) {
          lastLine = line.number;
          if (line.number < doc.lines) ranges.push(marker.range(line.to));
        }
        pos = line.to + 1;
      }
    }
    return Decoration.set(ranges);
  }

  const newlinePlugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(editorView: EditorViewType) {
        this.decorations = buildDecorations(editorView);
      }
      update(update: import("@codemirror/view").ViewUpdate) {
        if (update.docChanged || update.viewportChanged) this.decorations = buildDecorations(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );

  const markerTheme = EditorView.baseTheme({
    [`.${NEWLINE_MARKER_CLASS}`]: { opacity: "0.35", pointerEvents: "none", userSelect: "none" },
  });

  return [highlightWhitespace(), newlinePlugin, markerTheme];
}

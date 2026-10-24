import type { Extension } from "@codemirror/state";
import type { EditorView as EditorViewType } from "@codemirror/view";
import { nextBookmarkLine, normalizeBookmarkLines, type BookmarkNavigationDirection } from "./bookmarkNavigation";

export interface QueryEditorBookmarkModules {
  EditorView: typeof import("@codemirror/view").EditorView;
  StateField: typeof import("@codemirror/state").StateField;
  StateEffect: typeof import("@codemirror/state").StateEffect;
  GutterMarker: typeof import("@codemirror/view").GutterMarker;
  gutter: typeof import("@codemirror/view").gutter;
}

export interface QueryEditorBookmarks {
  extension: Extension;
  toggle(view: EditorViewType): boolean;
  next(view: EditorViewType): boolean;
  previous(view: EditorViewType): boolean;
  reset(view: EditorViewType): void;
}

export interface QueryEditorBookmarkOptions {
  modules: QueryEditorBookmarkModules;
  toggleLabel: () => string;
}

function createBookmarkMarkerDom(label: string): HTMLElement {
  const marker = document.createElement("span");
  marker.className = "cm-bookmark-marker";
  marker.title = label;
  marker.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M6 3h12a1 1 0 0 1 1 1v17l-7-4.2L5 21V4a1 1 0 0 1 1-1Z");
  svg.appendChild(path);
  marker.appendChild(svg);
  return marker;
}

let sharedBookmarks: QueryEditorBookmarks | null = null;
let toggleLabelProvider: () => string = () => "";

export function createQueryEditorBookmarks(options: QueryEditorBookmarkOptions): QueryEditorBookmarks {
  toggleLabelProvider = options.toggleLabel;
  if (sharedBookmarks) return sharedBookmarks;

  const { EditorView, StateField, StateEffect, GutterMarker, gutter } = options.modules;

  class BookmarkMarker extends GutterMarker {
    toDOM() {
      return createBookmarkMarkerDom(toggleLabelProvider());
    }
  }

  const bookmarkMarker = new BookmarkMarker();
  const toggleBookmarkEffect = StateEffect.define<number>();
  const resetBookmarksEffect = StateEffect.define<null>();

  const bookmarkField = StateField.define<ReadonlySet<number>>({
    create: () => new Set<number>(),
    update(bookmarks, transaction) {
      let next: Set<number> | null = null;

      if (transaction.docChanged) {
        next = new Set<number>();
        for (const position of bookmarks) {
          const mapped = transaction.changes.mapPos(position, 1);
          if (mapped < 0 || mapped > transaction.newDoc.length) continue;
          next.add(transaction.newDoc.lineAt(mapped).from);
        }
      }

      for (const effect of transaction.effects) {
        if (effect.is(resetBookmarksEffect)) next = new Set<number>();
      }

      for (const effect of transaction.effects) {
        if (!effect.is(toggleBookmarkEffect)) continue;
        next ??= new Set(bookmarks);
        const doc = transaction.state.doc;
        const lineStart = doc.lineAt(Math.max(0, Math.min(effect.value, doc.length))).from;
        if (next.has(lineStart)) next.delete(lineStart);
        else next.add(lineStart);
      }

      return next ?? bookmarks;
    },
  });

  const bookmarkGutter = gutter({
    class: "cm-bookmark-gutter",
    renderEmptyElements: true,
    initialSpacer: () => bookmarkMarker,
    lineMarker(view, line) {
      return view.state.field(bookmarkField).has(line.from) ? bookmarkMarker : null;
    },
    lineMarkerChange(update) {
      return update.startState.field(bookmarkField) !== update.state.field(bookmarkField);
    },
    domEventHandlers: {
      mousedown(view, line, event) {
        event.preventDefault();
        view.dispatch({ effects: toggleBookmarkEffect.of(line.from) });
        view.focus();
        return true;
      },
    },
  });

  const theme = EditorView.baseTheme({
    ".cm-bookmark-gutter": {
      width: "14px",
    },
    ".cm-bookmark-gutter .cm-gutterElement": {
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      cursor: "pointer",
      borderRadius: "3px",
    },
    ".cm-bookmark-gutter .cm-gutterElement:hover": {
      backgroundColor: "color-mix(in srgb, var(--foreground) 8%, transparent)",
    },
    ".cm-bookmark-marker": {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color: "var(--primary)",
    },
    ".cm-bookmark-marker svg": {
      width: "12px",
      height: "12px",
    },
  });

  function toggle(view: EditorViewType): boolean {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    view.dispatch({ effects: toggleBookmarkEffect.of(line.from) });
    return true;
  }

  function navigate(view: EditorViewType, direction: BookmarkNavigationDirection): boolean {
    const lines = normalizeBookmarkLines(view.state.field(bookmarkField));
    const currentLineStart = view.state.doc.lineAt(view.state.selection.main.head).from;
    const target = nextBookmarkLine(lines, currentLineStart, direction);
    if (target === null) return false;
    view.dispatch({ selection: { anchor: target }, scrollIntoView: true });
    return true;
  }

  sharedBookmarks = {
    extension: [bookmarkField, bookmarkGutter, theme],
    toggle,
    next: (view) => navigate(view, "next"),
    previous: (view) => navigate(view, "previous"),
    reset(view) {
      view.dispatch({ effects: resetBookmarksEffect.of(null) });
    },
  };
  return sharedBookmarks;
}

/** Clear every bookmark in this editor, e.g. after swapping in another tab's document. */
export function resetQueryEditorBookmarks(view: EditorViewType): void {
  sharedBookmarks?.reset(view);
}

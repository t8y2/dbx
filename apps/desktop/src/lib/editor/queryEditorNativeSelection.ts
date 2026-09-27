import type { EditorView } from "@codemirror/view";
import { appendDebugLog } from "@/lib/backend/debugLog";

/**
 * macOS 26/27 asks the web view to serialize the browser selection into an
 * attributed string whenever the pointer dwells over text services (the
 * Writing Tools check that follows a text selection). Resolving that string
 * means a colour lookup per styled run, so one request over a few hundred
 * highlighted lines of SQL costs well over 100 ms of web process main thread
 * time — and while one of the app's own menus sits on top of the selection
 * every pointer move over that menu asks again, which saturates the main
 * thread and makes right click, Esc and the whole window feel frozen.
 *
 * The browser selection does not have to cover the selection for the editor to
 * behave: CodeMirror paints the selection itself (`drawSelection` keeps the
 * native one transparent), it copies from its own state, and it ignores a
 * selection parked outside its content element. So while an overlay menu is
 * shown on top of the editor the browser selection is parked on the editor
 * chrome and restored as soon as the menu closes.
 *
 * Parking outside `contentDOM` is what makes CodeMirror leave the editor state
 * alone (it maps a foreign selection back to the selection it already has), so
 * the parked selection stays where it is, but it also means CodeMirror's own
 * `copy`/`cut` handler declines the event — see `handleParkedClipboardEvent`,
 * which supplies the clipboard text in that window.
 */

/**
 * Selections shorter than this are serialized cheaply enough that parking them
 * would only trade a measurable cost for an invisible one.
 */
export const NATIVE_SELECTION_PARK_MIN_CHARS = 1000;

export interface EditorNativeSelectionPark {
  /** Put the browser selection back where the editor state has it. */
  release(): void;
}

export interface EditorNativeSelectionParkOptions {
  /**
   * Applied to the text the parked copy path puts on the clipboard. Pass the
   * same normalizer the editor registers as `EditorView.clipboardOutputFilter`
   * (DBX rewrites line endings there) so copying with the menu open matches
   * copying with it closed. Injected rather than read from the facet so this
   * module never pulls CodeMirror into the startup bundle.
   */
  finalizeClipboardText?: (text: string) => string;
}

/**
 * Mirrors CodeMirror's own root handling: shadow roots only expose
 * `getSelection` on some browsers, otherwise the owner document holds it.
 */
export function editorRootSelection(currentView: EditorView): Selection | null {
  const root = currentView.root as unknown as ShadowRoot & { getSelection?: () => Selection | null };
  if (root.nodeType !== 11) return (root as unknown as Document).getSelection();
  if (typeof root.getSelection === "function") return root.getSelection() ?? null;
  return root.ownerDocument?.getSelection() ?? null;
}

function isParkedOutsideContent(currentView: EditorView, selection: Selection): boolean {
  const anchor = selection.anchorNode;
  return !!anchor && !currentView.contentDOM.contains(anchor);
}

function parkSelection(currentView: EditorView, selection: Selection): void {
  try {
    // `view.dom` (the editor element) sits outside `view.contentDOM`, so
    // CodeMirror treats the parked selection as somebody else's and leaves the
    // editor state alone. It is also far from the highlighted text, which is
    // what keeps the attributed string cheap.
    selection.collapse(currentView.dom, 0);
  } catch {
    // WebKit rejects a collapse whose node disappeared between layout passes.
  }
}

function restoreSelectionFromState(currentView: EditorView, selection: Selection): void {
  try {
    const main = currentView.state.selection.main;
    const anchor = currentView.domAtPos(main.from);
    const head = main.empty ? anchor : currentView.domAtPos(main.to);
    selection.collapse(anchor.node, anchor.offset);
    if (!main.empty) selection.extend(head.node, head.offset);
  } catch {
    // WebKit refuses `extend` when the target moved in the meantime; the next
    // selection change makes CodeMirror rewrite the browser selection anyway.
  }
}

/**
 * The text CodeMirror would put on the clipboard for the current state.
 *
 * Mirrors CodeMirror's `copiedRange` (join the non-empty ranges with the
 * document line break, then run the app's output filter) so a copy taken while
 * the selection is parked is byte-identical to a copy taken while it is not.
 */
function copiedEditorText(currentView: EditorView, finalizeText: (text: string) => string): { text: string; ranges: { from: number; to: number }[] } | null {
  const { state } = currentView;
  const parts: string[] = [];
  const ranges: { from: number; to: number }[] = [];
  for (const range of state.selection.ranges) {
    if (range.empty) continue;
    parts.push(state.sliceDoc(range.from, range.to));
    ranges.push({ from: range.from, to: range.to });
  }
  if (!parts.length) return null;
  return { text: finalizeText(parts.join(state.lineBreak)), ranges };
}

/**
 * Fills the clipboard for a `copy`/`cut` that CodeMirror declined.
 *
 * CodeMirror's handler only acts when the browser selection sits inside
 * `contentDOM` (`handlers.copy` bails out on `hasSelection(view.contentDOM,
 * …)`), which a parked selection deliberately is not. Without this the user
 * would copy the parked caret instead of the visible selection.
 *
 * The app's own menus close on the first non-modifier keydown, so a Cmd+C
 * normally releases the park before the copy lands and never reaches here;
 * this covers the copies that arrive while the selection is still parked
 * (clicking a copy item, platform-initiated copies).
 */
function handleParkedClipboardEvent(currentView: EditorView, finalizeClipboardText: (text: string) => string, released: () => boolean, event: ClipboardEvent): void {
  if (released() || event.defaultPrevented) return;
  // `copy`/`cut` fire on the focused element; a parked selection only exists
  // while the editor owns the interaction, so anything else is somebody else's.
  const target = event.target as Node | null;
  if (target && !currentView.dom.contains(target)) return;
  const payload = copiedEditorText(currentView, finalizeClipboardText);
  if (!payload) return;
  const data = event.clipboardData;
  if (!data) return;
  data.clearData();
  data.setData("text/plain", payload.text);
  if (event.type === "cut" && !currentView.state.readOnly) currentView.dispatch({ changes: payload.ranges, scrollIntoView: true, userEvent: "delete.cut" });
  event.preventDefault();
}

/**
 * Parks the browser selection while an overlay menu covers the editor.
 *
 * @returns a handle that restores the browser selection, or `null` when there
 * was nothing worth parking.
 */
export function parkEditorNativeSelection(currentView: EditorView, options: EditorNativeSelectionParkOptions = {}): EditorNativeSelectionPark | null {
  const main = currentView.state.selection.main;
  if (main.empty || main.to - main.from < NATIVE_SELECTION_PARK_MIN_CHARS) return null;
  const selection = editorRootSelection(currentView);
  if (!selection || !selection.anchorNode || !currentView.dom.contains(selection.anchorNode)) return null;
  // Kept for field diagnosis: it only writes while debug logging is switched
  // on, and it is the one line that shows whether the parked window was even
  // entered when somebody reports the editor still stuttering.
  appendDebugLog("info", "[DBX][QueryEditor:native-selection:park]", { chars: main.to - main.from });

  parkSelection(currentView, selection);
  let released = false;
  let frame = 0;
  const finalizeClipboardText = options.finalizeClipboardText ?? ((text: string) => text);
  // `copy`/`cut` bubble through the document, so listening there catches the
  // event no matter which editor chrome inside the view holds focus.
  const doc = currentView.dom.ownerDocument;
  const win = doc.defaultView ?? window;
  const onCopy = (event: ClipboardEvent) => handleParkedClipboardEvent(currentView, finalizeClipboardText, () => released, event);
  doc.addEventListener("copy", onCopy);
  doc.addEventListener("cut", onCopy);
  // CodeMirror rewrites the browser selection from its own state on every
  // selection update (menu actions, diagnostics re-anchoring, typing), so a
  // single collapse does not stick. Reading `anchorNode` costs no layout.
  const keepParked = () => {
    if (released) return;
    if (!isParkedOutsideContent(currentView, selection)) parkSelection(currentView, selection);
    frame = win.requestAnimationFrame(keepParked);
  };
  frame = win.requestAnimationFrame(keepParked);

  return {
    release() {
      if (released) return;
      released = true;
      doc.removeEventListener("copy", onCopy);
      doc.removeEventListener("cut", onCopy);
      win.cancelAnimationFrame(frame);
      const live = editorRootSelection(currentView);
      if (live && isParkedOutsideContent(currentView, live)) restoreSelectionFromState(currentView, live);
    },
  };
}

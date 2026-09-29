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
 * selection parked outside its content element. So the browser selection is
 * parked on the editor chrome while an overlay menu covers the editor, and for
 * as long as a pointer gesture is dragging a long selection out, and restored
 * as soon as the menu closes or the pointer is released.
 *
 * The drag is the case that is easiest to misread from a bug report: sweeping
 * the pointer to the edge of the editor autoscrolls and never leaves the
 * pointer on the text, so it stays smooth, while moving back up into the
 * already selected lines pays the serialization cost on every mouse move
 * (smooth in Chrome/Blink, which does not make that request at all).
 *
 * Parking outside `contentDOM` is what makes CodeMirror leave the editor state
 * alone (it maps a foreign selection back to the selection it already has), so
 * the parked selection stays where it is, but it also means CodeMirror's own
 * `copy`/`cut` handler declines the event — see `handleParkedClipboardEvent`,
 * which supplies the clipboard text in that window.
 */

/**
 * Selections shorter than this are serialized cheaply enough that parking them
 * would only trade a measurable cost for an invisible one. Dragging a selection
 * out keeps the browser selection live until it crosses this length, so a drag
 * over a few lines behaves exactly as it did before.
 */
export const NATIVE_SELECTION_PARK_MIN_CHARS = 1000;

/** Whether the editor's primary selection is long enough to be worth parking. */
export function isLargeEditorSelection(currentView: EditorView): boolean {
  const main = currentView.state.selection.main;
  return !main.empty && main.to - main.from >= NATIVE_SELECTION_PARK_MIN_CHARS;
}

export interface EditorNativeSelectionPark {
  /** Put the browser selection back where the editor state has it. */
  release(): void;
}

export interface EditorNativeSelectionDragParkOptions extends EditorNativeSelectionParkOptions {
  /**
   * Parking is suspended while this returns false, which lets a caller keep one
   * handle for a whole gesture and still let a short selection behave normally.
   */
  shouldKeepParked?: () => boolean;
  /**
   * Whether CodeMirror's own browser-selection writes are suspended while the
   * park holds. Only the drag park wants this, because only the drag park is
   * re-collapsed in a frame loop that CodeMirror then writes against. See
   * `suppressEditorSelectionWrites`.
   */
  suppressEditorSelectionWrites?: boolean;
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

interface EditorViewSelectionInternals {
  docView?: { updateSelection?: (mustRead?: boolean, fromPointer?: boolean) => void };
  observer?: { selectionRange: { focusNode: Node | null }; readSelectionRange: () => boolean };
}

const UPDATE_SELECTION = "updateSelection";

/**
 * Stops CodeMirror from writing its selection into the browser while parked.
 *
 * Parking alone is not enough for a drag. CodeMirror rewrites the browser
 * selection whenever it differs from the editor state, and a parked selection
 * always differs, so every pointer move issues a fresh `collapse` inside the
 * editable — which is exactly the operation that costs tens of milliseconds on
 * macOS 26/27. Measured on a 2500 line document: 21 writes over a 300 line
 * drag, 23–167 ms each, all of the web process main thread. Those writes buy
 * nothing while parked: CodeMirror draws and copies the selection from its own
 * state, a parked selection is by definition not what the user sees.
 *
 * The suppression is narrow on purpose — it shadows the single method that
 * performs the write and keeps its read half, so CodeMirror still notices a
 * selection the browser moved on its own. It is restored by the park's
 * `release()`, and it refuses to touch a view whose internals do not look like
 * the ones it was written against.
 */
function suppressEditorSelectionWrites(currentView: EditorView): (() => void) | null {
  const internals = currentView as unknown as EditorViewSelectionInternals;
  const docView = internals.docView;
  const observer = internals.observer;
  if (!docView || typeof docView[UPDATE_SELECTION] !== "function" || !observer) return null;
  // Never clobber a patch somebody else owns; without our shadow the prototype
  // method is what CodeMirror calls, and that is exactly what we restore.
  if (Object.prototype.hasOwnProperty.call(docView, UPDATE_SELECTION)) return null;
  const suppressed = (mustRead?: boolean) => {
    if (mustRead || !observer.selectionRange.focusNode) observer.readSelectionRange();
  };
  docView[UPDATE_SELECTION] = suppressed;
  return () => {
    if (docView[UPDATE_SELECTION] === suppressed) delete docView[UPDATE_SELECTION];
  };
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
 * The machinery both parking windows share.
 *
 * Parking is idempotent and self-healing: the browser can put a selection back
 * into the editor on its own (focus, a redraw, the platform moving a caret), so
 * the collapse is repeated for as long as the window lasts. Reading `anchorNode`
 * costs no layout, so the frame loop is cheap enough to run for the length of a
 * gesture. A drag park additionally stops CodeMirror from writing the browser
 * selection at all while it holds — see `suppressEditorSelectionWrites` — which
 * is what removes the per-pointer-move cost of re-collapsing a large selection.
 */
interface NativeSelectionParkConfig {
  /** Whether the window should still hold. Re-read on every frame. */
  shouldKeepParked: () => boolean;
  finalizeClipboardText: (text: string) => string;
  /** See `suppressEditorSelectionWrites`. */
  suppressWrites?: boolean;
  /**
   * Restore the browser selection on the next frame instead of inside
   * `release()`, and skip the restore when the browser selection is no longer
   * parked by then.
   *
   * A gesture ends by dispatching: CodeMirror collapses the selection for a
   * click and rewrites the browser selection for a drag. Either way its own
   * write lands first, after which there is nothing left to restore — and
   * restoring first would put the whole long selection back into the browser
   * only to have CodeMirror write over it. On macOS 26/27 each of those writes
   * is the expensive text-services operation this module exists to avoid, so a
   * click that clears a long drag paid for three of them. The frame is the
   * safety net for the gestures that end without any dispatch — a release
   * outside the window, a focus change — where the parked selection would
   * otherwise stay parked. The restore re-reads the editor state when it runs.
   */
  deferReleaseRestore?: boolean;
}

/**
 * Which park most recently took the browser selection. A deferred restore only
 * acts while its own park is still the newest one: a park that starts before the
 * microtask runs owns the browser selection, and restoring under it would hand
 * the selection back to the text services for a frame.
 */
let latestParkSequence = 0;

function createNativeSelectionPark(currentView: EditorView, config: NativeSelectionParkConfig): EditorNativeSelectionPark {
  const { shouldKeepParked, finalizeClipboardText, suppressWrites = false, deferReleaseRestore = false } = config;
  const sequence = ++latestParkSequence;
  const doc = currentView.dom.ownerDocument;
  const win = doc.defaultView ?? window;
  let released = false;
  let frame = 0;
  let parkedOnce = false;
  let parkedSince = 0;
  let restoreWrites: (() => void) | null = null;

  const park = () => {
    if (released || !shouldKeepParked()) return;
    const selection = editorRootSelection(currentView);
    if (!selection || isParkedOutsideContent(currentView, selection)) return;
    parkSelection(currentView, selection);
    if (!parkedOnce) {
      parkedOnce = true;
      parkedSince = performance.now();
      if (suppressWrites) restoreWrites = suppressEditorSelectionWrites(currentView);
      // Kept for field diagnosis: it only writes while debug logging is
      // switched on, and it is the one line that shows whether the parking
      // window was even entered when somebody reports the editor stuttering.
      appendDebugLog("info", "[DBX][QueryEditor:native-selection:park]", {
        chars: currentView.state.selection.main.to - currentView.state.selection.main.from,
        suppressesEditorWrites: !!restoreWrites,
      });
    }
  };
  park();

  const onCopy = (event: ClipboardEvent) => handleParkedClipboardEvent(currentView, finalizeClipboardText, () => released, event);
  // `copy`/`cut` bubble through the document, so listening there catches the
  // event no matter which editor chrome inside the view holds focus.
  doc.addEventListener("copy", onCopy);
  doc.addEventListener("cut", onCopy);

  const keepParked = () => {
    if (released) return;
    park();
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
      restoreWrites?.();
      restoreWrites = null;
      const restore = () => {
        if (sequence !== latestParkSequence) return;
        const live = editorRootSelection(currentView);
        if (live && isParkedOutsideContent(currentView, live)) restoreSelectionFromState(currentView, live);
      };
      if (deferReleaseRestore) win.requestAnimationFrame(restore);
      else restore();
      if (parkedOnce) {
        // Field diagnosis for "the selection took seconds to clear": how long a
        // park lived says whether a gesture was still parked while the user
        // thought it had ended, and how many frame-collapses it took.
        appendDebugLog("info", "[DBX][QueryEditor:native-selection:release]", {
          ms: Math.round(performance.now() - parkedSince),
          chars: currentView.state.selection.main.to - currentView.state.selection.main.from,
          suppressedEditorWrites: suppressWrites,
        });
      }
    },
  };
}

/**
 * Parks the browser selection while an overlay menu covers the editor.
 *
 * @returns a handle that restores the browser selection, or `null` when there
 * was nothing worth parking.
 */
export function parkEditorNativeSelection(currentView: EditorView, options: EditorNativeSelectionParkOptions = {}): EditorNativeSelectionPark | null {
  if (!isLargeEditorSelection(currentView)) return null;
  const selection = editorRootSelection(currentView);
  if (!selection || !selection.anchorNode || !currentView.dom.contains(selection.anchorNode)) return null;
  return createNativeSelectionPark(currentView, { shouldKeepParked: () => true, finalizeClipboardText: options.finalizeClipboardText ?? ((text: string) => text) });
}

/**
 * Parks the browser selection for the length of a pointer gesture.
 *
 * Call this on pointer down and `release()` on pointer up: the browser
 * selection stays parked only while the editor's own selection is long enough
 * to be worth it (`isLargeEditorSelection`), so a gesture that never grows past
 * a few lines — or one that starts by shrinking a selection back down — keeps
 * behaving exactly as it did before. The editor keeps its own selection while
 * this runs, so the highlight, the selection that survives the release and the
 * text on the clipboard are unchanged.
 */
export function keepNativeSelectionParkedDuringDrag(currentView: EditorView, options: EditorNativeSelectionDragParkOptions = {}): EditorNativeSelectionPark {
  return createNativeSelectionPark(currentView, {
    shouldKeepParked: () => isLargeEditorSelection(currentView) && (options.shouldKeepParked?.() ?? true),
    finalizeClipboardText: options.finalizeClipboardText ?? ((text: string) => text),
    suppressWrites: options.suppressEditorSelectionWrites ?? true,
    // A gesture ends by dispatching a selection change, and that write is both
    // the correct one and the cheap one to land first. See `deferReleaseRestore`.
    deferReleaseRestore: true,
  });
}

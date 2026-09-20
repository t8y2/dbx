/**
 * Click-to-focus for an unfocused SQL editor.
 *
 * On macOS WKWebView, a blurred contenteditable keeps its last selection. Clicking
 * after the scroller has moved can restore that caret and jump the viewport. The
 * scrollbar pointer guard does not cover wheel/trackpad scrolling (#9296).
 *
 * This only focuses the editor early and restores the viewport around the focus
 * jump. Selection stays with CodeMirror's built-in mousedown, which runs after
 * custom domEventHandlers and owns caret placement, drag-to-select, and the
 * Alt-rectangular and multi-cursor gestures. Calling event.preventDefault() here
 * would suppress that handler entirely (InputState.runHandlers stops at the
 * first handler whose event is default-prevented).
 */

import { startsQueryEditorSelectionDrag } from "@/lib/editor/queryEditorPointerSelection";

export interface UnfocusedQueryEditorPointerEvent {
  altKey: boolean;
  button: number;
  ctrlKey: boolean;
  detail: number;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface UnfocusedQueryEditorScroller {
  scrollLeft: number;
  scrollTop: number;
}

export interface UnfocusedQueryEditorView {
  hasFocus: boolean;
  focus(): void;
  scrollDOM: UnfocusedQueryEditorScroller;
}

export function shouldStabilizeUnfocusedQueryEditorPointerDown(event: UnfocusedQueryEditorPointerEvent, view: Pick<UnfocusedQueryEditorView, "hasFocus"> | null | undefined): boolean {
  if (!view || view.hasFocus) return false;
  if (event.button !== 0) return false;
  // Cmd/Ctrl belong to object navigation and Alt to CodeMirror's rectangular and
  // multi-cursor gestures; those clicks must reach their own handlers unfocused.
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  return startsQueryEditorSelectionDrag(event);
}

export function preserveQueryEditorScrollPosition(scroller: UnfocusedQueryEditorScroller) {
  const scrollLeft = scroller.scrollLeft;
  const scrollTop = scroller.scrollTop;
  return () => {
    if (scroller.scrollLeft !== scrollLeft) scroller.scrollLeft = scrollLeft;
    if (scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
  };
}

/**
 * Focuses an unfocused editor before CodeMirror's built-in mousedown runs and
 * restores the viewport synchronously plus once after a frame; the default is
 * left unprevented so CodeMirror performs the selection itself.
 */
export function stabilizeUnfocusedQueryEditorPointerDown(view: UnfocusedQueryEditorView, event: UnfocusedQueryEditorPointerEvent, scheduleFrame?: (callback: () => void) => void): boolean {
  if (!shouldStabilizeUnfocusedQueryEditorPointerDown(event, view)) return false;

  const restoreScroll = preserveQueryEditorScrollPosition(view.scrollDOM);
  view.focus();
  restoreScroll();
  const schedule = scheduleFrame ?? (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (callback) => callback());
  schedule(restoreScroll);
  return true;
}

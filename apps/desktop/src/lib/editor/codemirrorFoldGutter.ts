import { foldGutter } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

export function createFoldMarkerDom(open: boolean): HTMLElement {
  const span = document.createElement("span");
  span.className = "cm-foldMarker-svg";
  span.setAttribute("role", "button");
  span.setAttribute("aria-label", open ? "Fold line" : "Unfold line");
  span.innerHTML = open
    ? '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4.5 6.5l3.5 3.5 3.5-3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    : '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6.5 4.5l3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return span;
}

export function createConsistentFoldGutter(options?: Parameters<typeof foldGutter>[0]): Extension {
  return foldGutter({
    markerDOM: createFoldMarkerDom,
    ...options,
  });
}

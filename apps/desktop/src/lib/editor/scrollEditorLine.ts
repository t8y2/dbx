import type { EditorView } from "@codemirror/view";

export function scrollEditorLine(view: EditorView, direction: "up" | "down"): boolean {
  view.scrollDOM.scrollTop += (direction === "up" ? -1 : 1) * view.defaultLineHeight;
  return true;
}

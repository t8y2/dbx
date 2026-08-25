import type { EditorState } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";

type SelectedCompletionIndex = (state: EditorState) => number | null;

export function acceptSelectedOrFirstCompletion(view: EditorView, acceptCompletion: Command | null, selectedCompletionIndex: SelectedCompletionIndex | null, selectFirstCompletion: Command | null): boolean {
  if (!acceptCompletion) return false;
  if (!selectedCompletionIndex || !selectFirstCompletion) return acceptCompletion(view);
  if (selectedCompletionIndex(view.state) !== null) return acceptCompletion(view);
  if (!selectFirstCompletion(view)) return false;
  return acceptCompletion(view);
}

import type { EditorView } from "@codemirror/view";

type CompletionSelectionMover = (forward: boolean) => (view: EditorView) => boolean;

export function queryEditorCompletionNavigationDirection(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing">): boolean | null {
  // IME composition keys must never drive editor shortcuts (repo convention:
  // composition-period keys are ignored everywhere else in the editor).
  if (event.isComposing) return null;
  if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === "n") return true;
  if (key === "p") return false;
  return null;
}

export function handleQueryEditorCompletionNavigation(view: EditorView, event: KeyboardEvent, moveCompletionSelection: CompletionSelectionMover | null | undefined): boolean {
  const direction = queryEditorCompletionNavigationDirection(event);
  if (direction === null || !moveCompletionSelection) return false;
  const handled = moveCompletionSelection(direction)(view);
  if (handled) event.preventDefault();
  return handled;
}

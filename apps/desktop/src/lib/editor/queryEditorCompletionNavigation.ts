import type { EditorView } from "@codemirror/view";
import { matchesShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import { DEFAULT_SHORTCUT_SETTINGS, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";

type CompletionSelectionMover = (forward: boolean) => (view: EditorView) => boolean;
type CompletionNavigationShortcuts = Pick<ShortcutSettings, "previousCompletion" | "nextCompletion">;

export function queryEditorCompletionNavigationDirection(event: ShortcutLikeEvent, shortcuts: CompletionNavigationShortcuts = DEFAULT_SHORTCUT_SETTINGS): boolean | null {
  // IME composition keys must never drive editor shortcuts (repo convention:
  // composition-period keys are ignored everywhere else in the editor).
  if (event.isComposing) return null;
  if (matchesShortcut(event, shortcuts.nextCompletion)) return true;
  if (matchesShortcut(event, shortcuts.previousCompletion)) return false;
  return null;
}

export function handleQueryEditorCompletionNavigation(view: EditorView, event: KeyboardEvent, moveCompletionSelection: CompletionSelectionMover | null | undefined, shortcuts?: CompletionNavigationShortcuts): boolean {
  const direction = queryEditorCompletionNavigationDirection(event, shortcuts);
  if (direction === null || !moveCompletionSelection) return false;
  const handled = moveCompletionSelection(direction)(view);
  if (handled) event.preventDefault();
  return handled;
}

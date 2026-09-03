import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { parseShortcutParts } from "@/lib/editor/shortcutDisplay";
import { enabledSqlShortcutActions } from "@/lib/sql/sqlShortcutActions";
import type { SqlShortcutAction } from "@/types/database";
// pi-lens-ignore: typescript:2307
import type { EditorView } from "@codemirror/view";

const LETTER_KEY_RE = /^[A-Za-z]$/;

export function isCharacterProducingShortcut(shortcut: string): boolean {
  const parts = parseShortcutParts(shortcut.trim());
  if (parts.length === 0) return false;
  const key = parts[parts.length - 1] ?? "";
  if (!LETTER_KEY_RE.test(key)) return false;
  const modifiers = new Set(parts.slice(0, -1));
  return !modifiers.has("Mod") && !modifiers.has("Meta") && !modifiers.has("Ctrl") && !modifiers.has("Alt");
}

export function createQueryEditorSqlShortcutDomHandler(getActions: () => readonly SqlShortcutAction[], runAction: (action: SqlShortcutAction, view: EditorView, event: KeyboardEvent) => boolean, platform = globalThis.navigator?.platform || ""): (event: KeyboardEvent, view: EditorView) => boolean {
  return (event, view) => {
    for (const action of enabledSqlShortcutActions(getActions())) {
      if (!isCharacterProducingShortcut(action.shortcut)) continue;
      if (!matchesShortcut(event, action.shortcut, platform)) continue;
      if (!runAction(action, view, event)) return false;
      event.preventDefault();
      return true;
    }
    return false;
  };
}

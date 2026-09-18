import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { parseShortcutParts } from "@/lib/editor/shortcutDisplay";
import { resolveSqlShortcutForDatabase, uniqueSqlShortcutBindings } from "@/lib/sql/sqlShortcutActions";
import type { DatabaseType, SqlShortcutAction } from "@/types/database";
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

export function createQueryEditorSqlShortcutDomHandler(
  getActions: () => readonly SqlShortcutAction[],
  runAction: (action: SqlShortcutAction, view: EditorView, event: KeyboardEvent) => boolean,
  getDatabaseType?: () => DatabaseType | undefined,
  platform = globalThis.navigator?.platform || "",
): (event: KeyboardEvent, view: EditorView) => boolean {
  return (event, view) => {
    const actions = getActions();
    for (const shortcut of uniqueSqlShortcutBindings(actions, platform)) {
      if (!isCharacterProducingShortcut(shortcut)) continue;
      if (!matchesShortcut(event, shortcut, platform)) continue;
      const action = resolveSqlShortcutForDatabase(actions, shortcut, getDatabaseType?.(), platform);
      if (!action) return false;
      if (!runAction(action, view, event)) return false;
      event.preventDefault();
      return true;
    }
    return false;
  };
}

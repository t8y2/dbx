import { canonicalShortcutKey } from "@/lib/editor/shortcutDisplay";
import { formatShortcut, SHORTCUT_DEFINITIONS, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";
import type { SqlShortcutAction } from "@/types/database";

export const SQL_SHORTCUT_TABLE_TOKEN = "${table}";

export function resolveSqlShortcutTemplate(template: string, selectedTable: string): string {
  return template.replace(/\$\{table\}/g, () => selectedTable.trim());
}

export function enabledSqlShortcutActions(actions: readonly SqlShortcutAction[]): SqlShortcutAction[] {
  return actions.filter((action) => action.enabled !== false && action.shortcut.trim().length > 0);
}

function shortcutsUseSameKeys(first: string, second: string, platform = globalThis.navigator?.platform || ""): boolean {
  if (!first || !second) return false;
  if (canonicalShortcutKey(first) === canonicalShortcutKey(second)) return true;
  return formatShortcut(first, platform).toLowerCase() === formatShortcut(second, platform).toLowerCase();
}

export function findSqlShortcutConflicts(actions: readonly SqlShortcutAction[], fixedShortcuts: ShortcutSettings, platform = globalThis.navigator?.platform || ""): string[] {
  const conflicts = new Set<string>();
  const editorFixedShortcuts = SHORTCUT_DEFINITIONS.filter((item) => item.scope === "editor" || item.scope === "global");

  for (const action of actions) {
    if (action.enabled === false || !action.shortcut.trim()) continue;

    const duplicate = actions.find((other) => other.id !== action.id && other.enabled !== false && other.shortcut.trim() && shortcutsUseSameKeys(other.shortcut, action.shortcut, platform));
    if (duplicate) {
      conflicts.add(action.id);
      conflicts.add(duplicate.id);
    }

    const fixedConflict = editorFixedShortcuts.find((item) => fixedShortcuts[item.id] && shortcutsUseSameKeys(fixedShortcuts[item.id], action.shortcut, platform));
    if (fixedConflict) conflicts.add(action.id);
  }

  return [...conflicts];
}

export function hasSqlShortcutConflicts(actions: readonly SqlShortcutAction[], fixedShortcuts: ShortcutSettings, platform = globalThis.navigator?.platform || ""): boolean {
  return findSqlShortcutConflicts(actions, fixedShortcuts, platform).length > 0;
}

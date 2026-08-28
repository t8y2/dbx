import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";
// pi-lens-ignore: typescript:2307
import type { KeyBinding } from "@codemirror/view";

interface QueryEditorSearchKeymapOptions {
  openSearch: () => boolean;
  openReplace: () => boolean;
  isReadOnly: () => boolean;
}

export function createQueryEditorSearchKeymap(options: QueryEditorSearchKeymapOptions): KeyBinding[] {
  return [
    {
      key: "Mod-f",
      preventDefault: true,
      run: options.openSearch,
    },
    {
      key: "Mod-h",
      preventDefault: true,
      // Consume the shortcut in previews without exposing mutation controls.
      run: () => options.isReadOnly() || options.openReplace(),
    },
  ];
}

export function createQueryEditorReplaceShortcutBindings(shortcut: string, openReplace: () => boolean): KeyBinding[] {
  const normalizedShortcut = shortcut.trim();
  return normalizedShortcut && /\s/.test(normalizedShortcut) ? [{ key: shortcutToCodeMirrorKey(normalizedShortcut), preventDefault: true, run: openReplace }] : [];
}

/**
 * Handle the configurable replace shortcut outside CodeMirror's character
 * keymap matching. CodeMirror intentionally lets `Mod-r` match a shifted
 * character event too, so a `Mod+R` replace binding can consume a custom
 * `Shift+Mod+R` editor action before its exact binding is considered.
 *
 * Multi-stroke shortcuts stay in the regular keymap because this handler only
 * handles one keyboard event at a time.
 */
export function createQueryEditorReplaceShortcutHandler(options: { shortcut: string; openReplace: () => boolean; isReadOnly: () => boolean }): (event: KeyboardEvent) => boolean {
  const shortcut = options.shortcut.trim();
  if (!shortcut || /\s/.test(shortcut)) return () => false;

  return (event) => {
    if (!matchesShortcut(event, shortcut)) return false;
    // Match the existing keymap's preventDefault behavior even when the
    // read-only guard prevents the panel from opening.
    if (options.isReadOnly()) return true;
    options.openReplace();
    return true;
  };
}

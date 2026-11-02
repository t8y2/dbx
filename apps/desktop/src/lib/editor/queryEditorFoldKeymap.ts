import type { Command, KeyBinding } from "@codemirror/view";
import { shortcutToCodeMirrorKey, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";

type FoldShortcuts = Pick<ShortcutSettings, "foldAll" | "unfoldAll">;

export function foldKeymapWithoutAllBindings(foldKeymap: readonly KeyBinding[], foldAll: Command, unfoldAll: Command): KeyBinding[] {
  return foldKeymap.filter((binding) => binding.run !== foldAll && binding.run !== unfoldAll);
}

export function createQueryEditorFoldShortcutBindings(shortcuts: FoldShortcuts, foldAll: Command, unfoldAll: Command): KeyBinding[] {
  return [...(shortcuts.foldAll ? [{ key: shortcutToCodeMirrorKey(shortcuts.foldAll), preventDefault: true, run: foldAll }] : []), ...(shortcuts.unfoldAll ? [{ key: shortcutToCodeMirrorKey(shortcuts.unfoldAll), preventDefault: true, run: unfoldAll }] : [])];
}

import type { Command, KeyBinding } from "@codemirror/view";
import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { parseShortcutStrokes } from "@/lib/editor/shortcutDisplay";
import { shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";

export function createQueryEditorSelectionCaseShortcutBindings(shortcut: string, run: Command, platform = globalThis.navigator?.platform || ""): KeyBinding[] {
  if (!shortcut) return [];

  // CodeMirror matches event.key, but macOS Option+letter produces a composed
  // character. Use the shared physical-key fallback for single-stroke bindings.
  if (parseShortcutStrokes(shortcut).length === 1) {
    return [
      {
        any(view, event) {
          if (!matchesShortcut(event, shortcut, platform)) return false;
          return run(view);
        },
      },
    ];
  }

  return [{ key: shortcutToCodeMirrorKey(shortcut), preventDefault: true, run }];
}

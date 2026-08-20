import type { Command, KeyBinding } from "@codemirror/view";
import { matchesShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import { isMacShortcutPlatform } from "@/lib/editor/shortcutDisplay";
import { shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";

function matchesMacOptionSlash(event: ShortcutLikeEvent, shortcut: string, platform: string): boolean {
  if (!isMacShortcutPlatform(platform) || shortcut !== "Alt+/" || event.isComposing) return false;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
  return event.code === "Slash";
}

export function createQueryEditorCompletionShortcutBindings(shortcut: string, run: Command, platform = globalThis.navigator?.platform || ""): KeyBinding[] {
  if (!shortcut) return [];
  if (!isMacShortcutPlatform(platform) || shortcut !== "Alt+/") {
    return [{ key: shortcutToCodeMirrorKey(shortcut), run }];
  }
  return [
    {
      any(view, event) {
        if (event.isComposing) return false;
        if (!matchesShortcut(event, shortcut, platform) && !matchesMacOptionSlash(event, shortcut, platform)) return false;
        return run(view);
      },
    },
  ];
}

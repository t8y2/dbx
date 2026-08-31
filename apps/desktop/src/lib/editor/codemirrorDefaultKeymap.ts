import type { KeyBinding } from "@codemirror/view";
import { normalizeShortcutSettings, SHORTCUT_DEFINITIONS, shortcutToCodeMirrorKey, type ShortcutSettings } from "@/lib/editor/shortcutRegistry";

const indentBracketKeys = new Set(["Mod-[", "Mod-]"]);
const globalShortcutDefinitions = SHORTCUT_DEFINITIONS.filter((definition) => definition.scope === "global");

export function defaultKeymapForGlobalShortcuts(defaultKeymap: readonly KeyBinding[], shortcuts?: Partial<ShortcutSettings>): KeyBinding[] {
  const normalizedShortcuts = normalizeShortcutSettings(shortcuts);
  const occupiedGlobalKeys = new Set(globalShortcutDefinitions.map((definition) => shortcutToCodeMirrorKey(normalizedShortcuts[definition.id])).filter(Boolean));

  return defaultKeymap.filter((binding) => !binding.key || !indentBracketKeys.has(binding.key) || !occupiedGlobalKeys.has(binding.key));
}

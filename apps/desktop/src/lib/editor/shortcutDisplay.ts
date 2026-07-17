export function isMacShortcutPlatform(platform = globalThis.navigator?.platform || ""): boolean {
  return platform.toLowerCase().includes("mac");
}

export function parseShortcutParts(shortcut?: string): string[] {
  if (!shortcut) return [];

  if (shortcut.endsWith("++")) {
    const prefix = shortcut.slice(0, -2);
    return [...prefix.split("+").filter(Boolean), "Plus"];
  }

  return shortcut.split("+").filter(Boolean);
}

export function parseShortcutStrokes(shortcut?: string): string[][] {
  if (!shortcut) return [];
  return shortcut.trim().split(/\s+/).filter(Boolean).map(parseShortcutParts);
}

function shortcutDisplayOrder(parts: string[], platform = globalThis.navigator?.platform || ""): string[] {
  if (parts.length <= 2 || isMacShortcutPlatform(platform)) return parts;

  const key = parts[parts.length - 1];
  const modifierOrder = new Map([
    ["Mod", 0],
    ["Ctrl", 0],
    ["Control", 0],
    ["Meta", 0],
    ["Cmd", 0],
    ["Shift", 1],
    ["Alt", 2],
  ]);
  const modifiers = parts.slice(0, -1);
  if (!modifiers.some((part) => modifierOrder.get(part) === 0)) return parts;

  return [
    ...[...modifiers].sort((a, b) => {
      const rankA = modifierOrder.get(a) ?? 99;
      const rankB = modifierOrder.get(b) ?? 99;
      return rankA - rankB;
    }),
    key,
  ];
}

export function shortcutDisplayParts(shortcut?: string, platform = globalThis.navigator?.platform || ""): string[] {
  return shortcutDisplayOrder(parseShortcutParts(shortcut), platform);
}

export function shortcutDisplayStrokes(shortcut?: string, platform = globalThis.navigator?.platform || ""): string[][] {
  return parseShortcutStrokes(shortcut).map((parts) => shortcutDisplayOrder(parts, platform));
}

export function shortcutKeyLabel(part: string, platform = globalThis.navigator?.platform || ""): string {
  const isMac = isMacShortcutPlatform(platform);
  if (part === "Mod") return isMac ? "⌘" : "Ctrl";
  if (part === "Cmd") return isMac ? "⌘" : "Cmd";
  if (part === "Meta") return isMac ? "⌘" : "Meta";
  if (part === "Alt") return isMac ? "⌥" : "Alt";
  if (part === "Shift") return isMac ? "⇧" : "Shift";
  if (part === "Control" || part === "Ctrl") return isMac ? "⌃" : "Ctrl";
  if (part === "Delete") return isMac ? "⌦" : "Del";
  if (part === "Backspace") return "⌫";
  if (part === "Enter") return "↵";
  if (part === "Escape") return "Esc";
  if (part === "ArrowUp") return "↑";
  if (part === "ArrowDown") return "↓";
  if (part === "ArrowLeft") return "←";
  if (part === "ArrowRight") return "→";
  if (part === " ") return "Space";
  if (part === "Plus") return "+";
  return part.length === 1 ? part.toUpperCase() : part;
}

export function shortcutDisplayKeys(shortcut?: string, platform = globalThis.navigator?.platform || ""): string[] {
  return shortcutDisplayStrokes(shortcut, platform)
    .flat()
    .map((part) => shortcutKeyLabel(part, platform));
}

export function formatShortcutDisplay(shortcut: string, platform = globalThis.navigator?.platform || ""): string {
  if (!shortcut) return "—";
  const keySeparator = isMacShortcutPlatform(platform) ? " " : " + ";
  return shortcutDisplayStrokes(shortcut, platform)
    .map((parts) => parts.map((part) => shortcutKeyLabel(part, platform)).join(keySeparator))
    .join(", ");
}

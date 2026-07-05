export function isMacShortcutPlatform(platform = globalThis.navigator?.platform || ""): boolean {
  return platform.toLowerCase().includes("mac");
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
  return part.length === 1 ? part.toUpperCase() : part;
}

export function shortcutDisplayKeys(shortcut?: string, platform = globalThis.navigator?.platform || ""): string[] {
  return (
    shortcut
      ?.split("+")
      .filter(Boolean)
      .map((part) => shortcutKeyLabel(part, platform)) || []
  );
}

export function formatShortcutDisplay(shortcut: string, platform = globalThis.navigator?.platform || ""): string {
  if (!shortcut) return "—";
  return shortcutDisplayKeys(shortcut, platform).join(isMacShortcutPlatform(platform) ? " " : " + ");
}

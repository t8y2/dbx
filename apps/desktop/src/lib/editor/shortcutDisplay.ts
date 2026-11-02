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

export function canonicalShortcutKey(shortcut: string): string {
  return shortcutDisplayParts(shortcut, "Win32")
    .map((part) => {
      if (part === "Mod") return "Ctrl";
      if (part === "Plus") return "+";
      return part;
    })
    .join("+")
    .toLowerCase();
}

/**
 * #11632: 组合键搜索用的归一化形式——抹掉全部空白（`\s` 已含全角空格）并把全角
 * ＋ 折成半角，使 `Ctrl+T` / `Ctrl + T` / `⌘T` / `⌘ T` 归一到同一串。只作用于
 * 组合键字段：功能名等多词文本必须保留空格，否则 "new query" 会因去空白而失配。
 *
 * 不复用 canonicalShortcutKey：它按 Win32 语义把 Mod 展开成 Ctrl（macOS 的 ⌘ 会
 * 被误判），而且 parseShortcutParts 不 trim，`"Ctrl + T"` 会原样留下内部空格。
 */
export function normalizeShortcutSearch(value: string): string {
  // 全角 Ａ-Ｚ / ａ-ｚ / ＋ 等（码点 U+FF01–U+FF5E，与 ASCII 相差 0xFEE0）一并折成
  // 半角：中文输入法全角状态下打出的 ｃｔｒｌ＋ｔ 也要能命中。该折叠已覆盖独立
  // 处理全角 ＋ 的做法；全角空格由下面的 \s 处理（\s 含 U+3000）。
  return value
    .replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/\s+/g, "");
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

export function formatShortcutTooltip(label: string, shortcut?: string, platform = globalThis.navigator?.platform || ""): string {
  if (!shortcut?.trim()) return label;
  const display = formatShortcutDisplay(shortcut, platform);
  return display && display !== "—" ? `${label} (${display})` : label;
}

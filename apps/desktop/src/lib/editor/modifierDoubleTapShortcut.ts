import { isMacShortcutPlatform } from "@/lib/editor/shortcutDisplay";

const modifiers = new Set(["Shift", "Alt", "Mod", "Ctrl", "Meta"]);

export function isModifierDoubleTapShortcut(shortcut: string): boolean {
  const parts = shortcut.split(" ");
  return parts.length === 2 && parts[0] === parts[1] && modifiers.has(parts[0]!);
}

export function matchesModifierDoubleTapShortcut(first: string, second: string, platform = globalThis.navigator?.platform || ""): boolean {
  if (!isModifierDoubleTapShortcut(first) || !isModifierDoubleTapShortcut(second)) return false;
  const physicalModifier = (shortcut: string) => {
    const modifier = shortcut.split(" ")[0];
    return modifier === "Mod" ? (isMacShortcutPlatform(platform) ? "Meta" : "Ctrl") : modifier;
  };
  return physicalModifier(first) === physicalModifier(second);
}

function modifierName(key: string, platform: string): string | null {
  if (key === "Shift" || key === "Alt") return key;
  if (key === "Meta") return isMacShortcutPlatform(platform) ? "Mod" : "Meta";
  if (key === "Control") return isMacShortcutPlatform(platform) ? "Ctrl" : "Mod";
  return null;
}

/** Two complete, isolated taps of the same modifier. Normal key input is untouched. */
export function createModifierDoubleTapShortcutController(platform = globalThis.navigator?.platform || "") {
  const intervalMs = 400;
  let pressedAt: number | null = null;
  let pressedCode: string | null = null;
  let pressedModifier: string | null = null;
  let firstTapAt: number | null = null;
  let firstTapModifier: string | null = null;
  const heldKeys = new Set<string>();
  const metaChordKeys = new Set<string>();

  function cancel() {
    pressedAt = null;
    pressedCode = null;
    pressedModifier = null;
    firstTapAt = null;
    firstTapModifier = null;
  }

  function reset() {
    cancel();
    heldKeys.clear();
    metaChordKeys.clear();
  }

  function handleKeydown(event: KeyboardEvent) {
    const code = event.code || event.key;
    const alreadyHeld = heldKeys.has(code);
    heldKeys.add(code);
    const modifier = modifierName(event.key, platform);
    if (isMacShortcutPlatform(platform) && event.metaKey && !modifier) metaChordKeys.add(code);
    const otherModifier = (event.shiftKey && event.key !== "Shift") || (event.altKey && event.key !== "Alt") || (event.ctrlKey && event.key !== "Control") || (event.metaKey && event.key !== "Meta");
    if (!modifier || alreadyHeld || heldKeys.size !== 1 || event.repeat || event.isComposing || otherModifier) {
      cancel();
      return;
    }
    if (firstTapAt !== null && (event.timeStamp - firstTapAt > intervalMs || modifier !== firstTapModifier)) cancel();
    pressedAt = event.timeStamp;
    pressedCode = code;
    pressedModifier = modifier;
  }

  function handleKeyup(event: KeyboardEvent): string | null {
    const code = event.code || event.key;
    const wasHeld = heldKeys.delete(code);
    metaChordKeys.delete(code);
    // macOS may omit keyup for character keys pressed during a Cmd chord.
    // The chord is not a tap, and must not leave future taps permanently blocked.
    if (isMacShortcutPlatform(platform) && event.key === "Meta" && !event.metaKey && metaChordKeys.size) {
      for (const key of metaChordKeys) heldKeys.delete(key);
      metaChordKeys.clear();
      cancel();
      return null;
    }
    if (!wasHeld || heldKeys.size || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || pressedAt === null || code !== pressedCode || event.timeStamp - pressedAt > intervalMs) {
      cancel();
      return null;
    }
    const modifier = pressedModifier!;
    const completed = firstTapModifier === modifier && firstTapAt !== null && event.timeStamp - firstTapAt <= intervalMs;
    const tapStartedAt = pressedAt;
    cancel();
    if (!completed) {
      firstTapAt = tapStartedAt;
      firstTapModifier = modifier;
    }
    return completed ? `${modifier} ${modifier}` : null;
  }

  return { handleKeydown, handleKeyup, cancel, reset };
}

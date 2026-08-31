import { tabSwitcherDirectionFromShortcut, type ShortcutLikeEvent } from "@/lib/editor/keyboardShortcuts";
import { isMacShortcutPlatform, parseShortcutParts } from "@/lib/editor/shortcutDisplay";

export type TabSwitcherKeyboardAction = { type: "move"; direction: -1 | 1 } | { type: "commit" } | { type: "cancel" };

export interface TabSwitcherKeyboardControllerOptions {
  isOpen: () => boolean;
  shortcut: () => string;
  move: (direction: -1 | 1) => void;
  commit: () => void;
  cancel: () => void;
}

function normalizeReleaseKey(key: string): string {
  if (key === "Ctrl" || key === "Control") return "Control";
  if (key === "Cmd" || key === "Meta") return "Meta";
  if (key === "Space") return " ";
  if (key === "Plus") return "+";
  return key.length === 1 ? key.toLowerCase() : key;
}

export function tabSwitcherReleaseKeys(shortcut: string, event: ShortcutLikeEvent, platform = globalThis.navigator?.platform || ""): ReadonlySet<string> {
  const parts = parseShortcutParts(shortcut);
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));
  const releaseKeys = new Set<string>();

  if (modifiers.has("Mod")) {
    if (isMacShortcutPlatform(platform)) {
      releaseKeys.add("Meta");
    } else {
      if (event.ctrlKey) releaseKeys.add("Control");
      if (event.metaKey) releaseKeys.add("Meta");
    }
  }
  if (modifiers.has("Ctrl") || modifiers.has("Control")) releaseKeys.add("Control");
  if (modifiers.has("Meta") || modifiers.has("Cmd")) releaseKeys.add("Meta");
  if (modifiers.has("Alt")) releaseKeys.add("Alt");
  if (modifiers.has("Shift")) releaseKeys.add("Shift");

  if (!releaseKeys.size && key) releaseKeys.add(normalizeReleaseKey(key));
  return releaseKeys;
}

export function tabSwitcherKeydownAction(event: ShortcutLikeEvent, shortcut: string, platform = globalThis.navigator?.platform || ""): TabSwitcherKeyboardAction | null {
  const direction = tabSwitcherDirectionFromShortcut(event, { tabSwitcher: shortcut }, platform);
  if (direction) return { type: "move", direction };
  if (event.key === "ArrowDown") return { type: "move", direction: 1 };
  if (event.key === "ArrowUp") return { type: "move", direction: -1 };
  if (event.key === "Enter") return { type: "commit" };
  if (event.key === "Escape") return { type: "cancel" };
  return null;
}

export function captureTabSwitcherKeydown(event: KeyboardEvent, shortcut: string, onAction: (action: TabSwitcherKeyboardAction) => void, platform = globalThis.navigator?.platform || ""): boolean {
  const action = tabSwitcherKeydownAction(event, shortcut, platform);
  if (!action) return false;
  event.preventDefault();
  event.stopPropagation();
  onAction(action);
  return true;
}

export function createTabSwitcherKeyboardController(options: TabSwitcherKeyboardControllerOptions, platform = globalThis.navigator?.platform || "") {
  let releaseKeys: ReadonlySet<string> = new Set();

  function reset() {
    releaseKeys = new Set();
  }

  function rememberOpeningEvent(event: ShortcutLikeEvent) {
    releaseKeys = tabSwitcherReleaseKeys(options.shortcut(), event, platform);
  }

  function handleKeydownCapture(event: KeyboardEvent): boolean {
    if (!options.isOpen()) return false;
    return captureTabSwitcherKeydown(
      event,
      options.shortcut(),
      (action) => {
        if (action.type === "move") {
          options.move(action.direction);
        } else if (action.type === "commit") {
          reset();
          options.commit();
        } else {
          reset();
          options.cancel();
        }
      },
      platform,
    );
  }

  function handleKeyup(event: KeyboardEvent): boolean {
    if (!options.isOpen() || !releaseKeys.has(normalizeReleaseKey(event.key))) return false;
    reset();
    options.commit();
    return true;
  }

  function cancelForDeactivation(): boolean {
    if (!options.isOpen()) {
      reset();
      return false;
    }
    reset();
    options.cancel();
    return true;
  }

  function handleVisibilityChange(visibilityState: DocumentVisibilityState): boolean {
    return visibilityState === "visible" ? false : cancelForDeactivation();
  }

  return {
    reset,
    rememberOpeningEvent,
    handleKeydownCapture,
    handleKeyup,
    handleWindowBlur: cancelForDeactivation,
    handleVisibilityChange,
  };
}

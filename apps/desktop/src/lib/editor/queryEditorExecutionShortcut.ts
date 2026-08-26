import type { Command, EditorView, KeyBinding } from "@codemirror/view";
import { shortcutToCodeMirrorKey } from "@/lib/editor/shortcutRegistry";

const SAFARI_POST_COMPOSITION_KEY_WINDOW_MS = 100;

type BrowserNavigator = Pick<Navigator, "maxTouchPoints" | "userAgent" | "vendor">;

function isDesktopSafari(currentNavigator: BrowserNavigator | undefined): boolean {
  if (!currentNavigator) return false;
  return /Apple Computer/.test(currentNavigator.vendor) && !/Mobile\/\w+/.test(currentNavigator.userAgent) && currentNavigator.maxTouchPoints <= 2;
}

export function createQueryEditorPostCompositionKeyGuard(options: { navigator?: BrowserNavigator; now?: () => number } = {}) {
  const currentNavigator = options.navigator ?? (typeof navigator === "undefined" ? undefined : navigator);
  const now = options.now ?? Date.now;
  const desktopSafari = isDesktopSafari(currentNavigator);
  const blockedEvents = new WeakSet<KeyboardEvent>();
  let compositionEndedAt = 0;
  let compositionPendingKey = false;

  function handleCompositionStart() {
    compositionPendingKey = false;
  }

  function handleCompositionEnd() {
    compositionPendingKey = desktopSafari;
    compositionEndedAt = desktopSafari ? now() : 0;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!compositionPendingKey) return;
    compositionPendingKey = false;
    if (now() - compositionEndedAt < SAFARI_POST_COMPOSITION_KEY_WINDOW_MS) blockedEvents.add(event);
  }

  return {
    attach(element: HTMLElement) {
      element.addEventListener("compositionstart", handleCompositionStart, true);
      element.addEventListener("compositionend", handleCompositionEnd, true);
      element.addEventListener("keydown", handleKeydown, true);
      return () => {
        element.removeEventListener("compositionstart", handleCompositionStart, true);
        element.removeEventListener("compositionend", handleCompositionEnd, true);
        element.removeEventListener("keydown", handleKeydown, true);
        compositionPendingKey = false;
      };
    },
    blocks(event: KeyboardEvent) {
      return blockedEvents.has(event);
    },
  };
}

/**
 * Create a query-editor execution binding that consumes the shortcut while an
 * IME composition is active, without invoking the execution callback.
 *
 * CodeMirror may ignore keydown events after a composition has changed the
 * document, so the app-level shortcut fallback also checks the editor state.
 * This guard covers the keymap path when CodeMirror still dispatches it.
 */
export function createQueryEditorExecutionShortcutBindings(shortcut: string, run: Command, isComposing: (view: EditorView) => boolean): KeyBinding[] {
  if (!shortcut) return [];
  return [
    {
      key: shortcutToCodeMirrorKey(shortcut),
      preventDefault: true,
      run(view) {
        if (isComposing(view)) return true;
        return run(view);
      },
    },
  ];
}

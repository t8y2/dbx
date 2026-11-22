import { matchesShortcut } from "@/lib/editor/keyboardShortcuts";
import { parseShortcutStrokes } from "@/lib/editor/shortcutDisplay";
import type { ShortcutSettings } from "@/lib/editor/shortcutRegistry";

type CaseShortcuts = Pick<ShortcutSettings, "uppercaseSelection" | "lowercaseSelection" | "toggleCaseSelection">;

export function handleTextInputCaseShortcut(event: KeyboardEvent, shortcuts: CaseShortcuts): boolean {
  if (event.defaultPrevented || event.isComposing || event.key === "Process" || event.keyCode === 229) return false;
  const input = event.target;
  if (!(input instanceof HTMLTextAreaElement || (input instanceof HTMLInputElement && input.type === "text"))) return false;
  if (input.disabled || input.readOnly || input.ownerDocument.activeElement !== input) return false;
  const { selectionStart, selectionEnd, selectionDirection } = input;
  if (selectionStart === null || selectionEnd === null || selectionStart >= selectionEnd) return false;

  // Chords are handled by CodeMirror. A native field only receives one stroke at a time.
  const matches = (shortcut: string) => parseShortcutStrokes(shortcut).length === 1 && matchesShortcut(event, shortcut);
  const selected = input.value.slice(selectionStart, selectionEnd);
  let replacement: string;
  if (matches(shortcuts.uppercaseSelection)) replacement = selected.toUpperCase();
  else if (matches(shortcuts.lowercaseSelection)) replacement = selected.toLowerCase();
  else if (matches(shortcuts.toggleCaseSelection)) {
    const uppercase = selected.toUpperCase();
    replacement = uppercase === selected ? selected.toLowerCase() : uppercase;
  } else return false;

  if (replacement !== selected) {
    // The browser emits input and preserves its native undo history.
    if (!input.ownerDocument.execCommand("insertText", false, replacement)) return false;
    input.setSelectionRange(selectionStart, selectionStart + replacement.length, selectionDirection ?? undefined);
  }
  event.preventDefault();
  event.stopPropagation();
  return true;
}

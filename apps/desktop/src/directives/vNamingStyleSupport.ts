import type { Directive } from "vue";
import { isConvertNamingStyleShortcut } from "@/lib/editor/keyboardShortcuts";
import { convertToNextNamingStyle } from "@/lib/naming/namingStyleConverter";
import { useSettingsStore } from "@/stores/settingsStore";

function handleKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;

  // Match against the user-configured shortcut so settings changes apply
  // immediately; matchesShortcut uses the physical-key (event.code) fallback
  // so macOS Option+letter composed keys (⌥⇧C → "Ç") still match, and its
  // strict modifier check rejects combos with extra Ctrl/Meta held.
  const shortcuts = useSettingsStore().editorSettings.shortcuts;
  if (!isConvertNamingStyleShortcut(event, shortcuts)) return;

  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  const value = target.value;
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const source = start === end ? value : value.slice(start, end);
  const result = convertToNextNamingStyle(source);

  // No identifier-like content to convert: leave the keystroke to the
  // browser instead of swallowing it.
  if (result.text === source) return;

  event.preventDefault();
  event.stopPropagation();

  if (start === end) {
    // No selection - convert entire content
    target.value = result.text;
    target.setSelectionRange(0, result.text.length);
  } else {
    // Convert selected text
    target.value = value.slice(0, start) + result.text + value.slice(end);
    target.setSelectionRange(start + result.text.length, start + result.text.length);
  }

  // Trigger input event so v-model updates
  target.dispatchEvent(new Event("input", { bubbles: true }));
}

export const vNamingStyleSupport: Directive<HTMLInputElement | HTMLTextAreaElement> = {
  mounted(el) {
    el.addEventListener("keydown", handleKeydown as EventListener);
  },
  unmounted(el) {
    el.removeEventListener("keydown", handleKeydown as EventListener);
  },
};

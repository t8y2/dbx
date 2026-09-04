import type { Directive } from "vue";
import { convertToNextNamingStyle } from "@/lib/naming/namingStyleConverter";

function handleKeydown(event: KeyboardEvent): void {
  // Check for Shift+Alt+C
  if (!event.shiftKey || !event.altKey || event.key.toLowerCase() !== "c") {
    return;
  }

  const target = event.target as HTMLInputElement | HTMLTextAreaElement;

  // Prevent default behavior
  event.preventDefault();
  event.stopPropagation();

  const value = target.value;
  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;

  if (start === end) {
    // No selection - convert entire content
    const result = convertToNextNamingStyle(value);
    target.value = result.text;
    target.setSelectionRange(0, result.text.length);
  } else {
    // Convert selected text
    const selectedText = value.slice(start, end);
    const result = convertToNextNamingStyle(selectedText);

    const newValue = value.slice(0, start) + result.text + value.slice(end);
    target.value = newValue;
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

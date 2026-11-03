import type { Directive } from "vue";
import { isLowercaseShortcut, isToggleCaseShortcut, isUppercaseShortcut } from "@/lib/editor/keyboardShortcuts";
import { convertSqlSelectionCase, type SqlSelectionCaseMode } from "@/lib/sql/sqlSelectionCase";
import { useSettingsStore } from "@/stores/settingsStore";

export function applySelectionCaseToInput(target: HTMLInputElement | HTMLTextAreaElement, mode: SqlSelectionCaseMode, dialectId?: "mysql" | "postgres" | "sqlserver"): boolean {
  if (target.readOnly || target.disabled) return false;

  const value = target.value;
  if (!value) return false;

  const start = target.selectionStart ?? 0;
  const end = target.selectionEnd ?? 0;
  const hasSelection = start !== end;

  const range = hasSelection ? { from: start, to: end } : { from: 0, to: value.length };
  const sourceText = value.slice(range.from, range.to);
  const convertedText = convertSqlSelectionCase(value, range, mode, dialectId);

  // If no change (e.g. non-cased text or already in target case), do not touch input or dispatch events
  if (convertedText === sourceText) return false;

  const direction = target.selectionDirection ?? "none";

  if (hasSelection) {
    target.value = value.slice(0, start) + convertedText + value.slice(end);
    target.setSelectionRange(start, start + convertedText.length, direction);
  } else {
    target.value = convertedText;
    const newCursor = Math.min(start, convertedText.length);
    target.setSelectionRange(newCursor, newCursor, direction);
  }

  target.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
}

function resolveInputElement(el: HTMLElement): HTMLInputElement | HTMLTextAreaElement | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el;
  return el.querySelector<HTMLInputElement | HTMLTextAreaElement>("input, textarea");
}

function handleKeydown(event: KeyboardEvent): void {
  if (event.isComposing) return;

  const target = event.target;
  if (!target || !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;

  const shortcuts = useSettingsStore().editorSettings.shortcuts;

  let mode: SqlSelectionCaseMode | null = null;
  if (isToggleCaseShortcut(event, shortcuts)) {
    mode = "toggle";
  } else if (isUppercaseShortcut(event, shortcuts)) {
    mode = "upper";
  } else if (isLowercaseShortcut(event, shortcuts)) {
    mode = "lower";
  }

  if (!mode) return;

  if (applySelectionCaseToInput(target, mode)) {
    event.preventDefault();
    event.stopPropagation();
  }
}

const listeners = new WeakMap<HTMLElement, EventListener>();

export const vSelectionCaseSupport: Directive<HTMLElement> = {
  mounted(el) {
    const input = resolveInputElement(el);
    if (!input) return;
    const listener = handleKeydown as EventListener;
    listeners.set(el, listener);
    input.addEventListener("keydown", listener);
  },
  unmounted(el) {
    const input = resolveInputElement(el);
    const listener = listeners.get(el);
    if (input && listener) {
      input.removeEventListener("keydown", listener);
    }
    listeners.delete(el);
  },
};

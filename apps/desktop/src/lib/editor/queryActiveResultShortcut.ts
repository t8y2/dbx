import { isCopyActiveResultShortcut } from "@/lib/editor/keyboardShortcuts";
import { isShortcutEditingTarget } from "@/lib/editor/shortcutRecorder";
import type { ShortcutSettings } from "@/lib/editor/shortcutRegistry";

interface CopyActiveResultShortcutContext {
  /** Only the visible SQL query workspace owns this command. */
  enabled: boolean;
  shortcuts?: Partial<ShortcutSettings>;
  platform?: string;
  copyActiveResult: () => boolean;
}

export function dispatchCopyActiveResultShortcut(event: KeyboardEvent, context: CopyActiveResultShortcutContext): boolean {
  if (event.defaultPrevented || !context.enabled || !isCopyActiveResultShortcut(event, context.shortcuts, context.platform)) return false;
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (isShortcutEditingTarget(target) || target?.closest('[role="dialog"], [role="alertdialog"], input, textarea, select')) return false;
  // SQL editor content is the intended source of this command. Search fields,
  // cell editors and other text controls must retain their native shortcuts.
  if (target?.closest('[contenteditable="true"], [contenteditable=""], [role="textbox"]') && !target.closest("[data-query-editor-root] .cm-content")) return false;
  // Consume even an empty-result request: a binding such as Mod+C must never
  // fall back to copying SQL text when there is no result to copy.
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) context.copyActiveResult();
  return true;
}

export function registerCopyActiveResultShortcut(getContext: () => CopyActiveResultShortcutContext): () => void {
  const listener = (event: KeyboardEvent) => {
    dispatchCopyActiveResultShortcut(event, getContext());
  };
  // Configured commands take precedence over CodeMirror bindings such as Mod-i.
  window.addEventListener("keydown", listener, true);
  return () => window.removeEventListener("keydown", listener, true);
}

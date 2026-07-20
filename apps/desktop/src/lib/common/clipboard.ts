import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

interface ClipboardApi {
  readText?: () => Promise<string> | string;
  writeText?: (text: string) => Promise<void> | void;
}

interface ClipboardNavigator {
  clipboard?: ClipboardApi;
}

interface ClipboardTextarea {
  value: string;
  style: {
    position?: string;
    top?: string;
    left?: string;
    opacity?: string;
  };
  setAttribute(name: string, value: string): void;
  focus?(): void;
  select(): void;
  setSelectionRange?(start: number, end: number): void;
}

interface ClipboardDocument {
  body?: {
    appendChild(node: unknown): unknown;
    removeChild(node: unknown): unknown;
  };
  createElement(tagName: "textarea"): ClipboardTextarea;
  execCommand?(command: string): boolean;
}

export interface ClipboardEnvironment {
  navigator?: ClipboardNavigator;
  document?: ClipboardDocument;
}

export interface ClipboardShortcutEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  target?: EventTarget | null;
}

interface SelectionLike {
  anchorNode: Node | null;
  focusNode: Node | null;
  isCollapsed: boolean;
}

interface NativeClipboardSelectionEnvironment {
  getSelection?: () => SelectionLike | null;
}

const EDITABLE_CLIPBOARD_TARGET_SELECTOR = "input, textarea, [contenteditable='true'], [role='textbox']";
const NATIVE_CLIPBOARD_REGION_SELECTOR = "[data-native-clipboard]";

function closestElement(target: unknown, selector: string): unknown {
  return (target as { closest?: (selector: string) => unknown } | null)?.closest?.(selector) ?? null;
}

export function eventTargetUsesNativeClipboard(event: Pick<ClipboardShortcutEvent, "target">): boolean {
  return !!closestElement(event.target, EDITABLE_CLIPBOARD_TARGET_SELECTOR);
}

function selectionNodeElement(node: Node | null): Element | null {
  if (!node) return null;
  if (typeof Element !== "undefined" && node instanceof Element) return node;
  return (node as { parentElement?: Element | null }).parentElement ?? null;
}

export function isPlainClipboardShortcut(event: ClipboardShortcutEvent, key: string): boolean {
  return !!(event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === key;
}

export function hasNativeClipboardSelection(env: NativeClipboardSelectionEnvironment = globalThis as unknown as NativeClipboardSelectionEnvironment): boolean {
  const selection = env.getSelection?.();
  if (!selection || selection.isCollapsed) return false;
  const anchorRegion = selectionNodeElement(selection.anchorNode)?.closest(NATIVE_CLIPBOARD_REGION_SELECTOR);
  const focusRegion = selectionNodeElement(selection.focusNode)?.closest(NATIVE_CLIPBOARD_REGION_SELECTOR);
  return !!anchorRegion && anchorRegion === focusRegion;
}

export function eventTargetAllowsNativeClipboard(event: ClipboardShortcutEvent, env: NativeClipboardSelectionEnvironment = globalThis as unknown as NativeClipboardSelectionEnvironment): boolean {
  if (eventTargetUsesNativeClipboard(event)) return true;
  return isPlainClipboardShortcut(event, "c") && hasNativeClipboardSelection(env);
}

export function eventTargetAllowsAppClipboardShortcut(event: ClipboardShortcutEvent, key = "v"): boolean {
  if (!isPlainClipboardShortcut(event, key)) return false;
  return !eventTargetUsesNativeClipboard(event);
}

export async function readTextFromClipboard(env: ClipboardEnvironment = globalThis as unknown as ClipboardEnvironment): Promise<string> {
  if (isTauriRuntime(env as unknown as Record<string, unknown>)) {
    try {
      const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
      return await readText();
    } catch {
      // Fall through to Web Clipboard when the native plugin is unavailable.
    }
  }

  if (env.navigator?.clipboard?.readText) {
    return await env.navigator.clipboard.readText();
  }

  throw new Error("Clipboard API is not available");
}

export async function copyToClipboard(text: string, env: ClipboardEnvironment = globalThis as unknown as ClipboardEnvironment): Promise<void> {
  if (isTauriRuntime(env as unknown as Record<string, unknown>)) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      return;
    } catch {
      // Preserve Web Clipboard and legacy copy compatibility when native writes fail.
    }
  }

  try {
    if (env.navigator?.clipboard?.writeText) {
      await env.navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // Fall through to the legacy copy path for non-secure web contexts.
  }

  const document = env.document;
  if (!document?.body || !document.execCommand) {
    throw new Error("Clipboard API is not available");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  document.body.appendChild(textarea);
  try {
    textarea.focus?.();
    textarea.select();
    textarea.setSelectionRange?.(0, text.length);
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed");
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

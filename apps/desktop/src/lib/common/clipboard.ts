import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { getPlatform, type Platform } from "@/lib/backend/platform";

interface ClipboardApi {
  readText?: () => Promise<string> | string;
  writeText?: (text: string) => Promise<void> | void;
  write?: (items: readonly unknown[]) => Promise<void> | void;
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

interface ClipboardContainer {
  appendChild(node: unknown): unknown;
  removeChild(node: unknown): unknown;
}

interface ClipboardDocument {
  body?: ClipboardContainer;
  activeElement?: {
    closest?(selector: string): ClipboardContainer | null;
  };
  createElement(tagName: "textarea"): ClipboardTextarea;
  execCommand?(command: string): boolean;
}

/** Structural stand-ins for the DOM constructors used by the rich-text path. */
type ClipboardItemConstructor = new (items: Record<string, unknown>) => unknown;
type ClipboardBlobConstructor = new (parts: readonly string[], options?: { type?: string }) => unknown;

export interface ClipboardEnvironment {
  navigator?: ClipboardNavigator;
  document?: ClipboardDocument;
  /** Injected for tests; resolves from `globalThis` in the app. */
  ClipboardItem?: ClipboardItemConstructor;
  /** Injected for tests; resolves from `globalThis` in the app. */
  Blob?: ClipboardBlobConstructor;
}

/**
 * Rewrites the line endings of text destined for the system clipboard.
 *
 * Windows native edit controls (the Win32 EDIT control, and applications built
 * on it such as PowerBuilder) only treat CRLF as a line break, so text copied
 * with bare LF arrives as a single line. Other platforms keep LF.
 *
 * Existing CRLF pairs are matched before bare CR and LF so that already
 * normalized text is left byte-identical.
 */
export function clipboardLineEndings(text: string, platform: Platform = getPlatform()): string {
  if (platform !== "windows") return text;
  return text.replace(/\r\n|\r|\n/g, "\r\n");
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
const DATA_GRID_ROOT_SELECTOR = "[data-grid-root]";
let clipboardWriteRevision = 0;

export function getClipboardWriteRevision(): number {
  return clipboardWriteRevision;
}

function recordClipboardWrite(): void {
  clipboardWriteRevision += 1;
}

function legacyClipboardContainer(document: ClipboardDocument): ClipboardContainer | undefined {
  return document.activeElement?.closest?.("[role='dialog']") ?? document.body;
}

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

export function shouldBlockAppNativeSelectAll(event: ClipboardShortcutEvent): boolean {
  return isPlainClipboardShortcut(event, "a") && !eventTargetUsesNativeClipboard(event) && !closestElement(event.target, DATA_GRID_ROOT_SELECTOR);
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
  text = clipboardLineEndings(text);

  if (isTauriRuntime(env as unknown as Record<string, unknown>)) {
    try {
      const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeText(text);
      recordClipboardWrite();
      return;
    } catch {
      // Preserve Web Clipboard and legacy copy compatibility when native writes fail.
    }
  }

  try {
    if (env.navigator?.clipboard?.writeText) {
      await env.navigator.clipboard.writeText(text);
      recordClipboardWrite();
      return;
    }
  } catch {
    // Fall through to the legacy copy path for non-secure web contexts.
  }

  const document = env.document;
  const container = document ? legacyClipboardContainer(document) : undefined;
  if (!document || !container || !document.execCommand) {
    throw new Error("Clipboard API is not available");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";

  container.appendChild(textarea);
  try {
    textarea.focus?.();
    textarea.select();
    textarea.setSelectionRange?.(0, text.length);
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed");
    }
    recordClipboardWrite();
  } finally {
    container.removeChild(textarea);
  }
}

/**
 * Write both an HTML flavor and a plain-text flavor to the system clipboard.
 *
 * Rich-text targets (email clients, Word, chat apps) pick up `text/html` and
 * keep the formatting, while plain-text targets fall back to `text` — so the
 * same copy works everywhere.
 *
 * Order of attempts:
 * 1. Tauri `clipboard-manager` `writeHtml`, whose `altText` argument is the
 *    plain-text flavor.
 * 2. Web `navigator.clipboard.write` with a two-flavor `ClipboardItem`.
 * 3. Plain text via {@link copyToClipboard}. Rich writes need a secure
 *    context, and a non-secure web deployment should still copy something
 *    rather than fail.
 */
export async function copyRichTextToClipboard(html: string, text: string, env: ClipboardEnvironment = globalThis as unknown as ClipboardEnvironment): Promise<void> {
  text = clipboardLineEndings(text);
  if (isTauriRuntime(env as unknown as Record<string, unknown>)) {
    try {
      const { writeHtml } = await import("@tauri-apps/plugin-clipboard-manager");
      await writeHtml(html, text);
      recordClipboardWrite();
      return;
    } catch {
      // Fall through to the Web Clipboard rich-text path.
    }
  }

  try {
    const ClipboardItem = env.ClipboardItem;
    const Blob = env.Blob;
    if (env.navigator?.clipboard?.write && typeof ClipboardItem === "function" && typeof Blob === "function") {
      await env.navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
      recordClipboardWrite();
      return;
    }
  } catch {
    // Fall through to the plain-text path so the copy still succeeds.
  }

  await copyToClipboard(text, env);
}

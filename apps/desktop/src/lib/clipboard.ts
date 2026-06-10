import { isTauriRuntime } from "./tauriRuntime";

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
      // Fall through to Web Clipboard / legacy copy when the native plugin is unavailable.
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

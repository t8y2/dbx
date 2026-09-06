import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export type WindowContext = { kind: "main"; windowLabel: "main" } | { kind: "detached-tab"; windowLabel: string; tabId: string };

const DETACHED_WINDOW_PARAM = "dbxDetachedTab";

let cachedContext: WindowContext | undefined;

export function detachedWindowLabel(tabId: string): string {
  return `detached-tab-${tabId}`;
}

export function resolveWindowContext(): WindowContext {
  if (cachedContext) return cachedContext;
  if (!isTauriRuntime()) {
    cachedContext = { kind: "main", windowLabel: "main" };
    return cachedContext;
  }

  const tabId = new URLSearchParams(window.location.search).get(DETACHED_WINDOW_PARAM)?.trim();
  if (tabId) {
    // The window label is not available synchronously from the Tauri API. The
    // deterministic label is also what the creator uses, so it is sufficient
    // for routing and event targeting during bootstrap.
    cachedContext = { kind: "detached-tab", windowLabel: detachedWindowLabel(tabId), tabId };
  } else {
    cachedContext = { kind: "main", windowLabel: "main" };
  }
  return cachedContext;
}

export function isDetachedWindow(): boolean {
  return resolveWindowContext().kind === "detached-tab";
}

export function detachedTabId(): string | undefined {
  const context = resolveWindowContext();
  return context.kind === "detached-tab" ? context.tabId : undefined;
}

export function detachedWindowUrl(tabId: string): string {
  const url = new URL(window.location.href);
  url.search = new URLSearchParams({ [DETACHED_WINDOW_PARAM]: tabId }).toString();
  url.hash = "";
  return url.toString();
}

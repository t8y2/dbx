import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export type WindowContext =
  | { kind: "main"; windowLabel: "main" }
  | { kind: "detached-tab"; windowLabel: string; tabId: string }
  /** A floating plugin window: one plugin workbench rendered outside the shell (§8.3 surface "window"). */
  | { kind: "plugin-window"; windowLabel: string; pluginId: string; contributionId: string; creatorLabel: string; pluginContext?: Record<string, unknown> };

const DETACHED_WINDOW_PARAM = "dbxDetachedTab";
const PLUGIN_WINDOW_PARAM = "dbxPluginWindow";
const PLUGIN_WINDOW_CONTRIBUTION_PARAM = "dbxPluginContribution";
const PLUGIN_WINDOW_CONTEXT_PARAM = "dbxPluginWindowContext";
/** Label of the window that created this floating window, so the widget can report liveness back to it. */
const PLUGIN_WINDOW_CREATOR_PARAM = "dbxPluginWindowFrom";
const FLOATING_WINDOW_LABEL_PREFIX = "plugin-floating-";
/** Bound for the URL-carried plugin context: it is routing state, not a data channel. */
export const MAX_PLUGIN_WINDOW_CONTEXT_BYTES = 4 * 1024;

let cachedContext: WindowContext | undefined;

export function detachedWindowLabel(tabId: string): string {
  return `detached-tab-${tabId}`;
}

/**
 * Deterministic label for a plugin's floating window: one window per
 * (plugin, workbench contribution) pair, so reopening focuses the existing
 * window instead of stacking widgets. Tauri only allows alphanumeric, `-`,
 * `/`, `:` and `_` in labels, so plugin ids (dots) are slugged and a short hash
 * of the raw pair keeps slugs that differ only in stripped characters apart.
 * Labels are also the capability-scope pattern (`plugin-floating-*`), and an
 * over-long pair is folded into hashes.
 */
export function floatingWindowLabel(pluginId: string, contributionId: string): string {
  const raw = `${pluginId}/${contributionId}`;
  const slug = raw.replace(/[^A-Za-z0-9_-]+/g, "-");
  const label = `${FLOATING_WINDOW_LABEL_PREFIX}${slug}-${stableHash(raw)}`;
  return label.length <= 120 ? label : `${FLOATING_WINDOW_LABEL_PREFIX}${stableHash(pluginId)}-${stableHash(contributionId)}`;
}

export function isFloatingWindowLabel(label: string): boolean {
  return label.startsWith(FLOATING_WINDOW_LABEL_PREFIX);
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * Plugin context rides the window URL (base64url JSON) because the floating
 * window resolves it synchronously at boot; a cross-window event handoff would
 * race the first render. `undefined` when absent, oversized, or malformed —
 * a floating window still boots, it just starts without extra context.
 */
export function encodeFloatingPluginContext(context: Record<string, unknown> | undefined): string | undefined {
  if (!context || !Object.keys(context).length) return undefined;
  const json = JSON.stringify(context);
  if (new TextEncoder().encode(json).byteLength > MAX_PLUGIN_WINDOW_CONTEXT_BYTES) return undefined;
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeFloatingPluginContext(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  try {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes));
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

export function resolveWindowContext(): WindowContext {
  if (cachedContext) return cachedContext;
  if (!isTauriRuntime()) {
    cachedContext = { kind: "main", windowLabel: "main" };
    return cachedContext;
  }

  const search = new URLSearchParams(window.location.search);
  const tabId = search.get(DETACHED_WINDOW_PARAM)?.trim();
  if (tabId) {
    // The window label is not available synchronously from the Tauri API. The
    // deterministic label is also what the creator uses, so it is sufficient
    // for routing and event targeting during bootstrap.
    cachedContext = { kind: "detached-tab", windowLabel: detachedWindowLabel(tabId), tabId };
    return cachedContext;
  }

  const pluginId = search.get(PLUGIN_WINDOW_PARAM)?.trim();
  const contributionId = search.get(PLUGIN_WINDOW_CONTRIBUTION_PARAM)?.trim();
  if (pluginId && contributionId) {
    const pluginContext = decodeFloatingPluginContext(search.get(PLUGIN_WINDOW_CONTEXT_PARAM)?.trim());
    cachedContext = {
      kind: "plugin-window",
      windowLabel: floatingWindowLabel(pluginId, contributionId),
      pluginId,
      contributionId,
      creatorLabel: search.get(PLUGIN_WINDOW_CREATOR_PARAM)?.trim() || "main",
      ...(pluginContext ? { pluginContext } : {}),
    };
    return cachedContext;
  }

  cachedContext = { kind: "main", windowLabel: "main" };
  return cachedContext;
}

export function isDetachedWindow(): boolean {
  return resolveWindowContext().kind === "detached-tab";
}

export function isFloatingPluginWindow(): boolean {
  return resolveWindowContext().kind === "plugin-window";
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

export function floatingWindowUrl(pluginId: string, contributionId: string, context?: Record<string, unknown>, creatorLabel?: string): string {
  const url = new URL(window.location.href);
  const search = new URLSearchParams({ [PLUGIN_WINDOW_PARAM]: pluginId, [PLUGIN_WINDOW_CONTRIBUTION_PARAM]: contributionId });
  const encodedContext = encodeFloatingPluginContext(context);
  if (encodedContext) search.set(PLUGIN_WINDOW_CONTEXT_PARAM, encodedContext);
  if (creatorLabel) search.set(PLUGIN_WINDOW_CREATOR_PARAM, creatorLabel);
  url.search = search.toString();
  url.hash = "";
  return url.toString();
}

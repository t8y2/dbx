// The inlined plugin ui document is multiple megabytes; rebuilding it per
// workbench instance (every dock panel, every tab) re-reads the entry through
// the bridge and re-parses it each time. Module scope is the point: the cache
// is shared by every PluginWorkbenchHost instance, so only the first boot of a
// plugin version pays the read/decode/inline pipeline.
import * as api from "@/lib/backend/api";

export interface PluginUiHtml {
  html: string;
  entryDirectory: string;
  /** Final sandbox document (html + CSP/SDK/theme injection); built lazily once
   * per plugin version — regenerating it re-runs megabyte-scale string surgery
   * on every panel/tab boot. The embedded appearance only affects the pre-init
   * first paint; the init message pushes the live theme right after. */
  sandboxDoc?: string;
}

const cache = new Map<string, PluginUiHtml>();
const LIMIT = 4;

export function getCachedPluginUiHtml(key: string): PluginUiHtml | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Map iterates oldest-first; re-inserting makes the just-read entry the
  // newest survivor of an eviction.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function setCachedPluginUiHtml(key: string, value: PluginUiHtml): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > LIMIT) cache.delete(cache.keys().next().value as string);
}

/** Test and plugin-uninstall escape hatch. */
export function clearPluginUiHtmlCache(): void {
  cache.clear();
  inFlight.clear();
}

// --- First-boot pipeline (read → decode → inline local assets) -------------

function localUiAssetPath(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed || /^(?:blob:|data:|https?:|\/\/)/i.test(trimmed)) return undefined;
  try {
    const resolved = new URL(trimmed, "https://dbx-plugin.invalid/");
    if (resolved.origin !== "https://dbx-plugin.invalid") return undefined;
    const path = decodeURIComponent(resolved.pathname).replace(/^\/+/, "");
    if (!path || path.split("/").some((segment) => segment === "..")) return undefined;
    return path;
  } catch {
    return undefined;
  }
}

async function inlineLocalUiAssets(html: string, pluginId: string): Promise<PluginUiHtml> {
  // Shipped ui builds usually inline every asset into one HTML document.
  // Parsing and re-serializing a multi-megabyte document is pure overhead when
  // there is nothing local to inline — pre-check before touching DOMParser.
  if (!/<script\b[^>]*\bsrc=/i.test(html) && !/<link\b[^>]*rel=["']?stylesheet/i.test(html)) {
    return { html, entryDirectory: "" };
  }
  const document = new DOMParser().parseFromString(html, "text/html");
  const resources = [...document.querySelectorAll("script[src], link[rel='stylesheet'][href]")];
  // Dynamic-import chunks and CSS url() references live next to the entry
  // script; its directory is the <base> the sandbox document needs to resolve
  // them through the dbx-plugin scheme.
  let entryDirectory = "";
  // Fetch every referenced asset concurrently — these are bridge round-trips
  // into the sidecar, and panels reopen this path on every workbench (re)load.
  const fetched = await Promise.all(
    resources.map((resource) => {
      const source = resource.getAttribute(resource.tagName === "SCRIPT" ? "src" : "href");
      const path = source ? localUiAssetPath(source) : undefined;
      if (!path) return Promise.resolve({ resource, content: null });
      if (!entryDirectory) entryDirectory = path.split("/").slice(0, -1).join("/");
      return api.readPluginUiAsset(pluginId, path).then((asset) => ({
        resource,
        content: new TextDecoder().decode(Uint8Array.from(atob(asset.dataBase64), (character) => character.charCodeAt(0))),
      }));
    }),
  );
  for (const { resource, content } of fetched) {
    if (content === null) continue;
    if (resource.tagName === "SCRIPT") {
      const script = document.createElement("script");
      for (const attribute of [...resource.attributes]) {
        if (attribute.name !== "src") script.setAttribute(attribute.name, attribute.value);
      }
      script.textContent = content;
      resource.replaceWith(script);
    } else {
      const style = document.createElement("style");
      style.textContent = content;
      resource.replaceWith(style);
    }
  }
  return { html: document.documentElement.outerHTML, entryDirectory };
}

/** Full first-boot pipeline: read the ui entry through the bridge, decode, inline local assets. */
export async function loadPluginUiHtml(pluginId: string): Promise<PluginUiHtml> {
  const asset = await api.readPluginUiEntry(pluginId);
  const bytes = Uint8Array.from(atob(asset.dataBase64), (character) => character.charCodeAt(0));
  return inlineLocalUiAssets(new TextDecoder().decode(bytes), pluginId);
}

// --- In-flight coalescing ---------------------------------------------------

const inFlight = new Map<string, Promise<PluginUiHtml>>();

/**
 * Cache-or-coalesced-load: a hit resolves synchronously-ish from the LRU;
 * a miss starts (or JOINS) the single in-flight pipeline for the key. Callers
 * that warm ahead of user intent (the dock "+" picker) and the panel mounting
 * moments later share one bridge read instead of racing duplicate
 * multi-megabyte pipelines. A failed load settles the cache untouched and
 * clears its in-flight slot, so the next caller retries cleanly.
 */
export function getOrLoadPluginUiHtml(key: string, pluginId: string): Promise<PluginUiHtml> {
  const hit = getCachedPluginUiHtml(key);
  if (hit) return Promise.resolve(hit);
  let load = inFlight.get(key);
  if (!load) {
    load = loadPluginUiHtml(pluginId)
      .then((value) => {
        setCachedPluginUiHtml(key, value);
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, load);
  }
  return load;
}

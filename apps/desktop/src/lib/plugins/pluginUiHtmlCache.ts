// The processed plugin UI document is multiple megabytes; rebuilding it per
// workbench instance (every dock panel, every tab) re-reads the entry through
// the bridge and re-parses it each time. Module scope is the point: the cache
// is shared by every PluginWorkbenchHost instance, so only the first boot of a
// plugin version pays the read/decode/inline pipeline.
import * as api from "@/lib/backend/api";
import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { COMPONENT_PLUGINS_UPDATED_EVENT } from "@/lib/updates/componentUpdateEvents";

export interface PluginUiHtml {
  html: string;
  entryDirectory: string;
  /** Final sandbox document (html + CSP/SDK/theme injection); built lazily once
   * per plugin version — regenerating it re-runs megabyte-scale string surgery
   * on every panel/tab boot. The embedded appearance only affects the pre-init
   * first paint; the init message pushes the live theme right after. Carries the
   * `unsafe-eval` grant it was built with: that grant is a user setting that can
   * flip while the html stays valid, and it changes the CSP. */
  sandboxDoc?: { allowUnsafeEval: boolean; doc: string };
}

const cache = new Map<string, PluginUiHtml>();
const LIMIT = 4;
let cacheGeneration = 0;

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
  cacheGeneration++;
  cache.clear();
  inFlight.clear();
}

// --- First-boot pipeline (read → decode → prepare local assets) -------------

/** Base URL for packaged plugin UI resources on desktop hosts. */
export function pluginUiAssetBaseUrl(pluginId: string, entryDirectory = ""): string | undefined {
  if (!isTauriRuntime()) return undefined;
  const origin = location.protocol === "http:" || location.protocol === "https:" ? `${location.protocol}//dbx-plugin.localhost/${pluginId}/` : `dbx-plugin://localhost/${pluginId}/`;
  return entryDirectory ? `${origin}${entryDirectory}/` : origin;
}

function pluginUiAssetUrl(pluginId: string, path: string, source: string): string | undefined {
  const baseUrl = pluginUiAssetBaseUrl(pluginId);
  if (!baseUrl) return undefined;
  const assetUrl = new URL(
    path
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/"),
    baseUrl,
  );
  const sourceUrl = new URL(source.trim(), "https://dbx-plugin.invalid/");
  assetUrl.search = sourceUrl.search;
  assetUrl.hash = sourceUrl.hash;
  return assetUrl.href;
}

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
  // Keep the existing first-local-resource directory for the sandbox <base>
  // used by document-relative assets such as inlined CSS url(). External
  // module imports resolve from their own preserved module URLs instead.
  let entryDirectory = "";
  // Fetch every referenced asset concurrently — these are bridge round-trips
  // into the sidecar, and panels reopen this path on every workbench (re)load.
  const fetched = await Promise.all(
    resources.map(async (resource) => {
      const source = resource.getAttribute(resource.tagName === "SCRIPT" ? "src" : "href");
      const path = source ? localUiAssetPath(source) : undefined;
      if (!source || !path) return { resource, content: null };
      if (!entryDirectory) entryDirectory = path.split("/").slice(0, -1).join("/");
      const isModuleScript = resource.tagName === "SCRIPT" && resource.getAttribute("type")?.trim().toLowerCase() === "module";
      // Keep the external module URL only in packaged builds: `tauri dev` serves
      // the app from the devUrl (http(s):), which maps module URLs onto the
      // WebView2-only http-subdomain form that WKWebView/webkit2gtk never serve,
      // so the entry module would fail to load at all in dev there. Dev keeps
      // the inline fallback below (nested imports resolve relative to the
      // srcdoc <base>, as they did before the packaged fix).
      if (isModuleScript && import.meta.env.PROD) {
        const url = pluginUiAssetUrl(pluginId, path, source);
        if (url) {
          // Keep the module's real URL: browsers resolve its static and dynamic
          // imports from this URL, not from the srcdoc document's <base>.
          resource.setAttribute("src", url);
          return { resource, content: null };
        }
      }
      const asset = await api.readPluginUiAsset(pluginId, path);
      return {
        resource,
        content: new TextDecoder().decode(Uint8Array.from(atob(asset.dataBase64), (character) => character.charCodeAt(0))),
      };
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
      // Carry the stylesheet's own attributes over, exactly like the script
      // branch does: they are how a plugin addresses the sheet later (a theme or
      // skin switch selects sheets by a data-* marker and toggles `disabled`),
      // so dropping them here silently breaks every runtime stylesheet lookup in
      // plugin form. Note that `disabled` does not reflect from the content
      // attribute on a <style> element the way it does on a <link>, and it cannot
      // survive serialization as an IDL property either — a plugin that ships a
      // disabled stylesheet has to re-apply `sheet.disabled` itself.
      for (const attribute of [...resource.attributes]) {
        if (attribute.name !== "href" && attribute.name !== "rel") style.setAttribute(attribute.name, attribute.value);
      }
      style.textContent = content;
      resource.replaceWith(style);
    }
  }
  return { html: document.documentElement.outerHTML, entryDirectory };
}

/** Full first-boot pipeline: read the ui entry through the bridge, decode, and prepare local assets. */
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
    const generation = cacheGeneration;
    load = loadPluginUiHtml(pluginId)
      .then((value) => {
        // A plugin change may arrive while its old UI document is still being
        // read. Do not let that pre-invalidation request repopulate the cache.
        if (cacheGeneration === generation) setCachedPluginUiHtml(key, value);
        return value;
      })
      .finally(() => {
        // A post-invalidation load may already own this key.
        if (cacheGeneration === generation) inFlight.delete(key);
      });
    inFlight.set(key, load);
  }
  return load;
}

// The plugin set can change from entry points other than the plugin center (the update center
// dispatches COMPONENT_PLUGINS_UPDATED_EVENT from App.vue while the center is closed; batch
// uninstall dispatches only dbx:plugins-changed), and a same-version reinstall reuses the
// id:version key. Invalidate on both events here, at the cache owner — the same contract the
// icon resolver follows — so workbench tabs opened after an install/update/uninstall read the
// new ui build instead of the stale inlined bytes.
if (typeof window !== "undefined") {
  window.addEventListener(COMPONENT_PLUGINS_UPDATED_EVENT, clearPluginUiHtmlCache);
  window.addEventListener("dbx:plugins-changed", clearPluginUiHtmlCache);
}

// The inlined plugin ui document is multiple megabytes; rebuilding it per
// workbench instance (every dock panel, every tab) re-reads the entry through
// the bridge and re-parses it each time. Module scope is the point: the cache
// is shared by every PluginWorkbenchHost instance, so only the first boot of a
// plugin version pays the read/decode/inline pipeline.
const cache = new Map<string, { html: string; entryDirectory: string }>();
const LIMIT = 4;

export function getCachedPluginUiHtml(key: string): { html: string; entryDirectory: string } | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  // Map iterates oldest-first; re-inserting makes the just-read entry the
  // newest survivor of an eviction.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

export function setCachedPluginUiHtml(key: string, value: { html: string; entryDirectory: string }): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > LIMIT) cache.delete(cache.keys().next().value as string);
}

/** Test and plugin-uninstall escape hatch. */
export function clearPluginUiHtmlCache(): void {
  cache.clear();
}

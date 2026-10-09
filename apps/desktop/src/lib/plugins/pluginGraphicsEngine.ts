/**
 * Per-plugin opt-in for `script-src 'unsafe-eval'` in the workbench sandbox.
 *
 * WebGL graphics engines generate their uniform/UBO sync code with
 * `new Function` (PixiJS 8 refuses to even construct a renderer when that
 * throws), so a plugin whose UI renders through such an engine needs
 * unsafe-eval or its visual surfaces never initialize. The sandbox keeps the
 * directive off by default and the user grants it one plugin at a time, the
 * same way AI tool access and data reads are granted.
 */

const MAX_GRANTED_PLUGINS = 64;

export function normalizePluginGraphicsEngineIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id) continue;
    ids.add(id);
    if (ids.size >= MAX_GRANTED_PLUGINS) break;
  }
  return [...ids];
}

export function isPluginGraphicsEngineEnabled(ids: readonly string[] | undefined, pluginId: string): boolean {
  return !!pluginId && (ids || []).includes(pluginId);
}

export function withPluginGraphicsEngineEnabled(ids: readonly string[] | undefined, pluginId: string, enabled: boolean): string[] {
  const current = normalizePluginGraphicsEngineIds(ids).filter((id) => id !== pluginId);
  if (!enabled || !pluginId) return current;
  return [...current, pluginId].slice(0, MAX_GRANTED_PLUGINS);
}

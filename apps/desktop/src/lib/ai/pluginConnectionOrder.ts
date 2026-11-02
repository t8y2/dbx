/**
 * Orders plugin connections exactly like the backend's plugin-tool discovery
 * (`crates/dbx-core/src/ai/plugin_tools.rs`): by `plugin_id`, then connection
 * name, then connection id.
 *
 * Rust compares `str` values as UTF-8 bytes, which preserves code-point order.
 * JavaScript's `<` compares UTF-16 code units and disagrees for non-BMP
 * characters (a full-width Ａ sorts before 😀 in code-point order, while UTF-16
 * puts the emoji's surrogate pair first), so compare code points instead.
 */
export interface PluginConnectionOrderKey {
  id: string;
  name: string;
  plugin_id?: string;
}

function compareCodePointStrings(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index += 1) {
    const leftPoint = leftPoints[index].codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index].codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1;
  }
  if (leftPoints.length === rightPoints.length) return 0;
  return leftPoints.length < rightPoints.length ? -1 : 1;
}

export function comparePluginConnectionOrder(left: PluginConnectionOrderKey, right: PluginConnectionOrderKey): number {
  const pluginComparison = compareCodePointStrings(left.plugin_id ?? "", right.plugin_id ?? "");
  if (pluginComparison !== 0) return pluginComparison;
  const nameComparison = compareCodePointStrings(left.name, right.name);
  if (nameComparison !== 0) return nameComparison;
  return compareCodePointStrings(left.id, right.id);
}

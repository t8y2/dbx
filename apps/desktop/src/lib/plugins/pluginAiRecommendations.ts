import { MAX_PLUGIN_AI_RECOMMENDATIONS, type PluginAiRecommendation, type PluginAiRecommendationContext, type PluginAiRecommendationUpdate } from "@/types/pluginAiRecommendations";

export { MAX_PLUGIN_AI_RECOMMENDATIONS, type PluginAiRecommendation, type PluginAiRecommendationContext, type PluginAiRecommendationUpdate };

const PLACEHOLDER = /\{\{\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.(?:[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+))*)\s*\}\}/g;
const PLACEHOLDER_PATH = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.(?:[A-Za-z_$][A-Za-z0-9_$]*|[0-9]+))*$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/** Validate that every brace pair uses the supported context placeholder syntax. */
export function isValidPluginAiRecommendationTemplate(value: string): boolean {
  let offset = 0;
  while (offset < value.length) {
    const open = value.indexOf("{{", offset);
    const close = value.indexOf("}}", offset);
    const next = open < 0 ? close : close < 0 ? open : Math.min(open, close);
    if (next < 0) return true;
    if (value.startsWith("}}", next)) return false;
    const end = value.indexOf("}}", next + 2);
    if (end < 0) return false;
    const path = value.slice(next + 2, end).trim();
    if (!PLACEHOLDER_PATH.test(path) || FORBIDDEN_PATH_SEGMENTS.has(path) || path.split(".").some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) return false;
    offset = end + 2;
  }
  return true;
}

/**
 * Resolve a dotted context path without traversing inherited properties.
 * This keeps plugin supplied templates from reading prototype members.
 */
function readContextPath(context: unknown, path: string): unknown {
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (FORBIDDEN_PATH_SEGMENTS.has(segment) || (typeof current !== "object" && typeof current !== "function") || current === null) return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Convert a context leaf to safe human-readable template text. */
function contextValueText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.trim() ? value : undefined;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  return undefined;
}

/**
 * Interpolate one recommendation. If any placeholder cannot be resolved, the
 * item is omitted (`null`) so an unfinished prompt is never shown to users.
 */
export function interpolatePluginAiRecommendation(item: PluginAiRecommendation, context: PluginAiRecommendationContext): PluginAiRecommendation | null {
  if (!isValidRecommendation(item)) return null;

  let unresolved = false;
  const interpolate = (text: string): string =>
    text.replace(PLACEHOLDER, (_match, path: string) => {
      const value = contextValueText(readContextPath(context, path));
      if (value === undefined) {
        unresolved = true;
        return "";
      }
      return value;
    });

  const label = interpolate(item.label);
  const prompt = interpolate(item.prompt);
  if (unresolved || !label.trim() || !prompt.trim()) return null;

  return {
    id: item.id.trim(),
    label,
    prompt,
    ...(item.order === undefined ? {} : { order: item.order }),
  };
}

/**
 * Resolve, order, and cap a list of recommendations for a context.
 * The input is never mutated and the result contains fresh objects.
 */
export function resolvePluginAiRecommendations(items: readonly PluginAiRecommendation[] | undefined, context: PluginAiRecommendationContext = {}): PluginAiRecommendation[] {
  const resolved = (items ?? [])
    .map((item) => interpolatePluginAiRecommendation(item, context))
    .filter((item): item is PluginAiRecommendation => item !== null)
    .map((item, index) => ({ item, index }));

  resolved.sort((left, right) => (left.item.order ?? 0) - (right.item.order ?? 0) || left.index - right.index);
  return resolved.slice(0, MAX_PLUGIN_AI_RECOMMENDATIONS).map(({ item }) => item);
}

/**
 * Select the effective list. An omitted runtime list keeps manifest defaults;
 * an explicitly supplied list (including `[]`) replaces them.
 */
export function selectPluginAiRecommendations(defaults: readonly PluginAiRecommendation[] | undefined, runtime: readonly PluginAiRecommendation[] | undefined): readonly PluginAiRecommendation[] {
  return runtime === undefined ? (defaults ?? []) : runtime;
}

/** Resolve a declaration plus an optional runtime update in one pure step. */
export function resolvePluginAiRecommendationUpdate(defaults: readonly PluginAiRecommendation[] | undefined, runtime: PluginAiRecommendationUpdate | undefined, fallbackContext: PluginAiRecommendationContext = {}): PluginAiRecommendation[] {
  const items = selectPluginAiRecommendations(defaults, runtime?.items);
  return resolvePluginAiRecommendations(items, runtime?.context ?? fallbackContext);
}

function isValidRecommendation(item: PluginAiRecommendation): boolean {
  if (!item || typeof item !== "object") return false;
  if (typeof item.id !== "string" || !item.id.trim()) return false;
  if (typeof item.label !== "string" || !item.label.trim()) return false;
  if (typeof item.prompt !== "string" || !item.prompt.trim()) return false;
  if (!isValidPluginAiRecommendationTemplate(item.label) || !isValidPluginAiRecommendationTemplate(item.prompt)) return false;
  return item.order === undefined || (typeof item.order === "number" && Number.isFinite(item.order));
}

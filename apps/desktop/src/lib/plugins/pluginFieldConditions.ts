import type { PluginFieldCondition, PluginFormField, PluginFormFieldValue } from "@/types/database";

/**
 * Evaluates a plugin manifest field condition (`visible_when` / `required_when`,
 * Host API 1.1). A condition matches when the current value of the referenced
 * sibling field is listed in `one_of`. Missing conditions always match.
 */
export function pluginFieldConditionMatches(condition: PluginFieldCondition | undefined, value: PluginFormFieldValue): boolean {
  if (!condition) return true;
  if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) return false;
  return condition.one_of.includes(String(value));
}

/** Looks a sibling field up by key; returns undefined when the key is unknown. */
export type PluginFieldResolver = (key: string) => PluginFormField | undefined;

/**
 * A field is rendered when its `visible_when` (if any) matches current values.
 * Conditions cascade: when the referenced sibling is itself hidden, its stored
 * or default value must not light the condition up — otherwise a nested
 * default (e.g. `oauth_token_source: "msk_iam"` while SASL is off) marks
 * grandchild fields visible and required and dead-locks the dialog footer.
 */
export function pluginFieldIsVisible(field: PluginFormField, readValue: (key: string) => PluginFormFieldValue, resolveField?: PluginFieldResolver): boolean {
  return pluginFieldIsVisibleCached(field, readValue, resolveField, new Set([field.key]));
}

function pluginFieldIsVisibleCached(field: PluginFormField, readValue: (key: string) => PluginFormFieldValue, resolveField: PluginFieldResolver | undefined, seen: Set<string>): boolean {
  const condition = field.visible_when;
  if (!condition) return true;
  if (!pluginFieldConditionMatches(condition, readValue(condition.field))) return false;
  const target = resolveField?.(condition.field);
  if (!target || seen.has(target.key)) return true;
  seen.add(target.key);
  return pluginFieldIsVisibleCached(target, readValue, resolveField, seen);
}

/** Effective required = static `required` OR a matching `required_when`. */
export function pluginFieldIsRequired(field: PluginFormField, readValue: (key: string) => PluginFormFieldValue): boolean {
  if (field.required) return true;
  // No `required_when` means the field is simply optional: the shared
  // condition helper treats a missing condition as "always matches" (correct
  // for visibility), so it must not be consulted here — that used to mark
  // every plugin field required and dead-locked the connection footer.
  if (!field.required_when) return false;
  return pluginFieldConditionMatches(field.required_when, readValue(field.required_when.field));
}

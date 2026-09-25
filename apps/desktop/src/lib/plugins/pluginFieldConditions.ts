import type { PluginFieldCondition, PluginFormField, PluginFormFieldValue } from "@/types/database";

/**
 * Canonical string form of a form value, matching the Rust host
 * (`condition_value_text` in `crates/dbx-plugin-runtime/src/plugins/manifest.rs`).
 * `false` renders as `"false"` and `22.0` as `"22"`.
 */
export function pluginConditionValueText(value: PluginFormFieldValue): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

/** Reads the current value of a sibling form field by key. */
export type PluginFieldValueReader = (key: string) => PluginFormFieldValue;

/** A leaf clause matches when the sibling value equals one of its literals. */
function conditionClauseMatches(clause: { field: string; one_of: readonly (string | number | boolean)[] }, value: PluginFormFieldValue): boolean {
  if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) return false;
  const text = pluginConditionValueText(value);
  return clause.one_of.some((literal) => pluginConditionValueText(literal) === text);
}

/**
 * Evaluates a plugin manifest field condition (`visible_when` / `required_when`,
 * Host API 1.1+). A leaf matches when the current value of the referenced
 * sibling field is listed in `one_of`; `all_of` / `any_of` / `not` compose
 * clauses, so a manifest can express `sudo_source = custom AND read_only =
 * false`. Missing conditions always match; a missing or empty sibling value
 * never matches.
 */
export function pluginFieldConditionMatches(condition: PluginFieldCondition | undefined, readValue: PluginFieldValueReader): boolean {
  if (!condition) return true;
  return conditionExpressionMatches(condition, readValue);
}

function conditionExpressionMatches(condition: PluginFieldCondition, readValue: PluginFieldValueReader): boolean {
  if (isConditionClause(condition)) return conditionClauseMatches(condition, readValue(condition.field));
  if (isConditionAllOf(condition)) {
    return condition.all_of.every((child) => conditionExpressionMatches(child, readValue));
  }
  if (isConditionAnyOf(condition)) {
    return condition.any_of.some((child) => conditionExpressionMatches(child, readValue));
  }
  return !conditionExpressionMatches(condition.not, readValue);
}

/** Field keys the expression reads, in evaluation order (duplicates kept). */
export function pluginFieldConditionReferencedFields(condition: PluginFieldCondition): string[] {
  if (isConditionClause(condition)) return [condition.field];
  if (isConditionAllOf(condition)) return condition.all_of.flatMap(pluginFieldConditionReferencedFields);
  if (isConditionAnyOf(condition)) return condition.any_of.flatMap(pluginFieldConditionReferencedFields);
  return pluginFieldConditionReferencedFields(condition.not);
}

function isConditionClause(condition: PluginFieldCondition): condition is { field: string; one_of: (string | number | boolean)[] } {
  return typeof (condition as { field?: unknown }).field === "string";
}

function isConditionAllOf(condition: PluginFieldCondition): condition is { all_of: PluginFieldCondition[] } {
  return Array.isArray((condition as { all_of?: unknown }).all_of);
}

function isConditionAnyOf(condition: PluginFieldCondition): condition is { any_of: PluginFieldCondition[] } {
  return Array.isArray((condition as { any_of?: unknown }).any_of);
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
  return conditionExpressionVisible(condition, readValue, resolveField, seen);
}

/**
 * Visibility-aware evaluation of one condition expression.
 *
 * A clause only counts while the sibling it reads is visible *and* its own
 * `visible_when` chain is satisfied, so a hidden controller's stored default
 * cannot light a field up. `not` additionally requires every operand to be
 * visible: an inverted hidden value is not a usable answer.
 */
function conditionExpressionVisible(condition: PluginFieldCondition, readValue: PluginFieldValueReader, resolveField: PluginFieldResolver | undefined, seen: Set<string>): boolean {
  if (isConditionClause(condition)) {
    if (!conditionClauseMatches(condition, readValue(condition.field))) return false;
    return conditionOperandVisible(condition.field, readValue, resolveField, seen);
  }
  if (isConditionAllOf(condition)) {
    return condition.all_of.every((child) => conditionExpressionVisible(child, readValue, resolveField, seen));
  }
  if (isConditionAnyOf(condition)) {
    return condition.any_of.some((child) => conditionExpressionVisible(child, readValue, resolveField, seen));
  }
  const operandsVisible = pluginFieldConditionReferencedFields(condition.not).every((key) => conditionOperandVisible(key, readValue, resolveField, seen));
  return operandsVisible && !conditionExpressionMatches(condition.not, readValue);
}

/** Whether the sibling behind one clause is itself rendered. Cycles count as visible. */
function conditionOperandVisible(key: string, readValue: PluginFieldValueReader, resolveField: PluginFieldResolver | undefined, seen: Set<string>): boolean {
  const target = resolveField?.(key);
  if (!target || seen.has(target.key)) return true;
  seen.add(target.key);
  const visible = pluginFieldIsVisibleCached(target, readValue, resolveField, seen);
  seen.delete(target.key);
  return visible;
}

/** Effective required = static `required` OR a matching `required_when`. */
export function pluginFieldIsRequired(field: PluginFormField, readValue: (key: string) => PluginFormFieldValue): boolean {
  if (field.required) return true;
  // No `required_when` means the field is simply optional: the shared
  // condition helper treats a missing condition as "always matches" (correct
  // for visibility), so it must not be consulted here — that used to mark
  // every plugin field required and dead-locked the connection footer.
  if (!field.required_when) return false;
  return pluginFieldConditionMatches(field.required_when, readValue);
}

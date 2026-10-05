// ---------------------------------------------------------------------------
// Dynamic config form helpers. Provider config fields come straight from the
// manifest (`PluginFormField`, ADR §6.1: "禁止第二套 DSL"), so visibility and
// required evaluation reuse the exact condition engine the connection dialogs
// use — the scheduler renders the same field system, nothing else.
// ---------------------------------------------------------------------------

import { pluginFieldIsRequired, pluginFieldIsVisible, type PluginFieldResolver } from "@/lib/plugins/pluginFieldConditions";
import type { PluginFormField, PluginFormFieldValue } from "@/types/database";
import type { SchedulerTaskTriggerContribution } from "./schedulerTypes";

/** Form values the renderer edits; `undefined` = untouched. */
export type SchedulerFormValues = Record<string, PluginFormFieldValue>;

export function readFormValue(fields: readonly PluginFormField[], values: SchedulerFormValues, key: string): PluginFormFieldValue {
  const field = fields.find((candidate) => candidate.key === key);
  if (!field) return undefined;
  const raw = values[key];
  return raw ?? field.default ?? undefined;
}

/** Visibility with condition cascade (hidden controllers cannot light fields up). */
export function formFieldVisible(fields: readonly PluginFormField[], values: SchedulerFormValues, field: PluginFormField): boolean {
  const readValue = (key: string) => readFormValue(fields, values, key);
  const resolveField: PluginFieldResolver = (key) => fields.find((candidate) => candidate.key === key);
  return pluginFieldIsVisible(field, readValue, resolveField);
}

export function formFieldRequired(fields: readonly PluginFormField[], values: SchedulerFormValues, field: PluginFormField): boolean {
  const readValue = (key: string) => readFormValue(fields, values, key);
  return pluginFieldIsRequired(field, readValue);
}

export function visibleFormFields(fields: readonly PluginFormField[], values: SchedulerFormValues): PluginFormField[] {
  return fields.filter((field) => formFieldVisible(fields, values, field));
}

/**
 * Effective form values for a fresh draft: declared defaults fill untouched
 * keys so conditions see them, exactly like the connection dialog does.
 */
export function defaultFormValues(fields: readonly PluginFormField[]): SchedulerFormValues {
  const values: SchedulerFormValues = {};
  for (const field of fields) {
    if (field.default !== undefined && field.default !== null) values[field.key] = field.default;
  }
  return values;
}

/**
 * Config keys the UI must never persist. Secret-bound field values ride the
 * host secret channel at execution time (ADR §10.3) — a saved task config is
 * exportable and logged, so secrets never enter it.
 */
function isSecretBound(field: PluginFormField): boolean {
  return field.binding === "secret" || (field.type === "password" && field.binding !== "config");
}

/**
 * Projects form values onto the persisted config: only visible fields are
 * written, secret-bound values are dropped, untouched optional fields are
 * omitted. The reserved host `__triggerId` key survives untouched (it is
 * managed by schedulerProviders, not the form).
 */
export function configFromFormValues(fields: readonly PluginFormField[], values: SchedulerFormValues, previous?: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  const previousTriggerId = previous?.["__triggerId"];
  for (const field of fields) {
    if (!formFieldVisible(fields, values, field)) continue;
    if (isSecretBound(field)) continue;
    const value = values[field.key] ?? field.default;
    if (value === undefined || value === null || value === "") continue;
    next[field.key] = value;
  }
  if (typeof previousTriggerId === "string") next["__triggerId"] = previousTriggerId;
  return next;
}

/** Hydrates editor form values from a stored config, ignoring host keys. */
export function formValuesFromConfig(fields: readonly PluginFormField[], config: Record<string, unknown> | undefined | null): SchedulerFormValues {
  const values = defaultFormValues(fields);
  for (const field of fields) {
    const stored = config?.[field.key];
    if (stored !== undefined && stored !== null) values[field.key] = stored as PluginFormFieldValue;
  }
  return values;
}

export interface ConfigValidationIssue {
  key: string;
  label: string;
}

/** Required-field check mirroring the backend `invalid_config` pre-check. */
export function validateFormFields(fields: readonly PluginFormField[], values: SchedulerFormValues): ConfigValidationIssue[] {
  const issues: ConfigValidationIssue[] = [];
  for (const field of visibleFormFields(fields, values)) {
    if (!formFieldRequired(fields, values, field)) continue;
    const value = values[field.key] ?? field.default;
    if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) issues.push({ key: field.key, label: field.label });
  }
  return issues;
}

/** Fields of the trigger contribution a task is being edited against. */
export function triggerConfigFields(trigger: SchedulerTaskTriggerContribution | undefined): PluginFormField[] {
  return trigger?.fields ?? [];
}

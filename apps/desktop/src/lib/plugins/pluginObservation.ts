import type { PluginHostObservationEvent } from "@/types/pluginObservation";

/**
 * Frontend mirror of the Rust observation permission mapping
 * (`dbx_types::models::observability`). Keep both sides in sync: the Rust map
 * gates sidecar delivery, this one gates the plugin UI bridge.
 */
export const PLUGIN_OBSERVATION_PERMISSIONS = {
  queries: "host.observe:queries",
  connections: "host.observe:connections",
  ai: "host.observe:ai",
  transfers: "host.observe:transfers",
  plugins: "host.observe:plugins",
} as const;

export type PluginObservationCategory = keyof typeof PLUGIN_OBSERVATION_PERMISSIONS;

/**
 * Registered event kinds and the category (and thus permission) that gates
 * each one. Mirrors `OBSERVATION_KINDS` in
 * `dbx_types::models::observability`, which is the source of truth: delivery
 * looks kinds up by exact name, so a kind that is emitted without a
 * registration here is dropped rather than inheriting its prefix's permission.
 */
const KIND_CATEGORIES: Record<string, PluginObservationCategory> = {
  "query.started": "queries",
  "query.finished": "queries",
  "query.message": "queries",
  "connection.opened": "connections",
  "connection.open_failed": "connections",
  "connection.closed": "connections",
  "connection.liveness_lost": "connections",
  "connection.idle_closed": "connections",
  "ai.turn_started": "ai",
  "ai.turn_ended": "ai",
  "ai.text_delta": "ai",
  "ai.reasoning_delta": "ai",
  "ai.tool_call_started": "ai",
  "ai.tool_call_finished": "ai",
  "ai.approval_required": "ai",
  "ai.approval_resolved": "ai",
  "ai.write_sql_confirmation_required": "ai",
  "ai.production_write_blocked": "ai",
  "ai.response_complete": "ai",
  "ai.output_truncated": "ai",
  "ai.agent_finished": "ai",
  "ai.context_compacted": "ai",
  "ai.error": "ai",
  "transfer.progress": "transfers",
  "plugin.activated": "plugins",
  "plugin.activate_failed": "plugins",
  "plugin.status_changed": "plugins",
  "plugin.stopped": "plugins",
};

/**
 * Category (and thus permission) for an event kind. Unknown kinds return
 * `undefined` and must be dropped by delivery layers (fail closed) so a future
 * kind that forgot its registration cannot leak through an unrelated
 * permission.
 */
export function pluginObservationCategory(kind: string): PluginObservationCategory | undefined {
  return Object.prototype.hasOwnProperty.call(KIND_CATEGORIES, kind) ? KIND_CATEGORIES[kind] : undefined;
}

/** Registered kinds with their category, exported for the registry-drift spec. */
export const REGISTERED_OBSERVATION_KINDS: Readonly<Record<string, PluginObservationCategory>> = KIND_CATEGORIES;

/** Permission string required to observe this event kind, if any. */
export function pluginObservationPermission(kind: string): string | undefined {
  const category = pluginObservationCategory(kind);
  return category ? PLUGIN_OBSERVATION_PERMISSIONS[category] : undefined;
}

/**
 * High-frequency streaming kinds. They are delivered to plugin UIs but not to
 * sidecar backends (mirrors `SIDECAR_SKIPPED_KINDS` in Rust).
 */
export const SIDECAR_SKIPPED_OBSERVATION_KINDS = ["ai.text_delta", "ai.reasoning_delta"] as const;

/** Whether any `host.observe:*` permission is declared. */
export function declaresAnyObservationPermission(permissions: readonly string[] | undefined): boolean {
  return (permissions ?? []).some((permission) => permission.startsWith("host.observe:"));
}

/**
 * Whether a plugin with `permissions` may receive `event`.
 *
 * `getPermission` is injected instead of reading the manifest directly so the
 * bridge (which also honors the legacy `host.connections::read` alias rules)
 * stays the single permission authority.
 */
export function canObserveHostEvent(event: PluginHostObservationEvent, hasPermission: (permission: string) => boolean): boolean {
  const permission = pluginObservationPermission(event.kind);
  return permission !== undefined && hasPermission(permission);
}

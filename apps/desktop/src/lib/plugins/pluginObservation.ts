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

const KIND_PREFIX_TO_CATEGORY: Record<string, PluginObservationCategory> = {
  query: "queries",
  connection: "connections",
  ai: "ai",
  transfer: "transfers",
  plugin: "plugins",
};

/**
 * Category (and thus permission) for an event kind. Unknown kinds return
 * `undefined` and must be dropped by delivery layers (fail closed) so a future
 * kind that forgot its mapping cannot leak through an unrelated permission.
 */
export function pluginObservationCategory(kind: string): PluginObservationCategory | undefined {
  const prefix = kind.split(".", 1)[0];
  return KIND_PREFIX_TO_CATEGORY[prefix];
}

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

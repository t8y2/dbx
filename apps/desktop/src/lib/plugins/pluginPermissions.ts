/**
 * Permission display classification for the plugin center. The badge shows the
 * count; the detail surface lists the real permission strings so a user can see
 * exactly what a plugin asks for before installing. Permissions in
 * SENSITIVE_PLUGIN_PERMISSIONS hand user data or environment state to plugin
 * code without an interaction per call (or open a direct environment channel),
 * so they are highlighted instead of blended into the outline badge row.
 */
export const SENSITIVE_PLUGIN_PERMISSIONS: readonly string[] = ["host.clipboard:read"];

export function isSensitivePluginPermission(permission: string): boolean {
  return SENSITIVE_PLUGIN_PERMISSIONS.includes(permission);
}

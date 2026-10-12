/**
 * Web permission system keys shared by the auth store, permission-aware UI and
 * future admin tooling (plan §5). The backend is the authority; this list only
 * mirrors the contract so the frontend can type and test permission checks.
 *
 * Query read/write is granted per-connection via the role scope tree's
 * "write updates" checkbox — not a feature permission.
 */
export const PERMISSION_KEYS = ["connection.manage", "transfer", "sqlfile.execute", "schema.compare", "data.compare", "backup.restore", "import.data", "export.data", "mcp"] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/**
 * Returns whether the given permission set (from `GET /api/auth/check`) grants
 * `key`. Administrators hold every permission, so `isAdmin` short-circuits.
 */
export function hasPermission(permissions: readonly string[], key: string, isAdmin = false): boolean {
  if (isAdmin) return true;
  return permissions.includes(key);
}

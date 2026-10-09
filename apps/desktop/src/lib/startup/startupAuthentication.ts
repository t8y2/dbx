import { apiUrl } from "@/lib/common/webPath";

export interface AuthenticatedUser {
  username: string;
  display_name: string | null;
  is_admin: boolean;
  department_name: string | null;
  roles: string[];
}

/**
 * Full shape of `GET /api/auth/check` (and of successful login/setup
 * responses, which reuse the same contract). Older consumers only read the
 * first three fields, so the extension stays backwards compatible.
 */
export interface StartupAuthentication {
  required: boolean;
  authenticated: boolean;
  setup_required: boolean;
  user: AuthenticatedUser | null;
  permissions: string[];
  must_change_password: boolean;
  password_expires_in_days: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseUser(value: unknown): AuthenticatedUser | null {
  if (!isRecord(value) || typeof value.username !== "string") return null;
  return {
    username: value.username,
    display_name: typeof value.display_name === "string" ? value.display_name : null,
    is_admin: value.is_admin === true,
    department_name: typeof value.department_name === "string" ? value.department_name : null,
    roles: Array.isArray(value.roles) ? value.roles.filter((role): role is string => typeof role === "string") : [],
  };
}

function parsePermissions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((permission): permission is string => typeof permission === "string") : [];
}

/**
 * Normalizes an auth-check-shaped payload to the full contract, or `null` when
 * the required boolean fields are missing or malformed. Shared by the startup
 * check and the login/setup transports so one validation point covers both.
 */
export function normalizeStartupAuthentication(result: unknown): StartupAuthentication | null {
  if (!isRecord(result) || typeof result.required !== "boolean" || typeof result.authenticated !== "boolean") return null;
  return {
    required: result.required,
    authenticated: result.authenticated,
    setup_required: result.setup_required === true,
    user: parseUser(result.user),
    permissions: parsePermissions(result.permissions),
    must_change_password: result.must_change_password === true,
    password_expires_in_days: typeof result.password_expires_in_days === "number" ? result.password_expires_in_days : null,
  };
}

export async function checkStartupAuthentication(signal?: AbortSignal): Promise<StartupAuthentication> {
  const response = await fetch(apiUrl("/api/auth/check"), { credentials: "same-origin", signal });
  if (!response.ok) throw new Error("AUTH_CHECK_FAILED");
  const result: unknown = await response.json();
  const normalized = normalizeStartupAuthentication(result);
  if (!normalized) throw new Error("AUTH_CHECK_FAILED");
  return normalized;
}

export async function logoutWeb(): Promise<void> {
  const response = await fetch(apiUrl("/api/auth/logout"), {
    method: "POST",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error("AUTH_LOGOUT_FAILED");
  }
}

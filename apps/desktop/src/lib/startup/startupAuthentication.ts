import { apiUrl } from "@/lib/common/webPath";

/** Authentication methods available on the login page (local/LDAP/SSO coexist in multi-provider deployments). */
export interface StartupAuthProvider {
  id: string;
  kind: string;
  label: string;
  mode: "form" | "redirect" | "proxy";
  requires_username: boolean;
}

export interface StartupAuthenticationUser {
  username: string;
  role: string;
  provider_id: string;
}

export interface StartupAuthentication {
  required: boolean;
  authenticated: boolean;
  setup_required: boolean;
  /** Additive: provider list for the login page; absent from legacy backend responses. */
  providers?: StartupAuthProvider[];
  /** Additive: the current user when authenticated. */
  user?: StartupAuthenticationUser;
}

export async function checkStartupAuthentication(signal?: AbortSignal): Promise<StartupAuthentication> {
  const response = await fetch(apiUrl("/api/auth/check"), { credentials: "same-origin", signal });
  if (!response.ok) throw new Error("AUTH_CHECK_FAILED");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("required" in result) || !("authenticated" in result) || typeof result.required !== "boolean" || typeof result.authenticated !== "boolean") {
    throw new Error("AUTH_CHECK_FAILED");
  }
  return {
    required: result.required,
    authenticated: result.authenticated,
    setup_required: "setup_required" in result && result.setup_required === true,
    providers: parseProviders(result),
    user: parseUser(result),
  };
}

function parseProviders(result: object): StartupAuthProvider[] | undefined {
  if (!("providers" in result) || !Array.isArray(result.providers)) return undefined;
  const providers: StartupAuthProvider[] = [];
  for (const item of result.providers) {
    if (!item || typeof item !== "object" || !("id" in item) || !("kind" in item) || !("label" in item) || !("mode" in item) || !("requires_username" in item)) continue;
    const provider = item as Record<string, unknown>;
    if (typeof provider.id !== "string" || typeof provider.kind !== "string" || typeof provider.label !== "string" || typeof provider.requires_username !== "boolean") continue;
    if (provider.mode !== "form" && provider.mode !== "redirect" && provider.mode !== "proxy") continue;
    providers.push({ id: provider.id, kind: provider.kind, label: provider.label, mode: provider.mode, requires_username: provider.requires_username });
  }
  return providers;
}

function parseUser(result: object): StartupAuthenticationUser | undefined {
  if (!("user" in result) || !result.user || typeof result.user !== "object") return undefined;
  const user = result.user as Record<string, unknown>;
  if (typeof user.username !== "string" || typeof user.role !== "string" || typeof user.provider_id !== "string") return undefined;
  return { username: user.username, role: user.role, provider_id: user.provider_id };
}

/** Logout outcome. `logout_url` (RP-initiated logout) is additive: absent from legacy backends and form-only sessions. */
export interface WebLogoutResult {
  /** IdP end-session URL the browser should be sent to so the SSO session is really ended. */
  logoutUrl?: string;
}

export async function logoutWeb(): Promise<WebLogoutResult> {
  const response = await fetch(apiUrl("/api/auth/logout"), {
    method: "POST",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error("AUTH_LOGOUT_FAILED");
  }
  const result: unknown = await response.json();
  if (!result || typeof result !== "object") return {};
  const logoutUrl = "logout_url" in result && typeof (result as Record<string, unknown>).logout_url === "string" ? ((result as Record<string, unknown>).logout_url as string) : undefined;
  return { logoutUrl };
}

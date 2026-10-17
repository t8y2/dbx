import { apiUrl } from "@/lib/common/webPath";

export interface OidcInfo {
  enabled: boolean;
  button_label: string;
  password_disabled: boolean;
}

export interface UserIdentity {
  sub: string;
  email: string;
  name: string;
  role: string;
  method: "password" | "oidc";
}

export interface StartupAuthentication {
  required: boolean;
  authenticated: boolean;
  setup_required: boolean;
  oidc?: OidcInfo;
  user?: UserIdentity;
}

export async function checkStartupAuthentication(signal?: AbortSignal): Promise<StartupAuthentication> {
  const response = await fetch(apiUrl("/api/auth/check"), { credentials: "same-origin", signal });
  if (!response.ok) throw new Error("AUTH_CHECK_FAILED");
  const result: unknown = await response.json();
  if (!result || typeof result !== "object" || !("required" in result) || !("authenticated" in result) || typeof result.required !== "boolean" || typeof result.authenticated !== "boolean") {
    throw new Error("AUTH_CHECK_FAILED");
  }
  const r = result as Record<string, unknown>;
  const oidcRaw = r["oidc"];
  const oidc: OidcInfo | undefined =
    oidcRaw && typeof oidcRaw === "object"
      ? {
          enabled: (oidcRaw as Record<string, unknown>)["enabled"] === true,
          button_label: String((oidcRaw as Record<string, unknown>)["button_label"] ?? "Sign in with SSO"),
          password_disabled: (oidcRaw as Record<string, unknown>)["password_disabled"] === true,
        }
      : undefined;

  const userRaw = r["user"];
  const user: UserIdentity | undefined =
    userRaw && typeof userRaw === "object"
      ? {
          sub: String((userRaw as Record<string, unknown>)["sub"] ?? ""),
          email: String((userRaw as Record<string, unknown>)["email"] ?? ""),
          name: String((userRaw as Record<string, unknown>)["name"] ?? ""),
          role: String((userRaw as Record<string, unknown>)["role"] ?? ""),
          method: ((userRaw as Record<string, unknown>)["method"] as "password" | "oidc") ?? "password",
        }
      : undefined;

  return {
    required: result.required,
    authenticated: result.authenticated,
    setup_required: "setup_required" in result && result.setup_required === true,
    oidc,
    user,
  };
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

/** Redirect the browser to begin the OIDC login flow. */
export function startOidcLogin(): void {
  window.location.href = apiUrl("/api/auth/oidc/start");
}

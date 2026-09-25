import { apiUrl } from "@/lib/common/webPath";

export interface StartupAuthentication {
  required: boolean;
  authenticated: boolean;
  setup_required: boolean;
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
  };
}

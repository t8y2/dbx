import type { ConnectionConfig } from "@/types/database";

type PasswordAuthenticationConfig = Pick<ConnectionConfig, "db_type" | "driver_profile" | "url_params">;

function hiveServerUrlParams(urlParams?: string): Map<string, string> {
  const params = new Map<string, string>();
  for (const part of (urlParams || "").replace(/^[?&;]+|[?&;]+$/g, "").split(/[;&]/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const key = (equals < 0 ? trimmed : trimmed.slice(0, equals)).trim().toLowerCase();
    const value = (equals < 0 ? "" : trimmed.slice(equals + 1)).trim();
    if (key) params.set(key, value);
  }
  return params;
}

export function connectionUsesPasswordlessAuthentication(config: PasswordAuthenticationConfig): boolean {
  const profile = config.driver_profile || config.db_type;
  const isImpala = config.db_type === "impala" || profile === "impala";
  const isKyuubi = config.db_type === "kyuubi" || profile === "kyuubi";
  if (!isImpala && !isKyuubi) return false;

  const params = hiveServerUrlParams(config.url_params);
  if (params.get("principal")) return false;
  const auth = (params.get("auth") || (isKyuubi ? "none" : "nosasl")).toLowerCase();
  return isKyuubi ? auth === "none" || auth === "nosasl" : auth === "nosasl";
}

export function connectionNeedsPasswordPrompt(config: ConnectionConfig): boolean {
  return config.save_password === false && !config.password && !connectionUsesPasswordlessAuthentication(config);
}

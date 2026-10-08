import { apiUrl } from "@/lib/common/webPath";
import { normalizeStartupAuthentication, type StartupAuthentication } from "@/lib/startup/startupAuthentication";

/**
 * Auth endpoints report failures as `{"error": "<code>"}`; this error carries
 * the machine code so callers can translate it through the backend-error
 * catalog instead of guessing from the HTTP status alone.
 */
export class WebAuthError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null) {
    super(code ?? `Web authentication request failed (${status})`);
    this.name = "WebAuthError";
    this.status = status;
    this.code = code;
  }
}

async function parseErrorCode(response: Response): Promise<string | null> {
  try {
    const payload: unknown = await response.json();
    if (payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string") {
      return (payload as { error: string }).error;
    }
  } catch {
    // Not JSON (or unreadable) — fall through with no code.
  }
  return null;
}

async function postAuthPayload(path: string, body: Record<string, unknown>): Promise<StartupAuthentication> {
  const response = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new WebAuthError(response.status, await parseErrorCode(response));
  const normalized = normalizeStartupAuthentication(await response.json());
  if (!normalized) throw new WebAuthError(response.status, null);
  return normalized;
}

/** `POST /api/auth/login` — the session cookie is set by the response itself. */
export async function webLogin(username: string, password: string): Promise<StartupAuthentication> {
  return postAuthPayload("/api/auth/login", { username, password });
}

/** `POST /api/auth/setup` — creates the first administrator account. */
export async function webSetup(username: string, password: string): Promise<StartupAuthentication> {
  return postAuthPayload("/api/auth/setup", { username, password });
}

/** `POST /api/auth/change-password` — 200 `{"ok":true}` on success. */
export async function webChangePassword(oldPassword: string, newPassword: string): Promise<void> {
  const response = await fetch(apiUrl("/api/auth/change-password"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
  });
  if (!response.ok) throw new WebAuthError(response.status, await parseErrorCode(response));
}

/** `POST /api/auth/logout` — clears the server-side session cookie. */
export async function webLogout(): Promise<void> {
  const response = await fetch(apiUrl("/api/auth/logout"), { method: "POST", credentials: "same-origin" });
  if (!response.ok) throw new WebAuthError(response.status, await parseErrorCode(response));
}

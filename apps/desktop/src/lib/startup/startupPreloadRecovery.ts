const STARTUP_PRELOAD_RETRY_KEY = "dbx-startup-preload-retry";

interface StartupPreloadRecoveryEnvironment {
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  location: Pick<Location, "reload">;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return [error.message, error.stack].filter(Boolean).join("\n");
  return String(error);
}

export function retryStartupAfterPreloadFailure(error: unknown, env: StartupPreloadRecoveryEnvironment = window): boolean {
  if (!errorText(error).includes("Unable to preload CSS")) return false;
  try {
    if (env.sessionStorage.getItem(STARTUP_PRELOAD_RETRY_KEY) === "1") return false;
    env.sessionStorage.setItem(STARTUP_PRELOAD_RETRY_KEY, "1");
  } catch {
    return false;
  }
  env.location.reload();
  return true;
}

export function clearStartupPreloadRetry(env: Pick<StartupPreloadRecoveryEnvironment, "sessionStorage"> = window): void {
  try {
    env.sessionStorage.removeItem(STARTUP_PRELOAD_RETRY_KEY);
  } catch {
    // Storage can be unavailable in restricted WebView environments.
  }
}

import { isTauriRuntime } from "@/lib/backend/tauriRuntime";

export type AiRuntimeStrategy = "desktop-background" | "web-cancel-on-navigation";

/**
 * Keep the platform boundary in one place. Desktop owns a process-wide Tauri
 * event stream, while Web's POST/SSE response is still tied to the page request.
 */
export function resolveAiRuntimeStrategy(tauriRuntime = isTauriRuntime()): AiRuntimeStrategy {
  return tauriRuntime ? "desktop-background" : "web-cancel-on-navigation";
}

export function supportsBackgroundAiRuns(strategy = resolveAiRuntimeStrategy()): boolean {
  return strategy === "desktop-background";
}

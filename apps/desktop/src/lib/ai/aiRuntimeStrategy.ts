import { isTauriRuntime } from "@/lib/backend/tauriRuntime";
import { isDetachedWindow } from "@/lib/app/windowContext";

export type AiRuntimeStrategy = "desktop-background" | "desktop-cancel-on-close" | "web-cancel-on-navigation";

/**
 * The background run registry belongs to one webview. Detached windows use the
 * foreground path so opening their panel cannot recover or interrupt another
 * window's runs. Their requests are cancelled when the panel/window closes.
 */
export function resolveAiRuntimeStrategy(tauriRuntime = isTauriRuntime(), detachedWindow = isDetachedWindow()): AiRuntimeStrategy {
  if (!tauriRuntime) return "web-cancel-on-navigation";
  return detachedWindow ? "desktop-cancel-on-close" : "desktop-background";
}

export function supportsBackgroundAiRuns(strategy = resolveAiRuntimeStrategy()): boolean {
  return strategy === "desktop-background";
}

export const DEFAULT_REPEATED_ACTIVATION_WINDOW_MS = 500;

export interface ActionActivationGuard {
  lastActivatedAt?: number;
  running?: boolean;
}

function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

export function shouldSuppressRepeatedActivation(guard: ActionActivationGuard, now = nowMs(), windowMs = DEFAULT_REPEATED_ACTIVATION_WINDOW_MS): boolean {
  if (guard.lastActivatedAt !== undefined && now - guard.lastActivatedAt < windowMs) {
    return true;
  }
  guard.lastActivatedAt = now;
  return false;
}

export function suppressEvent(event: Event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation?.();
}

export function tryStartExclusiveActivation(guard: ActionActivationGuard): (() => void) | null {
  if (guard.running) return null;
  guard.running = true;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    guard.running = false;
  };
}

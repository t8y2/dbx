import { computed, ref } from "vue";
import { defineStore } from "pinia";
import * as api from "@/lib/backend/api";

export const WRITE_UNLOCK_ONE_MINUTE_SECS = 60;
export const WRITE_UNLOCK_FIVE_MINUTES_SECS = 300;
export type WriteUnlockDurationSecs = typeof WRITE_UNLOCK_ONE_MINUTE_SECS | typeof WRITE_UNLOCK_FIVE_MINUTES_SECS;

export interface ReadOnlyUnlockRequest {
  connectionId: string;
  connectionName?: string;
  sql?: string;
  source?: string;
}

interface QueuedUnlockRequest {
  request: ReadOnlyUnlockRequest;
  resolve: (confirmed: boolean) => void;
}

function applyRemaining(windows: Record<string, number>, connectionId: string, remainingMs: number, now = Date.now()): Record<string, number> {
  const next = { ...windows };
  if (remainingMs > 0) next[connectionId] = now + remainingMs;
  else delete next[connectionId];
  return next;
}

/**
 * Coordinates the read-only write-unlock dialog and per-connection countdown.
 * Expiry is compared against wall-clock `Date.now()` so backgrounded tabs still
 * expire; the backend Instant gate remains authoritative for actual writes.
 */
export const useReadOnlyUnlockStore = defineStore("readOnlyUnlock", () => {
  const pending = ref<ReadOnlyUnlockRequest>();
  const windows = ref<Record<string, number>>({});
  const nowMs = ref(Date.now());
  const queue: QueuedUnlockRequest[] = [];
  let resolvePending: ((confirmed: boolean) => void) | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let unlockInFlight = false;

  function touchNow() {
    nowMs.value = Date.now();
  }

  function pruneExpired(now = Date.now()) {
    const next: Record<string, number> = {};
    for (const [connectionId, expiresAt] of Object.entries(windows.value)) {
      if (expiresAt > now) next[connectionId] = expiresAt;
    }
    windows.value = next;
    if (!Object.keys(next).length) stopTicker();
  }

  function startTicker() {
    if (ticker !== undefined) return;
    ticker = setInterval(() => {
      touchNow();
      pruneExpired();
    }, 1000);
  }

  function stopTicker() {
    if (ticker === undefined) return;
    clearInterval(ticker);
    ticker = undefined;
  }

  // Always compare against the wall clock at call time: the ticker-fed `nowMs`
  // goes stale in throttled background tabs and would keep expired windows live.
  function remainingMs(connectionId: string, now = Date.now()): number {
    return Math.max(0, (windows.value[connectionId] ?? 0) - now);
  }

  function isUnlocked(connectionId: string, now = Date.now()): boolean {
    return remainingMs(connectionId, now) > 0;
  }

  function rememberWindow(connectionId: string, remaining: number) {
    windows.value = applyRemaining(windows.value, connectionId, remaining);
    touchNow();
    if (Object.keys(windows.value).length) startTicker();
    else stopTicker();
  }

  async function refreshFromBackend(connectionId: string): Promise<number> {
    const remaining = await api.connectionWriteUnlockState(connectionId);
    rememberWindow(connectionId, remaining);
    return remaining;
  }

  async function requestUnlock(request: ReadOnlyUnlockRequest): Promise<boolean> {
    if (isUnlocked(request.connectionId)) return true;
    try {
      const remaining = await refreshFromBackend(request.connectionId);
      if (remaining > 0) return true;
    } catch {
      // Backend remains the execution gate; continue to the confirm dialog.
    }
    return new Promise<boolean>((resolve) => {
      if (pending.value) {
        queue.push({ request, resolve });
        return;
      }
      beginRequest(request, resolve);
    });
  }

  function beginRequest(request: ReadOnlyUnlockRequest, resolve: (confirmed: boolean) => void) {
    pending.value = request;
    resolvePending = resolve;
  }

  function settle(confirmed: boolean) {
    const resolve = resolvePending;
    resolvePending = undefined;
    pending.value = undefined;
    resolve?.(confirmed);

    const next = queue.shift();
    if (next) {
      if (confirmed && isUnlocked(next.request.connectionId)) next.resolve(true);
      else beginRequest(next.request, next.resolve);
    }
  }

  async function confirm(durationSecs: WriteUnlockDurationSecs) {
    const request = pending.value;
    if (!request || unlockInFlight) return;
    unlockInFlight = true;
    try {
      const remaining = await api.unlockConnectionWrites(request.connectionId, durationSecs);
      rememberWindow(request.connectionId, remaining);
      settle(true);
    } catch {
      // Keep the dialog open so the user can retry or cancel.
    } finally {
      unlockInFlight = false;
    }
  }

  function cancel() {
    settle(false);
  }

  async function lockNow(connectionId: string) {
    await api.lockConnectionWrites(connectionId);
    rememberWindow(connectionId, 0);
  }

  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      touchNow();
      pruneExpired();
      if (document.visibilityState !== "visible") return;
      for (const connectionId of Object.keys(windows.value)) {
        void refreshFromBackend(connectionId);
      }
    });
  }

  const unlockedConnectionIds = computed(() => Object.keys(windows.value).filter((id) => isUnlocked(id)));

  return {
    pending,
    windows,
    nowMs,
    unlockedConnectionIds,
    remainingMs,
    isUnlocked,
    requestUnlock,
    confirm,
    cancel,
    lockNow,
    refreshFromBackend,
    rememberWindow,
  };
});

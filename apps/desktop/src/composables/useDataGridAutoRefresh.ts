import { onBeforeUnmount, ref, type ComputedRef } from "vue";

export interface UseDataGridAutoRefreshOptions {
  canRefresh: ComputedRef<boolean>;
  refresh: () => void | Promise<void>;
  initialIntervalSeconds?: number;
}

export function useDataGridAutoRefresh(options: UseDataGridAutoRefreshOptions) {
  const intervalSeconds = ref(options.initialIntervalSeconds ?? 10);
  const enabled = ref(false);
  // Bumped whenever the countdown is (re)armed: when the timer is started and on
  // every tick. The toolbar keys its single-sweep clock hand off this, so the
  // sweep restarts in phase with the real timer instead of free-running.
  const sweepKey = ref(0);
  let timer: ReturnType<typeof setInterval> | undefined;

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function tick() {
    // The sweep restarts even when the refresh itself is skipped: the timer is
    // still counting down to the next attempt.
    sweepKey.value += 1;
    if (!enabled.value || !options.canRefresh.value) return;
    void options.refresh();
  }

  function start() {
    stop();
    if (!enabled.value) return;
    sweepKey.value += 1;
    timer = setInterval(tick, intervalSeconds.value * 1000);
  }

  function setIntervalSeconds(seconds: number) {
    intervalSeconds.value = seconds;
    if (enabled.value) start();
  }

  function toggle() {
    enabled.value = !enabled.value;
    if (enabled.value) start();
    else stop();
  }

  onBeforeUnmount(stop);

  return {
    intervalSeconds,
    enabled,
    sweepKey,
    start,
    stop,
    setIntervalSeconds,
    toggle,
  };
}

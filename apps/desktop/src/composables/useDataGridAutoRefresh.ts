import { onBeforeUnmount, ref, type ComputedRef } from "vue";

export interface UseDataGridAutoRefreshOptions {
  canRefresh: ComputedRef<boolean>;
  refresh: () => void | Promise<void>;
  initialIntervalSeconds?: number;
}

export function useDataGridAutoRefresh(options: UseDataGridAutoRefreshOptions) {
  const intervalSeconds = ref(options.initialIntervalSeconds ?? 10);
  const enabled = ref(false);
  let timer: ReturnType<typeof setInterval> | undefined;

  function stop() {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function tick() {
    if (!enabled.value || !options.canRefresh.value) return;
    void options.refresh();
  }

  function start() {
    stop();
    if (!enabled.value) return;
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
    start,
    stop,
    setIntervalSeconds,
    toggle,
  };
}

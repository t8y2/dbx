import { computed, nextTick } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDataGridAutoRefresh } from "@/composables/useDataGridAutoRefresh";

describe("useDataGridAutoRefresh", () => {
  afterEach(() => vi.useRealTimers());

  it("refreshes on the configured interval when enabled", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const autoRefresh = useDataGridAutoRefresh({ canRefresh: computed(() => true), refresh, initialIntervalSeconds: 5 });

    autoRefresh.toggle();
    vi.advanceTimersByTime(5000);
    await nextTick();

    expect(refresh).toHaveBeenCalledOnce();
    autoRefresh.stop();
  });

  it("does not refresh while the operation is unavailable", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const autoRefresh = useDataGridAutoRefresh({ canRefresh: computed(() => false), refresh, initialIntervalSeconds: 1 });

    autoRefresh.toggle();
    vi.advanceTimersByTime(1000);

    expect(refresh).not.toHaveBeenCalled();
    autoRefresh.stop();
  });

  it("bumps the sweep key when the countdown is armed and on every tick", () => {
    vi.useFakeTimers();
    const autoRefresh = useDataGridAutoRefresh({ canRefresh: computed(() => true), refresh: vi.fn(), initialIntervalSeconds: 5 });

    expect(autoRefresh.sweepKey.value).toBe(0);

    autoRefresh.toggle();
    expect(autoRefresh.sweepKey.value).toBe(1);

    vi.advanceTimersByTime(5000);
    expect(autoRefresh.sweepKey.value).toBe(2);

    vi.advanceTimersByTime(5000);
    expect(autoRefresh.sweepKey.value).toBe(3);

    autoRefresh.stop();
  });

  it("bumps the sweep key when the interval changes while enabled", () => {
    vi.useFakeTimers();
    const autoRefresh = useDataGridAutoRefresh({ canRefresh: computed(() => true), refresh: vi.fn(), initialIntervalSeconds: 5 });

    autoRefresh.toggle();
    expect(autoRefresh.sweepKey.value).toBe(1);

    autoRefresh.setIntervalSeconds(30);
    expect(autoRefresh.sweepKey.value).toBe(2);
    expect(autoRefresh.intervalSeconds.value).toBe(30);

    autoRefresh.stop();
  });

  it("keeps sweeping through skipped refreshes and freezes once disabled", () => {
    vi.useFakeTimers();
    const autoRefresh = useDataGridAutoRefresh({ canRefresh: computed(() => false), refresh: vi.fn(), initialIntervalSeconds: 1 });

    autoRefresh.toggle();
    vi.advanceTimersByTime(2000);
    expect(autoRefresh.sweepKey.value).toBe(3);

    autoRefresh.toggle();
    vi.advanceTimersByTime(5000);
    expect(autoRefresh.enabled.value).toBe(false);
    expect(autoRefresh.sweepKey.value).toBe(3);
  });
});

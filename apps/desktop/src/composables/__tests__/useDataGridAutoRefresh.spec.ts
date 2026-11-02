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

  it.each([5, 10, 30, 60, 300])("starts refreshing when the %i second interval is selected", (seconds) => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const autoRefresh = useDataGridAutoRefresh({ canRefresh: computed(() => true), refresh });

    autoRefresh.setIntervalSeconds(seconds);

    expect(autoRefresh.enabled.value).toBe(true);
    vi.advanceTimersByTime(seconds * 1000 - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(seconds * 1000);
    expect(refresh).toHaveBeenCalledTimes(2);
    autoRefresh.stop();
  });

  it("restarts refreshing when the same interval is selected after disabling", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const autoRefresh = useDataGridAutoRefresh({ canRefresh: computed(() => true), refresh, initialIntervalSeconds: 5 });

    autoRefresh.toggle();
    autoRefresh.toggle();
    vi.advanceTimersByTime(5000);
    expect(refresh).not.toHaveBeenCalled();

    autoRefresh.setIntervalSeconds(5);
    vi.advanceTimersByTime(5000);

    expect(autoRefresh.enabled.value).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    autoRefresh.stop();
  });

  it("replaces the running countdown when a different interval is selected", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const autoRefresh = useDataGridAutoRefresh({ canRefresh: computed(() => true), refresh, initialIntervalSeconds: 5 });

    autoRefresh.toggle();
    vi.advanceTimersByTime(4000);
    autoRefresh.setIntervalSeconds(10);
    vi.advanceTimersByTime(9999);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10000);
    expect(refresh).toHaveBeenCalledTimes(2);
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

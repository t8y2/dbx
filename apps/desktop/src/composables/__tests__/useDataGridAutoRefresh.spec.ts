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
});

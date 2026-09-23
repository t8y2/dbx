import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDelayedPreview } from "../delayedPreview";

describe("createDelayedPreview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces rapid pointer previews to the latest value", () => {
    const apply = vi.fn();
    const preview = createDelayedPreview(apply, 80);

    preview.schedule("first");
    preview.schedule("second");
    preview.schedule("last");
    vi.advanceTimersByTime(79);

    expect(apply).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("last");
  });

  it("cancels pending work before an immediate keyboard or selection preview", () => {
    const apply = vi.fn();
    const preview = createDelayedPreview(apply, 80);

    preview.schedule("pointer");
    preview.runNow("keyboard");
    vi.runAllTimers();

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith("keyboard");
  });

  it("does not apply a preview after cleanup", () => {
    const apply = vi.fn();
    const preview = createDelayedPreview(apply, 80);

    preview.schedule("stale");
    preview.cancel();
    vi.runAllTimers();

    expect(apply).not.toHaveBeenCalled();
  });
});

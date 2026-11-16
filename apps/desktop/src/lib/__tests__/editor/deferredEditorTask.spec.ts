import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredEditorTask } from "@/lib/editor/deferredEditorTask";

afterEach(() => vi.useRealTimers());

describe("deferred editor work", () => {
  it("does no work during sustained scrolling and processes the final viewport once", () => {
    vi.useFakeTimers();
    let viewport = 0;
    const publish = vi.fn(() => viewport);
    const task = createDeferredEditorTask(publish, 150);
    for (let frame = 0; frame < 100; frame++) {
      viewport = frame * 20;
      task.schedule();
      vi.advanceTimersByTime(16);
    }
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveReturnedWith(1980);
  });

  it("flushes pending work before an owner switch without a later duplicate", () => {
    vi.useFakeTimers();
    let owner = "old-tab";
    const publish = vi.fn(() => owner);
    const task = createDeferredEditorTask(publish, 150);
    task.schedule();
    task.flush();
    owner = "new-tab";
    vi.runAllTimers();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveReturnedWith("old-tab");
  });

  it("cancels semantic refreshes when the editor plugin is destroyed", () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const task = createDeferredEditorTask(refresh, 100);
    task.schedule();
    task.cancel();
    vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled();
  });
});

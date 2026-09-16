import { describe, expect, it, vi } from "vitest";
import { createAutosave } from "../docsAutosave";

const file = { formatVersion: 1 } as const;

describe("createAutosave", () => {
  it("coalesces rapid edits into one save", async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue(undefined);
    const autosave = createAutosave(save, 500);

    autosave.schedule(file);
    autosave.schedule(file);
    autosave.schedule(file);
    expect(save).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("surfaces a failure instead of swallowing it", async () => {
    // A silently swallowed write failure is the worst outcome this feature
    // can produce: the user keeps typing and believes their notes are saved.
    vi.useFakeTimers();
    const save = vi.fn().mockRejectedValue(new Error("disk full"));
    const autosave = createAutosave(save, 500);

    autosave.schedule(file);
    await vi.advanceTimersByTimeAsync(500);

    expect(autosave.status.value.state).toBe("failed");
    expect(autosave.status.value.message).toContain("disk full");
    vi.useRealTimers();
  });

  it("reports saved after a successful write", async () => {
    vi.useFakeTimers();
    const autosave = createAutosave(vi.fn().mockResolvedValue(undefined), 500);
    autosave.schedule(file);
    await vi.advanceTimersByTimeAsync(500);
    expect(autosave.status.value.state).toBe("saved");
    vi.useRealTimers();
  });

  it("never runs two saves concurrently", async () => {
    // flush() clears the timer, but a debounced write may already be awaiting
    // save. Starting a second one issues two concurrent writes of the same
    // file — a wasted round trip, a stale-write race, and the exact
    // concurrency that corrupts the notes file.
    let concurrent = 0;
    let maxConcurrent = 0;
    const save = vi.fn().mockImplementation(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
    });

    const autosave = createAutosave(save, 0);
    autosave.schedule(file);
    await Promise.all([autosave.flush(), autosave.flush(), autosave.flush()]);

    expect(maxConcurrent).toBe(1);
  });

  it("flush writes immediately without waiting for the timer", async () => {
    // The dialog calls this on close, so a note typed a moment earlier is
    // not lost to a pending debounce.
    const save = vi.fn().mockResolvedValue(undefined);
    const autosave = createAutosave(save, 500);
    autosave.schedule(file);
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
  });
});

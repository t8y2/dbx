import { describe, expect, it, vi } from "vitest";
import { createUiScaleApplyQueue } from "@/lib/app/uiScaleApplyQueue";

function deferred() {
  let resolve: (() => void) | undefined;
  return {
    promise: new Promise<void>((done) => {
      resolve = done;
    }),
    resolve: () => resolve?.(),
  };
}

describe("ui scale apply queue", () => {
  it("serializes zoom IPC and only publishes the newest completed target", async () => {
    const first = deferred();
    const latest = deferred();
    const apply = vi.fn((scale: number) => (scale === 0.75 ? first.promise : latest.promise));
    const applied = vi.fn();
    const queue = createUiScaleApplyQueue(apply, applied, vi.fn());

    queue.request(0.75);
    queue.request(1.25);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(0.75);

    first.resolve();
    await Promise.resolve();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(1.25);
    expect(applied).not.toHaveBeenCalled();

    latest.resolve();
    await queue.whenIdle();

    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith(1.25);
  });
});

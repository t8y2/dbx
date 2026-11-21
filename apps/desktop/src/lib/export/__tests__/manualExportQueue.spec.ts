import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManualExportMode, ManualExportQueueState } from "../manualExportQueue";

function operation(id: string, mode: ManualExportMode = "queued") {
  let finish!: (outcome: "settled" | "unknown") => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<"settled" | "unknown">((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const states: ManualExportQueueState[] = [];
  return {
    id,
    mode,
    run: vi.fn(() => completion),
    onStateChange: vi.fn((state: ManualExportQueueState) => states.push(state)),
    states,
    finish,
    fail,
  };
}

describe("manual export queue", () => {
  beforeEach(() => vi.resetModules());

  it("starts queued operations in FIFO order only after actual settlement", async () => {
    const { submitManualExport } = await import("../manualExportQueue");
    const a = operation("a");
    const b = operation("b");
    const c = operation("c");
    [a, b, c].forEach(submitManualExport);
    expect(a.run).toHaveBeenCalledOnce();
    expect(b.run).not.toHaveBeenCalled();
    expect(c.run).not.toHaveBeenCalled();
    a.finish("settled");
    await Promise.resolve();
    expect(b.run).toHaveBeenCalledOnce();
    expect(c.run).not.toHaveBeenCalled();
    b.finish("settled");
    await Promise.resolve();
    expect(c.run).toHaveBeenCalledOnce();
    c.finish("settled");
    await Promise.resolve();
  });

  it("keeps immediate exports independent but waits for all active exports before dequeuing", async () => {
    const { submitManualExport } = await import("../manualExportQueue");
    const a = operation("a");
    const b = operation("b");
    const immediate = operation("immediate", "immediate");
    submitManualExport(a);
    submitManualExport(b);
    submitManualExport(immediate);
    expect(immediate.run).toHaveBeenCalledOnce();
    a.finish("settled");
    await Promise.resolve();
    expect(b.run).not.toHaveBeenCalled();
    immediate.finish("settled");
    await Promise.resolve();
    expect(b.run).toHaveBeenCalledOnce();
    b.finish("settled");
    await Promise.resolve();
  });

  it("cancels a waiting operation without ever running it", async () => {
    const { submitManualExport } = await import("../manualExportQueue");
    const a = operation("a");
    const b = operation("b");
    submitManualExport(a);
    const handle = submitManualExport(b);
    expect(handle.cancelQueued()).toBe(true);
    expect(handle.cancelQueued()).toBe(false);
    expect(b.states).toEqual(["queued", "cancelled"]);
    a.finish("settled");
    await Promise.resolve();
    expect(b.run).not.toHaveBeenCalled();
  });

  it.each(["unknown", "rejected"])("does not release execution ownership after %s completion", async (outcome) => {
    const { submitManualExport } = await import("../manualExportQueue");
    const a = operation("a");
    const b = operation("b");
    submitManualExport(a);
    const waiting = submitManualExport(b);
    if (outcome === "unknown") a.finish("unknown");
    else a.fail(new Error("connection interrupted after starting"));
    await Promise.resolve();
    expect(a.states.at(-1)).toBe("unknown");
    expect(b.run).not.toHaveBeenCalled();
    expect(waiting.cancelQueued()).toBe(true);
  });

  it("starts the next queued operation once an unknown one is explicitly released", async () => {
    const { releaseManualExport, submitManualExport } = await import("../manualExportQueue");
    const a = operation("a");
    const b = operation("b");
    submitManualExport(a);
    submitManualExport(b);
    a.finish("unknown");
    await Promise.resolve();
    expect(b.run).not.toHaveBeenCalled();

    releaseManualExport("a");
    expect(b.run).toHaveBeenCalledOnce();
    expect(a.run).toHaveBeenCalledOnce();
    expect(a.states.at(-1)).toBe("unknown");

    b.finish("settled");
    await Promise.resolve();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqlAnalysisWorker } from "@/lib/sql/sqlAnalysisWorker";

class ControlledWorker {
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  reply(id: number, result: string) {
    this.onmessage?.call(this as unknown as Worker, { data: { id, result } } as MessageEvent);
  }

  fail() {
    this.onerror?.call(this as unknown as Worker, {} as ErrorEvent);
  }
}

afterEach(() => vi.unstubAllGlobals());

function harness() {
  vi.stubGlobal("Worker", ControlledWorker);
  const worker = new ControlledWorker();
  const create = vi.fn(() => worker as unknown as Worker);
  const fallback = vi.fn((input: string) => `fallback:${input}`);
  const service = createSqlAnalysisWorker(create, fallback);
  return { worker, create, fallback, service };
}

describe("SQL background analysis scheduling", () => {
  it("does not run analysis on the UI thread and reuses the worker", async () => {
    const { worker, create, fallback, service } = harness();
    const first = service.analyze("first");
    expect(fallback).not.toHaveBeenCalled();
    worker.reply(1, "first result");
    await expect(first).resolves.toBe("first result");
    const second = service.analyze("second");
    worker.reply(2, "second result");
    await expect(second).resolves.toBe("second result");
    expect(create).toHaveBeenCalledTimes(1);
    service.dispose();
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it("keeps at most the running request and the newest queued edit", async () => {
    const { worker, fallback, service } = harness();
    const first = service.analyze("first");
    const second = service.analyze("second");
    const third = service.analyze("third");
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    worker.reply(1, "obsolete");
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 3, input: "third" });
    worker.reply(2, "out of order");
    worker.reply(3, "current");
    await expect(third).resolves.toBe("current");
    expect(fallback).not.toHaveBeenCalled();
    service.dispose();
  });

  it("settles both requests when cancelled without losing the warm worker", async () => {
    const { worker, create, service } = harness();
    const first = service.analyze("first");
    const second = service.analyze("second");
    service.cancel();
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
    worker.reply(1, "obsolete");
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    const next = service.analyze("next");
    worker.reply(3, "next result");
    await expect(next).resolves.toBe("next result");
    expect(create).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it("ignores late events after disposal", async () => {
    const { worker, service, fallback } = harness();
    const pending = service.analyze("pending");
    service.dispose();
    worker.reply(1, "late");
    worker.fail();
    await expect(pending).resolves.toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it("falls back only for the newest request when a worker fails", async () => {
    const { worker, service, fallback } = harness();
    const first = service.analyze("first");
    const latest = service.analyze("latest");
    worker.fail();
    await expect(first).resolves.toBeNull();
    await expect(latest).resolves.toBe("fallback:latest");
    expect(fallback.mock.calls).toEqual([["latest"]]);
    await expect(service.analyze("next")).resolves.toBe("fallback:next");
  });

  it("preserves functionality when worker construction or message cloning fails", async () => {
    const { worker, service, fallback } = harness();
    worker.postMessage.mockImplementation(() => {
      throw new Error("clone failed");
    });
    await expect(service.analyze("clone")).resolves.toBe("fallback:clone");
    const unavailable = createSqlAnalysisWorker(() => {
      throw new Error("blocked by CSP");
    }, fallback);
    await expect(unavailable.analyze("CSP")).resolves.toBe("fallback:CSP");
  });

  it("uses the caller's editor-aware fallback and handles its exceptions", async () => {
    vi.stubGlobal("Worker", undefined);
    const create = vi.fn();
    const service = createSqlAnalysisWorker<string, string>(create, () => "default");
    await expect(service.analyze("SQL", () => "editor state")).resolves.toBe("editor state");
    await expect(
      service.analyze("invalid", () => {
        throw new Error("invalid");
      }),
    ).resolves.toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireUpdateBarrier, assertUpdateSafe } from "../updatePreparation";
import { openDetachedTabWindow } from "../detachedTabWindow";
const mocks = vi.hoisted(() => ({ getByLabel: vi.fn(), created: vi.fn(), callbacks: new Map<string, (event?: unknown) => unknown>(), show: vi.fn(), focus: vi.fn(), destroy: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/lib/app/windowContext", () => ({ detachedWindowLabel: (id: string) => `detached-${id}`, detachedWindowUrl: () => "http://localhost/" }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    static getByLabel = mocks.getByLabel;
    constructor() {
      mocks.created();
    }
    once(event: string, callback: (event?: unknown) => unknown) {
      mocks.callbacks.set(event, callback);
      return Promise.resolve(() => {});
    }
    show = mocks.show;
    setFocus = mocks.focus;
    destroy = mocks.destroy;
  },
}));
afterEach(() => {
  vi.clearAllMocks();
  mocks.callbacks.clear();
  vi.useRealTimers();
});
function pendingLookup() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  mocks.getByLabel.mockReturnValueOnce(promise);
  return resolve;
}
describe("detached window update exclusion", () => {
  it("grants the capability required to remove never-shown late windows", () => {
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8"));
    expect(capability.permissions).toContain("core:window:allow-destroy");
  });

  it("blocks update preparation while the asynchronous existing-window lookup is pending", async () => {
    const resolve = pendingLookup();
    const operation = openDetachedTabWindow("one", "SQL");
    await vi.waitFor(() => expect(mocks.getByLabel).toHaveBeenCalled());
    expect(assertUpdateSafe).toThrow("window operation");
    resolve({ show: async () => {}, setFocus: async () => {} });
    expect(await operation).toEqual({ opened: true });
    expect(assertUpdateSafe).not.toThrow();
  });
  it("does not create a window if preparation starts during the awaited lookup", async () => {
    const resolve = pendingLookup();
    const operation = openDetachedTabWindow("two", "SQL");
    await vi.waitFor(() => expect(mocks.getByLabel).toHaveBeenCalled());
    const release = acquireUpdateBarrier();
    resolve(null);
    const result = await operation;
    expect(result.opened).toBe(false);
    expect(result.error).toContain("Update preparation");
    expect(mocks.created).not.toHaveBeenCalled();
    release();
    expect(assertUpdateSafe).not.toThrow();
  });
  it("keeps a timed-out native creation blocked and closes a late child without showing it", async () => {
    vi.useFakeTimers();
    mocks.getByLabel.mockResolvedValueOnce(null);
    mocks.destroy.mockResolvedValue(undefined);
    const operation = openDetachedTabWindow("late", "SQL");
    await vi.waitFor(() => expect(mocks.created).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await operation).opened).toBe(false);
    expect(assertUpdateSafe).toThrow("window operation");
    await mocks.callbacks.get("tauri://created")?.();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(assertUpdateSafe).not.toThrow();
  });
  it("rejects a new detach before starting native lookup while preparation is active", async () => {
    const release = acquireUpdateBarrier();
    expect((await openDetachedTabWindow("three", "SQL")).opened).toBe(false);
    expect(mocks.getByLabel).not.toHaveBeenCalled();
    release();
    expect(assertUpdateSafe).not.toThrow();
  });
});

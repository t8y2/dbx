import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import type { PlDebugCompileIntent, PlDebugCompileReceipt } from "@/lib/debug/plDebugProtocol";

const api = vi.hoisted(() => ({ plDebugBootstrap: vi.fn(), plDebugCompile: vi.fn(), plDebugCompileStatus: vi.fn() }));
const guard = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/backend/api", () => api);
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "conn", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => guard.run(options) }));
import { usePlDebugStore } from "../plDebugStore";

let pinia: ReturnType<typeof createPinia>;
let storage: Map<string, string>;
function newStore() {
  if (pinia) disposePinia(pinia);
  pinia = createPinia();
  setActivePinia(pinia);
  return usePlDebugStore();
}
const request = {
  connectionId: "conn",
  database: "APP",
  target: { schema: "APP", objectType: "PROCEDURE", objectName: "P" },
  preview: { schema: "APP", objectName: "P", objectType: "PROCEDURE" as const, sql: 'ALTER PROCEDURE "APP"."P" COMPILE DEBUG REUSE SETTINGS', reusesSettings: true, sources: [], canCompile: true, state: "available" as const },
  expectedConnectionRevision: "revision",
  confirmed: true,
};
function receipt(intent: PlDebugCompileIntent, overrides: Partial<PlDebugCompileReceipt> = {}): PlDebugCompileReceipt {
  return {
    serverEpoch: intent.serverEpoch,
    operationId: intent.operationId,
    connectionId: intent.connectionId,
    clientSessionId: intent.clientSessionId,
    dispatched: true,
    ddlState: "executed",
    finished: true,
    releaseState: "released",
    error: null,
    cleanupError: null,
    result: { readback: { status: "INVALID" } },
    ...overrides,
  };
}
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  vi.clearAllMocks();
  api.plDebugBootstrap.mockResolvedValue({ serverEpoch: "epoch" });
  api.plDebugCompile.mockImplementation(async (intent) => receipt(intent));
  guard.run.mockImplementation((options: { execute: () => Promise<unknown> }) => options.execute());
});
afterEach(() => {
  if (pinia) disposePinia(pinia);
  vi.unstubAllGlobals();
});

describe("explicit debug compilation recovery", () => {
  it("persists only the original reference before sending and preserves INVALID diagnostics", async () => {
    const store = newStore();
    api.plDebugCompile.mockImplementation(async (intent) => {
      expect(JSON.parse(storage.get("dbx:pl-debug:recovery:v1")!).compilationRef.operationId).toBe(intent.operationId);
      expect(storage.get("dbx:pl-debug:recovery:v1")).not.toContain(request.preview.sql);
      return receipt(intent);
    });
    const result = await store.compileDebug(request, () => true);
    expect(result?.result?.readback).toEqual({ status: "INVALID" });
    expect(store.compilationUnresolved).toBe(false);
    expect(guard.run.mock.calls[0]![0].reviewText).toBe(request.preview.sql);
    expect(api.plDebugCompile).toHaveBeenCalledTimes(1);
  });

  it("restores a lost response after reload by status only, never resubmitting DDL", async () => {
    let original!: PlDebugCompileIntent;
    api.plDebugCompile.mockImplementation(async (intent) => {
      original = intent;
      throw new Error("response lost");
    });
    await expect(newStore().compileDebug(request, () => true)).rejects.toThrow("response lost");
    const restored = newStore();
    expect(restored.compilationUnresolved).toBe(true);
    await expect(restored.compileDebug(request, () => true)).rejects.toThrow("original compilation");
    api.plDebugCompileStatus.mockResolvedValue(receipt(original));
    await restored.recoverCompilation();
    expect(restored.compilationUnresolved).toBe(false);
    expect(api.plDebugCompile).toHaveBeenCalledTimes(1);
    expect(api.plDebugCompileStatus).toHaveBeenCalledWith(restored.compilationRef);
  });

  it.each([{ ddlState: "unknown" as const }, { releaseState: "unconfirmed" as const }, { finished: false }])("retains unresolved occupancy for %j", async (state) => {
    api.plDebugCompile.mockImplementation(async (intent) => receipt(intent, state));
    const store = newStore();
    await store.compileDebug(request, () => true);
    expect(store.compilationUnresolved).toBe(true);
    await expect(store.compileDebug(request, () => true)).rejects.toThrow("original compilation");
    expect(api.plDebugCompile).toHaveBeenCalledTimes(1);
  });

  it("cancels or rejects a changed confirmation without saving a write operation", async () => {
    const store = newStore();
    guard.run.mockResolvedValueOnce(undefined);
    expect(await store.compileDebug(request, () => true)).toBeUndefined();
    await expect(store.compileDebug(request, () => false)).rejects.toThrow("preview changed");
    expect(store.compilationRef).toBeNull();
    expect(api.plDebugCompile).not.toHaveBeenCalled();
  });

  it("does not accept another operation's receipt or discard the saved original", async () => {
    api.plDebugCompile.mockImplementation(async (intent) => receipt(intent, { operationId: "foreign" }));
    const store = newStore();
    await expect(store.compileDebug(request, () => true)).rejects.toThrow("original operation");
    expect(store.compilationRef?.operationId).not.toBe("foreign");
    expect(store.compilationUnresolved).toBe(true);
  });

  it.each(["not_started", "unknown"] as const)("only clears the reference on authoritative %s admission evidence", async (operationOutcome) => {
    api.plDebugCompile.mockRejectedValue({ version: 1, code: "DBX-PLDEBUG-1001", messageKey: "backendErrors.plDebug.admissionRejected", messageParams: {}, source: "legacyBackend", origin: { subsystem: "backend", adapter: "legacy" }, operationOutcome, detail: "admission rejected" });
    const store = newStore();
    await expect(store.compileDebug(request, () => true)).rejects.toBeDefined();
    expect(store.compilationRef === null).toBe(operationOutcome === "not_started");
    expect(JSON.parse(storage.get("dbx:pl-debug:recovery:v1")!).compilationRef === null).toBe(operationOutcome === "not_started");
  });
});

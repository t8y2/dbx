import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlDebugStartIntent, PlDebugOperationRequest, PlDebugReadRequest, PlDebugInspectRequest, PlDebugCompileIntent, PlDebugCompileRef } from "@/lib/debug/plDebugProtocol";

const mocks = vi.hoisted(() => ({ desktop: false, invoke: vi.fn(), log: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => mocks.desktop }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: mocks.log, isDebugLoggingEnabled: () => true }));
vi.mock("@/lib/app/updatePreparation", () => ({ assertUpdateAllowsCommand: vi.fn() }));

const reference = { serverEpoch: "epoch", sessionId: "session", connectionId: "conn", clientSessionId: "editor" };
const inspect = { connectionId: "conn", database: "APP", clientSessionId: "editor", target: { objectType: "FUNCTION" as const, objectName: "Exact.Name", schema: " Mixed Owner ", packageName: "Quoted.Package" } };
const compileInspect: PlDebugInspectRequest = { ...inspect, target: { ...inspect.target, metadataPreparation: "debug_compile" } };
const compile: PlDebugCompileIntent = {
  ...inspect,
  serverEpoch: "epoch",
  operationId: "compile-once",
  expectedConnectionRevision: "revision",
  confirmed: true,
  productionConfirmed: false,
  preview: { schema: " Mixed Owner ", objectName: "Quoted.Package", objectType: "PACKAGE BODY", sql: "ALTER PACKAGE private_value COMPILE DEBUG BODY", reusesSettings: false, sources: [{ source: "private_value" }], canCompile: true, state: "available" },
};
const compileReference: PlDebugCompileRef = { serverEpoch: "epoch", operationId: "compile-once", connectionId: "conn", clientSessionId: "editor" };
const start: PlDebugStartIntent = {
  serverEpoch: "epoch",
  operationId: "start-once",
  connectionId: "conn",
  database: "APP",
  clientSessionId: "editor",
  target: { source: "BEGIN private_value; END;" },
  riskAccepted: true,
  productionConfirmed: false,
};
const typedStart: PlDebugStartIntent = {
  ...start,
  target: {
    objectType: "PROCEDURE",
    params: [
      { name: "N", mode: "IN", type: "NUMBER", typedValue: { kind: "number", value: "12345678901234567890.123400" } },
      { name: "T", mode: "IN", type: "VARCHAR2", typedValue: { kind: "text", value: "  private_value 中\n  " } },
      { name: "B", mode: "IN", type: "PL/SQL BOOLEAN", typedValue: { kind: "boolean", value: false } },
    ],
  },
};
const operation: PlDebugOperationRequest = {
  ...reference,
  operationId: "write-once",
  expectedRevision: 7,
  generation: 2,
  action: "execute",
  params: { sql: "BEGIN private_value; END;", stopRevision: 4 },
  productionConfirmed: true,
};
const read: PlDebugReadRequest = { ...reference, generation: 2, stopRevision: 4, kind: "value", params: { name: "N", frame: 1 } };
const results: PlDebugReadRequest = { ...reference, generation: 2, kind: "results", params: {} };
const resultPage: PlDebugReadRequest = { ...reference, generation: 1, kind: "result_page", params: { generation: "original-result-generation", resultId: "retained-result", offset: 65535, limit: 32000 } };
type Api = typeof import("../api");
const cases: Array<{
  path: string;
  command: string;
  body: unknown;
  args?: Record<string, unknown>;
  call: (api: Api) => Promise<unknown>;
}> = [
  { path: "bootstrap", command: "pl_debug_bootstrap", body: {}, call: (api) => api.plDebugBootstrap() },
  { path: "inspect", command: "pl_debug_inspect", body: inspect, args: { request: inspect }, call: (api) => api.plDebugInspect(inspect) },
  { path: "inspect", command: "pl_debug_inspect", body: compileInspect, args: { request: compileInspect }, call: (api) => api.plDebugInspect(compileInspect) },
  { path: "compile", command: "pl_debug_compile", body: compile, args: { request: compile }, call: (api) => api.plDebugCompile(compile) },
  { path: "compile-status", command: "pl_debug_compile_status", body: compileReference, args: { reference: compileReference }, call: (api) => api.plDebugCompileStatus(compileReference) },
  { path: "list", command: "pl_debug_list", body: { serverEpoch: "epoch", connectionId: "conn" }, args: { serverEpoch: "epoch", connectionId: "conn" }, call: (api) => api.plDebugList("epoch", "conn") },
  { path: "start", command: "pl_debug_start", body: start, args: { request: start }, call: (api) => api.plDebugStart(start) },
  { path: "start", command: "pl_debug_start", body: typedStart, args: { request: typedStart }, call: (api) => api.plDebugStart(typedStart) },
  { path: "status", command: "pl_debug_status", body: { reference, refresh: false }, args: { reference, refresh: false }, call: (api) => api.plDebugStatus(reference) },
  { path: "heartbeat", command: "pl_debug_heartbeat", body: reference, args: { reference }, call: (api) => api.plDebugHeartbeat(reference) },
  { path: "operation", command: "pl_debug_operation", body: { reference, operationId: "write-once" }, args: { reference, operationId: "write-once" }, call: (api) => api.plDebugOperation(reference, "write-once") },
  { path: "operate", command: "pl_debug_operate", body: operation, args: { request: operation }, call: (api) => api.plDebugOperate(operation) },
  { path: "read", command: "pl_debug_read", body: read, args: { request: read }, call: (api) => api.plDebugRead(read) },
  { path: "read", command: "pl_debug_read", body: results, args: { request: results }, call: (api) => api.plDebugRead(results) },
  { path: "read", command: "pl_debug_read", body: resultPage, args: { request: resultPage }, call: (api) => api.plDebugRead(resultPage) },
];

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllGlobals());

describe.each([false, true])("PL debug public API (desktop=%s)", (desktop) => {
  beforeEach(() => {
    mocks.desktop = desktop;
  });

  it.each(cases)("transmits $path once with its unchanged execution identity", async ({ path, command, body, args, call }) => {
    const result = { state: "unknown", dispatched: true, operationId: "write-once", private_value: "retained only in result" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(result), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockResolvedValue(result);
    const api = await import("../api");
    await expect(call(api)).resolves.toEqual(result);
    if (desktop) {
      expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(command, args);
      expect(fetchMock).not.toHaveBeenCalled();
    } else {
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`/api/pl-debug/${path}`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual(body);
      expect(mocks.invoke).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("private_value");
  });

  it("surfaces a lost write response without retrying or logging SQL/values", async () => {
    const failure = new Error("private_value was returned in a backend diagnostic");
    const fetchMock = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockRejectedValue(failure);
    const api = await import("../api");
    if (desktop) await expect(api.plDebugOperate(operation)).rejects.toMatchObject({ message: failure.message, backendError: { code: "DBX-LEGACY-0001", operationOutcome: "unknown" } });
    else await expect(api.plDebugOperate(operation)).rejects.toBe(failure);
    expect(desktop ? mocks.invoke : fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("private_value");
  });

  it("keeps a lost compilation response unknown without submitting the DDL again", async () => {
    const failure = new Error("private_value was returned in a compile diagnostic");
    const fetchMock = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockRejectedValue(failure);
    const api = await import("../api");
    await expect(api.plDebugCompile(compile)).rejects.toThrow(failure.message);
    expect(desktop ? mocks.invoke : fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.log.mock.calls)).not.toContain("private_value");
  });

  it.each(["start", "operate"] as const)("normalizes the authoritative %s admission rejection without retrying", async (method) => {
    const envelope = { version: 1, code: "DBX-PLDEBUG-1001", messageKey: "backendErrors.plDebug.admissionRejected", messageParams: {}, source: "legacyBackend", origin: { subsystem: "backend", adapter: "legacy" }, operationOutcome: "not_started", detail: "connection changed" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(envelope), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    mocks.invoke.mockRejectedValue(JSON.stringify(envelope));
    const api = await import("../api");
    const result = method === "start" ? api.plDebugStart(start) : api.plDebugOperate(operation);
    await expect(result).rejects.toMatchObject({ backendError: envelope });
    expect(desktop ? mocks.invoke : fetchMock).toHaveBeenCalledOnce();
  });
});

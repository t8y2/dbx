import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import type { PlDebugReceipt, PlDebugSnapshot, PlDebugStartIntent } from "@/lib/debug/plDebugProtocol";

const guard = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "conn", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: unknown) => guard.run(options) }));

import { usePlDebugStore } from "../plDebugStore";

const request = { objectType: "ANONYMOUS", source: "BEGIN NULL; END;", schema: "APP" };
const confirmation = { riskAccepted: true, expectedConnectionRevision: "epoch:0" };
let pinia: ReturnType<typeof createPinia>;
let epoch: string;
let snapshot: PlDebugSnapshot | null;
let start: PlDebugStartIntent | null;
let loseStart: boolean;
let loseClose: boolean;
let loseControl: boolean;
let startFailed: boolean;
let readResult: ((body: Record<string, unknown>) => unknown) | null;
let operationResult: unknown;
let operationState: PlDebugReceipt["state"];
let exceptionStateOverride: boolean | undefined;
let rejectSubmission: { path: "start" | "operate" | "operation"; code: string; operationOutcome: "not_started" | "unknown" } | null;
let fetchMock: ReturnType<typeof vi.fn>;
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const receipts = new Map<string, PlDebugReceipt>();

function newStore() {
  if (pinia) disposePinia(pinia);
  pinia = createPinia();
  setActivePinia(pinia);
  return usePlDebugStore();
}

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  calls.length = 0;
  receipts.clear();
  epoch = "epoch";
  snapshot = null;
  start = null;
  loseStart = false;
  loseClose = false;
  loseControl = false;
  startFailed = false;
  readResult = null;
  operationResult = undefined;
  operationState = "succeeded";
  exceptionStateOverride = undefined;
  rejectSubmission = null;
  guard.run.mockImplementation((options: { execute: () => Promise<unknown> }) => options.execute());
  fetchMock = vi.fn(async (url: string, options: RequestInit) => {
    const path = url.split("/").pop()!;
    const body = JSON.parse(String(options.body));
    calls.push({ path, body });
    if (rejectSubmission?.path === path)
      return new Response(
        JSON.stringify({
          version: 1,
          code: rejectSubmission.code,
          messageKey: "backendErrors.plDebug.admissionRejected",
          messageParams: {},
          source: "legacyBackend",
          origin: { subsystem: "backend", adapter: "legacy" },
          operationOutcome: rejectSubmission.operationOutcome,
          detail: "The debug state changed",
        }),
        { status: 409 },
      );
    let result: unknown;
    if (path === "bootstrap") result = { serverEpoch: epoch, heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 };
    else if (path === "start") {
      start = body as PlDebugStartIntent;
      snapshot = {
        serverEpoch: epoch,
        sessionId: "original-session",
        connectionId: start.connectionId,
        database: start.database,
        clientSessionId: start.clientSessionId,
        startOperationId: start.operationId,
        generation: 1,
        revision: 2,
        state: startFailed ? "unknown" : "paused",
        startState: startFailed ? "failed" : "succeeded",
        startError: startFailed ? "native start refused" : "",
        executionOutcome: startFailed ? "not_started" : "pending",
        executionStopped: false,
        releaseState: "open",
        transactionOutcome: "not_started",
        runtimeExited: false,
        closing: false,
        activeOperationId: null,
        stopRevision: 1,
        target: start.target,
        line: "7",
        exceptionBreakpoint: false,
      };
      result = { serverEpoch: epoch, sessionId: snapshot.sessionId, operationId: start.operationId, generation: 1, revision: 2, state: "succeeded", dispatched: true, result: snapshot, error: null } satisfies PlDebugReceipt;
      receipts.set(start.operationId, result as PlDebugReceipt);
      if (loseStart) throw new TypeError("start response lost");
    } else if (path === "list") result = snapshot ? [{ ...snapshot, sessionId: "decoy", clientSessionId: "other-workspace" }, snapshot] : [];
    else if (path === "status" || path === "heartbeat") result = snapshot;
    else if (path === "operation") result = receipts.get(String(body.operationId));
    else if (path === "read") result = readResult ? await readResult(body) : { output: "one\n\n中😀\n", outputComplete: true, outputTruncated: false, outputError: null };
    else if (path === "operate") {
      const ending = body.action === "close" || body.action === "abort";
      snapshot = {
        ...snapshot!,
        generation: snapshot!.generation + (body.action === "restart" ? 1 : 0),
        startState: "succeeded",
        state: ending ? "ended" : "paused",
        executionOutcome: ending ? "cancelled" : "pending",
        executionStopped: ending,
        releaseState: body.action === "close" ? "released" : "open",
        runtimeExited: body.action === "close",
        revision: snapshot!.revision + 1,
        stopRevision: ending ? snapshot!.stopRevision : Number(snapshot!.stopRevision) + 1,
        line: ending ? null : "8",
        exceptionBreakpoint: body.action === "set_exception_breakpoint" && operationState === "succeeded" ? (exceptionStateOverride ?? (body.params as Record<string, unknown>).enabled === true) : snapshot!.exceptionBreakpoint,
      };
      result = {
        serverEpoch: epoch,
        sessionId: snapshot.sessionId,
        operationId: String(body.operationId),
        generation: snapshot.generation,
        revision: snapshot.revision,
        state: operationState,
        dispatched: true,
        result: operationResult ?? snapshot,
        error: operationState === "failed" ? { message: "native assignment refused" } : null,
      } satisfies PlDebugReceipt;
      receipts.set(String(body.operationId), result as PlDebugReceipt);
      if (body.action === "close" && loseClose) throw new TypeError("close response lost");
      if (body.action !== "close" && loseControl) throw new TypeError("control response lost");
    } else throw new Error(`unexpected request ${path}`);
    return new Response(JSON.stringify(result), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  newStore();
});

afterEach(() => {
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

describe("public debugger start and original-identity recovery", () => {
  it.each(["empty", "running", "unknown", "ended", "generation", "stop"])("does not retain structured frames across an authoritative %s update", async (change) => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    readResult = () => ({ stopRevision: 1, frames: [{ frameIndex: 0, nativeFrameId: 2, program: "OLD" }] });
    await store.refreshStack();
    snapshot = { ...snapshot!, revision: snapshot!.revision + 1 };
    if (change === "empty") snapshot.frames = [];
    else if (change === "generation") snapshot.generation += 1;
    else if (change === "stop") snapshot.stopRevision = 2;
    else snapshot.state = change as "running" | "unknown" | "ended";
    await store.recover().catch(() => undefined);
    expect(store.status?.frames ?? []).toEqual([]);
  });

  it("retains complete source references through same-stop status recovery and frame selection", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const frames = [{ frameIndex: 0, nativeFrameId: 2, program: "PKG.RUN", sourceState: "resolved", sourceRef: { id: "s:target", nativeFrameId: 2, stopRevision: 1, sourceRevision: 1, source: "BEGIN NULL; END;" } }];
    readResult = (body) => (body.kind === "stack" ? { stopRevision: 1, frames } : { stopRevision: 1, variables: [] });
    await store.refreshStack();
    snapshot = { ...snapshot!, revision: snapshot!.revision + 1 };
    await store.recover();
    await store.selectFrame(1);
    expect(store.status?.frames).toEqual(frames);
    expect(store.currentFrame).toBe(1);
    expect(store.stopSeq).toBe(1);
  });

  it("keeps partial stack errors and clears invalid current reads without retaining source views", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    readResult = () => ({ stopRevision: 1, frames: [{ frameIndex: 0, nativeFrameId: 2, program: null }], backtrace: "raw", structuredBacktraceError: { message: "collection unavailable", sqlState: "HY001", vendorCode: 600 } });
    await store.refreshStack();
    expect(store.status?.frames).toHaveLength(1);
    expect(store.stackError).toBe("collection unavailable · HY001 · 600");
    store.showFrameSource({ frameIndex: 0, program: "P", line: 1, owner: "APP", name: "P", source: "old", error: null });
    readResult = () => ({ stopRevision: 1, frames: [] });
    await store.refreshStack();
    expect(store.status?.frames).toEqual([]);
    expect(store.frameSourceView).toBeNull();
    readResult = () => ({ stopRevision: 1, backtrace: "invalid" });
    await expect(store.refreshStack()).rejects.toThrow("no confirmed frame list");
    expect(store.status?.frames).toBeUndefined();
    expect(store.backtrace).toBe("");
    expect(store.stackError).toContain("no confirmed frame list");
  });

  it.each([false, true])("does not publish an older overlapping stack read or its failure: %s", async (fail) => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    let finish!: (value: unknown) => void;
    let reject!: (reason: Error) => void;
    readResult = () =>
      new Promise((resolve, failed) => {
        finish = resolve;
        reject = failed;
      });
    const older = store.refreshStack().catch((error) => error);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const frames = [{ frameIndex: 0, nativeFrameId: 2, program: "NEW" }];
    readResult = () => ({ stopRevision: 1, frames });
    await store.refreshStack();
    if (fail) reject(new Error("old read failed"));
    else finish({ stopRevision: 1, frames: [{ program: "OLD" }] });
    await older;
    expect(store.status?.frames).toEqual(frames);
    expect(store.stackError).toBeNull();
  });

  it("retains confirmed structured frames when a heartbeat refreshes the same stop", async () => {
    vi.useFakeTimers();
    try {
      const store = usePlDebugStore();
      await store.start("conn", "APP", request, confirmation);
      const frames = [{ frameIndex: 0, nativeFrameId: 2, program: "PKG.RUN", line: 7, identityState: "native", sourceState: "unknown" }];
      readResult = () => ({ stopRevision: 1, frames, backtrace: "[Line 7] PKG.RUN" });
      await store.refreshStack();
      expect(store.status?.frames).toEqual(frames);
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(calls.some((call) => call.path === "heartbeat")).toBe(true);
      expect(store.status?.frames).toEqual(frames);
      await store.stepOver();
      expect(store.status?.frames).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("discovers owned sessions without connecting and adopts only the explicitly selected original identity", async () => {
    await usePlDebugStore().start("conn", "APP", request, confirmation);
    const originalClient = snapshot!.clientSessionId;
    snapshot = { ...snapshot!, recovery: { version: 1, closeOperationId: null, operations: [{ operationId: "unknown-write", action: "set_value", requestGeneration: 1, receiptGeneration: 1, state: "unknown" }] } };
    receipts.set("unknown-write", { serverEpoch: epoch, sessionId: snapshot.sessionId, operationId: "unknown-write", generation: 1, revision: snapshot.revision, state: "unknown", dispatched: true, result: null, error: null });
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
    const store = newStore();
    calls.length = 0;
    const candidates = await store.discoverSessions("conn");
    expect(candidates).toHaveLength(2);
    expect(store.sessionRef).toBeNull();
    await store.adoptDiscoveredSession("original-session");
    expect(store.clientSessionId).toBe(originalClient);
    expect(store.sessionRef?.sessionId).toBe("original-session");
    expect(store.pendingOperations["unknown-write"]).toMatchObject({ generation: 1, action: "set_value", reference: { clientSessionId: originalClient } });
    expect(calls.every((call) => ["bootstrap", "list", "operation", "status"].includes(call.path))).toBe(true);
    expect(() => store.reset()).toThrow("unresolved");
  });

  it("keeps discovery from an older backend read-only across a refresh", async () => {
    await usePlDebugStore().start("conn", "APP", request, confirmation);
    const storage = new Map<string, string>();
    vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
    const store = newStore();
    await store.discoverSessions("conn");
    await store.adoptDiscoveredSession("original-session");
    expect(store.recoveryRequired).toBe(true);
    const reloaded = newStore();
    await reloaded.recover();
    expect(reloaded.recoveryRequired).toBe(true);
    expect(() => reloaded.reset()).toThrow("unresolved");
  });

  it("does not adopt a late or cancelled discovery result", async () => {
    const store = usePlDebugStore();
    const original = fetchMock.getMockImplementation()!;
    let finish: ((value: Response) => void) | undefined;
    fetchMock.mockImplementation((url: string, options: RequestInit) =>
      url.endsWith("/list")
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : original(url, options),
    );
    const pending = store.discoverSessions("conn").catch((error) => error);
    await vi.waitFor(() => expect(finish).toBeDefined());
    store.cancelSessionDiscovery();
    finish!(new Response("[]", { status: 200 }));
    expect(String(await pending)).toContain("old selection");
    await expect(store.adoptDiscoveredSession("original-session")).rejects.toThrow("Refresh");
    expect(store.sessionRef).toBeNull();
  });

  it("joins simultaneous close requests before status refresh or submission", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    calls.length = 0;
    const first = store.close();
    const second = store.close();
    expect(store.closeBusy).toBe(true);
    await Promise.all([first, second]);
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "status")).toHaveLength(2);
    expect(store.closeBusy).toBe(false);
    expect(store.publicSnapshot?.releaseState).toBe("released");
  });
  it("does not let a late recovery failure erase a newer workspace", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.close();
    const original = fetchMock.getMockImplementation()!;
    let rejectOld: ((reason: Error) => void) | undefined;
    let blockOld = true;
    fetchMock.mockImplementation((url: string, options: RequestInit) => {
      if (blockOld && url.endsWith("/operation"))
        return new Promise<Response>((_resolve, reject) => {
          rejectOld = reject;
        });
      return original(url, options);
    });
    const oldRecovery = store.recover().catch((error) => error);
    await vi.waitFor(() => expect(rejectOld).toBeDefined());
    store.reset();
    blockOld = false;
    await store.start("conn", "APP", { ...request, source: "BEGIN NULL; NULL; END;" }, confirmation);
    const current = store.publicSnapshot;
    rejectOld!(new Error("old recovery failed"));
    expect(String(await oldRecovery)).toContain("old recovery failed");
    expect(store.publicSnapshot).toEqual(current);
    expect(store.target?.source).toBe("BEGIN NULL; NULL; END;");
    expect(store.recoveryRequired).toBe(false);
  });

  it("sets exception mode through the public Web operation and publishes only the reported state", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    exceptionStateOverride = false;
    await store.setExceptionBreakpoint(true);
    expect(store.exceptionBreakpoint).toBe(false);
    const submitted = calls.filter((call) => call.path === "operate");
    expect(submitted).toHaveLength(1);
    expect(submitted[0].body).toMatchObject({ action: "set_exception_breakpoint", sessionId: "original-session", params: { enabled: true, stopRevision: 1 } });
    exceptionStateOverride = true;
    await store.setExceptionBreakpoint(true);
    expect(store.exceptionBreakpoint).toBe(true);
  });

  it("blocks only explicitly unavailable exception enabling and still permits disabling", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    snapshot = { ...snapshot!, capabilities: { exceptions: { status: "unsupported", canAttempt: false, message: "Exception flags are unavailable in this version" } } };
    await store.recover();
    await expect(store.setExceptionBreakpoint(true)).rejects.toThrow("unavailable in this version");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(0);
    store.exceptionBreakpoint = true;
    await store.setExceptionBreakpoint(false);
    expect(store.exceptionBreakpoint).toBe(false);
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
  });

  it("retains the actual exception mode on refusal and recovers a lost response without reposting", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    operationState = "failed";
    await expect(store.setExceptionBreakpoint(true)).rejects.toThrow("native assignment refused");
    expect(store.exceptionBreakpoint).toBe(false);
    expect(store.pendingOperations).toEqual({});
    operationState = "succeeded";
    loseControl = true;
    await expect(store.setExceptionBreakpoint(true)).rejects.toThrow("response lost");
    expect(store.exceptionBreakpoint).toBe(false);
    expect(store.recoveryRequired).toBe(true);
    const count = calls.filter((call) => call.path === "operate").length;
    loseControl = false;
    await store.recover();
    expect(store.exceptionBreakpoint).toBe(true);
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(count);
  });

  it("does not apply an old exception receipt or error to a newer generation", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const base = fetchMock.getMockImplementation()!;
    let release!: (response: Response) => void;
    let accepted!: Response;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      const response = await base(url, options);
      if (!url.endsWith("/operation")) return response;
      accepted = response;
      return new Promise<Response>((done) => {
        release = done;
      });
    });
    const old = store.setExceptionBreakpoint(true);
    const failure = expect(old).rejects.toThrow("original debug view changed");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    store.publicSnapshot = { ...store.publicSnapshot!, generation: 2 };
    store.exceptionBreakpoint = false;
    store.error = "new view error";
    const previousReceipt = store.lastReceipt;
    release(accepted);
    await failure;
    expect(store.publicSnapshot.generation).toBe(2);
    expect(store.exceptionBreakpoint).toBe(false);
    expect(store.lastReceipt).toEqual(previousReceipt);
    expect(store.error).toBe("new view error");
    expect(store.recoveryRequired).toBe(false);
  });

  it("restarts the released original session without another start or close", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    expect(store.canRestart).toBe(false);
    await store.close();
    expect(store.canRestart).toBe(true);
    const original = { ...store.sessionRef! };
    const before = calls.length;
    await store.restart();
    const submitted = calls.slice(before).filter((call) => call.path === "operate");
    expect(submitted).toHaveLength(1);
    expect(submitted[0].body).toMatchObject({ ...original, action: "restart", generation: 1, params: {} });
    expect(store.publicSnapshot?.generation).toBe(2);
    expect(store.sessionRef).toEqual(original);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
    expect(store.pendingOperations).toEqual({});
  });

  it("does not restart a stopped execution whose resources remain open", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.abort();
    await expect(store.restart()).rejects.toThrow("released");
    expect(calls.filter((call) => call.path === "operate").map((call) => call.body.action)).toEqual(["abort"]);
  });

  it("recovers a lost restart response by querying its original operation only", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.close();
    loseControl = true;
    await expect(store.restart()).rejects.toThrow("response lost");
    const restart = calls.filter((call) => call.path === "operate").at(-1)!;
    expect(store.pendingOperations[String(restart.body.operationId)]).toBeDefined();
    const restored = newStore();
    loseControl = false;
    await restored.recover();
    expect(restored.publicSnapshot?.generation).toBe(2);
    expect(restored.pendingOperations).toEqual({});
    expect(calls.filter((call) => call.path === "operate" && call.body.action === "restart")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
  });

  it("keeps an unresolved restart pending in the resulting generation", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.close();
    operationState = "unknown";
    await expect(store.restart()).rejects.toThrow("unknown");
    expect(store.publicSnapshot?.generation).toBe(2);
    expect(store.busy).toBe(true);
    await expect(store.stepOver()).rejects.toThrow("unresolved");
    expect(calls.filter((call) => call.path === "operate").map((call) => call.body.action)).toEqual(["close", "restart"]);
  });

  it("rejects a restart receipt from the previous generation without forgetting its intent", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.close();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      const response = await base(url, options);
      if (!url.endsWith("/operate")) return response;
      return new Response(JSON.stringify({ ...(await response.json()), generation: 1 }), { status: 200 });
    });
    await expect(store.restart()).rejects.toThrow("original debug request");
    expect(Object.keys(store.pendingOperations)).toHaveLength(1);
    expect(store.recoveryRequired).toBe(true);
  });

  it("rechecks the released generation after production confirmation", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.close();
    guard.run.mockImplementation(async (options: { execute: () => Promise<unknown> }) => {
      store.publicSnapshot = { ...store.publicSnapshot!, revision: store.publicSnapshot!.revision + 1 };
      return options.execute();
    });
    await expect(store.restart()).rejects.toThrow("changed during confirmation");
    expect(calls.filter((call) => call.path === "operate").map((call) => call.body.action)).toEqual(["close"]);
    expect(store.pendingOperations).toEqual({});
  });

  it("retains confirmed restart success when the following status read is lost", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.close();
    const base = fetchMock.getMockImplementation()!;
    let restarted = false;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/status") && restarted) throw new TypeError("status after restart lost");
      const response = await base(url, options);
      if (url.endsWith("/operate")) restarted = true;
      return response;
    });
    await expect(store.restart()).rejects.toThrow("Command succeeded; status could not be refreshed");
    expect(store.lastReceipt).toMatchObject({ state: "succeeded", generation: 2 });
    expect(store.recoveryRequired).toBe(true);
    expect(store.canRestart).toBe(false);
    fetchMock.mockImplementation(base);
    await store.recover();
    expect(store.publicSnapshot?.generation).toBe(2);
    expect(calls.filter((call) => call.path === "operate" && call.body.action === "restart")).toHaveLength(1);
  });

  it("binds an edit draft to the original stop even when the selected frame number is unchanged", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const context = store.captureValueContext();
    await store.stepOver();
    await expect(store.setValue("N", 0, 0, "8", context)).rejects.toThrow("edit context changed");
    expect(calls.filter((call) => call.path === "operate").map((call) => call.body.action)).toEqual(["step_over"]);
  });

  it("rechecks the captured edit view after confirmation even if the user switches back to the original frame", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const context = store.captureValueContext();
    readResult = () => ({ stopRevision: 1, variables: [] });
    guard.run.mockImplementation(async (options: { execute: () => Promise<unknown> }) => {
      await store.selectFrame(1);
      await store.selectFrame(0);
      return options.execute();
    });
    await expect(store.setValue("N", 0, 0, "8", context)).rejects.toThrow("changed during confirmation");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(0);
    expect(store.pendingOperations).toEqual({});
  });

  it("releases only a conclusively rejected first start and waits for an explicit new intent", async () => {
    const store = usePlDebugStore();
    rejectSubmission = { path: "start", code: "DBX-PLDEBUG-1001", operationOutcome: "not_started" };
    await expect(store.start("conn", "APP", request, confirmation)).rejects.toThrow("debug state changed");
    expect(store.pendingStart).toBeNull();
    expect(store.recoveryRequired).toBe(false);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
    const rejectedId = calls.find((call) => call.path === "start")!.body.operationId;
    rejectSubmission = null;
    await store.start("conn", "APP", request, confirmation);
    expect(start!.operationId).not.toBe(rejectedId);
  });

  it("removes a conclusively rejected control without forgetting the original session", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    rejectSubmission = { path: "operate", code: "DBX-PLDEBUG-1001", operationOutcome: "not_started" };
    await expect(store.stepOver()).rejects.toThrow("debug state changed");
    expect(store.pendingOperations).toEqual({});
    expect(store.recoveryRequired).toBe(false);
    expect(store.sessionRef?.sessionId).toBe("original-session");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
    rejectSubmission = null;
    await store.stepOver();
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(2);
  });

  it.each([
    ["DBX-LEGACY-0001", "not_started"],
    ["DBX-PLDEBUG-1001", "unknown"],
  ] as const)("does not infer admission rejection from %s/%s", async (code, operationOutcome) => {
    const store = usePlDebugStore();
    rejectSubmission = { path: "start", code, operationOutcome };
    await expect(store.start("conn", "APP", request, confirmation)).rejects.toThrow();
    expect(store.pendingStart).not.toBeNull();
    expect(store.recoveryRequired).toBe(true);
  });

  it("does not consume admission proof from a later receipt query after acceptance", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    rejectSubmission = { path: "operation", code: "DBX-PLDEBUG-1001", operationOutcome: "not_started" };
    await expect(store.stepOver()).rejects.toThrow("debug state changed");
    const submitted = calls.filter((call) => call.path === "operate");
    expect(submitted).toHaveLength(1);
    expect(store.pendingOperations[String(submitted[0].body.operationId)]).toBeDefined();
    expect(store.recoveryRequired).toBe(true);
  });

  it("clears a conclusively rejected close but does not report resource release", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    rejectSubmission = { path: "operate", code: "DBX-PLDEBUG-1001", operationOutcome: "not_started" };
    await expect(store.close()).rejects.toThrow("debug state changed");
    expect(store.pendingClose).toBeNull();
    expect(store.publicSnapshot?.releaseState).toBe("open");
    expect(store.sessionRef?.sessionId).toBe("original-session");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
  });

  it("adopts the original close owner receipt without resubmitting its operation", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.close();
    const originalId = String(calls.find((call) => call.path === "operate")!.body.operationId);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/operate")) {
        calls.push({ path: "operate", body: JSON.parse(String(options.body)) });
        return new Response(JSON.stringify(receipts.get(originalId)), { status: 200 });
      }
      return base(url, options);
    });
    const before = calls.length;
    await store.close();
    const closing = calls.slice(before);
    expect(closing.filter((call) => call.path === "operate")).toHaveLength(1);
    expect(closing.find((call) => call.path === "operate")!.body.operationId).not.toBe(originalId);
    expect(closing.filter((call) => call.path === "operation").map((call) => call.body.operationId)).toEqual([originalId]);
    expect(store.pendingClose).toBeNull();
  });

  it("does not let a late close alias overwrite a newer generation pending close", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const base = fetchMock.getMockImplementation()!;
    let release!: (response: Response) => void;
    let accepted!: Response;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      const response = await base(url, options);
      if (!url.endsWith("/operate")) return response;
      accepted = response;
      return new Promise<Response>((done) => {
        release = done;
      });
    });
    const old = store.close();
    const failure = expect(old).rejects.toThrow("original request");
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    store.publicSnapshot = { ...store.publicSnapshot!, generation: 2 };
    store.pendingClose = { operationId: "new-generation-close", reference: { ...store.sessionRef! } };
    release(accepted);
    await failure;
    expect(store.pendingClose?.operationId).toBe("new-generation-close");
    expect(store.publicSnapshot?.generation).toBe(2);
  });

  it("does not clear a newer pending close when an older recovery query finishes", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.close();
    const originalId = String(calls.find((call) => call.path === "operate")!.body.operationId);
    store.pendingClose = { operationId: originalId, reference: { ...store.sessionRef! } };
    const base = fetchMock.getMockImplementation()!;
    let release!: (response: Response) => void;
    let accepted!: Response;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      const response = await base(url, options);
      if (!url.endsWith("/operation") || JSON.parse(String(options.body)).operationId !== originalId) return response;
      accepted = response;
      return new Promise<Response>((done) => {
        release = done;
      });
    });
    const recovery = store.recover();
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    snapshot = { ...snapshot!, generation: 2 };
    store.publicSnapshot = { ...store.publicSnapshot!, generation: 2 };
    store.pendingClose = { operationId: "new-close", reference: { ...store.sessionRef! } };
    release(accepted);
    await recovery;
    expect(store.pendingClose?.operationId).toBe("new-close");
  });

  it("preserves native value states and reads watches independently of enumeration", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    store.addWatch('"Mixed"');
    store.addWatch('"MIXED"');
    readResult = (body) =>
      body.kind === "variables"
        ? {
            stopRevision: 1,
            variables: [
              { name: "N", state: "null", value: null },
              { name: "TEXT", state: "value", value: "NULL" },
              { name: "EMPTY", state: "empty", value: "" },
              { name: "BIG", state: "value", value: "9007199254740993" },
            ],
          }
        : { stopRevision: 1, variable: { name: (body.params as Record<string, unknown>).name, state: "value", value: "  'exact'  ", type: "VARCHAR2" } };
    await store.refreshVariables();
    expect(store.variables.map((entry) => [entry.state, entry.value])).toEqual([
      ["null", null],
      ["value", "NULL"],
      ["empty", ""],
      ["value", "9007199254740993"],
    ]);
    expect(store.watches).toHaveLength(2);
    expect(store.watches.every((entry) => entry.value === "  'exact'  " && entry.state === "value")).toBe(true);
    expect(calls.filter((call) => call.path === "read").map((call) => call.body.kind)).toEqual(["variables", "value", "value"]);
    expect(calls.filter((call) => call.path === "read").every((call) => call.body.stopRevision === 1 && (call.body.params as Record<string, unknown>).frame === 0)).toBe(true);
  });

  it("keeps watches usable when enumeration fails, without treating failure as empty", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    store.addWatch("N");
    readResult = (body) => {
      if (body.kind === "variables") throw new Error("enumeration unavailable");
      return { stopRevision: 1, variable: { name: "N", state: "out_of_scope", value: null, message: "not visible" } };
    };
    await expect(store.refreshVariables()).rejects.toThrow("enumeration unavailable");
    expect(store.variableError).toContain("enumeration unavailable");
    expect(store.watches[0]).toMatchObject({ state: "out_of_scope", value: null, message: "not visible" });
  });

  it("discards delayed frame values after frame selection changes", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    let resolve!: (value: unknown) => void;
    readResult = () =>
      new Promise((done) => {
        resolve = done;
      });
    const pending = store.refreshVariables();
    await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
    readResult = () => ({ stopRevision: 1, variables: [{ name: "INNER", state: "value", value: "new" }] });
    await store.selectFrame(1);
    resolve({ stopRevision: 1, variables: [{ name: "OLD", state: "value", value: "stale" }] });
    await expect(pending).rejects.toThrow("discarded");
    expect(store.variables).toEqual([{ name: "INNER", state: "value", value: "new" }]);
    expect(store.variableError).toBeNull();
  });

  it("keeps successful assignment separate from failed readback and never resends it", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    readResult = () => {
      throw new Error("GET refused");
    };
    const result = await store.setValue('"Mixed"', 0, 0, " 9007199254740993 ");
    expect(result.receipt.state).toBe("succeeded");
    expect(result.readError).toContain("GET refused");
    expect(store.lastReceipt?.state).toBe("succeeded");
    const writes = calls.filter((call) => call.path === "operate");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ action: "set_value", params: { name: '"Mixed"', frame: 0, index: 0, value: " 9007199254740993 ", stopRevision: 1 } });
    expect(calls.filter((call) => call.path === "read").map((call) => call.body.kind)).toEqual(["value"]);
  });

  it("retains assignment success when the subsequent original status response is lost", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/status")) throw new TypeError("status response lost");
      return base(url, options);
    });
    const result = await store.setValue("N", 0, 0, "42");
    expect(result.receipt.state).toBe("succeeded");
    expect(result.readError).toContain("status response lost");
    expect(store.lastReceipt?.state).toBe("succeeded");
    expect(store.recoveryRequired).toBe(true);
    expect(store.pendingOperations).toEqual({});
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "read")).toHaveLength(0);
  });

  it("retains valid partial values and does not replace a failed read with an empty list", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    readResult = () => ({
      stopRevision: 1,
      variables: [
        { name: "N", state: "value", value: "7" },
        { state: "value", value: "unidentified" },
        { name: "OLD", value: "NULL" },
      ],
    });
    await store.refreshVariables();
    expect(store.variables).toEqual([
      { name: "N", state: "value", value: "7" },
      { name: "OLD", state: "unknown", value: null },
    ]);
    expect(store.variableError).toContain("Some variable");
    readResult = () => {
      throw new Error("read failed");
    };
    await expect(store.refreshVariables()).rejects.toThrow("read failed");
    expect(store.variables[0].value).toBe("7");
    expect(store.variableError).toContain("read failed");
  });

  it("preserves native frame identities without letting read metadata move the stop", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const frame = { nativeFrameId: 3, frameIndex: 0, line: 91, identityState: "unknown", sourceState: "unknown", program: null };
    readResult = () => ({ stopRevision: 1, frames: [frame], line: 99, program: "not-authoritative", structuredBacktraceError: "collection unavailable" });
    await store.refreshStack();
    expect(store.status?.frames).toEqual([frame]);
    expect(store.currentLine).toBe(7);
    expect(store.status?.program).toBeNull();
    expect(store.stackError).toBe("collection unavailable");
  });

  it("reads back a known refusal but never replays a refused or unresolved assignment", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    operationState = "failed";
    await expect(store.setValue("N", 0, 0, "NULL")).rejects.toThrow("native assignment refused");
    expect(calls.filter((call) => call.path === "read")).toHaveLength(1);
    expect(store.lastReceipt?.state).toBe("failed");
    operationState = "unknown";
    await expect(store.setValue("N", 0, 0, "8")).rejects.toThrow("unknown");
    const originalId = store.lastReceipt!.operationId;
    await expect(store.setValue("N", 0, 0, "9")).rejects.toThrow("unresolved");
    expect(store.pendingOperations[originalId]).toBeDefined();
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(2);
    expect(calls.filter((call) => call.path === "read")).toHaveLength(1);
  });

  it("uses the original debuggee operation for SQL and preserves its native refusal", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    operationResult = { ok: false, error: "EXECUTE is not declared", rows: [], count: 0 };
    expect(await store.executeInDebuggee("  BEGIN NULL; END;\n", 4)).toEqual(operationResult);
    const writes = calls.filter((call) => call.path === "operate");
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ action: "execute", params: { sql: "  BEGIN NULL; END;\n", maxRows: 4, stopRevision: 1 } });
    expect(writes[0].body.params).not.toHaveProperty("frame");
    expect(calls.some((call) => call.path.includes("query"))).toBe(false);
  });

  it("requires explicit risk confirmation and retains the same public identity after start", async () => {
    const store = usePlDebugStore();
    await expect(store.start("conn", "APP", request)).rejects.toThrow("Confirm");
    expect(calls).toHaveLength(0);
    await store.start("conn", "APP", request, confirmation);
    expect(store.debugId).toBe("original-session");
    expect(store.currentLine).toBe(7);
    expect(start?.expectedConnectionRevision).toBe("epoch:0");
    expect(start?.riskAccepted).toBe(true);
    expect(store.pendingStart).toBeNull();
    await expect(store.start("conn", "APP", request, confirmation)).rejects.toThrow("original");
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
  });

  it("recovers a lost first response after refresh without replaying or choosing the first listed session", async () => {
    loseStart = true;
    const first = usePlDebugStore();
    await expect(first.start("conn", "APP", request, confirmation)).rejects.toThrow("lost");
    const operationId = first.pendingStart!.operationId;
    const workspace = first.clientSessionId;
    const restored = newStore();
    expect(restored.clientSessionId).toBe(workspace);
    await restored.recover();
    expect(restored.debugId).toBe("original-session");
    expect(restored.publicSnapshot?.startOperationId).toBe(operationId);
    expect(restored.pendingStart).toBeNull();
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "operation").every((call) => call.body.operationId === operationId)).toBe(true);
  });

  it("clears a stale start error when the same workspace is conclusively recovered", async () => {
    loseStart = true;
    const store = usePlDebugStore();
    await expect(store.start("conn", "APP", request, confirmation)).rejects.toThrow("lost");
    expect(store.error).toContain("lost");
    await store.recover();
    expect(store.publicSnapshot?.state).toBe("paused");
    expect(store.pendingStart).toBeNull();
    expect(store.error).toBeNull();
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
  });

  it("keeps an old epoch unresolved rather than treating the start as unexecuted", async () => {
    loseStart = true;
    await expect(usePlDebugStore().start("conn", "APP", request, confirmation)).rejects.toThrow();
    epoch = "restarted";
    const restored = newStore();
    const original = restored.pendingStart!.operationId;
    await expect(restored.recover()).rejects.toThrow("remains unknown");
    expect(restored.pendingStart?.operationId).toBe(original);
    expect(restored.recoveryRequired).toBe(true);
    await expect(restored.start("conn", "APP", request, confirmation)).rejects.toThrow("original");
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "list")).toHaveLength(0);
  });

  it("retains a lost close identity and queries it on the next close without dispatching again", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    loseClose = true;
    await expect(store.close()).rejects.toThrow("lost");
    const operationId = store.pendingClose!.operationId;
    expect(store.sessionRef?.sessionId).toBe("original-session");
    expect(() => store.reset()).toThrow("unresolved");
    await store.close();
    expect(store.pendingClose).toBeNull();
    expect(store.publicSnapshot?.releaseState).toBe("released");
    expect(store.sessionRef?.sessionId).toBe("original-session");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
    expect(calls.some((call) => call.path === "operation" && call.body.operationId === operationId)).toBe(true);
  });

  it("does not equate a successful command receipt with a successful native start", async () => {
    startFailed = true;
    const store = usePlDebugStore();
    await expect(store.start("conn", "APP", request, confirmation)).rejects.toThrow("native start refused");
    expect(store.sessionRef?.sessionId).toBe("original-session");
    expect(store.publicSnapshot?.startState).toBe("failed");
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
  });

  it("checks the frozen launch again after production confirmation", async () => {
    const store = usePlDebugStore();
    await expect(store.start("conn", "APP", request, { ...confirmation, isCurrent: () => false })).rejects.toThrow("changed");
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
    expect(store.pendingStart).toBeNull();
  });

  it("does not dispatch or retain a start when production confirmation is cancelled", async () => {
    guard.run.mockResolvedValue(undefined);
    const store = usePlDebugStore();
    await expect(store.start("conn", "APP", request, confirmation)).rejects.toThrow("cancelled before dispatch");
    expect(calls.filter((call) => call.path === "start")).toHaveLength(0);
    expect(store.pendingStart).toBeNull();
  });

  it("rejects a receipt for another operation and preserves the original recovery reference", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const id = start!.operationId;
    receipts.set(id, { ...receipts.get(id)!, operationId: "different-operation" });
    await expect(store.recover()).rejects.toThrow("does not belong");
    expect(store.sessionRef?.sessionId).toBe("original-session");
    expect(store.recoveryRequired).toBe(true);
    expect(calls.filter((call) => call.path === "start")).toHaveLength(1);
  });

  it("recovers a lost close after refresh and does not turn status reads into new stops", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const stop = store.stopSeq;
    await store.recover();
    expect(store.stopSeq).toBe(stop);
    loseClose = true;
    await expect(store.close()).rejects.toThrow("lost");
    const restored = newStore();
    await restored.recover();
    expect(restored.pendingClose).toBeNull();
    expect(restored.publicSnapshot?.releaseState).toBe("released");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
  });

  it("discards a late older revision without replacing the current stop", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const stop = store.stopSeq;
    snapshot = { ...snapshot!, revision: 1, line: "99" };
    await store.recover();
    expect(store.publicSnapshot?.revision).toBe(2);
    expect(store.currentLine).toBe(7);
    expect(store.stopSeq).toBe(stop);
  });

  it.each([
    ["resume", "resume"],
    ["resumeIgnoreBreakpoints", "run_to_end"],
    ["stepIn", "step_in"],
    ["stepOver", "step_over"],
    ["stepOut", "step_out"],
  ] as const)("submits %s once through the public owner-bound operation", async (method, action) => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    store.variables = [{ name: "N", value: "41", state: "value" }];
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      if (url.endsWith("/operate")) expect(store.variables).toEqual([]);
      return original(url, options);
    });
    const stop = store.stopSeq;
    await store[method]();
    const operations = calls.filter((call) => call.path === "operate");
    expect(operations).toHaveLength(1);
    expect(operations[0].body).toMatchObject({ sessionId: "original-session", serverEpoch: "epoch", connectionId: "conn", clientSessionId: store.clientSessionId, action, generation: 1, expectedRevision: 2, productionConfirmed: true, params: { stopRevision: 1 } });
    expect(operations[0].body.operationId).not.toBe(start!.operationId);
    expect(store.currentLine).toBe(8);
    expect(store.stopSeq).toBe(stop + 1);
    expect(store.lastReceipt?.state).toBe("succeeded");
    expect(store.busy).toBe(false);
    expect(store.pendingOperations).toEqual({});
  });

  it("recovers a lost control after refresh by original receipt without repeating the operation", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    loseControl = true;
    await expect(store.stepOver()).rejects.toThrow("control response lost");
    const [operationId] = Object.keys(store.pendingOperations);
    expect(operationId).toBeTruthy();
    expect(store.recoveryRequired).toBe(true);
    await expect(store.stepIn()).rejects.toThrow("Restore");
    const restored = newStore();
    await restored.recover();
    expect(restored.lastReceipt?.operationId).toBe(operationId);
    expect(restored.currentLine).toBe(8);
    expect(restored.pendingOperations).toEqual({});
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
  });

  it("does not clear an unknown original control merely because status says paused", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    loseControl = true;
    await expect(store.stepOver()).rejects.toThrow();
    const [operationId] = Object.keys(store.pendingOperations);
    receipts.set(operationId, { ...receipts.get(operationId)!, state: "unknown", result: null });
    const restored = newStore();
    await restored.recover();
    expect(restored.publicSnapshot?.state).toBe("paused");
    expect(restored.pendingOperations[operationId]).toBeDefined();
    expect(restored.busy).toBe(true);
    await expect(restored.stepOut()).rejects.toThrow("unresolved");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
  });

  it("cancels production confirmation without dispatching a control or losing the current stop", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    guard.run.mockResolvedValue(undefined);
    await expect(store.stepIn()).rejects.toThrow("cancelled before dispatch");
    expect(store.currentLine).toBe(7);
    expect(store.pendingOperations).toEqual({});
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(0);
  });

  it("rejects a selected-frame change while a control confirmation is open", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    guard.run.mockImplementation((options: { execute: () => Promise<unknown> }) => {
      store.currentFrame = 1;
      return options.execute();
    });
    await expect(store.stepIn()).rejects.toThrow("frame changed");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(0);
    expect(store.pendingOperations).toEqual({});
  });

  it("rechecks a second control after confirmation rather than dispatching two pending actions", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    const confirmations: Array<() => Promise<unknown>> = [];
    guard.run.mockImplementation(
      (options: { execute: () => Promise<unknown> }) =>
        new Promise((resolve, reject) => {
          confirmations.push(() => options.execute().then(resolve, reject));
        }),
    );
    const outcomes = Promise.allSettled([store.stepOver(), store.stepIn()]);
    expect(confirmations).toHaveLength(2);
    await Promise.all([confirmations[0](), confirmations[1]()]);
    const settled = await outcomes;
    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
  });

  it("aborts through the original session and reads completed output through the public read route", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    await store.abort();
    expect(calls.filter((call) => call.path === "operate")[0].body).toMatchObject({ action: "abort", sessionId: "original-session", expectedRevision: 2 });
    expect(calls.filter((call) => call.path === "read")[0].body).toMatchObject({ sessionId: "original-session", generation: 1, kind: "log" });
    expect(store.output).toBe("one\n\n中😀\n");
    expect(store.outputStatus).toEqual({ complete: true, truncated: false, error: null });
    expect(store.terminated).toBe(true);
  });

  it("can request an original-session abort after a lost control without repeating that control", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    loseControl = true;
    await expect(store.stepOver()).rejects.toThrow();
    const [originalId] = Object.keys(store.pendingOperations);
    loseControl = false;
    await store.abort();
    expect(calls.filter((call) => call.path === "operate").map((call) => call.body.action)).toEqual(["step_over", "abort"]);
    expect(store.pendingOperations[originalId]).toBeDefined();
    expect(store.publicSnapshot?.executionOutcome).toBe("cancelled");
  });

  it("discards output delayed across a newer control rather than publishing the old response", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    store.output = "previous confirmed output";
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (url: string, options: RequestInit) => {
      const result = await original(url, options);
      if (url.endsWith("/read")) {
        entered();
        await gate;
      }
      return result;
    });
    const reading = store.refreshLog();
    const rejected = expect(reading).rejects.toThrow("old debug context");
    await ready;
    await store.stepOver();
    release();
    await rejected;
    expect(store.output).toBe("previous confirmed output");
    expect(calls.filter((call) => call.path === "operate")).toHaveLength(1);
  });

  it("keeps confirmed output when a later read has an invalid payload", async () => {
    const store = usePlDebugStore();
    await store.start("conn", "APP", request, confirmation);
    store.output = "confirmed";
    const original = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string, options: RequestInit) => (url.endsWith("/read") ? Promise.resolve(new Response("{}", { status: 200 })) : original(url, options)));
    await expect(store.refreshLog()).rejects.toThrow("valid output buffer");
    expect(store.output).toBe("confirmed");
  });
});

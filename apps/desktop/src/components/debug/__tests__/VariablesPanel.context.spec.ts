// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import type { PlDebugReceipt, PlDebugSnapshot, PlDebugVariable } from "@/lib/debug/plDebugProtocol";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [{ id: "conn", name: "Fixture" }] }) }));
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

import VariablesPanel from "../VariablesPanel.vue";
import { usePlDebugStore } from "@/stores/plDebugStore";

let app: App | null;
let pinia: ReturnType<typeof createPinia>;
let root: HTMLDivElement;
let snapshot: PlDebugSnapshot;
let setSupported: boolean;
let enumerateSupported: boolean;
let setFailed: boolean;
let valueReadFailed: boolean;
let variableRows: PlDebugVariable[];
let variableReadError: string | null;
const requests: Array<{ path: string; body: Record<string, any> }> = [];
const receipts = new Map<string, PlDebugReceipt>();

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) });
  pinia = createPinia();
  setActivePinia(pinia);
  setSupported = true;
  enumerateSupported = true;
  setFailed = false;
  valueReadFailed = false;
  variableReadError = null;
  variableRows = [
    { name: "N", state: "value", value: "7" },
    { name: "SQL_NULL", state: "null", value: null },
    { name: "TEXT_NULL", state: "value", value: "NULL" },
    { name: "EMPTY", state: "empty", value: "" },
    { name: "ERROR", state: "error", value: null, message: "native read refused" },
  ];
  app = null;
  requests.length = 0;
  receipts.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const path = url.split("/").pop()!;
      const body = JSON.parse(String(options.body));
      requests.push({ path, body });
      let result: unknown;
      if (path === "bootstrap") result = { serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 };
      else if (path === "inspect") result = { connectionRevision: "epoch:0", capabilities: { supported: true, variablesSupported: enumerateSupported, capabilities: { setValue: { canAttempt: setSupported }, getValue: { canAttempt: true } } } };
      else if (path === "start") {
        snapshot = {
          serverEpoch: "epoch",
          sessionId: "session",
          connectionId: "conn",
          database: "APP",
          clientSessionId: body.clientSessionId,
          startOperationId: body.operationId,
          generation: 1,
          revision: 2,
          stopRevision: 1,
          state: "paused",
          startState: "succeeded",
          executionOutcome: "pending",
          releaseState: "open",
          transactionOutcome: "pending",
          runtimeExited: false,
          executionStopped: false,
          closing: false,
          activeOperationId: null,
          target: body.target,
          line: "7",
        };
        result = { serverEpoch: "epoch", sessionId: "session", operationId: body.operationId, generation: 1, revision: 2, state: "succeeded", dispatched: true, result: snapshot, error: null };
        receipts.set(body.operationId, result as PlDebugReceipt);
      } else if (path === "operation") result = receipts.get(body.operationId);
      else if (path === "status") result = snapshot;
      else if (path === "operate") {
        snapshot = { ...snapshot, revision: snapshot.revision + 1, stopRevision: body.action === "step_over" ? Number(snapshot.stopRevision) + 1 : snapshot.stopRevision, line: "8" };
        result = {
          serverEpoch: "epoch",
          sessionId: "session",
          operationId: body.operationId,
          generation: 1,
          revision: snapshot.revision,
          state: setFailed && body.action === "set_value" ? "failed" : "succeeded",
          dispatched: true,
          result: { ok: !setFailed, result: setFailed ? 77 : 0, message: setFailed ? "native assignment refused" : "" },
          error: null,
        };
        receipts.set(body.operationId, result as PlDebugReceipt);
      } else if (path === "read") {
        if (body.kind === "value" && valueReadFailed) throw new TypeError("GET response lost");
        result =
          body.kind === "value"
            ? { stopRevision: snapshot.stopRevision, variable: { name: body.params.name, state: "value", value: "watch exact", type: "VARCHAR2" } }
            : {
                stopRevision: snapshot.stopRevision,
                variables: variableRows,
                variablesComplete: variableReadError === null,
                variablesError: variableReadError,
              };
      } else throw new Error(`Unexpected boundary ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
});

afterEach(() => {
  app?.unmount();
  disposePinia(pinia);
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

async function mountPanel(read = true) {
  const store = usePlDebugStore();
  await store.start("conn", "APP", { objectType: "ANONYMOUS", source: "BEGIN NULL; END;" }, { riskAccepted: true, expectedConnectionRevision: "epoch:0" });
  await store.runProbe("conn", "APP");
  if (read) await store.refreshVariables();
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(VariablesPanel);
  app.use(pinia);
  app.mount(root);
  await nextTick();
  return store;
}

function button(title: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find((candidate) => candidate.title === title);
  if (!found) throw new Error(`Missing button ${title}`);
  return found;
}

function input(element: HTMLInputElement, text: string) {
  element.value = text;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("VariablesPanel through the public debug boundary", () => {
  it("shows the native partial-read reason alongside retained values and never calls an incomplete empty read empty", async () => {
    variableRows = [{ name: "SQL_NULL", state: "null", value: null }];
    variableReadError = "Outer frame source is not visible";
    const store = await mountPanel();
    expect(root.textContent).toContain("SQL_NULL");
    expect(root.textContent).toContain("Outer frame source is not visible");
    expect(store.variablesState).toBe("error");
    variableRows = [];
    await store.refreshVariables();
    await nextTick();
    expect(root.textContent).toContain("Outer frame source is not visible");
    expect(root.textContent).not.toContain("plDebug.variables.empty");
  });
  it("expands and copies complete native names and text using the shared clipboard path", async () => {
    const name = '"Mixed Name".LONG_VARIABLE';
    const value = "'NULL'\n中😀\r\nlast";
    variableRows = [{ name, value, state: "value" }];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { userAgent: "Windows", clipboard: { writeText } });
    await mountPanel();
    const row = root.querySelector("tbody tr")!;
    const details = row.querySelectorAll("details");
    expect(details).toHaveLength(2);
    details[0].querySelector("summary")!.click();
    expect(details[0].open).toBe(true);
    expect(details[0].querySelector("pre")!.textContent).toBe(name);
    button("plDebug.variables.copyName").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(name));
    details[1].querySelector("summary")!.click();
    expect(details[1].open).toBe(true);
    expect(details[1].querySelector("pre")!.textContent).toBe(value);
    button("plDebug.variables.copyValue").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenLastCalledWith("'NULL'\r\n中😀\r\nlast"));
    await vi.waitFor(() => expect(root.textContent).toContain("plDebug.variables.copied"));
  });

  it("copies confirmed empty text but never presents an unread/error state as a value", async () => {
    variableRows = [
      { name: "EMPTY", state: "empty", value: "" },
      { name: "UNKNOWN", state: "unknown", value: null },
      { name: "ERROR", state: "error", value: null },
    ];
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { userAgent: "Windows", clipboard: { writeText } });
    await mountPanel();
    const rows = [...root.querySelectorAll("tbody tr")];
    expect(rows[0].querySelector('button[title="plDebug.variables.copyValue"]')).not.toBeNull();
    expect(rows[1].querySelector('button[title="plDebug.variables.copyValue"]')).toBeNull();
    expect(rows[2].querySelector('button[title="plDebug.variables.copyValue"]')).toBeNull();
    button("plDebug.variables.copyValue").click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(""));
  });

  it("shows a copy failure without losing the expanded original text", async () => {
    vi.stubGlobal("navigator", { userAgent: "Windows", clipboard: { writeText: vi.fn().mockRejectedValue(new Error("clipboard denied")) } });
    await mountPanel();
    const previous = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    try {
      button("plDebug.variables.copyValue").click();
      await vi.waitFor(() => expect(root.textContent).toContain("plDebug.variables.copyFailed"));
      expect(root.querySelectorAll("tbody tr")[0].querySelectorAll("details")[1].querySelector("pre")!.textContent).toBe("7");
      expect(root.textContent).not.toContain("plDebug.variables.copied");
    } finally {
      if (previous) Object.defineProperty(document, "execCommand", previous);
      else Reflect.deleteProperty(document, "execCommand");
    }
  });

  it("shares a bounded name width across both tables with keyboard and reset controls", async () => {
    await mountPanel();
    const panel = root.firstElementChild as HTMLElement;
    const handles = root.querySelectorAll<HTMLElement>('[role="separator"]');
    expect(handles).toHaveLength(2);
    expect(panel.style.getPropertyValue("--debug-name-width")).toBe("240px");
    handles[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await nextTick();
    expect(panel.style.getPropertyValue("--debug-name-width")).toBe("256px");
    handles[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    await nextTick();
    expect(panel.style.getPropertyValue("--debug-name-width")).toBe("240px");
    button("plDebug.variables.resetWidth").click();
    await nextTick();
    expect(panel.style.getPropertyValue("--debug-name-width")).toBe("240px");
  });

  it("resizes from the pointer-down width and stops tracking after release", async () => {
    await mountPanel();
    const panel = root.firstElementChild as HTMLElement;
    const handle = root.querySelector<HTMLElement>('[role="separator"]')!;
    vi.spyOn(handle.closest("th")!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 200, 20));
    Object.defineProperty(handle, "setPointerCapture", { value: vi.fn() });
    handle.dispatchEvent(new PointerEvent("pointerdown", { clientX: 100, button: 0, pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 160, pointerId: 1, bubbles: true }));
    await nextTick();
    expect(panel.style.getPropertyValue("--debug-name-width")).toBe("260px");
    handle.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
    handle.dispatchEvent(new PointerEvent("pointermove", { clientX: 240, pointerId: 1, bubbles: true }));
    await nextTick();
    expect(panel.style.getPropertyValue("--debug-name-width")).toBe("260px");
  });

  it("distinguishes unread, loading and a confirmed empty frame", async () => {
    const store = await mountPanel(false);
    expect(root.textContent).toContain("plDebug.variables.unread");
    expect(root.textContent).not.toContain("plDebug.variables.empty");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/read")) {
        await gate;
        return new Response(JSON.stringify({ stopRevision: 1, variables: [] }), { status: 200 });
      }
      return original(...args);
    });
    const loading = store.refreshVariables();
    await nextTick();
    expect(root.textContent).toContain("common.loading");
    release();
    await loading;
    await nextTick();
    expect(root.textContent).toContain("plDebug.variables.empty");
    expect(store.variablesState).toBe("ready");
  });

  it("renders native NULL, literal NULL, empty and read errors distinctly", async () => {
    await mountPanel();
    const rows = [...root.querySelectorAll("tbody tr")];
    expect(rows.find((row) => row.textContent?.includes("SQL_NULL"))?.textContent).toContain("SQL NULL");
    expect(rows.find((row) => row.textContent?.includes("TEXT_NULL"))?.textContent).toContain("NULL");
    expect(rows.find((row) => row.textContent?.includes("EMPTY"))?.textContent).toContain("plDebug.variables.emptyString");
    expect(rows.find((row) => row.textContent?.includes("ERROR"))?.textContent).toContain("native read refused");
  });

  it("keeps direct watches and view configuration usable without SET or enumeration", async () => {
    setSupported = false;
    enumerateSupported = false;
    const store = await mountPanel();
    expect(button("plDebug.variables.setUnavailable").disabled).toBe(true);
    input(root.querySelector<HTMLInputElement>('input[placeholder="plDebug.watch.addPlaceholder"]')!, "N");
    await nextTick();
    button("plDebug.watch.add").click();
    await vi.waitFor(() => expect(root.textContent).toContain("watch exact"));
    expect(requests.some((request) => request.path === "read" && request.body.kind === "value")).toBe(true);
    store.busy = true;
    await nextTick();
    button("plDebug.watch.remove").click();
    expect(store.watchNames).toEqual([]);
    expect(requests.some((request) => request.path === "operate")).toBe(false);
  });

  it("preserves a stale draft and refuses keyboard submission at a new stop", async () => {
    const store = await mountPanel();
    button("plDebug.variables.edit").click();
    await nextTick();
    input(root.querySelector<HTMLInputElement>("[data-variable-editor]")!, "9007199254740993");
    await nextTick();
    await store.stepOver();
    await nextTick();
    const editor = root.querySelector<HTMLInputElement>("[data-variable-editor]")!;
    expect(editor.value).toBe("9007199254740993");
    expect(root.textContent).toContain("plDebug.variables.editContextChanged");
    expect(button("plDebug.variables.save").disabled).toBe(true);
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await nextTick();
    expect(requests.filter((request) => request.path === "operate").map((request) => request.body.action)).toEqual(["step_over"]);
    expect(editor.value).toBe("9007199254740993");
  });

  it("keeps the draft and native failure when assignment is refused", async () => {
    setFailed = true;
    await mountPanel();
    button("plDebug.variables.edit").click();
    await nextTick();
    input(root.querySelector<HTMLInputElement>("[data-variable-editor]")!, "42");
    await nextTick();
    button("plDebug.variables.save").click();
    await vi.waitFor(() => expect(root.textContent).toContain("plDebug.variables.setFailed"));
    expect(root.querySelector<HTMLInputElement>("[data-variable-editor]")?.value).toBe("42");
    expect(requests.filter((request) => request.path === "operate")).toHaveLength(1);
  });

  it("reports a successful assignment separately when its readback fails", async () => {
    valueReadFailed = true;
    const store = await mountPanel();
    button("plDebug.variables.edit").click();
    await nextTick();
    input(root.querySelector<HTMLInputElement>("[data-variable-editor]")!, "42");
    await nextTick();
    button("plDebug.variables.save").click();
    await vi.waitFor(() => expect(root.textContent).toContain("plDebug.variables.readbackFailed"));
    expect(root.textContent).not.toContain("plDebug.variables.setFailed");
    expect(root.querySelector("[data-variable-editor]")).toBeNull();
    expect(store.lastReceipt?.state).toBe("succeeded");
    expect(store.recoveryRequired).toBe(false);
    expect(requests.filter((request) => request.path === "operate")).toHaveLength(1);
  });
});

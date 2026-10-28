// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import { EditorView } from "@codemirror/view";
import type { PlDebugSnapshot, PlDebugReceipt } from "@/lib/debug/plDebugProtocol";
import type { PlDebugBreakpoint, PlDebugSourceRef } from "@/lib/backend/pl-debug-tauri";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [], getConfig: () => ({ db_type: "oracle" }) }) }));
vi.mock("@/stores/settingsStore", () => ({ useSettingsStore: () => ({ editorSettings: { theme: "light", fontSize: 14, fontFamily: "monospace", shortcuts: {} } }) }));
vi.mock("@/lib/editor/editorThemes", () => ({ loadEditorTheme: async () => [], editorFontTheme: () => [] }));
vi.mock("@/composables/useTheme", async () => {
  const { ref } = await import("vue");
  return { useTheme: () => ({ isDark: ref(false), themePalette: ref({}) }) };
});
vi.mock("@/lib/database/productionExecutionGuard", () => ({ executeWithProductionContextGuard: (options: { execute: () => Promise<unknown> }) => options.execute() }));

import BreakpointsPanel from "../BreakpointsPanel.vue";
import PlDebugSourceEditor from "../PlDebugSourceEditor.vue";
import { usePlDebugStore } from "@/stores/plDebugStore";

let app: App | null;
let root: HTMLDivElement;
let pinia: ReturnType<typeof createPinia>;
let store: ReturnType<typeof usePlDebugStore>;
let snapshot: PlDebugSnapshot;
let inventory: PlDebugBreakpoint[];
let failCommand: boolean;
let loseResponse: boolean;
let failInventory: boolean;
let coreError: Record<string, unknown> | null;
const receipts = new Map<string, PlDebugReceipt>();
const requests: Array<{ path: string; body: Record<string, any> }> = [];
const source: PlDebugSourceRef = {
  id: "original:target",
  sourceRevision: 1,
  stopRevision: 7,
  nativeFrameId: 2,
  lineBasis: "all_source",
  identityState: "native",
  evidenceKind: "runtime",
  objectType: "PROCEDURE",
  owner: "Exact Owner",
  name: "Mixed.Name\n",
  source: "PROCEDURE exact AS\nBEGIN NULL;\nEND;",
};

beforeEach(() => {
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  pinia = createPinia();
  setActivePinia(pinia);
  store = usePlDebugStore();
  const reference = { serverEpoch: "epoch", sessionId: "session", connectionId: "conn", clientSessionId: store.clientSessionId };
  store.sessionRef = reference;
  store.debugId = "session";
  store.connectionId = "conn";
  store.database = "APP";
  store.target = { schema: "Exact Owner", objectType: "PROCEDURE", objectName: "Mixed.Name\n", packageName: null, source: null };
  snapshot = {
    ...reference,
    startOperationId: "start",
    database: "APP",
    generation: 1,
    revision: 2,
    stopRevision: 7,
    state: "paused",
    startState: "succeeded",
    executionStopped: false,
    executionOutcome: "pending",
    releaseState: "open",
    transactionOutcome: "pending",
    runtimeExited: false,
    closing: false,
    activeOperationId: null,
    target: store.target,
    sourceMappingState: "verified",
    sourceRef: source,
    breakpointRulesOwner: "agent",
    breakpointRuleEvents: [],
  };
  store.publicSnapshot = snapshot;
  store.status = { sourceMappingState: "verified", sourceRef: source, breakpointRulesOwner: "agent", breakpointRuleEvents: [] };
  inventory = [];
  app = null;
  failCommand = loseResponse = failInventory = false;
  coreError = null;
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
      else if (path === "status") result = snapshot;
      else if (path === "operation") result = body.operationId === "start" ? { serverEpoch: "epoch", sessionId: "session", operationId: "start", generation: 1, revision: 2, state: "succeeded", dispatched: true, result: snapshot, error: null } : receipts.get(body.operationId);
      else if (path === "operate") {
        snapshot = { ...snapshot, revision: snapshot.revision + 1 };
        if (!failCommand) {
          if (body.action === "set_breakpoints" && body.params.rules) inventory = inventory.map((item) => (item.breakpointNumber === body.params.breakpointNumber && item.registrationId === body.params.registrationId ? { ...item, ...body.params.rules } : item));
          else if (body.action === "set_breakpoints")
            inventory.push({
              owned: true,
              registrationId: body.operationId,
              sourceRefId: body.params.sourceRefId,
              sourceRevision: body.params.sourceRevision,
              breakpointNumber: 77,
              line: body.params.line,
              nativeLine: body.params.line,
              localActive: true,
              name: source.name,
              owner: source.owner,
              kind: "PROCEDURE",
            });
          else if (body.action === "delete_breakpoints") inventory = inventory.filter((item) => item.breakpointNumber !== body.params.breakpointNumber || item.registrationId !== body.params.registrationId);
          else if (body.action === "set_breakpoint_enabled") inventory = inventory.map((item) => (item.breakpointNumber === body.params.breakpointNumber && item.registrationId === body.params.registrationId ? { ...item, localActive: body.params.enabled } : item));
          else if (body.action === "resume") snapshot = { ...snapshot, stopRevision: 8, line: "2", reason: 3, breakpointRuleEvents: [{ sequence: 1, stopRevision: 8, breakpointNumber: 77, message: "server final message", warning: "server condition warning" }] };
          else throw new Error(`Unexpected action ${body.action}`);
        }
        result = {
          serverEpoch: "epoch",
          sessionId: "session",
          operationId: body.operationId,
          generation: 1,
          revision: snapshot.revision,
          state: failCommand ? "failed" : "succeeded",
          dispatched: true,
          result: coreError ? null : { ok: !failCommand, result: failCommand ? 77 : 0, message: failCommand ? "native breakpoint refused" : "", snapshot },
          error: coreError,
        };
        receipts.set(body.operationId, result as PlDebugReceipt);
        if (loseResponse) {
          loseResponse = false;
          throw new TypeError("original response lost");
        }
      } else if (path === "read" && body.kind === "breakpoints") {
        if (failInventory) throw new TypeError("inventory response lost");
        result = { breakpoints: inventory };
      } else throw new Error(`Unexpected boundary ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
});

afterEach(() => {
  app?.unmount();
  root?.remove();
  disposePinia(pinia);
  vi.unstubAllGlobals();
});

const writes = () => requests.filter((request) => request.path === "operate");

it("creates, disables, enables and deletes through the shared public API with original source/registration identities", async () => {
  await store.toggleSourceBreakpoint(2);
  expect(writes()[0]!.body).toMatchObject({ action: "set_breakpoints", params: { sourceRefId: source.id, sourceRevision: 1, stopRevision: 7, nativeFrameId: 2, line: 2 } });
  expect(store.nativeBreakpointLines).toEqual([2]);
  const original = store.breakpoints[0]!;
  await store.setOwnedBreakpointEnabled(original, false);
  expect(store.nativeBreakpointLines).toEqual([]);
  await store.setOwnedBreakpointEnabled(store.breakpoints[0]!, true);
  await store.toggleSourceBreakpoint(2);
  expect(store.breakpoints).toEqual([]);
  expect(writes().map((request) => request.body.action)).toEqual(["set_breakpoints", "set_breakpoint_enabled", "set_breakpoint_enabled", "delete_breakpoints"]);
  for (const request of writes().slice(1)) expect(request.body.params).toMatchObject({ breakpointNumber: 77, registrationId: original.registrationId });
});

it("rejects stale source and unowned inventory before POST", async () => {
  store.status!.sourceRef = { ...source, stopRevision: 6 };
  await expect(store.toggleSourceBreakpoint(2)).rejects.toThrow("current native source");
  await expect(store.deleteOwnedBreakpoint({ breakpointNumber: 77, owned: false })).rejects.toThrow("owner registration");
  expect(writes()).toHaveLength(0);
});

it("keeps a conclusive native refusal and does not draw an optimistic marker", async () => {
  failCommand = true;
  await expect(store.toggleSourceBreakpoint(2)).rejects.toThrow("native breakpoint refused");
  expect(store.nativeBreakpointLines).toEqual([]);
  expect(store.pendingOperations).toEqual({});
  expect(store.recoveryRequired).toBe(false);
  expect(writes()).toHaveLength(1);
});

it("recovers a lost response by querying the original intent without another POST", async () => {
  loseResponse = true;
  await expect(store.toggleSourceBreakpoint(2)).rejects.toThrow();
  expect(store.recoveryRequired).toBe(true);
  const id = writes()[0]!.body.operationId;
  await store.recover();
  await store.refreshBreakpoints();
  expect(requests.some((request) => request.path === "operation" && request.body.operationId === id)).toBe(true);
  expect(writes()).toHaveLength(1);
  expect(store.nativeBreakpointLines).toEqual([2]);
});

it("reports known command success separately from failed inventory readback", async () => {
  failInventory = true;
  await expect(store.toggleSourceBreakpoint(2)).rejects.toThrow("command succeeded");
  expect(store.lastReceipt?.state).toBe("succeeded");
  expect(store.pendingOperations).toEqual({});
  expect(writes()).toHaveLength(1);
});

it("the real panel removes the selected same-line object's registration, not the launch target's line", async () => {
  inventory = [77, 88].map((number) => ({ owned: true, breakpointNumber: number, registrationId: `registration-${number}`, sourceRefId: `source-${number}`, sourceRevision: 1, line: 2, localActive: true, name: `Object ${number}` }));
  await store.refreshBreakpoints();
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(BreakpointsPanel);
  app.use(pinia).mount(root);
  root.querySelectorAll<HTMLButtonElement>('button[title="plDebug.breakpoints.remove"]')[1]!.click();
  await vi.waitFor(() => expect(writes()).toHaveLength(1));
  await vi.waitFor(() => expect(store.busy).toBe(false));
  await nextTick();
  expect(writes()[0]!.body.params).toMatchObject({ breakpointNumber: 88, registrationId: "registration-88" });
  expect(store.breakpoints.map((item) => item.breakpointNumber)).toEqual([77]);
});

it("the real CodeMirror gutter sends a source-bound public operation and draws only the confirmed inventory", async () => {
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(PlDebugSourceEditor);
  app.use(pinia).mount(root);
  await nextTick();
  await nextTick();
  const line = root.querySelectorAll<HTMLElement>(".cm-lineNumbers .cm-gutterElement")[2];
  expect(line).toBeDefined();
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>(".cm-content")!)!;
  const block = view.lineBlockAt(view.state.doc.line(2).from);
  vi.spyOn(line!, "getBoundingClientRect").mockReturnValue(new DOMRect(0, view.documentTop + block.top, 20, block.height));
  line!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientY: view.documentTop + block.top + block.height / 2 }));
  await vi.waitFor(() => expect(writes()).toHaveLength(1));
  await vi.waitFor(() => expect(store.busy).toBe(false));
  expect(writes()[0]!.body).toMatchObject({ action: "set_breakpoints", params: { sourceRefId: source.id, nativeFrameId: 2, line: 2 } });
  expect([...root.querySelectorAll(".cm-pl-debug-breakpoint")].map((element) => element.textContent)).toEqual(["2"]);
});

it("uses the Agent rule owner once and de-duplicates sequenced events across refresh", async () => {
  store.setBreakpointIgnoreCount(2, 3);
  store.setBreakpointMessage(2, "client must not run");
  const historyBeforeResume = store.history.length;
  await store.resume();
  expect(writes()).toHaveLength(1);
  expect(writes()[0]!.body.action).toBe("resume");
  expect(requests.filter((request) => request.path === "read")).toHaveLength(0);
  await store.recover();
  await store.recover();
  expect(store.history.filter((entry) => entry.message === "server final message")).toHaveLength(1);
  expect(store.history.filter((entry) => entry.message === "server condition warning")).toHaveLength(1);
  expect(store.history.slice(historyBeforeResume).some((entry) => entry.message.includes("client must not run"))).toBe(false);
  expect(writes()).toHaveLength(1);
});

it("the actual rule editor retains a refused condition draft", async () => {
  await store.toggleSourceBreakpoint(2);
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(BreakpointsPanel);
  app.use(pinia).mount(root);
  failCommand = true;
  const input = root.querySelectorAll<HTMLInputElement>("input")[1]!;
  expect(input.disabled).toBe(false);
  input.value = "N >= 9007199254740993";
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await vi.waitFor(() => expect(writes()).toHaveLength(2));
  await vi.waitFor(() => expect(store.busy).toBe(false));
  await nextTick();
  expect(writes()[1]!.body.params.rules.condition).toBe("N >= 9007199254740993");
  expect(root.querySelectorAll<HTMLInputElement>("input")[1]!.value).toBe("N >= 9007199254740993");
  expect(store.breakpoints[0]!.condition).toBeUndefined();
  expect(root.textContent).toContain("plDebug.breakpoints.actionFailed");
});

it("the real editor merges rule fields by registration and preserves exact condition/message text", async () => {
  await store.toggleSourceBreakpoint(2);
  root = document.createElement("div");
  document.body.append(root);
  app = createApp(BreakpointsPanel);
  app.use(pinia).mount(root);
  for (const [index, value] of [
    [0, "2"],
    [1, " N >= 9007199254740993 "],
    [2, " message 中 "],
  ] as const) {
    const count = writes().length;
    const input = root.querySelectorAll<HTMLInputElement>("input")[index]!;
    input.value = value;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(writes()).toHaveLength(count + 1));
    await vi.waitFor(() => expect(store.busy).toBe(false));
    await nextTick();
  }
  const registration = writes()[0]!.body.operationId;
  expect(writes()[3]!.body).toMatchObject({ action: "set_breakpoints", params: { breakpointNumber: 77, registrationId: registration, rules: { ignoreCount: 2, condition: " N >= 9007199254740993 ", message: " message 中 " } } });
  expect(inventory).toHaveLength(1);
  expect(store.breakpoints[0]).toMatchObject({ ignoreCount: 2, condition: " N >= 9007199254740993 ", message: " message 中 " });
});

it("keeps the Agent's actionable validation reason from the Core receipt envelope", async () => {
  await store.toggleSourceBreakpoint(2);
  failCommand = true;
  coreError = { code: "agent_call_failed", operationOutcome: "not_started", detail: { version: 1, code: "DBX-AGENT-0001", messageKey: "backendErrors.agent.failed", messageParams: {}, source: "agent", operationOutcome: "not_started", detail: "condition exceeds the 4096-byte limit" } };
  await expect(store.updateOwnedBreakpointRules(store.breakpoints[0]!, { condition: "draft" })).rejects.toThrow("condition exceeds the 4096-byte limit");
  expect(store.pendingOperations).toEqual({});
  expect(writes()).toHaveLength(2);
});

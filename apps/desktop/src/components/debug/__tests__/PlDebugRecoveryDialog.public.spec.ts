// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, nextTick, type App } from "vue";
import { createPinia, disposePinia, setActivePinia } from "pinia";
import type { PlDebugSnapshot } from "@/lib/debug/plDebugProtocol";

const workspace = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("@/stores/queryStore", () => ({ useQueryStore: () => ({ openPlDebugTab: workspace.open }) }));
vi.mock("@/stores/connectionStore", () => ({ useConnectionStore: () => ({ connections: [] }) }));
vi.mock("@/lib/backend/tauriRuntime", () => ({ isTauriRuntime: () => false }));
vi.mock("@/lib/backend/debugLog", () => ({ appendDebugLog: vi.fn(), isDebugLoggingEnabled: () => false }));
import i18n from "@/i18n";
import PlDebugRecoveryDialog from "../PlDebugRecoveryDialog.vue";
import { openPlDebugRecovery, plDebugRecoveryConnectionId } from "../plDebugLaunch";
import { usePlDebugStore } from "@/stores/plDebugStore";

let app: App;
let pinia: ReturnType<typeof createPinia>;
let sessions: PlDebugSnapshot[];
const calls: Array<{ path: string; body: Record<string, any> }> = [];
function button(text: string) {
  const found = [...document.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
}
beforeEach(() => {
  calls.length = 0;
  workspace.open.mockClear();
  i18n.global.locale.value = "en";
  plDebugRecoveryConnectionId.value = null;
  vi.stubGlobal("sessionStorage", { getItem: () => null, setItem: vi.fn() });
  sessions = ["first", "chosen"].map((id) => ({
    serverEpoch: "epoch",
    sessionId: id,
    connectionId: "conn",
    clientSessionId: `original-${id}`,
    startOperationId: `start-${id}`,
    database: "APP",
    generation: 1,
    revision: 2,
    state: "unknown",
    startState: "succeeded",
    executionOutcome: "unknown",
    executionStopped: false,
    transactionOutcome: "unknown",
    releaseState: "unknown",
    runtimeExited: true,
    closing: false,
    activeOperationId: null,
    target: { schema: "S", objectType: "PROCEDURE", objectName: id },
    recovery: { version: 1, closeOperationId: null, operations: [] },
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options: RequestInit) => {
      const path = url.split("/").pop()!;
      const body = JSON.parse(String(options.body));
      calls.push({ path, body });
      let result: unknown;
      if (path === "bootstrap") result = { serverEpoch: "epoch", heartbeatSeconds: 3600, leaseSeconds: 120, cleanupSeconds: 60 };
      else if (path === "list") result = sessions;
      else if (path === "status") result = sessions.find((session) => session.sessionId === body.reference.sessionId);
      else if (path === "operation")
        result = { serverEpoch: "epoch", sessionId: body.reference.sessionId, operationId: body.operationId, generation: 1, revision: 2, state: "succeeded", dispatched: true, result: sessions.find((session) => session.sessionId === body.reference.sessionId), error: null };
      else throw new Error(`Unexpected recovery side effect ${path}`);
      return new Response(JSON.stringify(result), { status: 200 });
    }),
  );
  pinia = createPinia();
  setActivePinia(pinia);
  const root = document.createElement("div");
  document.body.append(root);
  app = createApp(PlDebugRecoveryDialog);
  app.use(pinia).use(i18n).mount(root);
});
afterEach(() => {
  app.unmount();
  disposePinia(pinia);
  plDebugRecoveryConnectionId.value = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("public owned-session recovery dialog", () => {
  it("requires an explicit choice and restores the chosen original workspace without connecting or replaying", async () => {
    openPlDebugRecovery("conn");
    await vi.waitFor(() => expect(document.querySelectorAll('input[type="radio"]')).toHaveLength(2));
    expect(button("Restore session").disabled).toBe(true);
    expect(workspace.open).not.toHaveBeenCalled();
    (document.querySelector('input[value="chosen"]') as HTMLInputElement).click();
    await nextTick();
    button("Restore session").click();
    await vi.waitFor(() => expect(workspace.open).toHaveBeenCalledTimes(1));
    expect(workspace.open).toHaveBeenCalledWith({ connectionId: "conn", database: "APP", schema: "S", title: "S.chosen" });
    expect(usePlDebugStore().sessionRef?.clientSessionId).toBe("original-chosen");
    expect(usePlDebugStore().publicSnapshot?.executionOutcome).toBe("unknown");
    expect(calls.every((call) => ["bootstrap", "list", "operation", "status"].includes(call.path))).toBe(true);
    expect(calls.filter((call) => call.path === "operation")[0]!.body.operationId).toBe("start-chosen");
  });
  it("shows an empty owned list without adopting an identity", async () => {
    sessions = [];
    openPlDebugRecovery("conn");
    await vi.waitFor(() => expect(document.body.textContent).toContain("No debug sessions are available"));
    expect(button("Restore session").disabled).toBe(true);
    expect(usePlDebugStore().sessionRef).toBeNull();
    expect(workspace.open).not.toHaveBeenCalled();
  });
});
